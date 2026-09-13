# EDGE/RE-ARM SIGNAL SEMANTICS V1 — FINAL REPORT + STRICT ATOMIC FIX

Date: 2026-09-13
Branch: arena/01a09726-svechnoy-suslik (from 51eb129dea6a36ac077770d57859837769ece705, prod d6c573c20a11e79e26153579575818f1dada2f96 untouched)

## VPS VALIDATION (previous phase, read-only)

- RAW qualified 15m = 11 consecutive SHORT 08:15..10:45 every candle
- EDGE_TRIGGER = 1 at 08:15
- Current SETUP_KEY = 11 different keys FAILED
- Corrected RAW replay TP1 81.8% TP2 63.6% TP3 18.2% avg R -0.33 PF 0.59 but RAW not independent
- First EDGE 08:15 NEXT_BAR_OPEN 77026.62 TP3 R+2.6667 bars=1 ONE observed setup only

## CRITICAL FIX — STRICT ATOMICITY

Previous version had inconsistency:
"Signal+Outcome+State in ONE $transaction" + "Outcome failure caught but Signal remains backfillable" — incompatible guarantees.

FIXED to STRICT ATOMIC:

```ts
await prisma.$transaction(async tx => {
  const signal = await tx.signal.create(...)
  await tx.signalOutcome.create(...) // if throws, whole tx rolls back, no catch inside
  await tx.strategySignalState.update/upsert(...) // if throws, all rollback
})
// P2002 handling only OUTSIDE transaction — idempotent duplicate
// Other DB errors not suppressed
```

Test `scripts/test-transaction-atomicity.ts` stateful fake:
1. Signal succeeds, Outcome throws => Assert Signal count 0, Outcome 0, State 0 after rollback
2. Signal+Outcome succeed, State throws => Assert all 0 after rollback
3. Happy path => all 1 committed

Result 9 passed.

## EDGE_STATE_MACHINE V1

File: `lib/signals/edge-state-machine.ts` pure, no DB, no scoring change.

AggregateState: NEUTRAL/LONG/SHORT/CANNOT_EVALUATE/DATA_UNAVAILABLE/QUORUM_NOT_MET/FUTURE_HORIZON/ABSOLUTE_STALE
EdgeAction: EMIT/REARM/HOLD/PRESERVE_UNAVAILABLE/BOOTSTRAP_NO_SIGNAL/NOOP_SAME_HORIZON/REFUSE_OLDER_HORIZON
TriggerType: EDGE/REVERSAL/BOOTSTRAP/null

Transitions:
- null + SHORT/LONG + emitOnBootstrap=false => BOOTSTRAP_NO_SIGNAL default
- null + SHORT/LONG + emitOnBootstrap=true => EMIT BOOTSTRAP
- null + NEUTRAL => BOOTSTRAP_NO_SIGNAL
- NEUTRAL->LONG/SHORT => EMIT EDGE
- LONG->LONG, SHORT->SHORT => HOLD
- LONG->NEUTRAL, SHORT->NEUTRAL => REARM
- LONG->SHORT, SHORT->LONG => EMIT REVERSAL
- NEUTRAL->NEUTRAL => HOLD
- Any->UNAVAILABLE => PRESERVE_UNAVAILABLE (SHORT->DATA_UNAVAILABLE->SHORT = HOLD no duplicate)
- Same horizon => NOOP_SAME_HORIZON
- Older horizon => REFUSE_OLDER_HORIZON

## UNAVAILABLE_SEMANTICS

QUORUM_NOT_MET, DATA_UNAVAILABLE, CANNOT_EVALUATE, FUTURE_HORIZON, ABSOLUTE_STALE => PRESERVE_UNAVAILABLE, not NEUTRAL. Prevents false re-arm.

## BOOTSTRAP_SEMANTICS

Default no signal on first observation. Only after SHORT->NEUTRAL->SHORT or reversal. Optional --emit-on-bootstrap flag default false.

## TRANSACTION_DESIGN (STRICT)

- Load StrategySignalState unique [strategyId,symbol,timeframe]
- Compute edge transition pure
- Dry-run READ-ONLY no State mutation
- Live non-emitting: State only update in $transaction
- Live emitting: Signal+Outcome+State in ONE prisma.$transaction STRICT ATOMIC, no try/catch inside tx callback, exception bubbles out => full rollback
- P2002 handling only outside transaction, classified as idempotent duplicate
- Race: two workers same horizon concurrent — first tx wins, second sees lastEvaluated==current => NOOP or P2002 => only one Signal
- Failure: any of three throws => all rollback, no partial

## CONCURRENCY_DESIGN

- Unique [strategyId,symbol,timeframe,signalCandleTime] without direction
- State unique [strategyId,symbol,timeframe]
- Inside $transaction re-check lastEvaluated and lastSignalCandleTime
- Same horizon => NOOP_SAME_HORIZON
- Older => REFUSE_OLDER_HORIZON

## SETUP_KEY_ROOT_CAUSE

Uses commonHorizon as proxy for BOS/OB/FVG confirmedAt => changes every candle even same thesis. For V1, setupKey research metadata only, not production dedup. EDGE/RE-ARM gives ONE signal for 08:15..10:45.

## HISTORICAL_EDGE_ANALYZER

`scripts/analyze-edge-replay.ts` read-only, builds episodes start/direction/end/rearm durationBars peakScore confirmation trigger. Expected ONE SHORT episode for 08:15..10:45.

## TEST_RESULTS

- `test-edge-state-machine.ts` 18 passed
- `test-edge-v1-full.ts` 7 passed (strict atomic design)
- `test-transaction-atomicity.ts` 9 passed (fake DB rollback verification)
- `test-setup-key.ts` 12 passed
- `tsc --noEmit` green

## MIGRATION_SQL

`prisma/migrations/20260915_edge_state/migration.sql` design only, DO NOT apply prod.

## FILES_CHANGED

- `lib/signals/edge-state-machine.ts` — NEW pure machine
- `lib/signals/signal-engine.ts` — STRICT ATOMIC fix: no catch inside tx, P2002 outside only
- `prisma/schema.prisma` — StrategySignalState + triggerType
- `scripts/signal-worker.ts` — --emit-on-bootstrap
- `prisma/migrations/20260915_edge_state/migration.sql` — NEW
- `scripts/test-edge-state-machine.ts` — 18 tests
- `scripts/test-edge-v1-full.ts` — 7 tests strict atomic
- `scripts/test-transaction-atomicity.ts` — 9 tests atomic rollback
- `scripts/audit-setup-key.ts`, `analyze-edge-replay.ts`
- `docs/edge-state-machine-v1-report.md`

## VPS_VALIDATION_COMMANDS

```bash
npx tsx scripts/test-edge-state-machine.ts
npx tsx scripts/test-edge-v1-full.ts
npx tsx scripts/test-transaction-atomicity.ts
DATABASE_URL=... npx tsx scripts/analyze-edge-replay.ts
DATABASE_URL=... npx tsx scripts/signal-worker.ts --strategy=smart-money-suslik --timeframe=15m --dry-run
npx tsc --noEmit
```

STOP — no deploy, no prod migration.
