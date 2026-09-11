/**
 * P1-A — Smart Money overlays: чистая проекция SMC → DTO графика.
 *
 * НАЗНАЧЕНИЕ:
 * Подготовить per-exchange overlays и aggregate summary для будущей
 * кнопки «Смарт Мани Вкл/Выкл» на графике (только UI overlays — этот
 * модуль НЕ меняет Strategy.enabled и вообще не пишет в БД).
 *
 * ВТОРОГО SMC АЛГОРИТМА ЗДЕСЬ НЕТ. Проекция композирует ТОЛЬКО
 * существующие проверенные функции в ТОМ ЖЕ порядке, что и
 * production-адаптер (lib/strategies/smart-money.ts):
 *   1. exchange eligibility   — isSmartMoneyExchangeEligible (Option A);
 *   2. Strategy filters       — applySmartMoneyFilters (не дублируются);
 *   3. common CLOSED horizon  — selectCommonClosedHorizon (внутри
 *                                evaluateMarketsAtCommonHorizon);
 *   4. оценка каждого рынка   — evaluateMarketsAtCommonHorizon
 *                                (тот же вызов, что в production runtime:
 *                                «projection == existing Strategy evaluation
 *                                at same H» — по построению и по тестам);
 *   5. гейт агрегации         — decideAggregationAtCommonHorizon;
 *   6. aggregate summary      — aggregateAssetGroup (существующий runtime).
 * Overlay-факты строятся из evaluateSmc на ТЕХ ЖЕ усечённых до H свечах
 * (тот же единый SMC-движок, никакого параллельного расчёта).
 *
 * NO LOOKAHEAD (CLOSED-only):
 *  - projection при H видит только свечи <= H (усечение до H, потом
 *    evaluateSmc с asOf = effectiveCloseTime(H));
 *  - projectMarketOverlay отклоняет evaluation с asOf ≠ engineAsOf и
 *    оборонительно выбрасывает факты с confirmedAt > engineAsOf.
 *
 * ЧИСТОТА (обязательная): БЕЗ Prisma, БЕЗ DB, БЕЗ fetch, БЕЗ React,
 * БЕЗ DOM/window/localStorage, БЕЗ Date.now (now передаётся вызывающим),
 * БЕЗ Signal. Все входы — данные, переданные вызывающим кодом.
 */

import {
  decideAggregationAtCommonHorizon,
  truncateCandlesToHorizon,
} from "../strategies/common-horizon";
import { aggregateAssetGroup } from "../strategies/runtime";
import {
  evaluateMarketsAtCommonHorizon,
  SMART_MONEY_SLUG,
  type CommonHorizonOutcome,
  type SmartMoneyFilters,
  type SmartMoneyMarketMeta,
} from "../strategies/smart-money";
import { isSmartMoneyExchangeEligible } from "../strategies/smart-money-eligibility";
import {
  assertValidSmcScoringConfig,
  type SmcScoringConfig,
} from "../smc/config";
import type { SmcDisplacement } from "../smc/displacement";
import {
  evaluateSmc,
  type SmcEvaluation,
} from "../smc/evaluate";
import type { SmcFvg } from "../smc/fvg";
import type { SmcLiquidityLevel } from "../smc/liquidity";
import type { SmcOrderBlock } from "../smc/order-blocks";
import {
  isSmcTimeframe,
  SMCTIMEFRAME_MS,
  type SmcPivot,
  type SmcRawCandle,
  type SmcStructuralLevel,
  type SmcStructureEvent,
  type SmcTimeframe,
} from "../smc/types";
import { SmcInputError } from "../smc/validate";
import {
  SMC_SCORE_REASON_CODES,
  chartTimeToMs,
  msToChartTime,
  scoreReasonFactIds,
  type SmcAggregateSummaryDto,
  type SmcChartProjection,
  type SmcDisplacementOverlayDto,
  type SmcExchangeSummaryDto,
  type SmcFvgOverlayDto,
  type SmcLevelOverlayDto,
  type SmcLiquidityOverlayDto,
  type SmcMarketOverlayDto,
  type SmcOrderBlockOverlayDto,
  type SmcOverlayAvailabilityDto,
  type SmcOverlayMarketStatus,
  type SmcOverlayReasonDto,
  type SmcPivotOverlayDto,
  type SmcRangeOverlayDto,
  type SmcStructureEventOverlayDto,
} from "./smc-contract";

