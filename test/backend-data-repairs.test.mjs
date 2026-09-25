import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { D1Database } from '../functions/utils/d1Database.js';
import { readIndex, loadChunkedIndex, saveChunkedIndex, mergeOperationsToIndex } from '../functions/utils/indexManager.js';
import { onRequestPost as finalize } from '../functions/api/manage/batch/index/finalize.js';
import * as aliases from '../functions/utils/publicFileId.js';
import { onRequest as publicList } from '../functions/api/public/list.js';
import { onRequest as randomImage } from '../functions/random/index.js';
import { onRequestPost as restoreChunk } from '../functions/api/manage/batch/restore/chunk.js';

function sqlite(legacy = false) {
 const sql = new DatabaseSync(':memory:');
 sql.exec(readFileSync(new URL('../database/init.sql', import.meta.url),'utf8').replace(legacy ? /\s*expires_at INTEGER,/g : /NEVER_MATCH/g, ''));
 const queries=[]; let returned=0;
 const raw={sql,queries,get returned(){return returned;},prepare(query){queries.push(query); const stmt=sql.prepare(query);let args=[];return {
  bind(...v){args=v.map(x=>x===undefined?null:typeof x==='boolean'?Number(x):x);return this;},
  async run(){return {meta:{changes:stmt.run(...args).changes}};},
  async first(){return stmt.get(...args)||null;},
  async all(){const results=stmt.all(...args);returned+=results.length;return {results};}
 };}};
 return raw;
}
function kv(initial=[]) {
 const records=new Map(initial);const reads=[];let active=0,maxActive=0;
 return {records,reads,get maxActive(){return maxActive;},async get(k){reads.push(k);active++;maxActive=Math.max(active,maxActive);await new Promise(r=>setTimeout(r,1));active--;return records.get(k)??null;},
 async put(k,v){records.set(k,v);},async delete(k){records.delete(k);},async list({prefix='',cursor='',limit=1000}={}){const keys=[...records.keys()].sort().filter(k=>k.startsWith(prefix)&&k>cursor);const page=keys.slice(0,limit);return {keys:page.map(name=>({name,metadata:{TimeStamp:1}})),cursor:keys.length>limit?page.at(-1):null,list_complete:keys.length<=limit};}};
}
test('settings keyset pagination is complete across deletes and literal prefix characters',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);for(let i=0;i<1001;i++)await db.put(`manage@session@${String(i).padStart(4,'0')}`,'{}');let cursor=null,n=0;do{const page=await db.list({prefix:'manage@session@',cursor,limit:1000});n+=page.keys.length;await Promise.all(page.keys.map(k=>db.delete(k.name)));cursor=page.cursor;}while(cursor);assert.equal(n,1001);
 await db.put('manage@test_a','a');await db.put('manage@testXa','b');assert.equal((await db.list({prefix:'manage@test_'})).keys.length,1);
 }finally{raw.sql.close();}
});
test('TTL applies to settings and files, survives legacy schema, and cleanup is bounded',async()=>{
 const raw=sqlite(true);try{const db=new D1Database(raw);for(const key of ['upload_session_a','manage@session@a'])await db.put(key,'{}',{expiration:Math.floor(Date.now()/1000)-1});
 assert.equal(await db.get('upload_session_a'),null);assert.equal(await db.get('manage@session@a'),null);
 assert.equal((await db.list({prefix:'upload_session_'})).keys.length,0);
 const result=await db.cleanupExpired({limit:1});assert.equal(result.deleted,1);
 assert.equal(raw.sql.prepare('SELECT (SELECT count(*) FROM files)+(SELECT count(*) FROM settings) n').get().n,1);
 }finally{raw.sql.close();}
});
test('D1 list filters and stable cursor paginate without loading full index',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);for(let i=0;i<120;i++)await db.put(`album/${String(i).padStart(3,'0')}.jpg`,'',{metadata:{TimeStamp:100,Directory:'album/',FileName:`photo ${i}`,FileType:'image/jpeg',Channel:'HuggingFace',Tags:i%2?['red']:['blue']}});
 const ctx={env:{img_d1:raw}};const before=raw.returned;const first=await readIndex(ctx,{directory:'album',includeTags:['red'],count:7});assert.equal(first.success,true);assert.equal(first.files.length,7);assert.equal(first.totalCount,60);assert.ok(first.cursor);
 const second=await readIndex(ctx,{directory:'album',includeTags:['red'],count:7,cursor:first.cursor});assert.equal(second.files.length,7);assert.equal(new Set([...first.files,...second.files].map(f=>f.id)).size,14);
 assert.ok(raw.returned-before<30);assert.equal(raw.queries.some(q=>q.includes('manage@index_')),false);
 assert.equal(raw.sql.prepare('SELECT tags FROM files LIMIT 1').get().tags,'["blue"]');
 }finally{raw.sql.close();}
});
test('KV reads each chunk once with bounded I/O',async()=>{
 const store=kv([['manage@index@meta',JSON.stringify({totalCount:24,chunkCount:24})],...Array.from({length:24},(_,i)=>[`manage@index_${i}`,JSON.stringify([{id:`${i}.jpg`,metadata:{TimeStamp:i}}])])]);
 const result=await readIndex({env:{img_url:store}},{count:5});assert.equal(result.files.length,5);assert.equal(store.reads.filter(k=>/^manage@index_/.test(k)).length,24);assert.ok(store.maxActive<=8);
});
test('failed batch finalize preserves active generation and temporary retry data',async()=>{
 const previous=JSON.stringify({totalCount:1,chunkCount:1,generation:'old'});const store=kv([['manage@index@meta',previous],['manage@index_old_0',JSON.stringify([{id:'old.jpg',metadata:{}}])],['chunk_test_0',JSON.stringify({chunkId:0,metadataSnapshot:previous,data:[{id:'new.jpg',metadata:{}}]})]]);
 const put=store.put;store.put=async(k,v)=>{if(k.startsWith('manage@index_'))throw Error('write failed');return put(k,v);};
 const ctx={env:{img_url:store},request:new Request('https://example.test/finalize',{method:'POST',body:JSON.stringify({sessionId:'test',totalChunks:1,totalFiles:1})})};assert.equal((await finalize(ctx)).status,500);assert.equal(store.records.get('manage@index@meta'),previous);assert.equal((await loadChunkedIndex(ctx)).success,true);assert.ok(store.records.has('chunk_test_0'));
});
test('unknown public IDs never invoke request-time scan; maintenance backfills bounded pages',async()=>{
 const store=kv([['legacy.jpg',''],['second.jpg','']]);const env={img_url:store};const alias=await aliases.publicFileId('legacy.jpg');let scans=0;
 assert.equal(await aliases.resolvePublicFile(env,alias,async()=>{scans++;return [{id:'legacy.jpg'}];}),null);assert.equal(scans,0);
 const result=await aliases.backfillPublicFileAliases(env,{limit:1});assert.equal(result.processed,1);assert.equal(await aliases.resolvePublicFile(env,alias), 'legacy.jpg');
});

