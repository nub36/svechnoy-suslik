/**
 * Phase 3E — Candle window alignment helper (read-only, pure).
 *
 * Detects cross-exchange misalignment for multi-exchange aggregation.
 * For 1d, BINGX openTime UTC 16 vs others UTC 00 are NOT the same daily window,
 * even though each is internally valid 24h bar.
 *
 * Generic guard: each evaluated market's latest CLOSED candle openTime
 * must be canonical-aligned to UTC grid for its timeframe
 * (openTime.getTime() % SMCTIMEFRAME_MS[tf] === 0).
 *
 * This is pure, no DB, no side effects.
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
 * Human-readable UTC hour for 1d alignment audit.
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
  aligned: boolean;
  reason?: string;
  details: AlignmentDetail[];
  misaligned: AlignmentDetail[];
  alignedCount: number;
  totalEvaluated: number;
};

/**
 * Check cross-exchange alignment for aggregation horizon.
 * Only evaluated markets are checked; filtered/cannot-evaluate are ignored.
 * Aligned = every evaluated market's candleTime is canonical-aligned.
 * If any misaligned, overall not aligned — aggregation must be refused/marked.
 *
 * For 1d with BINGX at UTC 16 vs others UTC 00, BINGX will be misaligned.
 * For 5m/15m/1h/4h where all exchanges are UTC-grid aligned, check passes.
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
      aligned: true, // vacuous — no evaluated to misalign, aggregation will be empty but not misaligned
      reason: "no evaluated markets — vacuous aligned",
      details: [],
      misaligned: [],
      alignedCount: 0,
      totalEvaluated: 0,
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

  const misaligned = details.filter((d) => !d.aligned);

  if (misaligned.length === 0) {
    return {
      aligned: true,
      details,
      misaligned: [],
      alignedCount: details.length,
      totalEvaluated: details.length,
    };
  }

  const reason =
    `misaligned ${misaligned.length}/${details.length} markets for ${timeframe}: ` +
    misaligned
      .map(
        (d) =>
          `${d.exchange} ${d.market} openTime=${d.candleTime.toISOString()} UTC hour=${d.utcHour} offset=${d.offsetMs}ms (expected 0 for ${timeframe})`,
      )
      .join("; ");

  return {
    aligned: false,
    reason,
    details,
    misaligned,
    alignedCount: details.length - misaligned.length,
    totalEvaluated: details.length,
  };
}

/**
 * Whether multi-exchange aggregation is safe for this check.
 * For diagnostic Phase3E, 1d with BINGX misaligned => refuse aggregation.
 * For 5m/15m/4h where all aligned, allow.
 */
export function canAggregateSafely(
  check: AlignmentCheck,
): boolean {
  return check.aligned;
}
