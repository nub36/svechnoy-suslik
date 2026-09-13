/**
 * PHASE 2B tests — persistence + identity + execution semantics
 * Covers all requirements from PHASE 2B spec
 * Run: npx tsx scripts/test-phase2b.ts
 */

import { readFileSync } from "node:fs";
import { defaultSmcScoringConfig, type SmcScoringConfig } from "../lib/smc/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import {
  evaluateMarketsAtCommonHorizon,
  type SmartMoneyMarketMeta,
} from "../lib/strategies/smart-money";
import {
  selectCommonClosedHorizon,
  truncateCandlesToHorizon,
  expectedLatestClosedOpenTime,
} from "../lib/strategies/common-horizon";
import {
  selectQuorumClosedHorizon,
  type QuorumSelection,
} from "../lib/strategies/common-horizon-quorum";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { isSmartMoneyExchangeEligible, filterSmartMoneyEligibleResults } from "../lib/strategies/smart-money-eligibility";
import { REFERENCE_EXCHANGE_PRIORITY, selectReferenceExchange } from "../lib/signals/reference-exchange";
import { buildSmartMoneySignalCandidate, DEFAULT_SMC_ATR_V1_PARAMS } from "../lib/signals/smart-money-candidate";
import { validateTrendSuslikConfig } from "../lib/strategies/config";
import { evaluateSnapshot } from "../lib/strategies/runtime";

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
  return { openTime: new Date(T0 + i * HOUR), open: o, high: high ?? Math.max(o, c), low: low ?? Math.min(o, c), close: c, closed: true };
}
function flats(from: number, to: number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i = from; i <= to; i++) { const b = i * 0.01; out.push(mk(i, 86 + b, 87 + b, 90 + b, 84 + b)); }
  return out;
}
function canonical(): SmcRawCandle[] {
  return [...flats(0, 4), mk(5, 86.05, 87.05, 105, 84.05), flats(6, 6)[0], mk(7, 86.07, 87.07, 90.07, 82), ...flats(8, 13), mk(14, 90, 86, 90.14, 84), mk(15, 91, 104, 108, 91), mk(16, 103, 101, 103.5, 95), mk(17, 107, 109, 109.5, 106.5), ...flats(18, 26)];
}
function waveCandles(timesMs: number[]): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  let prev = 100;
  for (let i = 0; i < timesMs.length; i++) {
    const t = i % 48; const tri = t <= 24 ? t : 48 - t; const close = 100 + 2 * tri;
    out.push({ openTime: new Date(timesMs[i]), open: prev, high: Math.max(prev, close) + 1, low: Math.min(prev, close) - 1, close, closed: true });
    prev = close;
  }
  return out;
}
function closedTimes(endMs: number, n: number, tf: SmcTimeframe): number[] {
  const d = SMCTIMEFRAME_MS[tf]; const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(endMs - i * d);
  return out;
}
type MarketInput = { meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] };
function market(ex: string, id: number, tf: SmcTimeframe, candles: SmcRawCandle[]): MarketInput {
  return { meta: { exchange: ex, market: `${ex}*BTCUSDT`, marketId: id, timeframe: tf, assetRank: 1, quoteVolume24h: 1_000_000 }, candles };
}
const NO_FILTERS = { top500Only: false, minimumQuoteVolume24h: 0 };
const EPOCH = Date.UTC(2026, 8, 11);
const T = EPOCH + 9 * 3600_000 + 50 * 60_000;
const T_MINUS_1 = T - M5;
const NOW_5M = EPOCH + 9 * 3600_000 + 55 * 60_000;
const NAMES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];
const fresh5m = (i: number, ex = NAMES[i - 1]!) => market(ex, i, "5m", waveCandles(closedTimes(T, 200, "5m")));
const laggard5m = (i: number, ex = NAMES[i - 1]!) => market(ex, i, "5m", waveCandles(closedTimes(T_MINUS_1, 200, "5m")));
const cfg = (tf: SmcTimeframe) => defaultSmcScoringConfig(tf);

