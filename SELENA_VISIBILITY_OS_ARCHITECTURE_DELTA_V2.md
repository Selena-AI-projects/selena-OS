# Selena Visibility OS — Architecture Delta V2

Приложение к действующему ТЗ. Отвечает ровно на один вопрос: **что нужно
добавить или изменить, чтобы Selena AI Visibility стала первым модулем Selena
Visibility OS.**

Документ не переписывает архитектуру, не переименовывает существующие сущности
и не является разрешением на код. Реализация начинается только после
утверждения этой Delta вместе с
`SELENA_VISIBILITY_OS_MIGRATION_PLAN_V2.md` и
`SELENA_VISIBILITY_OS_ACCEPTANCE_GATES_V2.md`.

Статус: `DELTA_DRAFT — NOT APPROVED`. Кода по этой Delta не написано.

## 0. Оговорка о версии ТЗ

Задание ссылается на «ТЗ v1.1». В репозитории действующих файлов с таким
номером нет: актуальны `docs/selena-visibility/TZ_v1_3_impl.md` и
`docs/selena-visibility/TZ_v1_4_codex.md`, а фактическое состояние сборки —
`docs/selena-visibility/IMPLEMENTATION_STATUS_MATRIX_v1_4.md`. Delta написана
как приложение к v1.3/v1.4. Если «v1.1» — отдельный документ вне репозитория,
его нужно приложить: расхождение нумерации разрешает владелец, а не агент.

## 1. Baseline — что уже есть и считается неизменяемым фундаментом

Проверено в репозитории на 2026-08-26, ветка
`claude/selena-visibility-os-arch-fv4b9h`.

| Слой | Факт | Где |
|---|---|---|
| Migration head | `0036_selena_order_requests`, `_journal.json` idx 36 → первый свободный номер `0037` | `packages/lib/src/db/migrations/` |
| Применение миграций | 0025–0036 существуют только в ветках; применялись исключительно к одноразовым scratch-базам | `IMPLEMENTATION_STATUS_MATRIX_v1_4.md` |
| Таблицы домена | 36 таблиц `sv_*`, все с `enableRLS()`; политики `tenant_isolation` — миграция 0034 (без FORCE, инертны до runtime-роли) | `packages/lib/src/db/schema.ts` |
| Инвариант RLS в CI | `count(*) FROM pg_class WHERE relname LIKE 'sv_%' AND relrowsecurity` — новые таблицы обязаны попадать под этот счёт | `tools/selena_isolated_e2e.sh` |
| AI measurement | `sv_configuration_locks` → `sv_quotes` → `sv_orders` → `sv_cycles` → `sv_run_permits` → `sv_runs` → `sv_response_mentions` | `schema.ts` |
| Cardinality | `expectedRunsFromScope` = scenarios × systems × repeats, зафиксировано в Configuration Lock | `packages/selena-visibility-contracts/src/measurement-scope.ts` |
| Исполнение | permit → adapter; allowlist `ownerApprovedMeasurementAdapters`, инертные `noop` / `stub`; в воркере зарегистрирован только `noop` | `measurement-execution.ts` |
| Очереди | `selena-measure`, `selena-answer-retention` | `apps/worker/src/index.ts` |
| Evidence | `canonical_payload.answerText`, `raw_response_reference`, `sv_cost_events`, `sv_incidents`, `sv_audit_events`, окно хранения 13 месяцев | `schema.ts`, `selena-answer-retention.ts` |
| Findings / Recommendations | `sv_findings`, `sv_recommendations`; отдельный движок `sv_recommendation_runs/_manifests/_evidence/_findings/_actions/_tasks` с `evidence_ids`, `confidence`, `verification_plan` | `schema.ts`, `recommendation.ts` |
| Access classes | `PUBLIC` / `CONNECTED` / `UPLOADED` уже существуют | `recommendation.ts` |
| Local (RC7) | `sv_entities`, `sv_business_locations`, `sv_pilot_cycles`, `sv_capture_tasks`, `sv_local_observations`, `sv_observation_mentions`, `sv_observation_evidence_assets`; поверхность `GOOGLE_ASK_MAPS` — `MANUAL_ONLY`, backend не имеет права на внешний вызов | `local-discovery.ts`, `RC7_ARCHITECTURE_MAPPING.md` |
| Readiness | канонический публичный readiness-конвейер, `sv_website_snapshots`, `sv_public_scans` | `/api/v1/selena/readiness/*`, `selena-canonical-readiness` |
| API | `projects, profiles, scenarios, locks, quotes, orders, payments/test, cycles, findings, action-plan, citation-gaps, dashboard, public-scan, website-collector, readiness/*, pilot/*` | `apps/web/src/routes/api/v1/selena/` |
| Кабинет | `/app/selena` (семь шагов), `selena-admin`, `selena-order`, `selena-report`, `selena-sources` | `apps/web/src/routes/_authed/app/` |
| Экспорт | CSV + `assertCanonicalDataset`; PDF/XLSX офлайн-скриптом | `packages/lib/src/selena-export.ts`, `tools/selena_export.py` |
| Каталог | зафиксирован: Visitor Local $49, Full AI Landscape $79, Expert Verified $399, Growth 90 Days $2 490 | `catalog.ts`, `SELENA_PRODUCT_CATALOG_LOCK_V1.md` |

