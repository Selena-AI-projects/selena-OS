---
"@workspace/lib": patch
---

Add the Slice 3.1 durable provider budget ledger: migration 0044's
owner-set, append-only `provider_budgets` and the `provider_call_ledger`
written only through the `reserve_provider_call` / `settle_provider_call`
definer functions. A non-fixture creation or research run now reserves
against the budget before its adapter may run — no budget row, no cost
estimate, or an exhausted window fails the run with a normalized code
(`PROVIDER_BUDGET_MISSING`, `UNKNOWN_COST_BLOCKED`,
`PROVIDER_QUOTA_EXCEEDED`) — and settles the reservation SETTLED or
FAILED when the adapter finishes. Cost estimates come from fixed
per-provider constants until real pricing lands. The fixture path
touches neither table, so Stage 1's externalProviderCalls=0 evidence is
unchanged.
