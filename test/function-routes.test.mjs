import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('startup route table preserves exact, index and nearest catchall precedence without request filesystem reads', async t => {
    const dir = await mkdtemp(join(tmpdir(), 'imgbed-routes-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    for (const name of ['_middleware.js', 'file/_middleware.js', 'file/[[path]].js', 'file/exact.js', 'file/nested/index.js', 'file/nested/[[path]].js']) {
        const path = join(dir, name);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, 'export function onRequest() {}');
    }
    const { createFunctionRouter } = await import('../deploy/server/functionRouter.js');
    const router = createFunctionRouter(dir);
    // Resolution is a snapshot: removing the fixture proves that requests do
    // not stat disk or grow caches based on arbitrary request paths.
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(router.findFunctionFile('/file/exact'), { file: join(dir, 'file/exact.js'), params: {} });
    assert.deepEqual(router.findFunctionFile('/file/nested'), { file: join(dir, 'file/nested/index.js'), params: {} });
    assert.deepEqual(router.findFunctionFile('/file/nested/a/b'), { file: join(dir, 'file/nested/[[path]].js'), params: { path: ['a', 'b'] } });
    assert.deepEqual(router.findMiddlewareFiles('/file/a/b'), [join(dir, '_middleware.js'), join(dir, 'file/_middleware.js')]);
    assert.equal(router.findFunctionFile('/missing'), null);
});
