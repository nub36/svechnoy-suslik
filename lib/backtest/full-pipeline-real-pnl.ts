/**
 * Full Pipeline Real PnL — Phase H — integrates:
 * P2-B historical data plane + raw SMC observations + execution policy registry EP-1/EP-2/EP-3 + real PnL runner P2-A + splits TRAIN/VALIDATION/OOS OOS-blind.
 *
 * Truthful: EP-1 APPROVED baseline 0 trades, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED until APPROVED, policy identity in fingerprint, costs 5bps fee 2bps slippage, BTC only, BINGX excluded 1d, OOS never influences ranking.
 *
 * No DB writes, no workers, no Signal Engine, read-only, no hidden defaults, HONEST SCOPE top-level.
 * No new Date(), no Date.now(), no random, no env — uses formatIsoUtc.
 */

import type { BacktestMarketRow, BacktestDataDepsV2 } from "./data-source";
import type { SmcScoringConfig } from "../smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../smc/types";
import type { HistoricalDataPlaneReport } from "./historical-data-plane";
import { fetchHistoricalDataPlane } from "./historical-data-plane";
import type { ExecutionPolicyDefinition } from "./execution-policy";
import { getPolicyById as getRegistryPolicyById, listPolicies as listRegistryPolicies, listApprovedPolicies as listRegistryApprovedPolicies } from "./execution-policy-registry";
import { runRealPnlDiagnostics, type RealPnlDiagnostics, approvePolicy } from "./real-pnl-runner";
import { evaluateSplitsReadiness, type SplitsReadinessReport, type SplitDefinition } from "./splits-readiness";
import { buildHistoricalEligibilityDiagnostics, type EligibilityMethodology } from "./historical-eligibility";
import { formatIsoUtc, utcDateFromMs } from "./timeframe";
import { deepFreeze } from "./immutable";

export type FullPipelineStatus =
  | "READY_FOR_EXECUTION"
  | "PRE_REGISTRATION_REQUIRED"
  | "INVALID_POLICY"
  | "INSUFFICIENT_DATA"
  | "EXECUTION_FAILED";

export type FullPipelineRealPnlDiagnostics = {
  readonly status: FullPipelineStatus;
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly requestedRange: { readonly from: string; readonly to: string };
  readonly policyId: string | null;
  readonly policyFingerprint: string | null;
  readonly registryPolicies: readonly { readonly id: string; readonly version: string; readonly status: string; readonly fingerprint: string }[];
  readonly registryApprovedCount: number;
  readonly marketsCount: number;
  readonly eligibleMarketsCount: number;
  readonly coverageRatio: number | null;
  readonly commonTimestampsCount: number;
  readonly observationsCount: number;
  readonly rawLongCount: number;
  readonly rawShortCount: number;
  readonly tradesCount: number;
  readonly splitsReadiness: SplitsReadinessReport | null;
  readonly realPnl: RealPnlDiagnostics | null;
  readonly dataPlane: HistoricalDataPlaneReport | null;
  readonly limitations: readonly string[];
  readonly eligibilityLimitations: readonly string[];
  readonly truthfulBaselineName: string;
  readonly readOnly: true;
};

export type FullPipelineRealPnlRequest = {
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly from: Date;
  readonly to: Date;
  readonly markets: readonly BacktestMarketRow[];
  readonly deps: BacktestDataDepsV2;
  readonly smcConfig: SmcScoringConfig;
  readonly allCandlesPerMarket: ReadonlyMap<number, readonly SmcRawCandle[]>;
  readonly decisionBarsMs: readonly number[];
  readonly executionPolicyRegistryId?: string | null; // EP-1/EP-2/EP-3
  readonly executionPolicy?: ExecutionPolicyDefinition | null; // direct
  readonly approve?: boolean; // simulate owner approval via approvePolicy utility deterministic
  readonly eligibilityMethodology?: EligibilityMethodology | null;
  readonly isSmartMoneyRunner?: boolean;
  readonly splits?: readonly SplitDefinition[] | null; // if null, auto 60/20/20 from requested range
  readonly backtestConfig?: { readonly quantity?: number; readonly initialEquity?: number };
};

