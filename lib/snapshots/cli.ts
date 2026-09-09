import type { Timeframe } from "../exchanges/types";
import {
  parseCliNumber,
  parseTimeframeList
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
 * Тесты: scripts/test-snapshot-cli.ts.
 */

export type SnapshotCliOptions = {
  top: number;
  timeframes: Timeframe[];
  historyLimit: number;
};

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
