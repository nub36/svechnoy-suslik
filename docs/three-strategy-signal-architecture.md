# Three-Strategy Signal Architecture — Target Architecture Freeze

**PRE-ARCHITECTURE CHECKPOINT:** `b6fd73781652eb483a1803984ef9547074aff381`  
**Status:** DOCS ONLY — no code, no deploy, no Signal Engine change, no Prisma, no PM2, no site change  
**Date:** 2026-09-13  
**Purpose:** Freeze target architecture for three independent parallel strategies before changing signal semantics. Checkpoint b6fd737 is last point BEFORE signal semantics change, can be used for rollback/comparison.

---

## 1. Главное решение

В будущем одновременно работают ТРИ независимые стратегии:

1. `trend-suslik` (V1 Trend)
2. `smart-money-suslik` (V1 Smart Money)
3. `smart-money-v2` (V2)

Все три анализируют рынок независимо.

НЕТ единственной "главной" стратегии.

Какая стратегия сформировала валидный сигнал — её сигнал появляется на сайте.

Если сработали две или три — сохраняются результаты каждой (отдельные `Signal` records, разные `strategyId`).

Это параллельная модель, а не взаимоисключающая.

---

## 2. Биржи НЕ являются подтверждениями направления

**ФИНАЛЬНОЕ АРХИТЕКТУРНОЕ РЕШЕНИЕ:**

Не использовать модель:

```
3 из 5 exchanges voted LONG/SHORT
```

как смысл торгового confirmation.

Коррелированные цены пяти бирж (BINANCE, BYBIT, GATE, KUCOIN, BINGX) не являются пятью независимыми торговыми факторами. Цены движутся почти синхронно, их голосование не добавляет причинной информации о структуре рынка, а лишь дублирует один и тот же ценовой поток.

- **Биржа = источник market data** (OHLCV, price, volume)
- **Стратегия = источник торгового решения** (LONG/SHORT/NEUTRAL)

Разделить эти понятия.

Текущая реализация V1 (на момент checkpoint b6fd737) использует `minExchanges` quorum 3/5 как прокси подтверждения — это LEGACY. В target архитектуре exchange voting как directional confirmation отсутствует.

---

## 3. Reference Market

Default reference:

```
BINANCE
BTC/USDT
```

Для каждой стратегии вычисления делаются по CLOSED candles reference market.

- Trend-suslik: CLOSED candles BINANCE BTC/USDT на рабочем timeframe (15m/1h/4h/1d)
- Smart Money V1 (target): CLOSED candles BINANCE BTC/USDT, а не агрегат 5 бирж
- Smart Money V2: уже реализовано — `referenceExchange = BINANCE`, `symbol = BTC`, `timeframe = 15m` default

Для публичного сайта Binance также default, fallback по priority из `ExchangeConfig`.

Если reference exchange недоступна:

- Поведение должно быть fail-closed (`CANNOT_EVALUATE` / `DATA_UNAVAILABLE`, не NEUTRAL с фейковым скором)
- Или явно настроенный deterministic fallback (например, BYBIT как второй priority), но fallback должен логироваться в `Signal.referenceExchange` и `metadata.referenceFallback = true`
- Fallback не должен незаметно менять смысл сигнала — пользователь видит, что сигнал построен на fallback бирже.

---

## 4. Роль других бирж

```
BYBIT
GATE
KUCOIN
BINGX
```

могут использоваться для:

- **DATA HEALTH** — сравнение цены reference с другими биржами, детект аномалий / депега
- **Sanity check цены** — если BINANCE цена отклоняется > X% от медианы остальных, сигнал блокируется как нездоровый
- **Fallback** — если BINANCE OHLCV отсутствует, deterministic fallback на BYBIT (priority 90) с пометкой
- **Дополнительного исследования** — бэктесты, сравнение поведения стратегий на разных биржах, исследование ликвидности
- **Public charts** — для /coin/{symbol} можно показывать цены с разных бирж, но это UI, не сигнал

но НЕ как 4 дополнительных "голоса направления".

Для OHLCV ingestion:

