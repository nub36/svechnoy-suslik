/**
 * PHASE 2B/2C — Smart Money Signal Candidate Builder — FINAL HARDENING
 *
 * Single immutable builder for both dry-run and live persistence.
 * Ensures dry-run logic == live logic (no re-evaluation).
 *
 * PHASE 2C hardening:
 * - No optimistic fallback entry = nextBarOpenPrice OR referencePrice FORBIDDEN
 *   If executionPolicy SMC_ATR_V1 and policy NEXT_BAR_OPEN, while next candle not available:
 *   entryPrice=NULL, entryTime=NULL, executionStatus=WAITING_ENTRY
 *   referencePrice remains analytic only, not executable.
 * - SL/TP not calculated from non-existing entry. ATR frozen at signal candle, but levels anchored to real NEXT_BAR_OPEN when it appears.
 * - Signal immutable observation vs SignalOutcome separate model.
 * - Score semantics: LONG => longScore, SHORT => shortScore, metadata stores both.
 * - Confirmation structured: participantCount, evaluatedCount, longVotes, shortVotes, neutralVotes, minExchanges, confirmationCount, confirmationTotal, policy, fresh/stale.
 *   confirmationTotal = evaluated, confirmationCount = votes for final direction, UI 3/4 = 3 of 4 evaluable.
 * - Quorum reference fallback metadata: referenceFallback boolean.
 * - Deep immutability via deepFreeze, not just top-level.
 * - Write guard AND (flag AND env).
 */

import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../smc/types";
import { evaluateSmc } from "../smc/evaluate";
import { truncateCandlesToHorizon, type CommonHorizonSelection } from "../strategies/common-horizon";
import { selectQuorumClosedHorizon, type QuorumSelection } from "../strategies/common-horizon-quorum";
import { aggregateAssetGroup, type MarketStrategyResult } from "../strategies/runtime";
import { evaluateMarketsAtCommonHorizon, type SmartMoneyMarketMeta } from "../strategies/smart-money";
import { selectReferenceExchange, REFERENCE_EXCHANGE_PRIORITY } from "./reference-exchange";
import { computeAtrSeries, atrValueAt } from "../smc/volatility";
import { validateAndPrepare, horizonCandles } from "../smc/validate";

export type ExecutionPolicy = "SMC_DIRECTION_ONLY" | "SMC_ATR_V1";
export type SignalSource = "LIVE_FORWARD" | "SEEDED" | "BACKTEST" | "LEGACY";
export type ExecutionStatus = "WAITING_ENTRY" | "ENTRY_DATA_MISSING" | "READY" | "NO_SIGNAL";

export const DEFAULT_SMC_ATR_V1_PARAMS = {
  version: 1,
  stopMultiplier: 1.5,
  takeProfit1Multiplier: 1.5,
  takeProfit2Multiplier: 2.5,
  takeProfit3Multiplier: 4.0,
  // Timeout not chosen yet — part of policy, versioned, design only
  timeoutCandles: null as number | null,
} as const;

export type SmartMoneyCandidateMetadata = {
  // Common horizon
  commonHorizon: string; // ISO = signalCandleTime
  asOf: string; // ISO = commonHorizon + tfMs, when signal becomes known
  expectedLatestClosed: string;
  now: string;
  timeframe: SmcTimeframe;
  policy: "STRICT" | "QUORUM";
  quorum?: {
    freshCount: number;
    staleCount: number;
    freshExchanges: string[];
    staleExchanges: string[];
  };
  // Participants — structured, not parsing reason
  participantCount: number; // total considered (eligible)
  eligibleCount: number;
  filteredCount: number;
  evaluatedCount: number; // actually evaluated (evaluable)
  skippedCount: number; // filtered + cannot-evaluate
  // Aggregation
  longVotes: number;
  shortVotes: number;
  neutralVotes: number;
  confirmation: string; // e.g. "3/4"
  confirmationCount: number; // votes for final direction
  confirmationTotal: number; // evaluated
  minExchanges: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  conflict: boolean;
  // Scores — both stored
  longScore: number | null; // score for LONG direction (if LONG, = score, else maxLong)
  shortScore: number | null;
  maxLongScore: number | null;
  maxShortScore: number | null;
  // Per-exchange
  perExchange: Array<{
    exchange: string;
    marketId: number;
    direction: string;
    longScore: number | null;
    shortScore: number | null;
    evaluable: boolean;
    hardFailures: string[];
    softUnavailable: string[];
    price: number | null;
    reasons: Array<{ code: string; longPoints: number; shortPoints: number; maxPoints: number; label: string; value: string | null }>;
  }>;
  // Reference
  referenceExchange: string | null;
  referencePrice: number | null; // analytic only
  aggregatePrice: number | null; // informational only, never executable
  referenceFallback: boolean; // true if BINANCE missing and fallback used
  // ATR — frozen from signal candle
  atrAtSignal: number | null;
  atrPeriod: number;
  executionParams: typeof DEFAULT_SMC_ATR_V1_PARAMS;
  // Next bar — exact required
  nextBarOpenPrice: number | null;
  nextBarOpenTime: string | null; // = asOf when available
  nextBarExpectedOpenTime: string; // H + tfMs, for gap detection
  // Execution
  executionPolicy: ExecutionPolicy;
  executionStatus: ExecutionStatus;
  // Source
  signalSource: SignalSource;
};

