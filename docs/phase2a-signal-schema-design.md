# PHASE 2A — Signal Schema Design (DRY-RUN, no migration yet)

## Context

Current `prisma/schema.prisma` Signal model:

```prisma
model Signal {
  id          Int       @id @default(autoincrement())
  symbol      String
  timeframe   String
  direction   String
  score       Float
  entry       Float
  stopLoss    Float?
  takeProfit1 Float?
  takeProfit2 Float?
  takeProfit3 Float?
  status      String    @default("ACTIVE")
  reason      String
  strategyId  Int
  createdAt   DateTime  @default(now())
  closedAt    DateTime?
  ...
}
```

Candle model:

```prisma
model Candle {
  id        BigInt   @id
  marketId  Int
  timeframe String
  openTime  DateTime
  closeTime DateTime?
  ...
}
```

`Candle.openTime` is `DateTime`, not BigInt milliseconds. The BigInt `id` is unrelated.

## Required future fields — design only, no migration in PHASE 2A

### 1. signalCandleTime

**Purpose:** The canonical CLOSED candle openTime that triggered the signal — the common horizon H, not wall-clock `createdAt`.

**Temporal semantics:** MUST use same semantics as common SMC horizon:
- `selectCommonClosedHorizon()` returns `commonHorizon: Date` — the latest timestamp present as `closed=true` canonical CLOSED candle in EVERY participant.
- That timestamp IS the `openTime` of the CLOSED candle (e.g. `2026-09-11T09:50:00.000Z` for 5m).
- `asOf = commonHorizon + SMCTIMEFRAME_MS[tf]` — effectiveCloseTime for `evaluateSmc()`.
- `signalCandleTime` MUST be `commonHorizon` itself, NOT `asOf`, NOT `createdAt`.

**Type choice:**
- `Candle.openTime` is `DateTime` (Prisma DateTime → JS Date, UTC).
- Therefore `Signal.signalCandleTime` should be `DateTime` as well, to keep direct equality `signal.signalCandleTime.getTime() === candle.openTime.getTime()` without conversion.
- If `Candle.openTime` were BigInt milliseconds, we would prefer BigInt for zero-loss. Since it is DateTime, DateTime is correct.
- Alternative BigInt would require conversion and risk mismatch; no benefit.

**Proposed Prisma:**

```prisma
signalCandleTime DateTime? // nullable for backward compat with existing trend signals, but required for new SMC signals
```

For SMC signals: always set, equals `commonHorizon`.
For Trend signals: can be set to `candleTime` of IndicatorSnapshot or aggregated reference (currently not stored, but should be same concept).

**Index:** `@@index([symbol, timeframe, signalCandleTime])` and `@@index([strategyId, signalCandleTime])` for deduplication and historical queries.

**Deduplication:** Existing trend uses `strategyId + symbol + timeframe + direction` within timeframe window. Future should be `strategyId + symbol + timeframe + signalCandleTime + direction` — exact candle, not wall-clock.

### 2. referenceExchange, referencePrice, aggregatePrice

**Purpose:** Explainability — which exchange's price is reference, and what is aggregated average.

- `referenceExchange: String?` — e.g. "BINANCE" — the exchange with highest score or first in list, deterministic.
- `referencePrice: Float?` — close price of `referenceExchange` at `signalCandleTime`.
- `aggregatePrice: Float?` — average close across evaluated exchanges at `signalCandleTime` (used as entry for SMC until execution policy defined).

**Why not just entry:** `entry` currently is ATR-based for trend, but for SMC direction-only dry-run, entry should be reference/aggregate price without SL/TP invention. Keep separate.

### 3. executionPolicy

**Purpose:** Architecture separation RawSmcObservation vs Executability (from earlier constraints).

- Raw SMC gives `LONG/SHORT/NEUTRAL/CANNOT_EVALUATE` + facts, NO SL/TP.
- Executability is separate: `EXECUTABLE / NON_EXECUTABLE:NO_EXECUTION_POLICY / NO_VALID_LEVELS` etc.