- PUBLIC Top-50 ingestion (checkpoint b6fd737): сканирует ТОЛЬКО BINANCE по умолчанию (`ExchangeConfig ohlcvEnabled=true` только BINANCE, остальные false) — VPS 2GB safe, concurrency 1, interval 300000
- BTC dedicated worker (`svechnoy-suslik-ohlcv-btc`): продолжает сканировать 5 бирж (BINANCE, BYBIT, GATE, KUCOIN, BINGX) для data health и quorum LEGACY, НЕ использует ExchangeConfig filtering — это отдельная задача, не public ingestion.

---

## 5. Strategy #1 — Trend Suslik

Trend Strategy должна определять LONG/SHORT собственными trend/indicator conditions, а не голосованием бирж.

Предполагаемая модель (подлежит audit существующего `trend-suslik` кода перед реализацией, не придумывать новые indicators если существующий код уже имеет определения):

- **Trend structure** — направление тренда по свингам / структуре (аналог BOS в SMC, но для тренда)
- **EMA/MA structure** — положение цены относительно EMA20/50/200, fast > slow = UP и т.д.
- **EMA slope** — наклон EMA fast/slow за lookback (например, 5 баров), подтверждает силу тренда
- **Momentum** — RSI, MACD, volume ratio — фильтр перекупленности/перепроданности
- **HTF context** — старший timeframe (например, 1h для 15m) как контекст, не жёсткий блок

Confirmation count относится к условиям Trend Strategy:

```
N/M strategy confirmations
M = реальное количество активных trend conditions
```

Например, для Trend: BOS, EMA structure, EMA slope, HTF alignment, momentum — 5 independent.

Не к exchanges.

**Обязательный шаг перед реализацией:** audit текущего `lib/strategies/trend-suslik.ts` — какие условия уже есть, какие веса, какие фильтры, чтобы не дублировать и не сломать существующую логику.

---

## 6. Strategy #2 — Smart Money V1

Smart Money V1 должна определять направление по причинным SMC conditions, а не exchange votes.

Целевые категории (из существующего `lib/smc/scoring.ts` 9 reasons, но честная классификация):

**INDEPENDENT (реальные причинные факты):**

- **Market Structure / BOS** — `SWING_TREND` + `RECENT_SWING_BOS` (пробой структуры, фаза TREND_UP/DOWN)
- **Order Block** — `SWING_ORDER_BLOCK` / `INTERNAL_ORDER_BLOCK` (свежий активный OB)
- **FVG** — `FVG` (свежий активный Fair Value Gap)
- **Liquidity Sweep** — `LIQUIDITY_SWEEP` (свежий SWEPT)
- **Range Position** — `RANGE_POSITION` (Premium/Discount)

**DERIVED:**

- **OB+FVG Confluence** — `OB_FVG_CONFLUENCE` — overlap bonus 5 points, deliberate bonus из scoring.ts, не независимый вес, только если OB и FVG оба присутствуют и перекрываются

**CONTEXT:**

- **Internal Structure** — `INTERNAL_TREND` — внутренний тренд как контекст, не основной сигнал

Не считать:

- exchange votes (3/5 бирж LONG) — не является SMC фактором

Не допускать double counting:

- `SWING_TREND` + `RECENT_SWING_BOS` оба мапятся на один V2 ключ `bos` — считать один раз
- `SWING_ORDER_BLOCK` + `INTERNAL_ORDER_BLOCK` → `orderBlock` один раз
- `INTERNAL_TREND` не должен учитываться дважды как CHOCH и internalStructure

**Если текущий V1 сегодня использует 3/5 exchange quorum:**

В документе явно отметить:

- **CURRENT IMPLEMENTATION / LEGACY (checkpoint b6fd737):** V1 Smart Money использует `minExchanges=3` quorum по 5 биржам (BINANCE, BYBIT, GATE, KUCOIN, BINGX), direction определяется голосованием, `participantCount`, `evaluatedCount`, `longVotes`, `shortVotes`
- **TARGET ARCHITECTURE:** V1 переводится на reference-market model (BINANCE CLOSED candles) + SMC confirmations N/M, exchange quorum убирается как directional confirmation, может остаться как data health check

