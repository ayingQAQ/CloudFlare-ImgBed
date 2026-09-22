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
    // D1 batch executes in one transaction so related tables cannot be captured
    // on opposite sides of a concurrent move/upload.
    const results = await env.img_d1.batch(tables.map(table => env.img_d1.prepare(`SELECT * FROM ${table}`)));
    tables.forEach((table, index) => { snapshot.tables[table] = results[index].results || []; });
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
            if (url.pathname === '/backup' && request.method === 'GET') return await handleBackup(env);
            if (url.pathname === '/d1' && request.method === 'POST') return await handleD1(request, env);
            if (url.pathname.startsWith('/r2/')) return await handleR2(request, env, url);
            return new Response('Not Found', { status: 404 });
        } catch (error) {
            return json({ error: error?.message || String(error) }, 500);
        }
    },
};
