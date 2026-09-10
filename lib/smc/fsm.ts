/**
 * SMC Phase 1 — structure state machine (спецификация V2 §4)
 * и верхняя точка evaluateStructure.
 *
 * ФОРМАЛЬНЫЕ ПЕРЕХОДЫ (зафиксировано до кода, review V2):
 *
 *   UNDEFINED
 *     ├── close > последний AVAILABLE swing-high (при
 *     │   существовании ≥1 подтверждённого swing-low)
 *     │   → BOS_up, TREND_UP, уровень → CONSUMED
 *     └── close < последний AVAILABLE swing-low (при
 *         существовании ≥1 подтверждённого swing-high)
 *         → BOS_down, TREND_DOWN
 *
 *   TREND_UP
 *     ├── close > activeBreakableUp → BOS_up (continuation),
 *     │   уровень CONSUMED; остаёмся TREND_UP
 *     └── close < protectedLow → CHOCH_down,
 *         REVERSAL_PENDING_DOWN (тренд НЕ меняется)
 *
 *   REVERSAL_PENDING_DOWN
 *     ├── close > уровня CHOCH (reclaim) →
 *     │   CHOCH_INVALIDATED_up, TREND_UP (failed CHoCH)
 *     └── close < НОВОГО (eventTime > eventTime CHOCH)
 *         подтверждённого swing-low → BOS_down,
 *         TREND_DOWN (confirmed reversal)
 *
 *   TREND_DOWN / REVERSAL_PENDING_UP — зеркально.
 *
 * КРИТИЧЕСКИЕ ПРАВИЛА:
 * - Level lifecycle: AVAILABLE → CONSUMED навсегда.
 *   Повторные closes за CONSUMED уровень НЕ создают событий
 *   (duplicate BOS prevention).
 * - activeBreakableUp/Down = детерминированный выбор:
 *   среди AVAILABLE уровней направления с confirmedAt >=
 *   confirmedAt последнего CONSUMED уровня этого направления
 *   берётся последний подтверждённый (tie: позднее eventTime,
 *   затем большая цена). Stale уровни, подтверждённые до
 *   последнего разрыва, не стреляют — continuation BOS
 *   возможен ТОЛЬКО после нового подтверждённого target'а.
 * - protectedLow/High = последний AVAILABLE pivot
 *   противоположного рода (без фильтра по этажу потребления).
 * - Pivot становится AVAILABLE строго со своего confirmedAt и
 *   может быть сломан свечой, чей close >= его confirmedAt
 *   («подтверждён до/на момент break candle»).
 * - AMBIGUOUS WIDE CANDLE: close-правило допускает ровно одно
 *   направление на свечу; если бы close удовлетворил обоим
 *   направлениям — состояние invalid, бросается
 *   SmcAmbiguousBreakError (defensive guard). Для
 *   согласованного OHLC достижение двойного close-условия
 *   исключено конструкцией: свеча, закрывшаяся выше
 *   up-target, уже потребила его при первом таком close, а
 *   пивот, подтверждающийся «внутри» интервала между
 *   уровнями, требует соседних high ниже уровня при
 *   close > уровня, что противоречит high >= close
 *   (доказательство в тестах test-smc-fsm: wick spanning
 *   both levels разрешается close-правилом однозначно).
 * - Internal и swing используют ОДНУ реализацию FSM с разных
 *   pivot-потоков (разные окна pivots.ts).
 */

import { findPivots } from "./pivots";
import {
  assertValidAsOf,
  assertValidStructureParams,
  horizonCandles,
  validateAndPrepare
} from "./validate";
import {
  SmcCandle,
  SmcPivot,
  SmcStructureEvent,
  SmcStructureEventType,
  SmcStructuralLevel,
  StructureParams,
  StructurePhase,
  SmcStructureResult,
  SmcLayer
} from "./types";

export class SmcAmbiguousBreakError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmcAmbiguousBreakError";
  }
}

interface FsmLevel {
  pivot: SmcPivot;
  state: "AVAILABLE" | "CONSUMED";
  consumedAtMs: number | null;
  consumedByEventKey: string | null;
}

interface PendingReversal {
  /** Направление CHOCH-разрыва (down = падение из TREND_UP). */
  dir: "up" | "down";
  levelKey: string;
  levelPrice: number;
  /** openTime CHOCH-свечи; новые targets должны быть позже. */
  eventTimeMs: number;
}

