/**
 * Historical Data Plane — Phase A — Real read-only PostgreSQL historical data access on top of P2-B.
 *
 * Требования:
 * - SELECT-only behavior (via BacktestDataDepsV2 + read-only-sql guard)
 * - Dependency-injected executor, no direct secret handling
 * - No writes, no migrations, no workers
 * - Fetch market identity, exchange, asset, timeframe, CLOSED candles, openTime, OHLCV, createdAt, updatedAt where useful
 * - Strictly validate market echo, timeframe, requested range, closed=true, ASC ordering, duplicates, canonical grid, off-grid rows, provider over-return, pagination progress, maxRows, maxPages
 * - Use accepted P2-B canonical coverage semantics
 * - Report requested range, effective canonical range, expected slots, available slots, coverage ratio, leading missing, internal missing, trailing missing, duplicates, off-grid bars, earliest/latest, common timestamps, common contiguous ranges, participant feasibility, createdAt/updatedAt diagnostics, eligibility limitations
 * - Do NOT calculate signals or PnL in this module
 */

import { deepFreeze } from "./immutable";
import {
  fetchCandlesPaginatedV2,
  type BacktestDataDepsV2,
  type BacktestMarketRow,
  type BacktestAssetRow,
  MAX_PAGE_SIZE,
  DEFAULT_MAX_PAGES,
  DEFAULT_MAX_ROWS,
} from "./data-source";
import type { BacktestCandleRow } from "./adapter";
import {
  computeMarketCoverage,
  aggregateCoverage,
  type MarketCoverage,
  type AggregatedCoverage,
} from "./coverage";
import {
  findCommonTimestamps,
  findCommonContiguousIntervals,
  findContiguousIntervals,
  type ContiguousRange,
} from "./intervals";
import {
  detectDuplicates,
  checkOrdering,
  checkGrid,
  analyzeMarketAnomalies,
  type MarketAnomalies,
} from "./gaps";
import {
  getTimeframeMs,
  canonicalWindow,
  formatIsoUtc,
  utcDateFromMs,
  type CanonicalWindow,
} from "./timeframe";
import { isSmartMoneyExchangeEligible, ELIGIBLE_EXCHANGES_BY_TF } from "../strategies/smart-money-eligibility";
import {
  buildHistoricalEligibilityDiagnostics,
  type HistoricalEligibilityDiagnostics,
  type EligibilityMethodology,
} from "./historical-eligibility";
import {
  computeOhlcvProvenanceDiagnostics,
  type CandleProvenanceRow,
  type OhlcvProvenanceDiagnostics,
} from "./ohlcv-provenance";

export type HistoricalDataPlaneRequest = {
  readonly assetSymbol: string;
  readonly timeframe: string;
  readonly from: Date;
  readonly to: Date;
  readonly markets: readonly BacktestMarketRow[];
  readonly deps: BacktestDataDepsV2;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxRows?: number;
  readonly isSmartMoneyRunner?: boolean;
  readonly eligibilityMethodology?: EligibilityMethodology | null;
  /** Optional extended rows with createdAt/updatedAt for provenance (if deps provides them) */
  readonly provenanceRows?: readonly CandleProvenanceRow[];
};

export type MarketHistoricalResult = {
  readonly market: BacktestMarketRow;
  readonly coverage: MarketCoverage;
  readonly barsCount: number;
  readonly earliest: string | null;
  readonly latest: string | null;
  readonly duplicates: number;
  readonly offGrid: number;
  readonly anomalies: MarketAnomalies;
  readonly contiguousRanges: readonly ContiguousRange[];
  readonly isEligible: boolean;
  readonly eligibilityReason: string | null;
};

