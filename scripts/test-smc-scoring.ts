/**
 * SMC Phase 3A — unit-тесты explainable scoring над
 * синтетическими canonical FACTS
 * (запуск: npx tsx scripts/test-smc-scoring.ts).
 *
 * FACTS типизированы РЕАЛЬНЫМИ outputs подмодулей
 * (SmcStructureEvent/SmcFvg/SmcLiquidityLevel/SmcOrderBlock) —
 * альтернативной схемы нет. Композиция evaluateSmc
 * тестируется отдельно (test-smc-evaluate.ts).
 *
 * Веса — initial engineering defaults: 20+15+10+10+15+5+10+10+5
 * = 100 (coherence-инвариант конфига).
 */

import {
  defaultSmcScoringConfig,
  SmcScoringConfig,
  SmcScoringWeights
} from "../lib/smc/config";
import {
  closedBarsSince,
  evaluateSmcFromFacts,
  SmcFacts,
  SmcScoreReason
} from "../lib/smc/scoring";
import { SmcOrderBlock } from "../lib/smc/order-blocks";
import { SmcFvg, SmcFvgState } from "../lib/smc/fvg";
import {
  SmcLiquidityLevel,
  SmcLiquiditySide,
  SmcLiquidityState
} from "../lib/smc/liquidity";
import {
  SmcDirection,
  SmcStructureEvent,
  SmcStructureEventType
} from "../lib/smc/types";
import { SmcInputError } from "../lib/smc/validate";

let passed = 0;
let total = 0;

function ok(condition: boolean, label: string): void {
  total += 1;

  if (condition) {
    passed += 1;
  } else {
    console.error(`FAIL: ${label}`);
  }
}

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

/** Регулярный horizon: effClose(i) = T0+(i+1)h. */
function horizon(n: number): number[] {
  const out: number[] = [];

  for (let i = 0; i < n; i++) {
    out.push(T0 + (i + 1) * HOUR);
  }

  return out;
}

function evMs(index: number): number {
  return T0 + (index + 1) * HOUR;
}

function cfg(
  overrides: Partial<SmcScoringConfig> = {},
  weightOverrides: Partial<SmcScoringWeights> = {}
): SmcScoringConfig {
  return {
    ...defaultSmcScoringConfig("1h"),
    ...overrides,
    weights: {
      ...defaultSmcScoringConfig("1h").weights,
      ...weightOverrides
    }
  };
}

function mkEvent(
  type: SmcStructureEventType,
  dir: SmcDirection,
  confIndex: number
): SmcStructureEvent {
  return {
    key: `SMC1|E|1h|swing|${type}|${dir}|pivot|${evMs(confIndex) - HOUR}`,
    layer: "swing",
    type,
    dir,
    brokenPivotKey: "SMC1|P|1h|swing|high|0",
    brokenLevelPrice: 100,
    eventTime: new Date(evMs(confIndex) - HOUR),
    confirmedAt: new Date(evMs(confIndex)),
    protectedAnchor: null
  };
}

function mkOb(
  direction: SmcDirection,
  layer: "swing" | "internal",
  state: SmcOrderBlock["state"],
  confIndex: number,
  bottom = 84,
  top = 90
): SmcOrderBlock {
  return {
    key: `SMC1|OB|1h|${direction}|${layer}|event|${evMs(confIndex) - HOUR}`,
    tf: "1h",
    direction,
    layer,
    bottom,
    top,
    eventTime: new Date(evMs(confIndex) - 4 * HOUR),
    impulseStartAt: new Date(evMs(confIndex) - 3 * HOUR),
    impulseEndAt: new Date(evMs(confIndex) - 2 * HOUR),
    structureEventKey: `SMC1|E|1h|${layer}|BOS|${direction}|p|0`,
    structureEventType: "BOS",
    structureEventTime: new Date(evMs(confIndex) - HOUR),
    confirmedAt: new Date(evMs(confIndex)),
    firstTouchedAt: null,
    firstMitigatedAt: null,
    maxPenetrationFraction: 0,
    retests: 0,
    invalidatedAt: null,
    expiredAt: null,
    preConfirmationTouches: 0,
    hasFvgInImpulse: false,
    hasLiquiditySweepBeforeImpulse: false,
    state
  };
}

