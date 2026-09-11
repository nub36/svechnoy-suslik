/**
 * SMC overlay projection (P1-A) — ЧИСТАЯ проекция движка в DTO.
 *
 * Единственный источник фактов — существующий движок `lib/smc/*`
 * (точка входа `evaluateSmc`) и существующая стратегическая обвязка
 * (`evaluateMarketsAtCommonHorizon`, `decideAggregationAtCommonHorizon`,
 * `aggregateAssetGroup`). Здесь НЕТ и не может быть:
 *   - второго pivot/BOS/CHOCH/FVG/OB/liquidity/range детектора;
 *   - копированного scoring или его порогов;
 *   - своей фильтрации / eligibility / alignment политики;
 *   - каких-либо часов, сети, БД, React, DOM.
 *
 * Всё, что делает модуль: ограничивает ряд окном (правило runtime),
 * вызывает движок с `engineAsOf`, перекладывает Date→ms, сохраняет
 * состояния и lifecycle-времени дословно и строит join
 * «причина → факт» ТОЛЬКО по точному идентичность-ключу движка.
 *
 * Ключевое тождество (держится тестами):
 *   windowEnd = H (общий CLOSED горизонт) ⇒ engineAsOf = H + D
 *   {candle : openTime <= windowEnd} == {candle : effectiveCloseTime <= engineAsOf}
 *                                     == truncateCandlesToHorizon(candles, H)
 * поэтому проекция объясняет ровно тот результат, что посчитала стратегия.
 */

import {
  SMC_ENGINE_VERSION,
  SMC_OVERLAY_CONTRACT_VERSION,
  SMC_PROJECTION_WINDOW,
  SMC_PROJECTION_WINDOW_MAX,
  SMC_PROJECTION_WINDOW_MIN,
  requireEpochMs,
  toEpochMs,
  type SmcDtoAggregate,
  type SmcDtoDisplacement,
  type SmcDtoFvgZone,
  type SmcDtoHorizon,
  type SmcDtoLiquidityLevel,
  type SmcDtoMarket,
  type SmcDtoMarketProjection,
  type SmcDtoOrderBlockZone,
  type SmcDtoOverlays,
  type SmcDtoPivot,
  type SmcDtoRange,
  type SmcDtoStrategyView,
  type SmcDtoStructuralLevel,
  type SmcDtoStructureEvent,
  type SmcDtoWhyRow,
} from "./smc-contract";
import {
  minimumSwingHistoryCandles,
  type SmcScoringConfig,
} from "../smc/config";
import { evaluateSmc, type SmcEvaluation } from "../smc/evaluate";
import { SmcInputError } from "../smc/validate";
import {
  SMCTIMEFRAME_MS,
  type SmcRawCandle,
  type SmcTimeframe,
} from "../smc/types";
import {
  DEFAULT_SMART_MONEY_FILTERS,
  evaluateMarketsAtCommonHorizon,
  evaluateSmartMoneyWithCandles,
  type SmartMoneyFilters,
  type SmartMoneyMarketMeta,
} from "../strategies/smart-money";
import {
  decideAggregationAtCommonHorizon,
  type CommonHorizonSelection,
} from "../strategies/common-horizon";
import {
  aggregateAssetGroup,
  type MarketStrategyResult,
} from "../strategies/runtime";

/* ------------------------------------------------------------------ */
/* Ошибки контракта (это НЕ рыночные состояния)                        */
/* ------------------------------------------------------------------ */

/**
 * Нарушение контракта проекции (некорректный вход, несогласованность
 * движка и адаптера). Штатное «не смог оценить» сюда не относится:
 * оно доходит как cannot-evaluate.
 */
export class SmcProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmcProjectionError";
  }
}

/* ------------------------------------------------------------------ */
/* Окно проекции = правило runtime                                     */
/* ------------------------------------------------------------------ */

export type SmcProjectionWindowInput = {
  candles: SmcRawCandle[];
  timeframe: SmcTimeframe;
  /** openTime последней ВКЛЮЧАЕМОЙ закрытой свечи */
  windowEnd: Date;
  /** размер окна анализа; по умолчанию SMC_PROJECTION_WINDOW (500) */
  windowSize?: number;
};

export type SmcProjectionWindow = {
  /** ряд, который уходит в движок (ASC как на входе, без пересортировки) */
  candles: SmcRawCandle[];
  timeframe: SmcTimeframe;
  timeframeDurationMs: number;
  windowEndMs: number;
  engineAsOfMs: number;
  windowRule: number;
  windowStartMs: number | null;
  windowTruncated: boolean;
  droppedBeyondWindowEnd: number;
  droppedUnclosed: number;
};

