export function isPublicHostname(hostname) {
    let h = hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!h || h === 'localhost' || /\.(localhost|local|internal)$/.test(h)) return false;
    if (h.includes(':')) {
        // Only globally routable IPv6 unicast. This also excludes mapped IPv4,
        // loopback, link-local, ULA, multicast and transition/translation prefixes.
        const first = parseInt(h.split(':')[0], 16);
        return first >= 0x2000 && first <= 0x3fff && !/^2001:(?:0:|db8:)/.test(h) && !h.startsWith('2002:');
    }
    if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) {
        const [a,b,c,d] = h.split('.').map(Number);
        return [a,b,c,d].every(n => n <= 255) && a !== 0 && a !== 10 && a !== 127 && a < 224
            && !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31)
            && !(a === 192 && (b === 168 || b === 0)) && !(a === 100 && b >= 64 && b <= 127)
            && !(a === 198 && (b === 18 || b === 19));
    }
    return h.includes('.') && /^[a-z0-9.-]+$/.test(h);
}