function mkFvg(
  direction: SmcDirection,
  state: SmcFvgState,
  confIndex: number,
  bottom = 90,
  top = 95
): SmcFvg {
  return {
    key: `SMC1|FVG|1h|${direction}|${evMs(confIndex) - 2 * HOUR}`,
    tf: "1h",
    direction,
    bottom,
    top,
    ce: (bottom + top) / 2,
    gapSize: top - bottom,
    sizeAtr: 0.5,
    eventTime: new Date(evMs(confIndex) - 2 * HOUR),
    confirmedAt: new Date(evMs(confIndex)),
    firstTouchedAt: null,
    ceTouchedAt: null,
    fullFilledByExcursionAt: null,
    invalidatedByCloseAt: null,
    expiredAt: null,
    fillFraction: 0,
    state
  };
}

function mkLevel(
  side: SmcLiquiditySide,
  state: SmcLiquidityState,
  resolvedIndex: number | null
): SmcLiquidityLevel {
  return {
    key: `SMC1|LQ|1h|${side}|STRUCTURAL|${side}${resolvedIndex ?? "open"}`,
    tf: "1h",
    side,
    origin: "STRUCTURAL",
    price: side === "BUY_SIDE" ? 100 : 80,
    sourcePivotKeys: ["SMC1|P|1h|swing|high|0"],
    eventTime: new Date(T0 + HOUR),
    createdAt: new Date(T0 + 2 * HOUR),
    state,
    resolvedAt:
      resolvedIndex === null
        ? null
        : new Date(evMs(resolvedIndex)),
    resolvedByCandleTime:
      resolvedIndex === null
        ? null
        : new Date(evMs(resolvedIndex) - HOUR),
    sweepPenetrationAtr:
      state === "SWEPT" ? 0.3 : null
  };
}

function baseFacts(
  horizonLength = 100
): SmcFacts {
  return {
    asOfMs: evMs(horizonLength - 1),
    horizonEffCloseMs: horizon(horizonLength),
    swing: { phase: "UNDEFINED", events: [] },
    internal: { phase: "UNDEFINED" },
    fvgs: [],
    liquidity: [],
    swingOrderBlocks: [],
    internalOrderBlocks: [],
    range: null
  };
}

function reasonOf(
  reasons: SmcScoreReason[],
  code: string
): SmcScoreReason {
  const found = reasons.find(
    (reason) => reason.code === code
  );

  if (found === undefined) {
    throw new Error(`reason ${code} не найден`);
  }

  return found;
}

/** Инвариант: сумма points reasons === scores; always 9
 * component reasons (+ опционально conflict). */
function checkInvariant(
  facts: SmcFacts,
  config: SmcScoringConfig,
  label: string
): void {
  const r = evaluateSmcFromFacts(facts, config);
  const components = r.reasons.filter(
    (reason) => reason.code !== "DIRECTION_CONFLICT"
  );

  ok(
    components.length === 9 &&
      components.reduce((sum, reason) => sum + reason.longPoints, 0) ===
        r.longScore &&
      components.reduce((sum, reason) => sum + reason.shortPoints, 0) ===
        r.shortScore &&
      r.longScore >= 0 &&
      r.longScore <= 100 &&
      r.shortScore >= 0 &&
      r.shortScore <= 100,
    `${label}: инвариант reasons-sum/score + bounded 0..100 (L=${r.longScore} S=${r.shortScore})`
  );
  ok(
    r.reasons.every(
      (reason) =>
        reason.label.length > 0 &&
        reason.longPoints >= 0 &&
        reason.shortPoints >= 0
    ),
    `${label}: у всех reasons русский label и неотрицательные points`
  );

  return;
}

/* ---------- 7–10. SWING_TREND по фазе ---------- */

{
  const up = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [] }
    },
    cfg()
  );

  ok(
    up.longScore === 20 &&
      up.shortScore === 0 &&
      reasonOf(up.reasons, "SWING_TREND").value === "TREND_UP",
    "9: swing TREND_UP → LONG +20 (SWING_TREND)"
  );
  checkInvariant(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [] }
    },
    cfg(),
    "9"
  );

  const down = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_DOWN", events: [] }
    },
    cfg()
  );

  ok(
    down.longScore === 0 &&
      down.shortScore === 20,
    "10: swing TREND_DOWN → SHORT +20 (зеркало)"
  );

  const undefinedPhase = evaluateSmcFromFacts(
    baseFacts(),
    cfg()
  );

  ok(
    undefinedPhase.longScore === 0 &&
      undefinedPhase.shortScore === 0 &&
      reasonOf(undefinedPhase.reasons, "SWING_TREND").maxPoints === 20,
    "7: phase UNDEFINED → 0 structure points (reason с maxPoints 20)"
  );
  ok(
    undefinedPhase.softCodes.includes("STRUCTURE_UNDEFINED"),
    "7: soft STRUCTURE_UNDEFINED при UNDEFINED"
  );

  const pending = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "REVERSAL_PENDING_DOWN", events: [] }
    },
    cfg()
  );

  ok(
    pending.longScore === 0 &&
      pending.shortScore === 0 &&
      pending.softCodes.includes("STRUCTURE_TRANSITION"),
    "8: REVERSAL_PENDING → 0 swing bias + soft STRUCTURE_TRANSITION (старому тренду points нет)"
  );
}