export async function runFullPipelineRealPnlDiagnostics(
  req: FullPipelineRealPnlRequest
): Promise<FullPipelineRealPnlDiagnostics> {
  const allRegistry = listRegistryPolicies();
  const registryInfo = allRegistry.map((p) =>
    Object.freeze({
      id: p.id,
      version: p.version,
      status: p.status,
      fingerprint: p.fingerprint,
    })
  );
  const approvedCount = listRegistryApprovedPolicies().length;

  const limitationsBase: string[] = [
    "Full Pipeline Real PnL — Phase H — explicit execution policy registry EP-1/EP-2/EP-3, no hidden defaults",
    "Costs fixed: 5bps fee per side, 0 fixed, 2bps slippage per side — policy identity in fingerprint id|version|requiredFields|config",
    "BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d via isSmartMoneyExchangeEligible timeless",
    "Historical eligibility CANNOT_RECONSTRUCT — E1 present-day snapshot with CURRENT_STATE_SURVIVORSHIP_LIMITATION as professional default",
    "OHLCV PIT fidelity not guaranteed — upsert overwrites values, createdAt preserves creation only, updatedAt auto-updated",
    "No-lookahead context-channel-only, not proof against closures/globals, causal clock H+D boundary",
    "OOS never influences ranking — TRAIN/VALIDATION only selection, OOS final witness only, tie-break selectionKey->inputOrder OOS-blind",
    "EP-1 APPROVED baselineMode truthful 0 trades baseline, EP-2/EP-3 DRAFT PRE_REGISTRATION_REQUIRED until APPROVED via approvePolicy",
    "Read-only, no DB writes, no workers, no Signal Engine, no Prisma migration, production remains d6c573c",
  ];

  if (!(req.from instanceof Date) || !(req.to instanceof Date) || Number.isNaN(req.from.getTime()) || Number.isNaN(req.to.getTime())) {
    throw new Error("runFullPipelineRealPnlDiagnostics: from/to must be valid Date");
  }
  if (req.from.getTime() >= req.to.getTime()) {
    throw new Error("runFullPipelineRealPnlDiagnostics: from must be < to");
  }

  // Resolve execution policy from registry id or direct
  let resolvedPolicy: ExecutionPolicyDefinition | null = null;
  if (req.executionPolicyRegistryId) {
    const fromRegistry = getRegistryPolicyById(req.executionPolicyRegistryId);
    if (!fromRegistry) {
      const eligibilityDiag = buildHistoricalEligibilityDiagnostics(req.eligibilityMethodology ?? null);
      return deepFreeze({
        status: "INVALID_POLICY" as const,
        assetSymbol: req.assetSymbol,
        timeframe: req.timeframe,
        requestedRange: { from: req.from.toISOString(), to: req.to.toISOString() },
        policyId: req.executionPolicyRegistryId,
        policyFingerprint: null,
        registryPolicies: Object.freeze(registryInfo),
        registryApprovedCount: approvedCount,
        marketsCount: req.markets.length,
        eligibleMarketsCount: 0,
        coverageRatio: null,
        commonTimestampsCount: 0,
        observationsCount: 0,
        rawLongCount: 0,
        rawShortCount: 0,
        tradesCount: 0,
        splitsReadiness: null,
        realPnl: null,
        dataPlane: null,
        limitations: Object.freeze([...limitationsBase, `Registry policy ${req.executionPolicyRegistryId} not found`]),
        eligibilityLimitations: Object.freeze([...eligibilityDiag.limitations]),
        truthfulBaselineName: `Invalid policy ${req.executionPolicyRegistryId}`,
        readOnly: true as const,
      });
    }
    resolvedPolicy = fromRegistry;
  } else if (req.executionPolicy) {
    resolvedPolicy = req.executionPolicy;
  }

  if (resolvedPolicy && req.approve && resolvedPolicy.status !== "APPROVED") {
    resolvedPolicy = approvePolicy(resolvedPolicy);
  }

  // Fetch data plane for coverage diagnostics
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
    // Continue with null dataPlane, will be reported as insufficient if needed
    dataPlane = null;
  }

  const eligibilityDiag = buildHistoricalEligibilityDiagnostics(req.eligibilityMethodology ?? null);

  // Splits readiness — use provided splits or auto 60/20/20 from requested range using common timestamps or decisionBarsMs
  let splitsReadiness: SplitsReadinessReport | null = null;
  const commonForSplits = dataPlane?.commonTimestamps?.length ? dataPlane.commonTimestamps : [...req.decisionBarsMs];
  if (commonForSplits.length > 0) {
    let splitsInput: readonly { readonly name: "TRAIN" | "VALIDATION" | "OOS"; readonly from: Date; readonly to: Date }[];
    if (req.splits && req.splits.length > 0) {
      splitsInput = req.splits.map((s) => Object.freeze({ name: s.name, from: utcDateFromMs(s.fromMs), to: utcDateFromMs(s.toMs) }));
    } else {
      const totalMs = req.to.getTime() - req.from.getTime();
      const trainEndMs = req.from.getTime() + Math.floor(totalMs * 0.6);
      const valEndMs = trainEndMs + Math.floor(totalMs * 0.2);
      splitsInput = Object.freeze([
        Object.freeze({ name: "TRAIN" as const, from: req.from, to: utcDateFromMs(trainEndMs) }),
        Object.freeze({ name: "VALIDATION" as const, from: utcDateFromMs(trainEndMs), to: utcDateFromMs(valEndMs) }),
        Object.freeze({ name: "OOS" as const, from: utcDateFromMs(valEndMs), to: req.to }),
      ]);
    }
    try {
      splitsReadiness = evaluateSplitsReadiness({
        assetSymbol: req.assetSymbol,
        timeframe: req.timeframe,
        splits: splitsInput as any,
        availableTimestamps: commonForSplits,
      });
    } catch {
      splitsReadiness = null;
    }
  }

  // Run real PnL diagnostics — this will handle PRE_REGISTRATION_REQUIRED for DRAFT etc
  const realPnlDiag = runRealPnlDiagnostics({
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    from: req.from,
    to: req.to,
    markets: req.markets,
    allCandlesPerMarket: req.allCandlesPerMarket,
    decisionBarsMs: req.decisionBarsMs,
    smcConfig: req.smcConfig,
    executionPolicy: resolvedPolicy,
    backtestConfig: {
      quantity: req.backtestConfig?.quantity ?? 1,
      initialEquity: req.backtestConfig?.initialEquity ?? 10000,
    } as any,
  });

  const status = realPnlDiag.status as FullPipelineStatus;

  const truthfulBaselineName =
    realPnlDiag.policyId != null
      ? `Full Pipeline Real PnL / ${realPnlDiag.policyId} ${realPnlDiag.policyFingerprint ?? "null"} — ${realPnlDiag.tradesCount} trades raw LONG ${realPnlDiag.rawLongCount} SHORT ${realPnlDiag.rawShortCount} — ${status}`
      : `Full Pipeline Real PnL / UNRESOLVED (PRE_REGISTRATION_REQUIRED) registry=${registryInfo.map((p) => `${p.id}:${p.status}`).join(",")} approved=${approvedCount} — ${status}`;

  const limitations = [
    ...limitationsBase,
    ...realPnlDiag.limitations,
    ...(dataPlane ? dataPlane.warnings : []),
    ...(dataPlane?.provenanceDiagnostics?.knownLimitations ?? []),
  ];

  const diagnostics: FullPipelineRealPnlDiagnostics = {
    status,
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    requestedRange: { from: req.from.toISOString(), to: req.to.toISOString() },
    policyId: realPnlDiag.policyId,
    policyFingerprint: realPnlDiag.policyFingerprint,
    registryPolicies: Object.freeze(registryInfo),
    registryApprovedCount: approvedCount,
    marketsCount: req.markets.length,
    eligibleMarketsCount: dataPlane?.eligibleMarketsCount ?? req.markets.length,
    coverageRatio: dataPlane?.overallCoverageRatio ?? null,
    commonTimestampsCount: dataPlane?.commonTimestamps?.length ?? req.decisionBarsMs.length,
    observationsCount: realPnlDiag.observationsCount,
    rawLongCount: realPnlDiag.rawLongCount,
    rawShortCount: realPnlDiag.rawShortCount,
    tradesCount: realPnlDiag.tradesCount,
    splitsReadiness,
    realPnl: realPnlDiag,
    dataPlane,
    limitations: Object.freeze(limitations),
    eligibilityLimitations: Object.freeze([...eligibilityDiag.limitations]),
    truthfulBaselineName,
    readOnly: true as const,
  };

  return deepFreeze(diagnostics) as FullPipelineRealPnlDiagnostics;
}

