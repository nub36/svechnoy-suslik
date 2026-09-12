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
  type SignalAdapter,
  type SignalDecision,
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

  // forEach ПРОПУСКАЕТ дыры разреженного массива, поэтому обход явный:
  // null/undefined/дыра — это невалидный бар, а не повод для TypeError.
  let malformed = 0;

  for (let index = 0; index < bars.length; index += 1) {
    const bar: unknown = bars[index];

    if (bar === null || bar === undefined || typeof bar !== "object") {
      malformed += 1;
      pushLimited(
        errors,
        `bars[${String(index)}]: не объект (получено ${
          bar === undefined && !(index in (bars as unknown as object))
            ? "дыра разреженного массива"
            : String(bar)
        }) — прогон не выполняется`
      );

      continue;
    }

    validateBarShape(bar, index, errors);
  }

  let timeframeMs: number | null = null;
  let uniform = true;
  let gaps = 0;
  let maxGap: number | null = null;
  let minGap: number | null = null;

  for (let i = 1; i < bars.length; i += 1) {
    const prev: unknown = bars[i - 1];
    const curr: unknown = bars[i];

    // Любая невалидная запись уже попала в errors выше: здесь важно не
    // разыменовать null/undefined (fail closed, без uncaught TypeError).
    if (
      prev === null ||
      curr === null ||
      typeof prev !== "object" ||
      typeof curr !== "object" ||
      !isFiniteNumber((prev as BacktestBar).time) ||
      !isFiniteNumber((curr as BacktestBar).time)
    ) {
      continue;
    }

    const prevBar = prev as BacktestBar;
    const currBar = curr as BacktestBar;
    const delta = currBar.time - prevBar.time;

    if (delta === 0) {
      pushLimited(
        errors,
        `bars[${String(i)}]: дубликат time=${String(currBar.time)} — вход не дедуплицируется молча`
      );
      uniform = false;

      continue;
    }

    if (delta < 0) {
      pushLimited(
        errors,
        `bars[${String(i)}]: немонотонность time (${String(prevBar.time)} → ${String(currBar.time)}) — вход не сортируется молча`
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
    minGap !== null &&
    malformed === 0
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
    timeframeMs: uniform && malformed === 0 ? timeframeMs : null,
    gridGaps: gaps,
    maxGapMs: maxGap,
    minGapMs: minGap,
    firstBarTime: timeOfOrNull(bars[0]),
    lastBarTime: timeOfOrNull(bars[bars.length - 1])
  };
}

/** Время бара либо null, если запись невалидна (fail closed, без TypeError). */
function timeOfOrNull(bar: unknown): number | null {
  if (bar === null || bar === undefined || typeof bar !== "object") {
    return null;
  }

  const time = (bar as Partial<BacktestBar>).time;

  return isFiniteNumber(time) ? time : null;
}

export type DecisionShapeCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid-decision"; readonly detail: string };

/**
 * Проверка ЛЮБОГО решения (LONG/SHORT/NEUTRAL/CANNOT_EVALUATE) на баре
 * сигнала: скаляры конечны, label — строка (если задан), facts — массив
 * строк (если задан). Пункт 22 политики: решение проверяется и
 * снэпшотится в момент принятия, поэтому późнейшая мутация объекта
 * вызывающим кодом не меняет запланированную сделку.
 */
export function validateDecisionObject(
  decision: SignalDecision
): DecisionShapeCheck {
  if (decision === null || typeof decision !== "object") {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: "решение должно быть объектом"
    };
  }

  const candidate = decision as { label?: unknown; facts?: unknown };

  if (candidate.label !== undefined && typeof candidate.label !== "string") {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: `label должен быть строкой (получено ${typeof candidate.label})`
    };
  }

  if (candidate.facts !== undefined) {
    if (!Array.isArray(candidate.facts)) {
      return {
        ok: false,
        reason: "invalid-decision",
        detail: `facts должен быть массивом строк (получено ${typeof candidate.facts})`
      };
    }

    for (const fact of candidate.facts as unknown[]) {
      if (typeof fact !== "string") {
        return {
          ok: false,
          reason: "invalid-decision",
          detail: `facts должен содержать только строки (получено ${typeof fact})`
        };
      }
    }
  }

  return { ok: true };
}

