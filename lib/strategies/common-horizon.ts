/**
 * Common CLOSED horizon selection for Smart Money read runtime (FIX for transient ingestion race).
 *
 * Problem: sequential ingestion (25 tasks, ~15 sec) + concurrent SMC read causes transient
 * horizonMismatch: during a pass, one market's latest CLOSED is T while others are T+5m,
 * leading to strict alignment fail (cannot-aggregate) for ~15 sec, then ALIGNED after pass.
 * This is visibility race, not exchange boundary bug. We must minimize transient
 * cannot-evaluate windows while keeping CLOSED-only, no-lookahead, strict identical-horizon.
 *
 * Solution B (chosen, minimal, no schema migration): Smart Money read selects
 * latest COMMON CLOSED horizon that is present at ALL eligible markets (exact timestamp
 * intersection, CLOSED, canonical UTC grid). Per-exchange evaluation then uses
 * candles up to EXACT common horizon (truncate, no future candles), not newest per market.
 * If common horizon is stale beyond freshness bound or no common exists → cannot-evaluate.
 * For 1d, eligibility excludes BINGX BEFORE common selection (common among 4 eligible).
 *
 * This file is pure, no DB, no side effects, deterministic, no lookahead.
 */

import { SMCTIMEFRAME_MS, type SmcTimeframe, type SmcRawCandle } from "../smc/types";
import { isCanonicalAligned } from "./alignment";

/**
 * Freshness bound: max lag (in bars) between newest available horizon (max latest per market)
 * and selected common horizon before we consider common stale and fail to cannot-evaluate.
 * Prevents silent fallback too far back (e.g., common 1h behind newest due to missing data).
 *
 * For 5m: 3 bars = 15m, for 1h: 3h, for 1d: 3d. Chosen conservatively; matches typical
 * SMC needs (needs history, but not too stale). If common lag > 3 bars, we treat as stale.
 */
export const COMMON_HORIZON_MAX_LAG_BARS = 3;

export type CommonHorizonSelection = {
  /** Latest timestamp present as CLOSED at ALL eligible markets (or null if none) */
  commonHorizon: Date | null;
  /** Newest horizon among eligible markets (max latest per market) */
  newestHorizon: Date | null;
  /** Lag in ms between newest and common (null if no common) */
  lagMs: number | null;
  /** Lag in bars (lagMs / tfMs) */
  lagBars: number | null;
  /** Reason when common is null or stale */
  reason?: string;
  /** All eligible markets' latest times for diagnostics */
  perMarketLatest: Array<{ exchange: string; marketId: number; latest: Date | null }>;
  /** Common horizon diagnostics: count of markets that have it */
  eligibleCount: number;
};

export type MarketCandles = {
  exchange: string;
  marketId: number;
  candles: SmcRawCandle[]; // ASC, closed=true only, already filtered
};

/**
 * Select latest common CLOSED horizon.
 *
 * @param markets - eligible markets with their CLOSED candles (ASC). Each candles array
 *   should already be filtered to closed=true and sorted ASC. We consider only
 *   openTime where closed=true and isCanonicalAligned (grid). For 1d, caller must have
 *   already filtered eligible markets (BINGX excluded).
 * @param timeframe - SMC timeframe
 * @param options.freshnessBars - max allowed lag bars before stale (default 3)
 *
 * Returns commonHorizon = max timestamp that is present in ALL markets' sets,
 * or null if no common or stale beyond bound.
 */
