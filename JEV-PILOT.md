# Jev pilot — isolated mention-classification check (corrected pass)

Report generated: **2026-09-21 10:03:06 +05 (Asia/Tashkent)**
Verified commit: `e723e364` (the pilot commit already on `claude/selena-typesafe-integration-y98vbj`, on top of base `b437efc1`) — this pass adds a further **uncommitted** working-tree diff on top of `e723e364`, described below. The existing commit is preserved, not rewritten.
Node.js: `v24.21.0` (matches `package.json`'s `engines: {"node": "24.x"}`; the previous pass ran on a mismatched Node 22 by mistake — corrected this pass, see ЭТАП 5)
pnpm: `11.18.0` (matches the repo's pinned `packageManager`)
`@typesafe-ai/sdk`: `0.6.0`, exact-pinned
Jev model version: **NOT_MEASURED** — no real `systemOne` call has been made, so no `result.model` value has ever been observed. The SDK's documented default is the name `jev-latest`, not a pinned version.
Question template version: v0, one iteration, not calibrated against real data.
Data composition: 7 hand-written synthetic cases (`apps/worker/src/pilots/jev-mentions/fixtures.ts`), 0 real labeled examples.

**INDEPENDENT_REVIEW = NOT_PERFORMED.** Everything below is my own testing and self-review.

This report supersedes the version from the previous pass. Section by section below, it corrects: the pilot's stated goal (§1), the meaning of the metric being tested and one mislabeled test case (§ metric semantics, folded into ЭТАП 1/4), which of the two `analyzeMentions` copies is the baseline and proof it's reproduced correctly (§ baseline, in ЭТАП 1/3), whether this repository's code path is confirmed to run in production (new, ЭТАП applicability), the Node version tests ran on, an overclaim about prompt-injection robustness, and the pricing figures (ЭТАП 5).

---

## What this is, and what it is not

An isolated, disabled-by-default check of whether TypeSafe's Jev model (a "System One" model that returns typed judgments with probabilities, not free text) could improve **entity attribution** in the existing substring-match brand/competitor mention detector, and what that improvement would cost.

**Corrected goal (point 1).** `analyzeMentions` does not call an LLM today — it is pure string matching. This pilot is therefore **not** a token/cost-saving swap for an existing model call; there is no existing model call on this code path to save tokens on. The only two questions this candidate can honestly answer are:
1. Does Jev improve **entity attribution** (does the mention refer to the tracked brand/competitor, not a same-name unrelated entity) over substring matching?
2. What does that improvement cost, per call and at the product's real volume?

Any framing of this pilot as "saves tokens on the main model" would be wrong and is explicitly retracted. Where economy doesn't apply, the report says **NOT_APPLICABLE** with the reason, not a savings projection.

Nothing in the main pipeline was changed. The pilot code lives entirely under `apps/worker/src/pilots/jev-mentions/` and is never imported by `apps/worker/src/jobs/process-prompt.ts` or `apps/worker/src/report-worker.ts`.

## ЭТАП 1 — candidate, and what the metric actually means

**Candidate A (chosen): entity attribution inside repeating mention classification.**
- `apps/worker/src/jobs/process-prompt.ts:214-242` (`analyzeMentions`) decides whether the tracked brand and each tracked competitor is mentioned in an AI-engine answer via `contentLower.includes(...)` — pure substring matching.
- This result is written to `promptRuns.brandMentioned` / `promptRuns.competitorsMentioned` and feeds every downstream visibility/share-of-voice computation in `packages/lib/src/report-metrics.ts` and the report UI.
- No test file covers `analyzeMentions` in either location.
- Frequency, from the code itself: `RUNS_PER_PROMPT_FALLBACK = 5` runs per target every `DEFAULT_DELAY_HOURS_FALLBACK = 24` hours (`packages/lib/src/constants.ts`); report generation runs 84 candidate prompts in batches of 20 (`report-worker.ts:23-26,344`).

**Candidate B: model selection by task type — not found**, as before; not restated here to avoid stretching a non-match.

### Metric semantics (point 2) — three layers, only two of which exist in this product

I checked `packages/lib/src/db/schema.ts`, `packages/lib/src/report-metrics.ts`, and every consumer of `brandMentioned`/`competitorsMentioned` (grep across `apps/worker`, `apps/web`, `packages/lib`). There is **no sentiment, endorsement, or relevance field anywhere** in the schema or downstream code — only the two booleans/array, used purely for mention-rate and co-mention counting.

That means the concept `brandMentioned` actually encodes is:

1. **Name/domain presence** — the literal string match `analyzeMentions` performs.
2. **Correct-entity attribution** — does the string match actually refer to *the tracked brand*, not a same-word different real-world entity? Not measured by presence alone.
3. **Recommendation/attitude toward the brand** — does not exist in this product at all, has no schema field, and no consumer expects it.

This pilot targets layer 2 only. Extending it to layer 3 would mean building a separate sentiment-analysis feature, which is explicitly out of scope and not attempted.

**Correction to the previous pass's test case.** The case `"This isn't about Profound at all — just general AEO advice..."` was previously reported as a heuristic false positive. That was wrong: under the metric's real definition (topical presence of the correctly-attributed entity, not sentiment), Profound *is* correctly referenced — the topic surfaced, even to be dismissed. The heuristic's `true` here matches the product's actual definition. I did not re-label this case to flatter Jev; I re-labeled it because my earlier characterization of "mention" silently smuggled in a sentiment reading the product doesn't have. See `fixtures.ts`'s `referenceRationale` field for the same argument in the source.

The only case that survives as a genuine entity-attribution error: `"Elmo from Sesame Street is a popular children's character."` — a different real-world entity sharing the brand's name. `results.csv`'s `heuristic_matches_reference` column shows this precisely: **6 of 7 synthetic cases match the corrected reference label; 1 does not** (the Sesame Street case).

## Baseline (point 3) — one canonical implementation, proven, not merged

There are two `analyzeMentions` copies, and they are **not** identical (correcting the previous pass's claim that they were):

| | `process-prompt.ts:214-242` (chosen baseline) | `report-worker.ts:174-209` |
|---|---|---|
| Signature | `(content, brand: Brand, competitorsList: Competitor[])` | `(content, brandName: string, brandWebsite: string, competitors: CompetitorResult[])` |
| Aliases | Yes — `brand.aliases`, `competitor.aliases` | **No alias support at all** |
| Competitor domains | `competitor.domains` (array) | `competitor.domain` (singular, different shape) |
| Malformed URL | Caught (`extractDomainFromUrl` has a `try/catch`) | Uncaught — would throw |

**Chosen baseline: `process-prompt.ts`'s version**, because (a) it's the one driving the recurring 24h tracking job, not just report generation, and (b) it supports aliases, which matters for a fair comparison since Jev's questions are also given aliases. I did not merge the two or silently improve either one.

**Proof the pilot's copy reproduces it**, not just an assertion: `classifier.test.ts` now has a test that reads `process-prompt.ts`'s live source at test time (not a copy pasted once) and asserts the pilot's `heuristicMentions` body matches it, whitespace-normalized. If `process-prompt.ts`'s `analyzeMentions` is ever edited, this test breaks instead of silently drifting. This is the only automatic way to make the equivalence claim checkable, since the original function is not exported for direct import.

## Applicability to the real product (point 4) — NOT fully confirmed

Chain, as far as it's confirmed inside this repository:

`analyzeMentions()` → pg-boss job `process-prompt` → app `@workspace/worker` (`apps/worker`) → repo `Selena-AI-projects/selena-OS`, branch `claude/selena-typesafe-integration-y98vbj`, base commit `b437efc1`.

**What is not confirmed: whether this repository's worker is the one actually serving production traffic.** `docs/execution/SNAPSHOT.md` in this same repository states that `selena-OS` and a separate repository, `parkourcafe/selena-ai-visibility`, are **independent forks of the same upstream** (`elmohq/elmo`) — 0 shared commits, identical migrations only through `0020`, diverging from `0021` onward. The same document states the live product domains (`app.selenasystems.com`, `staging.selenasystems.com`) are served from `selena-ai-visibility`'s Railway **staging** environment, and explicitly flags an earlier assumption that they pointed to `selena-OS` production as **wrong**.

I have not checked whether `selena-ai-visibility` even has an `analyzeMentions` function, let alone whether it matches this one — `parkourcafe/selena-ai-visibility` is a different repository under a different GitHub org than the one this session is authorized for, so I did not clone it, read it, or connect to its database. Per the instructions for this pass, repeating the request to work on this pilot is not treated as authorization to switch repositories, and none was requested.

**Honest statement: runtime confirmation is NOT_CONFIRMED.** Everything in ЭТАП 1-3 is real and verified *for the `selena-OS` repository as checked out in this sandbox*. Whether that is the code path real users' AI-visibility data flows through today is an open question this pilot cannot answer without access to `selena-ai-visibility`.

## ЭТАП 3 — isolated implementation (unchanged in design, re-verified)

All in `apps/worker/src/pilots/jev-mentions/`, still never imported by the main pipeline:
- `classifier.ts` — one **Noul** question per entity (brand + each competitor) in a single `systemOne` call. Noul fits because each entity is independently "mentioned or not."
- `heuristicMentions()` — the pinned copy of `process-prompt.ts`'s baseline (see above), used as the fallback and comparison point.
- Kill switch: `JEV_PILOT_ENABLED`, off by default.
- `insufficient_data` before any network code runs, for empty text or a nameless brand.
- Fail-closed to the heuristic on any client/API error.
- Data sent: only `answer_text` + each entity's `name`/`aliases`/`domains`.

## Evidence, split into exactly what point 5 asks for

1. **Dry-run tests executed:** yes, for real. `npx vitest run src/pilots/jev-mentions/classifier.test.ts` on **Node.js v24.21.0**, pnpm `11.18.0`, commit `e723e364` + this pass's uncommitted diff:

   ```
    RUN  v4.1.10 /home/user/selena-OS/apps/worker

    Test Files  1 passed (1)
         Tests  9 passed (9)
      Duration  270ms
   ```

   `npx tsc --noEmit -p apps/worker/tsconfig.json` on the same Node/commit: **exit 0, no errors.**

   No unrelated dependency was touched to get here: `git status --short` is clean of `pnpm-lock.yaml`/`package.json` changes this pass (no new dependency was added), and pnpm's supply-chain gate was not bypassed at any point (`minimumReleaseAgeExclude` untouched, no `allowBuilds` flips).

2. **Real requests to Jev:** **zero, this pass and the last.** No `TYPESAFE_API_KEY` exists in this sandbox; `classifyMentions` returns before constructing a client whenever `dryRun` is set, and fails closed to the heuristic if a client can't be constructed at all.

3. **Request-structure verification:** done, for real, via `describeDryRunPayload()` and a test (`classifier.test.ts`, "data/instruction separation") that reads the actual constructed payload and asserts the injected adversarial text appears only in `state.answer_text`, never inside any question's `instructions`.

4. **The model's actual behavioral robustness to prompt injection: NOT tested — corrected overclaim.** The previous pass's report said the adversarial test proved the injected instruction "cannot alter model behavior." That's wrong: the test proves our *code* never routes untrusted text into the instructions channel. Whether a real Jev response would actually resist an injected instruction if it somehow reached the model is unverified and untestable without a real API call, which was not made.

## Pricing (point 6) — confirmed rate, separate from estimate, separate from actual spend

**Confirmed published rate**, from TypeSafe's own announcement (`typesafe.ai/blog/introducing-system-one-models-and-jev`, dated 2026-09-15; the domain itself is blocked by this sandbox's egress proxy, so I corroborated the figure via independent third-party coverage — MindStudio, OpenRouter, CloudPrice, NextBigFuture, Orcarouter — which agree with each other and with the figure given for this task):

> **$0.042 per million input tokens. Output tokens are free ($0/million).**

**Actual spend this session: $0** — a measured fact (zero real calls made), not an estimate.

**Illustrative cost estimate — clearly not a measurement.** Using the confirmed rate and this pilot's own request shape (one `state` block + N Noul questions, N = 1 brand + competitor count, currently 2 per call in the fixtures), a single call's input is roughly 300–800 tokens depending on answer length and competitor count — an assumption, not a measured `usage.input_tokens` value, since no real call has been made. At $0.042/million:

- Per call: ≈ $0.0000126–$0.0000336 (a few thousandths of a cent).
- At the code-derived volume from ЭТАП 1 (5 runs/target/day, or 84 prompts/report batch): on the order of **tens of cents to a few dollars per month**, for the sole purpose of the mention-classification calls — order-of-magnitude only, not a commitment, and it says nothing about whether the accuracy gain (still unmeasured) is worth even that.

This estimate is not a substitute for a real measurement; the first real call (see the proposal below) would replace the assumed token count with an actual `usage.input_tokens` figure.

## What's blocked, unchanged

**200 real examples (50 tune / 150 held-out): still BLOCKED.** No `DATABASE_URL` in this sandbox, no `.env`, and `parkourcafe/selena-ai-visibility` (the repo that may actually be in production) is out of this session's access scope regardless. Not simulated; not faked.

## Real test attempt (this pass) — BLOCKED by sandbox network policy, not by TypeSafe

A `TYPESAFE_API_KEY` was provided and the capped runner (`run-real-test.ts`, 7 calls max, stop on first real error) was executed once. Result:

```
[1/7] ordinary: direct brand mention
Stopping after a real API failure: Jev call failed, used fallback: API error 403:
403 Host not in allowlist: api.typesafe.ai. Add this host to your network egress
settings to allow access.

Calls made: 1/7
Total input tokens: 0, output tokens: 0
Measured cost: $0.000000
```

This 403 is from this sandbox's own outbound-network proxy, not from TypeSafe — the request never reached `api.typesafe.ai` (consistent with `docs.typesafe.ai` and `typesafe.ai` being blocked earlier in this pilot for the same reason). The runner's stop-on-first-failure behavior worked as designed: it made exactly 1 call, not 7, and stopped. **Actual spend: $0** (fact, not estimate — zero tokens were billed because zero requests reached the provider).

The API key was received in this session, written once to a file outside the repository (this session's scratchpad, never inside `selena-OS`), used only via `--env-file` so it never appeared in a shell command string, and deleted immediately after this single attempt. It was never printed, logged, or committed. Given it passed through chat, it should be treated as exposed — **rotate it** on TypeSafe's side independent of anything else in this report.

**This does not move the pilot past SETUP_READY.** API_VERIFIED is still not claimed: the key's validity against the real TypeSafe API remains unconfirmed, since the one request never got past this sandbox's own proxy. Fixing this needs the environment's network egress policy to allow `api.typesafe.ai` (a setting on how this Claude Code environment was created, not something changeable from inside the session) — see this session's own proxy status output, which confirms `api.typesafe.ai` is not on the current allowlist.

## Reproduce / disable

```bash
# use the pinned Node version
nvm use 24

# tests
cd apps/worker && npx vitest run src/pilots/jev-mentions/classifier.test.ts

# type-check the pilot's package
npx tsc --noEmit -p apps/worker/tsconfig.json

# dry run against the synthetic cases (run from apps/worker; move results.csv to repo root after)
pnpm --filter @workspace/worker exec tsx src/pilots/jev-mentions/run-dry-run.ts

# disable the pilot (also the default — no action needed unless JEV_PILOT_ENABLED was set)
unset JEV_PILOT_ENABLED
```

## Diff for review

The existing commit `e723e364` is untouched (not amended, not rebased). This pass's **uncommitted** working-tree diff on top of it:
- `apps/worker/src/pilots/jev-mentions/classifier.ts` — corrected baseline-choice comment (which of the two `analyzeMentions` copies, and why)
- `apps/worker/src/pilots/jev-mentions/classifier.test.ts` — added the baseline drift-detection test (reads live source, no hand-pasted copy to drift)
- `apps/worker/src/pilots/jev-mentions/fixtures.ts` — added `referenceBrand`/`referenceCompetitors`/`referenceRationale` per case; relabeled the negation case from "false positive" to "correct, not a bug," with the reasoning inline
- `apps/worker/src/pilots/jev-mentions/run-dry-run.ts` — `results.csv` now includes the reference label, a match column, and the rationale
- `apps/worker/src/pilots/jev-mentions/run-real-test.ts` — new: the capped real-call runner (7 calls max, stops on first real error)
- `results.csv` — regenerated with the corrected reference labels
- `real-test-results.csv` — one row, the blocked attempt above
- `JEV-PILOT.md` — this file

No secrets or personal data appear anywhere in this diff, this report, or any command output above — only variable *names* were ever checked, never a value; the one API key provided this pass was written to a file outside the repository, used once via `--env-file`, and deleted immediately after — it never touched this repository, this diff, or any committed file.

## Final status

**SETUP_READY, with one real attempt now made and BLOCKED** (not by TypeSafe — see above). Re-verified on the pinned Node version (24.x) with a corrected, honestly-labeled test set and a proven (not asserted) baseline.

Not claimed: **API_VERIFIED**, **BENCHMARK_VERIFIED** (both blocked, as before — see above). **NO_BENEFIT** is not asserted: the one confirmed entity-attribution gap (the Sesame Street case) is real but is a single synthetic example, not a measured error rate. Whether Jev actually closes that gap in practice, and whether the illustrative cost above is worth it, are both open questions a real call would start to answer.

## Proposed next real test (described, NOT run — needs separate authorization)

A minimal, capped API check, if and when authorized:

- **Data:** the 7 existing synthetic cases only (no production/user data, no PII) — the same set already in `fixtures.ts`.
- **Request composition:** exactly what `describeDryRunPayload()` already produces for each case — `state = { answer_text, entities: [{name, aliases, domains}] }` plus one Noul question per entity. Nothing beyond what's already shown in the dry run.
- **Call count:** at most 7 (one per synthetic case), single attempt each, no retries beyond the pilot's existing `maxRetries: 1`.
- **Cost cap:** at the confirmed rate and the token range estimated above, 7 calls cost well under $0.01; I'd still ask for an explicit dollar ceiling and a hard stop (e.g., abort after 7 calls or first non-2xx) before running it.
- **What it would answer:** real `usage.input_tokens`/`output_tokens` (replacing the estimate above with a measurement) and whether Jev's Noul probability agrees with `referenceBrand`/`referenceCompetitors` on these 7 cases — not a real accuracy benchmark (7 synthetic cases isn't one), just a first real signal and a real cost data point.
- **What it would still not answer:** real-world accuracy (needs the blocked 150-example held-out set) or prompt-injection robustness against a live model (needs a case specifically designed to try to manipulate the model's answer, which none of the current 7 do — they only test whether *our code* leaks instructions).

I have not run this. It needs an explicit go-ahead on the data (already minimal) and the budget (already tiny, but not mine to spend without asking).
