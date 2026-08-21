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

## Turning measurement on

Execution ships inert and stays inert until two separate decisions are made.

`SELENA_MEASUREMENT_ENABLED=false` is the safe state, and unset means off. While
it is not exactly `true`, the measurement worker records nothing, reads nothing
and calls no adapter — a permit that is queued by mistake is simply dropped.

`SELENA_MEASUREMENT_ADAPTER=noop` selects which adapter executes a permit. Only
adapters that hold no credentials and perform no provider call — `noop`,
`stub` — can be selected this way. Naming a live provider adapter is refused
even after it is registered in the worker: turning on real spend is a code
change the owner makes deliberately, alongside supplying credentials, and can
never be the side effect of setting one variable. Until then the noop adapter
records every run as `INVALID`, so an accidental run cannot produce something
that reads like a real measurement.

`SELENA_EMERGENCY_STOP=true` blocks execution at the point a provider would be
contacted, including for runs that are already claimed.

Measurement jobs are never scheduled. A run starts from an explicit action on a
specific permit, and a claimed permit is spent: it cannot be retried into a
second provider call.

### Rehearsing a cycle without spending anything

`pnpm -C packages/lib rehearse:selena-stub-cycle` runs a whole cycle against a
local Postgres with no provider behind it: it seeds a project, plans permits the
way an approved order does, executes every one of them, and then checks that the
runs, the mention rows and the cost-ledger rows landed together before printing
the §12 metrics computed over them. It deletes everything it created.

Nothing it writes can be mistaken for a measurement — the model is `stub`, every
charge is zero, and the answers are synthesized from the permit itself. Run it
after any change to extraction, storage or the metrics, and read the numbers as
a proof that the chain is wired, never as evidence about a brand.

The stub adapter is deliberately registered nowhere, so
`SELENA_MEASUREMENT_ADAPTER=stub` in a deployment fails with
`SELENA_ADAPTER_NOT_REGISTERED`: a rehearsal is something you run on purpose
against a scratch database, not a state a live system can drift into.

### Wiring the OpenRouter adapter for API View

The API View measurement adapter is written and tested, but it is registered
nowhere and cannot be selected — turning it on is these five steps, in this
order, and none of them is an environment variable on its own.

1. **Put a hard spend cap on the OpenRouter account itself.** It is the only
   limit that still holds if this application misbehaves.
2. **Supply credentials to the worker**: `OPENROUTER_API_KEY`, plus the model
   the run is sold as — use one of the catalog's API View model ids
   (`apiModelIds` in the contracts package), because a run measures the model
   the customer bought.
3. **Give the adapter its two per-permit reads.** A permit carries ids, not the
   question and not the brand, and the adapter holds no database access on
   purpose. `createSelenaMeasurementResolvers(db)` in
   `packages/lib/src/selena-extraction-context.ts` returns both:
   `resolveScenarioText` and `resolveExtractionContext`. Without the second one
   the run is still stored and still billed, but with no mention, position or
   citation extracted from it — the answer reference is kept, so extraction can
   be re-run later, but no ledger metric moves until it is passed in.
4. **Register the adapter** in `apps/worker/src/jobs/selena-measure.ts`:

   ```ts
   import { createOpenRouterAdapter } from "@workspace/lib/adapters/openrouter";
   import { createSelenaMeasurementResolvers } from "@workspace/lib/selena-extraction-context";

   const resolvers = createSelenaMeasurementResolvers(db);

   const ADAPTERS: MeasurementAdapterRegistry = {
     noop: createNoopMeasurementAdapter(),
     openrouter: createOpenRouterAdapter({
       apiKey: process.env.OPENROUTER_API_KEY ?? "",
       model: "anthropic/claude-haiku-4.5",
       fetchImpl: fetch,
       system: "chatgpt_api",
       resolveScenarioText: resolvers.resolveScenarioText,
       resolveExtractionContext: resolvers.resolveExtractionContext,
     }),
   };
   ```

   `system` must be the sold system id the permits were planned with. Evidence
   attributed to any other system is dropped from the ledger rather than stored
   under a name the customer did not buy.

5. **Widen the allowlist**, which is the actual owner gate:
   `assertAdapterAllowed` in
   `packages/selena-visibility-contracts/src/measurement-execution.ts` accepts
   only names listed in `inertMeasurementAdapters`, so `openrouter` has to be
   added there — and the list renamed to what it has then become, an
   owner-approved list rather than an inert one — together with the test that
   pins the gate shut. Registering the adapter without this edit changes
   nothing: the run is refused with `SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO`.

Only after all five does `SELENA_MEASUREMENT_ADAPTER=openrouter` with
`SELENA_MEASUREMENT_ENABLED=true` start spending.

What the adapter does and does not do, so the first invoice holds no surprises:

- One permit is one request. Requests are sent at `temperature: 0`, because two
  runs of the same scenario have to differ for reasons that are about the AI
  answer, not about sampling.
- Web search is never enabled and no search plugin is sent: API View is the
  model's own knowledge, which is what the catalog sells it as.
- The run row stores a reference to the answer — OpenRouter's generation id, or
  a digest when the response carries none — not the answer itself.
- `costUsd` is the cost OpenRouter reported for that call when it reports one,
  and the coarse local per-run estimate otherwise; `costBasis` says which of the
  two it was. Neither is a billed fact — reconcile against the provider invoice.
- A provider HTTP error is recorded as `PROVIDER_HTTP_<code>` and a transport
  failure as `TRANSPORT_ERROR`, with nothing quoted from the provider: error
  bodies and request errors can echo the API key back, and run rows are read by
  more people than hold the credential.

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

