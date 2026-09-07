# Handoff — Content OS Slice 4, continued in a new session

Written 2026-09-07 ~05:00 UTC by the session that finished Slice 3 and started
Slice 4. Every number and SHA below was produced in that session by running the
command shown; nothing here is from memory. Where something was **not** verified,
it says so.

Read this file, then start at §6.

---

## 1. Where everything is

| | |
|---|---|
| Repository | `Selena-AI-projects/selena-OS` |
| Default branch | `main`, at `6d1b4e82ec0e67df5d8948b8e57679763774f4db` |
| Working branch | `claude/handoff-slice3-continuation-4biyux`, head `8ae4bdd` |
| Slice 4 delta | 3 commits on top of `main`, pushed, **no PR opened yet** |

The branch name says "slice3" because it is the designated branch this
programme's sessions push to; its contents are Slice 4. Do not rename it and do
not push elsewhere without asking the owner.

## 2. Programme state

| Slice | State | Head | Merge on `main` |
|---|---|---|---|
| 1 — profile and draft YouTube target | MERGED | `45dd3b96` | `313daa0c` |
| 2 — research (`0040`) | MERGED | `52741ae` | `86a0a633` |
| 3 — ideas and scripts (`0041`) | MERGED | `3a6c9cd` | `58daa20f2bdaad2b28eba8be741bb67ed943145a` |
| 4 — thumbnails and editorial approval (`0042`) | **IN PROGRESS**, ~40% | `8ae4bdd` | — |
| 5 — local vertical acceptance | NOT STARTED | — | — |

Also merged in that session, both outside the slice sequence:

| PR | What | Merge |
|---|---|---|
| #33 | `pnpm turbo build --concurrency=2` in `build.yaml` | `6814f72034053aa61fdec79755b5a20b6f154cf3` |
| #34 | Round-three findings on Slice 3 | `2a8168d7810ef023447de57c16e7c6d382eba91d` |
| #35 | Two blind spots in the pgTAP harness | `6d1b4e82ec0e67df5d8948b8e57679763774f4db` |

`STAGE1_EXECUTION_PLAN.md` §5 and `ORCHESTRATION_STATE.md` are both current as of
`main`; Slice 4 is recorded there as `IN_PROGRESS`.

## 3. Environment — read this before doing anything

These cost hours to establish. They are properties of the container, not of the
code.

**Container images cannot be pulled.** The Docker *daemon* starts fine
(`dockerd &`, then `docker info` reports 29.3.1), but the agent proxy denies the
layer host:

```
$ docker pull alpine:3.22
failed to copy: ... production.cloudfront.docker.com ...: Forbidden

$ curl -sS "$HTTPS_PROXY/__agentproxy/status"
"detail": "gateway answered 403 to CONNECT (policy denial or upstream failure)",
"host": "production.cloudfront.docker.com:443"
```

So **no ClamAV container and no Supabase Storage container.** Do not spend time
retrying, and never disable TLS verification or unset `HTTPS_PROXY` to get
around it.

**pgTAP works here, and this is new.** Every earlier session — including all
three blind reviews of Slice 3 — could not run the database suites. This one
could:

```
apt-get install -y postgresql-16-pgtap
pg_ctlcluster 16 main start
su postgres -c "psql -q -c \"alter role postgres with password 'pgtap_local_disposable'\""
export PGPASSWORD='pgtap_local_disposable'
bash packages/lib/scripts/run-pgtap.sh <disposable-db-name>
```

The password step is required because the migration runner connects over TCP and
the cluster wants `scram-sha-256`. It is a throwaway cluster in an ephemeral
container; never do this to anything shared.

**Node is 22.22.2, not the 24 the repo declares.** Recorded deviation, unchanged
since Slice 1.

**Dependencies are not installed in a fresh container.** `pnpm install
--frozen-lockfile` takes several minutes and downloads ~1500 packages. Do it
early if you will need to run tests or typecheck.

## 4. What Slice 4 already has, and what it proves

Three commits, oldest first:

```
890bb94  bind an editorial decision to what it was actually shown
49a7597  pair 0042 with a suite, and take the two defects it found
8ae4bdd  say what a thumbnail has to be before a reviewer sees it
```

### Migration `0042` — done

`packages/lib/src/db/migrations/0042_thumbnail_origin_and_editorial_binding.sql`,
journal entry appended as text at `idx` 40, `when` 1788620640000.

Slice 3 created `editorial_approvals` with four hashes and checked one of them.
`0042` makes the other three values the **database derives** and the policy
compares against, so approving content that changed after the reviewer saw it is
refused. Specifically:

- `selena_registry.editorial_asset_bundle_hash(uuid)` — sha256 over the CLEAN
  assets' digests in digest order. A version with no clean asset hashes the empty
  string rather than returning NULL, because an unknown answer inside a
  `WITH CHECK` refuses for the wrong reason.
