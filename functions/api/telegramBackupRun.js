import { userAuthCheck, UnauthorizedResponse } from '../utils/auth/userAuth.js';
import { drainTelegramBackups, getTelegramBackup, processTelegramBackup } from '../utils/telegramBackup.js';

async function equalSecret(actual, expected) {
    if (!actual || !expected) return false;
    const digest = value => crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    const [a, b] = await Promise.all([digest(actual), digest(expected)]);
    return new Uint8Array(a).reduce((difference, byte, i) => difference | (byte ^ new Uint8Array(b)[i]), 0) === 0;
}

export async function onRequestPost(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    const fileId = url.searchParams.get('fileId');
    const runner = await equalSecret(request.headers.get('Authorization')?.replace(/^Bearer /, ''), env.TG_BACKUP_RUNNER_TOKEN);
    if (!runner && (!fileId || !await userAuthCheck(env, url, request, 'upload'))) return UnauthorizedResponse('Unauthorized');
    if (!env.img_r2) return Response.json({ error: 'R2 binding is required' }, { status: 503 });
    if (!fileId) {
        const processed = await drainTelegramBackups(env, 1);
        return Response.json({ success: true, processed }, { headers: { 'Cache-Control': 'no-store' } });
    }
    let job = await getTelegramBackup(env, fileId);
    if (!job) return Response.json({ status: 'missing' }, { status: 404 });
    if (!['ready', 'cancelled'].includes(job.status)) await processTelegramBackup(env, job.id);
    job = await getTelegramBackup(env, fileId);
    return Response.json({ status: job.status, completedChunks: job.chunks.length,
        totalChunks: Math.max(1, Math.ceil(job.size / (8 * 1024 * 1024))),
        retryAfterMs: Math.max(1000, (job.nextAttemptAt || 0) - Date.now()) },
    { headers: { 'Cache-Control': 'no-store' } });
}
