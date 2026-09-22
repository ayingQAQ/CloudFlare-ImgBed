import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { isPublicHostname } from '../../functions/utils/publicAddress.js';

export async function publicFetch(target, options = {}, resolve = lookup) {
    const url = new URL(target);
    if (!['http:', 'https:'].includes(url.protocol) || !isPublicHostname(url.hostname)) throw new Error('Disallowed target');
    let timer;
    const addresses = await Promise.race([
        resolve(url.hostname.replace(/^\[|\]$/g, ''), { all: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS resolution timed out')), 5000); }),
    ]).finally(() => clearTimeout(timer));
    if (!addresses.length || addresses.some(item => !isPublicHostname(item.address))) throw new Error('Disallowed resolved address');
    const pinned = addresses[0];
    return new Promise((accept, reject) => {
        const req = (url.protocol === 'https:' ? https : http).request(url, {
            method: 'GET', headers: { 'accept-encoding': 'identity' },
            signal: options.signal || AbortSignal.timeout(30000),
            // Connect to the verified address without a second DNS resolution.
            lookup(_host, opts, callback) { callback(null, opts?.all ? [pinned] : pinned.address, pinned.family); },
        }, res => {
            const headers = new Headers();
            for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
            accept(new Response([204,304].includes(res.statusCode) ? null : Readable.toWeb(res), { status: res.statusCode, headers }));
        });
        req.on('error', reject); req.end();
    });
}