export function selectCommonClosedHorizon(
  markets: MarketCandles[],
  timeframe: SmcTimeframe,
  options?: { freshnessBars?: number }
): CommonHorizonSelection {
  const freshnessBars = options?.freshnessBars ?? COMMON_HORIZON_MAX_LAG_BARS;
  const tfMs = SMCTIMEFRAME_MS[timeframe];

  if (markets.length === 0) {
    return {
      commonHorizon: null,
      newestHorizon: null,
      lagMs: null,
      lagBars: null,
      reason: "no eligible markets for common horizon",
      perMarketLatest: [],
      eligibleCount: 0,
    };
  }

  // Build per-market latest and sets
  const perMarketLatest: Array<{ exchange: string; marketId: number; latest: Date | null }> = [];
  const sets: Array<Set<number>> = [];
  let newestMs: number | null = null;

  for (const m of markets) {
    // Filter to canonical aligned CLOSED candles only (defensive; loader already closed=true)
    const times: number[] = [];
    let latest: Date | null = null;
    for (const c of m.candles) {
      if (!c.closed) continue;
      // Only consider canonical grid times
      if (!isCanonicalAligned(c.openTime, timeframe)) continue;
      const ms = c.openTime.getTime();
      times.push(ms);
      if (!latest || ms > latest.getTime()) latest = c.openTime;
    }
    perMarketLatest.push({ exchange: m.exchange, marketId: m.marketId, latest });
    if (latest && (newestMs === null || latest.getTime() > newestMs)) {
      newestMs = latest.getTime();
    }
    sets.push(new Set(times));
  }

  const newestHorizon = newestMs !== null ? new Date(newestMs) : null;

  if (sets.length === 0) {
    return {
      commonHorizon: null,
      newestHorizon,
      lagMs: null,
      lagBars: null,
      reason: "no candle sets",
      perMarketLatest,
      eligibleCount: markets.length,
    };
  }

  // Intersection: start with first set, intersect with others
  let intersection = new Set<number>(sets[0]);
  for (let i = 1; i < sets.length; i++) {
    const next = new Set<number>();
    for (const t of intersection) {
      if (sets[i].has(t)) next.add(t);
    }
    intersection = next;
    if (intersection.size === 0) break;
  }

  if (intersection.size === 0) {
    return {
      commonHorizon: null,
      newestHorizon,
      lagMs: null,
      lagBars: null,
      reason: "no common CLOSED horizon across all eligible markets",
      perMarketLatest,
      eligibleCount: markets.length,
    };
  }

  // Latest common = max in intersection
  let commonMs = -Infinity;
  for (const t of intersection) {
    if (t > commonMs) commonMs = t;
  }
  const commonHorizon = new Date(commonMs);

  // Freshness check: lag between newest and common must be within bound
  if (newestMs !== null) {
    const lagMs = newestMs - commonMs;
    const lagBars = Math.round(lagMs / tfMs); // exact multiple because canonical grid
    if (lagBars > freshnessBars) {
      return {
        commonHorizon: null,
        newestHorizon,
        lagMs,
        lagBars,
        reason: `stale common horizon: lag ${lagBars} bars (${lagMs}ms) > freshness bound ${freshnessBars} bars for ${timeframe} (common ${commonHorizon.toISOString()}, newest ${newestHorizon?.toISOString()})`,
        perMarketLatest,
        eligibleCount: markets.length,
      };
    }
    return {
      commonHorizon,
      newestHorizon,
      lagMs,
      lagBars,
      reason: lagBars > 0 ? `common lag ${lagBars} bar(s) behind newest` : undefined,
      perMarketLatest,
      eligibleCount: markets.length,
    };
  }

  return {
    commonHorizon,
    newestHorizon,
    lagMs: 0,
    lagBars: 0,
    perMarketLatest,
    eligibleCount: markets.length,
  };
}

/**
 * Truncate candles to horizon (inclusive).
 * Returns new array with only candles where openTime <= commonHorizon.
 * Preserves ASC order, deterministic, no-lookahead (excludes future candles after horizon).
 */
export function truncateCandlesToHorizon(
  candles: SmcRawCandle[],
  commonHorizon: Date
): SmcRawCandle[] {
  const ms = commonHorizon.getTime();
  // Since ASC, we can find last index where openTime <= ms
  // Simple filter is deterministic and pure
  return candles.filter((c) => c.openTime.getTime() <= ms);
}

/**
 * Helper for diagnostics: returns per-market latest before truncation and whether it has common.
 */
export function commonHorizonDiagnostics(
  markets: MarketCandles[],
  timeframe: SmcTimeframe,
  selection: CommonHorizonSelection
): string[] {
  const lines: string[] = [];
  if (selection.commonHorizon) {
    lines.push(
      `common horizon selected: ${selection.commonHorizon.toISOString()} (lag ${selection.lagBars ?? 0} bar(s) vs newest ${selection.newestHorizon?.toISOString() ?? "—"})`
    );
  } else {
    lines.push(
      `common horizon: none — ${selection.reason ?? "unknown"} (newest ${selection.newestHorizon?.toISOString() ?? "—"})`
    );
  }
  for (const p of selection.perMarketLatest) {
    const hasCommon =
      selection.commonHorizon &&
      markets
        .find((m) => m.marketId === p.marketId)
        ?.candles.some((c) => c.openTime.getTime() === selection.commonHorizon!.getTime());
    lines.push(
      `  ${p.exchange} marketId=${p.marketId} latest=${p.latest?.toISOString() ?? "none"} ${hasCommon ? "has-common" : "missing-common"}`
    );
  }
  return lines;
}
