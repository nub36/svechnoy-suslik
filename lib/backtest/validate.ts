/**
 * P2-A — валидация входа: бары и решения.
 *
 * Политика (см. contract.ts, пункты 1 и 4):
 *  - вход НЕ сортируется и НЕ дедуплицируется: дубликат time или
 *    немонотонность — структурированная ошибка, прогон не выполняется;
 *  - пропуски в сетке допускаются (учитываются в метаданных), если не
 *    заданы requireUniformGrid / expectedTimeframeMs;
 *  - все цены конечны и > 0, OHLC-инварианты соблюдены;
 *  - уровни сделки проверяются ДВУЖДЫ: структурно (конечность, > 0,
 *    sl ≠ tp) при принятии решения и по стороне/пробою — относительно
 *    open бара входа (это делает engine.ts).
 *
 * Никаких «починок» данных: честный бэктест не начинается с молчаливой
 * нормализации входа.
 */

import {
  type BacktestBar,
  type EntryDecision,
  type ResolvedBacktestConfig,
  isFiniteNumber
} from "./contract";

export interface BarsValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** Шаг сетки, если все дельты одинаковы; иначе null. */
  readonly timeframeMs: number | null;
  /** Число дельт, превышающих минимальную (пропуски в сетке). */
  readonly gridGaps: number;
  readonly maxGapMs: number | null;
  readonly minGapMs: number | null;
  readonly firstBarTime: number | null;
  readonly lastBarTime: number | null;
}

const MAX_REPORTED_ERRORS = 20;

function pushLimited(errors: string[], message: string): void {
  if (errors.length < MAX_REPORTED_ERRORS) {
    errors.push(message);
  } else if (errors.length === MAX_REPORTED_ERRORS) {
    errors.push("… (остальные ошибки опущены)");
  }
}

function barLabel(bar: BacktestBar, index: number): string {
  return `bars[${String(index)}] time=${String(bar.time)}`;
}

/** Проверка одного бара: конечность, положительность, OHLC-инварианты. */
export function validateBarShape(
  bar: unknown,
  index: number,
  errors: string[]
): void {
  if (bar === null || typeof bar !== "object") {
    pushLimited(errors, `bars[${String(index)}]: не объект`);

    return;
  }

  const candidate = bar as Partial<BacktestBar>;

  if (
    !isFiniteNumber(candidate.time) ||
    !Number.isInteger(candidate.time) ||
    candidate.time <= 0
  ) {
    pushLimited(
      errors,
      `bars[${String(index)}]: time должен быть целым > 0 (openTime, мс UTC)`
    );
  }

  for (const field of ["open", "high", "low", "close"] as const) {
    const value = candidate[field];

    if (!isFiniteNumber(value)) {
      pushLimited(errors, `bars[${String(index)}]: ${field} не конечное число`);
    } else if (value <= 0) {
      pushLimited(errors, `bars[${String(index)}]: ${field} должен быть > 0`);
    }
  }

  if (
    isFiniteNumber(candidate.high) &&
    isFiniteNumber(candidate.low) &&
    isFiniteNumber(candidate.open) &&
    isFiniteNumber(candidate.close)
  ) {
    const { high, low, open, close } = candidate as {
      high: number;
      low: number;
      open: number;
      close: number;
    };

    if (high < low) {
      pushLimited(errors, `${barLabel(bar as BacktestBar, index)}: high < low`);
    }

    if (high < Math.max(open, close)) {
      pushLimited(
        errors,
        `${barLabel(bar as BacktestBar, index)}: high < max(open, close)`
      );
    }

    if (low > Math.min(open, close)) {
      pushLimited(
        errors,
        `${barLabel(bar as BacktestBar, index)}: low > min(open, close)`
      );
    }
  }

  if (
    candidate.volume !== undefined &&
    (!isFiniteNumber(candidate.volume) || candidate.volume < 0)
  ) {
    pushLimited(
      errors,
      `bars[${String(index)}]: volume должен быть конечным ≥ 0 или отсутствовать`
    );
  }
}

/**
 * Валидация последовательности баров.
 *
 * Пустой массив — ошибка: метрики по пустому набору не имеют смысла, а
 * «нуль сделок» как корректный исход возникает из сигналов, не из данных.
 */
