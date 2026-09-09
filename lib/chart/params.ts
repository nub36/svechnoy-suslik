/**
 * Валидация параметров chart API — чистые функции
 * (тестируются в scripts/test-chart-params.ts).
 *
 * Правило: любой некорректный параметр — осмысленный 400
 * с русским сообщением, никогда не 500 и не тихий fallback.
 */

export const KNOWN_EXCHANGES: readonly string[] = [
  "BINANCE",
  "BYBIT",
  "GATE",
  "KUCOIN",
  "BINGX"
];

export const CHART_API_TIMEFRAMES: readonly string[] = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
];

export const MAX_SYMBOL_LENGTH = 16;

export type ParamCheck<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

/** symbol: непустой, <=16 символов, A-Z0-9 после нормализации. */
export function parseSymbolParam(
  raw: string | null | undefined
): ParamCheck<string> {
  if (
    raw === null ||
    raw === undefined ||
    raw.trim() === ""
  ) {
    return {
      ok: false,
      message: "Нужен параметр symbol"
    };
  }

  const value = raw.trim().toUpperCase();

  if (value.length > MAX_SYMBOL_LENGTH) {
    return {
      ok: false,
      message: `Параметр symbol слишком длинный (максимум ${MAX_SYMBOL_LENGTH} символов)`
    };
  }

  if (!/^[A-Z0-9]+$/.test(value)) {
    return {
      ok: false,
      message:
        "Параметр symbol должен состоять из латинских букв и цифр"
    };
  }

  return { ok: true, value };
}

/** exchange: только известные биржи (регистр не важен). */
export function parseExchangeParam(
  raw: string | null | undefined
): ParamCheck<string> {
  if (
    raw === null ||
    raw === undefined ||
    raw.trim() === ""
  ) {
    return {
      ok: false,
      message: "Нужен параметр exchange"
    };
  }

  const value = raw.trim().toUpperCase();

  if (!KNOWN_EXCHANGES.includes(value)) {
    return {
      ok: false,
      message: `Неизвестная биржа: ${value}. Доступные: ${KNOWN_EXCHANGES.join(", ")}`
    };
  }

  return { ok: true, value };
}

/** timeframe: белый список 5m/15m/1h/4h/1d. */
export function parseTimeframeParam(
  raw: string | null | undefined
): ParamCheck<string> {
  const value = raw?.trim() ?? "";

  if (value === "") {
    return {
      ok: false,
      message:
        "Нужен параметр timeframe (5m, 15m, 1h, 4h, 1d)"
    };
  }

  if (!CHART_API_TIMEFRAMES.includes(value)) {
    return {
      ok: false,
      message: `Неверный timeframe: ${value}. Доступные: ${CHART_API_TIMEFRAMES.join(", ")}`
    };
  }

  return { ok: true, value };
}

export const DEFAULT_CANDLES_LIMIT = 300;
export const MIN_CANDLES_LIMIT = 50;
export const MAX_CANDLES_LIMIT = 1000;

/**
 * limit: если параметра нет — 300; если есть и невалиден —
 * осмысленная ошибка (никакого тихого fallback).
 */
export function parseLimitParam(
  raw: string | null | undefined
): ParamCheck<number> {
  if (
    raw === null ||
    raw === undefined ||
    raw.trim() === ""
  ) {
    return {
      ok: true,
      value: DEFAULT_CANDLES_LIMIT
    };
  }

  const value = Number(raw);

  if (!Number.isInteger(value)) {
    return {
      ok: false,
      message:
        "Параметр limit должен быть целым числом"
    };
  }

  if (
    value < MIN_CANDLES_LIMIT ||
    value > MAX_CANDLES_LIMIT
  ) {
    return {
      ok: false,
      message: `Параметр limit должен быть от ${MIN_CANDLES_LIMIT} до ${MAX_CANDLES_LIMIT}`
    };
  }

  return { ok: true, value };
}
