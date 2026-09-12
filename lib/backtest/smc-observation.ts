/**
 * Historical Raw SMC Observation layer — Phase B.
 *
 * Reuses existing production logic (evaluateSmc) — does NOT copy/rewrite second SMC algorithm.
 * Output raw observations preserving exactly LONG/SHORT/NEUTRAL/CANNOT_EVALUATE.
 * Includes deterministic provenance: market(s), timeframe, decision bar, asOf, common horizon, participant count, reasons, facts/fingerprint, window policy.
 * No SL/TP, no PnL.
 *
 * Architecture preserves two concepts:
 * Concept 1: RawSmcObservation containing real production SMC outcome
 * Concept 2: Executability (EXECUTABLE or NON_EXECUTABLE: NO_EXECUTION_POLICY etc)
 *
 * A raw LONG/SHORT without approved SL/TP remains raw.direction=LONG/SHORT and executability=NON_EXECUTABLE, must NOT become fake NEUTRAL or CANNOT_EVALUATE.
 */

import { evaluateSmc, type SmcEvaluation } from "../smc/evaluate";
import type { SmcScoringConfig } from "../smc/config";
import { minimumSwingHistoryCandles } from "../smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../smc/types";
import { SMCTIMEFRAME_MS } from "../smc/types";
import { deepFreeze } from "./immutable";
import { utcDateFromMs, getTimeframeMs, formatIsoUtc } from "./timeframe";
import type { BacktestMarketRow } from "./data-source";
import type { ExecutionPolicyResult, Executability } from "./execution-policy";
import { buildNonExecutableResult } from "./execution-policy";

export type RawDirection = "LONG" | "SHORT" | "NEUTRAL" | "CANNOT_EVALUATE";

export type WindowPolicy = {
  readonly hardMinimumBars: number;
  readonly productionWindowBars: number; // 500
  readonly fullAvailabilityRequired: number | null; // e.g. maybe same as hardMinimum or larger?
  readonly fetchCap: number; // 500
  readonly strategyMemory: "ROLLING_500" | "EXPANDING" | "UNKNOWN";
  readonly historicalFidelityWindow: number; // hypothesis: 500 as production fidelity contract
  readonly description: string;
};

export const PRODUCTION_WINDOW_POLICY: WindowPolicy = Object.freeze({
  hardMinimumBars: 84, // approximate minimum hard swing history, will be overridden per config
  productionWindowBars: 500,
  fullAvailabilityRequired: null, // to be determined per evaluation
  fetchCap: 500,
  strategyMemory: "ROLLING_500",
  historicalFidelityWindow: 500,
  description:
    "Production Smart Money runtime fetches latest 500 CLOSED candles (orderBy openTime DESC take 500). Historical evaluation at H should see only equivalent causal rolling window, not whole future or arbitrary expanding history. 500 is production fidelity window hypothesis/contract after code verification, not mathematical hard minimum.",
});

export type RawSmcObservation = {
  readonly marketId: number;
  readonly exchange: string;
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly decisionBarOpenTime: string; // ISO
  readonly decisionBarOpenTimeMs: number;
  readonly asOf: string; // ISO — causal historical clock H + D
  readonly asOfMs: number;
  readonly commonHorizon: string | null; // ISO if multi-exchange
  readonly participantCount: number;
  readonly direction: RawDirection;
  readonly longScore: number | null;
  readonly shortScore: number | null;
  readonly reasons: readonly string[];
  readonly factsFingerprint: string | null; // deterministic fingerprint of facts if available
  readonly windowPolicy: WindowPolicy;
  readonly hardMinimumBars: number;
  readonly productionWindowBars: number;
  readonly availableBars: number;
  readonly isFullAvailability: boolean;
  readonly evaluation: SmcEvaluation; // full raw evaluation for provenance
  readonly provenance: {
    readonly marketEcho: boolean;
    readonly timeframeEcho: boolean;
    readonly closedOnly: boolean;
    readonly ascOrdering: boolean;
    readonly noFuture: boolean;
  };
};

export type HistoricalObservationBatch = {
  readonly observations: readonly RawSmcObservation[];
  readonly timeframe: SmcTimeframe;
  readonly from: string;
  readonly to: string;
  readonly total: number;
  readonly longCount: number;
  readonly shortCount: number;
  readonly neutralCount: number;
  readonly cannotEvaluateCount: number;
  readonly readOnly: true;
  readonly noPnl: true;
};

