/**
 * SMC Phase 2D — External Dealing Range + Premium/Discount/
 * Equilibrium (V1, swing layer).
 *
 * SOURCE OF TRUTH (новых детекторов НЕТ): range строится
 * ИСКЛЮЧИТЕЛЬНО из evaluateStructure(layer = "swing") и
 * metadata-контракта Phase FSM-metadata:
 *   event.brokenPivotKey / event.brokenLevelPrice /
 *   event.protectedAnchor.
 * Реконструкция protected anchor, копирование pickTarget,
 * поиск "latest high/low" и второй structure detector —
 * ЗАПРЕЩЕНЫ и отсутствуют.
 *
 * RANGE ИЗ BOS (только BOS создаёт range version):
 *   BOS_UP:   protectedAnchor.kind === "low",
 *             broken pivot kind === "high";
 *             low  = protectedAnchor.price,
 *             high = event.brokenLevelPrice.
 *   BOS_DOWN: protectedAnchor.kind === "high",
 *             broken pivot kind === "low";
 *             high = protectedAnchor.price,
 *             low  = event.brokenLevelPrice.
 *   anchorStartPivotKey = protectedAnchor.pivotKey,
 *   anchorEndPivotKey   = event.brokenPivotKey.
 *   eventTime  = BOS.eventTime (исторический anchor),
 *   confirmedAt = BOS.confirmedAt (момент доступности;
 *   до confirmedAt range для потребителя НЕ существует).
 *
 * DEFENSIVE POLICY (выбрано):
 *   - protectedAnchor === null → BOS не создаёт range
 *     (легитимное рыночное условие FSM: противоположный
 *     AVAILABLE уровень на границе отсутствовал; skip-invalid);
 *   - несогласованные metadata (чужой kind anchor'а, broken
 *     pivot отсутствует в structure.pivots / чужой kind,
 *     anchor.confirmedAt > event.confirmedAt, нефинитные
 *     цены, low >= high) → typed SmcRangeInvariantError:
 *     это bug upstream, а не market condition; другой anchor
 *     НЕ подбирается.
 *
 * BOOTSTRAP: первый BOS из UNDEFINED создаёт range на общих
 * основаниях (metadata теперь есть); отдельной эвристики нет.
 *
 * CONTINUATION: каждый valid continuation BOS → новая
 * immutable version; предыдущая active получает
 * replacedAt = новая confirmedAt (не более одной active
 * version одновременно).
 *
 * CHOCH: закрывает active range (replacedAt =
 * CHOCH.confirmedAt), сам range НЕ создаёт. Пока FSM в
 * REVERSAL_PENDING_* — current range отсутствует.
 * CHOCH_INVALIDATED ничего не создаёт и НЕ воскрешает
 * закрытые range (V1: unavailable до следующего valid BOS).
 * CONFIRMED REVERSAL: reversal-confirming BOS несёт тот же
 * metadata contract → создаёт range противоположного
 * направления общим алгоритмом (без распознавания reversal
 * в range-модуле).
 *
 * PREMIUM/DISCOUNT/EQUILIBRIUM (только для current != null):
 *   price = close последней canonical CLOSED candle <= asOf;
 *   position = (price - low) / (high - low) — БЕЗ clamp;
 *   equilibrium = (low + high) / 2;
 *   зона НЕ зависит от direction (low side = discount,
 *   high side = premium):
 *     position < 0.5 - eqBand → DISCOUNT;
 *     position > 0.5 + eqBand → PREMIUM;
 *     иначе EQUILIBRIUM (границы включительно — пространство
 *     покрыто без дырок; при default 0.02: [0.48, 0.52]);
 *   outsideRange = position < 0 || position > 1
 *   (ровно low/high → outsideRange = false).
 *   eqBand: INITIAL ENGINEERING DEFAULT / HYPOTHESIS = 0.02,
 *   валидно 0 <= eqBand < 0.5.
 *
 * VERSIONING / NO-LOOKAHEAD: обработка structure.events
 * строго в canonical хронологии; replacedAt появляется только
 * от события с confirmedAt <= asOf (исторический запрос
 * asOf=T не видит future replacedAt). future injection:
 * evaluateDealingRange(full, T) ≡ evaluateDealingRange(
 * prefixThroughT, T) — serialized identical.
 *
 * IDENTITY: SMC1|RANGE|tf|direction|confirmingBosEventKey —
 * без DB-id/random/price; key не меняется при replacedAt.
 *
 * COMPLEXITY: sub-evaluation O(n·window); walk O(events);
 * priceContext O(1). Без cartesian-произведений.
 *
 * STATELESS: результат — детерминированная функция
 * (raw, config, asOf).
 */

import { evaluateStructure } from "./fsm";
import {
  assertValidAsOf,
  assertValidTf,
  horizonCandles,
  SmcInputError,
  validateAndPrepare
} from "./validate";
import {
  SmcDirection,
  SmcPivotKind,
  SmcRawCandle,
  SmcStructureEvent,
  SmcTimeframe
} from "./types";

