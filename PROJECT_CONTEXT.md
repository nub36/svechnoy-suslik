# СВЕЧНОЙ СУСЛИК — КОНТЕКСТ ПРОЕКТА

Последнее обновление: 09.09.2026

ВАЖНО ДЛЯ AI:
Это уже существующий рабочий проект на VPS.
НЕ создавать проект заново.
НЕ менять стек без необходимости.
НЕ заменять работающую архитектуру другой.
Продолжать разработку от текущего состояния.
Перед изменением Prisma учитывать существующие данные PostgreSQL.
Весь пользовательский интерфейс и админка должны быть на РУССКОМ языке.
LONG/SHORT, RSI, EMA, MACD, ATR, OHLCV и другие общепринятые торговые обозначения можно оставлять.

==================================================
1. НАЗВАНИЕ
==================================================

Свечной Суслик

Назначение:
криптовалютная аналитическая платформа без AI.

Главное ядро:
- реальные рыночные данные;
- технические индикаторы;
- формализованные стратегии;
- LONG/SHORT сигналы;
- объяснение причин каждого сигнала;
- несколько бирж;
- мультитаймфрейм;
- статистика стратегий;
- бэктест;
- графики;
- позже подписки/реклама/новости/статьи.

Никаких выдуманных "AI прогнозов".

==================================================
2. VPS
==================================================

Ubuntu VPS.

Публичный IP:
89.125.24.50

Сайт сейчас:
http://89.125.24.50:3000

Админка:
http://89.125.24.50:3000/admin

Проект:
~/svechnoy-suslik

Production запускается через PM2.

Имя процесса:
svechnoy-suslik

Команды:

cd ~/svechnoy-suslik

npm run build

pm2 restart svechnoy-suslik --update-env

pm2 status

Логи:

pm2 logs svechnoy-suslik

==================================================
3. СТЕК
==================================================

Next.js 15
React 19
TypeScript
Node.js
Prisma 6.19.x
PostgreSQL 16
Auth.js / next-auth beta
bcryptjs
lucide-react
tsx
PM2

CSS:
обычный app/globals.css.
Tailwind сейчас НЕ используется.

==================================================
4. БАЗА
==================================================

PostgreSQL.

База:
suslik

Пользователь БД:
suslik

DATABASE_URL хранится только в .env.
Никогда не выводить секреты пользователю/в чат.

Текущие таблицы:

Account
Asset
Candle
IndicatorSnapshot
Instrument
Market
Session
Signal
Strategy
User
VerificationToken

Instrument — старая модель.
Пока НЕ удалять.
Позже удалить после полного перехода интерфейса на Asset + Market.

==================================================
5. АВТОРИЗАЦИЯ
==================================================

Auth.js.

Работает:
- регистрация e-mail + пароль;
- вход;
- PostgreSQL User;
- JWT session;
- роли.

Роли:

USER
PRO
ADMIN

Администратор существует.

Админка должна быть доступна ТОЛЬКО ADMIN.

Telegram и VK запланированы, но пока не подключены.
Их подключать после домена + HTTPS + credentials.

В auth.ts сейчас используется trustHost: true, потому что сайт пока работает напрямую по IP.

Позже после Nginx/domain/HTTPS пересмотреть production-конфигурацию Auth.js.

==================================================
6. БИРЖИ
==================================================

Подключены публичные Spot API:

BINANCE
BYBIT
GATE
KUCOIN
BINGX

API с VPS доступны.

Создан общий ExchangeAdapter.

Файлы находятся примерно:

lib/exchanges/types.ts
lib/exchanges/index.ts
lib/exchanges/binance.ts
lib/exchanges/bybit.ts
lib/exchanges/gate.ts
lib/exchanges/kucoin.ts
lib/exchanges/bingx.ts

Каждый адаптер умеет:

getUsdtTickers()
getCandles()

Формат свечей унифицирован.

Timeframes:

5m
15m
1h
4h
1d

==================================================
7. ПРОВЕРКА СВЕЧЕЙ
==================================================

Свечи BTC/USDT 1H проверены одновременно на пяти биржах.

Последняя тестовая закрытая свеча была одинакового времени:

2026-09-09T06:00:00.000Z

Пример результатов:

BINANCE
close ~79159
RSI ~57.36
EMA200 ~78996.57
ATR ~357.82

BYBIT
close ~79165
RSI ~57.51
EMA200 ~78996.02

GATE
close ~79166
RSI ~57.53
EMA200 ~78996.16

KUCOIN
close ~79153
RSI ~57.49
EMA200 ~78994.70

BINGX
close ~79159
RSI ~57.39
EMA200 ~78996.90

То есть нормализация OHLCV подтверждена.

Некоторые биржи возвращают свечи в обратном порядке.
Адаптеры приводят всё к:
СТАРАЯ -> НОВАЯ.

Для подтверждённых сигналов используются закрытые свечи.

==================================================
8. РЫНКИ
==================================================

Скрипт:

scripts/sync-markets.ts

Он получил реальные USDT Spot рынки.

Последнее состояние:

BINANCE: 471
BYBIT: 386
GATE: 500
KUCOIN: 500
BINGX: 500

Всего Market:
2357

Уникальных Asset после объединения было:
1228

==================================================
9. TOP-500
==================================================

Создан глобальный Top-500 ликвидности.

Скрипт:

scripts/rank-assets.ts

Asset хранит:

rank
exchangeCount
totalVolume24h
maxVolume24h
liquidityScore
top500

Top-500 сейчас:
500 активов.

Stablecoins фильтруются.

Фильтр уже включает, среди прочего:

USDT
USDC
FDUSD
TUSD
USDP
DAI
USDE
USDS
PYUSD
RLUSD
USD1
USDG
USDQ
USDD
GUSD
LUSD
FRAX
EUR
EURC
EURI

