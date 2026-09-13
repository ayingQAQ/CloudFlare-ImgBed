import test from 'node:test';
import assert from 'node:assert/strict';
import { withOriginFallback, retryableRead, isKvQuotaError } from '../deploy/worker/origin-fallback.js';

const enabled = {
    ORIGIN_FALLBACK_MODE: 'routes',
    ORIGIN_STATE_READY: 'true',
    ORIGIN_BASE_URL: 'https://origin-vps.imgb.top',
};
const ctx = { passThroughOnException() {} };
const req = () => new Request('https://imgb.top/api/manage/list');
test('disabled on current deployment, custom domains and unverified state', async () => {
    for (const env of [{}, { ORIGIN_FALLBACK_MODE: 'routes' }]) {
        let touched = false;
        const result = await withOriginFallback(req(), env, ctx,
            async () => new Response('primary', { status: 503 }), async () => { touched = true; });
        assert.equal(result.status, 503); assert.equal(touched, false);
    }
});
test('captures KV list quota even when the index layer swallows its exception', async () => {
    let count = 0;
    const env = { ...enabled, img_url: { async list() { throw Error('KV list failed: 429 quota exceeded'); } } };
    const result = await withOriginFallback(req(), env, ctx, async (_, scoped) => {
        try { await scoped.img_url.list(); } catch {}
        return Response.json({ files: [] });
    }, async request => {
        count++;
        assert.equal(request.url, 'https://origin-vps.imgb.top/api/manage/list');
        assert.equal(request.headers.get('x-forwarded-host'), 'imgb.top');
        return new Response('origin');
    });
    assert.equal(await result.text(), 'origin'); assert.equal(count, 1);
});
test('business 429 does not bypass upload limits', async () => {
    const result = await withOriginFallback(req(), enabled, ctx,
        async () => new Response('Visitor quota', { status: 429 }),
        async () => { throw Error('must not call'); });
    assert.equal(result.status, 429);
    assert.equal(isKvQuotaError(Error('Visitor quota exceeded')), false);
});
test('GET mutations and POST uploads are never automatically replayed', async () => {
    for (const request of [new Request('https://imgb.top/api/manage/delete/x'),
        new Request('https://imgb.top/api/manage/list?action=delete-operations'),
        new Request('https://imgb.top/api/manage/list?action=rebuild'),
        new Request('https://imgb.top/upload', { method: 'POST', body: 'image' })]) {
        assert.equal(retryableRead(request), false);
        const result = await withOriginFallback(request, enabled, ctx,
            async () => new Response('failure', { status: 500 }),
            async () => { throw Error('must not call'); });
        assert.equal(result.status, 500);
    }
});
test('both intended domains are eligible; a different domain is not', async () => {
    for (const hostname of ['imgb.top', 'www.imgb.top', 'staging.workers.dev']) {
        let calls = 0;
        await withOriginFallback(new Request(`https://${hostname}/api/userConfig`), enabled, ctx,
            async () => new Response('primary', { status: 503 }),
            async () => { calls++; return new Response('origin'); });
        assert.equal(calls, hostname.endsWith('workers.dev') ? 0 : 1);
    }
});

test('an explicitly configured staging host is eligible', async () => {
    let originCalls = 0;
    const response = await withOriginFallback(
        new Request('https://origin-test.imgb.top/api/userConfig'),
        { ...enabled, ORIGIN_FALLBACK_TEST_HOST: 'origin-test.imgb.top' },
        ctx,
        async () => { throw new Error('staging fault'); },
        async () => { originCalls += 1; return new Response('origin'); },
    );
    assert.equal(await response.text(), 'origin');
    assert.equal(originCalls, 1);
});
test('read-only code exception falls back; origin exception fails closed', async () => {
    const primary = async () => { throw Error('code error'); };
    assert.equal(await (await withOriginFallback(req(), enabled, ctx, primary,
        async () => new Response('origin'))).text(), 'origin');
    assert.equal((await withOriginFallback(req(), enabled, ctx, primary,
        async () => { throw Error('unreachable'); })).status, 503);
});
test('healthy worker does not depend on origin availability', async () => {
    const result = await withOriginFallback(req(), enabled, ctx, async () => new Response('ok'),
        async () => { throw Error('unreachable'); });
    assert.equal(await result.text(), 'ok');
});
