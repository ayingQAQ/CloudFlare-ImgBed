import test from 'node:test';
import assert from 'node:assert/strict';
import { HFCommitCoordinator } from '../functions/utils/storage/hfCommitCoordinator.js';
import { HuggingFaceAPI } from '../functions/utils/storage/huggingfaceAPI.js';
import gateway from '../deploy/worker/state-gateway.js';

test('preserved production HF coordinator batches requests and retains cooldown', async () => {
    const state = new Map(); let commits = 0;
    const coordinator = new HFCommitCoordinator({ storage: {
        async get(key) { return state.get(key); }, async put(key, value) { state.set(key, value); },
    } }, {}, { now: () => 1000, timer() {}, fetcher: async (url, init) => {
        commits++; assert.equal(init.body.split('\n').length, 3);
        return Response.json({ commitOid: 'mock' });
    } });
    const request = path => new Request('https://hf-commit/submit', { method: 'POST', body: JSON.stringify({
        repo: 'test/repo', token: 'test-only', operation: { key: 'file', value: { path, content: 'aA==', encoding: 'base64' } },
    }) });
    const results = [coordinator.fetch(request('a')), coordinator.fetch(request('b'))];
    await new Promise(resolve => setImmediate(resolve));
    await coordinator.flush();
    assert.deepEqual((await Promise.all(results)).map(response => response.status), [200, 200]);
    assert.equal(commits, 1); assert.equal(state.get('nextAt'), 36000);
});

test('HF upload client and authenticated gateway preserve existing durable binding', async () => {
    let body;
    const env = { GATEWAY_SECRET: 'test-only', HF_COMMITS: {
        idFromName(repo) { assert.equal(repo, 'test/repo'); return repo; },
        get() { return { async fetch(url, init) { body = JSON.parse(init.body); return Response.json({ ready: true }); } }; },
    } };
    const api = new HuggingFaceAPI('test-token', 'test/repo', false, env);
    assert.equal((await api.coordinatedCommit(null)).ready, true);
    assert.equal(body.check, true);
    const request = new Request('https://gateway/hf/commit', { method: 'POST',
        headers: { Authorization: 'Bearer test-only' }, body: JSON.stringify({ repo: 'test/repo', check: true }) });
    assert.equal((await gateway.fetch(request, env)).status, 200);
    assert.equal((await gateway.fetch(new Request(request.url, { method: 'POST' }), env)).status, 401);
});