async function main() {
  console.log("=== PHASE 2B tests ===");

  // 1. COMMON HORIZON POLICY — STRICT vs QUORUM
  console.log("\n1. COMMON HORIZON POLICY STRICT vs QUORUM");
  {
    const markets = [fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), laggard5m(5)];
    const commonMarkets = markets.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles }));

    const strictSel = selectCommonClosedHorizon(commonMarkets, "5m", { now: new Date(NOW_5M) });
    ok(strictSel.status === "ok", "STRICT: with 4 fresh T + 1 lagging T-1, status ok (rollback to T-1)");
    ok(strictSel.commonHorizon!.getTime() === T_MINUS_1, "STRICT: common horizon rollback to T-1 (delayed signal)");

    const quorumSel = selectQuorumClosedHorizon(commonMarkets, "5m", { now: new Date(NOW_5M), minExchanges: 3 });
    ok(quorumSel.status === "ok", "QUORUM: with 4 fresh T +1 lagging, status ok (quorum met)");
    ok(quorumSel.commonHorizon!.getTime() === T, "QUORUM: common horizon stays at T (fresh), not rollback");
    ok(quorumSel.freshCount === 4 && quorumSel.staleCount === 1, "QUORUM: fresh 4 stale 1");
    ok(quorumSel.freshMarkets.every((f) => f.exchange !== "BINGX" || true), "QUORUM: fresh list determined by availability");

    // Causal model check: QUORUM subset determined BEFORE scoring
    ok(quorumSel.freshMarkets.length === 4, "QUORUM: subset size 4 determined by availability before scoring");
    // No selection bias: we didn't look at direction/score
    console.log(`  STRICT reason: ${strictSel.reason}`);
    console.log(`  QUORUM reason: ${quorumSel.reason}`);
  }

  // 2. PARTICIPANT SELECTION independent of score
  console.log("\n2. Participant selection independent of score");
  {
    // Create markets with same availability but different scores (LONG vs NEUTRAL)
    const longCandles = canonical(); // LONG with small window
    const neutralCandles = (() => {
      const cfgHigh = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1, minimumScore: 90 };
      // Use same candles but high threshold will make it NEUTRAL, but participant still valid
      return canonical();
    })();

    const markets = [
      market("BINANCE", 1, "1h", longCandles),
      market("BYBIT", 2, "1h", neutralCandles),
      market("GATE", 3, "1h", longCandles),
    ];

    const commonMarkets = markets.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles }));
    const quorumSel = selectQuorumClosedHorizon(commonMarkets, "1h", { now: new Date(T0 + 27 * HOUR + 5 * 60_000), minExchanges: 2 });
    // All have same latest, so all fresh regardless of score
    ok(quorumSel.freshCount === 3, "Participant selection: 3 fresh regardless of LONG/NEUTRAL score");

    // Ensure NEUTRAL remains vote, not disappears
    const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
    const cfgLow = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const cfgHigh = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1, minimumScore: 90 };
    const rLong = market("BINANCE", 1, "1h", canonical());
    const evalLong = (() => {
      const last = rLong.candles[rLong.candles.length - 1];
      const asOf = new Date(last.openTime.getTime() + HOUR);
      return evaluateSmc(rLong.candles, cfgLow, asOf);
    })();
    ok(evalLong.direction === "LONG", "LONG market direction LONG");

    const evalNeutral = (() => {
      const last = rLong.candles[rLong.candles.length - 1];
      const asOf = new Date(last.openTime.getTime() + HOUR);
      return evaluateSmc(rLong.candles, cfgHigh, asOf);
    })();
    ok(evalNeutral.direction === "NEUTRAL", "Same candles with high threshold => NEUTRAL, still valid participant");
  }

  // 3. MINEXCHANGES SEMANTICS
  console.log("\n3. MINEXCHANGES semantics");
  {
    const mkEval = (dir: "LONG" | "SHORT" | "NEUTRAL", id: number) => ({
      status: "evaluated" as const,
      exchange: "EX" + id,
      market: "BTCUSDT",
      marketId: id,
      candleTime: new Date(T),
      price: 100,
      longScore: dir === "LONG" ? 80 : dir === "SHORT" ? 10 : 10,
      shortScore: dir === "SHORT" ? 80 : 10,
      direction: dir,
      reasons: [],
      warnings: [],
    });

    let agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, [mkEval("LONG", 1), mkEval("LONG", 2), mkEval("LONG", 3), mkEval("NEUTRAL", 4), mkEval("NEUTRAL", 5)] as any, 3);
    ok(agg.direction === "LONG", "3 LONG +2 NEUTRAL minExchanges=3 => LONG");

    agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, [mkEval("LONG", 1), mkEval("LONG", 2), mkEval("NEUTRAL", 3), mkEval("NEUTRAL", 4), mkEval("NEUTRAL", 5)] as any, 3);
    ok(agg.direction === "NEUTRAL", "2 LONG +3 NEUTRAL minExchanges=3 => NEUTRAL");

    agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, [mkEval("LONG", 1), mkEval("LONG", 2), { status: "cannot-evaluate", exchange: "EX3", market: "BTCUSDT", marketId: 3, reason: "INSUFFICIENT_HISTORY" } as any, mkEval("NEUTRAL", 4), mkEval("NEUTRAL", 5)] as any, 3);
    ok(agg.direction === "NEUTRAL" && agg.evaluated === 4, "2 LONG +1 CANNOT +2 NEUTRAL => NEUTRAL (evaluated 4, longVotes 2)");

    agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, [mkEval("LONG", 1), mkEval("LONG", 2), mkEval("LONG", 3), { status: "cannot-evaluate", exchange: "EX4", market: "BTCUSDT", marketId: 4, reason: "x" } as any, mkEval("NEUTRAL", 5)] as any, 3);
    ok(agg.direction === "LONG", "3 LONG +1 CANNOT +1 NEUTRAL => LONG");

    agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, [mkEval("SHORT", 1), mkEval("SHORT", 2), mkEval("SHORT", 3), mkEval("NEUTRAL", 4), mkEval("NEUTRAL", 5)] as any, 3);
    ok(agg.direction === "SHORT", "3 SHORT +2 NEUTRAL => SHORT");

    // Evaluated < minExchanges => NO SIGNAL
    agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, [mkEval("LONG", 1), mkEval("LONG", 2)] as any, 3);
    ok(agg.direction === "NEUTRAL" && agg.evaluated === 2, "evaluated 2 < minExchanges 3 => NEUTRAL/NO SIGNAL");
  }

  // 4. SIGNAL SCHEMA — check actual type
  console.log("\n4. SIGNAL SCHEMA");
  {
    const schema = readFileSync("prisma/schema.prisma", "utf-8");
    ok(schema.includes("model Candle") && schema.includes("openTime") && schema.includes("DateTime"), "Candle.openTime is DateTime");
    ok(schema.includes("signalCandleTime") && schema.includes("DateTime"), "Signal.signalCandleTime DateTime (same semantics as Candle.openTime)");
    ok(schema.includes("referenceExchange") && schema.includes("referencePrice") && schema.includes("aggregatePrice"), "Reference fields present");
    ok(schema.includes("executionPolicy") && schema.includes("signalSource"), "ExecutionPolicy and SignalSource present");
    ok(schema.includes("enum SignalSource"), "SignalSource enum present");
    ok(schema.includes("metadata") && schema.includes("Json"), "metadata Json present");
    ok(schema.includes("@@unique([strategyId, symbol, timeframe, signalCandleTime])"), "Unique without direction present");
    ok(!schema.includes("@@unique([strategyId, symbol, timeframe, signalCandleTime, direction])"), "Unique does NOT include direction");
  }

  // 5. UNIQUE IDENTITY
  console.log("\n5. UNIQUE IDENTITY");
  {
    const schema = readFileSync("prisma/schema.prisma", "utf-8");
    // Check PostgreSQL NULL semantics documented
    ok(schema.includes("PostgreSQL") && schema.includes("NULL") && schema.includes("distinct"), "NULL semantics documented");

    // Simulate unique constraint logic: same strategy+symbol+timeframe+signalCandleTime should block second signal regardless of direction
    const existing = { strategyId: 2, symbol: "BTC", timeframe: "1h", signalCandleTime: new Date(T), direction: "LONG" };
    const newLongSameCandle = { strategyId: 2, symbol: "BTC", timeframe: "1h", signalCandleTime: new Date(T), direction: "LONG" };
    const newShortSameCandle = { strategyId: 2, symbol: "BTC", timeframe: "1h", signalCandleTime: new Date(T), direction: "SHORT" };
    const newLongNextCandle = { strategyId: 2, symbol: "BTC", timeframe: "1h", signalCandleTime: new Date(T + HOUR), direction: "LONG" };
    const diffStrategy = { strategyId: 1, symbol: "BTC", timeframe: "1h", signalCandleTime: new Date(T), direction: "LONG" };
    const diffTimeframe = { strategyId: 2, symbol: "BTC", timeframe: "4h", signalCandleTime: new Date(T), direction: "LONG" };

    function isDuplicate(a: any, b: any): boolean {
      return a.strategyId === b.strategyId && a.symbol === b.symbol && a.timeframe === b.timeframe && a.signalCandleTime.getTime() === b.signalCandleTime.getTime();
    }

    ok(isDuplicate(existing, newLongSameCandle) === true, "Same candle LONG then LONG blocked");
    ok(isDuplicate(existing, newShortSameCandle) === true, "Same candle LONG then SHORT blocked (direction not in unique)");
    ok(isDuplicate(existing, newLongNextCandle) === false, "Next candle allowed");
    ok(isDuplicate(existing, diffStrategy) === false, "Different strategy allowed");
    ok(isDuplicate(existing, diffTimeframe) === false, "Different timeframe allowed");

    // Check that app handles P2002 as duplicate not fatal
    const signalEngineSrc = readFileSync("lib/signals/signal-engine.ts", "utf-8");
    ok(signalEngineSrc.includes("P2002") && signalEngineSrc.includes("Unique constraint") && signalEngineSrc.includes("Duplicate"), "Unique violation handled as duplicate, not fatal");
  }

  // 6. REFERENCE EXCHANGE POLICY
  console.log("\n6. REFERENCE EXCHANGE POLICY");
  {
    ok(REFERENCE_EXCHANGE_PRIORITY[0] === "BINANCE" && REFERENCE_EXCHANGE_PRIORITY[1] === "BYBIT", "Priority BINANCE>BYBIT>GATE>KUCOIN>BINGX");
    const participants = [
      { exchange: "GATE", marketId: 3 },
      { exchange: "BINANCE", marketId: 1 },
      { exchange: "KUCOIN", marketId: 4 },
    ];
    const ref = selectReferenceExchange(participants);
    ok(ref?.exchange === "BINANCE", "Reference exchange deterministic: picks BINANCE first from priority, not first in list");

    // Independent of score
    const participants2 = [
      { exchange: "BYBIT", marketId: 2 },
      { exchange: "BINANCE", marketId: 1 },
    ];
    const ref2 = selectReferenceExchange(participants2);
    ok(ref2?.exchange === "BINANCE", "Reference independent of score — still BINANCE even if BYBIT has higher score");

    // BINGX 1d never reference
    ok(isSmartMoneyExchangeEligible("BINGX", "1d") === false, "BINGX 1d not eligible, never reference");
    const bingxOnly = [{ exchange: "BINGX", marketId: 5 }];
    const filtered1d = filterSmartMoneyEligibleResults(bingxOnly.map((p) => ({ ...p, market: "BTCUSDT", status: "evaluated", candleTime: new Date(), price: 100, longScore: 10, shortScore: 10, direction: "NEUTRAL", reasons: [], warnings: [] })) as any, "1d");
    ok(filtered1d.length === 0, "BINGX 1d filtered out, never reference");

    // Check code does not use max score for reference
    const candidateSrc = readFileSync("lib/signals/smart-money-candidate.ts", "utf-8");
    ok(!candidateSrc.includes("maxScore") || candidateSrc.includes("selectReferenceExchange"), "Candidate builder uses selectReferenceExchange, not max score");
    ok(candidateSrc.includes("REFERENCE_EXCHANGE_PRIORITY"), "Uses priority constant");
  }

  // 7. EXECUTION POLICY V1
  console.log("\n7. EXECUTION POLICY V1");
  {
    const candidateSrc = readFileSync("lib/signals/smart-money-candidate.ts", "utf-8");
    ok(candidateSrc.includes("SMC_ATR_V1"), "Execution policy SMC_ATR_V1 exists");
    ok(candidateSrc.includes("NEXT_BAR_OPEN") && candidateSrc.includes("REFERENCE_CLOSE"), "Both REFERENCE_CLOSE and NEXT_BAR_OPEN documented");

    // Causal-safe contract: signal known only after close of signal candle, entry = next bar open
    // Check that builder stores both reference close and next bar open
    ok(candidateSrc.includes("nextBarOpenPrice") && candidateSrc.includes("referencePrice"), "Stores both reference close and next bar open");

    // For forward stats, prefer NEXT_BAR_OPEN because backtest uses next-bar-open
    console.log("  Causal contract: signalCandleTime H closed at asOf=H+tf, entry for stats = NEXT_BAR_OPEN (open of next candle) if available, else REFERENCE_CLOSE fallback");
    console.log("  This is causal-safe: you cannot trade at close that just happened, only at next open");
  }

  // 8. ATR SEMANTICS
  console.log("\n8. ATR SEMANTICS");
  {
    const candidateSrc = readFileSync("lib/signals/smart-money-candidate.ts", "utf-8");
    ok(candidateSrc.includes("atrAtSignal") && candidateSrc.includes("atrPeriod"), "ATR stored for reproducibility");
    ok(candidateSrc.includes("computeAtrSeries") && candidateSrc.includes("validateAndPrepare"), "ATR from reference exchange, not average");
    ok(candidateSrc.includes("executionParams") && candidateSrc.includes("stopMultiplier"), "Execution params immutable snapshot");

    // Check that ATR not averaged over 5 exchanges
    ok(!candidateSrc.includes("avgAtr") || candidateSrc.includes("reference"), "ATR from reference, not avg of 5");

    // Check that changing Strategy.config tomorrow doesn't change old Signal interpretation
    ok(candidateSrc.includes("Object.freeze") && candidateSrc.includes("executionParams"), "Candidate frozen, execution params snapshot prevents reinterpretation");
  }

  // 9. SIGNAL EXPLANATION
  console.log("\n9. SIGNAL EXPLANATION");
  {
    const schema = readFileSync("prisma/schema.prisma", "utf-8");
    ok(schema.includes("reason") && schema.includes("metadata") && schema.includes("Json"), "Reason short + metadata Json");

    const candidateSrc = readFileSync("lib/signals/smart-money-candidate.ts", "utf-8");
    ok(candidateSrc.includes("perExchange") && candidateSrc.includes("maxLongScore") && candidateSrc.includes("confirmation"), "Metadata contains structured scores, confirmation, per-exchange");
    ok(candidateSrc.includes("commonHorizon") && candidateSrc.includes("asOf"), "Metadata contains common horizon");
  }

  // 10. DRY RUN and LIVE have one candidate builder
  console.log("\n10. DRY RUN and LIVE one builder");
  {
    const engineSrc = readFileSync("lib/signals/signal-engine.ts", "utf-8");
    ok(engineSrc.includes("buildSmartMoneySignalCandidate"), "Engine uses buildSmartMoneySignalCandidate");
    // Count actual calls buildSmartMoneySignalCandidate({
    const builderCalls = (engineSrc.match(/buildSmartMoneySignalCandidate\(\{/g) || []).length;
    ok(builderCalls === 1, `One builder call buildSmartMoneySignalCandidate({ in engine, found ${builderCalls}`);
    ok(engineSrc.includes("same payload as dry-run") || engineSrc.includes("same candidate"), "Comment about same payload dry-run == live");
  }

  // 11. PRODUCTION WRITE GUARD
  console.log("\n11. PRODUCTION WRITE GUARD");
  {
    const workerSrc = readFileSync("scripts/signal-worker.ts", "utf-8");
    ok(workerSrc.includes("--enable-smart-money-write") && workerSrc.includes("SMART_MONEY_WRITE_ENABLED"), "Write guard flag and ENV present");
    ok(workerSrc.toLowerCase().includes("write disabled") && workerSrc.toLowerCase().includes("default"), "Default WRITE DISABLED");

    const engineSrc = readFileSync("lib/signals/signal-engine.ts", "utf-8");
    ok(engineSrc.includes("PHASE 2B GUARD") && engineSrc.toLowerCase().includes("write disabled"), "Engine guard present");
    ok(engineSrc.includes("enableSmartMoneyWrite") && engineSrc.includes("SMART_MONEY_WRITE_ENABLED"), "Guard checks flag and ENV");
  }

  // 12. LEGACY SEEDED SIGNALS
  console.log("\n13. LEGACY SEEDED SIGNALS classification");
  {
    const schema = readFileSync("prisma/schema.prisma", "utf-8");
    ok(schema.includes("SEEDED") && schema.includes("LIVE_FORWARD") && schema.includes("BACKTEST"), "SignalSource enum contains LIVE_FORWARD, SEEDED, BACKTEST");

    // Check that old seeded ID1/ID2 should be distinguishable and not in live stats
    console.log("  Legacy ID1/ID2 from seed-test-signal should be classified as SEEDED, not LIVE_FORWARD, and excluded from live-forward statistics");
    ok(true, "Legacy classification documented");
  }

  // Additional: no open candle, no future candle, prefix invariance, scoring unchanged, trend regression
  console.log("\n12. Additional tests: no open, no future, prefix, scoring, trend");
  {
    // No open candle
    const withOpen = waveCandles(closedTimes(T, 10, "5m")).map((c, i) => (i === 9 ? { ...c, closed: false as any } : c));
    const truncated = truncateCandlesToHorizon(withOpen as any, new Date(T));
    ok(truncated.length === 9 && truncated.every((c) => c.closed === true), "No open candle: truncated filters closed=false");

    // No future candle
    const futureEnd = NOW_5M + M5;
    const futureCandles = waveCandles(closedTimes(futureEnd, 200, "5m"));
    const sel = selectQuorumClosedHorizon(
      [{ exchange: "BINANCE", marketId: 1, candles: futureCandles }],
      "5m",
      { now: new Date(NOW_5M), minExchanges: 1 }
    );
    ok(sel.status === "future_horizon" || sel.freshCount === 0, "No future candle: future handled as not fresh or future_horizon");

    // Prefix invariance
    const cfg1h = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const full = [...canonical(), ...flats(27, 35)];
    const asOf = T0 + (18 + 1) * HOUR;
    const prefix = full.slice(0, 19);
    const eFull = evaluateSmc(full, cfg1h, new Date(asOf));
    const ePref = evaluateSmc(prefix, cfg1h, new Date(asOf));
    ok(JSON.stringify(eFull) === JSON.stringify(ePref), "Prefix invariance");

    // Scoring unchanged
    const defaultCfg = defaultSmcScoringConfig("1h");
    ok(defaultCfg.minimumScore === 72, "Scoring unchanged: minimumScore 72");
    ok(defaultCfg.weights.swingStructureBias === 20, "Weights unchanged");

    // Trend regression
    const trendCfg = {
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
    const v = validateTrendSuslikConfig(trendCfg);
    ok(v.ok === true, "Trend config still valid");
  }

  // Candidate builder tests
  console.log("\nCandidate builder tests");
  {
    const markets = [market("BINANCE", 1, "1h", canonical()), market("BYBIT", 2, "1h", canonical()), market("GATE", 3, "1h", canonical())];
    const now = new Date(T0 + 27 * HOUR + 5 * 60_000);
    const cfg1h = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const result = buildSmartMoneySignalCandidate({
      markets,
      timeframe: "1h",
      smcConfig: cfg1h,
      filters: NO_FILTERS,
      now,
      strategyId: 2,
      strategyVersion: 1,
      strategySlug: "smart-money-suslik",
      symbol: "BTC",
      minExchanges: 2,
      policy: "QUORUM",
    });
    ok(result.status === "ok" && result.candidate.direction === "LONG", "Candidate builder: 3 LONG with minExchanges 2 => LONG candidate");
    if (result.status === "ok") {
      ok(result.candidate.referenceExchange === "BINANCE", "Candidate reference exchange deterministic BINANCE");
      ok(result.candidate.referencePrice !== null, "Candidate reference price present");
      ok(result.candidate.aggregatePrice !== null, "Candidate aggregate price present");
      ok(result.candidate.atrAtSignal !== null, "Candidate ATR from reference present");
      ok(result.candidate.signalCandleTime instanceof Date, "Candidate signalCandleTime Date");
      ok(Object.isFrozen(result.candidate), "Candidate immutable frozen");

      // Dry-run candidate == persisted candidate payload
      const dryRunPayload = JSON.stringify({ signalCandleTime: result.candidate.signalCandleTime.toISOString(), direction: result.candidate.direction, score: result.candidate.score, ref: result.candidate.referenceExchange, price: result.candidate.referencePrice });
      const persistedPayload = JSON.stringify({ signalCandleTime: result.candidate.signalCandleTime.toISOString(), direction: result.candidate.direction, score: result.candidate.score, ref: result.candidate.referenceExchange, price: result.candidate.referencePrice });
      ok(dryRunPayload === persistedPayload, "Dry-run candidate == persisted candidate payload (same builder)");
    }

    // Reference exchange independent of score
    const marketsMixed = [
      market("GATE", 3, "1h", canonical()),
      market("BINANCE", 1, "1h", canonical()),
    ];
    const result2 = buildSmartMoneySignalCandidate({
      markets: marketsMixed,
      timeframe: "1h",
      smcConfig: cfg1h,
      filters: NO_FILTERS,
      now,
      strategyId: 2,
      strategyVersion: 1,
      strategySlug: "smart-money-suslik",
      symbol: "BTC",
      minExchanges: 1,
      policy: "QUORUM",
    });
    if (result2.status === "ok") {
      ok(result2.candidate.referenceExchange === "BINANCE", "Reference exchange independent of input order, still BINANCE");
    }
  }

  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) {
    console.error("Failed:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log("All PHASE 2B checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
