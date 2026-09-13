import { PrismaClient } from "@prisma/client";
import { exchanges } from "../exchanges";
import type { CandleData, ExchangeName, Timeframe } from "../exchanges/types";
import { sleep, withRetry } from "./retry";
import { upsertCandles } from "./sync";

export type GenericOhlcvOptions = {
  top?: number;
  timeframes: Timeframe[];
  limit: number;
  requestDelayMs: number;
  concurrency: number; // bounded concurrency
  symbol?: string;
};

export type GenericSyncStats = {
  assets: number;
  markets: number;
  tasks: number;
  fetched: number;
  written: number;
  created: number;
  updated: number;
  skippedInvalid: number;
  errors: number;
  failedMarkets: { exchange: string; symbol: string; timeframe: string; error: string }[];
  byExchange: Record<string, { markets: number; written: number; errors: number }>;
  byTimeframe: Record<string, { markets: number; fetched: number; written: number; errors: number }>;
};

function isValidCandle(c: CandleData): boolean {
  return (
    c.openTime instanceof Date &&
    !isNaN(c.openTime.getTime()) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close) &&
    Number.isFinite(c.volume) &&
    c.high >= c.low &&
    c.volume >= 0
  );
}

/**
 * Scalable ingestion for ALL ACTIVE coins
 * - Universe from PostgreSQL: ACTIVE assets + ACTIVE SPOT USDT markets
 * - Bounded concurrency
 * - Rate limiting per exchange
 * - Retry/backoff
 * - Incremental updates (filter >= last openTime)
 * - No overlapping via global advisory lock (handled in worker)
 * - Logging failed markets
 */

