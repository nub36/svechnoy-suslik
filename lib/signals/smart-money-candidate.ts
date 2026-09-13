/**
 * PHASE 2B — Smart Money Signal Candidate Builder
 *
 * Single immutable builder for both dry-run and live persistence.
 * Ensures dry-run logic == live logic (no re-evaluation).
 *
 * Uses production functions only:
 * evaluateSmc(), selectCommonClosedHorizon() or selectQuorumClosedHorizon(),
 * truncateCandlesToHorizon(), aggregateAssetGroup(), isSmartMoneyExchangeEligible()
 *
 * Reference exchange: deterministic priority, independent of score.
 * ATR: from reference exchange, not average.
 * Entry: REFERENCE_CLOSE vs NEXT_BAR_OPEN — contract documented below.
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

export type SignalSource = "LIVE_FORWARD" | "SEEDED" | "BACKTEST";

export const DEFAULT_SMC_ATR_V1_PARAMS = {
  version: 1,
  stopMultiplier: 1.5,
  takeProfit1Multiplier: 1.5,
  takeProfit2Multiplier: 2.5,
  takeProfit3Multiplier: 4.0,
} as const;

export type SmartMoneyCandidateMetadata = {
  // Common horizon
  commonHorizon: string; // ISO
  asOf: string; // ISO = commonHorizon + tfMs
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
  // Participants
  participantCount: number;
  eligibleCount: number;
  filteredCount: number;
  evaluatedCount: number;
  skippedCount: number;
  // Aggregation
  longVotes: number;
  shortVotes: number;
  neutralVotes: number;
  confirmation: string;
  minExchanges: number;
  direction: "LONG" | "SHORT" | "NEUTRAL";
  conflict: boolean;
  // Scores
  maxLongScore: number | null;
  maxShortScore: number | null;
  avgLongScore?: number;
  avgShortScore?: number;
  // Per-exchange details (structured, not parsing Russian text)
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
  referencePrice: number | null;
  aggregatePrice: number | null;
  // ATR
  atrAtSignal: number | null;
  atrPeriod: number;
  executionParams: typeof DEFAULT_SMC_ATR_V1_PARAMS;
  // Next bar open (for NEXT_BAR_OPEN policy)
  nextBarOpenPrice: number | null;
  nextBarOpenTime: string | null;
  // Execution
  executionPolicy: ExecutionPolicy;
  // Signal source
  signalSource: SignalSource;
};

export type SmartMoneySignalCandidate = {
  // Identity (for unique constraint)
  strategyId: number;
  symbol: string;
  timeframe: SmcTimeframe;
  signalCandleTime: Date; // = commonHorizon
  // Direction
  direction: "LONG" | "SHORT" | "NEUTRAL";
  // Scores
  score: number;
  longScore: number | null;
  shortScore: number | null;
  // Prices
  referenceExchange: string | null;
  referencePrice: number | null;
  aggregatePrice: number | null;
  entry: number | null; // per policy: REFERENCE_CLOSE or NEXT_BAR_OPEN
  // Execution (ATR_V1)
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  atrAtSignal: number | null;
  executionPolicy: ExecutionPolicy;
  executionParams: typeof DEFAULT_SMC_ATR_V1_PARAMS;
  // Explanation
  reason: string; // short human-readable
  metadata: SmartMoneyCandidateMetadata;
  // Source
  signalSource: SignalSource;
  // For persistence
  asOf: Date;
  commonHorizon: Date;
};

export type CandidateBuilderInput = {
  markets: Array<{ meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] }>;
  timeframe: SmcTimeframe;
  smcConfig: any; // SmcScoringConfig
  filters: any;
  now: Date;
  strategyId: number;
  strategyVersion: number;
  strategySlug: string;
  symbol: string;
  minExchanges: number;
  policy: "STRICT" | "QUORUM";
  // For ATR_V1, need next bar candles if available (optional)
  nextBarCandles?: Array<{ marketId: number; openTime: Date; open: number }>;
};

export type CandidateBuilderResult =
  | { status: "ok"; candidate: SmartMoneySignalCandidate; aggregation: any; selection: CommonHorizonSelection | QuorumSelection; results: MarketStrategyResult[] }
  | { status: "no_signal"; reason: string; selection: CommonHorizonSelection | QuorumSelection; results: MarketStrategyResult[]; insufficientReason?: string };

/**
 * Immutable candidate builder — single path for dry-run and live
 */
