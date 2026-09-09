import { PrismaClient } from "@prisma/client";
import type { Timeframe } from "../lib/exchanges/types";
import {
  DEFAULT_OHLCV_OPTIONS,
  runOhlcvSync,
  type OhlcvWorkerOptions
} from "../lib/ohlcv/sync";
import { sleep } from "../lib/ohlcv/retry";

const prisma = new PrismaClient();

function parseArgs(): OhlcvWorkerOptions & { once: boolean; intervalMs: number } {
  const args = process.argv.slice(2);
  const get = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const hit = args.find((arg) => arg.startsWith(prefix));
    return hit?.slice(prefix.length);
  };

  const timeframes = (get("timeframes") ?? "1h")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as Timeframe[];

  return {
    top: Number(get("top") ?? process.env.OHLCV_TOP ?? DEFAULT_OHLCV_OPTIONS.top),
    timeframes: timeframes.length ? timeframes : DEFAULT_OHLCV_OPTIONS.timeframes,
    limit: Number(
      get("limit") ?? process.env.OHLCV_LIMIT ?? DEFAULT_OHLCV_OPTIONS.limit
    ),
    requestDelayMs: Number(
      get("delay") ??
        process.env.OHLCV_DELAY_MS ??
        DEFAULT_OHLCV_OPTIONS.requestDelayMs
    ),
    once: args.includes("--once") || process.env.OHLCV_ONCE === "1",
    intervalMs: Number(process.env.OHLCV_INTERVAL_MS ?? 60 * 60 * 1000)
  };
}

async function printVerification(top: number, timeframe: string) {
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

  console.log("\n================ проверка ================");
  console.log(`Candle всего: ${total}`);
  console.log(`Candle закрытых: ${closed}`);
  console.log(`Дубликаты (market+tf+openTime): ${duplicates[0]?.dupes ?? 0}`);
  console.log(`Top запрошен: ${top}, timeframe: ${timeframe}`);
  console.log("");

  for (const row of byExchange) {
    console.log(
      `${row.exchange.padEnd(8)} рынков=${row.markets} ` +
        `свечей=${row.candles} ` +
        `${row.min_open.toISOString()} → ${row.max_open.toISOString()}`
    );
  }

  console.log("==========================================\n");
}

async function main() {
  const options = parseArgs();

  console.log("🐿️ OHLCV Worker");
  console.log(
    `top=${options.top} timeframes=${options.timeframes.join(",")} ` +
      `limit=${options.limit} once=${options.once}`
  );

  do {
    const started = Date.now();
    const stats = await runOhlcvSync(prisma, options);

    console.log("\n--- итог прохода ---");
    console.log(`активов: ${stats.assets}`);
    console.log(`пар рынок×tf: ${stats.markets}`);
    console.log(`получено свечей: ${stats.fetched}`);
    console.log(`записано/обновлено: ${stats.written}`);
    console.log(`отброшено невалидных: ${stats.skippedInvalid}`);
    console.log(`ошибок: ${stats.errors}`);

    for (const [exchange, row] of Object.entries(stats.byExchange)) {
      console.log(
        `  ${exchange.padEnd(8)} рынков=${row.markets} ` +
          `записано=${row.written} ошибок=${row.errors}`
      );
    }

    await printVerification(options.top, options.timeframes[0] ?? "1h");

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