/* ---------- 11–13. RECENT_SWING_BOS ---------- */

{
  const fresh = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: {
        phase: "TREND_UP",
        events: [mkEvent("BOS", "up", 95)]
      }
    },
    cfg()
  );

  ok(
    reasonOf(fresh.reasons, "RECENT_SWING_BOS").longPoints === 15 &&
      reasonOf(fresh.reasons, "RECENT_SWING_BOS").value === "BOS:up" &&
      fresh.longScore === 35,
    "11: свежий swing BOS up (age 4 <= 10) в TREND_UP → LONG +15 (итого 35 с фазой)"
  );

  const stale = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: {
        phase: "TREND_UP",
        events: [mkEvent("BOS", "up", 80)]
      }
    },
    cfg()
  );

  ok(
    stale.longScore === 20 &&
      stale.shortScore === 0 &&
      reasonOf(stale.reasons, "RECENT_SWING_BOS").longPoints === 0,
    "12: stale BOS (age 19 > 10) → компонент 0 (freshness по CLOSED-индексам), фаза даёт 20"
  );

  const conflict = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: {
        phase: "TREND_UP",
        events: [mkEvent("BOS", "down", 95)]
      }
    },
    cfg()
  );

  ok(
    conflict.longScore === 20 &&
      conflict.shortScore === 0 &&
      reasonOf(conflict.reasons, "RECENT_SWING_BOS").longPoints === 0 &&
      reasonOf(conflict.reasons, "RECENT_SWING_BOS").shortPoints === 0 &&
      reasonOf(conflict.reasons, "RECENT_SWING_BOS").value === "BOS:down",
    "13: свежий BOS, конфликтующий с фазой (down в TREND_UP) → компонент 0"
  );

  // Pending: BOS не начисляется вовсе (фаза не established).
  const pendingBos = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: {
        phase: "REVERSAL_PENDING_UP",
        events: [mkEvent("BOS", "up", 95)]
      }
    },
    cfg()
  );

  ok(
    pendingBos.longScore === 0 &&
      reasonOf(pendingBos.reasons, "RECENT_SWING_BOS").longPoints === 0,
    "13-доп: BOS в pending-фазе не начисляется (нет established phase)"
  );
}

/* ---------- 14–15. INTERNAL_TREND ---------- */

{
  const up = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      internal: { phase: "TREND_UP" }
    },
    cfg()
  );

  ok(
    up.longScore === 10 &&
      reasonOf(up.reasons, "INTERNAL_TREND").longPoints === 10,
    "14: internal TREND_UP → LONG +10"
  );

  const down = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      internal: { phase: "TREND_DOWN" }
    },
    cfg()
  );

  ok(
    down.shortScore === 10,
    "15: internal TREND_DOWN → SHORT +10"
  );
  checkInvariant(
    { ...baseFacts(), internal: { phase: "TREND_DOWN" } },
    cfg(),
    "15"
  );
}

/* ---------- 16–19. LIQUIDITY_SWEEP ---------- */

