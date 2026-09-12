import test from 'node:test';
import assert from 'node:assert/strict';
import { parseImageTransform, transformImageRequestViaUrl } from '../functions/file/imageTransform.js';

for (const extension of ['jpg', 'png', 'gif', 'webp']) {
    test(`admin ${extension} thumbnails retain the original file route`, async () => {
        const request = new Request(`https://imgb.top/file/a.${extension}?from=admin&display=grid`);
        const imageTransform = parseImageTransform(new URL(request.url), { imageTransformEnabled: false });
        assert.equal(imageTransform.requested, false);
        assert.equal(await transformImageRequestViaUrl({ request, env: { IMAGES: {} }, imageTransform }), null);
    });
}
