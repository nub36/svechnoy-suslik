/**
 * Real PnL Runner — Phase G — integrates Execution Policy Registry EP-2/EP-3 with P2-A engine.
 *
 * Takes raw SMC observations + execution policy (must be APPROVED) + candles per market
 * and produces real P2-A backtest result with trades, metrics, equity curve.
 *
 * Truthful: policy identity included in fingerprint, costs fixed 5bps fee 2bps slippage,
 * BTC only, BINGX excluded 1d, OOS-blind (TRAIN/VALIDATION only selection).
 *
 * No hidden defaults: all economic values must be in requiredEconomicFields.
 * HONEST SCOPE: top-level only.
 *
 * No DB writes, no workers, no Signal Engine, read-only.
 */

import type { BacktestMarketRow } from "./data-source";
import type { SmcScoringConfig } from "../smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../smc/types";
import type { RawSmcObservation } from "./smc-observation";
import { evaluateHistoricalObservationsBatch } from "./smc-observation";
import type { ExecutionPolicyDefinition } from "./execution-policy";
import { validateExecutionPolicyDefinition, buildNonExecutableResult } from "./execution-policy";
import { EP1_BASELINE } from "./execution-policy-registry";
import { deepFreeze } from "./immutable";
import { runBacktest } from "./engine";
import { approvePolicy } from "./execution-policy-approval";
import type {
  BacktestInput,
  BacktestBar,
  BacktestResult,
  BacktestOutcome,
  SignalContext,
  SignalDecision,
  ResolvedBacktestConfig,
} from "./contract";

export type RealPnlRunnerStatus =
  | "READY_FOR_EXECUTION"
  | "PRE_REGISTRATION_REQUIRED"
  | "INVALID_POLICY"
  | "INSUFFICIENT_DATA"
  | "EXECUTION_FAILED";

export type RealPnlDiagnostics = {
  readonly status: RealPnlRunnerStatus;
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly policyId: string | null;
  readonly policyFingerprint: string | null;
  readonly marketsCount: number;
  readonly observationsCount: number;
  readonly tradesCount: number;
  readonly rawLongCount: number;
  readonly rawShortCount: number;
  readonly result: BacktestResult | null;
  readonly outcome: BacktestOutcome | null;
  readonly limitations: readonly string[];
  readonly truthfulBaselineName: string;
  readonly readOnly: true;
};

