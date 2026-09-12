/**
 * P2-B — Candle → P2-A BacktestBar адаптер.
 *
 * Чистый детерминированный слой: без Prisma, без сети, без env, без
 * случайности, без Date.now(). Единственная ответственность —
 * преобразование PostgreSQL Candle строки в REAL P2-A BacktestBar input,
 * с сохранением timestamp точно (openTime ms UTC) и OHLCV как есть.
 *
 * P2-B НЕ устанавливает SL/TP/fees/slippage/timeout/policy/metrics —
 * это ответственность P2-A. Адаптер не фильтрует, не сортирует, не
 * дедуплицирует молча: любые аномалии отлавливаются валидацией
 * (lib/backtest/validate.ts) и coverage/gaps слоями, но базовая
 * идентичность/provenance проверяется здесь fail-closed.
 *
 * Контракт P2-A (BacktestBar): time=int>0 ms UTC, open/high/low/close
 * finite>0, high>=max(open,close), low<=min(open,close), volume>=0
 * optional. Пустой набор, дубликаты, немонотонность — ошибки валидации.
 *
 * Исторический as-of семантика:
 * - BacktestBar.time = openTime (ms UTC)
 * - Для таймфрейма D бар каузально закрыт в time + D (консервативно).
 *   Проектная конвенция effectiveCloseTime = openTime + SMCTIMEFRAME_MS[tf]
 *   (см. lib/smc/types.ts). P2-B загружает исторические закрытые свечи,
 *   которые сегодня closed=true, но это НЕ доказательство, что бар был
 *   доступен до исторического close — no-lookahead enforced в P2-A
 *   (SignalContext.barAt). Поэтому P2-B сохраняет openTime точно и
 *   документирует closeTime = openTime + D, не используя wall-clock now.
 * - Никакого Date.now() / new Date() без аргументов.
 *
 * Causal strategy-provider certification is pending hardened P2-A contract
 * (known P2-A finding: assertDecisionInvariance false-passes closure cheater).
 * P2-B itself is only responsible for honest historical data delivery.
 */

import type { BacktestBar } from "./contract";

/**
 * Минимальный тип Candle строки, как он приходит из PostgreSQL через
 * Prisma. Поля взяты из prisma/schema.prisma model Candle:
 * marketId, timeframe, openTime, closeTime?, open/high/low/close,
 * volume, closed. id/createdAt/updatedAt не нужны для бэктеста.
 */
export interface BacktestCandleRow {
  readonly marketId: number;
  readonly timeframe: string;
  readonly openTime: Date;
  readonly closeTime?: Date | null;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly closed: boolean;
}

export interface AdapterValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Строгая валидация одной строки Candle для identity/provenance.
 * Fail-closed, structured errors, не полагается только на later P2-A validation.
 */
export function validateCandleRow(row: unknown): AdapterValidation {
  const errors: string[] = [];

  if (row === null || typeof row !== "object") {
    return { ok: false, errors: ["CandleRow: не объект"] };
  }

  const r = row as Partial<BacktestCandleRow>;

  // marketId
  if (!isFiniteNumber(r.marketId) || !Number.isInteger(r.marketId) || r.marketId <= 0) {
    errors.push("marketId должен быть целым >0");
  }

  // timeframe
  if (typeof r.timeframe !== "string" || r.timeframe.trim().length === 0) {
    errors.push("timeframe: непустая строка");
  }

  // openTime
  if (!(r.openTime instanceof Date)) {
    errors.push("openTime должен быть Date");
  } else if (Number.isNaN(r.openTime.getTime())) {
    errors.push("openTime: invalid Date (NaN)");
  } else {
    const ms = r.openTime.getTime();
    if (!Number.isInteger(ms)) {
      // sub-second preserved, but must be integer ms (Date always integer ms)
      // This check ensures no float timestamp
      errors.push(`openTime ms должен быть целым, получен ${ms}`);
    }
    if (ms <= 0) {
      errors.push("openTime ms должен быть >0");
    }
    if (!Number.isSafeInteger(ms)) {
      errors.push(`openTime ms не safe integer: ${ms}`);
    }
  }

  // OHLCV — ALL fields checked, not just open/high
  for (const field of ["open", "high", "low", "close", "volume"] as const) {
    const v = r[field];
    if (!isFiniteNumber(v)) {
      errors.push(`${field}: конечное число, получено ${String(v)}`);
    } else {
      if (field !== "volume" && v <= 0) {
        errors.push(`${field} должен быть >0`);
      }
      if (field === "volume" && v < 0) {
        errors.push("volume должен быть >=0");
      }
    }
  }

  // OHLC geometry
  if (
    isFiniteNumber(r.open) &&
    isFiniteNumber(r.high) &&
    isFiniteNumber(r.low) &&
    isFiniteNumber(r.close)
  ) {
    if (r.high! < Math.max(r.open!, r.close!)) {
      errors.push(`high ${r.high} < max(open ${r.open}, close ${r.close})`);
    }
    if (r.low! > Math.min(r.open!, r.close!)) {
      errors.push(`low ${r.low} > min(open ${r.open}, close ${r.close})`);
    }
    if (r.high! < r.low!) {
      errors.push(`high ${r.high} < low ${r.low}`);
    }
  }

  // closed must be boolean
  if (typeof r.closed !== "boolean") {
    errors.push("closed должен быть boolean");
  }

  return { ok: errors.length === 0, errors };
}

/**
 * Преобразование одной строки в BacktestBar.
 * Сохраняет timestamp точь-в-точь: openTime.getTime() без округления.
 * Fail-closed на невалидных данных.
 */
export function candleRowToBacktestBar(row: BacktestCandleRow): BacktestBar {
  const validation = validateCandleRow(row);
  if (!validation.ok) {
    throw new Error(`candleRowToBacktestBar: ${validation.errors.join("; ")}`);
  }

  const time = row.openTime.getTime(); // exact ms, no rounding, sub-second preserved

  const bar: BacktestBar = {
    time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };

  return Object.freeze(bar);
}

/**
 * Пакетное преобразование. Не сортирует и не дедуплицирует — сохраняет
 * порядок входа, чтобы дубликаты/немонотонность ловились честно.
 * Fail-closed на первой невалидной строке.
 */
export function candleRowsToBacktestBars(
  rows: readonly BacktestCandleRow[]
): BacktestBar[] {
  const out: BacktestBar[] = new Array(rows.length);

  for (let i = 0; i < rows.length; i += 1) {
    out[i] = candleRowToBacktestBar(rows[i]);
  }

  return Object.freeze(out) as unknown as BacktestBar[];
}

/**
 * Проверка сохранения timestamp: round-trip Date → ms → Date.
 * Sub-second timestamp exactly preserved, no rounding.
 */
export function assertTimestampPreserved(
  row: BacktestCandleRow,
  bar: BacktestBar
): { ok: boolean; error?: string } {
  if (row.openTime.getTime() !== bar.time) {
    return {
      ok: false,
      error: `timestamp mismatch: row ${row.openTime.toISOString()} (${row.openTime.getTime()}) vs bar ${bar.time}`,
    };
  }

  return { ok: true };
}
