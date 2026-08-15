# Selena AI Visibility — production activation runbook

This runbook is intentionally stopped before paid infrastructure or live
provider calls. RC4 staging remains fixture-only.

## Preconditions

1. Create a production PostgreSQL service in Railway with recoverable backup or
   PITR and document the retention/restore target.
2. Configure encrypted production secrets through the existing secret boundary;
   never paste values into logs, tickets or the browser.
3. Deploy an immutable Selena release and run one-shot migrations once.
4. Verify web and worker health endpoints, logs, metrics and alerts.
5. Verify rollback to the previous immutable web/worker images.
6. Keep provider/payment flags disabled and
   `SCHEDULE_MAINTENANCE_ENABLED=false`.

## Staging RC4 canary

Deploy the immutable `selena-visibility-mvp-rc4` to the existing staging
environment only. Verify `/api/setup-status` and `/selena` return 200, worker
logs show maintenance disabled, and the browser fixture flow produces zero
provider/payment calls before considering the candidate for activation.

## Controlled launch

Admin must approve a quote and order, verify budget/cardinality permits, and
enable only the specific paid cycle. Run fixture mode first; expected provider
calls remain zero until the owner explicitly authorizes live dispatch.

## Abort conditions

Stop the global switch or order cycle on any budget, cardinality, duplicate,
402/429/5xx, timeout or stuck-job alert. Record the audit event before retrying.
