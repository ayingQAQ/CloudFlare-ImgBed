import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
class SqliteD1 {
 constructor() { this.db = new DatabaseSync(':memory:'); }
 exec(sql) { this.db.exec(sql); }
 prepare(sql) { const stmt=this.db.prepare(sql); let args=[]; return {
 bind(...values) { args=values; return this; },
 async run() { return { meta: { changes: stmt.run(...args).changes } }; },
 async first() { return stmt.get(...args) || null; },
 async all() { return {results:stmt.all(...args)}; }
 }; }
}
globalThis.caches = { default: { async put() {} } };
import { saveChunkedIndex, loadChunkedIndex } from '../functions/utils/indexManager.js';
import { onRequest } from '../functions/api/manage/move/[[path]].js';

function database() {
    const sql = new SqliteD1(':memory:');
    sql.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, category TEXT)');
    const ctx = { env: { img_d1: sql } };
    const index = n => ({ files: Array.from({length:n}, (_,i)=>({id:String(i), metadata:{}})), totalCount:n, lastUpdated:1,lastOperationId:'op'+n });
    return { sql,ctx,index };
}
test('failed chunk writes preserve the previously published snapshot and cursor', async () => {
    const {sql,ctx,index}=database();
    try {
        assert.equal(await saveChunkedIndex(ctx,index(1)),true);
        const original=await loadChunkedIndex(ctx);
        const prepare=sql.prepare.bind(sql);
        sql.prepare=query=>{
            const stmt=prepare(query), bind=stmt.bind.bind(stmt);
            stmt.bind=(...args)=>{bind(...args); if(String(args[0]).startsWith('manage@index_') && String(args[0]).endsWith('_1')) stmt.run=async()=>{throw Error('injected chunk failure')}; return stmt;};return stmt;
        };
        assert.equal(await saveChunkedIndex(ctx,{...index(501),metadataSnapshot:original.metadataSnapshot}),false);
        assert.deepEqual(await loadChunkedIndex(ctx), original);
    } finally {sql.db.close();}
});
test('only one writer from the same baseline can publish; missing chunks fail closed', async () => {
    const {sql,ctx,index}=database();
    try {
        await saveChunkedIndex(ctx,index(1));const baseline=await loadChunkedIndex(ctx);
        const results=await Promise.all([2,3].map(n=>saveChunkedIndex(ctx,{...index(n),metadataSnapshot:baseline.metadataSnapshot})));
        assert.deepEqual(results.sort(),[false,true]);
        const current=await loadChunkedIndex(ctx);assert.equal(current.files.length,current.totalCount);
        const metadata=JSON.parse(current.metadataSnapshot);
        sql.db.prepare('DELETE FROM settings WHERE key=?').run(`manage@index_${metadata.generation}_0`);
        assert.equal((await loadChunkedIndex(ctx)).success,false);
    } finally {sql.db.close();}
});
test('legacy index reads remain compatible and upgrade to immutable snapshots', async()=>{
    const {sql,ctx}=database();try {
        const put=sql.db.prepare('INSERT INTO settings VALUES (?, ?, ?)');
        put.run('manage@index@meta',JSON.stringify({totalCount:1,chunkCount:1}),'index');
        put.run('manage@index_0',JSON.stringify([{id:'legacy',metadata:{}}]),'index');
        const old=await loadChunkedIndex(ctx);assert.equal(old.success,true);
        assert.equal(await saveChunkedIndex(ctx,old),true);
        assert.equal((await loadChunkedIndex(ctx)).files[0].id,'legacy');
    }finally{sql.db.close();}
});
test('move never reports success when its index operation cannot be persisted', async()=>{
    const data=new Map([['a.jpg',{value:'',metadata:{Channel:'HuggingFace',Directory:''}}]]);
    let recoveryScheduled=false;
    const kv={
        get:async key=>data.get(key)?.value??null,
        getWithMetadata:async key=>data.get(key)??null,
        put:async(key,value,options={})=>{if(key.startsWith('manage@index@operation_'))throw Error('injected index failure');data.set(key,{value,metadata:options.metadata||{}})},
        delete:async key=>data.delete(key),list:async()=>({keys:[]})
    };
    const response=await onRequest({env:{img_url:kv},request:new Request('https://example.com/api/manage/move/a.jpg?dist=b'),params:{path:'a.jpg'},waitUntil:p=>{recoveryScheduled=true;p.catch(()=>{});}});
    assert.equal(response.status,503);
    const body=await response.json();assert.equal(body.success,false);assert.equal(body.code,'MOVE_INDEX_PENDING');
    assert.ok(data.has('b/a.jpg'));assert.equal(recoveryScheduled,true);
});
