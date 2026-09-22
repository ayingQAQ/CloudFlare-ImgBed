import { r2Put } from './r2Write.js';

export async function takeRateLimit(bucket, key, limit, windowMs, now = Date.now()) {
    if (!bucket) throw new Error('Rate limit storage unavailable');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    const id = [...new Uint8Array(digest)].map(b=>b.toString(16).padStart(2,'0')).join('');
    const objectKey = '.imgbed-internal/request-limits.json';
    for (let attempt=0; attempt<12; attempt++) {
        const object = await bucket.get(objectKey);
        const data = object ? await new Response(object.body).json() : {};
        for (const k of Object.keys(data)) if (data[k].until <= now) delete data[k];
        const entry = data[id] ||= { count: 0, until: now + windowMs };
        if (entry.count >= limit) return { allowed: false, retryAfter: Math.ceil((entry.until-now)/1000) };
        entry.count++;
        if (await r2Put(bucket, objectKey, JSON.stringify(data), { onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: '*' } })) return { allowed: true };
    }
    throw new Error('Rate limit storage busy');
}

export function clientAddress(request) {
    return request.headers.get('CF-Connecting-IP') || request.headers.get('x-real-ip') || 'unknown';
}
