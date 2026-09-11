/**
 * Common CLOSED horizon selection for the Smart Money read runtime.
 *
 * PROBLEM (production, observed on BTC): the OHLCV worker ingests 5 exchanges
 * sequentially (25 tasks, ~15s, cadence 120000ms) and materializes `closed=true`
 * for a candle only when that market's own slot in the pass runs. Therefore the
 * DB's "latest CLOSED candle" per exchange is a function of that market's slot,
 * not of the canonical UTC grid. A concurrent Smart Money read then legitimately
 * sees e.g. BINANCE at T while BYBIT/GATE/KUCOIN/BINGX are already at T+5m, and
 * the strict alignment guard correctly refuses (MISALIGNED / cannot-aggregate)
 * for ~15 seconds every 5m. Safety was right; availability was needlessly lost.
 *
 * CONTRACT (Solution B, read-side, minimal, no migration):
 *   1. exchange eligibility            (smart-money-eligibility.ts, Option A)
 *   2. Strategy filters                (applySmartMoneyFilters — reused, not duplicated)
 *   3. latest COMMON CLOSED horizon H  (exact timestamp intersection over participants)
 *   4. freshness: relative skew between participants + absolute staleness vs wall clock
 *   5. truncate EACH participant to H  (CLOSED only, no candles after H)
 *   6. evaluate each market exactly at H
 *   7. strict alignment + anchor check still mandatory before aggregation
 *
 * PARTICIPANT SET (what may veto H):
 *   - A market excluded by exchange eligibility (BINGX for 1d) is not a participant
 *     and never influences H, denominator or freshness.
 *   - A market excluded by Strategy filters (top500Only / minimumQuoteVolume24h) is
 *     `filtered` — it is not a participant either: Strategy itself declared it
 *     out of scope, so it must not veto the asset's horizon.
 *   - A market that passed eligibility AND filters IS a participant. If it has no
 *     CLOSED data, no common horizon, or is beyond a freshness bound, the answer is
 *     an explicit unusable status (DATA_UNAVAILABLE / NO_COMMON_HORIZON / *_STALE),
 *     NEVER a silent success on the remaining markets. Insufficient history after
 *     truncation keeps the pre-existing per-market cannot-evaluate semantics
 *     (visible as skipped, not dropped).
 *
 * INVARIANTS: CLOSED-only, no-lookahead, deterministic, canonical UTC grid, never
 * aggregate mixed horizons, no silent stale fallback. `now` is always injected by
 * the caller so the pure layer never reads the wall clock itself.
 *
 * Pure: no DB, no Prisma, no side effects, no Signal, no exchange API.
 */

import {
  SMCTIMEFRAME_MS,
  type SmcRawCandle,
  type SmcTimeframe,
} from "../smc/types";
import {
  canAggregateSafely,
  checkCandleAlignment,
  isCanonicalAligned,
  type AlignmentCheck,
} from "./alignment";
import type { MarketStrategyResult } from "./runtime";

/** Fail-closed input contract for this layer (mirrors SmcInputError style). */
export class CommonHorizonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommonHorizonError";
  }
}

/**
 * RELATIVE skew bound. Max lag (in bars) between the newest participant horizon and
 * the selected common horizon. Preserved from the original fix (not weakened):
 * beyond it we refuse instead of aggregating on a horizon one market is far behind.
 */
export const COMMON_HORIZON_RELATIVE_MAX_LAG_BARS = 3;

/**
 * ABSOLUTE staleness bound vs the expected latest CLOSED bar on the current wall
 * clock. A relative bound alone is blind to UNIFORM staleness: if ingestion stalls,
 * all markets agree, lag is 0, and a naive reader would happily "aggregate" data
 * that is days old. One extra closed bar of tolerance covers exactly the pass
 * skew this fix exists for (a slow/late market), and nothing more.
 *
 * OPERATIONAL SAFETY POLICY — deliberately NOT a Strategy/Admin trading
 * parameter: it must not be tradeable away by editing Strategy JSON.
 */