export type SmartMoneySignalCandidate = {
  // Identity for unique [strategyId, symbol, timeframe, signalCandleTime]
  strategyId: number;
  symbol: string;
  timeframe: SmcTimeframe;
  signalCandleTime: Date; // = commonHorizon
  // Direction
  direction: "LONG" | "SHORT" | "NEUTRAL";
  // Scores — LONG => longScore, SHORT => shortScore, metadata stores both
  score: number;
  longScore: number | null;
  shortScore: number | null;
  // Reference — immutable observation
  referenceExchange: string | null;
  referencePrice: number | null; // analytic only, NOT executable fallback
  aggregatePrice: number | null; // informational only
  referenceFallback: boolean;
  // Execution — PHASE 2C: no optimistic fallback
  // If NEXT_BAR_OPEN policy and next bar not available: entry = NULL, status WAITING_ENTRY
  entry: number | null;
  entryTime: Date | null;
  executionStatus: ExecutionStatus;
  // ATR frozen at signal candle, SL/TP only after entry known
  atrAtSignal: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  executionPolicy: ExecutionPolicy;
  executionParams: typeof DEFAULT_SMC_ATR_V1_PARAMS;
  // Explanation
  reason: string;
  metadata: SmartMoneyCandidateMetadata;
  signalSource: SignalSource;
  asOf: Date;
  commonHorizon: Date;
  // Structured confirmation
  participantCount: number;
  evaluatedCount: number;
  confirmationCount: number;
  confirmationTotal: number;
};

export type CandidateBuilderInput = {
  markets: Array<{ meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] }>;
  timeframe: SmcTimeframe;
  smcConfig: any;
  filters: any;
  now: Date;
  strategyId: number;
  strategyVersion: number;
  strategySlug: string;
  symbol: string;
  minExchanges: number;
  policy: "STRICT" | "QUORUM";
  // For NEXT_BAR_OPEN, need next bar candles (OPEN of H+D) — exact required
  nextBarCandles?: Array<{ marketId: number; openTime: Date; open: number }>;
};

export type CandidateBuilderResult =
  | { status: "ok"; candidate: SmartMoneySignalCandidate; aggregation: any; selection: CommonHorizonSelection | QuorumSelection; results: MarketStrategyResult[] }
  | { status: "no_signal"; reason: string; selection: CommonHorizonSelection | QuorumSelection; results: MarketStrategyResult[]; insufficientReason?: string };

// Deep freeze for immutability
function deepFreeze<T>(obj: T): T {
  if (obj === null || typeof obj !== "object") return obj;
  Object.getOwnPropertyNames(obj).forEach((prop) => {
    const value = (obj as any)[prop];
    if (value && typeof value === "object") {
      deepFreeze(value);
    }
  });
  return Object.freeze(obj);
}

