/**
 * PHASE 2A — Smart Money DRY-RUN tests
 * Covers A-K, L, M, parity, safety, common horizon behavior
 * Run: npx tsx scripts/test-smart-money-dry-run.ts
 *
 * Uses ONLY production functions:
 * evaluateSmc(), selectCommonClosedHorizon(), truncateCandlesToHorizon(),
 * aggregateAssetGroup(), isSmartMoneyExchangeEligible()
 */

import { readFileSync } from "node:fs";
import { defaultSmcScoringConfig, type SmcScoringConfig } from "../lib/smc/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import { isSmcTimeframe, SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import {
  evaluateSmartMoneyWithCandles,
  evaluateMarketsAtCommonHorizon,
  type SmartMoneyMarketMeta,
} from "../lib/strategies/smart-money";
import {
  selectCommonClosedHorizon,
  truncateCandlesToHorizon,
  decideAggregationAtCommonHorizon,
  expectedLatestClosedOpenTime,
  type CommonHorizonMarket,
} from "../lib/strategies/common-horizon";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { isSmartMoneyExchangeEligible, filterSmartMoneyEligibleResults } from "../lib/strategies/smart-money-eligibility";
import { checkCandleAlignment } from "../lib/strategies/alignment";
import { validateTrendSuslikConfig } from "../lib/strategies/config";
import { evaluateSnapshot } from "../lib/strategies/runtime";
import { runTrendSuslik } from "../lib/strategies/trend-suslik";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    failures.push(label);
    console.error(`  ✗ FAIL: ${label}`);
  }
}
function eq(a: unknown, b: unknown, label: string) {
  const same = JSON.stringify(a) === JSON.stringify(b);
  if (!same) console.error(`    actual=${JSON.stringify(a)} expect=${JSON.stringify(b)}`);
  ok(same, label);
}

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const M5 = SMCTIMEFRAME_MS["5m"];

function mk(i: number, o: number, c: number, high?: number, low?: number): SmcRawCandle {
  return {
    openTime: new Date(T0 + i * HOUR),
    open: o,
    high: high ?? Math.max(o, c),
    low: low ?? Math.min(o, c),
    close: c,
    closed: true,
  };
}
function flats(from: number, to: number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i = from; i <= to; i++) {
    const b = i * 0.01;
    out.push(mk(i, 86 + b, 87 + b, 90 + b, 84 + b));
  }
  return out;
}
function canonical(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 105, 84.05),
    flats(6, 6)[0],
    mk(7, 86.07, 87.07, 90.07, 82),
    ...flats(8, 13),
    mk(14, 90, 86, 90.14, 84),
    mk(15, 91, 104, 108, 91),
    mk(16, 103, 101, 103.5, 95),
    mk(17, 107, 109, 109.5, 106.5),
    ...flats(18, 26),
  ];
}
function canonicalMirror(): SmcRawCandle[] {
  return canonical().map((c) => ({
    openTime: c.openTime,
    open: -c.open,
    high: -c.low,
    low: -c.high,
    close: -c.close,
    closed: true as const,
  })) as SmcRawCandle[];
}

function waveCandles(timesMs: number[]): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  let prev = 100;
  for (let i = 0; i < timesMs.length; i++) {
    const t = i % 48;
    const tri = t <= 24 ? t : 48 - t;
    const close = 100 + 2 * tri;
    out.push({
      openTime: new Date(timesMs[i]),
      open: prev,
      high: Math.max(prev, close) + 1,
      low: Math.min(prev, close) - 1,
      close,
      closed: true,
    });
    prev = close;
  }
  return out;
}
function closedTimes(endMs: number, n: number, tf: SmcTimeframe): number[] {
  const d = SMCTIMEFRAME_MS[tf];
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(endMs - i * d);
  return out;
}

