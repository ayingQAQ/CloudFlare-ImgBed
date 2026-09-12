import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageTransform, transformImageRequestViaUrl } from '../functions/file/imageTransform.js';

test('admin display preview uses a bounded transform even when public transforms are disabled', () => {
    const grid = parseImageTransform(new URL('https://imgb.top/file/a.jpg?from=admin&display=grid'), {
        imageTransformEnabled: false,
    });
    assert.equal(grid.requested, true);
    assert.equal(grid.internalDisplayPreset, true);
    assert.deepEqual(grid.options, { width: 800, height: 800, fit: 'cover' });

    const viewer = parseImageTransform(new URL('https://imgb.top/file/a.jpg?from=admin&display=viewer'), {
        imageTransformEnabled: false,
    });
    assert.equal(viewer.requested, false);
});

test('admin display preview transforms through a bounded remote source request', async t => {
    const originalFetch = globalThis.fetch;
    t.after(() => { globalThis.fetch = originalFetch; });
    globalThis.fetch = async (url, options) => {
        assert.equal(String(url), 'https://imgb.top/file/a.jpg?from=admin');
        assert.deepEqual(options.cf.image, { width: 800, height: 800, fit: 'cover' });
        assert.equal(options.headers.get('cookie'), 'admin_session=test');
        return new Response('small');
    };
    const request = new Request('https://imgb.top/file/a.jpg?from=admin&display=grid', {
        headers: { cookie: 'admin_session=test' },
    });
    const imageTransform = parseImageTransform(new URL(request.url), { imageTransformEnabled: false });
    const response = await transformImageRequestViaUrl({ request, env: { IMAGES: {} }, imageTransform });
    assert.equal(await response.text(), 'small');
});

test('display presets are restricted to admin file requests', () => {
    const parsed = parseImageTransform(new URL('https://imgb.top/file/a.jpg?display=viewer'), {
        imageTransformEnabled: false,
    });
    assert.equal(parsed.requested, false);
});
