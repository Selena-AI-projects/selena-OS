# Wiring the Bright Data adapter for Visitor View

This note covers one adapter: `packages/lib/src/adapters/brightdata-measurement-adapter.ts`.
It is written and tested, registered nowhere, and cannot be selected. Keep it in
this state until the two open questions at the bottom are answered against a
real Bright Data response.

It is a companion to "Turning measurement on" in `SELENA_OWNER_OPERATING_GUIDE.md`;
nothing here replaces the gates described there.

## What Visitor View means here

Visitor View is the answer a person is shown by ChatGPT, Gemini or Perplexity —
a search-backed surface. API View is the model queried directly, with no search.
Selling one as the other is the failure this adapter is shaped to avoid, so it
accepts only `visitor_view` permits and only the three surfaces the catalog
sells (`visitorSurfaces`).

## Enabling it (five steps, in this order)

1. **Put a hard spend cap on the Bright Data account itself**, per zone. It is
   the only limit that still holds if this application misbehaves.
2. **Supply credentials and routing to the worker**: the API token, the endpoint
   URL (HTTPS — the adapter refuses plaintext, because the token travels in a
   header), the zone the call is billed to, and one surface per adapter
   instance. One instance measures one surface.
3. **Give the adapter a way to read the scenario text.** A permit carries a
   scenario id, not the question, and the adapter holds no database access on
   purpose — pass a tenant-scoped reader as `resolveScenarioText`.
4. **Register the adapter** in `apps/worker/src/jobs/selena-measure.ts`:

   ```ts
   import { createBrightDataAdapter } from "@workspace/lib/adapters/brightdata";

   const ADAPTERS: MeasurementAdapterRegistry = {
     noop: createNoopMeasurementAdapter(),
     brightdata: createBrightDataAdapter({
       apiKey: process.env.BRIGHTDATA_API_TOKEN ?? "",
       endpoint: process.env.SELENA_BRIGHTDATA_ENDPOINT ?? "",
       zone: process.env.SELENA_BRIGHTDATA_ZONE ?? "",
       system: "chatgpt",
       fetchImpl: fetch,
       resolveScenarioText: (permit) => scenarioTextFor(ctx, permit.scenarioId),
     }),
   };
   ```

5. **Widen the allowlist**, which is the actual owner gate: `assertAdapterAllowed`
   in `packages/selena-visibility-contracts/src/measurement-execution.ts` accepts
   only names listed in `inertMeasurementAdapters`, so `brightdata` has to be
   added there — together with the test that pins the gate shut. Registering the
   adapter without this edit changes nothing: the run is refused with
   `SELENA_LIVE_ADAPTER_REQUIRES_OWNER_GO`.

Only after all five does `SELENA_MEASUREMENT_ADAPTER=brightdata` with
`SELENA_MEASUREMENT_ENABLED=true` start spending.

## What the adapter does and does not do

- One permit is one POST. There is no retry and no polling loop inside it.
- The request carries the zone, the surface and the scenario question. The token
  is sent in the `Authorization` header and appears nowhere else — not in the
  body, the URL, an outcome, or an error string.
- The timeout never outlives the permit: the authorization window is the ceiling,
  so a call cannot return an answer nothing is allowed to record any more.
- The run row stores a reference to the answer — Bright Data's own request id
  when the payload names one, otherwise `brightdata:sha256:<digest>` — never the
  answer text.
- `costUsd` is what the provider reported when it reports a number, and the
  coarse local per-run estimate otherwise. The stored number does not say which
  it was; reconcile against the invoice rather than reading it as billed fact.
- Failure mapping: `EMPTY_RESPONSE`, `MALFORMED_RESPONSE`, `RESPONSE_TOO_LARGE`
  and `TIMEOUT` are INVALID; `PROVIDER_HTTP_<code>`, `TRANSPORT_ERROR` and
  `SCENARIO_TEXT_UNAVAILABLE` are FAILED. Nothing is quoted from the provider —
  error bodies can echo the token back, and run rows are read by more people
  than hold the credential.
- An unrecognized payload is `MALFORMED_RESPONSE`. It is never stringified into
  an "answer", and it is never reported as an empty answer: a shape nobody has
  read is not a measurement of a surface that said nothing.
- **Citations are parsed but not stored.** `parseBrightDataAnswer` returns the
  sources the payload actually showed — only real http(s) links present in the
  payload, deduplicated, never inferred from the answer text. `runOutcomeSchema`
  is a strict object with no citation field, and an adapter must not widen a
  stored contract, so a citation layer has to persist them itself (call the
  exported parser, or inject your own). Until that layer exists, Visitor View
  runs record the answer reference and the cost, not the source list.

## What must be confirmed on a real response before the first paid run

The request body and the response field names are a **hypothesis**, taken from
the field names this repository's existing collector reads
(`packages/lib/src/providers/registry/brightdata.ts`), which were observed on the
`datasets/v3` flow — not on the endpoint this adapter posts to. Both directions
are injectable so the answers below can be pinned without editing the adapter:
pass `buildRequestBody` and `parseAnswer`.

Capture one real response per surface and confirm:

1. **Endpoint and flow.** Is there an endpoint that returns the visitor answer in
   one synchronous POST? The known chat-surface flow in this repository is
   asynchronous — trigger a snapshot, poll `datasets/v3/progress`, then fetch the
   snapshot. If that is the only flow available, this adapter's single-request
   shape is not sufficient on its own and needs a polling variant; the permit
   deadline then has to cover the whole snapshot wait.
2. **Request body field names**: `zone`, `system`, `prompt`, `web_search`,
   `format` are the adapter's defaults. The real names may differ (`dataset_id`,
   `url`, `query`, `country`, …), and the surface may be selected by dataset id
   rather than by name.
3. **Answer field**: the default reads the first non-empty string among
   `answer_text_markdown`, `answer_text`, `answer`, `response_text`, `text`,
   `content`.
4. **Whether the body is JSON at all**, and whether a single answer arrives as an
   object or as a one-element array.
5. **Sources field**: the default reads `citations`, `links_attached`, `sources`.
   Confirm the surface actually displays them, because a citation is evidence
   that the answer showed a source.
6. **Request id field**: the default reads `snapshot_id`, `request_id`,
   `response_id`, `id`. This is what makes a run auditable on Bright Data's side.
7. **Cost field**: the default reads a numeric `cost`. If Bright Data reports
   cost out of band only, every run stores the local estimate.
8. **Response size**: the default cap is 1 MiB. A visitor payload that carries the
   rendered page would exceed it and be recorded as `RESPONSE_TOO_LARGE`.

Until 1–8 are answered from a real response, treat any Visitor View number this
adapter would produce as unverified.
