/**
 * SMC Phase 3A — explainable LONG/SHORT scoring (V1, чистая
 * функция над canonical FACTS).
 *
 * FACTS — РЕАЛЬНЫЕ outputs проверенных подмодулей (никакой
 * альтернативной схемы): phase/events структуры, FVG,
 * liquidity levels, order blocks, dealing range context.
 * evaluateSmcFromFacts — unit-тестируемый pure helper;
 * evaluateSmc (evaluate.ts) — canonical композиция, кормящая
 * его результатами подмодулей на ОДНОМ canonical horizon.
 *
 * МОДЕЛЬ (ровно 100 max per direction, веса в config.ts):
 *   A SWING_TREND          established swing phase (20)
 *   B RECENT_SWING_BOS     последний свежий swing BOS по фазе (15)
 *   C INTERNAL_TREND       established internal phase (10)
 *   D LIQUIDITY_SWEEP      последний свежий SWEPT (10)
 *   E SWING_ORDER_BLOCK    свежий active swing OB (15)
 *   F INTERNAL_ORDER_BLOCK свежий active internal OB (5)
 *   G FVG                  свежий active FVG (10)
 *   H RANGE_POSITION       Premium/Discount active range (10)
 *   I OB_FVG_CONFLUENCE    OB+FVG overlap (5, единственный
 *                          deliberate overlap bonus)
 *
 * DIRECTIONAL SELECTION: компоненты E/F/G выбирают РОВНО
 * ОДИН последний fresh active факт ПО ОБОИМ направлениям
 * (action ts, tie — детерминированный key); приоритет
 * bullish по порядку кода запрещён. Confluence (I) строится
 * на ТЕХ ЖЕ выбранных фактах (swing preferred, otherwise
 * internal — после выбора; +5 только при совпадении
 * направлений и пересечении зон).
 *
 * FRESHNESS: возраст события = число CLOSED свеч после его
 * action-свечи по каноническим индексам horizon (closedBarsSince),
 * НЕ wall-clock — таймгэпы истории не влияют. Используются
 * только confirmedAt/resolvedAt (actionable-времена), eventTime
 * для freshness НЕ используется.
 *
 * ПРИНЦИПЫ: один semantic fact — одни points (без double-count:
 * internal phase уже покрывает internal BOS; direction range не
 * начисляется отдельно); несколько событий одного компонента НЕ
 * суммируются (берётся последнее); mirror symmetry обязательна.
 *
 * NEUTRAL ≠ CANNOT_EVALUATE: direction резолвится только при
 * evaluable facts; CANNOT_EVALUATE — исключительно hard
 * prerequisite failure (evaluate.ts).
 */

import { SmcOrderBlock } from "./order-blocks";
import {
  SmcRangeEvaluation,
  SmcRangePriceContext,
  SmcRangeZone
} from "./range";
import { SmcFvg, SmcFvgState } from "./fvg";
import {
  SmcLiquidityLevel,
  SmcLiquiditySide
} from "./liquidity";
import {
  SmcDirection,
  SmcStructureEvent,
  SmcStructureResult
} from "./types";
import {
  SmcScoringConfig,
  assertValidSmcScoringConfig
} from "./config";

/** Canonical facts (типы = реальные outputs подмодулей). */
export interface SmcFacts {
  asOfMs: number;
  /** effectiveCloseTime всех CLOSED свеч horizon по
   * возрастанию — база индексного freshness. */
  horizonEffCloseMs: ReadonlyArray<number>;
  swing: Pick<SmcStructureResult, "phase" | "events">;
  internal: Pick<SmcStructureResult, "phase">;
  fvgs: ReadonlyArray<SmcFvg>;
  liquidity: ReadonlyArray<SmcLiquidityLevel>;
  swingOrderBlocks: ReadonlyArray<SmcOrderBlock>;
  internalOrderBlocks: ReadonlyArray<SmcOrderBlock>;
  /** current + priceContext активного range (или null). */
  range: Pick<
    SmcRangeEvaluation,
    "current" | "priceContext"
  > | null;
}

