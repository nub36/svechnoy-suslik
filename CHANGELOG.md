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