Сохраняются без изменения: Public Audit без обязательного OAuth;
`PUBLIC / UPLOADED / CONNECTED`; Visitor View и API View врозь; branded и
non-branded сценарии; Configuration Lock; expected cardinality; budget gates;
immutable measurement cycles; Evidence Ledger; Finding Ledger; Recommendation
Ledger; `evidence_ids`; `confidence`; `verification_plan`; tenant isolation;
canonical dataset; PDF/XLSX/CSV; `UNKNOWN` при отсутствии данных; запрет
рекомендаций без доказательств.

AI Visibility Core не переписывается. Он становится **одним measurement domain**
внутри более широкой системы.

## 2. Repository Gap Map — KEEP / EXTEND / ADD / DEPRECATE

`KEEP` — не трогать. `EXTEND` — дополнить, не ломая существующие чтения.
`ADD` — новое. `DEPRECATE` — вывести из употребления по расписанию.

### 2.1 Схема данных

| Объект | Решение | Что именно |
|---|---|---|
| `sv_projects`, `sv_project_profiles`, `sv_prompt_families`, `sv_scenarios` | KEEP | без изменений |
| `sv_configuration_locks` | EXTEND | новые необязательные блоки снапшота: `localMeasurement`, `reputationScope`, `outcomeScope`. Старые локи не переписываются, отсутствие блока — легальное состояние |
| `sv_quotes`, `sv_orders`, `sv_payments` | EXTEND | ссылка на набор доменов заказа; статусы не меняются |
| `sv_cycles`, `sv_run_permits`, `sv_runs`, `sv_response_mentions` | KEEP | AI-домен; ни одной новой колонки под Local/Reputation |
| `sv_findings`, `sv_recommendations` | EXTEND | `domain_id`, `location_id` (nullable) — чтобы находка знала, из какого домена она пришла |
| `sv_recommendation_*` (движок) | KEEP | контракт манифеста и evidence не меняется |
| `sv_entities`, `sv_business_locations` | EXTEND | это и есть «locations» из плана миграций; отдельная таблица `locations` не создаётся |
| `sv_pilot_cycles`, `sv_capture_tasks`, `sv_local_observations` | KEEP | Ask Maps остаётся ручной поверхностью, не сливается с Local Pack |
| `sv_website_snapshots`, `sv_public_scans` | EXTEND | источник Readiness-снимков |
| `sv_cost_events`, `sv_incidents`, `sv_audit_events` | EXTEND | новый `kind`/`domain_id`; таблицы общие для всех доменов |
| Реестр доменов и циклов | ADD | M1 |
| Local Visibility | ADD | M2 |
| Search + Reputation | ADD | M3 |
| Action и Evidence Loop | ADD | M4 |
| Read-models для Visibility Map | ADD | M5 |
| Outcome Layer | ADD | M6 |
| — | DEPRECATE | ничего. Ни одна существующая таблица не выводится из употребления этой Delta |

### 2.2 Именование — обязательная поправка к плану миграций

В задании новые таблицы названы без префикса (`locations`, `actions`,
`change_events`, `outcomes`). В этом репозитории так нельзя по двум причинам:

1. CI-инвариант считает покрытие RLS по маске `sv_%`. Таблица без префикса
   выпадает из проверки — то есть tenant-изоляция перестаёт быть проверяемой
   ровно на новых данных.
2. `actions` и `outcomes` — общие слова, а рядом уже живут
   `sv_recommendation_actions` (выход движка рекомендаций) и `action_plan`.
   Совпадение имён гарантирует путаницу между «движок предложил» и «владелец
   утвердил».

Все новые таблицы получают префикс `sv_`. Утверждённое действие называется
`sv_approved_actions`, чтобы его нельзя было спутать с
`sv_recommendation_actions`.

### 2.3 Поправка к batch M1 — общего `measurement_observations` не будет

План предлагает в M1 таблицу `measurement_observations`. Это противоречит
§3 этого же задания: у доменов разные единицы измерения, и общая таблица
наблюдений заставит как минимум один домен хранить ключ, которого у него нет
(координата у AI-прогона, система у отзыва). Получится ровно та «гигантская
таблица runs», от которой Delta уходит.

Решение: M1 добавляет **реестр и версионирование**, но не хранилище наблюдений:

```text
sv_measurement_domains      справочник доменов и их единиц измерения
sv_measurement_cycles       зонтичная запись цикла: domain_id + domain_cycle_id
sv_measurement_datasets     версия датасета, к которой привязан любой расчёт
sv_source_snapshots         снимок источника (общий для доменов)
sv_evidence_index           тонкий индекс: domain_id, cycle_id, observation_ref,
                            dataset_id, captured_at — указывает, не хранит
```

Наблюдения остаются в таблицах своего домена. `sv_evidence_index` даёт сквозной
поиск и целостность Evidence Loop, не сводя единицы измерения к одной.

`sv_cycles` остаётся циклом AI-домена. Зонтичный `sv_measurement_cycles` не
дублирует его, а ссылается на него как на `domain_cycle_id` домена `AI`.

## 3. Domain boundaries

Каждый домен измеряет свою единицу. Ни одна метрика не считается поперёк
единиц.

```text
AI Measurement
scenario × system × repeat

Search Measurement
query × engine × region × device

Local Measurement
location × keyword × coordinate × provider

Reputation Measurement
location × source × period

Outcome Measurement
project/location × metric × period
```

Правила границ:

- домен владеет своим циклом, своей cardinality, своим бюджетом и своими
  наблюдениями;
- падение одного домена не переводит другой в `FAILED`;
- retry домена перезапускает только его собственную единицу (для Local — одну
  конкретную координату, не весь grid);
- стоимость провайдера пишется в общий `sv_cost_events`, но с `domain_id`, и
  капы считаются по домену и по заказу отдельно;
- ни один расчёт не смешивает Visitor View и API View, а теперь ещё и не
  смешивает каналы поверх доменов.

### 3.1 Реестр поверхностей

Домен — это единица измерения; поверхность — то, что реально опрашивается.
Поверхность обязана декларировать допустимые способы съёма, иначе автоматизация
однажды заедет туда, где разрешён только человек.

| surface_id | domain | capture methods | gate | status |
|---|---|---|---|---|
| `AI_ANSWER_ENGINE` | AI | `PROVIDER_API`, `VISITOR_SCRAPE` | существующие | MEASURED |
| `GOOGLE_ASK_MAPS` | LOCAL | `MANUAL_OBSERVATION` **и только** | `LOCAL_AI_DISCOVERY_ENABLED` | MEASURED |
| `GOOGLE_MAPS_LOCAL_PACK` | LOCAL | `PROVIDER_API`, `MANUAL_OBSERVATION` | `SELENA_LOCAL_VISIBILITY_ENABLED` | ADD |
| `GOOGLE_ORGANIC` | SEARCH | `PROVIDER_API` | `SELENA_SEARCH_VISIBILITY_ENABLED` | ADD |
| `GOOGLE_AI_OVERVIEWS` | SEARCH | `PROVIDER_API` | `SELENA_SEARCH_VISIBILITY_ENABLED` | ADD |
| `REVIEW_PLATFORM` | REPUTATION | `PROVIDER_API`, `MANUAL_OBSERVATION` | `SELENA_REPUTATION_ENABLED` | ADD |