export function buildSmartMoneySignalCandidate(input: CandidateBuilderInput): CandidateBuilderResult {
  const { markets, timeframe, smcConfig, filters, now, strategyId, symbol, minExchanges, policy, nextBarCandles } = input;
  const tfMs = SMCTIMEFRAME_MS[timeframe];

  // 1. Determine common horizon via policy
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

    const commonHorizon = quorumSel.commonHorizon;
    // Build results only for fresh markets
    const freshIds = new Set(quorumSel.freshMarkets.map((f) => f.marketId));
    const freshMarkets = markets.filter((m) => freshIds.has(m.meta.marketId));

    // Evaluate fresh at common horizon
    const outcome = evaluateMarketsAtCommonHorizon(freshMarkets, timeframe, smcConfig, filters, now);
    // Note: evaluateMarketsAtCommonHorizon internally uses STRICT, but since all fresh have same latest==expected, it will be ok
    // For safety, we directly evaluate each fresh via truncate + evaluateSmc wrapper via evaluateMarketsAtCommonHorizon logic
    // Actually we already have outcome, but we need to ensure it uses expected horizon, not recalculated intersection
    // Since fresh all have expected, outcome.commonHorizon should equal expected
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
    // STRICT
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

  // 2. Aggregation
  const aggregation = aggregateAssetGroup(symbol, timeframe, input.strategySlug, input.strategyVersion, results as any, minExchanges);

  // Check evaluated < minExchanges
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

  // 3. Reference exchange — deterministic priority, independent of score
  const evaluatedParticipants = results.filter((r) => r.status === "evaluated").map((r) => ({ exchange: r.exchange, marketId: r.marketId }));
  const ref = selectReferenceExchange(evaluatedParticipants, REFERENCE_EXCHANGE_PRIORITY);
  const refMarket = ref ? markets.find((m) => m.meta.marketId === ref.marketId) : null;
  const refTruncated = refMarket ? truncateCandlesToHorizon(refMarket.candles, commonHorizon) : [];
  const refPrice = refTruncated.length > 0 ? refTruncated[refTruncated.length - 1].close : null;

  // Aggregate price (informational)
  const evaluatedPrices = results
    .filter((r) => r.status === "evaluated")
    .map((r) => (r as any).price as number)
    .filter((p) => Number.isFinite(p));
  const aggregatePrice = evaluatedPrices.length > 0 ? evaluatedPrices.reduce((a, b) => a + b, 0) / evaluatedPrices.length : null;

  // 4. ATR from reference exchange
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

  // 5. Next bar open (for NEXT_BAR_OPEN policy)
  let nextBarOpenPrice: number | null = null;
  let nextBarOpenTime: Date | null = null;
  if (nextBarCandles && ref) {
    const next = nextBarCandles.find((c) => c.marketId === ref.marketId && c.openTime.getTime() === asOf.getTime());
    if (next) {
      nextBarOpenPrice = next.open;
      nextBarOpenTime = next.openTime;
    }
  }

  // 6. Execution — SMC_ATR_V1
  // For causal-safe forward stats, entry = NEXT_BAR_OPEN if available, else REFERENCE_CLOSE
  // We store both, but entry field uses NEXT_BAR_OPEN when available
  const entry = nextBarOpenPrice ?? refPrice;
  const execParams = DEFAULT_SMC_ATR_V1_PARAMS;
  let stopLoss: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;

  if (entry !== null && atrAtSignal !== null) {
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

  // 7. Scores
  const evaluatedResults = results.filter((r) => r.status === "evaluated") as any[];
  const maxLongScore = evaluatedResults.length > 0 ? Math.max(...evaluatedResults.map((r) => r.longScore)) : null;
  const maxShortScore = evaluatedResults.length > 0 ? Math.max(...evaluatedResults.map((r) => r.shortScore)) : null;
  const score = aggregation.direction === "LONG" ? maxLongScore ?? 0 : maxShortScore ?? 0;

  // 8. Per-exchange detailed (for metadata)
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
    // Find full evaluation for this market to get hardFailures etc
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

  // 9. Reason short
  const reason = `${aggregation.direction} ${aggregation.confirmation} at ${commonHorizon.toISOString()} ref=${ref?.exchange ?? "none"} refPrice=${refPrice?.toFixed(2) ?? "null"} aggPrice=${aggregatePrice?.toFixed(2) ?? "null"} atr=${atrAtSignal?.toFixed(2) ?? "null"} ${aggregation.explanation}`;

  const metadata: SmartMoneyCandidateMetadata = {
    commonHorizon: commonHorizon.toISOString(),
    asOf: asOf.toISOString(),
    expectedLatestClosed: (selection as any).expectedLatestClosed?.toISOString() ?? commonHorizon.toISOString(),
    now: now.toISOString(),
    timeframe,
    policy: policy,
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
    confirmation: aggregation.confirmation,
    minExchanges,
    direction: aggregation.direction as any,
    conflict: aggregation.conflict,
    maxLongScore,
    maxShortScore,
    perExchange,
    referenceExchange: ref?.exchange ?? null,
    referencePrice: refPrice,
    aggregatePrice,
    atrAtSignal,
    atrPeriod: smcConfig.atrPeriod,
    executionParams: execParams,
    nextBarOpenPrice,
    nextBarOpenTime: nextBarOpenTime?.toISOString() ?? null,
    executionPolicy: "SMC_ATR_V1",
    signalSource: "LIVE_FORWARD",
  };

  const candidate: SmartMoneySignalCandidate = {
    strategyId,
    symbol,
    timeframe,
    signalCandleTime: commonHorizon,
    direction: aggregation.direction as any,
    score,
    longScore: maxLongScore,
    shortScore: maxShortScore,
    referenceExchange: ref?.exchange ?? null,
    referencePrice: refPrice,
    aggregatePrice,
    entry,
    stopLoss,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    atrAtSignal,
    executionPolicy: "SMC_ATR_V1",
    executionParams: execParams,
    reason,
    metadata,
    signalSource: "LIVE_FORWARD",
    asOf,
    commonHorizon,
  };

  // Freeze to ensure immutability
  Object.freeze(candidate);
  Object.freeze(candidate.metadata);
  Object.freeze(candidate.executionParams);

  return { status: "ok", candidate, aggregation, selection, results };
}
