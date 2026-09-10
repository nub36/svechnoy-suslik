# История разработки «Свечного Суслика»

Этот файл содержит хронологию успешно завершённых и проверенных этапов проекта.

Формат каждой записи:

## ДД.ММ.ГГГГ — Название этапа

### Сделано
- ...

### Изменённые/созданные файлы
- ...

### База данных
- ...

### Проверка
- ...

### Результат
- ...

### Известные ограничения
- ...

### Следующий этап
- ...


==================================================

## 09.09.2026 — Базовая архитектура проекта

### Сделано
- Создан Next.js/TypeScript проект.
- Настроена PostgreSQL.
- Настроена Prisma.
- Добавлена Auth.js авторизация.
- Добавлены роли USER / PRO / ADMIN.
- Реализована регистрация и вход по e-mail.
- Защищена административная часть.
- Настроен PM2.
- Добавлены светлая и тёмная темы.
- Подключены Binance, Bybit, Gate, KuCoin и BingX Spot API.
- Создан единый формат биржевых данных.
- Создана синхронизация USDT рынков.
- Получено 2357 рынков.
- Создан глобальный Top-500 ликвидных активов.
- Реализованы SMA, EMA, RSI, MACD и ATR.
- Проверены BTC/USDT 1H свечи на пяти биржах.
- Создана первая стратегия «Трендовый Суслик».
- Стратегия проверена одновременно на пяти биржах.
- Конфигурация стратегии перенесена в PostgreSQL JSON.
- Создан русский редактор параметров стратегии.
- Переделана главная страница админки на реальные данные PostgreSQL.
- Настроен Git.
- Репозиторий отправлен на GitHub.

### Биржи
- Binance
- Bybit
- Gate
- KuCoin
- BingX

### Проверка OHLCV
Последняя проверка BTC/USDT 1H показала близкие цены и значения индикаторов на всех пяти биржах.

### База данных
Таблицы:
- Account
- Asset
- Candle
- IndicatorSnapshot
- Instrument
- Market
- Session
- Signal
- Strategy
- User
- VerificationToken

### Текущее состояние
- Top-500: 500.
- Market: 2357.
- Candle: 0 на момент этой записи.
- Активных production сигналов: 0.
- OHLCV Worker ещё не запущен.
- Signal Engine ещё не запущен.

### Следующий этап
Production OHLCV Worker.

Первая проверка:
Top-10 × 5 бирж × 1H × ~300 свечей.

==================================================

## 09.09.2026 — Первый рабочий OHLCV Worker

### Сделано

- Создан lib/ohlcv/sync.ts.
- Создан lib/ohlcv/retry.ts.
- Создан scripts/ohlcv-worker.ts.
- Добавлена пакетная синхронизация OHLCV.
- Используются существующие адаптеры пяти бирж.
- Реализован upsert свечей.
- Реализована валидация OHLCV.
- Реализован retry с backoff.
- Реализована задержка запросов.
- Реализовано обновление Market.lastSyncAt.
- Добавлен одноразовый режим --once.
- Повторный запуск не дублирует исторические свечи.

### Проверка

Безопасный режим:

Top-10 × 5 бирж × 1H × ~300 свечей.

Использовано 48 реальных рынков.

Перед повторным проходом:
14395 Candle.

Повторный controlled-run:

- активов: 10
- рынков: 48
- upsert-операций: 95
- невалидных: 0
- ошибок: 0

После прохода:

- Candle: 14442
- closed: 14395
- open: 47
- duplicates: 0

Прирост новых строк:
47.

Полная история второй раз не продублировалась.

### Известные ограничения

Поле written в статистике сейчас считает выполненные upsert, а не только новые INSERT.

Worker пока не запущен постоянным PM2-процессом.

### Следующий этап

IndicatorSnapshot Engine:

Top-10 × 1H × последняя закрытая свеча.

==================================================

## 09.09.2026 — IndicatorSnapshot Engine

### Сделано

- Создан lib/snapshots/sync.ts.
- Создан scripts/snapshot-worker.ts.
- Анализ индикаторов переведён на сохранённые PostgreSQL Candle.
- Snapshot Engine не обращается повторно к API бирж.
- Для расчёта используются только закрытые свечи.
- Рассчитываются:
  - RSI
  - EMA20
  - EMA50
  - EMA200
  - MACD
  - MACD Signal
  - MACD Histogram
  - ATR
  - Volume
  - Average Volume 20
  - Volume Ratio
- Результаты сохраняются в IndicatorSnapshot.
- Реализован upsert по marketId + timeframe + candleTime.
- Повторный запуск не создаёт дубликаты.

### Проверка

Режим:

Top-10
× 1H
× 48 доступных рынков пяти бирж
× 300 исторических свечей.

Первый запуск:

- активов: 10
- рынков: 48
- создано: 48
- обновлено: 0
- пропущено: 0
- ошибок: 0
- дубликатов: 0

Все snapshots относятся к последней закрытой свече:

