# YouTube Pro — transferred source record

Required by Apache-2.0 sections 4(a), 4(b) and 4(c): the licence travels with the
code, the modifications are stated, and the attribution is retained.

```text
Repository: https://github.com/parkourcafe/youtube-pro
Commit:     63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25
Licence:    Apache-2.0 (declared in package.json and README.md; LICENSE at the repository root)
NOTICE:     none at this commit
```

## Attribution retained

The upstream `LICENSE` is reproduced verbatim beside this file. Its SHA-256 is
`b40930bbcf80744c86c46a12bc9da056641d722716c378f5659b9e555ef833e1`, which is the
digest of the file at the commit above.

The upstream repository carries **no `NOTICE` file** at that commit —
`git ls-tree -r --name-only 63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25` matches
nothing case-insensitively named `NOTICE`. Section 4(d) applies only "if the Work
includes a NOTICE text file", so the conditional obligation does not arise. It
would arise again for any later commit that adds one.

No transferred file carried a per-file copyright header
(`grep -rl Copyright --include=*.ts --include=*.tsx` over the source tree returns
nothing), so there are no per-file notices to preserve. Attribution is carried by
this record and by a header comment naming the repository and commit in each
destination file.

Nothing here is relicensed. The transferred material remains under Apache-2.0;
this package's own `license` field describes the code this repository wrote.

## What was transferred

| Upstream path | Destination |
|---|---|
| `shared/evidence-contracts.ts` | `src/creation/contracts.ts` |
| `shared/schema.ts` (format, audience and provider-error vocabularies only) | `src/creation/contracts.ts` |
| `server/script-regeneration-contract.ts` | `src/creation/contracts.ts` |
| idea and script generation flow from `server/gemini.ts` (shape only) | `src/creation/index.ts` |
| the script/idea output shape consumed by `client/src/pages/script.tsx` | `src/content-document/index.ts` |

## Modifications to each transferred file

**`shared/evidence-contracts.ts` → `src/creation/contracts.ts`**

- Persisted vocabularies are uppercase (`observed` → `OBSERVED`, `low` → `LOW`,
  and the discovery, format, audience and difficulty enums likewise), matching the
  registry enums every other Stage 1 module writes.
- `snapshotId` becomes `researchRunId`, a UUID naming the Slice 2 research run.
  Upstream's snapshot was a local research artefact with no owner; here the run is
  already immutable and brand-scoped, so it is the identity a claim binds to.
- `sourceVideoIds` becomes `sourceExternalIds`, matching
  `selena_registry.content_research_sources.external_id`.
- `researchEvidenceContextSchema` gains `opportunityKey`, because generation
  starts from a decided opportunity here rather than from a free-text query.
- `ideaGenerationRequestSchema` is not transferred: its `niche`, `keywords` and
  `audience` free-text fields are replaced by the brand's confirmed profile, which
  is the point of the profile existing.
- `validateEvidenceSourceIds` becomes `assertEvidenceSourcesInRun` and throws a
  typed `ContentCreationError` instead of a bare `Error`, so a caller records a
  normalized code rather than a message.
- Zod 3 idioms are updated for Zod 4 (`z.ZodIssueCode.custom` → `"custom"`).

**`shared/schema.ts` → `src/creation/contracts.ts`**

- Only the format, audience and provider-error vocabularies are transferred, as
  string-union schemas rather than TypeScript enums.
- **`CreatorPersona` is deliberately not transferred.** It enumerates real named
  people as tone targets. Imitating an identifiable person is outside what this
  product does, and the enum has no equivalent here.
- `scriptInputSchema`, `scriptResultSchema` and the research/video schemas are not
  transferred; Slice 2 already carries the research vocabulary.

**`server/script-regeneration-contract.ts` → `src/creation/contracts.ts`**

- `scriptRegenerationOutputSchema` and its uniqueness rule are transferred as-is.
- `parseScriptRegenerationOutput` is split: JSON decoding is the caller's, and the
  claim-membership rule becomes `assertCitedClaimsKnown`, which also checks the
  idea package's claims. Upstream checked only the context's.
- The section and paragraph request schemas are not transferred; Stage 1 revises a
  script by writing a new immutable version, not by patching a section in place.

**`server/provider-errors.ts`**

- The error *taxonomy* informs `CREATION_ERROR_CODES`; the module itself is not
  transferred. `normalizeProviderError` classifies by substring-matching a
  provider's message, which is the opposite of what Stage 1 wants: a provider
  string must not reach a surface at all. `providerErrorPayload` is UI copy
  instructing the reader to add an API key in Settings, a page that does not exist
  here.

**Idea and script generation flow from `server/gemini.ts`**

- The prompt assembly, model selection, HTTP client and retry logic are **not**
  transferred. What is transferred is the order of operations and the validation
  the output had to pass.
- Generation runs against a brand's confirmed profile version and one decided
  research opportunity. Upstream had no tenant, no profile and no run.
- Evidence membership is enforced against the research run's own sources rather
  than against a request-supplied list.
- Anti-copy is applied to generated idea titles, reusing Slice 2's rule.
- The clock is an argument rather than `Date.now()`, so a generation is
  reproducible.
- Adapters are injected. This package cannot open a socket.

## Not transferred, and why

Express routes, Wouter pages, the settings and API-key persistence layer, the
`localStorage` workflow state in `shared/workflow-history.ts`, the retired
auth/database code, the React 18 UI, `server/youtube.ts`, `server/gemini.ts`,
`server/rate-limit.ts` and the teleprompter. The plan places the teleprompter
outside Stage 1; the rest are either architecture this repository already has or
things upstream's own `PORTING.md` records as retired.
