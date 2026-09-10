/**
 * Phase 3E — Candle window alignment helper (read-only, pure).
 *
 * MarketStrategyResult.candleTime represents the latest CLOSED candle openTime
 * (from PostgreSQL Candle where closed=true, last CLOSED bar per market).
 * For same timeframe, identical candleTime means same canonical interval:
 *   [candleTime, candleTime + SMCTIMEFRAME_MS[timeframe])
 * We do NOT compare wall-clock execution time.
 *
 * Safe multi-exchange aggregation requires BOTH:
 * A) canonical grid alignment: each evaluated candleTime % SMCTIMEFRAME_MS[tf] === 0
 *    (UTC grid: 5m every 5min, 15m every 15min, 1h top, 4h q4, 1d UTC midnight)
 * B) same evaluation horizon: all evaluated markets share exactly the same
 *    candleTime (no stale/different horizon, even by one bar).
 *
 * This is pure, no DB, no side effects, deterministic, no lookahead.
 */

import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../smc/types";
import type { EvaluatedMarket, MarketStrategyResult } from "./runtime";

/**
 * Check if a candle openTime is canonical-aligned to UTC grid for timeframe.
 * For 5m: every 5min at 00 UTC, for 1h: every hour top, for 1d: UTC midnight.
 */
export function isCanonicalAligned(
  openTime: Date,
  timeframe: SmcTimeframe,
): boolean {
  const ms = SMCTIMEFRAME_MS[timeframe];
  // openTime is UTC-based via getTime(), epoch 1970-01-01 00:00 UTC is aligned
  return openTime.getTime() % ms === 0;
}

/**
 * Get offset in ms from canonical grid (0 = aligned).
 */
export function canonicalOffsetMs(
  openTime: Date,
  timeframe: SmcTimeframe,
): number {
  const ms = SMCTIMEFRAME_MS[timeframe];
  return openTime.getTime() % ms;
}

/**
 * Human-readable UTC hour for audit.
 */
export function utcHour(openTime: Date): number {
  return openTime.getUTCHours();
}

export type AlignmentDetail = {
  exchange: string;
  market: string;
  marketId: number;
  candleTime: Date;
  aligned: boolean;
  offsetMs: number;
  utcHour: number;
};

export type AlignmentCheck = {
  /** Legacy strict flag: true only if BOTH canonical and horizon pass and at least one evaluated exists. Kept for backward compat; equals safe. */
  aligned: boolean;
  /** Preferred strict flag: true only if canonical grid OK, same horizon, and at least one evaluated. */
  safe: boolean;
  /** Reference candleTime (first evaluated's openTime) — null when no evaluated. All evaluated must equal this. */
  referenceCandleTime: Date | null;
  /** Per-market details for evaluated markets */
  details: AlignmentDetail[];
  /** Subset of details where !isCanonicalAligned (off-grid) */
  offGrid: AlignmentDetail[];
  /** Subset of details where candleTime !== referenceCandleTime (different horizon, even by one bar) */
  horizonMismatch: AlignmentDetail[];
  /** Legacy alias for offGrid */
  misaligned: AlignmentDetail[];
  alignedCount: number;
  totalEvaluated: number;
  reason?: string;
};

/**
 * Check cross-exchange alignment for aggregation horizon.
 * Only evaluated markets are checked; filtered/cannot-evaluate are ignored.
 * Safe = every evaluated is canonical-aligned AND shares the same candleTime.
 * - Zero evaluated => safe=false (no evaluated markets available for cross-exchange aggregation)
 * - One evaluated  => safe = isCanonicalAligned(single) (horizon trivially same, but minExchanges is separate)
 *   Document: temporal alignment passing for 1 market does NOT imply minExchanges satisfied.
 */
export function checkCandleAlignment(
  results: MarketStrategyResult[],
  timeframe: SmcTimeframe,
): AlignmentCheck {
  const evaluated = results.filter(
    (r): r is EvaluatedMarket => r.status === "evaluated",
  );

  if (evaluated.length === 0) {
    return {
      aligned: false,
      safe: false,
      referenceCandleTime: null,
      details: [],
      offGrid: [],
      horizonMismatch: [],
      misaligned: [],
      alignedCount: 0,
      totalEvaluated: 0,
      reason: "no evaluated markets available for cross-exchange aggregation",
    };
  }

  const details: AlignmentDetail[] = evaluated.map((m) => {
    const aligned = isCanonicalAligned(m.candleTime, timeframe);
    const offset = canonicalOffsetMs(m.candleTime, timeframe);
    return {
      exchange: m.exchange,
      market: m.market,
      marketId: m.marketId,
      candleTime: m.candleTime,
      aligned,
      offsetMs: offset,
      utcHour: utcHour(m.candleTime),
    };
  });

  const offGrid = details.filter((d) => !d.aligned);
  const referenceCandleTime = details[0].candleTime;
  const refMs = referenceCandleTime.getTime();
  const horizonMismatch = details.filter(
    (d) => d.candleTime.getTime() !== refMs,
  );

  const safe = offGrid.length === 0 && horizonMismatch.length === 0;

  let reason: string | undefined;
  if (!safe) {
    const parts: string[] = [];
    if (offGrid.length > 0) {
      parts.push(
        `offGrid ${offGrid.length}/${details.length} markets for ${timeframe}: ` +
          offGrid
            .map(
              (d) =>
                `${d.exchange} openTime=${d.candleTime.toISOString()} UTC hour=${d.utcHour} offset=${d.offsetMs}ms (expected 0)`,
            )
            .join("; "),
      );
    }
    if (horizonMismatch.length > 0) {
      parts.push(
        `horizonMismatch ${horizonMismatch.length}/${details.length} markets for ${timeframe}: reference=${referenceCandleTime.toISOString()} mismatched ` +
          horizonMismatch
            .map(
              (d) =>
                `${d.exchange} ${d.candleTime.toISOString()} (delta=${d.candleTime.getTime() - refMs}ms)`,
            )
            .join("; "),
      );
    }
    reason = parts.join(" | ");
  }

  return {
    aligned: safe,
    safe,
    referenceCandleTime,
    details,
    offGrid,
    horizonMismatch,
    misaligned: offGrid,
    alignedCount: details.length - offGrid.length,
    totalEvaluated: details.length,
    reason,
  };
}

/**
 * Whether multi-exchange aggregation is safe for this check.
 * True only when canonical grid OK and all evaluated share same candleTime and at least one evaluated.
 * Note: one evaluated market may return safe=true (temporal), but aggregation layer must still
 * enforce minExchanges separately; safe=false for zero evaluated.
 */
export function canAggregateSafely(check: AlignmentCheck): boolean {
  return check.safe;
}

/**
 * Pure decision helper for tests/diag: whether to call aggregateAssetGroup.
 * Returns true only if safe; never aggregates on offGrid or horizonMismatch or no evaluated.
 */
export function shouldAggregateAssetGroup(check: AlignmentCheck): boolean {
  return canAggregateSafely(check);
}