Рейтинг сейчас основан на ликвидности нескольких бирж.
Позже желательно добавить отдельный рейтинг по market cap через CoinGecko.

НЕ путать:
Top-500 по капитализации
и
Суслик Top-500 по ликвидности.

==================================================
10. ИНДИКАТОРЫ
==================================================

Файл:

lib/indicators/index.ts

Реализованы самостоятельно:

SMA
EMA
EMA series
RSI
MACD
ATR

Без AI.

Следующие запланированы:

ADX
Bollinger Bands
Stochastic
VWAP
Supertrend
объёмные показатели

==================================================
11. MARKET ANALYSIS
==================================================

Файл:

lib/analysis/analyze.ts

Функция:

analyzeCandles()

Сейчас рассчитывает:

price
RSI14
EMA20
EMA50
EMA200
MACD
MACD signal
MACD histogram
ATR14
volume
average volume 20
volume ratio

Модель PostgreSQL:

IndicatorSnapshot

предназначена для сохранения рассчитанного состояния market + timeframe + candleTime.

==================================================
12. ПЕРВАЯ СТРАТЕГИЯ
==================================================

Название:

Трендовый Суслик

slug:

trend-suslik

Версия:

v1

Статус:
PUBLISHED

enabled:
true

Конфигурация находится в PostgreSQL Strategy.config JSON.

Настройки включают:

minimumSignalScore

weights:
trend
mediumTrend
rsi
macd
volume

ema:
fast
medium
slow

rsi:
period
longMin
longMax
shortMin
shortMax

macd:
fast
slow
signal

atr:
period
stopMultiplier
takeProfit1Multiplier
takeProfit2Multiplier
takeProfit3Multiplier

volume:
period
minimumRatio

execution:
closedCandleOnly
cooldownCandles

filters:
minimumQuoteVolume24h
top500Only

Strategy также хранит:

timeframes String[]
minExchanges

==================================================
13. ТЕСТ СТРАТЕГИИ
==================================================

Скрипт:

scripts/test-strategy.ts

BTC/USDT 1H проверялся на всех пяти биржах.

Последний результат:

BINANCE NEUTRAL
BYBIT NEUTRAL
GATE NEUTRAL
KUCOIN NEUTRAL
BINGX NEUTRAL

Все:
LONG score около 40
SHORT score 0

Причина:

RSI подтверждал LONG
MACD подтверждал LONG

Но:

EMA-тренд ещё не подтвердился
объём был ниже среднего

Поэтому итог:

NEUTRAL 5/5

Это правильное поведение.
НЕ подгонять стратегию специально под появление LONG.

==================================================
14. АДМИНКА
==================================================

/admin

Уже переделана из старого макета.

Показывает реальные данные PostgreSQL:

Top активов: 500
Рынков: 2357
Свечей в БД: сейчас 0
Активных сигналов: сейчас 0

Есть блок:
Движок анализа

PostgreSQL — подключена
Биржи — Binance, Bybit, Gate, KuCoin, BingX
OHLCV Worker — ещё не запущен
Signal Engine — ещё не запущен

Есть реальная карточка стратегии.

Кнопка:
Настроить

ведёт на:

/admin/strategies/1

==================================================
15. РЕДАКТОР СТРАТЕГИИ
==================================================

Страница:

/admin/strategies/[id]

Работает.

Компонент примерно:

components/admin/StrategyEditor.tsx

API:

app/api/admin/strategies/[id]/route.ts

Редактор на русском языке.

Уже редактирует:

включена/выключена
minimumSignalScore
minExchanges
timeframes
EMA
RSI
MACD
веса условий
ATR
Stop Loss
TP1
TP2
TP3
volume
minimum volume
Top-500 only
closed candle only
cooldown

Есть русские описания параметров.

Настройки сохраняются в PostgreSQL.

ВАЖНО:
Сейчас опубликованная v1 ещё может редактироваться непосредственно.
Это временно.

НАДО СДЕЛАТЬ:
изменение PUBLISHED v1 -> создать DRAFT v2
бэктест v2
paper test v2
только потом publish v2

Старые сигналы должны навсегда оставаться привязанными к версии стратегии, которая их создала.

==================================================
16. ГЛАВНАЯ
==================================================

Главная существует.

Тёмная/светлая тема работает.

Есть таблица рынка.

Пока часть главной использует CoinGecko для отображения цен/активов.

НЕОБХОДИМО позже перевести основной рынок на Asset + Market.

Текущие старые демонстрационные значения вроде:
38 сигналов
RSI 53.4
7/7 стратегий

нужно удалить/заменить реальными значениями.

Нельзя показывать фиктивные торговые показатели как реальные.

==================================================
17. СТРАНИЦЫ
==================================================

Есть:

/
 /login
 /profile
 /signals
 /strategies
 /coin/[symbol]
 /admin
 /admin/strategies/[id]

==================================================
18. OHLCV WORKER — РЕАЛИЗОВАН И ПРОВЕРЕН
==================================================

Production-основа OHLCV Worker реализована.

Файлы:

lib/ohlcv/sync.ts
lib/ohlcv/retry.ts
scripts/ohlcv-worker.ts

Реализовано:

- выбор Top-N активов из PostgreSQL;
- работа через существующие 5 ExchangeAdapter;
- Binance;
- Bybit;
- Gate;
- KuCoin;
- BingX;
- timeframes передаются параметрами;
- получение OHLCV;
- валидация свечей;
- запись Candle;
- upsert по marketId + timeframe + openTime;
- защита от дубликатов;
- retry;
- exponential backoff;
- задержка между запросами;
- ошибка одной биржи не останавливает остальные;
- Market.lastSyncAt;
- режим --once;
- повторный запуск не дублирует историю;
- открытая текущая свеча обновляется при следующем проходе.