/**
 * Ограничение ряда: только `closed === true`, только
 * `openTime <= windowEnd`, затем «последние windowSize» — ровно правило
 * `loadSmartMoneyCandles` (DESC take 500 → ASC).
 *
 * Порядок входа НЕ «починяется»: неканонический ряд обязан быть
 * отвергнут самим движком (`SmcInputError`), иначе проекция начала
 * бы рисовать то, чего стратегия не видит.
 */
export function applySmcProjectionWindow(
  input: SmcProjectionWindowInput
): SmcProjectionWindow {
  const durationMs = SMCTIMEFRAME_MS[input.timeframe];
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new SmcProjectionError(
      `applySmcProjectionWindow: неизвестный timeframe ${String(input.timeframe)}`
    );
  }

  const windowEndMs = requireEpochMs(input.windowEnd, "windowEnd");
  if (!Number.isSafeInteger(windowEndMs)) {
    throw new SmcProjectionError(
      `applySmcProjectionWindow: windowEnd должен быть целым числом мс, получено ${windowEndMs}`
    );
  }

  const rawWindow = input.windowSize ?? SMC_PROJECTION_WINDOW;
  if (
    !Number.isInteger(rawWindow) ||
    rawWindow < SMC_PROJECTION_WINDOW_MIN ||
    rawWindow > SMC_PROJECTION_WINDOW_MAX
  ) {
    throw new SmcProjectionError(
      `applySmcProjectionWindow: windowSize должен быть целым в пределах ` +
        `${SMC_PROJECTION_WINDOW_MIN}..${SMC_PROJECTION_WINDOW_MAX} (правило runtime), ` +
        `получено ${String(input.windowSize)}`
    );
  }

  const candles = Array.isArray(input.candles) ? input.candles : [];
  let droppedBeyondWindowEnd = 0;
  let droppedUnclosed = 0;
  const kept: SmcRawCandle[] = [];

  for (const candle of candles) {
    if (candle.closed !== true) {
      droppedUnclosed++;
      continue;
    }
    const ms = requireEpochMs(candle.openTime, "candle.openTime");
    if (ms > windowEndMs) {
      droppedBeyondWindowEnd++;
      continue;
    }
    kept.push(candle);
  }

  const windowTruncated = kept.length > rawWindow;
  const windowed = windowTruncated ? kept.slice(kept.length - rawWindow) : kept;

  return {
    candles: windowed,
    timeframe: input.timeframe,
    timeframeDurationMs: durationMs,
    windowEndMs,
    // Точка доступности движка = effectiveCloseTime последней
    // включённой свечи; для canonical ряда это windowEnd + D.
    engineAsOfMs: windowEndMs + durationMs,
    windowRule: rawWindow,
    windowStartMs:
      windowed.length > 0
        ? requireEpochMs(windowed[0]!.openTime, "windowStart")
        : null,
    windowTruncated,
    droppedBeyondWindowEnd,
    droppedUnclosed,
  };
}

/* ------------------------------------------------------------------ */
/* Проекция фактов (Date → ms, состояния — дословно)                    */
/* ------------------------------------------------------------------ */

function projectPivots(evaluation: SmcEvaluation): SmcDtoPivot[] {
  const out: SmcDtoPivot[] = [];
  for (const result of [evaluation.swingStructure, evaluation.internalStructure]) {
    if (result === null) continue;
    for (const pivot of result.pivots) {
      out.push({
        id: pivot.key,
        layer: pivot.layer,
        kind: pivot.kind,
        price: pivot.price,
        eventTime: requireEpochMs(pivot.eventTime, "pivot.eventTime"),
        confirmedAt: requireEpochMs(pivot.confirmedAt, "pivot.confirmedAt"),
      });
    }
  }
  return out;
}

function projectLevels(evaluation: SmcEvaluation): SmcDtoStructuralLevel[] {
  const out: SmcDtoStructuralLevel[] = [];
  for (const result of [evaluation.swingStructure, evaluation.internalStructure]) {
    if (result === null) continue;
    for (const level of result.levels) {
      out.push({
        id: level.pivotKey,
        pivotId: level.pivotKey,
        layer: level.layer,
        kind: level.kind,
        price: level.price,
        eventTime: requireEpochMs(level.eventTime, "level.eventTime"),
        confirmedAt: requireEpochMs(level.confirmedAt, "level.confirmedAt"),
        state: level.state,
        consumedAt: toEpochMs(level.consumedAt),
        consumedByEventId: level.consumedByEventKey,
      });
    }
  }
  return out;
}

