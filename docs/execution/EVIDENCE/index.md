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
| `d700c0a` | Указатель доказательств и отчёт по безопасности |
| `7041b43` | Живая проверка укреплённых эндпоинтов Aether |
| `d142d34` | Таблица покрытия требований |
| `c87e2b2` | Provider-neutral контракт, Postiz как адаптер, `0032` |
| `67fbab8` | Blotato за контрактом, запрет публикации на трёх уровнях, `0033` |
| `8457bb3` | Раннер миграций: решение по факту базы, а не кластера |
| `a476076` | Проекция чтения релизов (`0034`) — без неё Control Room не отрисовывался |

### parkourcafe/selena-ai-visibility

Изменений нет. Рабочее дерево чистое, коммитов не создавалось. Репозиторий
использовался только для доказательства разделения продуктов.

## Прогоны тестов

| Команда | Где | Результат |
|---|---|---|
| `ruff check app tests scripts` | Aether `backend/` | чисто |
| `pytest -q` | Aether `backend/` | **227 passed** (базовая точка — 137) |
| `pnpm exec turbo run check-types --force` | selena-OS | 13 задач, 0 ошибок |
| `pnpm exec turbo run test --force` | selena-OS | **1087 passed**, 0 failed (базовая точка 1010) |
| `pnpm build` | selena-OS | 16 задач, успех |
| `bash tools/verify-railway-targets.sh` | selena-OS | PASS |
| pgTAP, 12 наборов на чистой базе | selena-OS | **145 ok, 0 not ok** (базовая точка 115 в 9 наборах) |
| `biome check` по изменённым файлам | selena-OS | чисто |

Замечание о прогоне pgTAP: роли живут в кластере, а не в базе, поэтому набор
создаёт роли, которые переживают удаление базы. Прогон подряд без их удаления
даёт ложные падения `role already exists`. Числа выше сняты с удалением ролей
между наборами.

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
| Миграции `0020`–`0022` к живой базе | реестр 19 → 22; публичных таблиц 18 → 20; `task_approvals` и `bridge_events` с RLS, три триггера одобрений, частичный уникальный индекс, `handle_new_user` читает `raw_app_meta_data` |
| Развёрнутый Aether после этих миграций | в логе сервиса `GET / 200`, ошибок нет |
| Домен studio | custom domain `19d3bb27` на порт 8080; в списке доменов сервиса остались `os.selenasystems.com` и Railway-адрес |
| Проект `selena-os-staging` | `f8d94e6a-d0d9-4166-8ad5-828c1e0679fa`; Postgres `86c716c9` deployment SUCCESS, том `selena-os-staging-pgdata` |

## Проверка отсутствия публикаций

Вызовов create-post: **0**. Ни один код, добавленный в этом прогоне, не
обращается к внешнему сервису публикации. Флаги мостов не включались:
`N8N_BRIDGE_ENABLED` и `KAITEN_SYNC_ENABLED` не трогались, а новый мост
Control Room выключен по умолчанию (`CONTROL_ROOM_BRIDGE_ENABLED` не задан) и
покрыт тестом `test_bridge_is_off_by_default`.

## Проверка запущенного приложения

Aether поднят локально на настоящей схеме (применены все миграции), с
`APP_ENV=production`. Это поведенческое доказательство, а не прогон тестов.

```
без SETTINGS_ENCRYPTION_KEY:
  EncryptionNotConfigured — приложение отказалось стартовать

с ключом:
  GET /health           200  {"status":"ok","env":"production"}
  GET /health/db        200  {"db":"ok","select1":1}   причины нет: вызов анонимный
  GET /health/agent     401
  GET /health/channels  401
  GET /health/queue     401

вхождений ключа шифрования в ответах: 0
```

Раньше все шесть диагностических эндпоинтов отвечали анонимно, а `/health/agent`
отдавал четыре последних символа живого ключа и, через маску, его длину.

## Живой запуск Control Room

Свежая база, 35 записей журнала миграций, отдельный ограниченный логин в роли
`selena_web_runtime`, регистрация владельца через API аутентификации, бренд
засеян напрямую (онбординг требует внешних вызовов, а их в этом прогоне нет).

```
GET /app/selena/control-room   200, 43 316 байт
разделы на странице: Inbox Content Review Releases Publications
                     Performance Incidents Audit   (8 из 8)
баннера «could not load» нет

до миграции 0034 тот же запрос: 500
причина: selena_release.release_manifests — нет права на колонки
         content_version_id и channel_account_id
```

