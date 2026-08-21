# TZ v1.3-impl — следующий блок (ред. 3)

Ветка: claude/selenasystems-security-audit-b9uyst. Одна app-ветка, новую не создавать.

## Инварианты дизайна (действуют во всех фазах)
- Никакого заголовочного общего балла. Ведём разбивкой по движкам и дименшенам
  (recognition / presence / sentiment / share of voice / coverage / position).
  Композит, если он вообще есть, — вторичен, с открытой формулой, версией методики
  и провалом в доказательства. Урок HubSpot: sentiment 40% дал 44 балла бренду с
  recognition 2/20 — ложный комфорт. v1.3 §12.
- Пробел данных не подаётся как факт. Нет подходящих данных → UNKNOWN, никогда не
  «0%» и не «вас нет в AI» (HubSpot и Semrush обе этим грешат).
- Каждый вывод грунтуется в сохранённом evidence. Рекомендация без evidence IDs
  не создаётся.

## Жёсткие запреты (owner gates)
1. Не применять миграции (0025–0028 и новые). drizzle-kit migrate — только по команде владельца.
2. Не включать живые адаптеры, никаких реальных provider-вызовов. Registry = noop.
3. Не пушить в release.
4. Не трогать секреты и бюджетные флаги.
Всё остаётся DESIGNED / TESTED-on-stub. Верификация = stub/фикстуры end-to-end + сьюты.

## Фаза 1 — оживить экстракцию (доделать P0-08). Приоритет 1
- resolveExtractionContext: бренд, варианты названия, конкуренты, owned-домены из
  snapshot Configuration Lock → в extraction.
- complete() пишет sv_response_mentions (строка на сущность, ordinal >= 1),
  citations (только реально показанные провайдером; owned по суффиксу домена),
  extractorVersion.
- Поле captureMode на измерение (run/mention): enum live_search | training_data |
  unknown. Источник истины — адаптер на исполнении; noop оставляет unknown. Причина:
  Perplexity ищет вживую, ChatGPT/Gemini отвечают из training data — режимы
  несопоставимы, метрики не должны их смешивать. Контракт measurement несёт
  captureMode; тест на дефолт unknown.
- Переключить computeLedgerMetrics на чтение sv_response_mentions вместо колонок
  sv_runs (item #5). VALID без экстракции = «неизмерено», не «нет упоминания».
- mentionCoverage рассчитывается и хранится ОТДЕЛЬНО для branded и non-branded
  промптов. Смешанный показатель допускается только как производный и обязательно
  маркируется mixed. Если в группе нет подходящих запусков, результат возвращается
  как UNKNOWN, а не 0%.
- Acceptance: stub-прогон заполняет mentions/citations/captureMode; mentionCoverage
  (branded/non-branded раздельно) / relativeMentionShare / averageBrandPosition
  считаются из mentions; пустая группа → UNKNOWN; unit + contract зелёные; ноль
  живых вызовов.

## Фаза 2 — замкнуть deliverable (остаток P0-08). Приоритет 2
- Транзакционный переход QC_REQUIRED → READY/DELIVERED (QC-handler раньше только вставлял запись).
- assertExpertVerified реально вызывается на пути Expert Verified.
- Signed URL к raw evidence только своей организации (addendum §7).
- Acceptance: stub-заказ проходит order → run → mentions → QC → READY транзакционно;
  тесты на переход и на tenant-scope signed URL.

## Фаза 3 — ручная перепроверка item #3. Быстро
- sv_pilot_cycles: есть ли путь записи инцидента при cardinality overflow. Нет
  обработчика != «недостижимо» (DS-P1-18). Добавить incident-запись или задокументировать.

## Фаза 4 — Этап B addendum (аналитика). Только после Фазы 1
- sv_citation_gap_snapshots (§5.4/§6.4): gap = competitorCitationCount > 0 AND
  ownedCitationCount = 0 AND evidenceRunIds есть AND один Configuration Lock.
  priorityBand LOW/MEDIUM/HIGH прозрачными правилами, без скрытого score.
- Source Opportunity aggregation (§8): citations по domain/URL/topic/scenario/system,
  owned vs competitor, linked evidence.
- Acceptance: gap воспроизводится из citations + evidenceRunIds; рекомендация только
  с evidence IDs; тесты формул и границ.

## Фаза 5 — tenant-изоляция (перед вторым клиентом). Бэклог, спроектировать не применять
- organizationId на reports + scoping (сейчас временный admin-гейт) — DS-P0-15.
- Foreign prompt IDOR (DS-P1-28), viewer mutations (DS-P1-10), FORCE RLS + non-owner
  runtime role (P1-13). Требуют миграций → owner gate.

## НЕ в этом TZ
sv_topics, sv_prompt_proposals (§5.1–5.2) — пересекаются с онбординг-файлами, отдельная сессия.

## Обязательно на выходе
Обновить раздел 20 Implementation Status Matrix v1.3: реальный статус каждой функции.
Миграции не применены → строки не выше SCHEMA_EXISTS-in-branch, ни одна не RELEASED.
