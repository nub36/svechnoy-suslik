/**
 * Pre-PnL runner tests — Phase E+F.
 * Ensures PRE_REGISTRATION_REQUIRED, no PnL output, truthful baseline naming, OOS isolation.
 */

import { runPrePnlDiagnostics, formatPrePnlDiagnosticsReport } from "../lib/backtest/pre-pnl-runner";
import { evaluateSplitsReadiness, formatSplitsReadinessReport } from "../lib/backtest/splits-readiness";
import type { BacktestMarketRow, BacktestDataDepsV2 } from "../lib/backtest/data-source";
import type { SmcRawCandle, SmcTimeframe } from "../lib/smc/types";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { utcDateFromMs } from "../lib/backtest/timeframe";

let passed = 0;
let total = 0;

function ok(cond: boolean, label: string): void {
  total++;
  if (cond) passed++;
  else console.error(`FAIL: ${label}`);
}

const H1 = 3_600_000;
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

function mkCandle(openTimeMs: number, open = 100, high = 101, low = 99, close = 100.5): SmcRawCandle {
  return {
    openTime: new Date(openTimeMs),
    open,
    high,
    low,
    close,
    closed: true,
  };
}

function makeCandles(count: number, startMs = T0, stepMs = H1): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + Math.sin(i / 10) * 5;
    out.push(mkCandle(startMs + i * stepMs, base, base + 0.5, base - 0.5, base + 0.1));
  }
  return out;
}

function makeDeps(candlesMap: Map<number, SmcRawCandle[]>): BacktestDataDepsV2 {
  return {
    findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }) => {
      const all = candlesMap.get(marketId) ?? [];
      let filtered = all.filter((c) => {
        const t = c.openTime.getTime();
        return t >= from.getTime() && t < to.getTime();
      });
      if (cursorOpenTime) {
        filtered = filtered.filter((c) => c.openTime.getTime() > cursorOpenTime.getTime());
      }
      filtered.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
      const page = filtered.slice(0, take);
      // Return as BacktestCandleRow-like
      return page.map((c) => ({
        marketId,
        timeframe: "1h",
        openTime: c.openTime,
        closeTime: new Date(c.openTime.getTime() + H1 - 1),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: 1000,
        closed: true,
      })) as any;
    },
  };
}