/** Детерминированный выбор уровня: последний подтверждённый
 * среди подходящих; tie → позднее eventTime; tie → выше цена;
 * далее первый встречный (полная детерминированность). */
function pickTarget(
  levels: FsmLevel[],
  minConfirmedMs: number,
  afterEventTimeMs: number | null
): FsmLevel | null {
  let best: FsmLevel | null = null;

  for (const level of levels) {
    if (level.state !== "AVAILABLE") {
      continue;
    }

    const confirmedMs = level.pivot.confirmedAt.getTime();

    if (confirmedMs < minConfirmedMs) {
      continue;
    }

    if (
      afterEventTimeMs !== null &&
      level.pivot.eventTime.getTime() <= afterEventTimeMs
    ) {
      continue;
    }

    if (best === null) {
      best = level;
      continue;
    }

    const bestConfirmed = best.pivot.confirmedAt.getTime();

    if (confirmedMs > bestConfirmed) {
      best = level;
      continue;
    }

    if (confirmedMs === bestConfirmed) {
      const bestEvent = best.pivot.eventTime.getTime();
      const eventMs = level.pivot.eventTime.getTime();

      if (eventMs > bestEvent) {
        best = level;
      } else if (
        eventMs === bestEvent &&
        level.pivot.price > best.pivot.price
      ) {
        best = level;
      }
    }
  }

  return best;
}

