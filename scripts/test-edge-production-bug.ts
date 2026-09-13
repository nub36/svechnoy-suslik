/**
 * REGRESSION TESTS FOR PRODUCTION BUG 16:15 QUORUM_NOT_MET -> SHORT
 *
 * Real production log:
 * 16:31:44 UTC: expectedLatestClosed=16:15 status=quorum_not_met fresh=0 stale=5
 *   previous NEUTRAL lastEvaluated=16:00 current QUORUM_NOT_MET candleTime=16:15 action=PRESERVE_UNAVAILABLE -> lastEvaluated=16:15
 * 16:34:46: same expectedLatestClosed=16:15 status=ok fresh=5
 *   lastEvaluated=16:15 current=16:15 => NOOP_SAME_HORIZON — BUG, data not evaluated after quorum recovered
 *
 * FIX: provisional/unavailable evaluation should allow re-evaluation same horizon when becomes evaluable
 */

import { computeEdgeTransition, type StrategySignalStateRow } from "../lib/signals/edge-state-machine";

let passed = 0, failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`✅ ${label}`); } else { failed++; console.log(`❌ FAIL: ${label}`); }
}

const T16_00 = new Date("2026-09-13T16:00:00Z");
const T16_15 = new Date("2026-09-13T16:15:00Z");

function row(overrides: Partial<StrategySignalStateRow>): StrategySignalStateRow {
  return {
    strategyId: 1,
    symbol: "BTC",
    timeframe: "15m",
    lastEvaluatedCandleTime: null,
    aggregateState: "NEUTRAL",
    lastSignalCandleTime: null,
    lastSignalDirection: null,
    lastEvaluationStatus: null,
    ...overrides,
  };
}

console.log("=== PRODUCTION BUG REGRESSION ===");

// Scenario 1: 16:00 NEUTRAL finalized -> 16:15 QUORUM_NOT_MET -> 16:15 SHORT after data arrival => EMIT EDGE SHORT
{
  const state16_00 = row({ lastEvaluatedCandleTime: T16_00, aggregateState: "NEUTRAL", lastEvaluationStatus: "NEUTRAL" });
  const tr1 = computeEdgeTransition({ previousStateRow: state16_00, currentAggregate: "QUORUM_NOT_MET", currentCandleTime: T16_15 });
  ok(tr1.action === "PRESERVE_UNAVAILABLE", "16:00 NEUTRAL -> 16:15 QUORUM_NOT_MET => PRESERVE");

  // Simulate state after preserve: lastEvaluated=16:15, aggregateState preserved NEUTRAL, lastEvaluationStatus=QUORUM_NOT_MET
  const stateAfterQuorum = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "NEUTRAL", lastEvaluationStatus: "QUORUM_NOT_MET" });
  const tr2 = computeEdgeTransition({ previousStateRow: stateAfterQuorum, currentAggregate: "SHORT", currentCandleTime: T16_15 });
  ok(tr2.action === "EMIT" && tr2.shouldEmit && tr2.emitDirection === "SHORT" && tr2.triggerType === "EDGE", "16:15 QUORUM_NOT_MET (NEUTRAL preserved) -> 16:15 SHORT => EMIT EDGE SHORT (was BUG NOOP)");

  // After final evaluation, repeat same 16:15 SHORT => NOOP
  const stateAfterEmit = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "SHORT", lastSignalCandleTime: T16_15, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" });
  const tr3 = computeEdgeTransition({ previousStateRow: stateAfterEmit, currentAggregate: "SHORT", currentCandleTime: T16_15 });
  ok(tr3.action === "NOOP_SAME_HORIZON", "After final 16:15 SHORT, repeat 16:15 SHORT => NOOP");
}

// Scenario 2: 16:00 SHORT -> 16:15 QUORUM_NOT_MET -> 16:15 SHORT => HOLD
{
  const state16_00 = row({ lastEvaluatedCandleTime: T16_00, aggregateState: "SHORT", lastSignalCandleTime: T16_00, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" });
  const tr1 = computeEdgeTransition({ previousStateRow: state16_00, currentAggregate: "QUORUM_NOT_MET", currentCandleTime: T16_15 });
  ok(tr1.action === "PRESERVE_UNAVAILABLE", "16:00 SHORT -> 16:15 QUORUM_NOT_MET => PRESERVE");

  const stateAfter = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "SHORT", lastSignalCandleTime: T16_00, lastSignalDirection: "SHORT", lastEvaluationStatus: "QUORUM_NOT_MET" });
  const tr2 = computeEdgeTransition({ previousStateRow: stateAfter, currentAggregate: "SHORT", currentCandleTime: T16_15 });
  ok(tr2.action === "HOLD" && !tr2.shouldEmit, "16:15 QUORUM_NOT_MET (SHORT preserved) -> 16:15 SHORT => HOLD no duplicate");

  const stateAfterHold = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "SHORT", lastSignalCandleTime: T16_00, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" });
  const tr3 = computeEdgeTransition({ previousStateRow: stateAfterHold, currentAggregate: "SHORT", currentCandleTime: T16_15 });
  ok(tr3.action === "NOOP_SAME_HORIZON", "After HOLD finalized, repeat 16:15 SHORT => NOOP");
}

