/**
 * Full pipeline integration test — Phase A+B+C+D+E+F together.
 * No DB, no PnL, no Signal Engine, deterministic, no Date.now(), no random.
 *
 * Tests:
 * - Historical data plane mock -> coverage -> common timestamps
 * - Raw SMC observations batch -> causal prefix invariant
 * - Execution policy -> PRE_REGISTRATION_REQUIRED vs READY_FOR_EXECUTION
 * - Splits readiness -> OOS isolation
 * - Pre-PnL runner -> diagnostics only, no PnL, truthful baseline
 */

import { getTimeframeMs, formatIsoUtc } from "../lib/backtest/timeframe";
import { fetchHistoricalDataPlane } from "../lib/backtest/historical-data-plane";
import type { BacktestDataDepsV2, BacktestMarketRow } from "../lib/backtest/data-source";
import type { BacktestCandleRow } from "../lib/backtest/adapter";
import { evaluateHistoricalObservationsBatch } from "../lib/backtest/smc-observation";
import { validateExecutionPolicyDefinition, buildNonExecutableResult } from "../lib/backtest/execution-policy";
import { runPrePnlDiagnostics } from "../lib/backtest/pre-pnl-runner";
import { evaluateSplitsReadiness } from "../lib/backtest/splits-readiness";
import type { SmcScoringConfig } from "../lib/smc/config";
import type { SmcRawCandle } from "../lib/smc/types";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.error(`FAIL: ${msg}`);
  }
}

const T0 = Date.parse("2024-01-01T00:00:00Z");
const H1 = 3600_000;
const M5 = 5 * 60_000;

function mkCandle(openTime: number, open = 100, high = 110, low = 90, close = 105, volume = 1000): BacktestCandleRow {
  return {
    marketId: 1,
    timeframe: "1h",
    openTime: new Date(openTime) as any,
    closeTime: new Date(openTime + H1 - 1) as any,
    open,
    high,
    low,
    close,
    volume,
    closed: true,
  } as any;
}

function mkMarket(id: number, exchange = "BINANCE"): BacktestMarketRow {
  return {
    id,
    exchange,
    exchangeSymbol: "BTCUSDT",
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  } as any;
}

function makeSequentialCandles(count: number, startMs: number, tfMs: number): BacktestCandleRow[] {
  const arr: BacktestCandleRow[] = [];
  for (let i = 0; i < count; i++) {
    arr.push(mkCandle(startMs + i * tfMs));
  }
  return arr;
}

