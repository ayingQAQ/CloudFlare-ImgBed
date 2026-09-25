import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalR2Storage } from '../deploy/server/r2Storage.js';
import { dockerImageProcessor } from '../deploy/server/imageProcessor.js';
import { TelegramAPI } from '../functions/utils/storage/telegramAPI.js';
import { onRequest } from '../functions/file/[[path]].js';
import { fetchUpstream } from '../functions/utils/upstreamFetch.js';
import { getFileContent } from '../functions/file/fileTools.js';
import { DiscordAPI } from '../functions/utils/storage/discordAPI.js';
import sharp from 'sharp';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

async function bucket(t) {
    const dir = await mkdtemp(join(tmpdir(), 'imgbed-runtime-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return new LocalR2Storage(dir);
}

test('LocalR2 conditional writes use the etag returned by head for normal objects', async t => {
    const r2 = await bucket(t);
    const old = await r2.put('file', 'old');
    assert.ok(await r2.put('file', 'new', { onlyIf: { etagMatches: old.etag } }));
    const attempts = await Promise.all(Array.from({ length: 6 }, () => r2.put('exclusive', 'one', { onlyIf: { etagDoesNotMatch: '*' } })));
    assert.equal(attempts.filter(Boolean).length, 1);
});

test('LocalR2 rejects incomplete multipart manifests without replacing the old object', async t => {
    const r2 = await bucket(t);
    await r2.put('file', 'old');
    const upload = await r2.createMultipartUpload('file');
    const one = await upload.uploadPart(1, 'abc');
    await assert.rejects(upload.complete([one, { partNumber: 2, etag: 'missing' }]));
    assert.equal(await new Response((await r2.get('file')).body).text(), 'old');
});

test('LocalR2 validates multipart etags and streams a suffix range', async t => {
    const r2 = await bucket(t);
    const upload = await r2.createMultipartUpload('file');
    const one = await upload.uploadPart(1, new Blob(['abc']));
    await assert.rejects(upload.complete([{ ...one, etag: 'wrong' }]));
    const two = await upload.uploadPart(2, new Response('def').body);
    await upload.complete([one, two]);
    const object = await r2.get('file', { range: { suffix: 2 } });
    assert.equal(await new Response(object.body).text(), 'ef');
    assert.deepEqual(object.range, { offset: 4, length: 2 });
});

test('LocalR2 source failure preserves destination and removes temporary data', async t => {
    const r2 = await bucket(t);
    await r2.put('file', 'old');
    let reads = 0;
    const stream = new ReadableStream({ pull(c) { if (++reads === 2) c.error(new Error('source failed')); else c.enqueue(new Uint8Array(1024)); } });
    await assert.rejects(r2.put('file', stream), /source failed/);
    assert.equal(await new Response((await r2.get('file')).body).text(), 'old');
    assert.deepEqual((await r2.list()).objects.map(o => o.key), ['file']);
});

test('image transforms acquire bounded admission before reading any input', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let opened = 0;
    const streams = Array.from({ length: 8 }, () => ({ async *[Symbol.asyncIterator]() { opened++; await gate; yield Buffer.from('<svg/>'); } }));
    const pending = streams.map(stream => dockerImageProcessor.transform(stream, { sourceType: 'image/svg+xml' }).catch(e => e));
    await delay(30);
    const admitted = opened;
    release();
    await Promise.all(pending);
    assert.equal(admitted, 1);
});

function chunkContext(headers = {}, signal) {
    const value = JSON.stringify(Array.from({ length: 8 }, (_, index) => ({ index, size: 1024, fileId: String(index) })));
    const metadata = { Channel: 'TelegramNew', ChannelName: 'Telegram_env', IsChunked: true, TotalChunks: 8, FileName: 'sample.bin', FileType: 'application/octet-stream', TimeStamp: 1 };
    return { env: { img_url: { async get() { return null; }, async getWithMetadata() { return { value, metadata }; } }, TG_BOT_TOKEN: 'fake', TG_CHAT_ID: 'fake' },
        request: new Request('https://example.invalid/file/sample.bin', { headers, signal }), params: { path: ['sample.bin'] }, data: {} };
}

test('chunk download does no work until read and never prefetches later parts', async t => {
    let fetched = 0;
    t.mock.method(TelegramAPI.prototype, 'getFileContent', async () => { fetched++; return new Response(new Uint8Array(1024)); });
    const response = await onRequest(chunkContext());
    await delay(30);
    const idleFetched = fetched;
    const reader = response.body.getReader();
    await reader.read();
    await delay(30);
    await reader.cancel();
    assert.equal(idleFetched, 0);
    assert.equal(fetched, 1);
});

test('chunk cancellation aborts an in-flight fetch', async t => {
    let upstreamSignal;
    t.mock.method(TelegramAPI.prototype, 'getFileContent', async (_id, options = {}) => {
        upstreamSignal = options.signal;
        return new Promise((resolve, reject) => options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    });
    const response = await onRequest(chunkContext());
    const reader = response.body.getReader();
    const pending = reader.read();
    await delay(20);
    await reader.cancel();
    await pending;
    assert.equal(upstreamSignal?.aborted, true);
});

test('chunk ranges cross boundaries, support suffixes, and reject unsatisfiable ranges', async t => {
    t.mock.method(TelegramAPI.prototype, 'getFileContent', async id => new Response(new Uint8Array(1024).fill(Number(id))));
    for (const [range, expected] of [['bytes=1022-1025', [0, 0, 1, 1]], ['bytes=-3', [7, 7, 7]]]) {
        const response = await onRequest(chunkContext({ Range: range }));
        assert.equal(response.status, 206);
        assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], expected);
    }
    const invalid = await onRequest(chunkContext({ Range: 'bytes=8192-' }));
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get('Content-Range'), 'bytes */8192');
});

