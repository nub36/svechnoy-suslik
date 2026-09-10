/**
 * SMC Phase 2A — Fair Value Gap: геометрия, ATR-фильтр,
 * lifecycle. Strict 3-candle определение (наша convention,
 * не копия Auto Threshold LuxAlgo):
 *
 *   a = candles[i-2], b = candles[i-1] (impulse), c = candles[i]
 *
 * Bullish raw FVG: c.low > a.high  (СТРОГО >; c.low === a.high
 *   → нет FVG);  zone: bottom = a.high, top = c.low.
 * Bearish raw FVG: c.high < a.low; zone: bottom = c.high,
 *   top = a.low.
 *
 * eventTime  = b.openTime (исторический anchor);
 * confirmedAt = c.effectiveCloseTime — ДО этого момента FVG
 * для потребителя НЕ существует (anti-lookahead).
 *
 * SIZE FILTER (INITIAL ENGINEERING DEFAULT / HYPOTHESIS 0.10,
 * наша ATR-нормализация, НЕ формула LuxAlgo):
 *   gapSize / ATR[c] >= fvgMinAtr, ATR[c] causal;
 *   ATR[c] unavailable → кандидат not-evaluable и НЕ
 *   принимается (raw gap без фильтра не пропускается).
 *
 * IDENTITY: SMC1|FVG|tf|direction|middleOpenTimeMs.
 * Коллизия невозможна: middle openTime уникален (validate),
 * у одной middle максимум один bullish и один bearish FVG —
 * direction различает; price в identity не входит. Одинаковые
 * input/config/asOf → одинаковый key.
 *
 * LIFECYCLE (bullish; свечи d с effectiveCloseTime СТРОГО >
 * confirmedAt — свеча создания c не может митигировать себя):
 *   firstTouchedAt          — первая d с d.low <  top   (строго);
 *   ce = (bottom+top)/2;
 *   ceTouchedAt             — первая d с d.low <= ce   (включительно);
 *   fullFilledByExcursionAt — первая d с d.low <= bottom (включительно);
 *   invalidatedByCloseAt    — первая d с d.close < bottom (строго);
 *   fillFraction            — max проникновение (top - min low) / gap,
 *                             clamp [0,1], по свечам до invalidation;
 *   expiredAt               — эффективное закрытие (maxAgeCandles)-й
 *                             последующей свечи, если close-
 *                             invalidation не случилось раньше.
 * Bearish зеркально (high/low меняются местами, close-строго
 * против top). full fill и close invalidation — РАЗНЫЕ события:
 * wick ниже bottom с close обратно выше bottom = full fill БЕЗ
 * invalidation (тестируется).
 *
 * DERIVED STATE PRIORITY (original event/key никогда не меняется;
 * timestamps появляются только когда свеча-источник доступна asOf):
 *   INVALIDATED > EXPIRED > FILLED_BY_EXCURSION > CE_MITIGATED >
 *   TOUCHED > OPEN.
 *
 * EXPIRY: возраст в числе ПОСЛЕДУЮЩИХ CLOSED свеч того же ТФ
 * (не wall-clock). maxAgeCandles = 0 отключает expiry. Expiry не
 * переписывает eventTime/confirmedAt/key/historical lifecycle.
 *
 * STATELESS: ни одного mutable-accumulator'а между вызовами —
 * lifecycle полностью пересчитывается из candles <= asOf.
 */

import { computeAtrSeries } from "./volatility";
import {
  assertValidAsOf,
  assertValidTf,
  horizonCandles,
  SmcInputError,
  validateAndPrepare
} from "./validate";
import {
  SmcCandle,
  SmcDirection,
  SmcRawCandle,
  SmcTimeframe
} from "./types";

export interface SmcFvgConfig {
  tf: SmcTimeframe;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 14 (ATR14 проекта). */
  atrPeriod: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 0.10 */
  minGapAtr: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 500 последующих
   * CLOSED свеч того же ТФ; 0 = expiry отключён. */
  maxAgeCandles: number;
}

export function defaultFvgConfig(
  tf: SmcTimeframe
): SmcFvgConfig {
  return {
    tf,
    atrPeriod: 14,
    minGapAtr: 0.1,
    maxAgeCandles: 500
  };
}

