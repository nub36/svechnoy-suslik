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

## 09.09.2026 — Signal Engine (ядро + worker, dry-run)

### Сделано

- Создан lib/signals/engine.ts — чистое ядро без БД и сети:
  - computeRiskLevels: SL/TP1/TP2/TP3 через ATR
    multipliers из config (LONG/SHORT зеркально);
    без ATR14 уровни не выдумываются (null);
  - isCandleClosed: execution.closedCandleOnly;
  - isCooldownActive: execution.cooldownCandles;
  - planSignals: подтверждённая агрегация → черновики
    сигналов; NEUTRAL и KONFLIKT сигналов не дают;
    сигнал получает только рынок, голосовавший за
    подтверждённое направление; каждый отказ — с причиной;
  - signalKey: marketId | candleTime | direction.
- Создан scripts/signal-worker.ts — prod-worker:
  - по умолчанию DRY-RUN (записей в БД нет);
  - запись только при --apply: createMany +
    skipDuplicates, единственное место записи,
    вызов только внутри if (apply) — проверяется
    самотестом по исходнику;
  - только enabled=true + status=PUBLISHED,
    config через validateStrategyRuntime;
  - cooldown и существующие ключи читаются из PostgreSQL.
- Создан scripts/test-signal-engine.ts — самотест
  48 проверок без БД и сети.
- prisma/schema.prisma: модель Signal расширена
  (strategyVersion, marketId FK, exchange, exchangeSymbol,
  atr14, candleTime, reasonsJson, warningsJson,
  indicatorsJson), UNIQUE от дублей
  (strategyId, strategyVersion, marketId, timeframe,
  candleTime, direction), индекс под cooldown,
  у Market обратная связь signals. Старые поля сохранены.
- app/signals/page.tsx: УДАЛЕНЫ выдуманные демо-сигналы;
  страница читает реальные ACTIVE сигналы из PostgreSQL,
  без данных показывает честное «Нет данных»;
  добавлена пометка, что сила — степень совпадения
  условий, а не вероятность успеха.
- Обновлены PROJECT_CONTEXT.md (§25 переписан, добавлен §27),
  PROJECT_FILES.txt, PROJECT_SCHEMA.prisma.

### Изменённые/созданные файлы

- Созданы: lib/signals/engine.ts,
  scripts/signal-worker.ts, scripts/test-signal-engine.ts.
- Изменены: prisma/schema.prisma, app/signals/page.tsx,
  PROJECT_CONTEXT.md, PROJECT_FILES.txt,
  PROJECT_SCHEMA.prisma, CHANGELOG.md.
- package.json / зависимости НЕ менялись.

### База данных

- Схема: расширение модели Signal (см. выше); данные
  Candle/IndicatorSnapshot/Strategy/User не затрагиваются.
- npx prisma format / validate / generate / db push
  в песочнице НЕ выполнялись: binaries.prisma.sh
  недоступен (то же ограничение, что на этапе Runtime).
  Выполняются на VPS: формат/валидация → generate →
  проверка SELECT COUNT(*) FROM "Signal" (ожидается 0)
  → db push (без force-reset).
- Запись сигналов пока нигде не выполнялась: Signal = 0.

### Проверка

- Самотест ядра: npx tsx scripts/test-signal-engine.ts
  --self-test → 48/48:
  уровни риска и их порядок, ATR null/0, границы закрытия
  свечи, границы cooldown, NEUTRAL/конфликт без сигналов,
  только голосовавшие рынки, passthrough фильтров,
  целостность черновика, closedCandleOnly вкл/выкл,
  cooldown в планировании, dedup, SHORT-поток,
  неизвестный ТФ, нет snapshot, аудиты чистоты
  engine (нет Prisma/fetch/create) и worker
  (единственный createMany внутри if (apply)).
- npx tsc --noEmit: 16 ошибок — все старые и
  задокументированные (14 implicit-any + 2 InputJsonValue,
  следствие отсутствующего prisma generate в песочнице);
  новых ошибок 0.
- npm run build: падает на той же первой старой ошибке
  app/admin (implicit any) — известное ограничение
  песочницы; компиляция при этом успешна, на VPS после
  prisma generate собирается.
- Живой dry-run и боевой проход Top-10 × 1H — на VPS
  (§25, шаги 12–15).

### Результат

- Этап завершён на уровне ядра и dry-run-контура:
  48/48 самотестов, 0 новых ошибок tsc,
  схема расширена и скопирована в PROJECT_SCHEMA.prisma.
- Боевой записи сигналов ещё нет — это осознанный
  следующий шаг на VPS.

### Известные ограничения

- prisma generate/db push/format/validate в песочнице
  недоступны (нет доступа к binaries.prisma.sh).
- Cooldown опирается на историю Signal в БД: ручное
  удаление сигналов сбрасывает cooldown.
- Статусы ACTIVE/CLOSED и фиксация результата по TP/SL —
  следующий отдельный этап; пока все сигналы ACTIVE.
- Score — сила совпадения условий, НЕ вероятность успеха.