2026-09-09 10:00:00 UTC

BTC проверен на всех пяти биржах.

Значения RSI/EMA/MACD/ATR согласованы между биржами.

Повторный запуск:

- создано: 0
- обновлено: 48
- ошибок: 0

После повторного запуска:

IndicatorSnapshot = 48.

Дубликаты отсутствуют.

### Следующий этап

Перевести Strategy Engine с hardcoded настроек на Strategy.config из PostgreSQL.

После этого:
Signal Engine и мультибиржевое подтверждение.

==================================================

## 09.09.2026 — Strategy Runtime

### Сделано

- Создан lib/strategies/config.ts.
- Создан lib/strategies/runtime.ts.
- Создан scripts/test-strategy-runtime.ts.
- runTrendSuslik переведён на config параметром из PostgreSQL.
- Hardcoded trendSuslikConfig удалён из runtime.
- Добавлена строгая валидация Strategy.config без внешних библиотек.
- Runtime берёт только enabled=true + status=PUBLISHED.
- Результат считается по последнему IndicatorSnapshot каждого Market.
- Добавлено мультибиржевое подтверждение с minExchanges.
- Конфликт LONG+SHORT одновременно даёт NEUTRAL с объяснением.
- Учитываются фильтры top500Only и minimumQuoteVolume24h.
- scripts/test-strategy.ts переведён на config из PostgreSQL.
- Signal на этапе не создаются (read-only контур).

### Проверка

- Self-test без БД: 54/54.
- Батарея валидации: 32/32.
- Чувствительность к config доказана:
  порог 70→30 переворачивает NEUTRAL→LONG на тех же данных,
  смена веса RSI меняет баллы 40→20.
- Agregaciya: 4/5 LONG, 2/3 NEUTRAL, 3/3 конфликт, 5/5 SHORT.
- TypeScript: 0 новых ошибок.
- Аудит: scoring-ядро без доступа к БД,
  в скрипте нет Signal create/update/upsert/delete.
- Живой прогон Top-10 × 1H и --prove-db-link — на VPS,
  где есть PostgreSQL с данными.

### Известные ограничения

- Snapshot хранит фиксированные периоды индикаторов,
  runtime использует их позиционно + warnings.
- next build в песочнице без prisma generate упирается
  в старые implicit-any ошибки; на VPS собирается.

### Следующий этап

Signal Engine (после живого прогона Runtime на VPS).


==================================================

## 09.09.2026 — Strategy Runtime production-ready: динамические периоды и MACD dead zone

### Сделано

- Устранено ограничение фиксированных периодов IndicatorSnapshot.
- Стандартные периоды продолжают использовать готовый IndicatorSnapshot.
- При нестандартных периодах Runtime рассчитывает индикаторы по закрытым Candle из PostgreSQL.
- Поддерживаются фактические периоды Strategy.config для EMA, RSI, MACD, ATR и Volume.
- Дополнительные запросы к API бирж для динамического расчёта не выполняются.
- При недостаточной истории нестандартные параметры не подменяются фиксированным snapshot: рынок получает status=cannot-evaluate и не участвует в scoring.
- Свечи после candleTime snapshot исключаются из расчёта.
- Добавлена MACD dead zone: macd.deadZoneRatio как доля цены.
- Старые Strategy.config без deadZoneRatio остаются валидными; значение по умолчанию 0.
- Добавлено поле MACD dead zone в русскую админку и серверную валидацию config.
- Добавлены численные и boundary-тесты индикаторов и динамических периодов.
- Исправлен DB-тест динамических периодов: quoteVolume24h берётся из реального Market, а не передаётся как null.

### Проверено на VPS

- Prisma schema validate: успешно.
- Prisma Client 6.19.3 generate: успешно.
- npx tsc --noEmit: успешно, 0 ошибок.
- npm run build: успешно.
- scripts/test-indicators.ts: 74/74.
- scripts/test-strategy-periods.ts --self-test: 59/59.
- scripts/test-strategy-runtime.ts --self-test: 54/54.
- Живой read-only PostgreSQL Top-10 × 1H с нестандартными периодами:
  48 рынков проверено, 46 рассчитано по Candle, cannot-evaluate=0,
  два рынка PROM корректно отфильтрованы.
- Стандартный Strategy Runtime:
  minimumSignalScore=72, minExchanges=2;
  ZEC LONG 4/4, DOGE LONG 5/5, NEAR LONG 5/5;
  LONG=3, SHORT=0, NEUTRAL=7, конфликтов=0.
- Signal до/после: 0 → 0.

### Важно

- minExchanges=2 автоматически не менялся.
- MACD dead zone реализована, но старый config получает deadZoneRatio=0. Production-значение порога должно быть выбрано отдельно.
- Prisma schema не менялась.
- Signal Engine в production не переносился и не запускался.

==================================================

## 09.09.2026 — Чистая интеграционная ветка UI/Chart от 4db41af