// Scenario 3: 16:00 SHORT -> 16:15 QUORUM_NOT_MET -> 16:15 NEUTRAL => REARM
{
  const state16_00 = row({ lastEvaluatedCandleTime: T16_00, aggregateState: "SHORT", lastSignalCandleTime: T16_00, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" });
  const tr1 = computeEdgeTransition({ previousStateRow: state16_00, currentAggregate: "QUORUM_NOT_MET", currentCandleTime: T16_15 });
  ok(tr1.action === "PRESERVE_UNAVAILABLE", "16:00 SHORT -> 16:15 QUORUM_NOT_MET => PRESERVE (scenario 3)");

  const stateAfter = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "SHORT", lastSignalCandleTime: T16_00, lastSignalDirection: "SHORT", lastEvaluationStatus: "QUORUM_NOT_MET" });
  const tr2 = computeEdgeTransition({ previousStateRow: stateAfter, currentAggregate: "NEUTRAL", currentCandleTime: T16_15 });
  ok(tr2.action === "REARM" && !tr2.shouldEmit, "16:15 QUORUM_NOT_MET (SHORT preserved) -> 16:15 NEUTRAL => REARM");

  const stateAfterRearm = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "NEUTRAL", lastSignalCandleTime: T16_00, lastSignalDirection: "SHORT", lastEvaluationStatus: "NEUTRAL" });
  const tr3 = computeEdgeTransition({ previousStateRow: stateAfterRearm, currentAggregate: "NEUTRAL", currentCandleTime: T16_15 });
  ok(tr3.action === "NOOP_SAME_HORIZON", "After REARM finalized, repeat 16:15 NEUTRAL => NOOP");
}

// Scenario 4: unavailable -> unavailable same horizon should be NOOP to avoid churn but not block future evaluable
{
  const stateAfterFirstUnavailable = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "NEUTRAL", lastEvaluationStatus: "QUORUM_NOT_MET" });
  const tr = computeEdgeTransition({ previousStateRow: stateAfterFirstUnavailable, currentAggregate: "DATA_UNAVAILABLE", currentCandleTime: T16_15 });
  ok(tr.action === "NOOP_SAME_HORIZON", "16:15 QUORUM_NOT_MET -> 16:15 DATA_UNAVAILABLE same horizon => NOOP (avoid churn, preserves provisional)");

  // But still allow evaluable after that
  const tr2 = computeEdgeTransition({ previousStateRow: stateAfterFirstUnavailable, currentAggregate: "SHORT", currentCandleTime: T16_15 });
  ok(tr2.shouldEmit, "Still allow evaluable after unavailable->unavailable NOOP");
}

// Scenario 5: evaluable -> unavailable same horizon should NOT overwrite finalized (NOOP preserves finalized)
{
  const stateFinalized = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "SHORT", lastSignalCandleTime: T16_15, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" });
  const tr = computeEdgeTransition({ previousStateRow: stateFinalized, currentAggregate: "QUORUM_NOT_MET", currentCandleTime: T16_15 });
  ok(tr.action === "NOOP_SAME_HORIZON", "Finalized SHORT 16:15 -> QUORUM_NOT_MET same horizon => NOOP preserves finalized, not overwrite with provisional");
}

// Scenario 6: All unavailable types should allow re-evaluation to evaluable
for (const unavailable of ["DATA_UNAVAILABLE", "CANNOT_EVALUATE", "FUTURE_HORIZON", "ABSOLUTE_STALE"] as const) {
  const state = row({ lastEvaluatedCandleTime: T16_15, aggregateState: "NEUTRAL", lastEvaluationStatus: unavailable });
  const tr = computeEdgeTransition({ previousStateRow: state, currentAggregate: "SHORT", currentCandleTime: T16_15 });
  ok(tr.shouldEmit && tr.emitDirection === "SHORT", `${unavailable} same horizon -> SHORT => EMIT (not blocked)`);
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
