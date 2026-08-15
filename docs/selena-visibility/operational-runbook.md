# Selena Visibility local/staging runbook

## Scope

The Selena client layer runs above the existing Elmo Measurement Engine and Evidence Ledger. Website Collector, public-source fixture adapters, Connected Analytics contracts and Monitoring Core are reused as completed components. Native apps and live provider integrations are not part of this MVP.

## Safe local verification

1. Start only the isolated compose project from `tmp/selena-visibility-test-compose.yml`.
2. Apply migrations only to database `selena_visibility_test` on port `55432`.
3. Run `bash tools/selena_isolated_e2e.sh`.
4. Run the lib test suite and web typecheck/build.
5. Confirm provider calls and Elmo jobs remain zero.

Production database, real payment providers, Bright Data, OpenRouter and external analytics credentials must not be used by this runbook.

## Flow states

`DRAFT → AWAITING_APPROVAL → READY → RUNNING → COMPLETE` is the successful path. `BUDGET_BLOCKED`, `PARTIAL`, `FAILED` and `STOPPED` are terminal or operator-visible control states. A quote exceeding the order cap is blocked before dispatch. Cardinality and duplicate dispatch checks happen before runtime execution.

## Authentication and tenant safety

- Browser cabinet uses Better Auth session membership.
- Machine-to-machine routes use a scoped hashed API key.
- Tenant scope comes only from AuthContext; body/query `tenantId` is rejected when it differs.
- Never log tokens, raw credentials or provider secrets.
- Connector contracts remain `NOT_ACTIVATED` until explicit owner-approved integration work.

## Incident handling

- `BUDGET_BLOCKED`: adjust the test quote or budget; do not bypass the gate.
- `CARDINALITY_BLOCKED`: inspect scenario/system/repeat cardinality and dispatch keys.
- `DUPLICATE`: reuse the original idempotent result; do not dispatch again.
- `GROUNDING_FAILED`: keep the Action Plan unpublished and inspect evidence references.
- `PARTIAL` or `FAILED`: preserve immutable snapshots and audit events; retry only through a new approved cycle.
- `STOPPED`: record the stop reason and leave no new dispatches.

## Export safety

CSV/report exports use canonical rows and tenant-scoped data. Exports must contain source references and limitations, never secrets, access tokens or raw provider credentials.

## Railway staging fixture activation

Staging project: `selena-ai-visibility` (`51dd0770-e622-4734-a705-ace401234bb8`). The isolated staging environment is `90f3bf7f-5e53-4de3-a3f7-56052b706f24`; production is not modified.

- Web: `55909c04-a9ea-49af-9b71-98e4d7b848c9`, generated URL `https://web-staging-4a8f.up.railway.app`.
- Worker: `a43c94e7-76c5-4490-b8cb-87fd4ff97e33`, no public domain.
- Migration: `85e09996-7bc6-4dcd-a4af-7582683fa38c`, one-shot, restart policy `NEVER`.
- PostgreSQL: `280e3b59-77c3-46e0-8c2c-75955b7f9a40`.

Fixture bindings use `DEPLOYMENT_MODE=local`, `SCRAPE_TARGETS=stub:stub`, `ONBOARDING_LLM_TARGET=stub:stub`, telemetry disabled and `SCHEDULE_MAINTENANCE_ENABLED=false`. Staging-only auth/encryption secrets are generated randomly and passed to Railway through sealed stdin bindings; their values are never read back.

Activation order is migration SUCCESS → web SUCCESS and `/api/setup-status` HTTP 200 → worker SUCCESS with bounded logs. Real provider calls, payment calls, Elmo measurements and scheduler fan-out remain disabled.

## Production readiness gate (2026-08-15)

- Release candidate `selena-visibility-mvp-rc1` remains unchanged and does not contain commits `3e3501f5` and `6c515889`.
- Release candidate `selena-visibility-mvp-rc2` was created at commit `6c515889474c13824f806eaf3e70cbaf128126a5` and published to the Selena origin repository.
- Read-only Railway review confirmed staging remains healthy and production environment `72cd278f-af7c-4802-8da3-20a143d0ba1e` currently contains zero services.
- Production PostgreSQL backup/PITR cannot be verified because no production PostgreSQL service exists. No production service, migration, secret, domain, or deployment was created.
- Required rollback plan before production boot: retain the immutable release tag, take a provider-confirmed database backup/PITR checkpoint, apply migrations as a one-shot job, verify health, and roll back application services to the prior immutable release without destructive database changes. This plan is pending the production database and backup/PITR capability.