### Сделано

- Создана ветка arena/ui-chart-clean СТРОГО от
  origin/main (4db41af) — без merge старой Arena-ветки.
- Перенесён только проверенный на VPS функционал:
  1) свечной график (lightweight-charts, API Candle,
  CandleChart, страница монеты, CSS графика);
  2) честный UI (сводка, стратегии, поиск, профиль,
  фильтры, header, honest empty/error states);
  3) /signals — честный пустой экран.
- Страница монеты: без prisma.signal, с asset.id в
  select, единый GROUP BY SQL для таймфреймов.
- Сводка главной: карточка «Активные сигналы» заменена
  на «Активные рынки» (prisma.market.count) — счётчик
  сигналов не использует отсутствующий Signal Engine.
- lib/prisma.ts оставлен production-версией main
  (ленивый Proxy не переносился).
- app/admin/page.tsx и scripts/rank-assets.ts не
  переносились (type fixes были нужны только песочнице).

### Изменённые/созданные файлы

- Commit 1 (chart/API/coin): app/api/chart/candles/route.ts,
  app/api/chart/markets/route.ts,
  components/chart/CandleChart.tsx,
  app/coin/[symbol]/page.tsx, app/globals.css (график),
  package.json, package-lock.json.
- Commit 2 (market UI/search/profile):
  components/MarketOverview.tsx, MarketTable.tsx,
  Header.tsx, SearchBox.tsx, app/api/search/route.ts,
  app/strategies/page.tsx, app/profile/page.tsx,
  app/page.tsx, lib/market.ts,
  app/globals.css (поиск).
- Commit 3: app/signals/page.tsx.
- Commit 4: PROJECT_CONTEXT.md (§28), CHANGELOG.md,
  PROJECT_FILES.txt, PROJECT_DEPENDENCIES.txt.

### База данных

- prisma/schema.prisma и PROJECT_SCHEMA.prisma
  идентичны origin/main — НЕ менялись.
- Signal Engine (lib/signals, signal-worker,
  test-signal-engine) в ветке отсутствует.

### Проверка

- test-indicators 74/74; test-strategy-periods --self-test
  59/59; test-strategy-runtime --self-test 54/54.
- tsc --noEmit: 14 старых implicit-any (app/admin,
  rank-assets) — класс «в песочнице нет prisma generate»,
  на VPS эти файлы дают 0 (проверено на 30f0463);
  в новых UI/chart файлах ошибок нет.
- npm run build: компиляция и типы успешны; сбор страниц
  требует сгенерированного клиента (песочница); на VPS
  этот же код графика собирался успешно.
- prisma validate/generate: binaries.prisma.sh закрыт
  из песочницы — выполнить на VPS.

### Результат

- Ветка готова к VPS-review: график + честный UI без
  единой зависимости от Signal Engine.

### Следующий этап

- VPS-проверка и перенос commits; Signal Engine —
  отдельным решением.

==================================================

## 09.09.2026 — Исправление VPS-ревью: 503 /api/chart/markets

### Причина (точная)

- В runtime Prisma 6.19.3 $queryRaw — ПРОТОТИПНЫЙ метод
  клиента ($queryRaw(n,...i){ return this._createPrismaPromise(...) }).
- Код делал const queryRaw = prisma.$queryRaw as unknown as (...)
  и вызывал queryRaw`...` — отрыв метода от объекта теряет this,
  внутри _createPrismaPromise возникает TypeError, голый catch
  маскировал его под 503 «База данных временно недоступна»
  при живой PostgreSQL (candles API тем временем отвечал 200).
- Песочница не могла это поймать: stub @prisma/client (any,
  без generate) делает любой вызов «работоспособным».

### Исправление

- app/api/chart/markets/route.ts и app/coin/[symbol]/page.tsx:
  вызов строго членом объекта — await prisma.$queryRaw<Row[]>`...`
  (типизированный tagged template, безопасная параметризация
  сохранена, SQL не менялся);
- в оба catch добавлено console.error с технической причиной
  (server-лог), клиенту — прежнее безопасное русское сообщение;
- новый scripts/test-chart-sql.ts — статический тест БЕЗ базы:
  ловит отрыв $queryRaw, unsafe-варианты, ссылки на таблицы/
  колонки вне schema.prisma, расхождение алиасов SQL и полей
  ChartRow; --self-test на фикстурах. На сломанном коде даёт
  точный диагноз, после фикса — зелёный.

### Не тронуто

- Signal Engine, prisma/schema.prisma, PROJECT_SCHEMA.prisma,
  lib/prisma.ts, Strategy Runtime, minExchanges.
- Сам SQL не менялся — он был корректен; корректен был и
  вызов tsc/build на VPS (ошибка была runtime-only).

### Проверки (песочница)

- test-chart-sql: сам код зелёный, --self-test зелёный;
  на ПРЕДЫДУЩЕМ коде падал с точным диагнозом обоих мест;
