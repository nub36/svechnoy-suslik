/**
 * Свежесть данных (freshness) последней закрытой свечи —
 * чистая функция, общая для админки и графика.
 *
 * ФОРМУЛА (документирована сознательно):
 *
 *   D   — длительность таймфрейма в минутах
 *         (5m=5, 15m=15, 1h=60, 4h=240, 1d=1440);
 *   age — now − openTime последней ЗАКРЫТОЙ свечи.
 *
 *   АКТУАЛЬНО  : age <= FRESH_WITHIN_INTERVALS * D
 *                (последняя закрытая свеча максимум на 2 интервала
 *                старше now: текущая свеча ещё формируется + лаг
 *                синхронизации воркера);
 *   ЗАДЕРЖКА   : age <= DELAYED_WITHIN_INTERVALS * D
 *                (данные приходят с заметным опозданием, но
 *                соизмеримо с таймфреймом);
 *   УСТАРЕЛО   : age >  DELAYED_WITHIN_INTERVALS * D;
 *   НЕТ ДАННЫХ : свечи нет (или таймфрейм неизвестен).
 *
 * Порог пропорционален длительности свечи, поэтому 1d-свеча
 * возрастом 10 минут (и даже 28 часов) — АКТУАЛЬНО, а 5m-свеча
 * возрастом 25 минут — уже ЗАДЕРЖКА.
 *
 * Тесты: scripts/test-freshness.ts (с фиксированным now).
 */

export const TIMEFRAME_MINUTES: Record<
  string,
  number
> = {
  "5m": 5,
  "15m": 15,
  "1h": 60,
  "4h": 240,
  "1d": 1440
};

/** АКТУАЛЬНО: возраст последней закрытой свечи ≤ N интервалов. */
export const FRESH_WITHIN_INTERVALS = 2;

/** ЗАДЕРЖКА: возраст ≤ N интервалов (иначе УСТАРЕЛО). */
export const DELAYED_WITHIN_INTERVALS = 6;

export type FreshnessStatus =
  | "fresh"
  | "delayed"
  | "stale"
  | "missing";

export const FRESHNESS_LABELS: Record<
  FreshnessStatus,
  string
> = {
  fresh: "АКТУАЛЬНО",
  delayed: "ЗАДЕРЖКА",
  stale: "УСТАРЕЛО",
  missing: "НЕТ ДАННЫХ"
};

export type Freshness = {
  status: FreshnessStatus;
  label: string;
  /** Возраст последней закрытой свечи в минутах (или null). */
  ageMinutes: number | null;
};

function toMs(
  value: Date | number | string | null | undefined
): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const ms =
    value instanceof Date
      ? value.getTime()
      : typeof value === "number"
        ? value
        : Date.parse(value);

  return Number.isFinite(ms) ? ms : null;
}

export function candleFreshness(
  timeframe: string,
  lastCandleOpenTime:
    | Date
    | number
    | string
    | null
    | undefined,
  now: Date = new Date()
): Freshness {
  const duration =
    TIMEFRAME_MINUTES[timeframe];
  const lastMs = toMs(lastCandleOpenTime);

  if (
    duration === undefined ||
    lastMs === null
  ) {
    return {
      status: "missing",
      label: FRESHNESS_LABELS.missing,
      ageMinutes: null
    };
  }

  const ageMinutes =
    (now.getTime() - lastMs) / 60000;

  if (ageMinutes < 0) {
    // свеча «из будущего» — считаем актуальной
    return {
      status: "fresh",
      label: FRESHNESS_LABELS.fresh,
      ageMinutes: 0
    };
  }

  const status: FreshnessStatus =
    ageMinutes <=
    FRESH_WITHIN_INTERVALS * duration
      ? "fresh"
      : ageMinutes <=
          DELAYED_WITHIN_INTERVALS *
            duration
        ? "delayed"
        : "stale";

  return {
    status,
    label: FRESHNESS_LABELS[status],
    ageMinutes
  };
}

/** Рекомендуемая команда plan-режима для добора таймфрейма. */
export function planCommandForTimeframe(
  timeframe: string
): string {
  return `npx tsx scripts/ohlcv-worker.ts --plan --top=10 --timeframes=${timeframe} --limit=300`;
}
