// Optional isolated startup smoke test; never opens the user's data directory.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const directory = await mkdtemp(join(tmpdir(), 'imgbed-runtime-smoke-'));
const child = spawn(process.execPath, ['--import', './deploy/server/register.mjs', 'deploy/server/index.js'], {
    cwd: new URL('..', import.meta.url), windowsHide: true,
    env: { ...process.env, DATA_DIR: directory, PORT: '0', STATE_GATEWAY_URL: '', STATE_GATEWAY_SECRET: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stderr.on('data', data => { output += data; });
try {
    const port = await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 15000);
        child.once('error', error => { clearTimeout(timeout); reject(error); });
        child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited ${code}: ${output}`)); });
        child.stdout.on('data', data => {
            output += data;
            const match = /Server running at http:\/\/0\.0\.0\.0:(\d+)/.exec(output);
            if (match) { clearTimeout(timeout); resolve(Number(match[1])); }
        });
    });
    const root = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(root.status, 200); await root.body.cancel();
    const random = await fetch(`http://127.0.0.1:${port}/random`);
    assert.equal(random.status, 403);
    assert.equal((await random.json()).error, 'Random is disabled');
    console.log('Node startup, fresh-schema migrations, static route and middleware/function dispatch: passed');
} finally {
    if (child.exitCode === null) { child.kill(); await once(child, 'exit'); }
    await rm(directory, { recursive: true, force: true });
}
