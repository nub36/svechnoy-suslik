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

OHLCV Worker успешно проверен.

IndicatorSnapshot Engine успешно реализован и проверен.

Текущее состояние тестового контура:

Candle:
14442+

IndicatorSnapshot:
48

Top:
10 тестовых активов

Timeframe:
1H

Рынков:
48

Биржи:
Binance
Bybit
Gate
KuCoin
BingX

Snapshot рассчитывается исключительно из PostgreSQL Candle.

Используются только закрытые свечи.

Повторный запуск Snapshot Engine не создаёт дубликаты.

Strategy Runtime успешно реализован и проверен.

СЛЕДУЮЩИЙ ЭТАП:

Signal Engine.

Нулевой шаг перед Signal Engine (на VPS, 5 минут):
1. cd ~/svechnoy-suslik && git pull
2. npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=1h --once
3. npx tsx scripts/snapshot-worker.ts --top=10 --timeframe=1h
4. npx tsx scripts/test-strategy-runtime.ts --top=10 --timeframe=1h
5. npx tsx scripts/test-strategy-runtime.ts --prove-db-link --top=10 --timeframe=1h
6. Убедиться: Signal count не изменился, config восстановлен.

После живого подтверждения — Signal Engine:

1. Создавать Signal в PostgreSQL из подтверждённых agregacij
   Strategy Runtime (только enabled + PUBLISHED стратегии).
2. Каждый Signal хранит: монету, рынок, биржу, таймфрейм,
   направление, стратегию + версию, candleTime, entry,
   SL/TP1/TP2/TP3 (через ATR multipliers из config),
   score, причины, значения индикаторов, время создания.
3. Учитывать execution.closedCandleOnly и execution.cooldownCandles.
4. Защита от дубликатов: один Signal на
   Strategy version + Market + timeframe + candleTime + direction.
5. Статусы ACTIVE/CLOSED и фиксация результата позже
   (движение к TP/SL), но не в первом коммите Engine.
6. Сначала dry-run режим (вывод без INSERT), потом боевой проход
   Top-10 × 1H.
7. После Engine: реальные счётчики /admin и главной,
   график монеты, метки LONG/SHORT, история сигналов.

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
28. UI/CHART — ЧИСТАЯ ИНТЕГРАЦИОННАЯ ВЕТКА ОТ 4db41af
==================================================

Дата: 09.09.2026

Чистая интеграционная ветка arena/ui-chart-clean,
собранная СТРОГО от origin/main (4db41af) без merge
старой Arena-истории. Содержит только проверенную
на VPS функциональность графика и честный UI.

Основа ветки — production main:

30f0463 Доработан Strategy Runtime (production-ready)
4db41af Обновлена документация production-ready Runtime

Runtime (§26-§27) в этой ветке НЕ менялся:
lib/indicators, lib/analysis, lib/strategies,
scripts/test-indicators.ts, test-strategy-periods.ts,
test-strategy-runtime.ts — идентичны origin/main.

1. Свечной график (проверен на VPS):

- lightweight-charts ^5.2.1 (минимальная зависимость,
  без peer-зависимостей, Next 15 + React 19);
- app/api/chart/candles — закрытые свечи PostgreSQL
  + индикаторы (EMA 20/50/200, SMA 20, RSI 14,
  MACD 12/26/9) существующим слоем lib/indicators;
- app/api/chart/markets — активы/биржи/таймфреймы
  ОДНИМ агрегированным GROUP BY SQL в PostgreSQL
  (без N+1 запросов и без загрузки свечей в Node.js);
- components/chart/CandleChart — свечи, объём,
  EMA/SMA, панели RSI и MACD, переключатели, выбор
  монеты/биржи/таймфрейма (только реально существующие
  в БД; сейчас в основном 1H — показывается он),
  zoom/прокрутка, тёмная/светлая тема, русский UI,
  loading/error/empty, защита от гонок запросов;
- VPS-проверка: BTC/ETH/DOGE/ZEC/NEAR, переключение
  бирж, EMA/RSI/MACD/Volume, HTTP API, /coin/BTC,
  npm run build — работают.

2. Страница монеты /coin/[SYMBOL] — БЕЗ Signal:

- полностью убран prisma.signal (count и карточка
  «Активные сигналы») — страница не зависит от
  Signal Engine;
- реальные данные: место в Суслик Top-500 (или
  «Вне рейтинга»), биржи с данными, таймфреймы
  (только существующие в Candle), последняя закрытая
  свеча (UTC);
- asset.id добавлен в findUnique select;
- таймфреймы/счётчики/последняя свеча — единый
  GROUP BY SQL на стороне PostgreSQL.

3. Честный UI (без выдуманных значений):

- главная: капитализация Top-500 (CoinGecko, кэш 60 c),
  свечи/снимки/активные рынки/стратегии — счётчики
  PostgreSQL; демо-монеты CoinGecko-фолбэка удалены;
- /strategies — реальные PUBLISHED-стратегии из БД;
- поиск по активам (иконка в шапке) — рабочий,
  /api/search по PostgreSQL, переход на /coin/SYMBOL;
- фильтры таблицы «Все активы / Рост / Падение» —
  рабочие; колонки-заглушки RSI/«АНАЛИЗ» удалены;
- /profile — реальные данные сессии (имя, email, роль);
- /signals — честный статический экран «Signal Engine
  ещё не развёрнут» БЕЗ prisma.signal, lib/signals и
  каких-либо предположений о Signal schema;
- все состояния: loading / error с «Повторить» /
  честное «Нет данных», русский интерфейс,
  тёмная/светлая тема, мобильная вёрстка.

4. Что СОЗНАТЕЛЬНО НЕ перенесено из старой ветки:

