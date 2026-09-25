import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticate } from '../functions/utils/auth/authCore.js';
import { moveFile, onRequest as move } from '../functions/api/manage/move/[[path]].js';
import { publicFileId, relocatePublicFile, resolvePublicFile } from '../functions/utils/publicFileId.js';
import { isPublicHostname } from '../functions/utils/publicAddress.js';
import { publicFetch } from '../deploy/server/public-fetch.js';
import { visitorIdentity } from '../functions/utils/visitorIdentity.js';
import { takeRateLimit } from '../functions/utils/rateLimit.js';
import { getAnonymousIdentity, reserveAnonymousUpload } from '../functions/utils/anonymousUpload.js';

function memoryBucket() {
    const objects = new Map(); let revision=0;
    return { async get(key) { const o=objects.get(key); return o ? { body: new Blob([o.value]).stream(), etag:o.etag } : null; },
        async put(key,value,options={}) {
            const old=objects.get(key);
            if (options.onlyIf?.etagDoesNotMatch==='*' && old || options.onlyIf?.etagMatches && options.onlyIf.etagMatches!==old?.etag) return null;
            const saved={value,etag:String(++revision)}; objects.set(key,saved); return saved;
        } };
}

test('signed visitor cookie ignores forged IDs and retains 30-per-visitor across IP changes', async () => {
    const env={img_r2:memoryBucket(),img_url:{get:async()=>JSON.stringify({auth:{admin:{adminUsername:'admin',adminPassword:'set'},user:{authCode:''}}})}};
    async function identify(cookie, id, ip) {
        const context={env,request:new Request('https://imgb.top/upload',{headers:{cookie:cookie||'', 'x-visitor-id':id,'CF-Connecting-IP':ip}})};
        context.next=async()=>Response.json(await getAnonymousIdentity(context.request));
        const response=await visitorIdentity(context); return {request:context.request,response,identity:await response.json()};
    }
    const first=await identify('',crypto.randomUUID(),'1.1.1.1');
    const cookie=first.response.headers.get('set-cookie').split(';')[0];
    const next=await identify(cookie,crypto.randomUUID(),'8.8.8.8');
    assert.equal(first.identity.hash,next.identity.hash);
    for(let i=0;i<30;i++) assert.ok((await reserveAnonymousUpload(env.img_r2, first.request)).reservationId);
    assert.equal((await reserveAnonymousUpload(env.img_r2, next.request)).reservationId,null);
    const other=await identify('',crypto.randomUUID(),'1.1.1.1');
    assert.notEqual(other.identity.hash,first.identity.hash);
    assert.ok((await reserveAnonymousUpload(env.img_r2, other.request)).reservationId);
});

test('shared login limiter rejects the eleventh attempt and expires', async()=>{
    const bucket=memoryBucket();
    for(let i=0;i<10;i++) assert.equal((await takeRateLimit(bucket,'login:ip',10,600000,1000)).allowed,true);
    assert.equal((await takeRateLimit(bucket,'login:ip',10,600000,1000)).allowed,false);
    assert.equal((await takeRateLimit(bucket,'login:ip',10,600000,601001)).allowed,true);
});

test('D1 failures must not grant administrator privileges', async () => {
    const env = { img_d1: { prepare() { return { bind() { return this; }, first() { throw Error('D1 unavailable'); }, all() { throw Error('D1 unavailable'); } }; } } };
    await assert.rejects(authenticate({ env, request: new Request('https://test/api/manage/list'), authScope: 'admin' }), /D1 unavailable/);
});

test('same-directory move is a no-op before any storage access', async () => {
    const response = await move({ env: {}, params: { path: 'a,image.jpg' }, request: new Request('https://test/api/manage/move/a/image.jpg?dist=a') });
    assert.equal((await response.json()).unchanged, true);
    assert.equal(await moveFile({}, 'a/x', 'a/x'), true);
});

test('failed metadata commit preserves source bytes; destination collision does not overwrite', async () => {
    for (const collision of [false, true]) {
        const objects = new Map([['a/x.jpg', 'original'], ...(collision ? [['b/x.jpg', 'other']] : [])]);
        const bucket = { get: async key => ({ body: objects.get(key) }), put: async (key, value, options) => {
            assert.equal(options.onlyIf.etagDoesNotMatch, '*');
            if (objects.has(key)) return null;
            objects.set(key, value); return { etag: 'copy' };
        }, delete: async key => objects.delete(key) };
        const env = { img_r2: bucket, img_url: {
            get: async () => null,
            getWithMetadata: async key => key === 'a/x.jpg' ? { value: '', metadata: { Channel: 'CloudflareR2' } } : { value: null, metadata: null },
            put: async () => { throw Error('D1 commit failure'); },
        } };
        assert.equal(await moveFile(env, 'a/x.jpg', 'b/x.jpg', '', new URL('https://test')), false);
        assert.equal(objects.get('a/x.jpg'), 'original');
        if (!collision) assert.equal(objects.get('b/x.jpg'), 'original');
        if (collision) assert.equal(objects.get('b/x.jpg'), 'other');
    }
});

test('public links survive repeated moves and a move back to the original path', async () => {
    const data = new Map(); const env = { img_url: { get: async k => data.get(k), put: async (k,v) => data.set(k,v) } };
    await relocatePublicFile(env, 'A/a.jpg', 'B/a.jpg');
    await relocatePublicFile(env, 'B/a.jpg', 'C/a.jpg');
    assert.equal(await resolvePublicFile(env, await publicFileId('A/a.jpg'), async()=>[]), 'C/a.jpg');
    await relocatePublicFile(env, 'C/a.jpg', 'A/a.jpg');
    assert.equal(await resolvePublicFile(env, await publicFileId('B/a.jpg'), async()=>[]), 'A/a.jpg');
});

test('public proxy blocks mapped IPv6, internal DNS answers and mixed DNS answers', async () => {
    for (const address of ['::ffff:7f00:1', '[::ffff:127.0.0.1]', '127.0.0.1', '10.0.0.1', 'localhost', 'service', 'fe80::1', 'fd00::1']) assert.equal(isPublicHostname(address), false, address);
    for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '1.1.1.1', family: 4 }, { address: '10.1.1.1', family: 4 }]]) {
        await assert.rejects(publicFetch('https://example.com', {}, async()=>addresses), /Disallowed resolved address/);
    }
});
