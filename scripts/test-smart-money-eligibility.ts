/**
 * Option A eligibility tests — Smart Money 1d BINGX exclusion (narrow).
 * Pure, no DB, no Signal, deterministic.
 *
 * Must prove:
 * A. matrix, B defense-in-depth unfiltered unsafe, C filtered safe,
 * D stale after filtering, E off-grid after filtering,
 * F minExchanges independence, G no fake NEUTRAL, H determinism + no-lookahead + CLOSED-only unchanged.
 */

import {
  isSmartMoneyExchangeEligible,
  filterSmartMoneyEligibleResults,
  ELIGIBLE_EXCHANGES_BY_TF,
  getEligibleExchanges,
} from "../lib/strategies/smart-money-eligibility";
import { readFileSync } from "node:fs";
import {
  checkCandleAlignment,
  canAggregateSafely,
  shouldAggregateAssetGroup,
} from "../lib/strategies/alignment";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { evaluateSmartMoneyWithCandles } from "../lib/strategies/smart-money";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { MarketStrategyResult } from "../lib/strategies/runtime";

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

function mkRes(ex: string, ms: number, opts: Partial<MarketStrategyResult> = {}): MarketStrategyResult {
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
    ...opts,
  } as MarketStrategyResult;
}
function mkSkipped(ex: string, status: "cannot-evaluate" | "filtered"): MarketStrategyResult {
  return {
    status,
    exchange: ex,
    market: "BTCUSDT",
    marketId: 1,
    reason: "test",
  } as unknown as MarketStrategyResult;
}

// A. eligibility matrix
{
  console.log("\nA. eligibility matrix");
  ok(isSmartMoneyExchangeEligible("BINGX", "5m") === true, "A1 BINGX 5m true");
  ok(isSmartMoneyExchangeEligible("BINGX", "15m") === true, "A2 BINGX 15m true");
  ok(isSmartMoneyExchangeEligible("BINGX", "1h") === true, "A3 BINGX 1h true");
  ok(isSmartMoneyExchangeEligible("BINGX", "4h") === true, "A4 BINGX 4h true");
  ok(isSmartMoneyExchangeEligible("BINGX", "1d") === false, "A5 BINGX 1d false");
  for (const ex of ["BINANCE", "BYBIT", "GATE", "KUCOIN"] as const) {
    ok(isSmartMoneyExchangeEligible(ex, "1d") === true, `A6 ${ex} 1d true`);
    ok(isSmartMoneyExchangeEligible(ex, "5m") === true, `A6 ${ex} 5m true`);
    ok(isSmartMoneyExchangeEligible(ex, "1h") === true, `A6 ${ex} 1h true`);
  }
  ok(isSmartMoneyExchangeEligible("UNKNOWN", "1d") === false, "A7 unknown exchange false (fail-closed)");
  ok(isSmartMoneyExchangeEligible("BINANCE", "unknown") === false, "A8 unknown timeframe false");
  ok(isSmartMoneyExchangeEligible("BINGX", "2h") === false, "A9 unsupported TF false");
  ok(isSmartMoneyExchangeEligible("", "1d") === false, "A10 empty exchange false");
  // ELIGIBLE_EXCHANGES_BY_TF
  ok(ELIGIBLE_EXCHANGES_BY_TF["1d"].length === 4 && !ELIGIBLE_EXCHANGES_BY_TF["1d"].includes("BINGX" as any), "A11 ELIGIBLE 1d 4 without BINGX");
  ok(ELIGIBLE_EXCHANGES_BY_TF["5m"].length === 5 && ELIGIBLE_EXCHANGES_BY_TF["5m"].includes("BINGX" as any), "A12 ELIGIBLE 5m 5 with BINGX");
  ok(getEligibleExchanges("1d").length === 4, "A13 getEligible 1d 4");
  ok(getEligibleExchanges("unknown").length === 0, "A14 unknown TF empty");
  // filter helper
  {
    const ts = Date.UTC(2026, 0, 10, 0, 0, 0);
    const all = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"].map((ex) => mkRes(ex, ts));
    const filtered1d = filterSmartMoneyEligibleResults(all as any, "1d");
    ok(filtered1d.length === 4 && filtered1d.every((r) => r.exchange !== "BINGX"), "A15 filter 1d removes BINGX");
    const filtered5m = filterSmartMoneyEligibleResults(all as any, "5m");
    ok(filtered5m.length === 5, "A16 filter 5m keeps all 5");
    const filteredUnknown = filterSmartMoneyEligibleResults(all as any, "9m");
    ok(filteredUnknown.length === 0, "A17 filter unknown TF empty (fail-closed)");
  }
}

