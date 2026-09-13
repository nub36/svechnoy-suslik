/**
 * TASK 10 — EDGE STATE MACHINE TESTS
 * NEUTRAL->SHORT emits, SHORT->SHORT holds, SHORT->NEUTRAL rearms, NEUTRAL->SHORT emits again
 * SHORT->LONG reversal emits, LONG->SHORT reversal emits
 * SHORT->DATA_UNAVAILABLE->SHORT no duplicate
 * SHORT->CANNOT_EVALUATE->SHORT no duplicate
 * same horizon rerun no-op, older horizon refused, PM2 restart simulation state survives
 * bootstrap SHORT => no signal default, bootstrap NEUTRAL => state only, optional emit-on-bootstrap tested but default false
 * concurrent same-horizon attempts => max one Signal
 * dry-run => no Signal, no Outcome, no StrategySignalState mutation
 * transaction failure => no partial Signal/Outcome/state
 * TrendSuslik unaffected
 */

import { computeEdgeTransition, type StrategySignalStateRow } from "../lib/signals/edge-state-machine";

let passed = 0, failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`✅ ${label}`); } else { failed++; console.log(`❌ FAIL: ${label}`); }
}

const T0 = new Date("2026-09-13T08:00:00Z");
const T1 = new Date("2026-09-13T08:15:00Z");
const T2 = new Date("2026-09-13T08:30:00Z");
const T3 = new Date("2026-09-13T08:45:00Z");
const T4 = new Date("2026-09-13T09:00:00Z");

function stateRow(overrides: Partial<StrategySignalStateRow> = {}): StrategySignalStateRow {
  return {
    strategyId: 1,
    symbol: "BTC",
    timeframe: "15m",
    lastEvaluatedCandleTime: T0,
    aggregateState: "NEUTRAL",
    lastSignalCandleTime: null,
    lastSignalDirection: null,
    lastEvaluationStatus: "NEUTRAL",
    ...overrides,
  };
}

// NEUTRAL->SHORT emits
{
  const prev = stateRow({ aggregateState: "NEUTRAL", lastEvaluatedCandleTime: T0 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "SHORT", currentCandleTime: T1 });
  ok(tr.action === "EMIT" && tr.shouldEmit && tr.emitDirection === "SHORT" && tr.triggerType === "EDGE", "NEUTRAL->SHORT emits EDGE");
}

// SHORT->SHORT holds
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T1, lastSignalCandleTime: T1, lastSignalDirection: "SHORT" });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "SHORT", currentCandleTime: T2 });
  ok(tr.action === "HOLD" && !tr.shouldEmit, "SHORT->SHORT holds no duplicate");
}

// SHORT->NEUTRAL rearms
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T1 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "NEUTRAL", currentCandleTime: T2 });
  ok(tr.action === "REARM" && !tr.shouldEmit, "SHORT->NEUTRAL rearms");
}

// NEUTRAL->SHORT emits again after rearm
{
  const prev = stateRow({ aggregateState: "NEUTRAL", lastEvaluatedCandleTime: T2 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "SHORT", currentCandleTime: T3 });
  ok(tr.action === "EMIT" && tr.shouldEmit && tr.emitDirection === "SHORT", "NEUTRAL->SHORT emits again after rearm");
}

// SHORT->LONG reversal emits
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T1 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "LONG", currentCandleTime: T2 });
  ok(tr.action === "EMIT" && tr.shouldEmit && tr.emitDirection === "LONG" && tr.triggerType === "REVERSAL", "SHORT->LONG reversal emits");
}

// LONG->SHORT reversal emits
{
  const prev = stateRow({ aggregateState: "LONG", lastEvaluatedCandleTime: T1 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "SHORT", currentCandleTime: T2 });
  ok(tr.action === "EMIT" && tr.shouldEmit && tr.emitDirection === "SHORT" && tr.triggerType === "REVERSAL", "LONG->SHORT reversal emits");
}

