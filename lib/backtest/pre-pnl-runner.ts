/**
 * Pre-PnL Runner — Phase E + F — deterministic orchestration:
 * historical read-only bars → historical raw SMC observations → eligibility policy → execution-policy boundary → P2-A → P2-C.
 * But until concrete approved execution policy is supplied: REFUSE real trade/PnL execution.
 * Returns deterministic status PRE_REGISTRATION_REQUIRED.
 *
 * May produce PRE-PNL diagnostics only:
 * coverage, raw LONG count, raw SHORT count, raw NEUTRAL count, raw CANNOT_EVALUATE count,
 * NON_EXECUTABLE count, data limitations, eligibility limitations, fingerprints, common horizon diagnostics.
 *
 * Do NOT output profit, loss, win rate, profit factor, Sharpe, expectancy, equity curve from real strategy data.
 */

import type { BacktestMarketRow } from "./data-source";
import type { SmcScoringConfig } from "../smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../smc/types";
import type { HistoricalDataPlaneReport } from "./historical-data-plane";
import {
  evaluateHistoricalObservationsBatch,
  wrapWithExecutability,
  type RawSmcObservation,
  type HistoricalObservationBatch,
  type ObservationWithExecutability,
} from "./smc-observation";
import type { ExecutionPolicyDefinition, ExecutionPolicyResult } from "./execution-policy";
import { buildNonExecutableResult, validateExecutionPolicyDefinition } from "./execution-policy";
import { buildHistoricalEligibilityDiagnostics, type EligibilityMethodology } from "./historical-eligibility";
import { formatIsoUtc, getTimeframeMs } from "./timeframe";
import { deepFreeze } from "./immutable";
import type { BacktestDataDepsV2 } from "./data-source";
import { fetchHistoricalDataPlane } from "./historical-data-plane";

export type PrePnlRunnerStatus =
  | "PRE_REGISTRATION_REQUIRED"
  | "READY_FOR_EXECUTION" // only when approved policy supplied
  | "INSUFFICIENT_DATA"
  | "INVALID_INPUT";

export type PrePnlDiagnostics = {
  readonly status: PrePnlRunnerStatus;
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly requestedRange: { readonly from: string; readonly to: string };
  readonly effectiveCanonicalRange: { readonly from: string; readonly to: string; readonly expectedSlots: number } | null;
  readonly marketsCount: number;
  readonly eligibleMarketsCount: number;
  readonly coverageRatio: number | null;
  readonly commonTimestampsCount: number;
  readonly commonContiguousRangesCount: number;
  readonly rawLongCount: number;
  readonly rawShortCount: number;
  readonly rawNeutralCount: number;
  readonly rawCannotEvaluateCount: number;
  readonly nonExecutableCount: number;
  readonly executableCount: number;
  readonly dataLimitations: readonly string[];
  readonly eligibilityLimitations: readonly string[];
  readonly fingerprints: readonly string[];
  readonly commonHorizonDiagnostics: {
    readonly commonTimestamps: readonly number[];
    readonly commonContiguousRanges: readonly { startTime: number; endTime: number; count: number }[];
  };
  readonly executionPolicy: ExecutionPolicyResult | null;
  readonly readOnly: true;
  readonly noPnl: true;
  readonly truthfulBaselineName: string; // e.g. "SMC-Direction Baseline / execution policy EP-1"
};

export type PrePnlRunnerRequest = {
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly from: Date;
  readonly to: Date;
  readonly markets: readonly BacktestMarketRow[];
  readonly deps: BacktestDataDepsV2;
  readonly smcConfig: SmcScoringConfig;
  readonly allCandlesPerMarket: ReadonlyMap<number, readonly SmcRawCandle[]>; // marketId -> candles ASC
  readonly decisionBarsMs: readonly number[]; // sorted ASC decision bar open times (from requested range)
  readonly executionPolicy?: ExecutionPolicyDefinition | null;
  readonly eligibilityMethodology?: EligibilityMethodology | null;
  readonly isSmartMoneyRunner?: boolean;
};

