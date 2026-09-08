import { getTelegramBackup, readTelegramBackup, enqueueTelegramBackup } from '../../utils/telegramBackup.js';
import { getDatabase } from '../../utils/databaseAdapter.js';

// Existing /api/manage middleware requires administrator/manage permission.
export async function onRequest(context) {
    const url = new URL(context.request.url);
    const fileId = url.searchParams.get('fileId');
    if (!fileId) return new Response('fileId is required', { status: 400 });
    const record = await getDatabase(context.env).getWithMetadata(fileId);
    if (!record?.metadata) return new Response('File not found', { status: 404 });
    if (context.request.method === 'POST') {
        const channel = { CloudflareR2: 'cfr2', HuggingFace: 'huggingface' }[record.metadata.Channel];
        if (!channel) return new Response('Unsupported primary storage', { status: 400 });
        await enqueueTelegramBackup(context, fileId, channel);
    } else if (context.request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
    if (url.searchParams.get('download') === 'true') {
        return await readTelegramBackup(context.env, fileId, record.metadata, context.request) ||
            new Response('Backup is not ready', { status: 409 });
    }
    const job = await getTelegramBackup(context.env, fileId, record.metadata);
    return Response.json(job ? { status: job.status, sizeBytes: job.size, chunks: job.chunks,
        channelName: job.channelName, lastError: job.lastError, nextAttemptAt: job.nextAttemptAt } : { status: 'missing' },
    { headers: { 'Cache-Control': 'private, no-store' } });
}