export {
  /** Реэкспорт для chart-слоя: ms → lightweight-chart seconds. */
  msToChartTime,
  chartTimeToMs,
  scoreReasonFactIds,
  SMC_SCORE_REASON_CODES,
};

/** Fail-closed контракт входа проекции (стиль CommonHorizonError). */
export class SmcProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmcProjectionError";
  }
}

// ------------------------------------------------------------------
// Вход проекции
// ------------------------------------------------------------------

export interface SmcChartProjectionInput {
  assetSymbol: string;
  timeframe: SmcTimeframe;
  /** Рынки актива (обменники НЕ фильтруются вызывающим — eligibility
   * применяет сама проекция, как документирует production-контракт). */
  markets: ReadonlyArray<{
    meta: SmartMoneyMarketMeta;
    candles: SmcRawCandle[];
  }>;
  smcConfig: SmcScoringConfig;
  filters: SmartMoneyFilters;
  /** Порог голосов агрегации (1..5), берётся из Strategy runtime. */
  minExchanges: number;
  /** Injected wall clock — проекция сама часы НЕ читает. */
  now: Date;
  /** Версия Strategy для aggregateAssetGroup (по умолчанию 1). */
  strategyVersion?: number;
}

// ------------------------------------------------------------------
// Валидация входа
// ------------------------------------------------------------------

function assertValidNow(now: Date): void {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new SmcProjectionError(
      "now: ожидается валидная Date (значение передаёт вызывающий код)"
    );
  }
}

function assertValidInput(input: SmcChartProjectionInput): void {
  if (typeof input.assetSymbol !== "string" || input.assetSymbol.trim() === "") {
    throw new SmcProjectionError("assetSymbol: ожидается непустая строка");
  }
  if (!isSmcTimeframe(input.timeframe)) {
    throw new SmcProjectionError(
      `timeframe "${String(input.timeframe)}" вне белого списка`
    );
  }
  if (input.smcConfig.tf !== input.timeframe) {
    throw new SmcProjectionError(
      `smcConfig.tf ${input.smcConfig.tf} не совпадает с timeframe проекции ${input.timeframe}`
    );
  }
  assertValidSmcScoringConfig(input.smcConfig);
  if (
    typeof input.filters !== "object" ||
    input.filters === null ||
    typeof input.filters.top500Only !== "boolean" ||
    typeof input.filters.minimumQuoteVolume24h !== "number" ||
    !Number.isFinite(input.filters.minimumQuoteVolume24h) ||
    input.filters.minimumQuoteVolume24h < 0
  ) {
    throw new SmcProjectionError(
      "filters: ожидается { top500Only: boolean, minimumQuoteVolume24h: number >= 0 }"
    );
  }
  if (
    !Number.isInteger(input.minExchanges) ||
    input.minExchanges < 1 ||
    input.minExchanges > 5
  ) {
    throw new SmcProjectionError("minExchanges: ожидается целое 1..5");
  }
  assertValidNow(input.now);
  if (!Array.isArray(input.markets)) {
    throw new SmcProjectionError("markets: ожидается массив");
  }
}

// ------------------------------------------------------------------
// Построители DTO-фактов (ms-домен; cap = engineAsOfMs)
// ------------------------------------------------------------------

function ms(date: Date | null): number | null {
  return date === null ? null : date.getTime();
}

function msOrThrow(date: Date): number {
  return date.getTime();
}

function pivotDto(pivot: SmcPivot): SmcPivotOverlayDto {
  return {
    key: pivot.key,
    layer: pivot.layer,
    kind: pivot.kind,
    price: pivot.price,
    eventTimeMs: msOrThrow(pivot.eventTime),
    confirmedAtMs: msOrThrow(pivot.confirmedAt),
  };
}

function eventDto(event: SmcStructureEvent): SmcStructureEventOverlayDto {
  return {
    key: event.key,
    layer: event.layer,
    type: event.type,
    dir: event.dir,
    brokenPivotKey: event.brokenPivotKey,
    brokenLevelPrice: event.brokenLevelPrice,
    eventTimeMs: msOrThrow(event.eventTime),
    confirmedAtMs: msOrThrow(event.confirmedAt),
    protectedAnchorKey: event.protectedAnchor?.pivotKey ?? null,
  };
}