Исходящие соединения: **ноль** после старта сервера. Двадцать попыток к
`telemetry.vercel.com`, зафиксированные прокси, укладываются в окно 12:34–12:45
UTC — это сборка и тесты; сервер стартовал в 12:47.

Границы этого доказательства: оно показывает, что продукт работает на настоящей
схеме. Оно **не** доказывает деплой в Railway и не заменяет его.

## Разделение баз и продуктов

Без раскрытия значений:

- Aether → Supabase `iztqbgyytgcokfdpmfan`;
- AI Visibility → Postgres-сервисы Railway-проекта `selena-ai-visibility`
  (`51dd0770-e622-4734-a705-ace401234bb8`);
- Selena OS → новая база в проекте `selena-os-staging`, отдельная от обоих;
- ни один Railway-сервис не собирается из `parkourcafe/selena-OS`;
- миграции `0021+` у selena-OS и selena-ai-visibility несовместимы по номерам и
  пересекаются по именам таблиц в `public` — одна база им технически невозможна.

## Мост Aether → Control Room, сквозной прогон

Дата: 2026-09-03. Пилот — бизнес `other_bali`.

Что настроено: на проде Aether `CONTROL_ROOM_BRIDGE_ENABLED=true`,
`CONTROL_ROOM_BRIDGE_BUSINESS_KEYS=other_bali`, адрес staging-приёмника и общий
секрет подписи. В базе Aether создан проект «Other Bali» с этим бизнесом.

Первая доставка:

```
bridge_events: status=sent  attempts=1  last_error=null
```

Повторная доставка того же события (строка возвращена в `pending`):

```
приёмник: aether event duplicate: event=e839fb24-1fd0-427a-8397-3d2945a7617a
          aggregate=110af23d-6220-49fb-b471-d6c7f55eba7c version=1
Aether:   status=sent  attempts=2  last_error=null
```

Что доказывает: outbox → доставка → подпись → HTTPS → проверка на стороне
приёмника → запись через функцию ингестии → 202 → `sent`; и что повтор не создаёт
вторую карточку.

Чего не доказывает: событие ставилось в outbox запросом той же формы, что пишет
продюсер, а не прогоном настоящей задачи агентом.

**Секрет моста прошёл через сессию** (владелец попросил выполнить перенос
самостоятельно, а прочитать существующее значение через API нельзя — оно
скрыто). Значение подписи, не доступа к данным; перевыпускается заменой
`SELENA_AETHER_BRIDGE_SECRET` у приёмника и `CONTROL_ROOM_BRIDGE_SECRET` у
Aether. На время ротации оба принимают список через запятую.

## Проверка сертификата БД включена на проде, 2026-09-04

Оговорка Gate 1 снята. До этого дня подлинность сервера базы не проверялась:
работал `AETHER_DB_SSL_INSECURE=true`.

Причина отказа, дословно из лога деплоя `2de6416a` (02.09, 23:49) — того самого,
где флаг был снят:

```
DB pool init failed: SSLCertVerificationError: [SSL: CERTIFICATE_VERIFY_FAILED]
certificate verify failed: self-signed certificate in certificate chain
```

Не «неизвестный издатель» и не «имя не совпало», а самоподписанный корень.
Postgres у Supabase подписан их собственным корнем. Прежний диагноз («перевести
`DATABASE_URL` на пулер») был неверен: пулер уже использовался — соединения
приложения приходят в базу с адреса Supavisor, а исходящий IPv6 у сервиса
выключен, так что прямой IPv6-only хост недостижим в принципе.

Владелец выгрузил корень из дашборда своего проекта — канал, подтверждённый её
собственной авторизованной сессией. Файл проверен до применения:

```
subject/issuer : CN=Supabase Root 2021 CA, O=Supabase Inc   (совпадают → самоподписанный)
basicConstraints: CA=True (critical);  keyUsage: cert_sign, crl_sign
действует      : 2021-04-28 .. 2031-04-26;  ключ RSA-2048
собственная подпись проверена его же ключом: VALID
sha256         : 80:70:25:ad:50:d4:ed:21:9d:2c:9c:7d:29:9c:00:4f:
                 82:4e:b0:0c:f7:f6:5a:fe:f6:07:d0:7b:72:e6:ca:fa
```