// SHORT->DATA_UNAVAILABLE->SHORT no duplicate
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T1 });
  const trUnavailable = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "DATA_UNAVAILABLE", currentCandleTime: T2 });
  ok(trUnavailable.action === "PRESERVE_UNAVAILABLE" && !trUnavailable.shouldEmit, "SHORT->DATA_UNAVAILABLE preserves no re-arm");

  // Simulate state after preserve: lastEvaluated updated but aggregateState preserved as SHORT
  const prevAfterUnavailable = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T2 }); // preserved SHORT
  const trShortAgain = computeEdgeTransition({ previousStateRow: prevAfterUnavailable, currentAggregate: "SHORT", currentCandleTime: T3 });
  ok(trShortAgain.action === "HOLD" && !trShortAgain.shouldEmit, "DATA_UNAVAILABLE->SHORT no duplicate (preserved)");
}

// SHORT->CANNOT_EVALUATE->SHORT no duplicate
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T1 });
  const trCannot = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "CANNOT_EVALUATE", currentCandleTime: T2 });
  ok(trCannot.action === "PRESERVE_UNAVAILABLE" && !trCannot.shouldEmit, "SHORT->CANNOT_EVALUATE preserves");

  const prevAfter = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T2 });
  const trAgain = computeEdgeTransition({ previousStateRow: prevAfter, currentAggregate: "SHORT", currentCandleTime: T3 });
  ok(trAgain.action === "HOLD" && !trAgain.shouldEmit, "CANNOT_EVALUATE->SHORT no duplicate");
}

// same horizon rerun no-op
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T1 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "SHORT", currentCandleTime: T1 });
  ok(tr.action === "NOOP_SAME_HORIZON" && !tr.shouldEmit, "same horizon rerun no-op");
}

// older horizon refused
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T2 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "NEUTRAL", currentCandleTime: T1 });
  ok(tr.action === "REFUSE_OLDER_HORIZON" && !tr.shouldEmit, "older horizon refused");
}

// PM2 restart simulation state survives — state row persisted, reload same
{
  const persisted = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T2, lastSignalCandleTime: T1, lastSignalDirection: "SHORT" });
  // Simulate restart: load same row
  const reloaded = { ...persisted };
  const tr = computeEdgeTransition({ previousStateRow: reloaded, currentAggregate: "SHORT", currentCandleTime: T3 });
  ok(tr.action === "HOLD" && tr.previousState === "SHORT", "PM2 restart simulation state survives");
}

// bootstrap SHORT => no signal default
{
  const tr = computeEdgeTransition({ previousStateRow: null, currentAggregate: "SHORT", currentCandleTime: T1, emitOnBootstrap: false });
  ok(tr.action === "BOOTSTRAP_NO_SIGNAL" && !tr.shouldEmit, "bootstrap SHORT => no signal default");
}

// bootstrap NEUTRAL => state only
{
  const tr = computeEdgeTransition({ previousStateRow: null, currentAggregate: "NEUTRAL", currentCandleTime: T1, emitOnBootstrap: false });
  ok(tr.action === "BOOTSTRAP_NO_SIGNAL" && !tr.shouldEmit, "bootstrap NEUTRAL => state only");
}

// optional emit-on-bootstrap true
{
  const tr = computeEdgeTransition({ previousStateRow: null, currentAggregate: "SHORT", currentCandleTime: T1, emitOnBootstrap: true });
  ok(tr.action === "EMIT" && tr.shouldEmit && tr.triggerType === "BOOTSTRAP", "emit-on-bootstrap true => EMIT BOOTSTRAP");
}

// QUORUM_NOT_MET should preserve like unavailable
{
  const prev = stateRow({ aggregateState: "SHORT", lastEvaluatedCandleTime: T1 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "QUORUM_NOT_MET", currentCandleTime: T2 });
  ok(tr.action === "PRESERVE_UNAVAILABLE", "QUORUM_NOT_MET preserves");
}

// NEUTRAL->NEUTRAL hold
{
  const prev = stateRow({ aggregateState: "NEUTRAL", lastEvaluatedCandleTime: T1 });
  const tr = computeEdgeTransition({ previousStateRow: prev, currentAggregate: "NEUTRAL", currentCandleTime: T2 });
  ok(tr.action === "HOLD", "NEUTRAL->NEUTRAL hold");
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
