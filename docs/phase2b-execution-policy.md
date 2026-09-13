# PHASE 2B — Execution Policy V1 Decision

## Separation: SMC scoring vs execution

- SMC scoring: raw LONG/SHORT/NEUTRAL/CANNOT_EVALUATE + 9 components A-I, no SL/TP.
- Execution: how to turn direction into tradable levels and measure forward performance.

These must remain separate modules. Changing execution must not change historical SMC scores.

## Two options for entry

### A. REFERENCE_CLOSE

- entry = close price of reference exchange at signalCandleTime H
- Analytic price at moment signal becomes known (asOf = H + tfMs)
- At asOf, close of H is known (CLOSED candle)
- Optimistic as executable: you cannot trade at close that just happened, you already missed it
- Good for analytic dashboard: "price at signal moment"

### B. NEXT_BAR_OPEN

- entry = open price of next candle after H (openTime = asOf)
- First potentially executable price after signal
- Causal-safe: signal known at asOf, you can enter at open of next bar (which just opened)
- Matches backtest already uses next-bar-open (lib/backtest)
- For forward stats, more honest: measures what you could actually get

**Example timeline (1h timeframe):**

- H = 2026-09-13T12:00:00Z openTime, candle [12:00,13:00)
- Candle closes at 13:00, close price = 115000 known at 13:00
- asOf = H + 1h = 13:00 — signal becomes known
- Next bar openTime = 13:00, open price = 115010 (first tick of next hour)
- REFERENCE_CLOSE entry = 115000 (analytic, optimistic)
- NEXT_BAR_OPEN entry = 115010 (executable, causal)

If you use REFERENCE_CLOSE as entry for stats, you assume you could trade at 115000 at 13:00, but that price is already gone. Using NEXT_BAR_OPEN = 115010 is honest.

## Decision for production Smart Money

**Prefer NEXT_BAR_OPEN for forward performance statistics**, because:

- Backtest uses next-bar-open (fair)
- Forward live stats should use same to be comparable
- Causal-safe: entry price is after signal time, not same candle
- Avoids optimistic bias

**But store both for transparency:**

- referencePrice = close at H (analytic)
- aggregatePrice = avg close at H (informational)
- nextBarOpenPrice = open at asOf (executable, if available)
- entry = nextBarOpenPrice ?? referencePrice (fallback if next bar not yet ingested, with flag optimistic)

**Contract for SMC_ATR_V1:**

```ts
{
  version: 1,
  policy: "SMC_ATR_V1",
  direction: from SMC,
  signalCandleTime: H,
  asOf: H + tfMs,
  referenceExchange: deterministic priority,
  referencePrice: close at H on referenceExchange,
  aggregatePrice: avg close at H,
  nextBarOpenPrice: open at asOf on referenceExchange (nullable until next bar CLOSED or at least OPEN known),
  nextBarOpenTime: asOf,
  entry: nextBarOpenPrice ?? referencePrice, // executable
  atrAtSignal: ATR from referenceExchange at H (not average),
  atrPeriod: from SMC config (14),
  stopMultiplier: 1.5,
  tp1Multiplier: 1.5,
  tp2Multiplier: 2.5,
  tp3Multiplier: 4.0,
  stopLoss: entry ± atr*stopMult,
  takeProfits: entry ± atr*tpMult,
  executionPolicyVersion: 1,
  signalSource: LIVE_FORWARD,
  // Immutable snapshot: changing Strategy.config tomorrow doesn't change old Signal
}
```

**ATR semantics:**

- ATR from reference exchange only, not average of 5.
- ATR calculated from reference exchange's CLOSED history up to H (using same candles as SMC evaluation).
- Store atrAtSignal, period, multipliers for reproducibility.
- If reference exchange changes in future, old signals keep old ATR.

**Why not avg ATR:**

- Avg mixes different exchange histories, not reproducible
- Reference exchange is deterministic, independent of score, so ATR is deterministic too
- For backtest comparability, use single exchange ATR

**Immutability:**

- Candidate frozen via Object.freeze
- executionParams snapshot stored in metadata
- Changing config later doesn't reinterpret old signals

**Future outcome tracker (not in PHASE 2B):**

- Will use entry = NEXT_BAR_OPEN
- Will track high/low after entry to see if SL/TP hit
- Will store outcome in separate table, not modify Signal

---

## Implementation in PHASE 2B

- `lib/signals/smart-money-candidate.ts` implements SMC_ATR_V1 with both prices
- `DEFAULT_SMC_ATR_V1_PARAMS` = { stop 1.5, tp1 1.5, tp2 2.5, tp3 4.0, version 1 }
- Stores referencePrice, aggregatePrice, nextBarOpenPrice, atrAtSignal
- Entry = nextBarOpenPrice ?? referencePrice
- Tests verify ATR from reference, not avg
