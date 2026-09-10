/**
 * SMC Phase 3A — единый конфиг unified SMC evaluation +
 * explainable scoring.
 *
 * ПРИНЦИПЫ:
 * - все веса/пороги = INITIAL ENGINEERING DEFAULT /
 *   HYPOTHESIS; profitability НЕ заявляется; подгонка под
 *   production minimumSignalScore=72 НЕ выполняется
 *   (production integration позже передаст реальное значение);
 * - coherence-инвариант: сумма weights === 100 (модель ровно
 *   на 100 max per direction, проверяется assert'ом);
 * - sub-configs проверенных подмодулей НЕ дублируются
 *   вручную: deriveSubConfigs собирает их композиционно из
 *   одного SmcScoringConfig (единый atrPeriod там, где
 *   semantics требует единства; единые swing-окна для swing
 *   structure/liquidity/OB-swing/range; единые internal-окна
 *   для internal structure/OB-internal).
 *
 * НЕ менять проверенные algorithms: этот модуль только
 * собирает их параметры.
 */

import {
  defaultDisplacementConfig
} from "./displacement";
import { defaultFvgConfig } from "./fvg";
import {
  defaultLiquidityConfig
} from "./liquidity";
import {
  defaultOrderBlockConfig
} from "./order-blocks";
import { defaultRangeConfig } from "./range";
import { SmcInputError, assertValidTf } from "./validate";
import {
  SmcTimeframe
} from "./types";

/** Веса scoring-компонентов (сумма строго 100). */
export interface SmcScoringWeights {
  /** A. Established swing phase. */
  swingStructureBias: number;
  /** B. Последний свежий swing BOS (по фазе). */
  recentSwingBos: number;
  /** C. Established internal phase (без отдельного internal
   * BOS — anti double-count одной structure logic). */
  internalStructure: number;
  /** D. Последний свежий resolved SWEPT. */
  liquiditySweep: number;
  /** E. Свежий active swing OB (OPEN/MITIGATED). */
  swingOrderBlock: number;
  /** F. Свежий active internal OB. */
  internalOrderBlock: number;
  /** G. Свежий active FVG (OPEN/TOUCHED/CE_MITIGATED). */
  fvg: number;
  /** H. Premium/Discount активного dealing range. */
  rangePosition: number;
  /** I. Единственный deliberate overlap bonus (OB+FVG). */
  confluence: number;
}

export interface SmcScoringConfig {
  tf: SmcTimeframe;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 72.
   * НЕ production minimumSignalScore — его передаст
   * интеграция; здесь только порог направления. */
  minimumScore: number;
  /** External (swing) structure окна: FSM-swing, liquidity,
   * OB-swing, dealing range. */
  swingLeft: number;
  swingRight: number;
  /** Internal structure окна: FSM-internal, OB-internal. */
  internalLeft: number;
  internalRight: number;
  /** Единый ATR-период для displacement/FVG/liquidity/OB.
   * INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 14. */
  atrPeriod: number;
  /** Freshness в CLOSED candle indices (НЕ wall-clock).
   * INITIAL DEFAULTS / HYPOTHESIS: 10/5/20/20. */
  structureEventFreshBars: number;
  sweepFreshBars: number;
  orderBlockFreshBars: number;
  fvgFreshBars: number;
  /** Полоса Equilibrium dealing range (см. range.ts). */
  eqBand: number;
  weights: SmcScoringWeights;
}

export function defaultSmcScoringConfig(
  tf: SmcTimeframe
): SmcScoringConfig {
  return {
    tf,
    minimumScore: 72,
    swingLeft: 20,
    swingRight: 20,
    internalLeft: 3,
    internalRight: 3,
    atrPeriod: 14,
    structureEventFreshBars: 10,
    sweepFreshBars: 5,
    orderBlockFreshBars: 20,
    fvgFreshBars: 20,
    eqBand: 0.02,
    weights: {
      swingStructureBias: 20,
      recentSwingBos: 15,
      internalStructure: 10,
      liquiditySweep: 10,
      swingOrderBlock: 15,
      internalOrderBlock: 5,
      fvg: 10,
      rangePosition: 10,
      confluence: 5
    }
  };
}

const WEIGHT_KEYS = [
  "swingStructureBias",
  "recentSwingBos",
  "internalStructure",
  "liquiditySweep",
  "swingOrderBlock",
  "internalOrderBlock",
  "fvg",
  "rangePosition",
  "confluence"
] as const;

