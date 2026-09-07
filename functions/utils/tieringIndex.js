import { mergeOperationsToIndex } from './indexManager.js';

/**
 * Capacity routing depends on channelStats stored in the lightweight index meta.
 * Upload completion records index operations asynchronously, so merge pending
 * operations before making a new R2/HF tiering decision. This keeps the 95%
 * threshold from lagging behind a burst of recent uploads.
 */
export async function refreshTieringIndex(context) {
    try {
        const result = await mergeOperationsToIndex(context);
        if (result?.success === false) {
            console.warn('Storage tiering: index refresh incomplete:', result.error || result.message || 'unknown error');
        }
        return result;
    } catch (error) {
        // Do not make uploads unavailable solely because statistics refresh failed.
        // resolveAutomaticPrimary will fall back to the last durable index meta.
        console.warn('Storage tiering: failed to refresh index stats:', error.message);
        return { success: false, error: error.message };
    }
}
