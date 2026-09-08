import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { Miniflare, createFetchMock } from 'miniflare';
import { LocalR2Storage } from '../deploy/server/r2Storage.js';
import { reserveR2, releaseR2, checkR2Reservation, attachR2Multipart } from '../functions/utils/r2Capacity.js';
import { resolveAutomaticPrimary, isAutomaticChannelRequest } from '../functions/utils/storageTiering.js';
import { enqueueTelegramBackup, processTelegramBackup, getTelegramBackup, readTelegramBackup, relocateTelegramBackup } from '../functions/utils/telegramBackup.js';
import { onRequest as middleware } from '../functions/upload/_middleware.js';
import { sanitizeUploadFolder } from '../functions/upload/uploadTools.js';

const MB = 1024 * 1024;
function local(t) {
    const path = mkdtempSync(join(tmpdir(), 'imgbed-tiering-'));
    t.after(() => {
        assert.equal(dirname(path), tmpdir());
        rmSync(path, { recursive: true });
    });
    return new LocalR2Storage(path);
}
function environment(bucket) {
    const records = new Map();
    const writes = [];
    const env = { img_r2: bucket, HF_TOKEN: 'mock', HF_REPO: 'owner/repo', TG_BOT_TOKEN: '123:mock', TG_CHAT_ID: '123',
        img_url: {
            async get(key) { return records.get(key)?.value ?? null; },
            async getWithMetadata(key) { return records.get(key) ?? { value: null, metadata: null }; },
            async put(key, value, options) { writes.push(key); records.set(key, { value, metadata: options?.metadata }); },
            async delete(key) { records.delete(key); },
        } };
    return { env, records, writes };
}

for (const backend of ['docker', 'workerd']) {
    test(`${backend}: atomic reservations, release, actual bucket usage and expiry`, async t => {
        let bucket;
        if (backend === 'docker') bucket = local(t);
        else {
            const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', r2Buckets: ['BUCKET'] });
            t.after(() => mf.dispose());
            bucket = await mf.getR2Bucket('BUCKET');
        }
        const results = await Promise.all([reserveR2(bucket, 15 * MB, 24 * MB), reserveR2(bucket, 15 * MB, 24 * MB)]);
        assert.equal(results.filter(r => r.id).length, 1);
        const id = results.find(r => r.id).id;
        assert.equal((await checkR2Reservation(bucket, id)).bytes, 15 * MB);
        await releaseR2(bucket, id);
        await assert.rejects(checkR2Reservation(bucket, id), /expired/);
        await bucket.put('unindexed-file', new Uint8Array(2 * MB));
        assert.equal((await reserveR2(bucket, MB, 4 * MB)).id, null);
        const expired = await reserveR2(bucket, MB, 24 * MB, -1);
        await assert.rejects(checkR2Reservation(bucket, expired.id), /expired/);
    });
}

test('routing switches R2 UI selection to HF; unavailable HF fails closed', async t => {
    const { env } = environment(local(t));
    env.R2_AUTO_TIER_LIMIT_GB = '0.002';
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(MB)]), 'x');
    const request = new Request('https://test/upload?uploadChannel=cfr2', { method: 'POST', body: form });
    assert(isAutomaticChannelRequest(new URL(request.url)));
    assert.equal((await resolveAutomaticPrimary({ env, request })).channel, 'huggingface');
    delete env.HF_TOKEN;
    assert.equal((await resolveAutomaticPrimary({ env, request })).channel, null);
    assert(!isAutomaticChannelRequest(new URL('https://test/upload?uploadChannel=cfr2&tiering=off')));
});

test('middleware forwards rewritten Request and releases failed init reservations', async t => {
    const { env } = environment(local(t));
    env.R2_AUTO_TIER_LIMIT_GB = '0.002';
    let called = false;
    const form = new FormData(); form.set('file', new Blob([new Uint8Array(MB)]), 'x');
    const request = new Request('https://test/upload?uploadChannel=cfr2', { method: 'POST', body: form });
    const response = await middleware[3]({ env, request, next: async downstream => {
        called = true;
        assert.equal(new URL(downstream.url).searchParams.get('uploadChannel'), 'huggingface');
        assert.equal(new URL(downstream.url).searchParams.get('autoRetry'), 'false');
        return new Response('failed', { status: 500 });
    } });
    assert(called); assert.equal(response.status, 500);
    env.R2_AUTO_TIER_LIMIT_GB = '10';
    const init = new FormData(); init.set('totalChunks', '1');
    let id;
    await middleware[3]({ env, request: new Request('https://test/upload?initChunked=true', { method: 'POST', body: init }),
        next: async downstream => { id = new URL(downstream.url).searchParams.get('tieringReservation'); return new Response('fail', { status: 400 }); } });
    assert(id); await assert.rejects(checkR2Reservation(env.img_r2, id));
});

