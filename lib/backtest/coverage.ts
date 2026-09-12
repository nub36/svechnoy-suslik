/**
 * P2-B — покрытие по рынку × таймфрейму.
 *
 * Чистый детерминированный слой, без Date.now(). Не ходит в БД, работает поверх
 * BacktestBar[] и timeframeMs (единственный источник — SMCTIMEFRAME_MS).
 *
 * БЛОКЕР FIX: computeMarketCoverage теперь отвечает на вопрос
 * "Сколько запрошенного [from,to) диапазона присутствует?" а не
 * "сколько от first→last присутствует?".
 *
 * Для фиксированного таймфрейма D:
 * requested expected timestamps = from + k*D where timestamp >= from and timestamp < to
 * Это определение работает даже если from не выровнен по канонической сетке,
 * но мы отдельно валидируем выравнивание requested bounds и репортим off-grid.
 *
 * Report минимум:
 * - requestedExpectedCount
 * - availableInRequestedRange (distinct timestamps in [from,to))
 * - missingTotal, missingLeading, missingInternal, missingTrailing
 * - coverageRatio = available / requestedExpected
 * - firstAvailable, lastAvailable
 * - internal continuity (gaps inside requested)
 *
 * Empty requested range / from>=to must fail.
 */

import type { BacktestBar } from "./contract";
import {
  analyzeMarketAnomalies,
  isValidTimeframeMs,
  type MarketAnomalies,
} from "./gaps";
import { findContiguousIntervals, type ContiguousRange } from "./intervals";

export interface RequestedRange {
  readonly from: number | null; // ms inclusive
  readonly to: number | null; // ms exclusive
}

export interface RequestedAlignment {
  readonly fromAligned: boolean;
  readonly toAligned: boolean;
  readonly fromRemainder: number | null;
  readonly toRemainder: number | null;
  readonly isAligned: boolean;
}

export interface MarketCoverage {
  readonly marketId: number;
  readonly timeframe: string;
  readonly timeframeMs: number | null;
  readonly requestedRange: RequestedRange;
  readonly requestedAlignment: RequestedAlignment | null;
  readonly requestedExpectedCount: number | null;
  readonly availableInRequestedRange: number;
  readonly returnedCount: number;
  readonly distinctReturnedCount: number;
  readonly firstAvailable: number | null;
  readonly lastAvailable: number | null;
  // old first→last based (for internal continuity)
  readonly expectedCount: number | null; // based on first→last
  readonly missingCount: number | null; // based on first→last
  // new requested based
  readonly missingTotal: number | null;
  readonly missingLeading: number | null;
  readonly missingTrailing: number | null;
  readonly missingInternal: number | null;
  readonly coverageRatio: number | null; // requested based 0..1
  readonly isEmpty: boolean;
  readonly isRequestedRangeValid: boolean;
  readonly isTimeframeValid: boolean;
  readonly anomalies: MarketAnomalies;
  readonly contiguousRanges: readonly ContiguousRange[];
  readonly internalContiguous: boolean;
}

function toMs(value: Date | number | null | undefined): number | null {
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  return null;
}

function computeRequestedExpected(fromMs: number, toMs: number, timeframeMs: number): number {
  // count k where from + k*D < to
  // = ceil((to-from)/D)
  const diff = toMs - fromMs;
  return Math.ceil(diff / timeframeMs);
}

function buildExpectedSet(fromMs: number, toMs: number, timeframeMs: number): Set<number> {
  const expected = new Set<number>();
  const count = computeRequestedExpected(fromMs, toMs, timeframeMs);
  // safety upper bound: avoid OOM for huge ranges
  if (count > 1_000_000) {
    // too large to materialize, return empty set and let caller handle via count only
    // but for coverage we need leading/trailing detection, we can still compute via math without full set if count huge?
    // For safety, we return set with only first and last? Instead, we return set up to 1M and mark as truncated.
    // Here we implement truncated set: only generate up to 1M, caller must handle missing as count-based.
    // For now, generate up to 1M to avoid OOM, and let missing calculations use count.
    for (let k = 0; k < Math.min(count, 1_000_000); k += 1) {
      expected.add(fromMs + k * timeframeMs);
    }
    return expected;
  }
  for (let k = 0; k < count; k += 1) {
    expected.add(fromMs + k * timeframeMs);
  }
  return expected;
}

/**
 * Вычислить покрытие для одного рынка.
 * Fail-closed на from>=to, invalid Date, non-finite.
 */