export function assertValidSmcScoringConfig(
  config: SmcScoringConfig
): void {
  assertValidTf(config.tf);

  if (
    !Number.isInteger(config.minimumScore) ||
    config.minimumScore < 0 ||
    config.minimumScore > 100
  ) {
    throw new SmcInputError(
      "scoring.minimumScore: ожидается целое 0..100"
    );
  }

  for (const field of [
    "swingLeft",
    "swingRight",
    "internalLeft",
    "internalRight"
  ] as const) {
    const value = config[field];

    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > 500
    ) {
      throw new SmcInputError(
        `scoring.${field}: ожидается целое 1..500`
      );
    }
  }

  if (
    !Number.isInteger(config.atrPeriod) ||
    config.atrPeriod < 1
  ) {
    throw new SmcInputError(
      "scoring.atrPeriod: ожидается целое >= 1"
    );
  }

  for (const field of [
    "structureEventFreshBars",
    "sweepFreshBars",
    "orderBlockFreshBars",
    "fvgFreshBars"
  ] as const) {
    if (
      !Number.isInteger(config[field]) ||
      config[field] < 0
    ) {
      throw new SmcInputError(
        `scoring.${field}: ожидается целое >= 0`
      );
    }
  }

  if (
    !Number.isFinite(config.eqBand) ||
    config.eqBand < 0 ||
    config.eqBand >= 0.5
  ) {
    throw new SmcInputError(
      "scoring.eqBand: ожидается конечное 0 <= eqBand < 0.5"
    );
  }

  let weightSum = 0;

  for (const key of WEIGHT_KEYS) {
    const value = config.weights[key];

    if (
      !Number.isInteger(value) ||
      value < 0 ||
      value > 100
    ) {
      throw new SmcInputError(
        `scoring.weights.${key}: ожидается целое 0..100`
      );
    }

    weightSum += value;
  }

  if (weightSum !== 100) {
    throw new SmcInputError(
      `scoring.weights: сумма весов должна быть ровно 100 (сейчас ${weightSum})`
    );
  }
}

/** Порог минимальной истории swing structure:
 * 4 legs по (S+1) свече; S = max(swingLeft, swingRight).
 * Для default S=20 это 4*21=84 CLOSED candles. */
export function minimumSwingHistoryCandles(
  config: SmcScoringConfig
): number {
  const s = Math.max(
    config.swingLeft,
    config.swingRight
  );

  return 4 * (s + 1);
}

/**
 * Композиция sub-configs проверенных подмодулей из одного
 * scoring-config (без ручного дублирования параметров).
 * Константы displacement/FVG — ТЕ ЖЕ, что в проверенном
 * OB core (единая semantics примитивов).
 */
export function deriveSubConfigs(
  config: SmcScoringConfig
): {
  displacement: ReturnType<
    typeof defaultDisplacementConfig
  >;
  fvg: ReturnType<typeof defaultFvgConfig>;
  liquidity: ReturnType<typeof defaultLiquidityConfig>;
  orderBlockSwing: ReturnType<
    typeof defaultOrderBlockConfig
  >;
  orderBlockInternal: ReturnType<
    typeof defaultOrderBlockConfig
  >;
  range: ReturnType<typeof defaultRangeConfig>;
} {
  const displacement = {
    ...defaultDisplacementConfig(config.tf),
    atrPeriod: config.atrPeriod
  };
  const fvg = {
    ...defaultFvgConfig(config.tf),
    atrPeriod: config.atrPeriod,
    maxAgeCandles: 0
  };
  const liquidity = {
    ...defaultLiquidityConfig(config.tf),
    atrPeriod: config.atrPeriod,
    swingLeft: config.swingLeft,
    swingRight: config.swingRight,
    maxAgeCandles: 0
  };
  const orderBlockSwing = {
    ...defaultOrderBlockConfig(config.tf, "swing"),
    swingLeft: config.swingLeft,
    swingRight: config.swingRight,
    atrPeriod: config.atrPeriod
  };
  const orderBlockInternal = {
    ...defaultOrderBlockConfig(config.tf, "internal"),
    swingLeft: config.internalLeft,
    swingRight: config.internalRight,
    atrPeriod: config.atrPeriod
  };
  const range = {
    ...defaultRangeConfig(config.tf),
    eqBand: config.eqBand,
    swingLeft: config.swingLeft,
    swingRight: config.swingRight
  };

  return {
    displacement,
    fvg,
    liquidity,
    orderBlockSwing,
    orderBlockInternal,
    range
  };
}
