# Очередь координатора: завершение шести проектов

Ведёт только координатор. Статусы: DONE_CODE, TESTED_LOCAL, VERIFIED_STAGING,
VERIFIED_PRODUCTION, READY_TO_PUBLISH, BLOCKED_EXTERNAL, BLOCKED_DECISION.
Зелёная сессия или merged PR — не доказательство production.

## Базовое состояние (2026-09-27)

| Проект | Репозиторий | Ветка | SHA |
|---|---|---|---|
| Selena (приложение) | Selena-AI-projects/selena-ai-visibility | release/selena-visibility-mvp | 39dda8f6 |
| Selena (сайт) | Selena-AI-projects/SELENA-AI-COMPANY | main | 2fab794 |
| KORA | parkourcafe/kora | — | не подключён |
| REMHAOS | parkourcafe/design-interior2026.07 | main | 737795d |
| OtherBali | parkourcafe/privelegy-bali-club | main | beff274 |
| DOKI.help | parkourcafe/mydoki | claude/cool-volta-pdpl4t | 68844b4 |
| PetID.care | parkourcafe/Dog.uslugi | main | d8bf6fd |

Сеть сессии не пускает на *.selenasystems.com и сайты проектов: проверки
staging — только через GitHub Actions.

## Задачи

| task_id | Проект | Задача | Статус | Ветка / PR | Следующий шаг |
|---|---|---|---|---|---|
| T-SEL-01 | Selena | Падение /app/selena-admin (Buffer в браузерном бандле) | DONE_CODE, TESTED_LOCAL; слито в #201 | #201 | Владелец открывает админку на staging → VERIFIED_STAGING |
| T-SEL-02 | Selena | Живой приёмочный замер $79 (5 вопросов KORA) | BLOCKED_DECISION: нужен клик владельца в /app/selena-admin | — | Заказ → сбор доказательств → ACCEPTANCE.md |
| T-SEL-03 | Selena | M5 шаг 3: подключение Telegram | DONE_CODE, TESTED_LOCAL; слито #200; миграция 0078 применена на staging (журнал 89) | #200 | Токен бота на staging (владелец) → VERIFIED_STAGING |
| T-SEL-04 | Selena | M5 шаг 4: еженедельная задача и отправка | не начато | — | После T-SEL-02 |
| T-SEL-05 | Selena | /check, клиентский кабинет, RU/EN обещания vs продукт | частично: ACCEPTANCE.md (#198) | #198 | Правки текста сайта R1–R3, P1, P2, P17, P23, P24 |
| T-SEL-06 | Selena | Review/SMS: найти и проверить | Не найдено: в обоих репозиториях нет модуля отзывов/SMS; reviews только как ручная работа аудита $399 (SELENA-AI-COMPANY lib/visibility/sales.ts:319) | — | Уточнить у владельца, к какому проекту относится |
| T-KORA-01 | KORA | Единые факты, Opening Club, аренда, события, UTM | BLOCKED_EXTERNAL: подключение parkourcafe/kora отклонено в сессии | — | Владелец разрешает доступ к репозиторию |
| T-REMH-01 | REMHAOS | Бриф → паспорт → риски → цена → КП → ответ; M1–M4 | TESTED_LOCAL (M1 цепочка, M2–M4 на уровне БД); исправлено: отправленное/принятое КП можно было изменить; браузер AP5 и DB4/DB5 с Docker — BLOCKED_EXTERNAL (Docker Hub 429) | draft PR parkourcafe/design-interior2026.07#210 | Ревью #210; решения: вход M1→M2 и условие «КП принято», неизменяемость КП в БД, абзац V2/V3 в AGENTS.md vs DEC-039 |
| T-OB-01 | OtherBali | GSC affected URLs → sitemap/routing; HANDOFF_2026-09-02 после #309; QR/SEO пилот | GSC — BLOCKED_EXTERNAL (нет выгрузки в репо); handoff закрыт сверкой с #309 (DONE_CODE); пилот QR/SEO — документ, маршруты TESTED_LOCAL, площадка/перк — BLOCKED_DECISION | draft PR parkourcafe/privelegy-bali-club#311 | Выгрузка GSC Pages в docs/seo/gsc/<дата>/; следующий PR: обрезка meta description + 3 замечания Codex к #309 (T-OB-02) |
| T-OB-02 | OtherBali | Обрезка meta description по слову; 3 замечания ревью #309 (формат даты Last checked, обещание Not for, счётчик «все варунги») | в очереди | — | Следующий запуск |
| T-DOKI-01 | DOKI | employer → apply → board; Passport/Talent Pool; RLS #111/#114; apply bottleneck; SEO | TESTED_LOCAL (найм на уровне БД, RLS 6/6, unit 177/177, SEO 21 URL в реестрах/sitemap); bottleneck не доказан; браузер — BLOCKED_EXTERNAL; дыра: работодатель сам ставит verified_at/vacancy_limit — BLOCKED_DECISION | draft PR parkourcafe/mydoki#116 | Решение по дыре employer_profiles (миграция + RLS-тест); сделать RLS-файлы #111 падающими; Turbopack build в CI |
| T-PET-01 | PetID | #85/#89, миграция 0074, reminders, PET PASS → событие → напоминание → запись → визит; пилот клиники | TESTED_LOCAL; 3 бага исправлены (повтор напоминания, визиты vs записи, чужое фото); cron — BLOCKED_DECISION; GSC 4xx — BLOCKED_EXTERNAL (нет выгрузки) | draft PR parkourcafe/Dog.uslugi#93 | Ревью #93; решение по миграции (метка «записался», CTR); выгрузка GSC; тариф пилота 1 490/3 990 vs 3 000–15 000 ₽ |
| T-SEED-01 | Все | Посевы: восстановить планы, ≤10 площадок, 3 текста, UTM, 14 дней | в очереди; без отправок | — | После проектных задач |