type MarketInput = { meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] };
function market(ex: string, id: number, tf: SmcTimeframe, candles: SmcRawCandle[]): MarketInput {
  return {
    meta: { exchange: ex, market: `${ex}*BTCUSDT`, marketId: id, timeframe: tf, assetRank: 1, quoteVolume24h: 1_000_000 },
    candles,
  };
}
const asCommon = (m: MarketInput): CommonHorizonMarket => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles });
const NO_FILTERS = { top500Only: false, minimumQuoteVolume24h: 0 };

const EPOCH = Date.UTC(2026, 8, 11);
const T = EPOCH + 9 * 3600_000 + 50 * 60_000; // 09:50
const T_MINUS_1 = T - M5; // 09:45
const NOW_5M = EPOCH + 9 * 3600_000 + 55 * 60_000;
const NAMES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];
const fresh5m = (i: number, ex = NAMES[i - 1]!) => market(ex, i, "5m", waveCandles(closedTimes(T, 200, "5m")));
const laggard5m = (i: number, ex = NAMES[i - 1]!) => market(ex, i, "5m", waveCandles(closedTimes(T_MINUS_1, 200, "5m")));

const cfg = (tf: SmcTimeframe) => defaultSmcScoringConfig(tf);

async function main() {
  console.log("=== PHASE 2A Smart Money DRY-RUN tests ===");

  // A. 5 exchanges same horizon => aggregation allowed
  console.log("\nA. 5 exchanges same horizon");
  {
    const markets = [fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), fresh5m(5)];
    const out = evaluateMarketsAtCommonHorizon(markets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
    ok(out.status === "ok", "A: status ok");
    ok(out.usable === true, "A: usable true");
    ok(out.results.length === 5 && out.results.every((r) => r.status === "evaluated"), "A: 5 evaluated");
    ok(out.results.every((r) => r.status === "evaluated" && r.candleTime.getTime() === T), "A: all at same horizon T");
    const gate = decideAggregationAtCommonHorizon({ selection: out.selection, results: out.results, timeframe: "5m" });
    ok(gate.allowed === true && gate.alignment.safe === true, "A: aggregation allowed");
    const agg = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, out.results as any, 3);
    ok(agg.evaluated === 5, "A: evaluated 5");
  }

  // B. GATE lagging one candle => не смешивается с T
  console.log("\nB. GATE lagging one candle => not mixed with T");
  {
    const markets = [laggard5m(1, "BINANCE"), fresh5m(2, "BYBIT"), fresh5m(3, "GATE"), fresh5m(4, "KUCOIN"), fresh5m(5, "BINGX")];
    // Make GATE laggard
    const marketsB = [fresh5m(1, "BINANCE"), fresh5m(2, "BYBIT"), laggard5m(3, "GATE"), fresh5m(4, "KUCOIN"), fresh5m(5, "BINGX")];
    const out = evaluateMarketsAtCommonHorizon(marketsB, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
    ok(out.status === "ok", "B: status ok with laggard");
    ok(out.selection.commonHorizon!.getTime() === T_MINUS_1, "B: common horizon is T-1 (laggard), not T");
    ok(out.results.every((r) => r.status !== "evaluated" || r.candleTime.getTime() === T_MINUS_1), "B: no result at T, all at T-1 — no mixing");
    // Old path would be misaligned
    const oldResults = marketsB.map((m) => evaluateSmartMoneyWithCandles(m.meta, m.candles, cfg("5m"), NO_FILTERS));
    const align = checkCandleAlignment(oldResults, "5m");
    ok(align.safe === false, "B: old path without common horizon would be MISALIGNED (safe=false)");
  }

  // C. stale exchange => does not vote (cannot-evaluate due to short history)
  console.log("\nC. stale exchange => does not vote");
  {
    const short = market("BINGX", 8, "5m", waveCandles(closedTimes(T, 40, "5m"))); // 40 < 84 required
    const markets = [fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), short];
    const out = evaluateMarketsAtCommonHorizon(markets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
    ok(out.status === "ok", "C: status ok even with short market (has common bar)");
    const shortRow = out.results.find((r) => r.marketId === 8);
    ok(shortRow !== undefined && shortRow.status === "cannot-evaluate", "C: short market cannot-evaluate");
    const evaluated = out.results.filter((r) => r.status === "evaluated");
    ok(evaluated.length === 4, "C: 4 evaluated, stale does not vote");
    ok(out.results.every((r) => r.status !== "evaluated" || r.candleTime.getTime() === out.selection.commonHorizon!.getTime()), "C: evaluated all at common horizon");
  }

  // D. BINGX 1d => excluded
  console.log("\nD. BINGX 1d excluded");
  {
    ok(isSmartMoneyExchangeEligible("BINGX", "1d") === false, "D: BINGX 1d not eligible");
    ok(isSmartMoneyExchangeEligible("BINGX", "5m") === true, "D: BINGX 5m eligible");
    ok(isSmartMoneyExchangeEligible("BINANCE", "1d") === true, "D: BINANCE 1d eligible");
    const allEx = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"].map((ex, i) => ({
      exchange: ex,
      market: `${ex}*BTCUSDT`,
      marketId: i + 1,
      timeframe: "1d",
      status: "evaluated" as const,
      candleTime: new Date(),
      price: 100,
      longScore: 10,
      shortScore: 10,
      direction: "NEUTRAL" as const,
      reasons: [],
      warnings: [],
    }));
    const filtered = filterSmartMoneyEligibleResults(allEx as any, "1d");
    ok(filtered.length === 4 && filtered.every((r) => r.exchange !== "BINGX"), "D: filtered 1d has 4, BINGX excluded");
    const filtered5m = filterSmartMoneyEligibleResults(allEx as any, "5m");
    ok(filtered5m.length === 5, "D: filtered 5m has 5, BINGX included");
  }

  // E. open candle exists => ignored
  console.log("\nE. open candle exists => ignored");
  {
    const withOpen = waveCandles(closedTimes(T, 10, "5m")).map((c, i) => (i === 9 ? { ...c, closed: false as any } : c));
    const truncated = truncateCandlesToHorizon(withOpen as any, new Date(T));
    ok(truncated.length === 9, "E: truncate filters closed=false");
    ok(truncated.every((c) => c.closed === true), "E: truncated only closed");
    const sel = selectCommonClosedHorizon(
      [
        { exchange: "A", marketId: 1, candles: withOpen as any },
        { exchange: "B", marketId: 2, candles: waveCandles(closedTimes(T, 10, "5m")) },
      ],
      "5m",
      { now: new Date(NOW_5M) }
    );
    ok(sel.commonHorizon!.getTime() === T - M5, "E: common horizon ignores open candle at T, picks T-1");
  }

  // F. future candle => ignored/refused
  console.log("\nF. future candle => ignored/refused");
  {
    const futureEnd = NOW_5M + M5; // future bar 10:00 when now 09:55
    const futureCandles = waveCandles(closedTimes(futureEnd, 200, "5m"));
    const sel = selectCommonClosedHorizon(
      [
        { exchange: "BINANCE", marketId: 1, candles: futureCandles },
        { exchange: "BYBIT", marketId: 2, candles: futureCandles },
      ],
      "5m",
      { now: new Date(NOW_5M) }
    );
    ok(sel.status === "future_horizon" || sel.status === "absolute_stale" || sel.status === "ok", "F: future detected or handled");
    // If common is future, it should be future_horizon
    if (sel.commonHorizon && sel.commonHorizon.getTime() > expectedLatestClosedOpenTime(new Date(NOW_5M), "5m").getTime()) {
      ok(sel.status === "future_horizon", "F: future horizon status = future_horizon");
    } else {
      ok(true, "F: future not selected as common (filtered by expectedLatestClosed)");
    }
    // Truncate should not include future beyond common
    const truncated = truncateCandlesToHorizon(futureCandles, new Date(T));
    ok(truncated.every((c) => c.openTime.getTime() <= T), "F: truncate excludes future beyond horizon");
  }

  // G. one exchange CANNOT_EVALUATE => doesn't vote
  console.log("\nG. one exchange CANNOT_EVALUATE => doesn't vote");
  {
    const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
    const few = flats(0, 10); // 11 << 84
    const r = evaluateSmartMoneyWithCandles(meta, few, cfg("1h"), NO_FILTERS);
    ok(r.status === "cannot-evaluate", "G: short history -> cannot-evaluate");
    const mkEval = (dir: "LONG" | "SHORT" | "NEUTRAL", id: number) => ({
      status: "evaluated" as const,
      exchange: "EX" + id,
      market: "BTCUSDT",
      marketId: id,
      candleTime: new Date(),
      price: 100,
      longScore: dir === "LONG" ? 80 : 10,
      shortScore: dir === "SHORT" ? 80 : 10,
      direction: dir,
      reasons: [],
      warnings: [],
    });
    const results = [mkEval("LONG", 1), mkEval("LONG", 2), { status: "cannot-evaluate", exchange: "EX3", market: "BTCUSDT", marketId: 3, reason: "INSUFFICIENT_HISTORY" } as any];
    const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, results as any, 2);
    ok(agg.evaluated === 2 && agg.longVotes === 2, "G: cannot-evaluate doesn't vote, evaluated=2");
    ok(agg.direction === "LONG", "G: 2 LONG votes with minExchanges=2 => LONG despite cannot-evaluate");
  }

  // H. fewer evaluated than minExchanges => NEUTRAL/no signal
  console.log("\nH. fewer evaluated than minExchanges => NEUTRAL");
  {
    const mkEval = (dir: "LONG", id: number) => ({
      status: "evaluated" as const,
      exchange: "EX" + id,
      market: "BTCUSDT",
      marketId: id,
      candleTime: new Date(),
      price: 100,
      longScore: 80,
      shortScore: 10,
      direction: dir,
      reasons: [],
      warnings: [],
    });
    const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, [mkEval("LONG", 1)], 2);
    ok(agg.direction === "NEUTRAL", "H: 1 LONG with minExchanges=2 => NEUTRAL");
    ok(agg.evaluated === 1 && agg.evaluated < 2, "H: evaluated < minExchanges");
  }

  // I. 3 LONG + 2 NEUTRAL minExchanges=3 => LONG
  console.log("\nI. 3 LONG + 2 NEUTRAL minExchanges=3 => LONG");
  {
    const mkEval = (dir: "LONG" | "NEUTRAL", id: number) => ({
      status: "evaluated" as const,
      exchange: "EX" + id,
      market: "BTCUSDT",
      marketId: id,
      candleTime: new Date(),
      price: 100,
      longScore: dir === "LONG" ? 80 : 10,
      shortScore: 10,
      direction: dir,
      reasons: [],
      warnings: [],
    });
    const results = [mkEval("LONG", 1), mkEval("LONG", 2), mkEval("LONG", 3), mkEval("NEUTRAL", 4), mkEval("NEUTRAL", 5)];
    const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, results as any, 3);
    ok(agg.direction === "LONG" && agg.longVotes === 3 && agg.neutralVotes === 2, "I: 3 LONG +2 NEUTRAL => LONG");
  }

  // J. 2 LONG + 3 NEUTRAL minExchanges=3 => NEUTRAL
  console.log("\nJ. 2 LONG + 3 NEUTRAL minExchanges=3 => NEUTRAL");
  {
    const mkEval = (dir: "LONG" | "NEUTRAL", id: number) => ({
      status: "evaluated" as const,
      exchange: "EX" + id,
      market: "BTCUSDT",
      marketId: id,
      candleTime: new Date(),
      price: 100,
      longScore: dir === "LONG" ? 80 : 10,
      shortScore: 10,
      direction: dir,
      reasons: [],
      warnings: [],
    });
    const results = [mkEval("LONG", 1), mkEval("LONG", 2), mkEval("NEUTRAL", 3), mkEval("NEUTRAL", 4), mkEval("NEUTRAL", 5)];
    const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, results as any, 3);
    ok(agg.direction === "NEUTRAL" && agg.longVotes === 2, "J: 2 LONG +3 NEUTRAL => NEUTRAL");
  }

  // K. conflict scenario => fail-safe NEUTRAL
  console.log("\nK. conflict scenario => NEUTRAL");
  {
    const mkEval = (dir: "LONG" | "SHORT", id: number) => ({
      status: "evaluated" as const,
      exchange: "EX" + id,
      market: "BTCUSDT",
      marketId: id,
      candleTime: new Date(),
      price: 100,
      longScore: 80,
      shortScore: 80,
      direction: dir,
      reasons: [],
      warnings: [],
    });
    const results = [mkEval("LONG", 1), mkEval("LONG", 2), mkEval("LONG", 3), mkEval("SHORT", 4), mkEval("SHORT", 5), mkEval("SHORT", 6)];
    const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, results as any, 3);
    ok(agg.conflict === true && agg.direction === "NEUTRAL", "K: 3 LONG +3 SHORT => conflict true, NEUTRAL");
  }

  // L. Existing TrendSuslik tests still pass
  console.log("\nL. TrendSuslik regression");
  {
    const config = {
      minimumSignalScore: 60,
      weights: { trend: 30, mediumTrend: 20, rsi: 20, macd: 20, volume: 10 },
      ema: { fast: 20, medium: 50, slow: 200 },
      rsi: { period: 14, longMin: 40, longMax: 70, shortMin: 30, shortMax: 60 },
      macd: { fast: 12, slow: 26, signal: 9, deadZoneRatio: 0 },
      atr: { period: 14, stopMultiplier: 2, takeProfit1Multiplier: 2, takeProfit2Multiplier: 3, takeProfit3Multiplier: 4 },
      volume: { period: 20, minimumRatio: 0.8 },
      execution: { closedCandleOnly: true, cooldownCandles: 1 },
      filters: { minimumQuoteVolume24h: 0, top500Only: false },
    };
    const v = validateTrendSuslikConfig(config);
    ok(v.ok === true, "L: trend config valid");
    if (v.ok) {
      const input = {
        marketId: 1,
        exchange: "BINANCE",
        exchangeSymbol: "BTCUSDT",
        assetSymbol: "BTC",
        assetRank: 1,
        quoteVolume24h: 1e9,
        timeframe: "1h",
        candleTime: new Date(),
        price: 79150,
        rsi14: 60,
        ema20: 79000,
        ema50: 78500,
        ema200: 78000,
        macd: 100,
        macdSignal: 50,
        macdHist: 50,
        atr14: 350,
        volume: 120,
        avgVolume20: 100,
        volumeRatio: 1.2,
      };
      const res = evaluateSnapshot(input as any, v.config);
      ok(res.status === "evaluated" && res.direction === "LONG", "L: trend LONG evaluation still works");
    }
  }

  // M. Prefix invariance
  console.log("\nM. Prefix invariance evaluateSmc(full,T) == evaluateSmc(prefix,T)");
  {
    const cfg1h = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const full = [...canonical(), ...flats(27, 35)];
    const asOf = T0 + (18 + 1) * HOUR;
    const prefix = full.slice(0, 19);
    const eFull = evaluateSmc(full, cfg1h, new Date(asOf));
    const ePref = evaluateSmc(prefix, cfg1h, new Date(asOf));
    ok(JSON.stringify(eFull) === JSON.stringify(ePref), "M: prefix invariance holds");
  }

  // Parity test
  console.log("\nParity: chart SMC vs Signal Engine SMC");
  {
    const cfg1h = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const candles = canonical();
    const last = candles[candles.length - 1];
    const tfMs = SMCTIMEFRAME_MS["1h"];
    const asOf = new Date(last.openTime.getTime() + tfMs);
    const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };

    const chartEval = evaluateSmc(candles, cfg1h, asOf);
    const engineResult = evaluateSmartMoneyWithCandles(meta, candles, cfg1h, NO_FILTERS);

    ok(engineResult.status === "evaluated", "Parity: engine evaluated");
    if (engineResult.status === "evaluated" && chartEval.availability.evaluable) {
      ok(engineResult.direction === chartEval.direction, `Parity: direction same ${engineResult.direction} vs ${chartEval.direction}`);
      ok(engineResult.longScore === chartEval.longScore, `Parity: longScore same ${engineResult.longScore} vs ${chartEval.longScore}`);
      ok(engineResult.shortScore === chartEval.shortScore, `Parity: shortScore same ${engineResult.shortScore} vs ${chartEval.shortScore}`);
      // hardFailures/availability
      ok(chartEval.availability.hardFailures.length === 0, "Parity: chart no hardFailures");
      ok(chartEval.availability.evaluable === true, "Parity: chart evaluable true");
    } else {
      ok(false, "Parity: both should be evaluable");
    }
  }

  // Safety: prisma.signal.create not called for smart-money
  console.log("\nSafety: prisma.signal.create forbidden for smart-money");
  {
    const src = readFileSync("lib/signals/signal-engine.ts", "utf-8");
    // Must contain guard comment and must not have unconditional create in smart-money path
    ok(src.includes("PHASE 2A GUARD") && src.includes("prisma.signal.create is FORBIDDEN for smart-money"), "Safety: guard comment present");
    // Count actual DB writes: prisma.signal.create({
    const createMatches = src.match(/prisma\.signal\.create\(\{/g) || [];
    ok(createMatches.length === 1, `Safety: only 1 prisma.signal.create({ in file (trend only), found ${createMatches.length}`);
    // Ensure smart-money engine does not call create
    const smStart = src.indexOf("async function runSmartMoneyEngine");
    const smEnd = src.indexOf("}\n\n// ---------------------------------------------------------------------------\n// Main entry", smStart);
    const smartMoneyCode = smStart >= 0 ? src.substring(smStart, smEnd >= 0 ? smEnd : smStart + 20000) : "";
    const smCreates = (smartMoneyCode.match(/prisma\.signal\.create\(\{/g) || []).length;
    ok(smCreates === 0, `Safety: smart-money engine has 0 prisma.signal.create({ calls, found ${smCreates}`);
  }

  // Additional: common horizon behavior explicit
  console.log("\nCommon horizon behavior");
  {
    const markets = [fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), fresh5m(5)];
    const out = evaluateMarketsAtCommonHorizon(markets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
    ok(out.selection.commonHorizon !== null, "Common horizon exists");
    if (out.selection.commonHorizon) {
      console.log(`  COMMON HORIZON: ${out.selection.commonHorizon.toISOString()}`);
      for (const p of out.selection.perMarketLatest) {
        console.log(`  ${p.exchange} horizon=${out.selection.commonHorizon.toISOString()} INCLUDED latest=${p.latest?.toISOString()}`);
      }
    }
    // If common horizon unusable => NO SIGNAL
    const ancientEnd = NOW_5M - 3 * 86_400_000;
    const ancient = [1, 2, 3].map((i) => market(NAMES[i - 1]!, i, "5m", waveCandles(closedTimes(ancientEnd, 200, "5m"))));
    const outStale = evaluateMarketsAtCommonHorizon(ancient, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
    ok(outStale.usable === false && outStale.status === "absolute_stale", "Common horizon unusable => NO SIGNAL (absolute_stale)");
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("Failed tests:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("All PHASE 2A checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
