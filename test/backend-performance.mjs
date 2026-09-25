// Optional isolated local benchmark. Does not contact deployed services.
// node --import ./deploy/server/register.mjs test/backend-performance.mjs
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { LocalR2Storage } from '../deploy/server/r2Storage.js';

const directory = await mkdtemp(join(tmpdir(), 'imgbed-stream-benchmark-'));
const storage = new LocalR2Storage(directory);
const total = 256 * 1024 * 1024;
const baseline = process.memoryUsage();
const peak = { ...baseline };
const lag = monitorEventLoopDelay({ resolution: 10 }); lag.enable();
const sample = () => {
    const memory = process.memoryUsage();
    for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], memory[key]);
};
const timer = setInterval(sample, 5);
const start = performance.now();
try {
    let sent = 0;
    const body = new ReadableStream({ pull(controller) {
        if (sent >= total) { controller.close(); return; }
        const part = new Uint8Array(64 * 1024); part.fill(7);
        sent += part.byteLength; controller.enqueue(part);
    } });
    await storage.put('large.bin', body);
    const writeMs = performance.now() - start;
    let received = 0;
    const object = await storage.get('large.bin');
    for await (const part of object.body) received += part.byteLength;
    if (received !== total) throw new Error('Incomplete streamed object');
    sample();
    console.log(JSON.stringify({ node: process.version, bytes: total, writeMs: Math.round(writeMs),
        totalMs: Math.round(performance.now() - start), baseline, peak,
        peakRssGrowthMiB: Math.round((peak.rss - baseline.rss) / 1024 / 1024),
        eventLoopP99Ms: Math.round(lag.percentile(99) / 1e6) }, null, 2));
} finally {
    clearInterval(timer); lag.disable();
    // directory is the unique mkdtemp result; never remove a derived/user path.
    await rm(directory, { recursive: true, force: true });
}