export type SmcFvgState =
  | "OPEN"
  | "TOUCHED"
  | "CE_MITIGATED"
  | "FILLED_BY_EXCURSION"
  | "EXPIRED"
  | "INVALIDATED";

export interface SmcFvg {
  key: string;
  tf: SmcTimeframe;
  direction: SmcDirection;
  bottom: number;
  top: number;
  ce: number;
  gapSize: number;
  /** gapSize / ATR[c] — payload. */
  sizeAtr: number;
  /** openTime impulse-свечи b. */
  eventTime: Date;
  /** effectiveCloseTime свечи c. */
  confirmedAt: Date;
  firstTouchedAt: Date | null;
  ceTouchedAt: Date | null;
  fullFilledByExcursionAt: Date | null;
  invalidatedByCloseAt: Date | null;
  expiredAt: Date | null;
  /** 0..1, max проникновение в зону. */
  fillFraction: number;
  state: SmcFvgState;
}

export function assertValidFvgConfig(
  config: SmcFvgConfig
): void {
  assertValidTf(config.tf);

  if (
    !Number.isInteger(config.atrPeriod) ||
    config.atrPeriod < 1
  ) {
    throw new SmcInputError(
      "fvg.atrPeriod: ожидается целое >= 1"
    );
  }

  if (!Number.isFinite(config.minGapAtr) || config.minGapAtr < 0) {
    throw new SmcInputError(
      "fvg.minGapAtr: ожидается конечное число >= 0"
    );
  }

  if (
    !Number.isInteger(config.maxAgeCandles) ||
    config.maxAgeCandles < 0
  ) {
    throw new SmcInputError(
      "fvg.maxAgeCandles: ожидается целое >= 0 (0 = выключен)"
    );
  }
}

/** Один параметризованный алгоритм lifecycle для обоих
 * направлений: dir = "up" — bullish-поля, "down" — зеркально. */
function buildLifecycle(
  fvg: SmcFvg,
  candles: SmcCandle[],
  creationIndex: number,
  config: SmcFvgConfig
): void {
  const bullish = fvg.direction === "up";
  let minPenetration = Number.POSITIVE_INFINITY;
  let scanned = 0;

  for (
    let j = creationIndex + 1;
    j < candles.length;
    j++
  ) {
    const d = candles[j];

    // Свеча создания не митигирует себя: tracking строго
    // после confirmedAt (для j > creationIndex это
    // выполняется автоматически, guard оставлен явным).
    if (
      d.effectiveCloseTime.getTime() <=
      fvg.confirmedAt.getTime()
    ) {
      continue;
    }

    scanned += 1;

    const low = d.low;
    const high = d.high;
    const close = d.close;

    if (bullish) {
      const touch = low < fvg.top;
      const ceTouch = low <= fvg.ce;
      const fullFill = low <= fvg.bottom;
      const closeInvalidated = close < fvg.bottom;

      if (touch && fvg.firstTouchedAt === null) {
        fvg.firstTouchedAt = d.effectiveCloseTime;
      }

      if (ceTouch && fvg.ceTouchedAt === null) {
        fvg.ceTouchedAt = d.effectiveCloseTime;
      }

      if (fullFill && fvg.fullFilledByExcursionAt === null) {
        fvg.fullFilledByExcursionAt = d.effectiveCloseTime;
      }

      minPenetration = Math.min(minPenetration, low);

      if (closeInvalidated) {
        fvg.invalidatedByCloseAt = d.effectiveCloseTime;
        break;
      }
    } else {
      const touch = high > fvg.bottom;
      const ceTouch = high >= fvg.ce;
      const fullFill = high >= fvg.top;
      const closeInvalidated = close > fvg.top;

      if (touch && fvg.firstTouchedAt === null) {
        fvg.firstTouchedAt = d.effectiveCloseTime;
      }

      if (ceTouch && fvg.ceTouchedAt === null) {
        fvg.ceTouchedAt = d.effectiveCloseTime;
      }

      if (fullFill && fvg.fullFilledByExcursionAt === null) {
        fvg.fullFilledByExcursionAt = d.effectiveCloseTime;
      }

      minPenetration = Math.min(minPenetration, high);

      if (closeInvalidated) {
        fvg.invalidatedByCloseAt = d.effectiveCloseTime;
        break;
      }
    }
  }

  // fillFraction: max проникновение в зону, clamp [0,1].
  if (scanned === 0) {
    fvg.fillFraction = 0;
  } else {
    const raw = bullish
      ? (fvg.top - minPenetration) / fvg.gapSize
      : (minPenetration - fvg.bottom) / fvg.gapSize;

    fvg.fillFraction = Math.min(
      1,
      Math.max(0, raw)
    );
  }

  // Expiry: (maxAgeCandles)-я последующая свеча; только если
  // close-invalidation не произошло раньше (приоритет
  // INVALIDATED). Исторические поля не переписываются.
  if (
    config.maxAgeCandles > 0 &&
    fvg.invalidatedByCloseAt === null
  ) {
    const expiryIndex = creationIndex + config.maxAgeCandles;

    if (expiryIndex < candles.length) {
      fvg.expiredAt =
        candles[expiryIndex].effectiveCloseTime;
    }
  }

  fvg.state = deriveState(fvg);
}

