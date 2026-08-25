# Owner payment inputs

The current product uses a test-mode payment fixture only. No provider-specific
checkout session, live webhook, real charge or recurring billing is enabled.

Before production payment activation, provide this single set of inputs:

- Approved seller legal entity: `Selena Systems LLC`, United States. Settled by
  the owner on 2026-08-25 and now the single seller named by the site, the
  offer and the structured data.
- KYC confirmation for that entity with the chosen payment provider
- Registered address, NIB and NPWP (owner input; not supplied by this change)
- Settlement bank account and banking details (owner input; not supplied by this change)
- Chosen payment provider and confirmed account ownership
- Settlement currency
- Final confirmation of the four Selena catalog packages: Visitor Local ($49/month), Full AI Landscape ($79/month), Expert Verified ($399 one-time), Growth 90 Days ($2,490; manual approval/contact sales)
- Tax model and tax registration requirements
- Refund and cancellation policy
- Terms of Service, Privacy Policy and seller disclosures
- Production domain
- Support and billing email
- Growth 90-day measurement cycle count, scenario count, languages, systems, repeats, labor cap, provider cost cap and minimum margin
- Production PostgreSQL, backup/PITR retention and restore-test evidence
- Production DNS/domain

The owner must explicitly say `PAYMENTS GO` before live payment mode is enabled.
Until then `SELENA_PAYMENTS_ENABLED` remains false and `SELENA_PAYMENT_MODE`
remains `test`; Growth self-service checkout remains blocked. Prices remain in
USD.

## Why the cabinet takes a request instead of a payment

This is the reason, and the only one. With no checkout there is nothing for a
client to pay, so the plan card leads to a form that records what they want and
whether a promo code covers it. The measurement itself then starts from the
admin desk.

It is not the intended shape. A client choosing Landscape should pay and get
the measurement, and every step after the payment already exists: an order
mints permits, permits reach the worker, the worker runs them. What is missing
between the two is a real checkout session and a webhook that marks the order
paid — and the manual-approval gate that stands in for it today.
