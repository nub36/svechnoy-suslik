/**
 * Real Experiment Runner — Phase I — integrates Execution Policy Registry EP-1/EP-2/EP-3 with P2-A engine + P2-C experiment selection OOS-blind.
 *
 * Takes multiple execution policies (approved) and runs P2-C experiment: TRAIN/VALIDATION selection, OOS final witness only, policy identity in fingerprint, costs 5bps fee 2bps slippage, BTC only, BINGX excluded 1d.
 *
 * Truthful: EP-1 APPROVED baselineMode 0 trades baseline included, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED unless APPROVED via approve flag, ranking TRAIN/VALIDATION only OOS never influences selection.
 *
 * No DB writes, no workers, no Signal Engine, read-only, no hidden defaults, HONEST SCOPE top-level.
 * No new Date(), no Date.now(), no random, no env — uses utcDateFromMs.
 */

import type { BacktestBar } from "./contract";
import type { RawSmcObservation } from "./smc-observation";
import type { ExecutionPolicyDefinition } from "./execution-policy";
import { validateExecutionPolicyDefinition } from "./execution-policy";
import { approvePolicy } from "./execution-policy-approval";
import { getPolicyById as getRegistryPolicyById, listPolicies as listRegistryPolicies } from "./execution-policy-registry";
import { runExperiment, runExperimentReport, type ExperimentReportOutcome } from "../experiment/run";
import type { ExperimentInput, VariantDefinition, ExperimentOutcome } from "../experiment/contract";
import { deepFreeze } from "./immutable";
import type { SmcTimeframe } from "../smc/types";

export type RealExperimentStatus =
  | "READY_FOR_EXECUTION"
  | "PRE_REGISTRATION_REQUIRED"
  | "INVALID_POLICY"
  | "INSUFFICIENT_DATA"
  | "EXPERIMENT_FAILED";

export type RealExperimentDiagnostics = {
  readonly status: RealExperimentStatus;
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly policiesCount: number;
  readonly approvedPoliciesCount: number;
  readonly registryPolicies: readonly { readonly id: string; readonly version: string; readonly status: string; readonly fingerprint: string }[];
  readonly barsCount: number;
  readonly observationsCount: number;
  readonly rawLongCount: number;
  readonly rawShortCount: number;
  readonly experimentOutcome: ExperimentOutcome | null;
  readonly reportOutcome: ExperimentReportOutcome | null;
  readonly limitations: readonly string[];
  readonly truthfulBaselineName: string;
  readonly readOnly: true;
};

export type RealExperimentRunnerRequest = {
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly timeframeMs: number;
  readonly bars: readonly BacktestBar[];
  readonly observationsMap: ReadonlyMap<number, RawSmcObservation>;
  readonly executionPolicyRegistryIds?: readonly string[] | null;
  readonly executionPolicies?: readonly ExecutionPolicyDefinition[] | null;
  readonly approve?: boolean;
  readonly splitConfig?: { readonly trainFraction?: number; readonly validationFraction?: number; readonly minBarsPerSegment?: number };
  readonly selectionPolicy?: { readonly kind: "rank-only" | "select-by-rank" | "none"; readonly stage: "TRAIN" | "VALIDATION"; readonly criteria: readonly string[] } | null;
  readonly quantity?: number;
  readonly initialEquity?: number;
};

function computeLevels(
  direction: "LONG" | "SHORT",
  referencePrice: number,
  policy: ExecutionPolicyDefinition
): { stopLoss: number; takeProfit: number } | null {
  const cfg = policy.config as Record<string, unknown>;
  const stopLossPct = cfg.stopLoss as number | undefined;
  const takeProfitPct = cfg.takeProfit as number | undefined;
  const buffer = (cfg.buffer as number | undefined) ?? 0;

  if (typeof stopLossPct !== "number" || typeof takeProfitPct !== "number") {
    return null;
  }
  if (!Number.isFinite(stopLossPct) || !Number.isFinite(takeProfitPct)) {
    return null;
  }
  if (stopLossPct <= 0 || takeProfitPct <= 0) {
    return null;
  }

  let sl: number, tp: number;
  if (direction === "LONG") {
    sl = referencePrice * (1 - stopLossPct - buffer);
    tp = referencePrice * (1 + takeProfitPct);
  } else {
    sl = referencePrice * (1 + stopLossPct + buffer);
    tp = referencePrice * (1 - takeProfitPct);
  }

  if (!Number.isFinite(sl) || !Number.isFinite(tp) || sl <= 0 || tp <= 0) {
    return null;
  }
  return { stopLoss: sl, takeProfit: tp };
}

