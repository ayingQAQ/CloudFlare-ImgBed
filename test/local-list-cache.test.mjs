import test from 'node:test';
import assert from 'node:assert/strict';
import {LocalListCache} from '../deploy/server/listCache.js';
test('list cache expires and evicts by bytes while ignoring file payloads', async () => {
    let now = 0;
    const cache = new LocalListCache({maxBytes: 6, maxEntryBytes: 4, now: () => now});
    const response = data => new Response(data, {headers: {'cache-control':'public, max-age=1'}});
    const key = id => `https://test/api/publicFileList?dir=${id}`;
    await cache.put(key(1), response('1234'));
    assert.equal(await (await cache.match(key(1))).text(), '1234');
    await cache.put(key(2), response('5678'));
    assert.equal(await cache.match(key(1)), undefined);
    await cache.put('https://test/file/large', response('xx'));
    assert.equal(cache.entries.size, 1);
    await cache.put(key(3), response('oversized'));
    assert.equal(cache.entries.size, 1);
    now = 1001;
    assert.equal(await cache.match(key(2)), undefined);
    assert.equal(cache.bytes, 0);
});
test('max-age=0 invalidates a cached list', async () => {
    const cache = new LocalListCache(), key='https://test/api/randomFileList?dir=';
    await cache.put(key, new Response('[]', {headers:{'cache-control':'public, max-age=60'}}));
    await cache.put(key, new Response(null, {headers:{'cache-control':'max-age=0'}}));
    assert.equal(await cache.match(key), undefined);
});
test('invalidation wins over a pending cache fill', async () => {
    const cache = new LocalListCache();
    const key = 'https://example.test/api/publicFileList?dir=';
    let controller;
    const body = new ReadableStream({ start(c) { controller = c; } });
    const fill = cache.put(key, new Response(body, { headers: { 'cache-control': 'max-age=300' } }));
    await cache.delete(key);
    controller.enqueue(new TextEncoder().encode('old list')); controller.close();
    await fill;
    assert.equal(await cache.match(key), undefined);
});

test('oversized cloned body does not wait for its other tee branch', async () => {
    const cache = new LocalListCache({ maxEntryBytes: 2 });
    const response = new Response('oversized', { headers: { 'cache-control': 'max-age=300' } });
    await cache.put('https://example.test/api/publicFileList?dir=', response.clone());
    assert.equal(await response.text(), 'oversized');
    assert.equal(cache.pending.size, 0);
});
test('concurrent fills of the same cache key obey admission capacity', async () => {
    const cache = new LocalListCache();
    const key = 'https://example.test/api/publicFileList?dir=';
    const controllers = [];
    const fills = Array.from({ length: 8 }, () => cache.put(key, new Response(new ReadableStream({ start(c) { controllers.push(c); } }), {
        headers: { 'cache-control': 'max-age=300' },
    })));
    let cancelled = false;
    await cache.put(key, new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'cache-control': 'max-age=300' } }));
    assert.equal(cache.active, 8);
    assert.equal(cancelled, true);
    for (const controller of controllers) controller.close();
    await Promise.all(fills);
    assert.equal(cache.active, 0);
});
