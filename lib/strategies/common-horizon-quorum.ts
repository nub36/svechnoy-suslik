/**
 * Common Horizon QUORUM policy — alternative to STRICT.
 *
 * STRICT (existing):
 *   All eligible participants must share a common CLOSED horizon.
 *   One lagging exchange can rollback entire evaluation to T-1 or refuse (relative_lag_stale).
 *   Causal-safe but delayed, availability suffers.
 *
 * QUORUM (proposed for production Smart Money):
 *   1. Determine expected latest CLOSED T from wall clock (expectedLatestClosedOpenTime).
 *   2. Fresh = participants whose latest CLOSED == T and who have T in their history.
 *   3. Stale/lagging/missing = SKIPPED (not veto).
 *   4. If freshParticipants >= minExchanges, aggregation allowed strictly on T.
 *   5. Subset determined ONLY by availability/freshness BEFORE evaluateSmc, never by score/direction.
 *
 * This avoids selection bias: we never exclude because NEUTRAL or low score.
 * Only objective reasons: BINGX 1d unsupported, missing CLOSED at T, stale, future/off-grid, filtered, insufficient history.
 *
 * Causal model:
 *   - expectedLatestClosed = floor(now / D) * D - D  (same as existing)
 *   - T is canonical UTC grid, deterministic from now, not from data.
 *   - Freshness check is absolute: latest == T.
 *   - No relative lag bound needed among fresh (all same T), but we still check absolute staleness (T vs expected).
 *   - Future detection: if common would be > expected, future_horizon.
 *
 * Pure, no DB, no side effects.
 */

import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../smc/types";
import { expectedLatestClosedOpenTime } from "./common-horizon";
import { isCanonicalAligned } from "./alignment";
import type { CommonHorizonMarket, CommonHorizonSelection, CommonHorizonStatus } from "./common-horizon";

export type QuorumStatus =
  | "ok"
  | "quorum_not_met"
  | "no_participants"
  | "data_unavailable"
  | "future_horizon"
  | "absolute_stale";

export const QUORUM_UNUSABLE_STATUSES: readonly QuorumStatus[] = [
  "quorum_not_met",
  "no_participants",
  "data_unavailable",
  "future_horizon",
  "absolute_stale",
];

export type QuorumMarketInfo = {
  exchange: string;
  marketId: number;
  latest: Date | null;
  hasExpected: boolean;
  isFresh: boolean;
  reason: string;
};

export type QuorumSelection = {
  status: QuorumStatus;
  commonHorizon: Date | null; // = expected when ok
  expectedLatestClosed: Date;
  now: Date;
  participantCount: number; // total considered
  freshCount: number;
  staleCount: number;
  freshMarkets: QuorumMarketInfo[];
  staleMarkets: QuorumMarketInfo[];
  marketsWithoutData: Array<{ exchange: string; marketId: number }>;
  perMarketLatest: Array<{ exchange: string; marketId: number; latest: Date | null; hasCommon: boolean }>;
  reason: string;
  // For compatibility with CommonHorizonSelection reporting
  lagBars: number | null;
  absoluteLagBars: number | null;
};

function toBarCount(deltaMs: number, durationMs: number): number {
  return Math.round(deltaMs / durationMs);
}