export type HistoricalDataPlaneReport = {
  readonly assetSymbol: string;
  readonly timeframe: string;
  readonly timeframeMs: number | null;
  readonly requestedRange: { readonly from: string; readonly to: string };
  readonly effectiveCanonicalRange: {
    readonly from: string;
    readonly to: string;
    readonly expectedSlots: number;
    readonly isAligned: boolean;
    readonly canonicalized: boolean;
  } | null;
  readonly marketsCount: number;
  readonly eligibleMarketsCount: number;
  readonly ineligibleMarkets: readonly { marketId: number; exchange: string; reason: string }[];
  readonly totalReturned: number;
  readonly totalDistinct: number;
  readonly overallCoverageRatio: number | null;
  readonly aggregatedCoverage: AggregatedCoverage;
  readonly marketResults: readonly MarketHistoricalResult[];
  readonly commonTimestamps: readonly number[];
  readonly commonContiguousRanges: readonly ContiguousRange[];
  readonly participantFeasibility: {
    readonly minMarkets: number;
    readonly hasEnoughEligible: boolean;
    readonly commonTimestampsCount: number;
    readonly commonContiguousRangesCount: number;
  };
  readonly provenanceDiagnostics: OhlcvProvenanceDiagnostics | null;
  readonly eligibilityDiagnostics: HistoricalEligibilityDiagnostics;
  readonly warnings: readonly string[];
  readonly readOnly: true;
  readonly noPnl: true;
};

function toIso(d: Date): string {
  return d.toISOString();
}

function isValidDate(d: unknown): d is Date {
  return d instanceof Date && Number.isFinite(d.getTime());
}

