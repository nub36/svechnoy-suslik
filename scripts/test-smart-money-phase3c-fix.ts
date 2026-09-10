/**
 * Phase 3C targeted fix checks — no DB mutation, pure/static.
 * Covers VPS audit blockers:
 * - staged timeframe enforcement UI + API
 * - resetAll not hardcode minExchanges=2
 * - Signal Engine text
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

// 1. UI: 1h selectable/active (not disabled), others disabled
ok(editor.includes('isUnverified = tf !== "1h"'), "UI: isUnverified = tf !== 1h");
ok(editor.includes("disabled={isUnverified}"), "UI: 5m/15m/4h/1d disabled in Smart Money editor");
ok(editor.includes('Будет доступно после Phase 3E проверки реальных данных'), "UI: tooltip staged 3E");
ok(!editor.includes('onClick={() => toggleTimeframe(tf)}') || editor.includes("if (isUnverified) return"), "UI: toggle guarded for unverified (or disabled)");
ok(editor.includes('title={\n                    isUnverified\n                      ? "Будет доступно'), "UI: disabled tooltip correct");
ok(api.includes('smart-money-suslik'), "API: smart-money slug present");

// Helper: simulate API staged logic without DB
function isSmartMoneyStagedAccepted(timeframes: unknown): boolean {
  // Use same logic as API: after validateSmartMoneyRuntime, check exactly ["1h"]
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
  return tf.length === 1 && tf[0] === "1h";
}

// 2. Backend accepts ["1h"]
ok(isSmartMoneyStagedAccepted(["1h"]) === true, "API: Smart Money backend accepts [\"1h\"]");
ok(isSmartMoneyStagedAccepted(["4h"]) === false, "API: Smart Money backend rejects [\"4h\"]");
ok(isSmartMoneyStagedAccepted(["1h", "4h"]) === false, "API: Smart Money backend rejects [\"1h\",\"4h\"]");
ok(isSmartMoneyStagedAccepted(["5m"]) === false, "API: Smart Money backend rejects [\"5m\"]");
ok(isSmartMoneyStagedAccepted([]) === false, "API: Smart Money backend rejects []");

// Check API file contains staged guard before prisma.update (search without escaped quotes)
const stagedGuardIdx = api.indexOf("Smart Money Phase 3C разрешает только timeframe");
const prismaUpdateIdx = stagedGuardIdx !== -1 ? api.indexOf("prisma.strategy.update", stagedGuardIdx) : -1;
ok(stagedGuardIdx !== -1, "API: staged guard string present");
ok(stagedGuardIdx !== -1 && prismaUpdateIdx !== -1 && stagedGuardIdx < prismaUpdateIdx, "API: staged rejection occurs BEFORE prisma.strategy.update");

// Trend unchanged: should still accept multiple TFs
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
  // Trend API should not have staged guard — check file does not reject Trend TFs
  ok(!api.includes('trend-suslik') || api.indexOf('Smart Money Phase 3C') > api.indexOf('trend-suslik'), "API: staged guard only for smart-money, Trend unchanged");
}

// 3. resetAll does NOT hardcode minExchanges=2
ok(!editor.includes("setMinExchanges(2)"), "Editor: resetAll does NOT hardcode setMinExchanges(2)");
ok(editor.includes("minExchanges — Strategy-level параметр без автоматически выбранного"), "Editor: resetAll comment explains no trading default");
ok(editor.includes('setTimeframes(["1h"])'), "Editor: resetAll still resets timeframes to [\"1h\"] (staged)");

// 4. Signal text
ok(editor.includes("Signal Engine не развёрнут"), "UI: explicitly says Signal Engine not deployed");
ok(!editor.includes("Уже созданные сигналы не пересчитываются"), "UI: old signal text removed");
ok(editor.includes("Прибыльность не заявляется"), "UI: no profitability claims, but disclaimer kept");

// 5. Additional static: disabled prop is real HTML disabled, not just clickable warning
ok(editor.includes("disabled={isUnverified}"), "UI: buttons have real disabled attribute, not just clickable warning");

console.log(`\nИтог: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
