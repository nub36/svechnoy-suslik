/**
 * P2-B — Candle → P2-A BacktestBar адаптер.
 *
 * Чистый детерминированный слой: без Prisma, без сети, без env, без
 * случайности. Единственная ответственность — преобразование
 * PostgreSQL Candle строки в REAL P2-A BacktestBar input, с сохранением
 * timestamp точно (openTime ms UTC) и OHLCV как есть.
 *
 * P2-B НЕ устанавливает SL/TP/fees/slippage/timeout/policy/metrics —
 * это ответственность P2-A. Адаптер не фильтрует, не сортирует, не
 * дедуплицирует молча: любые аномалии отлавливаются валидацией
 * (lib/backtest/validate.ts) и coverage/gaps слоями.
 *
 * Контракт P2-A (BacktestBar): time=int>0 ms UTC, open/high/low/close
 * finite>0, high>=max(open,close), low<=min(open,close), volume>=0
 * optional. Пустой набор, дубликаты, немонотонность — ошибки валидации.
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

/**
 * Преобразование одной строки в BacktestBar.
 * Сохраняет timestamp точь-в-точь: openTime.getTime().
 * Не проверяет closed — проверка делается на уровне выборки
 * (WHERE closed=true), но если closed=false передан, бар всё равно
 * создаётся, чтобы валидация/покрытие могли зафиксировать аномалию
 * выше по стеку, если это потребуется (основной путь — фильтр в deps).
 */
export function candleRowToBacktestBar(row: BacktestCandleRow): BacktestBar {
  const time = row.openTime.getTime();

  // volume опционален в BacktestBar, но в Candle он всегда есть.
  // Сохраняем как есть; P2-A валидация допускает отсутствие.
  const bar: BacktestBar = {
    time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };

  return bar;
}

/**
 * Пакетное преобразование. Не сортирует и не дедуплицирует — сохраняет
 * порядок входа, чтобы дубликаты/немонотонность ловились честно.
 */
export function candleRowsToBacktestBars(
  rows: readonly BacktestCandleRow[]
): BacktestBar[] {
  const out: BacktestBar[] = new Array(rows.length);

  for (let i = 0; i < rows.length; i += 1) {
    out[i] = candleRowToBacktestBar(rows[i]);
  }

  return out;
}

/**
 * Проверка сохранения timestamp: round-trip Date → ms → Date.
 * Используется в тестах, чтобы доказать, что openTime сохраняется
 * без сдвига.
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
