import { r2Put } from './r2Write.js';

const KEY = '.imgbed-internal/site-stats.json';

function normalize(state = {}) {
    return {
        visits: Number(state.visits) || 0,
        images: Number(state.images) || 0,
        initialized: state.initialized === true,
    };
}

async function mutate(bucket, operation) {
    if (!bucket) throw new Error('Site statistics require R2');
    for (let attempt = 0; attempt < 12; attempt++) {
        const object = await bucket.get(KEY);
        const state = normalize(object ? await new Response(object.body).json() : {});
        operation(state);
        const saved = await r2Put(bucket, KEY, JSON.stringify(state), {
            onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
        });
        if (saved) return state;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
    throw new Error('Site statistics are busy; retry later');
}

export async function getSiteStats(bucket, initialImageCount = null, initialVisits = 0) {
    const object = await bucket?.get(KEY);
    const current = normalize(object ? await new Response(object.body).json() : {});
    if (current.initialized || initialImageCount === null) return current;
    return mutate(bucket, state => {
        if (!state.initialized) {
            state.images = Math.max(state.images, Number(initialImageCount) || 0);
            state.visits = Math.max(state.visits, Number(initialVisits) || 0);
            state.initialized = true;
        }
    });
}

export const recordVisit = bucket => mutate(bucket, state => { state.visits += 1; });

export async function recordImageUpload(bucket, metadata) {
    if (!String(metadata?.FileType || '').startsWith('image/')) return;
    await mutate(bucket, state => {
        state.images += 1;
    });
}
