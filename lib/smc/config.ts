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
 * Phase 3D-A — canonical advanced config contract:
 * - old configs без Phase3D полей сохраняют EXACT текущее
 *   поведение (backward compat);
 * - частично заданные группы дополняются каноническими
 *   fallback'ами (единственный источник — defaultXConfig
 *   + scoring семантика override 0 для FVG/Liquidity maxAge);
 * - FVG module default maxAge=500 и Liquidity 750
 *   остаются для изолированных модульных тестов, но scoring
 *   fallback — 0 (текущая runtime semantics);
 * - OB internal hardcode (1.5/2.0/0.6/0.4 + minGap 0.1)
 *   остаётся в findOrderBlocks до 3D-B — см. комментарий
 *   ниже (разрыв top-level vs OB будет устранён в 3D-B).
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

// ============================================================
// Phase 3D-A advanced groups (optional, backward-compatible)
// ============================================================

/**
 * Advanced displacement thresholds (optional).
 * Если группа отсутствует — канонические fallback'и:
 * bodyAtrMin 1.5, rangeAtrMin 2.0, bullCloseLocMin 0.6,
 * bearCloseLocMax 0.4 (lib/smc/displacement.ts:62).
 * Поле atrPeriod НЕ входит: единый atrPeriod берётся из
 * верхнего scoring.atrPeriod.
 */
export interface SmcAdvancedDisplacementConfig {
  bodyAtrMin?: number;
  rangeAtrMin?: number;
  bullCloseLocMin?: number;
  bearCloseLocMax?: number;
}

/**
 * Advanced FVG thresholds (optional).
 * minGapAtr fallback 0.10 (lib/smc/fvg.ts:66).
 * ВАЖНО: module default maxAge=500 остаётся для
 * изолированных FVG-тестов, но scoring fallback — 0
 * (текущая runtime semantics lib/smc/config.ts:195-199
 * scoring disables expiry). Resolver сохраняет 0 для
 * старых конфигов.
 */
export interface SmcAdvancedFvgConfig {
  minGapAtr?: number;
  maxAgeCandles?: number;
}

/**
 * Advanced liquidity thresholds (optional).
 * eqToleranceAtr 0.10, eqConfirmBars 2,
 * sweepMinPenetrationAtr 0.05 — из
 * lib/smc/liquidity.ts:64-66.
 * maxAgeCandles module default 750, но scoring fallback 0.
 */
export interface SmcAdvancedLiquidityConfig {
  eqToleranceAtr?: number;
  eqConfirmBars?: number;
  sweepMinPenetrationAtr?: number;
  maxAgeCandles?: number;
}

/**
 * Advanced Order Block thresholds (optional).
 * impulseMaxCandles 3, confirmMaxCandles 10,
 * maxAgeCandles 750, sweepLookbackCandles 5
 * (lib/smc/order-blocks.ts:122-125).
 * swingLeft/Right/atrPeriod НЕ входят — берутся из
 * верхних swingLeft/swingRight/atrPeriod.
 */
export interface SmcAdvancedOrderBlockConfig {
  impulseMaxCandles?: number;
  confirmMaxCandles?: number;
  maxAgeCandles?: number;
  sweepLookbackCandles?: number;
}