function runStructureFsm(
  candles: SmcCandle[],
  pivots: SmcPivot[],
  params: StructureParams
): {
  phase: StructurePhase;
  events: SmcStructureEvent[];
  highLevels: FsmLevel[];
  lowLevels: FsmLevel[];
} {
  const confirmByCloseMs = new Map<number, SmcPivot[]>();

  for (const pivot of pivots) {
    const ms = pivot.confirmedAt.getTime();
    const bucket = confirmByCloseMs.get(ms);

    if (bucket) {
      bucket.push(pivot);
    } else {
      confirmByCloseMs.set(ms, [pivot]);
    }
  }

  const highLevels: FsmLevel[] = [];
  const lowLevels: FsmLevel[] = [];
  const events: SmcStructureEvent[] = [];

  let phase: StructurePhase = "UNDEFINED";
  let pending: PendingReversal | null = null;
  let lastConsumedUpConfirmMs = -1;
  let lastConsumedDownConfirmMs = -1;

  const emitEvent = (
    type: SmcStructureEventType,
    dir: "up" | "down",
    level: FsmLevel,
    candle: SmcCandle
  ): string => {
    const key = `SMC1|E|${params.tf}|${params.layer}|${type}|${dir}|${level.pivot.key}|${candle.openTime.getTime()}`;

    events.push({
      key,
      layer: params.layer,
      type,
      dir,
      brokenPivotKey: level.pivot.key,
      brokenLevelPrice: level.pivot.price,
      eventTime: candle.openTime,
      confirmedAt: candle.effectiveCloseTime
    });

    return key;
  };

  const consume = (
    level: FsmLevel,
    atMs: number,
    eventKey: string
  ): void => {
    level.state = "CONSUMED";
    level.consumedAtMs = atMs;
    level.consumedByEventKey = eventKey;
  };

  for (let t = 0; t < candles.length; t++) {
    const candle = candles[t];
    const closeMs = candle.effectiveCloseTime.getTime();
    const close = candle.close;

    // 1. Пивоты, подтверждаемые этим close, становятся
    // AVAILABLE до break-проверки той же свечи
    // («подтверждён до/на момент break candle»).
    const confirmed = confirmByCloseMs.get(closeMs) ?? [];

    for (const pivot of confirmed) {
      const entry: FsmLevel = {
        pivot,
        state: "AVAILABLE",
        consumedAtMs: null,
        consumedByEventKey: null
      };

      if (pivot.kind === "high") {
        highLevels.push(entry);
      } else {
        lowLevels.push(entry);
      }
    }

    // 2. Переходы.
    if (phase === "UNDEFINED") {
      // Bootstrap: тренд объявляется только структурно —
      // нужен подтверждённый уровень ПРОБИВАЕМОГО рода и
      // хотя бы один подтверждённый уровень ПРОТИВОПОЛОЖНОГО
      // рода как контекст. Первая произвольная свеча выше
      // пивота без контекста тренд не объявляет.
      const haveHigh = highLevels.length > 0;
      const haveLow = lowLevels.length > 0;

      const upTarget = pickTarget(highLevels, -1, null);
      const downTarget = pickTarget(lowLevels, -1, null);

      const upBreak =
        haveLow && upTarget !== null && close > upTarget.pivot.price;
      const downBreak =
        haveHigh &&
        downTarget !== null &&
        close < downTarget.pivot.price;

      if (upBreak && downBreak) {
        throw new SmcAmbiguousBreakError(
          `свеча ${candle.openTime.toISOString()}: close удовлетворяет обоим направлениям`
        );
      }

      if (upBreak) {
        const key = emitEvent("BOS", "up", upTarget!, candle);

        consume(upTarget!, closeMs, key);
        lastConsumedUpConfirmMs =
          upTarget!.pivot.confirmedAt.getTime();
        phase = "TREND_UP";
      } else if (downBreak) {
        const key = emitEvent(
          "BOS",
          "down",
          downTarget!,
          candle
        );

        consume(downTarget!, closeMs, key);
        lastConsumedDownConfirmMs =
          downTarget!.pivot.confirmedAt.getTime();
        phase = "TREND_DOWN";
      }

      continue;
    }

    if (phase === "TREND_UP") {
      const continuation = pickTarget(
        highLevels,
        lastConsumedUpConfirmMs,
        null
      );
      const protectedLow = pickTarget(lowLevels, -1, null);

      const continuationBreak =
        continuation !== null &&
        close > continuation.pivot.price;
      const chochBreak =
        protectedLow !== null &&
        close < protectedLow.pivot.price;

      if (continuationBreak && chochBreak) {
        throw new SmcAmbiguousBreakError(
          `свеча ${candle.openTime.toISOString()}: dual close-break в TREND_UP`
        );
      }

      if (continuationBreak) {
        const key = emitEvent(
          "BOS",
          "up",
          continuation!,
          candle
        );

        consume(continuation!, closeMs, key);
        lastConsumedUpConfirmMs =
          continuation!.pivot.confirmedAt.getTime();
      } else if (chochBreak) {
        const key = emitEvent(
          "CHOCH",
          "down",
          protectedLow!,
          candle
        );

        consume(protectedLow!, closeMs, key);
        pending = {
          dir: "down",
          levelKey: protectedLow!.pivot.key,
          levelPrice: protectedLow!.pivot.price,
          eventTimeMs: candle.openTime.getTime()
        };
        phase = "REVERSAL_PENDING_DOWN";
      }

      continue;
    }

    if (phase === "TREND_DOWN") {
      const continuation = pickTarget(
        lowLevels,
        lastConsumedDownConfirmMs,
        null
      );
      const protectedHigh = pickTarget(highLevels, -1, null);

      const continuationBreak =
        continuation !== null &&
        close < continuation.pivot.price;
      const chochBreak =
        protectedHigh !== null &&
        close > protectedHigh.pivot.price;

      if (continuationBreak && chochBreak) {
        throw new SmcAmbiguousBreakError(
          `свеча ${candle.openTime.toISOString()}: dual close-break в TREND_DOWN`
        );
      }

      if (continuationBreak) {
        const key = emitEvent(
          "BOS",
          "down",
          continuation!,
          candle
        );

        consume(continuation!, closeMs, key);
        lastConsumedDownConfirmMs =
          continuation!.pivot.confirmedAt.getTime();
      } else if (chochBreak) {
        const key = emitEvent(
          "CHOCH",
          "up",
          protectedHigh!,
          candle
        );

        consume(protectedHigh!, closeMs, key);
        pending = {
          dir: "up",
          levelKey: protectedHigh!.pivot.key,
          levelPrice: protectedHigh!.pivot.price,
          eventTimeMs: candle.openTime.getTime()
        };
        phase = "REVERSAL_PENDING_UP";
      }

      continue;
    }

    if (phase === "REVERSAL_PENDING_DOWN") {
      const reversal = pending!;

      if (close > reversal.levelPrice) {
        // Failed CHoCH: reclaim вверх, тренд восстановлен.
        const ghost: FsmLevel = {
          pivot: {
            key: reversal.levelKey,
            layer: params.layer,
            kind: "low",
            price: reversal.levelPrice,
            eventTime: new Date(reversal.eventTimeMs),
            confirmedAt: new Date(reversal.eventTimeMs)
          },
          state: "AVAILABLE",
          consumedAtMs: null,
          consumedByEventKey: null
        };

        const key = emitEvent(
          "CHOCH_INVALIDATED",
          "up",
          ghost,
          candle
        );

        void key;
        pending = null;
        phase = "TREND_UP";
      } else {
        const target = pickTarget(
          lowLevels,
          -1,
          reversal.eventTimeMs
        );

        if (target !== null && close < target.pivot.price) {
          // Confirmed reversal: новый downside structural
          // break по НОВОМУ (позднее CHOCH) пивоту; сам
          // CHOCH-уровень CONSUMED и подтвердить reversal
          // вторично не может.
          const key = emitEvent(
            "BOS",
            "down",
            target,
            candle
          );

          consume(target, closeMs, key);
          lastConsumedDownConfirmMs =
            target.pivot.confirmedAt.getTime();
          pending = null;
          phase = "TREND_DOWN";
        }
      }

      continue;
    }

    if (phase === "REVERSAL_PENDING_UP") {
      const reversal = pending!;

      if (close < reversal.levelPrice) {
        const ghost: FsmLevel = {
          pivot: {
            key: reversal.levelKey,
            layer: params.layer,
            kind: "high",
            price: reversal.levelPrice,
            eventTime: new Date(reversal.eventTimeMs),
            confirmedAt: new Date(reversal.eventTimeMs)
          },
          state: "AVAILABLE",
          consumedAtMs: null,
          consumedByEventKey: null
        };

        emitEvent("CHOCH_INVALIDATED", "down", ghost, candle);
        pending = null;
        phase = "TREND_DOWN";
      } else {
        const target = pickTarget(
          highLevels,
          -1,
          reversal.eventTimeMs
        );

        if (target !== null && close > target.pivot.price) {
          const key = emitEvent("BOS", "up", target, candle);

          consume(target, closeMs, key);
          lastConsumedUpConfirmMs =
            target.pivot.confirmedAt.getTime();
          pending = null;
          phase = "TREND_UP";
        }
      }

      continue;
    }
  }

  return { phase, events, highLevels, lowLevels };
}