Проверено безопасным тестом:

Top-10
× 5 бирж
× 1H
× ~300 свечей.

Реально использовано рынков:
48.

Причина не 50:
часть Top-10 отсутствует на отдельных биржах.

Первоначально:
Candle = 14395.

Распределение:

BINANCE:
10 рынков / 3000 свечей

BINGX:
10 рынков / 2995 свечей

BYBIT:
8 рынков / 2400 свечей

GATE:
10 рынков / 3000 свечей

KUCOIN:
10 рынков / 3000 свечей

Дубликаты:
0.

При втором controlled-run:

активов: 10
рынков: 48
получено для upsert: 95
ошибок: 0
невалидных: 0

После второго запуска:

Candle всего:
14442

closed:
14395

open:
47

Новых строк появилось:
47.

Это соответствует появлению новой часовой свечи почти для всех 48 рынков.

Дублирования 300-свечной истории не произошло.

ВАЖНО:

Текущий показатель worker "written" означает выполненные upsert, а не исключительно INSERT.
Позже переименовать в processed либо разделить created/updated.

Worker пока НЕ запущен как постоянный PM2 daemon.

Не расширять сразу на Top-500 × все TF до проверки IndicatorSnapshot и Signal Engine.

==================================================
19. ПОСЛЕ WORKER
==================================================

Порядок:

1. OHLCV worker
2. IndicatorSnapshot
3. Strategy config из БД
4. Signal Engine
5. реальные сигналы PostgreSQL
6. реальные показатели /admin
7. реальные показатели главной
8. график монеты
9. метки LONG/SHORT на графике
10. TP/SL/Entry
11. история сигналов
12. бэктест
13. версионирование стратегий
14. paper trading
15. уведомления
16. Telegram
17. VK
18. e-mail verification/reset password
19. domain + Nginx + HTTPS
20. subscriptions/PRO
21. новости/статьи/реклама

==================================================
20. КОНЦЕПЦИЯ СИГНАЛОВ
==================================================

Signal — строгое срабатывание формализованной стратегии.

Не называть score вероятностью успеха.

Например:

Сила сигнала: 82/100

это допустимо.

Но:

"вероятность роста 82%"

НЕ использовать без статистически обоснованной модели.

Каждый сигнал должен хранить:

монету
рынок
биржу
таймфрейм
направление
стратегию
версию стратегии
candleTime
entry
SL
TP1
TP2
TP3
score
причины
значения индикаторов
время создания
статус
результат

==================================================
21. МУЛЬТИБИРЖЕВОЕ ПОДТВЕРЖДЕНИЕ
==================================================

Концепция:

BTC может иметь:

Binance BTCUSDT
Bybit BTCUSDT
Gate BTC_USDT
KuCoin BTC-USDT
BingX BTC-USDT

Каждая стратегия может рассчитываться независимо.

Пример:

Binance LONG
Bybit LONG
Gate LONG
KuCoin NEUTRAL
BingX LONG

Итог:

LONG
подтверждение 4/5

Настройка minExchanges находится в Strategy.

Но некоторые стратегии впоследствии должны уметь работать строго на одной бирже.

==================================================
22. БУДУЩИЕ ДАННЫЕ
==================================================

После Spot добавить Futures/Perpetual для пяти бирж.

Нужны:

Funding Rate
Open Interest
ликвидации
Long/Short ratio
basis
объём деривативов

Не смешивать Spot и Futures в одной сущности без marketType.

Market уже имеет:
marketType

==================================================
23. ПРАВИЛА РАЗРАБОТКИ
==================================================

НЕ использовать npm audit fix --force без анализа.

НЕ обновлять Prisma major автоматически.

НЕ удалять данные PostgreSQL без явной необходимости.

НЕ использовать prisma db push --force-reset.

Перед изменением schema:
npx prisma format
npx prisma validate

После:
npx prisma generate
npx prisma db push

Перед production:
npm run build

После успешного build:
pm2 restart svechnoy-suslik --update-env

Весь UI на русском.

Секреты никогда не писать в исходный код.

.env не публиковать.

==================================================
24. ФАЙЛЫ, КОТОРЫЕ НУЖНО БЕРЕЧЬ
==================================================

.env
prisma/schema.prisma
auth.ts
lib/prisma.ts

