# Selena Visibility OS — Migration Plan V2

Приложение к `SELENA_VISIBILITY_OS_ARCHITECTURE_DELTA_V2.md`. План миграций
логическими пакетами: что добавляется, в каком порядке, с какими ограничениями
и каким gate закрывается.

Статус: `MIGRATION_PLAN_DRAFT — NOT APPROVED`. Ни один файл миграции по этому
плану не написан и не применён.

## 0. Проверенный migration head

| Что | Значение |
|---|---|
| Последний файл | `packages/lib/src/db/migrations/0036_selena_order_requests.sql` |
| Последняя запись журнала | `_journal.json`, `idx: 36` |
| Первый свободный номер | `0037` |
| Применено к продовой базе | ничего из 0025–0036 |

Номера файлов присваиваются в момент реализации, а не сейчас: между
утверждением плана и первым коммитом head может сдвинуться. При параллельной
разработке в отдельной ветке номер присваивается только на мердже — §11.2. Пакет M1 может
занять несколько номеров — соответствие «пакет = один файл» не требуется.
Обязательное правило: номер файла и запись в `_journal.json` добавляются в
одном коммите, нумерация продолжает существующую без пропусков.

## 1. Правила, обязательные для каждого пакета

1. **Не применять.** `drizzle-kit migrate` не запускается ни против одной базы,
   кроме одноразовой scratch-базы в тестовом контейнере. Применение — акт
   владельца.
2. **Только аддитивно.** Ни одна существующая таблица, колонка, enum или
   индекс не изменяется и не удаляется. Новые колонки к существующим таблицам —
   только `NULL`-able и без `DEFAULT`, требующего переписывания таблицы.
3. **Префикс `sv_`** у всех новых таблиц. CI считает покрытие RLS по маске
   `sv_%` (`tools/selena_isolated_e2e.sh`); таблица без префикса выпадает из
   проверки tenant-изоляции.
4. **RLS в том же файле**: `ENABLE ROW LEVEL SECURITY` плюс политика
   `tenant_isolation` по образцу 0034/0036 для каждой таблицы, несущей
   `organization_id`.
5. **`organization_id text NOT NULL REFERENCES organization(id)`** у всякой
   таблицы с клиентскими данными. Исключение — только заведомо безтенантные
   справочники, и такое исключение обосновывается в комментарии файла.
6. **Иммутабельность наблюдений.** Наблюдение не обновляется: исправление —
   новая версия со ссылкой на предыдущую (`supersedes_*_id`), как в
   `sv_local_observations`.
7. **Версионирование расчётов.** Любая производная таблица несёт
   `formula_version` и `dataset_id`.
8. **Backfill — отдельным файлом-скриптом**, не внутри миграции схемы, и
   запускается владельцем.

## 2. Dependency graph

```text
                        M1  Measurement registry
                    (домены, циклы, датасеты, evidence index)
                                   │
        ┌──────────────────┬───────┴────────┬──────────────────┐
        │                  │                │                  │
   M2 Local          M3 Search/Reputation   │                  │
   Visibility                               │                  │
        │                  │                │                  │
        └──────────┬───────┘                │                  │
                   │                        │                  │
              M4 Action и Evidence Loop ────┘                  │
                   │                                           │
        ┌──────────┴──────────┐                                │
        │                     │                                │
   M5 Visibility Map    M6 Outcome Layer ◄──────────────────────┘
   (read-models)        (connected/uploaded)
```

Жёсткие зависимости:

- M2, M3 требуют M1 (домен и цикл обязаны быть зарегистрированы);
- M4 требует M1 и хотя бы один измерительный пакет — verification cycle не на
  чем запускать;
- M5 требует M2 (карта без координат бессмысленна) и читает M3/M4, если они
  есть;
- M6 не зависит от M2/M3 технически, но без M4 не имеет смысла: outcome без
  change event не участвует в атрибуции;
- каждый пакет самостоятельно проходит свой gate до начала следующего.

## 3. Migration batch M1 — Measurement domains

Реестр и версионирование. **Общей таблицы наблюдений здесь нет** — обоснование
в §2.3 Delta.

