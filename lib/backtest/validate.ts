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
 *    open бара входа (это делает engine.ts);
 *  - решение источника сигналов проверяется ПО СНИМКУ
 *    (`captureSignalDecision`, contract.ts п. 23): этот модуль читает
 *    уровни как `unknown` и никогда не обращается к исходному объекту;
 *  - контейнер `signals` классифицируется СТРОГО (п. 24): Array
 *    решений, функция-провайдер или валидный SignalAdapter — всё
 *    остальное отказ, а не «пустой список сигналов».
 *
 * Никаких «починок» данных: честный бэктест не начинается с молчаливой
 * нормализации входа.
 */

import {
  type BacktestBar,
  type ResolvedBacktestConfig,
  type SignalAdapter,
  type SignalDecisionList,
  type SignalProvider,
  type SignalSource,
  describeValue,
  isFiniteNumber,
  signalProviderFromList
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
  | {
      readonly ok: true;
      /** Проверенные уровни — числа; движок обязан брать ИХ, а не сырое решение. */
      readonly stopLoss: number;
      readonly takeProfit: number;
    }
  | { readonly ok: false; readonly reason: "invalid-decision"; readonly detail: string };

/**
 * Структурная проверка ПОЛЯ решения, прочитанных ОДИН раз
 * (`captureSignalDecision`, contract.ts п. 23): kind — один из четырёх
 * литералов, label — строка (если задан), facts — настоящий массив
 * строк (если задан) — выполняются на этапе снимка, а не здесь, потому
 * что там они читаются из исходного объекта ровно по одному разу.
 *
 * `validateDecisionObject` из p2a-1.1.0 УДАЛЁН: он дублировал эти
 * проверки и читал поля повторно (TOCTOU-окно). Единственная точка
 * входа — снимок.
 */

/**
 * Проверка адаптера источника решений (пункт 19 политики): идентичность
 * объявлена, требуемая история — целое ≥ 1, решающая функция на месте.
 */
/** Ключи, которые обязан иметь адаптер (и только их). */
const ADAPTER_KEYS: readonly string[] = Object.freeze([
  "adapterId",
  "version",
  "requiredLookbackBars",
  "decide"
]);

export type AdapterCheck =
  | { readonly ok: true; readonly adapter: SignalAdapter }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Читает адаптер источника решений в замороженный plain-снимок.
 *
 * Пункт 23 политики применяется и к адаптеру: каждое поле читается
 * РОВНО ОДИН РАЗ, поэтому геттер не может пройти валидацию одной
 * функцией `decide`, а движку отдать другую, и `requiredLookbackBars`
 * не может «подрасти» после проверки (warmup считается по снимку).
 * Тексты ошибок совпадают с прежней `validateSignalAdapter`.
 */
export function captureSignalAdapter(raw: unknown): AdapterCheck {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["adapter: ожидается объект"] };
  }

  const source = raw as Record<string, unknown>;
  const errors: string[] = [];

  /* ---- одиночные чтения ---- */

  const adapterId: unknown = source.adapterId;
  const version: unknown = source.version;
  const requiredLookbackBars: unknown = source.requiredLookbackBars;
  const decide: unknown = source.decide;
  const ownKeys = Object.keys(source);

  if (typeof adapterId !== "string" || adapterId.trim().length === 0) {
    errors.push(
      "adapter.adapterId: непустая строка (идентичность источника решений)"
    );
  }

  if (typeof version !== "string" || version.trim().length === 0) {
    errors.push("adapter.version: непустая строка");
  }

  if (
    !Number.isInteger(requiredLookbackBars) ||
    (requiredLookbackBars as number) < 1
  ) {
    errors.push(
      "adapter.requiredLookbackBars: целое ≥ 1 (1 — только текущий бар; требование истории ОБЯЗАНО быть явным)"
    );
  }

  if (typeof decide !== "function") {
    errors.push("adapter.decide: функция (context) → решение");
  }

  for (const key of ownKeys) {
    if (!ADAPTER_KEYS.includes(key)) {
      errors.push(
        `adapter: неизвестный ключ "${key}" (допустимы: ${ADAPTER_KEYS.join(", ")})`
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    adapter: Object.freeze({
      adapterId: adapterId as string,
      version: version as string,
      requiredLookbackBars: requiredLookbackBars as number,
      decide: decide as SignalProvider
    })
  };
}

/**
 * Структурная проверка адаптера (пункт 19 политики) — тонкая обёртка над
 * `captureSignalAdapter`: сообщения об ошибках живут в одном месте.
 * Возвращает список ошибок (пустой = валиден).
 */
export function validateSignalAdapter(adapter: SignalAdapter): readonly string[] {
  const check = captureSignalAdapter(adapter);

  return check.ok ? [] : check.errors;
}

/* ------------------------------------------------------------------ */
/* Строгая классификация контейнера решений (пункт 24 политики)         */
/* ------------------------------------------------------------------ */

export type SignalSourceCheck =
  | {
      readonly ok: true;
      readonly kind: "adapter";
      /** Замороженный снимок адаптера (поля прочитаны по одному разу). */
      readonly adapter: SignalAdapter;
      readonly provider: SignalProvider;
    }
  | { readonly ok: true; readonly kind: "provider"; readonly provider: SignalProvider }
  | {
      readonly ok: true;
      readonly kind: "list";
      readonly decisions: SignalDecisionList;
      readonly provider: SignalProvider;
    }
  | {
      readonly ok: false;
      /**
       * `"signals"` — контейнер не является ни массивом, ни функцией, ни
       * объектом, похожим на адаптер; `"adapter"` — похож на адаптер, но
       * невалиден (в том числе опечатка `Decide`).
       */
      readonly stage: "signals" | "adapter";
      readonly errors: readonly string[];
    };

/**
 * Ключи собственного набора объекта, по которым он «похож на адаптер».
 *
 * Перечисление ключей геттеры не вызывает. Ключ, отличающийся от
 * `decide` только регистром (`Decide`, `DECIDE`), считается ОПЕЧАТКОЙ
 * адаптера: такой объект обязан упасть как невалидный адаптер
 * (stage `"adapter"`), а не как «неизвестный контейнер».
 */
function adapterHintKeys(source: object): {
  readonly adapterLike: boolean;
  readonly typoKeys: readonly string[];
} {
  let keys: readonly (string | symbol)[];

  try {
    keys = Reflect.ownKeys(source);
  } catch (_error) {
    // hostile ownKeys-ловушка: объект не похож на адаптер и будет
    // отклонён как недопустимый контейнер.
    keys = [];
  }

  const own = keys.filter((key): key is string => typeof key === "string");
  const typoKeys = own.filter(
    (key) => key !== "decide" && key.toLowerCase() === "decide"
  );

  /**
   * Ключи адаптера ищутся и в прототипе (`in` не вызывает геттеры):
   * класс-стратегия с методом `decide` в прототипе обязана упасть как
   * НЕВАЛИДНЫЙ АДАПТЕР (stage "adapter"), а не как «неизвестный
   * контейнер». Map/Set/Date ни одного из этих ключей не имеют.
   */
  const inherited = ADAPTER_KEYS.filter((key) => {
    try {
      return key in source;
    } catch (_error) {
      return false;
    }
  });

  return {
    adapterLike: inherited.length > 0 || typoKeys.length > 0,
    typoKeys
  };
}

/** Признаки «объекта, похожего на массив» — только для текста ошибки. */
function looksArrayLike(source: object): boolean {
  const record = source as Record<string, unknown>;

  if (typeof record.length === "number") {
    return true;
  }

  try {
    return Object.keys(source).some((key) => /^(0|[1-9][0-9]*)$/.test(key));
  } catch (_error) {
    return false;
  }
}

function containerError(source: unknown): readonly string[] {
  const errors: string[] = [
    `signals: недопустимый контейнер источника решений (${describeValue(
      source
    )}) — допустимы ТОЛЬКО настоящий Array решений, функция-провайдер (context) → решение либо валидный SignalAdapter { adapterId, version, requiredLookbackBars, decide }`
  ];

  if (source !== null && typeof source === "object") {
    if (looksArrayLike(source as object)) {
      errors.push(
        "signals: объект, ПОХОЖИЙ на массив (length/числовые ключи), массивом не считается — передайте настоящий Array"
      );
    }

    if (source instanceof Map || source instanceof Set) {
      errors.push(
        "signals: Map/Set не являются допустимым контейнером решений — передайте Array.from(...) решений, функцию-провайдер или адаптер"
      );
    }
  }

  errors.push(
    "signals: молчаливое превращение недопустимого контейнера в «сигналов нет» (ok:true, 0 сделок) запрещено"
  );

  return errors;
}

/**
 * СТРОГАЯ классификация контейнера `signals` (пункт 24 политики).
 *
 * Допустимы ровно три формы: (A) настоящий `Array` решений, (B)
 * функция-провайдер, (C) валидный `SignalAdapter`. Всё остальное —
 * структурированный отказ: недопустимый контейнер даёт stage
 * `"signals"`, объект, похожий на адаптер, но невалидный (нет `decide`,
 * опечатка `Decide`, мусорные поля) — stage `"adapter"`. Никакого
 * «общего объектного» fallback и никакого превращения мусора в пустой
 * список решений больше нет.
 */
export function classifySignalSource(source: unknown): SignalSourceCheck {
  // (B) функция-провайдер.
  if (typeof source === "function") {
    return { ok: true, kind: "provider", provider: source as SignalProvider };
  }

  // (A) НАСТОЯЩИЙ массив решений (содержимое проверяется по bar-ам).
  if (Array.isArray(source)) {
    const decisions = source as SignalDecisionList;

    return {
      ok: true,
      kind: "list",
      decisions,
      provider: signalProviderFromList(decisions)
    };
  }

  if (source === null || typeof source !== "object") {
    return { ok: false, stage: "signals", errors: containerError(source) };
  }

  const candidate = source as object;
  const hint = adapterHintKeys(candidate);

  // (C) объект, похожий на адаптер: снимок + строгая валидация.
  if (hint.adapterLike) {
    const check = captureSignalAdapter(candidate);

    if (!check.ok) {
      const errors = [...check.errors];

      if (hint.typoKeys.length > 0) {
        errors.push(
          `adapter: ключ ${hint.typoKeys
            .map((key) => `"${key}"`)
            .join(", ")} не является "decide" (регистр имеет значение)`
        );
      }

      return { ok: false, stage: "adapter", errors };
    }

    return {
      ok: true,
      kind: "adapter",
      adapter: check.adapter,
      provider: check.adapter.decide
    };
  }

  return { ok: false, stage: "signals", errors: containerError(source) };
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
  limit = 20,
  visited?: WeakSet<object>
): readonly string[] {
  const found: string[] = [];
  const seen = visited ?? new WeakSet<object>();

  /**
   * Рекурсия БЕЙЗ ограничителя глубины: срез `depth > 8` (p2a-1.1.0)
   * означал, что неконечное число глубже 8 уровней не находилось, то
   * есть проверка конечности результата была неполной. Циклические
   * ссылки вместо этого отсекаются через `seen` (каждый объект
   * посещается один раз), поэтому обход конечен для любого конечного
   * графа, а полнота не зависит от вложенности. Единственное
   * ограничение — `limit` на число СООБЩЕНИЙ (не на обход).
   */
  const walk = (node: unknown, nodePath: string): void => {
    if (found.length >= limit) {
      // Сообщений достаточно: любое найденное значение уже означает
      // отказ, поэтому полный обход дальше не нужен.
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

    const target = node as object;

    if (seen.has(target)) {
      return;
    }

    seen.add(target);

    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        walk(node[i], `${nodePath}[${String(i)}]`);
      }

      return;
    }

    for (const key of Object.keys(node as Record<string, unknown>)) {
      walk((node as Record<string, unknown>)[key], `${nodePath}.${key}`);
    }
  };

  walk(value, path);

  return found;
}

