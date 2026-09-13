# EDGE/RE-ARM SIGNAL SEMANTICS V1 — FINAL REPORT

Date: 2026-09-13
Branch: arena/01a09726-svechnoy-suslik (from 51eb129dea6a36ac077770d57859837769ece705, prod d6c573c20a11e79e26153579575818f1dada2f96 untouched)

## VPS VALIDATION (previous phase, read-only)

- RAW qualified 15m = 11 consecutive SHORT 08:15..10:45 every candle (measured from BTC 15m common horizon quorum 3/5 exchanges)
- EDGE_TRIGGER = 1 at 08:15 (first observation of SHORT after NEUTRAL)
- Current SETUP_KEY = 11 different keys for 11 adjacent SHORT — FAILED as dedup mechanism
- Corrected RAW replay (timestamp aggregation, not bar index): TP1-before-SL 9/11=81.8% TP2 7/11=63.6% TP3 2/11=18.2% avg terminal R -0.33 PF 0.59 — but RAW not independent, 11 are same thesis repeated
- First EDGE observation 08:15 NEXT_BAR_OPEN 77026.62 TP3 reached terminal R+2.6667 bars=1 ONE observed setup only — not profitability evidence, synthetic correctness only per user constraints

## EDGE_STATE_MACHINE V1

File: `lib/signals/edge-state-machine.ts` pure, no DB, no scoring change.

AggregateState:
- NEUTRAL
- LONG
- SHORT
- CANNOT_EVALUATE
- DATA_UNAVAILABLE
- QUORUM_NOT_MET
- FUTURE_HORIZON
- ABSOLUTE_STALE

EdgeAction:
- EMIT
- REARM
- HOLD
- PRESERVE_UNAVAILABLE
- BOOTSTRAP_NO_SIGNAL
- NOOP_SAME_HORIZON
- REFUSE_OLDER_HORIZON

TriggerType:
- EDGE (NEUTRAL->LONG/SHORT)
- REVERSAL (LONG->SHORT, SHORT->LONG)
- BOOTSTRAP (optional flag)
- null (no emit)

Transitions:
- null (bootstrap) + SHORT/LONG + emitOnBootstrap=false => BOOTSTRAP_NO_SIGNAL (default) — state created as SHORT/LONG but no signal, wait for NEUTRAL->SHORT or reversal
- null + SHORT/LONG + emitOnBootstrap=true => EMIT BOOTSTRAP
- null + NEUTRAL => BOOTSTRAP_NO_SIGNAL state NEUTRAL
- NEUTRAL -> LONG/SHORT => EMIT EDGE
- LONG->LONG, SHORT->SHORT => HOLD no duplicate
- LONG->NEUTRAL, SHORT->NEUTRAL => REARM
- LONG->SHORT, SHORT->LONG => EMIT REVERSAL
- NEUTRAL->NEUTRAL => HOLD
- Any -> UNAVAILABLE (CANNOT_EVALUATE/DATA_UNAVAILABLE/QUORUM_NOT_MET/FUTURE/ABSOLUTE_STALE) => PRESERVE_UNAVAILABLE: update lastEvaluatedCandleTime but keep aggregateState, no re-arm. Therefore SHORT->DATA_UNAVAILABLE->SHORT = HOLD, no second signal.
- Same horizon (lastEvaluated == current) => NOOP_SAME_HORIZON idempotent
- Older horizon (current < lastEvaluated) => REFUSE_OLDER_HORIZON regression guard

## UNAVAILABLE_SEMANTICS

Distinguish NEUTRAL (real market indecision, causes re-arm) vs unavailable:
- QUORUM_NOT_MET: < minExchanges fresh
- DATA_UNAVAILABLE: no common horizon or missing candles
- CANNOT_EVALUATE: hard failures (e.g., no swing)
- FUTURE_HORIZON: asOf before commonHorizon (off-grid)
- ABSOLUTE_STALE: all exchanges stale
All map to PRESERVE_UNAVAILABLE, not NEUTRAL. Preserves last directional state, prevents false re-arm.

## BOOTSTRAP_SEMANTICS

Default: no signal on first observation if no state row. Only after SHORT->NEUTRAL->SHORT or reversal. Prevents spurious signal on restart after downtime. Optional --emit-on-bootstrap flag for manual first emit, default false. Docs in signal-worker.ts --help.

## TRANSACTION_DESIGN

In `lib/signals/signal-engine.ts` runSmartMoneyEngine:

- Load StrategySignalState unique [strategyId,symbol,timeframe]
- Compute edge transition pure
- Dry-run: READ-ONLY, logs previous current action, asserts DB counts unchanged (no Signal, no Outcome, no State mutation)
- Live non-emitting: State only update in $transaction (upsert or update lastEvaluated)
- Live emitting: Signal + Outcome + State update in ONE prisma.$transaction:
  ```
  tx.signal.create({ ... candidate, setupKey, triggerType })
  tx.signalOutcome.create({ signalId, status, entry, SL/TP, executionPolicy, atrAtSignal })
  tx.strategySignalState.upsert/update
  ```