export type SmcScoreReasonCode =
  | "SWING_TREND"
  | "RECENT_SWING_BOS"
  | "INTERNAL_TREND"
  | "LIQUIDITY_SWEEP"
  | "SWING_ORDER_BLOCK"
  | "INTERNAL_ORDER_BLOCK"
  | "FVG"
  | "RANGE_POSITION"
  | "OB_FVG_CONFLUENCE"
  | "DIRECTION_CONFLICT";

export interface SmcScoreReason {
  code: SmcScoreReasonCode;
  /** Русский человекочитаемый label (НЕ identity). */
  label: string;
  longPoints: number;
  shortPoints: number;
  maxPoints: number;
  /** Детерминированный payload факта (строка/null). */
  value: string | null;
}

export type SmcDirectionResolution =
  | "LONG"
  | "SHORT"
  | "NEUTRAL";

export interface SmcScoring {
  longScore: number;
  shortScore: number;
  reasons: SmcScoreReason[];
  /** Deterministic soft reason codes (отсутствующие факты). */
  softCodes: string[];
  direction: SmcDirectionResolution;
}

/**
 * Возраст события в CLOSED свечах: сколько CLOSED свеч horizon
 * ЗАКРЫЛОСЬ после action-свечи (её effectiveCloseTime =
 * actionMs). actionMs нет в horizon → null (не fresh).
 * Индексная семантика: таймгэпы между свечами не влияют.
 */
export function closedBarsSince(
  actionMs: number,
  horizonEffCloseMs: ReadonlyArray<number>,
  indexByEffClose?: ReadonlyMap<number, number>
): number | null {
  const index =
    indexByEffClose === undefined
      ? horizonEffCloseMs.indexOf(actionMs)
      : (indexByEffClose.get(actionMs) ?? null);

  if (index === null || index === -1) {
    return null;
  }

  return horizonEffCloseMs.length - 1 - index;
}

const OB_ACTIVE_STATES = new Set([
  "OPEN",
  "MITIGATED"
]);

const FVG_ACTIVE_STATES = new Set<SmcFvgState>([
  "OPEN",
  "TOUCHED",
  "CE_MITIGATED"
]);

/** Последний по (confirmedAt, key) элемент из свежих,
 * удовлетворяющих предикату. Детерминированно (tie-break по
 * key невозможен для одинаковых confirmedAt разных ключей
 * практически, но зафиксирован). */
function pickLatest<T>(
  items: ReadonlyArray<T>,
  freshBars: number,
  facts: SmcFacts,
  actionMs: (item: T) => number | null,
  predicate: (item: T) => boolean
): T | null {
  let best: T | null = null;
  let bestConfirm = -1;
  let bestKey = "";

  for (const item of items) {
    if (!predicate(item)) {
      continue;
    }

    const at = actionMs(item);

    if (at === null) {
      continue;
    }

    const age = closedBarsSince(at, facts.horizonEffCloseMs);

    if (age === null || age > freshBars) {
      continue;
    }

    const confirm = at;
    const key =
      typeof (item as { key?: unknown }).key === "string"
        ? (item as { key: string }).key
        : "";

    if (
      best === null ||
      confirm > bestConfirm ||
      (confirm === bestConfirm && key > bestKey)
    ) {
      best = item;
      bestConfirm = confirm;
      bestKey = key;
    }
  }

  return best;
}

function overlap(
  aBottom: number,
  aTop: number,
  bBottom: number,
  bTop: number
): boolean {
  return aBottom <= bTop && bBottom <= aTop;
}

/**
 * Чистый scoring над canonical facts. Все 9 компонентов дают
 * reason (в т.ч. 0-point); сумма longPoints/shortPoints ===
 * longScore/shortScore (инвариант).
 */