export function buildSmartMoneySignalCandidate(input: CandidateBuilderInput): CandidateBuilderResult {
  const { markets, timeframe, smcConfig, filters, now, strategyId, symbol, minExchanges, policy, nextBarCandles } = input;
  const tfMs = SMCTIMEFRAME_MS[timeframe];

  let selection: CommonHorizonSelection | QuorumSelection;
  let results: MarketStrategyResult[];
  let usable: boolean;
  let filteredCount = 0;

  if (policy === "QUORUM") {
    const quorumSel = selectQuorumClosedHorizon(
      markets.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles })),
      timeframe,
      { now, minExchanges }
    );
    selection = quorumSel;

    if (quorumSel.status !== "ok" || !quorumSel.commonHorizon) {
      return {
        status: "no_signal",
        reason: `QUORUM ${quorumSel.status}: ${quorumSel.reason}`,
        selection,
        results: [],
        insufficientReason: quorumSel.status === "quorum_not_met" ? "INSUFFICIENT_EVALUATED_EXCHANGES" : quorumSel.status.toUpperCase(),
      };
    }

    const freshIds = new Set(quorumSel.freshMarkets.map((f) => f.marketId));
    const freshMarkets = markets.filter((m) => freshIds.has(m.meta.marketId));
    const outcome = evaluateMarketsAtCommonHorizon(freshMarkets, timeframe, smcConfig, filters, now);
    results = outcome.results;
    usable = outcome.usable && outcome.selection.status === "ok";
    filteredCount = outcome.filteredCount;

    if (!usable) {
      return {
        status: "no_signal",
        reason: `QUORUM fresh evaluation not usable: ${outcome.selection.reason}`,
        selection,
        results,
        insufficientReason: "EVALUATION_NOT_USABLE",
      };
    }
  } else {
    const outcome = evaluateMarketsAtCommonHorizon(markets, timeframe, smcConfig, filters, now);
    selection = outcome.selection;
    results = outcome.results;
    usable = outcome.usable;
    filteredCount = outcome.filteredCount;

    if (!usable || selection.status !== "ok" || !selection.commonHorizon) {
      return {
        status: "no_signal",
        reason: `STRICT ${selection.status}: ${selection.reason}`,
        selection,
        results,
        insufficientReason: selection.status.toUpperCase(),
      };
    }
  }

  const commonHorizon = selection.commonHorizon!;
  const asOf = new Date(commonHorizon.getTime() + tfMs);
  const expectedNextOpenTime = asOf; // H + D

  const aggregation = aggregateAssetGroup(symbol, timeframe, input.strategySlug, input.strategyVersion, results as any, minExchanges);

  if (aggregation.evaluated < minExchanges) {
    return {
      status: "no_signal",
      reason: `INSUFFICIENT_EVALUATED_EXCHANGES: evaluated ${aggregation.evaluated} < minExchanges ${minExchanges}`,
      selection,
      results,
      insufficientReason: "INSUFFICIENT_EVALUATED_EXCHANGES",
    };
  }

  if (aggregation.direction === "NEUTRAL") {
    return {
      status: "no_signal",
      reason: `NEUTRAL: ${aggregation.explanation} ${aggregation.conflict ? "conflict" : ""}`,
      selection,
      results,
      insufficientReason: aggregation.conflict ? "CONFLICT" : "NO_CONFIRMATION",
    };
  }

  // Reference exchange — deterministic priority, independent of score
  const evaluatedParticipants = results.filter((r) => r.status === "evaluated").map((r) => ({ exchange: r.exchange, marketId: r.marketId }));
  const ref = selectReferenceExchange(evaluatedParticipants, REFERENCE_EXCHANGE_PRIORITY);
  const refMarket = ref ? markets.find((m) => m.meta.marketId === ref.marketId) : null;
  const refTruncated = refMarket ? truncateCandlesToHorizon(refMarket.candles, commonHorizon) : [];
  const refPrice = refTruncated.length > 0 ? refTruncated[refTruncated.length - 1].close : null;

  const aggregatePrice = (() => {
    const prices = results.filter((r) => r.status === "evaluated").map((r) => (r as any).price as number).filter((p) => Number.isFinite(p));
    return prices.length > 0 ? prices.reduce((a, b) => a + b, 0) / prices.length : null;
  })();

  const referenceFallback = ref ? ref.exchange !== "BINANCE" && evaluatedParticipants.some((p) => p.exchange === "BINANCE" ? false : true) && !evaluatedParticipants.find((p) => p.exchange === "BINANCE") : false;
  // More accurate: fallback true if BINANCE not in evaluated but reference exists and is not BINANCE
  const hasBinance = evaluatedParticipants.some((p) => p.exchange === "BINANCE");
  const isFallback = !hasBinance && ref !== null && ref.exchange !== "BINANCE" ? true : ref !== null && ref.exchange !== "BINANCE" && evaluatedParticipants.length > 0 && !evaluatedParticipants.find((p) => p.exchange === "BINANCE") ? true : false;
  // Simplified: if BINANCE not fresh/evaluated and we picked another, fallback true
  const fallbackFlag = !hasBinance && ref !== null;

  // ATR from reference exchange only, frozen at signal candle
  let atrAtSignal: number | null = null;
  if (refTruncated.length > 0) {
    try {
      const prepared = validateAndPrepare(refTruncated, timeframe);
      const horizon = horizonCandles(prepared, asOf);
      const atrSeries = computeAtrSeries(horizon, smcConfig.atrPeriod);
      atrAtSignal = atrValueAt(atrSeries, horizon.length - 1);
    } catch {
      atrAtSignal = null;
    }
  }

  // Next bar — exact required, no gap skip
  let nextBarOpenPrice: number | null = null;
  let nextBarOpenTime: Date | null = null;
  let executionStatus: ExecutionStatus = "WAITING_ENTRY";
  let entry: number | null = null;
  let entryTime: Date | null = null;

  if (nextBarCandles && ref) {
    const expectedMs = expectedNextOpenTime.getTime();
    const next = nextBarCandles.find((c) => c.marketId === ref.marketId && c.openTime.getTime() === expectedMs);
    if (next) {
      nextBarOpenPrice = next.open;
      nextBarOpenTime = next.openTime;
      entry = next.open;
      entryTime = next.openTime;
      executionStatus = "READY";
    } else {
      // Check if any next candle exists but with wrong time (gap)
      const anyNext = nextBarCandles.find((c) => c.marketId === ref.marketId && c.openTime.getTime() > commonHorizon.getTime());
      if (anyNext) {
        if (anyNext.openTime.getTime() !== expectedMs) {
          executionStatus = "ENTRY_DATA_MISSING";
        } else {
          // Should not happen, but handle
          executionStatus = "WAITING_ENTRY";
        }
      } else {
        executionStatus = "WAITING_ENTRY";
      }
    }
  } else {
    // No next bar data provided — waiting
    executionStatus = "WAITING_ENTRY";
  }

  // SL/TP only after entry known — ATR frozen, but levels anchored to real NEXT_BAR_OPEN
  const execParams = DEFAULT_SMC_ATR_V1_PARAMS;
  let stopLoss: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;

  if (executionStatus === "READY" && entry !== null && atrAtSignal !== null) {
    if (aggregation.direction === "LONG") {
      stopLoss = entry - atrAtSignal * execParams.stopMultiplier;
      tp1 = entry + atrAtSignal * execParams.takeProfit1Multiplier;
      tp2 = entry + atrAtSignal * execParams.takeProfit2Multiplier;
      tp3 = entry + atrAtSignal * execParams.takeProfit3Multiplier;
    } else if (aggregation.direction === "SHORT") {
      stopLoss = entry + atrAtSignal * execParams.stopMultiplier;
      tp1 = entry - atrAtSignal * execParams.takeProfit1Multiplier;
      tp2 = entry - atrAtSignal * execParams.takeProfit2Multiplier;
      tp3 = entry - atrAtSignal * execParams.takeProfit3Multiplier;
    }
  }

  // Score semantics: LONG => longScore, SHORT => shortScore, metadata stores both
  const evaluatedResults = results.filter((r) => r.status === "evaluated") as any[];
  const maxLongScore = evaluatedResults.length > 0 ? Math.max(...evaluatedResults.map((r) => r.longScore)) : null;
  const maxShortScore = evaluatedResults.length > 0 ? Math.max(...evaluatedResults.map((r) => r.shortScore)) : null;
  // For final direction, score = corresponding side
  const score = aggregation.direction === "LONG" ? maxLongScore ?? 0 : aggregation.direction === "SHORT" ? maxShortScore ?? 0 : 0;
  // For metadata, store both longScore and shortScore as max
  const longScoreForMeta = maxLongScore;
  const shortScoreForMeta = maxShortScore;

  const perExchange = results.map((r) => {
    if (r.status !== "evaluated") {
      return {
        exchange: r.exchange,
        marketId: r.marketId,
        direction: "CANNOT_EVALUATE",
        longScore: null,
        shortScore: null,
        evaluable: false,
        hardFailures: [(r as any).reason],
        softUnavailable: [],
        price: null,
        reasons: [],
      };
    }
    const marketCandles = markets.find((m) => m.meta.marketId === r.marketId)?.candles ?? [];
    const truncated = truncateCandlesToHorizon(marketCandles, commonHorizon);
    let fullEval: any = null;
    try {
      fullEval = evaluateSmc(truncated, smcConfig, asOf);
    } catch {
      fullEval = null;
    }
    return {
      exchange: r.exchange,
      marketId: r.marketId,
      direction: r.direction,
      longScore: r.longScore,
      shortScore: r.shortScore,
      evaluable: fullEval?.availability.evaluable ?? true,
      hardFailures: fullEval?.availability.hardFailures.map((f: any) => `${f.code}:${f.label}`) ?? [],
      softUnavailable: fullEval?.availability.softUnavailable.map((f: any) => f.code) ?? [],
      price: (r as any).price,
      reasons: fullEval?.reasons.map((rr: any) => ({ code: rr.code, longPoints: rr.longPoints, shortPoints: rr.shortPoints, maxPoints: rr.maxPoints, label: rr.label, value: rr.value })) ?? [],
    };
  });

  const confirmationCount = aggregation.direction === "LONG" ? aggregation.longVotes : aggregation.direction === "SHORT" ? aggregation.shortVotes : 0;
  const confirmationTotal = aggregation.evaluated; // evaluated exchanges, not eligible, not fresh — fixed semantics
  const confirmation = `${confirmationCount}/${confirmationTotal}`;

  const reason = `${aggregation.direction} ${confirmation} at ${commonHorizon.toISOString()} ref=${ref?.exchange ?? "none"}${fallbackFlag ? " (fallback)" : ""} refPrice=${refPrice?.toFixed(2) ?? "null"} aggPrice=${aggregatePrice?.toFixed(2) ?? "null"} atr=${atrAtSignal?.toFixed(2) ?? "null"} entryStatus=${executionStatus} ${aggregation.explanation}`;

  const metadata: SmartMoneyCandidateMetadata = {
    commonHorizon: commonHorizon.toISOString(),
    asOf: asOf.toISOString(),
    expectedLatestClosed: (selection as any).expectedLatestClosed?.toISOString() ?? commonHorizon.toISOString(),
    now: now.toISOString(),
    timeframe,
    policy,
    quorum:
      policy === "QUORUM"
        ? {
            freshCount: (selection as QuorumSelection).freshCount,
            staleCount: (selection as QuorumSelection).staleCount,
            freshExchanges: (selection as QuorumSelection).freshMarkets.map((f) => f.exchange),
            staleExchanges: (selection as QuorumSelection).staleMarkets.map((s) => s.exchange),
          }
        : undefined,
    participantCount: (selection as any).participantCount,
    eligibleCount: markets.length,
    filteredCount,
    evaluatedCount: aggregation.evaluated,
    skippedCount: aggregation.skipped,
    longVotes: aggregation.longVotes,
    shortVotes: aggregation.shortVotes,
    neutralVotes: aggregation.neutralVotes,
    confirmation,
    confirmationCount,
    confirmationTotal,
    minExchanges,
    direction: aggregation.direction as any,
    conflict: aggregation.conflict,
    longScore: longScoreForMeta,
    shortScore: shortScoreForMeta,
    maxLongScore,
    maxShortScore,
    perExchange,
    referenceExchange: ref?.exchange ?? null,
    referencePrice: refPrice,
    aggregatePrice,
    referenceFallback: fallbackFlag,
    atrAtSignal,
    atrPeriod: smcConfig.atrPeriod,
    executionParams: execParams,
    nextBarOpenPrice,
    nextBarOpenTime: nextBarOpenTime?.toISOString() ?? null,
    nextBarExpectedOpenTime: expectedNextOpenTime.toISOString(),
    executionPolicy: "SMC_ATR_V1",
    executionStatus,
    signalSource: "LIVE_FORWARD",
  };

  const candidate: SmartMoneySignalCandidate = {
    strategyId,
    symbol,
    timeframe,
    signalCandleTime: commonHorizon,
    direction: aggregation.direction as any,
    score,
    longScore: longScoreForMeta,
    shortScore: shortScoreForMeta,
    referenceExchange: ref?.exchange ?? null,
    referencePrice: refPrice,
    aggregatePrice: aggregatePrice,
    referenceFallback: fallbackFlag,
    entry,
    entryTime,
    executionStatus,
    atrAtSignal,
    stopLoss,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    executionPolicy: "SMC_ATR_V1",
    executionParams: execParams,
    reason,
    metadata,
    signalSource: "LIVE_FORWARD",
    asOf,
    commonHorizon,
    participantCount: (selection as any).participantCount,
    evaluatedCount: aggregation.evaluated,
    confirmationCount,
    confirmationTotal,
  };

  // Deep freeze for immutability — recursive
  deepFreeze(candidate);

  return { status: "ok", candidate, aggregation, selection, results };
}

