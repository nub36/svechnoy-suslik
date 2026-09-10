/**
 * SMC Phase 3A — unified PURE SMC evaluator.
 *
 * evaluateSmc(CLOSED candles, config, asOf) → SmcEvaluation:
 * композиция ТОЛЬКО проверенных слоёв на ОДНОМ canonical
 * horizon (validateAndPrepare + horizonCandles Phase 1):
 *   - evaluateStructure swing + internal (Phase 1);
 *   - evaluateDisplacements / evaluateFvgs (Phase 2A);
 *   - evaluateLiquidity (Phase 2B);
 *   - findOrderBlocks swing + internal (Phase 2C);
 *   - evaluateDealingRange (Phase 2D);
 * далее — explainable scoring (scoring.ts).
 *
 * ВТОРОГО АЛГОРИТМА SMC НЕТ: единый atrPeriod/окна идут во
 * все sublayers через deriveSubConfigs(config).
 *
 * HARD vs SOFT: hard prerequisite failure →
 * direction = CANNOT_EVALUATE, scores = null (НЕ подделываются),
 * explicit reason codes. Soft отсутствие фактов (нет range/OB/
 * FVG/sweep, фаза не определена/переход) НЕ делает глобальный
 * CANNOT_EVALUATE — только availability.softUnavailable.
 * NEUTRAL ≠ CANNOT_EVALUATE.
 *
 * NO LOOKAHEAD: ни один submodule не видит свечу после asOf;
 * evaluateSmc(full, config, T) ≡ evaluateSmc(prefix, T)
 * (serialized, включая scores/reasons/availability).
 *
 * БЕЗ Prisma/DB/workers/Signal: чистая детерминированная
 * функция (raw, config, asOf).
 */

import {
  evaluateDisplacements,
  SmcDisplacement
} from "./displacement";
import { evaluateFvgs, SmcFvg } from "./fvg";
import { evaluateStructure } from "./fsm";
import {
  evaluateLiquidity,
  SmcLiquidityLevel
} from "./liquidity";
import {
  findOrderBlocks,
  SmcOrderBlock
} from "./order-blocks";
import {
  evaluateDealingRange,
  SmcRangeEvaluation
} from "./range";
import {
  SmcScoringConfig,
  assertValidSmcScoringConfig,
  deriveSubConfigs,
  minimumSwingHistoryCandles
} from "./config";
import {
  evaluateSmcFromFacts,
  SmcFacts,
  SmcScoreReason
} from "./scoring";
import { atrValueAt, computeAtrSeries } from "./volatility";
import {
  assertValidAsOf,
  horizonCandles,
  validateAndPrepare
} from "./validate";
import {
  SmcStructureResult,
  SmcTimeframe
} from "./types";

export type SmcAvailabilityCode =
  | "INSUFFICIENT_HISTORY"
  | "ATR_UNAVAILABLE"
  | "NO_SWING_HIGH"
  | "NO_SWING_LOW"
  | "NO_ACTIVE_DEALING_RANGE"
  | "NO_SWING_ORDER_BLOCK"
  | "NO_INTERNAL_ORDER_BLOCK"
  | "NO_ACTIVE_FVG"
  | "NO_RECENT_LIQUIDITY_SWEEP"
  | "STRUCTURE_UNDEFINED"
  | "STRUCTURE_TRANSITION";

export interface SmcAvailabilityReason {
  code: SmcAvailabilityCode;
  /** Русский человекочитаемый label (НЕ identity). */
  label: string;
}

export interface SmcAvailability {
  evaluable: boolean;
  hardFailures: SmcAvailabilityReason[];
  softUnavailable: SmcAvailabilityReason[];
}

export type SmcEvaluationDirection =
  | "LONG"
  | "SHORT"
  | "NEUTRAL"
  | "CANNOT_EVALUATE";

export interface SmcEvaluation {
  tf: SmcTimeframe;
  asOf: Date;
  availability: SmcAvailability;
  internalStructure: SmcStructureResult | null;
  swingStructure: SmcStructureResult | null;
  displacements: SmcDisplacement[];
  fvgs: SmcFvg[];
  liquidity: SmcLiquidityLevel[];
  internalOrderBlocks: SmcOrderBlock[];
  swingOrderBlocks: SmcOrderBlock[];
  dealingRange: SmcRangeEvaluation | null;
  /** null при hard failure (scores НЕ подделываются). */
  longScore: number | null;
  shortScore: number | null;
  direction: SmcEvaluationDirection;
  reasons: SmcScoreReason[];
}

const HARD_LABELS = {
  INSUFFICIENT_HISTORY:
    "Недостаточно истории CLOSED свеч для swing-структуры",
  ATR_UNAVAILABLE:
    "ATR недоступен на последней свече оценки",
  NO_SWING_HIGH: "Нет подтверждённого swing-high",
  NO_SWING_LOW: "Нет подтверждённого swing-low"
} as const;

const SOFT_LABELS: Record<string, string> = {
  NO_ACTIVE_DEALING_RANGE:
    "Нет активного dealing range",
  NO_SWING_ORDER_BLOCK:
    "Нет свежего активного swing order block",
  NO_INTERNAL_ORDER_BLOCK:
    "Нет свежего активного internal order block",
  NO_ACTIVE_FVG: "Нет свежего активного FVG",
  NO_RECENT_LIQUIDITY_SWEEP:
    "Нет свежего resolved liquidity sweep",
  STRUCTURE_UNDEFINED: "Структура не определена",
  STRUCTURE_TRANSITION:
    "Структура в переходе (reversal pending)"
};

