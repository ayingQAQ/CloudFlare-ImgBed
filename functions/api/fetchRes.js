/**
 * 远程资源代理读取 API
 * 负责在鉴权后拉取请求体中指定 URL 的资源并透传响应内容
 */
import { dualAuthCheck } from '../utils/auth/dualAuth.js';
import { isPublicHostname } from '../utils/publicAddress.js';

const IS_NODE_RUNTIME = typeof process !== 'undefined' && Boolean(process.versions?.node);
const HOP_BY_HOP_HEADERS = [
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade'
];

/**
 * Build response headers that are safe to send on a new proxy response.
 * Node's fetch transparently decompresses upstream bodies while retaining
 * Content-Encoding/Content-Length, so those headers must be removed there.
 *
 * @param {Headers} responseHeaders - headers returned by the upstream server
 * @returns {Headers}
 */
function createProxyHeaders(responseHeaders) {
    const headers = new Headers(responseHeaders);

    for (const name of HOP_BY_HOP_HEADERS) {
        headers.delete(name);
    }

    if (IS_NODE_RUNTIME) {
        headers.delete('content-encoding');
        headers.delete('content-length');
    }

    return headers;
}

function fetchTarget(url, env) {
    const options = { redirect: 'manual', signal: AbortSignal.timeout(30000) };
    if (IS_NODE_RUNTIME) {
        options.headers = { 'Accept-Encoding': 'identity' };
    }
    if (IS_NODE_RUNTIME && !env.FETCH_PUBLIC_RESOURCE) throw new Error('Safe public fetch is unavailable');
    return (env.FETCH_PUBLIC_RESOURCE || fetch)(url.toString(), options);
}

export async function onRequest(context) {
    // 获取请求体中URL的内容
    const {
        request,
        env,
        params,
        waitUntil,
        next,
        data
    } = context;

    // 双重鉴权检查
    const url = new URL(request.url);
    const { authorized } = await dualAuthCheck(env, url, request);
    if (!authorized) {
        return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    const jsonRequest = await request.json();
    const targetUrl = jsonRequest.url;
    if (targetUrl === undefined) {
        return new Response('URL is required', { status: 400 })
    }

    // Validate the target URL to mitigate SSRF (CWE-918).
    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch (e) {
        return new Response(JSON.stringify({ error: 'Invalid URL' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Only allow http(s); block file:, gopher:, data:, ftp:, blob:, etc.
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return new Response(JSON.stringify({ error: 'Only http(s) URLs are allowed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Refuse embedded credentials (used to smuggle auth into internal targets).
    if (parsed.username || parsed.password) {
        return new Response(JSON.stringify({ error: 'Credentials in URL are not allowed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Block private / loopback / link-local / metadata targets.
    if (!isPublicHostname(parsed.hostname)) {
        return new Response(JSON.stringify({ error: 'Access to internal addresses is not allowed' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    // Follow redirects manually so a permitted host cannot redirect us onto
    // an internal address without re-validation.
    let currentUrl = parsed;
    let response = await fetchTarget(currentUrl, env);
    let hops = 0;
    while (response.status >= 300 && response.status < 400 && response.headers.get('location') && hops < 5) {
        const next = new URL(response.headers.get('location'), currentUrl);
        if ((next.protocol !== 'http:' && next.protocol !== 'https:') ||
            next.username || next.password ||
            !isPublicHostname(next.hostname)) {
            await response.body?.cancel();
            return new Response(JSON.stringify({ error: 'Redirect to disallowed target' }), {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
            });
        }
        currentUrl = next;
        await response.body?.cancel();
        response = await fetchTarget(currentUrl, env);
        hops++;
    }

    const headers = createProxyHeaders(response.headers);
    return new Response(response.body, {
        headers: headers,
        status: response.status
    })
}
