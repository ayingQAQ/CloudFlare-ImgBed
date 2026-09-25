export { HFCommitCoordinator } from '../../functions/utils/storage/hfCommitCoordinator.js';

function unauthorized() {
    return new Response('Unauthorized', { status: 401, headers: { 'cache-control': 'no-store' } });
}

function json(data, status = 200) {
    return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

function keyFrom(url) {
    const encoded = url.searchParams.get('key');
    if (!encoded) throw new Error('Missing key');
    return encoded;
}

async function handleD1(request, env) {
    const { method, sql, params = [], column } = await request.json();
    let statement = env.img_d1.prepare(sql);
    if (params.length) statement = statement.bind(...params);
    if (method === 'first') return json({ result: await statement.first(column) });
    if (method === 'all') return json(await statement.all());
    if (method === 'run') return json(await statement.run());
    return json({ error: 'Unsupported D1 method' }, 400);
}

async function handleBackup(env) {
    const tables = ['files', 'settings', 'index_operations', 'index_metadata', 'other_data'];
    const snapshot = { format: 'imgbed-d1-json-v1', createdAt: new Date().toISOString(), tables: {} };
    const maxRows = 10_000;
    const configuredBytes = Number(env.BACKUP_JSON_MAX_BYTES);
    const maxBytes = Number.isSafeInteger(configuredBytes) && configuredBytes > 0
        ? Math.min(configuredBytes, 64 * 1024 * 1024) : 16 * 1024 * 1024;
    // Old immutable index generations are rebuildable cache, not live metadata.
    // Export the active generation in the same transaction, rather than allowing
    // retired snapshots to exhaust the backup budget after routine uploads.
    const source = table => table !== 'settings' ? table : `(SELECT s.* FROM settings s CROSS JOIN
        (SELECT 'manage@index_' || COALESCE((SELECT json_extract(value, '$.generation') || '_' FROM settings WHERE key = 'manage@index@meta'), '') AS active_prefix) idx
        WHERE substr(s.key, 1, 13) != 'manage@index_' OR substr(s.key, 1, length(idx.active_prefix)) = idx.active_prefix)`;
    const quoteName = value => `"${value.replaceAll('"', '""')}"`;
    const quoteText = value => `'${value.replaceAll("'", "''")}'`;
    // Only schema metadata is read outside the snapshot transaction. Include
    // every deployed column in the byte budget, including later migrations.
    const columns = await Promise.all(tables.map(async table => {
        const result = await env.img_d1.prepare(`PRAGMA table_info(${table})`).all();
        const names = result.results.map(column => column.name);
        if (!names.length) throw new Error(`Backup table missing: ${table}`);
        return names;
    }));
    const schemaChecks = tables.map((table, index) =>
        `(SELECT group_concat(name, char(31)) FROM pragma_table_info('${table}')) = ${quoteText(columns[index].join('\x1f'))}`);
    const estimates = tables.map((table, index) => {
        // JSON escaping takes at most six bytes per source byte. Per-column
        // overhead also covers property names, nulls, numbers and separators.
        // Compute lengths in SQL; never hydrate the potentially oversized rows.
        const sizes = columns[index].map(column =>
            `(6 * COALESCE(length(CAST(${quoteName(column)} AS BLOB)), 0) + ${6 * new TextEncoder().encode(column).byteLength + 24})`).join(' + ');
        return `SELECT COUNT(*) AS row_count, COALESCE(SUM(${sizes}), 0) AS byte_count FROM (SELECT ${columns[index].map(quoteName).join(', ')} FROM ${source(table)} LIMIT ${maxRows + 1})`;
    });
    const admission = `WITH backup_totals AS (
        SELECT SUM(row_count) AS row_count, SUM(byte_count) AS byte_count FROM (${estimates.join(' UNION ALL ')})
    ), backup_gate AS (
        SELECT row_count, byte_count, (${schemaChecks.join(' AND ')}) AS schema_ok,
            CASE WHEN (${schemaChecks.join(' AND ')}) AND row_count <= ${maxRows} AND byte_count <= ${maxBytes} THEN 1 ELSE 0 END AS admitted
        FROM backup_totals
    )`;
    // D1 batch executes in one transaction so related tables cannot be captured
    // on opposite sides of a concurrent move/upload. Every SELECT checks the
    // same snapshot budget, so an oversized database returns zero payload rows.
    const statements = [env.img_d1.prepare(`${admission} SELECT * FROM backup_gate`),
        ...tables.map((table, index) => env.img_d1.prepare(`${admission} SELECT ${columns[index].map(quoteName).join(', ')} FROM ${source(table)} WHERE (SELECT admitted FROM backup_gate) = 1`))];
    const results = await env.img_d1.batch(statements);
    const gate = results[0]?.results?.[0];
    if (!gate) throw new Error('Backup admission result missing');
    if (!gate.schema_ok) return json({ error: 'Database schema changed during backup; retry the export.' }, 409);
    if (!gate.admitted) return json({ error: 'Database exceeds the bounded inline backup budget. Use native D1 export for a complete database snapshot.', maxRows, maxBytes }, 413);
    tables.forEach((table, index) => { snapshot.tables[table] = results[index + 1].results || []; });
    return json(snapshot);
}

function objectHeaders(object) {
    const headers = new Headers({
        'x-r2-key': encodeURIComponent(object.key || ''),
        'x-r2-size': String(object.size ?? 0),
        'x-r2-etag': object.etag || '',
    });
    if (object.range) {
        headers.set('x-r2-range-offset', String(object.range.offset));
        headers.set('x-r2-range-length', String(object.range.length));
    }
    object.writeHttpMetadata?.(headers);
    headers.set('cache-control', 'private, no-store');
    return headers;
}

async function handleR2(request, env, url) {
    if (url.pathname === '/r2/list') {
        const options = await request.json();
        const result = await env.img_r2.list(options);
        return json({
            ...result,
            objects: result.objects.map(o => ({ key: o.key, size: o.size, etag: o.etag })),
        });
    }
    if (url.pathname === '/r2/multipart/create') {
        const upload = await env.img_r2.createMultipartUpload(keyFrom(url));
        return json({ key: upload.key, uploadId: upload.uploadId });
    }
    if (url.pathname === '/r2/multipart/part') {
        const upload = env.img_r2.resumeMultipartUpload(keyFrom(url), url.searchParams.get('uploadId'));
        return json(await upload.uploadPart(Number(url.searchParams.get('partNumber')), request.body));
    }
    if (url.pathname === '/r2/multipart/complete') {
        const upload = env.img_r2.resumeMultipartUpload(keyFrom(url), url.searchParams.get('uploadId'));
        return json(await upload.complete(await request.json()) || { success: true });
    }
    if (url.pathname === '/r2/multipart/abort') {
        const upload = env.img_r2.resumeMultipartUpload(keyFrom(url), url.searchParams.get('uploadId'));
        await upload.abort();
        return json({ success: true });
    }

    const key = keyFrom(url);
    if (request.method === 'HEAD') {
        const object = await env.img_r2.head(key);
        return object ? new Response(null, { headers: objectHeaders(object) }) : new Response(null, { status: 404 });
    }
    if (request.method === 'GET') {
        const offset = url.searchParams.get('offset');
        const length = url.searchParams.get('length');
        const suffix = url.searchParams.get('suffix');
        const options = {};
        if (suffix !== null) options.range = { suffix: Number(suffix) };
        else if (offset !== null) options.range = { offset: Number(offset), ...(length === null ? {} : { length: Number(length) }) };
        if (request.headers.has('x-r2-if-match')) options.onlyIf = { etagMatches: request.headers.get('x-r2-if-match') };
        if (request.headers.has('x-r2-if-none-match')) options.onlyIf = { ...options.onlyIf, etagDoesNotMatch: request.headers.get('x-r2-if-none-match') };
        const object = await env.img_r2.get(key, options);
        return object?.body
            ? new Response(object.body, { headers: objectHeaders(object) })
            : new Response(null, { status: object ? 412 : 404, headers: object ? objectHeaders(object) : { 'cache-control': 'no-store' } });
    }
    if (request.method === 'PUT') {
        const onlyIf = {};
        if (request.headers.has('x-r2-if-match')) onlyIf.etagMatches = request.headers.get('x-r2-if-match');
        if (request.headers.has('x-r2-if-none-match')) onlyIf.etagDoesNotMatch = request.headers.get('x-r2-if-none-match');
        const metadata = JSON.parse(decodeURIComponent(request.headers.get('x-r2-metadata') || '%7B%7D'));
        const options = { ...metadata, ...(Object.keys(onlyIf).length ? { onlyIf } : {}) };
        const object = await env.img_r2.put(key, request.body, options);
        return object ? new Response(null, { headers: objectHeaders(object) }) : new Response(null, { status: 412 });
    }
    if (request.method === 'DELETE') {
        await env.img_r2.delete(key);
        return new Response(null, { status: 204 });
    }
    return new Response('Method Not Allowed', { status: 405 });
}

export default {
    async fetch(request, env) {
        if (!env.GATEWAY_SECRET || request.headers.get('authorization') !== `Bearer ${env.GATEWAY_SECRET}`) {
            return unauthorized();
        }
        try {
            const url = new URL(request.url);
            if (url.pathname === '/hf/commit' && request.method === 'POST') {
                const body = await request.json();
                if (!/^[\w.-]+\/[\w.-]+$/.test(body.repo || '')) return json({ error: 'Invalid repo' }, 400);
                const id = env.HF_COMMITS.idFromName(body.repo);
                return env.HF_COMMITS.get(id).fetch('https://hf-commit/submit', { method: 'POST', body: JSON.stringify(body) });
            }
            if (url.pathname === '/backup' && request.method === 'GET') return await handleBackup(env);
            if (url.pathname === '/d1' && request.method === 'POST') return await handleD1(request, env);
            if (url.pathname.startsWith('/r2/')) return await handleR2(request, env, url);
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            return json({ error: error?.message || String(error) }, 500);
        }
    },
};