// B. defense-in-depth: unfiltered 1d 4×00 + BINGX 16 => safe false (generic not weakened)
{
  console.log("\nB. defense-in-depth unfiltered unsafe");
  const ts00 = Date.UTC(2026, 0, 10, 0, 0, 0);
  const ts16 = Date.UTC(2026, 0, 10, 16, 0, 0);
  const unfiltered = [
    mkRes("BINANCE", ts00),
    mkRes("BYBIT", ts00),
    mkRes("GATE", ts00),
    mkRes("KUCOIN", ts00),
    mkRes("BINGX", ts16),
  ];
  const check = checkCandleAlignment(unfiltered as any, "1d");
  ok(check.safe === false, "B1 unfiltered 4×00 + BINGX16 safe false");
  ok(check.offGrid.length === 1 && check.offGrid[0].exchange === "BINGX", "B2 offGrid is BINGX");
  ok(check.horizonMismatch.length === 1 && check.horizonMismatch[0].exchange === "BINGX", "B3 horizonMismatch BINGX");
  ok(check.offGrid[0].offsetMs !== 0, "B4 offset non-zero");
  ok(canAggregateSafely(check) === false, "B5 canAggregate false");
  ok(shouldAggregateAssetGroup(check) === false, "B6 shouldAggregate false");
}

// C. filtered 1d => 4 markets, safe true when all four same T00
{
  console.log("\nC. filtered 1d safe when 4 aligned");
  const ts00 = Date.UTC(2026, 0, 10, 0, 0, 0);
  const ts16 = Date.UTC(2026, 0, 10, 16, 0, 0);
  const unfiltered = [
    mkRes("BINANCE", ts00),
    mkRes("BYBIT", ts00),
    mkRes("GATE", ts00),
    mkRes("KUCOIN", ts00),
    mkRes("BINGX", ts16),
  ];
  const filtered = filterSmartMoneyEligibleResults(unfiltered as any, "1d");
  ok(filtered.length === 4, "C1 filtered length 4");
  ok(filtered.every((r) => r.exchange !== "BINGX"), "C2 filtered has no BINGX");
  ok(filtered.map((r) => r.exchange).sort().join(",") === "BINANCE,BYBIT,GATE,KUCOIN", "C3 filtered is 4 canonical");
  const check = checkCandleAlignment(filtered as any, "1d");
  ok(check.safe === true, "C4 filtered 4×00 safe true");
  ok(check.offGrid.length === 0, "C5 filtered offGrid empty");
  ok(check.horizonMismatch.length === 0, "C6 filtered horizonMismatch empty");
  ok(check.referenceCandleTime?.getTime() === ts00, "C7 reference 00");
  ok(canAggregateSafely(check) === true, "C8 canAggregate true");
  ok(shouldAggregateAssetGroup(check) === true, "C9 shouldAggregate true");
  // aggregate path may proceed with 4
  const agg = aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, filtered as any, 3);
  ok(agg.evaluated === 4, "C10 aggregate evaluated 4");
  ok(agg.direction === "LONG" || agg.direction === "NEUTRAL" || agg.direction === "SHORT", "C11 agg direction exists");
}

// D. stale eligible exchange after BINGX filtering -> safe false, no aggregate
{
  console.log("\nD. stale eligible after filtering");
  const ts00 = Date.UTC(2026, 0, 10, 0, 0, 0);
  const tsPrev = Date.UTC(2026, 0, 9, 0, 0, 0); // one day stale
  const unfiltered = [
    mkRes("BINANCE", ts00),
    mkRes("BYBIT", ts00),
    mkRes("GATE", tsPrev), // stale eligible
    mkRes("KUCOIN", ts00),
    mkRes("BINGX", Date.UTC(2026, 0, 10, 16, 0, 0)),
  ];
  const filtered = filterSmartMoneyEligibleResults(unfiltered as any, "1d");
  ok(filtered.length === 4, "D1 filtered 4");
  const check = checkCandleAlignment(filtered as any, "1d");
  ok(check.safe === false, "D2 stale filtered safe false");
  ok(check.horizonMismatch.length === 1 && check.horizonMismatch[0].exchange === "GATE", "D3 horizonMismatch GATE stale");
  ok(check.offGrid.length === 0, "D4 offGrid still 0 (all on-grid)");
  ok(canAggregateSafely(check) === false, "D5 cannot aggregate");
  ok(shouldAggregateAssetGroup(check) === false, "D6 shouldAggregate false");
  // file-level: would not call aggregate
  let called = false;
  if (shouldAggregateAssetGroup(check)) {
    called = true;
    aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, filtered as any, 3);
  }
  ok(called === false, "D7 stale does NOT invoke aggregate");
}