Значение положено в `AETHER_DB_SSL_ROOT_CERT_PEM`, `AETHER_DB_SSL_INSECURE`
переведён в `false` (операции удаления переменной у доступного инструмента нет;
код считает включённым только точное значение `"true"`, поэтому проверка
включена, а откат — правка одного слова).

Доказательство — две последовательности старта, строка в строку. Отказавшая
(`2de6416a`) и нынешняя (`ca6ad42d`, 04.09, 08:08:56):

```
                                          2de6416a      ca6ad42d
Started server process [2]                    ✓             ✓
Waiting for application startup.              ✓             ✓
CLAUDE_CODE_OAUTH_TOKEN … нормализовано       ✓             ✓
DB pool init failed: SSLCertVerification…     ✓             —
Interrupted-task cleanup skipped: RuntimeError ✓            —
Application startup complete.                 ✓             ✓
Uvicorn running on http://0.0.0.0:8080        ✓             ✓
```

Ключевая строка — вторая исчезнувшая. Очистка прерванных задач идёт на старте и
берёт пул; раньше она падала с `RuntimeError` именно потому, что пула не было.
Её молчание — не отсутствие ошибки, а положительный признак: пул существует.
То есть соединение к базе установлено **с полной проверкой цепочки и имени
хоста**.

## Сертификат studio.selenasystems.com выдан, 2026-09-04

Домен стоял в `VALIDATING_OWNERSHIP` больше суток при `errorMessage: null`.
Разбор шёл не туда, потому что API описывал требования домена неполно.

Что было исключено по дороге — с авторитетных серверов зоны, а не из панели:

```
studio.selenasystems.com — ровно одна запись, CNAME, больше ничего
os.selenasystems.com     — то же самое по форме, сертификат при этом валиден
selenasystems.com  CAA   — 0 issue "pki.goog" / "sectigo.com" / "letsencrypt.org"
```

CAA зоны к делу отношения не имеет дважды: Let's Encrypt в ней разрешён, и по
RFC 8659 для имени-алиаса центр читает CAA из дерева цели CNAME, общего у обоих
имён.

**Настоящая причина.** Railway требует две записи, а `domain-status` возвращает
одну:

```
dnsRecords: [ { CNAME studio → …up.railway.app, PROPAGATED } ]     ← всё, что отдаёт API

диалог «Configure DNS Records» в панели:
  ✅ CNAME  studio                  ijo38eh1.up.railway.app
  ⚠️ TXT    _railway-verify.studio  railway-verify=14a68c3d…      ← её не существовало
```

Поэтому `errorMessage` был пуст, а запись помечалась `PROPAGATED`: проверялся
только CNAME, до подтверждения владения дело не доходило. Недостающую запись
нельзя было увидеть ни одним доступным инструментом — только глазами в панели.

**После правки.** Владелец пересоздала домен (id `19d3bb27…` → `1696026f…`,
цель `iu5dnw7q` → `ijo38eh1`) и добавила обе записи. Проверка с авторитетного
сервера зоны `198.51.44.13`:

```
studio.selenasystems.com                  CNAME  ijo38eh1.up.railway.app.
_railway-verify.studio.selenasystems.com  TXT    "railway-verify=14a68c3d1d9d7fa79f5bdd7e
                                                  4779105657b42299d7f32b48320dfec6a7e4ff63"
```

Railway сразу после этого:

```
studio.selenasystems.com  verified: true   certificate: CERTIFICATE_STATUS_TYPE_VALID
                          CNAME required == current == ijo38eh1.up.railway.app  PROPAGATED
os.selenasystems.com      verified: true   certificate: CERTIFICATE_STATUS_TYPE_VALID
                          цель прежняя d9vil0x9.up.railway.app — не затронут
```

Чего это не доказывает: вход, выход, обновление сессии и callback на новом
адресе в браузере не проверялись. Сетевая политика среды не пропускает запросы
к `studio.selenasystems.com` — шлюз отвечает `403` на CONNECT.

## Финальная приёмка, 2026-09-03

Прогоны на текущем состоянии веток:

| Что | Результат |
|---|---|
| Aether: `ruff check app tests scripts` | чисто |
| Aether: `pytest` | 267 passed |
| selena-OS: `turbo run test` | 1130 passed в семи пакетах |
| selena-OS: `turbo run check-types` и `build` | 17 задач, все успешны |
| pgTAP на одноразовой базе | 157 assertions, 0 failures |

