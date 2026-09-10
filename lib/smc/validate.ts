/**
 * SMC Phase 1 — canonical CLOSED/asOf input contract
 * (спецификация V2 §2).
 *
 * ВАЛИДАЦИЯ (нарушение → SmcInputError, это всегда баг
 * вызывающего):
 *  V1 все свечи closed === true;
 *  V2 openTime строго возрастают, дубликаты запрещены
 *     (совпадает с @@unique([marketId, timeframe, openTime])
 *     в реальной модели для одного рынка/ТФ);
 *  V3 tf — из белого списка проекта;
 *  V4 OHLC-санити с допуском 1e-9 (правило 20);
 *  V5 все числа finite.
 *
 * ГОРИЗОНТ (НЕ ошибка, документированное поведение):
 * свеча участвует ⟺ effectiveCloseTime <= asOf, где
 * effectiveCloseTime = openTime + SMCTIMEFRAME_MS[tf].
 *
 * SMC намеренно НЕ использует nullable exchange closeTime
 * как canonical asOf-границу: теоретический конец интервала
 * определяет CLOSED-горизонт едиобразно и консервативно.
 * Read-only проба production БД подтвердила формулу только
 * для 1h: closeTime = openTime + 1h - 1ms (20/20 sampled
 * CLOSED), т.е. эффективная граница консервативнее на 1ms;
 * для 5m/15m/4h/1d реальных строк не было — runtime-
 * консистентность БД пока не доказана. Поле closeTime при
 * этом используется exchange ingestion и snapshots — вне
 * SMC core; менять эффективную границу ради -1ms нельзя.
 *
 * Будущие свечи МОГУТ присутствовать во входном массиве —
 * downstream получает физически обрезанный префикс
 * (см. horizonCandles), поэтому ни один алгоритм не может
 * увидеть свечи после asOf.
 */

import {
  isSmcTimeframe,
  SMCTIMEFRAME_MS,
  SmcCandle,
  SmcRawCandle,
  SmcTimeframe,
  StructureParams
} from "./types";

export class SmcInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SmcInputError";
  }
}

/** Допуск OHLC-санити (правило 20: цена tolerance 1e-9). */
const PRICE_EPSILON = 1e-9;

function finiteOrThrow(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new SmcInputError(
      `${label}: ожидается конечное число`
    );
  }

  return value;
}

/** V1–V5 + вычисление effectiveCloseTime. Вход обязан быть
 * строго возрастающим: дубликат openTime и убывание —
 * contract violations (не молча сортируем: caller bug). */
export function validateAndPrepare(
  raw: SmcRawCandle[],
  tf: SmcTimeframe
): SmcCandle[] {
  if (!isSmcTimeframe(tf)) {
    throw new SmcInputError(
      `timeframe "${String(tf)}" вне белого списка проекта`
    );
  }

  if (!Array.isArray(raw)) {
    throw new SmcInputError(
      "candles: ожидается массив SmcRawCandle"
    );
  }

  const durationMs = SMCTIMEFRAME_MS[tf];
  let prevMs = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < raw.length; i++) {
    const candle = raw[i];

    if (
      candle === null ||
      typeof candle !== "object"
    ) {
      throw new SmcInputError(
        `candles[${i}]: не объект`
      );
    }

    if (
      !(candle.openTime instanceof Date) ||
      !Number.isFinite(candle.openTime.getTime())
    ) {
      throw new SmcInputError(
        `candles[${i}].openTime: невалидная дата`
      );
    }

    if (candle.closed !== true) {
      throw new SmcInputError(
        `candles[${i}]: свеча не закрыта (closed !== true) — core принимает только CLOSED`
      );
    }

    finiteOrThrow(candle.open, `candles[${i}].open`);
    finiteOrThrow(candle.high, `candles[${i}].high`);
    finiteOrThrow(candle.low, `candles[${i}].low`);
    finiteOrThrow(candle.close, `candles[${i}].close`);

    if (
      candle.high <
        Math.max(candle.open, candle.close) -
          PRICE_EPSILON ||
      candle.low >
        Math.min(candle.open, candle.close) +
          PRICE_EPSILON ||
      candle.high < candle.low - PRICE_EPSILON
    ) {
      throw new SmcInputError(
        `candles[${i}]: несогласованный OHLC`
      );
    }

    const ms = candle.openTime.getTime();

    if (ms === prevMs) {
      throw new SmcInputError(
        `candles[${i}]: дубликат openTime`
      );
    }

    if (ms < prevMs) {
      throw new SmcInputError(
        `candles[${i}]: openTime не по возрастанию`
      );
    }

    prevMs = ms;
  }

  return raw.map((candle) => ({
    openTime: candle.openTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    effectiveCloseTime: new Date(
      candle.openTime.getTime() + durationMs
    )
  }));
}

/** Физический горизонт: единственная точка доступа к свечам
 * для всех downstream-алгоритмов. После cut свечи после
 * asOf НЕ существуют в данных. Массив отсортирован, поэтому
 * возможен ранний выход; filter без break оставлен
 * намеренно читаемым и детерминированным. */
export function horizonCandles(
  candles: SmcCandle[],
  asOf: Date
): SmcCandle[] {
  assertValidAsOf(asOf);

  const asOfMs = asOf.getTime();
  const out: SmcCandle[] = [];

  for (const candle of candles) {
    if (candle.effectiveCloseTime.getTime() <= asOfMs) {
      out.push(candle);
    }
  }

  return out;
}

export function assertValidAsOf(asOf: Date): void {
  if (!(asOf instanceof Date)) {
    throw new SmcInputError("asOf: ожидается Date");
  }

  if (!Number.isFinite(asOf.getTime())) {
    throw new SmcInputError(
      "asOf: невалидная дата (NaN/Infinity)"
    );
  }
}

export function assertValidStructureParams(
  params: StructureParams
): void {
  if (!isSmcTimeframe(params.tf)) {
    throw new SmcInputError(
      "params.tf: вне белого списка проекта"
    );
  }

  for (const field of ["left", "right"] as const) {
    const value = params[field];

    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > 500
    ) {
      throw new SmcInputError(
        `params.${field}: ожидается целое 1..500`
      );
    }
  }
}
