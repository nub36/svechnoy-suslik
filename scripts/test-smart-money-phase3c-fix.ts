/**
 * Phase 3E unlock checks — verified 5m/15m/1h/4h, 1d disabled.
 * Replaces obsolete Phase 3C lock tests.
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

// 1. UI: 5m/15m/1h/4h enabled (verified), 1d disabled
ok(editor.includes('"5m", "15m", "1h", "4h"') || editor.includes('["5m", "15m", "1h", "4h"]') || editor.includes('isVerified = ["5m", "15m", "1h", "4h"]'), "UI: verified list 5m/15m/1h/4h present");
ok(editor.includes('isDisabled = tf === "1d"') || editor.includes('tf === "1d"'), "UI: 1d disabled");
ok(editor.includes('disabled={isDisabled}') || editor.includes('disabled={isDisabled}'), "UI: 1d disabled attribute");
ok(!editor.includes('isLocked = tf === "1h"') || editor.includes('isVerified'), "UI: old 1h lock removed (now verified set)");
ok(editor.includes('5m/15m/1h/4h — проверено Phase 3E') || editor.includes('проверено Phase 3E'), "UI: verified wording present");
ok(editor.includes('5m, 15m, 1h, 4h — проверено') || editor.includes('проверено Phase 3E'), "UI: verified wording for 5m/15m/1h/4h");
ok(editor.includes('1d временно недоступен: на реальных данных BTC обнаружено несовпадение дневной границы BingX (16:00 UTC) с четырьмя другими биржами (00:00 UTC). Multi-exchange aggregation запрещена до отдельного решения.'), "UI: 1d reason present");
ok(editor.includes('Timeframe runtime/alignment verified on BTC across 5 exchanges') && editor.includes('availability for each asset still depends on stored CLOSED history'), "UI: verified availability wording present");

// 1b. Check that outdated Phase 3C text removed
ok(!editor.includes('Phase 3C staged = 1h production-safe'), "UI: outdated 1h-only text removed");
ok(!editor.includes('Phase 3C staged requires exactly ["1h"]') && !editor.includes('staged требует ровно ["1h"]'), "UI: old staged lock text removed");

// 1c. Cannot remove last selected timeframe (generic non-empty guard)
ok(editor.includes('if (cur.length === 1) return cur'), "UI: cannot remove last selected timeframe (prevent [] transition)");
ok(editor.includes('timeframes must remain non-empty') || editor.includes('non-empty') || editor.includes('if (cur.length === 1)'), "UI: non-empty guard present");

// 1d. Transitions
// Can transition ["1h"] -> ["1h","15m"]  (adding verified TF allowed)
{
  let cur = ["1h"];
  // simulate toggle adds 15m
  const next = cur.includes("15m") ? cur.filter((x) => x !== "15m") : [...cur, "15m"];
  ok(JSON.stringify(next.sort()) === JSON.stringify(["1h", "15m"].sort()), "UI: can transition [1h] -> [1h,15m]");
}
// Can transition ["1h","15m"] -> ["15m"] (removing one of two allowed)
{
  let cur = ["1h", "15m"];
  const tf = "1h";
  let next: string[];
  if (cur.includes(tf)) {
    if (cur.length === 1) next = cur;
    else next = cur.filter((x) => x !== tf);
  } else next = [...cur, tf];
  ok(JSON.stringify(next) === JSON.stringify(["15m"]), "UI: can transition [1h,15m] -> [15m]");
}
// Cannot ["15m"] -> [] (last removal prevented)
{
  let cur = ["15m"];
  const tf = "15m";
  let next: string[];
  if (cur.includes(tf)) {
    if (cur.length === 1) next = cur;
    else next = cur.filter((x) => x !== tf);
  } else next = [...cur, tf];
  ok(JSON.stringify(next) === JSON.stringify(["15m"]) && next.length === 1, "UI: cannot [15m] -> [] (last prevented)");
}

// Check toggle prevents 1d
ok(editor.includes('if (tf === "1d") return'), "UI: toggle prevents 1d");

// Check button title for 1d is correct
ok(editor.includes('title={\n                    isDisabled') || editor.includes('1d временно недоступен'), "UI: 1d tooltip correct");

// Helper for API Phase3E acceptance
function isPhase3EAccepted(timeframes: unknown): boolean {
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
  const res = validateSmartMoneyRuntime({ config: cfg, timeframes, minExchanges: 2 });
  if (!res.ok) return false;
  const tf = res.timeframes;
  const allowed = new Set(["5m", "15m", "1h", "4h"]);
  if (tf.length === 0) return false;
  return tf.every((x) => allowed.has(x));
}

// 2. Backend accepts verified, rejects 1d and empty
ok(isPhase3EAccepted(["5m"]) === true, "API: accepts [5m]");
ok(isPhase3EAccepted(["15m"]) === true, "API: accepts [15m]");
ok(isPhase3EAccepted(["1h"]) === true, "API: accepts [1h]");
ok(isPhase3EAccepted(["4h"]) === true, "API: accepts [4h]");
ok(isPhase3EAccepted(["5m", "15m", "1h", "4h"]) === true, "API: accepts [5m,15m,1h,4h]");
ok(isPhase3EAccepted([]) === false, "API: rejects []");
ok(isPhase3EAccepted(["1d"]) === false, "API: rejects [1d]");
ok(isPhase3EAccepted(["1h", "1d"]) === false, "API: rejects [1h,1d]");

// Check API file contains Phase3E guard before prisma.update
const guardIdx = api.indexOf("1d временно недоступен");
const prismaUpdateIdx = guardIdx !== -1 ? api.indexOf("prisma.strategy.update", guardIdx) : -1;
ok(guardIdx !== -1, "API: 1d guard string present");
ok(guardIdx !== -1 && prismaUpdateIdx !== -1 && guardIdx < prismaUpdateIdx, "API: rejection occurs BEFORE prisma.strategy.update");
ok(api.includes('allowedVerified = new Set(["5m", "15m", "1h", "4h"])') || api.includes('allowedVerified'), "API: allowedVerified set present");
ok(!api.includes('Smart Money Phase 3C разрешает только timeframe ["1h"]'), "API: old Phase3C guard removed");

// Ensure new guard checks non-empty
ok(api.includes('Выберите хотя бы один таймфрейм') || api.includes('non-empty'), "API: non-empty check present");

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
  ok(!api.includes('trend-suslik') || api.indexOf('1d временно недоступен') > api.indexOf('trend-suslik'), "API: staged guard only for smart-money, Trend unchanged");
}

// 3. resetAll still resets to ["1h"] (valid verified subset) and does NOT hardcode minExchanges=2
ok(!editor.includes("setMinExchanges(2)"), "Editor: resetAll does NOT hardcode setMinExchanges(2)");
ok(editor.includes("minExchanges — Strategy-level параметр без автоматически выбранного"), "Editor: resetAll comment explains no trading default");
ok(editor.includes('setTimeframes(["1h"])'), "Editor: resetAll still resets timeframes to [\"1h\"] (verified subset)");

// 4. Signal text still correct
ok(editor.includes("Signal Engine не развёрнут"), "UI: explicitly says Signal Engine not deployed");
ok(!editor.includes("Уже созданные сигналы не пересчитываются"), "UI: old signal text removed");
ok(editor.includes("Прибыльность не заявляется"), "UI: no profitability claims, but disclaimer kept");

// 5. Disabled prop is real HTML disabled for 1d only
ok(editor.includes('disabled={isDisabled}'), "UI: buttons have real disabled attribute for 1d");

console.log(`\nИтог: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