`GOOGLE_MAPS_LOCAL_PACK` и `GOOGLE_ASK_MAPS` — **разные поверхности**. Первая —
ранжированная выдача мест, вторая — AI-ответ о месте. Политика RC7
(`LOCAL_AI_DISCOVERY_POLICY`, `MANUAL_ONLY`, никаких Places API) продолжает
действовать на Ask Maps без послаблений; появление провайдерного Local Pack её
не отменяет и не расширяет.

Поверхность, у которой не выставлен gate, недоступна. Незарегистрированный флаг
читается как выключенный.

## 4. Shared Evidence Layer

Домены сходятся в общий слой доказательств, но не в общую таблицу.

```text
        AI            Local           Search        Reputation      Outcome
         │              │                │              │              │
   sv_runs +      sv_local_rank_    sv_search_    sv_review_     sv_outcome_
 sv_response_      observations      rank_obs      snapshots     observations
   mentions             │                │              │              │
         └──────────────┴────────┬───────┴──────────────┴──────────────┘
                                 │
                        sv_evidence_index
                 (domain, cycle, observation_ref, dataset)
                                 │
                        sv_measurement_datasets
                        sv_source_snapshots
                                 │
                    Finding / Recommendation Ledger
```

Общий слой обязан обеспечивать:

- **адресуемость**: любая цифра на экране восстанавливается до конкретных
  observation IDs;
- **версионирование**: у каждого расчёта есть `formula_version` и
  `dataset_id`; смена формулы не переписывает историю;
- **воспроизводимость**: экспорт датасета даёт те же цифры, что и экран;
- **иммутабельность**: наблюдение не редактируется, исправление — новая версия
  со ссылкой на предыдущую (образец уже есть:
  `sv_local_observations.supersedes_observation_id`).

## 5. Readiness ≠ Visibility ≠ Outcome

Три модели, три формулы, три экрана. Общего балла нет и не будет.

```text
Readiness       готовы ли активы            0–100 по измерению, правило-based
Visibility      получаем ли присутствие     доля наблюдений, measurement-based
Outcome         возникает ли результат      абсолютные значения, connected/uploaded
```

| | Readiness | Visibility |
|---|---|---|
| Источник | правила по снимку активов | наблюдения измерительных доменов |
| Единица | измерение × снимок | единица домена |
| Отсутствие данных | `null` (не 0) | `UNKNOWN` (не 0 %) |
| Evidence type | `READINESS_RULE` | `OBSERVATION` |
| Меняется от | изменения актива | только от нового измерения |

Измерения Readiness: `WEBSITE`, `GBP`, `SCHEMA`, `REVIEWS`, `CITATIONS`,
`CONTENT_COVERAGE`.

Жёсткие правила:

- изменение Readiness **никогда** не меняет Visibility и наоборот; между ними
  нет вычислительной связи, только человеческая интерпретация в тексте находки;
- ни одна функция не принимает обе величины и не возвращает одну;
- readiness-находка не может быть подана как позиция или ранг;
- пустая группа — `UNKNOWN`, а не «0 %».

## 6. Visibility Map

Один экран, шесть режимов над одной территорией: `Maps`, `AI local intent`,
`Competitors`, `Reviews`, `Changes`, `Before/After`.

Контракт данных карты:

- каждая отображаемая точка несёт `observation_id`, `captured_at`,
  `provider`, `keyword`, `dataset_id`;
- статусы `measured` / `invalid` / `unmeasured` различимы **не только цветом**
  (форма или штриховка обязательны — WCAG AA уже требование продукта);
- интерполяция между точками либо отсутствует, либо явно помечена как
  интерполяция и не выдаётся за наблюдение;
- режим `Before/After` доступен только между совместимыми циклами (см. §8 и
  Gate 8), иначе экран показывает причину несовместимости, а не усреднённую
  разницу;
- карта не является источником истины: она читает read-model, который читает
  наблюдения.

## 7. Evidence Loop