function levelDto(level: SmcStructuralLevel): SmcLevelOverlayDto {
  return {
    pivotKey: level.pivotKey,
    layer: level.layer,
    kind: level.kind,
    price: level.price,
    eventTimeMs: msOrThrow(level.eventTime),
    confirmedAtMs: msOrThrow(level.confirmedAt),
    state: level.state,
    consumedAtMs: ms(level.consumedAt),
    consumedByEventKey: level.consumedByEventKey,
  };
}

function liquidityDto(level: SmcLiquidityLevel): SmcLiquidityOverlayDto {
  return {
    key: level.key,
    side: level.side,
    origin: level.origin,
    price: level.price,
    sourcePivotKeys: [...level.sourcePivotKeys],
    eventTimeMs: msOrThrow(level.eventTime),
    createdAtMs: msOrThrow(level.createdAt),
    state: level.state,
    resolvedAtMs: ms(level.resolvedAt),
    resolvedByCandleTimeMs: ms(level.resolvedByCandleTime),
    sweepPenetrationAtr: level.sweepPenetrationAtr,
  };
}

function fvgDto(fvg: SmcFvg): SmcFvgOverlayDto {
  return {
    key: fvg.key,
    direction: fvg.direction,
    bottom: fvg.bottom,
    top: fvg.top,
    ce: fvg.ce,
    gapSize: fvg.gapSize,
    sizeAtr: fvg.sizeAtr,
    eventTimeMs: msOrThrow(fvg.eventTime),
    confirmedAtMs: msOrThrow(fvg.confirmedAt),
    firstTouchedAtMs: ms(fvg.firstTouchedAt),
    ceTouchedAtMs: ms(fvg.ceTouchedAt),
    fullFilledByExcursionAtMs: ms(fvg.fullFilledByExcursionAt),
    invalidatedByCloseAtMs: ms(fvg.invalidatedByCloseAt),
    expiredAtMs: ms(fvg.expiredAt),
    fillFraction: fvg.fillFraction,
    state: fvg.state,
  };
}

function orderBlockDto(ob: SmcOrderBlock): SmcOrderBlockOverlayDto {
  return {
    key: ob.key,
    direction: ob.direction,
    layer: ob.layer,
    bottom: ob.bottom,
    top: ob.top,
    eventTimeMs: msOrThrow(ob.eventTime),
    impulseStartAtMs: msOrThrow(ob.impulseStartAt),
    impulseEndAtMs: msOrThrow(ob.impulseEndAt),
    structureEventKey: ob.structureEventKey,
    structureEventType: ob.structureEventType,
    structureEventTimeMs: msOrThrow(ob.structureEventTime),
    confirmedAtMs: msOrThrow(ob.confirmedAt),
    firstTouchedAtMs: ms(ob.firstTouchedAt),
    firstMitigatedAtMs: ms(ob.firstMitigatedAt),
    maxPenetrationFraction: ob.maxPenetrationFraction,
    retests: ob.retests,
    invalidatedAtMs: ms(ob.invalidatedAt),
    expiredAtMs: ms(ob.expiredAt),
    preConfirmationTouches: ob.preConfirmationTouches,
    hasFvgInImpulse: ob.hasFvgInImpulse,
    hasLiquiditySweepBeforeImpulse: ob.hasLiquiditySweepBeforeImpulse,
    state: ob.state,
  };
}

function displacementDto(d: SmcDisplacement): SmcDisplacementOverlayDto {
  return {
    key: d.key,
    direction: d.direction,
    eventTimeMs: msOrThrow(d.eventTime),
    confirmedAtMs: msOrThrow(d.confirmedAt),
    bodyAtr: d.bodyAtr,
    rangeAtr: d.rangeAtr,
    closeLocation: d.closeLocation,
  };
}