function projectEvents(evaluation: SmcEvaluation): SmcDtoStructureEvent[] {
  const out: SmcDtoStructureEvent[] = [];
  for (const result of [evaluation.swingStructure, evaluation.internalStructure]) {
    if (result === null) continue;
    for (const event of result.events) {
      out.push({
        id: event.key,
        layer: event.layer,
        type: event.type,
        dir: event.dir,
        brokenLevelPrice: event.brokenLevelPrice,
        brokenPivotId: event.brokenPivotKey,
        eventTime: requireEpochMs(event.eventTime, "event.eventTime"),
        confirmedAt: requireEpochMs(event.confirmedAt, "event.confirmedAt"),
        protectedAnchor:
          event.protectedAnchor === null
            ? null
            : {
                pivotId: event.protectedAnchor.pivotKey,
                kind: event.protectedAnchor.kind,
                price: event.protectedAnchor.price,
                eventTime: requireEpochMs(
                  event.protectedAnchor.eventTime,
                  "protectedAnchor.eventTime"
                ),
                confirmedAt: requireEpochMs(
                  event.protectedAnchor.confirmedAt,
                  "protectedAnchor.confirmedAt"
                ),
              },
      });
    }
  }
  return out;
}

function projectLiquidity(evaluation: SmcEvaluation): SmcDtoLiquidityLevel[] {
  return evaluation.liquidity.map((level) => ({
    id: level.key,
    side: level.side,
    origin: level.origin,
    price: level.price,
    sourcePivotIds: [...level.sourcePivotKeys],
    eventTime: requireEpochMs(level.eventTime, "liquidity.eventTime"),
    createdAt: requireEpochMs(level.createdAt, "liquidity.createdAt"),
    state: level.state,
    resolvedAt: toEpochMs(level.resolvedAt),
    resolvedByCandleTime: toEpochMs(level.resolvedByCandleTime),
    sweepPenetrationAtr: level.sweepPenetrationAtr,
  }));
}

function projectFvgs(evaluation: SmcEvaluation): SmcDtoFvgZone[] {
  return evaluation.fvgs.map((fvg) => {
    const eventTime = requireEpochMs(fvg.eventTime, "fvg.eventTime");
    const confirmedAt = requireEpochMs(fvg.confirmedAt, "fvg.confirmedAt");
    return {
      id: fvg.key,
      dir: fvg.direction,
      top: fvg.top,
      bottom: fvg.bottom,
      ce: fvg.ce,
      gapSize: fvg.gapSize,
      sizeAtr: fvg.sizeAtr,
      fillFraction: fvg.fillFraction,
      eventTime,
      confirmedAt,
      // Правый край = подтверждение (закрытие impulse-свечи c).
      zoneStart: eventTime,
      zoneEnd: confirmedAt,
      firstTouchedAt: toEpochMs(fvg.firstTouchedAt),
      ceTouchedAt: toEpochMs(fvg.ceTouchedAt),
      filledByExcursionAt: toEpochMs(fvg.fullFilledByExcursionAt),
      invalidatedByCloseAt: toEpochMs(fvg.invalidatedByCloseAt),
      expiredAt: toEpochMs(fvg.expiredAt),
      state: fvg.state,
    };
  });
}

function projectOrderBlocks(evaluation: SmcEvaluation): SmcDtoOrderBlockZone[] {
  const out: SmcDtoOrderBlockZone[] = [];
  for (const blocks of [
    evaluation.swingOrderBlocks,
    evaluation.internalOrderBlocks,
  ]) {
    for (const ob of blocks) {
      const eventTime = requireEpochMs(ob.eventTime, "ob.eventTime");
      const impulseStartAt = requireEpochMs(
        ob.impulseStartAt,
        "ob.impulseStartAt"
      );
      const impulseEndAt = requireEpochMs(ob.impulseEndAt, "ob.impulseEndAt");
      out.push({
        id: ob.key,
        dir: ob.direction,
        layer: ob.layer,
        top: ob.top,
        bottom: ob.bottom,
        eventTime,
        confirmedAt: requireEpochMs(ob.confirmedAt, "ob.confirmedAt"),
        impulseStartAt,
        impulseEndAt,
        zoneStart: eventTime,
        zoneEnd: impulseEndAt,
        structureEventId: ob.structureEventKey,
        structureEventType: ob.structureEventType,
        structureEventTime: requireEpochMs(
          ob.structureEventTime,
          "ob.structureEventTime"
        ),
        firstTouchedAt: toEpochMs(ob.firstTouchedAt),
        firstMitigatedAt: toEpochMs(ob.firstMitigatedAt),
        invalidatedAt: toEpochMs(ob.invalidatedAt),
        expiredAt: toEpochMs(ob.expiredAt),
        maxPenetrationFraction: ob.maxPenetrationFraction,
        retests: ob.retests,
        preConfirmationTouches: ob.preConfirmationTouches,
        hasFvgInImpulse: ob.hasFvgInImpulse,
        hasLiquiditySweepBeforeImpulse: ob.hasLiquiditySweepBeforeImpulse,
        state: ob.state,
      });
    }
  }
  return out;
}

