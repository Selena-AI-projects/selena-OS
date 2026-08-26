# Selena Visibility OS — Acceptance Gates V2

Приложение к `SELENA_VISIBILITY_OS_ARCHITECTURE_DELTA_V2.md` и
`SELENA_VISIBILITY_OS_MIGRATION_PLAN_V2.md`.

Gate бинарен. «Реализовано примерно» не является состоянием. Пока все критерии
gate не выполнены и не подтверждены артефактом, gate имеет статус `FAIL` или
`NOT_STARTED` — промежуточных значений нет.

Статус документа: `GATES_DRAFT — NOT APPROVED`. Ни один gate не запускался.

## 0. Матрица приёмки

| # | Gate | Пакет | Что блокирует до прохождения | Артефакт доказательства | Статус |
|---|---|---|---|---|---|
| 1 | `AI_CORE_NO_REGRESSION_PASS` | M1 | любую работу по OS | прогон существующих тестов + сверка экспортов | `NOT_STARTED` |
| 2 | `MEASUREMENT_DOMAIN_ISOLATION_PASS` | M1, M3 | M2 | юниты изоляции + прогон на scratch-базе | `NOT_STARTED` |
| 3 | `LOCAL_MEASUREMENT_SCHEMA_PASS` | M2 | локальные измерения | DB-constraint тесты | `NOT_STARTED` |
| 4 | `GEO_GRID_METRICS_PASS` | M2 | показ покрытия клиенту | фиксированный fixture + юниты формул | `NOT_STARTED` |
| 5 | `READINESS_VISIBILITY_SEPARATION_PASS` | M3 | главный экран портфеля | юниты + инспекция экрана | `NOT_STARTED` |
| 6 | `EVIDENCE_LOOP_INTEGRITY_PASS` | M4, M6 | Action Engine в кабинете | цепочка на scratch-базе | `NOT_STARTED` |
| 7 | `ATTRIBUTION_GUARDRAIL_PASS` | M4, M6 | показ атрибуции клиенту | юниты таблицы решений | `NOT_STARTED` |
| 8 | `BEFORE_AFTER_REPRODUCIBILITY_PASS` | M5 | режим Before/After | юниты совместимости циклов | `NOT_STARTED` |
| 9 | `LOCAL_COST_CARDINALITY_PASS` | M2 | любой платный локальный цикл | юниты + stub-репетиция | `NOT_STARTED` |
| 10 | `VISIBILITY_MAP_DATA_INTEGRITY_PASS` | M5 | публикацию карты | инспекция read-model + a11y-проверка | `NOT_STARTED` |
| 11 | `MULTI_LOCATION_TENANT_PASS` | M6 | продажу multi-location | тесты изоляции локаций | `NOT_STARTED` |
| 12 | `VISIBILITY_OS_VERTICAL_SLICE_PASS` | все | staging-ready | сквозной прогон одного проекта | `NOT_STARTED` |

Правило проверки: ни один gate не считается пройденным по результату живого
вызова провайдера. Проверка = юниты плюс stub-репетиция против одноразовой
scratch-базы, как это уже принято в репозитории
(`pnpm -C packages/lib rehearse:selena-stub-cycle`).

## Gate 1. `AI_CORE_NO_REGRESSION_PASS`

Существующий AI-домен не пострадал.

- [ ] существующие AI measurement cycles проходят полный путь на stub;
- [ ] `expectedRunsFromScope` даёт то же число, что и до Delta, на тех же входах;
- [ ] существующие отчёты воспроизводятся: CSV-экспорт того же цикла совпадает
      строка в строку, `assertCanonicalDataset` проходит;
- [ ] старые проекты открываются в кабинете, ни один шаг не сломан;
- [ ] существующие выгрузки Evidence Ledger читаются прежним кодом;
- [ ] ни одной новой колонки в `sv_runs`, `sv_cycles`, `sv_run_permits`.

Провал: любое расхождение экспорта, любое изменение cardinality существующих
планов.

## Gate 2. `MEASUREMENT_DOMAIN_ISOLATION_PASS`

Домены не протекают друг в друга.

- [ ] запуск локального цикла не создаёт ни одной строки в `sv_runs`;
- [ ] retry AI-прогона не создаёт локальных наблюдений и наоборот;
- [ ] у каждого домена своя expected cardinality, посчитанная своей формулой;
- [ ] `sv_cost_events` разделяет расходы по `domain_id`; сумма по домену
      не включает чужие строки;
