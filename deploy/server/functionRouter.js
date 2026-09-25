import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// The registry is bounded by deployed files. User-controlled paths never add
// cache entries and routing requires no filesystem operations after startup.
export function createFunctionRouter(root) {
    const exact = new Map();
    const indexes = new Map();
    const catchalls = new Map();
    const middlewares = new Map();
    function scan(directory, prefix = '') {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const file = join(directory, entry.name);
            if (entry.isDirectory()) { scan(file, `${prefix}/${entry.name}`); continue; }
            if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
            if (entry.name === '_middleware.js') middlewares.set(prefix, file);
            else if (entry.name === '[[path]].js') catchalls.set(prefix, file);
            else {
                exact.set(`${prefix}/${entry.name.slice(0, -3)}`, file);
                if (entry.name === 'index.js') indexes.set(prefix, file);
            }
        }
    }
    scan(root);
    return {
        findFunctionFile(pathname) {
            const parts = pathname.split('/').filter(Boolean);
            const path = '/' + parts.join('/');
            const file = exact.get(path) || (parts.length && indexes.get(path));
            if (file) return { file, params: {} };
            for (let index = parts.length; index >= 0; index--) {
                const prefix = index ? '/' + parts.slice(0, index).join('/') : '';
                if (catchalls.has(prefix)) return { file: catchalls.get(prefix), params: { path: parts.slice(index) } };
            }
            return null;
        },
        findMiddlewareFiles(pathname) {
            const parts = pathname.split('/').filter(Boolean);
            const found = [];
            for (let index = 0; index <= parts.length; index++) {
                const prefix = index ? '/' + parts.slice(0, index).join('/') : '';
                if (middlewares.has(prefix)) found.push(middlewares.get(prefix));
            }
            return found;
        },
    };
}
