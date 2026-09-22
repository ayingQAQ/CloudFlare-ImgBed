// One Durable Object per repository. Only active requests are queued: a file is
// never acknowledged until HF accepts the commit. Cooldowns survive eviction.
export class HFCommitCoordinator {
    constructor(state, env, options = {}) {
        this.storage = state.storage;
        this.now = options.now || Date.now;
        this.fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
        this.timer = options.timer || globalThis.setTimeout.bind(globalThis);
        this.pending = [];
        this.bytes = 0;
        this.flushing = false;
        this.scheduled = false;
        this.ready = this.storage.get('nextAt').then(value => { this.nextAt = value || 0; });
    }

    async fetch(request) {
        await this.ready;
        const input = await request.json();
        if (input.check === true && /^[\w.-]+\/[\w.-]+$/.test(input.repo || '')) {
            const wait = this.nextAt - this.now();
            return wait > 40000 ? this.limited(wait) : Response.json({ ready: true });
        }
        if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo || '') || !input.token ||
            !['lfsFile', 'file'].includes(input.operation?.key) || !input.operation?.value?.path) {
            return Response.json({ error: 'Invalid HF commit operation' }, { status: 400 });
        }
        const wait = this.nextAt - this.now();
        if (wait > 40000) return this.limited(wait);
        const bytes = JSON.stringify(input.operation).length;
        if (this.pending.length >= 50 || this.bytes + bytes > 24 * 1024 * 1024) {
            return Response.json({ error: 'HF commit queue busy' }, { status: 429, headers: { 'Retry-After': '35' } });
        }
        // Do not mix identities or conflicting writes to a path in a commit.
        const first = this.pending[0];
        if (first && (first.input.token !== input.token || first.input.repo !== input.repo ||
            this.pending.some(item => item.input.operation.value.path === input.operation.value.path))) {
            return Response.json({ error: 'Conflicting HF commit; retry later' }, { status: 409 });
        }
        return new Promise(resolve => {
            this.pending.push({ input, resolve });
            this.bytes += bytes;
            this.schedule();
        });
    }

    limited(milliseconds) {
        return Response.json({ error: 'HF repository commit cooldown', retryAfter: Math.ceil(milliseconds / 1000) },
            { status: 429, headers: { 'Retry-After': String(Math.max(1, Math.ceil(milliseconds / 1000))) } });
    }

    schedule() {
        if (this.scheduled || this.flushing || !this.pending.length) return;
        this.scheduled = true;
        // Time-based flushing works even with one OpenList copy worker.
        this.timer(() => { this.scheduled = false; void this.flush(); }, Math.max(2000, this.nextAt - this.now()));
    }

    async flush() {
        if (this.flushing || !this.pending.length) return;
        this.flushing = true;
        const batch = this.pending.splice(0);
        this.bytes = 0;
        let body, status = 502, retryAfter;
        try {
            // <= 103 submissions/hour from this coordinator, leaving headroom
            // below the observed 128/hour quota. Count failed attempts too.
            this.nextAt = this.now() + 35000;
            await this.storage.put('nextAt', this.nextAt);
            const { repo, token } = batch[0].input;
            const payload = [JSON.stringify({ key: 'header', value: { summary: `Upload ${batch.length} files` } }),
                ...batch.map(item => JSON.stringify(item.input.operation))].join('\n');
            const response = await this.fetcher(`https://huggingface.co/api/datasets/${repo}/commit/main`, {
                method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-ndjson' },
                body: payload, signal: AbortSignal.timeout(25000),
            });
            status = response.status;
            body = await response.text();
            if (status === 429) {
                const delay = hfRetryDelay(response.headers.get('Retry-After'), body, this.now());
                this.nextAt = this.now() + delay;
                await this.storage.put('nextAt', this.nextAt);
                retryAfter = String(Math.ceil(delay / 1000));
            }
            console.log(JSON.stringify({ event: 'hf_commit_batch', files: batch.length, status }));
        } catch {
            status = 502;
            body = JSON.stringify({ error: 'HF commit outcome unavailable; check before retrying' });
        } finally {
            const headers = { 'Content-Type': 'application/json', ...(retryAfter ? { 'Retry-After': retryAfter } : {}) };
            for (const item of batch) item.resolve(new Response(body, { status, headers }));
            this.flushing = false;
            if (this.nextAt - this.now() > 40000) {
                for (const item of this.pending.splice(0)) item.resolve(this.limited(this.nextAt - this.now()));
                this.bytes = 0;
            }
            this.schedule();
        }
    }
}

export function hfRetryDelay(header, body, now = Date.now()) {
    if (header && /^\d+$/.test(header)) return Math.max(35000, Number(header) * 1000);
    if (header && Number.isFinite(Date.parse(header))) return Math.max(35000, Date.parse(header) - now);
    const match = String(body).match(/(?:in|about)\s+(\d+)\s*(minute|hour|second)/i);
    return match ? Math.max(35000, Number(match[1]) * ({ second: 1000, minute: 60000, hour: 3600000 })[match[2].toLowerCase()] + 5000) : 3600000;
}
