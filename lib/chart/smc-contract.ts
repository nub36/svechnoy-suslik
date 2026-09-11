/**
 * SMC overlay DTO — chart-facing contract (P1-A, contract v1).
 *
 * Это ЕДИНСТВЕННЫЙ формат, в котором аналитика Smart Money
 * (движок `lib/smc/*`) передаётся слою визуализации. Слой
 * отображения НЕ имеет права ничего пересчитывать: только
 * фильтровать/раскрашивать то, что лежит здесь.
 *
 * Контракт сознательно:
 *  - чисто данные, сериализуем в JSON без потерь (никаких Date);
 *  - все времена — milliseconds (openTime/effectiveCloseTime
 *    движка). Секунд lightweight-charts в DTO нет вообще:
 *    единственная конвертация — `toChartTime` ниже;
 *  - использует существующие детерминированные идентичности
 *    движка (`SMC1|…` ключи) и его типы состояний — никаких
 *    frontend-only id и никаких новых состояний;
 *  - разделяет `market`+`overlays` (факты ОДНОЙ биржи) и
 *    `aggregate` (решение стратегии по нескольким биржам):
 *    в агрегате физически не может оказаться FVG/BOS/OB,
 *    поэтому «общее пятибиржевое FVG» нарисовать нельзя;
 *  - не отдаёт внутренний FSM state (уровни/переходы/счётчики),
 *    только результат, доступный наблюдателю в `engineAsOf`.
 *
 * Никаких React/DOM/Prisma/сети/часов — модуль чистый.
 */

import type { CommonHorizonStatus } from "../strategies/common-horizon";
import type { SmcFvgState } from "../smc/fvg";
import type {
  SmcLiquidityOrigin,
  SmcLiquiditySide,
  SmcLiquidityState,
} from "../smc/liquidity";
import type { SmcOrderBlockState } from "../smc/order-blocks";
import type { SmcRangeZone } from "../smc/range";
import type { SmcScoreReasonCode } from "../smc/scoring";
import type {
  SmcDirection,
  SmcLayer,
  SmcLevelState,
  SmcPivotKind,
  SmcStructureEventType,
  SmcTimeframe,
  StructurePhase,
} from "../smc/types";

/* ------------------------------------------------------------------ */
/* Версии и константы идентичности                                     */
/* ------------------------------------------------------------------ */

/** Номер контракта. Менять только совместимо-аддитивно. */
export const SMC_OVERLAY_CONTRACT_VERSION = 1;

/** Тег детерминированных id движка (`SMC1|…`) — для отлова дрейфа. */
export const SMC_ENGINE_VERSION = "SMC1" as const;

/**
 * Каноническое окно проекции = правилу runtime.
 *
 * `loadSmartMoneyCandles` (lib/strategies/smart-money.ts) берёт
 * последние 500 CLOSED свечей рынка (DESC take 500 → ASC). SMC
 * считает freshness ИНДЕКСНО от конца горизонта, поэтому окно
 * влияет на баллы: проекция обязана использовать ТО ЖЕ правило,
 * иначе график будет объяснять не тот результат, что стратегия.
 *
 * ВНИМАНИЕ: это размер ОКНА АНАЛИЗА, а не размер вселенной
 * активов. Основной universe продукта — Top-100 (§43).
 */
export const SMC_PROJECTION_WINDOW = 500;

/** Границы окна анализа — защита payload'а; верх = правилу runtime. */
export const SMC_PROJECTION_WINDOW_MAX = 500;
export const SMC_PROJECTION_WINDOW_MIN = 100;

/** Группы оверлеев (порядок = порядок тумблеров в UI). */
export const SMC_OVERLAY_GROUPS = [
  "structure",
  "internal",
  "liquidity",
  "fvg",
  "orderBlocks",
  "range",
  "displacement",
] as const;

export type SmcOverlayGroup = (typeof SMC_OVERLAY_GROUPS)[number];

/* ------------------------------------------------------------------ */
/* Времена: ms (домен) ↔ seconds (график)                              */
/* ------------------------------------------------------------------ */