export interface SmcRangeConfig {
  tf: SmcTimeframe;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 0.02.
   * Полуширина Equilibrium-полосы; 0 <= eqBand < 0.5. */
  eqBand: number;
  /** Default swing window Phase 1 (FSM external structure). */
  swingLeft: number;
  swingRight: number;
}

export function defaultRangeConfig(
  tf: SmcTimeframe
): SmcRangeConfig {
  return {
    tf,
    eqBand: 0.02,
    swingLeft: 20,
    swingRight: 20
  };
}

export function assertValidRangeConfig(
  config: SmcRangeConfig
): void {
  assertValidTf(config.tf);

  for (const field of [
    "swingLeft",
    "swingRight"
  ] as const) {
    const value = config[field];

    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > 500
    ) {
      throw new SmcInputError(
        `range.${field}: ожидается целое 1..500`
      );
    }
  }

  if (
    !Number.isFinite(config.eqBand) ||
    config.eqBand < 0 ||
    config.eqBand >= 0.5
  ) {
    throw new SmcInputError(
      "range.eqBand: ожидается конечное 0 <= eqBand < 0.5"
    );
  }
}

export type SmcRangeZone =
  | "DISCOUNT"
  | "EQUILIBRIUM"
  | "PREMIUM";

/** Immutable range version (fixable поле одно — replacedAt). */
export interface SmcDealingRange {
  key: string;
  tf: SmcTimeframe;
  direction: SmcDirection;
  /** protectedAnchor.pivotKey — начало leg'а. */
  anchorStartPivotKey: string;
  /** brokenPivotKey подтвердившего BOS — конец leg'а. */
  anchorEndPivotKey: string;
  low: number;
  high: number;
  /** openTime BOS-свечи (исторический anchor). */
  eventTime: Date;
  /** effectiveCloseTime BOS-свечи; до него range не
   * существует для потребителя. */
  confirmedAt: Date;
  /** Момент CHOCH.confirmedAt / подтверждения новой version;
   * появляется только когда событие видно при asOf. */
  replacedAt: Date | null;
  /** (low + high) / 2. */
  equilibrium: number;
}

export interface SmcRangePriceContext {
  /** close последней canonical CLOSED candle <= asOf. */
  price: number;
  /** (price - low) / (high - low), без clamp. */
  position: number;
  eqBand: number;
  zone: SmcRangeZone;
  outsideRange: boolean;
}

export interface SmcRangeEvaluation {
  asOf: Date;
  /** Все versions с confirmedAt <= asOf, хронологично. */
  history: SmcDealingRange[];
  /** Последняя version: confirmedAt <= asOf И
   * (replacedAt === null ИЛИ asOf < replacedAt). */
  current: SmcDealingRange | null;
  priceContext: SmcRangePriceContext | null;
}

/** Typed invariant error: несогласованные FSM metadata
 * (bug upstream, не market condition). */
export class SmcRangeInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmcRangeInvariantError";
  }
}

/**
 * Чистый помощник: range version из BOS-события по
 * metadata contract. Возвращает null, если
 * event.protectedAnchor === null (BOS не создаёт range —
 * легитимное условие). Бросает SmcRangeInvariantError при
 * несогласованных metadata. Экспортирован как isolated pure
 * helper — публичный API FSM не может естественно породить
 * invariant-кейсы, они тестируются через этот помощник.
 */
export function buildDealingRangeFromBos(
  event: SmcStructureEvent,
  tf: SmcTimeframe,
  pivotKindByKey: ReadonlyMap<string, SmcPivotKind>
): SmcDealingRange | null {
  const anchor = event.protectedAnchor;

  if (anchor === null) {
    return null;
  }

  const expectedAnchorKind: SmcPivotKind =
    event.dir === "up" ? "low" : "high";
  const expectedBrokenKind: SmcPivotKind =
    event.dir === "up" ? "high" : "low";

  if (anchor.kind !== expectedAnchorKind) {
    throw new SmcRangeInvariantError(
      `range: protectedAnchor.kind ${anchor.kind} не соответствует направлению BOS ${event.dir} (ожидался ${expectedAnchorKind}), event ${event.key}`
    );
  }

  const brokenKind = pivotKindByKey.get(
    event.brokenPivotKey
  );

  if (brokenKind === undefined) {
    throw new SmcRangeInvariantError(
      `range: broken pivot ${event.brokenPivotKey} отсутствует в structure.pivots, event ${event.key}`
    );
  }

  if (brokenKind !== expectedBrokenKind) {
    throw new SmcRangeInvariantError(
      `range: broken pivot kind ${brokenKind} не соответствует направлению BOS ${event.dir} (ожидался ${expectedBrokenKind}), event ${event.key}`
    );
  }

  if (
    anchor.confirmedAt.getTime() >
    event.confirmedAt.getTime()
  ) {
    throw new SmcRangeInvariantError(
      `range: protectedAnchor подтверждён позже события, event ${event.key}`
    );
  }

  if (
    !Number.isFinite(anchor.price) ||
    !Number.isFinite(event.brokenLevelPrice)
  ) {
    throw new SmcRangeInvariantError(
      `range: нефинитные цены anchor/broken, event ${event.key}`
    );
  }

  const low =
    event.dir === "up"
      ? anchor.price
      : event.brokenLevelPrice;
  const high =
    event.dir === "up"
      ? event.brokenLevelPrice
      : anchor.price;

  if (!(low < high)) {
    throw new SmcRangeInvariantError(
      `range: вырожденная геометрия low >= high (${low} >= ${high}), event ${event.key}`
    );
  }

  return {
    key: `SMC1|RANGE|${tf}|${event.dir}|${event.key}`,
    tf,
    direction: event.dir,
    anchorStartPivotKey: anchor.pivotKey,
    anchorEndPivotKey: event.brokenPivotKey,
    low,
    high,
    eventTime: event.eventTime,
    confirmedAt: event.confirmedAt,
    replacedAt: null,
    equilibrium: (low + high) / 2
  };
}

