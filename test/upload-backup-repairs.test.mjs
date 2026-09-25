import test from 'node:test';
import assert from 'node:assert/strict';
import { handleChunkUpload, checkChunkUploadStatuses, cleanupChunkData } from '../functions/upload/chunkUpload.js';

function atomicBucket() {
 const objects=new Map(); let seq=0;
 return {async get(key){const object=objects.get(key);return object?{etag:object.etag,body:new Blob([object.value]).stream()}:null;},
 async put(key,value,options={}){const previous=objects.get(key);if(options.onlyIf?.etagDoesNotMatch==='*'&&previous)return null;if(options.onlyIf?.etagMatches&&previous?.etag!==options.onlyIf.etagMatches)return null;
 const etag=String(++seq);objects.set(key,{value,etag});return {etag};}};
}

function fixture() {
 const records = new Map();
 const env = { img_r2: atomicBucket(), img_url: { async get(k) { return records.get(k)?.value ?? null; }, async getWithMetadata(k) { return records.get(k) || {}; }, async put(k,value,options={}) { records.set(k,{value,metadata:options.metadata}); }, async delete(k) {records.delete(k);} } };
 const form = new FormData();
 for (const [k,v] of Object.entries({uploadId:'test',chunkIndex:'0',totalChunks:'1',originalFileName:'x.bin',originalFileType:'application/octet-stream'})) form.set(k,v);
 form.set('file',new Blob(['abc']),'x.bin');
 records.set('upload_session_test',{value:JSON.stringify({originalFileName:'x.bin',totalChunks:1,expiresAt:Date.now()+60000,uploadChannel:'cfr2'})});
 const request = new Request('https://example.invalid/upload?chunked=true&uploadChannel=cfr2',{method:'POST',body:form});
 return {records,env,request,url:new URL(request.url),uploadConfig:{cfr2:{channels:[]}}};
}

test('failed chunk returns a retryable failure and clears its deadline timer', async () => {
 const context = fixture();
 const timers = new Set(); const originalSet = globalThis.setTimeout, originalClear=globalThis.clearTimeout;
 globalThis.setTimeout=(fn,ms,...args)=>{const t=originalSet(fn,ms,...args);timers.add(t);return t;};
 globalThis.clearTimeout=t=>{timers.delete(t);originalClear(t);};
 try {
  const response=await handleChunkUpload(context);
  assert.equal(response.status,503);
  const body=await response.json(); assert.equal(body.success,false);assert.equal(body.retryable,true);
  assert.equal(context.records.get('chunk_test_000').metadata.status,'failed');
  assert.equal(timers.size,0);
 } finally {for(const t of timers) originalClear(t);globalThis.setTimeout=originalSet;globalThis.clearTimeout=originalClear;}
});

test('status reads and cleanup use a bounded window rather than serial or all-at-once calls', async () => {
 const context=fixture(); let active=0,peak=0;
 const operation=async()=>{active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;};
 context.env.img_url.getWithMetadata=async()=>{await operation();return {metadata:{status:'completed'}};};
 const statuses=await checkChunkUploadStatuses(context.env,'test',25);
 assert.equal(statuses.length,25);assert(peak>1 && peak<=8,`peak ${peak}`);
 peak=0;context.env.img_url.delete=operation;await cleanupChunkData(context.env,'test',25);assert(peak>1 && peak<=8,`peak ${peak}`);
});

import { getUploadForm, rewriteUploadRequest } from '../functions/upload/uploadRequest.js';
import { handleChunkMerge } from '../functions/upload/chunkMerge.js';
import { LocalR2Storage } from '../deploy/server/r2Storage.js';
import { enqueueTelegramBackup, processTelegramBackup, getTelegramBackup, drainTelegramBackups } from '../functions/utils/telegramBackup.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { D1Database } from '../functions/utils/d1Database.js';

test('multipart parses once across Pages context and rewritten request', async () => {
 const context=fixture(); context.data={};
 const first=await getUploadForm(context);
 const rewritten=rewriteUploadRequest(context,'https://example.invalid/upload?uploadChannel=cfr2',context.request);
 const downstream={request:rewritten,data:context.data};
 assert.equal(await getUploadForm(downstream),first);
 assert.equal(await first.get('file').text(),'abc');
});

