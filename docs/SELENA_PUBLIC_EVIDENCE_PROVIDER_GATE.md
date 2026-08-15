# Selena Public Evidence Provider Gate

Status: design and fixture adapters only. No provider credentials, network calls, or paid requests are enabled.

## Recommended stack

| Surface | Recommended activation path | Cost gate | Key restriction |
|---|---|---|---|
| Public Search | Bright Data SERP API | Current published pay-as-you-go price is $1.50/1,000 successful requests; 5,000-request free tier is advertised. Confirm quote before activation. | Provider contract, query budget, retention and jurisdiction review required. |
| Maps | Google Maps Platform Places API (New) | Pay-as-you-go by SKU; exact cost depends on requested fields and volume. | Mandatory field masks; use minimum fields and preserve attribution/policy controls. |
| Reviews | Google Places API (New) for public place details, or Google Business Profile Reviews API only for an authorized/verified location | Places: SKU-based pay-as-you-go. GBP: access approval and quota; price UNKNOWN until Google Cloud billing is configured. | GBP is not a general public-review API: access is limited to locations the caller owns/manages; storage limits apply. |
| Social | Official Meta/Instagram Graph API for connected, authorized professional accounts | Price UNKNOWN; Meta access/app review and product terms apply. | Not a general arbitrary-public-profile collector. Keep public social adapter disabled unless an owner-approved compliant source is selected. |

The implementation boundary is provider-neutral: a provider returns an immutable source snapshot and normalized `EvidenceItem[]`; the Recommendation Engine consumes only that contract. The repository currently ships fixture adapters for all four surfaces and never performs a provider call.

## ToS and safety gates

- No scraping of Google Search, Maps, review pages, or social pages directly from Selena.
- No activation without owner approval of provider, contract/terms, monthly spend cap, retention period, regions, and attribution requirements.
- Public evidence is observational only. It must not be represented as reach, conversion, ranking guarantee, sentiment certainty, or ownership.
- Google Business Profile data requires an authorized relationship with the business/location and has temporary storage and use restrictions; it cannot be treated as a general public-data feed.
- Google Places requests must use explicit field masks. Reviews are a higher-priced field tier, so the adapter must request them only when the run explicitly includes reviews.
- Social evidence remains `MANUAL_ONLY` until a compliant official API path and account authorization exist.
- Every activated adapter must preserve provider request metadata, source URL/ID, captured timestamp, content hash, limitations, and an auditable provider-call counter.

## Activation checklist

1. Owner selects providers and approves the legal/ToS review.
2. Owner supplies disposable, scoped credentials through the production secret manager; never through fixtures, tests, logs, or this repository.
3. Owner approves a monthly request budget and per-run rate limit.
4. Engineering adds the provider-specific implementation behind the existing adapter contract, with live-call tests mocked at the HTTP boundary.
5. Compliance/owner confirms retention, deletion, attribution, and regional handling before enabling the feature flag.

## Official references

- Google Places fields and SKU tiers: <https://developers.google.com/maps/documentation/places/web-service/data-fields>
- Google Places field masks: <https://developers.google.com/maps/documentation/places/web-service/choose-fields>
- Google Places usage and billing: <https://developers.google.com/maps/documentation/places/web-service/usage-and-billing>
- Google Business Profile policies: <https://developers.google.com/my-business/content/policies>
- Google Business Profile review data: <https://developers.google.com/my-business/content/review-data>
- Bright Data SERP API pricing: <https://brightdata.com/pricing/serp>
- Bright Data SERP API documentation: <https://docs.brightdata.com/scraping-automation/serp-api/introduction>
