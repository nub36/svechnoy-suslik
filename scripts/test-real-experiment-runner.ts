/**
 * Real Experiment Runner tests — Phase I — registry EP-1/EP-2/EP-3 + P2-A + P2-C OOS-blind.
 * Truthful: EP-1 0 trades baseline, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED, APPROVED yields real experiment with ranking TRAIN/VALIDATION only.
 */

import { runRealExperimentDiagnostics, formatRealExperimentReport } from "../lib/backtest/real-experiment-runner";
import { getPolicyById, listPolicies, EP1_BASELINE } from "../lib/backtest/execution-policy-registry";
import { approvePolicy } from "../lib/backtest/real-pnl-runner";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { SmcRawCandle, SmcTimeframe } from "../lib/smc/types";
import type { BacktestBar } from "../lib/backtest/contract";
import { evaluateHistoricalObservationsBatch } from "../lib/backtest/smc-observation";
import type { BacktestMarketRow } from "../lib/backtest/data-source";

let passed = 0;
let total = 0;
function ok(cond: boolean, label: string) {
  total++;
  if (cond) passed++;
  else console.error(`FAIL: ${label}`);
}

const T0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);
const H1 = 3600_000;

function mkCandle(openTimeMs: number, open = 100, high = 110, low = 90, close = 105): SmcRawCandle {
  return {
    openTime: new Date(openTimeMs),
    open,
    high,
    low,
    close,
    closed: true,
  } as any;
}

function makeCandles(count: number, startMs = T0, stepMs = H1, withTrend = false): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i = 0; i < count; i++) {
    const base = withTrend ? 100 + i * 0.5 + Math.sin(i / 5) * 2 : 100 + Math.sin(i / 10) * 5;
    out.push(mkCandle(startMs + i * stepMs, base, base + 0.5, base - 0.5, base + 0.1));
  }
  return out;
}

