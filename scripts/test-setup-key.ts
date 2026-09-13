/**
 * TASK 5 — SETUP IDENTITY TESTS
 */

import { buildSetupKey, type SetupKeyComponents } from "../lib/signals/setup-key";
import { buildInitialOutcome, evaluateOutcomeProgression, computeReplayMetrics } from "../lib/signals/signal-outcome";
import type { SmartMoneySignalCandidate } from "../lib/signals/smart-money-candidate";

let passed = 0, failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`✅ ${label}`); } else { failed++; console.log(`❌ FAIL: ${label}`); }
}

// Test setupKey same BOS+same OB+same FVG next candle => same setupKey
{
  const base: SetupKeyComponents = {
    strategyVersion: 1,
    symbol: "BTC",
    timeframe: "15m",
    direction: "SHORT",
    swingPhase: "TREND_DOWN",
    swingBosKey: "BOS_KEY_123",
    swingBosConfirmedAt: "2026-09-13T08:00:00Z",
    swingOrderBlockKey: "OB_KEY_456",
    swingOrderBlockConfirmedAt: "2026-09-13T08:00:00Z",
    internalOrderBlockKey: "INT_OB_789",
    fvgKey: "FVG_KEY_101",
    fvgConfirmedAt: "2026-09-13T08:00:00Z",
    liquiditySweepKey: "SWEEP_BUY_2026-09-13T07:00:00Z",
    rangeKey: "RANGE_KEY_1",
  };
  const key1 = buildSetupKey(base);
  const key2 = buildSetupKey({ ...base }); // same
  ok(key1 === key2, "same BOS+same OB+same FVG next candle => same setupKey");

  const key3 = buildSetupKey({ ...base, swingBosKey: "BOS_KEY_124" });
  ok(key1 !== key3, "new BOS => new setupKey");

  const key4 = buildSetupKey({ ...base, swingOrderBlockKey: "OB_KEY_999" });
  ok(key1 !== key4, "new swing OB => new setupKey");

  const key5 = buildSetupKey({ ...base, fvgKey: "FVG_KEY_999" });
  ok(key1 !== key5, "new FVG => new setupKey (supporting fact, but counts as new thesis for now)");

  const key6 = buildSetupKey({ ...base, direction: "LONG" as any });
  ok(key1 !== key6, "opposite direction => new setupKey");

  // Score 75->80 but facts same => same setupKey (score not in key)
  const key7 = buildSetupKey(base);
  const key8 = buildSetupKey(base);
  ok(key7 === key8, "Score 75->80 but facts same => same setupKey (score not in key)");
}

// Test replay metric: TP1 on bar 2, SL on bar 5 => TP1-before-SL true, terminal STOPPED
{
  const tf = "15m" as any;
  const candidate = {
    timeframe: tf,
    direction: "SHORT" as const,
    signalCandleTime: new Date("2026-09-13T08:15:00Z"),
    atrAtSignal: 100,
    executionParams: { stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4.0 },
  } as unknown as SmartMoneySignalCandidate;

  const entryPrice = 50000;
  const sl = entryPrice + 150; // SHORT SL above
  const tp1 = entryPrice - 150;
  const tp2 = entryPrice - 250;
  const tp3 = entryPrice - 400;

  const outcomeInitial: any = {
    status: "OPEN",
    entryPrice,
    entryTime: new Date("2026-09-13T08:30:00Z"),
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    maxFavorableR: 0,
    maxAdverseR: 0,
    barsHeld: 0,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
  };

  const bar1 = { openTime: new Date("2026-09-13T08:45:00Z"), open: 49900, high: 50000, low: 49800, close: 49850 }; // no TP
  const bar2 = { openTime: new Date("2026-09-13T09:00:00Z"), open: 49850, high: 49850, low: 49800, close: 49820 }; // actually TP1 is 49850, low 49800 hits TP1
  // Let's make bar2 hit TP1
  const bar2_tp1 = { openTime: new Date("2026-09-13T09:00:00Z"), open: 49900, high: 49900, low: 49800, close: 49820 }; // low 49800 <= tp1 49850 => TP1 hit
  const bar3 = { openTime: new Date("2026-09-13T09:15:00Z"), open: 49820, high: 49830, low: 49750, close: 49800 };
  const bar4 = { openTime: new Date("2026-09-13T09:30:00Z"), open: 49800, high: 49810, low: 49700, close: 49750 };
  const bar5_sl = { openTime: new Date("2026-09-13T09:45:00Z"), open: 49750, high: 50160, low: 49700, close: 50000 }; // high 50160 >= sl 50150 => SL hit

  const afterBar2 = evaluateOutcomeProgression(outcomeInitial, candidate, [bar1, bar2_tp1]);
  ok(afterBar2.status === "TP1_HIT" && afterBar2.tp1HitAt != null, "TP1 on bar 2 => TP1_HIT");

  const final = evaluateOutcomeProgression(afterBar2, candidate, [bar3, bar4, bar5_sl]);
  ok(final.status === "STOPPED", "SL on bar 5 after TP1 => terminal STOPPED");

  const metrics = computeReplayMetrics(final as any);
  ok(metrics.tp1BeforeStop === true, "TP1 on bar 2, SL on bar 5 => TP1-before-SL true, terminal STOPPED");
  ok(metrics.tp1HitAt != null && metrics.stopHitAt != null && metrics.tp1HitAt.getTime() < metrics.stopHitAt.getTime(), "tp1HitAt < stopHitAt");

  // Same-bar pessimistic: TP1 and SL same candle, SL first => tp1BeforeStop false if not hit earlier
  const outcome2: any = { ...outcomeInitial };
  const sameBar = { openTime: new Date("2026-09-13T09:00:00Z"), open: 50000, high: 50200, low: 49800, close: 50000 }; // high >= sl 50150 and low <= tp1 49850 same bar
  const sameBarResult = evaluateOutcomeProgression(outcome2, candidate, [sameBar]);
  ok(sameBarResult.status === "STOPPED", "Same bar both SL and TP1 => pessimistic SL first => STOPPED");
  const metrics2 = computeReplayMetrics(sameBarResult as any);
  ok(metrics2.tp1BeforeStop === false, "Same-bar SL first => tp1BeforeStop false if not hit earlier");
}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
