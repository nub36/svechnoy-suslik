import { PrismaClient } from "@prisma/client";
import { runOhlcvSync } from "../lib/ohlcv/sync";
import { sleep } from "../lib/ohlcv/retry";
import {
  formatTimeframeSummary,
  parseOhlcvArgs
} from "../lib/ohlcv/cli";

const prisma = new PrismaClient();

/**
 * OHLCV Worker — управляемый вручную запуск с бирж.
 *
 * Примеры контролируемого запуска (см. §29 PROJECT_CONTEXT):
 *
 *   npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=1h --once
 *   npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d --once
 *   npx tsx scripts/ohlcv-worker.ts --top=5 --timeframes=1h --limit=300 --delay=250
 *
 * Опции: --top (1..500, по умолчанию 10), --timeframes
 * (5m,15m,1h,4h,1d — белый список, по умолчанию 1h),
 * --limit (50..1000 свечей истории за запрос), --delay (мс
 * между запросами), --once (один проход), env OHLCV_*.
 *
 * Безопасность: воркер идёт строго последовательно
 * (concurrency=1 + delay), с retry/backoff (lib/ohlcv/retry),
 * пишет только upsert по уникальному ключу market+tf+openTime —
 * дубли невозможны, существующие свечи не удаляются,
 * никакой reset. Top-500 сам по себе НЕ запускается.
 */

async function printVerification(
  top: number,
  timeframes: string[]
) {
  const total = await prisma.candle.count();
  const closed = await prisma.candle.count({ where: { closed: true } });

  const duplicates = await prisma.$queryRaw<
    { dupes: bigint }[]
  >`SELECT COUNT(*)::bigint AS dupes FROM (
      SELECT "marketId", timeframe, "openTime"
      FROM "Candle"
      GROUP BY 1, 2, 3
      HAVING COUNT(*) > 1
    ) t`;

  console.log("\n================ проверка ================");
  console.log(`Candle всего: ${total}`);
  console.log(`Candle закрытых: ${closed}`);
  console.log(`Дубликаты (market+tf+openTime): ${duplicates[0]?.dupes ?? 0}`);
  console.log(`Top запрошен: ${top}`);
  console.log("");

  for (const timeframe of timeframes) {
    const byExchange = await prisma.$queryRaw<
      {
        exchange: string;
        markets: bigint;
        candles: bigint;
        min_open: Date;
        max_open: Date;
      }[]
    >`
      SELECT
        m.exchange,
        COUNT(DISTINCT c."marketId")::bigint AS markets,
        COUNT(*)::bigint AS candles,
        MIN(c."openTime") AS min_open,
        MAX(c."openTime") AS max_open
      FROM "Candle" c
      JOIN "Market" m ON m.id = c."marketId"
      WHERE c.timeframe = ${timeframe}
      GROUP BY m.exchange
      ORDER BY m.exchange
    `;

    console.log(`--- timeframe ${timeframe} ---`);

    if (byExchange.length === 0) {
      console.log("  свечей пока нет");
    }

    for (const row of byExchange) {
      console.log(
        `  ${row.exchange.padEnd(8)} рынков=${row.markets} ` +
          `свечей=${row.candles} ` +
          `${row.min_open.toISOString()} → ${row.max_open.toISOString()}`
      );
    }
  }

  console.log("==========================================\n");
}

async function main() {
  const options = parseOhlcvArgs(process.argv.slice(2));

  console.log("🐿️ OHLCV Worker");
  console.log(
    `top=${options.top} timeframes=${options.timeframes.join(",")} ` +
      `limit=${options.limit} delay=${options.requestDelayMs}ms once=${options.once}`
  );

  do {
    const started = Date.now();
    const stats = await runOhlcvSync(prisma, options);

    console.log("\n--- итог прохода ---");
    console.log(`активов: ${stats.assets}`);
    console.log(`пар рынок×tf: ${stats.markets}`);
    console.log(`получено свечей: ${stats.fetched}`);
    console.log(`записано/обновлено: ${stats.written}`);
    console.log(`создано новых: ${stats.created}`);
    console.log(`обновлено существующих: ${stats.updated}`);
    console.log(`отброшено невалидных: ${stats.skippedInvalid}`);
    console.log(`ошибок: ${stats.errors}`);

    console.log("\n--- по таймфреймам ---");
    for (const line of formatTimeframeSummary(stats.byTimeframe)) {
      console.log(line);
    }

    for (const [exchange, row] of Object.entries(stats.byExchange)) {
      console.log(
        `  ${exchange.padEnd(8)} рынков=${row.markets} ` +
          `записано=${row.written} ошибок=${row.errors}`
      );
    }

    await printVerification(options.top, options.timeframes);

    console.log(`проход ${Date.now() - started}ms`);

    if (!options.once) {
      console.log(`следующий проход через ${options.intervalMs}ms`);
      await sleep(options.intervalMs);
    }
  } while (!options.once);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