/** Приоритет: INVALIDATED > EXPIRED > FILLED > CE > TOUCHED > OPEN. */
function deriveState(fvg: SmcFvg): SmcFvgState {
  if (fvg.invalidatedByCloseAt !== null) {
    return "INVALIDATED";
  }

  if (fvg.expiredAt !== null) {
    return "EXPIRED";
  }

  if (fvg.fullFilledByExcursionAt !== null) {
    return "FILLED_BY_EXCURSION";
  }

  if (fvg.ceTouchedAt !== null) {
    return "CE_MITIGATED";
  }

  if (fvg.firstTouchedAt !== null) {
    return "TOUCHED";
  }

  return "OPEN";
}

/** Ядро на подготовленном (уже horizon-обрезанном) массиве. */
export function findFvgs(
  candles: SmcCandle[],
  config: SmcFvgConfig
): SmcFvg[] {
  assertValidFvgConfig(config);

  const atrSeries = computeAtrSeries(
    candles,
    config.atrPeriod
  );
  const out: SmcFvg[] = [];

  for (let i = 2; i < candles.length; i++) {
    const a = candles[i - 2];
    const b = candles[i - 1];
    const c = candles[i];
    const atrC = atrSeries[i];

    let direction: SmcDirection | null = null;
    let bottom = 0;
    let top = 0;

    if (c.low > a.high) {
      direction = "up";
      bottom = a.high;
      top = c.low;
    } else if (c.high < a.low) {
      direction = "down";
      bottom = c.high;
      top = a.low;
    }

    if (direction === null) {
      continue;
    }

    // ATR[c] unavailable → кандидат not-evaluable: raw gap
    // БЕЗ фильтра не принимается.
    if (atrC === null || atrC === undefined) {
      continue;
    }

    const gapSize = top - bottom;
    const sizeAtr = gapSize / atrC;

    if (sizeAtr < config.minGapAtr) {
      continue;
    }

    const fvg: SmcFvg = {
      key: `SMC1|FVG|${config.tf}|${direction}|${b.openTime.getTime()}`,
      tf: config.tf,
      direction,
      bottom,
      top,
      ce: (bottom + top) / 2,
      gapSize,
      sizeAtr,
      eventTime: b.openTime,
      confirmedAt: c.effectiveCloseTime,
      firstTouchedAt: null,
      ceTouchedAt: null,
      fullFilledByExcursionAt: null,
      invalidatedByCloseAt: null,
      expiredAt: null,
      fillFraction: 0,
      state: "OPEN"
    };

    buildLifecycle(fvg, candles, i, config);
    out.push(fvg);
  }

  return out;
}

/** Каноническая точка входа: ТОЛЬКО validateAndPrepare +
 * horizonCandles (никакой другой asOf-реализации). Свечи
 * после asOf физически не видны — lifecycle timestamps
 * появляются только когда свеча-источник стала доступна. */
export function evaluateFvgs(
  raw: SmcRawCandle[],
  config: SmcFvgConfig,
  asOf: Date
): SmcFvg[] {
  assertValidFvgConfig(config);
  assertValidAsOf(asOf);

  const prepared = validateAndPrepare(raw, config.tf);

  return findFvgs(horizonCandles(prepared, asOf), config);
}
