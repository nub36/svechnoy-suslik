/**
 * P1-A — Smart Money overlays: чистый DTO-контракт для графика.
 *
 * РОЛЬ МОДУЛЯ:
 * Только ТИПЫ и чистейшие helper'ы (миллисекунды ↔ lightweight-chart
 * секунды, WHY→factIds). Никакой логики SMC здесь нет — все
 * литералы-домены (SmcTimeframe, SmcLayer, SmcDirection, состояния
 * FVG/OB/liquidity и т.д.) берутся TYPE-ONLY из проверенных модулей
 * lib/smc/*, чтобы DTO не мог разойтись с движком.
 *
 * ЧИСТОТА (обязательная, проверяется scripts/test-smc-projection.ts):
 *  - нет runtime-импортов вообще (только `import type`, стирается
 *    при компиляции) ⇒ сериализуемо в JSON как есть;
 *  - нет Prisma / DB / fetch / React / DOM / window / localStorage;
 *  - нет Date.now / Signal, нет генерации идентификаторов.
 *
 * ВСЕ DOMAIN TIMESTAMPS В МИЛЛИСЕКУНДАХ (числа, поля с суффиксом Ms).
 * Конвертация в lightweight-chart секунды — только в UI через
 * msToChartTime() (см. ниже). Никакой конвертации внутри DTO.
 *
 * СТРОГОЕ РАЗДЕЛЕНИЕ:
 *  - SmcMarketOverlayDto — per-exchange оверлеи (факты одной биржи);
 *  - SmcAggregateSummaryDto — aggregate summary БЕЗ оверлеев
 *    (никаких «общих FVG/BOS/OB» для пяти бирж). Это проверяется
 *    тестами и типом: summary содержит только per-exchange сводки.
 */
import type {
  SmcAvailabilityCode,
  SmcEvaluationDirection,
} from "../smc/evaluate";
import type { SmcFvgState } from "../smc/fvg";
import type {
  SmcLiquidityOrigin,
  SmcLiquiditySide,
  SmcLiquidityState,
} from "../smc/liquidity";
import type {
  SmcOrderBlockState,
} from "../smc/order-blocks";
import type { SmcRangeZone } from "../smc/range";
import type { SmcScoreReasonCode } from "../smc/scoring";
import type {
  SmcDirection,
  SmcLayer,
  SmcLevelState,
  SmcPivotKind,
  SmcStructureEventType,
  SmcTimeframe,
} from "../smc/types";
import type { CommonHorizonStatus } from "../strategies/common-horizon";

// ------------------------------------------------------------------
// ms ↔ lightweight-chart seconds
// ------------------------------------------------------------------

/**
 * Domain ms → lightweight-chart время (секунды, UTCTimestamp).
 * Единственная разрешённая конвертация времени в chart-слое:
 * DTO хранит только миллисекунды, UI переводит в секунды здесь.
 */
export function msToChartTime(ms: number): number {
  return Math.floor(ms / 1000);
}

/** Обратная конвертация: lightweight-chart секунды → domain ms. */
export function chartTimeToMs(chartSeconds: number): number {
  return chartSeconds * 1000;
}

// ------------------------------------------------------------------
// WHY → factIds: ТОЛЬКО exact existing key mapping
// ------------------------------------------------------------------

/** 9 SMC-компонентов scoring + DIRECTION_CONFLICT (модель Phase 3A). */
export const SMC_SCORE_REASON_CODES = [
  "SWING_TREND",
  "RECENT_SWING_BOS",
  "INTERNAL_TREND",
  "LIQUIDITY_SWEEP",
  "SWING_ORDER_BLOCK",
  "INTERNAL_ORDER_BLOCK",
  "FVG",
  "RANGE_POSITION",
  "OB_FVG_CONFLUENCE",
  "DIRECTION_CONFLICT",
] as const satisfies readonly SmcScoreReasonCode[];

/**
 * Exact-префиксы deterministic SMC ID, которые ПЕРЕНОСЯТСЯ в reason.value
 * самим scoring (lib/smc/scoring.ts): SWING_ORDER_BLOCK/INTERNAL_ORDER_BLOCK
 * value === ob.key, FVG value === fvg.key. Копии форматов ID из
 * lib/smc/order-blocks.ts (`SMC1|OB|tf|dir|layer|structureEventKey|candMs`)
 * и lib/smc/fvg.ts (`SMC1|FVG|tf|dir|openTimeMs`). Дрифт ловится тестом:
 * каждый OB/FVG key реальной оценки обязан начинаться с этих префиксов.
 */
