# Console transcripts (sandbox, 2026-09-28)

Verbatim output of sandbox runs that were printed to the console rather than to a log file.
All runs: hermetic network namespace (loopback only), disposable PostgreSQL 16 clusters,
code checked out at the deployed commits (selena-OS b437efc, selena-ai-visibility 39dda8f). Secrets in these runs are sandbox-only values.

## S-09 Receiver: isolated re-runs

```
N12_unknown_event_type_isolated 400 {"error":"rejected","reason":"event_type"}
{"status":"ok"} [healthz 200]                      <- receiver whose database is unreachable
N16_valid_event_db_unreachable CLIENT-ERROR UND_ERR_SOCKET
curl: (7) Failed to connect to 127.0.0.1 port 8084   <- process exited after the first event
Error: connect ECONNREFUSED 127.0.0.1:59999          <- unhandled, from pg-pool
```

## S-12 Control Room UI (real browser, owner A)

```
APPROVE -> Human approval recorded
QUEUE -> LinkedIn test is ready.
approvals: APPROVED | live = t
release_intents: QUEUED
```

## S-13 Gateway manifest signing (direct call with the internal token)

```
{"error":"bind message supplies 8 parameters, but prepared statement \"\" requires 7"} [409]
```

Cause (apps/worker/src/selena-release-gateway.ts, withGatewayContext):
`SELECT selena_registry.set_request_context($1, $2, $3, $4, $5, $6, $7, NULL)` is sent with 8 values.
Introduced by 8be855c (2026-09-03). Present in b437efc (production) and in every commit deployed to
selena-os-staging (313daa0, fd011fd, 981de9d, 29f7ac9, ab290bb).

## S-14 Dispatcher until dead-letter

```
round 1: status=PENDING attempts=3/5 err=Release Gateway answered 409 for /v1/release-manifests
round 2: status=PENDING attempts=4/5 err=Release Gateway answered 409 for /v1/release-manifests
round 3: status=DEAD_LETTER attempts=5/5 err=Release Gateway answered 409 for /v1/release-manifests
release_intents: QUEUED
incident: severity HIGH, code TRIGGER_OUTBOX_DEAD_LETTER, summary "Release Gateway answered 409 for /v1/release-manifests", status OPEN
UI: Planned releases -> "Queued · Needs attention"; Incidents -> "HIGH Release Gateway answered 409 for /v1/release-manifests Open"
```

## S-15 Outcome recording as the gateway login

```
--- p_status = NOT_SENT (what the dispatcher sends on every refusal):
ERROR:  Postiz outcome status is invalid
--- p_status = DEFINITIVE_FAILURE (control):
ERROR:  Gateway may only record an outcome for its exact manifest
NOT_SENT in enum: true
```

## S-17 selena-ai-visibility admin inbox (production build, platform admin)

```
fetch/xhr calls: ["GET /_serverFn/394661c8…", "GET /_serverFn/c22f813e…"]
operator request visible: true | customer request visible: false | still loading: false
```

Seed: one order request in the operator's own organisation, one in a separate customer organisation.

## S-18 Free check with the emergency stop on

Web: SELENA_EMERGENCY_STOP=true. Worker: SELENA_EMERGENCY_STOP=true, SELENA_MEASUREMENT_ENABLED=false,
SELENA_FREE_AI_VISIBILITY_ENABLED=false. Provider endpoint pointed at a loopback HTTPS mock.

```
2026-09-28T04:18:11.230Z POST /datasets/v3/scrape auth_header_present=true body_bytes=321
2026-09-28T04:18:11.249Z POST /datasets/v3/scrape auth_header_present=true body_bytes=329
sv_free_ai_visibility_checks: COMPLETED|example.com
```

## S-19 Tenant role grants after the documented provisioning order (migrations, then role script)

```
sv_begin_free_ai_visibility_check|f
sv_claim_free_ai_visibility|f
sv_complete_free_ai_visibility_check|f
has_table_privilege('selena_app','public.sv_free_ai_visibility_checks','SELECT') = f
customer page: "We could not start or read this check"
```

Migrations 0059, 0060, 0061, 0062, 0065, 0066, 0067 grant to selena_app only when the role already exists;
packages/lib/scripts/selena-rls-runtime-role.sql starts with REVOKE ALL on every table in public and does not
re-grant those objects.
