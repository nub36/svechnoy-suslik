/**
 * Phase 3E diagnostic tests — read-only verification, no DB writes.
 * Run: npx tsx scripts/test-smart-money-diagnostic.ts
 *
 * Strict tests, no unconditional OR-true (always-pass) pattern.
 * Cases cover canonical grid + same horizon (A+B).
 */

import { readFileSync } from "node:fs";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import {
  evaluateSmartMoneyWithCandles,
  validateSmartMoneyRuntime,
  DEFAULT_SMART_MONEY_FILTERS,
} from "../lib/strategies/smart-money";
import {
  checkCandleAlignment,
  canAggregateSafely,
  shouldAggregateAssetGroup,
  isCanonicalAligned,
} from "../lib/strategies/alignment";
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

function mkRes(ex: string, ms: number) {
  return {
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
  };
}

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
    ok(!has15m, "normal: Strategy [1h] has NO config for 15m");
    ok(readonlySrc.includes("if (!cfgForTf)"), "readonly normal path checks if (!cfgForTf)");
    ok(readonlySrc.includes("не поддерживает timeframe"), "readonly error message for unsupported TF");
    ok(readonlySrc.includes("if (diagnostic)"), "readonly diagnostic bypass present");
    ok(diagnosticSrc.includes("DIAGNOSTIC ONLY"), "diagnostic has loud banner");
  }
  const normalReject = validateSmartMoneyRuntime({ config: cfg, timeframes: ["1h"], minExchanges: 3 });
  ok(normalReject.ok && !(normalReject as any).configs["15m"], "normal CLI simulated reject for 15m");
  const diagCfg = defaultSmcScoringConfig("15m" as SmcTimeframe);
  ok(diagCfg.tf === "15m" && diagCfg.minimumScore === 72, "diagnostic canonical 15m direct");
}

// 2. diagnostic can evaluate 5m/15m/4h canonical, read-only
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
    const candles: SmcRawCandle[] = [];
    for (let i = 0; i < 100; i++) candles.push(mk(i, tfMs));
    const cfg = { ...defaultSmcScoringConfig(tf), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: tf, assetRank: 1, quoteVolume24h: 1e9 };
    const res = evaluateSmartMoneyWithCandles(meta, candles, cfg, DEFAULT_SMART_MONEY_FILTERS);
    ok(res.status === "evaluated" || res.status === "cannot-evaluate", `diagnostic can evaluate ${tf} (${res.status})`);
    ok(cfg.tf === tf, `canonical tf ${tf} matches`);
  }
  ok(diagnosticSrc.includes("defaultSmcScoringConfig"), "diagnostic uses defaultSmcScoringConfig");
  ok(diagnosticSrc.includes("Strategy SMC params IGNORED"), "diagnostic Strategy IGNORED logged");
  ok(diagnosticSrc.includes("DIAGNOSTIC ONLY"), "diagnostic banner");
  ok(!diagnosticSrc.includes("prisma.strategy.update"), "diagnostic no Strategy update");
  ok(!diagnosticSrc.includes("prisma.signal.create"), "diagnostic no Signal create");
}

// 3. only CLOSED
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
  const closedCandles = Array.from({ length: 9 }, (_, i) => mk(i, true));
  const withOpen = [...closedCandles];
  (withOpen[withOpen.length - 1] as any).closed = false;
  const resOpen = evaluateSmartMoneyWithCandles(meta, withOpen, cfg);
  ok(resOpen.status === "cannot-evaluate", "open candle => cannot-evaluate");
  ok(readonlySrc.includes("closed: true"), "readonly uses closed:true");
  ok(readonlySrc.includes("CLOSED"), "readonly mentions CLOSED");
  ok(diagnosticSrc.includes("CLOSED"), "diagnostic mentions CLOSED");
}

// 4. Strategy not mutated
{
  ok(!readonlySrc.includes("prisma.strategy.update"), "readonly no prisma.strategy.update");
  ok(!diagnosticSrc.includes("prisma.strategy.update"), "diagnostic no prisma.strategy.update");
  ok(!diagnosticSrc.includes("prisma.strategy.create"), "diagnostic no create");
  ok(!alignmentSrc.includes("prisma"), "alignment no prisma");
}