export const SMC_OB_KEY_PREFIX = "SMC1|OB|" as const;
export const SMC_FVG_KEY_PREFIX = "SMC1|FVG|" as const;

/** Минимальная форма reason для exact-маппинга (часть SmcScoreReason). */
export type SmcWhyReasonShape = {
  code: string;
  value: string | null;
  longPoints: number;
  shortPoints: number;
};

function isExactObKey(value: string | null): value is string {
  return typeof value === "string" && value.startsWith(SMC_OB_KEY_PREFIX);
}

function isExactFvgKey(value: string | null): value is string {
  return typeof value === "string" && value.startsWith(SMC_FVG_KEY_PREFIX);
}

/**
 * WHY → factIds: ТОЛЬКО exact existing key mapping, никаких догадок.
 *
 *  - SWING_ORDER_BLOCK / INTERNAL_ORDER_BLOCK: reason.value === ob.key
 *    (существующий deterministic ID) → [value]; иначе [].
 *  - FVG: reason.value === fvg.key → [value]; иначе [].
 *  - OB_FVG_CONFLUENCE с набранными points: scoring документирует, что
 *    confluence строится на ТЕХ ЖЕ выбранных фактах, чьи ключи лежат в
 *    value компонентов SWING_ORDER_BLOCK (приоритетно) / INTERNAL_ORDER_BLOCK
 *    и FVG того же набора reasons ⇒ [obKey, fvgKey] только из этих value.
 *  - все остальные коды (SWING_TREND, RECENT_SWING_BOS, INTERNAL_TREND,
 *    LIQUIDITY_SWEEP, RANGE_POSITION, DIRECTION_CONFLICT) и любые
 *    НЕИЗВЕСТНЫЕ коды → []: их value не является exact ключом факта
 *    (`BOS:up`, `pos=…`, `SELL_SIDE @…` — ключ из этого не восстанавливается).
 */
export function scoreReasonFactIds(
  reason: SmcWhyReasonShape,
  allReasons: ReadonlyArray<SmcWhyReasonShape>
): string[] {
  switch (reason.code) {
    case "SWING_ORDER_BLOCK":
    case "INTERNAL_ORDER_BLOCK":
      return isExactObKey(reason.value) ? [reason.value] : [];

    case "FVG":
      return isExactFvgKey(reason.value) ? [reason.value] : [];

    case "OB_FVG_CONFLUENCE": {
      if (reason.longPoints + reason.shortPoints <= 0) {
        return [];
      }
      const swingOb = allReasons.find(
        (r) => r.code === "SWING_ORDER_BLOCK"
      );
      const internalOb = allReasons.find(
        (r) => r.code === "INTERNAL_ORDER_BLOCK"
      );
      const fvg = allReasons.find((r) => r.code === "FVG");
      const obKey = isExactObKey(swingOb?.value ?? null)
        ? swingOb!.value
        : isExactObKey(internalOb?.value ?? null)
          ? internalOb!.value
          : null;
      const fvgKey = isExactFvgKey(fvg?.value ?? null)
        ? fvg!.value
        : null;
      const ids: string[] = [];
      if (obKey !== null) ids.push(obKey);
      if (fvgKey !== null) ids.push(fvgKey);
      return ids;
    }

    default:
      return [];
  }
}

// ------------------------------------------------------------------
// DTO: общие части
// ------------------------------------------------------------------

/** Статус рынка в оверлее/сводке (SMC не имеет no-snapshot: history-based). */
export type SmcOverlayMarketStatus =
  | "evaluated"
  | "cannot-evaluate"
  | "filtered";

export interface SmcOverlayAvailabilityDto {
  evaluable: boolean;
  hardFailures: Array<{ code: SmcAvailabilityCode; label: string }>;
  softUnavailable: Array<{ code: SmcAvailabilityCode; label: string }>;
}

export interface SmcOverlayReasonDto {
  code: SmcScoreReasonCode;
  /** Русский label (НЕ identity). */
  label: string;
  longPoints: number;
  shortPoints: number;
  maxPoints: number;
  /** Deterministic payload факта (строка/null). */
  value: string | null;
  /** WHY→factIds: только exact existing key mapping (scoreReasonFactIds). */
  factIds: string[];
}

// ------------------------------------------------------------------
// DTO: per-exchange overlays
// ------------------------------------------------------------------

export interface SmcPivotOverlayDto {
  key: string;
  layer: SmcLayer;
  kind: SmcPivotKind;
  price: number;
  /** openTime ПЕРВОЙ свечи plateau, ms. */
  eventTimeMs: number;
  /** effectiveCloseTime(k + right), ms; до него пивот не показывается. */
  confirmedAtMs: number;
}