| Таблица | Назначение | Ключевые ограничения |
|---|---|---|
| `sv_measurement_domains` | справочник доменов и их единиц измерения | `UNIQUE(domain_id)`; строки: `AI`, `SEARCH`, `LOCAL`, `REPUTATION`, `OUTCOME` |
| `sv_measurement_cycles` | зонтичная запись цикла | `UNIQUE(domain_id, domain_cycle_id)`; FK на `sv_configuration_locks` |
| `sv_measurement_datasets` | версия датасета для любого расчёта | `UNIQUE(organization_id, dataset_key, version)`; `immutable boolean NOT NULL DEFAULT true` |
| `sv_source_snapshots` | снимок источника, общий для доменов | `UNIQUE(organization_id, content_sha256)` |
| `sv_evidence_index` | тонкий индекс наблюдений | `UNIQUE(domain_id, observation_ref)`; индекс по `(organization_id, cycle_id)` |

Существующие AI-циклы **не переносятся**. Решение по совместимости:

- вариант «перенести `sv_runs` в общую таблицу» — отклонён: ломает
  иммутабельность проданных циклов, воспроизводимость экспортов и ссылки
  Configuration Lock;
- вариант «compatibility `VIEW` поверх `sv_cycles`» — принят как способ читать
  AI-домен через зонтичный интерфейс без переноса строк;
- вариант «постепенный backfill зонтичной строки на каждый существующий цикл» —
  принят как отдельный файл-скрипт, применяется владельцем после M1; до
  применения AI-домен виден через `VIEW`.

Gate пакета: **Gate 1** (`AI_CORE_NO_REGRESSION_PASS`) и **Gate 2**
(`MEASUREMENT_DOMAIN_ISOLATION_PASS`).

## 4. Migration batch M2 — Local Visibility

Локации уже есть: `sv_entities` и `sv_business_locations`. Отдельные
`locations` / `location_profiles` не создаются — вместо этого расширяются
существующие.

| Таблица | Назначение | Ключевые ограничения |
|---|---|---|
| `sv_business_locations` (EXTEND) | профиль локации | новые `NULL`-able колонки профиля; ничего не переименовывается |
| `sv_local_keywords` | локальные запросы локации | `UNIQUE(location_id, normalized_text, language)`; статус `PROPOSED/APPROVED/REJECTED` как у сценариев |
| `sv_grid_definitions` | замороженная геометрия | `UNIQUE(location_id, version)`; `point_count`, `spacing_meters`, `shape`, `formula_version`; иммутабельна после первого цикла |
| `sv_grid_points` | точки сетки | `UNIQUE(grid_id, point_index)`; `latitude/longitude numeric(9,6) NOT NULL` |
| `sv_local_scan_cycles` | цикл локального измерения | FK на `sv_measurement_cycles`, `sv_configuration_locks`, `sv_grid_definitions`; `expected_observations`, `created_observations`, статус из существующего словаря `sv_cycle_status` |
| `sv_local_rank_observations` | одно наблюдение выдачи | ключ ниже; `validity`, `invalid_reason`, `capture_depth NOT NULL`, `capture_mode`, `raw_reference`, `captured_at` |
| `sv_local_competitor_observations` | ранжированные записи внутри наблюдения | `UNIQUE(observation_id, rank)`; `matched_entity_id NULL`-able, `match_status` |
| `sv_local_visibility_metrics` | производные покрытия | `UNIQUE(cycle_id, keyword_id, formula_version)`; значения `NULL`-able = `UNKNOWN` |

Ключ уникальности наблюдения — тот, что защищает cardinality:

```sql
UNIQUE (cycle_id, location_id, keyword_id, grid_point_id, provider, repeat_index)
```

`repeat_index` добавлен к предложенному в задании ключу намеренно: без него
второй повтор той же координаты нарушает constraint, а повторы — часть
методики стабильности.

Дополнительно:

- `CHECK (capture_depth >= 0)` — глубина съёма обязательна, на ней стоит вся
  арифметика покрытия (§9 Delta);
- отсутствующая точка не удаляется: строка создаётся со `validity` в
  `INVALID` / `UNMEASURED` и причиной. Пропавших строк быть не должно, иначе
  фактическое число наблюдений разойдётся с ожидаемым;
- `sv_cost_events` получает `domain_id` в этом же пакете.

Gate пакета: **Gate 3**, **Gate 4**, **Gate 9**.

## 5. Migration batch M3 — Search и Reputation

| Таблица | Назначение | Ключевые ограничения |
|---|---|---|
| `sv_search_queries` | запрос поискового домена | `UNIQUE(project_id, normalized_text, engine, region, device)` |
| `sv_search_rank_observations` | наблюдение позиции | `UNIQUE(cycle_id, query_id, engine, region, device, repeat_index)` |
| `sv_reputation_sources` | площадка отзывов для локации | `UNIQUE(location_id, source)` |
| `sv_review_snapshots` | срез периода | `UNIQUE(source_id, period_start, period_end)`; `rating_average`, `review_count`, `new_reviews` — все `NULL`-able |
| `sv_review_velocity_metrics` | нормированная скорость | `UNIQUE(source_id, period_start, period_end, formula_version)` |
| `sv_review_topic_observations` | темы и sentiment | `CHECK`: строка недопустима без `analysis_method_version` |

