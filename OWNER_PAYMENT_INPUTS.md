# Owner payment inputs

The current product uses a test-mode payment fixture only. No Stripe Checkout
session, live webhook, real charge or recurring billing is enabled.

Before production payment activation, provide this single set of inputs:

- Legal entity name and country of registration
- Stripe account and confirmed account ownership
- Settlement currency
- Package names and final prices for Snapshot, Evidence Audit, Full Landscape and Expert Verified
- Tax model and tax registration requirements
- Refund and cancellation policy
- Terms of Service, Privacy Policy and seller disclosures
- Production domain
- Support and billing email

The owner must explicitly say `PAYMENTS GO` before live payment mode is enabled.
Until then `SELENA_PAYMENTS_ENABLED` remains false and `SELENA_PAYMENT_MODE`
remains `test`.