export type ObservationWithExecutability = {
  readonly observation: RawSmcObservation;
  readonly executability: Executability;
  readonly executionPolicy: ExecutionPolicyResult;
};

/**
 * Build window policy for a given config (hard minimum computed).
 */
export function buildWindowPolicyForConfig(config: SmcScoringConfig): WindowPolicy {
  const hardMin = minimumSwingHistoryCandles(config);
  return Object.freeze({
    ...PRODUCTION_WINDOW_POLICY,
    hardMinimumBars: hardMin,
    fullAvailabilityRequired: hardMin, // for now same as hard min; could be larger if components need more
  });
}

/**
 * Causal historical clock: for canonical candle open H and timeframe duration D,
 * earliest causal closed evaluation is approximately H + D according to existing closed-candle semantics.
 * This function computes asOf = H + D (and also provides boundary tests).
 */
export function computeCausalAsOf(decisionBarOpenTimeMs: number, timeframe: SmcTimeframe): Date {
  const duration = SMCTIMEFRAME_MS[timeframe];
  if (!duration) {
    throw new Error(`computeCausalAsOf: unknown timeframe ${timeframe}`);
  }
  // H + D
  return utcDateFromMs(decisionBarOpenTimeMs + duration);
}

/**
 * Test exact boundaries:
 * H + D -1ms => not yet closed
 * H + D => closed
 * H + D +1ms => closed (after)
 * H + 2D boundary => next bar closed
 */
export function testCausalClockBoundary(
  decisionBarOpenTimeMs: number,
  timeframe: SmcTimeframe,
  testAsOfMs: number
): "BEFORE_CLOSE" | "AT_CLOSE" | "AFTER_CLOSE" {
  const duration = SMCTIMEFRAME_MS[timeframe];
  const closeMs = decisionBarOpenTimeMs + duration;
  if (testAsOfMs < closeMs) return "BEFORE_CLOSE";
  if (testAsOfMs === closeMs) return "AT_CLOSE";
  return "AFTER_CLOSE";
}

/**
 * Evaluate single market historical observation at decision bar H,
 * using causal prefix of candles (only up to H inclusive).
 *
 * No future array captured by strategy/provider closure.
 * Uses production evaluateSmc directly.
 */
