# Slice 1 owner gates

| Gate | Status | Exact action | Scope / rollback |
|---|---|---|---|
| Disposable DB | APPROVED | Use an isolated PostgreSQL database and run the full migration chain through 0037 plus the guarded pgTAP suite | disposable only; remove the container after evidence is captured |
| Hosted CI / push | APPROVED | Commit and push the Slice 1 branch, open a PR and run its actual CI | limited to this Slice 1 delivery |
| Merge | APPROVED | Merge the exact reviewed, CI-green Slice 1 PR into `main` | does not authorize production publication or migration |
| Staging deploy and migration | APPROVED | Deploy to the verified Railway staging target and apply the migration there | production environment remains prohibited |
| Canary flag | APPROVED | Set `CONTENT_OS_STAGE1_ENABLED=true` in the verified Railway staging target after deployment and migration | unset restores fail-closed behavior |
| YouTube publication | PROHIBITED | Do not enable OAuth, a live provider adapter, scheduling or publication | remains draft-only |

# Slices 2-5 owner gates

| Gate | Status | Exact action | Scope / rollback |
|---|---|---|---|
| Video Radar source transfer | APPROVED | Transfer research contracts and pure domain rules from the exact source SHA | contracts only; no UI, auth, storage adapter or environment loading |
| Migration numbering | APPROVED | Number the research and structured-content migrations `0040` and `0041` | keeps one migration behind each journal tag in the shared ledger |
| Disposable DB | APPROVED | Run the full chain through `0041` plus paired pgTAP on a container-local cluster | disposable only; the cluster is discarded with the container |
| Hosted CI / push / merge | APPROVED | One branch and PR per slice, merged only on green required checks and a passed separate review | limited to Stage 1 fixture scope |
| Blind review | APPROVED | Obtain a separate read-only Claude Code review of each exact base/head SHA pair | the reviewing session cannot mutate the branch |
| Staging migration or deploy | PROHIBITED | Do not migrate or deploy the shared Railway staging environment | the owner runs staging migrations by hand during GE-5 |
| Live provider call | PROHIBITED | Do not dispatch Video Radar, Gemini or YouTube calls | fixture adapters only |
| YouTube publication | PROHIBITED | Do not enable OAuth, a channel account, release intent, scheduling or publication | remains draft-only |