{
  const sellSweep = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      liquidity: [mkLevel("SELL_SIDE", "SWEPT", 96)]
    },
    cfg()
  );

  ok(
    sellSweep.longScore === 10 &&
      reasonOf(sellSweep.reasons, "LIQUIDITY_SWEEP").value?.startsWith(
        "SELL_SIDE"
      ) === true,
    "16: свежий SELL_SIDE SWEPT (age 3 <= 5) → LONG +10"
  );

  const buySweep = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      liquidity: [mkLevel("BUY_SIDE", "SWEPT", 97)]
    },
    cfg()
  );

  ok(
    buySweep.shortScore === 10,
    "17: свежий BUY_SIDE SWEPT → SHORT +10"
  );

  const staleSweep = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      liquidity: [mkLevel("SELL_SIDE", "SWEPT", 90)]
    },
    cfg()
  );

  ok(
    staleSweep.longScore === 0 &&
      staleSweep.softCodes.includes("NO_RECENT_LIQUIDITY_SWEEP"),
    "18: stale sweep (age 9 > 5) → 0 + soft NO_RECENT_LIQUIDITY_SWEEP"
  );

  const broken = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      liquidity: [mkLevel("SELL_SIDE", "BROKEN", 96)]
    },
    cfg()
  );

  ok(
    broken.longScore === 0 &&
      broken.shortScore === 0,
    "19: BROKEN liquidity не даёт sweep points"
  );

  // Несколько свежих sweep'ов НЕ суммируются: берётся последний.
  const stacked = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      liquidity: [
        mkLevel("SELL_SIDE", "SWEPT", 95),
        mkLevel("SELL_SIDE", "SWEPT", 97)
      ]
    },
    cfg()
  );

  ok(
    stacked.longScore === 10 &&
      reasonOf(stacked.reasons, "LIQUIDITY_SWEEP").value ===
        `SELL_SIDE @${new Date(evMs(97)).toISOString()}`,
    "30-доп: несколько свежих sweep одной стороны → максимум 10 (последний resolvedAt в value)"
  );
}

/* ---------- 20–22. ORDER BLOCKS ---------- */

{
  const swingBull = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [mkOb("up", "swing", "OPEN", 90)]
    },
    cfg()
  );

  ok(
    swingBull.longScore === 15 &&
      reasonOf(swingBull.reasons, "SWING_ORDER_BLOCK").longPoints === 15,
    "20: свежий active bullish swing OB (OPEN, age 9 <= 20) → LONG +15"
  );

  const invalidated = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [mkOb("up", "swing", "INVALIDATED", 90)]
    },
    cfg()
  );

  ok(
    invalidated.longScore === 0 &&
      invalidated.softCodes.includes("NO_SWING_ORDER_BLOCK"),
    "21: INVALIDATED swing OB → 0 + soft NO_SWING_ORDER_BLOCK"
  );

  const expired = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [mkOb("up", "swing", "EXPIRED", 90)]
    },
    cfg()
  );

  ok(
    expired.longScore === 0,
    "21-доп: EXPIRED swing OB → 0"
  );

  const internalBull = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      internalOrderBlocks: [mkOb("up", "internal", "MITIGATED", 90)]
    },
    cfg()
  );

  ok(
    internalBull.longScore === 5,
    "22: свежий active internal OB (MITIGATED) → LONG +5"
  );

  const staleOb = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [mkOb("up", "swing", "OPEN", 70)]
    },
    cfg()
  );

  ok(
    staleOb.longScore === 0,
    "20-доп: stale OB (age 29 > 20) → 0"
  );

  // Несколько OB не суммируются; берётся последний (по confirmedAt).
  const stacked = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [
        mkOb("up", "swing", "OPEN", 88, 80, 86),
        mkOb("up", "swing", "OPEN", 92, 84, 90)
      ]
    },
    cfg()
  );

  ok(
    stacked.longScore === 15 &&
      reasonOf(stacked.reasons, "SWING_ORDER_BLOCK").value ===
        `SMC1|OB|1h|up|swing|event|${evMs(92) - HOUR}`,
    "30: два свежих bullish swing OB → ровно +15 (последний confirmedAt)"
  );
}

/* ---------- 23–24. FVG ---------- */

{
  const openFvg = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      fvgs: [mkFvg("up", "OPEN", 92)]
    },
    cfg()
  );

  ok(
    openFvg.longScore === 10,
    "23: свежий bullish FVG (OPEN, age 7 <= 20) → LONG +10"
  );

  const touched = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      fvgs: [mkFvg("down", "TOUCHED", 92)]
    },
    cfg()
  );

  ok(
    touched.shortScore === 10,
    "23-доп: bearish FVG TOUCHED → SHORT +10"
  );

  const ceMitigated = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      fvgs: [mkFvg("up", "CE_MITIGATED", 92)]
    },
    cfg()
  );

  ok(
    ceMitigated.longScore === 10,
    "23-доп: bullish FVG CE_MITIGATED → LONG +10 (active)"
  );

  let deadPoints = 0;

  for (const state of [
    "FILLED_BY_EXCURSION",
    "INVALIDATED",
    "EXPIRED"
  ] as SmcFvgState[]) {
    const dead = evaluateSmcFromFacts(
      {
        ...baseFacts(),
        fvgs: [mkFvg("up", state, 92)]
      },
      cfg()
    );

    if (dead.longScore !== 0) {
      deadPoints += 1;
    }
  }

  ok(
    deadPoints === 0,
    "24: FILLED_BY_EXCURSION/INVALIDATED/EXPIRED FVG → 0"
  );

  const staleFvg = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      fvgs: [mkFvg("up", "OPEN", 70)]
    },
    cfg()
  );

  ok(
    staleFvg.longScore === 0 &&
      staleFvg.softCodes.includes("NO_ACTIVE_FVG"),
    "24-доп: stale FVG (age 29 > 20) → 0 + soft NO_ACTIVE_FVG"
  );
}