export function evaluateHistoricalRawObservation(
  params: {
    market: BacktestMarketRow;
    assetSymbol: string;
    timeframe: SmcTimeframe;
    decisionBarOpenTimeMs: number;
    allCandlesAsc: readonly SmcRawCandle[]; // must be ASC, CLOSED only, up to at least H
    smcConfig: SmcScoringConfig;
    commonHorizon: Date | null;
    participantCount: number;
  }
): RawSmcObservation {
  const { market, assetSymbol, timeframe, decisionBarOpenTimeMs, allCandlesAsc, smcConfig, commonHorizon, participantCount } = params;

  // Validate no future beyond H in provided prefix (defense)
  const future = allCandlesAsc.filter((c) => c.openTime.getTime() > decisionBarOpenTimeMs);
  if (future.length > 0) {
    throw new Error(
      `evaluateHistoricalRawObservation: causal prefix must not contain future beyond decision bar H=${formatIsoUtc(decisionBarOpenTimeMs)}, found ${future.length} future candles (first future ${formatIsoUtc(future[0].openTime.getTime())})`
    );
  }

  // Compute causal asOf = H + D
  const asOf = computeCausalAsOf(decisionBarOpenTimeMs, timeframe);
  const asOfMs = asOf.getTime();

  // Window policy: production uses rolling 500, so historical should use causal rolling window
  // If allCandlesAsc is longer than 500, we should take only latest 500 up to H (production fidelity)
  const windowPolicy = buildWindowPolicyForConfig(smcConfig);
  const productionWindowBars = windowPolicy.productionWindowBars;

  let windowCandles: readonly SmcRawCandle[];
  if (allCandlesAsc.length > productionWindowBars) {
    // Take latest productionWindowBars candles (rolling window) — this reproduces production behavior better than expanding history
    windowCandles = allCandlesAsc.slice(allCandlesAsc.length - productionWindowBars);
  } else {
    windowCandles = allCandlesAsc;
  }

  // Also compute hard minimum
  const hardMin = minimumSwingHistoryCandles(smcConfig);
  const availableBars = windowCandles.length;
  const isFullAvailability = availableBars >= hardMin;

  // Evaluate using production evaluateSmc
  let evaluation: SmcEvaluation;
  try {
    evaluation = evaluateSmc(windowCandles as any, smcConfig, asOf);
  } catch (e) {
    // If evaluateSmc throws due to insufficient history, we treat as CANNOT_EVALUATE with explicit reason
    // But per contract, evaluateSmc should return CANNOT_EVALUATE not throw for insufficient history, except invalid input
    throw new Error(`evaluateSmc failed at H=${formatIsoUtc(decisionBarOpenTimeMs)}: ${(e as Error).message}`);
  }

  // Map direction
  const direction = evaluation.direction as RawDirection;

  // Reasons as strings (from SmcScoreReason)
  const reasons = evaluation.reasons.map((r) => `${r.code}:${r.label ?? ""}`.trim());

  // Simple fingerprint: hash of direction + scores + reasons length (deterministic placeholder)
  const factsFingerprint = `dir=${direction}|long=${evaluation.longScore ?? "null"}|short=${evaluation.shortScore ?? "null"}|reasons=${reasons.length}|bars=${availableBars}`;

  const obs: RawSmcObservation = {
    marketId: market.id,
    exchange: market.exchange,
    assetSymbol,
    timeframe,
    decisionBarOpenTime: formatIsoUtc(decisionBarOpenTimeMs),
    decisionBarOpenTimeMs,
    asOf: asOf.toISOString(),
    asOfMs,
    commonHorizon: commonHorizon ? commonHorizon.toISOString() : null,
    participantCount,
    direction,
    longScore: evaluation.longScore,
    shortScore: evaluation.shortScore,
    reasons: Object.freeze(reasons),
    factsFingerprint,
    windowPolicy: Object.freeze(windowPolicy),
    hardMinimumBars: hardMin,
    productionWindowBars,
    availableBars,
    isFullAvailability,
    evaluation,
    provenance: Object.freeze({
      marketEcho: true,
      timeframeEcho: true,
      closedOnly: true,
      ascOrdering: true,
      noFuture: true,
    }),
  };

  return deepFreeze(obs) as RawSmcObservation;
}

/**
 * Evaluate batch of historical observations for a single market over a range of decision bars.
 * Uses causal prefixes: for each H, only candles <= H are visible.
 * Ensures future suffix changes do not alter past observations.
 */
export function evaluateHistoricalObservationsBatch(
  params: {
    market: BacktestMarketRow;
    assetSymbol: string;
    timeframe: SmcTimeframe;
    decisionBarsMs: readonly number[]; // sorted ASC decision bar open times
    allCandlesAsc: readonly SmcRawCandle[]; // all candles ASC (full history)
    smcConfig: SmcScoringConfig;
    commonHorizon?: Date | null;
    participantCount?: number;
  }
): HistoricalObservationBatch {
  const { market, assetSymbol, timeframe, decisionBarsMs, allCandlesAsc, smcConfig } = params;
  const commonHorizon = params.commonHorizon ?? null;
  const participantCount = params.participantCount ?? 1;

  // Ensure decisionBars are sorted ASC
  for (let i = 1; i < decisionBarsMs.length; i++) {
    if (decisionBarsMs[i] <= decisionBarsMs[i - 1]) {
      throw new Error("evaluateHistoricalObservationsBatch: decisionBarsMs must be strictly ASC");
    }
  }

  // Ensure allCandlesAsc sorted ASC
  for (let i = 1; i < allCandlesAsc.length; i++) {
    if (allCandlesAsc[i].openTime.getTime() <= allCandlesAsc[i - 1].openTime.getTime()) {
      throw new Error("evaluateHistoricalObservationsBatch: allCandlesAsc must be strictly ASC");
    }
  }

  const observations: RawSmcObservation[] = [];

  // For each decision bar H, build causal prefix up to H inclusive
  let candleIdx = 0;
  const sortedCandles = [...allCandlesAsc].sort((a, b) => a.openTime.getTime() - b.openTime.getTime());

  for (const H of decisionBarsMs) {
    // Advance candleIdx to include all candles <= H
    while (candleIdx < sortedCandles.length && sortedCandles[candleIdx].openTime.getTime() <= H) {
      candleIdx++;
    }
    const prefix = sortedCandles.slice(0, candleIdx);
    if (prefix.length === 0) continue; // no data yet

    const obs = evaluateHistoricalRawObservation({
      market,
      assetSymbol,
      timeframe,
      decisionBarOpenTimeMs: H,
      allCandlesAsc: prefix,
      smcConfig,
      commonHorizon,
      participantCount,
    });
    observations.push(obs);
  }

  const longCount = observations.filter((o) => o.direction === "LONG").length;
  const shortCount = observations.filter((o) => o.direction === "SHORT").length;
  const neutralCount = observations.filter((o) => o.direction === "NEUTRAL").length;
  const cannotEvaluateCount = observations.filter((o) => o.direction === "CANNOT_EVALUATE").length;

  const batch: HistoricalObservationBatch = {
    observations: Object.freeze(observations),
    timeframe,
    from: decisionBarsMs.length > 0 ? formatIsoUtc(decisionBarsMs[0]) : "n/a",
    to: decisionBarsMs.length > 0 ? formatIsoUtc(decisionBarsMs[decisionBarsMs.length - 1]) : "n/a",
    total: observations.length,
    longCount,
    shortCount,
    neutralCount,
    cannotEvaluateCount,
    readOnly: true as const,
    noPnl: true as const,
  };

  return deepFreeze(batch) as HistoricalObservationBatch;
}