export const COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS: Record<SmcTimeframe, number> =
  {
    "5m": 1,
    "15m": 1,
    "1h": 1,
    "4h": 1,
    "1d": 1,
  };

/**
 * Why a common horizon is usable or not. Operators must be able to tell
 * "no shared bar" apart from "shared bar is too old" and "a participant has no
 * data at all" — they need different remediation.
 */
export type CommonHorizonStatus =
  /** usable common horizon */
  | "ok"
  /** nothing left after eligibility + Strategy filters */
  | "no_participants"
  /** a participant passed eligibility+filters but has no canonical CLOSED candle */
  | "data_unavailable"
  /** every participant has CLOSED data, yet no timestamp exists in all of them */
  | "no_common_horizon"
  /** participants disagree more than the relative bound */
  | "relative_lag_stale"
  /** common horizon older than expected latest CLOSED + absolute bound */
  | "absolute_stale"
  /** common horizon newer than the expected latest CLOSED bar (impossible under honest CLOSED flags) */
  | "future_horizon";

/** Statuses that must prevent multi-exchange aggregation. */
export const COMMON_HORIZON_UNUSABLE_STATUSES: readonly CommonHorizonStatus[] = [
  "no_participants",
  "data_unavailable",
  "no_common_horizon",
  "relative_lag_stale",
  "absolute_stale",
  "future_horizon",
];

export type CommonHorizonMarket = {
  exchange: string;
  marketId: number;
  /** ASC, closed=true only (loader contract) */
  candles: SmcRawCandle[];
};

export type CommonHorizonSelection = {
  status: CommonHorizonStatus;
  /**
   * Latest timestamp present as canonical CLOSED at ALL participants, else null.
   * NOTE: also present on the *rejected* statuses (relative_lag_stale /
   * future_horizon / absolute_stale) — a horizon can be computed and still be
   * unusable; `status`/`usable` decide, this field is for diagnostics.
   */
  commonHorizon: Date | null;
  /** Newest canonical CLOSED horizon among participants. */
  newestHorizon: Date | null;
  /** Expected latest CLOSED openTime for `now` on the canonical UTC grid. */
  expectedLatestClosed: Date;
  /** Injected wall clock (echoed for deterministic diagnostics). */
  now: Date;
  /** relative: newestHorizon - commonHorizon (null when no common) */
  lagMs: number | null;
  lagBars: number | null;
  /** absolute: expectedLatestClosed - commonHorizon (may be negative → future_horizon) */
  absoluteLagMs: number | null;
  absoluteLagBars: number | null;
  relativeMaxLagBars: number;
  absoluteMaxLagBars: number;
  /** participants = eligibility-passing markets that are not Strategy-`filtered` */
  participantCount: number;
  /** participants vetoing the horizon because they have no usable CLOSED data */
  marketsWithoutData: Array<{ exchange: string; marketId: number }>;
  perMarketLatest: Array<{
    exchange: string;
    marketId: number;
    latest: Date | null;
    hasCommon: boolean;
  }>;
  /** Always non-empty: human-readable verdict for operator output/logs. */
  reason: string;
};

/**
 * Expected latest CLOSED candle openTime for a canonical UTC grid timeframe.
 *
 * A candle opening at k*D closes at (k+1)*D. Ingestion marks it
 * `closed = closeTime < now` with `closeTime = openTime + D - 1`, i.e. exactly
 * `openTime + D <= now`. So at `now === k*D` the candle opened at (k-1)*D is
 * ALREADY closed (boundary belongs to the just-closed bar), while the candle
 * opened at k*D is still open. Hence: floor(now / D) * D - D.
 *
 * Deliberately NOT based on the exchange-reported nullable `closeTime`.
 */
