import { getDatabase } from './databaseAdapter.js';

const PREFIX = 'manage@public-file@';
export const isPublicFileId = id => /^p_[a-f0-9]{64}(?:\.[a-z0-9]{1,10})?$/.test(id);

export async function publicFileId(id) {
    if (isPublicFileId(id)) return id;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
    const hash = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    const extension = id.match(/\.([a-zA-Z0-9]{1,10})$/)?.[1]?.toLowerCase();
    return `p_${hash}${extension ? '.' + extension : ''}`;
}

export async function registerPublicFile(env, id) {
    const alias = await publicFileId(id);
    await getDatabase(env).put(PREFIX + alias, id);
    return alias;
}

export async function unregisterPublicFile(env, id) {
    const alias = await publicFileId(id);
    await getDatabase(env).delete(PREFIX + alias);
}

export async function relocatePublicFile(env, oldId, newId) {
    const db = getDatabase(env);
    const oldAlias = await publicFileId(oldId);
    const newAlias = await publicFileId(newId);
    await Promise.all([
        db.put(PREFIX + oldAlias, newId),
        db.put(PREFIX + newAlias, newId),
    ]);
    return newAlias;
}

export async function resolvePublicFile(env, alias, loadFiles) {
    if (!isPublicFileId(alias)) return alias;
    const db = getDatabase(env);
    let existing = await db.get(PREFIX + alias);
    if (existing) {
        const seen = new Set([alias]);
        for (let depth = 0; depth < 64; depth++) {
            const nextAlias = await publicFileId(existing);
            if (depth === 0 && nextAlias === alias) return existing;
            if (seen.has(nextAlias)) return null;
            seen.add(nextAlias);
            const next = await db.get(PREFIX + nextAlias);
            if (!next || next === existing) return existing;
            existing = next;
        }
        throw new Error('Public link relocation chain is too long');
    }
    // Unknown public input never starts a library scan. Legacy mappings are filled
    // by bounded maintenance, independently of requests for arbitrary aliases.
    return null;
}

const BACKFILL_KEY = 'manage@public-file-backfill@v1';
export async function resetPublicFileAliasBackfill(env) {
    await getDatabase(env).put(BACKFILL_KEY, JSON.stringify({ cursor: null, complete: false }));
}

export async function backfillPublicFileAliases(env, { limit = 100 } = {}) {
    const db = getDatabase(env);
    const state = JSON.parse(await db.get(BACKFILL_KEY) || '{}');
    if (state.complete) return { processed: 0, complete: true };
    const page = await db.list({ limit: Math.min(1000, Math.max(1, Number(limit) || 100)), cursor: state.cursor || undefined });
    let processed = 0;
    for (const file of page.keys || []) {
        const id = file.name;
        if (/^(manage@|chunk_|upload_session_|multipart_)/.test(id) || !file.metadata?.TimeStamp) continue;
        const alias = await publicFileId(id);
        // Preserve existing relocations if an old ID is reintroduced later.
        if (!await db.get(PREFIX + alias)) await db.put(PREFIX + alias, id);
        processed++;
    }
    const complete = page.list_complete === true || !page.cursor;
    await db.put(BACKFILL_KEY, JSON.stringify({ cursor: page.cursor || null, complete }));
    return { processed, complete, cursor: page.cursor || null };
}
