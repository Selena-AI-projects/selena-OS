# ADR-004: Postiz Deployment, Isolation, and Contract Spike

- **Date:** 2026-08-26
- **Status:** **BLOCKED_CONTRACT_SPIKE**
- **Decision owners:** Selena product owner and platform/security owner.

## Context

There is no Postiz package, client, network route, credential namespace, account mapping, OAuth flow, adapter, or reconciler in the repository. The source search for Postiz in apps/web/src, apps/worker/src, and packages/lib/src returns no implementation files. The absence of a client or a web signing helper is not a Postiz integration or a network boundary.

Postiz documents public API access for Cloud and self-hosted deployments. The upstream source repository is AGPL-3.0. These facts do not establish Cloud tenant isolation, authorization scope, endpoint coverage, or a usable API contract for Selena. Sources: [Postiz Public API](https://docs.postiz.com/public-api/introduction), [Postiz repository](https://github.com/gitroomhq/postiz-app), and [AGPL-3.0 license text](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE).

## Alternatives considered

| Alternative | Result | Security and operations consequence |
|---|---|---|
| A. Postiz Cloud, isolated Selena Systems one-brand organization | **MVP provisional selection** | A dedicated Selena Systems organization, an OAuth2 organization token held only by the Release Gateway, and an exact allowlist of one LinkedIn Page integration ID. Gateway rejects every other requested or observed integration ID. Cloud isolation and needed endpoint coverage must be proved by the contract spike. |
| B. Dedicated self-hosted Postiz | Fallback only | Requires AGPL obligation review plus Docker, Temporal, PostgreSQL, Redis, encrypted backups, monitoring, upgrades, vulnerability response, incident ownership, and restore evidence. |
| Shared Postiz workspace or credential | REJECT | Cross-brand/cross-environment blast radius is unacceptable. |
| Control Room, browser, agent, or Trigger.dev calls Postiz directly | REJECT | Bypasses the independent Gateway validation and credential control point. |
| Direct LinkedIn adapter in Control Room | REJECT | Bypasses the scheduler boundary and duplicates provider integration work. |

## Decision

For the MVP, choose **Postiz Cloud with an isolated one-brand Selena Systems organization**, **only if** the no-publish contract spike below proves organization isolation and the required API contracts. The Cloud organization must contain one allowlisted LinkedIn Page integration ID. The Release Gateway holds the OAuth2 organization token and performs an equality check against that single configured ID before every provider operation; any different ID is denied before an API call.

If the Cloud spike fails a security or functional acceptance condition, use dedicated self-hosted Postiz as the fallback. Self-hosting is not selected today. Therefore this ADR does **not** request a legal opinion, VPC, Docker environment, Temporal/PostgreSQL/Redis deployment, or self-hosting credential now.

The current decision is blocked because no Cloud organization, token, integration, Gateway service, or contract evidence exists. It becomes accepted only after the controlled spike produces the required evidence. It does not authorize a Postiz install, deployment, API call, credential creation, OAuth authorization, or publication in the present task.

### Credential and network boundary after implementation

| Material | Future physical holder | Explicitly denied to |
|---|---|---|
| Postiz Cloud OAuth2 organization token | Release Gateway secret namespace and Gateway workload identity only | Browser, Control Room web runtime, agents, apps/worker, Trigger task runtime, CI logs, and shared application database. |
| LinkedIn provider OAuth material | Postiz Cloud provider connection boundary only | Browser, Control Room, Trigger, Gateway application code, and Selena PostgreSQL. |
| Gateway manifest signing key | Gateway-only KMS/key namespace | Every other runtime, including Control Room and Postiz. |
| Control Plane request-signing key | Control Room server KMS/key namespace | Browser, Trigger, and Postiz. Gateway receives only the verification material. |

Technical enforcement requires all of the following, none of which exists yet:

1. No web, agent, Trigger, or worker deployment manifest mounts the Postiz token.
2. Only the Gateway egress identity can reach Postiz API endpoints; the others have no token and an explicit network-deny policy where the platform supports it.
3. Gateway maps a release request to the exact allowed LinkedIn Page integration ID held in its protected configuration, then rejects null, unrecognized, foreign-organization, disabled, or mismatched IDs.
4. Gateway re-reads the approved account binding under its database role; a browser request cannot substitute a provider integration ID.
5. Tests prove that a direct request from web/Trigger is denied and that an authorization request for another integration ID fails before a Postiz call.

Until this implementation and tests exist, the truthful state is: no component can obtain a real token because no token exists, but the future restriction is **not technically enforced yet**.

### Postiz Cloud contract spike, without publication

The future spike must use a controlled staging organization and must not create a real post. It is limited to authorization, discovery, non-mutating contract inspection, and revocation evidence. Before the spike begins, record the exact Cloud version/origin and official API documentation revision being tested.

| Acceptance | Required evidence |
|---|---|
| Organization identity | The OAuth2 organization token returns the expected Selena Systems organization ID. |
| Tenant isolation | Listing integrations shows only the Selena Systems organization available to this token. |
| One integration | Gateway protected configuration contains exactly one LinkedIn Page integration ID, and it matches the discovered integration. |
| Foreign ID denied | A request using a different integration ID is rejected by Gateway before any provider/Postiz publishing call. |
| Revocation | Token revocation disables subsequent authenticated discovery calls and is recorded as evidence. |
| API contract coverage | The selected Cloud API documents/supports create-post request validation, media uploads, publication status lookup, and analytics retrieval for the selected integration. Contract verification must not create a real post or upload production media. |
| Token isolation | Deployment/configuration inspection proves web and Trigger receive neither the token nor a route that reveals it. |
| No publication | Spike audit has zero Postiz create-post operations and zero real LinkedIn posts. |

If any evidence is absent, ambiguous, scoped to another organization, or requires a real post to establish basic contract availability, keep this ADR at **BLOCKED_CONTRACT_SPIKE**. A provider timeout or possible acceptance in later publishing code must enter Gateway reconciliation; it must never trigger a blind retry.

### Dedicated self-hosted fallback

If and only if the Cloud spike fails security/functional acceptance, create a replacement decision covering:

- AGPL obligations and distribution/network-service implications;
- a dedicated Docker deployment with Temporal, PostgreSQL, and Redis;
- encrypted backup/PITR and clean-environment restore tests;
- monitoring, alerting, patch/upgrades, version pinning, and vulnerability response; and
- named incident and on-call ownership for Postiz, its persistence, and provider connections.

No legal review or VPC request is needed before this fallback is actually selected.

## Evidence

- packages/lib/src/selena-control-room.ts:116-145 contains pure deterministic gate/classification rules only, with no credential, network, or side-effect authority.
- packages/lib/src/db/migrations/0021_selena_control_room.sql defines local manifest, dispatch-reservation and publication-attempt contracts, but no service, consumer, credential isolation, or Postiz adapter.
- The Postiz public API documentation distinguishes Cloud and self-hosted API use; the source repository is AGPL-3.0. Neither source proves Selena organization isolation or the selected endpoint contracts.

## Consequences and follow-up

- A Postiz type, interface, wrapper, table, Cloud tenant, or token is not a real adapter. A real adapter requires authenticated staging requests through a deployed Gateway plus the reconciliation tests in the Gateway design.
- Gateway remains a future separately deployable service. It is not a TanStack server function, packages/lib helper, Trigger task, or outbox table.
- The Cloud spike is the only Postiz-related external action contemplated after explicit approval. It remains no-publish and does not authorize social publication.

## Next external action after code review

Owner approval for the **Postiz Cloud no-publish contract spike** is recorded. The ADR remains `BLOCKED_CONTRACT_SPIKE` until evidence exists. Do not create a Postiz credential, LinkedIn secret, Gateway client key, audience, self-hosted environment, VPC, or legal workstream in the current task.
