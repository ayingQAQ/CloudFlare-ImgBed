// Opt-in only after BOTH DNS names use proxied origins and metadata/session
// continuity has been verified. Never enable on a Worker Custom Domain.
const HOSTS = new Set(['imgb.top', 'www.imgb.top']);
const openUntil = new Map();
export function resetOriginCircuit() { openUntil.clear(); }
async function boundedOriginFetch(fetcher, request) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try { return await fetcher(new Request(request, { signal: controller.signal })); }
    finally { clearTimeout(timer); }
}

export function isKvQuotaError(error) {
    const message = String(error?.message || error || '');
    return /\bkv\b|kvnamespace/i.test(message)
        && /429|quota|too many|limit exceeded/i.test(message);
}

export function retryableRead(request) {
    if (!['GET', 'HEAD'].includes(request.method)) return false;
    const url = new URL(request.url);
    const path = url.pathname;
    // Some legacy management endpoints mutate state on GET. Never use a
    // method-only check to decide whether replay is safe.
    if (path.startsWith('/api/manage/')) {
        return path === '/api/manage/list'
            && ['', 'info', 'index-storage-stats'].includes(url.searchParams.get('action') || '');
    }
    return ['/', '/dashboard', '/adminLogin', '/login', '/api/userConfig', '/api/channels', '/api/directoryTree', '/api/auth/sessionCheck'].includes(path)
        || path.startsWith('/file/') || /^\/(js|css|fonts|static)\//.test(path);
}

function observeKv(env, state) {
    if (!env.img_url) return env;
    const kv = new Proxy(env.img_url, {
        get(target, property) {
            const value = Reflect.get(target, property, target);
            if (typeof value !== 'function') return value;
            if (property !== 'list') return value.bind(target);
            return async (...args) => {
                try { return await value.apply(target, args); }
                catch (error) {
                    if (isKvQuotaError(error)) state.kvQuota = true;
                    throw error;
                }
            };
        },
    });
    return { ...env, img_url: kv };
}

export async function withOriginFallback(request, env, ctx, primary, originFetch = fetch) {
    const hostname = new URL(request.url).hostname;
    const eligibleHost = HOSTS.has(hostname)
        || (env.ORIGIN_FALLBACK_TEST_HOST && hostname === env.ORIGIN_FALLBACK_TEST_HOST);
    const enabled = env.ORIGIN_FALLBACK_MODE === 'routes'
        && env.ORIGIN_STATE_READY === 'true'
        && env.ORIGIN_BASE_URL
        && eligibleHost;
    if (!enabled) return primary(request, env, ctx);
    const originBase = new URL(env.ORIGIN_BASE_URL);
    if (originBase.protocol !== 'https:' || HOSTS.has(originBase.hostname) || originBase.hostname === hostname) {
        return new Response('Invalid origin configuration', { status: 503 });
    }
    // Explicit failover mode sends each request once, including login and
    // uploads. Never retry a mutation whose primary outcome is unknown.
    if (env.ORIGIN_PRIMARY === 'true' || (openUntil.get(hostname) || 0) > Date.now()) {
        try {
            const originUrl = new URL(request.url);
            originUrl.protocol = originBase.protocol; originUrl.host = originBase.host;
            originUrl.searchParams.set('__imgbed_origin', '2');
            const headers = new Headers(request.headers);
            headers.set('x-forwarded-host', hostname);
            headers.set('x-imgbed-public-host', hostname);
            headers.set('x-forwarded-proto', 'https');
            return await boundedOriginFetch(originFetch, new Request(originUrl, { method: request.method, headers, body: request.body, redirect: 'manual', duplex: 'half' }));
        } catch { return new Response('Origin unavailable', { status: 503, headers: { 'cache-control': 'no-store' } }); }
    }
    if (!retryableRead(request)) {
        try {
            const result = await primary(request, env, ctx);
            if (result.status >= 500) openUntil.set(hostname, Date.now() + 30000);
            return result;
        } catch {
            openUntil.set(hostname, Date.now() + 30000);
            return new Response('Primary unavailable; subsequent requests will use origin', { status: 503, headers: { 'Cache-Control': 'no-store' } });
        }
    }

    // Use the dedicated origin hostname, never the incoming routed hostname.
    ctx.passThroughOnException();
    const state = { kvQuota: false };
    let response;
    try {
        response = await primary(request, observeKv(env, state), ctx);
        if (!state.kvQuota && response.status < 500) return response;
        openUntil.set(hostname, Date.now() + 30000);
    } catch {
        openUntil.set(hostname, Date.now() + 30000);
        // Only replay the read-only allowlist. No upload body is cloned/buffered.
    }
    try {
        const originUrl = new URL(request.url);
        const originBase = new URL(env.ORIGIN_BASE_URL);
        originUrl.protocol = originBase.protocol;
        originUrl.host = originBase.host;
        originUrl.searchParams.set('__imgbed_origin', '2');
        const originHeaders = new Headers(request.headers);
        originHeaders.set('x-forwarded-host', new URL(request.url).host);
        originHeaders.set('x-imgbed-public-host', hostname);
        originHeaders.set('x-forwarded-proto', 'https');
        const originResponse = await boundedOriginFetch(originFetch, new Request(originUrl, {
            method: request.method,
            headers: originHeaders,
            redirect: 'manual',
        }));
        if (originResponse.status >= 500 && response) return response;
        if (response?.body) void response.body.cancel().catch(() => {});
        return originResponse;
    } catch {
        if (response) return response;
        return new Response('Both backends are unavailable', {
            status: 503, headers: { 'cache-control': 'no-store' },
        });
    }
}
