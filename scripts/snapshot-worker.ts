import { runSnapshotSync } from "../lib/snapshots/sync";
import {
  buildSnapshotHelp,
  resolveSnapshotInvocation
} from "../lib/snapshots/cli";
import {
  collectSnapshotPlan,
  formatSnapshotPlanReport
} from "../lib/snapshots/plan";

/**
 * IndicatorSnapshot Worker — считает снапшоты ТОЛЬКО из
 * существующих PostgreSQL Candle (никаких обращений к API
 * бирж), upsert по ключу market+tf+candleTime.
 *
 * Безопасные режимы вызова:
 *
 *   npx tsx scripts/snapshot-worker.ts --help
 *     справка; БД не затрагивается (runSnapshotSync
 *     импортируется только в run-режиме), код выхода 0;
 *   npx tsx scripts/snapshot-worker.ts --top=10 --timeframe=1h
 *   npx tsx scripts/snapshot-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d
 *   npx tsx scripts/snapshot-worker.ts --top=10 --timeframes=1h --history=500
 *
 * Неизвестные/опечатанные флаги (--foobar, --hist=5)
 * дают понятную ошибку и код выхода 1 — воркер с defaults
 * молча НЕ запускается. Остановка: Ctrl+C.
 */

let interrupted = false;

function onSignal(signal: string) {
  if (interrupted) {
    process.exit(130);
  }

  interrupted = true;
  console.error(
    `\n… получен сигнал ${signal}: завершаем работу корректно ` +
      "(повторный Ctrl+C — остановиться немедленно)"
  );
}

process.on("SIGINT", () => onSignal("SIGINT"));
process.on("SIGTERM", () => onSignal("SIGTERM"));

async function main() {
  // 1. Разбор вызова — до тяжёлой работы.
  const invocation = resolveSnapshotInvocation(
    process.argv.slice(2)
  );

  if (invocation.kind === "help") {
    console.log(buildSnapshotHelp());

    return;
  }

  if (invocation.kind === "error") {
    console.error(
      `Ошибка аргументов: ${invocation.message}`
    );

    process.exitCode = 1;

    return;
  }

  // 2. run/plan-режимы: Prisma подключается только здесь.
  const { PrismaClient } = await import(
    "@prisma/client"
  );

  const prisma = new PrismaClient();

  try {
    const options = invocation.options;

    if (invocation.kind === "plan") {
      const stats = await collectSnapshotPlan(
        prisma,
        options
      );

      console.log("");

      for (const line of formatSnapshotPlanReport(
        options,
        stats
      )) {
        console.log(line);
      }

      return;
    }

    console.log("");
    console.log(
      "🐿️ IndicatorSnapshot Worker"
    );

    console.log(
      `top=${options.top} timeframes=${options.timeframes.join(",")} history=${options.historyLimit}`
    );

    const started =
      Date.now();

    const totals = {
      assets: 0,
      markets: 0,
      created: 0,
      updated: 0,
      skipped: 0,
      errors: 0
    };

    for (const timeframe of options.timeframes) {
      if (interrupted) {
        break;
      }

      const stats =
        await runSnapshotSync(
          prisma,
          {
            top: options.top,
            timeframe,
            historyLimit: options.historyLimit
          }
        );

      console.log("");
      console.log(
        `---------- итог ${timeframe} ----------`
      );

      console.log(`активов: ${stats.assets}`);
      console.log(`рынков: ${stats.markets}`);
      console.log(`создано: ${stats.created}`);
      console.log(`обновлено: ${stats.updated}`);
      console.log(`пропущено: ${stats.skipped}`);
      console.log(`ошибок: ${stats.errors}`);

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

      totals.assets += stats.assets;
      totals.markets += stats.markets;
      totals.created += stats.created;
      totals.updated += stats.updated;
      totals.skipped += stats.skipped;
      totals.errors += stats.errors;
    }

    console.log("");
    console.log("---------- всего ----------");
    console.log(`таймфреймов: ${options.timeframes.length}`);
    console.log(`снапшотов создано: ${totals.created}`);
    console.log(`снапшотов обновлено: ${totals.updated}`);
    console.log(`пропущено: ${totals.skipped}`);
    console.log(`ошибок: ${totals.errors}`);
    console.log("");
    console.log(
      `время: ${Date.now() - started}ms`
    );

    if (interrupted) {
      console.log("Остановлено пользователем.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