- tsc --noEmit: 14 старых implicit-any (app/admin, rank-assets —
  класс «в песочнице нет prisma generate»), новых ошибок нет;
- npm run build: компиляция успешна, останов на тех же старых
  ошибках; test-indicators 74/74, periods 59/59, runtime 54/54;
- dev-smoke: страницы 200, 503 markets теперь сопровождается
  записью причины в server-лог.

### Ожидает VPS-проверки

- git fetch && checkout arena/ui-chart-clean (fix-коммит поверх bd1f40f);
- npm install; npm run build; pm2 restart;
- GET /api/chart/markets?symbol=BTC -> ожидание: 200 JSON
  { asset, markets: [ { marketId, exchange, exchangeSymbol,
  timeframes: [...] } ], error: null };
- GET /coin/BTC -> карточки с реальными Top-500/биржами/
  таймфреймами/последней свечой, а не «Нет данных».


==================================================

## 09.09.2026 — Multi-timeframe OHLCV, история графика по прокрутке, UX

### Задача 1 — OHLCV multi-TF готовность (без переписывания)
- lib/ohlcv/cli.ts: белый список 5m/15m/1h/4h/1d, границы
  --top 1..500 (по умолчанию 10), --limit 50..1000,
  --delay, env OHLCV_*; тесты 39/39.
- created/updated по дельте COUNT; итоги по КАЖДОМУ ТФ
  (markets/fetched/written/created/updated/skipped/errors);
  printVerification по всем ТФ + глобальная проверка дублей.
- Пайплайн не менялся: concurrency=1, retry/backoff,
  upsert по market+tf+openTime, без удаления/reset,
  без автопрогона Top-500.

### Задача 2 — Snapshot на нескольких ТФ
- --timeframes=5m,15m,1h,4h,1d (прогон по каждому ТФ
  отдельно, итоги по каждому), --timeframe сохранён;
  только PostgreSQL Candle, без API бирж, схема не
  расширена; тесты 15/15.

### Задача 3 — История графика (cursor-пагинация)
- API: before (строгая валидация, 400), limit 50..1000,
  take limit+1 → hasMore/nextCursor, без OFFSET;
- клиент: подгрузка при прокрутке влево, слияние без
  дублей (lib/chart/history.ts), пересчёт индикаторов
  тем же lib/indicators, сохранение видимой области,
  AbortController, останов hasMore=false/added=0,
  бейдж «Загрузка истории…»; тесты 35/35.

### Задача 4 — UX
- легенда OHLCV+индикаторов под курсором (русские
  названия, DOM-обновление), кнопка «Сбросить масштаб»,
  мобильные брейкпоинты 430/360.

### Задача 5 — Кнопки
- аудит: мёртвых кнопок нет; disabled-состояния с
  русскими подписями у select'ов графика.

### Задача 6 — Производительность
- N+1 нет; cursor по индексу (marketId, timeframe,
  openTime) — существует; новых индексов не требуется.

### Задача 7 — Error handling
- console.error причины во всех server catch UI/Chart;
  клиенту — безопасные русские сообщения.

### Файлы
- Новые: lib/ohlcv/cli.ts, lib/snapshots/cli.ts,
  lib/chart/history.ts, scripts/test-ohlcv-cli.ts,
  scripts/test-snapshot-cli.ts, scripts/test-chart-history.ts.
- Изменённые: scripts/ohlcv-worker.ts, lib/ohlcv/sync.ts,
  scripts/snapshot-worker.ts, app/api/chart/candles/route.ts,
  components/chart/CandleChart.tsx, app/globals.css,
  app/api/search/route.ts, app/strategies/page.tsx,
  components/MarketOverview.tsx, документация.

### Проверка
- tsc: 14 старых sandbox-ошибок, новых нет; компиляция
  build успешна; 74/74, 59/59, 54/54, chart-sql ОК,
  39/39, 15/15, 35/35.
- Запреты соблюдены: Signal Engine/schema/lib/prisma.ts/
  minExchanges не тронуты; reset/force-push/merge в main
  отсутствуют.


==================================================

## 09.09.2026 — Fix CLI воркеров: настоящий --help/-h, строгость флагов, аккуратный Ctrl+C

### Инцидент (VPS, честно)
- `ohlcv-worker --help` молча запускал worker с defaults;
  выполнен один проход Top-10 × 1H: создано 289 Candle,
  обновлено 48, errors=0, duplicates=0 (Candle 14731);
  процесс остановлен Ctrl+C до второго прохода;
  данные не потеряны, свечи сохранены (идемпотентный upsert).
- `snapshot-worker --help` остановлен до прогона.

### Исправление
- resolveOhlcvInvocation / resolveSnapshotInvocation:
  help | error | run; help выбирается раньше всего;
- --help/-h: русская справка с параметрами, defaults и
  безопасными примерами, exit 0, БД/биржи/Prisma не
  затрагиваются (динамические импорты только в run-режиме);
