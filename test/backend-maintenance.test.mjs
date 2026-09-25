import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { runMaintenance } from '../functions/utils/maintenance.js';
import { D1Database } from '../functions/utils/d1Database.js';
import { publicFileId, resolvePublicFile } from '../functions/utils/publicFileId.js';

test('maintenance recovers multipart before expiring sessions and backfills legacy links', async () => {
    const sql = new DatabaseSync(':memory:');
    sql.exec(readFileSync(new URL('../database/init.sql', import.meta.url), 'utf8'));
    let aborted = false;
    const raw = { prepare(query) {
        const statement = sql.prepare(query); let args = [];
        return { bind(...values) { args = values.map(value => value === undefined ? null : typeof value === "boolean" ? Number(value) : value); return this; },
            async first() { return statement.get(...args) || null; },
            async all() { return { results: statement.all(...args) }; },
            async run() {
                if (query.startsWith('DELETE')) assert.equal(aborted, true);
                return { meta: { changes: statement.run(...args).changes } };
            } };
    } };
    let ledger = JSON.stringify({ reservations: { abandoned: { bytes: 100, expiresAt: 0,
        multipart: { key: 'old-upload', uploadId: 'id' } } } });
    const env = { img_d1: raw, img_r2: {
        async get() { return { etag: 'tag', body: new Response(ledger).body }; },
        async put(key, body) { ledger = body; return { etag: 'tag' }; },
        resumeMultipartUpload() { return { async abort() { aborted = true; } }; },
    } };
    try {
        const db = new D1Database(raw);
        await db.put('legacy.jpg', '', { metadata: { TimeStamp: 1 } });
        await db.put('upload_session_old', '{}', { expiration: 1 });
        await db.put('upload_session_legacy-multipart', JSON.stringify({ uploadChannel: 'cfr2', expiresAt: 1 }), { expiration: 1 });
        await db.put('multipart_legacy-multipart', JSON.stringify({ key: 'legacy-object', uploadId: 'legacy-id' }), { expiration: 1 });
        const results = await runMaintenance(env);
        assert.equal(results.multipart.recovered, 1);
        assert.equal(results.reservations, 1);
        assert.equal(results.expiration.deleted, 1);
        assert.equal(results.aliases.complete, true);
        assert.equal(results.index.success, true);
        assert.equal(await resolvePublicFile(env, await publicFileId('legacy.jpg')), 'legacy.jpg');
        assert.equal(sql.prepare("SELECT count(*) n FROM files WHERE id='upload_session_old'").get().n, 0);
        assert.equal(sql.prepare("SELECT count(*) n FROM files WHERE id LIKE '%legacy-multipart'").get().n, 0);
    } finally { sql.close(); }
});
