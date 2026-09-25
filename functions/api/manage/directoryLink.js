import { getDatabase } from '../../utils/databaseAdapter.js';
import { directoryPath } from '../../utils/directories.js';

const PREFIX = 'manage@directory-link@';
const headers = { 'Cache-Control': 'no-store' };
const json = (body, status = 200) => Response.json(body, { status, headers });

// This endpoint inherits the admin authentication from manage/_middleware.js.
// Mappings live in shared metadata, so bookmarks work on both backends/devices.
export async function onRequest({ request, env }) {
    const db = getDatabase(env);
    if (request.method === 'GET') {
        const id = new URL(request.url).searchParams.get('id');
        if (!/^d_[a-f0-9]{64}$/.test(id || '')) return json({ error: 'Invalid directory ID' }, 400);
        const path = await db.get(PREFIX + id);
        return path ? json({ id, path }) : json({ error: 'Directory link not found' }, 404);
    }
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    let path;
    try { path = directoryPath((await request.json()).path); }
    catch { return json({ error: 'Invalid directory path' }, 400); }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path));
    const id = 'd_' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (await db.get(PREFIX + id) !== path) await db.put(PREFIX + id, path);
    return json({ id });
}
