# Shared workspace design language

## Product surfaces

The authenticated application contains two distinct surfaces:

- **AI Visibility**, entered through `/app/$brand`;
- **Content OS**, entered through `/app/$brand/control-room`.

Content OS is the neutral portfolio content product. It must never be labelled
Selena OS, Selena Content Control or Content Control Room. Selena may remain as
company/account attribution in the shared shell and on AI Visibility pages.
Internal compatibility names are not user-interface labels.

## Visual direction

The workspace is warm, editorial, calm and evidence-led. It should feel like a
trusted working environment rather than a developer console. Both surfaces use
the existing visual system so switching products feels coherent.

### Color tokens

- Page background: warm ivory `#f7f2ea`.
- Surface: soft paper `#fffdf8`.
- Primary ink: charcoal `#181614` / `#161413`.
- Muted copy: warm grey `#6e6258`.
- Accent: copper `#b9825b`; deep copper `#8f5c34`.
- Borders: warm line `#e6ddd1`.
- Success: muted green surfaces and text with WCAG AA contrast.
- Error: muted red surfaces and text with WCAG AA contrast.

Pure black, pure white and blue-purple gradients are not part of the default
theme.

### Typography

- Body and controls use the existing Geist Sans application font.
- Display headings and the company wordmark use the existing restrained serif
  stack led by Georgia.
- Headings use sentence case.
- Technical identifiers are not exposed as headings or labels.

## Layout

- Desktop: slim header, project rail on the left and one work area on the right.
- Mobile: header collapses cleanly and the rail stacks above the work area.
- Content width stays readable; forms use two columns only when space permits.
- Cards represent distinct workflow stages. Nested decorative cards are avoided.
- Content OS grows through focused child routes rather than extending the
  existing monolithic Control Room screen.

## Content OS workflow

The Stage 1 completion path is:

`Profile -> Research -> Opportunity -> Ideas -> Script -> Thumbnail -> Editorial review`

Publishing is outside Stage 1. The YouTube target must always state:
`Draft-only. No account connected. Publishing is unavailable.`

The product distinguishes:

- owner-confirmed facts from unknown, disputed or prohibited claims;
- research evidence from generated suggestions;
- editorial approval from release approval;
- local fixture acceptance from hosted or production acceptance.

## Feature-flag behavior

`CONTENT_OS_STAGE1_ENABLED` is disabled by default. Only the exact server value
`true` enables the Stage 1 shell. The UI must fail closed when the value is
absent, malformed or differently cased. Provider adapters, OAuth and publishing
remain independently disabled even when this flag is enabled.

## Components and states

- Primary buttons: charcoal fill, paper text, minimum 44 px target.
- Secondary buttons: paper surface, warm border, charcoal text.
- Status pills use human-readable state, not database enums.
- Forms include persistent labels, examples and readable validation.
- Empty states explain the next action and why it is safe.
- Success and error messages use `role=status` or equivalent semantics.
- Links leaving the app show a clear external-link affordance.

## Accessibility and motion

- Main text meets WCAG AA contrast.
- Interactive targets are at least 44 x 44 px.
- Focus-visible states remain obvious on ivory and dark surfaces.
- Responsive layout works at 390 px without horizontal scrolling.
- Motion is subtle and disabled under `prefers-reduced-motion`.

## Brand boundaries

- Content OS uses its neutral product name everywhere on content routes.
- The Selena wordmark may identify the company/account or AI Visibility, but not
  rename Content OS.
- Existing tokens and components are reused; Stage 1 introduces no new color,
  font, radius or shadow system.
- Credentials, raw provider payloads, internal IDs, job controls and release
  internals never appear in the customer workspace.