/* ---------- 25–27. RANGE_POSITION ---------- */

{
  const discount = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.2,
          eqBand: 0.02,
          zone: "DISCOUNT",
          outsideRange: false
        }
      }
    },
    cfg()
  );

  ok(
    discount.longScore === 10 &&
      reasonOf(discount.reasons, "RANGE_POSITION").longPoints === 10,
    "25: DISCOUNT → LONG +10"
  );

  const premium = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.8,
          eqBand: 0.02,
          zone: "PREMIUM",
          outsideRange: false
        }
      }
    },
    cfg()
  );

  ok(
    premium.shortScore === 10,
    "26: PREMIUM → SHORT +10"
  );

  const equilibrium = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.5,
          eqBand: 0.02,
          zone: "EQUILIBRIUM",
          outsideRange: false
        }
      }
    },
    cfg()
  );

  ok(
    equilibrium.longScore === 0 &&
      equilibrium.shortScore === 0 &&
      reasonOf(equilibrium.reasons, "RANGE_POSITION").value !== null,
    "27: EQUILIBRIUM → 0 (reason сохраняется с payload позиции)"
  );
}

/* ---------- 28–29. CONFLUENCE ---------- */

{
  const bull = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [mkOb("up", "swing", "OPEN", 90, 84, 90)],
      fvgs: [mkFvg("up", "OPEN", 92, 88, 95)]
    },
    cfg()
  );

  ok(
    bull.longScore ===
      15 + 10 + 5 &&
      reasonOf(bull.reasons, "OB_FVG_CONFLUENCE").longPoints === 5,
    "28: bullish swing OB [84,90] ∩ FVG [88,95] → confluence +5 (L = 15+10+5 = 30)"
  );

  const noOverlap = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [mkOb("up", "swing", "OPEN", 90, 60, 66)],
      fvgs: [mkFvg("up", "OPEN", 92, 88, 95)]
    },
    cfg()
  );

  ok(
    noOverlap.longScore === 15 + 10 &&
      reasonOf(noOverlap.reasons, "OB_FVG_CONFLUENCE").longPoints === 0,
    "29: зоны не перекрываются → confluence 0"
  );

  const internalFallback = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      internalOrderBlocks: [
        mkOb("up", "internal", "OPEN", 90, 84, 90)
      ],
      fvgs: [mkFvg("up", "OPEN", 92, 88, 95)]
    },
    cfg()
  );

  ok(
    reasonOf(internalFallback.reasons, "OB_FVG_CONFLUENCE").longPoints ===
      5,
    "28-доп: confluence fallback на internal OB (swing preferred, иначе internal)"
  );

  const oppositeSides = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swingOrderBlocks: [mkOb("up", "swing", "OPEN", 90, 84, 90)],
      fvgs: [mkFvg("down", "OPEN", 92, 88, 95)]
    },
    cfg()
  );

  ok(
    reasonOf(oppositeSides.reasons, "OB_FVG_CONFLUENCE").longPoints ===
      0 &&
      reasonOf(oppositeSides.reasons, "OB_FVG_CONFLUENCE")
        .shortPoints === 0,
    "29-доп: bullish OB + bearish FVG → confluence нет (направления должны совпадать)"
  );
}

/* ---------- 31/32. инвариант + bounded на наборе фактов ---------- */

