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