export async function runPrePnlDiagnostics(
  req: PrePnlRunnerRequest
): Promise<PrePnlDiagnostics> {
  // Validate inputs
  if (!(req.from instanceof Date) || !(req.to instanceof Date) || Number.isNaN(req.from.getTime()) || Number.isNaN(req.to.getTime())) {
    throw new Error("runPrePnlDiagnostics: from/to must be valid Date");
  }
  if (req.from.getTime() >= req.to.getTime()) {
    throw new Error("runPrePnlDiagnostics: from must be < to");
  }
  if (!req.allCandlesPerMarket || req.allCandlesPerMarket.size === 0) {
    return buildInsufficientDataDiagnostics(req, "No candles per market provided");
  }

  // Fetch historical data plane for coverage diagnostics (uses P2-B)
  let dataPlane: HistoricalDataPlaneReport | null = null;
  try {
    dataPlane = await fetchHistoricalDataPlane({
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      from: req.from,
      to: req.to,
      markets: req.markets,
      deps: req.deps,
      isSmartMoneyRunner: req.isSmartMoneyRunner,
      eligibilityMethodology: req.eligibilityMethodology ?? null,
    });
  } catch (e) {
    // If data plane fails, we still produce diagnostics with insufficient data status
    return buildInsufficientDataDiagnostics(req, `Data plane fetch failed: ${(e as Error).message}`);
  }

  // Build historical observations batch per market
  const allObservations: RawSmcObservation[] = [];

  for (const market of req.markets) {
    const candles = req.allCandlesPerMarket.get(market.id);
    if (!candles || candles.length === 0) continue;

    // Filter decision bars that are within this market's available data?
    // For simplicity, use provided decisionBarsMs as global decision bars
    const batch = evaluateHistoricalObservationsBatch({
      market,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      decisionBarsMs: req.decisionBarsMs,
      allCandlesAsc: candles,
      smcConfig: req.smcConfig,
      participantCount: req.markets.length,
    });

    allObservations.push(...(batch.observations as RawSmcObservation[]));
  }

  const rawLongCount = allObservations.filter((o) => o.direction === "LONG").length;
  const rawShortCount = allObservations.filter((o) => o.direction === "SHORT").length;
  const rawNeutralCount = allObservations.filter((o) => o.direction === "NEUTRAL").length;
  const rawCannotEvaluateCount = allObservations.filter((o) => o.direction === "CANNOT_EVALUATE").length;

  // Execution policy handling
  let executionPolicyResult: ExecutionPolicyResult | null = null;
  let status: PrePnlRunnerStatus = "PRE_REGISTRATION_REQUIRED";

  if (req.executionPolicy) {
    const validation = validateExecutionPolicyDefinition(req.executionPolicy);
    if (!validation.ok) {
      executionPolicyResult = buildNonExecutableResult("INVALID_POLICY", validation.errors.join("; "));
      status = "PRE_REGISTRATION_REQUIRED";
    } else {
      const policy = validation.policy;
      if (policy.status !== "APPROVED") {
        executionPolicyResult = buildNonExecutableResult("POLICY_NOT_APPROVED", `Policy ${policy.id} status ${policy.status}`);
        status = "PRE_REGISTRATION_REQUIRED";
      } else {
        // Approved policy -> would be READY_FOR_EXECUTION, but per task we must REFUSE real trade/PnL execution until owner explicitly enables?
        // For pre-PnL runner, we still return READY_FOR_EXECUTION but do NOT calculate PnL
        executionPolicyResult = {
          policyId: policy.id,
          policyFingerprint: policy.fingerprint,
          executability: { status: "EXECUTABLE", reason: null, details: null },
          validatedAt: new Date().toISOString(),
        };
        status = "READY_FOR_EXECUTION";
      }
    }
  } else {
    executionPolicyResult = buildNonExecutableResult("NO_EXECUTION_POLICY", "No execution policy supplied — PRE_REGISTRATION_REQUIRED");
    status = "PRE_REGISTRATION_REQUIRED";
  }

  // Wrap with executability
  const wrapped: ObservationWithExecutability[] = allObservations.map((obs) =>
    wrapWithExecutability(obs, executionPolicyResult)
  );

  const nonExecutableCount = wrapped.filter((w) => w.executability.status === "NON_EXECUTABLE").length;
  const executableCount = wrapped.filter((w) => w.executability.status === "EXECUTABLE").length;

  // Fingerprints
  const fingerprints = allObservations.map((o) => o.factsFingerprint ?? "null").slice(0, 100); // limit for report

  // Data limitations from dataPlane
  const dataLimitations: string[] = [];
  if (dataPlane) {
    dataLimitations.push(...dataPlane.warnings);
    if (dataPlane.aggregatedCoverage.overallCoverageRatio !== null && dataPlane.aggregatedCoverage.overallCoverageRatio < 1) {
      dataLimitations.push(`Coverage ratio ${dataPlane.aggregatedCoverage.overallCoverageRatio} < 1 — incomplete history`);
    }
    if (dataPlane.provenanceDiagnostics) {
      dataLimitations.push(...dataPlane.provenanceDiagnostics.knownLimitations);
    }
  }
  dataLimitations.push("OHLCV point-in-time fidelity not guaranteed — current Candle rows may have been upserted");
  dataLimitations.push("Historical eligibility not fully reconstructable — see eligibility diagnostics");

  const eligibilityDiagnostics = buildHistoricalEligibilityDiagnostics(req.eligibilityMethodology ?? null);
  const eligibilityLimitations = [...eligibilityDiagnostics.limitations];

  const diagnostics: PrePnlDiagnostics = {
    status,
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    requestedRange: {
      from: req.from.toISOString(),
      to: req.to.toISOString(),
    },
    effectiveCanonicalRange: dataPlane?.effectiveCanonicalRange
      ? {
          from: dataPlane.effectiveCanonicalRange.from,
          to: dataPlane.effectiveCanonicalRange.to,
          expectedSlots: dataPlane.effectiveCanonicalRange.expectedSlots,
        }
      : null,
    marketsCount: req.markets.length,
    eligibleMarketsCount: dataPlane?.eligibleMarketsCount ?? req.markets.length,
    coverageRatio: dataPlane?.overallCoverageRatio ?? null,
    commonTimestampsCount: dataPlane?.commonTimestamps.length ?? 0,
    commonContiguousRangesCount: dataPlane?.commonContiguousRanges.length ?? 0,
    rawLongCount,
    rawShortCount,
    rawNeutralCount,
    rawCannotEvaluateCount,
    nonExecutableCount,
    executableCount,
    dataLimitations: Object.freeze(dataLimitations),
    eligibilityLimitations: Object.freeze(eligibilityLimitations),
    fingerprints: Object.freeze(fingerprints),
    commonHorizonDiagnostics: Object.freeze({
      commonTimestamps: Object.freeze(dataPlane?.commonTimestamps ?? []),
      commonContiguousRanges: Object.freeze(
        (dataPlane?.commonContiguousRanges ?? []).map((r) => ({
          startTime: r.startTime,
          endTime: r.endTime,
          count: r.count,
        }))
      ),
    }),
    executionPolicy: executionPolicyResult ? Object.freeze(executionPolicyResult) : null,
    readOnly: true as const,
    noPnl: true as const,
    truthfulBaselineName:
      executionPolicyResult?.policyId != null
        ? `SMC-Direction Baseline / execution policy ${executionPolicyResult.policyId}`
        : "SMC-Direction Baseline / execution policy UNRESOLVED (PRE_REGISTRATION_REQUIRED)",
  };

  return deepFreeze(diagnostics) as PrePnlDiagnostics;
}

