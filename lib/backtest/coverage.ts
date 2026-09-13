/**
 * P2-B — покрытие по рынку × таймфрейму.
 *
 * Чистый детерминированный слой, без Date.now(). Не ходит в БД, работает поверх
 * BacktestBar[] и timeframeMs (единственный источник — SMCTIMEFRAME_MS).
 *
 * ══════════════════════════════════════════════════════════════════
 * КОНТРАКТ ПОКРЫТИЯ (P2-B HARDENING #2, MANDATORY FIX 1)
 * ══════════════════════════════════════════════════════════════════
 *
 * Выбран ОДИН детерминированный контракт: (B) ожидаемая занятость окна
 * считается по КАНОНИЧЕСКОЙ СЕТКЕ таймфрейма, а не по искусственной
 * сетке, заякоренной на `from` (см. lib/backtest/timeframe.ts:
 * canonicalWindow). Вариант (A) «fail closed на любой невыровненный
 * bound» отклонён сознательно: запросы с произвольными timestamp'ами
 * остаются допустимыми, но их семантика жёстко зафиксирована и видима —
 * «молчаливого healthy 100%» на невыровненном запросе нет.
 *
 *   from <= openTime < to          (to exclusive, конвенция сохранена)
 *   бар = [openTime, openTime + D), каузально закрыт в openTime + D
 *   канонический слот: t % D == 0
 *   effectiveFrom = ceil(from / D) * D  — первое каноническое открытие окна
 *   requestedExpectedCount = |{ t : t % D == 0 ∧ from <= t < to }|
 *   availableInRequestedRange = число DISTINCT канонических слотов окна,
 *                               реально присутствующих в данных
 *   off-grid бары внутри окна (t % D != 0) в available НЕ входят:
 *       они репортятся отдельно (offGridBarsInRequestedRange) и в
 *       anomalies.grid.offGrid — иначе чужая сетка (BINGX 1d 16:00 UTC)
 *       выглядела бы как покрытие канонического окна.
 *   missingLeading  = канонические слоты до первого присутствующего
 *   missingTrailing = канонические слоты после последнего присутствующего
 *   missingInternal = expected − available − leading − trailing
 *   coverageIdentityHolds = (available + leading + internal + trailing == expected)
 *   coverageRatio = available / requestedExpectedCount  (0..1, никогда >1)
 *
 * ИНВАРИАНТ (проверяется тестами и полем coverageIdentityHolds):
 * счётчики, alignment, contiguous и anomaly статусы не противоречат друг
 * другу: available + leading + internal + trailing === expected.
 *
 * FAIL CLOSED:
 * - requestedRange отсутствует            → requested-числа = null (легаси-режим);
 * - from/to невалидны или from >= to      → throw (как и раньше);
 * - окно БЕЗ канонических слотов          → CanonicalWindowError (это не «0%»);
 * - unknown timeframe                     → explicit invalid (не healthy).
 *
 * ALIGNMENT НЕ ВЫЧИСЛЯЕТСЯ И НЕ ОТБРАСЫВАЕТСЯ: `requestedAlignment`
 * содержит isAligned/canonicalized и эффективные границы окна; aggregate,
 * data-plan, report и CLI обязаны его показывать (иначе 100% на
 * невыровненном запросе вводит в заблуждение).
 *
 * Пустой requested range / from>=to — ошибка вызывающего кода.
 */

import type { BacktestBar } from "./contract";
import {
  analyzeMarketAnomalies,
  isValidTimeframeMs,
  type MarketAnomalies,
} from "./gaps";
import { findContiguousIntervals, type ContiguousRange } from "./intervals";
import { canonicalWindow } from "./timeframe";
import { deepFreeze, freezeCopy } from "./immutable";

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
  /**
   * Bounds не на канонической сетке → ожидаемая занятость считалась по
   * канонической сетке (см. контракт в шапке). ОБЯЗАТЕЛЬНО к показу
   * потребителю: canonicalized coverage ≠ coverage произвольной сетки.
   */
  readonly canonicalized: boolean;
  /** Первое каноническое открытие >= from (ms). null, если не применимо. */
  readonly effectiveFrom: number | null;
  /** Граница окна (exclusive, ms); запрос не расширяется. */
  readonly effectiveTo: number | null;
}