{
  const variants: SmcFacts[] = [
    baseFacts(),
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [mkEvent("BOS", "up", 95)] },
      internal: { phase: "TREND_UP" },
      swingOrderBlocks: [mkOb("up", "swing", "OPEN", 90)],
      fvgs: [mkFvg("up", "OPEN", 92, 88, 95)],
      liquidity: [mkLevel("SELL_SIDE", "SWEPT", 96)],
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.1,
          eqBand: 0.02,
          zone: "DISCOUNT",
          outsideRange: false
        }
      }
    },
    {
      ...baseFacts(),
      swing: { phase: "TREND_DOWN", events: [mkEvent("BOS", "down", 95)] },
      internal: { phase: "TREND_DOWN" },
      swingOrderBlocks: [mkOb("down", "swing", "MITIGATED", 90)],
      internalOrderBlocks: [mkOb("down", "internal", "OPEN", 91)],
      fvgs: [mkFvg("down", "TOUCHED", 92)],
      liquidity: [mkLevel("BUY_SIDE", "SWEPT", 97)],
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.9,
          eqBand: 0.02,
          zone: "PREMIUM",
          outsideRange: false
        }
      }
    },
    {
      ...baseFacts(),
      swing: { phase: "REVERSAL_PENDING_UP", events: [] }
    }
  ];

  let allInvariants = true;

  for (const facts of variants) {
    const r = evaluateSmcFromFacts(facts, cfg());
    const components = r.reasons.filter(
      (reason) => reason.code !== "DIRECTION_CONFLICT"
    );
    const sumLong = components.reduce(
      (sum, reason) => sum + reason.longPoints,
      0
    );
    const sumShort = components.reduce(
      (sum, reason) => sum + reason.shortPoints,
      0
    );

    if (
      sumLong !== r.longScore ||
      sumShort !== r.shortScore ||
      r.longScore < 0 ||
      r.longScore > 100 ||
      r.shortScore < 0 ||
      r.shortScore > 100 ||
      components.length !== 9
    ) {
      allInvariants = false;
    }
  }

  ok(
    allInvariants,
    "31/32: сумма points reasons === score и score bounded 0..100 на всех вариантах фактов"
  );

  // Max-наполнение: LONG=100 (все 9 компонентов в long).
  const maximal = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [mkEvent("BOS", "up", 95)] },
      internal: { phase: "TREND_UP" },
      swingOrderBlocks: [mkOb("up", "swing", "OPEN", 90, 84, 90)],
      internalOrderBlocks: [mkOb("up", "internal", "OPEN", 91)],
      fvgs: [mkFvg("up", "OPEN", 92, 88, 95)],
      liquidity: [mkLevel("SELL_SIDE", "SWEPT", 96)],
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.1,
          eqBand: 0.02,
          zone: "DISCOUNT",
          outsideRange: false
        }
      }
    },
    cfg()
  );

  ok(
    maximal.longScore === 100 &&
      maximal.shortScore === 0 &&
      maximal.direction === "LONG",
    "32: максимальный LONG-набор = ровно 100/0, direction LONG"
  );
}

/* ---------- 33–36. direction resolution ---------- */

{
  const long = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [mkEvent("BOS", "up", 95)] },
      internal: { phase: "TREND_UP" }
    },
    cfg({ minimumScore: 40 })
  );

  ok(
    long.longScore === 45 &&
      long.shortScore === 0 &&
      long.direction === "LONG",
    "33: long 45 >= threshold 40, short 0 < 40 → LONG"
  );

  const short = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_DOWN", events: [mkEvent("BOS", "down", 95)] },
      internal: { phase: "TREND_DOWN" }
    },
    cfg({ minimumScore: 40 })
  );

  ok(
    short.direction === "SHORT",
    "34: short 45 >= 40, long 0 → SHORT"
  );

  const neutral = evaluateSmcFromFacts(baseFacts(), cfg({ minimumScore: 30 }));

  ok(
    neutral.longScore === 0 &&
      neutral.shortScore === 0 &&
      neutral.direction === "NEUTRAL",
    "35: обе стороны ниже порога → NEUTRAL"
  );

  const conflict = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [mkEvent("BOS", "up", 95)] },
      internal: { phase: "TREND_UP" },
      liquidity: [mkLevel("BUY_SIDE", "SWEPT", 97)],
      fvgs: [mkFvg("down", "OPEN", 92)],
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.9,
          eqBand: 0.02,
          zone: "PREMIUM",
          outsideRange: false
        }
      }
    },
    cfg({ minimumScore: 30 })
  );

  ok(
    conflict.longScore === 45 &&
      conflict.shortScore === 30 &&
      conflict.direction === "NEUTRAL" &&
      conflict.reasons.some(
        (reason) => reason.code === "DIRECTION_CONFLICT"
      ),
    "36: обе стороны >= порога → NEUTRAL + reason DIRECTION_CONFLICT (0/0 points)"
  );
  checkInvariant(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [mkEvent("BOS", "up", 95)] },
      internal: { phase: "TREND_UP" },
      liquidity: [mkLevel("BUY_SIDE", "SWEPT", 97)],
      fvgs: [mkFvg("down", "OPEN", 92)],
      range: {
        current: {} as never,
        priceContext: {
          price: 100,
          position: 0.9,
          eqBand: 0.02,
          zone: "PREMIUM",
          outsideRange: false
        }
      }
    },
    cfg({ minimumScore: 30 }),
    "36"
  );
}