test('finalize rejects chunks collected against another published snapshot',async()=>{
 const current=JSON.stringify({totalCount:1,chunkCount:1,generation:'current',lastUpdated:2});
 const store=kv([['manage@index@meta',current],['manage@index_current_0',JSON.stringify([{id:'newer.jpg',metadata:{}}])],['chunk_test_0',JSON.stringify({chunkId:0,metadataSnapshot:'outdated',data:[{id:'stale.jpg',metadata:{}}]})]]);
 const response=await finalize({env:{img_url:store},request:new Request('https://example.test/finalize',{method:'POST',body:JSON.stringify({sessionId:'test',totalChunks:1,totalFiles:1})})});
 assert.equal(response.status,409);assert.equal(store.records.get('manage@index@meta'),current);
});

test('operation pagination traverses equal timestamps in stable key order',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);for(const id of ['z','a','m'])await db.putIndexOperation(id,{type:'add',timestamp:1,data:{fileId:id}});
 let cursor=null;const ids=[];do{const page=await db.list({prefix:'manage@index@operation_',limit:1,cursor});ids.push(...page.keys.map(k=>k.name));cursor=page.cursor;}while(cursor);
 assert.deepEqual(ids,['a','m','z'].map(id=>'manage@index@operation_'+id));
 }finally{raw.sql.close();}
});

