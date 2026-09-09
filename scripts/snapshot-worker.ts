import { PrismaClient } from "@prisma/client";
import type { Timeframe } from "../lib/exchanges/types";
import {
  DEFAULT_SNAPSHOT_OPTIONS,
  runSnapshotSync
} from "../lib/snapshots/sync";

const prisma =
  new PrismaClient();

const allowedTimeframes =
  new Set<Timeframe>([
    "5m",
    "15m",
    "1h",
    "4h",
    "1d"
  ]);

function getArgument(
  name: string
): string | undefined {
  const prefix =
    `--${name}=`;

  return process.argv
    .slice(2)
    .find((value) =>
      value.startsWith(prefix)
    )
    ?.slice(prefix.length);
}

async function main() {
  const top =
    Number(
      getArgument("top") ??
      DEFAULT_SNAPSHOT_OPTIONS.top
    );

  const rawTimeframe =
    getArgument("timeframe") ??
    DEFAULT_SNAPSHOT_OPTIONS.timeframe;

  if (
    !allowedTimeframes.has(
      rawTimeframe as Timeframe
    )
  ) {
    throw new Error(
      `Недопустимый timeframe: ${rawTimeframe}`
    );
  }

  const timeframe =
    rawTimeframe as Timeframe;

  const historyLimit =
    Number(
      getArgument("history") ??
      DEFAULT_SNAPSHOT_OPTIONS.historyLimit
    );

  if (
    !Number.isInteger(top) ||
    top < 1 ||
    top > 500
  ) {
    throw new Error(
      "top должен быть от 1 до 500"
    );
  }

  if (
    !Number.isInteger(historyLimit) ||
    historyLimit < 200 ||
    historyLimit > 1000
  ) {
    throw new Error(
      "history должен быть от 200 до 1000"
    );
  }

  console.log("");
  console.log(
    "🐿️ IndicatorSnapshot Worker"
  );

  console.log(
    `top=${top} timeframe=${timeframe} history=${historyLimit}`
  );

  const started =
    Date.now();

  const stats =
    await runSnapshotSync(
      prisma,
      {
        top,
        timeframe,
        historyLimit
      }
    );

  console.log("");
  console.log(
    "---------- итог ----------"
  );

  console.log(
    `активов: ${stats.assets}`
  );

  console.log(
    `рынков: ${stats.markets}`
  );

  console.log(
    `создано: ${stats.created}`
  );

  console.log(
    `обновлено: ${stats.updated}`
  );

  console.log(
    `пропущено: ${stats.skipped}`
  );

  console.log(
    `ошибок: ${stats.errors}`
  );

  console.log("");

  for (
    const [exchange, row]
    of Object.entries(
      stats.byExchange
    )
  ) {
    console.log(
      `${exchange.padEnd(8)} ` +
      `рынков=${row.markets} ` +
      `создано=${row.created} ` +
      `обновлено=${row.updated} ` +
      `пропущено=${row.skipped} ` +
      `ошибок=${row.errors}`
    );
  }

  console.log("");
  console.log(
    `время: ${Date.now() - started}ms`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
