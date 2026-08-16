# Selena Client Workspace Implementation Report

Date: 2026-08-15

## Outcome

The default authenticated customer journey now enters `/app/selena`. The previous technical Selena console was replaced by a customer workspace for creating a project, confirming a brand profile, collecting public website evidence and reading grounded next actions. Default application branding was changed from Elmo to Selena Systems across authentication, metadata, favicon, PWA manifest, Open Graph output and chart exports.

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
- No staging or production deployment was performed.

## Verification

- Authenticated browser journey: login → `/app/selena` — PASS.
- Legacy `/app` redirect — PASS.
- Local project creation and profile confirmation — PASS.
- Desktop and 390 px mobile visual review — PASS.
- EN/RU switch and translated customer workspace — PASS.
- Visitor View/API View separation — PASS.
- Visible Elmo branding in the customer workspace — none.
- Browser application console errors — none observed.
- Impeccable deterministic detector — PASS, no findings.
- `@workspace/config` tests — 87/87 PASS.
- `@workspace/web` tests — 240/240 PASS.
- `@workspace/web`, `@workspace/config` and `@workspace/og` typecheck — PASS.
- `@workspace/web` production build — PASS.
- `git diff --check` — PASS.

Non-blocking build warnings: the local runtime is Node 22 while the repository
declares Node 24, Sentry release/source-map upload is disabled without its
optional auth token, and the existing bundle-size warning remains.

## Review artifacts

- `tmp/ui-review/selena-workspace-empty.png`
- `tmp/ui-review/selena-workspace-populated.png`
- `tmp/ui-review/selena-workspace-mobile.png`
