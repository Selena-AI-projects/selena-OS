# ТЗ Visibility OS v2-codex — реализация пакетами, автономный режим

Исполнитель: автономный кодинг-агент (Codex или аналог). Человек не отвечает на
вопросы по ходу работы. Всё, что требует решения владельца, вынесено в «Жёсткие
запреты» и «Вне скоупа»; остальное решается правилами по умолчанию из этого
документа, а принятое решение фиксируется в описании PR.

**Предусловие.** Работа начинается после того, как владелец утвердил
`SELENA_VISIBILITY_OS_ARCHITECTURE_DELTA_V2.md` (шапка документа перестала
быть `DELTA_DRAFT — NOT APPROVED`). Единственное исключение — Фаза 0: она
ничего не добавляет в продукт, а её результат нужен для самого утверждения.

## 1. Источники правды

Прочитать до первой правки:

| Документ | Что берём |
|---|---|
| `SELENA_VISIBILITY_OS_ARCHITECTURE_DELTA_V2.md` | границы системы, домены, формулы, политика атрибуции |
| `SELENA_VISIBILITY_OS_MIGRATION_PLAN_V2.md` | состав пакетов, ограничения таблиц, §11 — правила ветвления |
| `SELENA_VISIBILITY_OS_ACCEPTANCE_GATES_V2.md` | что считается приёмкой |
| `AGENTS.md` | правила репозитория: pnpm, стиль коммитов, changesets, тесты |
| `docs/selena-visibility/TZ_v1_3_impl.md`, `TZ_v1_4_codex.md` | инварианты предыдущих ТЗ действуют и здесь |
| `docs/selena-visibility/CABINET_MODEL.md` | язык интерфейса, закрытые шаги, формулировки |
| `docs/selena-visibility/IMPLEMENTATION_STATUS_MATRIX_v1_4.md` | что уже сделано; не переделывать |
| `RC7_ARCHITECTURE_MAPPING.md` | граница Ask Maps, которую нельзя пересекать |
| `SELENA_OWNER_OPERATING_GUIDE.md` | что включает владелец; ничего из этого не включать самому |

Конфликт документов разрешается в порядке: Delta → Migration Plan →
Acceptance Gates → `AGENTS.md` → старые ТЗ. Если конфликт не разрешается —
выбрать вариант, который показывает меньше, и записать решение в PR.

## 2. Ветвление и порядок мерджа

Шаг 0 (владелец): смерджить четыре документа Visibility OS в
`release/selena-visibility-mvp`. Это только markdown, продукта они не касаются.
Если владелец этого не сделал, интеграционная ветка создаётся от
`claude/selena-visibility-os-arch-fv4b9h`, и это фиксируется в PR.

```text
release/selena-visibility-mvp                продуктовая линия, агент в неё не пишет
  └── codex/visibility-os                    интеграционная, живёт до Gate 12
        ├── codex/visibility-os-m0-economics
        ├── codex/visibility-os-m1-registry
        ├── codex/visibility-os-m2-local
        ├── codex/visibility-os-m3-search-reputation
        ├── codex/visibility-os-m4-evidence-loop
        ├── codex/visibility-os-m5-map
        └── codex/visibility-os-m6-outcome
```

Правила:

1. Одна ветка = один пакет = один PR в `codex/visibility-os`.
2. Ветка пакета создаётся от актуальной `codex/visibility-os`, **никогда** от
   ветки предыдущего пакета.
3. `release/*` вливается в `codex/visibility-os` еженедельно;
   `codex/visibility-os` вливается в ветки открытых пакетов. Обратное движение
   только через PR.
4. Rebase общей истории и force-push в `codex/visibility-os` и `release/*`
   запрещены.
5. PR пакета не мерджится, пока его gates не пройдены. Непройденный gate —
   не повод держать ветку открытой месяц: пакет мерджится только зелёным,
   иначе честно помечается в матрице и работа идёт дальше по следующему пакету.
6. В `release/*` не уходит ничего до Gate 12 и отдельного решения владельца.
7. Никаких рефакторингов существующих файлов в ветках пакетов. Правка, не
   являющаяся чистым добавлением, идёт отдельным маленьким PR в
   `release/selena-visibility-mvp`, мерджится владельцем и приезжает сверху.