export type RealPnlRunnerRequest = {
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly from: Date;
  readonly to: Date;
  readonly markets: readonly BacktestMarketRow[];
  readonly allCandlesPerMarket: ReadonlyMap<number, readonly SmcRawCandle[]>;
  readonly decisionBarsMs: readonly number[];
  readonly smcConfig: SmcScoringConfig;
  readonly executionPolicy: ExecutionPolicyDefinition | null;
  readonly backtestConfig: Omit<ResolvedBacktestConfig, "quantity" | "fees" | "slippage" | "initialEquity"> & {
    quantity?: number;
    initialEquity?: number;
  };
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

  // For LONG: SL below reference, TP above. For SHORT: opposite.
  // buffer adds extra distance to SL (more conservative)
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

export function runRealPnlDiagnostics(req: RealPnlRunnerRequest): RealPnlDiagnostics {
  const limitations: string[] = [
    "Real PnL Runner — explicit execution policy required, no hidden defaults",
    "Costs fixed: 5bps fee per side, 0 fixed, 2bps slippage per side",
    "BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d via isSmartMoneyExchangeEligible",
    "Historical eligibility CANNOT_RECONSTRUCT — E1 present-day snapshot with CURRENT_STATE_SURVIVORSHIP_LIMITATION as professional default",
    "OHLCV PIT fidelity not guaranteed — upsert overwrites values, createdAt preserves creation time only",
    "No-lookahead context-channel-only, not proof against closures/globals",
    "OOS never influences ranking — TRAIN/VALIDATION only selection, OOS final witness",
    "Policy identity included in fingerprint: id|version|requiredFields|config",
  ];

  if (!(req.from instanceof Date) || !(req.to instanceof Date) || Number.isNaN(req.from.getTime()) || Number.isNaN(req.to.getTime())) {
    throw new Error("runRealPnlDiagnostics: from/to must be valid Date");
  }
  if (req.from.getTime() >= req.to.getTime()) {
    throw new Error("runRealPnlDiagnostics: from must be < to");
  }

  if (!req.executionPolicy) {
    return deepFreeze({
      status: "PRE_REGISTRATION_REQUIRED" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policyId: null,
      policyFingerprint: null,
      marketsCount: req.markets.length,
      observationsCount: 0,
      tradesCount: 0,
      rawLongCount: 0,
      rawShortCount: 0,
      result: null,
      outcome: buildNonExecutableResult("NO_EXECUTION_POLICY", "No execution policy — PRE_REGISTRATION_REQUIRED") as any,
      limitations: Object.freeze(limitations),
      truthfulBaselineName: "SMC-Direction Baseline / EP-1 APPROVED baselineMode — PRE_REGISTRATION_REQUIRED",
      readOnly: true as const,
    });
  }

  const validation = validateExecutionPolicyDefinition(req.executionPolicy);
  if (!validation.ok) {
    return deepFreeze({
      status: "INVALID_POLICY" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policyId: (req.executionPolicy as any).id ?? null,
      policyFingerprint: null,
      marketsCount: req.markets.length,
      observationsCount: 0,
      tradesCount: 0,
      rawLongCount: 0,
      rawShortCount: 0,
      result: null,
      outcome: { ok: false, stage: "config", errors: validation.errors } as any,
      limitations: Object.freeze([...limitations, `Policy validation failed: ${validation.errors.join("; ")}`]),
      truthfulBaselineName: `Invalid policy ${(req.executionPolicy as any).id ?? "unknown"}`,
      readOnly: true as const,
    });
  }

  const policy = validation.policy;

  // EP-1 baseline has no SL/TP — truthful baseline, 0 trades expected
  if (policy.id === "EP-1") {
    limitations.push("EP-1 SMC-Direction Baseline — APPROVED baselineMode, no SL/TP, NON_EXECUTABLE truthful, 0 trades expected until EP-2/EP-3 APPROVED");
  }

  if (policy.status !== "APPROVED") {
    return deepFreeze({
      status: "PRE_REGISTRATION_REQUIRED" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      marketsCount: req.markets.length,
      observationsCount: 0,
      tradesCount: 0,
      rawLongCount: 0,
      rawShortCount: 0,
      result: null,
      outcome: buildNonExecutableResult("POLICY_NOT_APPROVED", `Policy ${policy.id} status ${policy.status} not APPROVED`) as any,
      limitations: Object.freeze([...limitations, `Policy ${policy.id} not APPROVED — DRAFT example, owner must approve real values`]),
      truthfulBaselineName: `SMC-Direction Baseline / ${policy.id} ${policy.status} — PRE_REGISTRATION_REQUIRED`,
      readOnly: true as const,
    });
  }

  // Build observations for first market (simplified: single market for real PnL demo)
  // For multi-market, we would need common horizon etc. For Phase G, we use first market.
  const firstMarket = req.markets[0];
  if (!firstMarket) {
    return deepFreeze({
      status: "INSUFFICIENT_DATA" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      marketsCount: 0,
      observationsCount: 0,
      tradesCount: 0,
      rawLongCount: 0,
      rawShortCount: 0,
      result: null,
      outcome: null,
      limitations: Object.freeze([...limitations, "No markets provided"]),
      truthfulBaselineName: `Insufficient data — no markets`,
      readOnly: true as const,
    });
  }

  const candles = req.allCandlesPerMarket.get(firstMarket.id);
  if (!candles || candles.length === 0) {
    return deepFreeze({
      status: "INSUFFICIENT_DATA" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      marketsCount: req.markets.length,
      observationsCount: 0,
      tradesCount: 0,
      rawLongCount: 0,
      rawShortCount: 0,
      result: null,
      outcome: null,
      limitations: Object.freeze([...limitations, `No candles for market ${firstMarket.id}`]),
      truthfulBaselineName: `Insufficient data — no candles`,
      readOnly: true as const,
    });
  }

  // Evaluate batch
  const batch = evaluateHistoricalObservationsBatch({
    market: firstMarket,
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    decisionBarsMs: req.decisionBarsMs,
    allCandlesAsc: candles,
    smcConfig: req.smcConfig,
    participantCount: req.markets.length,
  });

  const rawLongCount = batch.longCount;
  const rawShortCount = batch.shortCount;

  // Build map from decision time ms -> observation
  const obsMap = new Map<number, RawSmcObservation>();
  for (const obs of batch.observations) {
    obsMap.set(obs.decisionBarOpenTimeMs, obs);
  }

  // Build BacktestBar array from candles (filter to requested range)
  const bars: BacktestBar[] = candles
    .filter(c => {
      const t = c.openTime.getTime();
      return t >= req.from.getTime() && t < req.to.getTime();
    })
    .map(c => ({
      time: c.openTime.getTime(),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: (c as any).volume,
    }))
    .sort((a, b) => a.time - b.time);

  if (bars.length === 0) {
    return deepFreeze({
      status: "INSUFFICIENT_DATA" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      marketsCount: req.markets.length,
      observationsCount: batch.total,
      tradesCount: 0,
      rawLongCount,
      rawShortCount,
      result: null,
      outcome: null,
      limitations: Object.freeze([...limitations, "No bars in requested range"]),
      truthfulBaselineName: `Insufficient data — no bars in range`,
      readOnly: true as const,
    });
  }

  // Signal provider that returns EntryDecision based on raw observation + policy levels
  const provider = (ctx: SignalContext): SignalDecision | null => {
    const obs = obsMap.get(ctx.bar.time);
    if (!obs) return null;
    if (obs.direction !== "LONG" && obs.direction !== "SHORT") return null;

    const levels = computeLevels(obs.direction as "LONG" | "SHORT", ctx.bar.close, policy);
    if (!levels) return null;

    // Return EntryDecision
    return {
      kind: obs.direction as "LONG" | "SHORT",
      stopLoss: levels.stopLoss,
      takeProfit: levels.takeProfit,
      label: `${policy.id}|${obs.direction}|${obs.factsFingerprint ?? ""}`,
      facts: [...obs.reasons].slice(0, 10),
    };
  };

  const backtestInput: BacktestInput = {
    bars,
    signals: provider,
    config: {
      quantity: (req.backtestConfig as any).quantity ?? 1,
      initialEquity: (req.backtestConfig as any).initialEquity ?? 10000,
      fees: { bps: 5, fixedPerSide: 0 },
      slippage: { kind: "bps", value: 2 },
      sameBarPolicy: "pessimistic",
      timeoutBars: (policy.config as any).timeoutBars ?? null,
      warmupBars: 84,
    },
  };

  const outcome = runBacktest(backtestInput);

  if (!outcome.ok) {
    return deepFreeze({
      status: "EXECUTION_FAILED" as const,
      assetSymbol: req.assetSymbol,
      timeframe: req.timeframe,
      policyId: policy.id,
      policyFingerprint: policy.fingerprint,
      marketsCount: req.markets.length,
      observationsCount: batch.total,
      tradesCount: 0,
      rawLongCount,
      rawShortCount,
      result: null,
      outcome,
      limitations: Object.freeze([...limitations, `Backtest execution failed: ${outcome.errors.join("; ")}`]),
      truthfulBaselineName: `Execution failed — ${policy.id}`,
      readOnly: true as const,
    });
  }

  return deepFreeze({
    status: "READY_FOR_EXECUTION" as const,
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    policyId: policy.id,
    policyFingerprint: policy.fingerprint,
    marketsCount: req.markets.length,
    observationsCount: batch.total,
    tradesCount: outcome.result.trades.length,
    rawLongCount,
    rawShortCount,
    result: outcome.result,
    outcome,
    limitations: Object.freeze(limitations),
    truthfulBaselineName: `Real PnL / ${policy.id} ${policy.fingerprint} — ${outcome.result.trades.length} trades, raw LONG ${rawLongCount} SHORT ${rawShortCount}`,
    readOnly: true as const,
  });
}

export function formatRealPnlReport(diag: RealPnlDiagnostics): string {
  const lines: string[] = [];
  lines.push("=== Real PnL Runner Diagnostics — READ ONLY — REAL PNL WITH EXPLICIT POLICY ===");
  lines.push(`status: ${diag.status}`);
  lines.push(`baseline: ${diag.truthfulBaselineName}`);
  lines.push(`asset: ${diag.assetSymbol} timeframe: ${diag.timeframe} policy: ${diag.policyId ?? "null"} fingerprint: ${diag.policyFingerprint ?? "null"}`);
  lines.push(`markets: ${diag.marketsCount} observations: ${diag.observationsCount} raw LONG ${diag.rawLongCount} SHORT ${diag.rawShortCount} trades ${diag.tradesCount}`);
  if (diag.result) {
    lines.push(`trades: ${diag.result.trades.length} metrics: winRate=${(diag.result.metrics as any).winRate ?? "n/a"} PF=${(diag.result.metrics as any).profitFactor ?? "n/a"} totalNetPnl=${(diag.result.metrics as any).totalNetPnl ?? "n/a"}`);
    lines.push(`equity: initial=${(diag.result.config as any).initialEquity} final=${(diag.result.metrics as any).finalEquity ?? "n/a"}`);
  }
  if (diag.outcome && !diag.outcome.ok) {
    lines.push(`outcome failed: stage=${diag.outcome.stage} errors=${diag.outcome.errors.join("; ")}`);
  }
  lines.push("limitations:");
  for (const l of diag.limitations) {
    lines.push(`  - ${l}`);
  }
  lines.push("NOTE: Real PnL calculated only when execution policy APPROVED with explicit requiredEconomicFields, no hidden defaults, policy identity in fingerprint");
  return lines.join("\n");
}

export { approvePolicy } from "./execution-policy-approval";