test('Discord chunk route also remains idle until demand and supports cancellation', async t => {
    let fetched = 0;
    t.mock.method(DiscordAPI.prototype, 'getFileURL', async () => { fetched++; return 'https://cdn.example.invalid/file'; });
    t.mock.method(globalThis, 'fetch', async () => new Response(new Uint8Array(1024)));
    const context = chunkContext();
    const originalGet = context.env.img_url.getWithMetadata;
    context.env.img_url.getWithMetadata = async () => {
        const record = await originalGet();
        record.metadata.Channel = 'Discord';
        record.metadata.DiscordBotToken = 'fake';
        record.metadata.DiscordChannelId = 'fake';
        record.value = JSON.stringify(Array.from({ length: 8 }, (_, index) => ({ index, size: 1024, messageId: String(index) })));
        return record;
    };
    const response = await onRequest(context);
    await delay(10);
    assert.equal(fetched, 0);
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    assert.equal(fetched, 1);
});

test('download retries release failed bodies and stop after the configured attempts', async t => {
    let cancelled = 0;
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
    });
    assert.equal(await getFileContent(new Request('https://example.invalid'), 'https://upstream.invalid', 2), null);
    assert.equal(calls, 3);
    assert.equal(cancelled, 3);
});

test('upstream body idle timeout aborts the transport and cancels the body', async t => {
    let transportSignal;
    let cancelled = false;
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
        transportSignal = options.signal;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    });
    const response = await fetchUpstream('https://example.invalid', {}, 15);
    const pending = assert.rejects(response.text(), /timed out/);
    await delay(25);
    await pending;
    assert.equal(cancelled, true);
    assert.equal(transportSignal.aborted, true);
});

test('image admission rejects overload and cancels queued inputs before reading them', async () => {
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const first = dockerImageProcessor.transform({ async *[Symbol.asyncIterator]() { await gate; yield Buffer.from('<svg/>'); } }, { sourceType: 'image/svg+xml' });
    const aborter = new AbortController();
    let reads = 0;
    let cancelled = 0;
    const inputs = Array.from({ length: 12 }, () => new ReadableStream({ pull(c) { reads++; c.enqueue(new TextEncoder().encode('<svg/>')); c.close(); }, cancel() { cancelled++; } }, { highWaterMark: 0 }));
    const pending = inputs.map(stream => dockerImageProcessor.transform(stream, { sourceType: 'image/svg+xml', signal: aborter.signal }).catch(e => e));
    await delay(10);
    aborter.abort();
    const results = await Promise.all(pending);
    release();
    await first;
    assert.equal(reads, 0);
    assert.equal(cancelled, 12);
    assert.ok(results.some(error => error.statusCode === 503));
});

test('sharp transformation still produces resized image output', async () => {
    const input = await sharp({ create: { width: 20, height: 10, channels: 3, background: '#ff0000' } }).png().toBuffer();
    const response = await dockerImageProcessor.transform(new Response(input).body, { sourceType: 'image/png', outputFormat: 'image/png', width: 10 });
    const output = await sharp(Buffer.from(await response.arrayBuffer())).metadata();
    assert.equal(output.width, 10);
    assert.equal(output.height, 5);
});

test('cancelled image transforms do not wait for an unread fallback tee', async () => {
    const response = new Response('original bytes');
    const fallback = response.clone();
    const aborter = new AbortController();
    aborter.abort();
    const pending = dockerImageProcessor.transform(response.body, { sourceType: 'image/svg+xml', signal: aborter.signal }).then(() => false, () => true);
    const settled = await Promise.race([pending, delay(50, false)]);
    await fallback.body.cancel();
    await pending;
    assert.equal(settled, true);
});

test('S3 HEAD uses metadata command without fetching an object body', async t => {
    let command;
    t.mock.method(S3Client.prototype, 'send', async value => { command = value; return { ContentLength: 123 }; });
    const context = chunkContext();
    context.request = new Request(context.request.url, { method: 'HEAD' });
    context.env.img_url.getWithMetadata = async () => ({ value: '', metadata: { Channel: 'S3', S3FileKey: 'sample.bin', FileName: 'sample.bin', FileType: 'application/octet-stream' } });
    const response = await onRequest(context);
    assert.equal(response.status, 200);
    assert.ok(command instanceof HeadObjectCommand);
    assert.equal(response.headers.get('Content-Length'), '123');
    assert.equal(response.body, null);
});

test('LocalR2 pages preserve lexical ordering across files, directories and prefixes', async t => {
    const r2 = await bucket(t);
    for (const key of ['a/x', 'a.b', 'a/z', 'ab/q', 'b']) await r2.put(key, key);
    let cursor = '';
    const actual = [];
    do {
        const page = await r2.list({ cursor, limit: 2 });
        actual.push(...page.objects.map(object => object.key));
        cursor = page.truncated ? page.cursor : '';
    } while (cursor);
    assert.deepEqual(actual, ['a.b', 'a/x', 'a/z', 'ab/q', 'b']);
    assert.deepEqual((await r2.list({ prefix: 'a/', cursor: 'a/x' })).objects.map(object => object.key), ['a/z']);
});