- неизвестные/опечатанные флаги (--foobar, --onc, --to=5,
  --timeframess=1h, --hist=5) — ошибка и exit 1;
- SIGINT/SIGTERM: корректное завершение + $disconnect в
  finally; повторный Ctrl+C — немедленно (130).

### Файлы
- lib/ohlcv/cli.ts, lib/snapshots/cli.ts (resolve/buildHelp/
  validateKnownFlags), scripts/ohlcv-worker.ts,
  scripts/snapshot-worker.ts (переписаны на безопасный разбор),
  тесты: test-ohlcv-cli 39->68, test-snapshot-cli 15->33;
  PROJECT_CONTEXT §29.1.

### Проверка
- 68/68, 33/33, 35/35, chart-sql, 74/74, 59/59, 54/54;
- tsc: 14 старых sandbox-ошибок, новых нет; build: компиляция
  успешна; поведение --help/--foobar проверено запусками.


==================================================

## 09.09.2026 — Диагностика данных, plan-режимы воркеров, статус и URL графика

### Админка (только ADMIN, server component)
- /admin/data «Состояние данных»: активы, рынки по биржам,
  свечи по ТФ (+freshness), снапшоты, coverage рынков и
  Top-10, рекомендуемые plan-команды (без веб-запуска);
  агрегаты SQL, свечи в Node не грузятся; SQL включён в
  chart-sql проверку.

### Freshness
- lib/data/freshness.ts: АКТУАЛЬНО ≤2D, ЗАДЕРЖКА ≤6D,
  УСТАРЕЛО, НЕТ ДАННЫХ; тесты 32/32 (фиксированный now).

### OHLCV --plan + предохранитель
- read-only план (задачи/свечи/запросы/по биржам);
  sync-код в plan не импортируется;
- LARGE_RUN_TASK_THRESHOLD=500 задач; выше — отказ и
  команда с --confirm-large-run; тесты 68→94.

### Snapshot --plan
- read-only план по ТФ (история/создание/обновление);
  тесты 33→44.

### График
- статусная строка (рынок, счётчик свечей, последняя UTC,
  ● freshness); URL-состояние ?exchange&timeframe с
  валидацией/fallback и replaceState; отдельная ошибка
  истории; тесты url-state 18/18.

### API validation
- lib/chart/params.ts: осмысленные 400 для symbol/exchange/
  timeframe/limit/before (8 негативных сценариев проверены
  живым сервером); тесты 37/37.

### Производительность
- оценка payload: limit=300 ≈119 КБ, limit=1000 ≈408 КБ
  (синтетическая); новых индексов не требуется; схема не
  менялась.

### Проверка
- 74/74, 59/59, 54/54, chart-sql, 32/32, 94/94, 44/44,
  35/35, 18/18, 37/37; tsc: 14 старых, новых 0; build:
  компиляция успешна.
- Arena implementation — требуется VPS runtime verification.


==================================================

## 09.09.2026 — Fix блокирующего бага графика на VPS: селектор «Нет активов» и пустой canvas

### Корневая причина (регрессия 89e2671, моя)
- /api/chart/markets имеет ДВА легитимных режима: без
  symbol — список активов для селектора (PostgreSQL),
  с symbol — рынки актива. Строгая валидация symbol
  отвечала 400 «Нужен параметр symbol» на запрос СПИСКА —
  селектор получал пустой список («Нет активов»), а гонка
  статусов (list-400 после успешных candles) затирала
  статус ok ошибкой и снимала canvas.

### Исправление
- markets route: symbol валидируется ТОЛЬКО когда передан
  (get() без параметра даёт undefined — учтено); список
  снова работает, мусорный symbol по-прежнему 400;
- чистые функции состояния (lib/chart/history.ts):
  resolveSymbolFromList (выбранный BTC не сбрасывается
  пустым/частичным списком), nextStatusAfterListFailure
  (статус ok «липкий» — ошибка списка не убивает рабочий
  график), candlesIntegrityOk (count>0 при пустом массиве
  запрещён — противоречивый ответ не применяется, пишется
  console.error);
- компонент: честная подпись селектора «Список недоступен»
  при сбое списка (вместо вводящего «Нет активов»);
- тесты: test-chart-history 35 → 50.

### Проверки (песочница)
- живой dev-сервер: /api/chart/markets (список) → 503
  честный (раньше 400); symbol=BTC → 503 честный;
  symbol=мусор → 400; /coin/BTC?exchange=BINANCE&timeframe=1h
  → 200; полная регрессия 74/74, 59/59, 54/54, chart-sql
  (4 файла), 94/94, 44/44, 32/32, 50/50, 18/18, 37/37;
  tsc — 14 старых, новых 0; компиляция build успешна.
- VPS acceptance (селектор с активами из PostgreSQL,
  переключения BTC→ETH→DOGE, BINANCE→BINGX, dark/light)
  — после переноса коммита.


==================================================

## 09.09.2026 — URL следует за сменой монеты, двойной клик = сброс масштаба

