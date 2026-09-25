import { moveFile } from '../move/[[path]].js';
import { moveFileInIndex, rebuildIndex } from '../../../utils/indexManager.js';
import { getDatabase } from '../../../utils/databaseAdapter.js';
import { sanitizeUploadFolder } from '../../../upload/uploadTools.js';
import { buildFileMetadataForManagement } from '../../../utils/metadata/metadataView.js';

const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' };
const json = (body, status = 200) => Response.json(body, { status, headers });

// Rename and move share the same copy/metadata/alias/source-cleanup ordering.
export async function onRequest(context) {
    const { request, env, params } = context;
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return json({ success: false, message: 'Use POST' }, 405);
    try {
        const fileId = decodeURIComponent(Array.isArray(params.path) ? params.path.join('/') : params.path);
        let body;
        try { body = await request.json(); } catch { return json({ success: false, message: 'Invalid JSON' }, 400); }
        if (!fileId || typeof body?.newFileId !== 'string' || !body.newFileId.trim()) {
            return json({ success: false, message: 'File ID and newFileId are required' }, 400);
        }
        const newFileId = sanitizeUploadFolder(body.newFileId.trim());
        if (!newFileId) return json({ success: false, message: 'Invalid target file ID' }, 400);
        if (fileId === newFileId) return json({ success: true, newFileId, unchanged: true });
        const db = getDatabase(env);
        if (!(await db.getWithMetadata(fileId))?.metadata) return json({ success: false, message: 'File not found' }, 404);
        if ((await db.getWithMetadata(newFileId))?.metadata) return json({ success: false, message: 'Target exists' }, 409);
        const url = new URL(request.url);
        if (!await moveFile(env, fileId, newFileId, `${url.origin}/file/${fileId}`, url)) {
            return json({ success: false, message: 'Rename failed; source is retained until target metadata and links are durable' }, 500);
        }
        const result = await moveFileInIndex(context, fileId, newFileId);
        if (!result.success) {
            if (context.waitUntil) context.waitUntil(rebuildIndex(context));
            return json({ success: false, code: 'MOVE_INDEX_PENDING', newFileId, requiresRefresh: true,
                message: 'File renamed; index recovery required' }, 503);
        }
        const record = await db.getWithMetadata(newFileId);
        return json({ success: true, newFileId, metadata: await buildFileMetadataForManagement(db, env, record.metadata) });
    } catch (error) {
        console.error('Rename failed:', error.message);
        return json({ success: false, message: error.message }, 500);
    }
}
