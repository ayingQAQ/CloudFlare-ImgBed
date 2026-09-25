import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import gateway from '../deploy/worker/state-gateway.js';
import { Miniflare } from 'miniflare';

function database(t) {
    const dir = mkdtempSync(join(tmpdir(), 'imgbed-backup-'));
    const path = join(dir, 'db.sqlite');
    const db = new DatabaseSync(path);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(readFileSync(new URL('../database/init.sql', import.meta.url), 'utf8'));
    const other = new DatabaseSync(path);
    t.after(() => { other.close(); db.close(); rmSync(dir, { recursive: true, force: true }); });
    const batches = [];
    const adapter = {
        prepare(sql) { return { sql, async all() { return { results: db.prepare(sql).all() }; } }; },
        async batch(statements) {
            db.exec('BEGIN');
            try {
                const results = statements.map((statement, index) => {
                    const result = { results: db.prepare(statement.sql).all() };
                    if (!index) adapter.afterFirst?.();
                    return result;
                });
                batches.push(results);
                db.exec('COMMIT');
                return results;
            } catch (error) { db.exec('ROLLBACK'); throw error; }
        },
    };
    return { db, other, adapter, batches };
}
function backup(adapter) {
    return gateway.fetch(new Request('https://state.invalid/backup', { headers: { authorization: 'Bearer test' } }), { GATEWAY_SECRET: 'test', img_d1: adapter });
}

test('oversized backup returns 413 before any table rows cross the database boundary', async t => {
    const { db, adapter, batches } = database(t);
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('large', 'x'.repeat(4 * 1024 * 1024));
    const response = await backup(adapter);
    assert.equal(response.status, 413);
    assert.match((await response.json()).error, /D1 export/i);
    assert.equal(batches.length, 1);
    assert.ok(batches[0].slice(1).every(result => result.results.length === 0));
});

test('admitted backup keeps a consistent transaction snapshot during concurrent writes', async t => {
    const { db, other, adapter, batches } = database(t);
    db.prepare('INSERT INTO files (id, metadata) VALUES (?, ?)').run('before', '{}');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('version', 'before');
    adapter.afterFirst = () => { other.exec("UPDATE files SET id = 'after'; UPDATE settings SET value = 'after'"); };
    const response = await backup(adapter);
    assert.equal(response.status, 200);
    const snapshot = await response.json();
    assert.equal(snapshot.tables.files[0].id, 'before');
    assert.equal(snapshot.tables.settings[0].value, 'before');
    assert.equal(batches.length, 1);
});

test('backup budget includes added schema columns and prevents row-count floods', async t => {
    const { db, adapter } = database(t);
    db.exec('ALTER TABLE other_data ADD COLUMN extension TEXT');
    db.prepare('INSERT INTO other_data (key, value, extension) VALUES (?, ?, ?)').run('extension', 'small', 'x'.repeat(4 * 1024 * 1024));
    assert.equal((await backup(adapter)).status, 413);
    db.exec("DELETE FROM other_data; WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x < 10001) INSERT INTO other_data(key,value) SELECT CAST(x AS TEXT), '' FROM n");
    assert.equal((await backup(adapter)).status, 413);
});

test('workerd D1 supports SQL admission for both small and oversized snapshots', async t => {
    const mf = new Miniflare({ modules: true, scriptPath: fileURLToPath(new URL('../deploy/worker/state-gateway.js', import.meta.url)), modulesRules: [{ type: 'ESModule', include: ['**/*.js'] }], d1Databases: ['img_d1'], bindings: { GATEWAY_SECRET: 'test' } });
    t.after(() => mf.dispose());
    const db = await mf.getD1Database('img_d1');
    await db.batch(['files', 'settings', 'index_operations', 'index_metadata', 'other_data'].map(table => db.prepare(`CREATE TABLE ${table} (key TEXT PRIMARY KEY, value TEXT)`)));
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind('small', 'saved').run();
    const request = () => mf.dispatchFetch('https://state.invalid/backup', { headers: { authorization: 'Bearer test' } });
    const small = await request();
    assert.equal(small.status, 200);
    assert.equal((await small.json()).tables.settings[0].value, 'saved');
    const generation = '1790362452885-22c12345-1234-1234-1234-123456789012';
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind('manage@index@meta', JSON.stringify({generation})).run();
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind(`manage@index_${generation}_0`, '[]').run();
    await db.prepare('INSERT INTO settings VALUES (?, ?)').bind('manage@index_obsolete_0', '[]').run();
    const versioned = await request();
    assert.equal(versioned.status, 200);
    const snapshot = await versioned.json();
    assert(snapshot.tables.settings.some(row => row.key === `manage@index_${generation}_0`));
    assert(!snapshot.tables.settings.some(row => row.key === 'manage@index_obsolete_0'));
    await db.batch(Array.from({ length: 16 }, (_, index) => db.prepare('INSERT INTO settings VALUES (?, ?)').bind(String(index), 'x'.repeat(200_000))));
    const large = await request();
    assert.equal(large.status, 413);
    assert.match((await large.json()).error, /native D1 export/);
});

test('backup excludes retired index generations but retains active chunks and metadata', async t => {
 const { db, adapter } = database(t);
 const put=db.prepare('INSERT INTO settings (key,value) VALUES (?,?)');
 put.run('manage@index@meta',JSON.stringify({generation:'active',chunkCount:1,totalCount:1}));
 put.run('manage@index_active_0','[{"id":"file"}]');
 put.run('manage@index_old_0','x'.repeat(4*1024*1024));
 const response=await backup(adapter);assert.equal(response.status,200);
 const keys=(await response.json()).tables.settings.map(row=>row.key);
 assert(keys.includes('manage@index_active_0'));assert(keys.includes('manage@index@meta'));assert(!keys.includes('manage@index_old_0'));
});
