import { PrismaClient } from "@prisma/client";
import { runSnapshotSync } from "../lib/snapshots/sync";
import { parseSnapshotArgs } from "../lib/snapshots/cli";

const prisma =
  new PrismaClient();

/**
 * IndicatorSnapshot Worker — считает снапшоты ТОЛЬКО из
 * существующих PostgreSQL Candle (никаких обращений к API
 * бирж), upsert по ключу market+tf+candleTime.
 *
 * Примеры запуска:
 *
 *   npx tsx scripts/snapshot-worker.ts --top=10 --timeframe=1h
 *   npx tsx scripts/snapshot-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d
 *   npx tsx scripts/snapshot-worker.ts --top=10 --timeframes=1h --history=500
 *
 * --timeframes — несколько таймфреймов за один прогон,
 * по каждому ТФ снапшоты рассчитываются ОТДЕЛЬНО.
 * Таймфреймы валидируются по белому списку
 * 5m/15m/1h/4h/1d (см. lib/ohlcv/cli.ts), top 1..500,
 * history 200..1000. Схема БД не расширяется.
 */

async function main() {
  const options =
    parseSnapshotArgs(
      process.argv.slice(2)
    );

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
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