pgTAP прогоняется одной командой: `packages/lib/scripts/run-pgtap.sh`. Скрипт
появился по ходу этой приёмки: первый прогон дал 58 ошибок в `0021`, и причиной
была не схема, а роли `selena_pgtap%`, оставшиеся в кластере от предыдущего
прогона. Роли переживают удаление базы; теперь очистка выполняется скриптом
между наборами, а не помнится человеком.

### Отсутствие публикаций

Четыре независимых запрета, каждый проверен на текущем состоянии:

1. `PUBLISHING_ENVIRONMENTS = ["PRODUCTION"]` — staging не входит;
2. флаг включает только точное значение `"true"`;
3. транспорт адаптера Blotato по умолчанию — `disarmedFetch()`, который бросает
   исключение вместо сетевого вызова;
4. в переменных всех сервисов staging нет ни одного публикующего ключа: ни
   Postiz, ни Blotato.

Четвёртый пункт — не проектное решение, а следствие: публиковать в staging
нечем даже при отказе первых трёх.


## Три рантайма на staging — 04.09, вечер

Доступ к Railway дал ключ проекта, положенный владельцем в API credentials среды:
значение подставляет прокси Anthropic уже за пределами контейнера, поэтому в
сессии его нет и в логах он не появляется.

| Сервис | Итог | Чем подтверждено |
|---|---|---|
| `migrate` | SUCCESS | `runtime logins provisioned: selena_web_login, selena_gateway_login, selena_ingestion_login`; `skipped, no password set: selena_scanner_login, selena_worker_login` |
| `worker` | SUCCESS | `pg-boss started` → `All handlers registered, worker is ready` → плановая проверка отработала: `No enabled brands found` |
| `gateway` | SUCCESS | деплой с `healthcheckPath=/healthz` доходит до зелёного, а `/healthz` начинает отвечать только после `resolveSigningKey`: сервер слушает строкой ниже. Значит пара выпущена и лежит в `selena_release.gateway_signing_keys` |
| `scanner` | не создан | нужен Supabase Storage, которого у staging нет. Причина и порядок — `docs/control-room/DEPLOYING.md`, §5 |

Пароль логина `selena_gateway_login` создан генератором Railway (`${{secret(32)}}`)
на сервисе `migrate` и оттуда подставляется ссылкой: значение не проходило ни через
переписку, ни через репозиторий. То же с `SELENA_GATEWAY_INTERNAL_TOKEN`.

### Что стоило одного лишнего деплоя

`serviceCreate` принимает поле `branch`, молча его игнорирует и подключает
репозиторий на ветке по умолчанию. Первый деплой `gateway` собрался из `main` и
упал с `SELENA_GATEWAY_SIGNING_PRIVATE_KEY is required` — то есть кодом **до**
миграции `0036`. Отказ был правильным: fail-closed сработал.

Починка — `serviceInstanceDeploy(commitSha: …)`. Ключом проекта нельзя ни
`serviceConnect`, ни `deploymentTriggerCreate` (оба отвечают отказом авторизации),
поэтому автодеплой по ветке у `worker` и `gateway` **не настроен**: каждый
следующий деплой этих двух сервисов нужно запускать с явным commit sha, пока
ветка не слита в `main`.

## Домен кабинета — 04.09

`cabinet.selenasystems.com` добавлен к сервису `web`, `targetPort` взят из его
`PORT`. Требуемая запись: `CNAME cabinet → jwqocf2e.up.railway.app`.

Записей, как и в случае `studio.`, скорее всего **две**: API возвращает только
CNAME, а `TXT _railway-verify.cabinet` виден лишь в диалоге «Configure DNS
Records». Это стоило суток на предыдущем домене, поэтому записано здесь.


## Control Room в браузере — 05.09, владелец

Единственное, что оставалось от Gate 5 и Gate 4: как страница выглядит у
человека. Из среды исполнителя публичные адреса Railway недоступны, поэтому
проверку сделала владелец и прислала снимок экрана.

Видно на снимке: адрес `web-production-6cb6b.up.railway.app`, заголовок
`Content OS`, бренд `other bali`, роль `owner`, и **восемь разделов слева
ровно те**: Inbox, Content, Review, Releases, Publications, Performance,
Incidents, Audit. Меню AI Visibility в этом пространстве отсутствует —
переключатель продукта наверху, разделы под ним только Content OS. Очередь
проверки пуста: `No content versions`, что и должно быть, пока ни одна задача
не дошла до кабинета.