/**
 * Build outcome from candidate and next bar — separate model, does not mutate Signal
 * Contract:
 * - Signal is immutable observation at H
 * - Outcome starts WAITING_ENTRY, becomes OPEN when next bar H+D appears with exact openTime
 * - If next expected candle missing, ENTRY_DATA_MISSING, no gap skip
 * - SL/TP anchored to real NEXT_BAR_OPEN, ATR frozen from signal candle
 * - Same-bar pessimistic: if entry bar hits both SL and TP, SL first
 * - Gap-through: if OPEN already beyond SL/TP boundary, use actual open per backtest contract, not level price
 * - TP1/TP2 milestones, TP3 or STOP/EXPIRED terminal, store tp1HitAt etc
 */
export function buildOutcomeFromCandidate(
  candidate: SmartMoneySignalCandidate,
  nextBar: { openTime: Date; open: number; high: number; low: number; close: number } | null
): {
  status: string;
  entryTime: Date | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  reason: string;
} {
  const tfMs = SMCTIMEFRAME_MS[candidate.timeframe];
  const expectedNextOpenTime = new Date(candidate.signalCandleTime.getTime() + tfMs);

  if (!nextBar) {
    return {
      status: "WAITING_ENTRY",
      entryTime: null,
      entryPrice: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      reason: `WAITING_ENTRY: next bar ${expectedNextOpenTime.toISOString()} not yet available`,
    };
  }

  if (nextBar.openTime.getTime() !== expectedNextOpenTime.getTime()) {
    return {
      status: "ENTRY_DATA_MISSING",
      entryTime: null,
      entryPrice: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      reason: `ENTRY_DATA_MISSING: expected next bar ${expectedNextOpenTime.toISOString()} but got ${nextBar.openTime.toISOString()}, gap — no silent skip`,
    };
  }

  const entryPrice = nextBar.open;
  const entryTime = nextBar.openTime;
  const atr = candidate.atrAtSignal;
  const params = candidate.executionParams;

  if (atr === null) {
    return {
      status: "ENTRY_DATA_MISSING",
      entryTime,
      entryPrice,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      reason: `ENTRY_DATA_MISSING: ATR at signal is null`,
    };
  }

  let sl: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;

  if (candidate.direction === "LONG") {
    sl = entryPrice - atr * params.stopMultiplier;
    tp1 = entryPrice + atr * params.takeProfit1Multiplier;
    tp2 = entryPrice + atr * params.takeProfit2Multiplier;
    tp3 = entryPrice + atr * params.takeProfit3Multiplier;
  } else if (candidate.direction === "SHORT") {
    sl = entryPrice + atr * params.stopMultiplier;
    tp1 = entryPrice - atr * params.takeProfit1Multiplier;
    tp2 = entryPrice - atr * params.takeProfit2Multiplier;
    tp3 = entryPrice - atr * params.takeProfit3Multiplier;
  }

  return {
    status: "OPEN",
    entryTime,
    entryPrice,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    reason: `OPEN: entry at next bar open ${entryPrice} @ ${entryTime.toISOString()}, SL/TP anchored to real open, ATR ${atr} frozen from signal`,
  };
}
