# HF commit batching

Both the routed Worker and the VPS origin use the same repository coordinator
in `cloudflare-imgbed-state-gateway`. LFS bytes still upload using the existing
flow; only HF commit operations are grouped. Direct (non-LFS) uploads also use
the coordinator. Storage channel selection is unchanged.

## Behavior

- Flush after 2 seconds even when only one file is waiting. Waiting for a fixed
  file count would deadlock an OpenList pool smaller than the batch size.
- Space submissions by at least 35 seconds per repository (at most roughly 103
  attempts/hour). This leaves headroom below the 128/hour rejection observed
  on the current account; HF may change its limits.
- A batch contains up to 50 ready operations, with a bounded payload. With five
  OpenList copy workers, batches typically contain at most five files.
- Return success only after HF accepts the commit. Each upload then writes its
  normal ImgBed metadata. A rejected commit fails every member of that batch.
- Persist the next submission time and HF 429 cooldown in SQLite-backed DO
  storage. Preflight rejects uploads during long cooldowns before LFS transfer.
  Forward HTTP 429 and Retry-After to the client.
- Worker and origin share coordination; upload fallback allows 110 seconds,
  while read fallback retains its 15-second timeout.

The waiting requests are not a durable offline job queue. If the caller or
runtime disconnects, it must check the file before retrying an uncertain commit.
OpenList's existing task retry policy remains unchanged. External HF clients
and deletion commits bypass this coordinator and can still consume the quota.
This change does not address Cloudflare 1102 or source-download EOF failures.

## Deployment and rollback

Deploy the gateway before the application Worker:

```sh
npm test
npx wrangler deploy --config deploy/worker/wrangler.state-gateway.toml
node deploy/worker/generate-routes.js
npx wrangler deploy --config deploy/worker/wrangler.toml
```

The application binding must reference the same gateway script used by the
origin's existing STATE_GATEWAY_URL. Keep its authentication secret unchanged.
Deploy the updated `huggingfaceAPI.js` and three upload handlers to the origin
too. A Worker-only release would leave origin uploads uncoordinated.

Production release on 2026-09-22:

- Gateway: `0b0d989a-d080-47fd-84c0-fc3f06d5f5a5`.
- Application: `662364bd-cec6-4c52-b7b5-b10be5b742ac`.
- Prior application version: `6b003ad9-ec51-480e-9d70-fd329766d380`.
- Origin host: `greencloud`; compose directory `/opt/cloudflare-imgbed`.
- Origin image: `cloudflare-imgbed:hf-batching-20260922`, derived from the
  retained `cloudflare-imgbed:audit-repair-20260922` image with four files changed.
- Compose backup: `compose.yaml.before-hf-batching-20260922` in that directory.
  Restore that image reference and run `docker compose up -d --no-deps imgbed`
  only when intentionally rolling back. Preserve volumes and data.

For rollback, revert the application and origin first. The gateway can remain
deployed with its unused DO binding; do not delete its namespace/cooldown state.

## Verification

- `npm test`: 63 passing tests, including actual workerd/Miniflare DO batching,
  single-file flushing, pacing, cooldown persistence, and rejection handling.
- OpenList `/imgbed-r2` → `/imgbed-hf`: two batches of five tiny PNGs, each
  represented by one HF commit, all listed and publicly readable with the
  site's normal browser headers.
- One origin upload followed by a Worker batch: HF commit timestamps exactly
  35 seconds apart, demonstrating shared pacing across both paths.
- HF commits: `cc35f0c9` (5), `949f224f` (1 origin), `c0ac1ade` (5).
- Test files retained under `hf-batch-check-20260922/{source,result,origin,second}`.
  Five initial test tasks referenced names before ImgBed's timestamp prefix and
  failed with object-not-found before uploading; corrected tasks all succeeded.
  No historical failed copy tasks were retried or removed.

No large-file throughput or hour-long load test was performed. The LFS/direct
commit code paths are covered, but an entire directory is not held until all its
files finish: commits combine only files concurrently ready for submission.
