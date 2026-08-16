# AI Visibility by Selena Systems — Design Language

## Product surface

The default customer experience is Selena Systems, not the underlying Elmo administration product. The primary authenticated route is `/app/selena`; legacy `/app` traffic redirects there. Custom white-label deployments may still provide their own name and icon.

## Visual direction

The interface extends the existing Selena Systems public site: warm, editorial, calm and evidence-led. It should feel like a trusted advisory workspace rather than a developer console.

### Color tokens

- Page background: warm ivory `#f7f2ea`.
- Surface: soft paper `#fffdf8`.
- Primary ink: charcoal `#181614` / `#161413`.
- Muted copy: warm grey `#6e6258`.
- Accent: copper `#b9825b`; deep copper `#8f5c34`.
- Borders: warm line `#e6ddd1`.
- Success: muted green surfaces and text with WCAG AA contrast.
- Error: muted red surfaces and text with WCAG AA contrast.

Pure black, pure white and blue-purple gradients are not part of the Selena default theme.

### Typography

- Body and controls use the existing Geist Sans application font.
- Display headings and the Selena wordmark use a restrained editorial serif stack led by Georgia.
- “Systems” is letter-spaced uppercase sans text; the copper dot completes the wordmark.
- Headings use sentence case. Technical identifiers are not exposed as headings or labels.

## Layout

- Desktop: slim branded header, project rail on the left, single work area on the right.
- Mobile: header collapses to the wordmark and account action; project rail stacks above the work area.
- Content width stays readable and stable; forms use two columns only when space permits.
- Cards represent distinct workflow stages. Nested decorative cards are avoided.

## Customer workflow

The workspace communicates four stages in plain language:

1. Project created.
2. Brand profile confirmed.
3. Website evidence collected.
4. Results available.

The interface must distinguish website readiness from paid AI visibility measurements. Creating a project or saving a profile never triggers provider calls. A website collection starts only after an explicit customer action. Paid measurements remain behind a separate order, budget and owner-approval boundary.

## Components and states

- Primary buttons: charcoal fill, paper text, minimum 44 px target.
- Secondary buttons: paper surface, warm border, charcoal text.
- Status pills describe customer state (“Profile needed”, “Ready for website scan”), not database enums.
- Forms include persistent labels, examples and human-readable validation.
- Empty states explain the next action and why it is safe.
- Success and error messages use `role=status` or equivalent accessible semantics.
- Links that leave the app show a clear external-link affordance.

## Accessibility and motion

- Main text meets WCAG AA contrast.
- Interactive targets are at least 44 × 44 px.
- Focus-visible states must remain obvious on ivory and dark surfaces.
- Responsive layout must work at 390 px without horizontal scrolling.
- Motion is subtle and disabled when `prefers-reduced-motion` is set.

## Brand boundaries

- Default metadata, favicon, PWA manifest, Open Graph image, chart exports, authentication and customer workspace use Selena Systems branding.
- Upstream Elmo references may remain only where they are necessary technical attribution, source documentation or administrator-facing implementation detail.
- Internal IDs, configuration locks, raw provider credentials, job controls and manual cycle controls do not belong in the customer workspace.