function projectDisplacements(evaluation: SmcEvaluation): SmcDtoDisplacement[] {
  return evaluation.displacements.map((d) => ({
    id: d.key,
    dir: d.direction,
    eventTime: requireEpochMs(d.eventTime, "displacement.eventTime"),
    confirmedAt: requireEpochMs(d.confirmedAt, "displacement.confirmedAt"),
    bodyAtr: d.bodyAtr,
    rangeAtr: d.rangeAtr,
    closeLocation: d.closeLocation,
  }));
}

/**
 * Range БЕЗ clamp: `position` перекладывается дословно (бывает <0 и >1),
 * `outsideRange` — отдельный флаг. Никакого Math.min/max и никакого
 * «допиливания» equilibrium.
 */
export function projectRange(
  evaluation: SmcEvaluation | null
): SmcDtoRange | null {
  const rangeEvaluation = evaluation?.dealingRange ?? null;
  if (
    rangeEvaluation === null ||
    rangeEvaluation.current === null ||
    rangeEvaluation.priceContext === null
  ) {
    return null;
  }
  const current = rangeEvaluation.current;
  const ctx = rangeEvaluation.priceContext;
  return {
    id: current.key,
    dir: current.direction,
    low: current.low,
    high: current.high,
    equilibrium: current.equilibrium,
    eqBand: ctx.eqBand,
    eventTime: requireEpochMs(current.eventTime, "range.eventTime"),
    confirmedAt: requireEpochMs(current.confirmedAt, "range.confirmedAt"),
    replacedAt: toEpochMs(current.replacedAt),
    anchorStartPivotId: current.anchorStartPivotKey,
    anchorEndPivotId: current.anchorEndPivotKey,
    price: ctx.price,
    position: ctx.position,
    zone: ctx.zone,
    outsideRange: ctx.outsideRange,
    historyVersions: rangeEvaluation.history.length,
  };
}

/**
 * Join «причина → факт». Правило одно и оно не эвристическое: если
 * `value` reason'а — строка, ровно совпадающая с id спроецированного
 * факта (так движок отдаёт ключи для OB/FVG), то `factIds=[value]`;
 * иначе `[]` (`TREND_UP`, `BOS:up`, `SELL_SIDE @…`, `pos=…`, `null`).
 *
 * Подбирать факт по направлению/цене/близости времени ЗАПРЕЩЕНО:
 * это был бы второй, угадывающий алгоритм.
 */
export function projectWhy(
  evaluation: SmcEvaluation | null,
  overlays: SmcDtoOverlays
): SmcDtoWhyRow[] {
  if (evaluation === null) return [];

  const ids = new Set<string>();
  for (const p of overlays.pivots) ids.add(p.id);
  for (const l of overlays.levels) ids.add(l.pivotId);
  for (const e of overlays.events) ids.add(e.id);
  for (const l of overlays.liquidity) ids.add(l.id);
  for (const f of overlays.fvgs) ids.add(f.id);
  for (const o of overlays.orderBlocks) ids.add(o.id);
  if (overlays.range !== null) ids.add(overlays.range.id);
  for (const d of overlays.displacements) ids.add(d.id);

  return evaluation.reasons.map((reason) => ({
    code: reason.code,
    label: reason.label,
    longPoints: reason.longPoints,
    shortPoints: reason.shortPoints,
    maxPoints: reason.maxPoints,
    value: reason.value,
    factIds:
      reason.value !== null && ids.has(reason.value) ? [reason.value] : [],
  }));
}

function emptyOverlays(): SmcDtoOverlays {
  return {
    pivots: [],
    levels: [],
    events: [],
    liquidity: [],
    fvgs: [],
    orderBlocks: [],
    range: null,
    displacements: [],
    counts: {
      pivots: 0,
      levels: 0,
      events: 0,
      liquidity: 0,
      fvgs: 0,
      orderBlocks: 0,
      range: 0,
      displacements: 0,
    },
    phases: { swing: null, internal: null },
  };
}

/**
 * Defensive guard: ни один спроецированный факт не может иметь
 * `confirmedAt > engineAsOf` (для liquidity — `createdAt`). Движок
 * устроен так по построению, но guard держит инвариант на уровне
 * контракта и ловит будущие изменения усечения/окна.
 */
export function assertFactsNotBeyondAsOf(
  overlays: Pick<
    SmcDtoOverlays,
    | "pivots"
    | "levels"
    | "events"
    | "liquidity"
    | "fvgs"
    | "orderBlocks"
    | "displacements"
  >,
  engineAsOfMs: number,
  context: string
): void {
  const offenders: string[] = [];
  const check = (id: string, at: number, field: string): void => {
    if (at > engineAsOfMs) {
      offenders.push(
        `${field} ${id}: confirmedAt=${at} > engineAsOf=${engineAsOfMs}`
      );
    }
  };
  for (const p of overlays.pivots) check(p.id, p.confirmedAt, "pivot");
  for (const l of overlays.levels) check(l.id, l.confirmedAt, "level");
  for (const e of overlays.events) check(e.id, e.confirmedAt, "event");
  for (const l of overlays.liquidity) check(l.id, l.createdAt, "liquidity");
  for (const f of overlays.fvgs) check(f.id, f.confirmedAt, "fvg");
  for (const o of overlays.orderBlocks) check(o.id, o.confirmedAt, "orderBlock");
  for (const d of overlays.displacements) check(d.id, d.confirmedAt, "displacement");
  if (offenders.length > 0) {
    throw new SmcProjectionError(
      `${context}: lookahead-нарушение (${offenders.join("; ")})`
    );
  }
}

