/**
 * P2-A — издержки и арифметика сделки: слиппедж, комиссия, PnL, R.
 *
 * Политика (contract.ts, пункты 10 и 11):
 *  - слиппедж ВСЕГДА против сделки: вход LONG — вверх, вход SHORT —
 *    вниз, выход LONG (продажа) — вниз, выход SHORT (выкуп) — вверх;
 *  - bps считается от цены исполнения-основания, absolute — в
 *    единицах цены; цена исполнения не может стать отрицательной
 *    (нижняя граница 0, для bps недостижима);
 *  - комиссия = bps от НОТИОНАЛА (фактическая цена × quantity) +
 *    fixedPerSide, отдельно на каждую сторону;
 *  - слиппедж уже содержится в ценах исполнения, поэтому в netPnl он
 *    второй раз не вычитается; slippageCost публикуется аналитически.
 */

import {
  type Direction,
  type ResolvedBacktestConfig,
  type SlippageModel
} from "./contract";

/** Величина сдвига слиппеджа для цены-основания (≥ 0). */
export function slippageDelta(
  basePrice: number,
  slippage: SlippageModel
): number {
  if (slippage.value === 0) {
    return 0;
  }

  return slippage.kind === "bps"
    ? (basePrice * slippage.value) / 10_000
    : slippage.value;
}

/** Цена ВХОДА с учётом слиппеджа (против сделки). */
export function entryFillPrice(
  plannedEntryPrice: number,
  direction: Direction,
  config: ResolvedBacktestConfig
): number {
  const delta = slippageDelta(plannedEntryPrice, config.slippage);

  return Math.max(
    0,
    direction === "LONG"
      ? plannedEntryPrice + delta
      : plannedEntryPrice - delta
  );
}

/** Цена ВЫХОДА с учётом слиппеджа (против сделки). */
export function exitFillPrice(
  plannedExitPrice: number,
  direction: Direction,
  config: ResolvedBacktestConfig
): number {
  const delta = slippageDelta(plannedExitPrice, config.slippage);

  return Math.max(
    0,
    direction === "LONG"
      ? plannedExitPrice - delta
      : plannedExitPrice + delta
  );
}

/** Комиссия одной стороны: bps от нотионала + фиксированная часть. */
export function feeForSide(
  fillPrice: number,
  quantity: number,
  config: ResolvedBacktestConfig
): number {
  const notional = fillPrice * quantity;

  return (notional * config.fees.bps) / 10_000 + config.fees.fixedPerSide;
}

/** Валовый PnL (без комиссий; слиппедж уже в ценах). */
export function grossPnl(
  direction: Direction,
  entryPrice: number,
  exitPrice: number,
  quantity: number
): number {
  const diff =
    direction === "LONG" ? exitPrice - entryPrice : entryPrice - exitPrice;

  return diff * quantity;
}

/**
 * ПЛАНОВЫЙ риск — первичный знаменатель R (пункт 11 политики).
 *
 * Считается от опорной цены, известной НА МОМЕНТ СИГНАЛА (close бара
 * сигнала), до планового уровня SL. Он не зависит от слиппеджа и гэпа
 * на входе, поэтому не может схлопнуться в ноль и дать R в тысячи крат.
 */
export function plannedRiskAmount(
  plannedEntryReference: number,
  stopLoss: number,
  quantity: number
): number {
  return Math.abs(plannedEntryReference - stopLoss) * quantity;
}

/**
 * ДИАГНОСТИКА (не первичная метрика): риск между ФАКТИЧЕСКОЙ ценой
 * входа и плановым SL. Публикуется, чтобы было видно, сколько риска
 * съели слиппедж и гэп, но заголовный R считается по plannedRisk.
 */
export function riskAmount(
  entryPrice: number,
  stopLoss: number,
  quantity: number
): number {
  return Math.abs(entryPrice - stopLoss) * quantity;
}

/**
 * Задуманное reward/risk ПО ПЛАНОВЫМ уровням: от опорной цены сигнала
 * (а не от фактического исполнения).
 */
export function plannedRewardRisk(
  plannedEntryReference: number,
  stopLoss: number,
  takeProfit: number
): number {
  const risk = Math.abs(plannedEntryReference - stopLoss);

  if (risk === 0) {
    return 0;
  }

  return Math.abs(takeProfit - plannedEntryReference) / risk;
}

/**
 * Аналитическая стоимость слиппеджа в валюте счёта: сколько PnL съели
 * сдвиги цены входа и выхода относительно плановых цен.
 */
export function slippageCost(
  direction: Direction,
  plannedEntryPrice: number,
  entryPrice: number,
  plannedExitPrice: number,
  exitPrice: number,
  quantity: number
): number {
  const entryShift =
    direction === "LONG"
      ? entryPrice - plannedEntryPrice
      : plannedEntryPrice - entryPrice;
  const exitShift =
    direction === "LONG"
      ? plannedExitPrice - exitPrice
      : exitPrice - plannedExitPrice;

  return (entryShift + exitShift) * quantity;
}