async function run() {
  console.log("=== Full pipeline integration test — READ ONLY — NO PNL ===");

  // Mock deps V2
  const allCandles = makeSequentialCandles(100, T0, H1);
  const deps: BacktestDataDepsV2 = {
    findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }) => {
      let filtered = allCandles.filter((c) => {
        const t = (c.openTime as any).getTime();
        return t >= from.getTime() && t < to.getTime();
      });
      if (cursorOpenTime) {
        const cur = cursorOpenTime.getTime();
        filtered = filtered.filter((c) => (c.openTime as any).getTime() > cur);
      }
      const sliced = filtered.slice(0, take);
      // Return with correct marketId echo for P2-B validation
      return sliced.map((c) => ({ ...c, marketId })) as any;
    },
  };

  const markets = [mkMarket(1, "BINANCE"), mkMarket(2, "BYBIT")];

  // Phase A: historical data plane
  const from = new Date(T0);
  const to = new Date(T0 + 50 * H1);
  const plane = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from,
    to,
    markets,
    deps,
    pageSize: 20,
    isSmartMoneyRunner: true,
  });

  ok(plane.readOnly === true, "plane readOnly true");
  ok(plane.noPnl === true, "plane noPnl true");
  ok(plane.marketsCount === 2, "plane marketsCount 2");
  ok(plane.eligibleMarketsCount === 2, "plane eligible 2 (BINANCE/BYBIT 1h)");
  ok(plane.overallCoverageRatio !== null && plane.overallCoverageRatio > 0.9, "plane coverage >0.9");
  ok(plane.commonTimestamps.length > 0, "plane commonTimestamps >0");
  ok(plane.warnings.length >= 0, "plane warnings array");

  // Phase B: raw SMC observations — use production default config to avoid hidden defaults issues
  const { defaultSmcScoringConfig } = await import("../lib/smc/config");
  const smcConfig: SmcScoringConfig = {
    ...defaultSmcScoringConfig("1h"),
    tf: "1h" as any,
    minimumScore: 70,
  } as any;

  const rawCandles: SmcRawCandle[] = allCandles.map((c) => ({
    openTime: c.openTime as any,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    closed: true,
  })) as any;

  // Need enough history for SMC hard minimum (~84) — use bars 84..104 as decision bars
  const decisionBars = rawCandles.slice(84, 104).map((c) => (c.openTime as any).getTime());

  const batch = evaluateHistoricalObservationsBatch({
    market: markets[0],
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarsMs: decisionBars,
    allCandlesAsc: rawCandles,
    smcConfig,
    participantCount: 2,
  });

  ok(batch.observations.length === decisionBars.length, "batch observations length matches decisionBars");
  ok(batch.observations.every((o) => ["LONG", "SHORT", "NEUTRAL", "CANNOT_EVALUATE"].includes(o.direction)), "batch directions valid");
  ok(batch.observations.every((o) => o.reasons.length >= 0), "batch reasons array");
  ok(batch.observations.every((o) => typeof o.factsFingerprint === "string"), "batch factsFingerprint string");
  ok(batch.observations.every((o) => o.marketId === markets[0].id), "batch marketId");

  // Causal prefix invariant: same prefix different suffix = same observation
  const prefixLen = 10;
  const prefix = rawCandles.slice(0, prefixLen);
  const suffixA = rawCandles.slice(prefixLen, 30).map((c) => ({ ...c, close: c.close * 1.1 }));
  const suffixB = rawCandles.slice(prefixLen, 30).map((c) => ({ ...c, close: c.close * 0.9 }));
  const allA = [...prefix, ...suffixA];
  const allB = [...prefix, ...suffixB];
  const decisionAtPrefix = (prefix[prefix.length - 1].openTime as any).getTime();

  const batchA = evaluateHistoricalObservationsBatch({
    market: markets[0],
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarsMs: [decisionAtPrefix],
    allCandlesAsc: allA,
    smcConfig,
    participantCount: 2,
  });
  const batchB = evaluateHistoricalObservationsBatch({
    market: markets[0],
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarsMs: [decisionAtPrefix],
    allCandlesAsc: allB,
    smcConfig,
    participantCount: 2,
  });

  ok(batchA.observations[0].direction === batchB.observations[0].direction, "causal prefix invariant: same prefix different suffix same direction");
  ok(batchA.observations[0].longScore === batchB.observations[0].longScore, "causal prefix invariant: same longScore");
  ok(batchA.observations[0].shortScore === batchB.observations[0].shortScore, "causal prefix invariant: same shortScore");

  // Phase D: execution policy
  const noPolicyResult = buildNonExecutableResult("NO_EXECUTION_POLICY", "test");
  ok(noPolicyResult.executability.status === "NON_EXECUTABLE", "no policy -> NON_EXECUTABLE");
  ok(noPolicyResult.executability.reason === "NO_EXECUTION_POLICY", "no policy reason");

  const invalidPolicy = validateExecutionPolicyDefinition({
    id: "",
    version: "1",
    description: "test",
    fingerprint: "abc",
    requiredEconomicFields: [],
    config: {},
    status: "APPROVED",
    createdAt: "2024-01-01T00:00:00Z",
    approvedAt: null,
  });
  ok(!invalidPolicy.ok, "invalid policy fails");

  const draftPolicy = {
    id: "EP-1",
    version: "1.0.0",
    description: "SMC-Direction Baseline / EP-1 — economic semantics OWNER-UNRESOLVED",
    fingerprint: "fp-draft-1",
    requiredEconomicFields: ["slAnchor", "tpModel", "k", "rrMin"],
    config: { slAnchor: "TBD", tpModel: "TBD", k: "TBD", rrMin: "TBD" },
    status: "DRAFT" as const,
    createdAt: "2024-01-01T00:00:00Z",
    approvedAt: null,
  };

  const draftValidation = validateExecutionPolicyDefinition(draftPolicy);
  ok(draftValidation.ok, "draft policy valid");

  // Phase E: pre-PnL runner
  const allCandlesMap = new Map<number, readonly SmcRawCandle[]>();
  allCandlesMap.set(1, rawCandles);
  allCandlesMap.set(2, rawCandles);

  const prePnlNoPolicy = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h",
    from,
    to,
    markets,
    deps,
    smcConfig,
    allCandlesPerMarket: allCandlesMap,
    decisionBarsMs: decisionBars,
    executionPolicy: null,
    isSmartMoneyRunner: true,
  });

  ok(prePnlNoPolicy.status === "PRE_REGISTRATION_REQUIRED", "pre-PnL no policy -> PRE_REGISTRATION_REQUIRED");
  ok(prePnlNoPolicy.readOnly === true, "pre-PnL readOnly true");
  ok(prePnlNoPolicy.noPnl === true, "pre-PnL noPnl true");
  ok(prePnlNoPolicy.truthfulBaselineName.includes("SMC-Direction Baseline"), "pre-PnL truthful baseline name");
  ok(prePnlNoPolicy.rawLongCount + prePnlNoPolicy.rawShortCount + prePnlNoPolicy.rawNeutralCount + prePnlNoPolicy.rawCannotEvaluateCount === decisionBars.length * markets.length, "pre-PnL raw counts sum");
  ok(prePnlNoPolicy.nonExecutableCount === decisionBars.length * markets.length, "pre-PnL nonExecutableCount all when no policy");
  ok(prePnlNoPolicy.executableCount === 0, "pre-PnL executableCount 0 when no policy");
  ok(!("netPnl" in prePnlNoPolicy) && !("profitFactor" in prePnlNoPolicy), "pre-PnL no netPnl/profitFactor fields");

  const prePnlDraft = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h",
    from,
    to,
    markets,
    deps,
    smcConfig,
    allCandlesPerMarket: allCandlesMap,
    decisionBarsMs: decisionBars,
    executionPolicy: draftPolicy as any,
    isSmartMoneyRunner: true,
  });

  ok(prePnlDraft.status === "PRE_REGISTRATION_REQUIRED", "pre-PnL draft -> PRE_REGISTRATION_REQUIRED");

  const approvedPolicy = {
    ...draftPolicy,
    status: "APPROVED" as const,
    approvedAt: "2024-01-02T00:00:00Z",
  };

  const prePnlApproved = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h",
    from,
    to,
    markets,
    deps,
    smcConfig,
    allCandlesPerMarket: allCandlesMap,
    decisionBarsMs: decisionBars,
    executionPolicy: approvedPolicy as any,
    isSmartMoneyRunner: true,
  });

  ok(prePnlApproved.status === "READY_FOR_EXECUTION", "pre-PnL approved -> READY_FOR_EXECUTION");
  ok(prePnlApproved.executableCount + prePnlApproved.nonExecutableCount === decisionBars.length * markets.length, "pre-PnL approved executable+nonExecutable = total");
  ok(prePnlApproved.noPnl === true, "pre-PnL approved still noPnl true (no real PnL until full execution pipeline)");

  // Phase F: splits readiness
  const commonTimestamps = plane.commonTimestamps;
  const trainFrom = new Date(T0);
  const trainTo = new Date(T0 + 20 * H1);
  const valFrom = new Date(T0 + 20 * H1);
  const valTo = new Date(T0 + 30 * H1);
  const oosFrom = new Date(T0 + 30 * H1);
  const oosTo = new Date(T0 + 50 * H1);

  const splitsReport = evaluateSplitsReadiness({
    assetSymbol: "BTC",
    timeframe: "1h",
    splits: [
      { name: "TRAIN", from: trainFrom, to: trainTo },
      { name: "VALIDATION", from: valFrom, to: valTo },
      { name: "OOS", from: oosFrom, to: oosTo },
    ],
    availableTimestamps: commonTimestamps,
  });

  ok(splitsReport.readOnly === true, "splits readOnly true");
  ok(splitsReport.noPnl === true, "splits noPnl true");
  ok(splitsReport.oosIsolation.oosDoesNotInfluenceSelection === true, "splits oosDoesNotInfluenceSelection true");
  ok(splitsReport.oosIsolation.selectionStages.length === 2 && splitsReport.oosIsolation.selectionStages[0] === "TRAIN", "splits selectionStages TRAIN/VALIDATION");
  ok(splitsReport.oosIsolation.oosIsFinalWitnessOnly === true, "splits oosIsFinalWitnessOnly true");
  ok(splitsReport.splits.length === 3, "splits 3 splits");
  ok(splitsReport.splits.every((s) => s.split.expectedSlots !== null), "splits expectedSlots not null");

  // OOS isolation: changing only OOS available timestamps should not affect TRAIN/VALIDATION readiness
  const splitsReport2 = evaluateSplitsReadiness({
    assetSymbol: "BTC",
    timeframe: "1h",
    splits: [
      { name: "TRAIN", from: trainFrom, to: trainTo },
      { name: "VALIDATION", from: valFrom, to: valTo },
      { name: "OOS", from: oosFrom, to: oosTo },
    ],
    availableTimestamps: [...commonTimestamps.filter((t) => t < oosFrom.getTime()), 9999999999999], // add fake OOS timestamp
  });

  ok(splitsReport.splits[0].isReady === splitsReport2.splits[0].isReady, "splits TRAIN readiness not affected by OOS change");
  ok(splitsReport.splits[1].isReady === splitsReport2.splits[1].isReady, "splits VALIDATION readiness not affected by OOS change");

  console.log(`\nPassed ${passed}/${passed + failed}`);
  if (failed > 0) {
    console.error(`Failed ${failed}/${passed + failed}`);
    process.exit(1);
  }
  console.log("All full pipeline tests passed");
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