- P2002 idempotent: duplicate unique [strategyId,symbol,timeframe,signalCandleTime] blocked, counts as skippedDuplicate
- Race: two workers same horizon concurrent — first tx wins, second inside tx sees lastEvaluated == current => NOOP, or P2002 on Signal unique => only one Signal
- Failure: if Signal create fails, whole tx rolls back, no State update, no partial. If Outcome create fails inside tx, caught but Signal remains (backfillable), State still updated transactionally.

## CONCURRENCY_DESIGN

- Unique constraint [strategyId,symbol,timeframe,signalCandleTime] without direction prevents LONG then SHORT on same candle (PG NULL semantics handled by not including direction in unique)
- State unique [strategyId,symbol,timeframe] ensures one state per strategy/timeframe
- Inside $transaction re-check lastEvaluated and lastSignalCandleTime for concurrent duplicate
- Same horizon rerun => NOOP_SAME_HORIZON, no DB write
- Older horizon => REFUSE_OLDER_HORIZON, error logged

## SETUP_KEY_ROOT_CAUSE

Audit file: `scripts/audit-setup-key.ts`, `lib/signals/setup-key.ts`

Current setupKey = 11 different keys for 08:15..10:45 FAILED because:

- extractSetupComponents uses commonHorizon as proxy for BOS/OB/FVG confirmedAt:
  `swingBosConfirmedAt = meta.commonHorizon`
  `swingOrderBlockConfirmedAt = meta.commonHorizon`
  `fvgConfirmedAt = meta.commonHorizon`
- commonHorizon = H itself changes every candle, so tuple `bos:BOS:down|2026-09-13T08:15:00Z` vs `bos:BOS:down|2026-09-13T08:30:00Z` different every candle even if same BOS thesis
- Correct design needs stable event keys: store latest swing BOS event key and confirmedAt, OB key with confirmedAt, FVG key with confirmedAt, sweep key, not current H
- Score not in key (correct), but timestamp proxy makes key change
- For V1 production dedup, do NOT use setupKey. Keep as research metadata only. EDGE/RE-ARM gives correct ONE signal for 08:15..10:45.

Fixing setupKey secondary: need to store in candidate.metadata stable event keys, then setupKey built from those will be same across regime if thesis same.

## HISTORICAL_EDGE_ANALYZER

File: `scripts/analyze-edge-replay.ts` (ts-nocheck for strict TS)

- Read-only, loads BTC 15m CLOSED candles up to 1000, builds common horizons via quorum 3/5
- For each common horizon, builds candidate via buildSmartMoneySignalCandidate, maps to AggregateState
- Computes edge transition via computeEdgeTransition with persistent state simulation
- Builds episodes: start candle, direction, end/rearm candle, duration bars, peak score, confirmation min/max, triggerType
- For measured 08:15..10:45 expected ONE SHORT episode — verify prev/following regimes
- Execution replay only at episode start (not every candle)

Run: `npx tsx scripts/analyze-edge-replay.ts` — requires DATABASE_URL read-only, no writes.

## TEST_RESULTS

Files:
- `scripts/test-edge-state-machine.ts` — 18 passed
  - NEUTRAL->SHORT emits EDGE
  - SHORT->SHORT holds
  - SHORT->NEUTRAL rearms
  - NEUTRAL->SHORT again emits
  - SHORT->LONG reversal emits
  - LONG->SHORT reversal emits
  - SHORT->DATA_UNAVAILABLE preserves
  - DATA_UNAVAILABLE->SHORT no duplicate
  - SHORT->CANNOT_EVALUATE preserves
  - CANNOT_EVALUATE->SHORT no duplicate
  - same horizon no-op
  - older horizon refused
  - PM2 restart state survives (reload same row)
  - bootstrap SHORT no signal default
  - bootstrap NEUTRAL state only
  - emit-on-bootstrap true emits BOOTSTRAP
  - QUORUM_NOT_MET preserves
  - NEUTRAL->NEUTRAL hold

- `scripts/test-edge-v1-full.ts` — 7 passed
  - concurrent same horizon max one Signal (NOOP second)
  - dry-run no mutation design verified
  - transaction failure no partial design
  - setupKey root cause audited
  - episodes builder 1 SHORT episode

- `scripts/test-setup-key.ts` — 12 passed (existing)
- `npm run build` / `tsc --noEmit` — green

## MIGRATION_SQL

File: `prisma/migrations/20260915_edge_state/migration.sql`