function flattenLevel(level: FsmLevel): SmcStructuralLevel {
  return {
    pivotKey: level.pivot.key,
    layer: level.pivot.layer,
    kind: level.pivot.kind,
    price: level.pivot.price,
    eventTime: level.pivot.eventTime,
    confirmedAt: level.pivot.confirmedAt,
    state: level.state,
    consumedAt:
      level.consumedAtMs === null
        ? null
        : new Date(level.consumedAtMs),
    consumedByEventKey: level.consumedByEventKey
  };
}

/**
 * Каноническая точка входа Phase 1.
 *
 * Гарантии:
 * - свечи после asOf физически не попадают в pivots/FSM
 *   (единственный downstream — horizonCandles);
 * - результат — детерминированная функция
 *   (candles, params, asOf): повторный вызов даёт
 *   байт-в-байт идентичный serialized output;
 * - до confirmedAt пивот/событие не возвращаются.
 */
export function evaluateStructure(
  raw: Parameters<typeof validateAndPrepare>[0],
  params: StructureParams,
  asOf: Date
): SmcStructureResult {
  assertValidStructureParams(params);
  assertValidAsOf(asOf);

  const prepared = validateAndPrepare(raw, params.tf);
  const horizon = horizonCandles(prepared, asOf);

  const highPivots = findPivots(horizon, params, "high");
  const lowPivots = findPivots(horizon, params, "low");

  const { phase, events, highLevels, lowLevels } =
    runStructureFsm(horizon, [...highPivots, ...lowPivots], params);

  const result: SmcStructureResult = {
    tf: params.tf,
    layer: params.layer,
    phase,
    pivots: [...highPivots, ...lowPivots],
    events,
    levels: [
      ...highLevels.map(flattenLevel),
      ...lowLevels.map(flattenLevel)
    ]
  };

  return result;
}

/** Экспорт типа слоя для будущих потребителей overlay. */
export type { SmcLayer };