test('actual body limit cancels an unknown-length stream before parser buffers it all', async () => {
 let reads=0,cancelled=false;
 const stream=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(100));},cancel(){cancelled=true;}});
 const request=new Request('https://example.invalid/upload?chunked=true',{method:'POST',body:stream,duplex:'half',headers:{'Content-Type':'multipart/form-data; boundary=x'}});
 await assert.rejects(getUploadForm({request},request,250),/limit/);
 await new Promise(r=>setTimeout(r,0));
 assert(cancelled);assert(reads<=5,`reads ${reads}`);
});

test('timed-out Telegram upload is aborted before returning and cannot publish late success', async t => {
 const context=fixture(); context.url.searchParams.set('uploadChannel','telegram'); context.uploadTimeoutMs=10;
 context.uploadConfig={telegram:{channels:[{name:'test',botToken:'test',chatId:'test'}],loadBalance:{enabled:false}}};
 let aborted=false; const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
 globalThis.fetch=async(_url,{signal})=>new Promise((_resolve,reject)=>{
  signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
 });
 const response=await handleChunkUpload(context);
 assert.equal(response.status,503);assert(aborted);
 assert.equal(context.records.get('chunk_test_000').metadata.status,'timeout');
});

test('D1 failed chunk requests client retransmission and merge retains the retry session', async t => {
 const context=fixture();const sql=new DatabaseSync(':memory:');t.after(()=>sql.close());
 sql.exec(readFileSync(new URL('../database/init.sql',import.meta.url),'utf8'));
 const raw={prepare(query){const stmt=sql.prepare(query);let args=[];return {bind(...values){args=values.map(v=>v===undefined?null:typeof v==='boolean'?Number(v):v);return this;},async first(){return stmt.get(...args)||null;},async all(){return {results:stmt.all(...args)};},async run(){return {meta:{changes:stmt.run(...args).changes}};}};}};
 const db=new D1Database(raw);context.env={img_d1:raw};
 await db.put('upload_session_test',context.records.get('upload_session_test').value);
 assert.equal((await handleChunkUpload(context)).status,503);
 const part=await db.getWithMetadata('chunk_test_000');assert.equal(part.value,'');assert.equal(part.metadata.resendChunk,true);
 const form=new FormData();for(const[k,v]of Object.entries({uploadId:'test',totalChunks:'1',originalFileName:'x.bin',originalFileType:'application/octet-stream'}))form.set(k,v);
 const request=new Request('https://example.invalid/upload?chunked=true&merge=true',{method:'POST',body:form});
 const merged=await handleChunkMerge({env:context.env,request,url:new URL(request.url)});
 assert.equal(merged.status,409);assert.deepEqual((await merged.json()).resendChunks,[0]);assert(await db.get('upload_session_test'));
});

test('request workers and scheduled backup drain share durable admission before video source reads', async t => {
 const path=mkdtempSync(join(tmpdir(),'imgbed-backup-admission-'));t.after(()=>rmSync(path,{recursive:true}));
 const bucket=new LocalR2Storage(path);const context=fixture();
 context.env.img_r2=bucket;context.env.TG_BOT_TOKEN='123:test';context.env.TG_CHAT_ID='123';
 const previous=globalThis.fetch;t.after(()=>{globalThis.fetch=previous;});
 let releaseVideo,videoEntered;const entered=new Promise(r=>videoEntered=r);const block=new Promise(r=>releaseVideo=r);
 globalThis.fetch=async url=>{if(String(url).endsWith('/sendVideo')){videoEntered();await block;return Response.json({ok:true,result:{message_id:1,video:{file_id:'v'}}});}return Response.json({ok:true,result:{document:{file_id:'part'}}});};
 const work=[];context.waitUntil=p=>work.push(p);
 for(let i=0;i<4;i++){
  await bucket.put(`v${i}.mp4`,new Uint8Array(20));
  context.records.set(`v${i}.mp4`,{value:'',metadata:{BackupId:`v${i}`,FileName:`v${i}.mp4`,FileType:'video/mp4',Channel:'CloudflareR2',FileSizeBytes:20}});
 }
 let sourceReads=0;const originalGet=bucket.get.bind(bucket);bucket.get=async(key,options)=>{if(key.endsWith('.mp4')&&options?.range)sourceReads++;return originalGet(key,options);};
 await enqueueTelegramBackup(context,'v0.mp4','cfr2');await entered;
 for(let i=1;i<4;i++)await enqueueTelegramBackup(context,`v${i}.mp4`,'cfr2');
 assert.equal(await drainTelegramBackups({...context.env,img_r2:new LocalR2Storage(path)},4),0);
 assert.equal(sourceReads,1);
 releaseVideo();await Promise.all(work);
 for(let i=1;i<4;i++){const job=await getTelegramBackup(context.env,`v${i}.mp4`);assert.equal(job.status,'pending');}
 assert.equal(await processTelegramBackup(context.env,'v1'),'ready');
});