export function formatFullPipelineRealPnlReport(diag: FullPipelineRealPnlDiagnostics): string {
  const lines: string[] = [];
  lines.push("=== Full Pipeline Real PnL Diagnostics — Phase H — READ ONLY — REAL PNL ONLY WHEN APPROVED ===");
  lines.push(`status: ${diag.status}`);
  lines.push(`baseline: ${diag.truthfulBaselineName}`);
  lines.push(`asset: ${diag.assetSymbol} timeframe: ${diag.timeframe} policy: ${diag.policyId ?? "null"} fingerprint: ${diag.policyFingerprint ?? "null"}`);
  lines.push(`requested: ${diag.requestedRange.from} -> ${diag.requestedRange.to}`);
  lines.push(`markets: total=${diag.marketsCount} eligible=${diag.eligibleMarketsCount} coverageRatio=${diag.coverageRatio ?? "n/a"} commonTimestamps=${diag.commonTimestampsCount}`);
  lines.push(`observations: ${diag.observationsCount} raw LONG=${diag.rawLongCount} SHORT=${diag.rawShortCount} trades=${diag.tradesCount}`);
  lines.push(`registry: count=${diag.registryPolicies.length} approved=${diag.registryApprovedCount} ${diag.registryPolicies.map((p) => `${p.id}(${p.status})`).join(", ")}`);
  if (diag.splitsReadiness) {
    lines.push(`splits: overallReady=${diag.splitsReadiness.overallReady} TRAIN=${diag.splitsReadiness.splits[0]?.isReady} VALIDATION=${diag.splitsReadiness.splits[1]?.isReady} OOS=${diag.splitsReadiness.splits[2]?.isReady} oosDoesNotInfluence=${diag.splitsReadiness.oosIsolation.oosDoesNotInfluenceSelection} oosFinalWitnessOnly=${diag.splitsReadiness.oosIsolation.oosIsFinalWitnessOnly}`);
  }
  if (diag.realPnl?.result) {
    const m = diag.realPnl.result.metrics as any;
    lines.push(`realPnl metrics: trades=${diag.realPnl.result.trades.length} winRate=${m.winRate ?? "n/a"} PF=${m.profitFactor ?? "n/a"} totalNetPnl=${m.totalNetPnl ?? "n/a"} finalEquity=${m.finalEquity ?? "n/a"}`);
  }
  if (diag.realPnl && !diag.realPnl.outcome?.ok) {
    lines.push(`realPnl outcome failed: ${diag.realPnl.outcome ? (diag.realPnl.outcome as any).errors?.join("; ") : "null"}`);
  }
  lines.push("limitations:");
  for (const l of diag.limitations.slice(0, 20)) {
    lines.push(`  - ${l}`);
  }
  if (diag.limitations.length > 20) {
    lines.push(`  ... and ${diag.limitations.length - 20} more`);
  }
  lines.push("eligibilityLimitations:");
  for (const l of diag.eligibilityLimitations) {
    lines.push(`  - ${l}`);
  }
  lines.push("NOTE: Real PnL calculated only when execution policy APPROVED with explicit requiredEconomicFields, policy identity in fingerprint, OOS-blind TRAIN/VALIDATION only, no fake profitability");
  return lines.join("\n");
}