Search-домен добавляется схемой, но остаётся выключенным до появления своего
провайдера и gate; таблицы без данных ничего не стоят и снимают соблазн
дописывать поиск в чужой домен.

Gate пакета: **Gate 2**, **Gate 5**.

## 6. Migration batch M4 — Action и Evidence Loop

| Таблица | Назначение | Ключевые ограничения |
|---|---|---|
| `sv_approved_actions` | действие и его жизненный цикл | `source_kind` (`CYCLE_RECOMMENDATION` / `ENGINE_ACTION` / `MANUAL`) + `source_ref`; `status` из `sv_action_status`; `evidence_ids text[] NOT NULL` |
| `sv_action_approvals` | кто и когда утвердил | `UNIQUE(action_id, approval_version)`; `approved_by NOT NULL` |
| `sv_change_events` | что реально сделано | `action_id` `NULL`-able (`UNATTRIBUTED`); `occurred_at NOT NULL`; `verification` — `DECLARED/EVIDENCED/DISPUTED` |
| `sv_change_event_assets` | доказательства изменения | непрозрачная ссылка на объект, backend её не разыменовывает |
| `sv_verification_cycles` | повторный замер | FK на baseline и на цикл повторного измерения; `settle_days NOT NULL`; `UNIQUE(action_id, attempt)` |
| `sv_attribution_assessments` | оценка | `verdict` и `confidence` из enum; `evidence_ids text[] NOT NULL`; `CHECK (cardinality(evidence_ids) > 0)`; `UNIQUE(verification_cycle_id, metric_key, formula_version)` |

Имя `sv_approved_actions`, а не `actions`: рядом уже существует
`sv_recommendation_actions` — выход движка рекомендаций. Это разные сущности:
движок предлагает, владелец утверждает.

Словарь `sv_attribution_verdict` создаётся ровно из семи значений
(`POSITIVE_CORRELATION`, `NEGATIVE_CORRELATION`, `NO_OBSERVED_CHANGE`,
`MIXED_RESULT`, `INSUFFICIENT_EVIDENCE`, `CONFOUNDED`, `NOT_MEASURED`).
Значения `CAUSAL` в типе нет — запрет держится схемой, а не ревью.

`sv_findings` и `sv_recommendations` получают `NULL`-able `domain_id` и
`location_id` в этом же пакете.

Gate пакета: **Gate 6**, **Gate 7**.

## 7. Migration batch M5 — Visibility Map

Отдельная таблица под каждый слой интерфейса не создаётся. Нужны:

- канонические read-model'и (представления либо агрегатные таблицы) по
  `(project, location, period, dataset_id)`;
- привязка к версии датасета: карта показывает срез, а не «сейчас»;
- географическое представление точек, пригодное для выборки по области;
- сравнение периодов одной парой `(baseline_dataset_id, current_dataset_id)`;
- обязательная сохранность `observation_id` в каждой строке read-model —
  без неё Gate 10 не проходится.

Решение материализовать или считать на лету принимается по факту объёма
на первом реальном multi-location проекте, а не заранее. Если материализовать —
обязателен `refreshed_at` и признак устаревания, иначе карта тихо покажет
позавчерашний день как сегодняшний.

Gate пакета: **Gate 8**, **Gate 10**.

## 8. Migration batch M6 — Outcome Layer

| Таблица | Назначение | Ключевые ограничения |
|---|---|---|
| `sv_outcome_sources` | подключённый или загруженный источник | `access_class` только `CONNECTED` / `UPLOADED`; `CHECK` на уровне БД |
| `sv_outcome_metric_definitions` | что означает метрика | `UNIQUE(metric_key, version)`; единица измерения обязательна |
| `sv_outcome_observations` | значение за период | `UNIQUE(source_id, metric_key, period_start, period_end)`; `value numeric NULL`-able = `UNKNOWN` |
| `sv_outcome_attribution_windows` | окно сопоставления с изменением | FK на `sv_verification_cycles`; `window_start/window_end NOT NULL` |

Значение без источника не сохраняется. Отсутствие данных — `UNKNOWN`, а не 0 и
не оценка. Выручка и продажи не выводятся из видимости ни при каких условиях.

