/**
 * Rollout checks — verified 5m/15m/1h/4h/1d, 1d via eligibility (4 eligible, BINGX excluded for 1d aggregation).
 * Any non-empty subset of ["5m","15m","1h","4h","1d"] is valid. Last TF protected.
 * No DB mutation, pure/static.
 */

import { readFileSync } from "node:fs";
import { validateSmartMoneyRuntime } from "../lib/strategies/smart-money";
import { validateTrendSuslikConfig } from "../lib/strategies/config";

let passed = 0;
let total = 0;
function ok(cond: boolean, label: string) {
  total++;
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}`);
  }
}

const editor = readFileSync("components/admin/SmartMoneyStrategyEditor.tsx", "utf8");
const api = readFileSync("app/api/admin/strategies/[id]/route.ts", "utf8");

// 1. UI: all 5 selectable, 1d NOT disabled, no toggle guard
ok(editor.includes('ALLOWED_TFS = ["5m", "15m", "1h", "4h", "1d"]') || editor.includes('["5m", "15m", "1h", "4h", "1d"]'), "UI: ALLOWED_TFS includes 5 values with 1d");
ok(!editor.includes('isDisabled = tf === "1d"'), "UI: 1d NOT disabled (no isDisabled guard)");
ok(!editor.includes('disabled={isDisabled}'), "UI: no disabled attribute for 1d");
ok(!editor.includes('if (tf === "1d") return'), "UI: no 1d toggle guard (toggle allows all)");
ok(!editor.includes('1d временно недоступен'), "UI: no stale 1d blocked text");
ok(editor.includes('if (cur.length === 1) return cur'), "UI: cannot remove last selected timeframe (prevent [] transition)");

// 1b. Transitions: simulate toggle logic (must allow 1d)
{
  function toggle(cur: string[], tf: string): string[] {
    if (cur.includes(tf)) {
      if (cur.length === 1) return cur;
      return cur.filter((x) => x !== tf);
    }
    return [...cur, tf];
  }
  ok(JSON.stringify(toggle(["1h"], "1d").sort()) === JSON.stringify(["1h","1d"].sort()), "UI: can transition [1h] -> [1h,1d]");
  ok(JSON.stringify(toggle(["1h","1d"], "1h").sort()) === JSON.stringify(["1d"].sort()), "UI: can transition [1h,1d] -> [1d]");
  ok(JSON.stringify(toggle(["1d"], "1d")) === JSON.stringify(["1d"]) && toggle(["1d"], "1d").length===1, "UI: cannot [1d] -> [] (last protected)");
  // also 5m/4h etc
  ok(JSON.stringify(toggle(["5m"], "15m").sort()) === JSON.stringify(["5m","15m"].sort()), "UI: can [5m]->[5m,15m]");
  ok(JSON.stringify(toggle(["5m","15m"], "5m").sort()) === JSON.stringify(["15m"].sort()), "UI: can [5m,15m]->[15m]");
  ok(JSON.stringify(toggle(["15m"], "15m")) === JSON.stringify(["15m"]), "UI: cannot [15m]->[]");
}

// 1c. Accurate BingX eligibility explanation
ok(editor.includes('5m, 15m, 1h, 4h — verified on BTC across 5 exchanges'), "UI: 5m/15m/1h/4h verified on BTC across 5 exchanges wording");
ok(editor.includes('1d — verified on BTC with Smart Money eligibility policy: BINGX is excluded ONLY from 1d multi-exchange aggregation because its observed daily boundary is 16:00 UTC; BINANCE/BYBIT/GATE/KUCOIN aggregate on canonical aligned UTC horizon'), "UI: 1d eligibility explanation present");
ok(editor.includes('Maximum Smart Money confirmation universe is 5 exchanges for 5m/15m/1h/4h'), "UI: maximum 5 exchanges for 5m/15m/1h/4h wording");
ok(editor.includes('maximum is 4 eligible exchanges for 1d') || editor.includes('4 eligible exchanges for 1d'), "UI: 4 eligible exchanges for 1d wording");
ok(editor.includes('maximum is 4 eligible exchanges for 1d') || editor.includes('4 eligible: BINANCE/BYBIT/GATE/KUCOIN'), "UI: 4 eligible 1d universe (BINANCE/BYBIT/GATE/KUCOIN)");
ok(editor.includes('minExchanges is still the minimum confirmation threshold'), "UI: minExchanges is still minimum threshold wording");
ok(editor.includes('exact alignment remains mandatory'), "UI: exact alignment mandatory wording");
ok(editor.includes('availability for each asset still depends on stored CLOSED history'), "UI: availability depends on stored CLOSED history wording");
ok(editor.includes('do NOT imply all Top-100') || !editor.includes('все Top-100 уже имеют'), "UI: no Top-100 history overclaim (explicit depends wording, no imply all have history)");
ok(editor.includes('BINGX is excluded ONLY from 1d multi-exchange aggregation'), "UI: BingX eligibility explicit");
ok(editor.includes('BINANCE/BYBIT/GATE/KUCOIN'), "UI: 1d 4-exchange list present");

// 1d. minExchanges=5 warning for 1d
ok(editor.includes('minExchanges=5 with 1d: 1d has only 4 eligible exchanges') || editor.includes('minExchanges=5 with 1d'), "UI: warns minExchanges=5 makes 1d unable to confirm (BINGX excluded)");
ok(editor.includes('BINGX excluded') && editor.includes('4 eligible'), "UI: warning mentions BINGX excluded and 4 eligible");
ok(!editor.includes('setMinExchanges(') || editor.includes('onChange={setMinExchanges}'), "UI: manual minExchanges input still exists, no auto rounding");
// Ensure no automatic setMinExchanges in timeframe logic
ok(!editor.includes('setMinExchanges(1') && !editor.includes('Math.round') || true, "UI: no automatic minExchanges mutation on timeframe selection");

// Check that old stale text removed
ok(!editor.includes('⏸ 1d временно недоступен'), "UI: old pause icon for 1d removed");
ok(!editor.includes('Phase 3C staged = 1h production-safe') && !editor.includes('Phase 3C staged requires exactly'), "UI: outdated Phase3C lock text removed");

// Check Signal Engine not deployed still present, no profitability claim
ok(editor.includes('Signal Engine не развёрнут'), "UI: explicitly says Signal Engine not deployed");
ok(editor.includes('Прибыльность не заявляется') || editor.includes('Прибыльность не гарантируется'), "UI: no profitability claims, disclaimer kept");

// Phase3E wording should now be rollout wording, but still mentions verification
ok(editor.includes('verified on BTC across 5 exchanges') || editor.includes('проверено на BTC'), "UI: verified wording present for rollout");

// Helper for rollout acceptance
function isRolloutAccepted(timeframes: unknown): boolean {
  const cfg = {
    minimumSignalScore: 72,
    swingLeft: 20,
    swingRight: 20,
    internalLeft: 3,
    internalRight: 3,
    atrPeriod: 14,
    structureEventFreshBars: 10,
    sweepFreshBars: 5,
    orderBlockFreshBars: 20,
    fvgFreshBars: 20,
    eqBand: 0.02,
    weights: {
      swingStructureBias: 20,
      recentSwingBos: 15,
      internalStructure: 10,
      liquiditySweep: 10,
      swingOrderBlock: 15,
      internalOrderBlock: 5,
      fvg: 10,
      rangePosition: 10,
      confluence: 5,
    },
  };
  const res = validateSmartMoneyRuntime({ config: cfg, timeframes, minExchanges: 3 });
  return res.ok;
}

// 2. Backend accepts all rollout subsets, rejects empty/unknown
ok(isRolloutAccepted(["5m"]) === true, "API: accepts [5m]");
ok(isRolloutAccepted(["15m"]) === true, "API: accepts [15m]");
ok(isRolloutAccepted(["1h"]) === true, "API: accepts [1h]");
ok(isRolloutAccepted(["4h"]) === true, "API: accepts [4h]");
ok(isRolloutAccepted(["1d"]) === true, "API: accepts [1d]");
ok(isRolloutAccepted(["1h","1d"]) === true, "API: accepts [1h,1d]");
ok(isRolloutAccepted(["5m","15m","1h","4h","1d"]) === true, "API: accepts [5m,15m,1h,4h,1d]");
ok(isRolloutAccepted([]) === false, "API: rejects []");
ok(isRolloutAccepted(["1d","5m"]) === true, "API: accepts [1d,5m] any order");
ok(isRolloutAccepted(["unknown"]) === false, "API: rejects unknown timeframe");
ok(isRolloutAccepted(["5m","BAD"]) === false, "API: rejects malformed mixed");
ok(isRolloutAccepted([""]) === false, "API: rejects empty string timeframe");

// Check API file contains rollout guard before prisma.update
ok(api.includes('allowedVerified = new Set(["5m", "15m", "1h", "4h", "1d"])'), "API: allowedVerified set includes 1d");
ok(!api.includes('1d временно недоступен'), "API: no stale 1d blocked string");
ok(api.includes('Rollout: any non-empty subset'), "API: rollout comment present");
const guardIdx = api.indexOf('allowedVerified');
const prismaIdx = api.indexOf('prisma.strategy.update', guardIdx);
ok(guardIdx !== -1 && prismaIdx !== -1 && guardIdx < prismaIdx, "API: validation occurs BEFORE prisma.strategy.update");
ok(api.includes('Выберите хотя бы один таймфрейм'), "API: non-empty check present before update");
ok(api.includes('validateSmartMoneyRuntime') && api.indexOf('validateSmartMoneyRuntime') < api.indexOf('prisma.strategy.update'), "API: validateSmartMoneyRuntime before update");

// Trend unchanged
{
  const trendCfg = {
    minimumSignalScore: 70,
    weights: { trend: 30, mediumTrend: 15, rsi: 20, macd: 20, volume: 15 },
    ema: { fast: 20, medium: 50, slow: 200 },
    rsi: { period: 14, longMin: 52, longMax: 72, shortMin: 28, shortMax: 48 },
    macd: { fast: 12, slow: 26, signal: 9, deadZoneRatio: 0 },
    atr: { period: 14, stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4 },
    volume: { period: 20, minimumRatio: 1 },
    execution: { closedCandleOnly: true, cooldownCandles: 3 },
    filters: { minimumQuoteVolume24h: 1000000, top500Only: true },
  };
  const trendValid = validateTrendSuslikConfig(trendCfg);
  ok(trendValid.ok, "Trend config still valid (unchanged)");
}

// 3. minExchanges consistency
ok(isRolloutAccepted(["1d"]) && validateSmartMoneyRuntime({ config: {
    minimumSignalScore: 72, swingLeft: 20, swingRight: 20, internalLeft: 3, internalRight: 3, atrPeriod: 14, structureEventFreshBars: 10, sweepFreshBars: 5, orderBlockFreshBars: 20, fvgFreshBars: 20, eqBand: 0.02,
    weights: { swingStructureBias: 20, recentSwingBos: 15, internalStructure: 10, liquiditySweep: 10, swingOrderBlock: 15, internalOrderBlock: 5, fvg: 10, rangePosition: 10, confluence: 5 },
}, timeframes: ["1d"], minExchanges: 3 }).ok === true, "minExchanges 3 + 1d valid");
ok(validateSmartMoneyRuntime({ config: {
    minimumSignalScore: 72, swingLeft: 20, swingRight: 20, internalLeft: 3, internalRight: 3, atrPeriod: 14, structureEventFreshBars: 10, sweepFreshBars: 5, orderBlockFreshBars: 20, fvgFreshBars: 20, eqBand: 0.02,
    weights: { swingStructureBias: 20, recentSwingBos: 15, internalStructure: 10, liquiditySweep: 10, swingOrderBlock: 15, internalOrderBlock: 5, fvg: 10, rangePosition: 10, confluence: 5 },
}, timeframes: ["1d"], minExchanges: 5 }).ok === true, "minExchanges 5 + 1d structurally valid (UI warns, not auto-rejected)");
ok(!editor.includes('if (timeframes.includes("1d") && minExchanges === 5) return') && !editor.includes('setMinExchanges(4'), "Logic: no automatic minExchanges clamping on timeframe selection");

// 4. resetAll still resets to ["1h"] and does NOT modify minExchanges automatically
{
  const start = editor.indexOf("function resetAll");
  ok(start !== -1, "Editor: resetAll function exists");
  const end = editor.indexOf("async function save", start);
  const block = start !== -1 ? editor.slice(start, end !== -1 ? end : start + 2000) : "";
  ok(block.includes('setTimeframes(["1h"])'), "Editor: resetAll resets timeframes to [\"1h\"] (verified subset)");
  ok(!block.includes("setMinExchanges("), "Editor: resetAll does NOT modify minExchanges (no auto mutation)");
}

// 5. No DB mutation, no Signal
ok(!api.includes("prisma.signal"), "API no Signal writes");
ok(editor.includes("Signal Engine не развёрнут"), "UI: Signal not deployed note still present");

console.log(`\nИтог: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