function hardReason(
  code: keyof typeof HARD_LABELS
): SmcAvailabilityReason {
  return { code, label: HARD_LABELS[code] };
}

function softReason(
  code: string
): SmcAvailabilityReason {
  return {
    code: code as SmcAvailabilityCode,
    label: SOFT_LABELS[code] ?? code
  };
}

/** Shim horizon обратно в raw-форму (свечи уже прошли
 * validateAndPrepare, все CLOSED) — без пересортировки. */
function shim(
  horizon: ReturnType<typeof horizonCandles>
): Parameters<typeof validateAndPrepare>[0] {
  return horizon.map((candle) => ({
    openTime: candle.openTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    closed: true as const
  }));
}

/**
 * Каноническая точка входа Phase 3A: unified SMC evaluation
 * + explainable scoring. Невалидный вход (несогласованный
 * OHLC, не-CLOSED, дубликаты) отклоняется SmcInputError —
 * это нарушение контракта входа, а не market condition.
 */
export function evaluateSmc(
  raw: Parameters<typeof validateAndPrepare>[0],
  config: SmcScoringConfig,
  asOf: Date
): SmcEvaluation {
  assertValidSmcScoringConfig(config);
  assertValidAsOf(asOf);

  const prepared = validateAndPrepare(raw, config.tf);
  const horizon = horizonCandles(prepared, asOf);

  const hardFailures: SmcAvailabilityReason[] = [];
  let swing: SmcStructureResult | null = null;

  if (
    horizon.length <
    minimumSwingHistoryCandles(config)
  ) {
    hardFailures.push(hardReason("INSUFFICIENT_HISTORY"));
  } else {
    const horizonAsOf = new Date(
      horizon[horizon.length - 1].effectiveCloseTime
    );

    swing = evaluateStructure(
      shim(horizon),
      {
        tf: config.tf,
        layer: "swing",
        left: config.swingLeft,
        right: config.swingRight
      },
      horizonAsOf
    );

    const atrSeries = computeAtrSeries(
      horizon,
      config.atrPeriod
    );

    if (
      atrValueAt(atrSeries, horizon.length - 1) === null
    ) {
      hardFailures.push(hardReason("ATR_UNAVAILABLE"));
    }

    if (
      !swing.pivots.some(
        (pivot) => pivot.kind === "high"
      )
    ) {
      hardFailures.push(hardReason("NO_SWING_HIGH"));
    }

    if (
      !swing.pivots.some(
        (pivot) => pivot.kind === "low"
      )
    ) {
      hardFailures.push(hardReason("NO_SWING_LOW"));
    }
  }

  if (hardFailures.length > 0) {
    return {
      tf: config.tf,
      asOf,
      availability: {
        evaluable: false,
        hardFailures,
        softUnavailable: []
      },
      internalStructure: null,
      swingStructure: swing,
      displacements: [],
      fvgs: [],
      liquidity: [],
      internalOrderBlocks: [],
      swingOrderBlocks: [],
      dealingRange: null,
      longScore: null,
      shortScore: null,
      direction: "CANNOT_EVALUATE",
      reasons: []
    };
  }

  const horizonAsOf = new Date(
    horizon[horizon.length - 1].effectiveCloseTime
  );
  const horizonShim = shim(horizon);
  const subs = deriveSubConfigs(config);

  const internal = evaluateStructure(
    horizonShim,
    {
      tf: config.tf,
      layer: "internal",
      left: config.internalLeft,
      right: config.internalRight
    },
    horizonAsOf
  );
  const displacements = evaluateDisplacements(
    horizonShim,
    subs.displacement,
    horizonAsOf
  );
  const fvgs = evaluateFvgs(
    horizonShim,
    subs.fvg,
    horizonAsOf
  );
  const liquidity = evaluateLiquidity(
    horizonShim,
    subs.liquidity,
    horizonAsOf
  );
  const swingOrderBlocks = findOrderBlocks(
    horizon,
    subs.orderBlockSwing
  );
  const internalOrderBlocks = findOrderBlocks(
    horizon,
    subs.orderBlockInternal
  );
  const dealingRange = evaluateDealingRange(
    horizonShim,
    subs.range,
    horizonAsOf
  );

  const facts: SmcFacts = {
    asOfMs: asOf.getTime(),
    horizonEffCloseMs: horizon.map(
      (candle) => candle.effectiveCloseTime.getTime()
    ),
    swing: {
      phase: swing!.phase,
      events: swing!.events
    },
    internal: { phase: internal.phase },
    fvgs,
    liquidity,
    swingOrderBlocks,
    internalOrderBlocks,
    range: {
      current: dealingRange.current,
      priceContext: dealingRange.priceContext
    }
  };

  const scoring = evaluateSmcFromFacts(facts, config);

  return {
    tf: config.tf,
    asOf,
    availability: {
      evaluable: true,
      hardFailures: [],
      softUnavailable: scoring.softCodes.map(softReason)
    },
    internalStructure: internal,
    swingStructure: swing!,
    displacements,
    fvgs,
    liquidity,
    internalOrderBlocks,
    swingOrderBlocks,
    dealingRange,
    longScore: scoring.longScore,
    shortScore: scoring.shortScore,
    direction: scoring.direction,
    reasons: scoring.reasons
  };
}