import { onRequest as uploadMiddleware } from '../functions/upload/_middleware.js';
import { reserveR2, checkR2Reservation } from '../functions/utils/r2Capacity.js';

test('an incomplete merge reads each status once and keeps the upload session', async () => {
 const context=fixture(); const session=JSON.parse(context.records.get('upload_session_test').value);session.totalChunks=25;
 context.records.set('upload_session_test',{value:JSON.stringify(session)});
 let reads=0;const original=context.env.img_url.getWithMetadata;context.env.img_url.getWithMetadata=async key=>{if(key.startsWith('chunk_'))reads++;return original(key);};
 const form=new FormData();for(const[k,v]of Object.entries({uploadId:'test',totalChunks:'25',originalFileName:'x.bin'}))form.set(k,v);
 context.request=new Request('https://example.invalid/upload?chunked=true&merge=true',{method:'POST',body:form});context.url=new URL(context.request.url);
 const response=await handleChunkMerge(context);
 assert.equal(response.status,409);assert.equal(reads,25);assert(context.records.has('upload_session_test'));
});

test('retryable merge preserves its R2 capacity reservation', async t => {
 const path=mkdtempSync(join(tmpdir(),'imgbed-merge-reservation-'));t.after(()=>rmSync(path,{recursive:true}));
 const context=fixture();context.env.img_r2=new LocalR2Storage(path);
 const reservation=await reserveR2(context.env.img_r2,100,1000000000);
 const session=JSON.parse(context.records.get('upload_session_test').value);session.tieringReservation=reservation.id;
 context.records.set('upload_session_test',{value:JSON.stringify(session)});
 const form=new FormData();form.set('uploadId','test');
 context.request=new Request('https://example.invalid/upload?chunked=true&merge=true',{method:'POST',body:form});
 context.next=async()=>Response.json({success:false,resendChunks:[0]},{status:409});
 const response=await uploadMiddleware.find(fn=>fn.name==='storageTiering')(context);
 assert.equal(response.status,409);assert.equal((await checkR2Reservation(context.env.img_r2,reservation.id)).bytes,100);
});

test('an uncancellable R2 part settles before timeout returns and cannot write late metadata', async () => {
 const context=fixture();context.uploadTimeoutMs=5;context.uploadConfig.cfr2.channels=[{name:'R2'}];
 context.records.set('multipart_test',{value:JSON.stringify({uploadId:'m',key:'x.bin'})});
 let releasePart,enteredPart;const entered=new Promise(r=>enteredPart=r);const blocked=new Promise(r=>releasePart=r);
 context.env.img_r2={...context.env.img_r2,resumeMultipartUpload(){return {async uploadPart(){enteredPart();await blocked;return {etag:'part'};}};}};
 let returned=false;const work=handleChunkUpload(context).then(r=>{returned=true;return r;});
 await entered;await new Promise(r=>setTimeout(r,15));assert.equal(returned,false);
 releasePart();assert.equal((await work).status,503);
 assert.equal(context.records.get('chunk_test_000').metadata.status,'timeout');
});


import { readTelegramBackup } from '../functions/utils/telegramBackup.js';
import { onRequest as davRequest } from '../functions/dav/[[path]].js';
import { fetchUploadConfig, fetchSecurityConfig, fetchOthersConfig, bindRequestConfig } from '../functions/utils/sysConfig.js';

