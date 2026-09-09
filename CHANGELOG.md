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

==================================================

## 09.09.2026 — Исправление по ревью VPS: запрещён fallback на фиксированный snapshot

### Сделано
- lib/strategies/runtime.ts: при НЕстандартных периодах
  стратегии оценка выполняется ТОЛЬКО по закрытым Candle
  PostgreSQL с фактическими периодами config.
  Fallback на фиксированный IndicatorSnapshot
  (RSI14/EMA20/50/200/MACD12-26-9/ATR14/Volume20)
  полностью удалён — он давал бы ложный scoring
  позиционной подстановкой значений других периодов.
- Новый безопасный статус "cannot-evaluate" (расширен
  union SkippedMarket.status, существующая архитектура
  status/reason): рынок сейчас нельзя честно оценить;
  направлений и баллов у результата нет, в
  мультибиржевой агрегации рынок не голосует.
  Возникает при: свечи не переданы; пусто; истории меньше
  minCandlesForParams; последняя рассчитанная свеча не на
  candleTime snapshot; расхождение цены; невозможность
  расчёта.
- priceMatches: сравнение цены с относительной
  tolerance 1e-9 вместо хрупкого === (input.price и
  computed.price проходят разные преобразования
  float8 -> number). candleTime — по-прежнему точное
  ограничение.
- Свечи после candleTime snapshot гарантированно
  исключаются до анализа (доказано тестом побайтного
  равенства результата с «будущими» свечами и без них).
- minCandlesForParams() аудитирован против реальных
  реализаций ema/rsi/macd/atr/sma (включая guard
  macd() N >= slow+signal); добавлены boundary-тесты.
- scripts/test-strategy-periods.ts: 27 -> 59 проверок;
  DB-режим (только чтение) переведён на новую семантику.
- scripts/signal-worker.ts в этом коммите НЕ менялся:
  Runtime-решение концептуально от него не зависит
  (lib-ядро самодостаточно; worker лишь передаёт свечи
  в evaluateSnapshot и корректно обрабатывает
  cannot-evaluate через существующие проверки
  status !== "evaluated").

### Изменённые/созданные файлы
- lib/strategies/runtime.ts,
  scripts/test-strategy-periods.ts,
  PROJECT_CONTEXT.md (§25, §30), CHANGELOG.md.

### База данных
- Изменений нет. Prisma Signal не менялся, minExchanges
  не менялся.

### Проверка
- npx tsc --noEmit: 0 ошибок.
- npm run build: exit 0.
- Самотест периодов: 59/59, включая:
  - границы «ровно N свечей — все индикаторы посчитаны /
    N-1 — null» для 8 наборов периодов (стандарт;
    MACD 5/35/7, 8/17/9, 12/26/9 с малыми EMA;
    EMA slow 300; RSI 21; ATR 20; Volume 30);
  - явное доказательство: нестандартный
    RSI/EMA/MACD/ATR/Volume + недостаточная история НЕ
    даёт scoring по фиксированному snapshot (контроль на
    стандартном config с теми же значениями даёт LONG,
    guarded-результат — cannot-evaluate);
  - tolerance цены: относительное расхождение 1e-12
    проходит, 1% — cannot-evaluate; NaN/Infinity отвергаются;
  - отсечение свечей после candleTime;
  - legacy analyzeCandles требует те же 200 свечей, что и
    minCandlesForParams(default).
- Обратная совместимость: 54/54 и 48/48 прежних самотестов.

### Результат
- Ложный scoring при нестандартных периодах невозможен
  архитектурно: либо расчёт по свечам с периодами config,
  либо честный отказ (cannot-evaluate).

### Известные ограничения
- Живой DB-режим test-strategy-periods и поведение на
  реальных данных — на VPS (§25, шаг 16).
- Правка находится в Arena-ветке поверх коммитов
  Signal Engine (edf3732); для переноса Runtime на
  production достаточно файлов lib/ + тестов — список
  в PROJECT_CONTEXT §25/докладе ревью; signal-worker.ts
  и lib/signals переносить не нужно.

### Следующий этап
- Перенос Strategy Runtime (lib-ядро + тесты) на VPS
  отдельным набором файлов БЕЗ Signal Engine, живой
  прогон test-strategy-periods --top=10 --timeframe=1h.

==================================================

## 09.09.2026 — Проверка выравнивания macdSeries по ревью (изменений алгоритма не потребовалось)

### Контекст
Ручное ревью указало на «двойное смещение» в macdSeries:
будто emaSeries возвращает массив, выровненный по входу
(индексы 0..period-2 = null), и signal надо читать как
signalSeries[j]. Фактическая проверка кода показала:
emaSeries возвращает КОМПАКТНЫЙ массив без null
(result[0] — SMA-сид, соответствующий входному индексу
period-1). Поэтому корректное чтение —
signalSeries[j - (signalPeriod - 1)], как и реализовано.

Доказательства:
- Предложенный вариант signalSeries[j] соответствовал бы
  macdValues[j + signalPeriod - 1] — ЗНАЧЕНИЮ ИЗ БУДУЩЕГО
  (look-ahead), а на хвосте давал бы undefined:
  macd() возвращал бы null почти на всех данных
  (скалярный API сломался бы).
- Старый скалярный macd() (production до c14c97b,
  проверенный на живых данных VPS на этапе
  IndicatorSnapshot Engine) использует ema(macdValues,
  signal) = последний элемент КОМПАКТНОЙ emaSeries —
  текущая macdSeries воспроизводит его один в один.

