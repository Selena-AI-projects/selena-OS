# Slice 1 authorization matrix

| Action | Target | Authority | Scope | Automatic side effects |
|---|---|---|---|---|
| Read repository and project instructions | local `selena-OS` | ALLOWED by current task | source inspection | none |
| Edit Slice 1 source/docs/tests | isolated local branch | ALLOWED by current task | working tree only | none |
| Install/lock workspace dependencies offline | local workspace | ALLOWED as implementation step | lockfile and workspace links | no provider call |
| Run pure tests, typechecks, Biome and build | local workspace | ALLOWED | no external DB mutation | build artifacts are local/ignored |
| Apply migrations / run pgTAP | database | ALLOWED by owner on 2026-09-06 | disposable PostgreSQL and Railway staging only | production database remains prohibited |
| Enable flag in hosted environment | Railway staging | ALLOWED by owner on 2026-09-06 | `CONTENT_OS_STAGE1_ENABLED=true` after staging migration and deploy | unset or exact non-`true` value restores fail-closed behavior |
| Commit, push and merge | GitHub | ALLOWED by owner on 2026-09-06 | Slice 1 branch and PR into `main` after required checks | PR/main CI may run; no provider workflows are triggered automatically |
| Deploy | Railway staging | ALLOWED by owner on 2026-09-06 | Slice 1 candidate only; production deploy is prohibited | staging runtime changes only |
| YouTube OAuth/publication/provider call | external platform | PROHIBITED in Slice 1 | none | no account or publication authority |

Owner authorization quote:

> Да, разрешаю disposable PostgreSQL, commit, push, merge, Railway staging deploy, миграцию staging и включение canary-флага. YouTube-публикацию не включать.