export class SmcChartTimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmcChartTimeError";
  }
}

/**
 * Единственная конвертация ms → lightweight-charts `time`.
 *
 * Строго: только целые миллисекунды, кратные 1000. Никакого
 * округления/усечения — иначе off-by-1000 становится тихой
 * потерей одного бара на сетке 5m. Неровное/невалидное значение
 * означает нарушение контракта (данные не из canonical CLOSED
 * ряда), поэтому fail-closed исключением, а не «ближайшей секундой».
 *
 * Возвращает обычный `number` (секунды). Обёртку в `UTCTimestamp`
 * делает слой отображения на своём краю — контракт не зависит от
 * UI-библиотеки (тот же DTO переиспользует P2 backtest).
 */
export function toChartTime(ms: number): number {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    throw new SmcChartTimeError(
      `toChartTime: ожидается конечное число миллисекунд, получено ${String(ms)}`
    );
  }
  if (!Number.isSafeInteger(ms)) {
    throw new SmcChartTimeError(
      `toChartTime: миллисекунды должны быть целым безопасным числом, получено ${ms}`
    );
  }
  if (ms < 0) {
    throw new SmcChartTimeError(`toChartTime: отрицательное время ${ms}`);
  }
  if (ms % 1000 !== 0) {
    throw new SmcChartTimeError(
      `toChartTime: время не выровнено по секунде (${ms} мс, остаток ${ms % 1000}) — ` +
        "SMC оперирует effectiveCloseTime = openTime + D, значит кратность 1000 обязательна"
    );
  }
  return ms / 1000;
}

/** Обратная конвертация (проверки; клиентский курсор → домен). */
export function fromChartTime(seconds: number): number {
  if (
    typeof seconds !== "number" ||
    !Number.isInteger(seconds) ||
    seconds < 0
  ) {
    throw new SmcChartTimeError(
      `fromChartTime: ожидается целое неотрицательное число секунд, получено ${String(seconds)}`
    );
  }
  return seconds * 1000;
}

/** Пригодны ли эти ms для конвертации (без исключения). */
export function isChartTimeConvertible(ms: number): boolean {
  return (
    typeof ms === "number" &&
    Number.isSafeInteger(ms) &&
    ms >= 0 &&
    ms % 1000 === 0
  );
}

/**
 * Дата из домена (движок/Prisma) → epoch ms.
 *
 * `null | undefined` разрешены там, где поле жизненного цикла
 * отсутствует (движок возвращает `Date | null`); всё остальное —
 * нарушение контракта. Никакого тихого «сейчас».
 */
export function toEpochMs(value: Date | null | undefined): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (!(value instanceof Date)) {
    throw new SmcChartTimeError(
      `toEpochMs: ожидается Date | null, получено ${typeof value}`
    );
  }
  const ms = value.getTime();
  if (!Number.isFinite(ms)) {
    throw new SmcChartTimeError("toEpochMs: Date с NaN временем");
  }
  return ms;
}

/** Обязательная версия того же (поля, которых не может не быть). */
export function requireEpochMs(
  value: Date | null | undefined,
  field: string
): number {
  const ms = toEpochMs(value);
  if (ms === null) {
    throw new SmcChartTimeError(`toEpochMs: обязательное поле ${field} равно null`);
  }
  return ms;
}

/* ------------------------------------------------------------------ */
/* Горизонт/окно                                                       */
/* ------------------------------------------------------------------ */

/**
 * Точка, «на которую смотрит» движок:
 *   windowEnd  = openTime ПОСЛЕДНЕЙ ВКЛЮЧЁННОЙ закрытой свечи;
 *   engineAsOf = windowEnd + длительность ТФ, то есть ровно
 *                effectiveCloseTime этой свечи (lib/smc/types.ts).
 * Отождествление `openTime <= windowEnd` ⟷
 * `effectiveCloseTime <= engineAsOf` — основание no-lookahead
 * контракта и совпадения с truncateCandlesToHorizon.
 */