### Сделано
- scripts/test-indicators.ts — новый постоянный тест (74/74):
  - численная эквивалентность macd() против эталонного
    алгоритма старого production (fastSeries/slowSeries,
    сборка macdValues, expectedSignal = ema(macdValues,
    signal)) для 12/26/9, 5/35/7, 8/17/9 на N = 35/42/26
    (ровно guard-минимум), 100, 300, 1000 — точное ===
    по macd/signal/histogram;
  - поэлементная сверка macdSeries по входным индексам
    (macd/signal/histogram на своих свечах, null в зонах
    прогрева, null за хвостом) — вариант signalSeries[j]
    эти тесты проваливает (look-ahead);
  - границы 12/26/9: N=34 — guard, всё null; N=35 —
    macd/signal на входе 34; N=40 — macd впервые на
    входе 25, signal впервые ровно на входе 33,
    на входе 32 ещё null; ручной случай 3/5/2 на [1..10];
  - обратная совместимость скалярного API против
    НЕЗАВИСИМЫХ реализаций (другой порядок операций,
    допуск 1e-9): sma/ema/rsi/atr/macd — 150/150 наборов;
  - согласованность серий со скалярными функциями.
- lib/indicators/index.ts: только поясняющий комментарий
  о компактном выравнивании emaSeries в macdSeries
  (поведение НЕ менялось).
- PROJECT_FILES.txt.

### Изменённые/созданные файлы
- Создан: scripts/test-indicators.ts.
- Изменён: lib/indicators/index.ts (только комментарий),
  PROJECT_FILES.txt, CHANGELOG.md.

### База данных
- Изменений нет. Signal Engine, Prisma, minExchanges
  не затронуты.

### Проверка
- scripts/test-indicators.ts: 74/74.
- scripts/test-strategy-periods.ts: 59/59.
- scripts/test-strategy-runtime.ts: 54/54.
- scripts/test-signal-engine.ts: 48/48.
- npx tsc --noEmit: 0 ошибок. npm run build: exit 0.

### Результат
- Выравнивание macdSeries подтверждено математически
  и численно; алгоритм не менялся — изменение «signalSeries[j]»
  внесло бы look-ahead и сломало бы скалярный API.

### Следующий этап
- Без изменений: §25 (нулевой шаг на VPS).

==================================================

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

## 09.09.2026 — Синхронизация с production main и правки по VPS-проверке графика

### Сделано

- Синхронизация с origin/main (30f0463 + 4db41af):
  production-ветка содержит production-ready Strategy
  Runtime (идентично Arena-коммитам) и его документацию;
  их §27 (Runtime проверен на VPS) сохранён, мои разделы
  перенумерованы в §28-§31; их улучшение DB-теста
  (quoteVolume24h из реального Market) принято.
- /coin/[symbol]: ПОЛНОСТЬЮ убран Prisma Signal
  (signal count, карточка «Активные сигналы») — страница
  монеты больше не зависит от Signal Engine; добавлена
  карточка «Суслик Top-500» (место актива, вне рейтинга);
  asset.findUnique теперь выбирает id (использовался,
  но отсутствовал в select); биржи, таймфреймы и последняя
  закрытая свеча считаются ОДНИМ агрегированным SQL-запросом
  (GROUP BY на стороне PostgreSQL) — вместо N+1
  prisma.groupBy и без загрузки свечей в Node.js
  (проблема типов groupBy на реальном клиенте также снята).
- app/api/chart/markets: тот же единый SQL вместо
  findMany + groupBy в цикле (N+1 → 1 запрос).
- /signals: честный статический раздел «Signal Engine
  ещё не развёрнут» — страница больше не обращается к
  Prisma Signal (production-схема Signal старой структуры,
  расширение на VPS не переносилось).
- Таймфреймы: UI поддерживает 5m/15m/1h/4h/1d и показывает
  только реально существующие в Candle (подтверждено на
  VPS: сейчас в БД в основном 1H).
- PROJECT_CONTEXT.md: §25 переписан под новое состояние
  (production main = Runtime ready; Arena = график/UI-правки),
  разделы 28-31.

### Изменённые/созданные файлы

- app/coin/[symbol]/page.tsx, app/api/chart/markets/route.ts,
  app/signals/page.tsx, PROJECT_CONTEXT.md, CHANGELOG.md,
  PROJECT_FILES.txt; merge origin/main
  (scripts/test-strategy-periods.ts — их версия).

### База данных

- Изменений нет. Signal schema, minExchanges, Signal Engine
  не тронуты.

### Проверка

- В песочнице: npx tsc --noEmit 0 ошибок; npm run build
  exit 0; test-indicators 74/74; test-strategy-periods
  --self-test 59/59; test-strategy-runtime --self-test
  54/54; dev-сервер: все страницы 200 (/profile → 307
  без сессии), /api/chart/markets честный 503, /coin/BTC
  без карточки сигналов, /signals с честным сообщением.
- npx prisma validate / generate в песочнице недоступны
  (binaries.prisma.sh закрыт) — выполнить на VPS.
- Живая проверка с PostgreSQL — на VPS.

### Результат

- Страница монеты и раздел сигналов полностью работают
  без Signal Engine; запросы таймфреймов эффективные
  (один GROUP BY в PostgreSQL).

### Следующий этап

- VPS-проверка этой ветки; далее — решение по переносу
  Signal Engine (§28).
