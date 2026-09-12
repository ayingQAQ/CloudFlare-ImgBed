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
    const existing = await db.get(PREFIX + alias);
    if (existing) return existing;
    // Old files receive aliases on first use, without moving their storage objects.
    const files = await loadFiles();
    for (const file of files) {
        const id = file.id || file.name;
        if (await publicFileId(id) === alias) {
            await registerPublicFile(env, id);
            return id;
        }
    }
    return null;
}
