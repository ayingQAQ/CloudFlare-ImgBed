import { authenticate, AUTH_SCOPE } from './auth/authCore.js';
import { takeRateLimit, clientAddress } from './rateLimit.js';

const KEY = '.imgbed-internal/visitor-signing-key';
const COOKIE = 'imgbed_visitor';
const encoder = new TextEncoder();
const hex = bytes => [...new Uint8Array(bytes)].map(n=>n.toString(16).padStart(2,'0')).join('');

export async function visitorSignature(bucket, value) {
    let stored = await bucket.get(KEY);
    if (!stored) {
        await bucket.put(KEY, crypto.randomUUID() + crypto.randomUUID(), { onlyIf: { etagDoesNotMatch: '*' } });
        stored = await bucket.get(KEY);
    }
    if (!stored) throw new Error('Visitor identity unavailable');
    const key = await crypto.subtle.importKey('raw', encoder.encode(await new Response(stored.body).text()), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(value)));
}

export async function visitorIdentity(context) {
    // Never accept client-supplied verification headers or unsigned visitor IDs.
    const headers = new Headers(context.request.headers);
    headers.delete('x-imgbed-visitor-verified');
    headers.delete('x-visitor-id');
    const admin = await authenticate({ env: context.env, request: context.request, authScope: AUTH_SCOPE.ADMIN, requiredPermission: 'upload' });
    let setCookie;
    if (!admin.authorized) {
        const cookie = context.request.headers.get('cookie')?.match(/(?:^|;\s*)imgbed_visitor=([^;]+)/)?.[1] || '';
        const parts = cookie.split('.');
        let valid = /^[a-f0-9-]{36}$/.test(parts[0] || '') && Number(parts[1]) > Date.now();
        if (valid) valid = parts[2] === await visitorSignature(context.env.img_r2, parts.slice(0,2).join('.'));
        if (!valid) {
            const allowance = await takeRateLimit(context.env.img_r2, 'visitor-issue:' + clientAddress(context.request), 60, 60 * 60 * 1000);
            if (!allowance.allowed) return new Response('Too many new visitor sessions', { status: 429, headers: { 'Retry-After': String(allowance.retryAfter) } });
            parts[0] = crypto.randomUUID(); parts[1] = String(Date.now()+365*86400000);
            parts[2] = await visitorSignature(context.env.img_r2, parts.slice(0,2).join('.'));
            setCookie = `${COOKIE}=${parts.slice(0,3).join('.')}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000`;
        }
        headers.set('x-visitor-id', parts[0]);
        headers.set('x-imgbed-visitor-verified', 'true');
    }
    context.request = new Request(context.request, { headers });
    const response = await context.next();
    if (!setCookie) return response;
    const output = new Response(response.body, response);
    output.headers.append('Set-Cookie', setCookie);
    output.headers.set('Cache-Control', 'private, no-store');
    return output;
}
