import test from 'node:test';
import assert from 'node:assert/strict';
import gateway from '../deploy/worker/state-gateway.js';
import { RemoteR2Storage } from '../deploy/server/remoteR2.js';
import { syncOriginChannels, ORIGIN_CHANNEL_KEY } from '../functions/utils/originChannels.js';
import { publicRequest } from '../deploy/server/public-request.js';

test('backup reads all metadata tables in one D1 transaction', async () => {
    let calls = 0;
    const response = await gateway.fetch(new Request('https://state.test/backup', { headers: { authorization: 'Bearer test-secret' } }), {
        GATEWAY_SECRET: 'test-secret',
        img_d1: { prepare(sql) { return sql; }, async batch(statements) { calls++; assert.equal(statements.length, 5); return statements.map(() => ({ results: [] })); } },
    });
    assert.equal(response.status, 200);
    assert.equal(Object.keys((await response.json()).tables).length, 5);
    assert.equal(calls, 1);
});

test('remote R2 preserves unicode keys, open ranges, bytes and conditional reads', async () => {
    const bytes = new TextEncoder().encode('abcdefghij');
    const key = '测试/100%原图.jpg';
    const bucket = {
        async get(input, options) {
            assert.equal(input, key);
            const metadata = { key, size: bytes.length, etag: 'current', writeHttpMetadata(h) { h.set('content-type','image/jpeg'); } };
            if (options.onlyIf?.etagMatches === 'stale') return metadata;
            const offset = options.range?.offset ?? (options.range?.suffix ? bytes.length-options.range.suffix : 0);
            const length = options.range?.length ?? bytes.length-offset;
            return { ...metadata, body: new Blob([bytes.slice(offset,offset+length)]).stream(), range: options.range ? {offset,length} : undefined };
        },
    };
    const remote = new RemoteR2Storage('https://state.test','test-secret',(url,init)=>gateway.fetch(new Request(url,init),{GATEWAY_SECRET:'test-secret',img_r2:bucket}));
    for (const [range, expected] of [[{offset:2,length:3},'cde'],[{offset:7},'hij'],[{suffix:2},'ij']]) {
        const object = await remote.get(key,{range});
        assert.equal(object.key,key);assert.equal(object.size,10);
        assert.equal(await new Response(object.body).text(),expected);
        assert.equal(object.range.length,expected.length);
        const h = new Headers();object.writeHttpMetadata(h);assert.equal(h.get('content-type'),'image/jpeg');
    }
    assert.equal((await remote.get(key,{onlyIf:{etagMatches:'stale'}})).body,undefined);
    assert.equal((await gateway.fetch(new Request('https://state.test/backup'),{GATEWAY_SECRET:'test-secret'})).status,401);
});

test('channel synchronization cannot overwrite administrator settings and avoids unchanged writes', async()=>{
    const records=new Map();let writes=0;
    const db={prepare(sql){let params;return {bind(...p){params=p;return this;},async first(){return records.has(params[0])?{value:records.get(params[0])}:null;},async run(){writes++;records.set(params[0],params[1]);return {success:true};}};}};
    const env={img_d1:db,ORIGIN_STATE_READY:'true',HF_TOKEN:'hf-test',TG_BOT_TOKEN:'tg-test',BASIC_PASS:'must-not-copy'};
    await syncOriginChannels(env);
    assert.equal(records.size,1);const value=records.get(ORIGIN_CHANNEL_KEY);
    assert.ok(value.includes('hf-test'));assert.ok(!value.includes('must-not-copy'));
    const count=writes;await syncOriginChannels(env);assert.equal(writes,count);
});

test('origin restores HTTPS and only approved public hostnames', () => {
    const r = publicRequest(new Request('http://origin-vps.imgb.top/upload', { headers: { 'x-forwarded-proto': 'https', 'x-imgbed-public-host': 'www.imgb.top' } }));
    assert.equal(r.url, 'https://www.imgb.top/upload');
    const bad = publicRequest(new Request('http://origin-vps.imgb.top/upload', { headers: { 'x-imgbed-public-host': 'evil.example' } }));
    assert.equal(new URL(bad.url).hostname, 'origin-vps.imgb.top');
});
