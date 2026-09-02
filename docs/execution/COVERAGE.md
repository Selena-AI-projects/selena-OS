# Покрытие требований мастер-ТЗ

Таблица составлена против текста ТЗ, а не против сделанной работы: сначала
выписано требование, потом состояние. `NOT-VERIFIED` означает «не доказано», а не
«вероятно, работает».

Классы доказательств не смешиваются. Зелёные тесты доказывают поведение кода;
успешный деплой доказывает, что образ собрался; живая проверка доказывает, что
система отвечает. Это разные утверждения.

## Gate 0 — read-only discovery

| Требование | Состояние | Доказательство |
|---|---|---|
| Точные repo roots, remotes, ветки, dirty state | PASS | `SNAPSHOT.md`, раздел «Репозитории» |
| Сопоставить Railway services / source repo / окружения | PASS | `SNAPSHOT.md`, «Инфраструктура» |
| Сопоставить Supabase, RLS, реестр; доказать разделение БД | PASS | `SNAPSHOT.md`, «Разделение продуктов и баз» |
| Найти source ownership неизвестных worker/publish services | PASS (как факт отсутствия) | У `worker` и `publish` в проекте selena-ai-visibility нет repo в конфиге; помечены карантинными, не трогались |
| Проверить текущий Control Room | PASS | `SNAPSHOT.md`, «selena-OS: Control Room» |
| Домены и auth read-only, DNS не менять | PASS | DNS не менялся; расхождение карты доменов зафиксировано |
| Baseline typecheck/tests/lint/build, secret scan, dependency scan | PASS | `EVIDENCE/index.md`, «Прогоны тестов»; `SECURITY_REPORT.md` |
| SNAPSHOT содержит факты, неизвестные и блокеры | PASS | `SNAPSHOT.md` с разделом UNKNOWN |
| Production и публичные каналы исключены | PASS | `EVIDENCE/index.md`, «Проверка отсутствия публикаций» |

**Gate 0: PASS.**

## Gate 1 — безопасность и credentials

| Требование | Состояние | Доказательство |
|---|---|---|
| Backup/snapshot и проверка восстановимости до изменения | PASS | Все операции репетировались на одноразовых базах; точки возврата описаны в `RECOVERY.md` |
| Ключ шифрования только через secret store, plaintext-fallback запрещён | PASS | Fail-closed старт; опт-ин для разработки не действует при `APP_ENV=production` |
| Versioned envelope encryption, ротация, redaction, аудит без значений | PASS | Конверт `enc:v2` с меткой ключа; ротация через retired-ключи отрепетирована |
| Пять credentials перевыпустить и отозвать старые | **NOT-VERIFIED** | Действие владельца: `REMAINING_BLOCKERS.md` пункт 4 |
| Negative tests: dump, API, логи, UI не содержат plaintext | PASS | `test_secret_leaks.py`; живая проверка эндпоинтов |
| Runtime-роль не может прочитать шифротекст в обход | PASS частично | Расшифровка возможна только с ключом; отдельной runtime-роли в Aether нет — это архитектура одного сервиса |

**Gate 1: PASS по коду, NOT-VERIFIED по ротации credentials** — она физически
выполняется только владельцем у провайдеров.

## Gate 2 — сверка реестра миграций

| Требование | Состояние | Доказательство |
|---|---|---|
| Зафиксировать факт дрейфа, не запускать следующую миграцию напрямую | PASS | Дрейф подтверждён запросом; файла `0019` на момент старта не существовало |
| Schema-only dump, diff, checksum всех файлов | PASS | Дампы до/после совпали; `checksum()` в манифесте |
| Воспроизвести состояние в одноразовом Postgres и проверить план | PASS | `EVIDENCE/index.md`, «Сверка реестра миграций» |
| Forward-only reconciliation, не помечать без проверки каждого объекта | PASS | Предикаты на каждую миграцию; отказ при ложном предикате |
| Применить к целевому окружению единственным писателем | PASS | Одна транзакция под advisory-локом; применено к живой базе |
| Проверить схему, инварианты, RLS, повторный no-op | PASS | 18 таблиц до и после; повтор — no-op |
| Rollback заменён restore/corrective migration | PASS | `RECOVERY.md`: откат — удаление тех же строк реестра, прикладные объекты не трогаются |

**Gate 2: PASS.** С оговоркой, вынесенной в `docs/MIGRATIONS.md`: сверка не делает
безопасным `supabase db push`, потому что версии в реестре и имена файлов
устроены по-разному.

## Gate 3 — реальный owner approval

| Требование | Состояние | Доказательство |
|---|---|---|
| Исполнитель не может сам одобрить или завершить задачу | PASS | `test_creator_cannot_approve_own_task` |
| Owner identity/role из серверного контекста | PASS | Роль читается из `profiles`; `0021` закрыл SQL-сторону |
| Immutable approval record: actor, hash версии, решение, scope, срок, отзыв | PASS | Миграция `0020`; `test_approval_row_cannot_be_updated_or_deleted` |
| Изменение одобренной версии аннулирует одобрение | PASS | Триггеры БД + сверка отпечатка; `test_result_change_revokes_the_approval` |
| Повторные запросы идемпотентны | PASS | Частичный уникальный индекс; `test_repeat_approve_of_the_same_version_is_idempotent` |
| Negative tests: worker/member/cross-tenant; expired/revoked блокируют | PASS | Девять негативных тестов в `test_task_approvals.py` |

**Gate 3: PASS.** Миграции `0020` и `0021` к живой базе не применялись — это
следующий шаг после выката кода.

