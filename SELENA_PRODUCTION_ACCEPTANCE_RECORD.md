# Selena Production Acceptance Record

Date: 2026-08-15
Release tag: `selena-visibility-mvp-rc6-v1.2`
Release commit: `16e522e712aa55c2737f8b80f14a62f80b6f55ab`

## Staging release evidence

- Web deployment: `356822e9-eddd-484d-8073-843e99be038a` — `SUCCESS`
  - image digest: `sha256:566575830dbabf9fcf58ade874ee57f4d6935d593afbf60f4eacc2621081c5a8`
- Worker deployment: `1d1cb57f-d467-4013-8cf1-7d5486eba5b3` — `SUCCESS`
  - image digest: `sha256:d23ee17f2114981fc35f14f9b0c6c80bf2ec8dc1f55033feb7f965a81f09eb70`
- Browser Public Readiness E2E: PASS
- Provider calls: 0
- Payment charges: 0
- Measurement jobs: 0
- Maintenance: OFF

## Production foundation actions

- Temporary approved seller legal entity for Selena AI Visibility: `PT Izi Jiza Bali`.
- Seller address, NIB, NPWP, bank details and payment-provider KYC: owner inputs pending.
- Checkout currency: USD; live payments remain OFF pending payment-provider KYC and explicit owner authorization.

- Production environment: `72cd278f-af7c-4802-8da3-20a143d0ba1e`
- Production PostgreSQL service created: `Postgres-production`
  - service ID: `c29babea-c5ef-4594-9d11-c5c11592dbf6`
- Existing `Postgres-production` was not modified or deleted.
- New sibling PostgreSQL created from the official Railway PostgreSQL template:
  - service: `Postgres-W_9y`
  - service ID: `1d67db6f-7df7-44d6-a9d7-3d7058afafff`
  - image: `ghcr.io/railwayapp-templates/postgres-ssl:18` (major tag)
  - deployment: `1846aae7-6e64-4435-8eae-6bf6cd4a6b9b` — `SUCCESS`
  - persistent volume: `postgres-volume-pHMM`, 5,000 MB, mounted at `/var/lib/postgresql/data`
  - connection variable names confirmed without exposing values: `DATABASE_URL`, `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`
- Railway-managed PITR enabled on `Postgres-W_9y`; bucket wiring confirmed and `WAL_ARCHIVE_*` variables present.
- PITR policy: weekly full plus daily incremental backups, last four full backups retained (approximately four weeks), per Railway documentation.
- Latest database deployment: `b963d6d7-c90b-4736-b9ae-94fc49a3d4c5` — terminal `SUCCESS`.
- Runtime log evidence: `stanza-create completed`; full pgBackRest backup completed successfully; catalog verified with full backup present in S3; archive-push completed successfully; watcher reported `failed=0`, `gap_state=clear`, `lag=0`.
- Read-only PostgreSQL diagnostics on `Postgres-W_9y`:
  - `archive_mode`: `on`
  - `archive_command`: pgBackRest archive wrapper
  - `archive_timeout`: `1min`
  - `pg_stat_archiver`: `archived_count=22`, `failed_count=0`
  - `pg_is_in_recovery()`: `false`
- One technical `restore_probe` row was inserted and one `pg_switch_wal()` was executed; no WAL generation loop was run.
- Production worker variable set without deployment:
  - `SCHEDULE_MAINTENANCE_ENABLED=false`
- DNS: not changed.
- Live payments: not enabled.
- Real provider calls: not enabled.
- Production application deployment: not started.

## External blocker — production database acceptance

The new managed PostgreSQL foundation is provisioned and the runtime evidence
shows healthy pgBackRest archiving, a successful full backup, and zero
archiver failures. However, Railway's PITR status command still reports live
coverage as `unavailable`, and the available Backups/PITR inspection tools do
not expose a non-empty restore range. Therefore the isolated restore test and
integrity check cannot honestly be marked PASS yet. The source service remains
untouched and production web/worker deployment remains OFF.

Required next evidence: Railway must expose a non-empty restore range and a
successful restore into a new sibling service; record marker A/B results,
restored service and volume IDs, schema/table integrity, and measured recovery
duration here before marking the foundation accepted.

This record is not `PRODUCTION ACCEPTED` and does not authorize DNS, live
payments, or real provider calls.
