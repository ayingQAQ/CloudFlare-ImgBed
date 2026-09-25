// Preserved from production gateway version 0b0d989a-d080-47fd-84c0-fc3f06d5f5a5.
var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../functions/utils/storage/hfCommitCoordinator.js
var HFCommitCoordinator = class {
  static {
    __name(this, "HFCommitCoordinator");
  }
  constructor(state, env, options = {}) {
    this.storage = state.storage;
    this.now = options.now || Date.now;
    this.fetcher = options.fetcher || globalThis.fetch.bind(globalThis);
    this.timer = options.timer || globalThis.setTimeout.bind(globalThis);
    this.pending = [];
    this.bytes = 0;
    this.flushing = false;
    this.scheduled = false;
    this.ready = this.storage.get("nextAt").then((value) => {
      this.nextAt = value || 0;
    });
  }
  async fetch(request) {
    await this.ready;
    const input = await request.json();
    if (input.check === true && /^[\w.-]+\/[\w.-]+$/.test(input.repo || "")) {
      const wait2 = this.nextAt - this.now();
      return wait2 > 4e4 ? this.limited(wait2) : Response.json({ ready: true });
    }
    if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo || "") || !input.token || !["lfsFile", "file"].includes(input.operation?.key) || !input.operation?.value?.path) {
      return Response.json({ error: "Invalid HF commit operation" }, { status: 400 });
    }
    const wait = this.nextAt - this.now();
    if (wait > 4e4) return this.limited(wait);
    const bytes = JSON.stringify(input.operation).length;
    if (this.pending.length >= 50 || this.bytes + bytes > 24 * 1024 * 1024) {
      return Response.json({ error: "HF commit queue busy" }, { status: 429, headers: { "Retry-After": "35" } });
    }
    const first = this.pending[0];
    if (first && (first.input.token !== input.token || first.input.repo !== input.repo || this.pending.some((item) => item.input.operation.value.path === input.operation.value.path))) {
      return Response.json({ error: "Conflicting HF commit; retry later" }, { status: 409 });
    }
    return new Promise((resolve) => {
      this.pending.push({ input, resolve });
      this.bytes += bytes;
      this.schedule();
    });
  }
  limited(milliseconds) {
    return Response.json(
      { error: "HF repository commit cooldown", retryAfter: Math.ceil(milliseconds / 1e3) },
      { status: 429, headers: { "Retry-After": String(Math.max(1, Math.ceil(milliseconds / 1e3))) } }
    );
  }
  schedule() {
    if (this.scheduled || this.flushing || !this.pending.length) return;
    this.scheduled = true;
    this.timer(() => {
      this.scheduled = false;
      void this.flush();
    }, Math.max(2e3, this.nextAt - this.now()));
  }
  async flush() {
    if (this.flushing || !this.pending.length) return;
    this.flushing = true;
    const batch = this.pending.splice(0);
    this.bytes = 0;
    let body, status = 502, retryAfter;
    try {
      this.nextAt = this.now() + 35e3;
      await this.storage.put("nextAt", this.nextAt);
      const { repo, token } = batch[0].input;
      const payload = [
        JSON.stringify({ key: "header", value: { summary: `Upload ${batch.length} files` } }),
        ...batch.map((item) => JSON.stringify(item.input.operation))
      ].join("\n");
      const response = await this.fetcher(`https://huggingface.co/api/datasets/${repo}/commit/main`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-ndjson" },
        body: payload,
        signal: AbortSignal.timeout(25e3)
      });
      status = response.status;
      body = await response.text();
      if (status === 429) {
        const delay = hfRetryDelay(response.headers.get("Retry-After"), body, this.now());
        this.nextAt = this.now() + delay;
        await this.storage.put("nextAt", this.nextAt);
        retryAfter = String(Math.ceil(delay / 1e3));
      }
      console.log(JSON.stringify({ event: "hf_commit_batch", files: batch.length, status }));
    } catch {
      status = 502;
      body = JSON.stringify({ error: "HF commit outcome unavailable; check before retrying" });
    } finally {
      const headers = { "Content-Type": "application/json", ...retryAfter ? { "Retry-After": retryAfter } : {} };
      for (const item of batch) item.resolve(new Response(body, { status, headers }));
      this.flushing = false;
      if (this.nextAt - this.now() > 4e4) {
        for (const item of this.pending.splice(0)) item.resolve(this.limited(this.nextAt - this.now()));
        this.bytes = 0;
      }
      this.schedule();
    }
  }
};
function hfRetryDelay(header, body, now = Date.now()) {
  if (header && /^\d+$/.test(header)) return Math.max(35e3, Number(header) * 1e3);
  if (header && Number.isFinite(Date.parse(header))) return Math.max(35e3, Date.parse(header) - now);
  const match = String(body).match(/(?:in|about)\s+(\d+)\s*(minute|hour|second)/i);
  return match ? Math.max(35e3, Number(match[1]) * { second: 1e3, minute: 6e4, hour: 36e5 }[match[2].toLowerCase()] + 5e3) : 36e5;
}
__name(hfRetryDelay, "hfRetryDelay");


export { HFCommitCoordinator, hfRetryDelay };
