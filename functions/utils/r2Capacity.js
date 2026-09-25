// R2 conditional writes serialize reservations across isolates without a new binding.
import { r2Put } from './r2Write.js';
export const INTERNAL_PREFIX = '.imgbed-internal/';
const KEY = `${INTERNAL_PREFIX}capacity.json`;
const HEADROOM = 1024 * 1024; // Space for the ledger and backup manifests.
const RECONCILE_INTERVAL = 5 * 60 * 1000;

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
        state.reservations ||= {};
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
                // A terminated request may have stored its object before losing
                // its commit acknowledgement. Keep a conservative charge until
                // reconciliation proves the bytes are absent.
                if (Number.isFinite(state.usedBytes)) addUsage(state, entry.bytes);
                delete state.reservations[id];
            }
        }
        // Bootstrap once (and on policy changes). Ordinary uploads subsequently
        // use the conditional ledger; periodic maintenance reconciles in pages.
        if (!Number.isFinite(state.usedBytes) || state.limitBytes !== limitBytes) {
            let usedBytes = HEADROOM;
            let cursor;
            do {
                const page = await bucket.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
                usedBytes += page.objects.reduce((sum, object) => sum + object.size, 0);
                cursor = page.truncated ? page.cursor : undefined;
            } while (cursor);
            state.usedBytes = usedBytes;
            state.limitBytes = limitBytes;
            state.reconciledAt = now;
            delete state.scan;
        }
        const usedBytes = state.usedBytes;
        const reservedBytes = Object.values(state.reservations).reduce((sum, r) => sum + r.bytes, 0);
        if (usedBytes + reservedBytes + bytes >= limitBytes) {
            return { id: null, usedBytes, reservedBytes };
        }
        const id = crypto.randomUUID();
        state.reservations[id] = { bytes, expiresAt: now + ttl };
        return { id, usedBytes, reservedBytes };
    });
}

export async function releaseR2(bucket, id, { committed = false } = {}) {
    if (!id || !bucket) return;
    await mutate(bucket, async state => {
        const entry = state.reservations[id];
        if (committed && entry) addUsage(state, entry.bytes);
        await abortMultipart(bucket, entry);
        delete state.reservations[id];
    });
}

function addUsage(state, bytes) {
    // A bypass may finish before the first scan. Its object will be included in
    // bootstrap; never manufacture a partial baseline that hides other files.
    if (!Number.isFinite(state.usedBytes)) return;
    state.usedBytes += bytes;
    if (state.scan) state.scan.growth += bytes;
}

// Explicit bypasses still reserve their bytes while in flight. The caller must
// release this ID with committed:true after the object write succeeds.
export async function chargeR2Usage(bucket, bytes) {
    if (!bucket || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid R2 usage');
    return mutate(bucket, state => {
        const id = crypto.randomUUID();
        state.reservations[id] = { bytes, expiresAt: Date.now() + 24 * 3600000 };
        return id;
    });
}

// A bounded maintenance pass. Positive changes since scan start are added to
// the scanned total, even if the scan also saw them (safe overcount). Deletions
// are not subtracted during a scan. CAS retries prevent overwriting reservations.
export async function reconcileR2Capacity(bucket, { pages = 2, force = false } = {}) {
    if (!bucket) return;
    for (let pageIndex = 0; pageIndex < Math.min(10, Math.max(1, pages)); pageIndex++) {
        const done = await mutate(bucket, async state => {
            if (!Number.isFinite(state.usedBytes)) return true;
            if (!state.scan && !force && Date.now() - (state.reconciledAt || 0) < RECONCILE_INTERVAL) return true;
            state.scan ||= { cursor: null, bytes: HEADROOM, growth: 0 };
            const page = await bucket.list({ limit: 1000, ...(state.scan.cursor ? { cursor: state.scan.cursor } : {}) });
            state.scan.bytes += page.objects.reduce((sum, object) => sum + object.size, 0);
            if (page.truncated) { state.scan.cursor = page.cursor; return false; }
            state.usedBytes = state.scan.bytes + state.scan.growth;
            state.reconciledAt = Date.now();
            delete state.scan;
            return true;
        });
        if (done) break;
    }
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

// Recover abandoned multipart uploads before expiring their database sessions.
export async function expireR2Reservations(bucket, { limit = 20 } = {}) {
    if (!bucket) return 0;
    return mutate(bucket, async state => {
        let expired = 0;
        for (const [id, entry] of Object.entries(state.reservations)) {
            if (expired >= limit) break;
            if (entry.expiresAt > Date.now()) continue;
            await abortMultipart(bucket, entry);
            addUsage(state, entry.bytes);
            delete state.reservations[id];
            expired++;
        }
        return expired;
    });
}