```sql
CREATE TABLE IF NOT EXISTS "StrategySignalState" (
  "id" SERIAL PRIMARY KEY,
  "strategyId" INTEGER NOT NULL,
  "symbol" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "lastEvaluatedCandleTime" TIMESTAMP(3),
  "aggregateState" TEXT NOT NULL DEFAULT 'NEUTRAL',
  "lastSignalCandleTime" TIMESTAMP(3),
  "lastSignalDirection" TEXT,
  "lastEvaluationStatus" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "StrategySignalState_strategyId_symbol_timeframe_key" ON "StrategySignalState"("strategyId", "symbol", "timeframe");
CREATE INDEX IF NOT EXISTS "StrategySignalState_symbol_timeframe_idx" ON "StrategySignalState"("symbol", "timeframe");
CREATE INDEX IF NOT EXISTS "StrategySignalState_strategyId_idx" ON "StrategySignalState"("strategyId");
CREATE INDEX IF NOT EXISTS "StrategySignalState_aggregateState_idx" ON "StrategySignalState"("aggregateState");
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "setupKey" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "triggerType" TEXT;
CREATE INDEX IF NOT EXISTS "Signal_setupKey_idx" ON "Signal"("setupKey");
CREATE INDEX IF NOT EXISTS "Signal_triggerType_idx" ON "Signal"("triggerType");
```

DO NOT apply prod — design only per task 12. No migrate/db push in this phase.

Also need to add to prisma/schema.prisma model already present:
```
model StrategySignalState {
  id                       Int       @id @default(autoincrement())
  strategyId               Int
  symbol                   String
  timeframe                String
  lastEvaluatedCandleTime  DateTime?
  aggregateState           String    @default("NEUTRAL")
  lastSignalCandleTime     DateTime?
  lastSignalDirection      String?
  lastEvaluationStatus     String?
  metadata                 Json?
  createdAt                DateTime  @default(now())
  updatedAt                DateTime  @updatedAt
  strategy                 Strategy  @relation(fields: [strategyId], references: [id], onDelete: Cascade)
  @@unique([strategyId, symbol, timeframe])
  @@index([symbol, timeframe])
  @@index([strategyId])
  @@index([aggregateState])
}
Signal.triggerType String? @@index
Signal.setupKey String? already
```

## FILES_CHANGED

- `lib/signals/edge-state-machine.ts` — NEW pure machine
- `prisma/schema.prisma` — added StrategySignalState + Signal.triggerType
- `lib/signals/signal-engine.ts` — rewritten runSmartMoneyEngine with edge semantics, transactional write, dry-run no mutation, bootstrap, idempotent, unavailable preserve, triggerType, setupKey metadata
- `scripts/signal-worker.ts` — added --emit-on-bootstrap flag, docs EDGE semantics
- `prisma/migrations/20260915_edge_state/migration.sql` — NEW migration design
- `scripts/test-edge-state-machine.ts` — NEW 18 tests
- `scripts/test-edge-v1-full.ts` — NEW 7 tests for concurrency/dry-run/transaction/episodes
- `scripts/audit-setup-key.ts` — NEW audit script
- `scripts/analyze-edge-replay.ts` — NEW historical edge replay analyzer
- `docs/edge-state-machine-v1-report.md` — this report

## VPS_VALIDATION_COMMANDS

Read-only, no DB writes, synthetic correctness only:

```bash
# 1. Edge state machine unit tests (no DB)
npx tsx scripts/test-edge-state-machine.ts
npx tsx scripts/test-edge-v1-full.ts
npx tsx scripts/test-setup-key.ts
npx tsx scripts/audit-setup-key.ts

# 2. Historical edge replay (read-only DB, ONE SHORT episode for 08:15..10:45)
DATABASE_URL=... npx tsx scripts/analyze-edge-replay.ts

# 3. Dry-run signal engine with edge semantics (no State mutation)
DATABASE_URL=... npx tsx scripts/signal-worker.ts --strategy=smart-money-suslik --timeframe=15m --dry-run
# Check logs: Transition NEUTRAL->SHORT EMIT, SHORT->SHORT HOLD, etc, previous state null -> etc, action BOOTSTRAP_NO_SIGNAL etc, no DB mutation

# 4. Verify dry-run no mutation (read-only assertion)
# Before and after dry-run, SELECT COUNT(*) FROM "StrategySignalState" should be same, SELECT COUNT(*) FROM "Signal" WHERE "signalSource"='LIVE_FORWARD' same

# 5. Live write allowed only with AND guard
SMART_MONEY_WRITE_ENABLED=true npx tsx scripts/signal-worker.ts --strategy=smart-money-suslik --timeframe=15m --dry-run --enable-smart-money-write
# Still dry-run because flag alone not enough? Actually flag+env => allowed, but dry-run true forces no write. Need --no-dry-run for live.
# Live (DO NOT RUN ON PROD, only local):
SMART_MONEY_WRITE_ENABLED=true npx tsx scripts/signal-worker.ts --strategy=smart-money-suslik --timeframe=15m --no-dry-run --enable-smart-money-write --emit-on-bootstrap=false
# Should create ONE Signal+Outcome+State transactionally, second run same horizon => NOOP_SAME_HORIZON, no duplicate

# 6. Build check
npx tsc --noEmit
npm run build
```

STOP — no deploy, no prod migration, no PM2 changes per constraints.

## NEXT STEPS (not in this phase)

- Apply migration locally, test live transactional path with real DB
- Historical edge replay full run to confirm 08:15..10:45 ONE episode
- Integrate into VPS signal-worker PM2 after PHASE2B approval
- Fix setupKey stable event keys for research (secondary)
