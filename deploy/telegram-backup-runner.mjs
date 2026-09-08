// Pages has no scheduled handler. Run this on an always-on host for retries
// while browsers are closed. Worker and Docker deployments have built-in timers.
const origin = process.env.IMGBED_URL;
const token = process.env.TG_BACKUP_RUNNER_TOKEN;
if (!origin || !token) throw new Error('Set IMGBED_URL and TG_BACKUP_RUNNER_TOKEN');
const url = new URL('/api/telegramBackupRun', origin);
const once = process.argv.includes('--once');
do {
    let delay = 60000;
    try {
        const response = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(60000), redirect: 'error' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        if ((await response.json()).processed > 0) delay = 1000;
    } catch (error) {
        console.error('Backup runner request failed:', error.message);
        if (once) process.exitCode = 1;
        else await new Promise(resolve => setTimeout(resolve, 5000));
    }
    if (!once) await new Promise(resolve => setTimeout(resolve, delay));
} while (!once);