/* ------------------------------------------------------------------ */
/* Horizon-метаданные                                                  */
/* ------------------------------------------------------------------ */

export type SmcProjectionHorizonInput = {
  /** по умолчанию "exchange"; "strategy" — когда windowEnd = общий H */
  mode?: "strategy" | "exchange";
  /** выбор общего горизонта (если уже сделан) — только метаданные */
  selection?: CommonHorizonSelection | null;
  /** явный wall clock (эхо), если вызывающий его передавал */
  asOfNow?: Date | null;
};

function buildMarketHorizon(
  analysisWindow: SmcProjectionWindow,
  config: SmcScoringConfig,
  horizonInput: SmcProjectionHorizonInput
): SmcDtoHorizon {
  const selection = horizonInput.selection ?? null;
  const windowEndMs = analysisWindow.windowEndMs;
  return {
    mode: horizonInput.mode ?? "exchange",
    windowEnd: windowEndMs,
    engineAsOf: analysisWindow.engineAsOfMs,
    timeframeDurationMs: analysisWindow.timeframeDurationMs,
    timeframe: analysisWindow.timeframe,
    candlesInWindow: analysisWindow.candles.length,
    windowRule: analysisWindow.windowRule,
    windowStart: analysisWindow.windowStartMs,
    windowTruncated: analysisWindow.windowTruncated,
    droppedBeyondWindowEnd: analysisWindow.droppedBeyondWindowEnd,
    droppedUnclosed: analysisWindow.droppedUnclosed,
    warmupRequired: minimumSwingHistoryCandles(config),
    commonHorizon: toEpochMs(selection?.commonHorizon ?? null),
    expectedLatestClosed: toEpochMs(selection?.expectedLatestClosed ?? null),
    asOfNow: toEpochMs(horizonInput.asOfNow ?? null),
    relativeLagBars: selection?.lagBars ?? null,
    relativeMaxLagBars: selection?.relativeMaxLagBars ?? null,
    absoluteLagBars: selection?.absoluteLagBars ?? null,
    absoluteMaxLagBars: selection?.absoluteMaxLagBars ?? null,
    status: selection?.status ?? null,
    reason: selection?.reason ?? null,
    participantCount: selection?.participantCount ?? null,
    marketsWithoutData:
      selection?.marketsWithoutData.map((m) => ({
        exchange: m.exchange,
        marketId: m.marketId,
      })) ?? [],
  };
}

/**
 * Horizon уровня view: оконной части здесь нет (окно — свойство
 * конкретного рынка), поэтому соответствующие поля честно null.
 */
function buildViewHorizon(args: {
  selection: CommonHorizonSelection;
  status: SmcDtoHorizon["status"];
  timeframe: SmcTimeframe;
  nowMs: number;
  windowRule: number;
  warmupRequired: number;
}): SmcDtoHorizon {
  const { selection, timeframe, nowMs } = args;
  const durationMs = SMCTIMEFRAME_MS[timeframe];
  const commonMs = toEpochMs(selection.commonHorizon);
  const anchorMs = commonMs ?? toEpochMs(selection.newestHorizon);
  return {
    mode: "strategy",
    windowEnd: anchorMs,
    engineAsOf: anchorMs === null ? null : anchorMs + durationMs,
    timeframeDurationMs: durationMs,
    timeframe,
    candlesInWindow: null,
    windowRule: args.windowRule,
    windowStart: null,
    windowTruncated: null,
    droppedBeyondWindowEnd: null,
    droppedUnclosed: null,
    warmupRequired: args.warmupRequired,
    commonHorizon: commonMs,
    expectedLatestClosed: requireEpochMs(
      selection.expectedLatestClosed,
      "selection.expectedLatestClosed"
    ),
    asOfNow: nowMs,
    relativeLagBars: selection.lagBars,
    relativeMaxLagBars: selection.relativeMaxLagBars,
    absoluteLagBars: selection.absoluteLagBars,
    absoluteMaxLagBars: selection.absoluteMaxLagBars,
    status: args.status,
    reason: selection.reason,
    participantCount: selection.participantCount,
    marketsWithoutData: selection.marketsWithoutData.map((m) => ({
      exchange: m.exchange,
      marketId: m.marketId,
    })),
  };
}

