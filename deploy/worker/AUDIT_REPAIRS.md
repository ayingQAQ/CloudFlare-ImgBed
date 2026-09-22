# Audit repairs, 2026-09-22

Production source branch: `deploy/dual-backend-20260913`.

1. Authentication rejects unavailable security configuration rather than granting admin access.
2. Same-path moves are no-ops. Descendant folder moves and occupied destinations are rejected. R2 copies use conditional create and retain source bytes until metadata and aliases are durable. S3/WebDAV use their existing independent object keys for logical moves.
3. Public links follow successive relocation mappings, including moving back to the original directory.
4. Public resource proxy validates literal addresses; Docker resolves DNS and pins connections to validated public addresses, including redirect hops. Private and IPv4-mapped IPv6 destinations are rejected.
5. Upload middleware replaces unsigned visitor headers with a server-signed HttpOnly cookie identity. Each visitor retains their own 30-upload limit across IP changes. Issuing fresh identities is separately limited to 60/hour/IP. Clearing cookies still creates a new anonymous identity; proving human uniqueness requires accounts or a challenge service and is not claimed here.
6. Admin login admits at most 10 attempts/10 minutes/IP using shared atomic storage. Storage failure fails closed.
7. Deployment runs all regression tests before publishing either Worker. The regression workflow includes the production branch and the new audit/fallback tests.
8. Read fallback covers login pages and session/channel/directory reads. An application failure opens a 30-second per-isolate/hostname circuit: subsequent requests go to the origin once, including writes. An already-attempted mutation is never replayed. This is not a globally coordinated circuit and cannot overcome a Cloudflare-wide/shared-D1 outage.
9. Origin response-header wait is bounded; remote D1/R2 requests and proxy DNS/network waits have timeouts. VPS startup stays alive with unavailable APIs while waiting for shared configuration, then retries on its minute timer. It never substitutes local SQLite for authoritative D1.
10. `imgbed-backup.timer` runs the existing protected backup script daily at 04:15 server time, with jitter, a lock and a ten-minute execution limit. `Persistent=true` catches up after downtime. Backups are not pruned automatically.

Validation: `npm test`; live verification and deployment identifiers are reported in the task. Existing data and administrator credentials are not reset. On a partial cross-store move failure, an extra copy may remain for recovery rather than risking deletion of the only surviving bytes.

Rollback: restore the saved pre-audit compose file and run `docker compose up -d`; preserve shared D1/R2. Disable the new timer with `sudo systemctl disable --now imgbed-backup.timer` if needed. Do not restore an old metadata snapshot over new uploads.