export function expectedLatestClosedOpenTime(
  now: Date,
  timeframe: SmcTimeframe
): Date {
  assertValidNow(now);
  const durationMs = SMCTIMEFRAME_MS[timeframe];
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new CommonHorizonError(
      `timeframe "${String(timeframe)}" не имеет канонической длительности`
    );
  }
  const floorMs = Math.floor(now.getTime() / durationMs) * durationMs;
  return new Date(floorMs - durationMs);
}

function assertValidNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new CommonHorizonError(
      "now: ожидается валидная Date (значение передаёт вызывающий код, а не этот модуль)"
    );
  }
}

function toBarCount(deltaMs: number, durationMs: number): number {
  // Оба конца лежат на canonical UTC grid ⇒ деление всегда точное;
  // Math.round только убирает риск накопления float-шума в будущем.
  return Math.round(deltaMs / durationMs);
}

/**
 * Select the latest common canonical CLOSED horizon over the participant set,
 * then validate freshness (relative skew + absolute staleness).
 *
 * Real intersection semantics: H is a timestamp that physically EXISTS as a
 * CLOSED grid-aligned candle in EVERY participant. It is NOT min(latest) —
 * min(latest) can name a bar that the other markets do not have at all when
 * their history contains a hole.
 */
export function selectCommonClosedHorizon(
  markets: CommonHorizonMarket[],
  timeframe: SmcTimeframe,
  options: {
    now: Date;
    relativeMaxLagBars?: number;
    absoluteMaxLagBars?: number;
  }
): CommonHorizonSelection {
  assertValidNow(options.now);

  const durationMs = SMCTIMEFRAME_MS[timeframe];
  const relativeMaxLagBars =
    options.relativeMaxLagBars ?? COMMON_HORIZON_RELATIVE_MAX_LAG_BARS;
  const absoluteMaxLagBars =
    options.absoluteMaxLagBars ?? COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS[timeframe];
  const expectedLatestClosed = expectedLatestClosedOpenTime(
    options.now,
    timeframe
  );

  const base = {
    now: options.now,
    expectedLatestClosed,
    relativeMaxLagBars,
    absoluteMaxLagBars,
    participantCount: markets.length,
    marketsWithoutData: [] as Array<{ exchange: string; marketId: number }>,
  };

  const fail = (
    status: CommonHorizonStatus,
    reason: string,
    extra: Partial<CommonHorizonSelection> = {}
  ): CommonHorizonSelection => ({
    ...base,
    status,
    reason,
    commonHorizon: null,
    newestHorizon: null,
    lagMs: null,
    lagBars: null,
    absoluteLagMs: null,
    absoluteLagBars: null,
    perMarketLatest: [],
    ...extra,
  });

  if (markets.length === 0) {
    return fail(
      "no_participants",
      "нет участников: все рынки отсечены exchange eligibility или Strategy filters"
    );
  }

  // Per-participant canonical CLOSED timestamp sets. `closed` and the canonical
  // grid are both required; a market whose only rows are off-grid has NO usable
  // data rather than "different data".
  const sets: Array<Set<number>> = [];
  const latestPerMarket: Array<{
    exchange: string;
    marketId: number;
    latest: Date | null;
  }> = [];
  const marketsWithoutData: Array<{ exchange: string; marketId: number }> = [];
  let newestMs: number | null = null;

  for (const m of markets) {
    const times = new Set<number>();
    let latest: Date | null = null;
    for (const c of m.candles) {
      if (c.closed !== true) continue;
      if (!isCanonicalAligned(c.openTime, timeframe)) continue;
      const ms = c.openTime.getTime();
      times.add(ms);
      if (latest === null || ms > latest.getTime()) latest = c.openTime;
    }
    if (times.size === 0) {
      marketsWithoutData.push({ exchange: m.exchange, marketId: m.marketId });
    }
    sets.push(times);
    latestPerMarket.push({
      exchange: m.exchange,
      marketId: m.marketId,
      latest,
    });
    if (latest !== null && (newestMs === null || latest.getTime() > newestMs)) {
      newestMs = latest.getTime();
    }
  }

  const newestHorizon = newestMs !== null ? new Date(newestMs) : null;
  const withLatest = {
    ...base,
    marketsWithoutData,
    newestHorizon,
    perMarketLatest: latestPerMarket.map((p) => ({
      ...p,
      hasCommon: false,
    })),
  };

  // A participant without usable data must NOT be silently dropped so that the
  // rest can reach minExchanges: that is a data-quality condition.
  if (marketsWithoutData.length > 0) {
    return fail(
      "data_unavailable",
      `DATA_UNAVAILABLE: у ${marketsWithoutData
        .map((m) => `${m.exchange}(id ${m.marketId})`)
        .join(", ")} нет ни одной canonical CLOSED свечи для ${timeframe} — ` +
        "участник отсечён не был (eligibility+filters пройдены), поэтому общий горизонт не выбирается молча",
      { ...withLatest, marketsWithoutData }
    );
  }

  // Exact intersection over ALL participants (order-independent by construction).
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
    return fail(
      "no_common_horizon",
      `NO_COMMON_HORIZON: ни один canonical CLOSED timestamp не присутствует у всех ${markets.length} участников ${timeframe} ` +
        `(latest: ${latestPerMarket
          .map((p) => `${p.exchange}=${p.latest?.toISOString() ?? "—"}`)
          .join(", ")})`,
      withLatest
    );
  }

  let commonMs = -Infinity;
  for (const t of intersection) {
    if (t > commonMs) commonMs = t;
  }
  const commonHorizon = new Date(commonMs);
  const perMarketLatest = latestPerMarket.map((p) => ({
    ...p,
    hasCommon: sets[latestPerMarket.indexOf(p)].has(commonMs),
  }));

  const decorate = (
    status: CommonHorizonStatus,
    reason: string,
    horizon: Date | null
  ): CommonHorizonSelection => {
    const lagMs = newestMs === null ? null : newestMs - commonMs;
    const absoluteLagMs = expectedLatestClosed.getTime() - commonMs;
    return {
      ...base,
      marketsWithoutData,
      status,
      reason,
      commonHorizon: horizon,
      newestHorizon,
      perMarketLatest,
      lagMs,
      lagBars: lagMs === null ? null : toBarCount(lagMs, durationMs),
      absoluteLagMs,
      absoluteLagBars: toBarCount(absoluteLagMs, durationMs),
    };
  };

  // Relative skew first: it names the inter-market disagreement, which is the
  // actionable diagnosis when some markets are fresh and one is behind.
  const lagBars = toBarCount(newestMs! - commonMs, durationMs);
  if (lagBars > relativeMaxLagBars) {
    return decorate(
      "relative_lag_stale",
      `RELATIVE_LAG_STALE: участники расходятся на ${lagBars} бар(ов) ` +
        `(newest ${newestHorizon?.toISOString()} vs common ${commonHorizon.toISOString()}) ` +
        `> bound ${relativeMaxLagBars} для ${timeframe} — агрегация запрещена`,
      commonHorizon
    );
  }

  const absoluteLagBars = toBarCount(
    expectedLatestClosed.getTime() - commonMs,
    durationMs
  );
  if (absoluteLagBars < 0) {
    return decorate(
      "future_horizon",
      `FUTURE_HORIZON: общий CLOSED горизонт ${commonHorizon.toISOString()} новее ожидаемого ` +
        `latest CLOSED ${expectedLatestClosed.toISOString()} для ${timeframe} — несогласованные CLOSED-данные, агрегация запрещена`,
      commonHorizon
    );
  }
  if (absoluteLagBars > absoluteMaxLagBars) {
    return decorate(
      "absolute_stale",
      `ABSOLUTE_STALE: общий горизонт ${commonHorizon.toISOString()} отстаёт на ${absoluteLagBars} ` +
        `бар(ов) от ожидаемого latest CLOSED ${expectedLatestClosed.toISOString()} ` +
        `> bound ${absoluteMaxLagBars} для ${timeframe} (now=${options.now.toISOString()}) — ` +
        "равномерно устаревшие данные, тихий успех на них недопустим",
      commonHorizon
    );
  }

  return decorate(
    "ok",
    `OK: общий CLOSED горизонт ${commonHorizon.toISOString()} у всех ${markets.length} участников ${timeframe} ` +
      `(relative lag ${lagBars}/${relativeMaxLagBars}, absolute lag ${absoluteLagBars}/${absoluteMaxLagBars} ` +
      `от ожидаемого ${expectedLatestClosed.toISOString()})`
    ,
    commonHorizon
  );
}