## 3. Жёсткие запреты — нарушать нельзя ни при каких условиях

1. **Не применять миграции.** `drizzle-kit migrate` не запускается нигде,
   кроме одноразовой scratch-базы в тестовом контейнере.
2. **Не присваивать номера миграций в ветках.** SQL складывается в
   `packages/lib/src/db/migrations/_pending-os/` с логическими именами
   (`M2_local_visibility.sql`). Номер и запись в `_journal.json` — только на
   мердже в `release`, отдельным коммитом (§11.2 плана миграций).
3. **Не запускать `drizzle-kit generate`.** Миграции в этом репозитории
   пишутся руками; генератор переприсвоит номера и перепишет журнал.
4. **Не включать живые адаптеры и не расширять**
   `ownerApprovedMeasurementAdapters`. Registry воркера остаётся `noop`.
5. **Ни одного реального вызова провайдера** — в тестах, скриптах, при отладке.
6. **Не трогать секреты, бюджетные флаги и env деплоя.** Новые переменные —
   в `packages/config/src/env-registry.ts` с безопасным дефолтом «выключено»,
   плюс `turbo.json` globalEnv и `apps/web/src/env.d.ts` (этого требует
   существующий тест синхронизации).
7. **Не ослаблять supply-chain-контроль pnpm** (см. `AGENTS.md`).
8. **Не трогать Ask Maps.** `LOCAL_AI_DISCOVERY_POLICY` остаётся `MANUAL_ONLY`;
   `GOOGLE_MAPS_LOCAL_PACK` — отдельная поверхность и не даёт послаблений.
9. **Не трогать поток Selena Control Room** — это другой поток, другие
   миграции, другие PR.
10. **Не менять каталог, цены и состав пакетов** (`catalog.ts`,
    `SELENA_PRODUCT_CATALOG_LOCK_V1.md`).

## 4. Правила автономной работы

- малые атомарные коммиты; тема коммита — простое повелительное предложение без
  префиксов;
- changeset только на user-facing изменение; за флагом по умолчанию выключенным
  user-facing изменения нет;
- тесты на наблюдаемое поведение, не на форму реализации; прогоны точечные,
  полный lint не запускать;
- тексты интерфейса EN + RU через существующий helper `tr()`;
- пустая группа данных — `UNKNOWN`, никогда «0 %»;
- вывод без сохранённого evidence не создаётся;
- задача не удалась — статус в матрице пишется честно, работа продолжается со
  следующей задачи, а не останавливается.

## 5. Фаза 0 — экономика цикла и фикстура микро-slice

Ветка `codex/visibility-os-m0-economics`. Допустима до утверждения Delta.

- чистая функция расчёта worst-case стоимости локального цикла: входы —
  тариф за вызов (параметр, не константа), число точек grid, число запросов,
  число повторов, политика retry; выход — worst-case и разбивка по осям.
  Никаких сетевых вызовов, никаких зашитых тарифов;
- `docs/selena-visibility/local-cycle-economics.md`: таблица сценариев
  (3×3 / 5×5 / 7×7 точек × 5 / 10 / 20 запросов × 1 / 2 повтора) в единицах
  «вызовов провайдера», колонка стоимости оставлена пустой под тариф владельца;
- фикстура микро-slice: 1 локация, 1 запрос, grid 3×3, 1 повтор = 9 наблюдений.
  В Фазе 0 фиксируется только её состав, код появляется в M2.

Приёмка: юниты на формулу; в документе явная строка «потолок точек grid и
допустимая стоимость цикла — решение владельца»; ни одного придуманного тарифа.

## 6. M1 — реестр измерений

Ветка `codex/visibility-os-m1-registry`.

- новый файл схемы `packages/lib/src/db/schema-visibility-os.ts`; в
  `schema.ts` добавляется ровно одна строка реэкспорта;
- таблицы: `sv_measurement_domains`, `sv_measurement_cycles`,
  `sv_measurement_datasets`, `sv_source_snapshots`, `sv_evidence_index`
  (ограничения — §3 плана миграций);