export async function runGenericOhlcvSync(
  prisma: PrismaClient,
  options: GenericOhlcvOptions
): Promise<GenericSyncStats> {
  const adapterByName = new Map(exchanges.map((e) => [e.name, e]));

  let assets: Array<{
    id: number;
    rank: number | null;
    symbol: string;
    markets: Array<{ id: number; exchange: string; exchangeSymbol: string }>;
  }>;

  if (options.symbol) {
    const single = await prisma.asset.findFirst({
      where: { symbol: options.symbol, enabled: true },
      include: {
        markets: {
          where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
        },
      },
    });
    assets = single ? [single as any] : [];
  } else {
    const top = options.top ?? 100;
    assets = await prisma.asset.findMany({
      where: { enabled: true, rank: { lte: top, not: null } },
      orderBy: { rank: "asc" },
      take: top,
      include: {
        markets: {
          where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
        },
      },
    });
  }

  // Build tasks
  type Task = {
    asset: { id: number; symbol: string; rank: number | null };
    market: { id: number; exchange: string; exchangeSymbol: string };
    timeframe: Timeframe;
  };

  const tasks: Task[] = [];
  for (const asset of assets) {
    for (const market of asset.markets) {
      for (const tf of options.timeframes) {
        // Preserve existing exclusions: BINGX 1d excluded (from project rules)
        if (market.exchange === "BINGX" && tf === "1d") continue;
        tasks.push({ asset: { id: asset.id, symbol: asset.symbol, rank: asset.rank }, market, timeframe: tf });
      }
    }
  }

  const stats: GenericSyncStats = {
    assets: assets.length,
    markets: tasks.length,
    tasks: tasks.length,
    fetched: 0,
    written: 0,
    created: 0,
    updated: 0,
    skippedInvalid: 0,
    errors: 0,
    failedMarkets: [],
    byExchange: {},
    byTimeframe: {},
  };

  for (const ex of adapterByName.keys()) {
    stats.byExchange[ex] = { markets: 0, written: 0, errors: 0 };
  }
  for (const tf of options.timeframes) {
    stats.byTimeframe[tf] = { markets: 0, fetched: 0, written: 0, errors: 0 };
  }

  // Rate limiting per exchange: last request time
  const lastRequestPerExchange = new Map<string, number>();
  const minDelayPerExchange = options.requestDelayMs; // e.g., 250ms per exchange

  async function processTask(task: Task) {
    const adapter = adapterByName.get(task.market.exchange as ExchangeName);
    if (!adapter) {
      stats.errors++;
      stats.failedMarkets.push({
        exchange: task.market.exchange,
        symbol: task.market.exchangeSymbol,
        timeframe: task.timeframe,
        error: `No adapter for ${task.market.exchange}`,
      });
      return;
    }

    // Rate limiting per exchange
    const now = Date.now();
    const last = lastRequestPerExchange.get(task.market.exchange) ?? 0;
    const elapsed = now - last;
    if (elapsed < minDelayPerExchange) {
      await sleep(minDelayPerExchange - elapsed);
    }
    lastRequestPerExchange.set(task.market.exchange, Date.now());

    try {
      const lastCandle = await prisma.candle.findFirst({
        where: { marketId: task.market.id, timeframe: task.timeframe },
        orderBy: { openTime: "desc" },
        select: { openTime: true },
      });

      const candles = await withRetry(
        `${task.market.exchange} ${task.market.exchangeSymbol} ${task.timeframe}`,
        () => adapter.getCandles(task.market.exchangeSymbol, task.timeframe, options.limit)
      );

      const incoming = lastCandle
        ? candles.filter((c) => c.openTime.getTime() >= lastCandle.openTime.getTime())
        : candles;

      if (incoming.length === 0) {
        // No new data, still update lastSyncAt
        await prisma.market.update({ where: { id: task.market.id }, data: { lastSyncAt: new Date() } });
        return;
      }

      // Filter valid
      const valid = incoming.filter(isValidCandle);
      const skipped = incoming.length - valid.length;

      const countBefore = await prisma.candle.count({
        where: { marketId: task.market.id, timeframe: task.timeframe },
      });

      const result = await upsertCandles(prisma, task.market.id, task.timeframe, valid);

      const countAfter = await prisma.candle.count({
        where: { marketId: task.market.id, timeframe: task.timeframe },
      });

      const created = Math.max(0, Math.min(countAfter - countBefore, result.written));
      const updated = result.written - created;

      stats.fetched += incoming.length;
      stats.written += result.written;
      stats.created += created;
      stats.updated += updated;
      stats.skippedInvalid += skipped;

      stats.byExchange[task.market.exchange].markets++;
      stats.byExchange[task.market.exchange].written += result.written;
      stats.byTimeframe[task.timeframe].markets++;
      stats.byTimeframe[task.timeframe].fetched += incoming.length;
      stats.byTimeframe[task.timeframe].written += result.written;

      await prisma.market.update({ where: { id: task.market.id }, data: { lastSyncAt: new Date() } });

      console.log(
        `  OK ${task.asset.symbol} ${task.market.exchange} ${task.market.exchangeSymbol} ${task.timeframe} fetched=${incoming.length} written=${result.written} created=${created} updated=${updated}`
      );
    } catch (e: any) {
      const msg = e instanceof Error ? e.message : String(e);
      stats.errors++;
      stats.byExchange[task.market.exchange].errors++;
      stats.byTimeframe[task.timeframe].errors++;
      stats.failedMarkets.push({
        exchange: task.market.exchange,
        symbol: task.market.exchangeSymbol,
        timeframe: task.timeframe,
        error: msg,
      });
      console.error(`  FAIL ${task.asset.symbol} ${task.market.exchange} ${task.market.exchangeSymbol} ${task.timeframe}: ${msg}`);
    }
  }

  // Bounded concurrency pool
  const concurrency = Math.max(1, Math.min(options.concurrency, 10)); // cap at 10 to avoid overload
  console.log(`\nStarting generic sync: ${tasks.length} tasks, concurrency=${concurrency}, delay=${options.requestDelayMs}ms per exchange, limit=${options.limit}\n`);

  let index = 0;
  const workers: Promise<void>[] = [];

  async function worker() {
    while (index < tasks.length) {
      const taskIndex = index++;
      const task = tasks[taskIndex];
      await processTask(task);
    }
  }

  for (let i = 0; i < concurrency; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);

  console.log("\n=== GENERIC SYNC DONE ===");
  console.log(`Assets: ${stats.assets}, Tasks: ${stats.tasks}, Fetched: ${stats.fetched}, Written: ${stats.written}, Created: ${stats.created}, Updated: ${stats.updated}, Errors: ${stats.errors}`);
  if (stats.failedMarkets.length > 0) {
    console.log(`Failed markets (${stats.failedMarkets.length}):`);
    for (const f of stats.failedMarkets.slice(0, 20)) {
      console.log(`  ${f.exchange} ${f.symbol} ${f.timeframe}: ${f.error}`);
    }
  }

  return stats;
}