Пункт приёмки «в Selena OS есть Control Room с восемью разделами, слева нет
меню AI Visibility» переходит в PASS. Раньше он стоял как «не будет сделано» —
это была моя ошибка: разделение продуктов уже существовало, я судил по коду
меню, а не по тому, что видит вошедший.

### Три причины одного 404

Вход в Content OS не работал ни разу с момента создания кнопки. Причины
складывались друг за другом, и каждая давала неотличимый 404:

1. `/app/selena` — статический маршрут экрана выбора пространства; он
   перекрывал `/app/selena/control-room`, дочерних страниц у него нет.
2. `$brand` — идентификатор бренда в базе, а не имя. Любая вписанная строка
   не находилась загрузчиком и давала notFound.
3. Бренд выбирался из всех организаций пользователя, а Control Room открывает
   транзакцию в одной. `selena_registry.set_request_context` связывает бренд с
   организацией при проверке членства и отвергал чужой.

Первые две нашлись по коду, третья — только по логам приложения
(`selena_control_room_load_failed`). Вывод для метода: при отказе, который
видит пользователь, логи приложения идут первыми, а чтение кода — вторым.
Обратный порядок стоил двух лишних кругов.

## Growth Engine, локальный срез GE-1…GE-4 — 05.09, одноразовые базы

Ветка `growth/ge1-4-local-slice` в обоих репозиториях (selena-OS от `05599f9`,
Aether-Medium от `29d0e38`). Полный протокол, границы и NOT_VERIFIED — в
`SELENA-AI-COMPANY/docs/growth-engine/GE4_LOCAL_RUN_2026-09-05.md`; здесь только
что доказано и чем.

| Что | Чем доказано |
|---|---|
| Одна синтетическая задача Aether → два материала (ARTICLE, SOCIAL_ADAPTATION) с разными стабильными `aggregate_id` и общим `brief_ref` | outbox `bridge_events`: 3 строки `sent` (v1 задачи + 2 материала); Inbox Control Room: 2 `content_items` / 2 `content_versions` v1; строка версии в браузере под ролью `owner`: `Aether · SYNTHETIC_FIXTURE`, бейджи Synthetic и Needs verification |
| Повторная доставка и повторные проходы worker ничего не добавляют | outbox `attempts=2`, receiver 3× `duplicate`, счётчики карточек без изменений |
| Отказы на проводе | неверная подпись → 401 `signature`; метка −20 мин → 401 `timestamp`; тот же агрегат/версия с другим содержимым → 409 `conflict`; проект вне allow-list → 0 строк outbox; `business_key=kora` для привязанного проекта → `BUSINESS_KEY_MISMATCH`, версия не создана; отозванный binding → событие отложено `NO_BINDING`, версий не прибавилось |
| Роли | receiver под `selena_ingestion_login`, worker под `selena_worker_login`, web под `selena_web_login`; binding подтверждён владельцем в браузере через `confirm_growth_binding`; audit `growth.binding_confirmed`/`growth.binding_revoked` |
| Ноль вызовов модели и публикаций | `agent_runs`: `growth-fixture` ×3, `tokens 0/0`, `cost 0`; ключей модели в окружении Aether нет; `approvals=0`, `release_intents=0`, `release_manifests=0`, `publication_attempts=0` |
| Миграции воспроизводимы | `selena_ge4`: 39 миграций раннером, повторный прогон — no-op; `aether_ge4`: 23 файла через тот же путь, что `conftest.py`; реестр `migration_ledger.py` покрывает `0023` |
| Тесты на финальных SHA | Aether `pytest -q` 396 passed, `ruff` чисто; selena-OS lib 762 passed, worker 29 + интеграционные 9 на одноразовой базе, pgTAP 17 наборов 225 ok / 0 not ok, `tsc` 0 ошибок в lib/worker/web |

Засеяно напрямую (и названо засеянным): бренд `selena` (онбординг ходит наружу) и политика
`selena-brand-pack/v1` (её не создаёт ни UI, ни миграция — вопрос O18). Секреты прогона
одноразовые. Это доказательство локальной работоспособности среза; оно **не** доказывает
staging, Railway и готовность Growth Engine.
