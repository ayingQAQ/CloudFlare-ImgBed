import test from 'node:test';
import assert from 'node:assert/strict';
import { HFCommitCoordinator, hfRetryDelay } from '../functions/utils/storage/hfCommitCoordinator.js';
import { HuggingFaceAPI } from '../functions/utils/storage/huggingfaceAPI.js';
import { originRequestTimeout } from '../deploy/worker/origin-fallback.js';

function setup(fetcher) {
    const data = new Map();
    const storage = { get: async key => data.get(key), put: async (key, value) => data.set(key, value) };
    const timers = [];
    let now = 100000;
    const options = { now: () => now, timer: (fn, delay) => timers.push({ fn, delay }), fetcher };
    const object = new HFCommitCoordinator({ storage }, {}, options);
    return { object, data, timers, storage, options, advance: n => { now += n; } };
}
const req = (path = 'a.jpg') => new Request('https://commit', { method: 'POST', body: JSON.stringify({
    repo: 'owner/repo', token: 'secret', operation: { key: 'lfsFile', value: { path, oid: 'a'.repeat(64), size: 12, algo: 'sha256' } }
}) });

test('five concurrent files become one commit; requests wait for HF acceptance', async () => {
    const calls = [];
    const s = setup(async (url, init) => { calls.push(init); return Response.json({ commitOid: 'abc' }); });
    await s.object.ready;
    let done = 0;
    const promises = Array.from({ length: 5 }, (_, i) => s.object.fetch(req(`${i}.jpg`)).then(r => { done++; return r; }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(done, 0); assert.equal(s.timers.length, 1);
    await s.object.flush();
    const responses = await Promise.all(promises);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.split('\n').length, 6);
    for (const r of responses) assert.equal((await r.json()).commitOid, 'abc');
    assert.equal(s.data.get('nextAt'), 135000);
});

test('single file flushes without waiting for a full batch', async () => {
    const s = setup(async () => Response.json({ ok: true }));
    const p = s.object.fetch(req());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.timers[0].delay, 2000);
    await s.object.flush(); assert.equal((await p).status, 200);
});

test('429 is not success; repository cooldown survives coordinator restart', async () => {
    let calls = 0;
    const s = setup(async () => { calls++; return Response.json({ error: 'rate limited' }, { status: 429, headers: { 'Retry-After': '3600' } }); });
    const p = s.object.fetch(req());
    await new Promise(resolve => setImmediate(resolve));
    await s.object.flush();
    assert.equal((await p).status, 429);
    const restarted = new HFCommitCoordinator({ storage: s.storage }, {}, s.options);
    const r = await restarted.fetch(req('b.jpg'));
    assert.equal(r.status, 429); assert.equal(r.headers.get('Retry-After'), '3600');
    assert.equal(calls, 1);
});

test('HF rejection fails all batch members; no success is returned early', async () => {
    const s = setup(async () => Response.json({ error: 'bad file' }, { status: 400 }));
    const p = [s.object.fetch(req('a')), s.object.fetch(req('b'))];
    await new Promise(resolve => setImmediate(resolve)); await s.object.flush();
    for (const response of await Promise.all(p)) assert.equal(response.status, 400);
});

test('parse HF cooldown response without losing minute/hour units', () => {
    assert.equal(hfRetryDelay(null, 'retry this action in about 1 hour'), 3605000);
    assert.equal(hfRetryDelay(null, 'retry this action in 32 minutes'), 1925000);
    assert.equal(hfRetryDelay('120', ''), 120000);
});

test('LFS and direct-file clients both use the coordinator', async () => {
    const bodies = [];
    const env = { HF_COMMITS: { idFromName: x => x, get: () => ({ fetch: async (url, init) => {
        bodies.push(JSON.parse(init.body)); return Response.json({ commitOid: 'abc' });
    } }) } };
    const api = new HuggingFaceAPI('secret', 'owner/repo', true, env);
    await api.commitLfsFile('a.jpg', 'abc', 123, 'upload');
    await api.commitDirectFile('b.txt', new Blob(['text']), 'upload');
    assert.deepEqual(bodies.map(x => x.operation.key), ['lfsFile', 'file']);
});

test('second batch waits for the persisted submission interval', async () => {
    const s = setup(async () => Response.json({ commitOid: 'abc' }));
    const first = s.object.fetch(req());
    await new Promise(resolve => setImmediate(resolve));
    s.timers.shift().fn();
    await first;
    s.advance(1000);
    const second = s.object.fetch(req('b'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(s.timers[0].delay, 34000);
    s.advance(34000); s.timers.shift().fn();
    assert.equal((await second).status, 200);
});

test('cooldown preflight rejects before uploading file contents', async () => {
    const s = setup(() => { throw Error('must not submit'); });
    s.data.set('nextAt', 400000);
    const restarted = new HFCommitCoordinator({ storage: s.storage }, {}, s.options);
    const env = { HF_COMMITS: { idFromName: x => x, get: () => ({ fetch: (url, init) => restarted.fetch(new Request(url, init)) }) } };
    const api = new HuggingFaceAPI('secret', 'owner/repo', true, env);
    await assert.rejects(api.uploadFile(new Blob(['test']), 'a'), error => error.status === 429 && error.retryAfter === '300');
});

test('unreadable HF success response is an uncertain failure, never success', async () => {
    const s = setup(async () => ({ status: 200, text: async () => { throw Error('connection reset'); } }));
    const p = s.object.fetch(req());
    await new Promise(resolve => setImmediate(resolve)); await s.object.flush();
    assert.equal((await p).status, 502);
});

test('only upload mutations receive a longer origin timeout', () => {
    const request = (path, method = 'POST') => new Request(`https://imgb.top${path}`, { method });
    assert.equal(originRequestTimeout(request('/upload')), 110000);
    assert.equal(originRequestTimeout(request('/upload/huggingface/commitUpload')), 110000);
    assert.equal(originRequestTimeout(request('/api/manage/list', 'GET')), 15000);
    assert.equal(originRequestTimeout(request('/api/auth/login')), 15000);
});

test('real Durable Object runtime batches simultaneous requests and returns the commit', { timeout: 15000 }, async () => {
    const { Miniflare, Response: MFResponse } = await import('miniflare');
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(new URL('../functions/utils/storage/hfCommitCoordinator.js', import.meta.url), 'utf8');
    const calls = [];
    const mf = new Miniflare({
        modules: true, compatibilityDate: '2024-08-21',
        script: source + '\nexport default { fetch(request, env) { return env.HF_COMMITS.get(env.HF_COMMITS.idFromName("owner/repo")).fetch(request); } };',
        durableObjects: { HF_COMMITS: { className: 'HFCommitCoordinator', useSQLite: true } },
        outboundService: async request => {
            calls.push(await request.text());
            return new MFResponse(JSON.stringify({ commitOid: 'runtime-commit' }), { headers: { 'Content-Type': 'application/json' } });
        },
    });
    try {
        await mf.ready;
        const responses = await Promise.all(Array.from({ length: 5 }, async (_, i) =>
            mf.dispatchFetch('http://local/commit', { method: 'POST', body: await req(`${i}.jpg`).text() })));
        for (const response of responses) assert.equal((await response.json()).commitOid, 'runtime-commit');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].split('\n').length, 6);
    } finally { await mf.dispose(); }
});
