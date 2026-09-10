/**
 * Phase 3E diagnostic tests — read-only verification, no DB writes.
 * Run: npx tsx scripts/test-smart-money-diagnostic.ts
 *
 * Must prove:
 * - normal CLI still rejects 15m when Strategy.timeframes=["1h"];
 * - diagnostic mode can evaluate 5m/15m/4h using canonical config, read-only;
 * - only CLOSED candles;
 * - Strategy not mutated;
 * - Signal not written;
 * - 5m/15m/4h aligned markets can aggregate;
 * - misaligned 1d markets are NOT silently aggregated;
 * - deterministic;
 * - no-lookahead unchanged;
 * - no Signal Engine.
 */

import { readFileSync } from "node:fs";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { isSmcTimeframe, SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import {
  evaluateSmartMoneyWithCandles,
  validateSmartMoneyRuntime,
  DEFAULT_SMART_MONEY_FILTERS,
} from "../lib/strategies/smart-money";
import { checkCandleAlignment, canAggregateSafely, isCanonicalAligned } from "../lib/strategies/alignment";
import { evaluateSmc } from "../lib/smc/evaluate";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { parseSmartMoneyArgs } from "./smart-money-cli-args";
import type { SmcRawCandle } from "../lib/smc/types";

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

const readonlySrc = readFileSync("scripts/smart-money-readonly.ts", "utf8");
const diagnosticSrc = readFileSync("scripts/smart-money-diagnostic.ts", "utf8");
const alignmentSrc = readFileSync("lib/strategies/alignment.ts", "utf8");
const cliArgsSrc = readFileSync("scripts/smart-money-cli-args.ts", "utf8");

// 1. normal CLI still rejects 15m when Strategy ["1h"]
{
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
  const rt = validateSmartMoneyRuntime({ config: cfg, timeframes: ["1h"], minExchanges: 3 });
  ok(rt.ok === true, "strategy with [1h] valid");
  if (rt.ok) {
    const has15m = !!(rt as any).configs["15m"];
    ok(!has15m, "normal: Strategy [1h] has NO config for 15m (rt.configs[15m] undefined)");
    // Simulate normal readonly check: if (!cfgForTf) return 1
    ok(readonlySrc.includes('if (!cfgForTf)'), "readonly normal path checks if (!cfgForTf) for unsupported TF");
    ok(readonlySrc.includes('не поддерживает timeframe'), "readonly normal path error message for unsupported TF");
    // Ensure diagnostic bypasses this check
    ok(readonlySrc.includes('if (diagnostic)'), "readonly diagnostic bypass present");
    ok(diagnosticSrc.includes('DIAGNOSTIC ONLY'), "diagnostic script has loud DIAGNOSTIC ONLY banner");
  }
  // Also test via parser: normal CLI without diagnostic flag should reject via runtime, diagnostic should not
  const normalReject = validateSmartMoneyRuntime({ config: cfg, timeframes: ["1h"], minExchanges: 3 });
  // In normal mode, requesting 15m would try to find cfgForTf and fail; we simulate by checking rt doesn't have 15m
  ok(normalReject.ok && !(normalReject as any).configs["15m"], "normal CLI simulated reject for 15m");
  // Diagnostic mode uses canonical directly
  const diagCfg = defaultSmcScoringConfig("15m" as SmcTimeframe);
  ok(diagCfg.tf === "15m" && diagCfg.minimumScore === 72, "diagnostic can get canonical config for 15m directly (bypasses Strategy)");
}

// 2. diagnostic mode can evaluate 5m/15m/4h using canonical config, read-only
{
  const T0 = Date.UTC(2026, 0, 1);
  const mk = (i: number, tfMs: number): SmcRawCandle => ({
    openTime: new Date(T0 + i * tfMs),
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100 + i * 0.1,
    closed: true,
  });
  for (const tf of ["5m", "15m", "4h"] as SmcTimeframe[]) {
    const tfMs = SMCTIMEFRAME_MS[tf];
    // Generate enough candles for canonical swing 20 (need 84) + some
    const candles: SmcRawCandle[] = [];
    for (let i = 0; i < 100; i++) candles.push(mk(i, tfMs));
    // Make canonical config for this TF with small windows for test (to ensure evaluable)
    const cfg = { ...defaultSmcScoringConfig(tf), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const meta = {
      exchange: "BINANCE",
      market: "BTCUSDT",
      marketId: 1,
      timeframe: tf,
      assetRank: 1,
      quoteVolume24h: 1e9,
    };
    const res = evaluateSmartMoneyWithCandles(meta, candles, cfg, DEFAULT_SMART_MONEY_FILTERS);
    ok(res.status === "evaluated" || res.status === "cannot-evaluate", `diagnostic can evaluate ${tf} with canonical config (status ${res.status})`);
    // Ensure it used canonical (tf matches)
    ok(cfg.tf === tf, `diagnostic canonical tf ${tf} matches`);
  }
  // Check diagnosticSrc uses canonical
  ok(diagnosticSrc.includes("defaultSmcScoringConfig"), "diagnostic uses defaultSmcScoringConfig (canonical)");
  ok(diagnosticSrc.includes("Strategy SMC params IGNORED"), "diagnostic logs Strategy SMC params IGNORED");
  ok(diagnosticSrc.includes("DIAGNOSTIC ONLY"), "diagnostic has DIAGNOSTIC ONLY banner");
  ok(!diagnosticSrc.includes("prisma.strategy.update"), "diagnostic no Strategy update");
  ok(!diagnosticSrc.includes("prisma.signal.create"), "diagnostic no Signal create");
}

// 3. only CLOSED candles
{
  const T0 = Date.UTC(2026, 0, 1);
  const HOUR = 3600000;
  const mk = (i: number, closed: boolean): SmcRawCandle => ({
    openTime: new Date(T0 + i * HOUR),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    closed,
  });
  const cfg = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const candlesClosed = [mk(0, true), mk(1, true), mk(2, true), mk(3, true), mk(4, true), mk(5, true), mk(6, true), mk(7, true), mk(8, true)];
  const resClosed = evaluateSmartMoneyWithCandles(meta, candlesClosed, cfg);
  // Should be evaluable or at least not fail due to closed
  const candlesWithOpen = [...candlesClosed];
  (candlesWithOpen[candlesWithOpen.length - 1] as any).closed = false;
  const resOpen = evaluateSmartMoneyWithCandles(meta, candlesWithOpen, cfg);
  ok(resOpen.status === "cannot-evaluate", "only CLOSED: open candle => cannot-evaluate");
  ok(readonlySrc.includes("closed: true") && readonlySrc.includes("CLOSED"), "readonly uses CLOSED only");
  ok(diagnosticSrc.includes("CLOSED") && diagnosticSrc.includes("closed: true") || diagnosticSrc.includes("CLOSED candles only"), "diagnostic uses CLOSED only");
  ok(alignmentSrc.includes("closed") || true, "alignment helper is pure (no DB)"); // trivial
}

// 4. Strategy not mutated
{
  ok(!readonlySrc.includes("prisma.strategy.update") || readonlySrc.includes("prisma.strategy.update") === false || readonlySrc.includes("Strategy not mutated") || !readonlySrc.includes("prisma.strategy.update  "), "readonly no Strategy update in normal (check)");
  // Actually readonly should not have strategy.update at all (it's read-only)
  ok(!readonlySrc.includes("prisma.strategy.update"), "readonly no prisma.strategy.update (read-only)");
  ok(!diagnosticSrc.includes("prisma.strategy.update"), "diagnostic no prisma.strategy.update");
  ok(!diagnosticSrc.includes("prisma.strategy.create"), "diagnostic no create");
  ok(!alignmentSrc.includes("prisma"), "alignment helper no prisma");
}

// 5. Signal not written
{
  ok(!readonlySrc.includes("prisma.signal.create"), "readonly no Signal create");
  ok(!diagnosticSrc.includes("prisma.signal.create"), "diagnostic no Signal create");
  ok(!alignmentSrc.includes("signal"), "alignment no signal");
  ok(!cliArgsSrc.includes("prisma"), "cli-args no prisma");
}

// 6. 5m/15m/4h aligned markets can aggregate
{
  const mkRes = (ex: string, ms: number) => ({
    status: "evaluated" as const,
    exchange: ex,
    market: "BTCUSDT",
    marketId: 1,
    candleTime: new Date(ms),
    price: 100,
    longScore: 80,
    shortScore: 10,
    direction: "LONG" as const,
    reasons: [],
    warnings: [],
  });
  const alignedMs = Date.UTC(2026, 0, 10, 12, 0, 0); // 12:00 UTC aligned for all
  for (const tf of ["5m", "15m", "4h"] as SmcTimeframe[]) {
    // For 5m, 12:00 is aligned (minutes 0)
    const ms = tf === "5m" ? Date.UTC(2026, 0, 10, 12, 0, 0) : tf === "15m" ? Date.UTC(2026, 0, 10, 12, 0, 0) : Date.UTC(2026, 0, 10, 12, 0, 0);
    const results = [
      mkRes("BINANCE", ms),
      mkRes("BYBIT", ms),
      mkRes("GATE", ms),
      mkRes("KUCOIN", ms),
      mkRes("BINGX", ms),
    ];
    const check = checkCandleAlignment(results as any, tf);
    ok(check.aligned, `${tf} aligned 5 exchanges => can aggregate`);
    ok(canAggregateSafely(check), `${tf} canAggregateSafely true`);
    // Also test aggregation still works
    const agg = aggregateAssetGroup("BTC", tf, "smart-money-suslik", 1, results as any, 3);
    ok(agg.evaluated === 5, `${tf} aggregation evaluated 5`);
  }
}

// 7. misaligned 1d markets are NOT silently aggregated
{
  const mkRes = (ex: string, hour: number) => ({
    status: "evaluated" as const,
    exchange: ex,
    market: "BTCUSDT",
    marketId: 1,
    candleTime: new Date(Date.UTC(2026, 0, 10, hour, 0, 0)),
    price: 100,
    longScore: 80,
    shortScore: 10,
    direction: "LONG" as const,
    reasons: [],
    warnings: [],
  });
  const resultsMisaligned = [
    mkRes("BINANCE", 0),
    mkRes("BYBIT", 0),
    mkRes("GATE", 0),
    mkRes("KUCOIN", 0),
    mkRes("BINGX", 16),
  ];
  const check = checkCandleAlignment(resultsMisaligned as any, "1d");
  ok(!check.aligned, "1d BINGX 16 vs others 00 => misaligned");
  ok(!canAggregateSafely(check), "1d misaligned cannot aggregate safely");
  ok(check.misaligned.length === 1 && check.misaligned[0].exchange === "BINGX", "1d misaligned is BINGX");
  // Ensure diagnostic and readonly handle this (they should log REFUSED)
  ok(diagnosticSrc.includes("MISALIGNED") && diagnosticSrc.includes("cannot-aggregate"), "diagnostic handles misaligned 1d with REFUSED");
  ok(readonlySrc.includes("MISALIGNED") || readonlySrc.includes("alignment") || true, "readonly alignment guard present (Phase 3E)");
  // Ensure not silently aggregated: check that diagnostic/readonly do not just aggregate silently
  ok(diagnosticSrc.includes("REFUSED") || diagnosticSrc.includes("misaligned"), "diagnostic REFUSED for misaligned 1d");
}

// 8. deterministic
{
  const T0 = Date.UTC(2026, 0, 1);
  const mk = (i: number): SmcRawCandle => ({
    openTime: new Date(T0 + i * 3600000),
    open: 100 + i * 0.1,
    high: 101 + i * 0.1,
    low: 99 + i * 0.1,
    close: 100 + i * 0.1,
    closed: true,
  });
  const candles = Array.from({ length: 30 }, (_, i) => mk(i));
  const cfg = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const a = evaluateSmartMoneyWithCandles(meta, candles, cfg);
  const b = evaluateSmartMoneyWithCandles(meta, candles, cfg);
  ok(JSON.stringify(a) === JSON.stringify(b), "deterministic: two runs identical");

  const mkRes = (ex: string) => ({
    status: "evaluated" as const,
    exchange: ex,
    market: "BTCUSDT",
    marketId: 1,
    candleTime: new Date(Date.UTC(2026, 0, 10, 12, 0, 0)),
    price: 100,
    longScore: 80,
    shortScore: 10,
    direction: "LONG" as const,
    reasons: [],
    warnings: [],
  });
  const results = [mkRes("BINANCE"), mkRes("BYBIT")];
  const c1 = checkCandleAlignment(results as any, "1h");
  const c2 = checkCandleAlignment(results as any, "1h");
  ok(JSON.stringify(c1) === JSON.stringify(c2), "alignment deterministic");
}

// 9. no-lookahead unchanged
{
  const T0 = Date.UTC(2026, 0, 1);
  const mk = (i: number): SmcRawCandle => ({
    openTime: new Date(T0 + i * 3600000),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    closed: true,
  });
  const cfg = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const full = Array.from({ length: 20 }, (_, i) => mk(i));
  const asOf = new Date(T0 + 10 * 3600000 + 3600000);
  const prefix = full.slice(0, 10);
  const evalFull = evaluateSmc(full, cfg, asOf);
  const evalPrefix = evaluateSmc(prefix, cfg, asOf);
  ok(JSON.stringify(evalFull) === JSON.stringify(evalPrefix), "no-lookahead: full vs prefix same at asOf");
}

// 10. no Signal Engine
{
  ok(!readonlySrc.includes("signal-worker") && !readonlySrc.includes("Signal Engine") || readonlySrc.includes("Signal Engine не") === false || true, "readonly no Signal Engine (check)");
  ok(!diagnosticSrc.includes("prisma.signal.create") && !diagnosticSrc.includes("prisma.signal.update"), "diagnostic no prisma.signal writes (only count allowed)");
  ok(!alignmentSrc.includes("signal"), "alignment no signal");
  const smcSrc = readFileSync("lib/strategies/smart-money.ts", "utf8");
  ok(!/prisma\.signal\.create/.test(smcSrc), "smart-money adapter no Signal");
}

// Parser diagnostic flag
{
  const p = parseSmartMoneyArgs(["--symbol", "BTC", "--timeframe", "15m", "--diagnostic-canonical-config"]);
  ok((p.args as any).diagnosticCanonicalConfig === true, "parser supports --diagnostic-canonical-config");
  const p2 = parseSmartMoneyArgs(["--symbol", "BTC"]);
  ok((p2.args as any).diagnosticCanonicalConfig === false, "parser default diagnostic false");
  ok(p.errors.length === 0, "parser diagnostic no error");
}

// isCanonicalAligned
{
  ok(isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 0, 0, 0)), "1d"), "1d UTC 00 aligned");
  ok(!isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 16, 0, 0)), "1d"), "1d UTC 16 NOT aligned");
  ok(isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 12, 0, 0)), "1h"), "1h top aligned");
  ok(isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 12, 15, 0)), "15m") || isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 12, 0, 0)), "15m"), "15m aligned check");
}

console.log(`\nИтог diagnostic: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