Gate пакета: **Gate 6**, **Gate 7**, **Gate 11**.

## 9. Порядок работ и точки остановки

```text
M1 → Gate 1, Gate 2 → остановка и отчёт
M2 → Gate 3, Gate 4, Gate 9 → остановка и отчёт
M3 → Gate 2 (повторно), Gate 5
M4 → Gate 6, Gate 7
M5 → Gate 8, Gate 10
M6 → Gate 6/7 (повторно), Gate 11
всё → Gate 12 (vertical slice) → staging-ready
```

Провал gate останавливает свой пакет, но не отменяет уже пройденные: пакет с
непройденным gate не считается выполненным и честно помечается в матрице
статусов.

## 10. Rollback

- каждая миграция аддитивна, поэтому откат — `DROP` только созданных объектов
  в обратном порядке; файл отката пишется вместе с миграцией;
- данные существующих доменов при откате не затрагиваются;
- обратный скрипт не удаляет `sv_audit_events` и `sv_incidents`: журнал
  переживает откат схемы;
- откат применяет владелец, теми же правами, что и применение.

## 11. Ветвление и порядок мерджа

Решение владельца: текущий продукт замораживается и запускается как есть,
Visibility OS разрабатывается параллельно в отдельной ветке и вливается в
основную позже.

### 11.1 Предпочтительный режим — мердж пакетами по gate

Рекомендация: не копить всё до одного большого мерджа. Пакет, прошедший свои
gates, вливается в основную ветку сразу, с выключенным флагом и неприменёнными
миграциями. Продакшн при этом не видит ничего нового — изоляцию даёт не ветка,
а дисциплина default-off, которая в репозитории уже действует: адаптеры
инертны, миграции не применяются, флаги выключены по умолчанию.

Причина рекомендации: риск для запускаемого продукта в обоих режимах
одинаковый, а события «большой мердж» во втором просто не существует.

### 11.2 Правила долгоживущей ветки

Если пакеты всё же копятся в одной ветке, эти четыре правила обязательны — без
них ветка не доживает до мерджа.

1. **Номера миграций в ветке не присваиваются.** SQL складывается в
   `packages/lib/src/db/migrations/_pending-os/` с логическими именами
   (`M2_local_visibility.sql`). Номер файла и запись в `_journal.json`
   появляются одним коммитом в момент мерджа, по фактическому head на тот
   момент. Иначе ветка и основная линия занимают один и тот же номер, а
   конфликт в журнале миграций разрешается руками и ценой неопределённого
   состояния базы.
2. **Таблицы OS живут в отдельном файле схемы** —
   `packages/lib/src/db/schema-visibility-os.ts`, реэкспорт из `schema.ts`
   одной строкой. `schema.ts` описывает таблицу одной длинной строкой, поэтому
   правки с двух сторон дают конфликт, который глазами не читается; одна строка
   реэкспорта делает столкновение невозможным.
3. **Течение в одну сторону.** Основная ветка вливается в OS-ветку еженедельно;
   обратного слияния до готовности пакета нет, rebase общей истории запрещён.
   Долгая ветка умирает от отставания, а не от ошибок.
4. **Никаких рефакторингов в OS-ветке.** Любая правка существующих файлов, не
   являющаяся чистым добавлением, идёт отдельным PR в основную ветку,
   мерджится там и приезжает в OS-ветку сверху. Это единственное правило,
   которое сохраняет финальный мердж читаемым.

Дополнительно: `drizzle-kit generate` в OS-ветке не запускается — миграции в
этом репозитории пишутся руками, а генератор переприсвоит номера и перепишет
журнал.

### 11.3 Gate 1 проверяется на мердж-коммите

`AI_CORE_NO_REGRESSION_PASS` прогоняется на результате слияния, а не на
OS-ветке. Зелёная ветка и зелёный мердж — разные утверждения, и продукт
запускается со второго.

### 11.4 Граница с запуском

OS-ветка не касается ничего из списка запуска: применения миграций 0025–0036,
внесения адаптеров в `ownerApprovedMeasurementAdapters`, креденшелов,
включения платежей, продовых флагов, DNS и деплоя. Порядок этих действий —
`SELENA_PRODUCTION_ACTIVATION_RUNBOOK.md`, и он остаётся целиком за владельцем.

Если пакету OS понадобилось тронуть адаптеры, платежи или продовые флаги — это
сигнал, что он вышел за границы Delta, а не повод расширить ветку.