/* ---------- 40. freshness с таймгэпами ---------- */

{
  // Обычный horizon: возраст события (conf idx 95) = 4.
  const regular = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [mkEvent("BOS", "up", 95)] }
    },
    cfg()
  );

  // Horizon с ТЕМ ЖЕ числом свеч, но таймгэпом 1000h перед
  // последними свечами; event.confirmedAt тоже сдвинут
  // (тот же канонический ИНДЕКС 95). Индексный возраст
  // не меняется.
  const gappedEffCloses = horizon(100).map((ms, i) =>
    i >= 95 ? ms + 1000 * HOUR : ms
  );
  const gappedBos = {
    ...mkEvent("BOS", "up", 95),
    confirmedAt: new Date(gappedEffCloses[95])
  };
  const gapped = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      horizonEffCloseMs: gappedEffCloses,
      swing: { phase: "TREND_UP", events: [gappedBos] }
    },
    cfg()
  );

  ok(
    regular.longScore === gapped.longScore &&
      regular.longScore === 35,
    "40: таймгэп между свечами НЕ влияет на fresh-bars (индексная семантика): 20+15 при обоих horizon"
  );

  // closedBarsSince напрямую: same index, разные ms → один age.
  const regularAge = closedBarsSince(evMs(95), horizon(100));
  const gappedAge = closedBarsSince(
    gappedEffCloses[95],
    gappedEffCloses
  );

  ok(
    regularAge === 4 &&
      gappedAge === 4 &&
      closedBarsSince(evMs(99), horizon(100)) === 0 &&
      closedBarsSince(T0 + 999 * HOUR, horizon(100)) === null,
    "40: closedBarsSince — age по индексам (последняя свеча = 0, нет в horizon = null)"
  );
}

/* ---------- 42. mirror symmetry (синтетика) ---------- */

function mirrorFacts(facts: SmcFacts): SmcFacts {
  const flipPhase = (
    phase: string
  ): string => {
    if (phase === "TREND_UP") return "TREND_DOWN";
    if (phase === "TREND_DOWN") return "TREND_UP";
    if (phase === "REVERSAL_PENDING_UP")
      return "REVERSAL_PENDING_DOWN";
    if (phase === "REVERSAL_PENDING_DOWN")
      return "REVERSAL_PENDING_UP";

    return phase;
  };

  const flipDir = (dir: SmcDirection): SmcDirection =>
    dir === "up" ? "down" : "up";

  return {
    ...facts,
    swing: {
      phase: flipPhase(facts.swing.phase) as SmcFacts["swing"]["phase"],
      events: facts.swing.events.map((event) => ({
        ...event,
        dir: flipDir(event.dir)
      }))
    },
    internal: {
      phase: flipPhase(
        facts.internal.phase
      ) as SmcFacts["internal"]["phase"]
    },
    fvgs: facts.fvgs.map((fvg) => ({
      ...fvg,
      direction: flipDir(fvg.direction),
      bottom: -fvg.top,
      top: -fvg.bottom
    })),
    liquidity: facts.liquidity.map((level) => ({
      ...level,
      side:
        level.side === "BUY_SIDE"
          ? ("SELL_SIDE" as SmcLiquiditySide)
          : ("BUY_SIDE" as SmcLiquiditySide)
    })),
    swingOrderBlocks: facts.swingOrderBlocks.map((ob) => ({
      ...ob,
      direction: flipDir(ob.direction),
      bottom: -ob.top,
      top: -ob.bottom
    })),
    internalOrderBlocks: facts.internalOrderBlocks.map(
      (ob) => ({
        ...ob,
        direction: flipDir(ob.direction),
        bottom: -ob.top,
        top: -ob.bottom
      })
    ),
    range:
      facts.range === null
        ? null
        : {
            current: facts.range.current,
            priceContext:
              facts.range.priceContext === null
                ? null
                : {
                    ...facts.range.priceContext,
                    position:
                      1 - facts.range.priceContext.position,
                    zone:
                      facts.range.priceContext.zone === "DISCOUNT"
                        ? ("PREMIUM" as const)
                        : facts.range.priceContext.zone ===
                            "PREMIUM"
                          ? ("DISCOUNT" as const)
                          : ("EQUILIBRIUM" as const)
                  }
          }
  };
}