test('SQL filters match KV filters including missing directory fields and literal searches',async()=>{
 const raw=sqlite();try{
 const files=Array.from({length:48},(_,i)=>({id:`${i%3===0?'album/nested/':i%3===1?'album/':''}${i}%_.jpg`,metadata:{TimeStamp:100-i,FileName:`Photo ${i}%_`,Channel:i%2?'HuggingFace':'TelegramNew',ChannelName:i%2?'primary':'backup',ListType:[null,'Block','White','None'][i%4],Label:[null,'everyone','teen','adult'][i%4],Tags:i%2?['Red','blue']:['green'],FileType:['image/jpeg','video/mp4','audio/mpeg','application/pdf'][i%4]}}));
 const db=new D1Database(raw);for(const file of files)await db.put(file.id,'',{metadata:file.metadata});
 // Simulate old rows whose denormalized directory and tag columns were never populated.
 raw.sql.exec('UPDATE files SET directory=NULL, tags=NULL');
 const store=kv([['manage@index@meta',JSON.stringify({totalCount:files.length,chunkCount:1})],['manage@index_0',JSON.stringify(files)]]);
 for(const options of [{},{directory:'album'},{directory:'album',includeSubdirFiles:true},{includeTags:['RED'],excludeTags:['green']},{listType:['None','White']},{accessStatus:['blocked']},{accessStatus:['normal'],label:['normal']},{label:['teen','adult']},{fileType:['video','other']},{channel:['huggingface'],channelName:['HuggingFace:primary']},{search:'%_'},{directory:'album',start:3,count:2}]){
  const input={count:50,includeSubdirFiles:true,...options};const [sqlResult,kvResult]=await Promise.all([readIndex({env:{img_d1:raw}},input),readIndex({env:{img_url:store}},input)]);
  assert.equal(sqlResult.success,true,JSON.stringify(input));
  assert.deepEqual(sqlResult.files,kvResult.files,JSON.stringify(input));
  for(const field of ['totalCount','directFileCount','directFolderCount'])assert.equal(sqlResult[field],kvResult[field],`${field}: ${JSON.stringify(input)}`);
  assert.deepEqual(sqlResult.directories.sort(),kvResult.directories.sort());
 }
 }finally{raw.sql.close();}
});

test('100000-row single page materializes only page and folder projection',async()=>{
 const raw=sqlite();try{raw.sql.exec('BEGIN');const insert=raw.sql.prepare('INSERT INTO files(id,metadata,timestamp,directory) VALUES(?,?,?,?)');for(let i=0;i<100000;i++)insert.run(`file-${i}.jpg`,JSON.stringify({TimeStamp:i+1}),i+1,'');raw.sql.exec('COMMIT');
 // Warm schema compatibility check; account only query result materialization below.
 const db=new D1Database(raw);await db.list({limit:1});const before=raw.returned;
 const page=await readIndex({env:{img_d1:raw}},{count:50});assert.equal(page.totalCount,100000);assert.equal(page.files.length,50);assert.ok(raw.returned-before<=51);assert.ok(page.cursor);
 }finally{raw.sql.close();}
});

test('two finalizers from one baseline cannot both publish and pending operations survive',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);const ctx={env:{img_d1:raw}};
 await saveChunkedIndex(ctx,{files:[],totalCount:0,lastUpdated:1,lastOperationId:null});const baseline=await db.get('manage@index@meta');
 for(const name of ['one','two'])await db.put(`chunk_${name}_0`,JSON.stringify({chunkId:0,metadataSnapshot:baseline,data:[{id:name,metadata:{TimeStamp:1}}]}));
 await db.put('manage@index@operation_later',JSON.stringify({type:'add',timestamp:2,data:{fileId:'during-rebuild',metadata:{TimeStamp:2}}}));
 const responses=await Promise.all(['one','two'].map(sessionId=>finalize({...ctx,request:new Request('https://example.test/finalize',{method:'POST',body:JSON.stringify({sessionId,totalChunks:1,totalFiles:1})})})));
 assert.equal(responses.filter(r=>r.status===200).length,1);assert.ok(await db.get('manage@index@operation_later'));
 assert.equal((await mergeOperationsToIndex(ctx)).success,true);assert.ok((await loadChunkedIndex(ctx)).files.some(f=>f.id==='during-rebuild'));
 }finally{raw.sql.close();}
});