- [ ] перевод одного домена в `FAILED` оставляет остальные в прежнем статусе;
- [ ] emergency stop домена не останавливает чужие очереди.

Провал: любая строка, созданная не своим доменом.

## Gate 3. `LOCAL_MEASUREMENT_SCHEMA_PASS`

Схема локального домена держит методику сама, без помощи кода.

- [ ] одна запись на одну утверждённую координату: вставка дубля по
      `(cycle_id, location_id, keyword_id, grid_point_id, provider, repeat_index)`
      отклоняется базой, а не приложением;
- [ ] фактическое число наблюдений равно `grid_points × keywords × repeats`;
- [ ] отсутствующая точка присутствует строкой со `validity` `INVALID` или
      `UNMEASURED` и причиной — строки не исчезают;
- [ ] `capture_depth` обязателен и неотрицателен;
- [ ] `region`, `coordinate`, `keyword`, `provider` восстанавливаются из строки
      наблюдения без обращения к внешним системам;
- [ ] `sv_grid_definitions` неизменяема после первого цикла: правка создаёт
      новую версию.

Провал: любой дубль, пропущенная строка или наблюдение без глубины съёма.

## Gate 4. `GEO_GRID_METRICS_PASS`

На фиксированном fixture формулы §9 Delta дают ожидаемые значения.

- [ ] Top-3 coverage;
- [ ] Top-10 coverage;
- [ ] Outside Top-20;
- [ ] Share of Local Voice;
- [ ] average rank с явной политикой пропусков: усредняются только найденные
      точки, отдельно публикуется доля найденных; подстановка `depth+1`
      отсутствует;
- [ ] competitor comparison на том же fixture;
- [ ] точка со съёмом мельче полосы **не** попадает в знаменатель этой полосы;
- [ ] пустой знаменатель даёт `UNKNOWN`, ни одна метрика не возвращает 0 % при
      отсутствии данных.

Fixture фиксируется в репозитории вместе с ожидаемыми числами и не меняется
вместе с формулой: смена формулы = новая `formula_version` и новый fixture
рядом со старым.

Провал: любое расхождение с ожидаемым числом, любой 0 % вместо `UNKNOWN`.

## Gate 5. `READINESS_VISIBILITY_SEPARATION_PASS`

- [ ] изменение любого Readiness-балла не меняет ни одного значения Visibility;
- [ ] Visibility считается исключительно из observations измерительных доменов;
- [ ] readiness-находки несут собственный тип доказательства и не смешиваются
      с наблюдениями в одном списке;
- [ ] интерфейс нигде не подаёт readiness как позицию, ранг или присутствие;
- [ ] не существует функции, принимающей обе величины и возвращающей одну;
- [ ] на главном экране нет ни одного суммарного балла поверх поверхностей.

Провал: любой общий балл, любая формула, где readiness входит в visibility.

## Gate 6. `EVIDENCE_LOOP_INTEGRITY_PASS`

Каждый outcome прослеживается до начала цепочки.

- [ ] outcome связан с: finding, recommendation, action, change event,
      baseline cycle, verification cycle, версиями датасетов;
- [ ] `sv_approved_actions` без `evidence_ids` не создаётся;
- [ ] переход в `VERIFIED` невозможен без завершённого verification cycle;
- [ ] удаление промежуточного звена запрещено ограничением БД; там, где
      запретить нельзя, разрыв журналируется в `sv_incidents` как инцидент;
- [ ] разорванная цепочка даёт атрибуцию `INSUFFICIENT_EVIDENCE`, а не пустой
      экран и не молчаливый пропуск.

Провал: outcome, который нельзя восстановить до finding.

## Gate 7. `ATTRIBUTION_GUARDRAIL_PASS`

- [ ] значение `CAUSAL` отсутствует в типе — не в проверке, а в перечислении;
- [ ] изменение без baseline получает `NOT_MEASURED`;
- [ ] изменение без завершённой верификации получает `INSUFFICIENT_EVIDENCE`;
- [ ] несколько одновременных действий в окне (или неатрибутированный change
      event) дают `CONFOUNDED`;
- [ ] разнонаправленные метрики домена дают `MIXED_RESULT`;
- [ ] каждая оценка содержит confidence и непустой список supporting evidence
      IDs;
