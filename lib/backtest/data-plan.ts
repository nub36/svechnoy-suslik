/**
 * P2-B — read-only planning interface / CLI contract.
 *
 * Задача: описать будущий прогон без записи в БД, без сети, без workers.
 * План содержит:
 * - asset, markets, timeframe, requested range
 * - число DB read tasks (по одному на market)
 * - pageSize
 * - coverage/anomaly summary, если данные уже предоставлены через deps
 *   (для --plan режима, где deps может быть реальной Prisma с SELECT)
 * - eligibility summary, если runner для Smart Money (BINGX 1d exclusion)
 *
 * Планирование — чистая функция, не ходит в БД сама. Данные для summary
 * передаются извне (через coverage, который уже посчитан).
 *
 * Совместимо с существующей архитектурой --plan для OHLCV worker:
 * отдельный CLI скрипт может вызвать planBacktestRun и вывести отчёт.
 */

import type { BacktestMarketRow } from "./data-source";
import type { MarketCoverage } from "./coverage";

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
  /** Является ли runner для Smart Money (применяет BINGX 1d eligibility). */
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
    totalExpected: number | null;
    overallCoverageRatio: number | null;
    emptyMarkets: number;
    marketsWithAnomalies: number;
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

  // Eligibility: для Smart Money runner применяем существующую политику
  // isSmartMoneyExchangeEligible, но не хардкодим её здесь — логика в
  // eligibility.ts. Здесь только BINGX 1d как частный случай для плана,
  // но источник — та же функция, чтобы не было второго набора констант.
  // Для generic runner — все eligible.
  const isSmartMoney = req.isSmartMoneyRunner === true;
  const ineligible: { marketId: number; exchange: string; reason: string }[] =
    [];
  let eligibleMarkets = [...req.markets];

  if (isSmartMoney) {
    // Ленивый импорт через динамический require невозможен в pure слое,
    // поэтому применяем правило напрямую, но оно совпадает с
    // isSmartMoneyExchangeEligible: BINGX + 1d => ineligible.
    // Чтобы не дублировать константы, мы всё равно проверяем только
    // это правило, а полный список поддерживаемых бирж — в eligibility.
    const before = eligibleMarkets.length;
    eligibleMarkets = eligibleMarkets.filter((m) => {
      const isBingx1d = m.exchange === "BINGX" && req.timeframe === "1d";
      if (isBingx1d) {
        ineligible.push({
          marketId: m.id,
          exchange: m.exchange,
          reason: "BINGX excluded for 1d in Smart Money (off-grid 16:00 UTC)",
        });
        return false;
      }
      return true;
    });

    if (eligibleMarkets.length < before) {
      warnings.push(
        `Smart Money 1d: excluded ${before - eligibleMarkets.length} BINGX market(s)`
      );
    }
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
    let totalReturned = 0;
    let totalExpected: number | null = 0;
    let hasExpected = false;
    let emptyMarkets = 0;
    let marketsWithAnomalies = 0;

    for (const c of req.coverages) {
      totalReturned += c.returnedCount;
      if (c.isEmpty) emptyMarkets += 1;
      if (c.anomalies.hasAnomaly) marketsWithAnomalies += 1;
      if (c.expectedCount !== null) {
        if (totalExpected !== null) totalExpected += c.expectedCount;
        hasExpected = true;
      } else {
        if (hasExpected) totalExpected = null;
      }
    }

    if (!hasExpected) totalExpected = null;

    let overallCoverageRatio: number | null = null;

    if (totalExpected !== null && totalExpected > 0) {
      overallCoverageRatio = totalReturned / totalExpected;
    }

    coverageSummary = {
      totalReturned,
      totalExpected,
      overallCoverageRatio,
      emptyMarkets,
      marketsWithAnomalies,
    };

    if (emptyMarkets > 0) {
      warnings.push(`${emptyMarkets} market(s) empty — coverage not 100%`);
    }

    if (marketsWithAnomalies > 0) {
      warnings.push(`${marketsWithAnomalies} market(s) have anomalies`);
    }
  }

  return {
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
    ineligibleMarkets: ineligible,
    coverageSummary,
    warnings,
  };
}

export function formatDataPlanReport(plan: BacktestDataPlan): string {
  const lines: string[] = [];

  lines.push(`Backtest Data Plan — P2-B`);
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
    lines.push(`Ineligible:`);
    for (const m of plan.ineligibleMarkets) {
      lines.push(`  - marketId ${m.marketId} ${m.exchange}: ${m.reason}`);
    }
  }

  if (plan.coverageSummary) {
    lines.push(`Coverage:`);
    lines.push(`  returned: ${plan.coverageSummary.totalReturned}`);
    lines.push(
      `  expected: ${plan.coverageSummary.totalExpected ?? "n/a"}`
    );
    lines.push(
      `  ratio: ${plan.coverageSummary.overallCoverageRatio ?? "n/a"}`
    );
    lines.push(`  empty: ${plan.coverageSummary.emptyMarkets}`);
    lines.push(
      `  with anomalies: ${plan.coverageSummary.marketsWithAnomalies}`
    );
  }

  if (plan.warnings.length > 0) {
    lines.push(`Warnings:`);
    for (const w of plan.warnings) {
      lines.push(`  - ${w}`);
    }
  }

  return lines.join("\n");
}
