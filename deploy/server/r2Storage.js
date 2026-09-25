import { mkdirSync, createReadStream, createWriteStream } from 'node:fs';
import { mkdir, stat, readdir, rename, rm, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID, createHash } from 'node:crypto';

// Share publication locks across adapters pointing at the same local directory.
const locks = new Map();
async function locked(path, operation) {
    const previous = locks.get(path) || Promise.resolve();
    let release;
    const current = new Promise(resolve => { release = resolve; });
    locks.set(path, current);
    await previous;
    try { return await operation(); }
    finally { release(); if (locks.get(path) === current) locks.delete(path); }
}
function inputStream(value) {
    if (value instanceof Blob) return Readable.fromWeb(value.stream());
    if (value instanceof ReadableStream) return Readable.fromWeb(value);
    if (value?.[Symbol.asyncIterator]) return Readable.from(value);
    if (value instanceof ArrayBuffer) value = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) value = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else if (typeof value !== 'string') value = String(value);
    return Readable.from([value]);
}
async function hashFile(path) {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest('hex');
}
function matches(metadata, condition) {
    if (!condition) return true;
    const match = condition instanceof Headers ? condition.get('If-Match') : condition.etagMatches;
    const notMatch = condition instanceof Headers ? condition.get('If-None-Match') : condition.etagDoesNotMatch;
    const clean = value => String(value).replace(/^"|"$/g, '');
    if (match && (match === '*' ? !metadata : metadata?.etag !== clean(match))) return false;
    if (notMatch && (notMatch === '*' ? !!metadata : metadata?.etag === clean(notMatch))) return false;
    if (condition.uploadedBefore && metadata && metadata.uploaded > condition.uploadedBefore) return false;
    if (condition.uploadedAfter && metadata && metadata.uploaded <= condition.uploadedAfter) return false;
    return true;
}