function rangeDto(
  range: NonNullable<SmcEvaluation["dealingRange"]>
): SmcRangeOverlayDto | null {
  const current = range.current;
  if (current === null) {
    return null;
  }
  const ctx = range.priceContext;
  return {
    key: current.key,
    direction: current.direction,
    anchorStartPivotKey: current.anchorStartPivotKey,
    anchorEndPivotKey: current.anchorEndPivotKey,
    low: current.low,
    high: current.high,
    eventTimeMs: msOrThrow(current.eventTime),
    confirmedAtMs: msOrThrow(current.confirmedAt),
    replacedAtMs: ms(current.replacedAt),
    equilibrium: current.equilibrium,
    priceContext:
      ctx === null
        ? null
        : {
            price: ctx.price,
            // БЕЗ clamp: position может быть < 0 или > 1.
            position: ctx.position,
            eqBand: ctx.eqBand,
            zone: ctx.zone,
            outsideRange: ctx.outsideRange,
          },
  };
}

function availabilityDto(
  evaluation: SmcEvaluation
): SmcOverlayAvailabilityDto {
  return {
    evaluable: evaluation.availability.evaluable,
    hardFailures: evaluation.availability.hardFailures.map((f) => ({
      code: f.code,
      label: f.label,
    })),
    softUnavailable: evaluation.availability.softUnavailable.map((f) => ({
      code: f.code,
      label: f.label,
    })),
  };
}

function reasonsDto(evaluation: SmcEvaluation): SmcOverlayReasonDto[] {
  return evaluation.reasons.map((r) => ({
    code: r.code,
    label: r.label,
    longPoints: r.longPoints,
    shortPoints: r.shortPoints,
    maxPoints: r.maxPoints,
    value: r.value,
    factIds: scoreReasonFactIds(r, evaluation.reasons),
  }));
}

function hardFailureReasonText(evaluation: SmcEvaluation): string {
  const hard = evaluation.availability.hardFailures
    .map((f) => `${f.code}: ${f.label}`)
    .join("; ");
  return hard
    ? `SMC cannot evaluate — ${hard}`
    : "SMC cannot evaluate";
}

// ------------------------------------------------------------------
// Per-market overlay из существующего SmcEvaluation
// ------------------------------------------------------------------

/**
 * Чистый построитель per-exchange overlay из УЖЕ существующей оценки
 * evaluateSmc (единый SMC-движок — второго алгоритма нет).
 *
 * NO-LOOKAHEAD контракт:
 *  - evaluation.asOf обязан равняться engineAsOfMs (иначе SmcProjectionError:
 *    проекция отказывается показывать данные более позднего движка);
 *  - оборонительно: факты с confirmedAt > engineAsOfMs НЕ попадают в DTO
 *    (при честном входе это no-op — evaluateSmc сам не эмитит confirmedAt
 *    позже asOf; guard проверяется тестом на подделанной оценке);
 *  - liquidity: anchor видимости — createdAt; уровень с createdAt или
 *    resolvedAt позже engineAsOf не показывается.
 */
