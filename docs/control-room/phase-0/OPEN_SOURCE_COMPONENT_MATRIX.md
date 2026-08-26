# Selena OS Open-Source and Service Component Matrix

**Audit date:** 2026-08-26. **Scope:** architecture decision only. No component listed here was installed, cloned, deployed, credentialed, or connected by this task. A version is pinned only when it is already in pnpm-lock.yaml or explicitly selected after the required acceptance evidence.

| Component | Decision | Run as | Selena work still required | Canonical data/credential boundary | License | MVP phase | Status |
|---|---|---|---|---|---|---|---|
| Payload | **DEFER FOR MVP** | Not run for first brand. A separate Next.js/Payload service remains technically viable; TanStack Control Room could use its REST API. | Complete custom Registry contracts now; run build-vs-Payload review after first brand. Migrate one-way to Payload only when custom draft/version/access/admin support cost exceeds separate Payload service cost. | Selena Drizzle Registry during MVP. No Payload credential or dual-write registry. | MIT observed for payload@3.88.0; not installed | Post-first-brand review | DEFERRED by ADR-003 |
| Trigger.dev | ACCEPTED service direction | Trigger.dev Cloud task runtime, later replaceable by self-hosted v4. | Durable workflows, queues, retries, idempotency, approval wait, cancellation, reconciliation, and Gateway client. | Trigger run metadata only. No PostgreSQL or Postiz token in Trigger. | SDK metadata observed MIT; platform repository Apache-2.0 | P2, decision P0 | APPROVED; project/package deferred |
| Postiz | **TAKE AS SERVICE, conditional** | Postiz Cloud in one isolated Selena Systems organization, behind Gateway. Dedicated self-host is fallback only. | Gateway-only adapter, exact one-ID allowlist, account mapping, reconciliation, webhook/poll verification, and direct-access denial tests. | Postiz holds provider OAuth. Gateway alone holds future Cloud OAuth2 organization token; Selena owns release/attempt/audit truth. | Cloud terms require later review; self-host alternative AGPL-3.0 | P2, contract decision P0 | BLOCKED_CONTRACT_SPIKE by ADR-004 |
| Supabase | ACCEPTED service direction | Supabase Cloud PostgreSQL and private Storage; retain Drizzle and Better Auth. | Private schema/roles/RLS/pgTAP, server storage broker, scanner, signed URL flow, backup/restore evidence. | Supabase Auth is not used. Canonical private schemas are not exposed through Data API. Browser gets no service-role key. | Service; no SDK selected | P1/P3 | APPROVED; project deferred |
| pgTAP | ADAPT | Disposable DB and later staging/CI database test suite. | Run the reauthored role/context/RLS/grant negative tests. | Test-only database identity; no production authority. | PostgreSQL extension | P1 | TEST FILE READY; not installed or run |
| dlt | DEFER | Not run in MVP control plane. | Evaluate adapters/raw retention/checkpoints only when Phase 3 ingestion begins. | Raw/normalized/quality data stays Selena-owned. | Apache-2.0 | P3 | DEFERRED |
| Langfuse | DEFER | Optional managed/self-hosted observability later. | Agent trace redaction and retention controls. | No approval/release authority. | MIT core; enterprise terms vary | Post-MVP | DEFERRED |
| Cube | DEFER | Not run in MVP. | Semantic layer only after raw/normalized metrics exist. | No raw event or approval authority. | Apache-2.0 | Post-MVP | DEFERRED |
| OPA | INSPIRE | Not run in MVP. | Keep deterministic TypeScript validation now; re-evaluate Rego after policy volume justifies a separate runtime. | Brand Pack policy stays Selena PostgreSQL. | Apache-2.0 | Post-MVP | DEFERRED |

## Decision notes

- Payload is deferred for operational and ownership cost, not because it is incompatible with TanStack/Vite. No Payload project or package is requested now.
- Postiz Cloud is the MVP provisional choice only after a no-publish contract spike proves organization isolation, one LinkedIn integration allowlisting, token revocation, and required API coverage. No real post may be created in the spike.
- Dedicated self-hosted Postiz would require AGPL, Docker, Temporal, PostgreSQL, Redis, backups, monitoring, upgrades, and incident ownership. Do not start this work unless the Cloud spike fails.
- Supabase Data API is not used for canonical private schemas and Supabase Auth is not added. Better Auth plus server-established transaction context, RLS, grants, and application authorization operate together.
- The repository currently has neither Payload, Trigger.dev, Postiz, Supabase, pgTAP, Langfuse, dlt, Cube, or OPA in its dependency graph. It has pg-boss (apps/worker/src/index.ts:37-75) and locked PostHog packages (pnpm-lock.yaml:8352-8355).

## Sources reviewed before this no-external-call task

- [Payload installation](https://payloadcms.com/docs/getting-started/installation), [Payload outside Next.js](https://payloadcms.com/docs/local-api/outside-nextjs)
- [Trigger self-hosting overview](https://trigger.dev/docs/self-hosting/overview), [Trigger pricing](https://trigger.dev/pricing)
- [Postiz public API](https://docs.postiz.com/public-api/introduction), [Postiz AGPL license](https://github.com/gitroomhq/postiz-app/blob/main/LICENSE)
- [Supabase RLS guide](https://supabase.com/docs/guides/database/postgres/row-level-security)
