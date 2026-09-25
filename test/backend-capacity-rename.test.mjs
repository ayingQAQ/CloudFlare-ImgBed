import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveR2, releaseR2, chargeR2Usage, reconcileR2Capacity, expireR2Reservations, attachR2Multipart } from '../functions/utils/r2Capacity.js';
import { onRequest as rename } from '../functions/api/manage/rename/[[path]].js';
import { registerPublicFile, resolvePublicFile } from '../functions/utils/publicFileId.js';

globalThis.caches = { default: { async put() {} } };

function bucket() {
    const objects = new Map();
    let scans = 0;
    const store = {
        objects, get scans() { return scans; },
        async head(key) { const o = objects.get(key); return o ? { key, etag: o.etag, size: o.bytes.byteLength } : null; },
        async get(key) { const o = objects.get(key); return o ? { ...await store.head(key), body: new Response(o.bytes).body } : null; },
        async put(key, value, options = {}) {
            const bytes = new Uint8Array(await new Response(value).arrayBuffer());
            const old = objects.get(key);
            if (options.onlyIf?.etagMatches && old?.etag !== options.onlyIf.etagMatches) return null;
            if (options.onlyIf?.etagDoesNotMatch === '*' && old) return null;
            objects.set(key, { bytes, etag: crypto.randomUUID() });
            return store.head(key);
        },
        async delete(key) { objects.delete(key); },
        async list({ cursor = '', limit = 1000 } = {}) {
            scans++;
            const keys = [...objects.keys()].sort().filter(k => k > cursor);
            const page = keys.slice(0, limit);
            return { objects: await Promise.all(page.map(k => store.head(k))), truncated: keys.length > limit, cursor: page.at(-1) };
        },
    };
    return store;
}

function envFor(store, failNew = false) {
    const records = new Map([['old.jpg', { value: '', metadata: { Channel: 'CloudflareR2', FileName: 'old.jpg' } }]]);
    return { records, env: { img_r2: store, img_url: {
        async get(key) { return records.get(key)?.value ?? null; },
        async getWithMetadata(key) { return records.get(key) ?? null; },
        async put(key, value, options = {}) { if (failNew && key === 'new.jpg') throw new Error('metadata unavailable'); records.set(key, { value, metadata: options.metadata || {} }); },
        async delete(key) { records.delete(key); },
    } } };
}
function request() { return new Request('https://example.invalid/api/manage/rename/old.jpg', {method: 'POST', body: JSON.stringify({newFileId:'new.jpg'})}); }

test('rename metadata failure preserves source object and metadata', async () => {
    const storage = bucket(); await storage.put('old.jpg', 'source');
    const {env, records} = envFor(storage, true);
    const response = await rename({env, request: request(), params:{path:'old.jpg'}, waitUntil: p => p.catch(()=>{})});
    assert.equal(response.status, 500);
    assert.ok(await storage.head('old.jpg'));
    assert.ok(records.has('old.jpg'));
});

test('rename preserves public aliases and persists its index operation before success', async () => {
    const storage = bucket(); await storage.put('old.jpg', 'source');
    const {env, records} = envFor(storage);
    const alias = await registerPublicFile(env, 'old.jpg');
    const response = await rename({env, request: request(), params:{path:'old.jpg'}, waitUntil: p=>p.catch(()=>{})});
    assert.equal(response.status, 200);
    assert.equal(await resolvePublicFile(env, alias, async () => []), 'new.jpg');
    assert.equal(new TextDecoder().decode(storage.objects.get('new.jpg').bytes), 'source');
    assert.ok([...records.keys()].some(k => k.startsWith('manage@index@operation_')));
});

test('rename refuses an existing target storage object without overwriting it', async () => {
    const storage = bucket(); await storage.put('old.jpg', 'source'); await storage.put('new.jpg', 'unindexed target');
    const {env} = envFor(storage);
    const response = await rename({env, request:request(), params:{path:'old.jpg'}, waitUntil:p=>p.catch(()=>{})});
    assert.equal(response.ok, false);
    assert.equal(new TextDecoder().decode(storage.objects.get('new.jpg').bytes), 'unindexed target');
    assert.ok(await storage.head('old.jpg'));
});

test('capacity scans once then committed uploads continue to consume budget', async () => {
    const storage = bucket();
    const limit = 10 * 1024 * 1024;
    const first = await reserveR2(storage, 4 * 1024 * 1024, limit);
    await releaseR2(storage, first.id, {committed:true});
    const second = await reserveR2(storage, 4 * 1024 * 1024, limit);
    assert.ok(second.id);
    await releaseR2(storage, second.id, {committed:true});
    assert.equal((await reserveR2(storage, 2 * 1024 * 1024, limit)).id, null);
    assert.equal(storage.scans, 1);
});

test('failed capacity reservation releases space without rescanning', async () => {
    const storage = bucket(); const limit = 10 * 1024 * 1024;
    const first = await reserveR2(storage, 8 * 1024 * 1024, limit);
    await releaseR2(storage, first.id);
    assert.ok((await reserveR2(storage, 8 * 1024 * 1024, limit)).id);
    assert.equal(storage.scans, 1);
});

test('capacity reconciliation retains concurrent committed and in-flight bypass charges', async () => {
    const storage = bucket();
    for (let i = 0; i < 1001; i++) await storage.put(`file-${i}`, 'x');
    const limit = 20 * 1024 * 1024;
    await releaseR2(storage, (await reserveR2(storage, 0, limit)).id);
    await reconcileR2Capacity(storage, { pages: 1, force: true });
    const committed = await chargeR2Usage(storage, 2 * 1024 * 1024);
    await storage.put('file-000-added-before-cursor', new Uint8Array(2 * 1024 * 1024));
    await releaseR2(storage, committed, { committed: true });
    await releaseR2(storage, committed, { committed: true }); // idempotent release
    await chargeR2Usage(storage, 3 * 1024 * 1024);
    await reconcileR2Capacity(storage, { pages: 1, force: true });
    const result = await reserveR2(storage, 0, limit);
    assert.ok(result.usedBytes >= 3 * 1024 * 1024);
    assert.ok(result.usedBytes < 4 * 1024 * 1024);
    assert.equal(result.reservedBytes, 3 * 1024 * 1024);
});

test('expired multipart reservation is aborted before removal and retains uncertain bytes', async () => {
    const storage = bucket();
    const reservation = await reserveR2(storage, 1024, 10 * 1024 * 1024);
    let aborted = 0;
    storage.resumeMultipartUpload = () => ({ async abort() { aborted++; } });
    await attachR2Multipart(storage, reservation.id, { key: 'upload', uploadId: 'id' });
    const key = '.imgbed-internal/capacity.json';
    const state = await new Response((await storage.get(key)).body).json();
    state.reservations[reservation.id].expiresAt = 0;
    await storage.put(key, JSON.stringify(state));
    assert.equal(await expireR2Reservations(storage), 1);
    const result = await reserveR2(storage, 0, 10 * 1024 * 1024);
    assert.equal(aborted, 1);
    assert.equal(result.reservedBytes, 0);
    assert.equal(result.usedBytes, 1024 * 1024 + 1024);
});
