/**
 * SMC Phase 1 — типы фундамента (спецификация V2).
 *
 * Phase 1 СОЗНАТЕЛЬНО содержит только:
 * - canonical CLOSED/asOf input (validate.ts);
 * - deterministic pivots с plateau-политикой (pivots.ts);
 * - internal/swing structure FSM (fsm.ts).
 *
 * ЗАПРЕЩЕНО в Phase 1 (не реализовано): FVG, liquidity,
 * sweeps, displacement, Order Blocks, premium/discount,
 * MTF-сборка, scoring, Strategy-адаптер. Модули ниже не
 * импортируют Prisma, Next или сеть — чистые функции.
 */

/** Таймфреймы проекта (правило 26): 5m/15m/1h/4h/1d. */
export type SmcTimeframe = "5m" | "15m" | "1h" | "4h" | "1d";

/** Длительность ТФ в мс — единственный источник
 * effectiveCloseTime (см. validate.ts). */
export const SMCTIMEFRAME_MS: Record<SmcTimeframe, number> = {
  "5m": 5 * 60_000,
  "15m": 15 * 60_000,
  "1h": 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "1d": 24 * 60 * 60_000
};

export function isSmcTimeframe(value: unknown): value is SmcTimeframe {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SMCTIMEFRAME_MS, value)
  );
}

/**
 * INITIAL ENGINEERING DEFAULT / HYPOTHESIS (SMC V2 §16):
 * окна пивотов НЕ являются параметрами LuxAlgo и не
 * подтверждены ни backtest'ом, ни walk-forward.
 */
export const INTERNAL_PIVOT_WINDOW = 3;
export const SWING_PIVOT_WINDOW = 20;

export type SmcLayer = "internal" | "swing";

export type SmcPivotKind = "high" | "low";

/**
 * Сырая закрытая свеча, адаптированная к реальной модели
 * Prisma Candle (schema.prisma на 3b76086):
 * openTime DateTime, open/high/low/close Float,
 * closed Boolean @default(true).
 *
 * Поля closeTime/volume/marketId/id СОЗНАТЕЛЬНО не входят.
 * SMC намеренно НЕ использует nullable exchange closeTime
 * как canonical asOf-границу: берётся теоретический конец
 * интервала, чтобы определить CLOSED-горизонт едиобразно и
 * консервативно. Read-only проба production БД подтвердила
 * формулу только для 1h: closeTime = openTime + 1h - 1ms
 * (20/20 sampled CLOSED), т.е. effectiveCloseTime на 1ms
 * консервативнее; для 5m/15m/4h/1d реальных строк не было —
 * runtime-консистентность БД пока не доказана. Само поле
 * closeTime при этом используется exchange ingestion и
 * snapshots — но не SMC core.
 */
export interface SmcRawCandle {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  closed: boolean;
}

/** Каноническая свеча после валидации: эффективное время
 * закрытия вычислено, порядок гарантирован. */
export interface SmcCandle {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  /** openTime + SMCTIMEFRAME_MS[tf]; usable ⟺ <= asOf. */
  effectiveCloseTime: Date;
}

export interface StructureParams {
  tf: SmcTimeframe;
  layer: SmcLayer;
  /** Контекст ДО начала plateau (целое >= 1). */
  left: number;
  /** Контекст ПОСЛЕ конца plateau (целое >= 1). */
  right: number;
}

export function internalStructureParams(
  tf: SmcTimeframe
): StructureParams {
  return {
    tf,
    layer: "internal",
    left: INTERNAL_PIVOT_WINDOW,
    right: INTERNAL_PIVOT_WINDOW
  };
}

export function swingStructureParams(
  tf: SmcTimeframe
): StructureParams {
  return {
    tf,
    layer: "swing",
    left: SWING_PIVOT_WINDOW,
    right: SWING_PIVOT_WINDOW
  };
}

/** Детерминированный ключ пивота: только поля, известные
 * в момент confirmedAt. Цена — payload, не identity. */
export function smcPivotKey(
  tf: SmcTimeframe,
  layer: SmcLayer,
  kind: SmcPivotKind,
  anchorOpenTimeMs: number
): string {
  return `SMC1|P|${tf}|${layer}|${kind}|${anchorOpenTimeMs}`;
}

export interface SmcPivot {
  key: string;
  layer: SmcLayer;
  kind: SmcPivotKind;
  price: number;
  /** openTime ПЕРВОЙ свечи plateau (наш convention). */
  eventTime: Date;
  /** effectiveCloseTime(k + right); до него пивот не
   * существует для потребителей (anti-lookahead). */
  confirmedAt: Date;
}

export type StructurePhase =
  | "UNDEFINED"
  | "TREND_UP"
  | "TREND_DOWN"
  | "REVERSAL_PENDING_UP"
  | "REVERSAL_PENDING_DOWN";

export type SmcStructureEventType =
  | "BOS"
  | "CHOCH"
  | "CHOCH_INVALIDATED";

export interface SmcStructureEvent {
  key: string;
  layer: SmcLayer;
  type: SmcStructureEventType;
  dir: "up" | "down";
  /** Ключ пивота пробитого уровня (identity-ссылка). */
  brokenPivotKey: string;
  /** Цена пробитого уровня — payload. */
  brokenLevelPrice: number;
  /** openTime свечи, чей CLOSE образовал событие. */
  eventTime: Date;
  /** effectiveCloseTime той же свечи; actionableAt =
   * confirmedAt (anti-lookahead V2 §17). */
  confirmedAt: Date;
}

export type SmcLevelState = "AVAILABLE" | "CONSUMED";

export interface SmcStructuralLevel {
  pivotKey: string;
  layer: SmcLayer;
  kind: SmcPivotKind;
  price: number;
  eventTime: Date;
  confirmedAt: Date;
  state: SmcLevelState;
  consumedAt: Date | null;
  consumedByEventKey: string | null;
}

export interface SmcStructureResult {
  tf: SmcTimeframe;
  layer: SmcLayer;
  phase: StructurePhase;
  /** Хронологически по anchor (порядок сканирования). */
  pivots: SmcPivot[];
  events: SmcStructureEvent[];
  /** highs, затем lows, в порядке подтверждения-регистрации. */
  levels: SmcStructuralLevel[];
}