export function validateBars(
  bars: readonly BacktestBar[],
  config: ResolvedBacktestConfig
): BarsValidation {
  const errors: string[] = [];

  if (!Array.isArray(bars)) {
    return {
      ok: false,
      errors: ["bars: ожидается массив свечей"],
      timeframeMs: null,
      gridGaps: 0,
      maxGapMs: null,
      minGapMs: null,
      firstBarTime: null,
      lastBarTime: null
    };
  }

  if (bars.length === 0) {
    return {
      ok: false,
      errors: ["bars: пустой набор свечей (нужен хотя бы один закрытый бар)"],
      timeframeMs: null,
      gridGaps: 0,
      maxGapMs: null,
      minGapMs: null,
      firstBarTime: null,
      lastBarTime: null
    };
  }

  bars.forEach((bar, index) => {
    validateBarShape(bar, index, errors);
  });

  let timeframeMs: number | null = null;
  let uniform = true;
  let gaps = 0;
  let maxGap: number | null = null;
  let minGap: number | null = null;

  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1];
    const curr = bars[i];

    if (
      !isFiniteNumber(prev.time) ||
      !isFiniteNumber(curr.time)
    ) {
      continue;
    }

    const delta = curr.time - prev.time;

    if (delta === 0) {
      pushLimited(
        errors,
        `bars[${String(i)}]: дубликат time=${String(curr.time)} — вход не дедуплицируется молча`
      );
      uniform = false;

      continue;
    }

    if (delta < 0) {
      pushLimited(
        errors,
        `bars[${String(i)}]: немонотонность time (${String(prev.time)} → ${String(curr.time)}) — вход не сортируется молча`
      );
      uniform = false;

      continue;
    }

    if (timeframeMs === null) {
      timeframeMs = delta;
    } else if (delta !== timeframeMs) {
      uniform = false;
    }

    if (minGap === null || delta < minGap) {
      minGap = delta;
    }

    if (maxGap === null || delta > maxGap) {
      maxGap = delta;
    }

    if (timeframeMs !== null && delta > timeframeMs) {
      gaps += 1;
    }
  }

  if (config.requireUniformGrid && !uniform && bars.length > 1) {
    pushLimited(
      errors,
      "requireUniformGrid: сетка time неравномерна (пропуски/дубликаты/немонотонность)"
    );
  }

  if (
    config.expectedTimeframeMs !== null &&
    timeframeMs !== null &&
    minGap !== null
  ) {
    // Ожидаемый шаг: КАЖДАЯ дельта обязана быть ему кратна и не меньше.
    for (let i = 1; i < bars.length; i += 1) {
      const delta = bars[i].time - bars[i - 1].time;

      if (delta <= 0) {
        continue;
      }

      if (
        delta < config.expectedTimeframeMs ||
        delta % config.expectedTimeframeMs !== 0
      ) {
        pushLimited(
          errors,
          `bars[${String(i)}]: дельта ${String(delta)} мс не кратна expectedTimeframeMs=${String(config.expectedTimeframeMs)}`
        );

        break;
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    timeframeMs: uniform ? timeframeMs : null,
    gridGaps: gaps,
    maxGapMs: maxGap,
    minGapMs: minGap,
    firstBarTime: bars.length > 0 ? bars[0].time : null,
    lastBarTime: bars.length > 0 ? bars[bars.length - 1].time : null
  };
}

export type DecisionShapeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid-decision"; readonly detail: string };

/**
 * Структурная проверка LONG/SHORT-решения: конечные положительные цены,
 * sl ≠ tp. Проверка СТОРОНЫ выполняется отдельно — относительно open
 * бара входа (engine.ts), потому что на момент решения open ещё неизвестен.
 */
export function validateEntryDecisionShape(
  decision: EntryDecision
): DecisionShapeCheck {
  if (!isFiniteNumber(decision.stopLoss) || decision.stopLoss <= 0) {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: "stopLoss должен быть конечным числом > 0"
    };
  }

  if (!isFiniteNumber(decision.takeProfit) || decision.takeProfit <= 0) {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: "takeProfit должен быть конечным числом > 0"
    };
  }

  if (decision.stopLoss === decision.takeProfit) {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: "stopLoss не может равняться takeProfit"
    };
  }

  return { ok: true };
}

/** Проверка границ сегмента относительно набора баров. */
export function validateSegmentWindow(
  barsCount: number,
  startIndex: number,
  endIndexExclusive: number
): readonly string[] {
  const errors: string[] = [];

  if (!Number.isInteger(startIndex) || startIndex < 0) {
    errors.push("segment.startIndex: целое ≥ 0");
  }

  if (!Number.isInteger(endIndexExclusive)) {
    errors.push("segment.endIndexExclusive: целое");
  }

  if (endIndexExclusive > barsCount) {
    errors.push(
      `segment.endIndexExclusive=${String(endIndexExclusive)} за пределами bars (${String(barsCount)})`
    );
  }

  if (startIndex >= endIndexExclusive) {
    errors.push("segment: startIndex должен быть < endIndexExclusive");
  }

  return errors;
}