for (const cancellation of ['reader', 'request']) test(`backup restore ${cancellation} cancellation aborts an in-flight Telegram lookup`, async t => {
 const path=mkdtempSync(join(tmpdir(),'imgbed-restore-cancel-'));t.after(()=>rmSync(path,{recursive:true}));
 const context=fixture();context.env.img_r2=new LocalR2Storage(path);context.env.TG_BOT_TOKEN='123:test';context.env.TG_CHAT_ID='123';
 const metadata={BackupId:'restore',FileType:'application/octet-stream'};
 await context.env.img_r2.put('.imgbed-internal/telegram/complete/restore',JSON.stringify({status:'ready',size:3,chunks:[{size:3,fileId:'part'}],channelName:'Telegram_env',botId:'123',metadata}));
 const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);let started,aborted=false;const entered=new Promise(r=>started=r);
 globalThis.fetch=(_url,{signal})=>new Promise((_resolve,reject)=>{started();signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});});
 const controller=new AbortController();const request=new Request('https://example.invalid/file/x',{signal:controller.signal});
 const response=await readTelegramBackup(context.env,'x',metadata,request);
 const reader=response.body.getReader();const pending=reader.read().catch(()=>{});await entered;
 if(cancellation==='reader')await reader.cancel();else controller.abort();
 await pending;assert(aborted);
});

test('configuration loads are shared within one request and refreshed for the next request', async () => {
 const context=fixture();context.data={};bindRequestConfig(context);const reads=new Map();const get=context.env.img_url.get;
 context.env.img_url.get=async key=>{reads.set(key,(reads.get(key)||0)+1);return get(key);};
 await Promise.all([fetchUploadConfig(context.env,context),fetchUploadConfig(context.env,context),fetchOthersConfig(context.env,context),fetchOthersConfig(context.env,context),fetchSecurityConfig(context.env,{context}),fetchSecurityConfig(context.env,{request:context.request,throwOnError:true})]);
 for(const key of ['upload','others','security'])assert.equal(reads.get(`manage@sysConfig@${key}`),1,key);
 await fetchSecurityConfig(context.env,{context:{data:{}}});assert.equal(reads.get('manage@sysConfig@security'),2);
});

test('WebDAV PUT shares one bounded File with local upload pipeline without an HTTP multipart round trip', async t => {
 const path=mkdtempSync(join(tmpdir(),'imgbed-dav-upload-'));t.after(()=>rmSync(path,{recursive:true}));
 const context=fixture();context.env.img_r2=new LocalR2Storage(path);context.data={};
 context.records.set('manage@sysConfig@others',{value:JSON.stringify({telemetry:{enabled:false},webDAV:{enabled:true,internalToken:'internal',uploadChannel:'cfr2'}})});
 context.env.img_url.list=async()=>({keys:[],list_complete:true});
 const background=[];context.waitUntil=p=>background.push(p.catch(()=>{}));
 let network=0;const old=globalThis.fetch;t.after(()=>globalThis.fetch=old);globalThis.fetch=async()=>{network++;throw new Error('No external forwarding is allowed');};
 let multipartParses=0;const oldParse=Response.prototype.formData;t.after(()=>Response.prototype.formData=oldParse);Response.prototype.formData=function(){multipartParses++;return oldParse.call(this);};
 context.request=new Request('https://example.invalid/dav/folder/hello.txt',{method:'PUT',headers:{'Content-Type':'text/plain'},body:'hello from DAV'});
 const response=await davRequest(context);assert.equal(response.status,201,await response.text());
 const object=await context.env.img_r2.get('folder/hello.txt');assert.equal(await new Response(object.body).text(),'hello from DAV');
 await Promise.all(background);assert.equal(network,0);assert.equal(multipartParses,0);
});

test('WebDAV oversized Content-Length is rejected before reading the body', async () => {
 const context=fixture();context.data={};context.records.set('manage@sysConfig@others',{value:JSON.stringify({webDAV:{enabled:true,internalToken:'internal'}})});
 let reads=0,cancelled=false;const body=new ReadableStream({pull(c){reads++;c.enqueue(new Uint8Array(1));},cancel(){cancelled=true;}},{highWaterMark:0});
 context.request=new Request('https://example.invalid/dav/large.bin',{method:'PUT',body,duplex:'half',headers:{'Content-Length':String(101*1024*1024)}});
 const response=await davRequest(context);assert.equal(response.status,413);assert(cancelled);assert.equal(reads,0);
});

