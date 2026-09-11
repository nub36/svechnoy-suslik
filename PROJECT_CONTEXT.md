# СВЕЧНОЙ СУСЛИК — КОНТЕКСТ ПРОЕКТА

Последнее обновление: 11.09.2026

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

---

## §31h. P1-A — Smart Money overlays для графика (11.09.2026)

Подготовка P1 (SuslikChart): Smart Money overlays на графике.

АРХИТЕКТУРА P1-A:
- lib/chart/smc-contract.ts — чистый DTO-контракт: только типы
  (домены-литералы type-only из lib/smc/*, чтобы DTO не разошёлся
  с движком) + чистейшие helper'ы: msToChartTime (domain ms →
  lightweight-chart seconds). Все domain timestamps в миллисекундах.
- lib/chart/smc-projection.ts — чистая проекция БЕЗ Prisma/DB/
  fetch/React/DOM/Date.now/Signal. Композиция ТОЛЬКО существующих
  функций в порядке production-пайплайна: exchange eligibility
  (Option A, BINGX 1d исключён) → Strategy filters → common CLOSED
  horizon (evaluateMarketsAtCommonHorizon) → evaluateSmc на свечах,
  усечённых до H → decideAggregationAtCommonHorizon →
  aggregateAssetGroup. ВТОРОГО SMC-АЛГОРИТМА НЕТ.
- Per-exchange overlays и aggregate summary СТРОГО разделены:
  общих FVG/BOS/OB для пяти бирж не существует; aggregate — только
  per-exchange сводки + направление/голоса/confirmation.
- no-lookahead: проекция при H не видит свечи > H; факты с
  confirmedAt > engineAsOf не показываются; evaluation с asOf ≠
  engineAsOf отклоняется (SmcProjectionError).
- WHY→factIds: только exact existing key mapping — точные joins
  сейчас ТОЛЬКО FVG/OB (reason.value === deterministic ключ движка).
  OB_FVG_CONFLUENCE не содержит structured exact IDs → factIds=[]
  всегда (никакой projection-level реконструкции соседних reasons).
  Exact mapping нет → []. Будущий exact confluence-highlighting
  возможен только после отдельного изменения SMC representation
  (lib/smc/scoring.ts сейчас НЕ меняется).
- Range position НЕ clamp: position может быть <0/>1, outsideRange
  сохраняется.
- Deterministic SMC-идентификаторы (SMC1|…) проходят в DTO без
  изменений; собственных ID проекция не генерирует.
- Тесты: scripts/test-smc-projection.ts — реально evaluable fixture
  (LONG 75/10), равенство проекции с существующей Strategy-оценкой
  на том же H, 5-market common horizon summary, no-lookahead,
  deterministic/stable IDs, ms→seconds, lifecycle states,
  swing/internal слои, cannot-evaluate ≠ NEUTRAL, aggregate без
  overlays, чистота модулей.

ГРАНИЦЫ:
- API /api/chart/smc, CandleChart/UI, fancy-canvas, package changes —
  НЕ создаются в P1-A (только чистая подготовка DTO/проекции).
  (API /api/chart/smc добавлен ПОЗЖЕ в P1-B — см. §31i.)
- Будущая кнопка на графике «Смарт Мани Вкл/Выкл» управляет ТОЛЬКО
  UI-оверлеями; она НЕ трогает global Strategy.enabled и не пишет в БД.
- ПРОДУКТОВЫЙ UNIVERSE = TOP-100 (НЕ 500). Legacy
  Strategy.config.filters.top500Only=true фактически означает
  «только основной ranked universe» = Top-100 (lib/universe.ts);
  имя поля сохранено ради production JSON-конфигов.
- После полного Strategy cycle следующий Admin-приоритет —
  «Пользователи»: роли USER/ADMIN, назначение ADMIN, block/unblock,
  sessions, audit. СЕЙЧАС НЕ РЕАЛИЗОВЫВАТЬ.
- Signal Engine остаётся будущим P5 (только после приёмки стратегии
  и бэктеста).

---

## §31i. P1-B — read-only API boundary /api/chart/smc (11.09.2026)

API CONTRACT:
- GET /api/chart/smc?symbol=BTC&timeframe=1h (только GET; других
  методов нет). Таймфреймы: 5m/15m/1h/4h/1d.
- Ответ 200 — точный P1-A SmcChartProjection DTO (второго contract
  нет): per-exchange overlays + aggregate summary строго разделены.
- symbol: существующий parseSymbolParam (canonicalize A-Z0-9, <=16);
  timeframe: существующий parseTimeframeParam (белый список).
- Ошибки — { error } с русским сообщением: 400 INVALID_SYMBOL /
  INVALID_TIMEFRAME / STRATEGY_TIMEFRAME_UNSUPPORTED, 404
  ASSET_NOT_FOUND, 503 STRATEGY_MISSING / STRATEGY_INVALID /
  «База данных временно недоступна»; без stack/secrets клиенту.
- cannot-evaluate / нет рынков / нет свечей / нет общего горизонта —
  НЕ HTTP-ошибки: семантика в DTO (aggregate.status, per-market
  status); cannot-evaluate никогда не превращается в direction=NEUTRAL,
  unsafe alignment не прячется под успешный aggregate.

READ-ONLY ГАРАНТИИ:
- lib/chart/smc-api-service.ts — тонкий boundary: только загрузка и
  валидация входа + вызов существующей P1-A проекции; все вычисления
  SMC — внутри projectSmcChart, второго алгоритма нет.
- deps-интерфейс содержит ТОЛЬКО чтение (asset.findUnique,
  strategy.findFirst, market.findMany, candle.findMany); никаких
  Prisma create/update/upsert/delete, никаких Signal writes,
  никаких Strategy/Market/Candle writes — проверяется статически и
  поведенчески (fake без write-методов) в test-smc-api-service.
- Strategy читается из PostgreSQL: slug smart-money-suslik, latest
  version, config через существующий validateSmartMoneyRuntime.
  Engineering-config fallback запрещён (нет/невалидна → 503).
  Strategy.enabled/status не влияют на выдачу и не меняются: оверлеи
  графика — НЕ переключатель global Strategy.enabled.

DATA SOURCE / BOUNDS:
- только PostgreSQL CLOSED свечи; никаких внешних бирж и worker'ов.
- bounded query: существующий loadSmartMoneyCandles — последние 500
  CLOSED (DESC take 500 → reverse ASC), как в production runtime.
- Рынки: enabled + ACTIVE + SPOT + USDT (convention /api/chart/*).
- common-horizon checks НЕ ослабляются; eligibility целиком внутри
  проекции: для 1d BINGX исключается существующей Option A (4/4
  BINANCE/BYBIT/GATE/KUCOIN), special-case в route не дублируется.
- Top-100: semantics существующая (top500Only=true = Top-100
  universe), Top-500 не создаётся.

TESTS: scripts/test-smc-api-service.ts (111 проверок) — valid 5m,
valid 1d Option A, malformed/unsupported timeframe, symbol validation,
missing asset/markets/data, cannot-evaluate, exact DTO projection
preservation (побайтовое равенство с прямым вызовом P1-A проекции),
aggregate без overlay-массивов, OB_FVG_CONFLUENCE factIds=[],
exact OB/FVG factIds не теряются, no future/open candle leakage
(future CLOSED → future_horizon fail-closed), поведенческий no-write,
deterministic повторный результат.

ЯВНО: UI к графику ЕЩЁ НЕ подключён (кнопка «Смарт Мани» — позже,
только UI-state); Signal Engine НЕ входит (остаётся будущим P5).


## §31j. P1-C — панель Smart Money подключена к CandleChart (read-only UI) (11.09.2026)

SCOPE: только связка `CandleChart → GET /api/chart/smc → P1-A DTO →
Smart Money summary/WHY` с UI-only toggle. Это НЕ этап рисования:
визуальные primitives поверх свечей (BOS/CHoCH/liquidity/sweeps/FVG/OB/
dealing range/premium-eq-discount, canvas) остаются P1-D. Предыдущая строка
§31i «UI к графику ЕЩЁ НЕ подключён» с этого момента неактуальна (исторический
факт этапа P1-B, не переписывается).

КОД:
- `lib/chart/smc-panel.ts` — чистый view-model: состояние запроса
  (`off|loading|ok|error`), `shouldFetchSmc`/`needsSmcFetch`/
  `buildSmcRequestUrl`/`smcRequestKey`, `beginSmcRequest`/
  `applySmcResponse`/`clearSmcOnDisable` (identity-race), `isSmcAbortError`,
  `smcFailureMessage`, `parseSmcProjection` (граница), `isSmcPanelVisible`,
  подписи состояний (`AGGREGATE_STATUS_LABELS` — exhaustive по
  `CommonHorizonStatus`, `MARKET_STATUS_LABELS`, `AVAILABILITY_LABELS`),
  `formatUtcClock`, `reasonView`, `buildSmcPanelView`.
- `components/chart/SmartMoneyPanel.tsx` — тонкий рендер ИСКЛЮЧИТЕЛЬНО из
  view (в сырой DTO не ходит, overlay-массивы не печатает).
- `components/chart/CandleChart.tsx` — минимальная обвязка: локальный
  `smcEnabled` (useState(false)), `smcState` + `smcRequestIdRef` +
  `smcAbortRef` + `smcStateRef`, `loadSmc` (тот же паттерн, что у свечей),
  эффект только при ON, тумблер «Смарт Мани» в отдельном `<fieldset>`
  «Аналитика» (не среди «Индикаторы»), панель под графиком.
- `app/globals.css` — классы `.smcPanel/.smcHead/.smcTitle/.smcLine/
  .smcChip/.smcVerdict(--long|--short|--neutral|--none)/.smcMarkets/
  .smcMarket/.smcReasons/.smcTechnical/.smcDisclaimer` на существующих
  CSS-переменных; тема и layout графика не менялись.

TOGGLE = ТОЛЬКО UI. Он не читает и не пишет `Strategy.enabled`/status, не
ходит в admin API, не создаёт сигналов, ничего не сохраняет между reload.
Выключение панели НЕ выключает стратегию для кого-либо ещё.

REQUEST LIFECYCLE:
- URL строго `/api/chart/smc?symbol=<текущий symbol>&timeframe=<текущий
  timeframe>`; `exchange` НЕ передаётся, aggregate по выбранной бирже НЕ
  фильтруется (aggregate — уровень актива, несколько eligible бирж).
- ON и смена symbol/timeframe → новый запрос; OFF → abort + полный сброс.
- Ответ принимается только при `phase === "loading" && requestId === activeId`:
  отсталый ответ прежнего окна, ответ после выключения и повторный resolve
  того же id не могут ни перетереть новое, ни «воскресить» панель. При
  перезапросе прежняя проекция остаётся видимой до прихода новой (без мигания).
- Повторного запроса в то же окно нет (`loadedKey` + `needsSmcFetch`).
- HTTP 400/404/503 и битый payload → состояние панели: текст из `{ error }`
  тела либо «Не удалось загрузить Smart Money (HTTP nnn)» (обрезка 300
  символов, HTML/stack не показывается). Статус, ошибка и подгрузка истории
  графика из SMC-обвязки НЕ затрагиваются — ошибки SMC не ломают свечи
  (проверяется сканом региона обвязки: нет `setStatus(`, `setErrorMessage(`,
  `setHistory*`, обращения к сериям/`applyData`).

ЧТО РЕНДЕРИТСЯ (только фактические поля принятого `SmcChartProjection`):
- `assetSymbol` + `timeframe`; `aggregate.status`/`statusReason`
  (техническая строка — только при отказе: `technicalVisible`);
  `usable`/`gateAllowed`; `direction` → LONG/SHORT/«Нейтрально», при отказе —
  подпись статуса (`Не удалось согласовать рынки по времени`,
  `Данные отстают от расписания — вердикт не выдаётся`, …);
  `confirmation` (строка DTO, без пересчёта) + `minExchanges`;
  `evaluatedCount`/`cannotEvaluateCount`/`filteredCount`/`participantCount`;
  `horizonMs`/`engineAsOfMs` (UTC-подписи из ms),
  `expectedLatestClosedMs` + `lagBars`/`absoluteLagBars` с
  `relativeMaxLagBars`/`absoluteMaxLagBars`; `exchangeExcluded`
  (BINGX на 1d приходит из DTO — special-case в UI отсутствует);
  `gateRefusalReasons`; `perExchange`.
- per-exchange строки из `overlays[]`: `exchange · market`, статус
  («оценено» / «не удалось оценить» / «вне фильтров стратегии»), `direction`,
  `longScore`/`shortScore` (только у evaluated), `horizonMs`, `statusReason`,
  `availability.hardFailures` (подписи кодов), и WHY из `reasons[]`:
  `label` + «LONG x · SHORT y · макс z» + `value` (внутренние `SMC1|…`
  ключи текстом не печатаются).
- Дисклеймер: «Сила — это степень совпадения условий стратегии (0–100),
  а не вероятность успешной сделки». Процентов/«вероятности» в панели нет.

РАЗДЕЛЕНИЕ aggregate и биржи: aggregate-подписи не содержат имён бирж и
overlay-терминов (FVG/OB/BOS/pivot/liquidity), per-exchange строки не
содержат «подтверждений». Оверлеи и причины показываются как «по каждой
бирже отдельно» с явной пометкой, что общего набора фактов на несколько
бирж не существует.

WHY→factIds (семантика P1-A неизменна): только exact mapping контракта
(`scoreReasonFactIds`), `OB_FVG_CONFLUENCE` → `[]` всегда, соседние OB/FVG
не подбираются, никаких новых id; панель прокидывает `factIds` КОПИЕЙ
(мутация view не меняет DTO) — они пригодятся для highlighting на P1-D.

НЕ ИЗМЕНЕНО: `package.json`/`package-lock.json`, `prisma/schema.prisma`,
`app/api/chart/smc/route.ts`, `lib/chart/smc-api-service.ts`,
`lib/chart/smc-projection.ts`, `lib/chart/smc-contract.ts`, `lib/smc/**`,
`lib/strategies/**` (включая `common-horizon.ts` и `alignment.ts`), OHLCV/
адаптеры, worker/PM2, Admin/API, Strategy в БД. Записей в БД нет.
P1-A/P1-B semantics не правились: найденных дефектов нет.

TESTS: `scripts/test-smc-panel.ts` — 308/308 (view-model + порядковые
инварианты обвязки + скан чистоты + реальные DTO от `projectSmcChart`:
1h 5/5 LONG и 1d с исключением BINGX; deep-freeze DTO против мутаций).
Непустота подтверждена 9 мутациями (снятие loading-guard, игнор toggle,
пересчёт `confirmation` из голосов, `cannot-evaluate → «Нейтрально»`,
special-case 1d/BINGX в UI-слое, потеря `factIds`, отсутствие abort до
`fetch`, отсутствие early-return при OFF, безусловная техническая строка) —
каждая даёт падение. Регрессии P1-A/P1-B/SMC/chart — зелёные.

ЯВНО НЕ СДЕЛАНО (P1-D): primitives поверх свечей, маркеры/зоны/линии,
`factIds`-подсветка, тултипы, premium/equilibrium/discount-заливка,
пере-якорение оверлеев при прокрутке. Signal Engine — по-прежнему только P5.


==================================================
32. PRODUCT ROADMAP / ДАЛЬНЕЙШЕЕ РАЗВИТИЕ (10.09.2026)
==================================================

> Этот раздел — интеграция docs/ROADMAP.md (P0–P7) в единый authoritative контекст.
> После этого commit docs/ROADMAP.md удалён, чтобы не было двух источников правды.
> База: HEAD 9085d55 RANGE_POSITION CLOSED/UNDERSTOOD + Option A eligibility (принят на VPS 10.09.2026; real BTC diagnostic 5m READY, 15m READY, 1h READY, 4h READY, 1d verified via eligibility — BINGX 16:00 UTC excluded for 1d aggregation, 4/4 eligible BINANCE/BYBIT/GATE/KUCOIN aligned 2026-09-09T00:00:00Z safe=true), ветка arena/01a08b68-svechnoy-suslik. Rollout: Admin/API now supports all five TFs ["5m","15m","1h","4h","1d"].
> Документация-only — без изменения runtime/Admin/DB.

# Свечной Суслик — Product Roadmap & Backlog

Последнее обновление: 10.09.2026
HEAD: `9085d55936b20d54add3ab6a1534515be2d3480b` (RANGE_POSITION CLOSED/UNDERSTOOD + Option A eligibility + rollout, **принят на VPS 10.09.2026; 5m/15m/1h/4h READY, 1d verified via eligibility (4/4 aligned)**, Admin/API rollout supports ["5m","15m","1h","4h","1d"])
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
- Phase 3E multi-timeframe verification (принят на VPS 10.09.2026; real BTC diagnostic 5m READY, 15m READY, 1h READY, 4h READY, 1d BLOCKED before Option A — BINGX 16:00 UTC vs остальные 00:00 UTC; unsafe aggregation refused before eligibility, `aggregateAssetGroup` not called; after Option A (9085d55) 1d verified via eligibility — BINGX excluded, 4/4 eligible aligned 2026-09-09T00:00:00Z safe=true, aggregate executed on 4, Admin/API rollout now supports all five TFs)
- Phase 3D advanced configurable SMC parameters (Displacement, FVG, Liquidity, Order Blocks и др.)
- Полная Admin-конфигурируемость (русские описания, диапазоны, зависимости)
- Финальная приёмка Smart Money (read-only → staged → enabled)

**P1 — SuslikChart / визуализация стратегии**
- P1-A (11.09.2026, ПРИНЯТА): чистая подготовка Smart Money overlays —
  lib/chart/smc-contract.ts + lib/chart/smc-projection.ts +
  scripts/test-smc-projection.ts; per-exchange overlays и aggregate
  summary строго разделены; кнопка «Смарт Мани Вкл/Выкл» — только
  UI overlays, НЕ global Strategy.enabled
- P1-B (11.09.2026, ПРИНЯТА; подтверждена на VPS: BTC 5m/1d → 200,
  invalid 7m → 400): read-only API boundary GET /api/chart/smc —
  тонкий сервис над P1-A проекцией (lib/chart/smc-api-service.ts),
  PostgreSQL CLOSED-свечи через существующий bounded loader,
  Strategy из БД без engineering-fallback; UI ещё не подключён
- P1-C (11.09.2026, РЕАЛИЗОВАНО, §31j): подключение панели Smart Money к
  CandleChart — UI-only тумблер «Смарт Мани», GET /api/chart/smc с текущими
  symbol/timeframe, aggregate (актив) и per-exchange WHY показаны раздельно,
  race/abort-защита, ошибки изолированы от графика; без записей и без Strategy.enabled
- P1-D (СЛЕДУЮЩИЙ): визуальные primitives поверх свечей — BOS/CHoCH,
  structural levels, liquidity/sweeps, FVG/OB-зоны, dealing range,
  premium/equilibrium/discount, подсветка `factIds`; после него —
  canvas/primitives-приёмка на VPS
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
- `877dc61` Phase 3E fix **принят на VPS 10.09.2026** (5m/15m/1h/4h READY, 1d BLOCKED before Option A — BINGX 16:00 UTC vs 00:00 UTC) — проверено, переход к Phase 3D допустим после разблокировки 8549486; `9085d55` — 1d verified via eligibility (4/4 aligned) и rollout всех пяти TFs

---

## 17. Что сделано на 877dc61 и что дальше (приёмка 10.09.2026)

- Phase 3C: `["1h"]` staged lock, Admin/API, `minExchanges 3`, `DRAFT disabled`
- Phase 3E diagnostic: `lib/strategies/alignment.ts` (grid + same horizon, `referenceCandleTime`, `offGrid`/`horizonMismatch`, `safe=false` для 0 evaluated), generic `MULTI-EXCHANGE AGGREGATION REFUSED` для всех TF, `docs/phase3e-diagnostic-report.md`
- **VPS-приёмка 877dc61 (10.09.2026):** real BTC diagnostic 5m READY (5/5 evaluable, 15:10 UTC same horizon, safe=true), 15m READY (5/5, 15:00 UTC), 1h READY, 4h READY (5/5, 08:00 UTC), 1d BLOCKED before Option A (BINGX 16:00 UTC vs BINANCE/BYBIT/GATE/KUCOIN 00:00 UTC, OFF_GRID+HORIZON_MISMATCH, safe=false, `aggregateAssetGroup` not called); **после Option A (9085d55): 1d verified via eligibility — BINGX excluded, 4/4 eligible 2026-09-09T00:00:00Z GRID_OK/HORIZON_OK safe=true, aggregateAssetGroup executed on 4, minExchanges=3 NEUTRAL, Signal 0→0**; Strategy id=2 DRAFT disabled ["1h"] сохранён, edf3732 NOT ancestor
- **8549486 (10.09.2026):** Admin/API разблокированы проверенные 5m/15m/1h/4h, 1d остаётся disabled; код готов, DB строка id=2 пока ["1h"] не обновлялась (решение отдельно); **9085d55 + rollout (this commit): Admin/API теперь поддерживают все пять TFs ["5m","15m","1h","4h","1d"] (5m/15m/1h/4h across 5 exchanges, 1d via eligibility 4 eligible BINANCE/BYBIT/GATE/KUCOIN, BINGX excluded ONLY for 1d aggregation), DB id=2 остаётся ["1h"] DRAFT disabled до явного операторского решения**
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
  - 1d verified via eligibility — per-exchange all 5 evaluable, BINANCE/BYBIT/GATE/KUCOIN latest CLOSED = UTC 00 boundary (2026-09-09T00:00:00Z GRID_OK/HORIZON_OK), BINGX = UTC 16 boundary (OFF_GRID, excluded by eligibility), eligible 4/4 aligned safe=true, aggregateAssetGroup executed on 4 (BINANCE/BYBIT/GATE/KUCOIN), NEUTRAL (evaluated=4, minExchanges=3), BINGX per-exchange 16:00 UTC still available; Signal before=0 after=0
- Smart Money DRAFT id=2 exists in shared PostgreSQL; enabled=false; Signal=0; current DB Strategy timeframes=["1h"] — **no DB update has been approved/performed**; row remains DRAFT disabled ["1h"]
- Admin/API commit 8549486 unlocks verified 5m/15m/1h/4h and keeps 1d disabled — code ready, DB row still ["1h"] until separate decision; **rollout commit (this commit) unlocks 1d as well — Admin/API now supports ["5m","15m","1h","4h","1d"] (any non-empty subset), 1d via eligibility 4 eligible, DB id=2 remains ["1h"] DRAFT disabled until explicit operator approval**
- Signal remains 0 and Signal Engine remains prohibited (edf3732 NOT ancestor)
- 5m/15m/4h data quality passed; BTC test data now exists for 5m/15m/1h/4h/1d with same-horizon guard
- 1d has BINGX 16:00 UTC boundary vs other four 00:00 UTC — 1d now verified via Smart Money eligibility (BINGX excluded ONLY for 1d aggregation, BINANCE/BYBIT/GATE/KUCOIN aggregate on canonical UTC horizon 2026-09-09T00:00:00Z), per-exchange BINGX 16:00 UTC remains visible
- edf3732 NOT ancestor
- **Do not claim all Top-100 assets have multi-TF history** — timeframe runtime/alignment verified on BTC across 5 exchanges; availability for each asset still depends on stored CLOSED history.

RANGE_POSITION CURRENT SEMANTICS — CLOSED/UNDERSTOOD (11.09.2026, this commit — TEST/DOC ONLY, no runtime change):
During real VPS diagnostics observed: 5m historically pos ≈ -0.91 (DISCOUNT) and 1d after Option A pos ≈ 2.236..2.242 (PREMIUM). Verified now by `scripts/test-smc-scoring.ts` outside-range regression:

A) REPRESENTATION — VERIFIED (intended): `position=(price-low)/(high-low)` WITHOUT clamp (`range.ts:13-14,334-340` `БЕЗ clamp`, `outsideRange=position<0||>1`); `scripts/test-smc-range.ts:686-750` explicitly proves `1.01 outsideRange=true` and `-0.01 outsideRange=true` без clamp; DO NOT CLAMP.

B) CURRENT SCORING — VERIFIED + REGRESSION TESTED (preserve exact): `scoring.ts:340-360` ignores `outsideRange` as gate, `zone` still decides: `DISCOUNT (<0.48) → LONG +10`, `PREMIUM (>0.52) → SHORT +10`; therefore outside DISCOUNT/PREMIUM still receive configured `RANGE_POSITION` directional points. New `test-smc-scoring.ts` 25b–27b proves: pos -0.91 DISCOUNT => LONG+10 (value -0.91 not clamped), pos 2.236..2.242 PREMIUM => SHORT+10 (value 2.24 not clamped), custom weight 7 => exactly 7, inside 0.2/0.5/0.8 unchanged. This is CURRENT behavior, not profitability claim.

C) FUTURE PRODUCT HYPOTHESIS — NOT decided, moved to Backtest/OOS roadmap: whether outside ranges should stop scoring or expire (e.g. no scoring outside, N-bars-outside invalidation, maxAge) is NOT decided; must be evaluated by Backtest / out-of-sample before changing trading semantics. Not an unresolved correctness defect. Do NOT change `lib/smc/range.ts` / `lib/smc/scoring.ts` / `lib/smc/evaluate.ts` now; expected production diff NONE.

No DB/worker/Signal/Prisma change; `lib/smc/*` math preserved.

---
Единый источник правды — этот PROJECT_CONTEXT.md. docs/ROADMAP.md удалён (0b2be00 → этот commit).

==================================================
34. SMART MONEY PHASE 3D — CONFIGURABILITY + RANGE LIFECYCLE AUDIT (READ-ONLY) 10.09.2026
==================================================

**Baseline:** `60d243cbfd8cd33afa550c706f547f8c90cdac08` (parent `85494868f6b32ad062afd303309dc553e80a8ac9`), HEAD verified before audit.
**Scope:** Документационный аудит. Runtime/SMC-math/PostgreSQL/workers/Signal Engine НЕ менялись.
**Документ:** `docs/phase3d-audit.md` (версия этого раздела — краткое резюме, детали — в документе).

**Итог аудита:**

1. **Hardcoded SMC (A) найдены и верифицированы по файлам (см. §1 docs/phase3d-audit.md):**
   - `displacement: bodyAtrMin 1.5 / rangeAtrMin 2.0 / bullCloseLocMin 0.60 / bearCloseLocMax 0.40 / atrPeriod 14` (`lib/smc/displacement.ts:62`)
   - `fvg: minGapAtr 0.10 / maxAgeCandles 500 (override 0 в scoring) / atrPeriod 14` (`lib/smc/fvg.ts:66`)
   - `liquidity: eqToleranceAtr 0.10 / eqConfirmBars 2 / sweepMinPenetrationAtr 0.05 / maxAgeCandles 750 (override 0) / swing 20` (`lib/smc/liquidity.ts:64`)
   - `order-blocks: impulseMaxCandles 3 / confirmMaxCandles 10 / maxAge 750 / sweepLookback 5`; под-вызовы `1.5/2.0/0.6/0.4` и `minGap 0.1` захардкожены внутри `findOrderBlocks` (`lib/smc/order-blocks.ts:122,260`)
   - `range: eqBand 0.02 / swing 20` уже конфигурируем (`lib/smc/range.ts:48`) — не требует раскрытия
   - `config.ts:deriveSubConfigs` прокидывает только `atrPeriod/swing/eqBand/freshBars/weights` — остальные 14 кандидатов остаются вне `SmcScoringConfig` (B vs A чётко разделены).

2. **Уже конфигурируемо (B) — живой эффект:** `minimumScore 72 / minExchanges 3 / timeframes / swingLeft 20 / swingRight 20 / internal 3 / atrPeriod 14 / freshBars 10/5/20/20 / eqBand 0.02 / 9 weights / filters 0/false-Top-100` (`lib/smc/config.ts:39-84` → `deriveSubConfigs` → `scoring.ts/evaluate.ts/range.ts/liquidity/OB/fsm`). Мёртвых/дублированных ключей нет.

3. **RANGE_POSITION (критично, без clamp — уточнено после VPS review):** observed `5m ≈ -0.91 / 1d ≈ 2.24`.
   - **A) REPRESENTATION — CONFIRMED / TESTED:** `position=(price-low)/(high-low)` **не clamp** (`range.ts:13-14,334-340` `БЕЗ clamp`, `outsideRange=position<0||>1`); `scripts/test-smc-range.ts:686-750` явно тестирует `1.01 outsideRange=true без clamp` и `-0.01 outsideRange=true без clamp`.
   - **B) SCORING — VERIFIED + REGRESSION (this commit, TEST/DOC ONLY):** `scoring.ts:340-360` игнорирует `outsideRange`, зона → `DISCOUNT (<0.48) → LONG + weight`, `PREMIUM (>0.52) → SHORT + weight`; поэтому текущая реализация **детерминированно начисляет RANGE_POSITION и вне [low,high]** (вне-диапазон PREMIUM → SHORT, DISCOUNT → LONG). `scripts/test-smc-scoring.ts:320-360` покрывает `0.2/0.8/0.5 outsideRange=false`; **регрессия 25b–27b (this commit) верифицирует outside: 5m -0.91 → DISCOUNT LONG+10 (payload -0.91 без clamp), 1d 2.236..2.242 → PREMIUM SHORT+10 (payload 2.24 без clamp), вес 7 → ровно 7 — текущее поведение, не claim прибыльности**.
   - **C) PRODUCT / LIFECYCLE — FUTURE HYPOTHESIS → Backtest/OOS (NOT decided here):** старый active range остаётся scoring-релевантным после выхода цены за [low,high] (lifecycle без `maxAge`/price-invalidation, только `CHOCH`/новый `BOS` закрывают — `range.ts:278-290`). Явного решения `maxAge` / “N баров вне → expired” vs оставить breakout — нет; гипотеза перенесена в Backtest / out-of-sample roadmap. **Не clamp, не менять `lib/smc/range.ts` / `scoring.ts` сейчас**.

4. **Safety invariants (не конфигурируемы):** CLOSED-only / no-lookahead / детерминизм / cannot-evaluate / chronology / exact grid+same horizon / NO Signal writes / `edf3732` NOT ancestor + plateau `===`, FSM-phase, FVG/OB state sets, `SMCTIMEFRAME_MS`.

5. **Backward-compat контракт:** `defaultXConfig` — единственный источник (см. таблицу fallback в docs §5). `SmcScoringConfig` расширяется `optional` полями `displacement/fvg/liquidity/orderBlock`; отсутствие → `...defaultXConfig(tf)` (exact current behavior). Валидация в `assertValidSmcScoringConfig` с теми же ranges.

6. **Admin UX (рус., proposal docs §6):** grouped Displacement/FVG/Liquidity/OB, метка/объяснение/влияние ↑/↓/диапазон/дефолт/зависимости/предупреждение — не реализовано, только дизайн аудита.

7. **План внедрения (docs §7):** 3D-A (типы+defaults) → 3D-B (core wiring) → 3D-C (validate) → 3D-D (Admin/API) → 3D-E (regression/alignment/no-Signal) — минимум регрессии, proofs/эквивалентность на каждом этапе.

8. **Тест-план (docs §8):** old-config эквивалентность, канонические дефолты, эффект каждого параметра, malformed/boundary/dependencies, deterministic/no-lookahead/CLOSED/cannot-evaluate/multi-TF+exchange/Trend неизменён/no Signal/no ancestry + RANGE_POSITION 4 кейса.

Файлы аудита изменены в этом коммите: `docs/phase3d-audit.md` (новый) + этот §34.

==================================================
35. SMART MONEY PHASE 3D-A — CANONICAL ADVANCED CONFIG CONTRACT (IMPLEMENTED) 10.09.2026
==================================================

**Baseline:** `b06943112ff0c1aa9a4a8c23f474b0aa4c203076` (clean Phase3D branch, parent `b60de921931afe9920b4635fd7374f142d8921e6`; NOT the parallel SuslikChart chain `2c6b166`).
**Scope:** Config contract + canonical resolution/default mechanism only. No Admin UI, no API acceptance, no Prisma/DB, no workers, no Signal.
**Files:** `lib/smc/config.ts` (contract + resolver + validation + deriveSubConfigs wiring top-level), `scripts/test-smc-phase3d-config.ts` (61 tests).

**Exact config shape (optional, backward-compatible):**
```ts
SmcScoringConfig {
  // existing: tf, minimumScore, swingLeft/Right, internalLeft/Right, atrPeriod, freshBars, eqBand, weights
  displacement?: { bodyAtrMin?: number; rangeAtrMin?: number; bullCloseLocMin?: number; bearCloseLocMax?: number }
  fvg?: { minGapAtr?: number; maxAgeCandles?: number }
  liquidity?: { eqToleranceAtr?: number; eqConfirmBars?: number; sweepMinPenetrationAtr?: number; maxAgeCandles?: number }
  orderBlock?: { impulseMaxCandles?: number; confirmMaxCandles?: number; maxAgeCandles?: number; sweepLookbackCandles?: number }
}
```
Не вводит dealing-range lifecycle параметры (phase 3D defer).

**Canonical fallback values (единственный источник — defaultXConfig + scoring override):**
- `displacement 1.5 / 2.0 / 0.6 / 0.4` (`defaultDisplacementConfig tf` + atrPeriod)
- `fvg 0.10 / maxAge 0` — module default 500 остаётся для изолированных FVG-тестов, scoring fallback MUST be 0 (как и до Phase3D: `config.ts:195-199` override 0)
- `liquidity 0.10 / 2 / 0.05 / maxAge 0` — module default 750, scoring fallback MUST be 0
- `orderBlock 3 / 10 / 750 / 5` (`defaultOrderBlockConfig`)
Проверить `scripts/test-smc-phase3d-config.ts` §1 — модуль defaults 500/750 остаются, scoring resolved 0.

**Canonical resolution:** `resolveSmcAdvancedConfig(config)` — единственная чистая функция, покрывает 4 группы, дополняет недостающие поля fallback'ами, не дублирует magic constants. `deriveSubConfigs` уже использует resolved значения для top-level `displacement/fvg/liquidity/orderBlockSwing/orderBlockInternal` (старые конфиги → exact old behavior, т.к. fallback === hardcoded).

**Validation (fail-closed, в `assertValidSmcScoringConfig`):**
- `displacement.*` finite >=0 (каждый если задан)
- `fvg.minGapAtr` finite >=0; `fvg.maxAgeCandles` integer >=0
- `liquidity.eqToleranceAtr/sweepMinPenetrationAtr` finite >=0; `eqConfirmBars/maxAge` integer >=0
- `orderBlock.impulseMaxCandles` integer 1..10; `confirmMaxCandles` integer 1..100; `maxAge/sweepLookback` integer >=0
- malformed (NaN/Infinity/negative/fractional/0/11/101) → `SmcInputError`; edge 0/1/10/100 валидны. Границы — из существующих `assertValid*` модулей, без изобретения новых upper bounds (Admin UX bound 0..5000 — только UI рекомендация).

**NO RANGE LIFECYCLE CHANGE:** representation <0/>1 не clamp, scoring outsideRange игнорирует и начисляет via zone, lifecycle без maxAge/price-invalidation, `5m ≈ -0.91 / 1d ≈ 2.24` сохранены — verified `test-smc-phase3d-config.ts` §5 и `test-smc-range` 50/50.

**Exact semantic equivalence proofs (`test-smc-phase3d-config.ts` 61/61):**
1. Old config (no Phase3D fields) → resolved `1.5/2.0/0.6/0.4`, `0.1/0`, `0.1/2/0.05/0`, `3/10/750/5` (`deriveSubConfigs` identical).
2. Partial `{displacement:{bodyAtrMin:2.5}}` → остальные `2.0/0.6/0.4` fallback; аналогично для fvg/liquidity/orderBlock + empty groups.
3. Malformed → `SmcInputError` (26 кейсов) + edge valid.
4. Deterministic fixture 120 свечей: `deriveSubConfigs(old) ≡ explicit defaults` serialized, `evaluateSmc(old) ≡ explicit` deep identical, future-injection `full(T) ≡ prefix(T)` для обоих, `resolve` identical, scores/direction identical.
5. Range regression 5a/b outsideRange true still LONG/SHORT 10.
6. Trend `validateTrendSuslikConfig` still ok.
7. Signal: `lib/smc/config.ts` без `prisma.signal`; old resolved `1.5 === OB hardcoded 1.5` (no divergence for old); custom `3.0` demonstrates divergence — **deferred to 3D-B as documented**.

**What remains intentionally deferred to 3D-B (documented):**
- `findOrderBlocks` внутри всё ещё хардкодит `1.5/2.0/0.6/0.4` и `minGap 0.1` (`lib/smc/order-blocks.ts:260`); top-level displacement/FVG уже резолвятся, но OB internal остаётся divergent для кастомных значений. Для старых конфигов fallback === hardcoded, поэтому observable semantics идентична; для кастомных `3.0` divergence существует и устраняется в 3D-B пробросом resolved displacement/FVG в OB sub-evaluation. Типы/plumbing без семантического изменения допустимы, но не введены в 3D-A чтобы держать scope minimal (`lib/smc/config.ts` only).

**Tests (песочница):** `test-smc-phase3d-config.ts` 61/61, `test-smc-scoring` 63/63, `test-smc-range` 50/50, `test-smc-evaluate` 31/31, `smart-money` 62/62, `smart-money-readonly --self-test` 43/43, `test-admin-consistency` 84/84, `tsc --noEmit` 0, `git diff --check` 0.
**Signal ancestry:** `git merge-base --is-ancestor edf3732 HEAD` → NOT ancestor (проверено).
**DB:** No `prisma.strategy.*`/`prisma.signal.*`, no workers, Strategy id=2 остаётся `DRAFT enabled=false timeframes=["1h"]`, Signal 0→0 (read-only).

==================================================
36. SMART MONEY PHASE 3D-B — COMPLETE ADVANCED CORE WIRING / OB DIVERGENCE REMOVED (IMPLEMENTED) 10.09.2026
==================================================

**Baseline:** `dade753e1bed8663a7b8334241e6e09be14dec3e` (Phase 3D-A commit, parent `b06943112ff0c1aa9a4a8c23f474b0aa4c203076`), branch `arena/01a08b68-svechnoy-suslik-phase3d-clean` (exact parent, no SuslikChart).
**Scope:** Core wiring only — устраняет разрыв top-level vs OB internal; unknown-key fail-closed; без Admin UI/API, без Prisma/DB, без workers/Signal Engine, без dealing-range lifecycle изменений.
**Files:** `lib/smc/config.ts` (plumbing + unknown-key), `lib/smc/order-blocks.ts` (shared primitives), `scripts/test-smc-phase3d-config.ts` (расширен 61→70), `scripts/test-smc-phase3d-b.ts` (новый, 55 тестов).

**Проблема 3D-A (устранена):** `findOrderBlocks` хардкодил `bodyAtrMin 1.5 / rangeAtrMin 2.0 / bullCloseLocMin 0.6 / bearCloseLocMax 0.4` и `minGapAtr 0.1 / maxAge 0` (`order-blocks.ts:260`); `deriveSubConfigs` уже резолвил top-level, но OB internal оставался divergent для кастомных значений. Для старых конфигов fallback === hardcoded → no observable change; для кастомных `bodyAtrMin 3.0` top-level отклонял бы displacement, а OB всё ещё принимал — скрытое двойное поведение.

**Plumbing (ONE semantics, explicit typed, no circular/duplicate):**
- `SmcOrderBlockConfig` расширен optional полями `displacementBodyAtrMin/displacementRangeAtrMin/displacementBullCloseLocMin/displacementBearCloseLocMax/fvgMinGapAtr` (`order-blocks.ts` interface + validation finite>=0).
- `findOrderBlocks` теперь читает `config.displacementBodyAtrMin ?? 1.5` и т.д. (`minGapAtr ?? 0.1`), fallback сохраняет exact old behavior для старых вызовов без plumbing; `evaluateOrderBlocks` наследует.
- `deriveSubConfigs` прокидывает `adv.displacement.*` и `adv.fvg.minGapAtr` в `orderBlockSwing` и `orderBlockInternal` (оба `...defaultOrderBlockConfig` + 5 shared полей); top-level `displacement/fvg` и OB internal — одна resolved semantics (backward-compatible: old → 1.5/2.0/0.6/0.4/0.1).
- No circular imports, no duplicate constants, `findOrderBlocks` pure/deterministic без импорта global scoring config.

**FVG maxAge decision (документировано):**
- Top-level `fvg.maxAgeCandles` (0..∞) полностью wired в `deriveSubConfigs.fvg` и влияет на `evaluateFvgs` lifecycle (OPEN→EXPIRED), verified `test-smc-phase3d-b.ts` F2b.
- OB internal `hasFvgInImpulse` проверяет только `fvg.confirmedAt` ∈ `[clusterStart..impulseEnd]` и `confirmedAt <= structureConfirmedAt` (`order-blocks.ts: hasFvgInInterval`), state/expired НЕ проверяется; поэтому `maxAge` не влияет на OB confluence и намеренно НЕ пробрасывается — OB FVG `maxAge` остаётся `0` (строгое условие). `minGapAtr` MUST не diverge и прокинут. Задокументировано в `config.ts` header и `order-blocks.ts:260` comment, verified OB-R13.

**Unknown-key fail-closed (scoped to Phase3D namespace):**
- `assertValidAdvancedDisplacement/Fvg/Liquidity/OrderBlock` теперь проверяют `Object.keys` против `allowed Set` и бросают `SmcInputError: scoring.<group>.<typo>: неизвестное поле` (fail-closed для опечаток внутри 4 групп).
- Scoped: только внутри `displacement/fvg/liquidity/orderBlock`; legacy поля `SmcScoringConfig` (tf, swingLeft и т.д.) не затрагиваются; unknown advanced group name (например, `displecement`) игнорируется (не валидируется глобально) — задокументировано как Phase3D-namespace scoping, `test-smc-phase3d-b.ts` U6 и `test-smc-phase3d-config.ts` §8.
- Validation coherence: global `assertValidSmcScoringConfig` и module `assertValid*` консистентны, no weakening (все старые 26 malformed кейсов остаются, новые 4 unknown-key добавлены).

**Behavioral wiring proofs (14 params, каждый меняет relevant core):**
- Displacement 4: `bodyAtrMin 1.5→3.0` (fixture bodyAtr 1.5), `rangeAtrMin 2.0→2.5`, `bullCloseLocMin 0.6→0.9`, `bearCloseLocMax 0.4→0.1` — `evaluateDisplacements` count 1→0 verified.
- FVG 2: `minGapAtr 0.1→0.15` (gap 0.104), `maxAge 0→3` (expiry OPEN→EXPIRED) — `evaluateFvgs`.
- Liquidity 4: `eqToleranceAtr 0.5→0.05` (gap 2.0), `eqConfirmBars 2→3`, `sweepMinPenetrationAtr 0.05→0.5` (1.0 gap), `maxAge 0→3` — `evaluateLiquidity`.
- OB 4: `impulseMaxCandles 1→3` (derive + grouping), `confirmMaxCandles 1→10→15` (far BOS 12), `maxAge 0→3` (EXPIRED), `sweepLookback 0→1→5` (distance 2) — `evaluateOrderBlocks`.
- Distinguish resolver change vs behavior change: каждый тест сначала проверяет `deriveSubConfigs` resolved value, затем вызывает submodule с контролируемыми свечами и сверяет count/state.

**OB consistency regression (would have FAILED on 3D-A):**
- `test-smc-phase3d-b.ts` §5 OB-R1..R13: custom `bodyAtrMin 3.0` wired в оба OB configs (swing+internal) и identical top-level; behavioral: warmup fixture bodyAtr 1.5 top-level 0, old OB 1 vs new OB 0; `minGap 0.5` wired, `hasFvgInImpulse` true→false; `maxAge` not wired still true. На 3D-A этот тест падал бы (OB internal оставался 1 и true).
- Также `test-smc-phase3d-config.ts` §7c-ob/e: прямой check `deriveSubConfigs` wiring для всех 5 shared primitives.

**Old-config exact equivalence (frozen deterministic):**
- `deriveSubConfigs(old) ≡ explicit defaults` serialized, `resolve` identical, `evaluateSmc(old) ≡ explicit` deep identical (120 свечей fixture, `T0+120h`), future-injection `full(T) ≡ prefix(T)`, scores/direction identical — §7 EQ1-3 в `test-smc-phase3d-b.ts` и §4 в `test-smc-phase3d-config.ts`.

**Range position DO NOT CHANGE:**
- No clamp, `outsideRange` true still awards via zone, lifecycle без изменений — `test-smc-phase3d-config.ts` §5 и `test-smc-range` 50/50 untouched.

**Safety invariants unchanged:**
- CLOSED-only, no-lookahead, deterministic, cannot-evaluate≠NEUTRAL, chronological/grid/no Signal writes, `edf3732` NOT ancestor — verified.

**Tests (песочница):**
- `test-smc-phase3d-config.ts` 70/70 (61→70, +OB wiring + unknown-key)
- `test-smc-phase3d-b.ts` 55/55 (14 params behavioral + OB regression + unknown-key + equivalence)
- `test-smc-displacement` 23/23, `test-smc-fvg` 37/37, `test-smc-liquidity` 48/48, `test-smc-order-blocks` 63/63, `test-smc-scoring` 63/63, `test-smc-evaluate` 31/31, `test-smc-range` 50/50, `smart-money` 62/62, `smart-money-readonly --self-test` 39/39, `test-admin-consistency` 84/84, `tsc --noEmit` 0, `git diff --check` 0.

**Signal ancestry:** `git merge-base --is-ancestor edf3732 HEAD` → NOT ancestor.
**DB:** No `prisma.strategy.*`/`prisma.signal.*`, no workers, Strategy id=2 остаётся `DRAFT enabled=false timeframes=["1h"]`, Signal 0→0. Только config/OB/test/PROJECT_CONTEXT.md изменены; `components/admin/app/api/admin/prisma/schema/chart/Signal` не тронуты.

**Deliverable:** ONE commit exact parent `dade753`, push only `arena/01a08b68-svechnoy-suslik-phase3d-clean`, STOP after 3D-B (no 3D-C).

==================================================
37. SMART MONEY PHASE 3D-C — STRATEGY JSON / RUNTIME BOUNDARY (IMPLEMENTED) 10.09.2026
==================================================

**Baseline:** `2fc18aeb09164dc36b7316a9295ad944c995122a` (Phase 3D-B commit, parent `dade753e1bed8663a7b8334241e6e09be14dec3e`), branch `arena/01a08b68-svechnoy-suslik-phase3d-clean` (exact parent).
**Scope:** Strategy JSON boundary only — wires 4 optional advanced groups through real Strategy JSON → SmcScoringConfig → runtime; no Admin UI/API, no PostgreSQL mutation, no workers, no Signal.

**Problem (3D-B drop):** `lib/strategies/smart-money.ts` `validateSmartMoneyConfig` parsed only flat legacy fields (minimumSignalScore, swing/internal, atrPeriod, freshBars, eqBand, weights, filters, tf) and silently dropped `displacement/fvg/liquidity/orderBlock`. After 3D-C valid advanced JSON must be preserved and validated.

**Implementation:**
- `lib/strategies/smart-money.ts` `validateSmartMoneyConfig` updated:
  - Explicit `ALLOWED_TOP_LEVEL` Set (audit of seed `scripts/seed-smart-money-args.ts` `CANONICAL_SMC_CONFIG` + current DB id=2 shape + all existing tests): `minimumSignalScore/minimumScore/swingLeft/swingRight/internalLeft/internalRight/atrPeriod/structureEventFreshBars/sweepFreshBars/orderBlockFreshBars/fvgFreshBars/eqBand/weights/filters/tf` + 4 Phase3D groups. Unknown top-level → `config.<key>: neizvestnoe pole`.
  - Strict inner `weights` (9 keys) and `filters` (2 keys `minimumQuoteVolume24h/top500Only`) unknown → `config.weights.<key>/config.filters.<key>: neizvestnoe pole` (previously silent; now fail-closed — audited safe, no existing config/test uses extra).
  - Advanced groups safely copied (`displacement/fvg/liquidity/orderBlock` if present, preserving shape for validator) into `SmcScoringConfig` candidate; numeric/coherence validation delegated to canonical `assertValidSmcScoringConfig` (no duplicated bounds, deterministic translation via `ValidateSmcConfigResult`).
  - `filters` handling now explicitly checks both required fields if present, preserving default when absent.
  - `validateSmartMoneyRuntime` automatically inherits advanced handling per timeframe (validates config for each tf via `validateSmartMoneyConfig`, configs per tf preserved).
- **Legacy compat:** `filters.top500Only` (semantics Top-100) remains accepted; exact old JSON without advanced groups validates `ok:true` with no advanced fields leaked; `minimumScore` still gives proper threshold-uniqueness error.
- **Unknown group aliases:** `displecement/orderBlocks/orderblock/liqudity/randomFutureKnob` → top-level unknown reject (verified).

**Validation reuse:**
- Structural JSON shape (top-level allow-list, weights/filters strict) checked locally; all numeric bounds, coherence (weights sum 100), advanced groups numeric/integer ranges and nested unknown handled by canonical `lib/smc/config.ts` (single source of truth, no second bounds set). Errors translated to `ValidateSmcConfigResult` style.

**Backward compat — non-negotiable (verified):**
- Old Strategy JSON without advanced groups → `ok:true`, `config.displacement/fvg/liquidity/orderBlock === undefined`, derived `1.5/2.0/0.6/0.4` etc via resolver; DB row id=2 (DRAFT enabled=false `["1h"]` minExchanges 3) requires no migration; `test-smc-phase3d-c.ts` §1.

**Proofs:**
- **All 14 fields round-trip:** `test-smc-phase3d-c.ts` §3 via `validateSmartMoneyConfig` and §4 via `validateSmartMoneyRuntime` (displacement 4, fvg 2, liquidity 4, orderBlock 4) — each preserved and `deriveSubConfigs` wired.
- **Runtime behavior:** §5 displacement `bodyAtrMin 3.0` via `validateSmartMoneyConfig` → `deriveSubConfigs` → `evaluateDisplacements` 1→0, plus `validateSmartMoneyRuntime` configs per tf contain 3.0; representative FVG/Liquidity/OB also round-trip.
- **Multi-TF:** § MT 5m/15m/1h/4h/1d all `ok:true` and preserve `2.2/0.12` per tf; 1d `ok:true` at pure validator level and Admin/API rollout now accepts all five (any non-empty subset, 1d via eligibility).
- **Old-config equivalence:** §1e + deterministic/no-lookahead via `evaluateSmc` prefix equality.

**Tests (new):**
- `scripts/test-smc-phase3d-c.ts` **91/91**: old valid, partial, all 14 round-trip config/runtime, behavior, malformed (null/array/wrong type/NaN/Infinity/bounds/nested unknown), unknown top-level (5 aliases), filters/weights strict, legacy top500Only, Trend unchanged, deterministic/no-lookahead, no Signal, multi-TF 5m/15m/1h/4h + 1d.

**Regression (strict, no || true):**
- `test-smc-phase3d-config` 70/70, `test-smc-phase3d-b` 55/55, `test-smc-phase3d-c` 91/91, `test-smart-money` 62/62, `smart-money-readonly --self-test` 43/43, `test-smart-money-diagnostic` 95/95, `test-admin-consistency` 84/84, `test-seed-smart-money` 86/86, `test-smart-money-phase3c-fix` 39/39, `test-smc-*` 23/23/37/37/48/48/63/63/31/31/50/50, `tsc --noEmit` 0, `git diff --check` 0, `edf3732` NOT ancestor, **NO DB mutation** (prisma.strategy.* not called, only in-memory JSON, DB id=2 unchanged, Signal 0).

**Filters / existing config:** `minimumSignalScore`, `weights`, freshness, swing/internal, `atrPeriod`, `eqBand`, `minimumQuoteVolume24h`, `top500Only` semantics unchanged; Trend path unchanged.

**Range position:** No clamp, no maxAge, no outsideRange scoring changes (undecided, preserved).

**Admin / DB:** Advanced groups exposed in Admin via Phase 3D-D (14 params); **1d now enabled via rollout (eligible 4 for 1d, BINGX excluded ONLY for 1d aggregation)**; no PostgreSQL mutation, no workers, no Signal Engine (Strategy id=2 remains DRAFT ["1h"]).

**Deliverable:** ONE commit exact parent `2fc18ae` (this commit), push clean Phase3D branch only, STOP after 3D-C.

==================================================
38. SMART MONEY PHASE 3D-D — ADMIN + API FOR ALL 14 ADVANCED PARAMETERS (IMPLEMENTED) 10.09.2026
==================================================

**Baseline:** `980b4087ca163b6108dda0de1811267b8ed67f5e` (Phase 3D-C commit, parent `2fc18aeb09164dc36b7316a9295ad944c995122a`), branch `arena/01a08b68-svechnoy-suslik-phase3d-clean` (exact parent, no parallel history).
**Scope:** Admin UI + API for all 14 advanced parameters through already accepted `validateSmartMoneyRuntime→validateSmartMoneyConfig→canonical validator`, no second model. No schema/Signal/alignment/chart/range math/core changes.

**Problem (3D-C drop):** `components/admin/SmartMoneyStrategyEditor.tsx` показывал продвинутые параметры только read-only (`«Phase 3D (только просмотр)»`) — 14 полей не редактировались, старые DB без advanced выглядели пусто/blank. После 3D-D все 14 должны быть редактируемы, old config загружает canonical defaults, no migration.

**Implementation — `components/admin/SmartMoneyStrategyEditor.tsx` (единственный изменённый runtime-файл, `app/api/admin/strategies/[id]/route.ts` уже корректен):**
- Типы `SmartMoneyAdvancedDisplacement/Fvg/Liquidity/OrderBlock` + константы `DEFAULT_DISPLACEMENT 1.5/2.0/0.60/0.40`, `DEFAULT_FVG 0.10/0`, `DEFAULT_LIQUIDITY 0.10/2/0.05/0`, `DEFAULT_ORDERBLOCK 3/10/750/5` (единственный источник для UI fallback, backend остаётся authoritative).
- `normalizeConfig(raw)` — для old DB без advanced групп дополняет каждую группу canonical defaults (проверка `typeof === "number"` → иначе default, no blank/NaN), covers `displacement 4 + fvg 2 + liquidity 4 + orderBlock 4 = 14`.
- `validateLocal(config, timeframes, minExchanges)` — UI-валидация (client-side, backend authoritative): `minimumSignalScore 0..100 целое`, `swing/internal 1..500`, `freshBars ≥0`, `eqBand 0..0.5`, `weights Σ=100`, `timeframes []/1d` rejected, `minExchanges 1..5` + 14 advanced UI ranges: `displacement body 0..10 / range 0..10 / bull 0..1 / bear 0..1`, `fvg minGap 0..5 / maxAge 0..5000 целое`, `liquidity eqTol 0..1 / eqConfirm 0..20 целое / sweep 0..1 / maxAge 0..5000 целое`, `orderBlock impulse 1..10 целое / confirm 1..100 целое / maxAge 0..5000 целое / sweepLookback 0..100 целое`; integer checks via `Number.isInteger`.
- **4 editable grouped sections (Russian):**
  - `Импульс / Displacement` — 4 поля + описание shared top-level+OB (единый примитив), что контролирует/увеличение/уменьшение/диапазон/default/зависимость от `atrPeriod`.
  - `Ценовой дисбаланс / FVG` — 2 поля: `minGapAtr` shared (top-level+OB), `maxAgeCandles` top-level only (не влияет на OB `hasFvgInImpulse` — interval check), 0=выключено.
  - `Ликвидность` — 4 поля: eqTolerance/eqConfirmBars/sweepMin/maxAge (lifecycle, 0=выключено).
  - `Блоки ордеров / Order Blocks` — 4 поля: `impulseMax 1..10 / confirmMax 1..100 / maxAge 0..5000 (0=выключено) / sweepLookback 0..100 (0=выключено)` + dependencies от displacement/FVG/swing.
  - Каждая секция: кнопка `Сбросить секцию`, `NumberField` с `min/max/step` (body/range 0.1, bull/bear 0.05, fvg 0.05/1, liquidity 0.01/1, OB 1), русское объяснение what-it-controls/increase/decrease/range/default/dependencies, no profitability claims.
- **Range note:** `position не clamp — may be <0 or >1, Discount/Premium, lifecycle audit open` — сохранено, no clamp change.
- **Reset:** `resetSection(Импульс/FVG/Ликвидность/Order Blocks)` → `...DEFAULT_*`, `resetAll()` → `...DEFAULT_CONFIG` + `weights/filters/displacement/fvg/liquidity/orderBlock` + `timeframes ["1h"]`, preserves `enabled/status` (не трогает `setEnabled`).
- **Save:** `body: JSON.stringify({enabled, minExchanges, timeframes, config})` — `config` содержит 4 groups 14 fields; `canSave = isDirty && errors.length===0`; `isDirty` via `useMemo(JSON.stringify)`.

**API — `app/api/admin/strategies/[id]/route.ts` (проверен, изменений не требуется):**
- Уже вызывает `validateSmartMoneyRuntime({config, timeframes, minExchanges})` ДО `prisma.strategy.update` (preserve `config` exact, reject malformed/unknown before update).
- `allowedVerified = ["5m","15m","1h","4h","1d"]` (all five verified via rollout: 5m/15m/1h/4h across 5 exchanges, 1d via eligibility 4 eligible BINANCE/BYBIT/GATE/KUCOIN, BINGX excluded ONLY for 1d), any non-empty subset of ["5m","15m","1h","4h","1d"] allowed via `validateSmartMoneyRuntime` + API guard (reject []/unknown before prisma.update); `Trend` unchanged; no `prisma.signal`.

**Backward compat:**
- Old config (no advanced, как DB id=2 DRAFT enabled=false ["1h"] minExchanges 3) → `normalizeConfig` shows 14 canonical defaults, `validateSmartMoneyConfig` ok, derived `1.5/2.0/0.6/0.4` etc; no migration, no blank/NaN.

**Tests (new):**
- `scripts/test-smc-phase3d-d.ts` **87/87**: §1 old→14 defaults + normalize + 4 groups present + read-only removed, §2 14 represented, §3 reset section/all + preserve enabled, §4 UI ranges 0..10/0..1/0..5/0..5000 etc, §5 integer, §6 prospective payload includes 4 groups 14 fields `1.6/2.1/0.7/0.3 etc` validates, §7 backend accepts valid all14 / rejects NaN/unknown `displecement`/nested unknown before update + API validates before prisma, §8 []/1d/mixed rejected + 5m/15m/1h/4h accepted, §9 Trend unchanged, §10 Range note `<0/>1` + lifecycle audit + evaluateSmc still works, §11 no Signal Engine exists claim (честно `не развёрнут`), §12 no DB mutation (no `PrismaClient`/`await prisma.`), §13 client validation via `validateLocal` not just HTML min/max.

**Regression (strict, no || true):**
- `test-smc-phase3d-c` 91/91, `test-smc-phase3d-config` 70/70, `test-smc-phase3d-b` 55/55, `test-smart-money` 62/62, `smart-money-diagnostic` 95/95, `test-admin-consistency` 84/84, `test-smc-*` 23/23/37/37/48/48/63/63/31/31/50/50/63/63/24/24/62/62, `tsc --noEmit` 0, `next build` compiled successfully, `git diff --check` 0, `edf3732` NOT ancestor, NO DB mutation (only in-memory, `prisma.strategy.update` only via existing API guard), Signal 0.

**UI safety:** Suggested UI ranges not clamped at core (backend `finite≥0` authoritative, UI 0..10 etc only for operator comfort).

**Status:** 3D-D implemented, **not final-ready** (Phase 3D-E regression/alignment/no-Signal still pending before final acceptance). Only `components/admin/SmartMoneyStrategyEditor.tsx`, `scripts/test-smc-phase3d-d.ts`, `PROJECT_CONTEXT.md` changed; `prisma/schema`, `Signal`, `alignment`, chart/range math не тронуты.

**Deliverable:** ONE commit exact parent `980b408`, push only `arena/01a08b68-svechnoy-suslik-phase3d-clean`, STOP after 3D-D.

==================================================
39. BINGX 1D ALIGNMENT ROOT-CAUSE AUDIT — READ-ONLY (11.09.2026)
==================================================

**Baseline:** `d5029df40d75fd2d6ba36ac55c4bfac95a8e254c` (Phase 3D-D fix, parent `8e853e63dca144e11953c14c6a16545b3d826b4d`; **NO DB mutation, NO workers, NO Signal, NO SMC/math, NO 1d enable, NO global BingX removal; `edf3732` NOT ancestor — verified). Документационный аудит поверх точного `d5029df`, без изменения runtime/Admin/DB. Полный аудит: `docs/bingx-1d-alignment-audit.md` (версия этого раздела — краткое резюме, детали — в документе).

**Наблюдение Phase 3E (подтверждено, не гипотеза):** BTC real diagnostic 5m/15m/1h/4h READY (5/5 evaluable, same horizon `safe=true`), `1d` BLOCKED before Option A — BINGX `offGrid + horizonMismatch` (`openTime % 86400000 === 57600000`, `T16:00:00Z` vs `T00:00:00Z` у BINANCE/BYBIT/GATE/KUCOIN), `safe=false`, `MULTI-EXCHANGE AGGREGATION REFUSED` before eligibility (`aggregateAssetGroup` not called). **После Option A (9085d55): BINGX excluded by `lib/strategies/smart-money-eligibility.ts`, eligible `4/4` (BINANCE/BYBIT/GATE/KUCOIN) `2026-09-09T00:00:00Z` GRID_OK/HORIZON_OK `safe=true`, `aggregateAssetGroup` executed on 4.** 5m/15m/1h/4h BingX верифицирован как GRID_OK/aligned/usable.

**Трассировка ingestion (7 шагов, каждый pass-through, 16:00 UTC не вносится нами):**
- `lib/exchanges/bingx.ts:8-9,172-176` — `GET /openApi/spot/v2/market/kline?symbol&interval=1d&limit` — для `1d` `bingxInterval==="1d"` буквально, **no** `timeZone/session` param.
- `bingxInterval` + `timeframeMs` (`1d:86400000`) — `duration` только для `closeTime = openTime + 86400000 -1`, не сдвигает `openTime`.
- `210-251` — `openTime = Number(row[0])` (или `row.time`) verbatim → `new Date(openTime)` — **no** `+8h`, `toLocaleString`, `Intl`, timezone arithmetic. Если API отдал 00:00, мы бы сохранили 00:00.
- `closed = closeTime < now` — wall-clock, не session.
- `lib/ohlcv/sync.ts` — `runOhlcvSync → upsertCandles` по `marketId+timeframe+openTime` exact, `isValidCandle` не трогает `openTime % tfMs`, `incoming = filter(c.openTime >= last.openTime)` — no resampling/normalization.
- `prisma/schema.prisma` `Candle @@unique([marketId,timeframe,openTime])` — 16:00 и 00:00 разные ключи, no dedup.
- **Вывод:** pipeline прозрачен, UTC-агностичен — **16:00 приходит с провода BingX**.

**API семантика (evidence vs hypothesis — чётко разделено):**
- **Evidence:** адаптер не передаёт `timeZone`; тот же pipeline даёт `00:00Z` для 4 бирж и `16:00Z` только для BingX `1d`, а `5m/15m/1h/4h` BingX — `GRID_OK` (тот же `row[0]`-путь). Variance per-exchange/per-API доказывает внешний источник.
- **Strong hypothesis (не утверждается без `curl` + docs цитаты):** `16:00 UTC = 00:00 CST (UTC+8)` (`57600000 = 8h`). BingX `1d` определён как Asia session `00:00-24:00 CST`, а 4 другие — как UTC day (Binance docs UTC, Bybit `D` UTC и т.д.). Intraday `1h` и т.д. у всех — duration-anchored от Unix epoch, а daily — session-anchored, поэтому расхождение изолировано к `1d`.
- **Wire-доказательство (рекомендованное VPS `curl` до remediation):** `curl .../kline?symbol=BTC-USDT&interval=1d&limit=5` → `openTime T16:00:00.000Z`, тогда как `binance /api/v3/klines?interval=1d` → `T00:00:00.000Z` на те же UTC даты.

**Сравнение 5 бирж (почему другие 00:00):**
- BINANCE `interval=1d` UTC, BYBIT `D` UTC, GATE `1d` UTC, KUCOIN `1day` UTC — каждый адаптер хранит `openTime` verbatim, `close = open+duration-1`. Разница — определение `1d` на бирже, не наш код.

**Stored BTC BINGX 1d rows — READ-ONLY (no DB mutation, no bulk fetch):**
- **Proven Phase 3E:** latest CLOSED BTC BINGX `1d` `openTime T16:00:00Z` vs 4× `T00:00:00Z`, `offGrid true (57600000)`, `horizonMismatch true`, `safe false` → REFUSED.
- **To be re-verified on VPS READ-ONLY (exact SQL в `docs/bingx-1d-alignment-audit.md` §5.2):** `GROUP BY hour_utc` → `100% 16` для BINGX `1d`, `100% 0` для остальных; `lag(openTime)=86400000` continuous; `count==distinct`, no dups; `close = open+86400000-1`. Логика pipeline гарантирует стабильность `16:00` для всех 299 `1d` (API session stable), но полный scan — честная VPS-проверка без bulk fetch/workers.

**Критичное различение A vs B (доказано):**
- **A) Real 24h 16:00→16:00 UTC (00:00→00:00 CST)** — OHLC агрегирован биржей за это окно, `openTime` корректно его метит.
- **B) Canonical UTC [00:00,24:00) mis-encoded (+16h bug)** — OHLC был за UTC день, но label сдвинут.
- **Доказано A, B опровергнуто:** `openTime` verbatim без сдвига; no shift code; `1d` изолировано (timestamp bug задел бы все TF); OHLC divergence (будет на VPS): `BINGX 16:00` OHLC ≠ `BINANCE 00:00` того же календарного UTC дня, а равна price action `16:00→15:59Z`. **Следствие: `UPDATE openTime -16h` — фальсификация** (пометит 16:00-окно как UTC день, open/high/low/volume из неправильного окна).

**Сравнение remediation (без реализации, см. таблицу §7 audit):**
- **A) Exclude BINGX only for `1d` aggregation** — keep BingX globally (5m/15m/1h/4h), refuse BingX only when `timeframe==='1d'` via `isEligible(ex,tf)` / `ELIGIBLE_EXCHANGES_BY_TF["1d"]=4` (BINANCE/BYBIT/GATE/KUCOIN). No DELETE/UPDATE, rows stay but ignored for `1d` `aggregateAssetGroup`; per-exchange `1d` display may remain. Zero OHLC risk.
- **B) Request UTC-aligned `1d` if API supports** — send `?timeZone=UTC`/`session` etc., exchange returns `00:00Z`. **Не найдено** — в `bingx.ts` такого param нет, docs не цитированы; **not actionable today** — research spike с `curl` + docs quote required, иначе silent failure (param ignored, still `16:00`).
- **C) Construct canonical UTC daily from CLOSED `1h`** — compute `1d` `[00:00,24:00) UTC` from 24 CLOSED `1h` BingX (UTC-aligned): `open=first.open@00:00, high=max, low=min, close=last.close@23:00, volume=sum`, only after UTC day fully closed (`23:00 closeTime < now`), gap → `cannot-evaluate`, no lookahead. Mathematically safe if complete. Future, после A.
- **D) Remove BingX globally** — `DELETE Market WHERE exchange='BINGX'` — collateral damage: loses proven `5m/15m/1h/4h` 5/5 → 4/4 for no reason; **contraindicated** (task says do not).

**Other symbols/TF analogous off-grid (READ-ONLY, no bulk):**
- Code per-exchange/per-TF identical; symbol-independent. `5m/15m/1h/4h` `badStep=0` `GRID_OK` for all 5 on BTC, so no analogous off-grid beyond BingX `1d` expected. Future VPS spot-check: 1-2 symbols `GROUP BY symbol,hour_utc` (`ETH`, `SOL`) — `hour=16` for all BINGX `1d`, не bulk Top-500.

**Consequences of A (30/4-safe):**
- `1d` eligible = 4 (`BINANCE/BYBIT/GATE/KUCOIN`) canonical `00:00Z` → `minExchanges=3` remains safe (`3/4` or `4/4` confirmation). `5m/15m/1h/4h` remain `5/5`. Generic guard already refuses `5/5` with `16:00`, explicit eligibility makes `4/4 safe=true` intentional. Do NOT enable `1d` yet — eligibility must be live + §11 tests green.

**Root cause (concise, evidence-labeled):**
- **Proven:** BingX Spot `1d` `openTime` from API is `16:00 UTC`, not `00:00 UTC`; we store verbatim (`Number(row[0])`); pipeline cannot synthesize offset; exchange-side session definition causes divergence.
- **Evidence:** `bingx.ts` no timezone, worker pass-through, latest CLOSED `16:00` vs `00:00`, intraday control `GRID_OK`.
- **Hypothesis (to be quoted):** `16:00 UTC = 00:00+08:00` Asia session — arithmetic `16*3600000` + pattern, pending BingX docs phrase.

**Recommendation (safest):**
- **Immediate (next commit): Option A** — per-timeframe eligibility (BINGX excluded only for `1d`), `1d` aggregates 4 aligned, `minExchanges=3` safe, no data rewrite.
- **Future if 5/5 desired:** Option C (derive UTC `1d` from `1h`), after B spike shows no `timeZone` param. Option D not recommended.

**Exact future implementation plan (not in this audit, §12 audit):**
- Commit 1 — `lib/strategies/eligibility.ts` `ELIGIBLE_EXCHANGES_BY_TF` + `isEligible`, filter before `checkCandleAlignment` in diagnostic/aggregation, `TS validated by `scripts/test-eligibility.ts`; diagnostic BTC `1d` 4/4 `safe=true`.
- Commit 2 — B spike `curl` with candidate `timeZone` param + docs capture.
- Commit 3 — `lib/ohlcv/derive-daily.ts` `deriveUtcDailyCandles` pure 24×`1h`→`1d`, no lookahead, `CLOSED` only.
- What NOT to do: `UPDATE -16h`, `DELETE` without preview, `force-reset`, `TRUNCATE`, change SMC/alignment/1d enable/Signal.

**Migration implications:**
- **A:** None — old `16:00` rows stay, distinct key from future `00:00`, ignored for `1d` aggregation at read path.
- **B/C:** New `00:00` rows inserted as distinct keys; old `16:00` remain until explicit retention decision (keep both vs archive after `GROUP BY` + `24h` continuity proof). No `UPDATE` in place.

**Tests before enabling `1d` (must be green on VPS PostgreSQL, §14 audit):**
- Existing: `test-smc-phase3d-c 91/91`, `phase3d-config 70/70`, `phase3d-b 55/55`, `smart-money 62/62`, `diagnostic 95/95`, `admin-consistency 84/84`, `tsc 0`, `diff --check 0`, `edf3732` NOT ancestor, **NO DB mutation**.
- New for A: `isEligible(BINGX,1d)=false`, `4×T00:00Z→safe true`, `5×with T16→safe false`, BTC diagnostic `1d` filtered `4/4` ALIGNED `aggregateAssetGroup` called.
- New for C: `deriveUtcDaily` 24×CLOSED, 23→null, closed=false→null, high/low/volume, no lookahead.
- VPS READ-ONLY: `hour_utc` distribution BTC+ETH, continuity, duplicates, `smart-money-diagnostic --timeframe=1d` filtered `4/4 safe` and derived equality divergence.
- Must NOT: `UPDATE -16h`, `DELETE` BINGX `1d` without preview, `Strategy id=2 timeframes includes 1d` before tests.

**Files changed in this audit commit:** `docs/bingx-1d-alignment-audit.md` (new, 9 sections, evidence/hypothesis separated), `PROJECT_CONTEXT.md` (this §39 only). **No** `components/admin`, `app/api`, `lib/smc`, `lib/strategies`, `lib/exchanges`, `lib/ohlcv`, `prisma`, `Signal`, `alignment`, `chart`. Verification: `git diff --check` clean, `tsc --noEmit` if TS touched (no TS changes → 0), `git merge-base --is-ancestor edf3732 HEAD` → exit `1` (NOT ancestor), `NO DB mutation` (no `prisma.strategy.update/signal`/`DELETE/UPDATE`).

**Reference (§17 audit):** `lib/exchanges/bingx.ts`, `binance.ts/bybit.ts/gate.ts/kucoin.ts`, `lib/ohlcv/sync.ts`, `lib/strategies/alignment.ts`, `docs/phase3e-diagnostic-report.md`, `scripts/smart-money-diagnostic.ts`, `app/api/admin/strategies/[id]/route.ts`.

**Deliverable:** Documentation-only audit on exact `d5029df`, STOP after audit (next commit is Option A implementation after review).

==================================================
40. SMART MONEY OPTION A — ELIGIBILITY POLICY (IMPLEMENTED) 11.09.2026
==================================================

**Baseline:** `4a62758b499917bc94ed7dfebc0cb5c147caa807` (BingX 1d audit, parent `d5029df40d75fd2d6ba36ac55c4bfac95a8e254c`; **NO DB mutation, NO workers, NO Signal, NO SMC/math, NO 1d enable**). Narrow Option A implementation on exact `4a62758`, parent verified.

**Decision (from §39 audit):** BingX remains fully supported globally. Smart Money eligibility is the ONLY narrow 1d exclusion:
- `5m: BINANCE,BYBIT,GATE,KUCOIN,BINGX` (5)
- `15m: BINANCE,BYBIT,GATE,KUCOIN,BINGX` (5)
- `1h: BINANCE,BYBIT,GATE,KUCOIN,BINGX` (5)
- `4h: BINANCE,BYBIT,GATE,KUCOIN,BINGX` (5)
- `1d: BINANCE,BYBIT,GATE,KUCOIN` (4, **BINGX ineligible ONLY for Smart Money 1d multi-exchange aggregation**)

Reason: real Phase3E PostgreSQL data proves BingX 1d is **observed as 16:00 UTC** boundary while four others are canonical **00:00 UTC** (offGrid + horizonMismatch). What is **proven** is observed 16:00 UTC + our ingestion stores `row[0]` without shift; what remains **unproven without BingX docs/wire proof** is exact documented session contract (e.g., `UTC+8`). The eligibility policy requires only observed incompatibility, not docs claim. Audit wording corrected to label `UTC+8` as **hypothesis**, not proven.

**Semantics (eligibility vs alignment vs minExchanges — strictly separated):**
- **Eligibility** = which exchanges may participate for a given Smart Money timeframe (Strategy-layer policy, pure).
- **Alignment** = after eligibility filtering, EVERY remaining evaluated market must still pass generic `checkCandleAlignment` (canonical grid `openTime % tfMs===0` + exact identical latest CLOSED `candleTime`). No BINGX exception inside `lib/strategies/alignment.ts` — unfiltered 5-market 1d with BINGX 16:00 remains `safe=false`.
- **minExchanges** = separate: eligibility first → evaluate remaining → alignment safe → aggregate only if safe → `aggregateAssetGroup` retains normal `minExchanges` semantics. Never interpret “4 eligible and minExchanges=3” as permission for stale/misaligned.

**Implementation:**
- **New pure Strategy-layer policy:** `lib/strategies/smart-money-eligibility.ts` (no `lib/smc/*`, no Prisma, no adapter, no `alignment` internals)
  - `isSmartMoneyExchangeEligible(exchange: string, timeframe: string): boolean` — typed, fail-closed for unknown, deterministic, no `Date.now`, no DB.
  - `filterSmartMoneyEligibleResults(results: MarketStrategyResult[], timeframe): MarketStrategyResult[]` — pure, preserves order.
  - `ELIGIBLE_EXCHANGES_BY_TF` / `getEligibleExchanges(timeframe)` — explicit matrix.
  - Policy: `BINGX+1d=>false`, `BINGX+5m/15m/1h/4h=>true`, `BINANCE/BYBIT/GATE/KUCOIN` + all TF including 1d => true.
- **Call sites changed (exhaustive audit):** `checkCandleAlignment`/`canAggregateSafely`/`aggregateAssetGroup` for Smart Money found via grep in `lib/strategies/*`, `scripts/*`, `app/*` — only two production aggregation paths exist:
  - `scripts/smart-money-diagnostic.ts` — added import of eligibility, filter `eligibleResults = filterSmartMoneyEligibleResults(results, timeframe)` with eligibility log, then `checkCandleAlignment(eligibleResults, timeframe)` and `aggregateAssetGroup(..., eligibleResults, ...)`. Per-exchange evaluation logs still show all exchanges (including BINGX 1d) for visibility; only aggregation denominator excludes BINGX 1d.
  - `scripts/smart-money-readonly.ts` — same (added import, filter, log, then alignment/aggregate on filtered). Both modes (normal and `--diagnostic-canonical-config`) use eligibility before alignment.
  - `lib/strategies/smart-money.ts` — per-market evaluator only, no aggregation; no change needed (verified no `checkCandleAlignment` there).
  - `app/api/admin/strategies/[id]/route.ts` — no aggregation; no change (still rejects 1d). No other `app/` or `lib/` file aggregates Smart Money (verified via grep).
- **Generic alignment unchanged:** `lib/strategies/alignment.ts` has zero BINGX special-case; `isCanonicalAligned` / `checkCandleAlignment` / `canAggregateSafely` remain pure canonical.
- **Admin/API:** **Rollout: 1d now enabled.** `allowedVerified = ["5m","15m","1h","4h","1d"]` in `app/api/admin/strategies/[id]/route.ts` accepts any non-empty subset (including ["1d"], ["1h","1d"], all five) and rejects []/unknown before `prisma.strategy.update`. `components/admin/SmartMoneyStrategyEditor.tsx` now enables all five buttons (no `disabled` for 1d, no `if (tf==="1d") return` guard, last-TF protection `cur.length===1` still prevents []), shows verified checkmarks for all five (5m/15m/1h/4h across 5 exchanges, 1d via eligibility: BINGX excluded ONLY for 1d aggregation, 4 eligible BINANCE/BYBIT/GATE/KUCOIN, canonical UTC horizon) and warns `minExchanges=5 with 1d` cannot confirm. No `Strategy id=2` mutation (remains `DRAFT enabled=false timeframes=["1h"] minExchanges=3`).
- **No DB/candle/Signal changes:** no `prisma.strategy.update/signal`, no `prisma.candle` update/delete, no ingestion adapter change, no workers, no derived UTC daily, no `lib/signals`.

**Tests — new focused suite `scripts/test-smart-money-eligibility.ts` 81/81 (pure, no DB, deterministic):**
- **A matrix 17:** BINGX 5m/15m/1h/4h true, 1d false, other four 1d true, unknown fail-closed, `ELIGIBLE_EXCHANGES_BY_TF`, `getEligibleExchanges`, filter helpers.
- **B defense-in-depth:** unfiltered 4×00 + BINGX16 passed directly to generic `checkCandleAlignment("1d")` => `safe=false`, `offGrid`/`horizonMismatch` BINGX, not weakened.
- **C filtered 1d:** same input after filtering => exactly 4 (no BINGX), `safe=true` when four same T00, `shouldAggregate` true, `aggregateAssetGroup` with 4 => evaluated 4.
- **D stale eligible:** after BINGX filtering, make GATE one canonical day stale => `safe=false`, `horizonMismatch` GATE, aggregate NOT called.
- **E off-grid eligible:** after filtering, make GATE off-grid 01:00 => `safe=false`, `offGrid` GATE, NOT called.
- **F minExchanges independence:** 2 eligible/evaluable aligned with `minExchanges=3` => `NEUTRAL` (not fabricated LONG/SHORT), confirmation reflects 2.
- **G no fake NEUTRAL:** mixed `cannot-evaluate`/`filtered` remains `cannot-evaluate` + `skipped` counts, not converted to NEUTRAL votes.
- **H determinism:** same inputs => identical filtered/alignment/aggregate.
- **I invariants:** eligibility pure no `CandleData`/`candleTime`/`CLOSED`/`lookahead`/`prisma`/`signal`; `CLOSED-only` still enforced via `evaluateSmartMoneyWithCandles` (`closed=false => cannot-evaluate`).

**Regression (all green, strictly no || true):**
- `test-smart-money-eligibility` 81/81
- `test-smart-money-diagnostic` 95/95
- `test-smart-money` 62/62
- `test-smart-money-phase3c-fix` 40/40
- `test-smc-phase3d-config` 70/70, `phase3d-b` 55/55, `phase3d-c` 91/91, `phase3d-d` 126/126
- `test-smc-range` 50/50, `scoring` 63/63, `evaluate` 31/31, `admin-consistency` 84/84, etc.
- `npx tsc --noEmit` — no new errors in changed Strategy-layer files (sandbox baseline has known implicit-any/JSX stub errors unrelated to this commit; our pure policy file type-checks with `skipLibCheck`)
- `npm run build` — compilation succeeds (Next build fails only on missing stub prisma client in sandbox, same baseline)
- `git diff --check` clean (trailing whitespace fixed)
- `git merge-base --is-ancestor edf3732 HEAD` => 1 (NOT ancestor)

**Safety confirmed:** NO DB writes, NO workers, NO candle mutation, NO Strategy mutation, NO Signal, NO Signal Engine, 1d now enabled via rollout with eligibility (BINGX excluded ONLY for 1d), `canAggregateSafely` still mandatory after eligibility (exact alignment).

**Files changed (narrow):**
- `lib/strategies/smart-money-eligibility.ts` (new, pure)
- `scripts/smart-money-diagnostic.ts` (import + filter before alignment/aggregate)
- `scripts/smart-money-readonly.ts` (same)
- `scripts/test-smart-money-eligibility.ts` (new, 81 tests)
- `docs/bingx-1d-alignment-audit.md` (wording correction: `Proven (observed)` vs `hypothesis UTC+8`)
- `PROJECT_CONTEXT.md` (this §40; also audit wording remains hypothesis not proven)

**Deliverable:** ONE commit exact parent `4a62758`, push only `arena/01a08b68-svechnoy-suslik`, STOP after ONE implementation commit.

==================================================
40.1 BINGX 1D DIAGNOSTIC SUMMARY — FACTUAL FIX (OBSERVABILITY ONLY) 11.09.2026
==================================================

**Baseline exact:** `3c329893e186060914d8032cc415ec83ed0d96f2` (Option A eligibility, parent `4a62758`). This fix is **observability/test only** — NO eligibility/alignment/scoring/runtime/DB/Signal/math changes.

**Problem observed on real VPS BTC 1d after Option A:**
- Per-exchange (PostgreSQL CLOSED):
  - BINANCE  2026-09-09T00:00:00Z evaluable
  - BINGX    2026-09-08T16:00:00Z evaluable, OFF_GRID (BINGX 16:00 UTC vs canonical 00:00)
  - BYBIT    2026-09-09T00:00:00Z evaluable
  - GATE     2026-09-09T00:00:00Z evaluable
  - KUCOIN   2026-09-09T00:00:00Z evaluable
- Policy correctly printed: `eligibility: excluded BINGX for 1d ... 4/5 eligible`
- Filtered alignment correctly printed: `reference 2026-09-09T00:00:00Z`, BINANCE/BYBIT/GATE/KUCOIN GRID_OK HORIZON_OK, `ALIGNED 4/4 safe`
- Aggregation correctly executed on 4: `NEUTRAL`, `evaluated 4`, `minExchanges 3`, `Signal 0 -> 0`
- **BUT final summary incorrectly printed:** `Вывод Phase3E 1d: safe — all 5 at same UTC midnight.` — factually false after Option A (BINGX NOT at UTC midnight and was intentionally excluded; only 4 eligible aligned).

**Fix:**
- `scripts/smart-money-diagnostic.ts` final 1d summary now derives from runtime state, never claims all 5:
  - `if (alignment.safe)`: `Вывод Phase3E 1d: safe после eligibility-фильтра — ${alignedCount}/${totalEvaluated} eligible рынков aligned на одном canonical UTC horizon ${referenceCandleTime}; BINGX исключён из Smart Money 1d aggregation policy (${eligible}/${total} eligible, excluded: BINGX).`
  - `else`: `misaligned после eligibility-фильтра — ${alignedCount}/${totalEvaluated} eligible aligned (offGrid ${}, horizonMismatch ${}); BINGX исключён из Smart Money 1d aggregation policy (${eligible}/${total} eligible). 1d пока НЕЛЬЗЯ разблокировать ...`
  - Uses `eligibleResults`, `alignment.totalEvaluated / alignedCount / referenceCandleTime`, `excluded` list — no hardcoded `4/4`, no `all 5`.
  - `5m/15m/1h/4h` generic summary unchanged (`safe (grid OK + same horizon, badStep 0)` / `MISALIGNED ...`).
- `scripts/smart-money-readonly.ts` audited: no stale `all 5 at same UTC midnight` phrase found; generic `ALIGNED ${alignedCount}/${totalEvaluated} safe — можно агрегировать` remains correct and already derived; no change needed (audit confirmed).

**Preserved:**
- `lib/strategies/smart-money-eligibility.ts` policy unchanged (BINGX 1d ineligible only)
- `lib/strategies/alignment.ts` unchanged (generic canonical grid + horizon)
- `aggregateAssetGroup` / `lib/smc/*` / scoring / RANGE_POSITION math unchanged — observed RANGE_POSITION on four eligible 1d markets `pos ≈ 2.236..2.242` still awards `SHORT +10` (outsideRange true, scored via zone, no clamp — CURRENT SEMANTICS CLOSED/UNDERSTOOD, lifecycle hypothesis → Backtest/OOS, see §33/34).

**Real VPS BTC 1d Option A verification (factual, minimal):**
- 5 per-exchange evaluable (as above, BINGX OFF_GRID)
- BINGX excluded for aggregation per policy
- Remaining 4/4 exact 00:00 UTC aligned (`reference 2026-09-09T00:00:00Z`, `GRID_OK HORIZON_OK`, `safe=true`)
- Aggregation allowed on 4 (`evaluated 4`, `skipped 0`, `canAggregateSafely true`)
- `minExchanges=3` respected
- Result at test time `NEUTRAL` (no side reached 3; e.g., `0/4` LONG/SHORT or similar, depending on scores — observed `NEUTRAL` `0/4`)
- `Signal 0 -> 0` (DIAGNOSTIC ONLY, no writes)
- `Strategy id=2` remained `DRAFT enabled=false timeframes=["1h"] minExchanges=3` (no DB mutation)
- `1d` now enabled in Admin/API via rollout (`allowedVerified [5m,15m,1h,4h,1d]` with eligibility 4 eligible, BINGX excluded ONLY for 1d, tooltip 16:00 UTC vs canonical UTC horizon), `Strategy id=2` remains `DRAFT enabled=false timeframes=["1h"] minExchanges=3` until explicit operator approval (no DB mutation)
- RANGE_POSITION evidence preserved: eligible 1d `pos ≈ 2.236..2.242` → `SHORT +10` via `PREMIUM` zone, separate from eligibility.

**Tests — regression added to `scripts/test-smart-money-eligibility.ts` (81→96, new §J 15 checks):**
- J1 safe mentions `после eligibility-фильтра` + `eligible рынков aligned`
- J2/J3 must NOT contain `all 5 at same UTC midnight` / `safe — all 5`
- J4/J5 BINGX exclusion explicit (`BINGX исключён`, `Smart Money 1d aggregation policy`)
- J6 derives counts (`alignment.alignedCount`, `alignment.totalEvaluated`, `eligibleResults.length`)
- J7/J8 misaligned after eligibility shows `offGrid`/`horizonMismatch` + BINGX policy, not all 5
- J9/J10 5m/15m/4h wording unchanged
- J11/J12 generic `MULTI-EXCHANGE AGGREGATION REFUSED` / `cannot-aggregate` still present
- J13-J15 readonly audited: no stale all-5, generic ALIGNED still present

**Verification:** `test-smart-money-eligibility.ts` 96/96, `test-smart-money-diagnostic.ts` 95/95, `test-smart-money.ts` 62/62, `tsc --noEmit` no new errors, `git diff --check` clean, `git merge-base --is-ancestor edf3732 HEAD` → 1 (NOT ancestor), NO runtime math/eligibility/alignment/DB/Signal changes.

**Files changed (observability only):**
- `scripts/smart-money-diagnostic.ts` (final 1d summary wording)
- `scripts/test-smart-money-eligibility.ts` (added §J 15 checks, 81→96)
- `PROJECT_CONTEXT.md` (this §40.1)

**Deliverable:** ONE commit exact parent `3c329893e186060914d8032cc415ec83ed0d96f2`, push only `arena/01a08b68-svechnoy-suslik`, STOP after one commit.

==================================================
41. OHLCV CONTINUOUS INGESTION — PRODUCTION OPERATIONAL GAP CLOSURE (BTC PILOT) 11.09.2026
==================================================

**Baseline exact:** `a4d8de184c790a0bd172a09c1ff9d43ee39ab2fd` (origin/arena/01a08b68-svechnoy-suslik, branch `arena/01a08b68-svechnoy-suslik`), working tree clean before gap closure.

**Task:** Закрыть operational gap для continuous OHLCV ingestion до включения Smart Money Strategy. VPS — только Next.js в PM2, OHLCV worker есть (`scripts/ohlcv-worker.ts` concurrency=1, retry/backoff, idempotent upsert market+timeframe+openTime, --plan/--once/--top/--timeframes, large-run guard, SIGINT/SIGTERM graceful), interval только env `OHLCV_INTERVAL_MS` default 60m — недостаточно для 5m, pilot `--top=1 --timeframes=5m,15m,1h,4h,1d --limit=300 --once` дал BTC rank1 5 рынков 25 задач 0 ошибок, Smart Money CLOSED-only 5/5 5m/15m/1h/4h и 4/4 1d после BINGX exclusion, Strategy id=2 DRAFT/enabled=false Signal 0. Требуется: CLI --interval, cadence safety, BTC pilot --symbol, single-instance PM2, без Signal/schema/Strategy enable.

**Scope (9 требований):**

1) **CLI --interval=N ms** — strict integer bounded, CLI precedence > env, fail-closed unknown, --help документы, --plan показывает effective interval read-only, env backward compat сохранён.
2) **Cadence safety pure guard** — continuous с 5m и interval=60m не production-safe (fail-closed), --once bypass, conservative ≤5m (300000ms) с учётом runtime + CLOSED semantics, no candle timestamp/resample change.
3) **BTC pilot --symbol=BTC** — exact enabled Asset symbol + market filters (enabled/STATUS ACTIVE/quote USDT/SPOT), preserve --top без symbol, forbid/define ambiguous --symbol+--top, --plan показывает symbol/assets/markets/tasks, no hardcode DB id, не полагаться на silent --top=1=BTC.
4) **Single-instance** — advisory lock без Redis/schema migration, PostgreSQL `pg_try_advisory_lock(727923)` careful+tested, no migrations only for lock.
5) **PM2 artifact** version-controlled `ecosystem.config.js` для BTC pilot: BTC only, 5m,15m,1h,4h,1d, limit300, sequential 250ms, continuous, cadence suitable for 5m (120000 2m), process name `svechnoy-suslik-ohlcv-btc`, env inheritance no secrets, no hardcode DATABASE_URL.
6) **Failure behavior** — stats/log visible, no Signal, no Strategy enable, graceful shutdown, no destructive DB.
7) **Tests extend** — interval, help, unknown, plan, symbol BTC plan, missing/unknown/disabled fail-closed, ambiguity, cadence guard unsafe+once bypass, single-instance guard, PM2 exact BTC scope, no Signal imports.
8) **PROJECT_CONTEXT update** — operational model, exact BTC pilot command, cadence, PM2 name, start/stop/restart/status/log, rollback, emphasize worker start ≠ enable Smart Money.
9) **Don'ts** — не менять package majors, npm audit fix --force, db push/reset, schema, Smart Money algorithm, Strategy row, Signal, real worker в Arena, enable PM2.

**Implementation:**

- `lib/ohlcv/cli.ts`:
  - `KNOWN_OHLCV_FLAGS` + `"symbol","interval"`, `validateKnownFlags` hint обновлён.
  - `MAX_INTERVAL_FOR_5M_MS = 300000`, `validateCadence(options)` pure/testable: если `!once && timeframes includes 5m && intervalMs > 300000` → error string с conservative recommendation 120000/60000 и CLOSED semantics.
  - `resolveOhlcvInvocation` — `--help` priority, unknown → error, `parseOhlcvArgs` → cadence guard (only for run, не для --plan, once exempt) → plan/run. Env `OHLCV_INTERVAL_MS` fallback 3600000, CLI `--interval` имеет приоритет (`get("interval") ?? env...`), валидация `parseCliNumber` min1000 max86400000 integer, unknown fail-closed.
  - `parseOhlcvArgs` — `--symbol` парсит `trim().toUpperCase()`, regex `^[A-Z0-9]{1,20}$`, nonempty, если `get("top")` одновременно → throw `несовместимы`, CLI `intervalRaw = get("interval") ?? env.OHLCV_INTERVAL_MS`.
  - `buildOhlcvHelp` — документирует --symbol/--interval/--once, примеры BTC pilot, cadence note `interval ≤5m (300000) иначе fail closed; --once exempt; BTC pilot 120000/60000`, BTC pilot note `exact Asset symbol, без hardcode DB id; --plan показывает symbol/assets/markets/tasks`.

- `lib/ohlcv/sync.ts`:
  - `OhlcvWorkerOptions { symbol?: string }`, `DEFAULT_OHLCV_OPTIONS.symbol=undefined`.
  - `runOhlcvSync` — если `options.symbol` → `prisma.asset.findFirst({where:{symbol: options.symbol, enabled:true}, include:{markets:{where:{enabled:true,status:"ACTIVE",quote:"USDT",marketType:"SPOT"}}}})` → `assets = single?[single]:[]`, иначе старый Top-N `rank lte top`. Типы asset сохранены, where market filters идентичны.

- `lib/ohlcv/plan.ts`:
  - `collectPlanStats` — если `options.symbol` → `findFirst` symbol enabled, else `findMany` rank. `assetIds` → `market.findMany({assetId:{in:assetIds}, enabled:true,status:"ACTIVE",quote:"USDT",marketType:"SPOT"})`, tasks = markets×timeframes.
  - `formatPlanReport(options: Pick<OhlcvWorkerOptions,...>&{symbol?,intervalMs?})` — если `options.symbol` → `Symbol: BTC`, else `Top-N: N`; `Таймфреймы`, `limit`, `delay`, если `intervalMs!==undefined` → `Интервал continuous (interval): ${intervalMs}мс`; далее assets/markets/tasks/maxCandles/apiRequests/byExchange.
  - `buildConfirmCommand(options:{top,timeframes,limit,requestDelayMs,once,symbol?,intervalMs?})` — если `symbol` → `--symbol=BTC` splice at 1, else `--top=`, если `intervalMs` → ` --interval=...`, then `--once`.

- `lib/ohlcv/lock.ts` (new, no migration, FIX d0fd572→ dedicated session):
  - `OHLCV_ADVISORY_LOCK_KEY = 727923`, dedicated `pg.Client` session-level lock: `acquireDedicatedLock(key)` reads `process.env.DATABASE_URL` (fail-closed if absent, never logs value; no dotenv/filesystem coupling in library — env bootstrap is worker entrypoint `import "dotenv/config"`), `new pg.Client({connectionString})`, `await client.connect()`, `SELECT pg_try_advisory_lock($1)` on same physical connection, holds for entire worker lifetime, `releaseDedicatedLock(handle)` does `SELECT pg_advisory_unlock($1)` on same client then `client.end()`; disconnect/crash auto-releases. Legacy `tryAcquireOhlcvLock(prisma)` kept for mocks, not used for singleton.

- `scripts/ohlcv-worker.ts` (FIX same-session):
  - `import "dotenv/config"` + `import { acquireDedicatedLock, releaseDedicatedLock, OHLCV_ADVISORY_LOCK_KEY, type OhlcvDedicatedLockHandle } from "../lib/ohlcv/lock"`.
  - `printVerification(prisma, options:{top,symbol?,timeframes})` — логирует `Symbol запрошен: BTC` или `Top запрошен`, loop `for (timeframe of options.timeframes)`.
  - `main` — `let lockHandle: OhlcvDedicatedLockHandle|null=null; let prisma: PrismaClient|null=null; try { if (run) { lockHandle=await acquireDedicatedLock(); if (!lockHandle) fail-closed exit 1; log dedicated session acquired } ; const {PrismaClient}=await import("@prisma/client"); prisma=new PrismaClient(); collectPlanStats ...` . `--plan`/`--help` do NOT acquire (read-only SELECT only, verified). `finally` if `lockHandle` → `await releaseDedicatedLock(lockHandle)` on same session then `prisma.$disconnect()`. `--once` also uses same singleton guard. No credentials printed.

- `ecosystem.config.js` (new, version-controlled, FIX PM2/ENV lifecycle):
  ```js
  apps: [
    { name:"svechnoy-suslik", script:"npm", args:"start", cwd:"/root/svechnoy-suslik", ... },
    { name:"svechnoy-suslik-ohlcv-btc",
      script:"npx",
      args:"tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000",
      cwd:"/root/svechnoy-suslik", interpreter:"none", instances:1, exec_mode:"fork",
      autorestart:true, watch:false, restart_delay:5000, max_memory_restart:"300M",
      env:{NODE_ENV:"production"} // DATABASE_URL NOT hardcoded; worker loads .env via dotenv (see lock.ts/worker), cwd ensures /root/svechnoy-suslik/.env found
    }
  ]
  ```
  Header documents: BTC-only 5×5=25 tasks, sequential 250ms, interval 120000 conservative ≤5m, dedicated pg.Client lock 727923 same-session, `cwd "/root/svechnoy-suslik"` (absolute, not "./") for unambiguous .env loading, `dotenv` direct dependency (not shell --update-env), `--update-env` only for refreshing PM2 env from shell, NOT for secret loading, `--only svechnoy-suslik-ohlcv-btc` does NOT start/override Next.js, no secrets, rollback `pm2 stop/delete`.

**Operational model (VPS):**

- **Exact BTC pilot command (continuous):**
  `npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000`
- **One-shot verification (bypass cadence guard):**
  `npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --once`
- **Read-only plan (no exchange API, no DB write):**
  `npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --plan`
  Expected plan: `Symbol: BTC`, `Активов выбрано: 1`, `Рынков (активные SPOT USDT): 5`, `Задач: 25`, `Интервал continuous (interval): 120000мс`, `Максимум свечей: 7 500`, `API-запросов ≈25`, `По биржам: BINANCE 1 ...`.

- **Cadence:** `interval 120000ms = 2m` (conservative, ≤5m bound 300000, accounts for sequential pass runtime ~10-20s: 25 tasks × 250ms delay + API retry ~5-10s, ensures CLOSED 5m candle not missed). Default `60m (3600000)` is NOT production-safe for 5m continuous → guard `Cadence unsafe: interval 3600000ms > 300000ms ... Use --interval <=300000 or --once` fail-closed. `validateCadence` pure: `!once && includes 5m && interval>300000` → error, `--once` exempt, `--plan` exempt.

- **PM2 process name:** `svechnoy-suslik-ohlcv-btc` (fork, single-instance, dedicated session lock).

- **PM2 lifecycle (VPS, manual, NOT in Arena, cwd absolute):**
  ```bash
  cd /root/svechnoy-suslik
  pm2 start ecosystem.config.js --only svechnoy-suslik-ohlcv-btc
  pm2 status
  pm2 logs svechnoy-suslik-ohlcv-btc
  pm2 restart svechnoy-suslik-ohlcv-btc
  pm2 stop svechnoy-suslik-ohlcv-btc
  pm2 delete svechnoy-suslik-ohlcv-btc
  pm2 status # only svechnoy-suslik remains (Next.js) — --only prevents accidental start/override of web
  # Full deployment (both) only when intentionally starting web+worker: pm2 start ecosystem.config.js
  ```
  `cwd "/root/svechnoy-suslik"` + `dotenv` ensures worker and pg.Client load `/root/svechnoy-suslik/.env` (PrismaClient and pg both read `process.env.DATABASE_URL` after dotenv). `--update-env` NOT used for secret loading — it only refreshes PM2 env from shell; secrets come from .env via dotenv, not shell export.

- **Rollback:** `pm2 stop/delete svechnoy-suslik-ohlcv-btc`; DB rollback not needed — worker idempotent `upsert` (`marketId+timeframe+openTime`), no `deleteMany`, no `prisma.candle.delete`, no Signal writes, no Strategy mutation. Verify `pm2 status` shows only Next.js, `psql` candle count unchanged after stop, `project` рабочая.

- **Worker start ≠ enable Smart Money:** Запуск `svechnoy-suslik-ohlcv-btc` только пополняет свечи; Strategy `id=2` остаётся `DRAFT enabled=false status DRAFT timeframes=["5m","15m","1h","4h","1d"] minExchanges=3 slug=smart-money-suslik Signal 0` (текущий production state, независимо проверен, timeframes уже транзакционно обновлены пользователем; см. `prisma.strategy.findUnique where id:2`). Включение Strategy — отдельный ручной шаг после pilot verification (см. §36-41) и `/admin` approval, не происходит автоматически. Исторические записи §36-40 где `["1h"]` корректны на момент тех фаз, но current-state в этом §41 — `["5m","15m","1h","4h","1d"]`.

**Safety decisions (FIX):**

- `--symbol=BTC` over `--top=1` / hardcode DB id: explicit enabled Asset symbol selection, combined with market filters, fail-closed if missing/disabled, tested `collectPlanStats` BTC 1/5/25 vs Top-1 ambiguity.
- `interval 120000` over default 3600000: conservative 2m within 5m bound, documented runtime-aware, guard fail-closed for 5m+60m continuous, pure/testable, --once bypass for one-shot.
- Dedicated `pg.Client` advisory lock `727923` over Prisma pool / Redis: same physical session acquire & release, held for entire worker lifetime, `client.end()` auto-releases on crash/disconnect, fail-closed second worker, no schema migration, no lock table, tested via dedicated session vs Prisma pool bug, no Redis/CREATE TABLE.
- `ecosystem.config.js` cwd `"/root/svechnoy-suslik"` + `dotenv` over `cwd "./"` + shell `--update-env`: unambiguous .env loading via direct `dotenv@16.6.1` (not transitive `c12`), `pg` direct `^8.11.3`, no secrets in git, `--only` prevents accidental web override, documents rollback and verification.

**Failure behavior:**

- Exchange/API error → `stats.errors++` per timeframe/exchange, `byTimeframe` `ошибок=`, `byExchange` `ошибок=`, console.error `✗ exchange symbol timeframe: message`, process does NOT create Signal, does NOT enable Strategy, continues next market/timeframe, graceful `sleep(delay)`, `waitInterruptible(interval)` respects SIGINT/SIGTERM.
- Lock held → `Single-instance guard: OHLCV worker already running (advisory lock 727923 held) ... refusing to start overlapping` exit 1.
- Symbol not found/disabled → `Ошибка: актив с символом "BTC" не найден или disabled ...` exit 1 before `runOhlcvSync` (tested via `collectPlanStats` 0 assets).
- Large run guard still `<500` tasks: BTC pilot 25 tasks allowed, Top-500×5 2357 requires `--confirm-large-run`.
- No destructive DB: `upsertCandles` chunk 50 `prisma.$transaction` upsert, `market.lastSyncAt` only update, no deletes.

**Tests (FIX: dedicated session + --plan guard):**

- `scripts/test-ohlcv-pilot.ts` **127/127** (pure + mock Prisma, still passes after FIX):
  - interval default/env/CLI precedence/bounds/non-integer, help contains interval/symbol, unknown flags fail-closed, plan shows effective interval, cadence guard unsafe 5m+60m rejected + --once bypass + 5m 120000 ok + plan bypass + 1h ok, symbol BTC run case-insensitive symbol+top ambiguity forbidden empty/invalid symbol, collectPlanStats BTC 1/5/25 + plan report Symbol/interval, missing/unknown/disabled 0 assets fail-closed, Top-1 ambiguity, single-instance lock key 727923 pg_try_advisory_lock/unlock no Redis/migration worker lock order finally, PM2 artifact exact BTC scope interval ≤5m 120000 no hardcode DB no 60m, no Signal imports, stats/log, graceful, no deleteMany, upsert key, buildConfirmCommand symbol, schema unchanged, worker plan title before sync import.
- `scripts/test-ohlcv-cli.ts` **105/105** (existing + new interval/cadence): defaults, env, CLI precedence, timeframe list, limits, unknown flags, --plan, large-run guard, worker source guard order, preflightTitle.
- `scripts/test-ohlcv-lock.ts` **new FIX** (pure/static + integration):
  - **Pure/static (sandbox, no DB, always passes):** lock key 727923, `acquireDedicatedLock`/`releaseDedicatedLock` same-session via `pg.Client`, `SELECT pg_try_advisory_lock`/`pg_advisory_unlock` on same client, **no** `dotenv`/`/root/` in lock (library has no filesystem coupling, `process.env.DATABASE_URL` only, fail-closed), worker has deterministic `import "dotenv/config"` before DB use, `--plan` never acquires, legacy Prisma kept, `pg`/`dotenv` direct deps, no Redis/migration, schema unchanged, ecosystem `cwd` production allowed but library has no absolute path.
  - **Integration (VPS review DB, requires DATABASE_URL, not faked in sandbox):** same dedicated session acquires/releases, competing session cannot acquire while first holds (second `pg_try_advisory_lock` returns false fail-closed), after owner `client.end()` second can acquire, `--plan` run with same DB shows 0 lock held, `prisma` pool cannot guarantee same session (documented bug). Tests are separated; sandbox run reports `INTEGRATION SKIPPED (no DATABASE_URL/DB)` without false pass.
- `npx tsc --noEmit --skipLibCheck` 0 new errors in `lib/ohlcv/*` (baseline JSX/process stub unchanged, `pg`/`dotenv` types available via direct deps).
- `npm run build` compiles (sandbox baseline next build ok, `pg`/`dotenv` not major upgrade).

**Verification (Arena, read-only, no PM2 start, no Strategy enable, FIX):**
- `npx tsx scripts/test-ohlcv-cli.ts` 105/105, `npx tsx scripts/test-ohlcv-pilot.ts` 131/131, `npx tsx scripts/test-ohlcv-lock.ts` pure 56/56 + integration SKIPPED (no DATABASE_URL/DB, not faked), `grep -R "prisma.signal" lib/ohlcv scripts/ohlcv-worker.ts` 0, `grep -R "DATABASE_URL.*postgres" ecosystem.config.js` 0, `cat prisma/schema.prisma | grep -E "model (Asset|Market|Candle|Signal|Strategy)"` unchanged, `grep -R "/root/svechnoy-suslik/.env" lib/ohlcv scripts/ohlcv-worker.ts` 0 (no absolute production path in library/worker), `grep "import \"dotenv/config\"" scripts/ohlcv-worker.ts` 1 (deterministic bootstrap), `grep -R "dotenv" lib/ohlcv/lock.ts` 0 (library has no dotenv coupling, only worker), `git diff --name-only` shows lock + tests + PROJECT_CONTEXT (no new package deps for this minimal FIX), build ok, `git diff --check` clean.

**Files changed (gap closure + FIX d0fd572 + minimal FIX d20addf):**
- `package.json` + `package-lock.json` (add `pg@^8.11.3`, `dotenv@^16.6.1`, `@types/pg@^8.10.9` — done in d20addf, **no new deps in this minimal FIX**)
- `lib/ohlcv/cli.ts` (interval+symbol+cadence, unchanged in minimal FIX)
- `lib/ohlcv/plan.ts` (symbol+interval, unchanged)
- `lib/ohlcv/sync.ts` (symbol, unchanged)
- `lib/ohlcv/lock.ts` (**minimal FIX**: removed absolute `/root/.../.env` fallback and silent `require("dotenv")`; library now only reads `process.env.DATABASE_URL`, fail-closed, never logs; env bootstrap is worker entrypoint)
- `scripts/ohlcv-worker.ts` (**minimal FIX**: kept deterministic `import "dotenv/config"` at top, no absolute fallback; lock via dedicated session unchanged)
- `ecosystem.config.js` (production `cwd "/root/svechnoy-suslik"` remains allowed for version-controlled VPS artifact; library/worker have no absolute path — review `/root/svechnoy-suslik-review` uses its own `.env` symlink via cwd)
- `scripts/test-ohlcv-pilot.ts` (131/131, unchanged)
- `scripts/test-ohlcv-lock.ts` (**minimal FIX**: added asserts no absolute path in lib/ohlcv/worker, worker dotenv before DB, lock fails closed without logging, pure 56/56)
- `PROJECT_CONTEXT.md` (this §41 FIX + minimal FIX: correct timeframes and remove library absolute path coupling docs)

**Deliverable (FIX):** ONE additional commit atop `d0fd5725d4e752e58b1cac73b8ea8fb025c559e5` (not amend), push only `arena/01a08b68-svechnoy-suslik`, STOP after FIX (PM2 not auto-started, Strategy id=2 remains `DRAFT enabled=false timeframes=["5m","15m","1h","4h","1d"]` `Signal 0`, Signal Engine not implemented, no DB mutation).

==================================================
42. SMART MONEY READ — TRANSIENT INGESTION RACE FIX (COMMON CLOSED HORIZON) + REVIEW FIX 11.09.2026
==================================================

**Хронология и точные baseline (проверено `git merge-base --is-ancestor`/compare, не «на глаз»):**
- `83613d0d7393fc3e0934113e77a79c73c4424463` — `main` = production на 11.09.2026 10:22 UTC.
- `ec73320723327f68a64be435b87aff0e5701f110` — КАНДИДАТ FIX (read-side latest COMMON CLOSED horizon) = ровно `main + 1` (compare: ahead 0 / behind 1).
- Родитель ЭТОГО коммит — ровно `ec7332072…`: один reviewable FIX поверх кандидата, без amend и без ребейза/rewrite. Ветка `arena/01a09002-svechnoy-suslik`, push только в неё; `main` не тронут.
- `edf3732da81…` (Signal Engine dry-run) по-прежнему НЕ является предком `main` — это roadmap P5, в Phase 3 не входит и в этот коммит не входит.

**Production-наблюдение (факт, не mock):** BTC-ворк `svechnoy-suslik-ohlcv-btc`, последовательная ingest 25 задач/проход ≈ 15–16 s (5m/15m/1h/4h/1d, interval 120000). Параллельное Smart Money-чтение внутри прохода ловило транзиентный 5m `MISALIGNED`: `BINANCE 09:45` против четырёх `09:50` (UTC, canonical grid, CLOSED) → `checkCandleAlignment.horizonMismatch` → `cannot-aggregate`; через ~35 s (проход завершён) те же BTC 5m давали `ALIGNED 5/5` на `09:50`. Это гонка видимости (последовательная запись + конкурентное чтение), а не баг границ биржи.

**Ревью кандидата → вердикт NEEDS FIX (выводы по коду и провесам, не по тексту коммита):**
- **HIGH-1 (устранено этим FIX):** кандидат исключал из «участников» общего горизонта ЛЮБОЙ рынок, не давший оценки, — и отфильтрованный Strategy-фильтром, и рынок без CLOSED-данных, и рынок без общего бара. Следствия: «4 здоровых + 1 вне вселенной» превращалось в `usable=false` (вето там, где фильтр не должен влиять), а «4 здоровых + 1 без данных» не имело различимого исхода. Провес: old `evaluated 4, safe=true` vs кандидат `usable=false`.
- **HIGH-2 (устранено этим FIX):** не было абсолютной привязки к wall-clock: `lagBars = newestHorizon − commonHorizon` считался по самим участникам ⇒ если все участники устарели ОДИНАКОВО, лаг = 0 и агрегат «светился здоровым» на данных 3-суточной давности (провес V5: `lagBars=0, usable=true`); для 1d связка «3 бара» означала 3 суток (провес V6).
- **Гигиена (устранено):** `git diff --check` был грязный (пустые строки на EOF двух файлов); `scripts/test-common-horizon.ts` содержал ветку `if (evaluated.length > 0) { real } else { mock }`, `ok(true, placeholder…)` и «vacuous»-проверки, которые проходили и при пустом reads-результате; §42 описывал «9 mandatory cases, 46/46», что код не доказывал.

**ТРИ МНОЖЕСТВА — контракт участия (ключевое семантическое решение FIX):**
- (A) **exchange eligibility** — `isSmartMoneyExchangeEligible(exchange, tf)` (Option A без изменений: 5m/15m/1h/4h = 5 бирж, 1d = 4; BINGX исключён для 1d).
- (B) **Strategy filters** — `applySmartMoneyFilters` (вселенная Top-100 / минимальный quoteVolume24h). Логика НЕ дублируется в слое горизонта — она переиспользуется, отсюда и `filtered`-строки в результатах.
- (C) **data availability** — есть ли у рынка canonical CLOSED-свеча вообще и конкретный общий бар в частности (+ достаточно истории после усечения).
- `participants (множество, по которому выбирается H) = A ∧ ¬B`.
- Рынок из B (отфильтрованный) НЕ двигает и НЕ блокирует H, но сохраняется в `results` со статусом `filtered` и остаётся видимым в отчётности.
- Участник из `A ∧ ¬B` без CLOSED-данных / без общего бара / с историей < `minimumSwingHistoryCandles=84` / устаревший за bound НЕ «выбрасывается молча, чтобы добрать `minExchanges`»: вместо этого явный отказ asset×TF с различимой причиной.
- **Denominator семантика `aggregateAssetGroup` сохранена как в pre-common-horizon runtime:** `evaluated` = число реальных оценок, `skipped` = `filtered` + `cannot-evaluate`; `confirmation` = `votes/evaluated`. То есть исправление не «улучшает» и не портит статистику покрытия — оно меняет только ТОЧКУ СБОРА данных.

**Формула ожидаемого latest CLOSED (анти-HIGH-2):**
- `expectedLatestClosedOpenTime(now, tf) = floor(now / D) * D − D`, `D = SMCTIMEFRAME_MS[tf]`, каноническая UTC-сетка (5m/15m/1h/4h/1d), `now` — ЯВНЫЙ параметр (в чистом SMC-слое `Date.now()` нет вообще; скрипт читает wall clock ОДИН раз на прогон: `const runNow = new Date()`).
- Граница обоснована семантикой ingestion: свеча, открытая в `k*D`, закрыта в `(k+1)*D`, адаптеры ставят `closed = closeTime < now` при `closeTime = openTime + D − 1`, т.е. ровно `openTime + D <= now`. Значит в момент `now = k*D` бар `(k−1)*D` УЖЕ закрыт (граница относится к закрывшемуся бару), а бар `k*D` ещё открыт → ожидаем `floor(now/D)*D − D`. Специально НЕ основано на nullable `closeTime` биржи.
- `absoluteLagBars = (expectedLatestClosed − commonHorizon) / D` — целое, т.к. оба значения на сетке.
- **Политика (консервативная, в коде, НЕ в Strategy Admin и не торговый параметр):** `COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS = {5m:1, 15m:1, 1h:1, 4h:1, 1d:1}` — максимум ОДИН закрытый бар позади ожидаемого для всех TF. Относительная защита от перекоса между биржами сохранена без ослабления: `COMMON_HORIZON_RELATIVE_MAX_LAG_BARS = 3` (`newestHorizon − commonHorizon`, граница включительна).
- Порядок проверок после вычисления `H = max(пересечение)`: `relative_lag_stale` → `future_horizon` (`H` новее ожидаемого latest CLOSED — признак недобросовестных CLOSED-флагов) → `absolute_stale`.

**Статусы (все различимы оператором; `usable === (status === "ok")`):**
`ok` · `no_participants` (после A и B никого не осталось) · `data_unavailable` (участник A∧¬B без единой canonical CLOSED свечи — проверяется ДО пересечения, чтобы отсутствующие данные не маскировались) · `no_common_horizon` (пересечение пусто) · `relative_lag_stale` · `future_horizon` · `absolute_stale`.
Отбракованный горизонт ПРИ ЭТОМ сохраняется в `selection.commonHorizon` (и в `perMarketLatest[].hasCommon`), чтобы отчёт показывал «какой бар отбракован», а не «горизонта нет».

**Реализация (чисто, без БД/сети в слое горизонта):**
- **`lib/strategies/common-horizon.ts` (pure):** `expectedLatestClosedOpenTime`, `selectCommonClosedHorizon(markets, tf, {now, relativeMaxLagBars?, absoluteMaxLagBars?})` (реальное пересечение множеств CLOSED+canonical timestamps, НЕ `min(latest)`), `truncateCandlesToHorizon` (только `closed === true` и `openTime <= H`; бар на самой границе с `closed=false` отсекается), `assertEvaluatedAtHorizon`, `decideAggregationAtCommonHorizon`, `formatCommonHorizonReport`. Никаких `prisma`/`fetch`/`Date.now()`.
- **`lib/strategies/smart-money.ts`:** `evaluateMarketsAtCommonHorizon(markets, tf, smcConfig, filters, now) → { selection, results, usable, status, participantCount, filteredCount }`. Partition: переиспользует `applySmartMoneyFilters`; `results` возвращаются В ПОРЯДКЕ ВХОДА (позиционный `slot[]`), поэтому сопоставление с рынком и `skipped`-статистика не зависят от порядка. При `!usable` → `results = []` (строже дофиксного поведения на purpose «нет данных», задокументировано ниже). При `usable` каждый участник оценивается на `truncateCandlesToHorizon(candles, H)`; нехватка истории остаётся `cannot-evaluate` (агрегация на остальных продолжается — как в существующем runtime). Плюс per-market anchor-страховка: если `evaluated.candleTime !== H`, результат понижается до `cannot-evaluate` с текстом `invariant: candleTime … ≠ общий горизонт …`.
- **Единые runtime-ворота `decideAggregationAtCommonHorizon`:** разрешает агрегацию только при `selection.status === "ok"` ∧ `assertEvaluatedAtHorizon` без аномалий ∧ `canAggregateSafely(checkCandleAlignment(results, tf))`. `lib/strategies/alignment.ts` НЕ изменён: строгие ворота (canonical grid + один и тот же candleTime) обязательны и после перехода на общий горизонт, а не заменены им. Якорная проверка не дублирует alignment: при ОДНОМ evaluated рынке `checkCandleAlignment` тривиально `safe` (одно множество горизонтов) и только якорь ловит чужой `candleTime` — закреплено тестом.
- **`scripts/smart-money-readonly.ts` / `scripts/smart-money-diagnostic.ts`:** один `runNow = new Date()` на прогон → pure-слой; A (eligibility) → горизонт только по участникам; печать `formatCommonHorizonReport`; `alignment = gate.alignment`, `!gate.allowed` → `MULTI-EXCHANGE AGGREGATION REFUSED` с полным списком `refusalReasons` и `aggregateAssetGroup` НЕ вызывается; в нормальном символьном режиме возвращена по-рыночная объяснимость (`причины (N)` + `[LONG/SHORT/—] w=… label value`); сводки 1d больше не врут про «0/5 eligible», когда eligible = 4, а H непригоден; BINGX показан как исключение eligibility-политикой, а не как «нет данных».
- **`formatCommonHorizonReport`** печатает: `обменное eligibility: X/Y eligible, исключено eligibility-политикой: …`; `Strategy filters: filtered N — не влияет на выбор горизонта`; `участники common horizon: N[, без CLOSED данных: …]`; `ожидаемый latest CLOSED (wall clock …): …`; на каждого участника `latest CLOSED=… has-common|MISSING-COMMON`; затем `✓ common horizon … (relative lag a/A бар, absolute lag b/B бар …)` либо `✗ common horizon недоступен [STATUS] (вычисленный общий бар … отбракован): <точная причина>`.

**Детерминированные тестовые якоря (вехи, обязательные по ревью):**
- 1d, `now = 2026-09-11T10:00:00Z` ⇒ ожидаемый latest CLOSED `2026-09-10T00:00Z`; `H=09-10` → `ok` (лаг 0); `H=09-09` → `ok` (лаг 1 == bound); `H=09-08` → `absolute_stale` (лаг 2). Строки BINGX с границей 16:00 в этих проверках не участвуют (исключаются eligibility ДО выбора H), а контрольный прогон «без фильтра» даёт `data_unavailable`, что и доказывает необходимость порядка множеств.
- 5m, `now = 09:55:00.000Z` ⇒ ожидаем `09:50`; `now = 09:54:59.999Z` ⇒ ожидаем `09:45` (граница отдана закрывшемуся бару). Аналогичные проверки на 15m/1h/4h.
- Гонка: `1×09:45 + 4×09:50` ⇒ `H = 09:45`, все пять участников реально `evaluated` (fixtures проходят `evaluateSmc`, а не mock), `candleTime === H` у всех, каждый вход оценки заканчивается ровно на `H`, `checkCandleAlignment.safe = true`, агрегация разрешена через `decideAggregationAtCommonHorizon`; после догона отстающего `H` переезжает на `09:50`.
- Пересечение, а не `min(latest)`: ряд A..D = {09:35, 09:45, 09:50}, E = {09:35, 09:40} ⇒ `H = 09:35`; мутация «H = min(latest)» этот тест ломает.
- No-lookahead: `evaluate(trunc@H)` deep-equal `evaluate(физический префикс ≤ H)` по scores/direction/всем 9 reasons, `price === close(H)`; порча баров после H не меняет ни одну оценку и не сдвигает H.
- Порядок: reverse/rotation дают тот же H, те же лаги и freshness-решение, идентичные нормализованные оценки и идентичный aggregate outcome.
- Три «вредных» мутации проверялись явно и ЛОВЯТСЯ тестами: `min(latest)`; отключение absolute bound; молчаливое выбрасывание участника без данных; отключение усечения (lookahead); превращение `filtered` в участников; удаление anchor-проверки из gate.

**Verification (Arena-песочница, только чтение, worker/PM2 не запускались):**
- `npx tsx scripts/test-common-horizon.ts` — **227/227** (переписан полностью: без mock-веток, без `ok(true, …)`, статические чтения исходников идут от корня репозитория через `import.meta.url` и ПАДАЮТ при ошибке чтения; семантических проверок больше, чем grep-проверок).
- Существующие наборы, которые не должно было задеть: `test-smart-money 62/62`, `test-smart-money-eligibility 96/96`, `test-smart-money-diagnostic 95/95`, `test-smart-money-phase3c-fix 59/59`, `smart-money-readonly --self-test 43/43`.
- SMC-ядро: `scoring 75`, `range 50`, `evaluate 31`, `lookahead 13`, `order-blocks 63`, `liquidity 48`, `fvg 37`, `displacement 23`, `fsm 62`, `pivots 24`, `phase3d-config 70`, `phase3d-b 55`, `phase3d-c 91`, `phase3d-d 128` — все зелёные.
- Прочее: `admin-consistency 84`, `freshness 52`, `seed-smart-money 86`, `ohlcv-cli 105`, `ohlcv-pilot 131`, `ohlcv-lock pure 56` (integration-часть `SKIPPED: no DATABASE_URL` — честно, не имитировалась).
- `SKIPPED/BLOCKED`: `test-strategy-runtime` требует PostgreSQL (`DATABASE_URL` в песочнице нет) — прогон нужно повторить на VPS.
- `npx tsc --noEmit` локальным typescript из `node_modules` — 0 ошибок на всём репозитории. `npm run build` — `✓ Compiled successfully in 3.9s`, далее сборка падает на сборке page-data для `/api/register`: `@prisma/client did not initialize yet` (в песочнице нет сгенерированного клиента/БД). Тот же сбой воспроизведён КОНТРОЛЬНЫМ прогоном на чистом дереве `ec7332072` (правки были убраны через `git stash`) — значит это ограничение песочницы, а не следствие FIX'а: ни одна страница/API не менялась. `git diff --check` — чисто (обе EOF-пустые строки кандидата убраны).
- `prisma/schema.prisma` — 0 изменений; `lib/strategies/alignment.ts` — 0 изменений; `lib/strategies/smart-money-eligibility.ts` (Option A) — 0 изменений; `lib/smc/*`, адаптеры, `lib/ohlcv/*`, worker, PM2, Admin/API — не тронуты. Signal Engine отсутствует: `lib/signals`, `signal-worker`, `test-signal-engine` в диффе нет, записей в `Signal` нет (в скриптах остались только чтения `prisma.signal.count()` как инвариант «ничего не записано»).

**Факт production БД на момент FIX (данные владельца; ревьюер БД не трогал и `DATABASE_URL` в песочнице не имеет):** `Strategy id=2`, slug `smart-money-suslik`, version 1, status `PUBLISHED`, `enabled=true`, `timeframes=["5m","15m","1h","4h","1d"]`, `minExchanges=3`, `Signal` — 0 записей. §41 описывал состояние на момент своего коммита (`DRAFT enabled=false`) и остаётся корректным как исторический снимок; актуальным является абзац выше. Документация — никаких `prisma`-записей, seed/migration не выполнялись.

**Операционный эффект:**
- До: транзиентное `cannot-aggregate` ~15 s каждые 5 m во время прохода ingest.
- После: чтение в `09:50:15` (середина прохода) берёт общий `H=09:45`, все пять участников оцениваются на `09:45` (один и тот же горизонт → `ALIGNED`), агрегат строится; относительный лаг 1 бар и абсолютный лаг 1 бар — в пределах политик. Чтение в `09:50:35` (проход закончен) → `H=09:50`, лаги 0/0.
- Цена решения: во время прохода горизонт может быть на 1 бар старее самого свежего — это осознанный компромисс «не смешивать горизонты» вместо «агрегировать что удалось собрать». Если отставание больше policy (relative > 3 бара или абсолютное > 1 бара от ожидаемого) — явный отказ с `[STATUS]`, никакого тихого успеха на части рынков и никакого тихого успеха на древних данных.

**Files changed (один коммит):** `lib/strategies/common-horizon.ts` (переписан), `lib/strategies/smart-money.ts` (`evaluateMarketsAtCommonHorizon` + partition + anchor), `scripts/smart-money-readonly.ts`, `scripts/smart-money-diagnostic.ts` (единый gate + честная диагностика + возврат explainability), `scripts/test-common-horizon.ts` (переписан, 227 проверок), `PROJECT_CONTEXT.md` (этот §42).

**Deliverable:** ОДИН reviewable FIX-коммит ровно поверх `ec73320723327f68a64be435b87aff0e5701f110` (не amend), push только в `arena/01a09002-svechnoy-suslik`. DB/Strategy/PM2/worker/Signal Engine — не тронуты. После коммита и отчёта — STOP.
