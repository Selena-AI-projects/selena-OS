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
| Independent review | Claude.ai Max | ALLOWED by owner on 2026-09-06 | private `selena-OS` code and specification, read-only review only | no API billing, provider calls or repository mutation |
| CI runner access | Blacksmith via GitHub | ALLOWED by owner on 2026-09-06 | sign in to investigate and restore PR CI | repository/account permission grants still require confirmation at the OAuth action |
| GitHub-hosted CI | GitHub Actions | ALLOWED by owner on 2026-09-06 | required Slice 1 PR checks on GitHub-hosted runners | may consume available GitHub Actions minutes; no provider/release workflow is triggered |
| YouTube OAuth/publication/provider call | external platform | PROHIBITED in Slice 1 | none | no account or publication authority |

Owner authorization quote:

> Да, разрешаю disposable PostgreSQL, commit, push, merge, Railway staging deploy, миграцию staging и включение canary-флага. YouTube-публикацию не включать.

Review and CI-access authorization quote:

> Разрешаю передать приватный код selena-OS и спецификацию в Claude.ai Max для read-only review и войти в Blacksmith через GitHub.

# Slices 2-5 authorization matrix

Recorded on 2026-09-06 for the autonomous Slices 2-5 delivery. Everything not
named here keeps the Stage 1 default, which is prohibited.

| Action | Target | Authority | Scope | Automatic side effects |
|---|---|---|---|---|
| Transfer Video Radar source | `parkourcafe/video-radar-marketing-tool` @ `b589a811a4e1f205a784e5128283f9d227143f32` | ALLOWED by owner on 2026-09-06 | contracts, scoring, baseline, outlier, relevance, velocity and anti-copy rules only | none; the source repository is read-only to this work |
| Transfer YouTubePro source | `parkourcafe/youtube-pro` @ `63cd9b9c2ad19b9941a763be3d5cfcbd9bc13b25` | ALLOWED under Apache-2.0 | approved contracts only, with vendored license and provenance | license obligations are preserved in the delivered tree |
| Apply migrations / run pgTAP | disposable local PostgreSQL | ALLOWED by owner on 2026-09-06 | container-local cluster created and discarded for evidence | none outside the container |
| Apply migrations | shared Railway staging database | PROHIBITED for Slices 2-5 | none | the owner runs staging migrations by hand for the duration of GE-5 |
| Deploy | Railway staging or production | PROHIBITED for Slices 2-5 | none | no runtime is changed |
| Commit, push, open PR and merge | GitHub `selena-OS` | ALLOWED by owner on 2026-09-06 | one branch and PR per slice, merged only on green required checks and a passed separate review | PR/main CI runs; no provider or release workflow is triggered |
| Independent blind review | a separate read-only Claude Code session per slice | ALLOWED by owner on 2026-09-06 | repository, governing documents and the exact base/head SHA pair | the reviewing session cannot push, merge or mutate the branch |
| Live research/generation provider call | Video Radar, Gemini, YouTube | PROHIBITED | none | fixture adapters only; adapters fail closed |
| YouTube OAuth, `channel_account`, release intent, publication | external platform | PROHIBITED | none | no account or publication authority |

Owner decisions recorded on 2026-09-06:

- migrations for Slices 2 and 3 are numbered `0040` and `0041`;
- the Video Radar source transfer is authorized despite the absent license file;
- blind review is performed by a separate read-only Claude Code session per slice;
- the shared Railway staging environment is not touched by Slices 2-5.