/** Resolved (полные) advanced значения — все поля присутствуют. */
export interface ResolvedSmcAdvancedConfig {
  displacement: {
    bodyAtrMin: number;
    rangeAtrMin: number;
    bullCloseLocMin: number;
    bearCloseLocMax: number;
  };
  fvg: {
    minGapAtr: number;
    maxAgeCandles: number;
  };
  liquidity: {
    eqToleranceAtr: number;
    eqConfirmBars: number;
    sweepMinPenetrationAtr: number;
    maxAgeCandles: number;
  };
  orderBlock: {
    impulseMaxCandles: number;
    confirmMaxCandles: number;
    maxAgeCandles: number;
    sweepLookbackCandles: number;
  };
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
  /** Phase 3D advanced — optional, backward-compatible. */
  displacement?: SmcAdvancedDisplacementConfig;
  fvg?: SmcAdvancedFvgConfig;
  liquidity?: SmcAdvancedLiquidityConfig;
  orderBlock?: SmcAdvancedOrderBlockConfig;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertValidAdvancedDisplacement(
  displacement: unknown
): void {
  if (!isRecord(displacement)) {
    throw new SmcInputError(
      "scoring.displacement: ожидается объект"
    );
  }
  if (displacement.bodyAtrMin !== undefined) {
    const v = displacement.bodyAtrMin;
    if (!Number.isFinite(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.displacement.bodyAtrMin: ожидается конечное число >= 0"
      );
    }
  }
  if (displacement.rangeAtrMin !== undefined) {
    const v = displacement.rangeAtrMin;
    if (!Number.isFinite(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.displacement.rangeAtrMin: ожидается конечное число >= 0"
      );
    }
  }
  if (displacement.bullCloseLocMin !== undefined) {
    const v = displacement.bullCloseLocMin;
    if (!Number.isFinite(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.displacement.bullCloseLocMin: ожидается конечное число >= 0"
      );
    }
  }
  if (displacement.bearCloseLocMax !== undefined) {
    const v = displacement.bearCloseLocMax;
    if (!Number.isFinite(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.displacement.bearCloseLocMax: ожидается конечное число >= 0"
      );
    }
  }
}

function assertValidAdvancedFvg(fvg: unknown): void {
  if (!isRecord(fvg)) {
    throw new SmcInputError("scoring.fvg: ожидается объект");
  }
  if (fvg.minGapAtr !== undefined) {
    const v = fvg.minGapAtr;
    if (!Number.isFinite(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.fvg.minGapAtr: ожидается конечное число >= 0"
      );
    }
  }
  if (fvg.maxAgeCandles !== undefined) {
    const v = fvg.maxAgeCandles;
    if (!Number.isInteger(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.fvg.maxAgeCandles: ожидается целое >= 0 (0 = выключен)"
      );
    }
  }
}

function assertValidAdvancedLiquidity(
  liquidity: unknown
): void {
  if (!isRecord(liquidity)) {
    throw new SmcInputError("scoring.liquidity: ожидается объект");
  }
  if (liquidity.eqToleranceAtr !== undefined) {
    const v = liquidity.eqToleranceAtr;
    if (!Number.isFinite(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.liquidity.eqToleranceAtr: ожидается конечное число >= 0"
      );
    }
  }
  if (liquidity.eqConfirmBars !== undefined) {
    const v = liquidity.eqConfirmBars;
    if (!Number.isInteger(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.liquidity.eqConfirmBars: ожидается целое >= 0 (0 = выключен)"
      );
    }
  }
  if (liquidity.sweepMinPenetrationAtr !== undefined) {
    const v = liquidity.sweepMinPenetrationAtr;
    if (!Number.isFinite(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.liquidity.sweepMinPenetrationAtr: ожидается конечное число >= 0"
      );
    }
  }
  if (liquidity.maxAgeCandles !== undefined) {
    const v = liquidity.maxAgeCandles;
    if (!Number.isInteger(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.liquidity.maxAgeCandles: ожидается целое >= 0 (0 = выключен)"
      );
    }
  }
}

function assertValidAdvancedOrderBlock(
  orderBlock: unknown
): void {
  if (!isRecord(orderBlock)) {
    throw new SmcInputError("scoring.orderBlock: ожидается объект");
  }
  if (orderBlock.impulseMaxCandles !== undefined) {
    const v = orderBlock.impulseMaxCandles;
    if (!Number.isInteger(v as number) || (v as number) < 1 || (v as number) > 10) {
      throw new SmcInputError(
        "scoring.orderBlock.impulseMaxCandles: ожидается целое 1..10"
      );
    }
  }
  if (orderBlock.confirmMaxCandles !== undefined) {
    const v = orderBlock.confirmMaxCandles;
    if (!Number.isInteger(v as number) || (v as number) < 1 || (v as number) > 100) {
      throw new SmcInputError(
        "scoring.orderBlock.confirmMaxCandles: ожидается целое 1..100"
      );
    }
  }
  if (orderBlock.maxAgeCandles !== undefined) {
    const v = orderBlock.maxAgeCandles;
    if (!Number.isInteger(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.orderBlock.maxAgeCandles: ожидается целое >= 0 (0 = выключен)"
      );
    }
  }
  if (orderBlock.sweepLookbackCandles !== undefined) {
    const v = orderBlock.sweepLookbackCandles;
    if (!Number.isInteger(v as number) || (v as number) < 0) {
      throw new SmcInputError(
        "scoring.orderBlock.sweepLookbackCandles: ожидается целое >= 0 (0 = выключен)"
      );
    }
  }
}

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

