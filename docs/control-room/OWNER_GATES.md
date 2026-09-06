# Slice 1 owner gates

| Gate | Status | Exact action | Scope / rollback |
|---|---|---|---|
| Disposable DB | APPROVED | Use an isolated PostgreSQL database and run the full migration chain through 0037 plus the guarded pgTAP suite | disposable only; remove the container after evidence is captured |
| Hosted CI / push | APPROVED | Commit and push the Slice 1 branch, open a PR and run its actual CI | limited to this Slice 1 delivery |
| Merge | APPROVED | Merge the exact reviewed, CI-green Slice 1 PR into `main` | does not authorize production publication or migration |
| Staging deploy and migration | APPROVED | Deploy to the verified Railway staging target and apply the migration there | production environment remains prohibited |
| Canary flag | APPROVED | Set `CONTENT_OS_STAGE1_ENABLED=true` in the verified Railway staging target after deployment and migration | unset restores fail-closed behavior |
| YouTube publication | PROHIBITED | Do not enable OAuth, a live provider adapter, scheduling or publication | remains draft-only |
