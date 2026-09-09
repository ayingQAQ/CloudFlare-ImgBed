import { r2Put } from './r2Write.js';

const KEY = '.imgbed-internal/anonymous-upload-quota.json';
export const ANONYMOUS_DAILY_LIMIT = 30;

function dayKey(now = Date.now()) {
    // The site is operated in China; use the local calendar day instead of UTC.
    return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

async function ipHash(request) {
    const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For')?.split(',')[0].trim() || 'unknown';
    const visitorId = request.headers.get('X-Visitor-ID') || '';
    const validVisitorId = /^[0-9a-f-]{36}$/i.test(visitorId) ? visitorId : '';
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${ip}:${validVisitorId}`));
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function mutate(bucket, operation) {
    if (!bucket) throw new Error('Anonymous upload quota requires R2');
    for (let attempt = 0; attempt < 12; attempt++) {
        const object = await bucket.get(KEY);
        const state = object ? await new Response(object.body).json() : { days: {} };
        const result = operation(state);
        state.revision = crypto.randomUUID();
        const saved = await r2Put(bucket, KEY, JSON.stringify(state), {
            onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' },
        });
        if (saved) return result;
        await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)));
    }
    throw new Error('Anonymous upload quota is busy; retry the upload');
}

function clean(state, now) {
    const today = dayKey(now);
    for (const key of Object.keys(state.days || {})) if (key !== today) delete state.days[key];
    const entries = state.days[today] ||= {};
    for (const entry of Object.values(entries)) {
        entry.reservations ||= {};
        for (const [id, expiresAt] of Object.entries(entry.reservations)) {
            if (expiresAt <= now) delete entry.reservations[id];
        }
    }
    return entries;
}

export async function getAnonymousIdentity(request) {
    const hash = await ipHash(request);
    return { hash, namespace: `guest/${hash.slice(0, 24)}` };
}

export async function reserveAnonymousUpload(bucket, request, ttl = 60 * 60 * 1000) {
    const identity = await getAnonymousIdentity(request);
    const now = Date.now();
    const reservationId = await mutate(bucket, state => {
        const entries = clean(state, now);
        const entry = entries[identity.hash] ||= { completed: 0, reservations: {} };
        if (entry.completed + Object.keys(entry.reservations).length >= ANONYMOUS_DAILY_LIMIT) return null;
        const id = crypto.randomUUID();
        entry.reservations[id] = now + ttl;
        return id;
    });
    return { ...identity, reservationId };
}

export async function finishAnonymousUpload(bucket, request, reservationId, success) {
    if (!reservationId) return;
    const identity = await getAnonymousIdentity(request);
    const now = Date.now();
    await mutate(bucket, state => {
        const entries = clean(state, now);
        const entry = entries[identity.hash];
        if (!entry?.reservations?.[reservationId]) return;
        delete entry.reservations[reservationId];
        if (success) entry.completed = (entry.completed || 0) + 1;
    });
}

export function applyUploadNamespace(url, namespace, requestedFolder = url.searchParams.get('uploadFolder') || '') {
    const child = requestedFolder.replace(/^\/+|\/+$/g, '');
    url.searchParams.set('uploadFolder', child ? `${namespace}/${child}` : namespace);
}