/** Уровни, уже прочитанные в снимок решения (значения — как прочитаны). */
export interface CapturedLevels {
  readonly stopLoss: unknown;
  readonly takeProfit: unknown;
}

/**
 * Структурная проверка LONG/SHORT-решения: конечные положительные цены,
 * sl ≠ tp. Проверка СТОРОНЫ выполняется отдельно — относительно open
 * бара входа (engine.ts), потому что на момент решения open ещё неизвестен.
 *
 * Принимает СНИМОК уровней (п. 23 политики): типы полей `unknown`,
 * поэтому сюда нельзя передать «сырой» объект решения с геттерами, не
 * потеряв тип. При успехе возвращает ПРОВЕРЕННЫЕ ЧИСЛА — движок обязан
 * исполнять именно их, а не перечитывать решение.
 */
export function validateEntryDecisionShape(
  levels: CapturedLevels
): DecisionShapeCheck {
  // Локальные копии: единственное чтение каждого поля уже произошло при
  // создании снимка, здесь перечитывания не добавляются.
  const stopLoss: unknown = levels.stopLoss;
  const takeProfit: unknown = levels.takeProfit;

  if (!isFiniteNumber(stopLoss) || stopLoss <= 0) {
    return {
      ok: false,
      reason: "invalid-decision",
      // Значение приводится в тексте: в записи отказа неконечные уровни
      // нормализуются в null (пункт 17), поэтому причина обязана быть
      // видна здесь.
      detail: `stopLoss должен быть конечным числом > 0 (получено ${describeValue(stopLoss)})`
    };
  }

  if (!isFiniteNumber(takeProfit) || takeProfit <= 0) {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: `takeProfit должен быть конечным числом > 0 (получено ${describeValue(takeProfit)})`
    };
  }

  if (stopLoss === takeProfit) {
    return {
      ok: false,
      reason: "invalid-decision",
      detail: "stopLoss не может равняться takeProfit"
    };
  }

  return { ok: true, stopLoss, takeProfit };
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