/* ------------------------------------------------------------------ */
/* Проекция одного рынка                                               */
/* ------------------------------------------------------------------ */

export type SmcProjectionInput = {
  meta: SmartMoneyMarketMeta;
  /** тикер актива для DTO (BTC/ETH/…) */
  assetSymbol: string;
  candles: SmcRawCandle[];
  config: SmcScoringConfig;
  filters?: SmartMoneyFilters;
  windowEnd: Date;
  windowSize?: number;
  strategySlug: string;
  strategyVersion: number;
  horizon?: SmcProjectionHorizonInput;
};

/**
 * Вердикт рынка берётся ИЗ ЖЕ существующего адаптера
 * `evaluateSmartMoneyWithCandles` (там же Strategy filters,
 * cannot-evaluate тексты, якорь candleTime/price), факты — из
 * `evaluateSmc` на том же ряду и с тем же `engineAsOf`.
 *
 * Два вызова вместо одного — осознанно: иначе пришлось бы копировать
 * семантику адаптера, а это и есть «второй алгоритм». Расхождение двух
 * путей считается ошибкой контракта (fail-closed).
 *
 * Рынок, отсечённый Strategy-фильтром, всё равно получает факты
 * (это честный взгляд на ряд биржи), но `market.status="filtered"`
 * и `market.direction=null` — вердикта для стратегии нет.
 */
export function projectSmcMarket(
  input: SmcProjectionInput
): SmcDtoMarketProjection {
  const filters = input.filters ?? DEFAULT_SMART_MONEY_FILTERS;
  if (input.config.tf !== input.meta.timeframe) {
    throw new SmcProjectionError(
      `projectSmcMarket: config.tf ${input.config.tf} ≠ meta.timeframe ${input.meta.timeframe}`
    );
  }

  const analysisWindow = applySmcProjectionWindow({
    candles: input.candles,
    timeframe: input.meta.timeframe,
    windowEnd: input.windowEnd,
    windowSize: input.windowSize,
  });

  // 1) авторитетный вердикт рынка — существующий путь стратегии
  const verdict = evaluateSmartMoneyWithCandles(
    input.meta,
    analysisWindow.candles,
    input.config,
    filters
  );

  // 2) факты — тот же движок, тот же ряд, engineAsOf = windowEnd + D
  let evaluation: SmcEvaluation | null = null;
  let inputContract: string | null = null;
  if (analysisWindow.candles.length > 0) {
    try {
      evaluation = evaluateSmc(
        analysisWindow.candles,
        input.config,
        new Date(analysisWindow.engineAsOfMs)
      );
    } catch (error) {
      if (!(error instanceof SmcInputError)) {
        throw error;
      }
      inputContract = `SMC input contract: ${error.message}`;
    }
  }

  // 3) согласованность единственного источника истины
  const lastIncluded =
    analysisWindow.candles.length > 0
      ? analysisWindow.candles[analysisWindow.candles.length - 1]!
      : null;
  if (verdict.status === "evaluated") {
    if (evaluation === null || lastIncluded === null) {
      throw new SmcProjectionError(
        `projectSmcMarket: адаптер дал evaluated, а движок — нет (${verdict.exchange})`
      );
    }
    const mismatches: string[] = [];
    if (evaluation.direction !== verdict.direction) {
      mismatches.push(
        `direction ${evaluation.direction} ≠ ${verdict.direction}`
      );
    }
    if (evaluation.longScore !== verdict.longScore) {
      mismatches.push(
        `longScore ${String(evaluation.longScore)} ≠ ${verdict.longScore}`
      );
    }
    if (evaluation.shortScore !== verdict.shortScore) {
      mismatches.push(
        `shortScore ${String(evaluation.shortScore)} ≠ ${verdict.shortScore}`
      );
    }
    if (requireEpochMs(verdict.candleTime, "verdict.candleTime") !==
      requireEpochMs(lastIncluded.openTime, "lastIncluded.openTime")) {
      mismatches.push("candleTime ≠ openTime последней свечи окна");
    }
    if (verdict.price !== lastIncluded.close) {
      mismatches.push("price ≠ close последней свечи окна");
    }
    if (mismatches.length > 0) {
      throw new SmcProjectionError(
        `projectSmcMarket: расхождение движка и адаптера у ${verdict.exchange}: ` +
          mismatches.join("; ")
      );
    }
  }

  const overlays =
    evaluation === null ? emptyOverlays() : buildOverlays(evaluation, analysisWindow);

  return {
    contractVersion: SMC_OVERLAY_CONTRACT_VERSION,
    engineVersion: SMC_ENGINE_VERSION,
    horizon: buildMarketHorizon(analysisWindow, input.config, input.horizon ?? {}),
    market: buildMarketDto(input.meta, input, filters, verdict, evaluation, inputContract),
    overlays,
    why: projectWhy(evaluation, overlays),
  };
}

