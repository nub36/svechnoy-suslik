/**
 * P2-B — обнаружение дыр, дубликатов, порядка и сетки.
 *
 * Чистый детерминированный слой, без БД, без сети, без Date.now().
 * Работает поверх REAL P2-A BacktestBar (time ms).
 *
 * Источник длительности таймфрейма — единственный: SMCTIMEFRAME_MS
 * из lib/smc/types.ts (не второй набор констант). P2-B принимает
 * timeframeMs как число, полученное из этого источника, и никогда
 * не хардкодит свои 5m/1h и т.д.
 *
 * Правила:
 * - duplicate = одинаковый time встречается >1 раза (ошибка, не дедуп)
 * - non-monotonic = time <= prevTime (ошибка, не сортировка)
 * - gap: delta > timeframeMs (пропуск) или delta < timeframeMs но !=
 *   timeframeMs (неожиданная плотность) или delta % timeframeMs !=0
 *   (off-multiple)
 * - off-grid: time % timeframeMs !=0 (BINGX 1d 16:00 UTC → 57600000 mod)
 * - никакого silent fix: только отчёт или ошибка выше по стеку
 * - unknown/invalid timeframe = explicit invalid, never healthy defaults
 */

import type { BacktestBar } from "./contract";

export interface Gap {
  readonly prevIndex: number;
  readonly nextIndex: number;
  readonly prevTime: number;
  readonly nextTime: number;
  readonly deltaMs: number;
  readonly expectedMs: number;
  readonly missingBars: number;
  readonly isMultiple: boolean;
  readonly isShort: boolean;
}

export interface DuplicateGroup {
  readonly time: number;
  readonly indices: readonly number[];
  readonly count: number;
}

export interface OrderingViolation {
  readonly index: number;
  readonly prevTime: number;
  readonly currTime: number;
  readonly prevIndex: number;
}

export interface GridAnomaly {
  readonly index: number;
  readonly time: number;
  readonly remainder: number;
}

export function isValidTimeframeMs(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

/**
 * Обнаружение дыр. Предполагает, что массив уже в том порядке, в каком
 * пришёл из БД (ASC). Если порядок нарушен, gap всё равно считается по
 * фактической паре, а ordering violation ловится отдельно.
 * Если timeframeMs invalid → возвращает [] и помечает invalid выше.
 */
export function detectGaps(
  bars: readonly BacktestBar[],
  timeframeMs: number
): Gap[] {
  if (!isValidTimeframeMs(timeframeMs)) {
    return [];
  }

  const gaps: Gap[] = [];

  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const curr = bars[i];
    const delta = curr.time - prev.time;

    if (delta === timeframeMs) {
      continue;
    }

    const isMultiple = delta > 0 && delta % timeframeMs === 0;
    const missingBars = isMultiple ? delta / timeframeMs - 1 : 0;
    const isShort = delta < timeframeMs;

    gaps.push({
      prevIndex: i - 1,
      nextIndex: i,
      prevTime: prev.time,
      nextTime: curr.time,
      deltaMs: delta,
      expectedMs: timeframeMs,
      missingBars,
      isMultiple,
      isShort,
    });
  }

  return gaps;
}

export function detectDuplicates(
  bars: readonly BacktestBar[]
): DuplicateGroup[] {
  const byTime = new Map<number, number[]>();

  for (let i = 0; i < bars.length; i += 1) {
    const t = bars[i].time;
    const list = byTime.get(t);

    if (list) {
      list.push(i);
    } else {
      byTime.set(t, [i]);
    }
  }

  const dups: DuplicateGroup[] = [];

  for (const [time, indices] of byTime.entries()) {
    if (indices.length > 1) {
      dups.push({ time, indices: Object.freeze([...indices]), count: indices.length });
    }
  }

  dups.sort((a, b) => a.time - b.time);

  return Object.freeze(dups) as DuplicateGroup[];
}

export function checkOrdering(
  bars: readonly BacktestBar[]
): { isOrdered: boolean; violations: OrderingViolation[] } {
  const violations: OrderingViolation[] = [];

  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].time;
    const curr = bars[i].time;

    if (curr <= prev) {
      violations.push({
        index: i,
        prevTime: prev,
        currTime: curr,
        prevIndex: i - 1,
      });
    }
  }

  return { isOrdered: violations.length === 0, violations: Object.freeze(violations) as OrderingViolation[] };
}

export function checkGrid(
  bars: readonly BacktestBar[],
  timeframeMs: number
): { isCanonical: boolean; offGrid: GridAnomaly[]; isTimeframeValid: boolean } {
  if (!isValidTimeframeMs(timeframeMs)) {
    // unknown/invalid timeframe must NOT return healthy true/zero
    return { isCanonical: false, offGrid: [], isTimeframeValid: false };
  }

  const off: GridAnomaly[] = [];

  for (let i = 0; i < bars.length; i += 1) {
    const t = bars[i].time;
    const rem = t % timeframeMs;

    if (rem !== 0) {
      off.push({ index: i, time: t, remainder: rem });
    }
  }

  return { isCanonical: off.length === 0, offGrid: Object.freeze(off) as GridAnomaly[], isTimeframeValid: true };
}

export interface MarketAnomalies {
  readonly gaps: Gap[];
  readonly duplicates: DuplicateGroup[];
  readonly ordering: { isOrdered: boolean; violations: OrderingViolation[] };
  readonly grid: { isCanonical: boolean; offGrid: GridAnomaly[]; isTimeframeValid: boolean };
  readonly hasAnomaly: boolean;
  readonly isTimeframeValid: boolean;
}

export function analyzeMarketAnomalies(
  bars: readonly BacktestBar[],
  timeframeMs: number | null
): MarketAnomalies {
  if (!isValidTimeframeMs(timeframeMs)) {
    // fail-open fix: unknown timeframe is explicit invalid, never healthy
    return {
      gaps: [],
      duplicates: detectDuplicates(bars),
      ordering: checkOrdering(bars),
      grid: { isCanonical: false, offGrid: [], isTimeframeValid: false },
      hasAnomaly: true,
      isTimeframeValid: false,
    };
  }

  const gaps = detectGaps(bars, timeframeMs);
  const duplicates = detectDuplicates(bars);
  const ordering = checkOrdering(bars);
  const grid = checkGrid(bars, timeframeMs);

  const hasAnomaly =
    gaps.length > 0 ||
    duplicates.length > 0 ||
    !ordering.isOrdered ||
    !grid.isCanonical ||
    !grid.isTimeframeValid;

  return {
    gaps: Object.freeze(gaps) as Gap[],
    duplicates,
    ordering,
    grid,
    hasAnomaly,
    isTimeframeValid: true,
  };
}
