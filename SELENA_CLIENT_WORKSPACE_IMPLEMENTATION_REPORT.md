# Selena Client Workspace Implementation Report

Date: 2026-08-16

## Outcome

The default authenticated customer journey now enters `/app/selena`. The previous technical Selena console was replaced by a customer workspace for creating a project, confirming a brand profile, collecting public website evidence and reading grounded next actions. Default application branding was changed from Elmo to Selena Systems across authentication, metadata, favicon, PWA manifest, Open Graph output and chart exports. The customer-facing product name is now `AI Visibility`; internal package names, route contracts and stable IDs remain unchanged.

## Routing

- Safe post-authentication fallback: `/app/selena`.
- Legacy `/app`: server redirect to `/app/selena`.
- Registration preserves a validated same-origin `returnTo` value.
- Unsafe external `returnTo` values fall back to `/app/selena`.

## Customer workspace

- Tenant-scoped project list and project state.
- Guided new-project form.
- Plain-language four-step setup progress.
- Brand profile, website, public profiles, competitors and language-qualified customer questions.
- Explicit website evidence collection action.
- Separate website-readiness and AI-visibility messaging.
- Separate Visitor View and API View result channels with the exact configured systems.
- Grounded action-plan summary when recommendation evidence exists.
- Persistent English/Russian interface switch with browser-language default.
- Responsive project navigation and explicit selected-state accessibility.
- No customer-facing job IDs, order IDs, configuration locks, raw provider controls or technical cycle controls.

## Safety boundaries

- Project creation and profile save make no provider calls.
- Website collection runs only after an explicit click.
- Paid AI measurements remain behind the existing order, budget and owner-approval gates.
- Measurement lookup requires matching organization ownership on both order and cycle.
- No secrets were read or written.
- No payment, provider or measurement calls were made during implementation or review.
- The release was deployed only to Railway staging. Production was not deployed or changed.

## Verification

- Local authenticated browser journey: login → `/app/selena` — PASS.
- Staging login and registration pages — PASS; account creation was not submitted.
- Staging unauthenticated `/app` and `/app/selena` boundaries preserve safe same-origin `returnTo` values — PASS.
- Legacy `/app` post-authentication fallback to `/app/selena` — covered by route and `safeReturnTo` tests.
- Local project creation and profile confirmation — PASS.
- Desktop and 390 px mobile visual review — PASS.
- EN/RU switch and translated customer workspace — PASS.
- Visitor View/API View separation — PASS.
- Visible Elmo branding in the customer workspace — none.
- Browser application console errors — none observed.
- Staging 390 × 844 mobile login layout — PASS.
- Impeccable deterministic detector — PASS, no findings.
- `@workspace/config` tests — 87/87 PASS.
- `@workspace/web` tests — 240/240 PASS.
- `@workspace/web`, `@workspace/config` and `@workspace/og` typecheck — PASS.
- `@workspace/web` production build — PASS.
- `git diff --check` — PASS.

Non-blocking build warnings: Sentry release/source-map upload is disabled without
its optional auth token, and the existing bundle-size warning remains.

## Staging acceptance

- Git commit: `325ee2fefb4db7220de8b8cbb573f849910f0b97`.
- Branch: `release/selena-visibility-mvp`.
- Web deployment: `3434690a-62ef-4ce4-b79d-bdd3413242b0` — `SUCCESS`.
- Web image: `sha256:fc7dee602b5605e697100e75c041bd6cdb72f760d24422fbfa411bb6b26724d6`.
- Worker deployment: `f4ac5a77-d1a9-457f-887b-4b845f6cc98c` — `SUCCESS`.
- Worker image: `sha256:f063b52145ec4584a395daccef5cc714fcd425faef518e6aaa262a3fa61c3f1a`.
- `https://app.selenasystems.com/api/setup-status` — HTTP 200, `ready=true`.
- Worker startup — ready; recurring maintenance disabled by `SCHEDULE_MAINTENANCE_ENABLED=false`.
- Browser console errors on the checked staging authentication flow — none.
- Payment charges, paid provider calls and measurement actions initiated by this release verification — `0`.

The public-site naming change is isolated in commit `acdff24` on
`release/ai-visibility-naming` and is available as a Vercel preview. It was not
promoted to public-site production in this release step.

## Review artifacts

- `tmp/ui-review/selena-workspace-empty.png`
- `tmp/ui-review/selena-workspace-populated.png`
- `tmp/ui-review/selena-workspace-mobile.png`