/**
 * Wrap raw observation with executability (Phase D + E).
 * Until approved execution policy supplied, returns NON_EXECUTABLE NO_EXECUTION_POLICY.
 * Raw LONG/SHORT preserved, not converted to fake NEUTRAL.
 */
export function wrapWithExecutability(
  observation: RawSmcObservation,
  executionPolicyResult: ExecutionPolicyResult | null
): ObservationWithExecutability {
  const policyResult =
    executionPolicyResult ??
    buildNonExecutableResult("NO_EXECUTION_POLICY", "No execution policy supplied — raw observation remains LONG/SHORT but non-executable");

  // If policy says EXECUTABLE, we still need to ensure raw direction is LONG/SHORT
  // If raw is NEUTRAL/CANNOT_EVALUATE, executability is still NON_EXECUTABLE? Actually NEUTRAL is not executable as trade, but we keep raw.
  // For now, if raw is LONG/SHORT and policy EXECUTABLE, we allow EXECUTABLE, else NON_EXECUTABLE with reason.
  let finalExecutability = policyResult.executability;

  if (observation.direction === "NEUTRAL" || observation.direction === "CANNOT_EVALUATE") {
    // Raw NEUTRAL/CANNOT_EVALUATE never becomes EXECUTABLE trade, but we preserve raw
    if (finalExecutability.status === "EXECUTABLE") {
      finalExecutability = {
        status: "NON_EXECUTABLE",
        reason: "NO_VALID_TARGET" as const,
        details: `Raw direction ${observation.direction} is not executable as trade`,
      };
    }
  }

  return Object.freeze({
    observation,
    executability: Object.freeze(finalExecutability),
    executionPolicy: Object.freeze(policyResult),
  });
}

export function formatRawObservationReport(obs: RawSmcObservation): string {
  return [
    `RawSmcObservation market=${obs.marketId} ${obs.exchange} tf=${obs.timeframe} H=${obs.decisionBarOpenTime} asOf=${obs.asOf} commonHorizon=${obs.commonHorizon ?? "n/a"} participants=${obs.participantCount}`,
    `  direction=${obs.direction} longScore=${obs.longScore ?? "null"} shortScore=${obs.shortScore ?? "null"} availableBars=${obs.availableBars}/${obs.productionWindowBars} hardMin=${obs.hardMinimumBars} fullAvail=${obs.isFullAvailability}`,
    `  reasons: ${obs.reasons.join(", ") || "none"}`,
    `  fingerprint: ${obs.factsFingerprint}`,
    `  windowPolicy: ${obs.windowPolicy.strategyMemory} hardMin=${obs.windowPolicy.hardMinimumBars} prodWindow=${obs.windowPolicy.productionWindowBars} fetchCap=${obs.windowPolicy.fetchCap} fidelity=${obs.windowPolicy.historicalFidelityWindow}`,
  ].join("\n");
}