test('backup survives failed Telegram send, resumes without KV writes and restores ranges', async t => {
    const bucket = local(t);
    const { env, records, writes } = environment(bucket);
    const data = new Uint8Array(9 * MB).fill(42);
    await bucket.put('x.bin', data);
    const metadata = { FileName: 'x.bin', FileType: 'application/octet-stream', Channel: 'CloudflareR2',
        ChannelName: 'R2_env', TimeStamp: 10, FileSizeBytes: data.length };
    records.set('x.bin', { value: '', metadata });
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    let failed = false;
    const documents = new Map();
    globalThis.fetch = async (url, options) => {
        if (String(url).endsWith('/sendDocument')) {
            if (!failed) { failed = true; return Response.json({ ok: false, error_code: 429 }, { status: 429 }); }
            const fileId = 'id_' + documents.size;
            documents.set(fileId, options.body.get('document'));
            return Response.json({ ok: true, result: { document: { file_id: fileId } } });
        }
        if (String(url).includes('/getFile?')) return Response.json({ ok: true, result: { file_path: new URL(url).searchParams.get('file_id') } });
        return new Response(documents.get(String(url).split('/').pop()));
    };
    const work = [];
    await enqueueTelegramBackup({ env, waitUntil: p => work.push(p) }, 'x.bin', 'cfr2');
    await Promise.all(work);
    let job = await getTelegramBackup(env, 'x.bin');
    assert.equal(job.status, 'retrying'); assert.equal(job.chunks.length, 0);
    const key = '.imgbed-internal/telegram/pending/' + job.id;
    job.nextAttemptAt = 0;
    await bucket.put(key, JSON.stringify(job));
    await Promise.all([processTelegramBackup(env, job.id), processTelegramBackup(env, job.id)]);
    job = await getTelegramBackup(env, 'x.bin');
    assert.equal(job.chunks.length, 1); assert.equal(documents.size, 1);
    await processTelegramBackup(env, job.id);
    job = await getTelegramBackup(env, 'x.bin');
    assert.equal(job.status, 'ready'); assert.equal(job.chunks.length, 2);
    assert.equal(writes.length, 0);
    const response = await readTelegramBackup(env, 'x.bin', metadata,
        new Request('https://test/file/x.bin', { headers: { Range: `bytes=${8 * MB - 2}-${8 * MB + 2}` } }));
    assert.equal(response.status, 206);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array(5).fill(42));
});

test('deleted source cancels a queued job without resurrecting file metadata', async t => {
    const bucket = local(t); const { env, records, writes } = environment(bucket);
    await bucket.put('x', 'abc');
    records.set('x', { value: '', metadata: { FileSizeBytes: 3, Channel: 'CloudflareR2', TimeStamp: 1 } });
    // Hold the job before the first metadata read, as a terminated background request would.
    const originalGet = env.img_url.getWithMetadata;
    let reads = 0;
    env.img_url.getWithMetadata = async key => {
        if (++reads > 1) return { value: null, metadata: null };
        return originalGet(key);
    };
    const work = [];
    await enqueueTelegramBackup({ env, waitUntil: p => work.push(p) }, 'x', 'cfr2');
    await Promise.all(work);
    env.img_url.getWithMetadata = originalGet;
    assert.equal((await getTelegramBackup(env, 'x')).status, 'cancelled');
    assert.equal(writes.length, 0);
});

test('internal namespace cannot be selected as an upload directory', () => {
    for (const path of ['.imgbed-internal', '/.imgbed-internal/a', '%2eimgbed-internal', '\\.imgbed-internal']) {
        assert.throws(() => sanitizeUploadFolder(path), /Reserved/);
    }
});

