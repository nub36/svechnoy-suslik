/**
 * SMC Phase 2A — primitive displacement.
 *
 * ЧИСТОЕ price-action измерение ОДНОЙ закрытой свечи,
 * нормированное causal ATR. НЕ зависит и не знает про:
 * BOS, CHoCH, FVG, OB, liquidity, структуру FSM.
 *
 * INITIAL ENGINEERING DEFAULT / HYPOTHESIS (не оптимизировано,
 * не заявляется прибыльным/оптимальным):
 *   displacementBodyAtr      = 1.5
 *   displacementRangeAtr     = 2.0
 *   bullishCloseLocationMin  = 0.60
 *   bearishCloseLocationMax  = 0.40
 *
 * Формулы для CLOSED свечи c доступным ATR[i]:
 *   body          = |close - open|
 *   range         = high - low
 *   bodyAtr       = body / ATR[i]
 *   rangeAtr      = range / ATR[i]
 *   closeLocation = (close - low) / range   (range > 0)
 *
 * Bullish displacement:
 *   close > open AND bodyAtr >= 1.5 AND rangeAtr >= 2.0
 *   AND closeLocation >= 0.60
 * Bearish — зеркально (close < open, closeLocation <= 0.40).
 *
 * BOUNDARY POLICIES (явно, тестируются):
 * - пороги inclusive (>= / <=): точное равенство принимается;
 * - doji (close === open): не displacement (body = 0);
 * - range === 0: closeLocation по конвенции = 0.5
 *   (детерминировано), свеча НЕ displacement (rangeAtr = 0);
 * - ATR[i] unavailable → точка not-evaluable: displacement НЕ
 *   создаётся (никакого fallback-значения ATR).
 *
 * EventTime = openTime свечи (исторический anchor);
 * confirmedAt = effectiveCloseTime свечи; до confirmedAt
 * событие не существует. Identity — deterministic semantic
 * key (tf, direction, openTime), цена — payload.
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

export interface SmcDisplacementConfig {
  tf: SmcTimeframe;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 14 (ATR14 проекта). */
  atrPeriod: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 1.5 */
  bodyAtrMin: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 2.0 */
  rangeAtrMin: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 0.60 */
  bullCloseLocMin: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 0.40 */
  bearCloseLocMax: number;
}

export function defaultDisplacementConfig(
  tf: SmcTimeframe
): SmcDisplacementConfig {
  return {
    tf,
    atrPeriod: 14,
    bodyAtrMin: 1.5,
    rangeAtrMin: 2.0,
    bullCloseLocMin: 0.6,
    bearCloseLocMax: 0.4
  };
}

export interface SmcDisplacement {
  key: string;
  tf: SmcTimeframe;
  direction: SmcDirection;
  eventTime: Date;
  confirmedAt: Date;
  bodyAtr: number;
  rangeAtr: number;
  closeLocation: number;
}

/** Конвенция для range === 0 (документировано, тестируется). */
export const ZERO_RANGE_CLOSE_LOCATION = 0.5;

export function assertValidDisplacementConfig(
  config: SmcDisplacementConfig
): void {
  assertValidTf(config.tf);

  if (
    !Number.isInteger(config.atrPeriod) ||
    config.atrPeriod < 1
  ) {
    throw new SmcInputError(
      "displacement.atrPeriod: ожидается целое >= 1"
    );
  }

  for (const field of [
    "bodyAtrMin",
    "rangeAtrMin",
    "bullCloseLocMin",
    "bearCloseLocMax"
  ] as const) {
    const value = config[field];

    if (!Number.isFinite(value) || value < 0) {
      throw new SmcInputError(
        `displacement.${field}: ожидается конечное число >= 0`
      );
    }
  }
}

/** Один параметризованный алгоритм для обоих направлений. */
function classifyCandle(
  candle: SmcCandle,
  atr: number,
  config: SmcDisplacementConfig
): SmcDisplacement | null {
  const open = candle.open;
  const close = candle.close;
  const high = candle.high;
  const low = candle.low;
  const range = high - low;
  const body = Math.abs(close - open);

  let closeLocation: number;

  if (range === 0) {
    closeLocation = ZERO_RANGE_CLOSE_LOCATION;
  } else {
    closeLocation = (close - low) / range;
  }

  const bodyAtr = body / atr;
  const rangeAtr = range / atr;

  const bullish =
    close > open &&
    bodyAtr >= config.bodyAtrMin &&
    rangeAtr >= config.rangeAtrMin &&
    closeLocation >= config.bullCloseLocMin;

  const bearish =
    close < open &&
    bodyAtr >= config.bodyAtrMin &&
    rangeAtr >= config.rangeAtrMin &&
    closeLocation <= config.bearCloseLocMax;

  if (!bullish && !bearish) {
    return null;
  }

  const direction: SmcDirection = bullish ? "up" : "down";

  return {
    key: `SMC1|D|${config.tf}|${direction}|${candle.openTime.getTime()}`,
    tf: config.tf,
    direction,
    eventTime: candle.openTime,
    confirmedAt: candle.effectiveCloseTime,
    bodyAtr,
    rangeAtr,
    closeLocation
  };
}

/** Ядро на подготовленном (уже horizon-обрезанном) массиве. */
export function findDisplacements(
  candles: SmcCandle[],
  config: SmcDisplacementConfig
): SmcDisplacement[] {
  assertValidDisplacementConfig(config);

  const atrSeries = computeAtrSeries(
    candles,
    config.atrPeriod
  );
  const out: SmcDisplacement[] = [];

  for (let i = 0; i < candles.length; i++) {
    const atr = atrSeries[i];

    // Insufficient history → not evaluable, без fallback.
    if (atr === null || atr === undefined) {
      continue;
    }

    const displacement = classifyCandle(
      candles[i],
      atr,
      config
    );

    if (displacement !== null) {
      out.push(displacement);
    }
  }

  return out;
}

/** Каноническая точка входа: ТОЛЬКО через validateAndPrepare +
 * horizonCandles (никакой другой asOf-реализации). Свечи после
 * asOf физически не видны алгоритму. */
export function evaluateDisplacements(
  raw: SmcRawCandle[],
  config: SmcDisplacementConfig,
  asOf: Date
): SmcDisplacement[] {
  assertValidDisplacementConfig(config);
  assertValidAsOf(asOf);

  const prepared = validateAndPrepare(raw, config.tf);

  return findDisplacements(
    horizonCandles(prepared, asOf),
    config
  );
}