- Signal Engine: lib/signals/*, scripts/signal-worker.ts,
  scripts/test-signal-engine.ts — отсутствуют;
- расширение Prisma Signal — prisma/schema.prisma и
  PROJECT_SCHEMA.prisma идентичны origin/main;
- ленивый Prisma-клиент (Proxy) в lib/prisma.ts —
  оставлен production singleton из main (в песочнице
  без prisma generate это даёт известное ограничение
  сборки, см. ниже);
- sandbox type fixes app/admin / rank-assets —
  не переносились (на VPS с реальным клиентом
  типизация зелёная, проверено на 30f0463).

5. Проверки ветки (песочница):

- scripts/test-indicators.ts: 74/74;
- scripts/test-strategy-periods.ts --self-test: 59/59;
- scripts/test-strategy-runtime.ts --self-test: 54/54;
- npx tsc --noEmit: 14 ошибок — ВСЕ старые implicit-any
  в app/admin и scripts/rank-assets (следствие stub-клиента
  @prisma/client без prisma generate в песочнице;
  на VPS с реальным клиентом эти же файлы дают 0 —
  проверено на 30f0463); ошибок в новых UI/chart файлах нет;
- npm run build: компиляция и проверка типов успешны;
  финальный сбор страниц упирается в отсутствие
  сгенерированного клиента (та же песочница);
  этот же код графика на VPS собирался успешно;
- npx prisma validate / generate: binaries.prisma.sh
  недоступен из песочницы — выполнить на VPS
  (schema.prisma не менялась относительно main).


==================================================
28.1. ИСПРАВЛЕНИЕ VPS-РЕВЮ: 503 /api/chart/markets
==================================================

Дата: 09.09.2026. Исправление в ветке arena/ui-chart-clean
поверх bd1f40f. Ожидает повторной VPS-проверки.

Точная причина 503: $queryRaw в runtime Prisma 6.19.3 —
прототипный метод клиента. Код commit 84f7c63 отрывал его
в переменную (const queryRaw = prisma.$queryRaw as ...),
вызов queryRaw`...` терял this -> TypeError внутри
_createPrismaPromise -> голый catch превращал это в 503
«База данных временно недоступна» при живой PostgreSQL.
Песочница не ловила: stub-клиент (any, без prisma generate)
делает вызов «работоспособным». /coin/BTC молча показывал
empty state по той же причине.

Исправление (SQL не менялся — он корректен):

- app/api/chart/markets/route.ts,
  app/coin/[symbol]/page.tsx: вызов строго членом объекта,
  await prisma.$queryRaw<ChartRow[]>`...` — типизированный
  tagged template, параметризация сохранена;
- в оба catch добавлен console.error технической причины
  (server-лог); клиент получает прежнее безопасное
  русское сообщение;
- scripts/test-chart-sql.ts — НОВЫЙ статический тест без
  базы: запрещает отрыв $queryRaw и unsafe-варианты,
  сверяет таблицы/колонки SQL с schema.prisma, алиасы SQL
  с полями ChartRow; --self-test на фикстурах. На сломанном
  коде даёт точный диагноз, на исправленном — зелёный.

Проверки: tsc — 14 старых sandbox-ошибок, новых нет;
build — компиляция успешна (останов на старых, см. §28);
74/74 + 59/59 + 54/54; dev-smoke: страницы 200, причина
503 пишется в server-лог.

Правило на будущее: prisma.$queryRaw — ТОЛЬКО членный
tagged-template вызов; проверяется scripts/test-chart-sql.ts.


==================================================
29. MULTI-TIMEFRAME OHLCV, ИСТОРИЯ ГРАФИКА И UX
==================================================

Дата: 09.09.2026. Ветка arena/ui-chart-clean,
поверх fix f5db569 (§28.1). Signal Engine и схема БД
не затронуты.

1. OHLCV MULTI-TIMEFRAME — ГОТОВНОСТЬ (не переписан)

Существующий пайплайн уже обеспечивал: последовательный
обход (concurrency=1 + --delay), retry/backoff
(lib/ohlcv/retry, 3 попытки, экспонента), upsert по
уникальному ключу market+tf+openTime (идемпотентность,
дубли невозможны), инкремент по последней свече,
фильтр невалидных OHLCV, никакой удаления/reset.

Добавлено:

- lib/ohlcv/cli.ts — чистый разбор CLI: белый список
  таймфреймов 5m/15m/1h/4h/1d (мусор вида --timeframes=1x
  теперь отклоняется сразу, раньше проходил cast-ом),
  границы: --top 1..500 (по умолчанию 10 — автопрогона
  Top-500 НЕТ), --limit 50..1000 (свечей истории за
  запрос), --delay 0..60000, env OHLCV_*;
- created/updated по дельте COUNT до/после upsert
  (upsert сам этого не сообщает); статистика byTimeframe:
  markets/fetched/written/created/updated/skipped/errors;
- printVerification по КАЖДОМУ запрошенному ТФ
  (+ глобальная проверка дублей раз за проход);
- тесты: scripts/test-ohlcv-cli.ts — 39/39.

Безопасный запуск (ручной, на VPS):

  npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d --once
  npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=1h --once

Рекомендация по глубине: 1h — limit 300 (обычно уже есть),
5m/15m — по 300-500 свечей достаточно для графика и
индикаторов (EMA 200 требует 200), 4h/1d — 300.

2. SNAPSHOT НА НЕСКОЛЬКИХ ТАЙМФРЕЙМАХ

runSnapshotSync уже работал ТОЛЬКО по PostgreSQL Candle
(без обращения к биржам), upsert по market+tf+candleTime,
схема не расширялась. Добавлен разбор --timeframes=5m,15m,1h,4h,1d
(по каждому ТФ прогон отдельно, итоги по каждому + всего);
одиночный --timeframe сохранён. Валидация — общий белый
список (lib/ohlcv/cli.ts). Тесты: test-snapshot-cli.ts — 15/15.

  npx tsx scripts/snapshot-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d

3. ГРАФИК — ИСТОРИЯ ПО ПРОКРУТКЕ (cursor-пагинация)

- API /api/chart/candles: параметр before (openTime мс,
  строгая валидация: целое, >0, не будущее — иначе 400
  с русским сообщением), limit 50..1000 (серверный
  максимум, невалидное — 300 как раньше); запрос
  openTime < before, orderBy DESC, take limit+1 →
  hasMore + nextCursor (никакого OFFSET);
- клиент CandleChart: подписка subscribeVisibleLogicalRangeChange,
  при range.from <= 2 — запрос следующего батча по
  курсору; слияние БЕЗ дублей (lib/chart/history.ts
  mergeOlder: строгая граница, чистка дублей внутри
  батча); текущие 300 свечей не сломаны (первый ответ
  прежний + hasMore/nextCursor);
- индикаторы после подгрузки пересчитываются на клиенте
  ТЕМ ЖЕ слоем lib/indicators (линии непрерывны через
  стык батчей, серверный расчёт остаётся для первого окна);
- видимая область сохраняется (сдвиг на число добавленных);
- останов: hasMore=false ИЛИ added=0 (нет циклов);
  ошибки истории не ломают график — попытки прекращаются;
  AbortController + сброс при смене монеты/биржи/ТФ;
  бейдж «Загрузка истории…»;
- тесты: scripts/test-chart-history.ts — 35/35
  (валидация курсора, лимиты, слияние, 3×300 без дублей).

4. UX ГРАФИКА

- легенда под курсором: O/H/L/C/Объём + EMA20/50/200,
  SMA20, RSI14, MACD/сигнал/гистограмма с русскими
  названиями; обновление напрямую в DOM (без ре-рендеров);
  вне курсора — последняя закрытая свеча;
- кнопка «Сбросить масштаб» (resetTimeScale + авто-масштаб
  цены); автоскейл и panes-resize — штатные;
- mobile 360/390/430: брейкпоинты 430/360, на ≤360px
  легенда скрывается (перекосы вёрстки исключены),
  crosshair-метки остаются;
- тема dark/light, resize (autoSize), локаль ru-RU —
  были; быстрые переключения: requestId + AbortController
  (старый ответ не показывается).

5. АУДИТ КНОПОК (мёртвых нет)

MarketTable — фильтры «Все/Рост/Падение» с активным
состоянием, строки — ссылки /coin/SYMBOL; SearchBox —
открытие/очистка/переходы; Header — ссылки; график —
select'ы с disabled и русскими подписями «Нет активов/
Нет рынков», тумблеры индикаторов, «Повторить», «Сбросить
масштаб»; /profile и /signals — без кнопок (честно).
Все кликабельные элементы функциональны.

6. ПРОИЗВОДИТЕЛЬНОСТЬ (новых индексов НЕ требуется)

- markets API: 1 GROUP BY по индексам Market(assetId) —
  N+1 нет;
- candles API: диапазон openTime < cursor + orderBy +
  take по существующему @@index([marketId, timeframe,
  openTime]) — курсор ложится на индекс идеально;
- страница монеты: 1 findUnique + 1 GROUP BY;
- все выборки — select только нужных полей, limit везде.
Рекомендация: схема/индексы менять не нужно.

7. ERROR HANDLING

Все server catch-блоки UI/Chart логируют техническую
причину: [api/chart/markets], [api/chart/candles],
[api/search], [strategies], [MarketOverview],
[coin/SYMBOL]; клиенту — только безопасные русские
сообщения. /api/register логировал и раньше.

Проверки этапа: tsc — 14 старых sandbox-ошибок, новых
нет; сборка — компиляция успешна (останов на старых,
см. §28); тесты: 74/74, 59/59, 54/54, chart-sql,
39/39, 15/15, 35/35. Ожидает VPS-проверки.


==================================================
29.1. FIX: --help/-h воркеров (найден на VPS)
==================================================

Дата: 09.09.2026. Ветка arena/ui-chart-clean поверх 01bca05.

Честная фиксация VPS-инцидента:

- при VPS-проверке `npx tsx scripts/ohlcv-worker.ts --help`
  флаг --help молча игнорировался (parseArgs смотрел только
  --имя= и --once) и воркер ЗАПУСТИЛСЯ с defaults:
  top=10, timeframes=1h, limit=300, delay=250ms, once=false;
- выполнен ОДИН реальный проход Top-10 × 1H:
  активов 10, пар рынок×tf 48, получено/записано 337,
  СОЗДАНО 289 Candle, обновлено 48, errors=0, duplicates=0;
  Candle стало 14731 (закрытых 14683);
- процесс остановлен Ctrl+C до второго прохода
  («следующий проход через 3600000ms»);
- `snapshot-worker.ts --help` остановлен Ctrl+C сразу,
  до рабочего прогона;
- ЭТО НЕ ПОТЕРЯ ДАННЫХ: проход идемпотентен (upsert по
  ключу, 0 ошибок, 0 дублей) — свечи СОХРАНЕНЫ, удалять
  их не нужно и они не удалялись.

Исправление:

- lib/ohlcv/cli.ts, lib/snapshots/cli.ts: resolveOhlcvInvocation /
  resolveSnapshotInvocation — ПОЛНЫЙ разбор вызова без БД:
  kind = help | error | run;
- --help и -h: русская справка (параметры, defaults,
  безопасные примеры), exit 0; в help-режиме воркер
  возвращает управление ДО импорта клиента Prisma и кода
  синхронизации (в ohlcv-worker клиент Prisma и
  lib/ohlcv/sync теперь импортируются ДИНАМИЧЕСКИ только
  в run-режиме) — БД и биржи не затрагиваются вовсе;
- НЕИЗВЕСТНЫЕ/опечатанные флаги (--foobar, --onc, --to=5,
  --timeframess=1h, --hist=5, позиционные слова) — понятная
  ошибка «Неизвестный флаг … Доступные флаги: …» и exit 1;
  тихий запуск с defaults исключён;
- SIGINT/SIGTERM: первый сигнал — корректное завершение
  (интервальное ожидание прерываемо с шагом 100мс,
  prisma.$disconnect() в finally), повторный Ctrl+C —
  немедленный выход (130);
- тесты расширены: test-ohlcv-cli 39 -> 68, test-snapshot-cli
  15 -> 33: help-режим выбирается раньше всего и НЕ содержит
  run-опций; все опечатки отклоняются; обычный run не сломан;
  справки содержат defaults и примеры.

Поведение:

  npx tsx scripts/ohlcv-worker.ts --help          -> справка, exit 0
  npx tsx scripts/ohlcv-worker.ts -h              -> справка, exit 0
  npx tsx scripts/snapshot-worker.ts --help       -> справка, exit 0
  npx tsx scripts/ohlcv-worker.ts --foobar        -> ошибка, exit 1
  npx tsx scripts/ohlcv-worker.ts --onc           -> ошибка, exit 1
  npx tsx scripts/snapshot-worker.ts --hist=5     -> ошибка, exit 1

Проверки: tsc — 14 старых sandbox-ошибок, новых нет;
build — компиляция успешна (останов на старых, §28);
68/68, 33/33, 35/35, chart-sql ОК, 74/74, 59/59, 54/54.
Приметка: в песочнице run-режим падает на stub-клиенте
Prisma до цикла, поэтому корректность Ctrl+C на живом
проходе окончательно подтверждается на VPS.


==================================================
30. ДИАГНОСТИКА ДАННЫХ, PLAN-РЕЖИМЫ И СТАТУС ГРАФИКА
==================================================

Дата: 09.09.2026. Ветка arena/ui-chart-clean поверх 0f596d9.

!!! Arena implementation — требуется VPS runtime
verification для всего перечисленного ниже. На VPS эти
механизмы ещё НЕ проверялись; записей о VPS-проверке здесь
нет сознательно.

1. АДМИНКА: «СОСТОЯНИЕ ДАННЫХ» (/admin/data, только ADMIN)

- существующая Auth.js-защита (auth() + role=ADMIN,
  USER/PRO → redirect «/»); server component, отдельный
  admin API НЕ создавался; env/DATABASE_URL/stack trace
  не выводятся;
- АКТИВЫ: всего/enabled/Top-500/с местом в рейтинге +
  updatedAt как честная approximation времени рейтинга
  (время прогона rank-assets в схеме не хранится);
- РЫНКИ: один SQL GROUP BY exchange с FILTER — всего и
  активных SPOT USDT по Binance/Bybit/Gate/KuCoin/BingX;
- CANDLE: один SQL GROUP BY timeframe — всего/closed/
  open/рынков со свечами/первая/последняя + строка
  freshness; итог — сумма в Node (свечи НЕ грузятся);
- SNAPSHOT: GROUP BY timeframe — всего/рынков/последний
  candleTime;
- COVERAGE: рынков со свечами / активных SPOT USDT по
  каждому ТФ (подпись: coverage РЫНКОВ, не активов) +
  Top-10 (JOIN Asset, rank<=10);
- рекомендуемые plan-команды для отсутствующих ТФ —
  текстом; веб-запуск worker'ов СОЗНАТЕЛЬНО не сделан
  (безопасность);
- сырой SQL — членные prisma.$queryRaw<T>`...` без
  Unsafe, файл добавлен в проверку scripts/test-chart-sql.ts;
- в навигации админки мёртвая ссылка «Источники данных»
  теперь ведёт на /admin/data.

2. FRESHNESS (lib/data/freshness.ts, чистая функция)

Формула (документирована в модуле): D — длительность ТФ
(5/15/60/240/1440 минут), age = now − openTime последней
закрытой свечи. АКТУАЛЬНО: age ≤ 2D; ЗАДЕРЖКА: ≤ 6D;
иначе УСТАРЕЛО; свечи нет — НЕТ ДАННЫХ. 1d-свеча 10 минут
(и даже ~28 часов) — АКТУАЛЬНО. Используется в админке
и на графике. Тесты: test-freshness.ts — 32/32
(фиксированный now).

3. OHLCV --plan И ПРЕДОХРАНИТЕЛЬ (lib/ohlcv/plan.ts)

- npx tsx scripts/ohlcv-worker.ts --plan --top=10
  --timeframes=5m,15m,1h,4h,1d --limit=300 → read-only
  SELECT (Asset/Market): активы, рынки, задачи
  (рынок×ТФ), максимум свечей, оценка API-запросов,
  разбивка по биржам; баннер «Режим PLAN: PostgreSQL
  не изменяется, API бирж не вызываются»;
- sync-код и адаптеры бирж в plan-режиме НЕ импортируются
  (импорт после предохранителя, только в run);
- предохранитель: LARGE_RUN_TASK_THRESHOLD = 500 задач
  (рынок×ТФ); выше — отказ с числом задач, оценкой и
  готовой командой повтора с --confirm-large-run;
  Top-10×5ТФ (240) и Top-20×5ТФ (~480) проходят без
  confirm; Top-500×1ТФ (~2357) — уже требует confirm;
- тесты: test-ohlcv-cli 68 → 94.

4. SNAPSHOT --plan (lib/snapshots/plan.ts)

- npx tsx scripts/snapshot-worker.ts --plan --top=10
  --timeframes=... → read-only: по каждому ТФ сколько
  рынков имеют историю ≥ historyLimit, сколько нет,
  сколько снапшотов потенциально создано/обновлено;
  IndicatorSnapshot НЕ пишутся, API бирж не вызываются;
- тесты: test-snapshot-cli 33 → 44; SQL включён в
  chart-sql проверку (4 файла).

5. ГРАФИК: СТАТУС ДАННЫХ И URL-СОСТОЯНИЕ

- статусная строка: BINANCE · BTCUSDT · 1 час /
  «Загружено свечей: N» / «Последняя: 09.09.2026 17:00
  UTC» / «● АКТУАЛЬНО» (freshness по формуле выше);
- /coin/BTC?exchange=BINANCE&timeframe=1h — восстановление
  выбора; смена биржи/ТФ обновляет URL через
  history.replaceState (без reload); невалидные
  exchange=XXX / timeframe=2h → fallback без поломки
  (lib/chart/url-state.ts, тесты 18/18);
- ошибка подгрузки истории — ОТДЕЛЬНО от ошибки основной
  загрузки: график остаётся на загруженных данных,
  показывается предупреждение; параллельные pagination
  запросы исключены (loadingOlderRef), при смене окна
  история обрывается и сбрасывается.

6. API VALIDATION (lib/chart/params.ts)

- symbol: пустой/длинный (>16)/инъекция → 400;
  нормализация в верхний регистр;
- exchange: только BINANCE/BYBIT/GATE/KUCOIN/BINGX → 400
  со списком доступных;
- timeframe=2h/1H → 400; limit=0/999999/abc/10.5 → 400
  (тихий fallback на 300 удалён; отсутствие параметра —
  300 как раньше); before=abc/-5/0/будущее → 400;
- все негативные сценарии проверены живым dev-сервером
  песочницы (8 сценариев → 400) и юнит-тестами
  test-chart-params.ts — 37/37.

7. PERFORMANCE (оценка)

Размер ответа /api/chart/candles (синтетическая оценка
структуры JSON в песочнице, НЕ VPS-замер): limit=300 ≈
119 КБ, limit=1000 ≈ 408 КБ. Лишние Asset/Market поля не
отдаются (select узкий), все Candle сразу не возвращаются
(лимит + cursor). gzip — задача HTTP layer, не вводился.
Новые индексы НЕ требуются: cursor ложится на существующий
@@index([marketId, timeframe, openTime]), агрегаты админки
идут по существующим индексам; схема НЕ менялась.

8. READ/WRITE-ОПЕРАЦИИ ЭТАПА

Read-only (новое): /admin/data (все запросы), --plan
OHLCV (Asset/Market SELECT), --plan snapshot (Asset/
Market/Candle/IndicatorSnapshot SELECT).
Write-capable (как прежде, только явные run): OHLCV
run-режим (upsert Candle, Market.lastSyncAt), snapshot
run-режим (upsert IndicatorSnapshot). Новых write-операций
не появилось; из HTTP write к БД по-прежнему невозможен.

Проверки этапа (песочница): 74/74, 59/59, 54/54,
chart-sql (4 файла), 32/32 freshness, 94/94 ohlcv-cli,
44/44 snapshot-cli, 35/35 chart-history, 18/18 url-state,
37/37 chart-params; tsc — 14 старых sandbox-ошибок,
новых нет; build — компиляция успешна (останов на старых).


==================================================
30.1. FIX VPS: селектор «Нет активов» и пустой canvas
==================================================

Дата: 09.09.2026. Поверх d080045.

Корневая причина — регрессия 89e2671: строгая валидация
symbol в /api/chart/markets отвечала 400 на легитимный
запрос БЕЗ symbol (это режим списка активов для селектора,
данные из PostgreSQL). Гонка: list-400 затирал статус ok
успешной загрузки свечей → canvas снимался, селектор был
пуст. Исправление: symbol валидируется только когда передан
(undefined учтён); чистые функции состояния в
lib/chart/history.ts: resolveSymbolFromList (выбранный из
URL символ не сбрасывается), nextStatusAfterListFailure
(«липкий» ok), candlesIntegrityOk (count>0 с пустым
массивом не применяется, console.error); «Список недоступен»
в селекторе при сбое списка. Тесты chart-history 35→50.
Живая проверка песочницы: список снова идёт в БД (503
честный без БД), мусорный symbol по-прежнему 400.
Требуется VPS-проверка acceptance-сценариев ревью.


==================================================
30.2. FIX: freshness по закрытым свечам; заголовок preflight
==================================================

Дата: 09.09.2026. Поверх 5b82b8d.

1. /admin/data: freshness = ТОЛЬКО последняя ЗАКРЫТАЯ
свеча (SQL FILTER по c.closed); открытая свеча выводится
отдельной колонкой «Текущая открытая» и не влияет на
freshness (раньше MAX(openTime) брал 17:00 открытой
вместо 16:00 закрытой). Хелпер splitClosedOpenFreshness
+ 15 новых тестов (47/47). Пороги 2D/6D не менялись.

2. OHLCV: заголовок оценки — preflightTitle(isPlan);
«Режим PLAN» только при явном --plan, обычный preflight —
«Предварительная оценка запуска». Guard не ослаблен:
exit=1 до runOhlcvSync/API/записи (структурный тест
порядка guard→sync-импорт). Тесты 101/101.

Ограничение песочницы: prisma binaries заблокированы
(validate/generate — шаг VPS); реальный build завершается
на заглушке клиента, компиляция успешна. Workers реально
не запускались; Signal/schema/Runtime/minExchanges/
deadZoneRatio не тронуты.


==================================================
31. ЭТАП A: АУДИТ АДМИНКИ И ПЛАН (факт на e14fef0)
==================================================

Дата: 09.09.2026. База этапа: e14fef0 (= origin/main),
история ветки чиста от edf3732 (проверено).

АУДИТ ТЕКУЩЕЙ /admin (что реально работает)

Работает (реальные данные/действия):
- /admin/data — состояние данных на реальных агрегатах
  PostgreSQL (свежесть по CLOSED, coverage, plan-команды);
- Стратегии: реальный список Strategy БД (published/
  enabled — реальные поля); «Настроить» ведёт на
  /admin/strategies/[id] (StrategyEditor 780 строк)
  с существующим безопасным API PUT
  /api/admin/strategies/[id] (ADMIN-only,
  validateTrendSuslikConfig валидирует config целиком);
- «Активных сигналов» — реальный COUNT Signal (0);
- «Новая стратегия» — УЖЕ disabled (create-flow нет);
- паттерн ADMIN-доступа: auth() + role=ADMIN во всех
  admin-страницах и admin API.

Условное/неверное (исправляется в A4):
- «Top активов» = count(top500=true) — счётчик флага,
  не текущего universe;
- «Рынков» = count(enabled=true) — без ACTIVE/SPOT/USDT,
  расходится с остальными страницами;
- «PostgreSQL: База подключена» — неявное (следует из
  того, что страница отрисовалась), нет измеримого
  статуса/задержки;
- «Биржи: Binance...» с зелёной точкой — вводящее:
  наличие Markets в БД НЕ доказывает, что API бирж
  сейчас online;
- «OHLCV Worker: Свечи поступают» при candleCount>0 —
  ЛОЖЬ: наличие старых свечей не доказывает запуск
  worker; web безопасно не может видеть PM2-процессы;
- «Signal Engine» — формулировка «сканер ещё не запущен»
  → честнее «не развёрнут».

Мёртвая навигация (исправляется в A2/A3):
- Индикаторы, Рынки, Мониторинг, Уведомления, Журнал,
  Бэктесты — ведут на /admin (в никуда);
- Сигналы — ведёт на /signals (честный экран, ок);
- Источники данных — /admin/data (реальная, ок).

ИНВЕНТАРИЗАЦИЯ Top-500 (для A1)

Код/CLI:
- scripts/rank-assets.ts: размечает top500=true для
  первых 500 (rank-скрипт; флаг остаётся историческим);
- lib/ohlcv/cli.ts: --top max=500, help «1..500»;
- lib/snapshots/cli.ts: --top max=500, help «1..500»;
- lib/ohlcv/plan.ts: комментарий-пример Top-500
  (порог задач 500 — НЕ меняется, это задачи рынок×ТФ);
- app/admin/page.tsx: карточка «Top активов» по флагу;
- app/admin/data/page.tsx: карточка «Суслик Top-500»;
- app/coin/[symbol]/page.tsx: «Суслик Top-500»,
  «актив в расчётном/вне текущего Top-500»;
- app/api/chart/markets: отдаёт поле top500 как факт БД
  (не меняется);
- components/admin/StrategyEditor + lib/strategies/config
  + runtime: ПОЛЕ КОНФИГА top500Only — часть контракта
  Strategy Runtime: НЕ переименовывается, семантика
  Runtime не трогается (вопрос трактовки universe в
  Runtime — предмет ЭТАПА B);
- components/MarketOverview: «Капитализация Top-500» —
  факт о данных CoinGecko (сумма капитализаций топ-500
  CoinGecko), НЕ наш universe — остаётся как есть.
Docs/tests: PROJECT_CONTEXT §24/§28, ohlcv/snapshot CLI
тесты (границы «от 1 до 500», кейс 501).

РЕШЕНИЕ A1 (без schema migration):
основной universe проекта = Asset.rank IS NOT NULL AND
rank <= 100 (поля rank/top500 в схеме остаются; флаг
top500 = «входит в исторический Top-500 рейтинг»).
Ничего в БД не удаляется. Единая константа TOP_UNIVERSE_SIZE=100
в lib/universe.ts; CLI --top ограничивается 1..100.

ПЛАН ЭТАПА A (коммиты)

1. Документация: аудит и план (этот раздел).
2. A1: Top-100 universe (lib/universe.ts, CLI-границы,
   карточки admin/admin-data/coin, тесты CLI).
3. A2: навигация и честные разделы: /admin/indicators
   (реальные IndicatorSnapshot-агрегаты), /admin/markets
   (реальные Market, поиск/фильтр, пагинация, coverage),
   /admin/backtests и /admin/notifications (честные
   empty-state), Сигналы — ссылка на /signals.
4. A3: /admin/journal — реальный журнал событий текущего
   процесса: instrumentation.ts + ring-buffer (без schema
   change, без чтения произвольных файлов; PM2-файлы
   отклонены как непереносимые), уровни/источники/
   фильтр/пагинация, retention 500 событий, ADMIN-only.
   Worker-события из web НЕ видны (честно документировано).
5. A4: Overview — реальные статусы: PostgreSQL (SELECT 1
   + latency), Биржи (факт о БД, не об API), OHLCV Worker
   («Состояние процесса не отслеживается» + freshness
   закрытых свечей), Signal Engine («Не развёрнут»),
   Top активов (universe), Рынков (активные SPOT USDT).
6. Документация этапа A.

СТОП после коммитов A — ждём VPS review. ЭТАП B
(график + Strategy Runtime) не начинается.

---

## §31a. Статус этапа A (09.09.2026) — ВЫПОЛНЕН

- A1 **e6934a9** — Top-100 universe (lib/universe.ts,
  CLI, coin-карточка, admin/data), история Top-500
  сохранена.
- A2 **557d003** — AdminNav, /admin/indicators,
  /admin/markets, честные /admin/backtests и
  /admin/notifications.
- A3 **30d82a9** — журнал: instrumentation.ts +
  lib/observability/journal.ts (ring-buffer 500,
  маскирование секретов), /admin/journal с фильтрами;
  без schema change; test-journal 23/23.
- A4 — /admin/monitoring (SELECT 1+latency, счётчики,
  freshness закрытых свечей по ТФ; worker-состояние
  честно «не отслеживается») и переписанный Overview
  (замер PostgreSQL, «Биржи» = факт о БД, OHLCV Worker
  без выдуманного «Свечи поступают», Signal Engine
  «Не развёрнут», graceful-деградация при недоступной
  БД); AdminNav дополнен пунктом «Журнал»;
  globals.css: .statusRed.

Проверки песочницы: tsc — 12 известных implicit-any
(scripts/rank-assets.ts, baseline; 2 из admin/page
закрыты явной типизацией); build компилируется,
финальный фейл — тот же baseline rank-assets
(подтверждено сравнением с HEAD~1); self-тесты:
journal 23/23, ohlcv 102/102, snapshot 44/44,
freshness 52/52, chart-history 50/50, url-state 18/18,
chart-params 37/37, chart-sql ok, indicators 74/74,
periods 59/59, runtime 54/54.

VPS-ревью рендера/admin-auth — на живой БД (песочница
stub: admin-страницы дают 500 «did not initialize» —
ожидаемо). ЭТАП B не начинается до явного
подтверждения.

---

## §31b. Фикс A1-consistency по VPS-ревью (09.09.2026)

VPS-аудит commits ac044bb..2d51bed нашёл
семантическую рассинхронизацию: UI заявлял Top-100,
а Strategy Runtime фильтровал по legacy-флагу
Asset.top500, CLI был заперт на 100 (потеряна
--plan --top=500 диагностика).

Решение (коммит поверх 2d51bed, история не
переписывается):
- основной ranked universe = rank 1..100 через
  lib/universe.ts (TOP_UNIVERSE_SIZE, isInTopUniverse);
- legacy-поле Strategy.config.filters.top500Only
  СОХРАНЕНО (совместимость production JSON), семантика
  true = «только основной ranked universe» = Top-100;
- SnapshotInput.assetTop500 → assetRank (number|null),
  компилятор заставляет все вызывающие стороны передать
  rank; рантайм НЕ читает Asset.top500;
- CLI --top 1..500 (LEGACY_TOP500_SIZE), default 10;
  large-run guard (500 задач) без изменений;
- классификация оставшихся Top-500:
  LEGACY DATA — Asset.top500, rank-assets (поддержка
  первых 500), статистика «в историческом Top-500» в
  admin/data, select-поля top500 в chart API/coin
  (факт данных, не фильтр universe); ВНЕШНЯЯ МЕТРИКА —
  «Капитализация Top-500» MarketOverview (CoinGecko,
  помечена); DOC — план Top-500 × 1 ТФ ≈ 2357 задач в
  lib/ohlcv/plan.ts (масштаб guard);
- Journal UI: явная эфемерность (память процесса,
  очистка при рестарте, НЕ audit log); SECRET_PATTERN
  расширен (bearer/api-key/private-key/ssh);
  instrumentation: только строки консоли и
  Error.name/message, env/headers/cookies не читаются.

Snapshot worker: guard добавлен НЕ был (его не
существовало и до A1; снапшоты считают из локальных
Candle без API бирж) — поведение не расширяли,
существующий guard не ослаблен.

---

## §31c. Фикс хвостов браузер-ревью (10.09.2026)

VPS browser review 3af152c: acceptance в основном
пройден; хвосты исправлены отдельным коммитом:
1) Monitoring считал «Свечей» тотал вместе с открытыми
   в разделе свежести → закрытые/открытые раздельно
   (семантика /admin/data), freshness только по
   закрытым;
2) «Рынков 2357» был тотал БД без выделения universe →
   везде различаются «Рынки Top-100»
   (asset: topUniverseRankFilter()) и «всего активных
   в БД»;
3) /admin/notifications был orphan → пункт
   «Уведомления» в AdminNav (страница — честный
   empty-state);
4) /admin/strategies/[id] был тупиком → AdminNav
   active="strategies".
Тест scripts/test-admin-consistency.ts фиксирует всё
это (42/42). ЭТАП B не начат; 3af152c/фикс в
production не переносится без решения владельца.

---

## §31d. Фикс runtime-бага Overview (10.09.2026)

VPS-ревью 8a1ae16 нашло реальный runtime-баг:
рассинхрон деструктурирования Promise.all в
app/admin/page.tsx (вставка universeMarkets-запроса
без сдвига имён). Решение: lib/admin/overview.ts —
хелпер buildOverviewQueries с константой
OVERVIEW_QUERY_ORDER; тест на подставной БД проверяет
позицию каждого запроса семантически (запись вызовов),
перестановка ловится (проверено: swap → 58/63 exit 1).
topUniverseRankFilter усилен gte:1 (эквивалентность
isInTopUniverse), admin/data на общем хелпере.
Урок: изменения Promise.all сопровождать сдвигом
деструктурирования в том же коммите; позиционные
списки — только через именованный проверяемый контракт.

---

## §31e. Фикс типизации OverviewDb (10.09.2026)

VPS tsc/build: единственная ошибка TS2345 —
buildOverviewQueries(prisma): OverviewDb.strategy.findMany
объявлял orderBy: ReadonlyArray, реальный
StrategyFindManyArgs требует mutable
StrategyOrderByWithRelationInput[]. Исправлено на
Array; семантика запросов/фильтров не менялась.
Песочница не может ловить такие ошибки напрямую
(stub @prisma/client any-типизирован) — добавлен
и удалён временный типо-пробник с реальной формой
делегатов Prisma 6 (позитив: fix проходит; негатив:
ReadonlyArray-копия даёт TS2345). Разница «12
rank-assets TS7006 в песочнице vs 0 на VPS» —
артефакт stub: с сгенерированным клиентом колбэки
получают контекстные типы. Урок: контрактные типы
для Prisma-параметров — только с учётом mutability
реальных Prisma-типов; stub-песочница проверяет
логику, но не Prisma-варианс.

---

## §31f. Фикс layout/interactive стратегии (10.09.2026)

VPS browser acceptance 7ddb2ef: /admin/strategies/[id]
использовала .shell вместо .adminPage — AdminNav во
всю ширину, редактор внизу. Исправлено на общий
layout-контракт (grid 235px+1fr + adminDashboard,
responsive из globals.css). Интерактив редактора
проверен статически и тестами (checkbox→PUT enabled,
save→PUT с валидацией и update, без mutation-тестов
против production БД). «+ Новая стратегия» — честно
disabled с явным объяснением (backend создания не
существует). Тестов в test-admin-consistency стало 76.
Подтверждённые числа (100/401/2357, 14683/48,
Top-100 semantics, Notifications, Journal, Runtime,
72, 2) не тронуты.

---

## §31g. Раздел «Стратегии» (10.09.2026)

VPS browser acceptance 9bf14ce: пункт «Стратегии»
вёл на /admin#strategies (выглядел неработающим).
Создан самостоятельный раздел /admin/strategies
(реальные Strategy записи, настройка внутри карточки,
единый layout), AdminNav переключён на маршрут.
«+ Новая стратегия» — disabled с единым объяснением
на /admin и /admin/strategies; create-API отсутствует
(проверяется тестом). test-admin-consistency 84/84.


==================================================
32. PRODUCT ROADMAP / ДАЛЬНЕЙШЕЕ РАЗВИТИЕ (10.09.2026)
==================================================

> Этот раздел — интеграция docs/ROADMAP.md (P0–P7) в единый authoritative контекст.
> После этого commit docs/ROADMAP.md удалён, чтобы не было двух источников правды.
> База: HEAD 877dc61 Phase 3E alignment fix (принят на VPS 10.09.2026; real BTC diagnostic 5m READY, 15m READY, 1h READY, 4h READY, 1d BLOCKED — BINGX 16:00 UTC vs BINANCE/BYBIT/GATE/KUCOIN 00:00 UTC), ветка arena/01a08b68-svechnoy-suslik.
> Документация-only — без изменения runtime/Admin/DB.

# Свечной Суслик — Product Roadmap & Backlog

Последнее обновление: 10.09.2026
HEAD: `877dc61889866888fff2f5f91747405a1f9ae0a9` (Phase 3E alignment fix, **принят на VPS 10.09.2026; 5m/15m/1h/4h READY, 1d BLOCKED**)
Ветка: `arena/01a08b68-svechnoy-suslik`
Статус: документация — без изменения runtime/Admin/DB

> Эта документация — единственный актуальный бэклог. `PROJECT_CONTEXT.md` §1–31 остаётся историческим контекстом; приоритеты и границы фич — здесь. `CHANGELOG.md` — хронология выполненных этапов. `docs/phase3e-diagnostic-report.md` — диагностический отчёт Phase 3E.

---

## 0. Направление продукта

«Свечной Суслик» — самостоятельная crypto analytics platform. Не копировать UI/брендинг TRdesk/TradingView. Референсы могут вдохновлять функциональность только.

Ключевые отличия:
- реальные PostgreSQL-данные рынка (не демо);
- объяснимые стратегии (exact reasons);
- мультибиржевое подтверждение (minExchanges);
- воспроизводимые расчёты по **CLOSED** свечам;
- честные состояния `cannot-evaluate` ≠ `NEUTRAL`;
- будущие бэктесты без фальшивой статистики;
- объяснимые сигналы с точным скоopen.

Никаких выдуманных AI-прогнозов и фейковых метрик.

---

## 1. Порядок приоритетов (обязателен)

**P0 — Завершить Smart Money Strategy**
- Phase 3E multi-timeframe verification (принят на VPS 10.09.2026; real BTC diagnostic 5m READY, 15m READY, 1h READY, 4h READY, 1d BLOCKED — BINGX 16:00 UTC vs остальные 00:00 UTC; unsafe aggregation refused, `aggregateAssetGroup` not called)
- Phase 3D advanced configurable SMC parameters (Displacement, FVG, Liquidity, Order Blocks и др.)
- Полная Admin-конфигурируемость (русские описания, диапазоны, зависимости)
- Финальная приёмка Smart Money (read-only → staged → enabled)

**P1 — SuslikChart / визуализация стратегии**
- Собственный график на PostgreSQL-свечах, оверлеи SMC, объяснение `WHY` сигнала

**P2 — Backtest Engine / тестер стратегий**
- Честный, воспроизводимый, без lookahead, с комиссией/проскальзыванием

**P3 — Suslik Scanner + Market dashboard**
- Top-100 сканер по реальным данным Strategy

**P4 — Дополнительный центр индикаторной аналитики**
- Только реальные рассчитанные индикаторы

**P5 — Signal Engine + alerts ТОЛЬКО после готовности стратегии/бэктеста**

**P6 — Watchlist / персонализация**

**P7 — Статьи/CMS и дальнейшее расширение продукта**

Нельзя реализовывать P1–P7 в обход P0, нельзя запускать Signal/алерты до приёмки.

---

## 2. SuslikChart — изменение требования

**Отменено:** переключатель страниц `[ Суслик ] [ TradingView ]`

**Сейчас:**
- Развивать **собственный SuslikChart** на PostgreSQL-свечах (`lib/exchanges`, `Candle`, `IndicatorSnapshot`)
- Не реализовывать TradingView-режим, не имитировать его UI, не выдавать самодельный график за TradingView

**Текущие оверлеи:**
- Свечи, Volume, EMA(20/50/200), RSI(14), MACD(12/26/9)

**Будущие Smart Money оверлеи (после финализации ядра стратегии):**
- swing highs / lows
- BOS (Break of Structure)
- CHoCH / MSS
- liquidity levels
- liquidity sweeps
- FVG / imbalance
- Swing Order Blocks
- Internal Order Blocks
- mitigation / invalidation где осмысленно
- active dealing range
- Premium / Equilibrium / Discount
- вклад каждой компоненты в LONG/SHORT scoring
- мультитаймфрейм-контекст

**Критичный UX:** открыв результат/сигнал Smart Money, пользователь должен **видеть ПОЧЕМУ** он возник.
Пример заголовка:
`BTC · 15m · LONG 82/100 · confirmed 4/5 exchanges`
→ на графике подсвечены соответствующие BOS/sweep/OB/FVG/range.

Реализация только после Phase 3E/3D — не блокирует текущий P0.

---

## 3. Сканер Суслика (P3)

Будущий раздел «Сканер Суслика». Primary universe: **Top-100** (`Asset.rank 1..100`, `lib/universe.ts` `TOP_UNIVERSE_SIZE=100`, `isInTopUniverse`). Legacy `top500` / `Asset.top500` / `filters.top500Only` сохранены как история/совместимость.

Сканер показывает только реальные данные:

- Asset / symbol
- timeframe: `5m / 15m / 1h / 4h / 1d`
- Smart Money direction: `LONG / SHORT / NEUTRAL / cannot-evaluate`
- LONG score, SHORT score
- мультибиржевое подтверждение: `3/5, 4/5`
- conflict state
- last relevant BOS
- liquidity sweep state
- FVG state
- Swing OB, Internal OB
- Premium / Equilibrium / Discount
- data freshness (`lib/data/freshness.ts`: `age ≤2D → АКТУАЛЬНО`, `≤6D → ЗАДЕРЖКА`, иначе `УСТАРЕЛО`)
- last CLOSED candle (`openTime`)

Фильтры/сортировка: direction, score, timeframe, confirmation, liquidity/volume, наличие SMC-компоненты, freshness. Клик → ` /coin/[symbol]` с объяснением scoring.

Никаких фейковых строк сканера.

---

## 4. Объяснимость «Почему нет сигнала?»

Нельзя показывать только `BTC NEUTRAL`.

Нужно показывать:

```
BTC · 1h
LONG 20 / SHORT 15  threshold 72
- bullish swing structure +20
- bearish internal structure +10 SHORT
- bearish internal OB +5 SHORT
- no fresh BOS
- no liquidity sweep
- no active FVG
- no active dealing range
```

`cannot-evaluate` остаётся отдельным от `NEUTRAL` (недостаточно истории, невалидные свечи, фильтры). Пользователь понимает, почему нет LONG/SHORT.

---

## 5. Мультитаймфрейм-матрица

Будущая фича Scanner/Coin:

```
BTC
5m   LONG
15m  LONG
1h   NEUTRAL
4h   LONG
1d   cannot-evaluate
```

Никогда не превращать `cannot-evaluate` / недоступность в фейковый `NEUTRAL`. Опционально показывать scores и `confirmation`.

---

## 6. Центр индикаторной аналитики (P4)

Будущий раздел «Индикаторы». Старт только с реальных рассчитанных:

- EMA, RSI, MACD, ATR, Volume, Smart Money analytics

Возможные реальные расширения после готовности данных:
- volatility, relative volume, market breadth, trend breadth, cross-asset rankings

Funding / Open Interest / ликвидации / order book / CVD / on-chain — **только после** появления реальных источников и пайплайнов хранения. Не создавать фейковые значения для заполнения UI.

---

## 7. Backtest Engine / Тестер стратегий (P2)

Высокий приоритет после Smart Money + визуализация. Будущий раздел «Тестер стратегий» / Backtest.

Требования честности:
- CLOSED свечи только
- no lookahead, детерминизм
- commission, slippage
- in-sample / out-of-sample, walk-forward
- trades, win rate, PnL, max drawdown, profit factor, Sharpe, Sortino
- стабильность по активам / таймфреймам / режимам рынка

Нельзя заявлять прибыльность до этих тестов. Никакого фейкового PnL/winrate.

---

## 8. Сигналы — будущее, не сейчас (P5)

Продукт предполагает реальные сигналы, но **Signal Engine строго запрещён сейчас**.

Экспериментальный коммит `edf3732` **не должен** попадать в текущую работу (`git merge-base --is-ancestor edf3732 HEAD` → NOT ancestor, проверено).

Текущий Smart Money производит только Strategy Runtime/results (read-only, без записи `Signal`).

Будущий Signal концептуально:

```
BTC 15m LONG 82/100 confirmed 4/5
- компоненты и баллы, candleTime, версия стратегии, timeframe, биржи
- chart-контекст
```

Production-запись `Signal` возможна только в отдельно спроектированной и одобренной фазе после:
- финальной приёмки Smart Money
- multi-TF верификации (Phase 3E)
- готовности архитектуры бэктеста

Сейчас — никакой реализации.

---

## 9. Алерты — после Signal Engine

Будущее: Telegram / web / возможно email.

Примеры условий (выбирает пользователь):
- Smart Money LONG score ≥80
- минимум 3 подтверждения бирж
- timeframe 15m
- выбранные активы/watchlist

Бэкенда алертов сейчас нет.

---

## 10. Watchlist (P6)

Персональный список монет:

- последние результаты Strategy
- multi-TF матрица
- scores, confirmation, важные SMC-события
- позже сигналы/алерты

Только реальные данные.

---

## 11. Market Dashboard

Эволюция каталога рынка (Top-100) с фильтрами/сортировкой, рангом, ценой/изменением, объёмом, freshness, состоянием стратегии, multi-TF, confirmation, ссылками на SuslikChart.

---

## 12. Admin vs Public стратегии

- **Admin Strategy** — профессиональная конфигурация детерминированных алгоритмов (`/admin/strategies/[id]`, `StrategyEditor`, `validateSmartMoneyRuntime`)
- **Public `/strategies`** — человекочитаемое объяснение: что анализирует стратегия, текущие реальные результаты, позже верифицированные бэктесты, без редактирования production-конфига

Не выносить Admin-контролы в паблик.

---

## 13. Admin-конфигурируемость

Smart Money должен быть максимально разумно конфигурируем через Admin, но **никогда** не делать конфигурируемыми инварианты безопасности:
- CLOSED-only
- no-lookahead
- детерминизм
- cannot-evaluate семантика
- Signal safety, валидационная связность

Phase 3D открывает безопасные профессиональные параметры: Displacement, FVG, Liquidity, Order Blocks и др.

Каждая настройка Admin — русское объяснение: что значит, что делает увеличение/уменьшение, допустимый диапазон, дефолт, зависимости.

---

## 14. Статьи / CMS (P7)

Admin: список, создание/редактирование, title/slug/excerpt/content/cover/categories/tags/draft/published/publish date/SEO/preview
Public: `/articles`, `/articles/[slug]`
Только PostgreSQL. Без фейковых статей.

---

## 15. Монетизация

Не реализовывать pricing/subscription сейчас. Возможная модель Free/Pro рассматривается только после появления ценности: scanner, стратегии, бэктесты, реальные сигналы, алерты.

---

## 16. Текущие правила безопасности (обязательны)

- Signal Engine `edf3732` запрещён
- Никаких фейковых market/signal/backtest данных
- Никакого `prisma db push --force-reset` / удаления PostgreSQL без необходимости
- Никаких воркеров без явного одобрения; web не запускает OHLCV/snapshot workers
- Review и production сейчас делят один PostgreSQL — `Admin Save` во время review мутирует реальную БД (осторожно)
- Top-100 — основной universe (`rank 1..100`); `Asset.top500` / `top500Only` — legacy/история
- Прибыльность стратегии требует бэктеста / out-of-sample доказательств
- Все расчёты — CLOSED свечи, детерминизм, cannot-evaluate честно
- `877dc61` Phase 3E fix **принят на VPS 10.09.2026** (5m/15m/1h/4h READY, 1d BLOCKED — BINGX 16:00 UTC vs 00:00 UTC) — проверено, переход к Phase 3D допустим после разблокировки 8549486

---

## 17. Что сделано на 877dc61 и что дальше (приёмка 10.09.2026)

- Phase 3C: `["1h"]` staged lock, Admin/API, `minExchanges 3`, `DRAFT disabled`
- Phase 3E diagnostic: `lib/strategies/alignment.ts` (grid + same horizon, `referenceCandleTime`, `offGrid`/`horizonMismatch`, `safe=false` для 0 evaluated), generic `MULTI-EXCHANGE AGGREGATION REFUSED` для всех TF, `docs/phase3e-diagnostic-report.md`
- **VPS-приёмка 877dc61 (10.09.2026):** real BTC diagnostic 5m READY (5/5 evaluable, 15:10 UTC same horizon, safe=true), 15m READY (5/5, 15:00 UTC), 1h READY, 4h READY (5/5, 08:00 UTC), 1d BLOCKED (BINGX 16:00 UTC vs BINANCE/BYBIT/GATE/KUCOIN 00:00 UTC, OFF_GRID+HORIZON_MISMATCH, safe=false, `aggregateAssetGroup` not called); Signal 0→0, Strategy id=2 DRAFT disabled ["1h"] сохранён, edf3732 NOT ancestor
- **8549486 (10.09.2026):** Admin/API разблокированы проверенные 5m/15m/1h/4h, 1d остаётся disabled; код готов, DB строка id=2 пока ["1h"] не обновлялась (решение отдельно)
- **Дальше:** Phase 3D configurable SMC → финальная приёмка Smart Money → P1 SuslikChart → P2 Backtest → затем P3–P7
- **Примечание:** timeframe runtime/alignment verified on BTC across 5 exchanges; availability for each asset still depends on stored CLOSED history — не заявлять, что все Top-100 уже имеют multi-TF историю

---

## 18. Связанные документы

- `PROJECT_CONTEXT.md` — исторический контекст (до §31g)
- `CHANGELOG.md` — хронология этапов
- `docs/phase3e-diagnostic-report.md` — отчёт Phase 3E (observed BINGX 16:00 UTC vs 00:00 UTC)
- `lib/strategies/alignment.ts` — guard-реализация
- `lib/universe.ts` — Top-100 константы

==================================================
33. CURRENT PRIORITY — ТЕКУЩЕЕ СОСТОЯНИЕ (10.09.2026, принято VPS)
==================================================

- current accepted baseline around Phase3E — **Phase 3E alignment correctness from 877dc61 has been independently accepted on VPS (10.09.2026)**;
- Real BTC diagnostic (READ-ONLY, CLOSED, 5 exchanges):
  - 5m READY — 5/5 evaluable, latest CLOSED candleTime all = 2026-09-10T15:10:00Z, canonical grid OK, horizon same, safe=true, aggregation allowed
  - 15m READY — 5/5 evaluable, latest CLOSED all = 2026-09-10T15:00:00Z, safe=true
  - 1h READY — previously verified real PostgreSQL/runtime, safe
  - 4h READY — 5/5 evaluable, latest CLOSED all = 2026-09-10T08:00:00Z, safe=true
  - 1d BLOCKED — per-exchange evaluation works, BINANCE/BYBIT/GATE/KUCOIN latest CLOSED = UTC 00 boundary, BINGX = UTC 16 boundary, BINGX OFF_GRID + HORIZON_MISMATCH, safe=false, MULTI-EXCHANGE AGGREGATION REFUSED, aggregateAssetGroup was NOT called; Signal before=0 after=0
- Smart Money DRAFT id=2 exists in shared PostgreSQL; enabled=false; Signal=0; current DB Strategy timeframes=["1h"] — **no DB update has been approved/performed**; row remains DRAFT disabled ["1h"]
- Admin/API commit 8549486 unlocks verified 5m/15m/1h/4h and keeps 1d disabled — code ready, DB row still ["1h"] until separate decision
- Signal remains 0 and Signal Engine remains prohibited (edf3732 NOT ancestor)
- 5m/15m/4h data quality passed; BTC test data now exists for 5m/15m/1h/4h/1d with same-horizon guard
- 1d has BINGX 16:00 UTC boundary vs other four 00:00 UTC — 1d BLOCKED for multi-exchange, per-exchange remains visible
- edf3732 NOT ancestor
- **Do not claim all Top-100 assets have multi-TF history** — timeframe runtime/alignment verified on BTC across 5 exchanges; availability for each asset still depends on stored CLOSED history.

TODO/AUDIT before final Smart Money acceptance — RANGE_POSITION: during real diagnostics observed rangePosition values outside [0,1], e.g. 5m pos ≈ -0.91, 1d pos ≈ 2.24. No math change in this commit. Before final acceptance, verify dealing-range lifecycle/invalidation semantics when price is outside active range — determine whether outside-range position is intended or range should have been invalidated/replaced.

---
Единый источник правды — этот PROJECT_CONTEXT.md. docs/ROADMAP.md удалён (0b2be00 → этот commit).
