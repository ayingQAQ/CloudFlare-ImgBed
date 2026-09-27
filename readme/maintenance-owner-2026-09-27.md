# Edge CPU errors from duplicate scheduled maintenance

Live tail captured the main Worker's `* * * * *` scheduled invocations ending
with `outcome: exceededCpu`, CPU time 10 ms and wall times 5.9–7.2 seconds.
This matches the dashboard's sustained roughly 15 errors per 15-minute bin.
It does not establish that every historical error had this cause. Some later
invocations succeeded with 18–20 ms CPU time.

GreenCloud's existing non-overlapping timer already runs maintenance and Telegram
backup processing every minute against the same shared state. Production Routes
now set `MAINTENANCE_OWNER=origin`: after lightweight channel configuration sync,
the edge cron skips duplicate heavy maintenance when `ORIGIN_STATE_READY=true`.
Regular HTTP handling, upload processing and origin fallback remain unchanged.

If GreenCloud is unavailable, periodic cleanup, index merging and scheduled backup
processing wait for its recovery (request-driven work can still run). For deliberate
maintenance failover, remove this variable or set it to `worker` and redeploy;
ensure the Worker has a sufficient CPU budget first. Standalone Worker deployments
retain their prior scheduler behavior by default.

Validation: ownership regression plus the full 141-test backend suite passed.
VPS maintenance logs showed continued successful index loads/merges before the
ownership change. No image data or credentials were modified.