- CandleChart: смена монеты обновляет URL /coin/SYMBOL?...
  (мягкая router.push без полной перезагрузки — серверная
  карточка монеты обновляется тоже; acceptance «BTC → ETH:
  URL меняется»);
- сброс масштаба: по кнопке И по двойному клику на области
  графика (acceptance задачи 10).
- Проверки: tsc без новых ошибок, 50/50, 18/18,
  /coin/BTC и /coin/ETH — 200.


==================================================

## 09.09.2026 — Fix: freshness только по закрытым свечам; честный заголовок preflight OHLCV

### /admin/data (реальный VPS-баг)
- MAX(openTime) без фильтра closed показывал 17:00 ОТКРЫТОЙ
  1h-свечи вместо 16:00 закрытой и делал закрытые данные
  «свежее» факта. Теперь: SQL с FILTER (WHERE c.closed = true/false),
  две колонки «Последняя закрытая» и «Текущая открытая»
  (— если открытой нет), freshness считается ТОЛЬКО от
  закрытой (splitClosedOpenFreshness); открытая свеча не
  влияет на freshness никогда. Пороги 2D/6D не менялись.
- test-freshness 32 → 47 (регрессия 16:00/17:00, edge cases).

### OHLCV preflight title (UX, guard не тронут)
- «Режим PLAN: PostgreSQL не изменяется…» писался и обычному
  запуску, заблокированному guard-ом. Теперь заголовок —
  preflightTitle(isPlan): явный --plan → «Режим PLAN…»,
  обычный preflight → «Предварительная оценка запуска».
  Блокировка большого запуска как была, так и есть: exit=1
  ДО runOhlcvSync/API/записи (проверено структурно: guard
  в исходнике раньше динамического импорта sync).
- test-ohlcv-cli 94 → 101.


==================================================

## 09.09.2026 — Fix: карточка coin page «Последняя закрытая свеча» только по закрытым свечам

### Реальный VPS-баг (тот же класс, что /admin/data)
- SQL карточки /coin/[SYMBOL] брал MAX(openTime) без
  фильтра closed → показывал 17:00 ОТКРЫТОЙ 1h-свечи
  под подписью «Последняя закрытая свеча» (закрытая —
  16:00). Chart при этом работал корректно.
- Исправление: MAX(c."openTime") FILTER (WHERE c.closed
  = true) AS "lastCandleTime"; тип lastCandleTime —
  Date | null (рынок только с открытой свечой);
  итог по рынкам — чистый newestClosedCandleTime
  (lib/data/freshness), null/мусор пропускает, закрытых
  нет — честное «—».
- Regression: test-freshness 47 → 52 (16:00/17:00,
  несколько рынков, null); структурное правило в
  test-chart-sql: coin page ОБЯЗАН иметь FILTER
  (closed=true) для lastCandleTime и ЗАПРЕЩЁН голый
  MAX(openTime) AS "lastCandleTime" (правило проверено
  на старом коде — ловит).


### A1 — Top-100 universe (09.09.2026)
- lib/universe.ts: TOP_UNIVERSE_SIZE=100, isInTopUniverse,
  фильтр Prisma; схема НЕ менялась (rank/top500 как были),
  исторические Top-500 данные сохранены;
- CLI --top ограничен 1..100 (ohlcv/snapshot, help обновлён);
- карточки: admin «Top активов (Top-100)» по universe,
  admin/data «Top-100 (основной universe)» + «в историческом
  Top-500» раздельно, coin page «Суслик Top-100» с
  членством по rank<=100;
- «Капитализация Top-500» (CoinGecko) и поле конфига
  top500Only (Runtime-контракт) сознательно не тронуты;
- тесты: ohlcv-cli 101 → 102 (граница 100/вне universe).


### A2 — навигация и честные разделы (09.09.2026)
- components/admin/AdminNav — единая навигация без
  мёртвых ссылок (Обзор/Стратегии/Индикаторы/Источники/
  Рынки/Бэктесты/Сигналы/Мониторинг);
- /admin/indicators — реальные IndicatorSnapshot:
  агрегаты по ТФ (COUNT/MAX/GROUP BY) + 20 последних
  снапшотов с реальными значениями, freshness по
  candleTime;
- /admin/markets — реальные Market: фильтр по бирже/
  символу через URL, пагинация 50/стр, coverage закрытых
  свечей агрегатом только по странице (groupBy, без
  тяжёлых выборок);
- /admin/backtests, /admin/notifications — честные
  empty-state (backend-функции не существуют, никаких
  fake PnL/каналов);
- Все новые страницы ADMIN-only (auth() + role).
- Ограничение песочницы: admin-страницы проверены на
  компиляцию (stub Prisma даёт ожидаемый 500 на
  инициализации клиента — на VPS работает).


### A3 — Журнал (09.09.2026)
- instrumentation.ts: перехват console.error/warn/log +
  unhandledRejection/uncaughtException в кольцевой буфер
  (оригинальный вывод сохранён);