function frontendSource() {
    const dir = new URL('../frontend-dist/js/', import.meta.url);
    for (const name of readdirSync(dir).filter(n => n.endsWith('.js.map'))) {
        const map = JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
        const source = map.sourcesContent?.find(s => s?.includes('async uploadFileInChunks(file) {'));
        if (source) return source;
    }
    throw new Error('UploadForm source missing from frontend build');
}

test('compiled UI contains tiering and backup continuation', () => {
    const dir = new URL('../frontend-dist/js/', import.meta.url);
    const ui = readdirSync(dir).filter(n => n.endsWith('.js')).map(n => readFileSync(new URL(n, dir), 'utf8')).join('');
    assert(ui.includes('hf_direct_upload_required'));
    assert(ui.includes('originalFileSize'));
    assert(ui.includes('/api/telegramBackupRun?fileId='));
});

test('built frontend source hands off to HF and completes the queue only once', async () => {
    const text = frontendSource();
    const start = text.indexOf('async uploadFileInChunks(file) {');
    const end = text.indexOf('    handleRemove(file)', start);
    const sandbox = { AbortController, FormData, console, axios: async options => {
        assert.equal(options.data.get('originalFileSize'), '20000000');
        throw { response: { status: 409, data: { error: 'hf_direct_upload_required' } } };
    } };
    vm.createContext(sandbox);
    const component = vm.runInContext('({' + text.slice(start, end) + '})', sandbox);
    let direct = 0, completed = 0;
    const item = { uid: 'u', uploadChannel: 'cfr2' };
    Object.assign(component, { fileList: [item], abortControllers: new Map(),
        getFileUploadFolder: () => '', onUploadComplete: () => completed++,
        uploadToHuggingFaceDirect: async () => { direct++; component.onUploadComplete(); } });
    await component.uploadFileInChunks({ file: { uid: 'u', name: 'large.bin', size: 20000000 } });
    assert.equal(direct, 1); assert.equal(completed, 1); assert.equal(item.uploadChannel, 'huggingface');
});

test('multipart retries share the original upload; cancellation aborts reserved parts', async t => {
    const bucket = local(t);
    const reservation = await reserveR2(bucket, MB, 10 * MB);
    const a = await bucket.createMultipartUpload('x');
    const b = await bucket.createMultipartUpload('x');
    const attached = await attachR2Multipart(bucket, reservation.id, { key: 'x', uploadId: a.uploadId });
    const retried = await attachR2Multipart(bucket, reservation.id, { key: 'x', uploadId: b.uploadId });
    assert.deepEqual(retried, attached);
    const dirs = readdirSync(join(bucket.basePath, '_multipart'));
    assert.deepEqual(dirs, [a.uploadId]);
    await releaseR2(bucket, reservation.id);
    assert.deepEqual(readdirSync(join(bucket.basePath, '_multipart')), []);
});

test('HF private source uses authenticated ranges and ready backup survives rename', async t => {
    const { env, records } = environment(local(t));
    const metadata = { BackupId: crypto.randomUUID(), TimeStamp: 2, Channel: 'HuggingFace',
        ChannelName: 'HuggingFace_env', HfFilePath: 'folder/unique-x', FileName: 'x', FileSizeBytes: 3 };
    records.set('x', { value: '', metadata });
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url, options) => {
        if (String(url).startsWith('https://huggingface.co/')) {
            assert.equal(options.headers.Authorization, 'Bearer mock');
            assert.equal(options.headers.Range, 'bytes=0-2');
            return new Response('abc', { status: 206, headers: { 'content-range': 'bytes 0-2/3' } });
        }
        assert.equal(await options.body.get('document').text(), 'abc');
        return Response.json({ ok: true, result: { document: { file_id: 'abc' } } });
    };
    const work = [];
    await enqueueTelegramBackup({ env, waitUntil: p => work.push(p) }, 'x', 'huggingface');
    await Promise.all(work);
    assert.equal((await getTelegramBackup(env, 'x')).status, 'ready');
    records.set('renamed', { value: '', metadata });
    await relocateTelegramBackup(env, 'renamed', metadata);
    records.delete('x');
    const job = await getTelegramBackup(env, 'renamed');
    assert.equal(job.status, 'ready'); assert.equal(job.fileId, 'renamed');
});