{
  const bull: SmcFacts = {
    ...baseFacts(),
    swing: { phase: "TREND_UP", events: [mkEvent("BOS", "up", 95)] },
    internal: { phase: "TREND_UP" },
    swingOrderBlocks: [mkOb("up", "swing", "OPEN", 90, 84, 90)],
    internalOrderBlocks: [mkOb("up", "internal", "OPEN", 91)],
    fvgs: [mkFvg("up", "OPEN", 92, 88, 95)],
    liquidity: [mkLevel("SELL_SIDE", "SWEPT", 96)],
    range: {
      current: {} as never,
      priceContext: {
        price: 100,
        position: 0.1,
        eqBand: 0.02,
        zone: "DISCOUNT",
        outsideRange: false
      }
    }
  };

  const direct = evaluateSmcFromFacts(bull, cfg());
  const mirrored = evaluateSmcFromFacts(mirrorFacts(bull), cfg());

  ok(
    direct.longScore === 100 &&
      direct.shortScore === 0 &&
      mirrored.longScore === 0 &&
      mirrored.shortScore === 100 &&
      mirrored.direction === "SHORT",
    "42: mirror symmetry — LONG 100/0 ↔ SHORT 0/100 (все компоненты зеркальны)"
  );

  const directMap = new Map(
    direct.reasons.map((reason) => [reason.code, reason])
  );
  const mirroredMap = new Map(
    mirrored.reasons.map((reason) => [reason.code, reason])
  );

  let reasonsMirrored = true;

  for (const [code, reason] of directMap) {
    const mirrorReason = mirroredMap.get(code);

    if (
      mirrorReason === undefined ||
      reason.longPoints !== mirrorReason.shortPoints ||
      reason.shortPoints !== mirrorReason.longPoints ||
      reason.maxPoints !== mirrorReason.maxPoints
    ) {
      reasonsMirrored = false;
    }
  }

  ok(
    reasonsMirrored,
    "42: reasons попарно зеркальны (longPoints ↔ shortPoints, maxPoints равны)"
  );
}

/* ---------- config validation ---------- */

{
  const bad: Array<[string, SmcScoringConfig]> = [
    [
      "weight sum 90",
      cfg({}, {
        confluence: 0
      })
    ],
    [
      "weight sum 105",
      cfg({}, { swingStructureBias: 25 })
    ],
    ["minimumScore 101", cfg({ minimumScore: 101 })],
    ["minimumScore -1", cfg({ minimumScore: -1 })],
    ["eqBand 0.5", cfg({ eqBand: 0.5 })],
    ["eqBand -0.1", cfg({ eqBand: -0.1 })],
    ["fvgFreshBars -1", cfg({ fvgFreshBars: -1 })],
    ["swingLeft 0", cfg({ swingLeft: 0 })],
    ["atrPeriod 0", cfg({ atrPeriod: 0 })]
  ];

  let allRejected = true;

  for (const [label, config] of bad) {
    try {
      evaluateSmcFromFacts(baseFacts(), config);
      console.error(`FAIL: config "${label}" принят`);
      allRejected = false;
    } catch (error) {
      if (!(error instanceof SmcInputError)) {
        console.error(`FAIL: config "${label}" — чужой error`);
        allRejected = false;
      }
    }
  }

  ok(
    allRejected,
    "config: сумма весов ≠ 100 / minimumScore вне 0..100 / eqBand / freshness / окна — SmcInputError"
  );

  const custom = evaluateSmcFromFacts(
    {
      ...baseFacts(),
      swing: { phase: "TREND_UP", events: [] }
    },
    cfg({}, { swingStructureBias: 25, confluence: 0 })
  );

  ok(
    custom.longScore === 25,
    "config: когерентный кастомный набор весов (25+15+10+10+15+5+10+10+0=100) принимается и применяется (TREND_UP → 25)"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