export interface SmcStructureEventOverlayDto {
  key: string;
  layer: SmcLayer;
  type: SmcStructureEventType;
  dir: SmcDirection;
  /** Identity-ссылка на пробитый пивот. */
  brokenPivotKey: string;
  brokenLevelPrice: number;
  /** openTime свечи, чей CLOSE образовал событие, ms. */
  eventTimeMs: number;
  /** effectiveCloseTime той же свечи, ms (actionableAt = confirmedAt). */
  confirmedAtMs: number;
  /** Ключ защищённого противоположного якоря (или null). */
  protectedAnchorKey: string | null;
}

export interface SmcLevelOverlayDto {
  pivotKey: string;
  layer: SmcLayer;
  kind: SmcPivotKind;
  price: number;
  eventTimeMs: number;
  confirmedAtMs: number;
  state: SmcLevelState;
  consumedAtMs: number | null;
  consumedByEventKey: string | null;
}

export interface SmcLiquidityOverlayDto {
  key: string;
  side: SmcLiquiditySide;
  origin: SmcLiquidityOrigin;
  price: number;
  sourcePivotKeys: string[];
  eventTimeMs: number;
  /** Момент, когда уровень стал известен потребителю, ms. */
  createdAtMs: number;
  state: SmcLiquidityState;
  resolvedAtMs: number | null;
  resolvedByCandleTimeMs: number | null;
  /** Payload при SWEPT: (extreme − price)/ATR свечи. */
  sweepPenetrationAtr: number | null;
}

export interface SmcFvgOverlayDto {
  key: string;
  direction: SmcDirection;
  bottom: number;
  top: number;
  ce: number;
  gapSize: number;
  /** gapSize / ATR[c]. */
  sizeAtr: number;
  /** openTime impulse-свечи b, ms. */
  eventTimeMs: number;
  /** effectiveCloseTime свечи c, ms. */
  confirmedAtMs: number;
  firstTouchedAtMs: number | null;
  ceTouchedAtMs: number | null;
  fullFilledByExcursionAtMs: number | null;
  invalidatedByCloseAtMs: number | null;
  expiredAtMs: number | null;
  /** 0..1, max проникновение в зону. */
  fillFraction: number;
  state: SmcFvgState;
}

export interface SmcOrderBlockOverlayDto {
  key: string;
  direction: SmcDirection;
  layer: SmcLayer;
  bottom: number;
  top: number;
  /** openTime ПЕРВОЙ свечи candidate cluster, ms. */
  eventTimeMs: number;
  /** openTime первой impulse-свечи, ms. */
  impulseStartAtMs: number;
  /** effectiveCloseTime последней impulse-свечи, ms. */
  impulseEndAtMs: number;
  /** Key подтверждающего FSM event. */
  structureEventKey: string;
  structureEventType: "BOS" | "CHOCH";
  /** openTime confirmation candle, ms. */
  structureEventTimeMs: number;
  confirmedAtMs: number;
  firstTouchedAtMs: number | null;
  firstMitigatedAtMs: number | null;
  maxPenetrationFraction: number;
  retests: number;
  invalidatedAtMs: number | null;
  expiredAtMs: number | null;
  preConfirmationTouches: number;
  hasFvgInImpulse: boolean;
  hasLiquiditySweepBeforeImpulse: boolean;
  state: SmcOrderBlockState;
}

export interface SmcDisplacementOverlayDto {
  key: string;
  direction: SmcDirection;
  eventTimeMs: number;
  confirmedAtMs: number;
  bodyAtr: number;
  rangeAtr: number;
  closeLocation: number;
}

export interface SmcRangePriceContextDto {
  /** close последней canonical CLOSED свечи <= asOf. */
  price: number;
  /**
   * (price - low) / (high - low), БЕЗ clamp: может быть < 0 и > 1 —
   * проекция обязана сохранять outsideRange-значения как есть.
   */
  position: number;
  eqBand: number;
  zone: SmcRangeZone;
  outsideRange: boolean;
}

export interface SmcRangeOverlayDto {
  key: string;
  direction: SmcDirection;
  anchorStartPivotKey: string;
  anchorEndPivotKey: string;
  low: number;
  high: number;
  /** openTime BOS-свечи, ms. */
  eventTimeMs: number;
  /** effectiveCloseTime BOS-свечи, ms. */
  confirmedAtMs: number;
  replacedAtMs: number | null;
  equilibrium: number;
  priceContext: SmcRangePriceContextDto | null;
}