lib/exchanges/*
lib/indicators/*
lib/analysis/*
lib/strategies/*

scripts/sync-markets.ts
scripts/rank-assets.ts
scripts/test-strategy.ts
scripts/ohlcv-worker.ts
scripts/snapshot-worker.ts
scripts/test-strategy-runtime.ts
lib/strategies/config.ts
lib/strategies/runtime.ts

components/admin/StrategyEditor.tsx

app/api/admin/strategies/[id]/route.ts
app/admin/page.tsx
app/admin/strategies/[id]/page.tsx

==================================================
25. ТЕКУЩАЯ ТОЧКА ПРОДОЛЖЕНИЯ
==================================================

Реализовано и проверено в песочнице (см. §26-§30):

- OHLCV Worker (VPS, живой прогон ранее).
- IndicatorSnapshot Engine (VPS, живой прогон ранее).
- Strategy Runtime (самотесты 54/54; живой прогон — на VPS).
- Signal Engine: ядро + worker DRY-RUN (самотест 48/48;
  запись в PostgreSQL по-прежнему НЕ выполнялась).
- Свечной график рынка (§29, проверен на VPS): tsc 0, build green,
  живой вид с реальными свечами НЕ проверен (в песочнице
  нет PostgreSQL с Candle) — проверить на VPS.
- UI-заглушки заменены реальной функциональностью (§30).
- Динамические периоды + MACD dead zone (§31): самотесты
  27/27; живой DB-режим — scripts/test-strategy-periods.ts
  на VPS.

Текущее состояние тестового контура (VPS, до Signal Engine):

Candle: 14442+, IndicatorSnapshot: 48, Signal: 0.
Top-10 тестовых активов, 1H, 48 рынков,
биржи Binance/Bybit/Gate/KuCoin/BingX.

В песочнице binaries.prisma.sh недоступен:
npx prisma format / validate / generate падают по сети —
выполнять на VPS. Схема prisma/schema.prisma в Git,
изменений в этой серии этапов НЕ было.

НУЛЕВОЙ ШАГ НА VPS (строго по порядку, ~15 минут):

1. cd ~/svechnoy-suslik && git pull
   (после переноса Arena-ветки в main)
2. npm install
   (новая зависимость lightweight-charts ^5.2.1)
3. npx prisma format && npx prisma validate
4. npx prisma generate
5. psql: SELECT COUNT(*) FROM "Signal"; — ожидание 0.
6. npx prisma db push
   (расширение Signal из этапа Signal Engine;
   Candle/Snapshot/Strategy не трогаются;
   --force-reset запрещён)
7. npm run build && pm2 restart svechnoy-suslik --update-env

Затем проверки UI и графика в браузере:
8. /coin/BTC — график: выбор биржи, ТФ, индикаторы,
   zoom/прокрутка, тёмная/светлая тема, телефон.
9. /strategies — реальные стратегии из БД.
10. /, /signals, /profile — честные состояния.

Затем живой прогон Strategy Runtime:
11. npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=1h --once
12. npx tsx scripts/snapshot-worker.ts --top=10 --timeframe=1h
13. npx tsx scripts/test-strategy-runtime.ts --top=10 --timeframe=1h
14. npx tsx scripts/test-strategy-runtime.ts --prove-db-link --top=10 --timeframe=1h
    (Signal count не меняется, config восстанавливается)

Затем динамические периоды (§30):
15. npx tsx scripts/test-strategy-periods.ts --self-test
    (ожидание: 59/59)
16. npx tsx scripts/test-strategy-periods.ts --top=10 --timeframe=1h
    (только чтение; нестандартные периоды строго по свечам,
    ринки без истории — cannot-evaluate, БЕЗ scoring по snapshot)

Затем Signal Engine (см. §28):
17. npx tsx scripts/test-signal-engine.ts --self-test
18. npx tsx scripts/signal-worker.ts --top=10 --timeframe=1h
    DRY-RUN: Signal остаётся 0.
19. npx tsx scripts/signal-worker.ts --top=10 --timeframe=1h --apply
20. Повторить шаг 18: дубликатов быть не должно.

СЛЕДУЮЩИЙ ЭТАП (после боевого прохода Signal Engine):

Реальные сигналы в интерфейсе: счётчики /admin и главной,
метки LONG/SHORT на графике монеты, история сигналов,
затем статусы ACTIVE/CLOSED с фиксацией результата
по движению к TP/SL.

Запрещено без явной команды: production Signal Engine,
запись Signal, изменение minExchanges автоматически,
push/merge в main, изменения VPS.

==================================================
26. STRATEGY RUNTIME — РЕАЛИЗОВАН И ПРОВЕРЕН
==================================================

Дата: 09.09.2026

Связаны в единый контур:

PostgreSQL IndicatorSnapshot
→
PostgreSQL Strategy.config (валидированный)
→
Strategy Runtime
→
результат каждой биржи
→
мультибиржевое подтверждение.

Signal на этом этапе НЕ создаются.

Созданные файлы:

lib/strategies/config.ts
- Тип TrendSuslikConfig.
- Строгая валидация Strategy.config без внешних библиотек.
- Проверяются: minimumSignalScore 0..100, веса 0..100
  (сумма > 0), EMA целые > 0 и fast < medium < slow,
  RSI period > 0 и диапазоны 0..100 (min <= max),
  MACD периоды > 0, ATR period > 0 и multipliers > 0,
  volume period > 0 и minimumRatio >= 0,
  minimumQuoteVolume24h >= 0, cooldownCandles >= 0,
  booleans, timeframes (непустой список из 5m/15m/1h/4h/1d),
  minExchanges 1..5.
- Лишние неизвестные ключи разрешены (forward-compat).

lib/strategies/runtime.ts
- Чистые функции БЕЗ доступа к БД и сети
  (не импортируют Prisma — проверено аудитом).
- applyStrategyFilters: top500Only, minimumQuoteVolume24h
  (null объём считается за 0).
- evaluateSnapshot: snapshot → LONG/SHORT score + direction
  + reasons + warnings.
- aggregateAssetGroup: Asset + timeframe + slug + version,
  порог minExchanges, подтверждение вида 4/5.
- Конфликт LONG+SHORT одновременно → NEUTRAL + объяснение,
  направление не выдумывается.

Изменённые файлы:

lib/strategies/trend-suslik.ts
- runTrendSuslik(analysis, config): config приходит
  параметром из PostgreSQL после валидации.
- Hardcoded trendSuslikConfig УДАЛЁН из runtime.
- Добавлены warnings при расхождении периодов config
  с периодами snapshot (см. ограничение ниже).

scripts/test-strategy-runtime.ts
- DB-прогон Top-N × timeframe, только чтение
  (SELECT + count, INSERT нет — проверено аудитом
  и счётчиком Signal до/после).
- Берёт только enabled=true + status=PUBLISHED.
- Для каждого Market — последний IndicatorSnapshot.
- Выводит per-exchange результаты и agregaciyu.
- Режимы: --self-test (без БД), --check-validation,
  --prove-db-link (временная смена параметра в БД
  со сравнением и восстановлением в finally).

scripts/test-strategy.ts
- Переведён на config из PostgreSQL (был hardcoded вызов).
- minExchanges теперь из Strategy, а не константа 3.

Известное ограничение (честное):
IndicatorSnapshot хранит фиксированные периоды
(EMA 20/50/200, RSI 14, MACD 12/26/9, средний объём 20).
Runtime использует их позиционно
(fast → ema20, medium → ema50, slow → ema200).
Пороги, веса, minimumSignalScore, фильтры, minExchanges
учитываются из config полностью.
При несовпадении периодов runtime продолжает работу
и возвращает warnings (видны в CLI).
Произвольные периоды потребуют расширения схемы snapshot.

Проверка в песочнице:
- self-test: 54/54 (валидация, scoring LONG/SHORT/NEUTRAL,
  чувствительность к config, фильтры, agregaciya 4/5,
  конфликт, аудит отсутствия Signal-записей).
- validation battery: 32/32.
- tsc: 0 новых ошибок (14 старых в app/admin и rank-assets
  из-за отсутствующего prisma generate в песочнице).
- next build в песочнице упирается в те же 14 старых ошибок
  (нет скачивания Prisma engines); на VPS после
  prisma generate собирается.
- Живой прогон Top-10 × 1H и --prove-db-link выполняются
  на VPS (см. нулевой шаг в разделе 25).

==================================================
27. STRATEGY RUNTIME — ДИНАМИЧЕСКИЕ ПЕРИОДЫ И MACD DEAD ZONE ПРОВЕРЕНЫ НА VPS
==================================================

Дата: 09.09.2026

Этот раздел заменяет известное ограничение раздела 26 о фиксированных периодах IndicatorSnapshot.

Текущая архитектура:

- если периоды Strategy.config стандартные
  (EMA 20/50/200, RSI 14, MACD 12/26/9, ATR 14, Volume 20),
  Strategy Runtime использует готовый IndicatorSnapshot;

- если хотя бы один период нестандартный,
  Runtime использует только закрытые Candle из PostgreSQL
  и рассчитывает EMA, RSI, MACD, ATR и Volume с фактическими
  периодами Strategy.config;

- дополнительных запросов к API бирж для такого расчёта нет;

- Candle после candleTime snapshot в расчёт не попадают;

- если истории недостаточно или данные не синхронизированы,
  Runtime возвращает cannot-evaluate и НЕ подменяет выбранные
  периоды значениями фиксированного IndicatorSnapshot.

MACD dead zone:

- Strategy.config поддерживает macd.deadZoneRatio;
- порог считается относительно цены:
  deadZone = deadZoneRatio × abs(price);
- при abs(macdHistogram) <= deadZone MACD не начисляет
  LONG или SHORT score;
- старый config без поля валиден и получает deadZoneRatio=0;
- настройка добавлена в русскую админку;
- production-значение deadZoneRatio пока сознательно не выбрано.

Проверено на VPS:

- Prisma validate — успешно;
- Prisma generate 6.19.3 — успешно;
- TypeScript — 0 ошибок;
- production build — успешно;
- индикаторы — 74/74;
- динамические периоды/dead zone — 59/59;
- Strategy Runtime self-test — 54/54;
- реальный PostgreSQL Top-10 × 1H, нестандартные периоды:
  48 рынков, 46 evaluated по Candle, 0 cannot-evaluate,
  2 PROM filtered по реальному quoteVolume24h;
- стандартный PostgreSQL Runtime:
  minimumSignalScore=72;
  minExchanges=2;
  ZEC LONG 4/4;
  DOGE LONG 5/5;
  NEAR LONG 5/5;
  итог LONG=3, SHORT=0, NEUTRAL=7, конфликтов=0;
- Signal 0 → 0, read-only подтверждён.

Новые тесты:

scripts/test-indicators.ts
scripts/test-strategy-periods.ts

Signal Engine в production не переносился и на этом этапе не запускается.

==================================================
28. SIGNAL ENGINE — ЯДРО + WORKER РЕАЛИЗОВАНЫ, DRY-RUN ПРОВЕРЕН
==================================================

Дата: 09.09.2026

Контур завершён до черновиков сигналов:

PostgreSQL IndicatorSnapshot
→ Strategy Runtime (оценка каждой биржи)
→ мультибиржевое подтверждение (minExchanges)
→ Signal Engine (планирование сигналов)
→ scripts/signal-worker.ts (dry-run / --apply в PostgreSQL).

Запись в PostgreSQL на этом этапе НЕ выполнялась:
сначала npx prisma db push на VPS, затем dry-run,
и только потом --apply (см. §25, шаги 4-15).

Созданные файлы:

lib/signals/engine.ts
- Чистые функции БЕЗ БД и сети
  (аудит отсутствия @prisma/client, fetch, create/upsert
  встроен в самотест).
- timeframeMs: длительность свечи 5m/15m/1h/4h/1d.
- computeRiskLevels: SL/TP1/TP2/TP3 через ATR multipliers
  из config (LONG: SL ниже входа, TP выше; SHORT зеркально).
  Без ATR14 уровни НЕ выдумываются — всё null.
- isCandleClosed: execution.closedCandleOnly.
- isCooldownActive: execution.cooldownCandles
  (пауза в свечах после последнего сигнала той же
  стратегии + рынка + timeframe + направления;
  кандидат старее последнего сигнала тоже запрещён).
- planSignals: агрегация → черновики SignalDraft:
  - только подтверждённые LONG/SHORT;
    NEUTRAL и KONFLIKT сигналов не дают (глобальная причина);
  - сигнал получает только рынок, который САМ проголосовал
    за подтверждённое направление;
  - отказы фиксируются с причиной (фильтр, нет snapshot,
    незакрытая свеча, cooldown, нет ATR, дубликат);
  - в черновик входят: стратегия+версия, монета, marketId,
    биржа, рынок, timeframe, направление, score, entry,
    SL/TP1/TP2/TP3, atr14, reason (сводка), reasons[],
    warnings[], indicatorsJson (все значения snapshot),
    candleTime.
- signalKey: marketId|candleTime ISO|direction.
- score = сила совпадения условий, НЕ вероятность успеха.

scripts/signal-worker.ts
- Prod-worker Signal Engine.
- По умолчанию DRY-RUN: полный цикл до черновиков,
  записи в БД НЕТ (явно печатается).
- Запись только при --apply: writeSignals →
  signal.createMany(..., skipDuplicates: true).
  Единственное место записи в файле; вызов только внутри
  if (apply) — это проверяет самотест по исходнику.
- Только enabled=true + status=PUBLISHED стратегии;
  config через validateStrategyRuntime, невалидные
  стратегии пропускаются с выводом ошибок.
- Cooldown-карта: signal.groupBy(marketId, _max candleTime)
  по стратегии+версии+timeframe+направлению.
- Существующие ключи из БД → планSignals отсекает дубли
  ещё до записи; в БД дубль невозможен и по UNIQUE.

scripts/test-signal-engine.ts
- Самотест БЕЗ БД и сети: 48/48.
- Покрывают: длительности таймфреймов, уровни риска
  LONG/SHORT и их порядок, отказ при ATR null/0,
  границы закрытия свечи, границы cooldown (включая
  ровно N свечей и кандидата старее последнего сигнала),
  NEUTRAL → нет сигналов, KONFLIKT → нет сигналов,
  только голосовавшие рынки, passthrough отказов фильтров,
  целостность черновика, closedCandleOnly вкл/выкл,
  cooldown в планировании, dedup, SHORT-поток,
  неизвестный таймфрейм, отсутствие snapshot,
  аудиты чистоты engine.ts и worker'а.

Изменённые файлы:

prisma/schema.prisma
- Модель Signal расширена (старые поля сохранены):
  strategyVersion Int @default(1), marketId Int (FK Market,
  onDelete Cascade), exchange, exchangeSymbol, atr14 Float?,
  candleTime DateTime, reasonsJson Json?, warningsJson Json?,
  indicatorsJson Json?.
- UNIQUE(strategyId, strategyVersion, marketId, timeframe,
  candleTime, direction) — защита от дублей по правилу
  «один Signal на Strategy version + Market + timeframe +
  candleTime + direction».
- @@index([marketId, timeframe, direction, candleTime])
  под cooldown-запросы.
- Market: добавлена обратная связь signals Signal[].
- generate/db push/format/validate — на VPS (песочница без
  доступа к binaries.prisma.sh, ограничение известное).
  Перед db push: SELECT COUNT(*) FROM "Signal" — ожидается 0.

app/signals/page.tsx
- УДАЛЕНЫ выдуманные демо-сигналы (нарушение правила
  честных торговых данных).
- Страница читает реальные ACTIVE сигналы из PostgreSQL
  (последние 50), показывает биржу, направление,
  стратегию+версию, ТФ, силу, вход, SL, TP1, время свечи.
- Нет сигналов → «Нет данных. Signal Engine ещё не
  создал сигналов»; БД недоступна → «Нет данных:
  база временно недоступна».
- Добавлена честная пометка: сила — степень совпадения
  условий, а не вероятность успешной сделки.

Проверка в песочнице:
- npx tsx scripts/test-signal-engine.ts --self-test → 48/48.
- npx tsc --noEmit → 16 ошибок, ВСЕ старые и задокументированные
  (14 implicit-any в app/admin и rank-assets + 2 InputJsonValue
  в test-strategy-runtime) — следствие отсутствующего
  prisma generate; НОВЫХ ошибок 0.
- npm run build → падает на той же первой старой ошибке
  (app/admin, implicit any) — известное ограничение песочницы;
  компиляция при этом успешна, на VPS после prisma generate
  собирается (см. §25, шаги 3 и 6).
- Живой dry-run, боевой проход и проверка дубликатов — на VPS.

Известные ограничения:
- В БД сигналы ещё не создавались ни разу — боевой проход
  впереди (§25).
- Cooldown опирается на историю Signal в PostgreSQL:
  ручное удаление сигналов «забывает» cooldown.
- Статусы ACTIVE/CLOSED и фиксация результата (движение
  к TP/SL) — следующий отдельный этап, в Engine пока
  только ACTIVE по умолчанию.
- Score стратегии — сила совпадения условий, а не
  вероятность успешной сделки (пометка выведена в UI).

==================================================
29. СВЕЧНОЙ ГРАФИК РЫНКА — ПРОВЕРЕН НА VPS
==================================================

Дата: 09.09.2026

Полноценный интерактивный свечной график в существующей
странице монеты /coin/[SYMBOL]. Второй OHLCV-конвейер НЕ
создавался: данные читаются из существующего PostgreSQL
Candle/Market/Asset.

Новая зависимость:
lightweight-charts ^5.2.1 (минимальная, без peer-зависимостей,
совместима с Next.js 15 + React 19; ESM, клиентский бандл).

Созданные файлы:

app/api/chart/markets/route.ts
- Без параметров: активы, у которых есть включённые
  SPOT USDT-рынки со свечами (из Asset/Market/Candle).
- С ?symbol=BTC: биржи актива и доступные таймфреймы
  с количеством свечей и временем последней.
- Только чтение; ленивый импорт Prisma;
  честные 404/503 на русском.

app/api/chart/candles/route.ts
- GET ?symbol&exchange&timeframe&limit (50..1000, дефолт 300).
- Закрытые свечи PostgreSQL, от старых к новым.
- Индикаторы считает СУЩЕСТВУЮЩИЙ слой lib/indicators:
  EMA 20/50/200, SMA 20, RSI 14, MACD 12/26/9 — тот же
  набор, что и в IndicatorSnapshot; ATR на график
  сознательно не вынесен (не перегружать основной график).
- Ответ содержит series, выровненные по времени (UTC).

components/chart/CandleChart.tsx
- Клиентский компонент lightweight-charts v5:
  свечи + объём-оверлей + EMA/SMA на главной панели,
  RSI в отдельной панели, MACD (линия+сигнал+гистограмма)
  в третьей панели; переключатели индикаторов.
- Выбор монеты, биржи и таймфрейма (только реально
  доступные в БД).
- Zoom (колесо/щипок) и прокрутка истории — встроенные.
- Тёмная/светлая тема: цвета читаются из CSS-переменных
  проекта и обновляются автоматически (MutationObserver
  на data-theme).
- Состояния: загрузка, ошибка с кнопкой «Повторить»,
  честное «Нет данных», все тексты на русском.
- Защита от гонок запросов (abort + requestId).

lib/indicators/index.ts — расширение
- Добавлены серийные версии: smaSeries, rsiSeries,
  macdSeries, atrSeries (для графика и параметрического
  анализа). Старые sma/ema/rsi/macd/atr сохранены и
  теперь делегируют сериям — поведение проверено
  на эквивалентность (300 случайных прогонов, разница 0).

app/coin/[symbol]/page.tsx — переписана
- УДАЛЕНЫ выдуманные карточки «LONG / 4 LONG / 78 / 100 / 4H»
  (нарушение правила честных торговых данных).
- Реальные карточки: биржи с данными, таймфреймы,
  последняя закрытая свеча (UTC), активные сигналы
  (пока честное «Нет»).
- Проверка тикера, честные состояния «нет актива» и
  «база недоступна».

Проверка:
- tsc: 0 новых ошибок; npm run build: успешно (exit 0).
- Dev-сервер: /coin/BTC -> 200 с честным состоянием,
  /api/chart/* -> 400/503 с русскими сообщениями.
- Визуальная проверка с реальными свечами — на VPS (§25, шаг 8).

==================================================
30. UI-ЗАГЛУШКИ — АУДИТ И ЗАМЕНА НА РЕАЛЬНУЮ ФУНКЦИОНАЛЬНОСТЬ
==================================================

Дата: 09.09.2026

Аудит найденных заглушек и что с ними сделано:

1. components/MarketOverview.tsx — выдуманные цифры
   («$2.71 трлн», «38 сигналов», «RSI 53.4», «7/7 движок
   работает»). Стало: реальные данные — капитализация
   Top-500 (сумма CoinGecko), счётчики PostgreSQL
   (свечи/снимки/ACTIVE-сигналы/стратегии), честные
   «Нет данных» при недоступной базе.

2. app/strategies/page.tsx — 7 выдуманных стратегий
   с «АКТИВНА». Стало: реальные PUBLISHED-стратегии
   из PostgreSQL (название, версия, таймфреймы,
   minExchanges, честный статус АКТИВНА/ВЫКЛЮЧЕНА),
   пустое состояние и состояние недоступной базы.

3. components/Header.tsx — кнопка «Поиск» без обработчика.
   Стало: рабочий поиск по активам
   (components/SearchBox.tsx + app/api/search/route.ts,
   PostgreSQL Asset, переход на /coin/SYMBOL, debounce,
   Escape/клик-вне, честное «Ничего не найдено»).

4. components/UserMenu.tsx — ссылка «Мой профиль» вела
   на несуществующий /profile. Стало: страница
   app/profile/page.tsx с реальными данными сессии
   (имя, email, роль USER/PRO/ADMIN), редирект на /login
   для неавторизованных. Подписки/уведомления честно
   помечены как будущие.

5. components/MarketTable.tsx — мёртвые чипы
   «С сигналом» и «Настроить колонки», колонки RSI («—»)
   и «Сигнал» («АНАЛИЗ») без данных. Стало: рабочие
   фильтры «Все активы / Рост / Падение» (с активным
   состоянием), фиктивные чипы и колонки удалены,
   честное «Ничего не найдено» при пустом фильтре.

6. lib/market.ts — при недоступности CoinGecko
   подсовывались демо-монеты как реальные цены.
   Стало: пустой список, на главной честное
   «источник рынка временно недоступен».

7. app/signals/page.tsx и страницы с БД — переведены
   на ленивый импорт Prisma: недоступная база даёт
   честное «Нет данных», а не падение страницы.

8. lib/prisma.ts — клиент создаётся лениво (Proxy)
   при первом обращении. На VPS поведение то же;
   в песочнице без prisma generate приложение больше
   не падает при импорте — build проходит полностью.

Сознательно оставлено как есть:
- /admin и админка — работали, не тронуты (кроме
  валидации, см. §30);
- роли и авторизация Auth.js — не тронуты;
- «Управление подписками» в /profile — честная пометка
  «появится в будущих версиях» (backend отсутствует).

Проверка: dev-сервер, все страницы 200
(/, /signals, /strategies, /login, /coin/BTC),
/profile -> 307 на /login без сессии,
tsc 0, npm run build exit 0.

==================================================
31. STRATEGY RUNTIME — ДИНАМИЧЕСКИЕ ПЕРИОДЫ + MACD DEAD ZONE (ДЕТАЛИ РЕАЛИЗАЦИИ)
==================================================

Дата: 09.09.2026

Разрешение известного ограничения «фиксированные периоды
snapshot» + мёртвая зона MACD.

lib/analysis/analyze.ts
- AnalysisParams + analyzeCandlesWithParams():
  анализ с произвольными периодами EMA/RSI/MACD/ATR/объёма
  по закрытым свечам; minCandlesForParams() — сколько
  свечей нужно. analyzeCandles() сохранил прежнее
  поведение (делегирует с дефолтными периодами).

lib/strategies/config.ts
- TrendSuslikMacd.deadZoneRatio: доля цены; валидация
  0..0.1, поле необязательное — старые конфиги в БД
  валидны и означают зону 0 (проверено тестом).
- periodsAreStandard(): все ли периоды стратегии
  совпадают с фиксированным набором IndicatorSnapshot.
- configToAnalysisParams(), ActualPeriods,
  snapshotActualPeriods().

lib/strategies/trend-suslik.ts
- runTrendSuslik(a, config, actualPeriods?): warnings
  теперь сравнивают config с ФАКТИЧЕСКИМИ периодами
  анализа; при расчёте по свечам с периодами config
  warnings нет. Без параметра — прежнее поведение.
- Мёртвая зона MACD: |histogram| <= deadZoneRatio * |price|
  не даёт баллов ни LONG, ни SHORT; в причине видна зона.
  deadZoneRatio = 0 — прежнее поведение.

lib/strategies/runtime.ts (УСИЛЕНО ПО РЕЗУЛЬТАТАМ РЕВЬЮ VPS)
- evaluateSnapshot(input, config, candles?):
  - стандартные периоды -> значения из IndicatorSnapshot,
    как раньше;
  - НЕСТАНДАРТНЫЕ -> ТОЛЬКО закрытые Candle PostgreSQL +
    analyzeCandlesWithParams с периодами config. FALLBACK
    НА ФИКСИРОВАННЫЙ SNAPSHOT ПОЛНОСТЬЮ УДАЛЁН:
    позиционная подстановка RSI14/EMA20/50/200/MACD12-26-9
    при других периодах давала бы ложный scoring.
  - при нестандартных периодах и любой проблеме с историей
    (свечи не переданы / пусто / меньше minCandlesForParams /
    последняя свеча не на candleTime snapshot / расхождение
    цены / ошибка расчёта) рынок отсеивается со статусом
    "cannot-evaluate" (расширен SkippedMarket.status):
    рынка сейчас нельзя честно оценить, в агрегации он
    не голосует, направления и баллов у результата НЕТ.
  - цена сверяется с относительной tolerance 1e-9
    (priceMatches): input.price и computed.price проходят
    разные преобразования float8 -> number; candleTime
    остаётся ТОЧНЫМ ограничением.
  - свечи ПОСЛЕ candleTime snapshot в расчёте не участвуют
    никогда (фильтр до анализа; доказано тестом побайтового
    равенства результата с/без «будущих» свечей).
  - без обращений к биржам.

scripts/signal-worker.ts (по-прежнему DRY-RUN по умолчанию)
- Для нестандартных периодов подтягивает свечи из
  PostgreSQL и передаёт их в evaluateSnapshot.

components/admin/StrategyEditor.tsx
- Поле «Мёртвая зона (доля цены)» в секции MACD,
  нормализация старых конфигов без поля.

app/api/admin/strategies/[id]/route.ts
- Полная серверная валидация config через
  validateTrendSuslikConfig (раньше проверялся только
  minimumSignalScore); ошибки по-русски с перечислением.

scripts/test-strategy-periods.ts
- Самотест 59/59 без БД: распознавание периодов,
  эквивалентность analyzeCandles, границы достаточности
  свечей (ровно N / N-1 для 8 наборов периодов),
  отсечение будущего, cannot-evaluate при недостатке
  истории, ЯВНОЕ доказательство «нет scoring по snapshot»,
  tolerance цены, мёртвая зона (симметрия, границы,
  совместимость), валидация deadZoneRatio, аудит чистоты.
- Живой DB-режим для VPS (ТОЛЬКО чтение):
  --top=10 --timeframe=1h — нестандартные периоды строго
  по свечам; рынки без достаточной истории —
  cannot-evaluate. Signal не создаются.

Проверка в песочнице (после правки по ревью VPS):
- 59/59 самотест периодов; 54/54 и 48/48 прежние
  (обратная совместимость полная); tsc 0; build exit 0.
- minCandlesForParams() аудитирован против реальных
  реализаций ema/rsi/macd/atr/sma (включая guard macd()
  N >= slow+signal); boundary-тесты: ровно N — все
  индикаторы не null, N-1 — null.
- Явный тест: нестандартный RSI/EMA/MACD/ATR/Volume +
  недостаточная история НЕ даёт scoring по фиксированному
  snapshot (контроль на стандартном config с теми же
  значениями даёт LONG; guarded-результат —
  cannot-evaluate).
- Живой расчёт по свечам — на VPS (§25, шаг 16).

СОСТАВ ПЕРЕНОСА STRATEGY RUNTIME НА PRODUCTION
(БЕЗ Signal Engine: без scripts/signal-worker.ts,
lib/signals/*, расширения Prisma Signal, app/signals):

1. lib/indicators/index.ts — серийные версии + делегирование
   (совместим и со старой версией: скалярные сигнатуры
   не менялись; рекомендуем текущую).
2. lib/analysis/analyze.ts — AnalysisParams,
   analyzeCandlesWithParams, minCandlesForParams.
3. lib/strategies/config.ts — deadZoneRatio,
   periodsAreStandard, configToAnalysisParams,
   ActualPeriods, snapshotActualPeriods.
4. lib/strategies/trend-suslik.ts — dead zone,
   фактические периоды в warnings.
5. lib/strategies/runtime.ts — cannot-evaluate,
   priceMatches, строгое разделение по периодам.
6. scripts/test-strategy-periods.ts — 59 проверок +
   read-only DB-режим.
7. scripts/test-strategy-runtime.ts — исправления
   configToJson и фикстура deadZoneRatio: 0.

Опционально (не Runtime, но безвредно): app/admin/page.tsx,
scripts/rank-assets.ts (явные типы, коммит исправления tsc).

Signal Engine (lib/signals/engine.ts, scripts/signal-worker.ts,
расширение Signal в схеме, app/signals/page.tsx) на
production НЕ переносится до отдельной команды.