```text
Finding
  → Recommendation
    → Action                  (утверждение владельца)
      → Change Event          (что и когда реально сделано)
        → Verification Cycle  (повторное измерение)
          → Outcome           (только connected/uploaded)
            → Attribution Assessment
              → Learning
```

Состояния действия:

```text
PROPOSED → APPROVED → IN_PROGRESS → IMPLEMENTED → VERIFIED
    ↓          ↓            ↓
 REJECTED  ABANDONED    ABANDONED
```

`VERIFIED`, `REJECTED`, `ABANDONED` — терминальные. Переход в `VERIFIED`
возможен только из `IMPLEMENTED` и только когда существует verification cycle,
завершённый после окна вылёживания.

Правила целостности:

- `APPROVED` невозможно без `evidence_ids` и без утвердившего;
- change event без действия допустим (изменение случилось само) и помечается
  `UNATTRIBUTED` — это важный вход для `CONFOUNDED`;
- verification cycle обязан ссылаться на baseline cycle и на dataset-версии
  обоих измерений;
- удаление промежуточного звена запрещено; если звено всё же исчезло,
  пишется incident в `sv_incidents`, а attribution получает
  `INSUFFICIENT_EVIDENCE`;
- окно вылёживания по умолчанию 14 дней, хранится в verification cycle, а не в
  коде экрана.

## 8. Attribution policy

Допустимые исходы — и никаких других:

```text
POSITIVE_CORRELATION
NEGATIVE_CORRELATION
NO_OBSERVED_CHANGE
MIXED_RESULT
INSUFFICIENT_EVIDENCE
CONFOUNDED
NOT_MEASURED
```

Значения `CAUSAL` в словаре нет. Причинность не выводится из
последовательности событий — это не оговорка в интерфейсе, а отсутствующее
значение в перечислении.

Нормативный порядок решения (первое сработавшее правило выигрывает):

```text
1. нет baseline или нет повторного измерения        → NOT_MEASURED
2. before или after == UNKNOWN                      → NOT_MEASURED
3. циклы несовместимы (см. Gate 8)                  → INSUFFICIENT_EVIDENCE
4. нет ни одного change event                       → NOT_MEASURED
5. change events есть, но verification не завершён  → INSUFFICIENT_EVIDENCE
6. измерение раньше окна вылёживания                → INSUFFICIENT_EVIDENCE
7. ≥2 независимых действия в окне, либо
   присутствует UNATTRIBUTED change event           → CONFOUNDED
8. метрики домена разошлись по знаку                → MIXED_RESULT
9. |delta| < минимально различимого изменения       → NO_OBSERVED_CHANGE
10. delta > 0                                       → POSITIVE_CORRELATION
11. delta < 0                                       → NEGATIVE_CORRELATION
```

Confidence считается отдельно и только для исходов 8–11. Начинает с `HIGH` и
понижается на шаг за каждый признак, пол — `LOW`:

```text
change event заявлен, но не подтверждён доказательством
объём выборки до или после ниже порога домена
объявленные внешние факторы (сезонность, реклама, ремонт)
более одного типа изменения в окне
```

Каждая оценка атрибуции хранит: verdict, confidence, `reason_codes`,
`evidence_ids`, `baseline_cycle_id`, `verification_cycle_id`, `dataset_id`,
`formula_version`. Оценка без supporting evidence IDs не сохраняется.

## 9. Расчётные правила новых метрик

Нормативные определения. Реализация обязана считать именно так — на этом стоят
Gate 4 и Gate 8.

**Глубина съёма (правило, из которого следует всё остальное).** Точка отвечает
на вопрос «внутри ли Top-N?» только если съём прочитал минимум N позиций **или**
цель найдена на позиции ≤ N. Пакет, прочитанный на 3 позиции, ничего не
сообщает о позиции 11: такая точка не является доказательством отсутствия и в
знаменатель Top-10 не входит.

```text
answers_band(point, N) = capture_depth >= N OR (rank != null AND rank <= N)

Top-N coverage = |{ valid points : answers_band AND rank <= N }|
               / |{ valid points : answers_band }|

Outside Top-20 = 1 − Top-20 coverage, по тому же знаменателю
```

Пустой знаменатель даёт `UNKNOWN`, не 0 %.

