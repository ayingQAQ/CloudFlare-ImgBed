// R2 conditional writes serialize reservations across isolates without a new binding.
import { r2Put } from './r2Write.js';
export const INTERNAL_PREFIX = '.imgbed-internal/';
const KEY = `${INTERNAL_PREFIX}capacity.json`;
const HEADROOM = 1024 * 1024; // Space for the ledger and backup manifests.

async function abortMultipart(bucket, entry) {
    if (!entry?.multipart) return;
    try { await bucket.resumeMultipartUpload(entry.multipart.key, entry.multipart.uploadId).abort(); }
    catch (error) {
        if (!/not.?found|does not exist|404|NoSuchUpload/i.test(error.message)) throw error;
    }
}

async function mutate(bucket, operation) {
    for (let attempt = 0; attempt < 12; attempt++) {
        const object = await bucket.get(KEY);
        const state = object ? await new Response(object.body).json() : { reservations: {} };
        const result = await operation(state);
        // Include a nonce so an unchanged payload cannot create an ABA race.
        state.revision = crypto.randomUUID();
        const saved = await r2Put(bucket, KEY, JSON.stringify(state), {
            onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
        });
        if (saved) return result;
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
    }
    throw new Error('Capacity ledger is busy; retry the upload');
}

export async function reserveR2(bucket, bytes, limitBytes, ttl = 24 * 3600000) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid upload size');
    return mutate(bucket, async state => {
        const now = Date.now();
        for (const [id, entry] of Object.entries(state.reservations)) {
            if (entry.expiresAt <= now) {
                // Uploaded multipart parts consume storage even though list() omits them.
                await abortMultipart(bucket, entry);
                delete state.reservations[id];
            }
        }
        // Count actual objects, including objects missing from the application's index.
        // Completion removes its reservation only AFTER the object becomes visible.
        // Concurrent ledger changes invalidate this scan and force a retry.
        let usedBytes = HEADROOM;
        let cursor;
        do {
            const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
            usedBytes += page.objects.reduce((sum, object) => sum + object.size, 0);
            cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        const reservedBytes = Object.values(state.reservations).reduce((sum, r) => sum + r.bytes, 0);
        if (usedBytes + reservedBytes + bytes >= limitBytes) {
            return { id: null, usedBytes, reservedBytes };
        }
        const id = crypto.randomUUID();
        state.reservations[id] = { bytes, expiresAt: now + ttl };
        return { id, usedBytes, reservedBytes };
    });
}

export async function releaseR2(bucket, id) {
    if (!id || !bucket) return;
    await mutate(bucket, async state => {
        await abortMultipart(bucket, state.reservations[id]);
        delete state.reservations[id];
    });
}

export async function attachR2Multipart(bucket, id, candidate) {
    let chosen;
    try {
        chosen = await mutate(bucket, state => {
            const entry = state.reservations[id];
            if (!entry || entry.expiresAt <= Date.now()) throw new Error('Upload reservation expired');
            entry.multipart ||= candidate;
            return entry.multipart;
        });
    } finally {
        if (chosen?.uploadId !== candidate.uploadId) await abortMultipart(bucket, { multipart: candidate });
    }
    return chosen;
}

export async function checkR2Reservation(bucket, id) {
    const object = await bucket.get(KEY);
    const state = object ? await new Response(object.body).json() : null;
    const entry = state?.reservations?.[id];
    if (!entry || entry.expiresAt <= Date.now()) throw new Error('Upload reservation expired; restart upload');
    return entry;
}
