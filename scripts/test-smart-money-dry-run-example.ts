/**
 * Example dry-run with fixture — not production data
 * Shows COMMON HORIZON, per-exchange evaluation, aggregation
 * Uses production functions only
 */

import { defaultSmcScoringConfig } from "../lib/smc/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import { evaluateMarketsAtCommonHorizon, type SmartMoneyMarketMeta } from "../lib/strategies/smart-money";
import { truncateCandlesToHorizon, formatCommonHorizonReport, decideAggregationAtCommonHorizon } from "../lib/strategies/common-horizon";
import { aggregateAssetGroup } from "../lib/strategies/runtime";

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
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

const EPOCH = Date.UTC(2026, 8, 11);
const T = EPOCH + 9 * 3600_000 + 50 * 60_000;
const NOW_5M = EPOCH + 9 * 3600_000 + 55 * 60_000;
const NAMES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];
function market(ex: string, id: number, tf: SmcTimeframe, candles: SmcRawCandle[]) {
  return { meta: { exchange: ex, market: `${ex}*BTCUSDT`, marketId: id, timeframe: tf, assetRank: 1, quoteVolume24h: 1_000_000 } as SmartMoneyMarketMeta, candles };
}
const fresh5m = (i: number, ex = NAMES[i - 1]!) => market(ex, i, "5m", waveCandles(closedTimes(T, 200, "5m")));
const NO_FILTERS = { top500Only: false, minimumQuoteVolume24h: 0 };
const cfg = defaultSmcScoringConfig("5m");

async function main() {
  console.log("=== EXAMPLE DRY-RUN WITH FIXTURE (not production) ===");
  console.log("Using synthetic wave candles, 5 exchanges same horizon 2026-09-11T09:50Z");
  console.log("");

  const markets = [fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), fresh5m(5)];
  const now = new Date(NOW_5M);
  const outcome = evaluateMarketsAtCommonHorizon(markets, "5m", cfg, NO_FILTERS, now);

  console.log("COMMON HORIZON:");
  console.log(outcome.selection.commonHorizon?.toISOString() ?? "null");
  console.log("");
  for (const p of outcome.selection.perMarketLatest) {
    console.log(`${p.exchange} horizon=${outcome.selection.commonHorizon?.toISOString()} INCLUDED latest=${p.latest?.toISOString()} hasCommon=${p.hasCommon}`);
  }
  console.log("");
  const report = formatCommonHorizonReport({
    selection: outcome.selection,
    timeframe: "5m",
    marketCount: 5,
    exchangeEligibleCount: 5,
    exchangeExcluded: [],
    filteredCount: 0,
  });
  for (const line of report) console.log(line);

  console.log("\n=== PER-EXCHANGE ===");
  const commonHorizon = outcome.selection.commonHorizon!;
  const tfMs = SMCTIMEFRAME_MS["5m"];
  const asOf = new Date(commonHorizon.getTime() + tfMs);
  for (const m of markets) {
    const truncated = truncateCandlesToHorizon(m.candles, commonHorizon);
    const evalSmc = evaluateSmc(truncated, cfg, asOf);
    console.log(`\nexchange=${m.meta.exchange} horizon=${commonHorizon.toISOString()} direction=${evalSmc.direction} longScore=${evalSmc.longScore} shortScore=${evalSmc.shortScore} evaluable=${evalSmc.availability.evaluable}`);
    console.log(`hardFailures=${evalSmc.availability.hardFailures.map(f=>f.code).join(",")||"none"} softUnavailable=${evalSmc.availability.softUnavailable.map(f=>f.code).join(",")||"none"}`);
    console.log("A-I contributions:");
    for (const r of evalSmc.reasons) {
      console.log(`  ${r.code} long=${r.longPoints} short=${r.shortPoints} max=${r.maxPoints} label=${r.label}`);
    }
  }

  const gate = decideAggregationAtCommonHorizon({ selection: outcome.selection, results: outcome.results, timeframe: "5m" });
  console.log(`\n=== GATE === allowed=${gate.allowed} alignment.safe=${gate.alignment.safe}`);

  const agg = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, outcome.results as any, 3);
  console.log("\n=== AGGREGATION ===");
  console.log(`eligible=5 evaluated=${agg.evaluated} minExchanges=3 longVotes=${agg.longVotes} shortVotes=${agg.shortVotes} neutralVotes=${agg.neutralVotes}`);
  console.log(`direction=${agg.direction} confirmation=${agg.confirmation} conflict=${agg.conflict}`);
  console.log(`explanation: ${agg.explanation}`);
  if (agg.direction === "NEUTRAL") {
    console.log("NEUTRAL reason: no side reached minExchanges or conflict");
  }

  console.log("\n=== SECOND EXAMPLE: 3 LONG + 2 NEUTRAL => LONG ===");
  // Simulate LONG vs NEUTRAL via mock results
  const mockLong = (id: number) => ({ status: "evaluated" as const, exchange: "EX"+id, market: "BTCUSDT", marketId: id, candleTime: commonHorizon, price: 100, longScore: 80, shortScore: 10, direction: "LONG" as const, reasons: [], warnings: [] });
  const mockNeutral = (id: number) => ({ status: "evaluated" as const, exchange: "EX"+id, market: "BTCUSDT", marketId: id, candleTime: commonHorizon, price: 100, longScore: 10, shortScore: 10, direction: "NEUTRAL" as const, reasons: [], warnings: [] });
  const agg2 = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, [mockLong(1), mockLong(2), mockLong(3), mockNeutral(4), mockNeutral(5)] as any, 3);
  console.log(`direction=${agg2.direction} longVotes=${agg2.longVotes} neutralVotes=${agg2.neutralVotes} confirmation=${agg2.confirmation}`);

  console.log("\n=== EXAMPLE DRY-RUN COMPLETE (fixture, not production) ===");
}

main().catch(e=>{ console.error(e); process.exit(1); });