/**
 * Truncate a market's candles to the common horizon (inclusive), CLOSED only.
 * The CLOSED re-filter keeps this helper safe for any caller, not only the
 * `where { closed: true }` loader.
 */
export function truncateCandlesToHorizon(
  candles: SmcRawCandle[],
  commonHorizon: Date
): SmcRawCandle[] {
  if (!(commonHorizon instanceof Date) || !Number.isFinite(commonHorizon.getTime())) {
    throw new CommonHorizonError("commonHorizon: ожидается валидная Date");
  }
  const ms = commonHorizon.getTime();
  return candles.filter(
    (c) => c.closed === true && c.openTime.getTime() <= ms
  );
}

/**
 * Anchor check: after truncation, EVERY evaluated market must report exactly H.
 *
 * This is not redundant with checkCandleAlignment: with a single evaluated
 * market the alignment guard is trivially safe (one horizon cannot disagree
 * with itself), yet its result may still be anchored elsewhere. It also keeps
 * protecting the invariant if truncation/anchoring is ever refactored.
 */
export function assertEvaluatedAtHorizon(
  results: MarketStrategyResult[],
  horizon: Date | null
): { ok: boolean; anomalies: string[] } {
  if (horizon === null) {
    const nonEmpty = results.filter((r) => r.status === "evaluated");
    return {
      ok: nonEmpty.length === 0,
      anomalies:
        nonEmpty.length === 0
          ? []
          : nonEmpty.map(
              (r) =>
                `${r.exchange}: evaluated при отсутствии общего горизонта`
            ),
    };
  }
  const ms = horizon.getTime();
  const anomalies: string[] = [];
  for (const r of results) {
    if (r.status !== "evaluated") continue;
    if (r.candleTime.getTime() !== ms) {
      anomalies.push(
        `${r.exchange} (market ${r.marketId}): candleTime=${r.candleTime.toISOString()} ≠ общий горизонт ${horizon.toISOString()}`
      );
    }
  }
  return { ok: anomalies.length === 0, anomalies };
}