export function projectMarketOverlay(
  meta: SmartMoneyMarketMeta,
  evaluation: SmcEvaluation | null,
  horizonMs: number,
  engineAsOfMs: number
): SmcMarketOverlayDto {
  if (!Number.isFinite(horizonMs) || !Number.isInteger(horizonMs)) {
    throw new SmcProjectionError("horizonMs: ожидается целое число (ms)");
  }
  if (!Number.isFinite(engineAsOfMs) || !Number.isInteger(engineAsOfMs)) {
    throw new SmcProjectionError("engineAsOfMs: ожидается целое число (ms)");
  }

  const base = {
    exchange: meta.exchange,
    market: meta.market,
    marketId: meta.marketId,
    timeframe: meta.timeframe,
    status: "evaluated" as const,
    statusReason: null,
    horizonMs,
    engineAsOfMs,
    direction: null as SmcMarketOverlayDto["direction"],
    longScore: null as number | null,
    shortScore: null as number | null,
    availability: null as SmcOverlayAvailabilityDto | null,
    reasons: [] as SmcOverlayReasonDto[],
    pivots: [] as SmcPivotOverlayDto[],
    structureEvents: [] as SmcStructureEventOverlayDto[],
    levels: [] as SmcLevelOverlayDto[],
    liquidity: [] as SmcLiquidityOverlayDto[],
    fvgs: [] as SmcFvgOverlayDto[],
    orderBlocks: [] as SmcOrderBlockOverlayDto[],
    dealingRange: null as SmcRangeOverlayDto | null,
    displacements: [] as SmcDisplacementOverlayDto[],
  };

  if (evaluation === null) {
    return {
      ...base,
      status: "cannot-evaluate",
      statusReason: "SMC cannot evaluate",
    };
  }

  if (evaluation.asOf.getTime() !== engineAsOfMs) {
    throw new SmcProjectionError(
      `lookahead-контракт нарушен: evaluation.asOf ${evaluation.asOf.toISOString()} ≠ engineAsOf ${new Date(engineAsOfMs).toISOString()} — проекция отказывается показывать оценку более позднего горизонта`
    );
  }

  if (
    !evaluation.availability.evaluable ||
    evaluation.direction === "CANNOT_EVALUATE" ||
    evaluation.longScore === null ||
    evaluation.shortScore === null
  ) {
    return {
      ...base,
      status: "cannot-evaluate",
      statusReason: hardFailureReasonText(evaluation),
      availability: availabilityDto(evaluation),
    };
  }

  const cap = engineAsOfMs;
  const confirmedVisible = (confirmedAt: Date): boolean =>
    confirmedAt.getTime() <= cap;

  const swing = evaluation.swingStructure;
  const internal = evaluation.internalStructure;

  const pivots: SmcPivotOverlayDto[] = [];
  const events: SmcStructureEventOverlayDto[] = [];
  const levels: SmcLevelOverlayDto[] = [];
  for (const structure of [swing, internal]) {
    if (structure === null) continue;
    for (const pivot of structure.pivots) {
      if (!confirmedVisible(pivot.confirmedAt)) continue;
      pivots.push(pivotDto(pivot));
    }
    for (const event of structure.events) {
      if (!confirmedVisible(event.confirmedAt)) continue;
      events.push(eventDto(event));
    }
    for (const level of structure.levels) {
      if (!confirmedVisible(level.confirmedAt)) continue;
      levels.push(levelDto(level));
    }
  }

  const liquidity: SmcLiquidityOverlayDto[] = [];
  for (const level of evaluation.liquidity) {
    if (level.createdAt.getTime() > cap) continue;
    if (level.resolvedAt !== null && level.resolvedAt.getTime() > cap) {
      continue;
    }
    liquidity.push(liquidityDto(level));
  }

  const fvgs: SmcFvgOverlayDto[] = [];
  for (const fvg of evaluation.fvgs) {
    if (!confirmedVisible(fvg.confirmedAt)) continue;
    fvgs.push(fvgDto(fvg));
  }

  const orderBlocks: SmcOrderBlockOverlayDto[] = [];
  for (const ob of [
    ...evaluation.swingOrderBlocks,
    ...evaluation.internalOrderBlocks,
  ]) {
    if (!confirmedVisible(ob.confirmedAt)) continue;
    orderBlocks.push(orderBlockDto(ob));
  }

  const displacements: SmcDisplacementOverlayDto[] = [];
  for (const d of evaluation.displacements) {
    if (!confirmedVisible(d.confirmedAt)) continue;
    displacements.push(displacementDto(d));
  }

  const dealingRange =
    evaluation.dealingRange === null
      ? null
      : rangeDto(evaluation.dealingRange);

  return {
    ...base,
    direction: evaluation.direction,
    longScore: evaluation.longScore,
    shortScore: evaluation.shortScore,
    availability: availabilityDto(evaluation),
    reasons: reasonsDto(evaluation),
    pivots,
    structureEvents: events,
    levels,
    liquidity,
    fvgs,
    orderBlocks,
    dealingRange,
    displacements,
  };
}

// ------------------------------------------------------------------
// Пустой (не-evaluated) overlay-слот
// ------------------------------------------------------------------

function skippedOverlay(
  meta: SmartMoneyMarketMeta,
  status: "cannot-evaluate" | "filtered",
  reason: string
): SmcMarketOverlayDto {
  return {
    exchange: meta.exchange,
    market: meta.market,
    marketId: meta.marketId,
    timeframe: meta.timeframe,
    status,
    statusReason: reason,
    horizonMs: null,
    engineAsOfMs: null,
    direction: null,
    longScore: null,
    shortScore: null,
    availability: null,
    reasons: [],
    pivots: [],
    structureEvents: [],
    levels: [],
    liquidity: [],
    fvgs: [],
    orderBlocks: [],
    dealingRange: null,
    displacements: [],
  };
}

