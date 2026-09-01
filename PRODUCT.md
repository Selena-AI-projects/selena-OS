# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Product structure

This repository provides one authenticated workspace with two distinct product
surfaces:

- **AI Visibility** measures how a brand appears in AI answers and turns
  disclosed evidence into grounded recommendations.
- **Content OS** prepares, reviews and approves evidence-bearing portfolio
  content without enabling external publication.

Both products use Better Auth organizations and the existing brand workspace.
Content OS uses the canonical `organization -> brand` tenancy path; it does not
merge brands with the separate AI Visibility `sv_projects` model.

## Users

The workspace serves local businesses, hospitality teams, service companies,
founders and agencies. A user may manage several brands while keeping every
brand's facts, evidence and drafts isolated from the others.

## Product purpose

AI Visibility measures public evidence and visibility. Content OS turns a
confirmed brand profile, research and human decisions into immutable content
drafts. Success means a user can move between those surfaces without confusing
measurement with creation or editorial approval with publishing authority.

## Content OS Stage 1

Stage 1 is local and draft-only. For each brand it will support a versioned
project profile, a draft-only YouTube target, research, ideas, scripts,
thumbnails and human editorial approval. It does not include YouTube OAuth,
uploads, scheduling, analytics ingestion or any other external publication.

`CONTENT_OS_STAGE1_ENABLED` is fail-closed and disabled unless the server sees
the exact value `true`. Enabling the flag exposes only the Stage 1 product
surface; it does not authorize provider calls, paid work, credentials, release
intents or publication.

## Operating context

- `selenasystems.com` is the public marketing and free-readiness surface.
- `app.selenasystems.com` is the authenticated workspace.
- AI Visibility retains Visitor View and API View as separate evidence modes.
- Public website readiness can run without connecting private accounts.
- Paid measurements require an approved order, fixed cardinality and provider
  budget caps.
- Content OS provider adapters remain independently disabled by default.

## Capabilities and constraints

The current AI Visibility catalog and its commercial gates remain unchanged.
Content OS Stage 1 adds no checkout, provider spending or publishing authority.
Creating or confirming a profile never triggers research, generation or any
other external call.

## Naming and compatibility

**Content OS** is the single neutral working name for the portfolio content
surface. Content routes must not present Selena as the product name. Selena may
remain visible as company or account attribution and on the separate AI
Visibility surface. Historical `selena-*` schemas, roles, migration names,
server modules and compatibility routes are internal implementation details and
are not renamed in Stage 1.

## Brand commitments

The workspace voice is clear, practical and evidence-first, without hype, fake
urgency or unverifiable claims. The approved seller for the current AI
Visibility product documents is PT Izi Jiza Bali, Indonesia.

## Product principles

1. Evidence before interpretation.
2. Organization and brand boundaries are enforced at every layer.
3. No measurement, generation or spend before an explicit approved boundary.
4. Editorial approval never grants publication authority.
5. Internal identifiers and operational controls stay out of the user experience.
6. Source, disposable-database, local-browser, staging and production evidence
   remain separate acceptance classes.

## Accessibility and inclusion

The web experience must meet WCAG AA contrast, keyboard navigation and 44x44 px
minimum touch targets. English and Russian routes must remain equivalent in
meaning and product scope.
