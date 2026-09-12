/**
 * P2-B — покрытие по рынку × таймфрейму.
 *
 * Чистый детерминированный слой. Не ходит в БД, работает поверх
 * BacktestBar[] и timeframeMs (единственный источник длительности —
 * SMCTIMEFRAME_MS, сюда передаётся числом).
 *
 * Минимум, требуемый ТЗ P2-B:
 * - requested range (from/to)
 * - first/last available
 * - returned count
 * - expected count где математически определимо
 * - missing count
 * - coverage ratio
 * - gaps, duplicates, ordering violations, grid/alignment status
 * - contiguous usable ranges
 *
 * Важно: не возвращать 100% при пустом наборе (ratio null, isEmpty).
 */

import type { BacktestBar } from "./contract";
import {
  analyzeMarketAnomalies,
  type MarketAnomalies,
} from "./gaps";
import { findContiguousIntervals, type ContiguousRange } from "./intervals";

export interface RequestedRange {
  readonly from: number | null; // ms inclusive
  readonly to: number | null; // ms exclusive
}

export interface MarketCoverage {
  readonly marketId: number;
  readonly timeframe: string;
  readonly timeframeMs: number | null;
  readonly requestedRange: RequestedRange;
  readonly firstAvailable: number | null;
  readonly lastAvailable: number | null;
  readonly returnedCount: number;
  readonly expectedCount: number | null;
  readonly missingCount: number | null;
  readonly coverageRatio: number | null; // 0..1, null если неопределено
  readonly isEmpty: boolean;
  readonly anomalies: MarketAnomalies;
  readonly contiguousRanges: ContiguousRange[];
}

/**
 * Вычислить покрытие для одного рынка.
 *
 * @param marketId — Market.id (identity, не exchangeSymbol)
 * @param timeframe — строковый ТФ, для отчётности
 * @param bars — бары, как пришли из БД (ASC, но не сортируем молча)
 * @param timeframeMs — длительность ТФ в ms из SMCTIMEFRAME_MS, или null
 * @param requestedRange — запрошенный диапазон (from inclusive, to exclusive)
 */
export function computeMarketCoverage(
  marketId: number,
  timeframe: string,
  bars: readonly BacktestBar[],
  timeframeMs: number | null,
  requestedRange?: { from: Date | number | null; to: Date | number | null }
): MarketCoverage {
  const fromMs =
    requestedRange?.from instanceof Date
      ? requestedRange.from.getTime()
      : (requestedRange?.from as number | null) ?? null;
  const toMs =
    requestedRange?.to instanceof Date
      ? requestedRange.to.getTime()
      : (requestedRange?.to as number | null) ?? null;

  const returnedCount = bars.length;
  const isEmpty = returnedCount === 0;

  let firstAvailable: number | null = null;
  let lastAvailable: number | null = null;

  if (!isEmpty) {
    // first/last по фактическим данным, но детерминированно: min/max,
    // а не просто bars[0]/bars[last], чтобы отчёт был стабилен даже
    // если порядок нарушен (нарушение отдельно в anomalies).
    let min = bars[0].time;
    let max = bars[0].time;

    for (let i = 1; i < bars.length; i += 1) {
      const t = bars[i].time;
      if (t < min) min = t;
      if (t > max) max = t;
    }

    firstAvailable = min;
    lastAvailable = max;
  }

  let expectedCount: number | null = null;
  let missingCount: number | null = null;
  let coverageRatio: number | null = null;

  if (
    !isEmpty &&
    timeframeMs !== null &&
    Number.isFinite(timeframeMs) &&
    timeframeMs > 0 &&
    firstAvailable !== null &&
    lastAvailable !== null
  ) {
    const span = lastAvailable - firstAvailable;

    if (span >= 0 && span % timeframeMs === 0) {
      expectedCount = span / timeframeMs + 1;
      missingCount = expectedCount - returnedCount;
      if (missingCount < 0) missingCount = 0; // дубликаты дают > expected, но missing не отрицательный
      coverageRatio = expectedCount > 0 ? returnedCount / expectedCount : null;
    } else if (span >= 0) {
      // span не кратен — expected не определён математически точно
      // (сетка нарушена), но можем дать floor-оценку для диагностики
      expectedCount = null;
      missingCount = null;
      coverageRatio = null;
    }
  }

  // Если пусто — никогда не 100%
  if (isEmpty) {
    expectedCount = null;
    missingCount = null;
    coverageRatio = null;
  }

  const anomalies =
    timeframeMs !== null && Number.isFinite(timeframeMs) && timeframeMs > 0
      ? analyzeMarketAnomalies(bars, timeframeMs)
      : {
          gaps: [],
          duplicates: [],
          ordering: { isOrdered: true, violations: [] },
          grid: { isCanonical: true, offGrid: [] },
          hasAnomaly: false,
        };

  const contiguousRanges =
    timeframeMs !== null && Number.isFinite(timeframeMs) && timeframeMs > 0
      ? findContiguousIntervals(bars, timeframeMs)
      : [];

  return {
    marketId,
    timeframe,
    timeframeMs,
    requestedRange: { from: fromMs, to: toMs },
    firstAvailable,
    lastAvailable,
    returnedCount,
    expectedCount,
    missingCount,
    coverageRatio,
    isEmpty,
    anomalies,
    contiguousRanges,
  };
}

export interface AggregatedCoverage {
  readonly markets: MarketCoverage[];
  readonly totalReturned: number;
  readonly totalExpected: number | null;
  readonly totalMissing: number | null;
  readonly overallCoverageRatio: number | null;
  readonly emptyMarkets: number;
  readonly marketsWithAnomalies: number;
}

/**
 * Агрегация по нескольким рынкам (для отчёта по активу).
 */
export function aggregateCoverage(
  coverages: readonly MarketCoverage[]
): AggregatedCoverage {
  let totalReturned = 0;
  let totalExpected: number | null = 0;
  let hasExpected = false;
  let emptyMarkets = 0;
  let marketsWithAnomalies = 0;

  for (const c of coverages) {
    totalReturned += c.returnedCount;

    if (c.isEmpty) emptyMarkets += 1;
    if (c.anomalies.hasAnomaly) marketsWithAnomalies += 1;

    if (c.expectedCount !== null) {
      if (totalExpected !== null) {
        totalExpected += c.expectedCount;
      }
      hasExpected = true;
    } else {
      // Если хотя бы у одного expected null, общий expected null,
      // чтобы не врать частичной суммой.
      if (hasExpected) {
        // уже начали суммировать, но теперь неопределённость
        totalExpected = null;
      }
    }
  }

  if (!hasExpected) {
    totalExpected = null;
  }

  let totalMissing: number | null = null;
  let overallCoverageRatio: number | null = null;

  if (totalExpected !== null && totalExpected > 0) {
    totalMissing = totalExpected - totalReturned;
    if (totalMissing < 0) totalMissing = 0;
    overallCoverageRatio = totalReturned / totalExpected;
  }

  return {
    markets: [...coverages],
    totalReturned,
    totalExpected,
    totalMissing,
    overallCoverageRatio,
    emptyMarkets,
    marketsWithAnomalies,
  };
}
