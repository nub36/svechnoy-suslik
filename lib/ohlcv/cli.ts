import type { Timeframe } from "../exchanges/types";
import { TOP_UNIVERSE_SIZE } from "../universe";
import { DEFAULT_OHLCV_OPTIONS, type OhlcvWorkerOptions } from "./sync";

/**
 * Чистый (без Prisma и бирж) разбор аргументов CLI OHLCV worker.
 *
 * Вынесен отдельно, чтобы можно было тестировать парсинг
 * без базы данных: scripts/test-ohlcv-cli.ts.
 *
 * Принципы безопасного запуска:
 * - top ограничен 1..100 (основной universe Top-100,
 *   см. lib/universe.ts) и по умолчанию 10;
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
  confirmLargeRun: boolean;
};

/* ---------- безопасный разбор вызова ---------- */

/**
 * Флаги, которые понимает ohcv-worker. Всё прочее —
 * ошибка (защита от опечаток вида --onc/--to=5,
 * которые раньше молча запускали воркер с defaults).
 */
const KNOWN_OHLCV_FLAGS: ReadonlySet<string> = new Set([
  "top",
  "timeframes",
  "limit",
  "delay",
  "once",
  "plan",
  "confirm-large-run",
  "help",
  "h"
]);

export function wantsHelp(argv: string[]): boolean {
  return (
    argv.includes("--help") || argv.includes("-h")
  );
}

export function validateKnownFlags(
  argv: string[],
  known: ReadonlySet<string>,
  availableHint: string
): string | null {
  for (const arg of argv) {
    if (!arg.startsWith("-")) {
      return `Неизвестный аргумент "${arg}". Доступные флаги: ${availableHint}. Справка: --help`;
    }

    if (!arg.startsWith("--")) {
      // одиночный "-h" разрешён, остальной одиночный дефис — нет
      if (arg !== "-h") {
        return `Неизвестный флаг "${arg}". Доступные флаги: ${availableHint}. Справка: --help`;
      }

      continue;
    }

    const name = arg.slice(2).split("=")[0];

    if (!known.has(name)) {
      return `Неизвестный флаг "${arg}". Доступные флаги: ${availableHint}. Справка: --help`;
    }
  }

  return null;
}

export type OhlcvInvocation =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "plan"; options: OhlcvCliOptions }
  | { kind: "run"; options: OhlcvCliOptions };

/**
 * Полный разбор вызова воркера БЕЗ обращения к БД/биржам:
 * help обнаруживается раньше всего; неизвестные флаги и
 * невалидные значения — error (воркер выйдет с кодом != 0),
 * иначе — run с готовыми опциями.
 */
export function resolveOhlcvInvocation(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): OhlcvInvocation {
  // --help приоритетнее любых других аргументов.
  if (wantsHelp(argv)) {
    return { kind: "help" };
  }

  const flagError = validateKnownFlags(
    argv,
    KNOWN_OHLCV_FLAGS,
    "--top= --timeframes= --limit= --delay= --once"
  );

  if (flagError !== null) {
    return { kind: "error", message: flagError };
  }

  try {
    const options = parseOhlcvArgs(argv, env);

    // --plan: показать план и выйти (read-only,
    // без sync-кода, бирж и записи). Справка (--help)
    // имеет приоритет над --plan.
    if (argv.includes("--plan")) {
      return { kind: "plan", options };
    }

    return { kind: "run", options };
  } catch (error) {
    return {
      kind: "error",
      message:
        error instanceof Error
          ? error.message
          : String(error)
    };
  }
}

export function buildOhlcvHelp(): string {
  return [
    "🐿️ OHLCV Worker — загрузка свечей с бирж в PostgreSQL",
    "",
    "Использование:",
    "  npx tsx scripts/ohlcv-worker.ts [флаги]",
    "",
    "Флаги (только форма --имя=значение):",
    "  --top=N           сколько топ-активов грузить, 1..100 (основной universe),",
    "                    по умолчанию 10; массовый прогон всего universe НЕ запускается сам",
    "  --timeframes=...  список таймфреймов: 5m,15m,1h,4h,1d, по умолчанию 1h",
    "  --limit=N         свечей истории за один запрос, 50..1000, по умолчанию 300",
    "  --delay=N         пауза между запросами в мс, 0..60000, по умолчанию 250",
    "  --once            один проход (без него цикл: проход раз в час)",
    "  --help, -h        эта справка (без обращения к БД и биржам)",
    "",
    "Примеры безопасного запуска:",
    "  npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=1h --once",
    "  npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d --once",
    "  npx tsx scripts/ohlcv-worker.ts --top=5 --timeframes=1h --limit=300 --delay=250 --once",
    "",
    "Безопасность: воркер идёт строго последовательно, с retry/backoff;",
    "пишет только upsert по ключу рынок+таймфрейм+openTime — дубли невозможны,",
    "существующие свечи не удаляются, никакого reset. Остановка: Ctrl+C"
  ].join("\n");
}

export function parseOhlcvArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): OhlcvCliOptions {
  // Строгая проверка имён флагов: опечатка вида --onc
  // или --to=5 должна падать, а не молча включать defaults.
  const flagError = validateKnownFlags(
    argv,
    KNOWN_OHLCV_FLAGS,
    "--top= --timeframes= --limit= --delay= --once"
  );

  if (flagError !== null) {
    throw new Error(flagError);
  }

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
      { name: "top", min: 1, max: TOP_UNIVERSE_SIZE }
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
    confirmLargeRun:
      argv.includes("--confirm-large-run"),
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
