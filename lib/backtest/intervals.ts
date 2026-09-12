/**
 * P2-B — непрерывные интервалы и общие окна.
 *
 * Чистый детерминированный слой.
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
 * Сортировка: входные бары могут быть неупорядочены; для поиска
 * contiguous мы сортируем копию по time ASC детерминированно, но
 * исходные anomalies (ordering violations) уже пойманы в gaps.ts и не
 * скрываются здесь. То есть intervals — это интерпретация идеального
 * порядка, а факт нарушения порядка — отдельный сигнал в coverage.
 */

import type { BacktestBar } from "./contract";

export interface ContiguousRange {
  readonly startTime: number;
  readonly endTime: number;
  readonly count: number;
  /** Индекс первого бара в отсортированном порядке. */
  readonly startIndex: number;
  /** Индекс последнего бара. */
  readonly endIndex: number;
  /** Удовлетворяет ли minBars, если задан. */
  readonly isUsable: boolean;
  /** Применённый minBars (null если не задан). */
  readonly minBarsApplied: number | null;
}

/**
 * Найти непрерывные диапазоны в одном рынке.
 *
 * @param bars — бары (могут быть неупорядочены, сортируем копию)
 * @param timeframeMs — шаг сетки
 * @param minBars — опциональный минимум из P2-A (minBarsPerSegment) или
 *                  другой явный минимум; если null/undefined — все usable
 */
export function findContiguousIntervals(
  bars: readonly BacktestBar[],
  timeframeMs: number,
  minBars?: number | null
): ContiguousRange[] {
  if (bars.length === 0) return [];
  if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) return [];

  const sorted = [...bars].sort((a, b) => a.time - b.time);

  const ranges: ContiguousRange[] = [];
  let rangeStartIdx = 0;
  let rangeStartTime = sorted[0].time;

  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i].time - sorted[i - 1].time;

    if (delta === timeframeMs) {
      continue;
    }

    // Разрыв — закрыть текущий диапазон
    const count = i - rangeStartIdx;
    const endTime = sorted[i - 1].time;
    const minApplied = minBars ?? null;
    const isUsable = minApplied === null ? true : count >= minApplied;

    ranges.push({
      startTime: rangeStartTime,
      endTime,
      count,
      startIndex: rangeStartIdx,
      endIndex: i - 1,
      isUsable,
      minBarsApplied: minApplied,
    });

    rangeStartIdx = i;
    rangeStartTime = sorted[i].time;
  }

  // Последний диапазон
  const lastCount = sorted.length - rangeStartIdx;
  const lastEndTime = sorted[sorted.length - 1].time;
  const minApplied = minBars ?? null;

  ranges.push({
    startTime: rangeStartTime,
    endTime: lastEndTime,
    count: lastCount,
    startIndex: rangeStartIdx,
    endIndex: sorted.length - 1,
    isUsable: minApplied === null ? true : lastCount >= minApplied,
    minBarsApplied: minApplied,
  });

  return ranges;
}

/**
 * Найти общие timestamps, присутствующие во всех рынках.
 * Вход: Map marketId -> bars.
 * Выход: отсортированный список общих времен и их contiguous интервалы.
 */
export interface CommonInterval {
  readonly startTime: number;
  readonly endTime: number;
  readonly count: number;
  readonly times: readonly number[];
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

  return result;
}

export function findCommonContiguousIntervals(
  perMarketBars: ReadonlyMap<number, readonly BacktestBar[]>,
  timeframeMs: number,
  minBars?: number | null
): CommonInterval[] {
  const commonTimes = findCommonTimestamps(perMarketBars);

  if (commonTimes.length === 0) return [];
  if (!Number.isFinite(timeframeMs) || timeframeMs <= 0) {
    return [
      {
        startTime: commonTimes[0],
        endTime: commonTimes[commonTimes.length - 1],
        count: commonTimes.length,
        times: commonTimes,
      },
    ];
  }

  const intervals: CommonInterval[] = [];
  let startIdx = 0;

  for (let i = 1; i < commonTimes.length; i += 1) {
    const delta = commonTimes[i] - commonTimes[i - 1];

    if (delta === timeframeMs) continue;

    const slice = commonTimes.slice(startIdx, i);
    const minApplied = minBars ?? null;
    const isUsable = minApplied === null ? true : slice.length >= minApplied;

    if (isUsable) {
      intervals.push({
        startTime: slice[0],
        endTime: slice[slice.length - 1],
        count: slice.length,
        times: slice,
      });
    }

    startIdx = i;
  }

  const lastSlice = commonTimes.slice(startIdx);
  const minApplied = minBars ?? null;
  const lastUsable = minApplied === null ? true : lastSlice.length >= minApplied;

  if (lastUsable && lastSlice.length > 0) {
    intervals.push({
      startTime: lastSlice[0],
      endTime: lastSlice[lastSlice.length - 1],
      count: lastSlice.length,
      times: lastSlice,
    });
  }

  return intervals;
}