**Average rank** требует явной политики пропусков. Политика: усредняются только
точки, где цель найдена; отдельно публикуется `found_points / valid_points`.
Замена ненайденной точки на `21` или на `depth+1` запрещена — это выдуманное
наблюдение.

**Share of Local Voice.** Знаменатель — занятые слоты, а не `точки × глубина`:
пакет, вернувший две позиции из трёх, третьего слота не имел, и его учёт молча
занизит долю всем. Одна сущность на одной точке считается один раз.

```text
SoLV(entity) = слоты rank<=D, занятые entity / все занятые слоты rank<=D
               по точкам с capture_depth >= D
```

**Review velocity** нормируется к 30 дням; отсутствующий счётчик даёт `null`,
не 0. Темы и sentiment сохраняются только вместе с `analysis_method_version` —
интерпретация без названного метода является мнением, поданным как измерение.

**Grid geometry.** Точки генерируются один раз и замораживаются в
`sv_grid_definitions` / `sv_grid_points`. Шаг по долготе корректируется на
косинус широты центра. Координаты округляются до 6 знаков (`numeric(9,6)`).
Пересчёт точек на чтении запрещён: иначе будущая правка округления бесшумно
сдвинет прошлогоднюю карту.

## 10. Competitive Intelligence — расширение

Существующий слой отвечает «кого чаще упоминают». Расширение отвечает «где
именно и за счёт каких наблюдаемых различий».

Добавляется: разрез по территории (grid point), по каналу, по запросу; таблица
наблюдаемых различий конкурента (число и скорость отзывов, совпадение
категории, наличие тематической страницы, цитируемые источники).

Формулировки: **observable differences** и **contributing signals**. Запрещено
«Competitor A выигрывает, потому что…» без измерения; разрешено «у Competitor A
наблюдаются такие отличия, измеренные тогда-то». Каждое различие несёт
`evidence_ids`.

## 11. Новые API, jobs, adapters, состояния, экраны

**API** (все под существующей ключевой аутентификацией `/api/v1/selena/*`,
все за своим gate, при выключенном gate — 404 до аутентификации):

```text
POST /api/v1/selena/locations/:id/grids            создать grid definition
GET  /api/v1/selena/locations/:id/grids/:gridId    точки и версия
POST /api/v1/selena/local/cycles                   план локального цикла
GET  /api/v1/selena/local/cycles/:id               статус, expected/created
GET  /api/v1/selena/local/cycles/:id/coverage      Top-3/10/20, SoLV, UNKNOWN
POST /api/v1/selena/reputation/snapshots           снимок периода
POST /api/v1/selena/actions                        предложить действие
POST /api/v1/selena/actions/:id/approve            утверждение владельцем
POST /api/v1/selena/change-events                  зафиксировать изменение
POST /api/v1/selena/verification-cycles            назначить повторный замер
GET  /api/v1/selena/attribution/:verificationId    оценка атрибуции
POST /api/v1/selena/outcomes                       connected/uploaded значения
GET  /api/v1/selena/map                            read-model карты
```

**Jobs** (отдельные очереди, чтобы падение и retry не пересекались):

```text
selena-local-measure          одна координата × запрос × повтор
selena-reputation-snapshot    один источник × период
selena-verification-run       повторный замер по расписанию действия
selena-attribution-assess     расчёт после закрытия verification cycle
```

**Provider adapters.** Локальный ранк-провайдер добавляется тем же механизмом,
что и существующие: имя адаптера должно попасть в
`ownerApprovedMeasurementAdapters` — это отдельное решение владельца вместе с
креденшелами и провайдерным капом. До этого в реестре только инертные адаптеры.

**Новые состояния.** Цикл локального измерения повторяет словарь
`sv_cycle_status` (включая `CARDINALITY_INCIDENT`) — новый словарь не заводится.
Добавляются: `sv_action_status`, `sv_change_verification`
(`DECLARED` / `EVIDENCED` / `DISPUTED`), `sv_attribution_verdict`,
`sv_attribution_confidence`.

**Экраны.** Внутри существующего маршрута кабинета, по правилам
`CABINET_MODEL.md` (закрытый шаг показывается закрытым, а не прячется):
портфель поверхностей на главной; Visibility Map; Local coverage; Reputation;
Action board с жизненным циклом; Before/After; Attribution с confidence и
ссылками на доказательства.