/** Закрыть текущую active version (первую с конца без
 * replacedAt) моментом toMs. */
function closeActive(
  versions: SmcDealingRange[],
  toMs: number
): void {
  for (
    let i = versions.length - 1;
    i >= 0;
    i--
  ) {
    if (versions[i].replacedAt === null) {
      versions[i].replacedAt = new Date(toMs);
      return;
    }
  }
}

/**
 * Каноническая точка входа Phase 2D. Свечи после asOf
 * физически не видны ни structure, ни priceContext
 * (canonical Phase 1 horizon). Range НЕ существует для
 * потребителя до confirmedAt; replacedAt появляется только
 * от событий, подтверждённых <= asOf.
 */
export function evaluateDealingRange(
  raw: SmcRawCandle[],
  config: SmcRangeConfig,
  asOf: Date
): SmcRangeEvaluation {
  assertValidRangeConfig(config);
  assertValidAsOf(asOf);

  const prepared = validateAndPrepare(raw, config.tf);
  const horizon = horizonCandles(prepared, asOf);

  if (horizon.length === 0) {
    return {
      asOf,
      history: [],
      current: null,
      priceContext: null
    };
  }

  const horizonAsOf = new Date(
    horizon[horizon.length - 1].effectiveCloseTime
  );

  // SOURCE OF TRUTH: внешний (swing) structure Phase 1;
  // internal для dealing range V1 не используется.
  const structure = evaluateStructure(
    horizon.map((candle) => ({
      openTime: candle.openTime,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      closed: true as const
    })),
    {
      tf: config.tf,
      layer: "swing",
      left: config.swingLeft,
      right: config.swingRight
    },
    horizonAsOf
  );

  const pivotKindByKey = new Map<
    string,
    SmcPivotKind
  >();

  for (const pivot of structure.pivots) {
    pivotKindByKey.set(pivot.key, pivot.kind);
  }

  // Хронологический walk: CHOCH закрывает active, BOS
  // создаёт version (заменяя active), CHOCH_INVALIDATED —
  // ничего. Overlapping active versions невозможны.
  const versions: SmcDealingRange[] = [];

  for (const event of structure.events) {
    if (event.type === "CHOCH_INVALIDATED") {
      continue;
    }

    if (event.type === "CHOCH") {
      closeActive(versions, event.confirmedAt.getTime());
      continue;
    }

    const created = buildDealingRangeFromBos(
      event,
      config.tf,
      pivotKindByKey
    );

    if (created === null) {
      continue;
    }

    closeActive(versions, event.confirmedAt.getTime());
    versions.push(created);
  }

  // current: последняя version, ещё не заменённая на asOf.
  let current: SmcDealingRange | null = null;

  for (
    let i = versions.length - 1;
    i >= 0;
    i--
  ) {
    const candidate = versions[i];

    if (
      candidate.replacedAt === null ||
      asOf.getTime() < candidate.replacedAt.getTime()
    ) {
      current = candidate;
      break;
    }
  }

  let priceContext: SmcRangePriceContext | null = null;

  if (current !== null) {
    const price =
      horizon[horizon.length - 1].close;
    const position =
      (price - current.low) /
      (current.high - current.low);

    priceContext = {
      price,
      position,
      eqBand: config.eqBand,
      zone:
        position < 0.5 - config.eqBand
          ? "DISCOUNT"
          : position > 0.5 + config.eqBand
            ? "PREMIUM"
            : "EQUILIBRIUM",
      outsideRange:
        position < 0 || position > 1
    };
  }

  return {
    asOf,
    history: versions,
    current,
    priceContext
  };
}
