/**
 * SMC Phase 2A — ATR/volatility primitive.
 *
 * АУДИТ СУЩЕСТВУЮЩЕЙ ATR (предписание Phase 2A):
 * проект уже содержит pure-функцию atrSeries в
 * lib/indicators/index.ts (используется analyze.ts через
 * atr(); тот же модуль; без Prisma/сети):
 *
 *   TR_i (i>=1) = max(high_i - low_i,
 *                     |high_i - close_{i-1}|,
 *                     |low_i - close_{i-1}|),  TR_0 нет;
 *   ATR[period] = SMA(TR_1..TR_period)  (seed);
 *   ATR[i] = (ATR[i-1]*(period-1) + TR_i) / period  (Wilder RMA);
 *   ATR[i] = null для i < period (insufficient history).
 *
 * РЕШЕНИЕ: (A) переиспользуем atrSeries НАПРЯМУЮ — реимплементации
 * нет, математическая эквивалентность гарантирована вызовом той же
 * функции и дополнительно доказана тестом (test-smc-displacement:
 * равенство серий 1e-9 + hand-computed Wilder-контроль на period=3).
 *
 * CAUSALITY / ACTIONABILITY:
 * ATR[i] вычисляется только из свечей 0..i (серия causal) и
 * становится actionable строго в effectiveCloseTime(candles[i]);
 * потребитель не может увидеть ATR[i] раньше закрытия свечи i.
 * Insufficient history → null: никакого fallback; primitive,
 * требующий ATR, обязан вернуть not-evaluable для точки
 * (displacement/FVG пропускают кандидата, не выдумывая значение).
 */

import { atrSeries } from "../indicators";
import { SmcCandle } from "./types";

/**
 * INITIAL ENGINEERING DEFAULT / HYPOTHESIS: период ATR =
 * 14 — согласован с существующим ATR14 проекта
 * (IndicatorSnapshot.atr14). Не оптимизирован под SMC.
 */
export const SMC_ATR_PERIOD_DEFAULT = 14;

/** ATR-серия, выровненная по каноническим свечам.
 * Значение null = недостаточно истории (нет fallback). */
export function computeAtrSeries(
  candles: SmcCandle[],
  period: number = SMC_ATR_PERIOD_DEFAULT
): (number | null)[] {
  return atrSeries(
    candles.map((candle) => ({
      high: candle.high,
      low: candle.low,
      close: candle.close
    })),
    period
  );
}

/** Точечный доступ с проверкой границ: null вне массива или
 * при недостаточной истории. */
export function atrValueAt(
  series: (number | null)[],
  index: number
): number | null {
  if (index < 0 || index >= series.length) {
    return null;
  }

  return series[index];
}

/** Момент, когда ATR[i] становится actionable:
 * effectiveCloseTime свечи i (каноническая граница Phase 1). */
export function atrActionableAt(
  candles: SmcCandle[],
  index: number
): Date {
  const candle = candles[index];

  if (!candle) {
    throw new RangeError(
      `atrActionableAt: индекс ${index} вне массива`
    );
  }

  return candle.effectiveCloseTime;
}