- lib/observability/journal.ts: буфер 500 записей,
  нормализация сообщений, извлечение источника из тега
  [src], МАСКИРОВАНИЕ записей с признаками секретов
  (DATABASE_URL/AUTH_SECRET/password/token/cookie/
  authorization/соединительные строки);
- /admin/journal: фильтр уровень/источник, пагинация,
  ADMIN-only, честные ограничения (только текущий
  процесс web; worker'ы не видны; очистка при
  рестарте); без schema change, без чтения файлов;
- тесты: test-journal 23/23.


### A4 — честный Overview и Мониторинг (09.09.2026)
- /admin/monitoring: замер PostgreSQL (SELECT 1 +
  задержка), счётчики (universe/активные SPOT USDT-
  рынки/свечи/снапшоты), свежесть закрытых свечей по
  ТФ; OHLCV worker — «Состояние процесса не
  отслеживается» (web не имеет безопасного доступа к
  PM2), Signal Engine — «Не развёрнут»;
- /admin (Overview): карточка «Рынков» теперь
  «активные SPOT USDT-рынки» (точный смысл);
  блок статусов переписан: PostgreSQL — замер SELECT 1;
  Биржи — факт о данных в БД (число бирж с активными
  рынками), НЕ статус API; OHLCV Worker —
  не отслеживается + последняя закрытая 1h-свеча;
  Signal Engine — не развёрнут + число записей Signal;
  при недоступной БД страница показывает «—» и
  «Нет ответа», а не падает;
- AdminNav: добавлен пункт «Журнал»;
- globals.css: .statusRed (честное состояние ошибки);
- убраны ложные статусы «Свечи поступают»,
  «База подключена», «Есть активные сигналы» без
  измерений.


### Фикс A1-consistency по VPS-ревью (09.09.2026)
- Единая модель universe без schema migration:
  основной universe = Asset.rank 1..100
  (lib/universe.ts), Asset.top500 — исторический
  legacy-флаг;
- Strategy Runtime: SnapshotInput.assetTop500 заменён
  на assetRank (number | null) — фильтр legacy-поля
  config.filters.top500Only теперь проверяет
  принадлежность основному universe (rank 1..100),
  а НЕ флагу Asset.top500; имя поля top500Only в
  конфиге СОХРАНЕНО (production JSON-конфиги валидны
  без изменений в БД); минимальный порог/
  minExchanges/deadZoneRatio не тронуты;
- StrategyEditor: метка «Анализировать только основной
  universe (Top-100)» + пояснение про наследное имя
  поля; seed: только комментарий, значения не менялись;
- CLI --top: возвращён диапазон 1..500
  (LEGACY_TOP500_SIZE) — default по-прежнему 10;
  --plan --top=500 снова доступен для read-only
  диагностики исторических данных; large-run guard
  (порог 500 задач, --confirm-large-run) НЕ ослаблен;
- Journal: в UI явно указано, что журнал хранится
  только в памяти Node-процесса, очищается при
  рестарте/деплое и НЕ является постоянным audit log;
  SECRET_PATTERN расширен (bearer, api[_-]key,
  private[_-]key, ssh); instrumentation документировано:
  headers/cookies/body/query/env не логируются;
- MarketOverview: «Капитализация Top-500» помечена как
  ВНЕШНЯЯ метрика CoinGecko, не universe проекта;
- тесты: journal 30/30, ohlcv-cli 105/105,
  snapshot-cli 47/47, runtime 56/56 (границы rank=100
  проходит / rank=101 и rank=null отсеиваются),
  periods 59/59; tsc — только 12 известных
  implicit-any rank-assets (baseline).


### Фикс хвостов VPS-браузер-ревью ЭТАПА A (10.09.2026)
- Monitoring: семантика свечей как в /admin/data —
  закрытые и открытые считаются РАЗДЕЛЬНО (SQL FILTER);
  таблица: Закрытых / Открытых / Рынков / Последняя
  закрытая / Текущая открытая / Свежесть (по закрытой);
  карточка свечей показывает закрытые и открытые
  суммарно раздельно; open не смешивается с freshness;
- Рынки: во всём admin различаются «Рынки Top-100
  (активные SPOT USDT)» — через rank 1..100
  (topUniverseRankFilter, НЕ Asset.top500) — и «Всего
  активных SPOT USDT-рынков в БД»; Overview показывает
  основным показателем Рынков Top-100, вторичным
  текстом — всего в БД; Monitoring — обе карточки;
- AdminNav: добавлен пункт «Уведомления»
  (/admin/notifications больше не orphan); порядок:
  ... Мониторинг, Уведомления, Журнал; страница
  осталась честным empty-state;
- единый AdminNav добавлен на страницу редактирования
  стратегии /admin/strategies/[id] (была тупиковой,
  active="strategies");