test('TTL expires after elapsed time and an ordinary overwrite clears prior expiration',async()=>{
 const raw=sqlite();const original=Date.now;let now=original();Date.now=()=>now;try{const db=new D1Database(raw);await db.put('temp','x',{expirationTtl:1});assert.equal(await db.get('temp'),'x');now+=2000;assert.equal(await db.get('temp'),null);await db.put('temp','replacement');assert.equal(await db.get('temp'),'replacement');}finally{Date.now=original;raw.sql.close();}
});

test('maintenance with more than one operation batch returns hasMore without HTTP recursion',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);const ctx={env:{img_d1:raw}};await saveChunkedIndex(ctx,{files:[],totalCount:0,lastUpdated:1,lastOperationId:null});for(let i=0;i<31;i++)await db.putIndexOperation(String(i).padStart(3,'0'),{type:'add',timestamp:i,data:{fileId:String(i),metadata:{TimeStamp:i+1}}});
 const result=await mergeOperationsToIndex(ctx);assert.equal(result.success,true);assert.equal(result.hasMore,true);assert.equal(result.processedOperations,30);assert.equal(JSON.stringify(result).includes('metadataSnapshot'),false);
 assert.equal((await mergeOperationsToIndex(ctx)).processedOperations,1);
 }finally{raw.sql.close();}
});

test('SQL public and random filters run before limiting metadata rows',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);for(const [id,metadata] of [['guest/hidden.jpg',{FileType:'image/jpeg',Width:200,Height:100}],['public/portrait.JPG',{FileType:'image/jpeg',Width:100,Height:200}],['public/landscape.jpg',{FileType:'image/jpeg',Width:200,Height:100}],['public/note.txt',{FileType:'text/plain'}]])await db.put(id,'',{metadata:{TimeStamp:1,...metadata}});
 const page=await db.queryFiles({includeSubdirFiles:true,excludePrefixes:['guest/'],extensionType:'image',search:'landscape',searchIdOnly:true,count:1});assert.deepEqual(page.files.map(f=>f.id),['public/landscape.jpg']);assert.equal(page.totalCount,1);
 const random=await db.queryFiles({directory:'public',includeSubdirFiles:true,mimeIncludes:['image'],orientation:'portrait',random:true,count:1});assert.deepEqual(random.files.map(f=>f.id),['public/portrait.JPG']);
 }finally{raw.sql.close();}
});

test('public gallery and random routes use bounded SQL and preserve visibility filters',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);await db.put('manage@sysConfig@others',JSON.stringify({publicBrowse:{enabled:true,allowedDir:''},randomImageAPI:{enabled:true,allowedDir:''}}));
 for(let i=0;i<80;i++)await db.put(`album/${i}.jpg`,'',{metadata:{TimeStamp:i+1,FileType:'image/jpeg',Width:200,Height:100,ListType:i===79?'Block':'None'}});
 await db.put('guest/private.jpg','',{metadata:{TimeStamp:200,FileType:'image/jpeg'}});
 const before=raw.returned;const response=await publicList({env:{img_d1:raw},request:new Request('https://example.test/api/public/list?recursive=true&count=4&type=image')});assert.equal(response.status,200);const body=await response.json();assert.equal(body.totalCount,79);assert.equal(body.files.length,4);assert.ok(body.files.every(f=>!f.name.startsWith('guest/')&&f.name!=='album/79.jpg'));assert.ok(raw.returned-before<10);
 const randomBefore=raw.returned;const random=await randomImage({env:{img_d1:raw},request:new Request('https://example.test/random?dir=album&orientation=landscape')});assert.equal(random.status,200);assert.match((await random.json()).url,/^\/file\/album\//);assert.equal(raw.returned-randomBefore,1);
 }finally{raw.sql.close();}
});

test('restore resumes completed legacy alias backfill',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);await aliases.backfillPublicFileAliases({img_d1:raw});const response=await restoreChunk({env:{img_d1:raw},request:new Request('https://example.test/restore',{method:'POST',body:JSON.stringify({type:'files',data:{'restored.jpg':{value:'',metadata:{TimeStamp:1}}}})})});assert.equal(response.status,200);assert.equal((await aliases.backfillPublicFileAliases({img_d1:raw})).processed,1);assert.equal(await aliases.resolvePublicFile({img_d1:raw},await aliases.publicFileId('restored.jpg')),'restored.jpg');}finally{raw.sql.close();}
});

