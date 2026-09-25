// Time out connection setup and stalled body reads without limiting the total
// duration of a healthy download. The consumer controls when body reads begin.
export async function fetchUpstream(url, options = {}, timeoutMs = 30_000) {
    return requestUpstream(signal => fetch(url, { ...options, signal }), options.signal, timeoutMs);
}

export async function requestUpstream(load, signal, timeoutMs = 30_000, onCleanup = () => {}) {
    const controller = new AbortController();
    let timer;
    let reader;
    let bodyController;
    let cleaned = false;
    const cleanup = () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (!cleaned) { cleaned = true; onCleanup(); }
    };
    const abort = () => {
        const reason = signal?.reason || new DOMException('Upstream timed out', 'TimeoutError');
        controller.abort(reason);
        void reader?.cancel(reason).catch(() => {});
        try { bodyController?.error(reason); } catch {}
        cleanup();
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(abort, timeoutMs); timer.unref?.(); };
    signal?.throwIfAborted();
    signal?.addEventListener('abort', abort, { once: true });
    arm();
    let response;
    try { response = await load(controller.signal); }
    catch (error) { cleanup(); throw error; }
    clearTimeout(timer);
    if (controller.signal.aborted) {
        void response.body?.cancel(controller.signal.reason).catch(() => {});
        cleanup();
        throw controller.signal.reason;
    }
    if (!response.body) { cleanup(); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream({
        start(value) { bodyController = value; },
        async pull(stream) {
            arm();
            try {
                const item = await reader.read();
                clearTimeout(timer);
                if (controller.signal.aborted) return;
                if (item.done) { cleanup(); reader.releaseLock(); stream.close(); }
                else stream.enqueue(item.value);
            } catch (error) { cleanup(); controller.abort(error); stream.error(error); }
        },
        async cancel(reason) { cleanup(); controller.abort(reason); await reader.cancel(reason).catch(() => {}); },
    }, { highWaterMark: 0 });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

export function abortableDelay(ms, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const cleanup = () => signal?.removeEventListener('abort', abort);
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        const abort = () => { clearTimeout(timer); cleanup(); reject(signal.reason); };
        signal?.addEventListener('abort', abort, { once: true });
    });
}