- `selena_registry.editorial_evidence_hash(uuid)` — sha256 over the stored
  `evidence` jsonb rendered by Postgres, so no second implementation has to agree
  with a first about what canonical means. **The application asks for these; it
  does not compute them.**
- Both are `SECURITY DEFINER`. `0021` already gives `selena_schema_owner` read
  policies on `content_assets` and `content_versions` — checked, not assumed.
- `profile_hash` is bound by joining the version's profile version. A version
  with no profile lineage (a legacy one) cannot be editorially approved at all.
- `editorial_decision` gains `REVOKED`. Revoking is owner-only, requires a
  standing approval for the same version and content hash, and is a new row —
  the table admits no UPDATE and no DELETE.
- `content_assets.origin` (`UPLOADED` | `GENERATED`), defaulted to `UPLOADED`
  because every asset written before this arrived through the upload path.
- `editorial_approvals.decided_seq`, `GENERATED ALWAYS AS IDENTITY`.

**Two defects the suite caught in that migration**, both fixed in `49a7597`:

1. Which decision is *standing* was ordered by `created_at` then by primary key.
   Several decisions land in one transaction, where `now()` is identical, so the
   tie broke on a random uuid and an approval could be **revoked twice**.
   `decided_seq` exists for this.
2. The immutability assertion was written under `selena_web_runtime`, where an
   `UPDATE` is refused by matching no rows rather than by raising. The trigger
   never fired and the assertion **would have passed on silence**. It runs after
   `RESET ROLE` now.

### pgTAP suite for `0042` — done

`packages/lib/src/db/tests/0042_thumbnail_origin_and_editorial_binding.pgtap.sql`,
27 assertions. Measured on the full chain:

```
0041_structured_content_and_editorial_review.pgtap.sql   ok=70   failed=0
0042_thumbnail_origin_and_editorial_binding.pgtap.sql    ok=27   failed=0
assertions=380 failures=0
```

`0041`'s suite supplied two digests as literals and now asks the database for
them, so it tests the contract rather than two chosen constants. That is why
`0041` still reports 70.

### Thumbnail contracts — done

`packages/content-workflow/src/creation/thumbnails.ts` plus its test, 11
assertions, all passing. Pure rules only, no I/O: an asset must belong to the
version under review, be scanned CLEAN, and have unexpired rights and consent.
A **null** rights or consent date means nobody stated a limit, which is a
different fact from a limit that ran out — do not "fix" that into a refusal.

Falsified: replacing the CLEAN check with `if (false)` fails exactly the three
scanner-state tests; restoring returns 11/11.

`BLOCKED_STORAGE`, `ASSET_NOT_CLEAN`, `ASSET_OUT_OF_VERSION`,
`ASSET_RIGHTS_EXPIRED` and `ASSET_CONSENT_EXPIRED` joined
`CREATION_ERROR_CODES`. `BLOCKED_STORAGE` is deliberately not an internal error:
it has to say the thumbnail was *not* saved.

## 5. What Slice 4 still needs

From `STAGE1_EXECUTION_PLAN.md` §9. Nothing below is started.

**A. The asset attach path** — the I/O half of the thumbnails work. Reuse the
existing private storage and scanner; persist opaque storage references and
SHA-256 only, never base64 in content, audit or job payloads; distinguish
generated from uploaded imagery (the column exists); return `BLOCKED_STORAGE`
when storage or scanning is unavailable rather than claiming a save.

**B. `apps/web/src/server/content-review.ts`** — submit, approve, revoke.
Interactive-owner session to approve or revoke. Bind the exact content, profile,
evidence and asset-bundle hashes, obtaining the last two from the two SQL
functions. Append-only. Emit `content.editorial_approved` and
`content.editorial_approval_revoked` through `appendContentAudit`, with metadata
limited to ids, hashes, versions, status and normalized error codes.

**C. Two surfaces**, both behind `CONTENT_OS_STAGE1_ENABLED`:
`/app/$brand/control-room/thumbnails` under **Create**, and
`/app/$brand/control-room/review` under **Govern**. Editorial readiness shown
separately from Releases; Releases stay read-only and explicitly unavailable for
YouTube. One short patch changeset for the user-facing surface.

**D. Release containment evidence** — editorial approval cannot satisfy
publishing approval foreign keys or manifest functions; no YouTube
`channel_account`, release intent, outbox event or publication attempt; LinkedIn
dry-run hashes and kill switches preserved.

**E. Browser evidence**, flag unset and flag exactly `true`, at 1440px and 390px.

### The storage and scanner decision the owner already took

Real Supabase Storage and real ClamAV cannot run here (§3). The owner chose, on
2026-09-07, **local doubles at the network boundary**: an HTTP server
implementing the `/storage/v1/` endpoints `SupabasePrivateStorage` calls, and a
TCP server speaking ClamAV `INSTREAM` that returns **both** `OK` and `FOUND`.
The real socket and HTTP code paths are exercised; only the far end is
substituted.

