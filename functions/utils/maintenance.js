import { getDatabase } from './databaseAdapter.js';
import { backfillPublicFileAliases } from './publicFileId.js';
import { mergeOperationsToIndex } from './indexManager.js';
import { expireR2Reservations, reconcileR2Capacity } from './r2Capacity.js';
import { cleanupExpiredMultipartUploads } from './multipartRecovery.js';
import { cleanupChunkAttempts } from '../upload/chunkAttempt.js';

// Each invocation performs bounded work; one failed component cannot starve
// unrelated maintenance. R2 multipart recovery must precede session cleanup.
export async function runMaintenance(env) {
    const results = {};
    const run = async (name, operation) => {
        try { results[name] = await operation(); }
        catch (error) {
            results[name] = { error: error.message };
            console.warn(`Maintenance ${name}:`, error.message);
        }
    };
    if (env.img_d1 || env.img_url) await run('multipart', () => cleanupExpiredMultipartUploads(env, { limit: 20 }));
    await run('reservations', () => expireR2Reservations(env.img_r2));
    await run('capacity', () => reconcileR2Capacity(env.img_r2));
    if (env.img_d1 || env.img_url) {
        await run('attempts', () => cleanupChunkAttempts(env, { limit: 20 }));
        await run('expiration', () => getDatabase(env).cleanupExpired?.({ limit: 100 }));
        await run('aliases', () => backfillPublicFileAliases(env, { limit: 100 }));
        await run('index', async () => {
            const pending = [];
            const result = await mergeOperationsToIndex({ env, waitUntil: promise => pending.push(promise) });
            await Promise.allSettled(pending);
            // Do not return the complete index in maintenance responses/logs.
            return { success: result.success, processedOperations: result.processedOperations, hasMore: result.hasMore };
        });
    }
    return results;
}