  // Phase 3D-A advanced groups — optional, fail-closed
  if (config.displacement !== undefined) {
    assertValidAdvancedDisplacement(config.displacement);
  }
  if (config.fvg !== undefined) {
    assertValidAdvancedFvg(config.fvg);
  }
  if (config.liquidity !== undefined) {
    assertValidAdvancedLiquidity(config.liquidity);
  }
  if (config.orderBlock !== undefined) {
    assertValidAdvancedOrderBlock(config.orderBlock);
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

// ============================================================
// Canonical resolution — единственная точка разрешения
// Phase3D advanced значений. Старые конфиги без групп
// возвращают EXACT текущее поведение.
// ============================================================

/**
 * Канонический resolver Phase3D advanced конфига.
 * - полностью покрывает все 4 группы;
 * - недостающие поля дополняются каноническими fallback'ами;
 * - FVG/Liquidity maxAge fallback — 0 (scoring semantics),
 *   а не 500/750 module defaults;
 * - порядок fallback'ов — единственный источник (см. audit §5).
 *
 * Чистая функция, без мутаций входа.
 */
export function resolveSmcAdvancedConfig(
  config: SmcScoringConfig
): ResolvedSmcAdvancedConfig {
  // Используем defaultXConfig как канонический источник для
  // тех полей, где scoring fallback совпадаует с module default.
  // Для FVG/Liquidity maxAge используем явный 0.
  const dispDefault = defaultDisplacementConfig(config.tf);
  const fvgDefault = defaultFvgConfig(config.tf);
  const liqDefault = defaultLiquidityConfig(config.tf);
  const obDefault = defaultOrderBlockConfig(config.tf, "swing");

  return {
    displacement: {
      bodyAtrMin:
        config.displacement?.bodyAtrMin ?? dispDefault.bodyAtrMin,
      rangeAtrMin:
        config.displacement?.rangeAtrMin ?? dispDefault.rangeAtrMin,
      bullCloseLocMin:
        config.displacement?.bullCloseLocMin ?? dispDefault.bullCloseLocMin,
      bearCloseLocMax:
        config.displacement?.bearCloseLocMax ?? dispDefault.bearCloseLocMax
    },
    fvg: {
      minGapAtr: config.fvg?.minGapAtr ?? fvgDefault.minGapAtr,
      maxAgeCandles: config.fvg?.maxAgeCandles ?? 0
    },
    liquidity: {
      eqToleranceAtr:
        config.liquidity?.eqToleranceAtr ?? liqDefault.eqToleranceAtr,
      eqConfirmBars:
        config.liquidity?.eqConfirmBars ?? liqDefault.eqConfirmBars,
      sweepMinPenetrationAtr:
        config.liquidity?.sweepMinPenetrationAtr ??
        liqDefault.sweepMinPenetrationAtr,
      maxAgeCandles: config.liquidity?.maxAgeCandles ?? 0
    },
    orderBlock: {
      impulseMaxCandles:
        config.orderBlock?.impulseMaxCandles ?? obDefault.impulseMaxCandles,
      confirmMaxCandles:
        config.orderBlock?.confirmMaxCandles ?? obDefault.confirmMaxCandles,
      maxAgeCandles:
        config.orderBlock?.maxAgeCandles ?? obDefault.maxAgeCandles,
      sweepLookbackCandles:
        config.orderBlock?.sweepLookbackCandles ??
        obDefault.sweepLookbackCandles
    }
  };
}

/**
 * Композиция sub-configs проверенных подмодулей из одного
 * scoring-config (без ручного дублирования параметров).
 * Константы displacement/FVG — ТЕ ЖЕ, что в проверенном
 * OB core (единая semantics примитивов).
 *
 * Phase 3D-A: top-level sub-configs уже используют resolved
 * advanced значения. ВАЖНО: findOrderBlocks внутри всё ещё
 * хардкодит displacement 1.5/2.0/0.6/0.4 и FVG minGap 0.1
 * (lib/smc/order-blocks.ts:260) — разрыв между top-level
 * и OB internal сохраняется до 3D-B. Для старых конфигов
 * (без advanced полей) resolved === hardcoded, поэтому
 * семантика идентична; для кастомных advanced значений
 * top-level и OB разойдутся — это известное ограничение
 * 3D-A, устраняется в 3D-B путём проброса resolved
 * displacement/FVG в OB sub-evaluation.
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
  const adv = resolveSmcAdvancedConfig(config);
  const displacement = {
    ...defaultDisplacementConfig(config.tf),
    atrPeriod: config.atrPeriod,
    bodyAtrMin: adv.displacement.bodyAtrMin,
    rangeAtrMin: adv.displacement.rangeAtrMin,
    bullCloseLocMin: adv.displacement.bullCloseLocMin,
    bearCloseLocMax: adv.displacement.bearCloseLocMax
  };
  const fvg = {
    ...defaultFvgConfig(config.tf),
    atrPeriod: config.atrPeriod,
    minGapAtr: adv.fvg.minGapAtr,
    maxAgeCandles: adv.fvg.maxAgeCandles
  };
  const liquidity = {
    ...defaultLiquidityConfig(config.tf),
    atrPeriod: config.atrPeriod,
    swingLeft: config.swingLeft,
    swingRight: config.swingRight,
    eqToleranceAtr: adv.liquidity.eqToleranceAtr,
    eqConfirmBars: adv.liquidity.eqConfirmBars,
    sweepMinPenetrationAtr: adv.liquidity.sweepMinPenetrationAtr,
    maxAgeCandles: adv.liquidity.maxAgeCandles
  };
  const orderBlockSwing = {
    ...defaultOrderBlockConfig(config.tf, "swing"),
    swingLeft: config.swingLeft,
    swingRight: config.swingRight,
    atrPeriod: config.atrPeriod,
    impulseMaxCandles: adv.orderBlock.impulseMaxCandles,
    confirmMaxCandles: adv.orderBlock.confirmMaxCandles,
    maxAgeCandles: adv.orderBlock.maxAgeCandles,
    sweepLookbackCandles: adv.orderBlock.sweepLookbackCandles
  };
  const orderBlockInternal = {
    ...defaultOrderBlockConfig(config.tf, "internal"),
    swingLeft: config.internalLeft,
    swingRight: config.internalRight,
    atrPeriod: config.atrPeriod,
    impulseMaxCandles: adv.orderBlock.impulseMaxCandles,
    confirmMaxCandles: adv.orderBlock.confirmMaxCandles,
    maxAgeCandles: adv.orderBlock.maxAgeCandles,
    sweepLookbackCandles: adv.orderBlock.sweepLookbackCandles
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
