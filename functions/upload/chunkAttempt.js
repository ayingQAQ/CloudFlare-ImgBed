import { getDatabase } from '../utils/databaseAdapter.js';
import { r2Put } from '../utils/r2Write.js';

const PREFIX = '.imgbed-internal/upload-attempt/';
const settingKey = (id, index) => `manage@uploadAttempt@${id}@${index}`;
const busy = expired => Object.assign(new Error(expired
    ? 'Previous chunk attempt is uncertain; restart the upload session'
    : 'Chunk attempt is already in progress'), { status: expired ? 410 : 409, restartUpload: expired });

// Do not steal an expired attempt: its uncancellable provider RPC may still be
// running. Only that attempt can release the slot once all physical writes settle.
export async function claimChunkAttempt(env, id, index, timeoutMs = 180000) {
    const bucket = env.img_r2;
    const db = getDatabase(env);
    const token = crypto.randomUUID();
    const state = { token, sessionId: id, index, active: true, until: Date.now() + timeoutMs, expiresAt: Date.now() + 2 * 3600000 };
    if (bucket?.get && bucket?.put) {
        const key = `${PREFIX}${encodeURIComponent(id)}/${index}.json`;
        const object = await bucket.get(key);
        const previous = object ? await new Response(object.body).json() : null;
        if (previous?.active) throw busy(previous.until <= Date.now());
        const claim = await r2Put(bucket, key, JSON.stringify(state), { onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' } });
        if (!claim) throw busy(false);
        return {
            async assertOwner() {
                const owner = await bucket.get(key);
                await owner?.body?.cancel();
                if (!owner || owner.etag !== claim.etag) throw busy(true);
            },
            async release() {
                await r2Put(bucket, key, JSON.stringify({ ...state, active: false }), { onlyIf: { etagMatches: claim.etag } });
            }
        };
    }
    if (typeof db.compareAndSwapSetting === 'function') {
        const key = settingKey(id, index);
        const raw = await db.get(key);
        const previous = raw ? JSON.parse(raw) : null;
        if (previous?.active) throw busy(previous.until <= Date.now());
        const value = JSON.stringify(state);
        if (!await db.compareAndSwapSetting(key, raw ?? null, value)) throw busy(false);
        return {
            async assertOwner() { if (await db.get(key) !== value) throw busy(true); },
            async release() { await db.compareAndSwapSetting(key, value, JSON.stringify({ ...state, active: false })); }
        };
    }
    throw Object.assign(new Error('Chunk uploads require R2 or D1 atomic attempt admission'), { status: 503 });
}


export async function cleanupChunkAttempts(env, { limit = 20 } = {}) {
    const db = getDatabase(env);
    limit = Math.max(1, Math.min(100, limit));
    const bucket = env.img_r2;
    const r2 = !!(bucket?.get && bucket?.put && bucket?.list);
    const cursorKey = 'manage@uploadAttemptCursor';
    const cursor = await db.get(cursorKey);
    const page = r2 ? await bucket.list({ prefix: PREFIX, limit, ...(cursor ? { cursor } : {}) })
        : await db.list({ prefix: 'manage@uploadAttempt@', limit, ...(cursor ? { cursor } : {}) });
    let deleted = 0;
    for (const item of r2 ? page.objects : page.keys) {
        const key = item.key || item.name;
        const object = r2 ? await bucket.get(key) : null;
        const value = r2 ? object && await new Response(object.body).text() : await db.get(key);
        let marker;
        try { marker = value && JSON.parse(value); } catch { continue; }
        if (!marker || marker.expiresAt > Date.now()) continue;
        const id = marker.sessionId || (r2 ? decodeURIComponent(key.slice(PREFIX.length).split('/')[0]) : key.slice('manage@uploadAttempt@'.length).split('@')[0]);
        const session = JSON.parse(await db.get(`upload_session_${id}`) || 'null');
        if (session && session.expiresAt > Date.now()) continue;
        // The session cannot admit another attempt. A late writer fails its owner
        // check and its conditional release cannot recreate this deleted marker.
        if (r2) await bucket.delete(key); else await db.delete(key);
        deleted++;
    }
    await db.put(cursorKey, (r2 ? page.truncated : page.list_complete === false) ? page.cursor || '' : '');
    return deleted;
}