// ------------------------------------------------------------------
// Aggregate summary (БЕЗ overlays)
// ------------------------------------------------------------------

function buildAggregate(input: {
  assetSymbol: string;
  timeframe: SmcTimeframe;
  outcome: CommonHorizonOutcome;
  excludedExchanges: string[];
  minExchanges: number;
  strategyVersion: number;
  engineAsOfMs: number | null;
}): SmcAggregateSummaryDto {
  const {
    assetSymbol,
    timeframe,
    outcome,
    excludedExchanges,
    minExchanges,
    strategyVersion,
    engineAsOfMs,
  } = input;
  const selection = outcome.selection;

  const results = outcome.results;
  const evaluated = results.filter(
    (r) => r.status === "evaluated"
  ).length;
  const cannotEvaluate = results.filter(
    (r) => r.status === "cannot-evaluate"
  ).length;

  const perExchange: SmcExchangeSummaryDto[] = results.map((r) => {
    if (r.status === "evaluated") {
      return {
        exchange: r.exchange,
        market: r.market,
        marketId: r.marketId,
        status: r.status,
        direction: r.direction,
        longScore: r.longScore,
        shortScore: r.shortScore,
        horizonMs: r.candleTime.getTime(),
      };
    }
    // SMC-адаптер не производит no-snapshot (history-based); если такой
    // статус когда-либо появится — оборонительно трактуем как cannot-evaluate.
    const status: SmcOverlayMarketStatus =
      r.status === "filtered" ? "filtered" : "cannot-evaluate";
    return {
      exchange: r.exchange,
      market: r.market,
      marketId: r.marketId,
      status,
      direction: null,
      longScore: null,
      shortScore: null,
      horizonMs: null,
    };
  });

  let gateAllowed = false;
  let gateRefusalReasons: string[] = [];
  let direction: SmcAggregateSummaryDto["direction"] = null;
  let conflict = false;
  let longVotes = 0;
  let shortVotes = 0;
  let neutralVotes = 0;
  let confirmation: string | null = null;

  if (outcome.usable) {
    const gate = decideAggregationAtCommonHorizon({
      selection,
      results,
      timeframe,
    });
    gateAllowed = gate.allowed;
    gateRefusalReasons = [...gate.refusalReasons];
    if (gate.allowed) {
      const aggregation = aggregateAssetGroup(
        assetSymbol,
        timeframe,
        SMART_MONEY_SLUG,
        strategyVersion,
        results,
        minExchanges
      );
      direction = aggregation.direction;
      conflict = aggregation.conflict;
      longVotes = aggregation.longVotes;
      shortVotes = aggregation.shortVotes;
      neutralVotes = aggregation.neutralVotes;
      confirmation = aggregation.confirmation;
    }
  } else {
    gateRefusalReasons = [selection.reason];
  }

  return {
    usable: outcome.usable,
    status: selection.status,
    statusReason: selection.reason,
    timeframe,
    horizonMs:
      selection.commonHorizon === null
        ? null
        : selection.commonHorizon.getTime(),
    engineAsOfMs,
    newestHorizonMs:
      selection.newestHorizon === null
        ? null
        : selection.newestHorizon.getTime(),
    expectedLatestClosedMs: selection.expectedLatestClosed.getTime(),
    nowMs: selection.now.getTime(),
    lagMs: selection.lagMs,
    lagBars: selection.lagBars,
    absoluteLagMs: selection.absoluteLagMs,
    absoluteLagBars: selection.absoluteLagBars,
    relativeMaxLagBars: selection.relativeMaxLagBars,
    absoluteMaxLagBars: selection.absoluteMaxLagBars,
    participantCount: outcome.participantCount,
    filteredCount: outcome.filteredCount,
    exchangeExcluded: [...excludedExchanges],
    evaluatedCount: evaluated,
    cannotEvaluateCount: cannotEvaluate,
    direction,
    conflict,
    longVotes,
    shortVotes,
    neutralVotes,
    minExchanges,
    confirmation,
    gateAllowed,
    gateRefusalReasons,
    perExchange,
  };
}

// ------------------------------------------------------------------
// Каноническая точка входа P1-A
// ------------------------------------------------------------------

