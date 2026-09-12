/**
 * P2-B — eligibility wrapper, переиспользующий существующую Smart Money
 * политику, не дублируя её.
 *
 * Требование ТЗ: "Переиспользуй существующую Smart Money eligibility
 * policy там, где runner запускается именно для Smart Money. BINGX 1d
 * exclusion там, где eligibility этого требует, но не как глобальное
 * правило."
 *
 * То есть:
 * - generic data plane: все рынки eligible (сырое покрытие)
 * - Smart Money runner: применяем isSmartMoneyExchangeEligible
 *
 * Этот файл — тонкая обёртка, не новый набор констант.
 */

import {
  isSmartMoneyExchangeEligible as isSMEligible,
  filterSmartMoneyEligibleMarkets as filterSMMarkets,
  ELIGIBLE_EXCHANGES_BY_TF,
} from "../strategies/smart-money-eligibility";
import type { BacktestMarketRow } from "./data-source";

export { isSMEligible as isSmartMoneyExchangeEligible };
export { ELIGIBLE_EXCHANGES_BY_TF };

/**
 * Generic eligibility: все рынки eligible (для raw coverage).
 */
export function isGenericEligible(): boolean {
  return true;
}

/**
 * Проверить один рынок на eligibility в зависимости от контекста runner.
 *
 * @param market — Market row с exchange
 * @param timeframe — timeframe string (5m/15m/1h/4h/1d)
 * @param isSmartMoneyRunner — если true, применяем Smart Money политику
 */
export function isMarketEligible(
  market: { exchange: string },
  timeframe: string,
  isSmartMoneyRunner: boolean
): boolean {
  if (!isSmartMoneyRunner) return true;
  return isSMEligible(market.exchange, timeframe);
}

/**
 * Фильтр рынков по eligibility.
 */
export function filterEligibleMarkets(
  markets: readonly BacktestMarketRow[],
  timeframe: string,
  isSmartMoneyRunner: boolean
): BacktestMarketRow[] {
  if (!isSmartMoneyRunner) return [...markets];

  return filterSMMarkets(
    markets.map((m) => ({ ...m, timeframe })),
    timeframe
  ) as BacktestMarketRow[];
}

/**
 * Разделение на eligible / ineligible с причиной.
 */
export function partitionByEligibility(
  markets: readonly BacktestMarketRow[],
  timeframe: string,
  isSmartMoneyRunner: boolean
): {
  eligible: BacktestMarketRow[];
  ineligible: { market: BacktestMarketRow; reason: string }[];
} {
  const eligible: BacktestMarketRow[] = [];
  const ineligible: { market: BacktestMarketRow; reason: string }[] = [];

  for (const m of markets) {
    if (isMarketEligible(m, timeframe, isSmartMoneyRunner)) {
      eligible.push(m);
    } else {
      const reason =
        m.exchange === "BINGX" && timeframe === "1d"
          ? "BINGX excluded for 1d in Smart Money (off-grid 16:00 UTC)"
          : `Exchange ${m.exchange} not eligible for ${timeframe} in Smart Money`;

      ineligible.push({ market: m, reason });
    }
  }

  return { eligible, ineligible };
}
