# Selena AI Visibility — owner operating guide

## Deployment mode

Selena deployments must run `DEPLOYMENT_MODE=local` (the Dockerfile default,
also recorded in the operational runbook). The upstream `cloud` mode enables
Stripe billing and a plan picker with the upstream product's own plans and
prices, which do not match the published Selena catalog — never switch a
customer-facing Selena deployment to `cloud` mode.

## Spend guards before approving runs

Two environment variables decide whether the admin queue will let an order be
approved. Both are deliberate stops, not formalities.

`SCHEDULE_MAINTENANCE_ENABLED` must stay `false` on any deployment that runs
commercial orders. Unset means enabled, so the safe state is the explicit one.
While recurring maintenance is on, a commercial order cannot be approved: the
background scheduler and an order-scoped dispatch would both drive provider
calls for the same work, which doubles spend and breaks cardinality.

`SELENA_PROVIDER_BUDGET_USD` is the ceiling for a single order's worst-case
cost, not a wallet balance — no provider balance is ever read. Its job is to
catch a scope typo before the first paid call: an order that suddenly costs ten
times the usual amount cannot be approved. A starting value of `25` leaves
roughly a fourfold margin over the current per-order estimates while still
stopping an order-of-magnitude mistake. Re-tune it against the first real
provider invoice.

Neither variable replaces a hard spend limit configured in the provider
accounts themselves. Set those too: they are the only guard that survives a
failure outside this application.

## Before accepting a paid order

- Set package prices in the admin pricing configuration.
- Until real prices and payment activation are supplied, keep checkout in
  `REQUEST_QUOTE` or payment test mode.
- Payment endpoints refuse to record a payment until `SELENA_PAYMENTS_ENABLED`
  is explicitly set to `true`; a recorded test payment moves the order to
  `PAID_REVIEW_REQUIRED`, never directly to `APPROVED`.
- Confirm brand, domain, region, languages, scenarios and expected cardinality.
- Review the configuration lock, quote expiry, budget and provider status.

## During a cycle

Approve the order only after payment verification and the budget/cardinality
preflight. Use one dispatch mechanism at a time. Monitor the emergency stop,
budget thresholds, duplicate dispatch, provider errors and stuck jobs.

## Results

Dashboard, PDF, XLSX and CSV are generated from the same canonical run and
dataset version. Automated findings are marked `AUTOMATED — NOT EXPERT
VERIFIED`; do not present them as ranking, mention or revenue guarantees.

## Current owner gate

Production PostgreSQL plus recoverable backup/PITR must exist before production
boot or rollback can be verified. No DNS, paid infrastructure, live provider
calls or real payment calls are performed by the current release process.

