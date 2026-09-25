// Small JSON lists only: never retain file bodies in the Node process cache.
export class LocalListCache {
    constructor({ maxBytes = 8 * 1024 * 1024, maxEntryBytes = 512 * 1024, maxEntries = 128, now = Date.now } = {}) {
        this.entries = new Map(); this.pending = new Map(); this.bytes = 0; this.active = 0;
        Object.assign(this, { maxBytes, maxEntryBytes, maxEntries, now });
    }
    key(input) { return typeof input === 'string' ? input : input.url || String(input); }
    async delete(input) {
        const key = this.key(input), entry = this.entries.get(key);
        this.pending.delete(key);
        if (!entry) return false;
        this.bytes -= entry.bytes.byteLength; return this.entries.delete(key);
    }
    async match(input) {
        const key = this.key(input), entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.expires <= this.now()) { this.delete(key); return undefined; }
        this.entries.delete(key); this.entries.set(key, entry);
        return new Response(entry.bytes, {status: entry.status, headers: entry.headers});
    }
    async put(input, response) {
        const key = this.key(input);
        if (!/\/api\/(?:randomFileList|publicFileList)\?/.test(key)) return;
        const control = response.headers.get('cache-control') || '';
        const seconds = Number(/(?:^|,)\s*(?:s-maxage|max-age)=(\d+)/i.exec(control)?.[1] || 0);
        this.delete(key);
        if (!seconds || /no-store|private/.test(control) || response.status !== 200) return;
        if (this.active >= 8) { void response.body?.cancel().catch(() => {}); return; }
        const token = Symbol(); this.pending.set(key, token);
        const reader = response.body?.getReader(); if (!reader) { this.pending.delete(key); return; }
        this.active++;
        const chunks = []; let length = 0;
        try {
            while (true) {
                const part = await reader.read(); if (part.done) break;
                length += part.value.byteLength;
                if (length > Math.min(this.maxEntryBytes, this.maxBytes)) { void reader.cancel().catch(() => {}); return; }
                chunks.push(part.value);
            }
            if (this.pending.get(key) !== token) return;
        } catch (error) { if (this.pending.get(key) === token) this.pending.delete(key); throw error; }
        finally { this.active--; reader.releaseLock(); if (length > Math.min(this.maxEntryBytes, this.maxBytes) && this.pending.get(key) === token) this.pending.delete(key); }
        const bytes = new Uint8Array(length); let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        // Concurrent puts may have inserted the same key during the stream read.
        this.delete(key);
        while (this.entries.size && (this.entries.size >= this.maxEntries || this.bytes + length > this.maxBytes)) {
            this.delete(this.entries.keys().next().value);
        }
        this.entries.set(key, {bytes, expires: this.now() + seconds * 1000, status: response.status, headers: [...response.headers]});
        this.bytes += length;
    }
}
