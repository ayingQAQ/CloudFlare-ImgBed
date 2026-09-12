import test from 'node:test';
import assert from 'node:assert/strict';
import { directoryPath, saveDirectory, savedDirectories, mergeDirectories, changeDirectories } from '../functions/utils/directories.js';

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