export interface MarketCoverage {
  readonly marketId: number;
  readonly timeframe: string;
  readonly timeframeMs: number | null;
  readonly requestedRange: RequestedRange;
  readonly requestedAlignment: RequestedAlignment | null;
  /** Явная база ожидаемых слотов — каноническая сетка таймфрейма. */
  readonly requestedExpectedBasis: "canonical-grid";
  readonly requestedExpectedCount: number | null;
  /** Бары внутри окна, НЕ лежащие на канонической сетке (в available не входят). */
  readonly offGridBarsInRequestedRange: number;
  /**
   * Инвариант счётчиков: available + leading + internal + trailing === expected.
   * false — только при невалидном timeframe/окне (там все числа null).
   */
  readonly coverageIdentityHolds: boolean;
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
  let offGridBarsInRequestedRange = 0;
  let missingTotal: number | null = null;
  let missingLeading: number | null = null;
  let missingTrailing: number | null = null;
  let missingInternal: number | null = null;
  let coverageRatio: number | null = null;
  let requestedAlignment: RequestedAlignment | null = null;
  let isTimeframeValid = isValidTimeframeMs(timeframeMs);
  let internalContiguous = true;
  let coverageIdentityHolds = true;

  if (isRequestedRangeValid && fromMs !== null && toMsVal !== null && isTimeframeValid) {
    const tf = timeframeMs as number;

    // Fail-closed: окно без канонических слотов — ошибка запроса, а не «0%».
    // canonicalWindow бросает CanonicalWindowError и НЕ подменяет границы.
    const window = canonicalWindow(fromMs, toMsVal, tf);

    requestedAlignment = freezeCopy<RequestedAlignment>({
      fromAligned: window.fromAligned,
      toAligned: window.toAligned,
      fromRemainder: window.fromRemainder,
      toRemainder: window.toRemainder,
      isAligned: window.isAligned,
      canonicalized: window.canonicalized,
      effectiveFrom: window.effectiveFromMs,
      effectiveTo: window.effectiveToMs,
    });

    requestedExpectedCount = window.expectedCanonicalSlots;

    // available = DISTINCT канонические слоты окна; off-grid — отдельно.
    let available = 0;
    let offGrid = 0;
    let firstPresent: number | null = null;
    let lastPresent: number | null = null;

    for (const t of distinctSet) {
      if (t < fromMs || t >= toMsVal) continue;

      if (t % tf !== 0) {
        offGrid += 1;
        continue;
      }

      available += 1;
      if (firstPresent === null || t < firstPresent) firstPresent = t;
      if (lastPresent === null || t > lastPresent) lastPresent = t;
    }

    availableInRequestedRange = available;
    offGridBarsInRequestedRange = offGrid;
    missingTotal = Math.max(requestedExpectedCount - available, 0);

    let leading: number;
    let trailing: number;

    if (firstPresent === null || lastPresent === null) {
      // Ни одного канонического слота окна в данных: всё окно «leading».
      leading = requestedExpectedCount;
      trailing = 0;
    } else {
      leading = Math.floor((firstPresent - window.effectiveFromMs) / tf);
      trailing = Math.floor((toMsVal - 1 - lastPresent) / tf);
    }

    missingLeading = leading;
    missingTrailing = trailing;
    missingInternal = Math.max(
      requestedExpectedCount - available - leading - trailing,
      0
    );

    if (requestedExpectedCount > 0) {
      coverageRatio = available / requestedExpectedCount;
      if (coverageRatio > 1) coverageRatio = 1;
    }

    internalContiguous = missingInternal === 0;

    // Инвариант контракта: счётчики обязаны складываться в expected.
    coverageIdentityHolds =
      available + leading + (missingInternal ?? 0) + trailing ===
      requestedExpectedCount;
  } else if (isRequestedRangeValid && !isTimeframeValid) {
    // unknown timeframe → explicit invalid, never healthy
    requestedExpectedCount = null;
    availableInRequestedRange = 0;
    offGridBarsInRequestedRange = 0;
    missingTotal = null;
    missingLeading = null;
    missingTrailing = null;
    missingInternal = null;
    coverageRatio = null;
    requestedAlignment = null;
    internalContiguous = false;
    coverageIdentityHolds = false;
  } else {
    // no requested range provided → old behavior for internal continuity only
    availableInRequestedRange = distinctReturnedCount;
    offGridBarsInRequestedRange = 0;
    requestedExpectedCount = null;
    missingTotal = null;
    missingLeading = null;
    missingTrailing = null;
    missingInternal = null;
    coverageRatio = null;
    requestedAlignment = null;
    internalContiguous = true;
    coverageIdentityHolds = true;
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

  return deepFreeze({
    marketId,
    timeframe,
    timeframeMs,
    requestedRange: deepFreeze({ from: fromMs, to: toMsVal }),
    requestedAlignment,
    requestedExpectedBasis: "canonical-grid" as const,
    requestedExpectedCount,
    availableInRequestedRange,
    offGridBarsInRequestedRange,
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
    coverageIdentityHolds,
    isEmpty,
    isRequestedRangeValid,
    isTimeframeValid,
    anomalies: deepFreeze(anomalies),
    contiguousRanges: deepFreeze([...contiguousRanges]),
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
  /** Явная база ожидаемых слотов агрегата (каноническая сетка). */
  readonly coverageBasis: "canonical-grid";
  /** Рынки, у которых окно было канонизировано (bounds не на сетке). */
  readonly canonicalizedMarkets: number;
  /** Рынки с валидным alignment И выровненным окном. Null — alignment недоступен. */
  readonly alignedMarkets: number | null;
  /** Сумма off-grid баров внутри окна (в available они не входят). */
  readonly offGridBarsInRequestedRange: number;
  /**
   * Агрегатный инвариант счётчиков: у ВСЕХ рынков с валидным окном
   * available + leading + internal + trailing === expected.
   */
  readonly coverageIdentityHolds: boolean;
  /**
   * Итоговое предупреждение: агрегат НЕ является «просто 100%», если окно
   * было канонизировано или есть off-grid бары внутри окна.
   */
  readonly requiresCanonicalWindowDisclosure: boolean;
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
  let canonicalizedMarkets = 0;
  let alignedMarkets = 0;
  let marketsWithAlignment = 0;
  let offGridBarsInRequestedRange = 0;
  let coverageIdentityHolds = true;

  for (const c of sorted) {
    totalReturned += c.returnedCount;
    totalDistinctReturned += c.distinctReturnedCount;

    if (c.isEmpty) emptyMarkets += 1;
    if (c.anomalies.hasAnomaly) marketsWithAnomalies += 1;
    if (!c.isTimeframeValid) isTimeframeValid = false;

    offGridBarsInRequestedRange += c.offGridBarsInRequestedRange;

    if (c.isRequestedRangeValid && c.isTimeframeValid) {
      marketsWithAlignment += 1;
      if (c.requestedAlignment?.canonicalized === true) canonicalizedMarkets += 1;
      if (c.requestedAlignment?.isAligned === true) alignedMarkets += 1;
      if (!c.coverageIdentityHolds) coverageIdentityHolds = false;
    }

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

  return deepFreeze({
    markets: Object.freeze([...sorted]),
    coverageBasis: "canonical-grid" as const,
    canonicalizedMarkets,
    alignedMarkets: marketsWithAlignment > 0 ? alignedMarkets : null,
    offGridBarsInRequestedRange,
    coverageIdentityHolds,
    requiresCanonicalWindowDisclosure:
      canonicalizedMarkets > 0 || offGridBarsInRequestedRange > 0,
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
