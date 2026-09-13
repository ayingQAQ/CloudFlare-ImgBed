function encodeKey(key) { return encodeURIComponent(key); }

export class RemoteR2Storage {
    constructor(baseUrl, secret, fetcher = fetch) {
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.secret = secret;
        this.fetcher = fetcher;
    }

    headers(extra = {}) { return { authorization: `Bearer ${this.secret}`, ...extra }; }
    url(path, key, extra = {}) {
        const url = new URL(`${this.baseUrl}${path}`);
        if (key !== undefined) url.searchParams.set('key', key);
        for (const [name, value] of Object.entries(extra)) url.searchParams.set(name, value);
        return url;
    }
    metadata(response) {
        return {
            key: response.headers.get('x-r2-key') || '',
            size: Number(response.headers.get('x-r2-size') || 0),
            etag: response.headers.get('x-r2-etag') || '',
            httpMetadata: {},
            writeHttpMetadata() {},
        };
    }
    async head(key) {
        const response = await this.fetcher(this.url('/r2/object', key), { method: 'HEAD', headers: this.headers() });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Remote R2 HEAD failed: ${response.status}`);
        return this.metadata(response);
    }
    async list(options = {}) {
        const response = await this.fetcher(`${this.baseUrl}/r2/list`, {
            method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(options),
        });
        if (!response.ok) throw new Error(`Remote R2 LIST failed: ${response.status}`);
        return response.json();
    }
    async get(key, options) {
        const extra = options?.range ? { offset: options.range.offset || 0 } : {};
        if (options?.range?.length !== undefined) extra.length = options.range.length;
        const response = await this.fetcher(this.url('/r2/object', key, extra), { headers: this.headers() });
        if (response.status === 404) return null;
        if (!response.ok) throw new Error(`Remote R2 GET failed: ${response.status}`);
        const object = this.metadata(response);
        object.body = response.body;
        if (response.headers.has('x-r2-range-offset')) object.range = {
            offset: Number(response.headers.get('x-r2-range-offset')),
            length: Number(response.headers.get('x-r2-range-length')),
        };
        return object;
    }
    async put(key, value, options = {}) {
        const headers = this.headers();
        if (options.onlyIf?.etagMatches) headers['x-r2-if-match'] = options.onlyIf.etagMatches;
        if (options.onlyIf?.etagDoesNotMatch) headers['x-r2-if-none-match'] = options.onlyIf.etagDoesNotMatch;
        const response = await this.fetcher(this.url('/r2/object', key), { method: 'PUT', headers, body: value, duplex: 'half' });
        if (response.status === 412) return null;
        if (!response.ok) throw new Error(`Remote R2 PUT failed: ${response.status}`);
        return this.metadata(response);
    }
    async delete(key) {
        const response = await this.fetcher(this.url('/r2/object', key), { method: 'DELETE', headers: this.headers() });
        if (!response.ok) throw new Error(`Remote R2 DELETE failed: ${response.status}`);
    }
    async createMultipartUpload(key) {
        const response = await this.fetcher(this.url('/r2/multipart/create', key), { method: 'POST', headers: this.headers() });
        if (!response.ok) throw new Error(`Remote R2 multipart create failed: ${response.status}`);
        const { uploadId } = await response.json();
        return { key, uploadId, ...this.multipartMethods(key, uploadId) };
    }
    resumeMultipartUpload(key, uploadId) { return { key, uploadId, ...this.multipartMethods(key, uploadId) }; }
    multipartMethods(key, uploadId) {
        return {
            uploadPart: async (partNumber, data) => {
                const response = await this.fetcher(this.url('/r2/multipart/part', key, { uploadId, partNumber }), {
                    method: 'PUT', headers: this.headers(), body: data, duplex: 'half',
                });
                if (!response.ok) throw new Error(`Remote R2 multipart part failed: ${response.status}`);
                return response.json();
            },
            complete: async parts => {
                const response = await this.fetcher(this.url('/r2/multipart/complete', key, { uploadId }), {
                    method: 'POST', headers: this.headers({ 'content-type': 'application/json' }), body: JSON.stringify(parts),
                });
                if (!response.ok) throw new Error(`Remote R2 multipart complete failed: ${response.status}`);
                return response.json();
            },
            abort: async () => {
                const response = await this.fetcher(this.url('/r2/multipart/abort', key, { uploadId }), {
                    method: 'POST', headers: this.headers(),
                });
                if (!response.ok) throw new Error(`Remote R2 multipart abort failed: ${response.status}`);
            },
        };
    }
}
