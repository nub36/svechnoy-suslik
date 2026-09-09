import type { Timeframe } from "../exchanges/types";
import {
  parseCliNumber,
  parseTimeframeList,
  validateKnownFlags,
  wantsHelp
} from "../ohlcv/cli";
import { DEFAULT_SNAPSHOT_OPTIONS } from "./sync";

/**
 * Чистый (без Prisma) разбор аргументов CLI snapshot worker.
 *
 * Поддерживаются обе формы:
 *   --timeframe=1h            (один ТФ — прежнее поведение)
 *   --timeframes=5m,15m,1h    (несколько ТФ за один прогон,
 *                              снапшоты считаются отдельно
 *                              по каждому ТФ из PostgreSQL Candle)
 *
 * Границы: top 1..500, history 200..1000 — как раньше,
 * таймфреймы строго по белому списку 5m/15m/1h/4h/1d.
 * Неизвестные флаги — ошибка, --help/-h — справка.
 * Тесты: scripts/test-snapshot-cli.ts.
 */

export type SnapshotCliOptions = {
  top: number;
  timeframes: Timeframe[];
  historyLimit: number;
};

const KNOWN_SNAPSHOT_FLAGS: ReadonlySet<string> = new Set([
  "top",
  "timeframe",
  "timeframes",
  "history",
  "plan",
  "help",
  "h"
]);

const SNAPSHOT_FLAGS_HINT =
  "--top= --timeframe= --timeframes= --history=";

export type SnapshotInvocation =
  | { kind: "help" }
  | { kind: "error"; message: string }
  | { kind: "plan"; options: SnapshotCliOptions }
  | { kind: "run"; options: SnapshotCliOptions };

/**
 * Полный разбор вызова воркера БЕЗ обращения к БД:
 * help обнаруживается раньше всего; неизвестные флаги
 * и невалидные значения — error (код выхода != 0).
 */
export function resolveSnapshotInvocation(
  argv: string[]
): SnapshotInvocation {
  if (wantsHelp(argv)) {
    return { kind: "help" };
  }

  const flagError = validateKnownFlags(
    argv,
    KNOWN_SNAPSHOT_FLAGS,
    SNAPSHOT_FLAGS_HINT
  );

  if (flagError !== null) {
    return { kind: "error", message: flagError };
  }

  try {
    const options = parseSnapshotArgs(argv);

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

export function buildSnapshotHelp(): string {
  return [
    "🐿️ IndicatorSnapshot Worker — расчёт снапшотов индикаторов",
    "",
    "Использование:",
    "  npx tsx scripts/snapshot-worker.ts [флаги]",
    "",
    "Источник данных — ТОЛЬКО существующие PostgreSQL Candle",
    "(никаких обращений к API бирж). Схема БД не расширяется.",
    "",
    "Флаги (только форма --имя=значение):",
    "  --top=N            топ-активов, 1..500, по умолчанию 10",
    "  --timeframe=X      один таймфрейм: 5m|15m|1h|4h|1d, по умолчанию 1h",
    "  --timeframes=...   несколько таймфреймов за прогон (каждый — отдельно),",
    "                     например --timeframes=5m,15m,1h,4h,1d",
    "  --history=N        глубина истории свечей, 200..1000, по умолчанию 300",
    "  --help, -h         эта справка (без обращения к БД)",
    "",
    "Примеры безопасного запуска:",
    "  npx tsx scripts/snapshot-worker.ts --top=10 --timeframe=1h",
    "  npx tsx scripts/snapshot-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d",
    "  npx tsx scripts/snapshot-worker.ts --top=10 --timeframes=1h --history=500",
    "",
    "Пишет только upsert по ключу рынок+таймфрейм+candleTime,",
    "существующие снапшоты не удаляются. Остановка: Ctrl+C"
  ].join("\n");
}

export function parseSnapshotArgs(
  argv: string[]
): SnapshotCliOptions {
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = argv.find((value) =>
      value.startsWith(prefix)
    );

    return hit?.slice(prefix.length);
  };

  const top = parseCliNumber(
    get("top"),
    DEFAULT_SNAPSHOT_OPTIONS.top,
    { name: "top", min: 1, max: 500 }
  );

  const historyLimit = parseCliNumber(
    get("history"),
    DEFAULT_SNAPSHOT_OPTIONS.historyLimit,
    { name: "history", min: 200, max: 1000 }
  );

  const listRaw = get("timeframes");

  const timeframes = listRaw !== undefined
    ? parseTimeframeList(listRaw, [
        DEFAULT_SNAPSHOT_OPTIONS.timeframe
      ])
    : [
        (() => {
          const single = get("timeframe") ??
            DEFAULT_SNAPSHOT_OPTIONS.timeframe;

          return parseTimeframeList(single, [
            DEFAULT_SNAPSHOT_OPTIONS.timeframe
          ])[0];
        })()
      ];

  return { top, timeframes, historyLimit };
}
