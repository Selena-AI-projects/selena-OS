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
  - deployment: `b963d6d7-c90b-4736-b9ae-94fc49a3d4c5` — `SUCCESS`
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
  - `pg_stat_archiver` after the restore probe: `archived_count=97`, `failed_count=0`
  - `pg_is_in_recovery()`: `false`
- Two technical `restore_probe` rows were inserted and exactly two
  `pg_switch_wal()` calls were executed across the foundation and marker A/B
  checks; no WAL generation loop was run.
- Production worker variable set without deployment:
  - `SCHEDULE_MAINTENANCE_ENABLED=false`
- Public product DNS was changed separately for early access:
  `app.selenasystems.com` is attached to the accepted staging RC6 web service,
  with Railway ownership verification and TLS certificate status `VALID`.
  This is not a production web/worker deployment.
- Live payments: not enabled.
- Real provider calls: not enabled.
- Production application deployment: not started.

## Production database restore acceptance — PASS

Railway's PITR picker/status probe continued to report coverage as unavailable.
The cause was isolated to the CLI live probe invoking `pgBackRest info` as
`root`; the image correctly rejects that command. Running the same read-only
command as the PostgreSQL system user returned repository status `ok`, full
backup `20260815-131415F`, and archived WAL from segment `...0001` through at
least `...005F`.

Marker A/B restore evidence:

- marker A: `foundation-probe`, created `2026-08-15T13:35:29.384Z`;
- marker B: `marker-b-20260815`, created `2026-08-15T14:47:25.520Z`;
- explicit restore target: `2026-08-15T14:00:00Z`;
- workflow: `createServiceFromPITR/51dd0770-e622-4734-a705-ace401234bb8/11c3672b-38b8-4193-b407-ca259e91b3f9/YJFqWd-fOqiC-AfnGTKoC`;
- restored sibling service: `Postgres-W_9y-restore-test-20260815`;
- restored service ID: `e8eee92c-02f9-45f5-b78f-f8cb05fa8a7b`;
- restored deployment: `f264b27a-862d-48c7-8193-4552385d5232` — `SUCCESS`;
- restored volume: `dd8de391-fb05-4c04-9cae-bd67f7bd4a54`, 5,000 MB,
  status `Ready`;
- marker A present in the restored database: PASS;
- marker B absent in the restored database: PASS;
- restored database promoted (`pg_is_in_recovery()=false`): PASS;
- invalid indexes: `0`; unvalidated constraints: `0`;
- schema-only dump: PASS (`1,173` bytes);
- restore service creation to PostgreSQL postmaster start: approximately
  `26.6 seconds` (`14:47:59.610Z` to `14:48:26.242Z`);
- source database remained primary and healthy, with marker B present and
  `failed_count=0` after restore: PASS.

Status: `PRODUCTION DATABASE FOUNDATION ACCEPTED`. This acceptance does not
authorize a production web/worker deployment, live payments, real provider
calls, or automatic measurement jobs. The restored sibling remains isolated
and is not connected to any application.