/**
 * Оверлеи ОДНОЙ биржи на общем CLOSED горизонте H.
 * Swing и internal слои НЕ смешиваются в отдельные массивы — они лежат
 * в общих массивах и различаются полем `layer` (стабильные identity-ключи).
 */
export interface SmcMarketOverlayDto {
  exchange: string;
  market: string;
  marketId: number;
  timeframe: SmcTimeframe;
  status: SmcOverlayMarketStatus;
  /** Причина для cannot-evaluate/filtered (иначе null). */
  statusReason: string | null;
  /** Общий CLOSED горизонт H (openTime, ms) — якорь этих оверлеев. */
  horizonMs: number | null;
  /** effectiveCloseTime(H) = H + tfMs. Ни один факт с confirmedAt >
   * этого значения НЕ показывается (no-lookahead контракт). */
  engineAsOfMs: number | null;
  direction: SmcEvaluationDirection | null;
  longScore: number | null;
  shortScore: number | null;
  availability: SmcOverlayAvailabilityDto | null;
  reasons: SmcOverlayReasonDto[];
  pivots: SmcPivotOverlayDto[];
  structureEvents: SmcStructureEventOverlayDto[];
  levels: SmcLevelOverlayDto[];
  liquidity: SmcLiquidityOverlayDto[];
  fvgs: SmcFvgOverlayDto[];
  orderBlocks: SmcOrderBlockOverlayDto[];
  dealingRange: SmcRangeOverlayDto | null;
  displacements: SmcDisplacementOverlayDto[];
}

// ------------------------------------------------------------------
// DTO: aggregate summary (БЕЗ overlays — строгое разделение)
// ------------------------------------------------------------------

/** Сводка одной биржи внутри aggregate summary. */
export interface SmcExchangeSummaryDto {
  exchange: string;
  market: string;
  marketId: number;
  status: SmcOverlayMarketStatus;
  direction: SmcEvaluationDirection | null;
  longScore: number | null;
  shortScore: number | null;
  /** H для evaluated (иначе null). */
  horizonMs: number | null;
}

/**
 * Aggregate summary по активу на общем CLOSED горизонте.
 * ПО КОНТРАКТУ НЕ содержит overlay-фактов: общих FVG/BOS/OB для пяти
 * бирж не существует — факты строго per-exchange (только сводки).
 */
export interface SmcAggregateSummaryDto {
  usable: boolean;
  status: CommonHorizonStatus;
  /** Человекочитаемый verdict selection (всегда непустой). */
  statusReason: string;
  timeframe: SmcTimeframe;
  horizonMs: number | null;
  engineAsOfMs: number | null;
  newestHorizonMs: number | null;
  /** Ожидаемый latest CLOSED на injected wall clock. */
  expectedLatestClosedMs: number;
  /** Входной now (эхо injected wall clock, projection сама часы не читает). */
  nowMs: number;
  lagMs: number | null;
  lagBars: number | null;
  absoluteLagMs: number | null;
  absoluteLagBars: number | null;
  relativeMaxLagBars: number;
  absoluteMaxLagBars: number;
  participantCount: number;
  filteredCount: number;
  /** Имена бирж, отсечённых exchange eligibility (например BINGX для 1d). */
  exchangeExcluded: string[];
  evaluatedCount: number;
  cannotEvaluateCount: number;
  /** Итог aggregateAssetGroup (существующий runtime), null если gate не пустил. */
  direction: SmcEvaluationDirection | null;
  conflict: boolean;
  longVotes: number;
  shortVotes: number;
  neutralVotes: number;
  minExchanges: number;
  /** Например "4/5", null если gate не пустил. */
  confirmation: string | null;
  gateAllowed: boolean;
  gateRefusalReasons: string[];
  /** Per-exchange сводки в порядке входа — и всё, никаких overlay-массивов. */
  perExchange: SmcExchangeSummaryDto[];
}

// ------------------------------------------------------------------
// DTO: корневой результат проекции
// ------------------------------------------------------------------

/**
 * Корневой DTO P1-A: строго разделённые per-exchange overlays +
 * aggregate summary. Готов к JSON-сериализации; UI сам конвертирует
 * ms → lightweight-chart seconds через msToChartTime().
 */
export interface SmcChartProjection {
  assetSymbol: string;
  timeframe: SmcTimeframe;
  /** Wall clock, переданный вызывающим (projection Date.now НЕ читает). */
  generatedAtMs: number;
  overlays: SmcMarketOverlayDto[];
  aggregate: SmcAggregateSummaryDto;
}
