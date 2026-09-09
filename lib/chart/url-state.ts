/**
 * URL-состояние графика (/coin/BTC?exchange=BINANCE&timeframe=1h)
 * — чистые функции без Next-роутера и без state-менеджеров.
 *
 * URL обновляется через history.replaceState (без полного
 * reload), валидация — против реально доступных бирж и
 * таймфреймов рынка: невалидные значения НЕ ломают страницу,
 * вызывающий код берёт fallback.
 *
 * Тесты: scripts/test-url-state.ts.
 */

export type ChartUrlState = {
  exchange: string | null;
  timeframe: string | null;
};

/** Разрешённые таймфреймы графика (единый белый список). */
export const CHART_TIMEFRAMES: readonly string[] = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
];

function cleanParam(
  raw: string | null | undefined,
  maxLen: number
): string | null {
  if (typeof raw !== "string") {
    return null;
  }

  const value = raw.trim();

  if (
    value.length === 0 ||
    value.length > maxLen ||
    !/^[\w-]+$/.test(value)
  ) {
    return null;
  }

  return value;
}

/**
 * Разбор URL-параметров: exchange валиден, только если есть
 * в списке доступных рынков; timeframe — только из белого
 * списка. Невалидное → null (вызывающий возьмёт fallback).
 */
export function parseChartUrlState(
  exchangeParam: string | null | undefined,
  timeframeParam: string | null | undefined,
  availableExchanges: readonly string[]
): ChartUrlState {
  const exchangeRaw = cleanParam(exchangeParam, 16);
  const timeframeRaw = cleanParam(timeframeParam, 4);

  const exchange =
    exchangeRaw !== null &&
    availableExchanges.includes(exchangeRaw)
      ? exchangeRaw
      : null;

  const timeframe =
    timeframeRaw !== null &&
    CHART_TIMEFRAMES.includes(timeframeRaw)
      ? timeframeRaw
      : null;

  return { exchange, timeframe };
}

/**
 * Строка запроса для history.replaceState: только валидные
 * значения попадают в URL (мусор из состояния не приходит —
 * состояние уже провалидировано при разборе/выборе).
 */
export function buildChartSearch(
  exchange: string,
  timeframe: string
): string {
  const params = new URLSearchParams();

  if (/^[\w-]{1,16}$/.test(exchange)) {
    params.set("exchange", exchange);
  }

  if (CHART_TIMEFRAMES.includes(timeframe)) {
    params.set("timeframe", timeframe);
  }

  const query = params.toString();

  return query.length > 0 ? `?${query}` : "";
}
