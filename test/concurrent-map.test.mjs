import test from 'node:test';
import assert from 'node:assert/strict';
import { mapConcurrent } from '../functions/utils/concurrent.js';

test('maps large folder moves with bounded concurrency and stable results', async () => {
    let active = 0;
    let peak = 0;
    const result = await mapConcurrent([1, 2, 3, 4, 5, 6], 3, async value => {
        active++;
        peak = Math.max(peak, active);
        await new Promise(resolve => setTimeout(resolve, 5));
        active--;
        return value * 2;
    });
    assert.equal(peak, 3);
    assert.deepEqual(result, [2, 4, 6, 8, 10, 12]);
});
