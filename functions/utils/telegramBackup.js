import { r2Put } from './r2Write.js';
import { getDatabase } from './databaseAdapter.js';
import { fetchUploadConfig } from './sysConfig.js';
import { INTERNAL_PREFIX } from './r2Capacity.js';
import { TelegramAPI } from './storage/telegramAPI.js';

const PENDING = `${INTERNAL_PREFIX}telegram/pending/`;
const COMPLETE = `${INTERNAL_PREFIX}telegram/complete/`;
const CURSOR = `${INTERNAL_PREFIX}telegram/cursor.json`;
const CHUNK_SIZE = 8 * 1024 * 1024;
const json = object => new Response(object.body).json();
const encodePath = path => path.split('/').map(encodeURIComponent).join('/');
const sourceMetadata = metadata => Object.fromEntries([
    'BackupId', 'TimeStamp', 'Channel', 'ChannelName', 'HfFilePath', 'FileName', 'FileType', 'FileSizeBytes',
].filter(key => metadata[key] !== undefined).map(key => [key, metadata[key]]));

async function jobId(fileId, metadata) {
    if (metadata.BackupId) return metadata.BackupId;
    const bytes = new TextEncoder().encode(JSON.stringify([fileId, metadata.TimeStamp, metadata.Channel, metadata.HfFilePath]));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function relocateTelegramBackup(env, fileId, metadata) {
    if (!env.img_r2 || !metadata.BackupId) return;
    const bucket = env.img_r2;
    const id = metadata.BackupId;
    for (let attempt = 0; attempt < 8; attempt++) {
        const key = await bucket.head(COMPLETE + id) ? COMPLETE + id : PENDING + id;
        const object = await bucket.get(key);
        if (!object) return;
        const job = await json(object);
        job.fileId = fileId;
        job.metadata = sourceMetadata(metadata);
        if (job.primaryChannel === 'cfr2') job.sourceEtag = (await bucket.head(fileId))?.etag;
        job.leaseUntil = 0;
        job.nextAttemptAt = 0;
        if (await r2Put(bucket, key, JSON.stringify(job), { onlyIf: { etagMatches: object.etag } })) return;
    }
    throw new Error('Backup relocation is busy; retry the operation');
}

export async function getTelegramBackup(env, fileId, metadata) {
    const bucket = env.img_r2;
    if (!bucket) return null;
    metadata ||= (await getDatabase(env).getWithMetadata(fileId))?.metadata;
    if (!metadata) return null;
    const id = await jobId(fileId, metadata);
    const object = await bucket.get(COMPLETE + id) || await bucket.get(PENDING + id);
    return object ? json(object) : null;
}

export async function enqueueTelegramBackup(context, fileId, primaryChannel) {
    if (!['cfr2', 'huggingface'].includes(primaryChannel)) return;
    const bucket = context.env.img_r2;
    if (!bucket) throw new Error('R2 binding is required for durable Telegram backup jobs');
    const record = await getDatabase(context.env).getWithMetadata(fileId);
    if (!record?.metadata) throw new Error('Primary metadata is unavailable; cannot enqueue backup');
    const metadata = record.metadata;
    const id = await jobId(fileId, metadata);
    if (await bucket.head(COMPLETE + id)) return;
    const sourceHead = primaryChannel === 'cfr2' ? await bucket.head(fileId) : null;
    const size = sourceHead?.size ?? Number(metadata.FileSizeBytes);
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Backup source size is unavailable');
    const job = { id, fileId, primaryChannel, metadata: sourceMetadata(metadata), size, sourceEtag: sourceHead?.etag,
        chunks: [], status: 'pending', attempts: 0, nextAttemptAt: 0, createdAt: Date.now() };
    // No writes to the file's KV key: manifests live in R2 values, without the 1KB limit.
    await r2Put(bucket, PENDING + id, JSON.stringify(job), { onlyIf: { etagDoesNotMatch: '*' } });
    // One bounded attempt for low latency; scheduled/request-driven workers resume the rest.
    context.waitUntil(processTelegramBackup(context.env, id).catch(error => console.error('Backup worker:', error.message)));
}

async function readSlice(env, job, config, start, end) {
    if (end === start) return new Blob([]);
    if (job.primaryChannel === 'cfr2') {
        const object = await env.img_r2.get(job.fileId, {
            range: { offset: start, length: end - start }, onlyIf: { etagMatches: job.sourceEtag },
        });
        if (!object?.body) throw new Error('R2 backup source changed or was deleted');
        const blob = await new Response(object.body).blob();
        if (blob.size !== end - start) throw new Error('Incomplete R2 range');
        return blob;
    }
    const channel = config.huggingface.channels.find(c => c.name === job.metadata.ChannelName);
    if (!channel?.token || !channel.repo || !job.metadata.HfFilePath) throw new Error('Hugging Face source channel is unavailable');
    const url = `https://huggingface.co/datasets/${encodePath(channel.repo)}/resolve/main/${encodePath(job.metadata.HfFilePath)}`;
    const response = await fetch(url, {
        headers: { Authorization: `Bearer ${channel.token}`, Range: `bytes=${start}-${end - 1}` },
        signal: AbortSignal.timeout(15000),
    });
    if (!response.ok || (response.status !== 206 && (start !== 0 || end !== job.size))) {
        await response.body?.cancel();
        throw new Error(`Hugging Face range read failed: ${response.status}`);
    }
    if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${start}-${end - 1}/`)) {
        await response.body?.cancel();
        throw new Error('Unexpected Hugging Face content range');
    }
    // Bound reads even if an upstream ignores its Content-Length/Range headers.
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.byteLength;
            if (size > end - start) throw new Error('Oversized Hugging Face range');
            chunks.push(part.value);
        }
    } finally { await reader.cancel(); }
    if (size !== end - start) throw new Error('Incomplete Hugging Face range');
    return new Blob(chunks);
}

export async function processTelegramBackup(env, id) {
    const bucket = env.img_r2;
    const key = PENDING + id;
    const object = await bucket.get(key);
    if (!object) return null;
    const job = await json(object);
    const now = Date.now();
    if (job.leaseUntil > now || job.nextAttemptAt > now) return 'deferred';
    job.leaseUntil = now + 120000;
    job.lease = crypto.randomUUID();
    const claim = await r2Put(bucket, key, JSON.stringify(job), { onlyIf: { etagMatches: object.etag } });
    if (!claim) return 'busy';
    // Recover a crash between the final checkpoint and manifest publication.
    if (['ready', 'cancelled'].includes(job.status)) {
        await r2Put(bucket, COMPLETE + id, JSON.stringify(job));
        await bucket.delete(key);
        return job.status;
    }
    try {
        const record = await getDatabase(env).getWithMetadata(job.fileId);
        if (!record?.metadata || await jobId(job.fileId, record.metadata) !== id) {
            job.status = 'cancelled'; // Deleted/replaced files must never be recreated by a backup.
        } else {
            const config = await fetchUploadConfig(env);
            // Pin the bot/channel after the first successful part; do not mix credentials.
            const name = job.channelName || env.TG_BACKUP_CHANNEL_NAME;
            const channel = name ? config.telegram.channels.find(c => c.name === name) : config.telegram.channels[0];
            if (!channel?.botToken || !channel.chatId) throw new Error('Telegram backup channel is not configured');
            const botId = channel.botToken.split(':')[0];
            if (job.botId && job.botId !== botId) throw new Error('Telegram backup bot changed');
            const index = job.chunks.length;
            const start = index * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, job.size);
            const blob = await readSlice(env, job, config, start, end);
            const form = new FormData();
            form.set('chat_id', channel.chatId);
            form.set('document', blob, `${job.metadata.FileName || 'backup'}.part${String(index).padStart(5, '0')}`);
            form.set('caption', `ImgBed backup ${id} ${index + 1}/${Math.max(1, Math.ceil(job.size / CHUNK_SIZE))}`);
            const api = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
            const response = await fetch(`${api.baseURL}/sendDocument`, {
                method: 'POST', body: form, signal: AbortSignal.timeout(15000),
            });
            const result = await response.json();
            if (!response.ok || !result.ok || !result.result?.document?.file_id) {
                throw new Error(`Telegram send failed: ${response.status}, code ${result.error_code || 'unknown'}`);
            }
            job.chunks.push({ fileId: result.result.document.file_id, size: blob.size });
            job.channelName = channel.name;
            job.botId = botId;
            job.status = end >= job.size ? 'ready' : 'pending';
            job.attempts = 0;
            job.nextAttemptAt = 0;
            job.lastError = null;
        }
    } catch (error) {
        job.status = 'retrying';
        job.attempts++;
        job.lastError = String(error.message).slice(0, 300);
        job.nextAttemptAt = Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(job.attempts, 12));
    }
    job.leaseUntil = 0;
    job.updatedAt = Date.now();
    const saved = await r2Put(bucket, key, JSON.stringify(job), { onlyIf: { etagMatches: claim.etag } });
    if (!saved) return 'busy'; // A reclaimed lease owns further progress.
    if (['ready', 'cancelled'].includes(job.status)) {
        await r2Put(bucket, COMPLETE + id, JSON.stringify(job));
        await bucket.delete(key);
    }
    return job.status;
}

export async function drainTelegramBackups(env, maxSteps = 10) {
    if (!env.img_r2) return 0;
    const savedCursor = await env.img_r2.get(CURSOR);
    const cursor = savedCursor ? (await json(savedCursor)).cursor : null;
    const page = await env.img_r2.list({ prefix: PENDING, limit: Math.max(1, Math.min(10, maxSteps)),
        ...(cursor ? { cursor } : {}) });
    // Advance past deferred jobs as well: a failed/large job cannot starve the tail.
    if (!page.objects.length && !cursor) return 0;
    let processed = 0;
    for (const object of page.objects) {
        const status = await processTelegramBackup(env, object.key.slice(PENDING.length));
        if (!['deferred', 'busy', null].includes(status)) processed++;
    }
    await r2Put(env.img_r2, CURSOR, JSON.stringify({ cursor: page.truncated ? page.cursor : null }));
    return processed;
}

// Used after the existing file access checks, and by the authenticated restore endpoint.
export async function readTelegramBackup(env, fileId, metadata, request) {
    const job = await getTelegramBackup(env, fileId, metadata);
    if (job?.status !== 'ready') return null;
    const config = await fetchUploadConfig(env);
    const channel = config.telegram.channels.find(c => c.name === job.channelName);
    if (!channel || channel.botToken.split(':')[0] !== job.botId) return null;
    const api = new TelegramAPI(channel.botToken, channel.proxyUrl || '');
    let start = 0;
    let end = job.size - 1;
    const range = request?.headers.get('Range');
    if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range);
        if (!match) return new Response(null, { status: 416 });
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), end) : end;
        if (start > end || start >= job.size) return new Response(null, { status: 416 });
    }
    let index = Math.floor(start / CHUNK_SIZE);
    let position = index * CHUNK_SIZE;
    let reader;
    const body = new ReadableStream({
        async pull(controller) {
            try {
                while (true) {
                    if (!reader) {
                        if (index === job.chunks.length || position > end) return controller.close();
                        const response = await api.getFileContent(job.chunks[index++].fileId);
                        if (!response.ok) throw new Error('Telegram restore failed');
                        reader = response.body.getReader();
                    }
                    const part = await reader.read();
                    if (part.done) { reader = null; continue; }
                    const offset = Math.max(0, start - position);
                    const length = Math.min(part.value.byteLength, end - position + 1);
                    position += part.value.byteLength;
                    if (length <= offset) continue;
                    controller.enqueue(part.value.slice(offset, length));
                    if (position > end) { await reader.cancel(); controller.close(); }
                    return;
                }
            } catch (error) { controller.error(error); }
        },
        async cancel() { await reader?.cancel(); },
    });
    return new Response(body, { status: range ? 206 : 200, headers: {
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${job.size}` } : {}),
        'Accept-Ranges': 'bytes', 'Content-Type': job.metadata.FileType || 'application/octet-stream',
        'Content-Length': String(Math.max(0, end - start + 1)), 'Cache-Control': 'private, no-store', 'X-ImgBed-Replica': 'telegram' } });
}