test('backup deadline cancels a stalled R2 source and releases global admission', async t => {
 const path=mkdtempSync(join(tmpdir(),'imgbed-backup-timeout-'));t.after(()=>rmSync(path,{recursive:true}));
 const context=fixture();const bucket=new LocalR2Storage(path);context.env.img_r2=bucket;context.env.TG_BOT_TOKEN='123:test';context.env.TG_CHAT_ID='123';
 const metadata={BackupId:'timeout',FileType:'application/octet-stream'};context.records.set('source',{value:'',metadata});
 await bucket.put('.imgbed-internal/telegram/pending/timeout',JSON.stringify({id:'timeout',fileId:'source',primaryChannel:'cfr2',size:3,metadata,chunks:[],status:'pending',attempts:0,nextAttemptAt:0}));
 let cancelled=false,deadline;const get=bucket.get.bind(bucket);bucket.get=async(key,options)=>{if(key==='source'&&options?.range){oldTimeout(()=>deadline(),0);return {body:new ReadableStream({pull(){return new Promise(()=>{});},cancel(){cancelled=true;return new Promise(()=>{});}})};}return get(key,options);};
 const oldTimeout=globalThis.setTimeout;t.after(()=>globalThis.setTimeout=oldTimeout);globalThis.setTimeout=(fn,ms,...args)=>{if(ms>80000&&ms<=90000){deadline=fn;return oldTimeout(fn,10000,...args);}return oldTimeout(fn,ms,...args);};
 assert.equal(await processTelegramBackup(context.env,'timeout'),'retrying');assert(cancelled);
 const slot=await bucket.get('.imgbed-internal/telegram/worker-slot.json');assert.equal((await new Response(slot.body).json()).until,0);
});

import { claimChunkAttempt } from '../functions/upload/chunkAttempt.js';
import { initializeChunkedUpload } from '../functions/upload/chunkUpload.js';
import { registerMultipartRecovery, cleanupExpiredMultipartUploads } from '../functions/utils/multipartRecovery.js';
import { S3Client } from '@aws-sdk/client-s3';

test('overlapping same-part retry cannot enter storage or replace metadata until old uncancellable attempt settles', async () => {
 const old=fixture();old.uploadTimeoutMs=10;old.uploadConfig.cfr2.channels=[{name:'R2'}];
 old.records.set('multipart_test',{value:JSON.stringify({uploadId:'m',key:'x.bin'})});
 let releasePart,enteredPart,physical=0;const entered=new Promise(r=>enteredPart=r);const blocked=new Promise(r=>releasePart=r);
 old.env.img_r2={...old.env.img_r2,resumeMultipartUpload(){return {async uploadPart(){physical++;enteredPart();if(physical===1)await blocked;return {etag:'part'+physical};}};}};
 const running=handleChunkUpload(old);await entered;
 const duplicate=()=>({...fixture(),env:old.env,uploadConfig:old.uploadConfig});
 assert.equal((await handleChunkUpload(duplicate())).status,409);
 await new Promise(r=>setTimeout(r,20));
 const uncertain=await handleChunkUpload(duplicate());assert.equal(uncertain.status,410);assert.equal((await uncertain.json()).restartUpload,true);assert.equal(physical,1);
 releasePart();assert.equal((await running).status,503);
 assert.equal((await handleChunkUpload(duplicate())).status,200);assert.equal(physical,2);
 assert.equal(old.records.get('chunk_test_000').metadata.status,'completed');
 assert.equal((await handleChunkUpload(duplicate())).status,200);assert.equal(physical,2,'completed duplicate must not rewrite provider part');
});

test('KV-only chunk uploads fail closed without a distributed conditional-write backend', async () => {
 const context=fixture();delete context.env.img_r2;
 const response=await handleChunkUpload(context);assert.equal(response.status,503);assert.match((await response.json()).error,/R2 or D1/);assert(!context.records.has('chunk_test_000'));
});

test('explicit R2 initialization reserves bytes before any multipart provider allocation', async t => {
 const path=mkdtempSync(join(tmpdir(),'imgbed-explicit-init-'));t.after(()=>rmSync(path,{recursive:true}));
 const context=fixture();context.env.img_r2=new LocalR2Storage(path);context.url.searchParams.set('tiering','off');
 const response=await initializeChunkedUpload(context);assert.equal(response.status,200);
 const {uploadId}=await response.json();const session=JSON.parse(context.records.get(`upload_session_${uploadId}`).value);
 assert(session.tieringReservation);assert.equal((await checkR2Reservation(context.env.img_r2,session.tieringReservation)).bytes,16*1024*1024);
});