export type SmcDtoHorizon = {
  mode: "strategy" | "exchange";
  /**
   * openTime последней включённой свечи, ms.
   * null — на уровне strategy view при недоступном общем горизонте
   * (заякоривать нечего); на уровне рынка заполнено всегда.
   */
  windowEnd: number | null;
  /** asOf для evaluateSmc: windowEnd + D, ms (см. note выше) */
  engineAsOf: number | null;
  /** длительность ТФ, мс (из SMCTIMEFRAME_MS — не локальная константа) */
  timeframeDurationMs: number;
  timeframe: SmcTimeframe;
  /**
   * Сколько свечей реально попало в движок и каково правило окна.
   * null на уровне strategy view: окно — свойство конкретного рынка.
   */
  candlesInWindow: number | null;
  windowRule: number;
  windowStart: number | null;
  /** окно пришлось обрезать по правилу «последние N» */
  windowTruncated: boolean | null;
  /** сколько закрытых свечей отброшено windowEnd / closed-флагом */
  droppedBeyondWindowEnd: number | null;
  droppedUnclosed: number | null;
  /** warm-up минимум движка (minimumSwingHistoryCandles) */
  warmupRequired: number | null;
  /** общий CLOSED горизонт стратегии; null в exchange-режиме */
  commonHorizon: number | null;
  /** ожидаемый latest CLOSED по wall-clock (из common-horizon слоя) */
  expectedLatestClosed: number | null;
  /** wall clock, переданный явным образом (эхо для детерминизма) */
  asOfNow: number | null;
  relativeLagBars: number | null;
  relativeMaxLagBars: number | null;
  absoluteLagBars: number | null;
  absoluteMaxLagBars: number | null;
  /** статус выбора общего горизонта (существующие статусы слоя) */
  status: CommonHorizonStatus | null;
  /** текст причины — дословно из слоя, без перефразирования */
  reason: string | null;
  /** участники, от которых зависит решение (vetoes видны) */
  participantCount: number | null;
  marketsWithoutData: Array<{ exchange: string; marketId: number }>;
};

/* ------------------------------------------------------------------ */
/* Рынок (идентичность + вердикт ОДНОЙ биржи)                          */
/* ------------------------------------------------------------------ */

export type SmcDtoMarket = {
  marketId: number;
  exchange: string;
  /** = SmartMoneyMarketMeta.market (exchangeSymbol) */
  exchangeSymbol: string;
  /** тикер актива (BTC, ETH, …) */
  assetSymbol: string;
  timeframe: SmcTimeframe;
  strategySlug: string;
  strategyVersion: number;
  /**
   * Отображение Strategy.config.filters с ЧЕСТНОЙ подписью:
   * legacy-ключ `top500Only` означает основной universe проекта,
   * а это Top-100 (rank 1..100, lib/universe.ts). UI не выводит
   * «Top-500»; переименования ключа в config/schema нет.
   */
  filters: {
    universe: "TOP_100" | "OFF";
    /** исходный ключ конфига (для отладки), семантика не меняется */
    top500Only: boolean;
    minimumQuoteVolume24h: number;
  };
  /**
   * Статус рынка — ровно существующая унификация runtime
   * (`MarketStrategyResult["status"]`), ничего не сворачивается:
   * evaluated | filtered | cannot-evaluate | no-snapshot.
   */
  status: "evaluated" | "filtered" | "cannot-evaluate" | "no-snapshot";
  /** null, если оценки нет (0 не выдумывается) */
  candleTime: number | null;
  price: number | null;
  /**
   * Вердикт стратегии по этому рынку. null — вердикта нет вовсе
   * (рынок отсечён фильтром / нет snapshot); CANNOT_EVALUATE —
   * рынок в выборке, но оценить его нельзя (это НЕ NEUTRAL).
   */
  direction: "LONG" | "SHORT" | "NEUTRAL" | "CANNOT_EVALUATE" | null;
  longScore: number | null;
  shortScore: number | null;
  evaluable: boolean;
  hardFailures: Array<{ code: string; label: string }>;
  softUnavailable: Array<{ code: string; label: string }>;
  /** причина отказа/фильтра — дословно из адаптера */
  reason: string | null;
  warnings: string[];
  /**
   * Сообщение контракта входа движка (`SmcInputError`), если ряд
   * неканонический и движок отказался его принять. null — всё в
   * порядке. Это диагностика данных, а НЕ рыночное состояние.
   */
  inputContract: string | null;
};