- **общей таблицы наблюдений не создавать**;
- SQL в `_pending-os/M1_measurement_registry.sql`: таблицы, индексы,
  `ENABLE ROW LEVEL SECURITY` и политика `tenant_isolation` на каждой;
- compatibility `VIEW` поверх `sv_cycles`, чтобы AI-домен читался через
  зонтичный интерфейс без переноса строк;
- backfill зонтичных строк — отдельный файл-скрипт, не часть миграции.

Приёмка: **Gate 1**, **Gate 2**.

## 7. M2 — Local Visibility

Ветка `codex/visibility-os-m2-local`. Самый большой пакет.

Схема и SQL (`_pending-os/M2_local_visibility.sql`) — по §4 плана миграций,
включая ключ уникальности наблюдения:

```sql
UNIQUE (cycle_id, location_id, keyword_id, grid_point_id, provider, repeat_index)
```

Контракты: новый `packages/selena-visibility-contracts/src/visibility-os.ts`,
реэкспорт из `index.ts`. Обязательный состав:

```text
surfaceFamilies, surfaceCaptureMethods
VISIBILITY_SURFACES            замороженный реестр поверхностей (§3.1 Delta)
surfaceSpec, assertSurfaceCaptureAllowed
readinessDimensions, readinessScoreSchema, surfaceVisibilitySchema
visibilityPortfolio            две семьи рядом, ни одной общей цифры
gridSpecSchema, squareGridPoints
DEFAULT_GRID_POINT_CEILING, assertGridWithinCeiling
expectedLocalObservations, assertLocalObservationCardinality
targetRank, localCoverage, shareOfLocalVoice
```

Нормативные правила, которые эти функции обязаны воплощать (§9 Delta):

- поверхность `GOOGLE_ASK_MAPS` берёт единственный допустимый способ съёма из
  `LOCAL_AI_DISCOVERY_POLICY.captureMethod`, а не повторяет его строкой;
- незарегистрированный флаг читается как выключенный;
- точка отвечает на «внутри ли Top-N» только при `capture_depth >= N` либо
  когда цель найдена на позиции ≤ N; иначе она вне знаменателя этой полосы;
- `outsideTop20` — дополнение `top20` по тому же знаменателю;
- знаменатель Share of Local Voice — занятые слоты, а не «точки × глубина»;
  одна сущность на одной точке считается один раз;
- пустой знаменатель возвращает `null`, а не 0;
- `squareGridPoints` детерминирована, корректирует шаг долготы на косинус
  широты, округляет до 6 знаков и отказывается работать там, где коррекция
  вырождается;
- функции, принимающей readiness и visibility одновременно, не существует.

Экраны: локальное покрытие внутри маршрута кабинета, закрытый шаг показывается
закрытым.

Приёмка: **Gate 3**, **Gate 4**, **Gate 9**. Fixture для Gate 4 фиксируется в
репозитории вместе с ожидаемыми числами.

## 8. M3 — Search и Reputation

Ветка `codex/visibility-os-m3-search-reputation`. Состав таблиц — §5 плана.

Search-домен добавляется только схемой и остаётся выключенным: провайдера нет,
gate выключен, данных не пишется.

Функции репутации (в `visibility-os.ts`):

```text
assertReputationAnalysis       темы и sentiment невозможны без analysis_method_version
reviewVelocityPer30Days        нормировка к 30 дням; отсутствующий счётчик → null
```

Приёмка: **Gate 2** (повторно, теперь на трёх доменах), **Gate 5**.

## 9. M4 — Action Engine и Evidence Loop

Ветка `codex/visibility-os-m4-evidence-loop`. Таблицы — §6 плана.

Контракты: новый `packages/selena-visibility-contracts/src/evidence-loop.ts`:

```text
actionStatuses, ACTION_TRANSITIONS, assertActionTransition
assertActionApproval           нет evidence_ids или утвердившего → отказ
changeVerifications            DECLARED / EVIDENCED / DISPUTED
DEFAULT_SETTLE_DAYS = 14, assertVerificationWindow
outcomeAccessClasses           только CONNECTED и UPLOADED
outcomeMetrics, assertOutcomeProvenance
attributionVerdicts            семь значений, CAUSAL отсутствует в типе
attributionConfidences, assessAttribution
```