test('expired S3 recovery survives failed abort and deletes journal only after successful provider cleanup', async t => {
 const context=fixture();context.env.img_url.list=async({prefix='',limit=1000})=>({keys:[...context.records.keys()].filter(k=>k.startsWith(prefix)).slice(0,limit).map(name=>({name})),list_complete:true});
 context.records.set('manage@sysConfig@upload',{value:JSON.stringify({s3:{channels:[{name:'archive',enabled:true,endpoint:'https://s3.example.invalid',accessKeyId:'x',secretAccessKey:'y',bucketName:'bucket'}]}})});
 context.records.set('upload_session_orphan',{value:JSON.stringify({expiresAt:Date.now()-1000,uploadChannel:'s3',channelName:'archive'})});
 context.records.set('multipart_orphan',{value:JSON.stringify({uploadId:'provider-id',key:'object'})});
 await registerMultipartRecovery(context.env,'orphan',{provider:'s3',channelName:'archive',uploadId:'provider-id',key:'object'});
 const original=S3Client.prototype.send;t.after(()=>S3Client.prototype.send=original);let fail=true,aborts=0;
 S3Client.prototype.send=async function(command){assert.equal(command.constructor.name,'AbortMultipartUploadCommand');aborts++;if(fail)throw new Error('storage unavailable');return {};};
 assert.equal((await cleanupExpiredMultipartUploads(context.env)).failed,1);assert(context.records.has('manage@multipartRecovery@orphan'));assert(context.records.has('multipart_orphan'));
 fail=false;assert.equal((await cleanupExpiredMultipartUploads(context.env)).recovered,1);assert.equal(aborts,2);assert(!context.records.has('manage@multipartRecovery@orphan'));assert(!context.records.has('multipart_orphan'));
});

import { cleanupChunkAttempts } from '../functions/upload/chunkAttempt.js';

test('bounded attempt GC waits for session expiry and fences a late owner', async t => {
 const path=mkdtempSync(join(tmpdir(),'imgbed-attempt-gc-'));t.after(()=>rmSync(path,{recursive:true}));
 const context=fixture();context.env.img_r2=new LocalR2Storage(path);
 const attempt=await claimChunkAttempt(context.env,'test',0);
 const key='.imgbed-internal/upload-attempt/test/0.json';const value=JSON.parse(await new Response((await context.env.img_r2.get(key)).body).text());
 await context.env.img_r2.put(key,JSON.stringify({...value,expiresAt:Date.now()-1}));
 assert.equal(await cleanupChunkAttempts(context.env,{limit:1}),0);assert(await context.env.img_r2.get(key));
 context.records.delete('upload_session_test');assert.equal(await cleanupChunkAttempts(context.env,{limit:1}),1);
 await assert.rejects(attempt.assertOwner(),/uncertain/);await attempt.release();assert.equal(await context.env.img_r2.get(key),null);
});

test('S3 recovery retains provider identity when same channel is redirected to another bucket', async t => {
 const context=fixture();context.env.img_url.list=async({prefix=''})=>({keys:[...context.records.keys()].filter(k=>k.startsWith(prefix)).map(name=>({name})),list_complete:true});
 context.records.set('manage@sysConfig@upload',{value:JSON.stringify({s3:{channels:[{name:'archive',enabled:true,endpoint:'https://s3.example.invalid',accessKeyId:'x',secretAccessKey:'y',bucketName:'changed'}]}})});
 context.records.set('upload_session_orphan',{value:JSON.stringify({expiresAt:Date.now()-1})});
 await registerMultipartRecovery(context.env,'orphan',{provider:'s3',channelName:'archive',uploadId:'provider-id',key:'object',providerIdentity:{endpoint:'https://s3.example.invalid',bucketName:'original',region:'auto',pathStyle:false}});
 const original=S3Client.prototype.send;t.after(()=>S3Client.prototype.send=original);S3Client.prototype.send=async()=>assert.fail('must not abort against a different bucket');
 assert.equal((await cleanupExpiredMultipartUploads(context.env)).failed,1);assert(context.records.has('manage@multipartRecovery@orphan'));
});
