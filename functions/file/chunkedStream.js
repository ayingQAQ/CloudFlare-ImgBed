// No prefetch: at most one upstream read is retained and later parts are not
// opened until the downstream asks for their bytes.
export function createChunkedStream(chunks, { start = 0, end, signal, fetchChunk }) {
    const aborter = new AbortController();
    let reader;
    let index = 0;
    let position = 0;
    let received = 0;
    let stopped = false;
    let downstream;
    const detach = () => signal?.removeEventListener('abort', abort);
    const cancel = async reason => {
        stopped = true;
        detach();
        aborter.abort(reason);
        await reader?.cancel(reason).catch(() => {});
    };
    const abort = () => { void cancel(signal.reason); try { downstream?.error(signal.reason); } catch {} };
    return new ReadableStream({
        start(controller) {
            downstream = controller;
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
        },
        async pull(controller) {
            try {
                while (!stopped) {
                    if (index >= chunks.length || position > end) { stopped = true; detach(); controller.close(); return; }
                    const chunk = chunks[index];
                    if (!Number.isSafeInteger(chunk.size) || chunk.size <= 0) throw new Error('Invalid chunk size');
                    if (position + chunk.size <= start) { position += chunk.size; index++; continue; }
                    if (!reader) {
                        const response = await fetchChunk(chunk, aborter.signal);
                        if (stopped) { await response.body?.cancel(); return; }
                        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error(`Chunk fetch failed: ${response.status}`); }
                        reader = response.body.getReader();
                        received = 0;
                    }
                    const item = await reader.read();
                    if (stopped) return;
                    if (item.done) {
                        reader.releaseLock(); reader = null;
                        if (received !== chunk.size) throw new Error('Truncated chunk');
                        position += chunk.size; index++; continue;
                    }
                    const first = position + received;
                    received += item.value.byteLength;
                    if (received > chunk.size) throw new Error('Chunk size exceeds manifest');
                    const low = Math.max(0, start - first);
                    const high = Math.min(item.value.byteLength, end - first + 1);
                    if (high > low) {
                        controller.enqueue(item.value.subarray(low, high));
                        if (first + high > end) { await cancel(); controller.close(); }
                        return;
                    }
                }
            } catch (error) {
                if (!stopped) { await cancel(error); controller.error(error); }
            }
        },
        cancel,
    }, { highWaterMark: 0 });
}

export function parseByteRange(value, size) {
    if (!value) return { start: 0, end: size - 1, partial: false };
    const match = /^bytes=(\d*)-(\d*)$/.exec(value);
    if (!match || (!match[1] && !match[2])) return null;
    const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) return null;
    return { start, end, partial: true };
}