export async function runRealExperimentDiagnostics(req: RealExperimentRunnerRequest): Promise<RealExperimentDiagnostics> {
  const allRegistry = listRegistryPolicies();
  const registryInfo = allRegistry.map((p) =>
    Object.freeze({
      id: p.id,
      version: p.version,
      status: p.status,
      fingerprint: p.fingerprint,
    })
  );

  const limitationsBase: string[] = [
    "Real Experiment Runner — Phase I — explicit execution policy registry EP-1/EP-2/EP-3 + P2-A + P2-C OOS-blind, no hidden defaults",
    "Costs fixed: 5bps fee per side, 0 fixed, 2bps slippage per side — policy identity in fingerprint id|version|requiredFields|config",
    "BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d via isSmartMoneyExchangeEligible timeless",
    "Historical eligibility CANNOT_RECONSTRUCT — E1 present-day snapshot CURRENT_STATE_SURVIVORSHIP_LIMITATION professional default",
    "OHLCV PIT fidelity not guaranteed — upsert overwrites values",
    "No-lookahead context-channel-only, not proof against closures/globals, causal clock H+D",
    "OOS never influences ranking — TRAIN/VALIDATION only selection, OOS final witness only, tie-break selectionKey->inputOrder OOS-blind",
    "EP-1 APPROVED baselineMode truthful 0 trades baseline, EP-2/EP-3 DRAFT PRE_REGISTRATION_REQUIRED until APPROVED via approvePolicy deterministic",
    "Read-only, no DB writes, no workers, no Signal Engine, production remains d6c573c",
  ];

  if (!req.bars || req.bars.length === 0) {
    return deepFreeze({
      status: "INSUFFICIENT_DATA" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policiesCount: 0,
      approvedPoliciesCount: 0,
      registryPolicies: Object.freeze(registryInfo),
      barsCount: 0,
      observationsCount: 0,
      rawLongCount: 0,
      rawShortCount: 0,
      experimentOutcome: null,
      reportOutcome: null,
      limitations: Object.freeze([...limitationsBase, "No bars provided"]),
      truthfulBaselineName: "Insufficient data — no bars",
      readOnly: true as const,
    });
  }

  const resolvedPolicies: ExecutionPolicyDefinition[] = [];

  if (req.executionPolicyRegistryIds && req.executionPolicyRegistryIds.length > 0) {
    for (const id of req.executionPolicyRegistryIds) {
      const fromRegistry = getRegistryPolicyById(id);
      if (!fromRegistry) {
        return deepFreeze({
          status: "INVALID_POLICY" as const,
          assetSymbol: req.assetSymbol,
          timeframe: req.timeframe,
          policiesCount: 0,
          approvedPoliciesCount: 0,
          registryPolicies: Object.freeze(registryInfo),
          barsCount: req.bars.length,
          observationsCount: req.observationsMap.size,
          rawLongCount: 0,
          rawShortCount: 0,
          experimentOutcome: null,
          reportOutcome: null,
          limitations: Object.freeze([...limitationsBase, `Registry policy ${id} not found`]),
          truthfulBaselineName: `Invalid policy ${id}`,
          readOnly: true as const,
        });
      }
      let pol = fromRegistry;
      if (req.approve && pol.status !== "APPROVED") {
        pol = approvePolicy(pol);
      }
      resolvedPolicies.push(pol);
    }
  }

  if (req.executionPolicies && req.executionPolicies.length > 0) {
    for (let p of req.executionPolicies) {
      if (req.approve && p.status !== "APPROVED") {
        p = approvePolicy(p);
      }
      resolvedPolicies.push(p);
    }
  }

  if (resolvedPolicies.length === 0) {
    return deepFreeze({
      status: "PRE_REGISTRATION_REQUIRED" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policiesCount: 0,
      approvedPoliciesCount: 0,
      registryPolicies: Object.freeze(registryInfo),
      barsCount: req.bars.length,
      observationsCount: req.observationsMap.size,
      rawLongCount: 0,
      rawShortCount: 0,
      experimentOutcome: null,
      reportOutcome: null,
      limitations: Object.freeze([...limitationsBase, "No execution policies supplied — PRE_REGISTRATION_REQUIRED"]),
      truthfulBaselineName: `Full Pipeline Real Experiment / UNRESOLVED (PRE_REGISTRATION_REQUIRED) registry=${registryInfo.map((p) => `${p.id}:${p.status}`).join(",")}`,
      readOnly: true as const,
    });
  }

  const validPolicies: ExecutionPolicyDefinition[] = [];
  const invalidReasons: string[] = [];
  for (const pol of resolvedPolicies) {
    const validation = validateExecutionPolicyDefinition(pol);
    if (!validation.ok) {
      invalidReasons.push(`Policy ${pol.id} invalid: ${validation.errors.join("; ")}`);
      continue;
    }
    if (validation.policy.status !== "APPROVED") {
      invalidReasons.push(`Policy ${pol.id} not APPROVED status ${validation.policy.status} — DRAFT blocked PRE_REGISTRATION_REQUIRED`);
      continue;
    }
    validPolicies.push(validation.policy);
  }

  if (validPolicies.length === 0) {
    return deepFreeze({
      status: "PRE_REGISTRATION_REQUIRED" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policiesCount: resolvedPolicies.length,
      approvedPoliciesCount: 0,
      registryPolicies: Object.freeze(registryInfo),
      barsCount: req.bars.length,
      observationsCount: req.observationsMap.size,
      rawLongCount: 0,
      rawShortCount: 0,
      experimentOutcome: null,
      reportOutcome: null,
      limitations: Object.freeze([...limitationsBase, ...invalidReasons]),
      truthfulBaselineName: `Full Pipeline Real Experiment / ${resolvedPolicies.map((p) => p.id).join(",")} PRE_REGISTRATION_REQUIRED — DRAFT blocked`,
      readOnly: true as const,
    });
  }

  let rawLongCount = 0;
  let rawShortCount = 0;
  for (const obs of req.observationsMap.values()) {
    if (obs.direction === "LONG") rawLongCount++;
    if (obs.direction === "SHORT") rawShortCount++;
  }

  const variants: VariantDefinition[] = validPolicies.map((policy) => {
    const label = `${policy.id}|${policy.fingerprint.slice(0, 16)}|${(policy.config as any).stopLoss ?? "baseline"}`;
    const signalsProvider = (ctx: { bar: BacktestBar }) => {
      const obs = req.observationsMap.get(ctx.bar.time);
      if (!obs) return null;
      if (obs.direction !== "LONG" && obs.direction !== "SHORT") return null;
      const levels = computeLevels(obs.direction as "LONG" | "SHORT", ctx.bar.close, policy);
      if (!levels) return null;
      return {
        kind: obs.direction as "LONG" | "SHORT",
        stopLoss: levels.stopLoss,
        takeProfit: levels.takeProfit,
        label: `${policy.id}|${obs.direction}|${obs.factsFingerprint ?? ""}`,
        facts: [...obs.reasons].slice(0, 10),
      };
    };

    return {
      label,
      params: {
        policyId: policy.id,
        fingerprint: policy.fingerprint,
        version: policy.version,
        requiredFields: [...policy.requiredEconomicFields].join(","),
        stopLoss: (policy.config as any).stopLoss ?? null,
        takeProfit: (policy.config as any).takeProfit ?? null,
        buffer: (policy.config as any).buffer ?? 0,
        costs: "5bps fee 2bps slippage",
      },
      config: {
        quantity: req.quantity ?? 1,
        initialEquity: req.initialEquity ?? 10000,
        fees: { bps: 5, fixedPerSide: 0 },
        slippage: { kind: "bps" as const, value: 2 },
        sameBarPolicy: "pessimistic" as const,
        timeoutBars: (policy.config as any).timeoutBars ?? null,
        warmupBars: 84,
      },
      signals: signalsProvider as any,
      signalSourceId: `${policy.id}@${policy.fingerprint}|${policy.version}`,
    };
  });

  const subject = {
    strategy: { slug: "suslik-real-pnl", version: "1.0.0" },
    market: {
      asset: `${req.assetSymbol}USDT`,
      exchange: "test-exchange",
      timeframe: req.timeframe,
      timeframeMs: req.timeframeMs,
    },
  };

  const selectionPolicy = req.selectionPolicy ?? {
    kind: "rank-only" as const,
    stage: "TRAIN" as const,
    criteria: ["netPnl", "profitFactor"] as const,
  };

  const experimentInput: ExperimentInput = {
    bars: req.bars as any,
    subject,
    variants,
    splitConfig: req.splitConfig ?? { trainFraction: 0.6, validationFraction: 0.2, minBarsPerSegment: 10 },
    orderPolicy: "input-order",
    selectionPolicy: selectionPolicy as any,
  };

  const syncOutcome = runExperiment(experimentInput);
  const reportOutcome = runExperimentReport(experimentInput);

  if (!syncOutcome.ok) {
    return deepFreeze({
      status: "EXPERIMENT_FAILED" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policiesCount: resolvedPolicies.length,
      approvedPoliciesCount: validPolicies.length,
      registryPolicies: Object.freeze(registryInfo),
      barsCount: req.bars.length,
      observationsCount: req.observationsMap.size,
      rawLongCount,
      rawShortCount,
      experimentOutcome: syncOutcome,
      reportOutcome: reportOutcome.ok ? reportOutcome : null,
      limitations: Object.freeze([...limitationsBase, `Experiment failed stage=${syncOutcome.stage} errors=${syncOutcome.errors.join("; ")}`, ...invalidReasons]),
      truthfulBaselineName: `Experiment failed — ${validPolicies.map((p) => p.id).join(",")}`,
      readOnly: true as const,
    });
  }

  return deepFreeze({
    status: "READY_FOR_EXECUTION" as const,
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    policiesCount: resolvedPolicies.length,
    approvedPoliciesCount: validPolicies.length,
    registryPolicies: Object.freeze(registryInfo),
    barsCount: req.bars.length,
    observationsCount: req.observationsMap.size,
    rawLongCount,
    rawShortCount,
    experimentOutcome: syncOutcome,
    reportOutcome: reportOutcome.ok ? reportOutcome : null,
    limitations: Object.freeze([...limitationsBase, ...invalidReasons]),
    truthfulBaselineName: `Real Experiment / ${validPolicies.map((p) => `${p.id}(${p.fingerprint.slice(0, 12)}...)`).join(", ")} — ${syncOutcome.record.variants.length} variants TRAIN/VALIDATION selection OOS final witness, raw LONG ${rawLongCount} SHORT ${rawShortCount}`,
    readOnly: true as const,
  });
}