export function selectQuorumClosedHorizon(
  markets: CommonHorizonMarket[],
  timeframe: SmcTimeframe,
  options: { now: Date; minExchanges: number }
): QuorumSelection {
  const { now, minExchanges } = options;
  const durationMs = SMCTIMEFRAME_MS[timeframe];
  const expectedLatestClosed = expectedLatestClosedOpenTime(now, timeframe);

  const freshMarkets: QuorumMarketInfo[] = [];
  const staleMarkets: QuorumMarketInfo[] = [];
  const marketsWithoutData: Array<{ exchange: string; marketId: number }> = [];
  const perMarketLatest: Array<{ exchange: string; marketId: number; latest: Date | null; hasCommon: boolean }> = [];

  let hasFuture = false;

  for (const m of markets) {
    let latest: Date | null = null;
    const times = new Set<number>();
    for (const c of m.candles) {
      if (c.closed !== true) continue;
      if (!isCanonicalAligned(c.openTime, timeframe)) continue;
      const ms = c.openTime.getTime();
      times.add(ms);
      if (latest === null || ms > latest.getTime()) latest = c.openTime;
    }

    if (times.size === 0) {
      marketsWithoutData.push({ exchange: m.exchange, marketId: m.marketId });
      perMarketLatest.push({ exchange: m.exchange, marketId: m.marketId, latest: null, hasCommon: false });
      staleMarkets.push({
        exchange: m.exchange,
        marketId: m.marketId,
        latest: null,
        hasExpected: false,
        isFresh: false,
        reason: "no CLOSED canonical data",
      });
      continue;
    }

    const hasExpected = times.has(expectedLatestClosed.getTime());
    const isFresh = latest !== null && latest.getTime() === expectedLatestClosed.getTime() && hasExpected;

    // Future detection: if latest > expected, it's ahead of wall clock
    if (latest && latest.getTime() > expectedLatestClosed.getTime()) {
      hasFuture = true;
    }

    perMarketLatest.push({
      exchange: m.exchange,
      marketId: m.marketId,
      latest,
      hasCommon: hasExpected,
    });

    if (isFresh) {
      freshMarkets.push({
        exchange: m.exchange,
        marketId: m.marketId,
        latest,
        hasExpected,
        isFresh: true,
        reason: `fresh at expected ${expectedLatestClosed.toISOString()}`,
      });
    } else {
      const lag = latest ? toBarCount(expectedLatestClosed.getTime() - latest.getTime(), durationMs) : null;
      staleMarkets.push({
        exchange: m.exchange,
        marketId: m.marketId,
        latest,
        hasExpected,
        isFresh: false,
        reason: latest
          ? `stale: latest ${latest.toISOString()} vs expected ${expectedLatestClosed.toISOString()} lag ${lag} bars, hasExpected=${hasExpected}`
          : "no latest",
      });
    }
  }

  const base = {
    expectedLatestClosed,
    now,
    participantCount: markets.length,
    marketsWithoutData,
    perMarketLatest,
  };

  if (markets.length === 0) {
    return {
      ...base,
      status: "no_participants",
      commonHorizon: null,
      freshCount: 0,
      staleCount: 0,
      freshMarkets: [],
      staleMarkets: [],
      reason: "нет участников: все рынки отсечены eligibility или filters",
      lagBars: null,
      absoluteLagBars: null,
    };
  }

  if (hasFuture) {
    // If any fresh market is future relative to expected, treat as future_horizon
    // But in QUORUM, future markets are stale, not fresh, unless all are future
    const allFuture = freshMarkets.length === 0 && markets.every((m) => {
      const latest = perMarketLatest.find((p) => p.marketId === m.marketId)?.latest;
      return latest && latest.getTime() > expectedLatestClosed.getTime();
    });
    if (allFuture) {
      return {
        ...base,
        status: "future_horizon",
        commonHorizon: null,
        freshCount: 0,
        staleCount: staleMarkets.length,
        freshMarkets: [],
        staleMarkets,
        reason: `FUTURE_HORIZON: все участники новее ожидаемого latest CLOSED ${expectedLatestClosed.toISOString()}`,
        lagBars: null,
        absoluteLagBars: -1,
      };
    }
  }

  if (freshMarkets.length === 0 && marketsWithoutData.length === markets.length) {
    return {
      ...base,
      status: "data_unavailable",
      commonHorizon: null,
      freshCount: 0,
      staleCount: staleMarkets.length,
      freshMarkets: [],
      staleMarkets,
      reason: `DATA_UNAVAILABLE: ни у одного участника нет CLOSED данных для ${timeframe}`,
      lagBars: null,
      absoluteLagBars: null,
    };
  }

  if (freshMarkets.length < minExchanges) {
    return {
      ...base,
      status: "quorum_not_met",
      commonHorizon: null,
      freshCount: freshMarkets.length,
      staleCount: staleMarkets.length,
      freshMarkets,
      staleMarkets,
      reason: `QUORUM_NOT_MET: свежих участников ${freshMarkets.length} < minExchanges ${minExchanges} на ожидаемом горизонте ${expectedLatestClosed.toISOString()} (всего ${markets.length}, stale ${staleMarkets.length})`,
      lagBars: null,
      absoluteLagBars: null,
    };
  }

  // OK — quorum met, common horizon is expected
  return {
    ...base,
    status: "ok",
    commonHorizon: expectedLatestClosed,
    freshCount: freshMarkets.length,
    staleCount: staleMarkets.length,
    freshMarkets,
    staleMarkets,
    reason: `OK QUORUM: общий CLOSED горизонт ${expectedLatestClosed.toISOString()} у ${freshMarkets.length}/${markets.length} свежих участников (minExchanges ${minExchanges}), stale ${staleMarkets.length} пропущены`,
    lagBars: 0,
    absoluteLagBars: 0,
  };
}

/**
 * Compare STRICT vs QUORUM for documentation/tests
 */
export function comparePolicies(
  markets: CommonHorizonMarket[],
  timeframe: SmcTimeframe,
  now: Date,
  minExchanges: number
): {
  strict: CommonHorizonSelection;
  quorum: QuorumSelection;
} {
  // Import dynamically to avoid circular
  const { selectCommonClosedHorizon } = require("./common-horizon") as {
    selectCommonClosedHorizon: typeof import("./common-horizon").selectCommonClosedHorizon;
  };
  const strict = selectCommonClosedHorizon(markets, timeframe, { now });
  const quorum = selectQuorumClosedHorizon(markets, timeframe, { now, minExchanges });
  return { strict, quorum };
}