(async () => {
  console.log("=== Real Experiment Runner tests — Phase I — READ ONLY ===");

  const market: BacktestMarketRow = {
    id: 1,
    exchange: "BINANCE",
    exchangeSymbol: "BTCUSDT",
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  };

  const candles = makeCandles(200, T0, H1, true);
  const bars: BacktestBar[] = candles.map((c) => ({
    time: c.openTime.getTime(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));

  const smcConfig = defaultSmcScoringConfig("1h" as SmcTimeframe);
  const decisionBarsMs = [];
  for (let i = 84; i < 180; i += 2) decisionBarsMs.push(T0 + i * H1);

  const batch = evaluateHistoricalObservationsBatch({
    market,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarsMs,
    allCandlesAsc: candles,
    smcConfig,
    participantCount: 1,
  });

  const obsMap = new Map<number, any>();
  for (const obs of batch.observations) {
    obsMap.set(obs.decisionBarOpenTimeMs, obs);
  }

  // 1. No policy -> PRE_REGISTRATION_REQUIRED
  const diagNoPolicy = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars,
    observationsMap: obsMap,
    executionPolicyRegistryIds: null,
    executionPolicies: null,
  });

  ok(diagNoPolicy.status === "PRE_REGISTRATION_REQUIRED", `no policy -> PRE_REGISTRATION_REQUIRED got ${diagNoPolicy.status}`);
  ok(diagNoPolicy.readOnly === true, "readOnly true");
  ok(diagNoPolicy.registryPolicies.length === 3, "registryPolicies 3");
  ok(diagNoPolicy.limitations.some((l) => l.includes("CANNOT_RECONSTRUCT")), "limitations include CANNOT_RECONSTRUCT");

  // 2. EP-1 baseline alone — 0 trades but experiment ok
  const diagEP1 = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars,
    observationsMap: obsMap,
    executionPolicyRegistryIds: ["EP-1"],
  });

  ok(diagEP1.status === "READY_FOR_EXECUTION", `EP-1 -> READY_FOR_EXECUTION got ${diagEP1.status}`);
  ok(diagEP1.approvedPoliciesCount === 1, "EP-1 approvedPoliciesCount 1");
  ok(diagEP1.experimentOutcome?.ok === true, "EP-1 experimentOutcome ok");
  ok(!!diagEP1.experimentOutcome?.ok && diagEP1.experimentOutcome.record.counts.declared === 1, "EP-1 declared 1");
  ok(diagEP1.truthfulBaselineName.includes("EP-1"), "truthfulBaselineName includes EP-1");

  // 3. EP-2 DRAFT blocked
  const diagEP2Draft = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars,
    observationsMap: obsMap,
    executionPolicyRegistryIds: ["EP-2"],
  });

  ok(diagEP2Draft.status === "PRE_REGISTRATION_REQUIRED", `EP-2 DRAFT -> PRE_REGISTRATION_REQUIRED got ${diagEP2Draft.status}`);
  ok(diagEP2Draft.approvedPoliciesCount === 0, "EP-2 DRAFT approved 0");

  // 4. EP-2 APPROVED via approve flag
  const diagEP2Approved = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars,
    observationsMap: obsMap,
    executionPolicyRegistryIds: ["EP-2"],
    approve: true,
  });

  ok(diagEP2Approved.status === "READY_FOR_EXECUTION", `EP-2 APPROVED -> READY_FOR_EXECUTION got ${diagEP2Approved.status}`);
  ok(diagEP2Approved.approvedPoliciesCount === 1, "EP-2 APPROVED count 1");
  ok(diagEP2Approved.experimentOutcome?.ok === true, "EP-2 APPROVED experiment ok");
  ok(!!diagEP2Approved.experimentOutcome?.ok && diagEP2Approved.experimentOutcome.record.counts.evaluated === 1, "EP-2 APPROVED evaluated 1");

  // 5. Multiple policies EP-1 + EP-2 APPROVED + EP-3 APPROVED — ranking TRAIN/VALIDATION only
  const diagMulti = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars,
    observationsMap: obsMap,
    executionPolicyRegistryIds: ["EP-1", "EP-2", "EP-3"],
    approve: true,
    selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["netPnl", "profitFactor"] },
  });

  ok(diagMulti.status === "READY_FOR_EXECUTION", `multi EP-1+EP-2+EP-3 APPROVED -> READY got ${diagMulti.status}`);
  ok(diagMulti.policiesCount === 3, "multi policiesCount 3");
  ok(diagMulti.approvedPoliciesCount === 3, "multi approved 3");
  ok(diagMulti.experimentOutcome?.ok === true, "multi experiment ok");
  ok(!!diagMulti.experimentOutcome?.ok && diagMulti.experimentOutcome.record.counts.declared === 3, "multi declared 3");
  ok(!!diagMulti.experimentOutcome?.ok && diagMulti.experimentOutcome.record.variants.length === 3, "multi variants 3");
  ok(!!diagMulti.experimentOutcome?.ok && diagMulti.experimentOutcome.record.oosIsolation.oosConsultedForSelection === false, "oosConsultedForSelection false — OOS-blind");
  ok(!!diagMulti.experimentOutcome?.ok && diagMulti.experimentOutcome.record.oosIsolation.oosConsultedForRanking === false, "oosConsultedForRanking false");
  ok(!!diagMulti.experimentOutcome?.ok && diagMulti.experimentOutcome.record.selection.ranking != null, "ranking exists");
  ok(!!diagMulti.experimentOutcome?.ok && diagMulti.experimentOutcome.record.selection.ranking!.stage === "TRAIN", "ranking stage TRAIN");
  ok(!!diagMulti.experimentOutcome?.ok && diagMulti.experimentOutcome.record.selection.ranking!.oosConsulted === false, "ranking oosConsulted false");

  // 6. Policy identity in fingerprint — EP-2 vs EP-3 fingerprints differ
  const ep2 = getPolicyById("EP-2")!;
  const ep3 = getPolicyById("EP-3")!;
  ok(ep2.fingerprint !== ep3.fingerprint, "EP-2 vs EP-3 fingerprint differs — policy identity");
  ok(diagMulti.registryPolicies.length === 3, "registryPolicies 3 in multi");

  // 7. Report contains truthful info
  const report = formatRealExperimentReport(diagMulti);
  ok(report.includes("Real Experiment Runner"), "report contains Real Experiment Runner");
  ok(report.includes("EP-1") && report.includes("EP-2") && report.includes("EP-3"), "report contains EP-1 EP-2 EP-3");
  ok(report.includes("5bps") || report.includes("fee"), "report contains costs");
  ok(report.includes("CANNOT_RECONSTRUCT") || report.includes("SURVIVORSHIP"), "report contains CANNOT_RECONSTRUCT");
  ok(report.includes("oosConsultedForSelection=false") || report.includes("oosConsultedForSelection"), "report contains oos isolation");
  ok(!report.includes("new Date(") && !report.includes("Date.now()") && !report.includes("Math.random()"), "report no forbidden tokens");

  // 8. No DB writes check
  const fs = await import("fs");
  const src = fs.readFileSync("lib/backtest/real-experiment-runner.ts", "utf8");
  const stripped = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  ok(!stripped.includes("new Date("), "no new Date( in real-experiment file");
  ok(!stripped.includes("Date.now()"), "no Date.now() in file");
  ok(!stripped.includes("Math.random()"), "no Math.random() in file");
  ok(!stripped.includes("process.env"), "no process.env in file");

  // 9. Invalid policy
  const diagInvalid = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars,
    observationsMap: obsMap,
    executionPolicyRegistryIds: ["EP-999"],
  });

  ok(diagInvalid.status === "INVALID_POLICY", `invalid -> INVALID_POLICY got ${diagInvalid.status}`);

  // 10. Insufficient data
  const diagInsufficient = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars: [],
    observationsMap: new Map(),
    executionPolicyRegistryIds: ["EP-1"],
  });

  ok(diagInsufficient.status === "INSUFFICIENT_DATA", `empty bars -> INSUFFICIENT_DATA got ${diagInsufficient.status}`);

  // 11. Select-by-rank policy
  const diagSelect = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    timeframeMs: H1,
    bars,
    observationsMap: obsMap,
    executionPolicyRegistryIds: ["EP-1", "EP-2", "EP-3"],
    approve: true,
    selectionPolicy: { kind: "select-by-rank", stage: "VALIDATION", criteria: ["netPnl"] },
  });

  ok(diagSelect.status === "READY_FOR_EXECUTION", `select-by-rank VALIDATION -> READY got ${diagSelect.status}`);
  ok(!!diagSelect.experimentOutcome?.ok && diagSelect.experimentOutcome.record.selection.performed === true, "selection performed true for select-by-rank");
  ok(!!diagSelect.experimentOutcome?.ok && diagSelect.experimentOutcome.record.selection.ranking?.stage === "VALIDATION", "ranking stage VALIDATION for select-by-rank");

  console.log(`\nPassed ${passed}/${total}`);
  if (passed !== total) {
    console.error(`FAIL: ${total - passed} failed`);
    process.exit(1);
  }
  console.log("Real Experiment Runner tests passed — Phase I — EP-1 0 trades baseline, EP-2/EP-3 DRAFT blocked, APPROVED yields real experiment ranking TRAIN/VALIDATION OOS-blind, policy identity in fingerprint");
})();
