# Backend audit repairs implementation plan

> Execute with superpowers:subagent-driven-development; retain the user's existing working-tree changes. No deployment or commit is required.

**Goal:** Fix all fifteen findings and the related concrete secondary issues from the backend review.

**Architecture:** Preserve the existing KV/D1 and Worker/Node interfaces. Use bounded streams and task admission for memory, transactional/conditional publication for state, SQL queries for D1 lists, and bounded incremental work for maintenance.

**Spec:** readme/backend-review-2026-09-26.md

**Constraints:** Preserve current uncommitted changes. Do not call production services. No secrets in outputs. Tests must exercise behavior, including failures and cancellation. No new platform binding required.

## Tasks and ownership

- [x] A: Data/index (F03 F04 F07 F11 F12). Own d1Database, databaseAdapter, indexManager, publicFileId, manage/list, batch/index/finalize, database schema/migrations. Add regression tests for paging/filtering, TTL, settings pagination, failed finalize, unknown aliases. D1 list must not hydrate the complete index; KV must retain filtering/pagination and bounded block reads. Legacy public aliases must be backfilled by bounded maintenance rather than request-time hash scans.
- [x] B: Streaming/local runtime (F01 F02 F08). Own file route/tools/storage API download helpers, LocalR2, imageProcessor, Node route lookup. Add slow consumer/cancel/range tests, multipart missing-part/conditional-write tests, image admission tests. No whole-file buffers in LocalR2; preserve R2 conditional writes and range semantics.
- [x] C: Upload/backup (F05 F13 F14 F15). Own upload tree, storageTiering (except capacity APIs), telegramBackup. Add failed upload/no false ACK, single multipart parse with byte limit, bounded merge status calls, backup admission tests. Keep retry bytes on client in D1; timeout must not leave detached writes. Backup scheduling must be durable and globally bounded across consumers.
- [x] D: Root integration (F06 F09 F10 and secondary issues). Own rename/move, r2Capacity, ancillary maintenance/runtime integration, docs/package scripts. Reuse safe logical relocation; update public aliases and confirm index persistence. Replace per-upload full scans with a conservative ledger that counts reservations through commit and reconciles periodically without losing concurrent mutations.
- [x] E: Review and validation. Review each task against the report, run complete tests, Worker bundle checks and targeted Node checks; document migrations and any remaining operational limitations.

## Interface checks and rulings

| Tasks | Shared boundary | Decision |
| --- | --- | --- |
| A/D | D1 schema + maintenance | A owns adapter changes; D integrates maintenance calls after interface is reported. |
| B/D | R2 adapter + capacity ledger | B preserves put/head/get/list/multipart conditional semantics; D counts capacity independently. |
| C/D | capacity release after upload | D preserves reserveR2/releaseR2/attachR2Multipart/checkR2Reservation API and supplies commit accounting internally. |
| A/C | request data + index | Keep existing context contracts and await index persistence where required. |
| A/B/C | common concurrency utilities | Create task-specific helper files; coordinate before editing existing shared utility. |

Each task starts with a failing regression or the existing audit reproduction, implements the smallest coherent repair, runs its tests, and reports files and evidence. Integration runs `npm test` plus all new tests. Final review covers migration compatibility, failure recovery, cancellation, bounded memory, and generated Worker entry parity.

Ruling: Work in the current workspace because the requested current backend includes substantial uncommitted fixes; isolating only HEAD would omit the user's baseline. Preserve and inspect those edits throughout.


## Final verification

- All fifteen findings and concrete secondary optimizations implemented; independent review found and verified additional fixes for >1000 child directories, overlapping chunk attempts, and multipart recovery lifetime.
- Final `npm test`: 132 passed, 0 failed (31 storage + 25 existing backend + 76 repair regressions).
- Worker and state-gateway Wrangler dry runs: passed, no deployment.
- Isolated Node startup smoke: passed; installed better-sqlite3 native binding rebuilt locally to allow the check, with no package version changes.
- 256 MiB isolated LocalR2 read/write benchmark: RSS growth 49 MiB, event-loop P99 13 ms on Node v24.11.1; no production or before/after throughput claims.
- Final diff whitespace check passed. Frontend/preexisting working-tree edits retained.
- Rollout details and limitations: readme/backend-repairs-2026-09-26.md.