export function formatRealExperimentReport(diag: RealExperimentDiagnostics): string {
  const lines: string[] = [];
  lines.push("=== Real Experiment Runner Diagnostics — Phase I — READ ONLY — REAL PNL EXPERIMENT OOS-BLIND ===");
  lines.push(`status: ${diag.status}`);
  lines.push(`baseline: ${diag.truthfulBaselineName}`);
  lines.push(`asset: ${diag.assetSymbol} timeframe: ${diag.timeframe} policies: ${diag.policiesCount} approved: ${diag.approvedPoliciesCount} registry: ${diag.registryPolicies.map((p) => `${p.id}(${p.status})`).join(", ")}`);
  lines.push(`bars: ${diag.barsCount} observations: ${diag.observationsCount} raw LONG=${diag.rawLongCount} SHORT=${diag.rawShortCount}`);
  if (diag.experimentOutcome?.ok) {
    const rec = diag.experimentOutcome.record;
    lines.push(`experiment: contract=${rec.contractVersion} variants declared=${rec.counts.declared} evaluated=${rec.counts.evaluated} rejected=${rec.counts.rejected} orderPolicy=${rec.orderPolicy} selectionPolicy=${rec.selection.policy.kind} stage=${(rec.selection.policy as any).stage ?? "none"}`);
    lines.push(`selection: performed=${rec.selection.performed} selected=${rec.selection.selectedConfigurationId ?? "null"} ranking=${rec.selection.ranking ? rec.selection.ranking.order.map((o) => `${o.label}(${o.values.netPnl ?? "null"})`).join(", ") : "null"}`);
    lines.push(`oosIsolation: oosConsultedForSelection=${rec.oosIsolation.oosConsultedForSelection} oosConsultedForRanking=${rec.oosIsolation.oosConsultedForRanking} mechanism=${rec.oosIsolation.mechanism} rankingIndependenceVerified=${rec.oosIsolation.rankingIndependenceVerified}`);
    lines.push(`inputFingerprint: ${rec.inputFingerprint.slice(0, 24)}... resultFingerprint: ${rec.resultFingerprint.slice(0, 24)}...`);
  } else if (diag.experimentOutcome && !diag.experimentOutcome.ok) {
    lines.push(`experiment failed: stage=${diag.experimentOutcome.stage} errors=${diag.experimentOutcome.errors.join("; ")}`);
  }
  if (diag.reportOutcome?.ok) {
    lines.push(`report: reportFingerprint=${diag.reportOutcome.view.reportFingerprint.slice(0, 24)}... rows=${diag.reportOutcome.view.rows.length}`);
  }
  lines.push("limitations:");
  for (const l of diag.limitations.slice(0, 20)) {
    lines.push(`  - ${l}`);
  }
  if (diag.limitations.length > 20) {
    lines.push(`  ... and ${diag.limitations.length - 20} more`);
  }
  lines.push("NOTE: Real experiment ranking TRAIN/VALIDATION only, OOS final witness only, no fake profitability, policy identity in fingerprint, costs 5bps fee 2bps slippage");
  return lines.join("\n");
}
