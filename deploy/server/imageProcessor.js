import sharp from 'sharp';

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_INPUT_PIXELS = 25_000_000;
const MAX_OUTPUT_BYTES = 20 * 1024 * 1024;
const MAX_ANIMATION_FRAMES = 32;

const maxInputPixels = readPositiveInteger(
    process.env.IMAGE_TRANSFORM_MAX_PIXELS,
    DEFAULT_MAX_INPUT_PIXELS
);
const concurrency = Math.min(
    readPositiveInteger(process.env.IMAGE_TRANSFORM_CONCURRENCY, 1),
    8
);

// Limit native memory and parallel decoding so concurrent large requests do not
// unexpectedly exhaust a small Docker container.
sharp.cache({ memory: 32, files: 0, items: 32 });
sharp.concurrency(concurrency);

const maxActive = Math.min(readPositiveInteger(process.env.IMAGE_TRANSFORM_MAX_ACTIVE, 1), 8);
const maxQueued = Math.min(readPositiveInteger(process.env.IMAGE_TRANSFORM_MAX_QUEUED, 8), 64);
let active = 0;
const queue = [];
function acquire(signal) {
    signal?.throwIfAborted();
    if (active < maxActive) { active++; return Promise.resolve(release); }
    if (queue.length >= maxQueued) return Promise.reject(Object.assign(new Error('Image processor is busy'), { statusCode: 503 }));
    return new Promise((resolve, reject) => {
        const entry = { resolve, signal, abort() {
            const index = queue.indexOf(entry);
            if (index !== -1) queue.splice(index, 1);
            reject(signal.reason);
        } };
        queue.push(entry);
        signal?.addEventListener('abort', entry.abort, { once: true });
    });
}
function release() {
    const next = queue.shift();
    if (next) { next.signal?.removeEventListener('abort', next.abort); next.resolve(release); }
    else active--;
}

export const dockerImageProcessor = {
    async transform(stream, options) {
        let releaseSlot;
        try {
            releaseSlot = await acquire(options.signal);
            const input = await readStreamWithLimit(stream, MAX_INPUT_BYTES, options.signal);

            // SVG is inherently scalable. Keep the source document unchanged,
            // matching Cloudflare Image Transformations behavior.
            if (options.sourceType === 'image/svg+xml') {
                return new Response(input, {
                    headers: {
                        'Content-Type': options.sourceType,
                        'Content-Length': input.byteLength.toString(),
                    },
                });
            }

            const animated = options.sourceType === 'image/gif' || options.sourceType === 'image/webp';

            let pipeline = sharp(input, {
                animated,
                failOn: 'error',
                limitInputPixels: maxInputPixels,
                sequentialRead: true,
            }).autoOrient().resize({
                width: options.width,
                height: options.height,
                fit: resolveSharpFit(options.fit),
                withoutEnlargement: !options.fit,
            });

            const metadata = await pipeline.metadata();
            const frames = metadata.pages || 1;
            if (frames > MAX_ANIMATION_FRAMES || metadata.width * (metadata.pageHeight || metadata.height) * frames > maxInputPixels) {
                pipeline.destroy();
                throw Object.assign(new Error('Image animation exceeds the transform budget'), { statusCode: 413 });
            }

            pipeline = applyOutputFormat(pipeline, options.outputFormat);
            const output = await readStreamWithLimit(pipeline, MAX_OUTPUT_BYTES, options.signal);

            return new Response(output, {
                headers: {
                    'Content-Type': options.outputFormat,
                    'Content-Length': output.byteLength.toString(),
                },
            });
        } catch (error) {
            if (!stream.locked) void stream.cancel?.(error).catch(() => {});
            throw error;
        } finally { releaseSlot?.(); }
    },
};

function resolveSharpFit(fit) {
    if (fit === 'cover') return 'cover';
    if (fit === 'squeeze') return 'fill';
    return 'inside';
}

function applyOutputFormat(pipeline, outputFormat) {
    switch (outputFormat) {
        case 'image/jpeg':
            return pipeline.jpeg();
        case 'image/png':
            return pipeline.png();
        case 'image/webp':
            return pipeline.webp();
        case 'image/avif':
            return pipeline.avif();
        case 'image/gif':
            return pipeline.gif();
        default:
            throw new Error(`Unsupported Docker image output format: ${outputFormat}`);
    }
}

async function readStreamWithLimit(stream, maxBytes, signal) {
    const chunks = [];
    let totalBytes = 0;

    signal?.throwIfAborted();
    const reader = stream.getReader?.();
    const abort = () => { if (reader) void reader.cancel(signal.reason).catch(() => {}); else stream.destroy?.(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    const source = reader ? { async *[Symbol.asyncIterator]() { while (true) { const item = await reader.read(); signal?.throwIfAborted(); if (item.done) return; yield item.value; } } } : stream;
    try {
        for await (const chunk of source) {
            signal?.throwIfAborted();
            const buffer = Buffer.from(chunk);
            totalBytes += buffer.byteLength;
            if (totalBytes > maxBytes) {
                const error = new Error('Image resizing supports source files up to 20 MB');
                error.statusCode = 413;
                throw error;
            }
            chunks.push(buffer);
        }

        return Buffer.concat(chunks, totalBytes);
    } catch (error) { if (reader) void reader.cancel(error).catch(() => {}); else stream.destroy?.(); throw error; }
    finally { signal?.removeEventListener('abort', abort); reader?.releaseLock(); }
}

function readPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