### Следующий этап

1. Нулевой шаг на VPS (§25): db push расширения Signal,
   build, pm2 restart, живой прогон Runtime.
2. Signal Engine на VPS: dry-run → --apply Top-10 × 1H →
   проверка отсутствия дубликатов.
3. После боевого прохода: реальные счётчики /admin и
   главной, метки LONG/SHORT, график монеты, история
   сигналов; затем статусы ACTIVE/CLOSED.

==================================================

## 09.09.2026 — Исправлены блокеры локальной проверки песочницы

### Сделано
- app/admin/page.tsx и scripts/rank-assets.ts: явные
  структурные типы вместо implicit any.
- scripts/test-strategy-runtime.ts: configToJson без
  привязки к типу Prisma.InputJsonValue (JSON round-trip
  сохранён; компилируется и со stub-клиентом, и с
  сгенерированным).

### Изменённые/созданные файлы
- app/admin/page.tsx, scripts/rank-assets.ts,
  scripts/test-strategy-runtime.ts.

### База данных
- Изменений нет.

### Проверка
- npx tsc --noEmit: 0 ошибок (было 16 старых).
- Самотесты 54/54 и 48/48.
- npm run build: компиляция и проверка типов проходят.

### Результат
- Локальная проверка tsc/build разблокирована.

### Известные ограничения
- На тот момент build всё ещё падал на Collecting page
  data (stub-клиент Prisma); окончательно решено в этапе
  «UI-заглушки» через ленивый Prisma-клиент.

### Следующий этап
- Свечной график рынка.

==================================================

## 09.09.2026 — Свечной график рынка

### Сделано
- Добавлена зависимость lightweight-charts ^5.2.1
  (минимальная, без peer-зависимостей, Next 15 + React 19).
- lib/indicators: серийные версии smaSeries, rsiSeries,
  macdSeries, atrSeries; старые функции делегируют сериям,
  эквивалентность проверена (300 прогонов, diff 0).
- app/api/chart/markets: активы/биржи/таймфреймы из
  PostgreSQL (только чтение).
- app/api/chart/candles: закрытые свечи + индикаторы
  (EMA 20/50/200, SMA 20, RSI 14, MACD 12/26/9) тем же
  слоем lib/indicators; лимиты 50..1000.
- components/chart/CandleChart.tsx: свечи, объём,
  EMA/SMA, панели RSI и MACD, переключатели, выбор
  монеты/биржи/таймфрейма, zoom/прокрутка, тёмная/светлая
  тема (CSS-переменные + MutationObserver), русский UI,
  loading/error/empty, защита от гонок.
- app/coin/[symbol]: УДАЛЕНЫ выдуманные карточки
  (LONG/78/100/4H), вместо них реальные данные и график.
- Обновлены PROJECT_DEPENDENCIES.txt, PROJECT_FILES.txt.

### Изменённые/созданные файлы
- Созданы: app/api/chart/markets/route.ts,
  app/api/chart/candles/route.ts,
  components/chart/CandleChart.tsx.
- Изменены: lib/indicators/index.ts,
  app/coin/[symbol]/page.tsx, app/globals.css,
  package.json, package-lock.json,
  PROJECT_DEPENDENCIES.txt.

### База данных
- Схема не менялась. Только чтение Candle/Market/Asset.

### Проверка
- Эквивалентность индикаторов: 300 прогонов, 0 расхождений.
- tsc: 0 ошибок; build: компиляция и типы успешны.
- Dev-сервер: /coin/BTC 200 с честным состоянием,
  API 400/503 с русскими сообщениями.
- Визуальная проверка с реальными свечами — на VPS.

### Результат
- График реализован; живой вид проверить на VPS (§25, шаг 8).

### Известные ограничения
- ATR на график сознательно не вынесен (не перегружать).
- В песочнице нет PostgreSQL — весь поток с данными
  не просмотрен глазами.

### Следующий этап
- Аудит и замена остальных UI-заглушек.

==================================================

## 09.09.2026 — UI-заглушки заменены реальной функциональностью

### Сделано
- MarketOverview: реальные счётчики PostgreSQL и
  капитализация Top-500 (CoinGecko) вместо выдуманных цифр.
- /strategies: реальные PUBLISHED-стратегии из БД вместо
  семи выдуманных; честные статусы.
- Header: кнопка «Поиск» без обработчика -> рабочий поиск
  (components/SearchBox.tsx, app/api/search/route.ts,
  PostgreSQL, переход на /coin/SYMBOL).
- Ссылка «Мой профиль» (вела в никуда) -> страница
  app/profile/page.tsx с реальными данными сессии.
- MarketTable: мёртвые чипы «С сигналом»/«Настроить
  колонки» удалены; «Все/Рост/Падение» — рабочие фильтры;
  фиктивные колонки RSI и «Сигнал АНАЛИЗ» удалены.
- lib/market.ts: демо-монеты-фолбэк удалены (правило
  честных данных), честное «источник недоступен».