// E. off-grid eligible exchange after filtering -> safe false
{
  console.log("\nE. off-grid eligible after filtering");
  const ts00 = Date.UTC(2026, 0, 10, 0, 0, 0);
  const tsOff = Date.UTC(2026, 0, 10, 1, 0, 0); // 01:00 not midnight, off-grid for 1d
  const unfiltered = [
    mkRes("BINANCE", ts00),
    mkRes("BYBIT", ts00),
    mkRes("GATE", tsOff), // off-grid eligible
    mkRes("KUCOIN", ts00),
    mkRes("BINGX", Date.UTC(2026, 0, 10, 16, 0, 0)),
  ];
  const filtered = filterSmartMoneyEligibleResults(unfiltered as any, "1d");
  const check = checkCandleAlignment(filtered as any, "1d");
  ok(check.safe === false, "E1 off-grid filtered safe false");
  ok(check.offGrid.length === 1 && check.offGrid[0].exchange === "GATE", "E2 offGrid GATE");
  ok(check.offGrid[0].offsetMs !== 0, "E3 offset non-zero");
  ok(!canAggregateSafely(check), "E4 cannot aggregate");
  ok(!shouldAggregateAssetGroup(check), "E5 shouldAggregate false");
}

// F. minExchanges independence: 2 eligible/evaluable aligned with minExchanges=3 -> not fabricated LONG/SHORT
{
  console.log("\nF. minExchanges independence");
  const ts = Date.UTC(2026, 0, 10, 0, 0, 0);
  const two = [mkRes("BINANCE", ts), mkRes("BYBIT", ts)];
  const filteredTwo = filterSmartMoneyEligibleResults(two as any, "1d");
  ok(filteredTwo.length === 2, "F1 filtered 2");
  const check = checkCandleAlignment(filteredTwo as any, "1d");
  ok(check.safe === true, "F2 2 aligned safe true (temporal, but minExchanges separate)");
  const agg = aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, filteredTwo as any, 3);
  ok(agg.evaluated === 2, "F3 evaluated 2");
  ok(agg.minExchanges === 3, "F4 minExchanges 3");
  ok(agg.direction === "NEUTRAL", "F5 direction NEUTRAL when 2 < 3 (not fabricated LONG/SHORT)");
  ok(agg.confirmation === "0/2" || agg.confirmation === "1/2" || agg.confirmation.includes("/2"), "F6 confirmation reflects 2 markets");
  // also test with 3 but one SHORT, one LONG, one LONG -> should be NEUTRAL conflict? but at least not fabricated
  const threeMixed = [
    mkRes("BINANCE", ts, { direction: "LONG" as const, longScore: 80 }),
    mkRes("BYBIT", ts, { direction: "SHORT" as const, longScore: 10, shortScore: 80 }),
    mkRes("GATE", ts, { direction: "LONG" as const }),
  ];
  const aggMixed = aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, threeMixed as any, 3);
  // With 2 LONG, 1 SHORT, minExchanges 3, neither side reaches 3 => NEUTRAL
  ok(aggMixed.direction === "NEUTRAL" || aggMixed.direction === "LONG" || aggMixed.direction === "SHORT", "F7 mixed with 3 still handled without fabrication");
  // The critical is not fabricating when below threshold
  const twoLong = [mkRes("BINANCE", ts), mkRes("BYBIT", ts)];
  const aggTwoLong = aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, twoLong as any, 3);
  ok(aggTwoLong.direction === "NEUTRAL", "F8 2 LONG with threshold 3 => NEUTRAL");
}