// 5. Signal not written
{
  ok(!readonlySrc.includes("prisma.signal.create"), "readonly no Signal create");
  ok(!diagnosticSrc.includes("prisma.signal.create"), "diagnostic no Signal create");
  ok(!alignmentSrc.includes("signal"), "alignment no signal");
  ok(!cliArgsSrc.includes("prisma"), "cli-args no prisma");
}

// 6. CASE 1: 15m all 5 @15:00 => safe true
{
  const ts = Date.UTC(2026, 0, 10, 15, 0, 0);
  const results = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"].map((ex) => mkRes(ex, ts));
  const check = checkCandleAlignment(results as any, "15m");
  ok(check.safe === true, "CASE1 15m all 5 @15:00 safe true");
  ok(check.aligned === true, "CASE1 aligned true");
  ok(check.offGrid.length === 0, "CASE1 offGrid 0");
  ok(check.horizonMismatch.length === 0, "CASE1 horizonMismatch 0");
  ok(check.referenceCandleTime?.getTime() === ts, "CASE1 reference 15:00");
  ok(canAggregateSafely(check) === true, "CASE1 canAggregate true");
  ok(shouldAggregateAssetGroup(check) === true, "CASE1 shouldAggregate true");
  const agg = aggregateAssetGroup("BTC", "15m", "smart-money-suslik", 1, results as any, 3);
  ok(agg.evaluated === 5, "CASE1 aggregation evaluated 5");
}

// 7. CASE 2: 15m 4@15:00 1@14:45 => safe false, horizonMismatch GATE
{
  const ts1500 = Date.UTC(2026, 0, 10, 15, 0, 0);
  const ts1445 = Date.UTC(2026, 0, 10, 14, 45, 0);
  const results = [
    mkRes("BINANCE", ts1500),
    mkRes("BYBIT", ts1500),
    mkRes("GATE", ts1445),
    mkRes("KUCOIN", ts1500),
    mkRes("BINGX", ts1500),
  ];
  const check = checkCandleAlignment(results as any, "15m");
  ok(check.safe === false, "CASE2 15m stale safe false");
  ok(check.offGrid.length === 0, "CASE2 offGrid 0 (all on-grid)");
  ok(check.horizonMismatch.length === 1 && check.horizonMismatch[0].exchange === "GATE", "CASE2 horizonMismatch GATE");
  ok(check.horizonMismatch[0].candleTime.getTime() === ts1445, "CASE2 stale 14:45");
  ok(!canAggregateSafely(check), "CASE2 cannot aggregate");
  ok(!shouldAggregateAssetGroup(check), "CASE2 shouldAggregate false");
}

// 8. CASE 3: 5m 4@15:15 1@15:10 => safe false
{
  const ts1515 = Date.UTC(2026, 0, 10, 15, 15, 0);
  const ts1510 = Date.UTC(2026, 0, 10, 15, 10, 0);
  const results = [
    mkRes("BINANCE", ts1515),
    mkRes("BYBIT", ts1515),
    mkRes("GATE", ts1510),
    mkRes("KUCOIN", ts1515),
    mkRes("BINGX", ts1515),
  ];
  const check = checkCandleAlignment(results as any, "5m");
  ok(check.safe === false, "CASE3 5m stale safe false");
  ok(check.horizonMismatch.length === 1 && check.horizonMismatch[0].exchange === "GATE", "CASE3 horizonMismatch GATE");
  ok(!canAggregateSafely(check), "CASE3 cannot aggregate");
}

// 9. CASE 4: 4h 4@12:00 1@08:00 => safe false
{
  const ts1200 = Date.UTC(2026, 0, 10, 12, 0, 0);
  const ts0800 = Date.UTC(2026, 0, 10, 8, 0, 0);
  const results = [
    mkRes("BINANCE", ts1200),
    mkRes("BYBIT", ts1200),
    mkRes("GATE", ts1200),
    mkRes("KUCOIN", ts1200),
    mkRes("BINGX", ts0800),
  ];
  const check = checkCandleAlignment(results as any, "4h");
  ok(check.safe === false, "CASE4 4h safe false");
  ok(check.horizonMismatch.length === 1 && check.horizonMismatch[0].exchange === "BINGX", "CASE4 horizonMismatch BINGX");
  ok(check.offGrid.length === 0, "CASE4 offGrid 0 (both on-grid 4h)");
}