export class LocalR2Storage {
    constructor(basePath) {
        this.basePath = resolve(basePath);
        mkdirSync(this.basePath, { recursive: true });
    }
    _filePath(key) {
        const path = resolve(this.basePath, key);
        if (!path.startsWith(this.basePath + sep)) throw new Error('Invalid object key');
        return path;
    }
    async head(key) {
        const path = this._filePath(key);
        let info;
        try { info = await stat(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        if (!info.isFile()) return null;
        const etag = key.startsWith('.imgbed-internal/') ? await hashFile(path) : `${info.ino}-${info.size}-${info.mtimeMs}-${info.ctimeMs}`;
        return { key, size: info.size, etag, uploaded: info.mtime, httpEtag: `"${etag}"`, httpMetadata: {}, writeHttpMetadata() {} };
    }
    async list({ prefix = '', cursor = '', limit = 1000 } = {}) {
        limit = Math.max(1, Math.min(1000, Number(limit) || 1000));
        const keys = [];
        const walk = async (dir, base = '') => {
            // Only retain one directory's entries and one result page. Sorting
            // names including the slash gives the same order as object keys.
            const entries = await readdir(dir, { withFileTypes: true });
            const name = item => item.name + (item.isDirectory() ? '/' : '');
            entries.sort((a, b) => name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0);
            for (const item of entries) {
                if (keys.length > limit) break;
                if (!base && ['_multipart', '_tmp'].includes(item.name)) continue;
                const key = base + item.name;
                if (item.isDirectory()) {
                    const branch = key + '/';
                    if (!prefix.startsWith(branch) && !branch.startsWith(prefix)) continue;
                    if (branch < cursor && !cursor.startsWith(branch)) continue;
                    await walk(join(dir, item.name), branch);
                }
                else if (key.startsWith(prefix) && key > cursor) keys.push(key);
            }
        };
        await walk(this.basePath);
        const page = keys.slice(0, limit);
        return { objects: (await Promise.all(page.map(key => this.head(key)))).filter(Boolean), truncated: keys.length > limit, cursor: page.at(-1) };
    }
    async get(key, options = {}) {
        const metadata = await this.head(key);
        if (!metadata) return null;
        if (!matches(metadata, options.onlyIf)) return metadata;
        const size = metadata.size;
        let range;
        if (options.range) {
            const requested = options.range;
            const offset = requested.suffix !== undefined ? Math.max(0, size - requested.suffix) : (requested.offset ?? 0);
            const length = Math.min(requested.length ?? (size - offset), size - offset);
            if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0 || offset >= size) throw new RangeError('Range Not Satisfiable');
            range = { offset, length };
        }
        const nodeStream = createReadStream(this._filePath(key), range ? { start: range.offset, end: range.offset + range.length - 1 } : {});
        return { ...metadata, body: Readable.toWeb(nodeStream, { strategy: { highWaterMark: 65536, size: chunk => chunk.byteLength } }), range };
    }
    async _stage(value, signal) {
        const dir = join(this.basePath, '_tmp');
        await mkdir(dir, { recursive: true });
        const path = join(dir, randomUUID());
        const hash = createHash('sha256');
        const digest = new Transform({ transform(chunk, encoding, callback) { hash.update(chunk); callback(null, chunk); } });
        try {
            await pipeline(inputStream(value), digest, createWriteStream(path, { flags: 'wx' }), ...(signal ? [{ signal }] : []));
            return { path, etag: hash.digest('hex') };
        } catch (error) { await rm(path, { force: true }); throw error; }
    }
    async put(key, value, options = {}) {
        const path = this._filePath(key);
        const staged = await this._stage(value, options.signal);
        try {
            return await locked(path, async () => {
                options.signal?.throwIfAborted();
                if (!matches(await this.head(key), options.onlyIf)) return null;
                await mkdir(dirname(path), { recursive: true });
                await rename(staged.path, path);
                return this.head(key);
            });
        } finally { await rm(staged.path, { force: true }); }
    }
    async delete(key) {
        if (Array.isArray(key)) { await Promise.all(key.map(item => this.delete(item))); return; }
        const path = this._filePath(key);
        await locked(path, () => rm(path, { force: true }));
    }
    async createMultipartUpload(key, options = {}) {
        this._filePath(key);
        const uploadId = randomUUID();
        const uploadDir = join(this.basePath, '_multipart', uploadId);
        await mkdir(uploadDir, { recursive: true });
        await writeFile(join(uploadDir, '_key'), JSON.stringify({ key, options }));
        return this.resumeMultipartUpload(key, uploadId);
    }
    resumeMultipartUpload(key, uploadId) {
        if (!/^[a-zA-Z0-9-]+$/.test(uploadId)) throw new Error('Invalid multipart upload ID');
        const uploadDir = join(this.basePath, '_multipart', uploadId);
        const partPath = number => {
            if (!Number.isInteger(number) || number < 1 || number > 10000) throw new Error('Invalid multipart part number');
            return join(uploadDir, `part_${String(number).padStart(6, '0')}`);
        };
        const state = async () => {
            const raw = await readFile(join(uploadDir, '_key'), 'utf8');
            // Retain existing local uploads written before this adapter upgrade.
            const saved = raw.startsWith('{') ? JSON.parse(raw) : { key: raw, options: {}, legacy: true };
            if (saved.key !== key) throw new Error('Multipart key mismatch');
            return saved;
        };
        return { key, uploadId,
            uploadPart: (partNumber, value) => locked(uploadDir, async () => {
                await state();
                const path = partPath(partNumber);
                const staged = await this._stage(value);
                try { await rename(staged.path, path); }
                finally { await rm(staged.path, { force: true }); }
                return { partNumber, etag: staged.etag };
            }),
            complete: parts => locked(uploadDir, async () => {
                const saved = await state();
                if (!Array.isArray(parts) || !parts.length) throw new Error('Multipart parts are required');
                const sorted = [...parts].sort((a, b) => a.partNumber - b.partNumber);
                const seen = new Set();
                for (const part of sorted) {
                    partPath(part.partNumber);
                    if (seen.has(part.partNumber)) throw new Error('Duplicate multipart part');
                    seen.add(part.partNumber);
                    if (!(await stat(partPath(part.partNumber))).isFile()) throw new Error('Missing multipart part');
                }
                async function* source() {
                    for (const part of sorted) {
                        const hash = createHash('sha256');
                        for await (const chunk of createReadStream(partPath(part.partNumber))) { hash.update(chunk); yield chunk; }
                        const etag = hash.digest('hex');
                        if (part.etag !== etag && !(saved.legacy && part.etag === `etag_${part.partNumber}`)) throw new Error('Multipart etag mismatch');
                    }
                }
                const result = await this.put(key, source(), saved.options);
                if (!result) throw new Error('Multipart conditional write failed');
                await rm(uploadDir, { recursive: true, force: true });
                return result;
            }),
            abort: () => locked(uploadDir, () => rm(uploadDir, { recursive: true, force: true })),
        };
    }
}
