# Dual backend production status — 2026-09-13

Both `imgb.top/*` and `www.imgb.top/*` run `cloudflare-imgbed` as Workers Routes over proxied GreenCloud origins. Neither public hostname uses a Worker Custom Domain. `origin-vps.imgb.top` has no Worker Route and is the dedicated fallback target.

## Shared state and storage

- Authoritative metadata, sessions, settings and file aliases: D1 `imgbed-shared`.
- Shared R2: `imgbed-r2`. VPS accesses D1/R2 through authenticated `cloudflare-imgbed-state-gateway`.
- Worker has no KV binding. Old KV data has not been deleted.
- Worker cron synchronizes only HF/TG storage environment credentials into protected shared settings. VPS loads these at startup and refreshes every minute. Administrator credentials are never copied from bootstrap environment values.
- VPS: `/opt/cloudflare-imgbed`, container `cloudflare-imgbed`, loopback `127.0.0.1:17658`, image `cloudflare-imgbed:origin-repair-20260913b`.
- Metadata snapshots use a single D1 batch transaction. Backup script: `/opt/cloudflare-imgbed/backup.sh`; latest verified backup: `/opt/backups/cloudflare-imgbed/20260913T081756Z`.

## Repairs and evidence

- HF origin reads restored; TG getMe and channel administrator/post permissions verified.
- R2 full responses include Content-Length; byte-range responses return 206 and exact lengths through Cloudflare. Unicode keys, open/suffix ranges and conditional reads are preserved by the gateway.
- Origin requests restore HTTPS and approved public hostnames, keeping generated links and cookie attributes correct. Versioned fallback requests bypass stale origin cache entries without purging stored files.
- Real tests: VPS R2 and HF uploads plus www R2 upload; every file read from all three hosts matched original bytes. All three test files deleted successfully.
- Temporary diagnostic admin session was accepted on all backends and removed afterwards. Current administrator password was not changed; password entry itself was not retested because the earlier temporary password no longer matches.
- Container restart retained channels/configuration and returned healthy.
- Automated suite: 44 passing tests, including quota error/code exception fallback and origin unavailability.

## Failure behavior and limits

Healthy requests use Worker. Allowlisted reads automatically fall back on application exceptions, 5xx or observed KV quota exceptions. Ordinary business 429 responses remain unchanged. Legacy GET mutations, uploads, login and deletes are never automatically replayed after an ambiguous failure.

Explicit `ORIGIN_PRIMARY=true` routes each request once to VPS, including writes; this mode is available but not enabled. Tests cover streaming and avoiding duplicate writes. It is not an automatic circuit breaker.

Both backends share D1/R2 and the same Cloudflare edge. This removes KV.list quotas and application-instance divergence; it is **not** independence from a complete Cloudflare or shared-state outage. Independent disaster recovery requires a separate data/DNS architecture and is not silently enabled.

## Deployment safety

Production workflow checks out `deploy/dual-backend-20260913`. Versioned `dual-backend.json` controls D1/R2 and both Routes. Old KV/CUSTOM_DOMAIN repository secrets are ignored. Workflow checks reject missing topology, KV or Custom Domain deployment configuration. Application secrets stay on Cloudflare.

## Rollback

Restore `/opt/cloudflare-imgbed/compose.yaml.before-origin-repair` as compose.yaml and run `docker compose up -d` in `/opt/cloudflare-imgbed` to restore the previous container image. Do not restore old metadata over live D1 writes. Worker code rollback must retain the shared D1/R2 bindings and two Routes; never restore the legacy KV/Custom Domain deployment.