Ничего пока в коде V1 не менять — только зафиксировать target.

---

## 7. Strategy #3 — Smart Money V2

V2: `SMC core + Trend Context`

Нынешняя подготовленная классификация (checkpoint b6fd737, файл `lib/strategies/smart-money-v2.ts`):

**INDEPENDENT (5):**

- **BOS** — `SWING_TREND` + `RECENT_SWING_BOS` — Break of Structure, вес 20, required true
- **Order Block** — `SWING_ORDER_BLOCK` (или INTERNAL как fallback) — вес 20, required true
- **FVG** — `FVG` — вес 15
- **Liquidity Sweep** — `LIQUIDITY_SWEEP` — вес 15
- **Range Position** — `RANGE_POSITION` — Premium/Discount, вес 15

**DERIVED (1):**

- **OB+FVG Confluence** — `OB_FVG_CONFLUENCE` — overlap bonus, вес 5, required false, не дублирует веса OB+FVG, только если оба родителя присутствуют

**CONTEXT (1):**

- **Internal Structure** — `INTERNAL_TREND` — вес 10, context bias

**PLACEHOLDER / disabled (2):**

- **CHOCH** — Change of Character — duplicate of internalStructure (INTERNAL_TREND), disabled weight 0, category PLACEHOLDER, чтобы избежать double count
- **Displacement** — evaluateSmc возвращает `displacements[]`, но scoring не имеет отдельного DISPLACEMENT reason — до отдельной причинной реализации PLACEHOLDER disabled weight 0

Итого активных: 7 (5 INDEPENDENT + 1 DERIVED + 1 CONTEXT), всего ключей 9, PLACEHOLDER 2 disabled — честное N/M, не искусственные 9.

**Trend:**

- Modes: `OFF`, `MARKET_STRUCTURE`, `EMA`, `HTF`, `COMBINED`
- Policies: `SCORE_BOOST`, `TIERING`, `HARD_ALIGNMENT`
- Preferred research starting policy: `SCORE_BOOST` / `TIERING`, не `HARD_ALIGNMENT` по умолчанию (HARD_ALIGNMENT может душить сигналы, требует исследования)

V2 config уже имеет:

- `mode: DISABLED` default
- `symbol: BTC`, `timeframe: 15m`, `referenceExchange: BINANCE`
- `minimumSignalScore: 65`
- Trend default `mode: MARKET_STRUCTURE`, `policy: SCORE_BOOST`, `htfTimeframe: 1h`

---

## 8. Не обязательно N/5

Не пытаться искусственно сделать:

```
3/5
4/5
5/5
```

Каждая стратегия имеет своё количество независимых conditions:

- Trend: может быть 5 trend conditions
- SMC V1 target: 5-6 independent SMC + 1 derived + 1 context = 7 активных
- SMC V2: 5 independent + 1 derived + 1 context = 7 активных (checkpoint b6fd737)

UI:

```
N/M strategy confirmations
M = реальное количество активных confirmations данной конфигурации
```

Например:

- `BOS 1/1, OrderBlock 1/1, FVG 0/1, LiquiditySweep 1/1, Range 1/1, Confluence 0/1, Internal 1/1` → `5/7` met, breakdown `independent 4/5, derived 0/1, context 1/1`

Не рисовать 9 ради дизайна.

---

## 9. Signal Pipeline

Целевая схема для каждой стратегии (одинакова, но evaluation разный):

```
CLOSED reference candles (BINANCE BTC/USDT, tf = strategy timeframe)
→ strategy-specific evaluation (trend conditions / SMC conditions / SMC+Trend)
→ LONG / SHORT / NEUTRAL / CANNOT_EVALUATE
→ strategy confirmations (list with code, label, longPoints, shortPoints, category, v2Key, smcCode)
→ score (longScore, shortScore)
→ EDGE state machine (per strategyId)
→ Signal (DB record with strategyId, symbol, timeframe, signalCandleTime, referenceExchange, direction, score, confirmations metadata, triggerType EDGE/REVERSAL, executionPolicy, etc.)
```

Детали:

- Вход только CLOSED свечи, no lookahead
- `signalCandleTime` = openTime последней CLOSED свечи, используется для уникальности `[strategyId, symbol, timeframe, signalCandleTime]`
- `referenceExchange` = BINANCE (или fallback с пометкой)
- `score` = strategy score (для V2: SMC longScore/shortScore + trend boost)
- `confirmationCount` / `confirmationTotal` = N/M strategy confirmations (distinct v2Keys, dedup)
- `triggerType` = EDGE / REVERSAL (из edge-state-machine)

---

## 10. EDGE независим для каждой стратегии

Каждая стратегия имеет свой `StrategySignalState` через `strategyId` (уникальный `[strategyId, symbol, timeframe]`).

Для каждой отдельно, одинаковая машина из `lib/signals/edge-state-machine.ts` (проверена тестами, включая регрессию 2026-09-13):

- `NEUTRAL → LONG/SHORT = EDGE` → EMIT LONG/SHORT, triggerType EDGE
- `same direction = HOLD` → no signal
- `LONG/SHORT → NEUTRAL = REARM` → состояние сбрасывается, готов к новому EDGE
- `LONG ↔ SHORT = REVERSAL` → EMIT opposite direction, triggerType REVERSAL
- `UNAVAILABLE / CANNOT_EVALUATE / DATA_UNAVAILABLE = PRESERVE` → состояние сохраняется, не re-arm
- `same horizon (same signalCandleTime) = idempotent` → NOOP_SAME_HORIZON, нет дубля
- `provisional unavailable → evaluable same horizon = re-evaluate` → если предыдущий evaluation был provisional (QUORUM_NOT_MET и т.п.) и пришёл evaluable на том же horizon, разрешается повторная оценка (фикс бага 16:15)

V1/V2 состояния независимы по strategyId — V1 SHORT не блокирует V2 LONG.

---

## 11. Три стратегии могут сработать одновременно

Пример 1:

```
Trend: SHORT (15m BOS + EMA bearish)
SMC V1: SHORT (BOS + OB + Sweep)
SMC V2: no signal (NEUTRAL)
```

Создаются 2 независимых signals:

- Signal id=100, strategyId=1 (trend-suslik), direction SHORT, confirmations 4/5
- Signal id=101, strategyId=2 (smart-money-suslik), direction SHORT, confirmations 3/5

Оба видны на /signals, можно показать badge "2 стратегии подтверждают SHORT".

Пример 2 (конфликт):

```
Trend: LONG
SMC V1: SHORT
```

Это НЕ ошибка.

Сохраняются оба:

- Signal trend LONG
- Signal SMC V1 SHORT

UI показывает CONFLICT, ничего не скрывать, не отменять один другим.

Пользователь видит, что стратегии расходятся — это информация, а не баг.

---

## 12. Dedup

Dedup только внутри `strategyId`.

Одинаковый BTC/15m/horizon:

```
Strategy A Signal (trend-suslik, BTC, 15m, 2026-09-13T08:15:00Z)
Strategy B Signal (smart-money-suslik, BTC, 15m, 2026-09-13T08:15:00Z)
```

не являются duplicates — разные strategyId, разные причины.

Но Strategy A не может создать два одинаковых EDGE signal на одном horizon:

- Уникальность `[strategyId, symbol, timeframe, signalCandleTime]` без direction (PostgreSQL NULL distinct, legacy rows с NULL не ограничены, новые SMC с NOT NULL ограничены)
- + edge machine `same horizon = idempotent` → второй вызов на том же horizon возвращает NOOP
- Будущее: `[strategyId, symbol, timeframe, setupKey]` для persistent setup dedup (один bearish regime 08:15..10:45 = один setup, а не 11 свечей)

---

## 13. UI /signals

Каждая запись показывает:

- **Strategy** — slug + name (trend-suslik / smart-money-suslik / smart-money-v2)
- **Symbol** — BTC (в будущем может быть расширяемо, но сейчас BTC only)
- **Timeframe** — 15m / 1h / 4h / 1d
- **Direction** — LONG / SHORT
- **Score** — longScore / shortScore
- **Strategy Confirmations N/M** — например, `5/7` (independent 4/5, derived 0/1, context 1/1) с breakdown по категориям, а не "Биржи 3/5"
- **Trigger** — EDGE / REVERSAL
- **Reference Exchange** — BINANCE (или fallback с пометкой)
- **Candle Time** — signalCandleTime (CLOSED candle)
- **Entry/SL/TP** — ATR-based, anchored to real entry (NEXT_BAR_OPEN, no optimistic fallback)
- **Outcome** — SignalOutcome status WAITING_ENTRY / OPEN / TP1_HIT / TP2_HIT / TP3_HIT / STOPPED / EXPIRED / ENTRY_DATA_MISSING

Если несколько стратегий совпали:

```
"2 стратегии подтверждают SHORT"
```

можно показывать как дополнительный агрегированный badge, но исходные Signal records остаются отдельными (не схлопывать в один).

Если конфликт:

```
LONG 1 strategy
SHORT 1 strategy
```

показать:

```
CONFLICT — Trend LONG vs SMC SHORT
```

ничего не скрывать.

---

## 14. Никакого auto-trading

Все три стратегии создают только informational Signal records.

Никакого выставления ордеров.

Никаких реальных позиций.

Никакого PnL / winRate / profitFactor / Sharpe в production как истины — только synthetic correctness tests.

Write guard: `SMART_MONEY_WRITE_ENABLED` + env flag + `no-dry-run` + `enable-smart-money-write` — truth table, default dry-run.

---

## 15. Качество стратегий

Нельзя объявлять стратегию лучшей только по winrate.

Сравнивать:

- **signal frequency** — signals/day
- **EDGE episodes** — сколько раз NEUTRAL→LONG/SHORT, а не сколько свечей подряд
- **TP1-before-SL** — частота достижения TP1 до стопа
- **TP2-before-SL**
- **TP3-before-SL**
- **STOP-before-TP1** — частота стопа до TP1
- **LONG/SHORT отдельно** — LONG и SHORT могут вести себя по-разному
- **market regimes** — тренд, флет, волатильность
- **TRAIN / VALIDATION / OOS** — хронологический split, OOS-blind, OOS не для тюнинга

Если V2 даёт -80% сигналов vs V1 — это серьёзный минус, даже если winrate выше.

Метрики хранятся в `StrategyResearchResult` с полями `trainFrom/To`, `validFrom/To`, `oosFrom/To`, `metrics JSON`.

---

## 16. V2

V2 пока:

```
DISABLED
```

Перед LIVE:

- research (V2-A/B/C/D vs V1 baseline, SCORE_BOOST/TIERING/HARD_ALIGNMENT)
- historical replay (replay past CLOSED candles, проверить детерминизм, no lookahead)
- OOS (out-of-sample, не использовался для тюнинга)
- forward test (DRY_RUN / FORWARD_TEST mode, реальные CLOSED свечи, но без LIVE)

Только после отдельного решения активировать.

PM2 V2 LIVE worker отсутствует by design (checkpoint b6fd737: `grep smart-money-v2 ecosystem.config.js` = no results). Есть только `signal-btc-15m-smart` для V1.

---

## 17. Миграционный план Signal Logic

Будущий безопасный порядок реализации (не выполнять сейчас, только план):

**STEP 1:** Audit current Trend Strategy — прочитать `lib/strategies/trend-suslik.ts`, зафиксировать существующие индикаторы, веса, фильтры, как определяется LONG/SHORT сейчас.

**STEP 2:** Выделить strategy confirmations Trend — определить независимые trend conditions (BOS, EMA structure, EMA slope, momentum, HTF), присвоить категории INDEPENDENT/CONTEXT, убрать exchange voting из подсчёта.

**STEP 3:** Перевести Trend с exchange voting на reference-market model — evaluation по BINANCE CLOSED candles, `minExchanges` больше не используется как directional confirmation, может остаться как data health.

**STEP 4:** Audit Smart Money V1 — прочитать `lib/strategies/smart-money.ts`, `lib/smc/evaluate.ts`, `lib/smc/scoring.ts`, зафиксировать какие SMC факты уже есть, какие веса, как работает quorum.

