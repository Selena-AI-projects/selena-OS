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

- Production environment: `72cd278f-af7c-4802-8da3-20a143d0ba1e`
- Production PostgreSQL service created: `Postgres-production`
  - service ID: `c29babea-c5ef-4594-9d11-c5c11592dbf6`
- Production worker variable set without deployment:
  - `SCHEDULE_MAINTENANCE_ENABLED=false`
- DNS: not changed.
- Live payments: not enabled.
- Real provider calls: not enabled.
- Production application deployment: not started.

## External blocker — production database acceptance

The created image-based PostgreSQL service does not yet expose a verified
Railway-managed `DATABASE_URL`, persistent volume, backup/PITR retention policy,
or restore-test evidence. Consequently the production database is not accepted
as a safe application foundation, and production web/worker deployment remains
OFF. A Railway-managed PostgreSQL provisioning path plus owner-confirmed
backup/PITR policy and a successful restore test are required before the next
step.

This record is not `PRODUCTION ACCEPTED` and does not authorize DNS, live
payments, or real provider calls.