/* ------------------------------------------------------------------ */
/* Факты                                                               */
/* ------------------------------------------------------------------ */

export type SmcDtoPivot = {
  id: string;
  layer: SmcLayer;
  kind: SmcPivotKind;
  price: number;
  eventTime: number;
  confirmedAt: number;
};

export type SmcDtoStructuralLevel = {
  id: string;
  pivotId: string;
  layer: SmcLayer;
  kind: SmcPivotKind;
  price: number;
  eventTime: number;
  confirmedAt: number;
  state: SmcLevelState;
  consumedAt: number | null;
  consumedByEventId: string | null;
};

export type SmcDtoStructureEvent = {
  id: string;
  layer: SmcLayer;
  type: SmcStructureEventType;
  /** направление события — литералы движка */
  dir: SmcDirection;
  brokenLevelPrice: number;
  brokenPivotId: string;
  eventTime: number;
  confirmedAt: number;
  protectedAnchor: {
    pivotId: string;
    kind: SmcPivotKind;
    price: number;
    eventTime: number;
    confirmedAt: number;
  } | null;
};

export type SmcDtoLiquidityLevel = {
  id: string;
  side: SmcLiquiditySide;
  origin: SmcLiquidityOrigin;
  price: number;
  sourcePivotIds: string[];
  eventTime: number;
  createdAt: number;
  state: SmcLiquidityState;
  resolvedAt: number | null;
  resolvedByCandleTime: number | null;
  sweepPenetrationAtr: number | null;
};

export type SmcDtoFvgZone = {
  id: string;
  dir: SmcDirection;
  top: number;
  bottom: number;
  ce: number;
  gapSize: number;
  sizeAtr: number;
  fillFraction: number;
  eventTime: number;
  confirmedAt: number;
  /** правый край зоны для рисования = confirmedAt (закрылась bar c) */
  zoneStart: number;
  zoneEnd: number;
  firstTouchedAt: number | null;
  ceTouchedAt: number | null;
  filledByExcursionAt: number | null;
  invalidatedByCloseAt: number | null;
  expiredAt: number | null;
  state: SmcFvgState;
};

export type SmcDtoOrderBlockZone = {
  id: string;
  dir: SmcDirection;
  layer: SmcLayer;
  top: number;
  bottom: number;
  eventTime: number;
  confirmedAt: number;
  impulseStartAt: number;
  impulseEndAt: number;
  zoneStart: number;
  zoneEnd: number;
  structureEventId: string;
  structureEventType: "BOS" | "CHOCH";
  structureEventTime: number;
  firstTouchedAt: number | null;
  firstMitigatedAt: number | null;
  invalidatedAt: number | null;
  expiredAt: number | null;
  maxPenetrationFraction: number;
  retests: number;
  preConfirmationTouches: number;
  hasFvgInImpulse: boolean;
  hasLiquiditySweepBeforeImpulse: boolean;
  state: SmcOrderBlockState;
};

/**
 * Dealing range. `position` сохраняется БЕЗ clamp и движком, и
 * проекцией: может быть <0, в [0,1] и >1. Вне-диапазона —
 * отдельный флаг, а не «зажатое значение».
 */
export type SmcDtoRange = {
  id: string;
  dir: SmcDirection;
  low: number;
  high: number;
  equilibrium: number;
  eqBand: number;
  eventTime: number;
  confirmedAt: number;
  replacedAt: number | null;
  anchorStartPivotId: string;
  anchorEndPivotId: string;
  /** цена, для которой посчитан контекст (= close последнего бара окна) */
  price: number;
  position: number;
  zone: SmcRangeZone;
  outsideRange: boolean;
  /** сколько версий range видел движок (история — только счётчиком) */
  historyVersions: number;
};

