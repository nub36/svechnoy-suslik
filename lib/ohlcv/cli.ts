import type { Timeframe } from "../exchanges/types";
import { DEFAULT_OHLCV_OPTIONS, type OhlcvWorkerOptions } from "./sync";

/**
 * Чистый (без Prisma и бирж) разбор аргументов CLI OHLCV worker.
 *
 * Вынесен отдельно, чтобы можно было тестировать парсинг
 * без базы данных: scripts/test-ohlcv-cli.ts.
 *
 * Принципы безопасного запуска:
 * - top ограничен 1..500 и по умолчанию 10 — никакого
 *   автоматического прогона Top-500;
 * - timeframes валидируются по белому списку — опечатка
 *   вида --timeframes=1x падает сразу с понятной ошибкой,
 *   а не превращается в мусорный запрос к адаптеру биржи;
 * - limit (исторических свечей за раз) ограничен 50..1000;
 * - delay (пауза между запросами) — троттлинг, воркер
 *   работает строго последовательно (concurrency = 1).
 */

export const ALLOWED_TIMEFRAMES: readonly Timeframe[] = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
];

const TIMEFRAME_SET: ReadonlySet<string> = new Set(
  ALLOWED_TIMEFRAMES
);

export function parseTimeframeList(
  raw: string | undefined,
  fallback: Timeframe[]
): Timeframe[] {
  if (raw === undefined || raw.trim() === "") {
    return [...fallback];
  }

  const seen = new Set<string>();
  const result: Timeframe[] = [];

  for (const part of raw.split(",")) {
    const value = part.trim();

    if (value === "") {
      continue;
    }

    if (!TIMEFRAME_SET.has(value)) {
      throw new Error(
        `Недопустимый timeframe: "${value}". Разрешены: ${ALLOWED_TIMEFRAMES.join(", ")}`
      );
    }

    if (!seen.has(value)) {
      seen.add(value);
      result.push(value as Timeframe);
    }
  }

  if (result.length === 0) {
    return [...fallback];
  }

  return result;
}

export function parseCliNumber(
  raw: string | undefined,
  fallback: number,
  options: { name: string; min: number; max: number }
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }

  const value = Number(raw);

  if (!Number.isInteger(value)) {
    throw new Error(
      `Опция --${options.name}: ожидается целое число, получено "${raw}"`
    );
  }

  if (value < options.min || value > options.max) {
    throw new Error(
      `Опция --${options.name}: должно быть от ${options.min} до ${options.max}, получено ${value}`
    );
  }

  return value;
}

export type OhlcvCliOptions = OhlcvWorkerOptions & {
  once: boolean;
  intervalMs: number;
};

export function parseOhlcvArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): OhlcvCliOptions {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((arg) =>
      arg.startsWith(prefix)
    );

    return hit?.slice(prefix.length);
  };

  const timeframes = parseTimeframeList(
    get("timeframes") ?? env.OHLCV_TIMEFRAMES,
    DEFAULT_OHLCV_OPTIONS.timeframes
  );

  return {
    top: parseCliNumber(
      get("top") ?? env.OHLCV_TOP,
      DEFAULT_OHLCV_OPTIONS.top,
      { name: "top", min: 1, max: 500 }
    ),
    timeframes,
    limit: parseCliNumber(
      get("limit") ?? env.OHLCV_LIMIT,
      DEFAULT_OHLCV_OPTIONS.limit,
      { name: "limit", min: 50, max: 1000 }
    ),
    requestDelayMs: parseCliNumber(
      get("delay") ?? env.OHLCV_DELAY_MS,
      DEFAULT_OHLCV_OPTIONS.requestDelayMs,
      { name: "delay", min: 0, max: 60000 }
    ),
    once:
      argv.includes("--once") ||
      env.OHLCV_ONCE === "1",
    intervalMs: parseCliNumber(
      env.OHLCV_INTERVAL_MS,
      60 * 60 * 1000,
      { name: "interval", min: 1000, max: 86400000 }
    )
  };
}

export type TimeframeStatsRow = {
  markets: number;
  fetched: number;
  written: number;
  created: number;
  updated: number;
  skippedInvalid: number;
  errors: number;
};

/**
 * Строки итогов по каждому таймфрейму
 * (для печати в воркере; чистая функция — тестируется).
 */
export function formatTimeframeSummary(
  byTimeframe: Record<string, TimeframeStatsRow>
): string[] {
  const lines: string[] = [];

  for (const [timeframe, row] of Object.entries(
    byTimeframe
  )) {
    lines.push(
      `  ${timeframe.padEnd(4)} рынков=${row.markets} ` +
        `получено=${row.fetched} записано=${row.written} ` +
        `создано=${row.created} обновлено=${row.updated} ` +
        `пропущено=${row.skippedInvalid} ошибок=${row.errors}`
    );
  }

  return lines;
}