- [ ] порядок правил §8 Delta воспроизводится юнит-тестами по одному тесту на
      правило.

Провал: любая формулировка, утверждающая причинность, в данных или в тексте
интерфейса.

## Gate 8. `BEFORE_AFTER_REPRODUCIBILITY_PASS`

Сравнение выполняется только между совместимыми циклами. Совместимость
проверяется по всему списку:

- [ ] keyword set;
- [ ] grid definition (та же версия);
- [ ] provider;
- [ ] locale;
- [ ] device / context;
- [ ] methodology version (`formula_version`);
- [ ] dataset status.

Дополнительно:

- [ ] несовместимые циклы не показываются как before/after: экран называет
      конкретное расхождение;
- [ ] несравнимая группа даёт `UNKNOWN`, а не усреднение;
- [ ] существующий движок `selena-cycle-diff/1` остаётся в силе для AI-домена
      и не переопределяется локальной логикой.

Провал: любое сравнение, где хотя бы один пункт списка различается, а экран
показывает разницу как результат.

## Gate 9. `LOCAL_COST_CARDINALITY_PASS`

- [ ] worst-case стоимость цикла рассчитана и заморожена в Configuration Lock
      до запуска;
- [ ] scan не создаёт ни одной точки сверх grid definition;
- [ ] попытка создать наблюдение `expected + 1` блокируется **до** вызова
      провайдера и порождает `CARDINALITY_INCIDENT`;
- [ ] retry разрешён только для конкретной невалидной координаты и не
      увеличивает `expected`;
- [ ] emergency stop предотвращает новые вызовы провайдера в этом домене;
- [ ] превышение потолка точек grid отклоняется до постановки в очередь.

Провал: любой вызов провайдера сверх expected, любой retry всего grid.

## Gate 10. `VISIBILITY_MAP_DATA_INTEGRITY_PASS`

- [ ] каждая отображаемая точка связана с `observation_id`;
- [ ] tooltip показывает timestamp, provider, keyword;
- [ ] цвет не единственный носитель статуса (форма или штриховка обязательны);
- [ ] `missing`, `invalid`, `unknown` визуально различимы между собой;
- [ ] интерполяция либо отсутствует, либо явно помечена и не заменяет
      фактическое значение;
- [ ] read-model привязан к `dataset_id`, а материализованный слой несёт
      `refreshed_at` и признак устаревания.

Провал: точка на карте без наблюдения за ней.

## Gate 11. `MULTI_LOCATION_TENANT_PASS`

- [ ] данные одной локации не попадают в выборку другой;
- [ ] агрегат организации воспроизводится из датасетов локаций и совпадает с
      их суммой;
- [ ] пользователь видит только разрешённые ему локации;
- [ ] подписанные экспорты не позволяют подменить location ID;
- [ ] новые таблицы попадают под счёт RLS в `tools/selena_isolated_e2e.sh`;
- [ ] политика `tenant_isolation` существует на каждой новой таблице с
      `organization_id`.

Провал: любая строка чужой локации в выборке.

## Gate 12. `VISIBILITY_OS_VERTICAL_SLICE_PASS`

Один тестовый проект проходит путь целиком, на stub, против одноразовой базы:

```text
Create project
→ Confirm location
→ Approve local keywords
→ Create grid
→ Quote
→ Configuration Lock
→ Run AI cycle
→ Run Local cycle
→ Generate findings
→ Approve action
→ Record change event
→ Run verification
→ Generate before/after
→ Produce attribution assessment
→ Export Evidence
```

- [ ] каждый шаг оставляет запись в `sv_audit_events`;
- [ ] на выходе экспорт проходит `assertCanonicalDataset`;
- [ ] ни одного живого вызова провайдера за весь прогон;
- [ ] ни одной выдуманной цифры: всё, чего нет, помечено `UNKNOWN`.

Только после этого модуль считается staging-ready. Staging-деплой,
креденшелы и включение живых адаптеров остаются отдельными решениями
владельца и в этот gate не входят.

## Приложение. Что gate не проверяет

Gate не проверяет коммерческую готовность, не разрешает включение провайдеров и
не заменяет production acceptance record. Пройденный gate означает ровно одно:
соответствующая часть системы ведёт себя так, как описано в Delta, и это
доказано артефактом.
