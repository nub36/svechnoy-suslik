# PHASE 2B — Legacy Seeded Signals Classification

## Current state

- `scripts/seed-test-signal.ts` creates test signals ID1/ID2 for development
- These are not real market signals, they are seeded for UI testing
- They currently have no signalSource, so they appear as LIVE_FORWARD in statistics

## Problem

If future Smart Money live-forward statistics query `Signal` table without filtering source, seeded ID1/ID2 will pollute live stats.

## Solution — SignalSource enum

```prisma
enum SignalSource {
  LIVE_FORWARD
  SEEDED
  BACKTEST
}
```

- Existing production signals (trend-suslik) have no source → default LIVE_FORWARD for backward compat
- New SMC signals will have LIVE_FORWARD when created via worker with guard enabled
- Seeded signals should be created with SEEDED
- Backtest signals (if ever stored in Signal table) should be BACKTEST, but preferably backtest uses separate layer, not Signal table

## Classification for existing rows

- ID1/ID2 from `seed-test-signal.ts` → should be updated to SEEDED (but NOT in PHASE 2B, production DB not touched)
- All existing trend signals → LIVE_FORWARD (default)
- Future SMC signals → LIVE_FORWARD

## Safe query for live statistics

```sql
SELECT * FROM "Signal" WHERE "signalSource" = 'LIVE_FORWARD' AND "strategyId" = 2 -- smart-money
```

Exclude SEEDED and BACKTEST.

## Implementation in PHASE 2B

- Schema adds `signalSource` with default LIVE_FORWARD
- Migration adds enum and column
- `seed-test-signal.ts` should be updated in future to set SEEDED (not done in PHASE 2B to avoid production change, but documented)
- Signal engine for SMC sets LIVE_FORWARD explicitly
- No deletion of ID1/ID2, no production DB change in PHASE 2B

## Additional safety

- Unique constraint [strategyId, symbol, timeframe, signalCandleTime] without direction prevents duplicate LIVE_FORWARD signals on same candle
- Seeded signals with same candle time would also be blocked if they try to use same identity — they should use different signalCandleTime or different strategyId
- For backtest, if it writes to Signal table (not recommended), it should use BACKTEST source and different strategy version or be stored in separate table

## Future: separate backtest layer

- Backtest already has its own data plane (lib/backtest)
- It should NOT write to Signal table; it should write to separate BacktestSignal or keep in memory
- If it does write, use BACKTEST source and filter out

## No action in PHASE 2B

- Don't delete ID1/ID2
- Don't update production DB
- Only schema design + migration file prepared for VPS