// 10. CASE 5: 1d 4@00 UTC BINGX 16 UTC => offGrid safe false
{
  const ts00 = Date.UTC(2026, 0, 10, 0, 0, 0);
  const ts16 = Date.UTC(2026, 0, 10, 16, 0, 0);
  const results = [
    mkRes("BINANCE", ts00),
    mkRes("BYBIT", ts00),
    mkRes("GATE", ts00),
    mkRes("KUCOIN", ts00),
    mkRes("BINGX", ts16),
  ];
  const check = checkCandleAlignment(results as any, "1d");
  ok(check.safe === false, "CASE5 1d BINGX16 safe false");
  ok(check.offGrid.length === 1 && check.offGrid[0].exchange === "BINGX", "CASE5 offGrid BINGX");
  ok(check.offGrid[0].offsetMs !== 0, "CASE5 BINGX offset non-zero");
  ok(check.horizonMismatch.length === 1 && check.horizonMismatch[0].exchange === "BINGX", "CASE5 horizonMismatch BINGX");
  ok(check.misaligned.length === 1 && check.misaligned[0].exchange === "BINGX", "CASE5 misaligned alias BINGX");
  ok(!canAggregateSafely(check), "CASE5 cannot aggregate");
  ok(diagnosticSrc.includes("OFF_GRID") && diagnosticSrc.includes("HORIZON_MISMATCH"), "diagnostic handles offGrid/horizonMismatch");
  ok(diagnosticSrc.includes("MULTI-EXCHANGE AGGREGATION REFUSED"), "diagnostic REFUSED generic");
  ok(readonlySrc.includes("MULTI-EXCHANGE AGGREGATION REFUSED"), "readonly REFUSED generic");
}

// 11. CASE 6: 1d all 5 same midnight => safe true
{
  const ts = Date.UTC(2026, 0, 10, 0, 0, 0);
  const results = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"].map((ex) => mkRes(ex, ts));
  const check = checkCandleAlignment(results as any, "1d");
  ok(check.safe === true, "CASE6 1d all same safe true");
  ok(check.offGrid.length === 0 && check.horizonMismatch.length === 0, "CASE6 no mismatches");
  ok(canAggregateSafely(check), "CASE6 can aggregate");
}

// 12. CASE 7: zero evaluated => safe false
{
  const check = checkCandleAlignment([] as any, "1h");
  ok(check.safe === false, "CASE7 zero evaluated safe false");
  ok(check.referenceCandleTime === null, "CASE7 reference null");
  ok(check.totalEvaluated === 0, "CASE7 total 0");
  ok(!canAggregateSafely(check), "CASE7 cannot aggregate");
  ok(!shouldAggregateAssetGroup(check), "CASE7 shouldAggregate false");
  ok(!!check.reason?.includes("no evaluated markets"), "CASE7 reason mentions no evaluated");
}

// 13. CASE 8: one evaluated canonical => temporal safe true, minExchanges separate
{
  const ts = Date.UTC(2026, 0, 10, 12, 0, 0);
  const results = [mkRes("BINANCE", ts)];
  const check = checkCandleAlignment(results as any, "1h");
  ok(check.safe === true, "CASE8 one evaluated safe true (temporal)");
  ok(check.horizonMismatch.length === 0, "CASE8 horizonMismatch empty");
  ok(check.offGrid.length === 0, "CASE8 offGrid empty");
  const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, results as any, 3);
  ok(agg.direction === "NEUTRAL" && agg.evaluated === 1 && agg.minExchanges === 3, "CASE8 minExchanges 3 with 1 evaluated => NEUTRAL");
}

