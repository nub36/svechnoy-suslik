import type { Timeframe } from "../exchanges/types";
import { LEGACY_TOP500_SIZE } from "../universe";
import { DEFAULT_OHLCV_OPTIONS, type OhlcvWorkerOptions } from "./sync";

export const ALLOWED_TIMEFRAMES: readonly Timeframe[] = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
];

export const MAX_INTERVAL_FOR_5M_MS = 5 * 60 * 1000; // 5m = 300000ms

export function validateCadence(options: { timeframes: string[]; intervalMs: number; once: boolean }): string | null {
  if (!options.once && options.timeframes.includes("5m") && options.intervalMs > MAX_INTERVAL_FOR_5M_MS) {
    return `Cadence unsafe: interval ${options.intervalMs}ms > ${MAX_INTERVAL_FOR_5M_MS}ms (5m) for continuous ingestion with 5m timeframe — default 60m (3600000ms) misses 5m CLOSED candles. Use --interval <= ${MAX_INTERVAL_FOR_5M_MS} (≤5m) or --once, or exclude 5m. For BTC pilot recommended --interval=120000 (2m) or 60000 (1m) to account for pass runtime.`;
  }
  return null;
}

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

export type SafeMode = "safe" | "incremental" | "backfill";

export type OhlcvCliOptions = OhlcvWorkerOptions & {
  once: boolean;
  intervalMs: number;
  confirmLargeRun: boolean;
  concurrency: number;
  // Safe ingestion options
  batchSize: number;
  pauseBetweenBatchesMs: number;
  incrementalLimit: number;
  backfillLimit: number;
  mode: SafeMode;
  minFreeMemMb: number;
  maxLoadAvg: number;
};

const KNOWN_OHLCV_FLAGS: ReadonlySet<string> = new Set([
  "top",
  "symbol",
  "timeframes",
  "limit",
  "delay",
  "interval",
  "once",
  "plan",
  "confirm-large-run",
  "help",
  "h",
  "concurrency",
  "batch-size",
  "pause",
  "incremental-limit",
  "backfill-limit",
  "mode",
  "min-free-mem",
  "max-load",
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

export function parseConcurrency(
  raw: string | undefined,
  fallback: number
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < 1 || v > 10) {
    throw new Error(`Опция --concurrency: ожидается целое 1..10, получено "${raw}"`);
  }
  return v;
}

function parseSafeMode(raw: string | undefined, fallback: SafeMode): SafeMode {
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase() as SafeMode;
  if (v !== "safe" && v !== "incremental" && v !== "backfill") {
    throw new Error(`Опция --mode: ожидается safe|incremental|backfill, получено "${raw}"`);
  }
  return v;
}

function parseFloatNumber(
  raw: string | undefined,
  fallback: number,
  options: { name: string; min: number; max: number }
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const v = Number(raw);
  if (!Number.isFinite(v)) {
    throw new Error(`Опция --${options.name}: ожидается число, получено "${raw}"`);
  }
  if (v < options.min || v > options.max) {
    throw new Error(`Опция --${options.name}: должно быть от ${options.min} до ${options.max}, получено ${v}`);
  }
  return v;
}

export type OhlcvInvocation =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "plan"; options: OhlcvCliOptions }
  | { kind: "run"; options: OhlcvCliOptions };

export function resolveOhlcvInvocation(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): OhlcvInvocation {
  if (wantsHelp(argv)) {
    return { kind: "help" };
  }

  const flagError = validateKnownFlags(
    argv,
    KNOWN_OHLCV_FLAGS,
    "--top= --symbol= --timeframes= --limit= --delay= --interval= --once --concurrency= --batch-size= --pause= --mode= --incremental-limit= --backfill-limit="
  );

  if (flagError !== null) {
    return { kind: "error", message: flagError };
  }

  try {
    const options = parseOhlcvArgs(argv, env);

    const cadenceError = validateCadence(options);
    if (cadenceError && !argv.includes("--plan")) {
      return { kind: "error", message: cadenceError };
    }

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
    "  --top=N           топ-активов 1..500; основной universe — Top-100,",
    "                       большие РЕАЛЬНЫЕ прогоны защищает large-run guard",
    "                    по умолчанию 10; массовый прогон всего universe НЕ запускается сам",
    "  --symbol=SYM      точный символ актива (например BTC) — альтернатива --top для BTC-only pilot;",
    "                    сочетается с market filters enabled/STATUS=ACTIVE/quote=USDT/SPOT;",
    "                    без --symbol сохраняется старое --top поведение; одновременно --symbol и --top запрещены (fail closed)",
    "  --timeframes=...  список таймфреймов: 5m,15m,1h,4h,1d, по умолчанию 1h",
    "  --limit=N         свечей истории за один запрос, 50..1000, по умолчанию 300 (legacy, для safe режима используйте --incremental-limit и --backfill-limit)",
    "  --delay=N         пауза между запросами в мс, 0..60000, по умолчанию 250 (для safe режима рекомендуется 1000)",
    "  --interval=N      интервал continuous цикла в мс, 1000..86400000, по умолчанию 60м (3600000);",
    "                    CLI имеет приоритет над env OHLCV_INTERVAL_MS; для 5m continuous интервал должен быть ≤5m (300000)",
    "                    иначе fail closed; --once exempt; для BTC pilot рекомендуется --interval=120000 (2m) или 60000 (1m)",
    "  --once            один проход (без него цикл: проход каждые interval мс, по умолчанию раз в час)",
    "  --concurrency=N   1..10, по умолчанию 1 (safe режим требует 1)",
    "  --batch-size=N    assets за один batch 1..20, по умолчанию 2 (safe режим)",
    "  --pause=N         пауза между batches в мс 0..120000, по умолчанию 10000 (10s)",
    "  --incremental-limit=N  лимит для incremental sync 5..100, по умолчанию 20",
    "  --backfill-limit=N     лимит для backfill 20..500, по умолчанию 100",
    "  --mode=MODE       safe|incremental|backfill, по умолчанию safe",
    "                    safe: сначала incremental для существующих, затем медленный backfill для отсутствующих",
    "                    incremental: только рынки с уже достаточной историей (>=200 свечей), small tail",
    "                    backfill: только отсутствующие/неполные рынки, gradual",
    "  --min-free-mem=N  минимальная свободная память MB для backpressure 50..1000, по умолчанию 200",
    "  --max-load=N      максимальная loadavg для backpressure 0.5..10, по умолчанию 2.0",
    "  --help, -h        эта справка (без обращения к БД и биржам)",
    "",
    "Примеры безопасного запуска:",
    "  npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=1h --once",
    "  npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d --once",
    "  npx tsx scripts/ohlcv-worker.ts --top=5 --timeframes=1h --limit=300 --delay=250 --once",
    "  npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000",
    "  npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --once",
    "  # SAFE incremental (production safe):",
    "  npx tsx scripts/ohlcv-worker.ts --top=100 --timeframes=5m,15m,1h,4h,1d --batch-size=2 --delay=1000 --pause=10000 --incremental-limit=20 --backfill-limit=100 --concurrency=1 --interval=600000 --mode=safe --confirm-large-run",
    "  # SAFE backfill slow (manual):",
    "  npx tsx scripts/ohlcv-worker.ts --top=100 --timeframes=5m,15m,1h,4h,1d --batch-size=2 --delay=2000 --pause=15000 --backfill-limit=100 --concurrency=1 --mode=backfill --once --confirm-large-run",
    "",
    "Безопасность: воркер идёт строго последовательно, с retry/backoff;",
    "пишет только upsert по ключу рынок+таймфрейм+openTime — дубли невозможны,",
    "существующие свечи не удаляются, никакого reset. Остановка: Ctrl+C",
    "Safe режим: batches 2-5 assets, concurrency=1, delay 1000ms, pause 10s, incremental 20, backfill 100, backpressure по памяти/load, progress через DB coverage (oldest lastSyncAt).",
  ].join("\n");
}

