/**
 * P2-B — read-only planning interface / CLI contract.
 *
 * Задача: описать будущий прогон без записи в БД, без сети, без workers,
 * без DATABASE_URL, без DB connection.
 *
 * План содержит:
 * - asset, markets, timeframe, requested range
 * - число DB read tasks (по одному на market)
 * - pageSize
 * - coverage/anomaly summary, если данные уже предоставлены через deps
 *   (для --plan режима, где deps может быть реальной Prisma с SELECT)
 * - eligibility summary, если runner для Smart Money (BINGX 1d exclusion via upstream)
 *
 * Планирование — чистая функция, не ходит в БД сама. Данные для summary
 * передаются извне (через coverage, который уже посчитан).
 *
 * Совместимо с существующей архитектурой --plan для OHLCV worker:
 * отдельный CLI скрипт может вызвать planBacktestRun и вывести отчёт.
 *
 * P2-B HARDENING:
 * - remove duplicate aggregateCoverage implementation, prefer shared lib/backtest/coverage.ts
 * - remove duplicate BINGX+1d manual check, use P2-B wrapper / upstream Smart Money eligibility
 * - unknown exchange/timeframe fail-closed
 * - raw vs Smart Money eligibility distinct
 */

import type { BacktestMarketRow } from "./data-source";
import type { MarketCoverage } from "./coverage";
import { aggregateCoverage } from "./coverage";
import { partitionByEligibility } from "./eligibility";

export interface BacktestDataPlanRequest {
  readonly assetSymbol: string;
  readonly timeframe: string;
  readonly timeframeMs: number | null;
  readonly from: Date;
  readonly to: Date;
  readonly markets: readonly BacktestMarketRow[];
  readonly pageSize: number;
  /** Опционально: уже посчитанное покрытие для каждого рынка (для summary). */
  readonly coverages?: readonly MarketCoverage[];
  /** Является ли runner для Smart Money (применяет BINGX 1d eligibility via upstream). */
  readonly isSmartMoneyRunner?: boolean;
  /** Минимум баров из P2-A, если есть (для usable ranges). */
  readonly minBarsPerSegment?: number | null;
}

export interface BacktestDataPlan {
  readonly assetSymbol: string;
  readonly timeframe: string;
  readonly timeframeMs: number | null;
  readonly from: string; // ISO
  readonly to: string; // ISO
  readonly requestedRangeMs: number;
  readonly marketsCount: number;
  readonly eligibleMarketsCount: number;
  readonly readTasks: number;
  readonly pageSize: number;
  readonly estimatedPagesPerMarket: number | null;
  readonly minBarsPerSegment: number | null;
  readonly isSmartMoneyRunner: boolean;
  readonly ineligibleMarkets: readonly {
    marketId: number;
    exchange: string;
    reason: string;
  }[];
  readonly coverageSummary?: {
    totalReturned: number;
    totalDistinctReturned: number;
    totalRequestedExpected: number | null;
    totalAvailableInRequested: number | null;
    totalExpected: number | null;
    overallCoverageRatio: number | null;
    emptyMarkets: number;
    marketsWithAnomalies: number;
    isTimeframeValid: boolean;
  };
  readonly warnings: readonly string[];
}