test('backup above 800MiB starts and manifests larger than 1KB remain durable', async t => {
    const bucket = local(t);
    await bucket.put('large', 'placeholder');
    const originalHead = bucket.head.bind(bucket), originalGet = bucket.get.bind(bucket);
    bucket.head = async key => key === 'large' ? { ...await originalHead(key), size: 900 * MB } : originalHead(key);
    bucket.get = async (key, options) => key === 'large' && options?.range
        ? { body: new Blob([new Uint8Array(options.range.length)]).stream() } : originalGet(key, options);
    const { env, records, writes } = environment(bucket);
    records.set('large', { value: '', metadata: { Channel: 'CloudflareR2', FileSizeBytes: 900 * MB, TimeStamp: 4 } });
    const originalFetch = globalThis.fetch; t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async () => Response.json({ ok: true, result: { document: { file_id: 'x'.repeat(110) } } });
    const work = [];
    await enqueueTelegramBackup({ env, waitUntil: p => work.push(p) }, 'large', 'cfr2');
    await Promise.all(work);
    const initial = await getTelegramBackup(env, 'large');
    for (let step = 0; step < 9; step++) await processTelegramBackup(env, initial.id);
    const job = await getTelegramBackup(env, 'large');
    assert.equal(job.status, 'pending'); assert.equal(job.chunks.length, 10);
    assert(Buffer.byteLength(JSON.stringify(job.chunks)) > 1024);
    assert.equal(writes.length, 0);
});

test('compiled Pages endpoint uploads to R2, serves exact bytes and completes Telegram backup', async t => {
    const output = local(t).basePath;
    execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'pages', 'functions', 'build',
        'functions', '--outdir', output], { stdio: 'pipe', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } });
    const agent = createFetchMock(); agent.disableNetConnect();
    agent.get('https://api.telegram.org').intercept({ path: '/bot123:mock/sendDocument', method: 'POST' })
        .reply(200, JSON.stringify({ ok: true, result: { document: { file_id: 'test-file' } } })).persist();
    const mf = new Miniflare({ modules: true, compatibilityDate: '2024-08-21', scriptPath: join(output, 'index.js'),
        kvNamespaces: ['img_url'], r2Buckets: ['img_r2'], fetchMock: agent,
        bindings: { disable_telemetry: 'true', TG_BOT_TOKEN: '123:mock', TG_CHAT_ID: '123' } });
    try {
        const form = new FormData(); form.set('file', new Blob(['hello'], { type: 'text/plain' }), 'x.txt');
        const request = new Request('https://test/upload?uploadChannel=cfr2', { method: 'POST', body: form });
        const response = await mf.dispatchFetch(request.url, { method: 'POST',
            headers: Object.fromEntries(request.headers), body: await request.arrayBuffer() });
        const body = await response.text();
        assert.equal(response.status, 200, body);
        const src = JSON.parse(body)[0].src;
        const file = await mf.dispatchFetch('https://test' + src);
        assert.equal(file.status, 200); assert.equal(await file.text(), 'hello');
        const status = await mf.dispatchFetch('https://test/api/telegramBackupRun?fileId=' + encodeURIComponent(src.slice(6)), { method: 'POST' });
        assert.equal(status.status, 200); assert.equal((await status.json()).status, 'ready');
        const post = async (query, fields) => {
            const form = new FormData();
            for (const [key, value] of Object.entries(fields)) form.set(key, value);
            const req = new Request('https://test/upload?uploadChannel=cfr2&' + query, { method: 'POST', body: form });
            const res = await mf.dispatchFetch(req.url, { method: 'POST', headers: Object.fromEntries(req.headers), body: await req.arrayBuffer() });
            const text = await res.text();
            assert.equal(res.status, 200, text);
            return JSON.parse(text);
        };
        const common = { originalFileName: 'chunked.bin', originalFileType: 'application/octet-stream', totalChunks: '1' };
        const session = await post('initChunked=true', { ...common, originalFileSize: '5' });
        await post('chunked=true', { ...common, uploadId: session.uploadId, chunkIndex: '0', file: new Blob(['hello']) });
        const merged = await post('chunked=true&merge=true', { ...common, uploadId: session.uploadId });
        const mergedFile = await mf.dispatchFetch('https://test' + merged[0].src);
        assert.equal(mergedFile.status, 200); assert.equal(await mergedFile.text(), 'hello');
    } finally { await mf.dispose(); }
});
