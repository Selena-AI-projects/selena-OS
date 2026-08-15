# Controlled cycle runbook

Use this procedure for a finite measurement cohort. It applies to both Visitor
View and API View, which must be planned and monitored separately.

1. Confirm the production backup, `active/queued=0`, target separation, and the
   expected job/call cardinality.
2. Select exactly one dispatch mechanism: either the recurring
   `schedule-maintenance` path or direct singleton dispatch. Never enable both.
3. For direct dispatch, start the worker with
   `SCHEDULE_MAINTENANCE_ENABLED=false`. The worker removes the existing
   `schedule-maintenance` cron entry on startup and ignores manual maintenance
   jobs while disabled.
4. Confirm `pgboss.schedule` has no `schedule-maintenance` row and that no
   maintenance jobs are active before sending direct jobs.
5. Use a unique cohort ID and singleton keys containing that ID. Preflight must
   reject an existing cohort or any active maintenance job.
6. Monitor created jobs, completed provider calls, per-provider counts, and
   OpenRouter/Visitor counts independently. Stop at the first hard-cap breach;
   do not retry the full scenario.
7. Disable prompts and brand, cancel remaining cohort jobs, verify
   `active/queued=0`, and restore the normal worker environment. With
   `SCHEDULE_MAINTENANCE_ENABLED=true` (the default), the next normal worker
   starts the recurring schedule again.

The scheduler fix is packaged as candidate image
`local/elmo-worker:0.2.19-openrouter-scheduler-fix`. It has not been deployed to
production. The isolated smoke used a temporary PostgreSQL and a no-network
stub target; no provider calls were made.