export async function fetchHistoricalDataPlane(
  req: HistoricalDataPlaneRequest
): Promise<HistoricalDataPlaneReport> {
  // Validate inputs fail-closed
  if (!isValidDate(req.from) || !isValidDate(req.to)) {
    throw new Error("fetchHistoricalDataPlane: from/to must be valid Date");
  }
  if (req.from.getTime() >= req.to.getTime()) {
    throw new Error("fetchHistoricalDataPlane: from must be < to");
  }
  if (typeof req.assetSymbol !== "string" || req.assetSymbol.trim().length === 0) {
    throw new Error("fetchHistoricalDataPlane: assetSymbol must be non-empty string");
  }
  if (typeof req.timeframe !== "string" || req.timeframe.trim().length === 0) {
    throw new Error("fetchHistoricalDataPlane: timeframe must be non-empty string");
  }

  const timeframeMs = getTimeframeMs(req.timeframe);
  const warnings: string[] = [];

  let canonical: CanonicalWindow | null = null;
  let effectiveCanonicalRange: HistoricalDataPlaneReport["effectiveCanonicalRange"] = null;

  if (timeframeMs !== null) {
    try {
      canonical = canonicalWindow(req.from.getTime(), req.to.getTime(), timeframeMs);
      effectiveCanonicalRange = Object.freeze({
        from: formatIsoUtc(canonical.effectiveFromMs),
        to: formatIsoUtc(canonical.effectiveToMs),
        expectedSlots: canonical.expectedCanonicalSlots,
        isAligned: canonical.isAligned,
        canonicalized: canonical.canonicalized,
      });
      if (canonical.canonicalized) {
        warnings.push(
          `Requested range not on canonical ${req.timeframe} grid: effective window ${effectiveCanonicalRange.from} -> ${effectiveCanonicalRange.to} (expected slots ${canonical.expectedCanonicalSlots}) — coverage is canonical-grid based`
        );
      }
    } catch (e) {
      // Unknown or zero slots -> fail-closed for historical plane? We report null effective range but continue with coverage that will fail-closed internally
      warnings.push(`Canonical window error: ${(e as Error).message}`);
    }
  } else {
    warnings.push(`Unknown timeframe ${req.timeframe} — coverage will be reported as explicit invalid, never healthy`);
  }

  const pageSize = req.pageSize ?? 1000;
  const maxPages = req.maxPages ?? DEFAULT_MAX_PAGES;
  const maxRows = req.maxRows ?? DEFAULT_MAX_ROWS;

  if (!Number.isInteger(pageSize) || pageSize <= 0 || pageSize > MAX_PAGE_SIZE) {
    throw new Error(`fetchHistoricalDataPlane: pageSize must be integer 1..${MAX_PAGE_SIZE}`);
  }
  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error("fetchHistoricalDataPlane: maxPages must be integer >0");
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new Error("fetchHistoricalDataPlane: maxRows must be integer >0");
  }

  const isSmartMoney = req.isSmartMoneyRunner === true;

  // Eligibility partition
  const eligibleMarkets: BacktestMarketRow[] = [];
  const ineligibleMarkets: { marketId: number; exchange: string; reason: string }[] = [];

  for (const m of req.markets) {
    if (isSmartMoney) {
      const eligible = isSmartMoneyExchangeEligible(m.exchange, req.timeframe);
      if (eligible) {
        eligibleMarkets.push(m);
      } else {
        const reason =
          m.exchange === "BINGX" && req.timeframe === "1d"
            ? "BINGX excluded for 1d in Smart Money (off-grid 16:00 UTC)"
            : `Exchange ${m.exchange} not eligible for ${req.timeframe} in Smart Money (fail-closed unknown)`;
        ineligibleMarkets.push({ marketId: m.id, exchange: m.exchange, reason });
      }
    } else {
      eligibleMarkets.push(m);
    }
  }

  if (isSmartMoney && ineligibleMarkets.length > 0) {
    warnings.push(
      `Smart Money ${req.timeframe}: excluded ${ineligibleMarkets.length} market(s) via upstream eligibility (BINGX 1d etc)`
    );
  }

  // Fetch per market using P2-B hardened pagination
  const marketResults: MarketHistoricalResult[] = [];
  const allBarsPerMarket: Map<number, { market: BacktestMarketRow; bars: readonly BacktestCandleRow[] }> = new Map();
  let totalReturned = 0;
  let totalDistinct = 0;

  for (const market of req.markets) {
    // Even ineligible markets we fetch for raw coverage diagnostics, but mark eligibility
    const isEligible = eligibleMarkets.some((em) => em.id === market.id);
    const eligibilityReason = isEligible
      ? null
      : ineligibleMarkets.find((im) => im.marketId === market.id)?.reason ?? "ineligible";

    // Fetch via V2 deps — correct signature
    const fetched = await fetchCandlesPaginatedV2({
      deps: req.deps,
      marketId: market.id,
      timeframe: req.timeframe,
      from: req.from,
      to: req.to,
      pageSize,
      maxPages,
      maxRows,
    });
    const rows = fetched.rows;

    // Convert to BacktestBar for coverage computation
    const bars = rows.map((r) => ({
      time: r.openTime.getTime(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));

    const frozenBars = Object.freeze(bars) as typeof bars;

    const coverage = computeMarketCoverage(market.id, req.timeframe, frozenBars, timeframeMs, {
      from: req.from,
      to: req.to,
    });

    const anomalies = analyzeMarketAnomalies(frozenBars as any, timeframeMs);

    const duplicates =
      (anomalies.duplicates?.length ?? 0) > 0
        ? anomalies.duplicates.reduce((acc, g) => acc + (g.count - 1), 0)
        : Math.max(0, rows.length - (coverage.distinctReturnedCount ?? rows.length));
    const offGrid = (coverage as any).offGridBarsInRequestedRange ?? anomalies.grid.offGrid.length ?? 0;

    const contiguousRanges =
      timeframeMs !== null
        ? findContiguousIntervals(frozenBars as any, timeframeMs)
        : ([] as readonly ContiguousRange[]);

    const earliest = coverage.firstAvailable !== null ? formatIsoUtc(coverage.firstAvailable) : null;
    const latest = coverage.lastAvailable !== null ? formatIsoUtc(coverage.lastAvailable) : null;

    marketResults.push(
      Object.freeze({
        market,
        coverage: Object.freeze(coverage),
        barsCount: rows.length,
        earliest,
        latest,
        duplicates,
        offGrid,
        anomalies: Object.freeze(anomalies),
        contiguousRanges: Object.freeze(contiguousRanges),
        isEligible,
        eligibilityReason,
      })
    );

    allBarsPerMarket.set(market.id, { market, bars: rows });
    totalReturned += coverage.returnedCount ?? rows.length;
    totalDistinct += coverage.distinctReturnedCount ?? rows.length;
  }

  // Aggregated coverage
  const coverages = marketResults.map((mr) => mr.coverage);
  const aggregatedCoverage = aggregateCoverage(coverages);

  // Common timestamps across eligible markets only (for feasibility)
  // Build Map for common timestamps (P2-B contract expects Map<marketId, bars>)
  const eligibleMapForCommon = new Map<number, readonly { time: number; open: number; high: number; low: number; close: number; volume: number }[]>();
  for (const mr of marketResults) {
    if (!mr.isEligible) continue;
    const entry = allBarsPerMarket.get(mr.market.id);
    if (!entry) continue;
    const bars = entry.bars.map((r) => ({
      time: r.openTime.getTime(),
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));
    if (bars.length > 0) {
      eligibleMapForCommon.set(mr.market.id, bars as any);
    }
  }

  let commonTimestamps: number[] = [];
  let commonContiguousRanges: readonly ContiguousRange[] = [];

  if (eligibleMapForCommon.size > 0 && timeframeMs !== null) {
    try {
      commonTimestamps = findCommonTimestamps(eligibleMapForCommon as any);
      // findCommonContiguousIntervals expects same Map shape
      const commonIntervals = findCommonContiguousIntervals(eligibleMapForCommon as any, timeframeMs);
      // Convert CommonInterval to ContiguousRange shape for uniform reporting (adapter)
      commonContiguousRanges = commonIntervals.map((ci) => ({
        startTime: ci.startTime,
        endTime: ci.endTime,
        startIndex: 0,
        endIndexExclusive: ci.count,
        endIndex: ci.count - 1,
        count: ci.count,
        isUsable: ci.isUsable,
        minBarsApplied: ci.minBarsApplied,
        reason: ci.reason,
      })) as unknown as readonly ContiguousRange[];
    } catch {
      // If timeframe invalid or empty, keep empty
      commonTimestamps = [];
      commonContiguousRanges = [];
    }
  }

  const minMarkets = 1; // for BTC we need at least 1, but Smart Money may need more
  const hasEnoughEligible = eligibleMarkets.length >= minMarkets;

  const participantFeasibility = Object.freeze({
    minMarkets,
    hasEnoughEligible,
    commonTimestampsCount: commonTimestamps.length,
    commonContiguousRangesCount: commonContiguousRanges.length,
  });

  // Provenance diagnostics if provided
  let provenanceDiagnostics: OhlcvProvenanceDiagnostics | null = null;
  if (req.provenanceRows && req.provenanceRows.length > 0) {
    provenanceDiagnostics = computeOhlcvProvenanceDiagnostics(req.provenanceRows);
  }

  const eligibilityDiagnostics = buildHistoricalEligibilityDiagnostics(
    req.eligibilityMethodology ?? null
  );

  // Additional warnings
  if (aggregatedCoverage.emptyMarkets > 0) {
    warnings.push(`${aggregatedCoverage.emptyMarkets} market(s) empty — coverage not 100%`);
  }
  if (!aggregatedCoverage.coverageIdentityHolds) {
    warnings.push("Coverage counter identity violated — report not trustworthy");
  }
  if (aggregatedCoverage.offGridBarsInRequestedRange > 0) {
    warnings.push(
      `offGridBarsInRequestedRange=${aggregatedCoverage.offGridBarsInRequestedRange} — these bars are not counted as available`
    );
  }

  const report: HistoricalDataPlaneReport = Object.freeze({
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    timeframeMs,
    requestedRange: Object.freeze({ from: toIso(req.from), to: toIso(req.to) }),
    effectiveCanonicalRange,
    marketsCount: req.markets.length,
    eligibleMarketsCount: eligibleMarkets.length,
    ineligibleMarkets: Object.freeze(ineligibleMarkets),
    totalReturned,
    totalDistinct,
    overallCoverageRatio: aggregatedCoverage.overallCoverageRatio,
    aggregatedCoverage: Object.freeze(aggregatedCoverage),
    marketResults: Object.freeze(marketResults),
    commonTimestamps: Object.freeze(commonTimestamps),
    commonContiguousRanges: Object.freeze(commonContiguousRanges),
    participantFeasibility: Object.freeze(participantFeasibility),
    provenanceDiagnostics: provenanceDiagnostics ? Object.freeze(provenanceDiagnostics) : null,
    eligibilityDiagnostics: Object.freeze(eligibilityDiagnostics),
    warnings: Object.freeze(warnings),
    readOnly: true as const,
    noPnl: true as const,
  });

  return deepFreeze(report) as HistoricalDataPlaneReport;
}

export function formatHistoricalDataPlaneReport(report: HistoricalDataPlaneReport): string {
  const lines: string[] = [];
  lines.push("=== Historical Data Plane — READ ONLY — NO DB WRITES — NO PNL ===");
  lines.push(`asset: ${report.assetSymbol} timeframe: ${report.timeframe} tfMs: ${report.timeframeMs ?? "unknown"}`);
  lines.push(`requested: ${report.requestedRange.from} -> ${report.requestedRange.to} (exclusive)`);
  if (report.effectiveCanonicalRange) {
    lines.push(
      `effective canonical: ${report.effectiveCanonicalRange.from} -> ${report.effectiveCanonicalRange.to} expectedSlots=${report.effectiveCanonicalRange.expectedSlots} aligned=${report.effectiveCanonicalRange.isAligned} canonicalized=${report.effectiveCanonicalRange.canonicalized}`
    );
  } else {
    lines.push("effective canonical: n/a (unknown timeframe or canonical window error)");
  }
  lines.push(`markets: total=${report.marketsCount} eligible=${report.eligibleMarketsCount} ineligible=${report.ineligibleMarkets.length}`);
  if (report.ineligibleMarkets.length > 0) {
    for (const im of report.ineligibleMarkets) {
      lines.push(`  ineligible: id=${im.marketId} ${im.exchange} reason=${im.reason}`);
    }
  }
  lines.push(`totalReturned: ${report.totalReturned} totalDistinct: ${report.totalDistinct}`);
  lines.push(`overallCoverageRatio: ${report.overallCoverageRatio ?? "n/a"} (requested-based, canonical-grid)`);
  lines.push(`aggregated: empty=${report.aggregatedCoverage.emptyMarkets} withAnomalies=${report.aggregatedCoverage.marketsWithAnomalies} coverageIdentityHolds=${report.aggregatedCoverage.coverageIdentityHolds}`);
  lines.push(`commonTimestamps: ${report.commonTimestamps.length} commonContiguousRanges: ${report.commonContiguousRanges.length}`);
  lines.push(`participantFeasibility: min=${report.participantFeasibility.minMarkets} hasEnough=${report.participantFeasibility.hasEnoughEligible}`);
  lines.push("marketResults:");
  for (const mr of report.marketResults) {
    lines.push(
      `  - id=${mr.market.id} ${mr.market.exchange} eligible=${mr.isEligible} bars=${mr.barsCount} earliest=${mr.earliest ?? "n/a"} latest=${mr.latest ?? "n/a"} dup=${mr.duplicates} offGrid=${mr.offGrid} coverageRatio=${mr.coverage.coverageRatio ?? "n/a"} missingLeading=${mr.coverage.missingLeading ?? "n/a"} internal=${mr.coverage.missingInternal ?? "n/a"} trailing=${mr.coverage.missingTrailing ?? "n/a"}`
    );
  }
  if (report.provenanceDiagnostics) {
    lines.push(`provenance: totalRows=${report.provenanceDiagnostics.totalRows} withCreatedAt=${report.provenanceDiagnostics.rowsWithCreatedAt} diff=${report.provenanceDiagnostics.rowsWhereUpdatedAtDiffersFromCreatedAt}`);
  }
  lines.push(`eligibility: methodology=${report.eligibilityDiagnostics.methodology ?? "UNRESOLVED"} reconstructability=${report.eligibilityDiagnostics.reconstructability}`);
  if (report.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  lines.push("READ ONLY: no DB writes, no PnL, no workers");
  return lines.join("\n");
}
