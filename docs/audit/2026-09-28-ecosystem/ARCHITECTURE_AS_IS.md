# ARCHITECTURE_AS_IS — реальная схема с разрывами, 2026-09-28 (публичная версия)

> Схема структурная: публичные пути кода и публичные домены. Внутренние идентификаторы и
> доказательства — в приватном комплекте (см. `README.md`).

Две схемы: как есть (с обрывами) и целевая. Стрелки — реальные вызовы на развёрнутых коммитах
(selena-OS b437efc, Aether 23ef430, visibility 84944e5, company-site 2fab794). Полные контракты —
в `CONNECTION_MATRIX.csv` (65 связей).

## Как есть (реальная)

```
СOTРУДНИК                        ВЛАДЕЛЕЦ                         КЛИЕНТ
Aether Studio                    Control Room (selena-OS)         AI Visibility
studio.selenasystems.com         web-production-b7719f (нет       app.selenasystems.com
                                 своего домена; cabinet.* → 404)  (окружение «staging»)
   │                                                                  │
   │ POST /tasks                                                      │ заказ/бесплатная проверка
   ▼                                                                  ▼
Aether web ──enqueue──▶ ARQ worker ──▶ result+version               visibility web ──▶ pg-boss
   │  (Redis; иначе inline)              │                              │ selena-measure worker
   │                                     │ pending_approval             ▼
   │ ОДОБРЕНИЕ В AETHER ✗ тупик:         │                           Bright Data / DataForSEO / ...
   │ автор одобрять не может,            │                           ⛔ PROVIDER_CALLS_STOPPED,
   │ участников 0 → 11/13 задач          │                              scheduler off (по коду)
   │                                     ▼
   │                       transactional outbox (bridge_events)
   │                                     │ HTTPS + HMAC (delivery loop, 8 попыток ≈5 мин → dead)
   │                                     ▼
   │                    ┌─ prod receiver-9310  ✗ 0 запросов за всё время ─┐
   │                    └─▶ STAGING receiver-3704  ◀── события 09-03..09-08 (P-06)
   │                                     ▼
   │                       selena_ingest_raw.aether_events
   │                            │                    │
   │            content.draft_ready              task.result.ready
   │                            ▼                    ✗ НИКОГДА не проецируется (C-04)
   │                       projection (gate GROWTH_ENGINE_STAGE1_ENABLED)
   │                            │  проверка growth_project_binding + content_policy
   │                            ▼
   │                       Inbox: content_items / content_versions  ── карточка владельцу
   │                            ▼ одобрение конкретной версии (owner; member ✗ 403 на сервере)
   │                       release_intents + outbox
   │                            ▼ dispatcher → gateway
   │                       ⛔ GATEWAY ✗ 409 «8 parameters» на ВСЕХ развёрнутых SHA (S-13)
   │                            ▼ (только с патчем в песочнице)
   │                       Blotato adapter → backend.blotato.com   (fake transport в аудите)
   │                            ▼
   │                       publication_attempts ; метрики ✗ не подключены (C-12) → Performance пуст
   │
   ✗ ОБРАТНЫЙ КАНАЛ В AETHER ОТСУТСТВУЕТ (C-05/C-13): статус, одобрение, метрики не возвращаются
```

Боковые пути Aether: **n8n** (A05, 30 событий в prod, без подписи/метки времени, повторы
бесконечные) — вне основной цепочки; **Kaiten** (A06/A07, 0 подключений в prod) — выключен.

### Три главных обрыва
1. **Доставка**: шлюз не подписывает манифест ни на одном развёрнутом SHA (P1-1).
2. **Контур**: production Control Room не подключён — события идут в staging-приёмник (P1-2).
3. **Обратная связь**: канала возврата статуса/метрик нет ни в одну сторону (P1-3); плюс
   `task.result.ready` не проецируется (P1-4).

### Что работает и доказано на развёрнутом коде
- Первая половина: вход → проект → задача → исполнитель → результат → мост (подпись, окно времени,
  идемпотентность, порядок версий, конфликты) → проекция `content.draft_ready` → карточка Inbox под
  правильным владельцем, с совпадающим `trace_id`.
- Одобрение и очередь в Control Room; kill switch блокирует выпуск на сервере (fake-провайдер не
  вызывается).
- Изоляция в интерфейсе: чужая организация → 404; клиентский отчёт visibility → «project is outside
  AuthContext tenant»; роли Aether через API → 403.
- Отдельные локальные инструменты: central-memory, ai-council, youtube-pro, сайт selenasystems.com.

## Целевая (минимально замкнутая)

```
Aether Studio ──▶ Aether runtime ──▶ ОДОБРЕНИЕ (админ или обязательный ревьюер, не автор)
                                       │
                                       ▼ outbox → HMAC → ЕДИНЫЙ решённый production-приёмник
                                       ▼ проекция (И content.draft_ready, И task.result.ready)
                                       ▼ Inbox → одобрение владельца
                                       ▼ gateway (исправлен: 7 параметров) → провайдер (один на канал)
                                       ▼ publication_attempts → метрики → Performance
                                       ▼
             ◀── ОБРАТНЫЙ КАНАЛ: статус доставки, метрики, решения → Aether/Studio (автор видит правду)
```

Целевые границы (ТЗ 6): у Aether, OS и AI Visibility — своё состояние и своя БД; обмен только через
API/события; постоянная память (Central Memory) не заменяет очередь; n8n — транспорт, Kaiten —
зеркало. GitHub — только для кода; одобрение контента, merge PR и публикация — разные события.

Разделение БД подтверждено топологически (три отдельных Postgres); пер-продуктовые агрегаты —
через `OWNER_SQL_READONLY.md` (владелец запускает на чтение).
