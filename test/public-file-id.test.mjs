import test from 'node:test';
import assert from 'node:assert/strict';
import { publicFileId, resolvePublicFile } from '../functions/utils/publicFileId.js';

test('opaque links hide directories, preserve extension and distinguish same filenames', async () => {
    const alias = await publicFileId('照片/旅行/0013.jpg');
    assert.match(alias, /^p_[a-f0-9]{64}\.jpg$/);
    assert.notEqual(alias, await publicFileId('其他/0013.jpg'));
    assert.equal(await publicFileId(alias), alias);
});

test('old files resolve without redirects; subsequent lookups use their saved mapping', async () => {
    const records = new Map();
    const env = { img_url: { get: async k => records.get(k), put: async (k, v) => records.set(k, v) } };
    const id = '照片/旅行/0013.jpg';
    const alias = await publicFileId(id);
    assert.equal(await resolvePublicFile(env, id, () => { throw Error('legacy'); }), id);
    assert.equal(await resolvePublicFile(env, alias, async () => [{ id }]), id);
    assert.equal(await resolvePublicFile(env, alias, () => { throw Error('cached'); }), id);
    assert.equal(await resolvePublicFile(env, await publicFileId('missing'), async () => []), null);
});
