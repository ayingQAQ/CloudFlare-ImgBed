const requestForms = new WeakMap();
export const CHUNK_BYTES = 16 * 1024 * 1024;
const FORM_OVERHEAD = 64 * 1024;

export function uploadBodyLimit(request) {
    const url = new URL(request.url);
    if (url.searchParams.get('merge') === 'true' || url.searchParams.get('initChunked') === 'true') return FORM_OVERHEAD;
    return (url.searchParams.get('chunked') === 'true' ? CHUNK_BYTES : 100 * 1024 * 1024) + FORM_OVERHEAD;
}

// Count actual transport bytes before the multipart parser can retain them. Pages
// creates a new context for next(request), so the shared data object owns the cache.
export async function getUploadForm(context, request = context.request, limit = uploadBodyLimit(request)) {
    context.data ||= {};
    let parsed = context.data.uploadForm || requestForms.get(request);
    if (!parsed) {
        parsed = (async () => {
            const limited = limitUploadBody(request, limit);
            return new Response(limited, { headers: request.headers }).formData();
        })();
        requestForms.set(request, parsed);
    }
    context.data.uploadForm = parsed;
    return parsed;
}

export function rewriteUploadRequest(context, url, request = context.request) {
    if (!context.data?.uploadForm) return new Request(url, request);
    return new Request(url, { method: request.method, headers: request.headers, signal: request.signal });
}

export async function uploadMap(values, fn, concurrency = 8) {
    const result = new Array(values.length);
    let next = 0;
    await Promise.all(Array.from({length: Math.min(concurrency, values.length)}, async () => {
        while (next < values.length) { const i = next++; result[i] = await fn(values[i], i); }
    }));
    return result;
}

export function uploadDelay(ms, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(done, ms);
        const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(signal.reason); };
        signal?.addEventListener('abort', abort, {once: true});
    });
}

export function limitUploadBody(request, limit = 100 * 1024 * 1024) {
    if (Number(request.headers.get('content-length')) > limit) {
        void request.body?.cancel().catch(() => {});
        throw Object.assign(new Error('Upload body exceeds limit'), { status: 413 });
    }
    let bytes = 0;
    return request.body?.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            bytes += chunk.byteLength;
            if (bytes > limit) throw Object.assign(new Error('Upload body exceeds limit'), { status: 413 });
            controller.enqueue(chunk);
        }
    }), { signal: request.signal });
}