## 12. Cost и cardinality для новых доменов

Grid умножает всё. Существующего капа AI-домена недостаточно.

```text
expected_local_observations = grid_points × keywords × repeats
```

- worst-case стоимость считается **до** запуска и замораживается в
  Configuration Lock вместе с составом;
- потолок точек grid по умолчанию 49 (7×7); превышение — решение владельца,
  а не параметр формы;
- попытка создать наблюдение `expected + 1` блокируется до вызова провайдера,
  как это уже сделано для AI-прогонов и ручного пилота;
- retry разрешён только для конкретной невалидной координаты и не увеличивает
  expected;
- emergency stop прекращает новые вызовы домена, не трогая другие домены;
- `sv_cost_events` получает `domain_id`; лимиты считаются по домену и по заказу.

## 13. Pricing and package impact

Каталог зафиксирован (`SELENA_PRODUCT_CATALOG_LOCK_V1.md`), изменение цен и
состава — решение владельца. Ниже предложение по составу модулей, не изменение
каталога.

| Пакет | AI | Local | Search | Reputation | Map | Action Engine | Outcome |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| AI Visibility (текущие планы) | ✔ | — | — | — | — | рекомендации | — |
| Local Visibility | — | ✔ | — | базовый | ✔ | рекомендации | — |
| Visibility OS | ✔ | ✔ | ✔ | ✔ | ✔ | полный цикл | опционально |
| Monitor (периодический) | ✔ | ✔ | — | ✔ | ✔ | verification | — |
| Multi-location | по локациям | ✔ | — | ✔ | ✔ | полный цикл | опционально |
| Connected Outcomes | — | — | — | — | — | — | ✔ |

Ограничения: Outcome продаётся только при подключённых или загруженных данных;
Multi-location требует пройденного Gate 11; ни один пакет не продаётся до
прохождения соответствующих gates.

## 14. Обратная совместимость с AI Visibility Core

- существующие циклы, прогоны и локи не мигрируют и не переписываются;
- `sv_runs` не получает ни одной колонки под другие домены;
- существующие отчёты и экспорты воспроизводятся байт в байт (Gate 1);
- зонтичный реестр M1 заполняется для существующих AI-циклов backfill-скриптом
  **файлом**, применение — решение владельца;
- если совместимость требует представления, это `VIEW` поверх `sv_cycles`, а не
  перенос данных;
- новые необязательные блоки Configuration Lock не читаются старым кодом;
  отсутствие блока — легальное состояние, а не ошибка.

## 15. Out of scope на первом этапе

- автоматическое редактирование Google Business Profile;
- автоматические ответы на отзывы;
- автоматическая публикация чего бы то ни было;
- любые гарантии роста;
- revenue attribution без connected data;
- единый непрозрачный Overall Score;
- автоматизированный доступ к Ask Maps (остаётся `MANUAL_ONLY`);
- Google Places API;
- применение миграций, включение живых адаптеров, креденшелы, продовые флаги.

## 16. Открытые решения владельца

1. Расхождение «ТЗ v1.1» и фактических v1.3/v1.4 (§0).
2. Провайдер локального ранга и его включение в allowlist адаптеров.
3. Потолок точек grid и потолок стоимости локального цикла.
4. Изменение каталога под новые пакеты (§13).
5. Порядок применения миграций M1–M6 и момент backfill зонтичного реестра.
6. Юридический режим сбора отзывов у конкретных площадок.

## 17. Разделение потоков

`Selena Control Room` и `Selena Visibility OS` — разные потоки. Текущий gate
Control Room: `DISPOSABLE_DB_PASS; STAGING NOT AUTHORIZED`. Общих миграций,
общих очередей и общих PR у потоков нет. Один PR не должен трогать оба.

Следующий шаг Visibility OS: утверждение этой Delta →
`SELENA_VISIBILITY_OS_MIGRATION_PLAN_V2.md` →
`SELENA_VISIBILITY_OS_ACCEPTANCE_GATES_V2.md` →
`SELENA_VISIBILITY_OS_TZ_CODEX_V2.md` (задание исполняющему агенту) → фазы
реализации.