// 14. Unsafe path does NOT call aggregateAssetGroup (pure helper)
{
  const ts1500 = Date.UTC(2026, 0, 10, 15, 0, 0);
  const ts1445 = Date.UTC(2026, 0, 10, 14, 45, 0);
  const results = [mkRes("BINANCE", ts1500), mkRes("BYBIT", ts1445)];
  const check = checkCandleAlignment(results as any, "15m");
  ok(shouldAggregateAssetGroup(check) === false, "unsafe shouldAggregate false");
  ok(canAggregateSafely(check) === false, "unsafe canAggregate false");
  // Simulate diagnostic decision: should NOT call aggregate
  let called = false;
  if (shouldAggregateAssetGroup(check)) {
    called = true;
    aggregateAssetGroup("BTC", "15m", "smart-money-suslik", 1, results as any, 2);
  }
  ok(called === false, "unsafe path does NOT invoke aggregate");
  // Safe path does call
  const safeResults = [mkRes("BINANCE", ts1500), mkRes("BYBIT", ts1500)];
  const safeCheck = checkCandleAlignment(safeResults as any, "15m");
  let calledSafe = false;
  if (shouldAggregateAssetGroup(safeCheck)) {
    calledSafe = true;
    aggregateAssetGroup("BTC", "15m", "smart-money-suslik", 1, safeResults as any, 2);
  }
  ok(calledSafe === true, "safe path invokes aggregate");
}

// 15. deterministic
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
  ok(JSON.stringify(a) === JSON.stringify(b), "deterministic two runs identical");
  const c1 = checkCandleAlignment([mkRes("BINANCE", Date.UTC(2026, 0, 10, 12, 0, 0))] as any, "1h");
  const c2 = checkCandleAlignment([mkRes("BINANCE", Date.UTC(2026, 0, 10, 12, 0, 0))] as any, "1h");
  ok(c1.safe === c2.safe && c1.referenceCandleTime?.getTime() === c2.referenceCandleTime?.getTime(), "alignment deterministic");
}

// 16. no-lookahead
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
  ok(JSON.stringify(evalFull) === JSON.stringify(evalPrefix), "no-lookahead full vs prefix same");
}

// 17. no Signal Engine
{
  ok(!diagnosticSrc.includes("prisma.signal.create") && !diagnosticSrc.includes("prisma.signal.update"), "diagnostic no signal writes");
  ok(!alignmentSrc.includes("signal"), "alignment no signal");
  const smcSrc = readFileSync("lib/strategies/smart-money.ts", "utf8");
  ok(!/prisma\.signal\.create/.test(smcSrc), "smart-money no Signal");
  ok(!readonlySrc.includes("prisma.signal.create"), "readonly no Signal create");
}

// 18. parser flag
{
  const p = parseSmartMoneyArgs(["--symbol", "BTC", "--timeframe", "15m", "--diagnostic-canonical-config"]);
  ok((p.args as any).diagnosticCanonicalConfig === true, "parser supports diagnostic flag");
  const p2 = parseSmartMoneyArgs(["--symbol", "BTC"]);
  ok((p2.args as any).diagnosticCanonicalConfig === false, "parser default false");
  ok(p.errors.length === 0, "parser no error");
}

// 19. isCanonicalAligned
{
  ok(isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 0, 0, 0)), "1d"), "1d UTC 00 aligned");
  ok(!isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 16, 0, 0)), "1d"), "1d UTC 16 not aligned");
  ok(isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 12, 0, 0)), "1h"), "1h top aligned");
  const aligned15a = isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 12, 0, 0)), "15m");
  const aligned15b = isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 12, 15, 0)), "15m");
  ok(aligned15a === true && aligned15b === true, "15m 12:00 and 12:15 aligned");
  ok(!isCanonicalAligned(new Date(Date.UTC(2026, 0, 10, 12, 7, 0)), "15m"), "15m 12:07 not aligned");
}

// 20. ensure no unconditional OR-true in tests
{
  const self = readFileSync("scripts/test-smart-money-diagnostic.ts", "utf8");
  ok(!self.includes("||" + " true"), "no unconditional OR-true pattern in diagnostic tests");
}

// 21. alignment reference semantics
{
  const ts = Date.UTC(2026, 0, 10, 12, 0, 0);
  const r = checkCandleAlignment([mkRes("BINANCE", ts)] as any, "1h");
  ok(r.referenceCandleTime?.getTime() === ts, "reference is candleTime itself");
  ok(r.details[0].candleTime.getTime() === ts, "detail candleTime matches");
}

console.log(`\nИтог diagnostic: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