/**
 * Проверка адаптера источника решений (пункт 19 политики): идентичность
 * объявлена, требуемая история — целое ≥ 1, решающая функция на месте.
 */
export function validateSignalAdapter(adapter: SignalAdapter): readonly string[] {
  const errors: string[] = [];

  if (adapter === null || typeof adapter !== "object" || Array.isArray(adapter)) {
    return ["adapter: ожидается объект"];
  }

  if (typeof adapter.adapterId !== "string" || adapter.adapterId.trim().length === 0) {
    errors.push("adapter.adapterId: непустая строка (идентичность источника решений)");
  }

  if (typeof adapter.version !== "string" || adapter.version.trim().length === 0) {
    errors.push("adapter.version: непустая строка");
  }

  if (
    !Number.isInteger(adapter.requiredLookbackBars) ||
    adapter.requiredLookbackBars < 1
  ) {
    errors.push(
      "adapter.requiredLookbackBars: целое ≥ 1 (1 — только текущий бар; требование истории ОБЯЗАНО быть явным)"
    );
  }

  if (typeof adapter.decide !== "function") {
    errors.push("adapter.decide: функция (context) → решение");
  }

  const known = ["adapterId", "version", "requiredLookbackBars", "decide"];

  for (const key of Object.keys(adapter)) {
    if (!known.includes(key)) {
      errors.push(
        `adapter: неизвестный ключ "${key}" (допустимы: ${known.join(", ")})`
      );
    }
  }

  return errors;
}

/**
 * Поиск неконечных чисел в структуре результата (пункт 17 политики).
 *
 * Возвращает пути до значений (не более limit), чтобы отказ был
 * diagnosable: «NaN в metrics.maxDrawdown» вместо молчаливого
 * «красивого» результата, который затем роняет сериализацию.
 *
 * Исключений нет: успешный результат (ok = true) обязан быть конечным
 * ЦЕЛИКОМ, иначе serializeResult бросил бы исключение на «успешном»
 * прогоне. Неконечные уровни входного решения нормализуются в null ещё
 * при записи отказа (engine.ts), а причина сохраняется в detail.
 */
export function findNonFiniteNumbers(
  value: unknown,
  path = "result",
  limit = 20
): readonly string[] {
  const found: string[] = [];

  const walk = (node: unknown, nodePath: string, depth: number): void => {
    if (found.length >= limit || depth > 8) {
      return;
    }

    if (typeof node === "number") {
      if (!Number.isFinite(node)) {
        found.push(`${nodePath} = ${String(node)}`);
      }

      return;
    }

    if (node === null || typeof node !== "object") {
      return;
    }

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${nodePath}[${String(i)}]`, depth + 1);
      }

      return;
    }

    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk(
        (node as Record<string, unknown>)[key],
        `${nodePath}.${key}`,
        depth + 1
      );
    }
  };

  walk(value, path, 0);

  return found;
}

/**
 * Структурная проверка LONG/SHORT-решения: конечные положительные цены,
 * sl ≠ tp. Проверка СТОРОНЫ выполняется отдельно — относительно open
 * бара входа (engine.ts), потому что на момент решения open ещё неизвестен.
 */
export function validateEntryDecisionShape(
  decision: EntryDecision
): DecisionShapeCheck {
  const common = validateDecisionObject(decision);

  if (!common.ok) {
    return common;
  }

  if (!isFiniteNumber(decision.stopLoss) || decision.stopLoss <= 0) {
    return {
      ok: false,
      reason: "invalid-decision",
      // Значение приводится в тексте: в записи отказа неконечные уровни
      // нормализуются в null (пункт 17), поэтому причина обязана быть
      // видна здесь.
      detail: `stopLoss должен быть конечным числом > 0 (получено ${String(decision.stopLoss)})`
    };
  }

  if (!isFiniteNumber(decision.takeProfit) || decision.takeProfit <= 0) {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: `takeProfit должен быть конечным числом > 0 (получено ${String(decision.takeProfit)})`
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
