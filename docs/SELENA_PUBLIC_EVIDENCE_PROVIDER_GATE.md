# Selena Public Evidence Provider Gate

Status: Bright Data is the only approved public-evidence provider for the current MVP. Network calls and paid requests remain disabled until a controlled smoke test.

## Recommended stack

| Surface | MVP activation path | Cost gate | Key restriction |
|---|---|---|---|
| Public Search | Bright Data SERP API | Current published pay-as-you-go price is $1.50/1,000 successful requests; 5,000-request free tier is advertised. Confirm quote before activation. | Provider contract, query budget, retention and jurisdiction review required. |

The Website Collector remains part of the core MVP and needs no external provider. Maps, connected reviews and social accounts are not MVP activation dependencies. Their provider-neutral fixture contracts may remain for future owner-approved modules, but no live client or credential is required by the current product.

The implementation boundary is provider-neutral: Bright Data returns an immutable source snapshot and normalized `EvidenceItem[]`; the Recommendation Engine consumes only that contract. Fixture adapters never perform a provider call.

## ToS and safety gates

- No direct scraping of Google Search, Maps, review pages, or social pages from Selena.
- No activation without owner approval of provider, contract/terms, monthly spend cap, retention period, regions, and attribution requirements.
- Public evidence is observational only. It must not be represented as reach, conversion, ranking guarantee, sentiment certainty, or ownership.
- Connected review and social evidence remains `MANUAL_ONLY` or fixture-only until a separate owner-approved integration is selected.
- Every activated adapter must preserve provider request metadata, source URL/ID, captured timestamp, content hash, limitations, and an auditable provider-call counter.

## Activation checklist

1. Owner approves Bright Data and the legal/ToS review.
2. Owner supplies the scoped Bright Data credential through the encrypted admin workflow; never through fixtures, tests, logs, or this repository.
3. Owner approves a monthly request budget and per-run rate limit.
4. Engineering verifies the existing provider client with live-call tests mocked at the HTTP boundary and one separately authorized smoke request.
5. Compliance/owner confirms retention, deletion, attribution, and regional handling before enabling the feature flag.

## Official references

- Bright Data SERP API pricing: <https://brightdata.com/pricing/serp>
- Bright Data SERP API documentation: <https://docs.brightdata.com/scraping-automation/serp-api/introduction>