test('folder keyset paging exposes all folders while keeping rows bounded',async()=>{
 const raw=sqlite();try{const insert=raw.sql.prepare('INSERT INTO files(id,metadata,timestamp,directory) VALUES(?,?,?,?)');for(let i=0;i<1003;i++)insert.run(`folder${String(i).padStart(4,'0')}/x.jpg`,'{}',1,`folder${String(i).padStart(4,'0')}/`);const db=new D1Database(raw);const first=await db.queryFiles({count:1});assert.equal(first.directFolderCount,1003);assert.equal(first.directories.length,1000);assert.ok(first.directoriesTruncated);const second=await db.queryFiles({count:1,directoryCursor:first.directoryCursor});assert.equal(second.directFolderCount,1003);assert.equal(second.directories.length,3);assert.equal(second.directoryCursor,null);}finally{raw.sql.close();}
});

test('bulk folder traversal visits more than 1000 children without consuming page cursors',async()=>{
 const raw=sqlite();try{
  const insert=raw.sql.prepare('INSERT INTO files(id,metadata,timestamp,directory) VALUES(?,?,?,?)');
  for(let i=0;i<1003;i++){const folder=`source/folder${String(i).padStart(4,'0')}/`;insert.run(folder+'x.jpg','{}',1,folder);}
  const queue=['source'];const visited=new Set();const files=new Set();
  while(queue.length){
   const directory=queue.shift();visited.add(directory);
   const result=await readIndex({env:{img_d1:raw}},{directory,count:-1});
   assert.equal(result.success,true);assert.equal(result.directoryCursor,null);assert.equal(result.directoriesTruncated,false);
   for(const file of result.files)files.add(file.id);
   queue.push(...result.directories);
  }
  assert.equal(visited.size,1004);assert.equal(files.size,1003);
 }finally{raw.sql.close();}
});

test('TTL cleanup preserves multipart recovery identifiers and their expired sessions',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);const expired={expiration:Math.floor(Date.now()/1000)-1};
  await db.put('multipart_upload_a',JSON.stringify({key:'a.bin',uploadId:'provider-a'}),expired);
  await db.put('upload_session_upload_a',JSON.stringify({uploadChannel:'s3',channelName:'archive'}),expired);
  await db.put('upload_session_unrelated','{}',expired);await db.put('ordinary-expired','data',expired);
  assert.equal(await db.get('multipart_upload_a'),null);assert.equal(await db.get('upload_session_upload_a'),null);
  assert.equal((await db.cleanupExpired({limit:100})).deleted,2);
  assert.equal(raw.sql.prepare("SELECT count(*) n FROM files WHERE id IN ('multipart_upload_a','upload_session_upload_a')").get().n,2);
  const page=await db.listExpiredMultipart({limit:1});assert.equal(page.keys.length,1);
  assert.equal(page.keys[0].id,'multipart_upload_a');assert.equal(JSON.parse(page.keys[0].value).uploadId,'provider-a');assert.equal(JSON.parse(page.keys[0].sessionValue).channelName,'archive');
  // Simulate provider abort failure: nothing is explicitly deleted; another GC pass is safe.
  assert.equal((await db.cleanupExpired({limit:100})).deleted,0);
  // A confirmed abort can remove the multipart marker, releasing its session to normal GC.
  await db.delete('multipart_upload_a');assert.equal((await db.cleanupExpired({limit:100})).deleted,1);
 }finally{raw.sql.close();}
});

test('expired multipart paging includes pre-TTL legacy rows using session expiry',async()=>{
 const raw=sqlite();try{const db=new D1Database(raw);const expiresAt=Date.now()-1000;
  for(const id of ['a','b','c']){await db.put(`multipart_${id}`,JSON.stringify({key:id,uploadId:'provider-'+id}));await db.put(`upload_session_${id}`,JSON.stringify({expiresAt,uploadChannel:'cfr2'}));}
  await db.put('multipart_active','{}',{expirationTtl:3600});await db.put('upload_session_active',JSON.stringify({expiresAt:Date.now()+3600000}));
  await db.put('multipart_unknown','{}');
  let cursor=null;const found=[];do{const page=await db.listExpiredMultipart({limit:1,cursor});assert.ok(page.keys.length<=1);found.push(...page.keys.map(k=>k.name));cursor=page.cursor;}while(cursor);
  assert.deepEqual(found,['multipart_a','multipart_b','multipart_c']);
 }finally{raw.sql.close();}
});