function buildInsufficientDataDiagnostics(
  req: PrePnlRunnerRequest,
  reason: string
): PrePnlDiagnostics {
  const eligibilityDiagnostics = buildHistoricalEligibilityDiagnostics(req.eligibilityMethodology ?? null);
  return Object.freeze({
    status: "INSUFFICIENT_DATA" as const,
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    requestedRange: { from: req.from.toISOString(), to: req.to.toISOString() },
    effectiveCanonicalRange: null,
    marketsCount: req.markets.length,
    eligibleMarketsCount: 0,
    coverageRatio: null,
    commonTimestampsCount: 0,
    commonContiguousRangesCount: 0,
    rawLongCount: 0,
    rawShortCount: 0,
    rawNeutralCount: 0,
    rawCannotEvaluateCount: 0,
    nonExecutableCount: 0,
    executableCount: 0,
    dataLimitations: Object.freeze([reason, "Insufficient data for pre-PnL diagnostics"]),
    eligibilityLimitations: Object.freeze([...eligibilityDiagnostics.limitations]),
    fingerprints: Object.freeze([]),
    commonHorizonDiagnostics: Object.freeze({
      commonTimestamps: Object.freeze([]),
      commonContiguousRanges: Object.freeze([]),
    }),
    executionPolicy: Object.freeze(buildNonExecutableResult("NO_EXECUTION_POLICY", reason)),
    readOnly: true as const,
    noPnl: true as const,
    truthfulBaselineName: "SMC-Direction Baseline / INSUFFICIENT_DATA",
  });
}