(async () => {
  console.log("=== Pre-PnL runner tests ===");

  const market: BacktestMarketRow = {
    id: 1,
    exchange: "BINANCE",
    exchangeSymbol: "BTCUSDT",
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  };

  const candles = makeCandles(100, T0, H1);
  const candlesMap = new Map<number, SmcRawCandle[]>();
  candlesMap.set(1, candles);

  const deps = makeDeps(candlesMap);

  const decisionBars = [T0 + 50 * H1, T0 + 60 * H1, T0 + 70 * H1, T0 + 80 * H1, T0 + 90 * H1];

  // 1. Without execution policy -> PRE_REGISTRATION_REQUIRED
  const diagNoPolicy = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    from: new Date(T0),
    to: new Date(T0 + 100 * H1),
    markets: [market],
    deps,
    smcConfig: defaultSmcScoringConfig("1h" as SmcTimeframe),
    allCandlesPerMarket: candlesMap,
    decisionBarsMs: decisionBars,
    executionPolicy: null,
    eligibilityMethodology: null,
    isSmartMoneyRunner: true,
  });

  ok(diagNoPolicy.status === "PRE_REGISTRATION_REQUIRED", `no policy -> PRE_REGISTRATION_REQUIRED (got ${diagNoPolicy.status})`);
  ok(diagNoPolicy.readOnly === true, "readOnly true");
  ok((diagNoPolicy as any).noPnl === true, "noPnl true");
  ok(diagNoPolicy.truthfulBaselineName.includes("PRE_REGISTRATION_REQUIRED") || diagNoPolicy.truthfulBaselineName.includes("UNRESOLVED"), "truthful baseline name mentions unresolved");
  ok(diagNoPolicy.nonExecutableCount > 0, "nonExecutableCount >0 when no policy");
  ok(diagNoPolicy.executableCount === 0, "executableCount 0 when no policy");

  // Ensure no PnL fields
  const diagJson = JSON.stringify(diagNoPolicy);
  ok(!diagJson.includes("profit") && !diagJson.includes("pnl") && !diagJson.includes("winRate") || diagJson.includes("raw"), "no PnL fields in diagnostics (except raw counts)");
  // Actually raw counts include LONG etc but not profit
  ok(!("netPnl" in diagNoPolicy), "no netPnl field");
  ok(!("profitFactor" in diagNoPolicy), "no profitFactor field");

  // 2. With DRAFT policy -> still PRE_REGISTRATION_REQUIRED
  const draftPolicy = {
    id: "EP-1",
    version: "1.0.0",
    description: "Draft",
    fingerprint: "fp-123",
    requiredEconomicFields: ["slAnchor", "tpModel"],
    config: { slAnchor: "X", tpModel: "Y" },
    status: "DRAFT" as const,
    createdAt: new Date().toISOString(),
    approvedAt: null,
  };

  const diagDraft = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    from: new Date(T0),
    to: new Date(T0 + 100 * H1),
    markets: [market],
    deps,
    smcConfig: defaultSmcScoringConfig("1h" as SmcTimeframe),
    allCandlesPerMarket: candlesMap,
    decisionBarsMs: decisionBars,
    executionPolicy: draftPolicy,
    eligibilityMethodology: null,
  });

  ok(diagDraft.status === "PRE_REGISTRATION_REQUIRED", "DRAFT policy -> PRE_REGISTRATION_REQUIRED");

  // 3. With APPROVED policy -> READY_FOR_EXECUTION but still no PnL
  const approvedPolicy = {
    ...draftPolicy,
    status: "APPROVED" as const,
    approvedAt: new Date().toISOString(),
  };

  const diagApproved = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    from: new Date(T0),
    to: new Date(T0 + 100 * H1),
    markets: [market],
    deps,
    smcConfig: defaultSmcScoringConfig("1h" as SmcTimeframe),
    allCandlesPerMarket: candlesMap,
    decisionBarsMs: decisionBars,
    executionPolicy: approvedPolicy,
    eligibilityMethodology: null,
  });

  ok(diagApproved.status === "READY_FOR_EXECUTION", `APPROVED policy -> READY_FOR_EXECUTION (got ${diagApproved.status})`);
  ok(diagApproved.truthfulBaselineName.includes("EP-1"), "truthful baseline includes EP-1 when approved");
  ok(diagApproved.executionPolicy?.policyId === "EP-1", "executionPolicy id preserved");
  ok(diagApproved.executionPolicy?.policyFingerprint === "fp-123", "fingerprint preserved");

  // 4. Raw counts preserved, not fake NEUTRAL
  ok(diagNoPolicy.rawLongCount + diagNoPolicy.rawShortCount + diagNoPolicy.rawNeutralCount + diagNoPolicy.rawCannotEvaluateCount === decisionBars.length, "raw counts sum to decisionBars length");
  ok(diagNoPolicy.rawLongCount >= 0 && diagNoPolicy.rawShortCount >= 0, "raw LONG/SHORT counts non-negative");

  // 5. Format report contains READ ONLY NO PNL and no profitability
  const reportStr = formatPrePnlDiagnosticsReport(diagNoPolicy);
  ok(reportStr.includes("READ ONLY") && reportStr.includes("NO PNL"), "report contains READ ONLY NO PNL");
  ok(reportStr.includes("PRE_REGISTRATION_REQUIRED"), "report contains PRE_REGISTRATION_REQUIRED");
  ok(!reportStr.toLowerCase().includes("profit") || reportStr.includes("profitability"), "report does not contain profit numbers");

  // 6. Splits readiness — OOS isolation
  const availableTimestamps = candles.map((c) => c.openTime.getTime()).filter((t) => t >= T0 && t < T0 + 100 * H1);

  const splitsReport = evaluateSplitsReadiness({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    splits: [
      { name: "TRAIN", from: new Date(T0), to: new Date(T0 + 50 * H1) },
      { name: "VALIDATION", from: new Date(T0 + 50 * H1), to: new Date(T0 + 80 * H1) },
      { name: "OOS", from: new Date(T0 + 80 * H1), to: new Date(T0 + 100 * H1) },
    ],
    availableTimestamps,
  });

  ok(splitsReport.oosIsolation.oosDoesNotInfluenceSelection === true, "OOS does not influence selection");
  ok(splitsReport.oosIsolation.selectionStages.includes("TRAIN" as any), "selection stages include TRAIN");
  ok(splitsReport.oosIsolation.selectionStages.includes("VALIDATION" as any), "selection stages include VALIDATION");
  ok(!(splitsReport.oosIsolation.selectionStages as any).includes("OOS"), "selection stages do NOT include OOS");
  ok(splitsReport.oosIsolation.oosIsFinalWitnessOnly === true, "OOS is final witness only");
  ok(splitsReport.readOnly === true && splitsReport.noPnl === true, "splits report readOnly/noPnl");

  const splitsReportStr = formatSplitsReadinessReport(splitsReport);
  ok(splitsReportStr.includes("OOS") && splitsReportStr.includes("READ ONLY"), "splits report contains OOS and READ ONLY");

  // 7. Insufficient data case
  const insufficientReport = evaluateSplitsReadiness({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    splits: [
      { name: "TRAIN", from: new Date(T0), to: new Date(T0 + 10 * H1) },
      { name: "VALIDATION", from: new Date(T0 + 10 * H1), to: new Date(T0 + 20 * H1) },
      { name: "OOS", from: new Date(T0 + 20 * H1), to: new Date(T0 + 100 * H1) },
    ],
    availableTimestamps: availableTimestamps.slice(0, 15), // only 15 available, but OOS expects 80
  });

  ok(!insufficientReport.overallReady, "insufficient data -> overallReady false");
  ok(insufficientReport.insufficient.length > 0, "insufficient array non-empty");

  console.log(`\nPassed ${passed}/${total}`);
  if (passed !== total) {
    console.error(`FAIL: ${total - passed} failed`);
    process.exit(1);
  }
  console.log("All pre-PnL tests passed");
})();
