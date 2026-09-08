// Download in bounded ranges, including files requiring more than 50 TG API calls.
import { open } from 'node:fs/promises';
const [fileId, output] = process.argv.slice(2);
if (!fileId || !output || !process.env.IMGBED_URL || !process.env.IMGBED_MANAGE_TOKEN) {
    throw new Error('Usage: IMGBED_URL / IMGBED_MANAGE_TOKEN set; node deploy/download-telegram-backup.mjs <fileId> <output>');
}
const url = new URL('/api/manage/telegramBackup', process.env.IMGBED_URL);
url.searchParams.set('fileId', fileId);
url.searchParams.set('download', 'true');
const file = await open(output, 'wx'); // Never overwrite an existing local file.
try {
    for (let start = 0; ; start += 8 * 1024 * 1024) {
        const response = await fetch(url, { headers: {
            Authorization: `Bearer ${process.env.IMGBED_MANAGE_TOKEN}`,
            Range: `bytes=${start}-${start + 8 * 1024 * 1024 - 1}`,
        }, redirect: 'error', signal: AbortSignal.timeout(60000) });
        if (response.status !== 206) throw new Error(`Download failed: HTTP ${response.status}`);
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        if (!range || Number(range[1]) !== start) throw new Error('Invalid backup range');
        const data = new Uint8Array(await response.arrayBuffer());
        if (data.byteLength !== Number(range[2]) - start + 1) throw new Error('Incomplete backup range');
        await file.writeFile(data);
        if (Number(range[2]) + 1 === Number(range[3])) break;
    }
} finally { await file.close(); }