export type AggregationGateDecision = {
  allowed: boolean;
  refusalReasons: string[];
  /** Strict cross-exchange alignment check that gated this decision. */
  alignment: AlignmentCheck;
  /** Anchor check result (every evaluated market at H). */
  anchor: { ok: boolean; anomalies: string[] };
};

/**
 * SINGLE mandatory gate for multi-exchange aggregation. Aggregation is allowed
 * only when ALL of these hold:
 *   - a common horizon was selected (status ok), and
 *   - every evaluated result is anchored at that horizon, and
 *   - the existing strict alignment guard passes.
 *
 * `checkCandleAlignment` / `canAggregateSafely` are NOT weakened and NOT
 * optional here — they stay in the path by construction.
 */
export function decideAggregationAtCommonHorizon(input: {
  selection: CommonHorizonSelection;
  results: MarketStrategyResult[];
  timeframe: SmcTimeframe;
}): AggregationGateDecision {
  const { selection, results, timeframe } = input;
  const refusalReasons: string[] = [];

  if (selection.status !== "ok" || selection.commonHorizon === null) {
    refusalReasons.push(`common horizon: ${selection.reason}`);
  }

  const anchor = assertEvaluatedAtHorizon(results, selection.commonHorizon);
  if (!anchor.ok) {
    refusalReasons.push(
      `anchor: ${anchor.anomalies.join("; ")} — рыночный результат заякорен не на общем горизонте`
    );
  }

  const alignment = checkCandleAlignment(results, timeframe);
  if (!canAggregateSafely(alignment)) {
    refusalReasons.push(
      `alignment: ${alignment.reason ?? "unsafe alignment (offGrid/horizonMismatch/no evaluated)"}`
    );
  }

  return {
    allowed: refusalReasons.length === 0,
    refusalReasons,
    alignment,
    anchor,
  };
}