**STEP 5:** Перевести V1 на SMC confirmations — вместо `3/5 exchanges LONG` использовать `N/M SMC confirmations` (BOS, OB, FVG, Sweep, Range, Confluence, Internal), сохранить EDGE machine, обеспечить независимость по strategyId.

**STEP 6:** V2 research — запустить `StrategyResearchResult` для V2-A (SMC+MARKET_STRUCTURE), V2-B (SMC+EMA), V2-C (SMC+HTF 1h), V2-D (SMC+COMBINED) с политиками SCORE_BOOST/TIERING/HARD_ALIGNMENT, сравнить с V1 baseline по частоте, TP1/2/3, STOP, LONG/SHORT, TRAIN/VALID/OOS.

**STEP 7:** Parallel dry-run all 3 — запустить три воркера в DRY_RUN mode на одном и том же периоде (например, 1 месяц), собрать signals, сравнить EDGE episodes, conflicts, frequency.

**STEP 8:** Compare results — анализ, какая стратегия лучше в каких режимах, есть ли смысл держать все три, или одна доминирует.

**STEP 9:** Parallel forward test — FORWARD_TEST mode, реальные CLOSED свечи, но без LIVE, проверить стабильность, отсутствие lookahead, корректность outcome tracker.

**STEP 10:** Только после проверки LIVE all 3 — отдельное решение, включение LIVE по одной стратегии за раз, с мониторингом, rollback план к checkpoint b6fd737 если новая архитектура хуже.

---

## 18. Важно: не ломать текущую точку

Commit `b6fd73781652eb483a1803984ef9547074aff381` является checkpoint ДО изменения signal semantics.

На момент b6fd737:

- Prisma schema: `SignalSource` single enum, `Strategy.mode` default DISABLED, `Asset.archivedAt`, `ExchangeConfig`, `StrategyResearchResult`
- Migration: `20260916_top50_v2_exchange_config` additive, BINANCE-only defaults (BINANCE ohlcv true, others false)
- PM2: `svechnoy-suslik-public-top50` interval 300000 concurrency 1 with `--use-exchange-config`, `svechnoy-suslik-ohlcv-btc` 5 markets, `signal-btc-15m-smart` V1, no V2 LIVE worker
- V2: mode DISABLED, honest categories INDEPENDENT/DERIVED/CONTEXT/PLACEHOLDER, no double count, displacement/choch disabled
- Tests: 87 V2, 47 exchange filtering, 86 admin consistency, tsc 0, build green

Документ должен прямо это указать.

Если новая архитектура окажется хуже (например, -80% signals, или TP1-before-SL хуже, или конфликты неинформативны):

- Мы можем вернуться / сравнить с checkpoint b6fd737
- Сравнить метрики TRAIN/VALID/OOS до и после
- Rollback без потери данных (OHLCV, Signals, Outcomes preserved, soft archive)

---

## 19. В этой задаче никакого кода

Разрешено изменить ТОЛЬКО:

```
docs/three-strategy-signal-architecture.md
```

Не менять другие файлы.

- Не менять Signal Engine
- Не менять Prisma
- Не менять PM2
- Не менять сайт
- Не запускать research/backtest

После создания документа:

```bash
git diff --stat   # должен показать ровно 1 файл
git commit -m "DOCS: freeze target three-strategy signal architecture — strategy confirmations, no exchange voting, independent parallel EDGE"
git push origin arena/01a09726-svechnoy-suslik
```

---

## Итоговая цель

```
3 independent parallel strategies
strategy-specific confirmations (N/M, real count, categories)
no exchange directional voting (exchange = data source, not confirmation)
BINANCE default reference (BTC/USDT CLOSED candles, deterministic fallback)
independent EDGE/state per strategyId
all valid signals visible (no hidden cancellation, CONFLICT shown)
no auto-trading (informational signals only)
quality comparison via frequency, EDGE episodes, TP1/2/3-before-SL, LONG/SHORT, TRAIN/VALID/OOS, not winrate alone
V2 DISABLED until research/OOS/forward test
safe migration plan STEP 1..10
checkpoint b6fd737 preserved for rollback
```

Этот документ — freeze target architecture, а не реализация.