function buildMarketDto(
  meta: SmartMoneyMarketMeta,
  input: SmcProjectionInput,
  filters: SmartMoneyFilters,
  verdict: MarketStrategyResult,
  evaluation: SmcEvaluation | null,
  inputContract: string | null
): SmcDtoMarket {
  return {
    marketId: meta.marketId,
    exchange: meta.exchange,
    exchangeSymbol: meta.market,
    assetSymbol: input.assetSymbol,
    timeframe: meta.timeframe,
    strategySlug: input.strategySlug,
    strategyVersion: input.strategyVersion,
    filters: {
      // legacy-ключ top500Only == основной universe проекта == Top-100
      universe: filters.top500Only ? "TOP_100" : "OFF",
      top500Only: filters.top500Only,
      minimumQuoteVolume24h: filters.minimumQuoteVolume24h,
    },
    status: verdict.status,
    candleTime:
      verdict.status === "evaluated"
        ? requireEpochMs(verdict.candleTime, "verdict.candleTime")
        : null,
    price: verdict.status === "evaluated" ? verdict.price : null,
    // cannot-evaluate остаётся явным CANNOT_EVALUATE (не NEUTRAL!);
    // filtered / no-snapshot — «вердикта нет» (null), как в агрегате.
    direction:
      verdict.status === "evaluated"
        ? verdict.direction
        : verdict.status === "cannot-evaluate"
          ? "CANNOT_EVALUATE"
          : null,
    longScore: verdict.status === "evaluated" ? verdict.longScore : null,
    shortScore: verdict.status === "evaluated" ? verdict.shortScore : null,
    evaluable: evaluation?.availability.evaluable ?? false,
    hardFailures:
      evaluation?.availability.hardFailures.map((failure) => ({
        code: failure.code,
        label: failure.label,
      })) ?? [],
    softUnavailable:
      evaluation?.availability.softUnavailable.map((failure) => ({
        code: failure.code,
        label: failure.label,
      })) ?? [],
    reason: verdict.status === "evaluated" ? null : verdict.reason,
    warnings: verdict.status === "evaluated" ? [...verdict.warnings] : [],
    inputContract,
  };
}

function buildOverlays(
  evaluation: SmcEvaluation,
  analysisWindow: SmcProjectionWindow
): SmcDtoOverlays {
  const overlays: SmcDtoOverlays = {
    pivots: projectPivots(evaluation),
    levels: projectLevels(evaluation),
    events: projectEvents(evaluation),
    liquidity: projectLiquidity(evaluation),
    fvgs: projectFvgs(evaluation),
    orderBlocks: projectOrderBlocks(evaluation),
    range: projectRange(evaluation),
    displacements: projectDisplacements(evaluation),
    counts: {
      pivots: 0,
      levels: 0,
      events: 0,
      liquidity: 0,
      fvgs: 0,
      orderBlocks: 0,
      range: 0,
      displacements: 0,
    },
    phases: {
      swing: evaluation.swingStructure?.phase ?? null,
      internal: evaluation.internalStructure?.phase ?? null,
    },
  };
  overlays.counts = {
    pivots: overlays.pivots.length,
    levels: overlays.levels.length,
    events: overlays.events.length,
    liquidity: overlays.liquidity.length,
    fvgs: overlays.fvgs.length,
    orderBlocks: overlays.orderBlocks.length,
    range: overlays.range === null ? 0 : 1,
    displacements: overlays.displacements.length,
  };
  assertFactsNotBeyondAsOf(
    overlays,
    analysisWindow.engineAsOfMs,
    `projectSmcMarket(${analysisWindow.timeframe})`
  );
  return overlays;
}

/* ------------------------------------------------------------------ */
/* Стратегический вид                                                  */
/* ------------------------------------------------------------------ */

export type SmcStrategyViewInput = {
  /** рынки ПОСЛЕ exchange eligibility (политику применяет вызывающий) */
  markets: Array<{ meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] }>;
  timeframe: SmcTimeframe;
  config: SmcScoringConfig;
  filters?: SmartMoneyFilters;
  /** wall clock — ЯВНО (никаких часов внутри расчёта) */
  now: Date;
  minExchanges: number;
  strategySlug: string;
  strategyVersion: number;
  assetSymbol: string;
  /** сколько рынков было до eligibility (для честного denominator) */
  marketCount?: number;
  exchangeExcluded?: string[];
  windowSize?: number;
};

/**
 * Единственный путь: выбор общего горизонта, гейт и сам агрегат —
 * существующие функции. Своего выбора горизонта, своего alignment или
 * «агрегата по тому, что удалось собрать» здесь нет и быть не может.
 */
