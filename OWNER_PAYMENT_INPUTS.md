# Owner payment inputs

The current product uses a test-mode payment fixture only. No provider-specific
checkout session, live webhook, real charge or recurring billing is enabled.

Before production payment activation, provide this single set of inputs:

- Temporary approved seller legal entity: `PT Izi Jiza Bali`
- Official legal entity name and country of registration/KYC confirmation
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
USD. `PT Izi Jiza Bali` is temporary seller metadata pending payment-provider
KYC and does not by itself authorize live payments.