export function formatPrePnlDiagnosticsReport(diag: PrePnlDiagnostics): string {
  const lines: string[] = [];
  lines.push("=== Pre-PnL Runner Diagnostics — READ ONLY — NO PNL ===");
  lines.push(`status: ${diag.status}`);
  lines.push(`baseline: ${diag.truthfulBaselineName}`);
  lines.push(`asset: ${diag.assetSymbol} timeframe: ${diag.timeframe}`);
  lines.push(`requested: ${diag.requestedRange.from} -> ${diag.requestedRange.to}`);
  if (diag.effectiveCanonicalRange) {
    lines.push(
      `effective canonical: ${diag.effectiveCanonicalRange.from} -> ${diag.effectiveCanonicalRange.to} expectedSlots=${diag.effectiveCanonicalRange.expectedSlots}`
    );
  }
  lines.push(`markets: total=${diag.marketsCount} eligible=${diag.eligibleMarketsCount}`);
  lines.push(`coverageRatio: ${diag.coverageRatio ?? "n/a"}`);
  lines.push(`commonTimestamps: ${diag.commonTimestampsCount} commonContiguousRanges: ${diag.commonContiguousRangesCount}`);
  lines.push(`raw counts: LONG=${diag.rawLongCount} SHORT=${diag.rawShortCount} NEUTRAL=${diag.rawNeutralCount} CANNOT_EVALUATE=${diag.rawCannotEvaluateCount}`);
  lines.push(`executability: NON_EXECUTABLE=${diag.nonExecutableCount} EXECUTABLE=${diag.executableCount}`);
  if (diag.executionPolicy) {
    lines.push(`executionPolicy: id=${diag.executionPolicy.policyId ?? "null"} fingerprint=${diag.executionPolicy.policyFingerprint ?? "null"} status=${diag.executionPolicy.executability.status} reason=${diag.executionPolicy.executability.reason ?? "null"}`);
  }
  lines.push("dataLimitations:");
  for (const l of diag.dataLimitations) {
    lines.push(`  - ${l}`);
  }
  lines.push("eligibilityLimitations:");
  for (const l of diag.eligibilityLimitations) {
    lines.push(`  - ${l}`);
  }
  lines.push(`fingerprints (sample ${diag.fingerprints.length}): ${diag.fingerprints.slice(0, 5).join(", ")}${diag.fingerprints.length > 5 ? "..." : ""}`);
  lines.push("NO REAL PNL CALCULATED — PRE_REGISTRATION_REQUIRED until execution policy approved");
  return lines.join("\n");
}