export function computeMarketCoverage(
  marketId: number,
  timeframe: string,
  bars: readonly BacktestBar[],
  timeframeMs: number | null,
  requestedRange?: { from: Date | number | null; to: Date | number | null }
): MarketCoverage {
  const fromMs = toMs(requestedRange?.from);
  const toMsVal = toMs(requestedRange?.to);

  // Validate requested range presence
  let isRequestedRangeValid = true;
  if (requestedRange !== undefined) {
    if (fromMs === null || toMsVal === null) {
      throw new Error(
        `computeMarketCoverage: requestedRange from/to must be valid Date or finite number, got from=${String(requestedRange.from)} to=${String(requestedRange.to)}`
      );
    }
    if (fromMs >= toMsVal) {
      throw new Error(
        `computeMarketCoverage: requestedRange from must be < to, got from=${fromMs} to=${toMsVal} (empty range)`
      );
    }
  } else {
    isRequestedRangeValid = false;
  }

  const returnedCount = bars.length;
  const distinctSet = new Set<number>();
  for (const b of bars) {
    distinctSet.add(b.time);
  }
  const distinctReturnedCount = distinctSet.size;
  const isEmpty = returnedCount === 0;

  let firstAvailable: number | null = null;
  let lastAvailable: number | null = null;

  if (!isEmpty) {
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

  // old first→last based (for internal continuity)
  let expectedCount: number | null = null;
  let missingCount: number | null = null;

  if (
    !isEmpty &&
    isValidTimeframeMs(timeframeMs) &&
    firstAvailable !== null &&
    lastAvailable !== null
  ) {
    const span = lastAvailable - firstAvailable;
    if (span >= 0 && span % timeframeMs === 0) {
      expectedCount = span / timeframeMs + 1;
      missingCount = expectedCount - distinctReturnedCount;
      if (missingCount < 0) missingCount = 0;
    }
  }

  // new requested based
  let requestedExpectedCount: number | null = null;
  let availableInRequestedRange = 0;
  let missingTotal: number | null = null;
  let missingLeading: number | null = null;
  let missingTrailing: number | null = null;
  let missingInternal: number | null = null;
  let coverageRatio: number | null = null;
  let requestedAlignment: RequestedAlignment | null = null;
  let isTimeframeValid = isValidTimeframeMs(timeframeMs);
  let internalContiguous = true;

  if (isRequestedRangeValid && fromMs !== null && toMsVal !== null && isTimeframeValid) {
    const tf = timeframeMs as number;

    // alignment validation
    const fromRem = fromMs % tf;
    const toRem = toMsVal % tf;
    const fromAligned = fromRem === 0;
    const toAligned = toRem === 0;

    requestedAlignment = {
      fromAligned,
      toAligned,
      fromRemainder: fromRem,
      toRemainder: toRem,
      isAligned: fromAligned && toAligned,
    };

    requestedExpectedCount = computeRequestedExpected(fromMs, toMsVal, tf);

    // availableInRequestedRange = distinct timestamps within [from,to)
    let available = 0;
    for (const t of distinctSet) {
      if (t >= fromMs && t < toMsVal) available += 1;
    }
    availableInRequestedRange = available;

    missingTotal = requestedExpectedCount - availableInRequestedRange;
    if (missingTotal < 0) missingTotal = 0; // distinct should never exceed expected, but guard

    if (requestedExpectedCount > 0) {
      coverageRatio = availableInRequestedRange / requestedExpectedCount;
      // Never >1 for healthy distinct count
      if (coverageRatio > 1) coverageRatio = 1;
    } else {
      coverageRatio = null;
    }

    // missingLeading / trailing / internal
    // Build expected list in order
    if (requestedExpectedCount <= 1_000_000) {
      const expectedList: number[] = [];
      for (let k = 0; k < requestedExpectedCount; k += 1) {
        expectedList.push(fromMs + k * tf);
      }

      // Find first present index
      let firstPresentIdx = -1;
      let lastPresentIdx = -1;
      for (let i = 0; i < expectedList.length; i += 1) {
        if (distinctSet.has(expectedList[i])) {
          if (firstPresentIdx === -1) firstPresentIdx = i;
          lastPresentIdx = i;
        }
      }

      if (firstPresentIdx === -1) {
        // none present
        missingLeading = requestedExpectedCount;
        missingTrailing = 0;
        missingInternal = 0;
      } else {
        missingLeading = firstPresentIdx;
        missingTrailing = expectedList.length - 1 - lastPresentIdx;

        // internal missing = total - leading - trailing
        let internalMissing = 0;
        for (let i = firstPresentIdx; i <= lastPresentIdx; i += 1) {
          if (!distinctSet.has(expectedList[i])) internalMissing += 1;
        }
        missingInternal = internalMissing;

        // internal continuity: true if no internal missing
        internalContiguous = internalMissing === 0;
      }
    } else {
      // huge range, cannot materialize full list, use approximations for leading/trailing based on first/last available
      if (firstAvailable === null || lastAvailable === null) {
        missingLeading = requestedExpectedCount;
        missingTrailing = 0;
        missingInternal = 0;
        internalContiguous = false;
      } else {
        // leading = number of expected slots before firstAvailable
        if (firstAvailable < fromMs) {
          missingLeading = 0;
        } else if (firstAvailable >= toMsVal) {
          missingLeading = requestedExpectedCount;
        } else {
          missingLeading = Math.floor((firstAvailable - fromMs) / tf);
        }

        if (lastAvailable < fromMs) {
          missingTrailing = requestedExpectedCount;
        } else if (lastAvailable >= toMsVal) {
          missingTrailing = 0;
        } else {
          missingTrailing = Math.floor((toMsVal - 1 - lastAvailable) / tf);
        }

        const remaining = (missingTotal ?? 0) - (missingLeading ?? 0) - (missingTrailing ?? 0);
        missingInternal = remaining > 0 ? remaining : 0;
        internalContiguous = missingInternal === 0;
      }
    }
  } else if (isRequestedRangeValid && !isTimeframeValid) {
    // unknown timeframe → explicit invalid, never healthy
    requestedExpectedCount = null;
    availableInRequestedRange = 0;
    missingTotal = null;
    missingLeading = null;
    missingTrailing = null;
    missingInternal = null;
    coverageRatio = null;
    requestedAlignment = null;
    internalContiguous = false;
  } else {
    // no requested range provided → old behavior for internal continuity only
    availableInRequestedRange = distinctReturnedCount;
    requestedExpectedCount = null;
    missingTotal = null;
    missingLeading = null;
    missingTrailing = null;
    missingInternal = null;
    coverageRatio = null;
    requestedAlignment = null;
    internalContiguous = true;
    if (isValidTimeframeMs(timeframeMs)) {
      // compute internal gaps for continuity
      if (!isEmpty) {
        const sortedTimes = Array.from(distinctSet).sort((a, b) => a - b);
        for (let i = 1; i < sortedTimes.length; i += 1) {
          if (sortedTimes[i] - sortedTimes[i - 1] !== timeframeMs) {
            internalContiguous = false;
            break;
          }
        }
      }
    }
  }

  if (isEmpty) {
    coverageRatio = isRequestedRangeValid ? 0 : null;
    availableInRequestedRange = 0;
    if (isRequestedRangeValid && requestedExpectedCount !== null) {
      missingTotal = requestedExpectedCount;
      missingLeading = requestedExpectedCount;
      missingTrailing = 0;
      missingInternal = 0;
    }
  }

  const anomalies =
    isTimeframeValid && timeframeMs !== null
      ? analyzeMarketAnomalies(bars, timeframeMs)
      : {
          gaps: [],
          duplicates: [],
          ordering: { isOrdered: true, violations: [] },
          grid: { isCanonical: false, offGrid: [], isTimeframeValid: false },
          hasAnomaly: true,
          isTimeframeValid: false,
        };

  // contiguousRanges should be computed only on strictly ordered input, and only within requested range if provided
  let contiguousRanges: ContiguousRange[] = [];
  if (isTimeframeValid && timeframeMs !== null) {
    // Filter bars to requested range for contiguous check if requested valid
    let barsForContiguous = bars;
    if (isRequestedRangeValid && fromMs !== null && toMsVal !== null) {
      barsForContiguous = bars.filter((b) => b.time >= fromMs && b.time < toMsVal);
    }
    contiguousRanges = findContiguousIntervals(barsForContiguous, timeframeMs);
  }

  return Object.freeze({
    marketId,
    timeframe,
    timeframeMs,
    requestedRange: { from: fromMs, to: toMsVal },
    requestedAlignment,
    requestedExpectedCount,
    availableInRequestedRange,
    returnedCount,
    distinctReturnedCount,
    firstAvailable,
    lastAvailable,
    expectedCount,
    missingCount,
    missingTotal,
    missingLeading,
    missingTrailing,
    missingInternal,
    coverageRatio,
    isEmpty,
    isRequestedRangeValid,
    isTimeframeValid,
    anomalies: Object.freeze(anomalies),
    contiguousRanges: Object.freeze(contiguousRanges),
    internalContiguous,
  });
}

export interface AggregatedCoverage {
  readonly markets: readonly MarketCoverage[];
  readonly totalReturned: number;
  readonly totalDistinctReturned: number;
  readonly totalRequestedExpected: number | null;
  readonly totalAvailableInRequested: number | null;
  readonly totalExpected: number | null; // old first→last based, kept for compatibility
  readonly totalMissing: number | null;
  readonly totalMissingRequested: number | null;
  readonly overallCoverageRatio: number | null; // requested based
  readonly emptyMarkets: number;
  readonly marketsWithAnomalies: number;
  readonly isTimeframeValid: boolean;
}

/**
 * Агрегация по нескольким рынкам — order-independent.
 * Invariant: same market set in any order → identical semantic result.
 * Never publishes overallCoverageRatio >1.
 */
export function aggregateCoverage(
  coverages: readonly MarketCoverage[]
): AggregatedCoverage {
  // Order-independent: sort by marketId for deterministic iteration, but sums are commutative
  const sorted = [...coverages].sort((a, b) => a.marketId - b.marketId);

  let totalReturned = 0;
  let totalDistinctReturned = 0;
  let totalRequestedExpected: number | null = 0;
  let totalAvailableInRequested: number | null = 0;
  let totalExpectedOld: number | null = 0;
  let hasRequestedExpected = false;
  let hasAvailable = false;
  let hasOldExpected = false;
  let emptyMarkets = 0;
  let marketsWithAnomalies = 0;
  let isTimeframeValid = true;

  for (const c of sorted) {
    totalReturned += c.returnedCount;
    totalDistinctReturned += c.distinctReturnedCount;

    if (c.isEmpty) emptyMarkets += 1;
    if (c.anomalies.hasAnomaly) marketsWithAnomalies += 1;
    if (!c.isTimeframeValid) isTimeframeValid = false;

    // requested based
    if (c.requestedExpectedCount !== null) {
      if (totalRequestedExpected !== null) {
        totalRequestedExpected += c.requestedExpectedCount;
      }
      hasRequestedExpected = true;
    } else {
      // If any market has null expected, total becomes null (order-independent)
      if (c.isRequestedRangeValid) {
        totalRequestedExpected = null;
      }
    }

    if (c.isRequestedRangeValid) {
      if (totalAvailableInRequested !== null) {
        totalAvailableInRequested += c.availableInRequestedRange;
      }
      hasAvailable = true;
    }

    // old first→last based
    if (c.expectedCount !== null) {
      if (totalExpectedOld !== null) {
        totalExpectedOld += c.expectedCount;
      }
      hasOldExpected = true;
    } else {
      if (c.firstAvailable !== null) {
        totalExpectedOld = null;
      }
    }
  }

  if (!hasRequestedExpected) {
    totalRequestedExpected = null;
  }
  if (!hasAvailable) {
    totalAvailableInRequested = null;
  }
  if (!hasOldExpected) {
    totalExpectedOld = null;
  }

  let totalMissingRequested: number | null = null;
  let overallCoverageRatio: number | null = null;

  if (totalRequestedExpected !== null && totalAvailableInRequested !== null && totalRequestedExpected > 0) {
    totalMissingRequested = totalRequestedExpected - totalAvailableInRequested;
    if (totalMissingRequested < 0) totalMissingRequested = 0;
    overallCoverageRatio = totalAvailableInRequested / totalRequestedExpected;
    // Never >1
    if (overallCoverageRatio > 1) overallCoverageRatio = 1;
    if (overallCoverageRatio < 0) overallCoverageRatio = 0;
  }

  let totalMissingOld: number | null = null;
  if (totalExpectedOld !== null && totalExpectedOld > 0) {
    totalMissingOld = totalExpectedOld - totalDistinctReturned;
    if (totalMissingOld < 0) totalMissingOld = 0;
  }

  return Object.freeze({
    markets: Object.freeze([...sorted]),
    totalReturned,
    totalDistinctReturned,
    totalRequestedExpected,
    totalAvailableInRequested,
    totalExpected: totalExpectedOld,
    totalMissing: totalMissingOld,
    totalMissingRequested,
    overallCoverageRatio,
    emptyMarkets,
    marketsWithAnomalies,
    isTimeframeValid,
  });
}
