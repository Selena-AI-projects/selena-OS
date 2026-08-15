# Selena AI Visibility — rollback runbook

1. Disable provider/payment flags and maintenance scheduling.
2. Activate the global emergency stop and stop the affected order/cycle.
3. Confirm no active or queued dispatch jobs remain.
4. Repoint web and worker to the previous immutable release (RC5 → RC4); do not rewrite
   tags or run destructive database commands.
5. Check health endpoints, login boundary, queue state and database
   connectivity.
6. Preserve audit logs and the failed release artifacts for investigation.
7. Re-enable only after owner approval and a successful fixture canary.

Rollback is not verified for production until the production PostgreSQL and
recoverable backup/PITR gate exists. Staging rollback may be exercised between
immutable RC5 and RC4 images without touching production. Existing tags remain
immutable.
