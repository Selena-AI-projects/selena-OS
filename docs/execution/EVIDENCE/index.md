# Указатель доказательств

Каждая строка отвечает на вопрос «чем это доказано» и не более того. Разные
классы доказательств не смешиваются: зелёные тесты, успешный деплой и живая
проверка в браузере доказывают разное.

Секретов здесь нет: переменные названы по именам, значения не приводятся.

## Коммиты

### parkourcafe/Aether-Medium, ветка `claude/new-session-r64y7u`

| SHA | Что закрывает |
|---|---|
| `8dff675` | Обязательное шифрование настроек, конверт `enc:v2`, три закрытые утечки диагностики |
| `ccbd1ad` | Проверка сертификата сервера БД |
| `a2af0a6` | Сверка реестра миграций и устранение корневой причины дрейфа |
| `418073e` | Иммутабельные записи одобрений (`0020`) и укрепление роли при регистрации (`0021`) |
| `09fef03` | Запрет wildcard-origin в CORS, правила эксплуатации в `docs/SETUP.md` |
| `6f9b02d` | Ключом шифрования может быть любая случайная строка |
| `25b5420` | Слияние с развёрнутой веткой, перенумерование миграций одобрений |
| `27ff086` | Версионированный контракт событий моста, outbox `0022` |

Базовая точка: `fc67769` — вершина развёрнутой ветки на момент слияния.

### parkourcafe/selena-OS, ветка `claude/new-session-r64y7u`

| SHA | Что закрывает |
|---|---|
| `0c06f3e` | Пакет доказательств: SNAPSHOT, DECISIONS, RECOVERY, REMAINING_BLOCKERS, унаследованный контекст |

### parkourcafe/selena-ai-visibility

Изменений нет. Рабочее дерево чистое, коммитов не создавалось. Репозиторий
использовался только для доказательства разделения продуктов.

## Прогоны тестов

| Команда | Где | Результат |
|---|---|---|
| `ruff check app tests scripts` | Aether `backend/` | чисто |
| `pytest -q` | Aether `backend/` | **227 passed** (базовая точка — 137) |
| `pnpm exec turbo run check-types` | selena-OS | 13 задач, 0 ошибок |
| `pnpm test` | selena-OS | 94 файла, **1010 passed**, 0 failed, 0 skipped |
| `pnpm build` | selena-OS | 16 задач, успех |
| `bash tools/verify-railway-targets.sh` | selena-OS | PASS |

Замечание: скрипта `pnpm typecheck` в selena-OS нет, задача называется
`check-types`. Отчёт о падении `pnpm typecheck` означал бы именно это, а не дефект.

## Репетиции на одноразовых базах

Все проводились на локальном Postgres 16, к живым базам не подключались.

### Перешифровка настроек

```
до:    plaintext: 5, current_key: 0
apply: re-wrapped: 5
после: plaintext: 0, current_key: 5
повтор: nothing to re-wrap
pg_dump --data-only --table=public.app_settings | grep -c REHEARSAL  →  0
несекретная настройка MONTHLY_BUDGET_USD осталась значением 100
```

### Ротация ключа шифрования

```
новый ключ основным, старый в SETTINGS_ENCRYPTION_KEYS_RETIRED
re-wrapped: 5
чтение только новым ключом:  telegram ok / smtp ok / budget ok
чтение только старым ключом: DecryptionError — значит перешифровка реальна
```

### Сверка реестра миграций

```
дрейф воспроизведён: в реестре 7 строк, физически объекты через 0018
dry run: applied but unrecorded: 11, not applied: 0  (ничего не записано)
apply:   recorded: 11
повтор:  ledger already agrees with the schema
diff дампов схемы до/после (без nonce pg_dump): пусто
```

Негативный прогон:

```
drop table agents cascade
apply → exit 1
error: these migrations are missing objects and must be applied properly,
       not recorded: 0012_agent_registry.sql
строк записано: 0 (транзакция откатилась)
```

Проверка `--undo`:

```
--undo 0018_n8n_bridge_outbox.sql → строка реестра удалена
to_regclass('public.n8n_bridge_outbox') is not null → t  (таблица на месте)
```

### Миграции selena-OS

Дважды на чистой базе: сырым psql (32/32) и собственным раннером репозитория
`packages/lib/scripts/run-migrations.mjs` («migrations applied successfully»).

```
схемы:   selena_registry, selena_release, selena_audit,
         selena_ingest_raw, selena_performance
таблицы: 18 в приватных схемах, 41 в public
роли:    10, приватные схемы принадлежат selena_schema_owner
журнал drizzle: 32 записи
```

## Живые изменения

Все — через MCP провайдера, строка подключения не читалась и не выводилась.

| Что | Доказательство |
|---|---|
| Сверка реестра Aether | было 7 строк → стало 18; `public` содержит 18 таблиц до и после |
| Миграция `agent_mcp_servers` | `mcp_servers_column: true`, реестр 19 строк, новейшая запись `20260902102413 agent_mcp_servers` |
| Домен studio | custom domain `19d3bb27` на порт 8080; в списке доменов сервиса остались `os.selenasystems.com` и Railway-адрес |
| Проект `selena-os-staging` | `f8d94e6a-d0d9-4166-8ad5-828c1e0679fa`; Postgres `86c716c9` deployment SUCCESS, том `selena-os-staging-pgdata` |

## Проверка отсутствия публикаций

Вызовов create-post: **0**. Ни один код, добавленный в этом прогоне, не
обращается к внешнему сервису публикации. Флаги мостов не включались:
`N8N_BRIDGE_ENABLED` и `KAITEN_SYNC_ENABLED` не трогались, а новый мост
Control Room выключен по умолчанию (`CONTROL_ROOM_BRIDGE_ENABLED` не задан) и
покрыт тестом `test_bridge_is_off_by_default`.

## Разделение баз и продуктов

Без раскрытия значений:

- Aether → Supabase `iztqbgyytgcokfdpmfan`;
- AI Visibility → Postgres-сервисы Railway-проекта `selena-ai-visibility`
  (`51dd0770-e622-4734-a705-ace401234bb8`);
- Selena OS → новая база в проекте `selena-os-staging`, отдельная от обоих;
- ни один Railway-сервис не собирается из `parkourcafe/selena-OS`;
- миграции `0021+` у selena-OS и selena-ai-visibility несовместимы по номерам и
  пересекаются по именам таблиц в `public` — одна база им технически невозможна.