**Proposed:**

```prisma
executionPolicy String? // e.g. "SMC_DIRECTION_ONLY" | "ATR_1.5_1.5_2.5_4" | "STRUCTURAL_OB" etc
```

For PHASE 2A: `SMC_DIRECTION_ONLY` — no SL/TP, only direction.

Future: JSON field `executionConfig Json?` or separate columns for policy params.

### 4. signalSource

**Purpose:** Distinguish LIVE_FORWARD vs BACKTEST vs SEEDED vs DRY_RUN.

Current Signal has no source, all assumed live. For backtest and seeding, need explicit source to avoid mixing.

**Proposed:**

```prisma
signalSource String @default("LIVE_FORWARD") // LIVE_FORWARD | BACKTEST | SEEDED | DRY_RUN
```

Or enum.

**Usage:**
- Production live: `LIVE_FORWARD`
- Backtest: `BACKTEST`
- Seed script: `SEEDED`
- Dry-run test: `DRY_RUN` (not persisted in PHASE 2A, but for future if we persist dry-run candidates)

### 5. Additional fields considered but deferred

- `commonHorizonStatus: String?` — e.g. "ok" — for debugging why no signal.
- `evaluatedExchanges: Int?`, `longVotes: Int?`, `shortVotes: Int?`, `neutralVotes: Int?`, `confirmation: String?` — aggregation metadata, currently in `reason` string, but better as columns for query.
- `referenceCandleCloseTime: DateTime?` — redundant with `signalCandleTime + timeframe`, but could be stored as `asOf`.
- `rawScores Json?` — per-exchange longScore/shortScore snapshot for audit.

For PHASE 2A, keep minimal: only `signalCandleTime` is critical. Others can be in `reason` or future JSON.

## Full proposed migration (NOT APPLIED in PHASE 2A)

```prisma
model Signal {
  id                 Int       @id @default(autoincrement())
  symbol             String
  timeframe          String
  direction          String
  score              Float
  entry              Float
  stopLoss           Float?
  takeProfit1        Float?
  takeProfit2        Float?
  takeProfit3        Float?
  status             String    @default("ACTIVE")
  reason             String
  strategyId         Int
  createdAt          DateTime  @default(now())
  closedAt           DateTime?

  // PHASE 2B proposed additions:
  signalCandleTime   DateTime? // common closed horizon openTime, same semantics as Candle.openTime
  referenceExchange  String?
  referencePrice     Float?
  aggregatePrice     Float?
  executionPolicy    String?   @default("SMC_DIRECTION_ONLY")
  signalSource       String    @default("LIVE_FORWARD")

  strategy Strategy @relation(fields: [strategyId], references: [id], onDelete: Cascade)

  @@index([symbol, timeframe])
  @@index([symbol, timeframe, signalCandleTime])
  @@index([status])
  @@index([strategyId])
  @@index([strategyId, signalCandleTime])
  @@index([createdAt])
  @@index([signalSource])
}
```

## Temporal semantics guarantee

- `signalCandleTime` MUST equal `commonHorizon` from `selectCommonClosedHorizon()` which itself equals `Candle.openTime` of a CLOSED candle (canonical UTC grid, `openTime % SMCTIMEFRAME_MS[tf] == 0`).
- It MUST NOT be `now` (wall clock) nor `createdAt`.
- It MUST be CLOSED: `closeTime < now` and `openTime + tf <= now` per ingestion semantics (`lib/exchanges/*.ts` `closeTime < now`).
- For 1d, `00:00 UTC` grid, BINGX excluded.
- For multi-exchange, same `signalCandleTime` across all participants, enforced by `assertEvaluatedAtHorizon()` and `checkCandleAlignment()`.

## Safety

- PHASE 2A: no migration, no DB write for smart-money, only design doc.
- PHASE 2B: migration adds nullable columns, backward compatible, no data loss.
- Existing trend signals: `signalCandleTime` nullable, backfilled from `IndicatorSnapshot.candleTime` if needed.
