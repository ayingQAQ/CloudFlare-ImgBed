import { getDatabase } from './databaseAdapter.js';
import { getUploadConfig } from '../api/manage/sysConfig/upload.js';
import { releaseR2 } from './r2Capacity.js';
import { S3Client, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';

const PREFIX = 'manage@multipartRecovery@';
const CURSOR = 'manage@multipartRecoveryCursor';
const LEGACY_CURSOR = 'manage@multipartLegacyCursor';

export async function registerMultipartRecovery(env, sessionId, info) {
    const db = getDatabase(env);
    const session = JSON.parse(await db.get(`upload_session_${sessionId}`) || 'null');
    const job = { ...info, sessionId, expiresAt: session?.expiresAt || Date.now() + 3600000 };
    // Never apply TTL: provider cleanup must succeed before this record disappears.
    await db.put(PREFIX + sessionId, JSON.stringify(job));
    return job;
}

export async function finishMultipartRecovery(env, sessionId) {
    await getDatabase(env).delete(PREFIX + sessionId);
}

async function abortRecovery(env, job) {
    try {
        if (job.provider === 'cfr2') {
            if (!env.img_r2) throw new Error('R2 binding unavailable for multipart recovery');
            await env.img_r2.resumeMultipartUpload(job.key, job.uploadId).abort();

        } else if (job.provider === 's3') {
            // Disabled channels still need cleanup; retain the journal if credentials
            // were removed rather than deleting an unrecoverable provider identifier.
            const config = await getUploadConfig(getDatabase(env), env);
            const channel = config.s3.channels.find(c => c.name === job.channelName);
            if (!channel) throw new Error('S3 cleanup channel is unavailable');
            const identity = { endpoint: channel.endpoint, bucketName: channel.bucketName,
                region: channel.region || 'auto', pathStyle: !!channel.pathStyle };
            if (job.providerIdentity && Object.keys(identity).some(key => identity[key] !== job.providerIdentity[key])) {
                throw new Error('S3 provider identity changed; recovery journal retained');
            }
            const client = new S3Client({ region: channel.region || 'auto', endpoint: channel.endpoint,
                forcePathStyle: channel.pathStyle, credentials: { accessKeyId: channel.accessKeyId, secretAccessKey: channel.secretAccessKey } });
            try {
                await client.send(new AbortMultipartUploadCommand({ Bucket: channel.bucketName, Key: job.key, UploadId: job.uploadId }),
                    { abortSignal: AbortSignal.timeout(15000) });
            } finally { client.destroy(); }
        } else throw new Error('Multipart provider is unknown; recovery record retained');
    } catch (error) {
        if (job.provider === 's3' && !job.providerIdentity) throw error;
        if (error.name !== 'NoSuchUpload' && error.$metadata?.httpStatusCode !== 404 && !/multipart.*(not found|does not exist)/i.test(error.message)) throw error;
    }
    if (job.provider === 'cfr2' && job.reservationId) await releaseR2(env.img_r2, job.reservationId, { committed: true });
}

export async function cleanupExpiredMultipartUploads(env, { limit = 20 } = {}) {
    const db = getDatabase(env);
    limit = Math.max(1, Math.min(100, limit));
    const cursor = await db.get(CURSOR);
    const page = await db.list({ prefix: PREFIX, limit, ...(cursor ? { cursor } : {}) });
    const result = { recovered: 0, deferred: 0, failed: 0 };
    const clean = async (job, journalKey) => {
        if (job.expiresAt > Date.now()) { result.deferred++; return; }
        try {
            await abortRecovery(env, job);
            await db.delete(`multipart_${job.sessionId}`);
            await db.delete(`upload_session_${job.sessionId}`);
            if (journalKey) await db.delete(journalKey);
            result.recovered++;
        } catch (error) { result.failed++; console.warn('Multipart recovery deferred:', error.message); }
    };
    for (const item of page.keys) {
        const value = await db.get(item.name);
        try { if (value) await clean(JSON.parse(value), item.name); }
        catch { result.failed++; }
    }
    await db.put(CURSOR, page.list_complete === false ? page.cursor || '' : '');
    // Legacy D1 rows are intentionally protected from TTL GC until provider abort.
    if (db.listExpiredMultipart && page.keys.length < limit) {
        const legacyCursor = await db.get(LEGACY_CURSOR);
        const legacy = await db.listExpiredMultipart({ limit: limit - page.keys.length, ...(legacyCursor ? { cursor: legacyCursor } : {}) });
        for (const item of legacy.keys) {
            try {
            const info = JSON.parse(item.value || '{}');
            const session = JSON.parse(item.sessionValue || 'null');
            await clean({ ...info, sessionId: item.name.slice('multipart_'.length),
                provider: info.provider || session?.uploadChannel, channelName: info.channelName || session?.channelName,
                reservationId: info.reservationId || session?.tieringReservation, expiresAt: session?.expiresAt || 0 });
            } catch { result.failed++; }
        }
        await db.put(LEGACY_CURSOR, legacy.list_complete === false ? legacy.cursor || '' : '');
    }
    return result;
}
