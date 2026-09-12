import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('move response waits for index updates and relocates public links', async () => {
    const source = await readFile(new URL('../functions/api/manage/move/[[path]].js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /waitUntil\((?:batchMoveFilesInIndex|moveFileInIndex)/);
    assert.match(source, /await batchMoveFilesInIndex/);
    assert.match(source, /await moveFileInIndex/);
    assert.match(source, /await relocatePublicFile\(env, fileId, newFileId\)/);
    assert.match(source, /status: failedFiles\.length > 0 \? 409 : 200/);
});