`assessAttribution` реализует порядок правил §8 Delta буквально: первое
сработавшее правило выигрывает, по одному юнит-тесту на правило. Confidence
считается только для исходов `MIXED_RESULT`, `NO_OBSERVED_CHANGE`,
`POSITIVE_CORRELATION`, `NEGATIVE_CORRELATION`: начинает с `HIGH`, понижается на
шаг за каждый признак слабости, пол — `LOW`.

Переход действия в `VERIFIED` возможен только из `IMPLEMENTED` и только при
завершённом verification cycle. Разорванная цепочка даёт
`INSUFFICIENT_EVIDENCE` и запись в `sv_incidents`, а не пустой экран.

Приёмка: **Gate 6**, **Gate 7**.

## 10. M5 — Visibility Map

Ветка `codex/visibility-os-m5-map`. Состав — §7 плана.

Отдельных таблиц под слои интерфейса не создавать. В каждой строке read-model
обязан присутствовать `observation_id`; материализованный слой несёт
`refreshed_at` и признак устаревания. Статусы `missing` / `invalid` /
`unknown` различимы не только цветом.

Приёмка: **Gate 8**, **Gate 10**.

## 11. M6 — Outcome Layer

Ветка `codex/visibility-os-m6-outcome`. Состав — §8 плана.

`access_class` ограничен `CONNECTED` и `UPLOADED` на уровне `CHECK`. Значение
без источника не сохраняется. Выручка и продажи не выводятся из видимости ни
при каких условиях.

Приёмка: **Gate 6** и **Gate 7** повторно на реальных outcome-данных,
**Gate 11**.

## 12. Интеграция и выход в release

1. Каждый смердженный пакет обновляет свою строку в матрице статусов.
2. **Gate 12** прогоняется на `codex/visibility-os`, а не на ветке пакета.
3. Присвоение номеров миграций — один коммит на мердже в `release`:
   переименование файлов из `_pending-os/` по фактическому head плюс записи в
   `_journal.json`, нумерация без пропусков.
4. **Gate 1** прогоняется на мердж-коммите в `release`. Зелёная ветка и зелёный
   мердж — разные утверждения.
5. PR в `release/selena-visibility-mvp` готовит агент, мерджит владелец. В
   описании — полный перечень изменений, список миграций к применению и список
   env-переменных с их выключенным состоянием.

## 13. Формат PR каждого пакета

- что добавлено, одним абзацем;
- какие gates пройдены и чем именно доказаны (юниты, stub-репетиция, fixture);
- какие gates не пройдены и почему — честно, без смягчения;
- какие файлы лежат в `_pending-os/` и что владельцу предстоит применить;
- какие env-переменные добавлены и что означает их выключенное состояние;
- какие неоднозначности решены по умолчанию и как.

## 14. Матрица статусов

Создать `docs/selena-visibility/IMPLEMENTATION_STATUS_MATRIX_v2_0.md` — только
по Visibility OS. `IMPLEMENTATION_STATUS_MATRIX_v1_4.md` остаётся записью по
AI-ядру и не помечается устаревшей.

Статусы читаются как в v1.3/v1.4. Миграции не применены → ни одна строка не
выше `SCHEMA_EXISTS-in-branch`, ни одна не `RELEASED`.

## 15. Вне скоупа

- применение любых миграций к любой базе;
- включение живых адаптеров, креденшелы, бюджетные env, платежи, KYC, деплой,
  DNS;
- автоматический доступ к Ask Maps, Google Places;
- автоматическое редактирование GBP, автоответы на отзывы, автопубликация;
- revenue attribution без connected data;
- единый общий Overall Score в любом виде;
- маркетинговый сайт (другой репозиторий);
- поток Selena Control Room.

## 16. Критерий готовности

Работа считается завершённой, когда: все пакеты либо смерджены в
`codex/visibility-os` зелёными, либо честно помечены в матрице с причиной;
Gate 12 пройден на интеграционной ветке; PR в `release/selena-visibility-mvp`
открыт с полным перечнем изменений, миграций и env, которые владелец применяет
сам. Мердж в `release` выполняет владелец, не агент.