export function planBacktestRun(
  req: BacktestDataPlanRequest
): BacktestDataPlan {
  const fromMs = req.from.getTime();
  const toMs = req.to.getTime();
  const rangeMs = toMs - fromMs;

  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) {
    throw new Error("planBacktestRun: from должен быть < to и валидными Date");
  }

  if (!Number.isInteger(req.pageSize) || req.pageSize <= 0) {
    throw new Error("planBacktestRun: pageSize целое >0");
  }

  const warnings: string[] = [];

  // Eligibility via upstream P2-B wrapper, not manual BINGX check
  const isSmartMoney = req.isSmartMoneyRunner === true;
  let eligibleMarkets: readonly BacktestMarketRow[];
  let ineligible: { marketId: number; exchange: string; reason: string }[] = [];

  if (isSmartMoney) {
    // Use shared partitionByEligibility which wraps isSmartMoneyExchangeEligible (fail-closed unknown)
    const partitioned = partitionByEligibility(req.markets, req.timeframe);
    eligibleMarkets = partitioned.eligible;
    ineligible = partitioned.ineligible.map((m) => ({
      marketId: m.market.id,
      exchange: m.market.exchange,
      reason: m.reason,
    }));

    if (ineligible.length > 0) {
      warnings.push(
        `Smart Money ${req.timeframe}: excluded ${ineligible.length} market(s) via upstream eligibility`
      );
    }
  } else {
    // Generic runner: all markets eligible (raw data)
    eligibleMarkets = req.markets;
  }

  // Оценка числа страниц на рынок
  let estimatedPagesPerMarket: number | null = null;

  if (
    req.timeframeMs !== null &&
    Number.isFinite(req.timeframeMs) &&
    req.timeframeMs > 0
  ) {
    const expectedBars = Math.ceil(rangeMs / req.timeframeMs);
    estimatedPagesPerMarket = Math.ceil(expectedBars / req.pageSize);
  }

  let coverageSummary: BacktestDataPlan["coverageSummary"] | undefined;

  if (req.coverages && req.coverages.length > 0) {
    // Use shared order-independent aggregateCoverage
    const agg = aggregateCoverage(req.coverages);

    coverageSummary = {
      totalReturned: agg.totalReturned,
      totalDistinctReturned: agg.totalDistinctReturned,
      totalRequestedExpected: agg.totalRequestedExpected,
      totalAvailableInRequested: agg.totalAvailableInRequested,
      totalExpected: agg.totalExpected,
      overallCoverageRatio: agg.overallCoverageRatio,
      emptyMarkets: agg.emptyMarkets,
      marketsWithAnomalies: agg.marketsWithAnomalies,
      isTimeframeValid: agg.isTimeframeValid,
    };

    if (agg.emptyMarkets > 0) {
      warnings.push(`${agg.emptyMarkets} market(s) empty — coverage not 100%`);
    }

    if (agg.marketsWithAnomalies > 0) {
      warnings.push(`${agg.marketsWithAnomalies} market(s) have anomalies`);
    }

    if (!agg.isTimeframeValid) {
      warnings.push(`unknown/invalid timeframe — not healthy`);
    }
  }

  return Object.freeze({
    assetSymbol: req.assetSymbol,
    timeframe: req.timeframe,
    timeframeMs: req.timeframeMs,
    from: req.from.toISOString(),
    to: req.to.toISOString(),
    requestedRangeMs: rangeMs,
    marketsCount: req.markets.length,
    eligibleMarketsCount: eligibleMarkets.length,
    readTasks: eligibleMarkets.length,
    pageSize: req.pageSize,
    estimatedPagesPerMarket,
    minBarsPerSegment: req.minBarsPerSegment ?? null,
    isSmartMoneyRunner: isSmartMoney,
    ineligibleMarkets: Object.freeze([...ineligible]),
    coverageSummary,
    warnings: Object.freeze([...warnings]),
  });
}

export function formatDataPlanReport(plan: BacktestDataPlan): string {
  const lines: string[] = [];

  lines.push(`Backtest Data Plan — P2-B — SIMULATED / NO DB`);
  lines.push(`Asset: ${plan.assetSymbol}`);
  lines.push(`Timeframe: ${plan.timeframe} (${plan.timeframeMs ?? "unknown"} ms)`);
  lines.push(`Range: ${plan.from} → ${plan.to} (${plan.requestedRangeMs} ms)`);
  lines.push(`Markets: ${plan.marketsCount} total, ${plan.eligibleMarketsCount} eligible`);
  lines.push(`Read tasks: ${plan.readTasks}, pageSize: ${plan.pageSize}`);
  lines.push(
    `Estimated pages/market: ${plan.estimatedPagesPerMarket ?? "n/a (no timeframeMs)"}`
  );
  lines.push(`Smart Money runner: ${plan.isSmartMoneyRunner}`);
  lines.push(
    `minBarsPerSegment: ${plan.minBarsPerSegment ?? "n/a (report only)"}`
  );

  if (plan.ineligibleMarkets.length > 0) {
    lines.push(`Ineligible (upstream Smart Money eligibility, fail-closed unknown):`);
    for (const m of plan.ineligibleMarkets) {
      lines.push(`  - marketId ${m.marketId} ${m.exchange}: ${m.reason}`);
    }
  }

  if (plan.coverageSummary) {
    lines.push(`Coverage (requested-range basis):`);
    lines.push(`  returned: ${plan.coverageSummary.totalReturned}`);
    lines.push(`  distinct: ${plan.coverageSummary.totalDistinctReturned}`);
    lines.push(
      `  requestedExpected: ${plan.coverageSummary.totalRequestedExpected ?? "n/a"}`
    );
    lines.push(
      `  availableInRequested: ${plan.coverageSummary.totalAvailableInRequested ?? "n/a"}`
    );
    lines.push(
      `  expected (first→last): ${plan.coverageSummary.totalExpected ?? "n/a"}`
    );
    lines.push(
      `  ratio (requested): ${plan.coverageSummary.overallCoverageRatio ?? "n/a"}`
    );
    lines.push(`  empty: ${plan.coverageSummary.emptyMarkets}`);
    lines.push(
      `  with anomalies: ${plan.coverageSummary.marketsWithAnomalies}`
    );
    lines.push(`  timeframeValid: ${plan.coverageSummary.isTimeframeValid}`);
  }

  if (plan.warnings.length > 0) {
    lines.push(`Warnings:`);
    for (const w of plan.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  lines.push(`NOTE: This report is SIMULATED / NO DB — no live DB connection, no env DB.`);

  return lines.join("\n");
}
