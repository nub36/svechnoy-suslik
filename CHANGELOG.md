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