export function parseOhlcvArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env
): OhlcvCliOptions {
  const flagError = validateKnownFlags(
    argv,
    KNOWN_OHLCV_FLAGS,
    "--top= --symbol= --timeframes= --limit= --delay= --interval= --once --concurrency= --batch-size= --pause= --mode="
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

  const symbolRaw = get("symbol");
  let symbol: string | undefined = undefined;
  if (symbolRaw !== undefined) {
    const trimmed = symbolRaw.trim().toUpperCase();
    if (trimmed === "") {
      throw new Error(`Опция --symbol: ожидается непустой тикер, получено "${symbolRaw}"`);
    }
    if (!/^[A-Z0-9]{1,20}$/.test(trimmed)) {
      throw new Error(`Опция --symbol: ожидается тикер 1..20 заглавных букв/цифр, получено "${symbolRaw}"`);
    }
    if (get("top") !== undefined) {
      throw new Error(`Опции --symbol и --top несовместимы: используйте либо --symbol=BTC для точного BTC pilot, либо --top для Top-N (получено --symbol=${symbolRaw} и --top=${get("top")})`);
    }
    symbol = trimmed;
  }

  const intervalRaw = get("interval") ?? env.OHLCV_INTERVAL_MS;
  const intervalMs = parseCliNumber(
    intervalRaw,
    60 * 60 * 1000,
    { name: "interval", min: 1000, max: 86400000 }
  );

  const once =
    argv.includes("--once") ||
    env.OHLCV_ONCE === "1";

  const result: OhlcvCliOptions = {
    top: parseCliNumber(
      get("top") ?? env.OHLCV_TOP,
      DEFAULT_OHLCV_OPTIONS.top,
      {
      name: "top",
      min: 1,
      max: LEGACY_TOP500_SIZE
    }
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
    once,
    confirmLargeRun:
      argv.includes("--confirm-large-run"),
    intervalMs,
    concurrency: parseConcurrency(get("concurrency") ?? env.OHLCV_CONCURRENCY, 1),
    batchSize: parseCliNumber(get("batch-size") ?? env.OHLCV_BATCH_SIZE, 2, { name: "batch-size", min: 1, max: 20 }),
    pauseBetweenBatchesMs: parseCliNumber(get("pause") ?? env.OHLCV_PAUSE_MS, 10000, { name: "pause", min: 0, max: 120000 }),
    incrementalLimit: parseCliNumber(get("incremental-limit") ?? env.OHLCV_INCREMENTAL_LIMIT, 20, { name: "incremental-limit", min: 5, max: 100 }),
    backfillLimit: parseCliNumber(get("backfill-limit") ?? env.OHLCV_BACKFILL_LIMIT, 100, { name: "backfill-limit", min: 20, max: 500 }),
    mode: parseSafeMode(get("mode") ?? env.OHLCV_MODE, "safe"),
    minFreeMemMb: parseCliNumber(get("min-free-mem") ?? env.OHLCV_MIN_FREE_MEM, 200, { name: "min-free-mem", min: 50, max: 1000 }),
    maxLoadAvg: parseFloatNumber(get("max-load") ?? env.OHLCV_MAX_LOAD, 2.0, { name: "max-load", min: 0.5, max: 10 }),
  };
  if (symbol) {
    (result as any).symbol = symbol;
  }

  return result;
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
