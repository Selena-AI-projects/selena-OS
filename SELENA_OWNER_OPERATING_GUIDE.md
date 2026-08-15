# Selena AI Visibility — owner operating guide

## Before accepting a paid order

- Set package prices in the admin pricing configuration.
- Until real prices and payment activation are supplied, keep checkout in
  `REQUEST_QUOTE` or payment test mode.
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

