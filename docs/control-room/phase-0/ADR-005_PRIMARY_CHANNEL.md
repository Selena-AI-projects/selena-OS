# ADR-005: Primary Channel Pilot

- **Date:** 2026-08-26
- **Status:** PILOT APPROVED; BLOCKED_EXTERNAL_CONTRACT_AND_SETUP
- **Chosen candidate:** LinkedIn organization Page through Postiz Cloud, isolated Selena Systems organization.

## Context

No LinkedIn OAuth, Postiz organization, Page/integration mapping, post adapter, raw platform snapshot, normalizer, or attribution pipeline exists in the repository. Existing metric and tracking definitions are unexecuted prospective tables only (packages/lib/src/db/migrations/0021_selena_control_room.sql:220-271); they are not platform ingestion or attribution.

LinkedIn authorization-code flows require an HTTPS redirect URL configured in the Developer Portal. The redirect value must be absolute and exactly match the authorization request; its available scopes depend on enabled LinkedIn products/partner programs. [LinkedIn authorization-code flow](https://learn.microsoft.com/en-us/linkedin/shared/authentication/authorization-code-flow).

The primary-channel choice is conditional on ADR-004's Postiz Cloud contract spike. No simulated post, mock OAuth callback, fake metric, provider API call, or social publication is created by this ADR or the current task.

## Decision

LinkedIn organization Page is the approved first pilot channel because it can support a future approval-to-publication-to-metrics vertical slice. It is not an implemented channel and remains blocked until a controlled staging Page, approved products/scopes, isolated Postiz Cloud organization, Gateway boundary, and ADR-004 contract-spike evidence have been verified.

### LinkedIn callback candidate

The current candidate for a LinkedIn Page connection through Postiz is:

    https://<postiz-origin>/integrations/social/linkedin-page

Do **not** register or use:

    https://<postiz-origin>/integrations/linkedin/callback

The candidate is not treated as a permanent vendor fact. Immediately before any Developer Portal registration, the designated operator must verify both the current official Postiz documentation and the callback URL actually produced by the selected Postiz Cloud or installed version. Record the exact origin, version, and resulting path in this existing ADR before registration. This verification is deferred; it is not performed in the present task because no external API calls or credentials are authorized.

Gateway does not perform the LinkedIn authorization-code exchange in the Postiz Cloud design. It does not receive a LinkedIn client secret. Its role begins after Postiz exposes a verified integration ID and then enforces the one-ID allowlist from ADR-004.

## Sequenced external setup

After the owner approves the Postiz Cloud contract spike and confirms the LinkedIn Page pilot:

1. Create or identify a real staging LinkedIn organization Page and name its Page administrator.
2. Create the isolated one-brand Selena Systems Postiz Cloud organization.
3. Determine the actual Postiz Cloud origin/version and re-verify the callback candidate above before registration.
4. Create the LinkedIn Developer application and enable only the products/scopes needed for the Page pilot.
5. Register the verified exact callback and connect the Page only within the isolated Postiz organization.
6. Discover the resulting integration ID in the controlled contract spike; configure exactly that ID in the future Gateway allowlist.

Credentials are deliberately excluded from this sequence until integration code and secret-holder configuration exist. Do not create, request, or transmit LinkedIn client credentials, a Postiz token, a Gateway client key/private key, or an audience value now.

## Future credential placement

| Material | Future holder after integration code exists | Denied to |
|---|---|---|
| LinkedIn client ID/secret and redirect configuration | Postiz Cloud provider connection boundary | Browser, Control Room, Trigger, Gateway application code, and Selena PostgreSQL. |
| Postiz Cloud OAuth2 organization token | Gateway secret namespace only | Browser, web runtime, agents, Trigger, worker, and application database. |
| LinkedIn Page/integration identifier | Gateway protected configuration after spike verification | Browser-controlled request parameters and unallowlisted accounts. |

## Future acceptance evidence

1. A human-approved, allowlisted staging Page post reaches LinkedIn only through Gateway and Postiz.
2. Gateway rejects a foreign integration ID before a Postiz operation.
3. OAuth expiry/revocation disables the allowlist and produces a controlled incident/reconnect state.
4. Postiz status and analytics are ingested through a raw/normalized pipeline; a UI metric alone is insufficient.
5. A controlled redirect/UTM route, test visit, and lead event are linked deterministically without invented metrics.

## Consequences and risks

- LinkedIn products/scopes may require approval. That is an external blocker, not a code defect.
- The Cloud contract spike must prove tenant isolation and API capability before a real post or real credentials are authorized.
- The corrected callback is a pre-registration candidate only. Vendor docs and the actual selected Postiz deployment take precedence at registration time.

## Next external action after code review

The LinkedIn Page pilot decision is recorded. No account, Developer application, callback registration, credential, or provider API call is requested in the current task; those actions remain sequenced after an implemented Gateway and approved ADR-004 contract-spike execution plan.
