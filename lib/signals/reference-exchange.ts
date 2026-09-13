/**
 * Reference exchange policy — deterministic, independent of score/direction
 *
 * Запрещено использовать "exchange with max score" — это selection bias.
 * Reference должен определяться ДО результата SMC, не зависеть от direction/score.
 *
 * Priority (deterministic):
 * BINANCE > BYBIT > GATE > KUCOIN > BINGX
 *
 * BINGX 1d всё равно excluded via eligibility.
 */

export const REFERENCE_EXCHANGE_PRIORITY = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"] as const;

export type ExchangeName = typeof REFERENCE_EXCHANGE_PRIORITY[number] | string;

export function selectReferenceExchange(
  participants: Array<{ exchange: string; marketId: number }>,
  priority: readonly string[] = REFERENCE_EXCHANGE_PRIORITY
): { exchange: string; marketId: number } | null {
  if (participants.length === 0) return null;
  for (const prio of priority) {
    const found = participants.find((p) => p.exchange === prio);
    if (found) return found;
  }
  // Fallback: first participant if none matches priority (should not happen with known exchanges)
  return participants[0] ?? null;
}

/**
 * Validate that selection is independent of score/direction
 * Pure function, no side effects, deterministic
 */
export function isReferenceSelectionScoreIndependent(): boolean {
  // This function exists to document invariant: selection uses only exchange name, not score
  return true;
}