export type SmcDtoDisplacement = {
  id: string;
  dir: SmcDirection;
  eventTime: number;
  confirmedAt: number;
  bodyAtr: number;
  rangeAtr: number;
  closeLocation: number;
};

export type SmcDtoOverlays = {
  pivots: SmcDtoPivot[];
  levels: SmcDtoStructuralLevel[];
  events: SmcDtoStructureEvent[];
  liquidity: SmcDtoLiquidityLevel[];
  fvgs: SmcDtoFvgZone[];
  orderBlocks: SmcDtoOrderBlockZone[];
  range: SmcDtoRange | null;
  displacements: SmcDtoDisplacement[];
  counts: {
    pivots: number;
    levels: number;
    events: number;
    liquidity: number;
    fvgs: number;
    orderBlocks: number;
    range: 0 | 1;
    displacements: number;
  };
  /** фазы структур — единственное «состояние» FSM в контракте */
  phases: { swing: StructurePhase | null; internal: StructurePhase | null };
};

/* ------------------------------------------------------------------ */
/* WHY: вклад компонент + связь с фактами                              */
/* ------------------------------------------------------------------ */

export type SmcDtoWhyRow = {
  code: SmcScoreReasonCode;
  label: string;
  longPoints: number;
  shortPoints: number;
  maxPoints: number;
  /** дословный payload движка (часто — id факта) */
  value: string | null;
  /**
   * Факты, которые эта причина использует. Заполняется ТОЛЬКО
   * когда payload reason — точный идентичность-ключ движка,
   * присутствующий в спроецированных фактах. Никаких эвристик
   * по направлению/цене: нет точного соответствия — [].
   */
  factIds: string[];
};

/* ------------------------------------------------------------------ */
/* Агрегат стратегии (без фактов!)                                     */
/* ------------------------------------------------------------------ */

export type SmcDtoAggregate = {
  direction: "LONG" | "SHORT" | "NEUTRAL";
  conflict: boolean;
  votes: {
    long: number;
    short: number;
    neutral: number;
    evaluated: number;
    skipped: number;
  };
  confirmation: string;
  minExchanges: number;
  explanation: string;
  /** множества, из которых всё собрано (честность denominator) */
  participants: {
    marketCount: number;
    exchangeEligibleCount: number;
    participantCount: number;
    filteredCount: number;
    exchangeExcluded: string[];
  };
  /** существующий alignment/gate: агрегат только когда он разрешён */
  gate: {
    allowed: boolean;
    alignmentSafe: boolean;
    alignedCount: number;
    totalEvaluated: number;
    offGridCount: number;
    horizonMismatchCount: number;
    referenceCandleTime: number | null;
    refusalReasons: string[];
    anchorOk: boolean;
  };
  /** по-рыночный вердикт участника — числа и тексты, без оверлеев */
  perMarket: Array<{
    marketId: number;
    exchange: string;
    status: "evaluated" | "filtered" | "cannot-evaluate" | "no-snapshot";
    direction: "LONG" | "SHORT" | "NEUTRAL" | null;
    longScore: number | null;
    shortScore: number | null;
    candleTime: number | null;
    reason: string | null;
  }>;
};

/* ------------------------------------------------------------------ */
/* Верхние объекты                                                     */
/* ------------------------------------------------------------------ */

/** Проекция ОДНОГО рынка: вердикт + факты этого рынка. */
export type SmcDtoMarketProjection = {
  contractVersion: number;
  engineVersion: typeof SMC_ENGINE_VERSION;
  horizon: SmcDtoHorizon;
  market: SmcDtoMarket;
  overlays: SmcDtoOverlays;
  why: SmcDtoWhyRow[];
};

/** Стратегический вид: общий горизонт + агрегат + проекции участников. */
export type SmcDtoStrategyView = {
  contractVersion: number;
  engineVersion: typeof SMC_ENGINE_VERSION;
  horizon: SmcDtoHorizon;
  /** null при любом отказе выбора горизонта/гейта — не выдумывается */
  aggregate: SmcDtoAggregate | null;
  markets: SmcDtoMarketProjection[];
};