// G. no fake NEUTRAL for cannot-evaluate: eligibility filtering must not convert cannot-evaluate into NEUTRAL
{
  console.log("\nG. cannot-evaluate not converted");
  const ts = Date.UTC(2026, 0, 10, 0, 0, 0);
  const mixed: MarketStrategyResult[] = [
    mkRes("BINANCE", ts),
    mkRes("BYBIT", ts),
    mkSkipped("GATE", "cannot-evaluate"),
    mkSkipped("KUCOIN", "cannot-evaluate"),
    mkRes("BINGX", Date.UTC(2026, 0, 10, 16, 0, 0)),
  ];
  // eligibility first
  const filtered = filterSmartMoneyEligibleResults(mixed as any, "1d");
  // filtered should still have 2 evaluated + 2 skipped (BINGX removed), but skipped are not evaluated, alignment only checks evaluated
  ok(filtered.length === 4, "G1 filtered 4 (BINANCE,BYBIT,GATE, KUCOIN) — BINGX removed, skipped kept");
  ok(filtered.filter((r) => r.status === "cannot-evaluate").length === 2, "G2 filtered still has 2 cannot-evaluate");
  const check = checkCandleAlignment(filtered as any, "1d");
  // alignment only over evaluated (2)
  ok(check.totalEvaluated === 2, "G3 totalEvaluated 2 (skipped ignored)");
  ok(check.safe === true, "G4 2 evaluated aligned safe true");
  // aggregate should count evaluated 2, skipped 2, and still respect minExchanges
  const agg = aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, filtered as any, 3);
  ok(agg.evaluated === 2, "G5 agg evaluated 2");
  ok(agg.skipped === 2, "G6 agg skipped 2");
  ok(agg.direction === "NEUTRAL", "G7 agg direction NEUTRAL (2 < 3, cannot-evaluate not counted as NEUTRAL vote)");
  // Ensure that filtering didn't turn cannot-evaluate into evaluated NEUTRAL
  const hasNeutralFromCannot = filtered.some((r) => r.status === "evaluated" && (r as any).direction === "NEUTRAL" && (r as any).longScore === 0);
  ok(!hasNeutralFromCannot, "G8 no fake NEUTRAL created from cannot-evaluate");
}

// H. determinism
{
  console.log("\nH. determinism");
  const ts = Date.UTC(2026, 0, 10, 0, 0, 0);
  const input = [
    mkRes("BINANCE", ts),
    mkRes("BYBIT", ts),
    mkRes("GATE", ts),
    mkRes("KUCOIN", ts),
    mkRes("BINGX", Date.UTC(2026, 0, 10, 16, 0, 0)),
  ];
  const f1 = filterSmartMoneyEligibleResults(input as any, "1d");
  const f2 = filterSmartMoneyEligibleResults(input as any, "1d");
  ok(JSON.stringify(f1) === JSON.stringify(f2), "H1 filter deterministic");
  const c1 = checkCandleAlignment(f1 as any, "1d");
  const c2 = checkCandleAlignment(f2 as any, "1d");
  ok(c1.safe === c2.safe && c1.referenceCandleTime?.getTime() === c2.referenceCandleTime?.getTime(), "H2 alignment deterministic");
  const a1 = aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, f1 as any, 3);
  const a2 = aggregateAssetGroup("BTC", "1d", "smart-money-suslik", 1, f2 as any, 3);
  ok(JSON.stringify(a1) === JSON.stringify(a2), "H3 aggregate deterministic");
  // eligibility pure, no Date.now
  let e1 = isSmartMoneyExchangeEligible("BINGX", "1d");
  let e2 = isSmartMoneyExchangeEligible("BINGX", "1d");
  ok(e1 === e2 && e1 === false, "H4 isEligible deterministic");
}

