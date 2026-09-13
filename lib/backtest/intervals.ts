/**
 * P2-B — непрерывные интервалы и общие окна.
 *
 * Чистый детерминированный слой, без Date.now().
 *
 * Задачи:
 * - найти contiguous usable ranges для одного рынка: где delta == D
 * - найти общие интервалы по нескольким рынкам: timestamp, присутствующий
 *   во всех рынках (intersection), и его contiguous подотрезки
 *
 * Не хардкодит minimumSwingHistoryCandles как универсальный минимум.
 * Если P2-A имеет явное требование minBarsPerSegment — использует его
 * (передаётся параметром). Если нет — просто отчитывается о размерах.
 *
 * Контракт P2-B hardening:
 * - require strictly ordered input; if malformed, refuse interval generation
 *   (return []), do not silently sort anomalies into usable history
 * - use startIndex inclusive, endIndexExclusive exclusive matching P2-A Segment convention
 * - common intervals: do not silently discard below minBars, return with isUsable/reason
 */

import type { BacktestBar } from "./contract";
import { isValidTimeframeMs } from "./gaps";
import { deepFreeze } from "./immutable";

export interface ContiguousRange {
  readonly startTime: number;
  readonly endTime: number;
  /** Inclusive start index in original ordered input */
  readonly startIndex: number;
  /** Exclusive end index (P2-A convention) */
  readonly endIndexExclusive: number;
  /** Inclusive end index for convenience (endIndexExclusive-1) */
  readonly endIndex: number;
  readonly count: number;
  readonly isUsable: boolean;
  readonly minBarsApplied: number | null;
  readonly reason?: string;
}

function isStrictlyOrdered(bars: readonly BacktestBar[]): boolean {
  for (let i = 1; i < bars.length; i += 1) {
    if (bars[i].time <= bars[i - 1].time) return false;
  }
  return true;
}

/**
 * Найти непрерывные диапазоны в одном рынке.
 * Требует строго упорядоченный вход, иначе отказывается генерировать интервалы.
 */
export function findContiguousIntervals(
  bars: readonly BacktestBar[],
  timeframeMs: number,
  minBars?: number | null
): ContiguousRange[] {
  if (bars.length === 0) return [];
  if (!isValidTimeframeMs(timeframeMs)) return [];

  // Require strictly ordered input, do not silently sort
  if (!isStrictlyOrdered(bars)) {
    return [];
  }

  const ranges: ContiguousRange[] = [];
  let rangeStartIdx = 0;
  let rangeStartTime = bars[0].time;

  for (let i = 1; i < bars.length; i += 1) {
    const delta = bars[i].time - bars[i - 1].time;

    if (delta === timeframeMs) {
      continue;
    }

    const count = i - rangeStartIdx;
    const endTime = bars[i - 1].time;
    const minApplied = minBars ?? null;
    const isUsable = minApplied === null ? true : count >= minApplied;

    ranges.push({
      startTime: rangeStartTime,
      endTime,
      count,
      startIndex: rangeStartIdx,
      endIndexExclusive: i,
      endIndex: i - 1,
      isUsable,
      minBarsApplied: minApplied,
      reason: isUsable ? undefined : `count ${count} < minBars ${minApplied}`,
    });

    rangeStartIdx = i;
    rangeStartTime = bars[i].time;
  }

  const lastCount = bars.length - rangeStartIdx;
  const lastEndTime = bars[bars.length - 1].time;
  const minApplied = minBars ?? null;
  const lastUsable = minApplied === null ? true : lastCount >= minApplied;

  ranges.push({
    startTime: rangeStartTime,
    endTime: lastEndTime,
    count: lastCount,
    startIndex: rangeStartIdx,
    endIndexExclusive: bars.length,
    endIndex: bars.length - 1,
    isUsable: lastUsable,
    minBarsApplied: minApplied,
    reason: lastUsable ? undefined : `count ${lastCount} < minBars ${minApplied}`,
  });

  // MANDATORY FIX 4: элементы тоже заморожены (mutation attempts обязаны падать).
  return deepFreeze(ranges) as ContiguousRange[];
}

export interface CommonInterval {
  readonly startTime: number;
  readonly endTime: number;
  readonly count: number;
  readonly times: readonly number[];
  readonly isUsable: boolean;
  readonly minBarsApplied: number | null;
  readonly reason?: string;
}

export function findCommonTimestamps(
  perMarketBars: ReadonlyMap<number, readonly BacktestBar[]>
): number[] {
  if (perMarketBars.size === 0) return [];

  const iter = perMarketBars.values().next();

  if (iter.done) return [];

  const firstBars = iter.value;
  let common = new Set<number>(firstBars.map((b) => b.time));

  for (const bars of perMarketBars.values()) {
    if (bars === firstBars) continue;

    const set = new Set<number>(bars.map((b) => b.time));
    const nextCommon = new Set<number>();

    for (const t of common) {
      if (set.has(t)) nextCommon.add(t);
    }

    common = nextCommon;

    if (common.size === 0) break;
  }

  const result = Array.from(common);
  result.sort((a, b) => a - b);

  // MANDATORY FIX 4: результат публичный и раньше был мутабельным.
  return Object.freeze(result) as number[];
}

export function findCommonContiguousIntervals(
  perMarketBars: ReadonlyMap<number, readonly BacktestBar[]>,
  timeframeMs: number,
  minBars?: number | null
): CommonInterval[] {
  if (!isValidTimeframeMs(timeframeMs)) {
    // fail-open fix: do not fabricate continuous interval when timeframe unknown
    return [];
  }

  const commonTimes = findCommonTimestamps(perMarketBars);

  if (commonTimes.length === 0) return [];

  const intervals: CommonInterval[] = [];
  let startIdx = 0;

  for (let i = 1; i < commonTimes.length; i += 1) {
    const delta = commonTimes[i] - commonTimes[i - 1];

    if (delta === timeframeMs) continue;

    const slice = commonTimes.slice(startIdx, i);
    const minApplied = minBars ?? null;
    const isUsable = minApplied === null ? true : slice.length >= minApplied;

    // Do not silently discard below minBars, return with isUsable flag
    intervals.push({
      startTime: slice[0],
      endTime: slice[slice.length - 1],
      count: slice.length,
      times: Object.freeze([...slice]),
      isUsable,
      minBarsApplied: minApplied,
      reason: isUsable ? undefined : `count ${slice.length} < minBars ${minApplied}`,
    });

    startIdx = i;
  }

  const lastSlice = commonTimes.slice(startIdx);
  const minApplied = minBars ?? null;
  const lastUsable = minApplied === null ? true : lastSlice.length >= minApplied;

  if (lastSlice.length > 0) {
    intervals.push({
      startTime: lastSlice[0],
      endTime: lastSlice[lastSlice.length - 1],
      count: lastSlice.length,
      times: Object.freeze([...lastSlice]),
      isUsable: lastUsable,
      minBarsApplied: minApplied,
      reason: lastUsable ? undefined : `count ${lastSlice.length} < minBars ${minApplied}`,
    });
  }

  return deepFreeze(intervals) as CommonInterval[];
}
