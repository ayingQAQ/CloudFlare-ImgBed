import { getDatabase } from './databaseAdapter.js';
const PREFIX = 'manage@directory@';

export function directoryPath(value) {
    if (typeof value !== 'string') throw new Error('Invalid directory');
    const path = value.replace(/^\/+|\/+$/g, '');
    if (!path || path.length > 500 || path.split('/').some(p => !p.trim() || p === '.' || p === '..' || p.startsWith('manage@')) || /[\\\u0000-\u001f]/.test(path)) throw new Error('Invalid directory');
    return path;
}

export async function savedDirectories(env) {
    const db = getDatabase(env);
    const paths = [];
    let cursor;
    do {
        const page = await db.list({ prefix: PREFIX, limit: 1000, ...(cursor ? { cursor } : {}) });
        paths.push(...page.keys.map(key => key.name.slice(PREFIX.length)));
        cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
    return paths;
}

export async function saveDirectory(env, path) {
    await getDatabase(env).put(PREFIX + directoryPath(path), '1');
}

export async function mergeDirectories(env, result, dir) {
    const prefix = dir ? dir.replace(/\/+$/, '') + '/' : '';
    const paths = new Set(result.directories || []);
    for (const path of await savedDirectories(env)) {
        if (!path.startsWith(prefix) || path === prefix.slice(0, -1)) continue;
        const child = path.slice(prefix.length).split('/')[0];
        if (child) paths.add(prefix + child);
    }
    result.directories = [...paths];
    result.directFolderCount = paths.size;
    return result;
}

export async function changeDirectories(env, source, destination = null) {
    source = directoryPath(source);
    const db = getDatabase(env);
    const paths = (await savedDirectories(env)).filter(p => p === source || p.startsWith(source + '/'));
    for (const path of paths) {
        if (destination !== null) await saveDirectory(env, destination + path.slice(source.length));
        await db.delete(PREFIX + path);
    }
}