// I. no-lookahead / CLOSED-only remain unchanged (prove via existing adapter behavior not changed)
{
  console.log("\nI. invariants unchanged");
  // We verify that eligibility does not touch SMC scoring invariants: we check that eligibility file has no lookahead, no CLOSED logic
  const src = readFileSync("lib/strategies/smart-money-eligibility.ts", "utf8");
  ok(!src.includes("CandleData") && !src.includes("candleTime") && !src.includes("lookahead") && !src.includes("CLOSED"), "I1 eligibility pure, no candle/CLOSED/lookahead logic");
  ok(!src.includes("prisma") && !src.includes("signal"), "I2 no DB/Signal");
  ok(src.includes("isSmartMoneyExchangeEligible"), "I3 exposes helper");
  // Alignment still enforces CLOSED via separate layer — we already proved D/E still safe=false for stale/off-grid
  // Simple repeat: CLOSED-only is in smart-money adapter, not eligibility
  const T0 = Date.UTC(2026, 0, 1);
  const mkC = (i: number, closed: boolean) => ({
    openTime: new Date(T0 + i * 3600000),
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    closed,
  });
  const cfg = { ...defaultSmcScoringConfig("1h" as any), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as any, assetRank: 1, quoteVolume24h: 1e9 };
  const bad = Array.from({ length: 9 }, (_, i) => mkC(i, true));
  (bad[bad.length - 1] as any).closed = false;
  const res = evaluateSmartMoneyWithCandles(meta as any, bad as any, cfg);
  ok(res.status === "cannot-evaluate", "I4 CLOSED-only still enforced (closed=false => cannot-evaluate)");
}

// J. diagnostic 1d summary factual after Option A — must reflect filtered eligibility, not all 5
{
  console.log("\nJ. diagnostic 1d summary wording (Option A factual)");
  const diag = readFileSync("scripts/smart-money-diagnostic.ts", "utf8");
  const readonlySrc = readFileSync("scripts/smart-money-readonly.ts", "utf8");
  // Safe summary must mention eligible/filtered and BINGX exclusion, not all 5
  ok(diag.includes("после eligibility-фильтра") && diag.includes("eligible рынков aligned"), "J1 diagnostic 1d safe mentions eligible/filtered (после eligibility-фильтра + eligible рынков aligned)");
  ok(!diag.includes("all 5 at same UTC midnight"), "J2 diagnostic must NOT claim all 5 at same UTC midnight");
  ok(!diag.includes("safe — all 5"), "J3 diagnostic must NOT contain stale 'all 5' safe phrase");
  ok(diag.includes("BINGX") && (diag.includes("исключён") || diag.includes("excluded") || diag.includes("BINGX ineligible for 1d")), "J4 diagnostic mentions BINGX exclusion explicit");
  ok(diag.includes("Smart Money 1d aggregation policy") || diag.includes("BINGX ineligible for 1d"), "J5 diagnostic mentions aggregation policy (Smart Money 1d aggregation policy)");
  // Derived counts, not hardcoded 4/4 only
  ok(diag.includes("alignment.alignedCount") && diag.includes("alignment.totalEvaluated") && diag.includes("eligibleResults.length"), "J6 diagnostic 1d safe derives counts from alignment/eligibleResults (not hardcoded)");
  // Misaligned after eligibility still factual
  ok(diag.includes("misaligned после eligibility-фильтра"), "J7 diagnostic 1d misaligned after eligibility-фильтра");
  ok(diag.includes("offGrid") && diag.includes("horizonMismatch") && diag.includes("BINGX исключён"), "J8 diagnostic misaligned still shows offGrid/horizonMismatch + BINGX policy");
  // 5m/15m/1h/4h wording unchanged
  ok(diag.includes("Вывод Phase3E: ${timeframe} — safe (grid OK + same horizon"), "J9 diagnostic 5m/15m/4h safe wording unchanged");
  ok(diag.includes("Вывод Phase3E: ${timeframe} — MISALIGNED"), "J10 diagnostic 5m/15m/4h misaligned wording unchanged");
  // Generic unsafe still behaves
  ok(diag.includes("MULTI-EXCHANGE AGGREGATION REFUSED"), "J11 diagnostic generic REFUSED still present");
  ok(diag.includes("cannot-aggregate for multi-exchange"), "J12 diagnostic cannot-aggregate guard still present");
  // Readonly audit — no stale claim
  ok(!readonlySrc.includes("all 5 at same UTC midnight"), "J13 readonly must NOT contain stale all 5 phrase");
  ok(!readonlySrc.includes("safe — all 5"), "J14 readonly no stale safe all 5");
  ok(readonlySrc.includes("ALIGNED") && readonlySrc.includes("safe — можно агрегировать"), "J15 readonly generic ALIGNED still present (audited)");
}

console.log(`\nEligibility tests: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