Record the limitation explicitly in the PR, the way Slice 3 recorded
"Staging evidence: NOT RUN": **a double is not proof about real Supabase or real
ClamAV.** Returning only `OK` would hide the very thing the scanner-bypass stop
condition exists to catch, which is why the double must return both.

## 6. What to do next, in order

1. **Set the environment up** per §3: `pnpm install --frozen-lockfile`, start
   Postgres, install pgTAP, set the password. Confirm the baseline before
   changing anything: `bash packages/lib/scripts/run-pgtap.sh selena_check`
   must print `assertions=380 failures=0`.
2. **Build the attach path (A)** and its unit tests.
3. **Build the review module (B)**, then an integration test through
   `packages/lib/scripts/run-integration.sh <db>` so it runs under real RLS.
4. **Build the two surfaces (C)**.
5. **Produce the evidence (D, E)** with the doubles from §5.
6. **Open the PR**, get CI green on the exact head, then a **separate read-only
   blind review session** on that exact SHA. Do not self-certify. Merge only
   after the owner says so; record the merge SHA in `ORCHESTRATION_STATE.md` and
   `STAGE1_EXECUTION_PLAN.md` §5.
7. **Slice 5** per the plan.

## 7. Owner decisions and outstanding owner actions

- **Outstanding:** the owner still owes an 8 GB swap file on the Hetzner runner.
  Four commands in the Hetzner web console (`>_` button):
  `sudo swapon --show; df -h /` → `sudo fallocate -l 8G /swapfile && sudo chmod
  600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile` →
  `echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab` → `free -h`.
  PR #33 lowered the build's memory peak; swap is the part that absorbs one.
- **Taken:** local doubles for storage and the scanner (§5).
- **Taken:** keep the Hetzner self-hosted runner; do not move CI to
  GitHub-hosted runners.
- **Open, inherited:** revoking a confirmed profile does not stop research or
  creation — both fall back to the previous still-confirmed version. In
  `DECISION_LOG.md`, pinned by tests either way.

## 8. Carried items

In `ORCHESTRATION_STATE.md`, unchanged:

- The vendored-licence digest is compared against a value in its own manifest.
  It catches drift and replacement — both demonstrated by falsification — but
  cannot establish the digest is the one at upstream `63cd9b9`. That needs a
  check against `parkourcafe/youtube-pro`, outside these sessions' repo scope.
- The shared `SidebarTrigger` is 28 px, under the 44 px mobile target. A
  `packages/ui` component, not a content-slice fix.
- No required CI check runs pgTAP, the integration harness, the formatter or the
  linter. `biome check .` reports 323 errors and 358 warnings repo-wide.
- **Not investigated:** `appendContentAudit` picks the previous hash with
  `ORDER BY created_at DESC, id DESC`. That is the same shape as the ordering
  defect found in `0042`, on the audit chain rather than on decisions. Nobody has
  checked whether two events in one transaction can fork the chain. Pre-existing,
  out of Slice 4's scope, worth its own look.

## 9. Working practices that held

- Reviews are separate read-only Claude Code Remote sessions that post to the PR.
- Never state a number in a PR comment or a document that you did not produce in
  that session. Two public corrections were needed for exactly that.
- Falsify load-bearing assertions: break the code they guard and watch them fail.
  An assertion never seen to fail is not yet evidence.
- The migration journal is appended as text, never round-tripped through a JSON
  writer. `git diff` on `_journal.json` must show only the added lines.
- Migrations run only against a disposable local cluster, never anything shared.
- `run-pgtap.sh` now provisions `anon`, `authenticated` and `service_role` and
  detects a plan mismatch. If a suite reports failures you cannot explain, read
  the diagnostic it prints before assuming the schema is broken.

## 10. Non-negotiable boundaries

Verbatim from `HANDOFF_SLICES_2_5.md` §14, unchanged:

- Never read or print `.env`, token stores, private keys, passwords or provider credentials.
- Never commit a secret or a real provider payload.
- Never claim Central Memory registration without a successful tool receipt.
- Never use a shared/staging database as the disposable pgTAP target.
- Never make a live Video Radar, Gemini, YouTube or other paid call in Stage 1.
- Never create a YouTube `channel_account`, release intent, outbox publication event or upload.
- Never allow editorial approval to grant publishing authority.
- Never weaken RLS, brand isolation, append-only history or owner-only approval.
- Never touch production or the existing public `cabinet.selenasystems.com` without a new explicit owner authorization.
- Never call a build, PR, deployment or fixture run production acceptance.

## 11. Owner-facing conventions

The owner (Selena) communicates in Russian and is not an engineer. Explain in
plain words, give one click or one command at a time, name the exact button.
When she brings a substantive text or plan, apply her standing rule: state
agreement and disagreement with arguments both ways, rate it 1–5, name the three
most critical flaws, and execute only after she approves. That rule does not
apply to short questions, continuation commands, or steps already approved
in-session.
