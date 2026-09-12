/**
 * P2-B — единый источник длительности таймфрейма.
 *
 * Требование: "gap detection должен быть timeframe-aware, используя
 * timeframe duration source, а не второй набор констант".
 *
 * Единственный источник — SMCTIMEFRAME_MS из lib/smc/types.ts.
 * P2-B не хардкодит свои 5m/15m/1h/4h/1d, а импортирует отсюда.
 *
 * HARDENING:
 * - unknown timeframe must be explicit invalid/unknown, never healthy defaults
 * - CLI unknown timeframe must exit non-zero
 * - No arbitrary timeframe fabrication
 */

import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../smc/types";

export { SMCTIMEFRAME_MS };
export type { SmcTimeframe };

/**
 * Получить длительность ТФ в ms из единственного источника.
 * Возвращает null если ТФ неизвестен (не бросает, чтобы coverage мог
 * отчитаться о неизвестном ТФ как explicit invalid).
 */
export function getTimeframeMs(timeframe: string): number | null {
  const ms = (SMCTIMEFRAME_MS as Record<string, number>)[timeframe];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Проверить, является ли timeframe каноническим (из SMCTIMEFRAME_MS).
 * Unknown timeframe → false (fail-closed, never healthy true).
 */
export function isCanonicalTimeframe(timeframe: string): boolean {
  return getTimeframeMs(timeframe) !== null;
}

/**
 * Список канонических ТФ — единственный источник.
 */
export const CANONICAL_TIMEFRAMES: readonly string[] = Object.freeze(
  Object.keys(SMCTIMEFRAME_MS)
) as readonly string[];

/**
 * Fail-closed validation for CLI and data-plane.
 * Throws structured error if timeframe unknown.
 */
export function assertCanonicalTimeframe(timeframe: string): number {
  const ms = getTimeframeMs(timeframe);
  if (ms === null) {
    throw new Error(
      `Unknown timeframe '${timeframe}'. Supported: ${CANONICAL_TIMEFRAMES.join(", ")} (explicit invalid, never healthy)`
    );
  }
  return ms;
}