## Gate 4 — studio.selenasystems.com

| Требование | Состояние | Доказательство |
|---|---|---|
| Добавить studio, не меняя назначение app/os | PASS частично | Домен добавлен, `os.` не тронут |
| Railway domain, DNS, Supabase redirect, cookies, origins, CORS | **NOT-VERIFIED** | Нужна DNS-запись владельца: `REMAINING_BLOCKERS.md` пункт 2 |
| Не использовать wildcard origins | PASS | Wildcard отвергается конфигурацией; `test_wildcard_origin_is_refused` |
| Браузерная проверка входа, выхода, refresh, callback | **NOT-VERIFIED** | Невозможна до DNS |
| Старый адрес остаётся рабочим | PASS | `os.selenasystems.com` и Railway-адрес в списке доменов сервиса |

**Gate 4: NOT-VERIFIED** — упирается в DNS-запись.

## Gate 5 — staging Control Room

| Требование | Состояние | Доказательство |
|---|---|---|
| Write access через обычный PR workflow, не обходя CLA | PASS | Работа в ветке, коммиты подписаны, история не переписывалась |
| Развернуть существующий Control Room, не переписывая продукт | **BLOCKED** | Railway не имеет доступа к репозиторию: `REMAINING_BLOCKERS.md` пункт 1 |
| Отдельные staging services и отдельная БД | PASS частично | Проект и Postgres созданы; сервисы ждут источник |
| Только проверенные forward migrations | PASS | 32 миграции проверены дважды на чистой базе |
| Восемь разделов доступны | **NOT-VERIFIED** | Требует развёрнутого веба |
| Storage/scanner runtime и deployable Release Gateway | **NOT-VERIFIED** | Требует развёрнутых сервисов |
| Owner flow до queue dry run, external calls = 0 | **NOT-VERIFIED** | Требует развёрнутого веба |
| Control Room отделён от AI Visibility | **NOT-VERIFIED, и не будет** | По решению владельца продукт не переписывается; `DESIGN.md` репозитория прямо запрещает ярлык «Selena OS» |

**Gate 5: BLOCKED.**

## Gate 6 — мост Aether → Control Room

| Требование | Состояние | Доказательство |
|---|---|---|
| Envelope: schema_version, event_id, event_type, project, aggregate, version, occurred_at, trace_id, payload_hash | PASS | `contracts/control-room-event.v1.schema.json` |
| Транзакционный outbox Aether | PASS | Миграция `0022`; постановка в одной транзакции с изменением задачи |
| Подпись, окно времени, защита от replay, ротация ключа | PASS | `bridge_events.py`; подпись покрывает и метку времени |
| Идемпотентность по event_id/version, retry, dead-letter, correlation | PASS | Уникальные индексы, состояние `dead`, `trace_id` |
| Результат создаёт Inbox item, не APPROVED и не PUBLISHED | PASS | Нагрузка несёт только заголовок, статус и сводку |
| Обратный путь отдельным событием, без записи в БД Aether | PASS как контракт | Приёмник не реализован — Stage 5 заблокирован |
| Contract tests и fixtures до producer/consumer | PASS | 21 тест в `test_bridge_events.py` |
| Duplicate, out-of-order, invalid signature, expired timestamp, schema mismatch, retry, DLQ | PASS | Отдельный тест на каждый случай |
| Один результат создаёт ровно один Inbox item | **NOT-VERIFIED** | Приёмника нет: упирается в Gate 5 |

**Gate 6: PASS по контракту и отправителю, NOT-VERIFIED сквозным путём.**

## Gate 7 и 8 — provider contract и Blotato

Состояние на момент составления таблицы: работа над provider contract идёт,
Blotato не начат. Итог будет дописан в `EXECUTION_REPORT.md`.

Заранее известное расхождение с ТЗ: «текущий ключ Blotato считать
недействительным» — признавать недействительным нечего, ни ключа, ни кода Blotato
в репозитории нет.

## Приёмочный чек-лист владельца

| Пункт | Состояние |
|---|---|
| Вижу отдельные адреса: AI Visibility, Selena OS, Aether Studio | **NOT-VERIFIED**. `app.` работает; `studio.` ждёт DNS; у Selena OS адреса нет — `os.` по вашему решению остаётся у Aether |
| В Selena OS есть Control Room с восемью разделами, слева нет меню AI Visibility | **NOT-VERIFIED**. Восемь разделов есть в коде; развернуть нельзя (Gate 5); меню не убирается по вашему решению |
| Событие из Aether появляется в Inbox ровно один раз | **NOT-VERIFIED**. Контракт и отправитель готовы, приёмник упирается в Gate 5 |
| Сотрудник не может выдать owner approval | **PASS** |
| После Approve и Queue dry run видно, что публикации не было | PASS частично: отправка без одобрения невозможна; queue dry run — в Gate 5 |
| В staging выбран Blotato; Postiz не удалён и не активен одновременно | см. Gate 7–8 |
| Отчёт доказывает 0 create-post и отсутствие production changes | **PASS** |
| Мне не присылали и не просили прислать ключи в чат | **PASS** |

## Требования, выполненные сверх ТЗ

Найдены по ходу работы, в тексте ТЗ их нет:

- столкновение номеров миграций между рабочей и развёрнутой ветками;
- отсутствующая в живой базе колонка, которую уже ожидал развёрнутый код;
- полностью отключённая проверка сертификата при подключении к базе;
- несовместимость формата версий реестра с Supabase CLI.