export function projectStrategyView(
  input: SmcStrategyViewInput
): SmcDtoStrategyView {
  const filters = input.filters ?? DEFAULT_SMART_MONEY_FILTERS;
  const nowMs = requireEpochMs(input.now, "now");

  const outcome = evaluateMarketsAtCommonHorizon(
    input.markets,
    input.timeframe,
    input.config,
    filters,
    input.now
  );
  const gate = decideAggregationAtCommonHorizon({
    selection: outcome.selection,
    results: outcome.results,
    timeframe: input.timeframe,
  });

  const selection = outcome.selection;
  const commonHorizonMs = toEpochMs(selection.commonHorizon);
  const windowRule = input.windowSize ?? SMC_PROJECTION_WINDOW;

  const aggregate =
    gate.allowed && commonHorizonMs !== null
      ? buildAggregate({
          aggregation: aggregateAssetGroup(
            input.assetSymbol,
            input.timeframe,
            input.strategySlug,
            input.strategyVersion,
            outcome.results,
            input.minExchanges
          ),
          outcome,
          gate,
          marketCount: input.marketCount ?? input.markets.length,
          exchangeEligibleCount: input.markets.length,
          exchangeExcluded: input.exchangeExcluded ?? [],
        })
      : null;

  // Общий горизонт недоступен → заякорить нечего:проекции рынков
  // выдаются (иначе оверлеи «объясняли» бы то, чего стратегия не видела).
  const anchorHorizon = selection.commonHorizon;
  const markets =
    outcome.usable && anchorHorizon !== null
      ? input.markets.map((m) =>
          projectSmcMarket({
            meta: m.meta,
            assetSymbol: input.assetSymbol,
            candles: m.candles,
            config: input.config,
            filters,
            windowEnd: anchorHorizon,
            windowSize: input.windowSize,
            strategySlug: input.strategySlug,
            strategyVersion: input.strategyVersion,
            horizon: {
              mode: "strategy",
              selection,
              asOfNow: new Date(nowMs),
            },
          })
        )
      : [];

  return {
    contractVersion: SMC_OVERLAY_CONTRACT_VERSION,
    engineVersion: SMC_ENGINE_VERSION,
    horizon: buildViewHorizon({
      selection,
      status: outcome.status,
      timeframe: input.timeframe,
      nowMs,
      windowRule,
      warmupRequired: minimumSwingHistoryCandles(input.config),
    }),
    aggregate,
    markets,
  };
}

type CommonHorizonOutcome = ReturnType<typeof evaluateMarketsAtCommonHorizon>;
type GateDecision = ReturnType<typeof decideAggregationAtCommonHorizon>;

function buildAggregate(input: {
  aggregation: ReturnType<typeof aggregateAssetGroup>;
  outcome: CommonHorizonOutcome;
  gate: GateDecision;
  marketCount: number;
  exchangeEligibleCount: number;
  exchangeExcluded: string[];
}): SmcDtoAggregate {
  const { aggregation, outcome, gate } = input;
  const perMarket: SmcDtoAggregate["perMarket"] = outcome.results.map(
    (result: MarketStrategyResult) => ({
      marketId: result.marketId,
      exchange: result.exchange,
      status: result.status,
      direction: result.status === "evaluated" ? result.direction : null,
      longScore: result.status === "evaluated" ? result.longScore : null,
      shortScore: result.status === "evaluated" ? result.shortScore : null,
      candleTime:
        result.status === "evaluated"
          ? requireEpochMs(result.candleTime, "result.candleTime")
          : null,
      reason: result.status === "evaluated" ? null : result.reason,
    })
  );

  return {
    direction: aggregation.direction,
    conflict: aggregation.conflict,
    votes: {
      long: aggregation.longVotes,
      short: aggregation.shortVotes,
      neutral: aggregation.neutralVotes,
      evaluated: aggregation.evaluated,
      skipped: aggregation.skipped,
    },
    confirmation: aggregation.confirmation,
    minExchanges: aggregation.minExchanges,
    explanation: aggregation.explanation,
    participants: {
      marketCount: input.marketCount,
      exchangeEligibleCount: input.exchangeEligibleCount,
      participantCount: outcome.participantCount,
      filteredCount: outcome.filteredCount,
      exchangeExcluded: input.exchangeExcluded,
    },
    gate: {
      allowed: gate.allowed,
      alignmentSafe: gate.alignment.safe,
      alignedCount: gate.alignment.alignedCount,
      totalEvaluated: gate.alignment.totalEvaluated,
      offGridCount: gate.alignment.offGrid.length,
      horizonMismatchCount: gate.alignment.horizonMismatch.length,
      referenceCandleTime: toEpochMs(gate.alignment.referenceCandleTime),
      refusalReasons: [...gate.refusalReasons],
      anchorOk: gate.anchor.ok,
    },
    perMarket,
  };
}