- lib/prisma.ts: ленивый клиент (Proxy) — импорт модуля
  не падает без prisma generate; на VPS поведение то же;
  npm run build теперь проходит полностью в песочнице.
- Страницы с БД (signals и др.) переведены на ленивый
  импорт Prisma: честные состояния вместо 500.

### Изменённые/созданные файлы
- Созданы: app/api/search/route.ts, app/profile/page.tsx,
  components/SearchBox.tsx.
- Изменены: components/MarketOverview.tsx,
  components/MarketTable.tsx, components/Header.tsx,
  app/strategies/page.tsx, app/signals/page.tsx,
  app/page.tsx, lib/market.ts, lib/prisma.ts,
  app/globals.css, PROJECT_FILES.txt.

### База данных
- Схема не менялась. Только чтение.

### Проверка
- Dev-сервер: /, /signals, /strategies, /login,
  /coin/BTC -> 200; /profile -> 307 на /login без сессии;
  /api/search -> 503 с честным сообщением.
- tsc: 0 ошибок; npm run build: exit 0 (все 15 маршрутов).

### Результат
- Ни одной кнопки/ссылки без поведения на публичных
  страницах; фейковых торговых данных в UI нет.

### Известные ограничения
- Роли PRO/USER отличий в UI пока не имеют (backend
  разграничений не существует) — честно показан статус.
- Полная визуальная проверка — на VPS.

### Следующий этап
- Динамические периоды + MACD dead zone.

==================================================

## 09.09.2026 — Динамические периоды + MACD dead zone (Strategy Runtime)

### Сделано
- lib/analysis/analyze.ts: AnalysisParams,
  analyzeCandlesWithParams (произвольные периоды
  EMA/RSI/MACD/ATR/объёма по закрытым свечам),
  minCandlesForParams; analyzeCandles сохранил поведение.
- lib/strategies/config.ts: MACD deadZoneRatio (доля цены,
  валидация 0..0.1, необязательное поле — старые конфиги
  БД валидны, зона 0); periodsAreStandard,
  configToAnalysisParams, ActualPeriods,
  snapshotActualPeriods.
- lib/strategies/trend-suslik.ts: warnings сравниваются
  с фактическими периодами анализа; мёртвая зона MACD
  (|hist| <= deadZoneRatio*price не даёт баллов,
  симметрично, видна в причине).
- lib/strategies/runtime.ts: evaluateSnapshot принимает
  историю свечей — стандартные периоды берутся из
  snapshot, нестандартные считаются по закрытым свечам
  PostgreSQL точно на candleTime snapshot, при
  недостатке — fallback с warnings. Без обращений к биржам.
- scripts/signal-worker.ts: подтягивает свечи для
  нестандартных периодов (по-прежнему DRY-RUN по умолчанию).
- components/admin/StrategyEditor.tsx: поле «Мёртвая зона»,
  нормализация старых конфигов.
- app/api/admin/strategies/[id]/route.ts: полная серверная
  валидация config (validateTrendSuslikConfig) вместо
  проверки только minimumSignalScore.
- scripts/test-strategy-periods.ts: самотест 27/27 +
  живой DB-режим только-чтение для VPS.

### Изменённые/созданные файлы
- Созданы: scripts/test-strategy-periods.ts.
- Изменены: lib/analysis/analyze.ts,
  lib/strategies/config.ts, lib/strategies/runtime.ts,
  lib/strategies/trend-suslik.ts,
  scripts/signal-worker.ts,
  scripts/test-strategy-runtime.ts (фикстура + deadZoneRatio: 0),
  components/admin/StrategyEditor.tsx,
  app/api/admin/strategies/[id]/route.ts, PROJECT_FILES.txt.

### База данных
- Схема НЕ менялась (конфиг стратегии — JSON).
- Старые конфиги в БД остаются валидными (поле
  необязательное, трактуется как зона 0) — проверено тестом.

### Проверка
- Новый самотест: 27/27 (периоды, эквивалентность,
  границы свечей, отсечение будущего, fallback, мёртвая
  зона, валидация, аудит чистоты).
- Прежние самотесты: 54/54 и 48/48 — обратная
  совместимость полная.
- tsc: 0 ошибок; npm run build: exit 0.
- Живой расчёт по свечам и admin-сохранение — на VPS
  (§25, шаги 15-16).

### Результат
- Ограничение «фиксированные периоды snapshot» снято:
  стандартные параметры — из snapshot, нестандартные —
  расчёт по закрытым свечам PostgreSQL без обращений к биржам.

### Известные ограничения
- Подписи причин при fallback по-прежнему используют
  периоды config (существующее поведение), честность
  обеспечивают warnings.
- Живой DB-режим test-strategy-periods не выполнялся —
  нет БД в песочнице.

### Следующий этап
- Нулевой шаг на VPS (§25): перенос ветки в main,
  npm install, prisma-шаги, db push расширения Signal,
  build+restart, живые прогоны графика/Runtime/периодов,
  затем dry-run и боевой проход Signal Engine по команде.
