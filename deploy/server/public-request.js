// Only restore known public hosts, never an arbitrary forwarded host supplied by a client.
export function publicRequest(request) {
    const url = new URL(request.url);
    const hosts = new Set(['imgb.top', 'www.imgb.top', 'origin-vps.imgb.top']);
    if (!hosts.has(url.hostname)) return request;
    const publicHost = request.headers.get('x-imgbed-public-host');
    if (url.hostname === 'origin-vps.imgb.top' && ['imgb.top', 'www.imgb.top'].includes(publicHost)) url.hostname = publicHost;
    if (request.headers.get('x-forwarded-proto') === 'https') url.protocol = 'https:';
    return new Request(url, { method: request.method, headers: request.headers, body: request.body, duplex: 'half' });
}