export function evaluateSmcFromFacts(
  facts: SmcFacts,
  config: SmcScoringConfig
): SmcScoring {
  assertValidSmcScoringConfig(config);

  const w = config.weights;
  const softCodes: string[] = [];
  const reasons: SmcScoreReason[] = [];
  let longScore = 0;
  let shortScore = 0;

  const push = (
    code: SmcScoreReasonCode,
    label: string,
    longPoints: number,
    shortPoints: number,
    maxPoints: number,
    value: string | null
  ): void => {
    longScore += longPoints;
    shortScore += shortPoints;
    reasons.push({
      code,
      label,
      longPoints,
      shortPoints,
      maxPoints,
      value
    });
  };

  // --- A. SWING STRUCTURE BIAS ---
  if (facts.swing.phase === "TREND_UP") {
    push(
      "SWING_TREND",
      "Установленная swing-структура: восходящий тренд",
      w.swingStructureBias,
      0,
      w.swingStructureBias,
      "TREND_UP"
    );
  } else if (facts.swing.phase === "TREND_DOWN") {
    push(
      "SWING_TREND",
      "Установленная swing-структура: нисходящий тренд",
      0,
      w.swingStructureBias,
      w.swingStructureBias,
      "TREND_DOWN"
    );
  } else if (facts.swing.phase === "UNDEFINED") {
    push(
      "SWING_TREND",
      "Swing-структура не определена",
      0,
      0,
      w.swingStructureBias,
      "UNDEFINED"
    );
    softCodes.push("STRUCTURE_UNDEFINED");
  } else {
    // REVERSAL_PENDING_*: старому тренду points НЕ выдаются.
    push(
      "SWING_TREND",
      "Swing-структура в переходе (reversal pending)",
      0,
      0,
      w.swingStructureBias,
      facts.swing.phase
    );
    softCodes.push("STRUCTURE_TRANSITION");
  }

  // --- B. RECENT SWING BOS (по установленной фазе) ---
  const freshBos = pickLatest(
    facts.swing.events,
    config.structureEventFreshBars,
    facts,
    (event) =>
      event.type === "BOS"
        ? event.confirmedAt.getTime()
        : null,
    (event) => event.type === "BOS"
  );

  const bosMatchesPhase =
    freshBos !== null &&
    ((facts.swing.phase === "TREND_UP" &&
      freshBos.dir === "up") ||
      (facts.swing.phase === "TREND_DOWN" &&
        freshBos.dir === "down"));

  if (freshBos !== null && bosMatchesPhase) {
    const longPoints = freshBos.dir === "up" ? w.recentSwingBos : 0;
    const shortPoints =
      freshBos.dir === "down" ? w.recentSwingBos : 0;

    push(
      "RECENT_SWING_BOS",
      "Свежий swing BOS подтверждает направление",
      longPoints,
      shortPoints,
      w.recentSwingBos,
      `BOS:${freshBos.dir}`
    );
  } else {
    push(
      "RECENT_SWING_BOS",
      "Свежего swing BOS по текущей фазе нет",
      0,
      0,
      w.recentSwingBos,
      freshBos === null ? null : `BOS:${freshBos.dir}`
    );
  }

  // --- C. INTERNAL STRUCTURE (фаза, без отдельного BOS) ---
  if (facts.internal.phase === "TREND_UP") {
    push(
      "INTERNAL_TREND",
      "Установленная internal-структура: восходящий тренд",
      w.internalStructure,
      0,
      w.internalStructure,
      "TREND_UP"
    );
  } else if (facts.internal.phase === "TREND_DOWN") {
    push(
      "INTERNAL_TREND",
      "Установленная internal-структура: нисходящий тренд",
      0,
      w.internalStructure,
      w.internalStructure,
      "TREND_DOWN"
    );
  } else {
    push(
      "INTERNAL_TREND",
      "Internal-структура не установлена",
      0,
      0,
      w.internalStructure,
      facts.internal.phase
    );
  }

  // --- D. LIQUIDITY SWEEP ---
  const freshSweep = pickLatest(
    facts.liquidity,
    config.sweepFreshBars,
    facts,
    (level) =>
      level.resolvedAt === null
        ? null
        : level.resolvedAt.getTime(),
    (level) => level.state === "SWEPT"
  );

  if (freshSweep !== null) {
    const side: SmcLiquiditySide = freshSweep.side;
    // SELL_SIDE sweep (сняли ликвидность снизу) → bullish
    // context; BUY_SIDE sweep → bearish context.
    push(
      "LIQUIDITY_SWEEP",
      "Свежий sweep ликвидности",
      side === "SELL_SIDE" ? w.liquiditySweep : 0,
      side === "BUY_SIDE" ? w.liquiditySweep : 0,
      w.liquiditySweep,
      `${side} @${freshSweep.resolvedAt!.toISOString()}`
    );
  } else {
    push(
      "LIQUIDITY_SWEEP",
      "Свежего resolved SWEPT нет",
      0,
      0,
      w.liquiditySweep,
      null
    );
    softCodes.push("NO_RECENT_LIQUIDITY_SWEEP");
  }

  // --- E/F. ORDER BLOCKS (fresh + active, по одному) ---
  // Directional recency: ОДИН последний fresh active OB слоя
  // ПО ОБОИМ направлениям (action = confirmedAt; tie — key).
  // Сначала «по одному на направление, затем bullish if/else»
  // запрещено — это bullish-приоритет порядка кода, а не
  // свежайший факт.
  const obPredicate = (ob: SmcOrderBlock): boolean =>
    OB_ACTIVE_STATES.has(ob.state);

  const swingOb = pickLatest(
    facts.swingOrderBlocks,
    config.orderBlockFreshBars,
    facts,
    (ob) => ob.confirmedAt.getTime(),
    obPredicate
  );
  const internalOb = pickLatest(
    facts.internalOrderBlocks,
    config.orderBlockFreshBars,
    facts,
    (ob) => ob.confirmedAt.getTime(),
    obPredicate
  );

  if (swingOb !== null) {
    push(
      "SWING_ORDER_BLOCK",
      swingOb.direction === "up"
        ? "Свежий активный bullish swing order block"
        : "Свежий активный bearish swing order block",
      swingOb.direction === "up" ? w.swingOrderBlock : 0,
      swingOb.direction === "down" ? w.swingOrderBlock : 0,
      w.swingOrderBlock,
      swingOb.key
    );
  } else {
    push(
      "SWING_ORDER_BLOCK",
      "Свежего активного swing order block нет",
      0,
      0,
      w.swingOrderBlock,
      null
    );
    softCodes.push("NO_SWING_ORDER_BLOCK");
  }

  if (internalOb !== null) {
    push(
      "INTERNAL_ORDER_BLOCK",
      internalOb.direction === "up"
        ? "Свежий активный bullish internal order block"
        : "Свежий активный bearish internal order block",
      internalOb.direction === "up"
        ? w.internalOrderBlock
        : 0,
      internalOb.direction === "down"
        ? w.internalOrderBlock
        : 0,
      w.internalOrderBlock,
      internalOb.key
    );
  } else {
    push(
      "INTERNAL_ORDER_BLOCK",
      "Свежего активного internal order block нет",
      0,
      0,
      w.internalOrderBlock,
      null
    );
    softCodes.push("NO_INTERNAL_ORDER_BLOCK");
  }

  // --- G. FVG ---
  // Directional recency: ОДИН последний fresh active FVG по
  // обоим направлениям (confirmedAt, tie — key).
  const fvgPredicate = (fvg: SmcFvg): boolean =>
    FVG_ACTIVE_STATES.has(fvg.state);

  const selectedFvg = pickLatest(
    facts.fvgs,
    config.fvgFreshBars,
    facts,
    (fvg) => fvg.confirmedAt.getTime(),
    fvgPredicate
  );

  if (selectedFvg !== null) {
    push(
      "FVG",
      selectedFvg.direction === "up"
        ? "Свежий активный bullish FVG"
        : "Свежий активный bearish FVG",
      selectedFvg.direction === "up" ? w.fvg : 0,
      selectedFvg.direction === "down" ? w.fvg : 0,
      w.fvg,
      selectedFvg.key
    );
  } else {
    push(
      "FVG",
      "Свежего активного FVG нет",
      0,
      0,
      w.fvg,
      null
    );
    softCodes.push("NO_ACTIVE_FVG");
  }

  // --- H. PREMIUM / DISCOUNT ---
  const rangeContext:
    | {
        zone: SmcRangeZone;
        ctx: SmcRangePriceContext;
      }
    | null =
    facts.range !== null &&
    facts.range.current !== null &&
    facts.range.priceContext !== null
      ? {
          zone: facts.range.priceContext.zone,
          ctx: facts.range.priceContext
        }
      : null;

  if (rangeContext === null) {
    push(
      "RANGE_POSITION",
      "Активный dealing range отсутствует",
      0,
      0,
      w.rangePosition,
      null
    );
    softCodes.push("NO_ACTIVE_DEALING_RANGE");
  } else if (rangeContext.zone === "DISCOUNT") {
    push(
      "RANGE_POSITION",
      "Цена в discount активного диапазона",
      w.rangePosition,
      0,
      w.rangePosition,
      `pos=${rangeContext.ctx.position.toFixed(6)}`
    );
  } else if (rangeContext.zone === "PREMIUM") {
    push(
      "RANGE_POSITION",
      "Цена в premium активного диапазона",
      0,
      w.rangePosition,
      w.rangePosition,
      `pos=${rangeContext.ctx.position.toFixed(6)}`
    );
  } else {
    push(
      "RANGE_POSITION",
      "Цена в equilibrium активного диапазона",
      0,
      0,
      w.rangePosition,
      `pos=${rangeContext.ctx.position.toFixed(6)}`
    );
  }

  // --- I. OB + FVG CONFLUENCE (единственный overlap bonus) ---
  // Confluence строится на ТЕХ ЖЕ выбранных фактах, что
  // получили component points: swing preferred, otherwise
  // internal (после дирекционально-нейтрального выбора OB);
  // +5 только если direction выбранного OB === direction
  // выбранного FVG И зоны перекрываются. Никакого
  // дополнительного дирекционального выбора и bullish-приоритета.
  const confluenceOb =
    swingOb !== null ? swingOb : internalOb;
  const confluence =
    confluenceOb !== null &&
    selectedFvg !== null &&
    confluenceOb.direction === selectedFvg.direction &&
    overlap(
      confluenceOb.bottom,
      confluenceOb.top,
      selectedFvg.bottom,
      selectedFvg.top
    );

  if (confluence && confluenceOb!.direction === "up") {
    push(
      "OB_FVG_CONFLUENCE",
      "Confluence: bullish OB и FVG перекрываются",
      w.confluence,
      0,
      w.confluence,
      null
    );
  } else if (confluence) {
    push(
      "OB_FVG_CONFLUENCE",
      "Confluence: bearish OB и FVG перекрываются",
      0,
      w.confluence,
      w.confluence,
      null
    );
  } else {
    push(
      "OB_FVG_CONFLUENCE",
      "OB+FVG confluence отсутствует",
      0,
      0,
      w.confluence,
      null
    );
  }

  // --- DIRECTION RESOLUTION ---
  let direction: SmcDirectionResolution;
  const longQualifies =
    longScore >= config.minimumScore;
  const shortQualifies =
    shortScore >= config.minimumScore;

  if (longQualifies && shortQualifies) {
    direction = "NEUTRAL";
    reasons.push({
      code: "DIRECTION_CONFLICT",
      label:
        "Обе стороны достигли порога — конфликт, направления нет",
      longPoints: 0,
      shortPoints: 0,
      maxPoints: 0,
      value: `long=${longScore};short=${shortScore}`
    });
  } else if (longQualifies) {
    direction = "LONG";
  } else if (shortQualifies) {
    direction = "SHORT";
  } else {
    direction = "NEUTRAL";
  }

  return {
    longScore,
    shortScore,
    reasons,
    softCodes,
    direction
  };
}