/**
 * Operator-facing report. Explains the four sets explicitly, because "why is
 * there no signal?" depends on knowing who was eligible, who was filtered, who
 * was a participant and who vetoed the horizon.
 */
export function formatCommonHorizonReport(input: {
  selection: CommonHorizonSelection;
  timeframe: SmcTimeframe;
  /** all markets considered for this asset×TF before eligibility */
  marketCount: number;
  /** markets kept by exchange eligibility */
  exchangeEligibleCount: number;
  /** exchanges dropped by eligibility policy */
  exchangeExcluded: string[];
  /** eligible markets dropped by Strategy filters */
  filteredCount: number;
}): string[] {
  const {
    selection,
    timeframe,
    marketCount,
    exchangeEligibleCount,
    exchangeExcluded,
    filteredCount,
  } = input;
  const lines: string[] = [];

  lines.push(
    `обменное eligibility: ${exchangeEligibleCount}/${marketCount} eligible` +
      (exchangeExcluded.length > 0
        ? `, исключено eligibility-политикой: ${exchangeExcluded.join(", ")} (Smart Money 1d aggregation policy)`
        : ` (BINGX eligible на 5m/15m/1h/4h)`)
  );
  lines.push(
    `Strategy filters: filtered ${filteredCount} — не влияет на выбор горизонта (рынок вне выборки стратегии)`
  );
  lines.push(
    `участники common horizon: ${selection.participantCount}` +
      (selection.marketsWithoutData.length > 0
        ? `, без CLOSED данных: ${selection.marketsWithoutData
            .map((m) => m.exchange)
            .join(", ")}`
        : "")
  );
  lines.push(
    `ожидаемый latest CLOSED (wall clock ${selection.now.toISOString()}): ${selection.expectedLatestClosed.toISOString()}`
  );

  for (const p of selection.perMarketLatest) {
    lines.push(
      `  ${p.exchange} marketId=${p.marketId} latest CLOSED=${p.latest?.toISOString() ?? "нет данных"}${
        selection.commonHorizon
          ? p.hasCommon
            ? " has-common"
            : " MISSING-COMMON"
          : ""
      }`
    );
  }

  if (selection.status === "ok" && selection.commonHorizon !== null) {
    lines.push(
      `✓ common horizon: ${selection.commonHorizon.toISOString()} ` +
        `(relative lag ${selection.lagBars}/${selection.relativeMaxLagBars} бар, ` +
        `absolute lag ${selection.absoluteLagBars}/${selection.absoluteMaxLagBars} бар от ожидаемого)`
    );
  } else {
    // Отбракованный горизонт может быть вычислен — показываем его явно, чтобы
    // «0 eligible» и «горизонта нет» не выглядели одинаково.
    lines.push(
      `✗ common horizon недоступен [${selection.status.toUpperCase()}]` +
        (selection.commonHorizon
          ? ` (вычисленный общий бар ${selection.commonHorizon.toISOString()} отбракован)`
          : "") +
        `: ${selection.reason}`
    );
  }

  return lines;
}