/**
 * Чистая проекция: markets × (meta + CLOSED candles) → SmcChartProjection.
 *
 * Композиция ТОЛЬКО существующих функций (см. шапку модуля):
 * eligibility → evaluateMarketsAtCommonHorizon (filters + common horizon +
 * per-market оценка) → overlays из evaluateSmc на усечённых до H свечах →
 * decideAggregationAtCommonHorizon → aggregateAssetGroup.
 *
 * Возвращаемый aggregate summary НЕ содержит overlay-фактов: общих
 * FVG/BOS/OB для пяти бирж не существует, факты строго per-exchange.
 */
export function projectSmcChart(
  input: SmcChartProjectionInput
): SmcChartProjection {
  assertValidInput(input);

  const {
    assetSymbol,
    timeframe,
    markets,
    smcConfig,
    filters,
    minExchanges,
    now,
  } = input;
  const strategyVersion = input.strategyVersion ?? 1;

  // Шаг 1: exchange eligibility (Option A, существующая политика).
  // Отсечённые обменники не участники и не влияют на H (production-контракт).
  const eligible: Array<{
    meta: SmartMoneyMarketMeta;
    candles: SmcRawCandle[];
  }> = [];
  const excludedExchanges: string[] = [];
  for (const m of markets) {
    if (isSmartMoneyExchangeEligible(m.meta.exchange, timeframe)) {
      eligible.push(m);
    } else if (!excludedExchanges.includes(m.meta.exchange)) {
      excludedExchanges.push(m.meta.exchange);
    }
  }

  // Шаги 2–4: существующий production-пайплайн (filters → common CLOSED
  // horizon → per-market оценка ровно на H). Тот же вызов, что в runtime.
  const outcome = evaluateMarketsAtCommonHorizon(
    eligible,
    timeframe,
    smcConfig,
    filters,
    now
  );

  const horizon =
    outcome.selection.status === "ok"
      ? outcome.selection.commonHorizon
      : null;

  let overlays: SmcMarketOverlayDto[] = [];
  let engineAsOfMs: number | null = null;

  if (outcome.usable && horizon !== null) {
    const engineAsOf =
      horizon.getTime() + SMCTIMEFRAME_MS[timeframe];
    engineAsOfMs = engineAsOf;

    // results сохраняет порядок входа eligible-рынков (оценённые,
    // cannot-evaluate и filtered) — оверлеи строятся в том же порядке.
    overlays = eligible.map((m, i) => {
      const result = outcome.results[i];
      if (result === undefined) {
        // Участник без результата возможен только при unusable horizon —
        // здесь недостижимо (usable === true); fail-closed.
        throw new SmcProjectionError(
          `внутренний инвариант: нет результата для ${m.meta.exchange} (marketId ${m.meta.marketId}) при usable horizon`
        );
      }

      if (result.status === "evaluated") {
        const truncated = truncateCandlesToHorizon(
          m.candles,
          horizon
        );
        // Тот же движок и тот же asOf, что использовала
        // evaluateSmartMoneyWithCandles внутри outcome (детерминизм).
        let evaluation: SmcEvaluation;
        try {
          evaluation = evaluateSmc(
            truncated,
            smcConfig,
            new Date(engineAsOf)
          );
        } catch (e) {
          const msg =
            e instanceof SmcInputError
              ? e.message
              : e instanceof Error
                ? e.message
                : String(e);
          throw new SmcProjectionError(
            `внутренний инвариант: evaluateSmc на усечённом горизонте неожиданно нарушил контракт входа — ${msg}`
          );
        }
        return projectMarketOverlay(
          m.meta,
          evaluation,
          horizon.getTime(),
          engineAsOf
        );
      }

      return skippedOverlay(
        m.meta,
        result.status === "filtered" ? "filtered" : "cannot-evaluate",
        result.reason
      );
    });
  }
  // Иначе (horizon unusable): overlays = [] — ровно как production-адаптер
  // возвращает results = [] в этой ветке; диагноз целиком в aggregate.

  const aggregate = buildAggregate({
    assetSymbol,
    timeframe,
    outcome,
    excludedExchanges,
    minExchanges,
    strategyVersion,
    engineAsOfMs,
  });

  return {
    assetSymbol,
    timeframe,
    generatedAtMs: now.getTime(),
    overlays,
    aggregate,
  };
}
