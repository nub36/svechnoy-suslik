/**
 * P2-B — единый источник длительности таймфрейма.
 *
 * Требование: "gap detection должен быть timeframe-aware, используя
 * timeframe duration source, а не второй набор констант".
 *
 * Единственный источник — SMCTIMEFRAME_MS из lib/smc/types.ts.
 * P2-B не хардкодит свои 5m/15m/1h/4h/1d, а импортирует отсюда.
 */

import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../smc/types";

export { SMCTIMEFRAME_MS };
export type { SmcTimeframe };

/**
 * Получить длительность ТФ в ms из единственного источника.
 * Возвращает null если ТФ неизвестен (не бросает, чтобы coverage мог
 * отчитаться о неизвестном ТФ).
 */
export function getTimeframeMs(timeframe: string): number | null {
  const ms = (SMCTIMEFRAME_MS as Record<string, number>)[timeframe];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Проверить, является ли timeframe каноническим (из SMCTIMEFRAME_MS).
 */
export function isCanonicalTimeframe(timeframe: string): boolean {
  return getTimeframeMs(timeframe) !== null;
}

/**
 * Список канонических ТФ.
 */
export const CANONICAL_TIMEFRAMES: readonly string[] = Object.keys(
  SMCTIMEFRAME_MS
);
