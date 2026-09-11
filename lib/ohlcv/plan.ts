import type { PrismaClient } from "@prisma/client";
import type { OhlcvWorkerOptions } from "./sync";

/**
 * План запуска OHLCV worker — read-only.
 *
 * collectPlanStats делает ТОЛЬКО SELECT-запросы
 * (Asset/Market), ничего не пишет и не обращается к биржам.
 * formatPlanReport и evaluateRunScale — чистые функции
 * (тестируются в scripts/test-ohlcv-cli.ts).
 */

export type PlanStats = {
  assets: number;
  markets: number;
  tasks: number;
  maxCandles: number;
  apiRequests: number;
  byExchange: Record<string, number>;
};

/** Читает масштаб прогона из PostgreSQL (read-only SELECT). */
export async function collectPlanStats(
  prisma: PrismaClient,
  options: OhlcvWorkerOptions
): Promise<PlanStats> {
  let assets: Array<{ id: number }>;
  if (options.symbol) {
    const single = await prisma.asset.findFirst({
      where: {
        symbol: options.symbol,
        enabled: true
      },
      select: { id: true }
    });
    assets = single ? [single] : [];
  } else {
    assets = await prisma.asset.findMany({
      where: {
        enabled: true,
        rank: {
          lte: options.top,
          not: null
        }
      },
      orderBy: { rank: "asc" },
      take: options.top,
      select: { id: true }
    });
  }

  const assetIds = assets.map((a: { id: number }) => a.id);

  const markets =
    assetIds.length > 0
      ? await prisma.market.findMany({
          where: {
            assetId: { in: assetIds },
            enabled: true,
            status: "ACTIVE",
            quote: "USDT",
            marketType: "SPOT"
          },
          select: { exchange: true }
        })
      : [];

  const byExchange: Record<string, number> = {};

  for (const market of markets) {
    byExchange[market.exchange] =
      (byExchange[market.exchange] ?? 0) + 1;
  }

  const tasks =
    markets.length * options.timeframes.length;

  return {
    assets: assets.length,
    markets: markets.length,
    tasks,
    maxCandles:
      tasks * options.limit,
    apiRequests: tasks,
    byExchange
  };
}

/**
 * ПРЕДОХРАНИТЕЛЬ от случайного большого запуска
 * (Top-500 × 5 таймфреймов × все рынки).
 *
 * Порог — в ЗАДАЧАХ (рынок × таймфрейм): 500.
 * Ориентиры: Top-10 × 5 ТФ ≈ 240 задач — разрешено;
 * Top-500 × 1 ТФ ≈ 2357 — уже требует явного confirm.
 */
export const LARGE_RUN_TASK_THRESHOLD = 500;

export type RunScaleDecision = {
  allowed: boolean;
  message: string | null;
};

export function evaluateRunScale(
  tasks: number,
  confirmLargeRun: boolean,
  threshold: number = LARGE_RUN_TASK_THRESHOLD
): RunScaleDecision {
  if (tasks <= threshold) {
    return { allowed: true, message: null };
  }

  if (confirmLargeRun) {
    return {
      allowed: true,
      message: `Подтверждено: задач ${tasks} > порога ${threshold} (--confirm-large-run)`
    };
  }

  return {
    allowed: false,
    message:
      `Отказ: задач ${tasks} (рынок × таймфрейм) больше порога ` +
      `${threshold}. Повторите ту же команду, добавив ` +
      `--confirm-large-run, если нагрузка осознанная.`
  };
}

/**
 * Заголовок предварительной оценки — семантика вывода:
 * ТОЛЬКО явный --plan имеет право писать «Режим PLAN»
 * (read-only до конца процесса). Обычный запуск без
 * --plan перед предохранителем пишет честное
 * «Предварительная оценка запуска» — БД при оценке
 * не меняется, но дальше будет обращение к API бирж.
 */
export function preflightTitle(
  isPlan: boolean
): string {
  return isPlan
    ? "Режим PLAN: PostgreSQL не изменяется, API бирж не вызываются"
    : "Предварительная оценка запуска (read-only по PostgreSQL; далее, при запуске — обращение к API бирж)";
}

/** Строки отчёта оценки (чистая функция, без заголовка). */
export function formatPlanReport(
  options: Pick<
    OhlcvWorkerOptions,
    "top" | "timeframes" | "limit" | "requestDelayMs"
  > & { symbol?: string; intervalMs?: number },
  stats: PlanStats
): string[] {
  const lines: string[] = [];

  if (options.symbol) {
    lines.push(`Symbol: ${options.symbol}`);
  } else {
    lines.push(`Top-N: ${options.top}`);
  }
  lines.push(`Таймфреймы: ${options.timeframes.join(", ")}`);
  lines.push(`Свечей истории за запрос (limit): ${options.limit}`);
  lines.push(`Пауза между запросами (delay): ${options.requestDelayMs}мс`);
  if (options.intervalMs !== undefined) {
    lines.push(`Интервал continuous (interval): ${options.intervalMs}мс`);
  }
  lines.push(`Активов выбрано: ${stats.assets}`);
  lines.push(`Рынков (активные SPOT USDT): ${stats.markets}`);
  lines.push(`Задач (рынок × таймфрейм): ${stats.tasks}`);
  lines.push(
    `Максимум свечей за проход (оценка): ${stats.maxCandles.toLocaleString("ru-RU")}`
  );
  lines.push(
    `API-запросов getCandles (оценка, без retry): ≈${stats.apiRequests}`
  );

  const exchanges = Object.entries(
    stats.byExchange
  ).sort(([a], [b]) => a.localeCompare(b));

  if (exchanges.length === 0) {
    lines.push("По биржам: рынков не найдено");
  } else {
    lines.push("По биржам:");

    for (const [exchange, count] of exchanges) {
      lines.push(`  ${exchange.padEnd(8)} рынков=${count}`);
    }
  }

  return lines;
}

/** Команда повтора с явным подтверждением (чистая функция). */
export function buildConfirmCommand(options: {
  top: number;
  timeframes: string[];
  limit: number;
  requestDelayMs: number;
  once: boolean;
  symbol?: string;
  intervalMs?: number;
}): string {
  const parts = [
    "npx tsx scripts/ohlcv-worker.ts",
    `--timeframes=${options.timeframes.join(",")}`,
    `--limit=${options.limit}`,
    `--delay=${options.requestDelayMs}`,
    "--confirm-large-run"
  ];
  if (options.symbol) {
    parts.splice(1, 0, `--symbol=${options.symbol}`);
  } else {
    parts.splice(1, 0, `--top=${options.top}`);
  }
  if (options.intervalMs !== undefined) {
    parts.push(`--interval=${options.intervalMs}`);
  }

  if (options.once) {
    parts.push("--once");
  }

  return parts.join(" ");
}