- новый тест scripts/test-admin-consistency.ts 42/42:
  контракт universe (границы rank=100/101),
  полнота AdminNav, AdminNav на всех 9 admin-страницах,
  closed/open SQL-семантика Monitoring, рынки Top-100
  через rank-фильтр (без top500), честный empty-state
  уведомлений.


### Фикс runtime-бага Overview по VPS-ревью 8a1ae16 (10.09.2026)
- app/admin/page.tsx: при добавлении запроса
  universeMarkets в 3af152c→8a1ae16 деструктурирование
  Promise.all не было сдвинуто — assets получал счётчик
  рынков Top-100 (~401), universeMarkets — счётчик
  активов (100), markets — bare enabled-count,
  activeMarkets вычислялся и не использовался;
  исправлено: запросы Overview вынесены в проверяемый
  хелпер lib/admin/overview.ts (OVERVIEW_QUERY_ORDER
  фиксирует порядок; деструктурирование на странице
  строго соответствует); дублирующий enabled-count и
  неиспользуемый activeMarkets удалены;
- семантика карточек: «Рынков Top-100» = enabled+
  ACTIVE+SPOT+USDT рынки активов rank 1..100; «всего
  активных в БД» = те же фильтры без ограничения
  Top-100; Top активов = Asset.count universe;
- lib/universe.ts: topUniverseRankFilter теперь
  { gte: 1, lte: 100, not: null } — семантически
  эквивалентен isInTopUniverse; admin/data переведён
  с inline-фильтра на хелпер;
- тесты: test-admin-consistency 63/63 — позиции
  Promise.all проверяются на ПОДСТАВНОЙ БД с записью
  вызовов (перестановка запросов ловится: проверено
  обратной перестановкой — 58/63, exit 1); границы
  rank 1/100 проходят, 0/-1/101/null — нет; ровно 2
  счётчика рынков; activeMarkets отсутствует;
- tsc: ошибок в app/lib/components нет; 12 TS7006 в
  scripts/rank-assets.ts — известные, запрещены к
  правке правилом 34, логика не менялась с этапа A.


### Фикс типизации Overview-контракта по VPS-ревью 7b2bb09 (10.09.2026)
- lib/admin/overview.ts: OverviewDb.strategy.findMany
  объявлял orderBy как ReadonlyArray — реальный Prisma
  StrategyFindManyArgs требует изменяемый
  StrategyOrderByWithRelationInput[], readonly-массив
  не присваиваем (TS2345 на buildOverviewQueries(prisma),
  app/admin/page.tsx:70, tsc/build exit 2/1 на VPS);
  контракт исправлен на Array<{slug:"asc"}|
  {version:"desc"}>; DB-semantics, topUniverseRankFilter
  gte:1/lte:100, тесты-маппинги — без изменений;
- проверка без реального клиента (песочница имеет
  stub): временный типо-пробник воспроизвёл форму
  делегатов Prisma 6 (generic findMany/count +
  SelectSubset) — присваиваемость PrismaClientLike →
  OverviewDb с Array проходит, копия контракта с
  ReadonlyArray даёт тот же класс ошибки (негативный
  контроль через @ts-expect-error в пробнике,
  пробник удалён до коммита);
- расхождение tsc песочницы и VPS объяснено: 12
  TS7006 в scripts/rank-assets.ts существуют только
  на stub-клиенте (без сгенерированных типов колбэки
  теряют контекстные типы); VPS с prisma generate
  6.19.3 их не видит — на 7b2bb09 VPS tsc показал
  ровно одну ошибку (этот контракт); rule 34/46:
  rank-assets не трогается.


### Фикс layout/interactive страницы стратегии по VPS-ревью 7ddb2ef (10.09.2026)
- /admin/strategies/[id]: страница была на блоковом
  .shell (без сетки) — AdminNav растягивался во всю
  ширину, редактор уезжал вниз; переведена на точный
  layout-контракт рабочих страниц (.adminPage — grid
  235px+1fr, AdminNav слева, StrategyEditor в
  adminDashboard справа; responsive <=950px — средства
  globals.css, без pixel-hack);
- аудит интерактива редактора (статически + тесты,
  без mutation против БД): checkbox «Стратегия
  включена» — state + PUT enabled; «Сохранить
  настройки» — onClick → PUT /api/admin/strategies/[id]
  (isAdmin-gate, server-валидация config/minExchanges/
  timeframes, prisma.strategy.update); таймфреймы и
  числовые поля — реальная проводка; decorative
  кнопок нет (обе <button> с onClick — проверено
  тестом);
- «+ Новая стратегия» (Overview): подтверждено —
  backend создания НЕ существует; кнопка честно
  disabled без onClick, title уточнён: «Создание
  стратегий из админки пока не реализовано —
  стратегия задаётся seed-скриптом»;
- «Настроить» — реальный Link на существующий
  /admin/strategies/[id] (тест проверяет href и цель);
- regression: test-admin-consistency 76/76 (+13
  проверок layout/interactive/dead-buttons).
