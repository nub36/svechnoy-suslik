/**
 * Smart Money — exchange eligibility policy (Option A, narrow).
 *
 * BingX remains fully supported globally.
 * Smart Money multi-exchange aggregation eligibility:
 * - 5m/15m/1h/4h: BINANCE, BYBIT, GATE, KUCOIN, BINGX (all 5)
 * - 1d: BINANCE, BYBIT, GATE, KUCOIN only (BINGX excluded for 1d aggregation)
 *
 * Reason: real Phase3E PostgreSQL observation — BingX 1d boundary 16:00 UTC
 * vs other four 00:00 UTC (offGrid + horizonMismatch). Until verified UTC
 * normalization, BingX 1d must not participate in Smart Money confirmation.
 *
 * This is a pure Strategy-layer policy. It does NOT modify:
 * - lib/smc/* scoring/math
 * - Prisma schema/queries
 * - exchange ingestion adapters
 * - lib/strategies/alignment.ts generic checks
 *
 * Eligibility is distinct from alignment:
 * 1) filter by eligibility (which exchanges may participate for this TF)
 * 2) exact temporal alignment on remaining evaluated markets (canonical grid + same horizon)
 * 3) aggregate only if safe, with normal minExchanges semantics
 *
 * Fail-closed for unknown exchange/timeframe.
 */

import type { ExchangeName, Timeframe } from "../exchanges/types";
import type { SmcTimeframe } from "../smc/types";
import type { MarketStrategyResult } from "./runtime";

const SUPPORTED_EXCHANGES = new Set<string>([
  "BINANCE",
  "BYBIT",
  "GATE",
  "KUCOIN",
  "BINGX",
]);

const SUPPORTED_TIMEFRAMES = new Set<string>(["5m", "15m", "1h", "4h", "1d"]);

/**
 * Pure eligibility check — no DB, no side effects, deterministic.
 * Returns false for unknown exchange or timeframe (fail-closed).
 */
export function isSmartMoneyExchangeEligible(
  exchange: string,
  timeframe: string
): boolean {
  if (!SUPPORTED_EXCHANGES.has(exchange)) return false;
  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) return false;
  if (exchange === "BINGX" && timeframe === "1d") return false;
  return true;
}

/**
 * Filter MarketStrategyResult array by eligibility for given timeframe.
 * Preserves order, pure, no mutation of original array.
 */
export function filterSmartMoneyEligibleResults(
  results: MarketStrategyResult[],
  timeframe: SmcTimeframe | string
): MarketStrategyResult[] {
  return results.filter((r) =>
    isSmartMoneyExchangeEligible(r.exchange, timeframe as string)
  );
}

/**
 * Generic filter for any array with {exchange, timeframe} fields.
 * Useful for Market-like objects before evaluation, if needed.
 */
export function filterSmartMoneyEligibleMarkets<
  T extends { exchange: string; timeframe?: string }
>(markets: T[], timeframe: SmcTimeframe | string): T[] {
  // markets may already have timeframe, or we use passed timeframe
  return markets.filter((m) => {
    const tf = (m.timeframe as string) ?? (timeframe as string);
    return isSmartMoneyExchangeEligible(m.exchange, tf);
  });
}

/**
 * Eligibility matrix for documentation/tests.
 * 5m/15m/1h/4h: all 5 eligible. 1d: 4 eligible (BINGX excluded).
 */
export const ELIGIBLE_EXCHANGES_BY_TF: Record<SmcTimeframe, readonly ExchangeName[]> = {
  "5m": ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"],
  "15m": ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"],
  "1h": ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"],
  "4h": ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"],
  "1d": ["BINANCE", "BYBIT", "GATE", "KUCOIN"],
} as const;

/**
 * Helper: get eligible exchanges for timeframe (typed, fail-closed for unknown).
 */
export function getEligibleExchanges(
  timeframe: string
): readonly ExchangeName[] {
  if (!SUPPORTED_TIMEFRAMES.has(timeframe)) return [];
  return (
    ELIGIBLE_EXCHANGES_BY_TF[timeframe as SmcTimeframe] ?? ([] as readonly ExchangeName[])
  );
}
