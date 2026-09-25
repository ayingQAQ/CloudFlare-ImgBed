import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryPath, saveDirectory, savedDirectories, mergeDirectories, changeDirectories } from '../functions/utils/directories.js';
import { onRequest as directoryLink } from '../functions/api/manage/directoryLink.js';

test('opaque directory links persist across backends without listing or exposing names', async () => {
    const records = new Map();
    let writes = 0;
    const env = { img_url: {
        get: async key => records.get(key),
        put: async (key, value) => { writes++; records.set(key, value); },
        list: () => { throw new Error('Must not list'); }
    } };
    const call = (method, body, query = '') => directoryLink({ env,
        request: new Request('https://test/api/manage/directoryLink' + query, {
            method, ...(body === undefined ? {} : { body: JSON.stringify(body) })
        }) });
    const path = '照片/Yeha+_예하_ & [158P_4V-5.75GB]';
    const response = await call('POST', { path });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const { id } = await response.json();
    assert.match(id, /^d_[a-f0-9]{64}$/);
    assert.equal((await (await call('POST', { path: '/' + path + '/' })).json()).id, id);
    assert.equal(writes, 1);
    assert.equal((await (await call('GET', undefined, '?id=' + id)).json()).path, path);
    assert.equal((await call('GET', undefined, '?id=d_' + '0'.repeat(64))).status, 404);
    assert.equal((await call('GET', undefined, '?id=../secret')).status, 400);
    assert.equal((await call('POST', { path: '../secret' })).status, 400);
});

test('empty nested folders persist, list once, move and delete with their parent', async () => {
    const records = new Map();
    const env = { img_url: {
        get: async key => records.get(key), put: async (key, value) => records.set(key, value),
        delete: async key => records.delete(key),
        list: async ({ prefix }) => ({ keys: [...records.keys()].filter(k => k.startsWith(prefix)).map(name => ({ name })), list_complete: true })
    } };
    await saveDirectory(env, '照片/子目录');
    await saveDirectory(env, '照片/子目录');
    assert.deepEqual((await mergeDirectories(env, { directories: [] }, '')).directories, ['照片']);
    assert.deepEqual((await mergeDirectories(env, { directories: ['照片/子目录'] }, '照片/')).directories, ['照片/子目录']);
    assert.deepEqual((await mergeDirectories(env, { directories: [] }, '照片/子目录/')).directories, []);
    await changeDirectories(env, '照片', '归档/照片');
    assert.deepEqual(await savedDirectories(env), ['归档/照片/子目录']);
    await changeDirectories(env, '归档');
    assert.deepEqual(await savedDirectories(env), []);
});

test('rejects traversal and internal storage namespaces', () => {
    for (const path of ['', '../x', 'x/../y', 'x/./y', 'x//y', 'manage@directory@x', 'x\\y']) {
        assert.throws(() => directoryPath(path));
    }
    assert.equal(directoryPath('照片/旅行 2026'), '照片/旅行 2026');
});
