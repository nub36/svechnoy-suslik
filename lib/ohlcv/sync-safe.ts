import os from "os";
import { PrismaClient } from "@prisma/client";
import { exchanges } from "../exchanges";
import type { CandleData, ExchangeName, Timeframe } from "../exchanges/types";
import { sleep, withRetry } from "./retry";
import { upsertCandles } from "./sync";
import type { OhlcvCliOptions } from "./cli";

/**
 * SAFE low-priority incremental background worker
 * - batches 2-5 assets per batch
 * - concurrency default 1
 * - delay between tasks 1000ms
 * - pause between batches 10000ms
 * - incremental vs backfill separated
 * - progress via DB coverage (oldest lastSyncAt / least candles)
 * - backpressure via freemem / loadavg
 * - small upsert batches (chunk 20-50)
 * - advisory lock preserved (handled in worker.ts)
 * - CPU target 20-30% via delay/pause, not aggressive parallelism
 */

export type SafeSyncStats = {
  assets: number;
  markets: number;
  tasks: number;
  fetched: number;
  written: number;
  created: number;
  updated: number;
  skippedInvalid: number;
  errors: number;
  batches: number;
  pausedDueToBackpressure: number;
  byExchange: Record<string, { markets: number; written: number; errors: number }>;
  byTimeframe: Record<string, { markets: number; fetched: number; written: number; errors: number }>;
  failedMarkets: { exchange: string; symbol: string; timeframe: string; error: string }[];
};

type Task = {
  asset: { id: number; symbol: string; rank: number | null };
  market: { id: number; exchange: string; exchangeSymbol: string; lastSyncAt: Date | null };
  timeframe: Timeframe;
  coverage: { count: number; maxOpenTime: Date | null };
  priority: number;
  isIncremental: boolean;
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

function checkBackpressure(minFreeMemMb: number, maxLoadAvg: number): { ok: boolean; reason?: string; freememMb: number; loadAvg: number } {
  const freememMb = Math.floor(os.freemem() / 1024 / 1024);
  const loadAvg = os.loadavg()[0];
  if (freememMb < minFreeMemMb) {
    return { ok: false, reason: `low memory freemem ${freememMb}MB < ${minFreeMemMb}MB`, freememMb, loadAvg };
  }
  if (loadAvg > maxLoadAvg) {
    return { ok: false, reason: `high load ${loadAvg.toFixed(2)} > ${maxLoadAvg}`, freememMb, loadAvg };
  }
  return { ok: true, freememMb, loadAvg };
}

async function getCoverageMap(
  prisma: PrismaClient,
  marketIds: number[]
): Promise<Map<string, { count: number; maxOpenTime: Date | null }>> {
  if (marketIds.length === 0) return new Map();

  // Group by marketId + timeframe — use unsafe with placeholders for IN clause
  // Prisma $queryRaw with array IN is tricky, so use $queryRawUnsafe
  try {
    const placeholders = marketIds.map((_, i) => `$${i + 1}`).join(",");
    const rows = await prisma.$queryRawUnsafe(
      `SELECT "marketId", timeframe, COUNT(*)::bigint as count, MAX("openTime") as "maxOpenTime" FROM "Candle" WHERE "marketId" IN (${placeholders}) GROUP BY "marketId", timeframe`,
      ...marketIds
    ) as { marketId: number; timeframe: string; count: bigint; maxOpenTime: Date | null }[];

    const map = new Map<string, { count: number; maxOpenTime: Date | null }>();
    for (const r of rows as any[]) {
      const key = `${r.marketId}:${r.timeframe}`;
      map.set(key, { count: Number(r.count), maxOpenTime: r.maxOpenTime ? new Date(r.maxOpenTime) : null });
    }
    return map;
  } catch (e) {
    console.log(`[safe] Coverage query failed, assuming empty: ${e instanceof Error ? e.message : String(e)}`);
    return new Map();
  }
}

export async function runSafeOhlcvSync(
  prisma: PrismaClient,
  options: OhlcvCliOptions
): Promise<SafeSyncStats> {
  const adapterByName = new Map(exchanges.map((e) => [e.name, e]));

  // Try to lower process priority (nice)
  try {
    // Node os.setPriority: 0 = current process, 10 = low priority (19 lowest)
    if (typeof os.setPriority === "function") {
      os.setPriority(0, 10);
      console.log(`[safe] Process priority set to low (nice 10) via os.setPriority`);
    }
  } catch (e) {
    console.log(`[safe] Could not set low priority: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Load assets
  let assets: Array<{
    id: number;
    rank: number | null;
    symbol: string;
    markets: Array<{ id: number; exchange: string; exchangeSymbol: string; lastSyncAt: Date | null }>;
  }>;

  if (options.symbol) {
    const single = await prisma.asset.findFirst({
      where: { symbol: options.symbol, enabled: true },
      include: {
        markets: {
          where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
          select: { id: true, exchange: true, exchangeSymbol: true, lastSyncAt: true },
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
          select: { id: true, exchange: true, exchangeSymbol: true, lastSyncAt: true },
        },
      },
    });
  }

  const allMarketIds = assets.flatMap((a) => a.markets.map((m) => m.id));
  console.log(`[safe] Loading coverage for ${allMarketIds.length} markets...`);
  const coverageMap = await getCoverageMap(prisma, allMarketIds);
  console.log(`[safe] Coverage map loaded: ${coverageMap.size} market+tf combos have candles`);

  // Build tasks
  const tasks: Task[] = [];
  const MIN_CANDLES_FOR_INCREMENTAL = 200; // if >=200, consider incremental

  for (const asset of assets) {
    for (const market of asset.markets) {
      for (const tf of options.timeframes) {
        if (market.exchange === "BINGX" && tf === "1d") continue;
        const key = `${market.id}:${tf}`;
        const cov = coverageMap.get(key) || { count: 0, maxOpenTime: null };
        const isIncremental = cov.count >= MIN_CANDLES_FOR_INCREMENTAL;
        // Priority: incremental tasks first sorted by oldest lastSyncAt, then backfill sorted by rank asc + count asc
        let priority = 0;
        if (options.mode === "incremental" && !isIncremental) continue;
        if (options.mode === "backfill" && isIncremental) continue;

        if (isIncremental) {
          // Older lastSyncAt = higher priority (lower number)
          const lastSync = market.lastSyncAt ? market.lastSyncAt.getTime() : 0;
          priority = lastSync; // smaller = older = higher priority, will sort asc
        } else {
          // Backfill: lower count + lower rank = higher priority
          // Use rank*10000 + count to prioritize top assets with least coverage
          const rank = asset.rank ?? 9999;
          priority = 1_000_000_000 + rank * 10000 + cov.count; // ensure backfill after incremental in safe mode
        }

        tasks.push({
          asset: { id: asset.id, symbol: asset.symbol, rank: asset.rank },
          market,
          timeframe: tf as Timeframe,
          coverage: cov,
          priority,
          isIncremental,
        });
      }
    }
  }

  // Sort by priority
  tasks.sort((a, b) => a.priority - b.priority);

  // In safe mode: incremental first, then backfill
  if (options.mode === "safe") {
    const incremental = tasks.filter((t) => t.isIncremental);
    const backfill = tasks.filter((t) => !t.isIncremental);
    // Already sorted, but ensure incremental first
    tasks.length = 0;
    tasks.push(...incremental, ...backfill);
  }

  const stats: SafeSyncStats = {
    assets: assets.length,
    markets: allMarketIds.length,
    tasks: tasks.length,
    fetched: 0,
    written: 0,
    created: 0,
    updated: 0,
    skippedInvalid: 0,
    errors: 0,
    batches: 0,
    pausedDueToBackpressure: 0,
    byExchange: {},
    byTimeframe: {},
    failedMarkets: [],
  };

  for (const ex of adapterByName.keys()) {
    stats.byExchange[ex] = { markets: 0, written: 0, errors: 0 };
  }
  for (const tf of options.timeframes) {
    stats.byTimeframe[tf] = { markets: 0, fetched: 0, written: 0, errors: 0 };
  }

  // Group tasks by asset for batching
  const tasksByAsset = new Map<number, Task[]>();
  for (const t of tasks) {
    if (!tasksByAsset.has(t.asset.id)) tasksByAsset.set(t.asset.id, []);
    tasksByAsset.get(t.asset.id)!.push(t);
  }

  const assetIdsOrdered = Array.from(tasksByAsset.keys()).sort((aId, bId) => {
    const aTasks = tasksByAsset.get(aId)!;
    const bTasks = tasksByAsset.get(bId)!;
    // Sort assets by min priority of their tasks
    const aMin = Math.min(...aTasks.map((t) => t.priority));
    const bMin = Math.min(...bTasks.map((t) => t.priority));
    return aMin - bMin;
  });

  // Batch assets
  const batchSize = options.batchSize ?? 2;
  const batches: number[][] = [];
  for (let i = 0; i < assetIdsOrdered.length; i += batchSize) {
    batches.push(assetIdsOrdered.slice(i, i + batchSize));
  }

  console.log(`\n[safe] Starting SAFE sync: ${assets.length} assets, ${allMarketIds.length} markets, ${tasks.length} tasks`);
  console.log(`[safe] Mode=${options.mode}, batchSize=${batchSize} assets, batches=${batches.length}, delay=${options.requestDelayMs}ms, pause=${options.pauseBetweenBatchesMs}ms`);
  console.log(`[safe] incrementalLimit=${options.incrementalLimit}, backfillLimit=${options.backfillLimit}, concurrency=${options.concurrency} (forced 1 for safe)`);
  console.log(`[safe] Backpressure: minFreeMem=${options.minFreeMemMb}MB, maxLoad=${options.maxLoadAvg}`);
  console.log(`[safe] Coverage: ${coverageMap.size} existing combos, ${tasks.filter(t=>t.isIncremental).length} incremental, ${tasks.filter(t=>!t.isIncremental).length} backfill\n`);

  let taskIndex = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batchAssetIds = batches[batchIdx];
    const batchTasks: Task[] = [];
    for (const aid of batchAssetIds) {
      batchTasks.push(...(tasksByAsset.get(aid) || []));
    }

    // Backpressure check before batch
    const bp = checkBackpressure(options.minFreeMemMb, options.maxLoadAvg);
    if (!bp.ok) {
      console.log(`[safe] BACKPRESSURE pause: ${bp.reason} (freemem ${bp.freememMb}MB load ${bp.loadAvg.toFixed(2)}) — pausing 30s`);
      stats.pausedDueToBackpressure++;
      await sleep(30000);
      // Re-check
      const bp2 = checkBackpressure(options.minFreeMemMb, options.maxLoadAvg);
      if (!bp2.ok) {
        console.log(`[safe] Still under pressure after 30s, pausing another 30s...`);
        await sleep(30000);
      }
    }

    console.log(`[safe] Batch ${batchIdx + 1}/${batches.length}: assets ${batchAssetIds.map(id => assets.find(a=>a.id===id)?.symbol).join(",")} — ${batchTasks.length} tasks`);

    for (const task of batchTasks) {
      taskIndex++;
      const adapter = adapterByName.get(task.market.exchange as ExchangeName);
      if (!adapter) {
        stats.errors++;
        stats.failedMarkets.push({
          exchange: task.market.exchange,
          symbol: task.market.exchangeSymbol,
          timeframe: task.timeframe,
          error: `No adapter for ${task.market.exchange}`,
        });
        continue;
      }

      // Determine fetch limit
      const fetchLimit = task.isIncremental ? options.incrementalLimit : options.backfillLimit;

      try {
        // For incremental, we still want to fetch only tail: we can use last candle filter, but adapter always returns limit candles
        // We will filter >= last openTime later, so fetching 20 is enough for reconciliation
        const candles = await withRetry(
          `${task.market.exchange} ${task.market.exchangeSymbol} ${task.timeframe} ${task.isIncremental ? "INCR" : "BACKFILL"}`,
          () => adapter.getCandles(task.market.exchangeSymbol, task.timeframe, fetchLimit)
        );

        // Filter valid and incremental logic
        const validAll = candles.filter(isValidCandle);
        const skippedInvalid = candles.length - validAll.length;

        // For incremental: only keep candles >= last known maxOpenTime (if exists) to avoid re-upserting all history
        let incoming = validAll;
        if (task.isIncremental && task.coverage.maxOpenTime) {
          // Keep only candles >= maxOpenTime (allow overlap 1 candle for update)
          incoming = validAll.filter((c) => c.openTime.getTime() >= task.coverage.maxOpenTime!.getTime());
        }

        if (incoming.length === 0) {
          await prisma.market.update({ where: { id: task.market.id }, data: { lastSyncAt: new Date() } });
          console.log(`  [${taskIndex}/${tasks.length}] OK ${task.asset.symbol} ${task.market.exchange} ${task.market.exchangeSymbol} ${task.timeframe} ${task.isIncremental ? "INCR" : "BACKFILL"} fetched=0 (no new) cov=${task.coverage.count}`);
          // Still delay
          await sleep(options.requestDelayMs);
          continue;
        }

        // Small upsert batches: reuse upsertCandles which chunks 50, but we have at most 20-100
        const countBefore = await prisma.candle.count({
          where: { marketId: task.market.id, timeframe: task.timeframe },
        });

        const result = await upsertCandles(prisma, task.market.id, task.timeframe, incoming);

        const countAfter = await prisma.candle.count({
          where: { marketId: task.market.id, timeframe: task.timeframe },
        });

        const created = Math.max(0, Math.min(countAfter - countBefore, result.written));
        const updated = result.written - created;

        stats.fetched += incoming.length;
        stats.written += result.written;
        stats.created += created;
        stats.updated += updated;
        stats.skippedInvalid += skippedInvalid;

        stats.byExchange[task.market.exchange].markets++;
        stats.byExchange[task.market.exchange].written += result.written;
        stats.byTimeframe[task.timeframe].markets++;
        stats.byTimeframe[task.timeframe].fetched += incoming.length;
        stats.byTimeframe[task.timeframe].written += result.written;

        await prisma.market.update({ where: { id: task.market.id }, data: { lastSyncAt: new Date() } });

        console.log(
          `  [${taskIndex}/${tasks.length}] OK ${task.asset.symbol} ${task.market.exchange} ${task.market.exchangeSymbol} ${task.timeframe} ${task.isIncremental ? "INCR" : "BACKFILL"} fetched=${incoming.length} written=${result.written} created=${created} updated=${updated} cov=${task.coverage.count} -> ${countAfter}`
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
        console.error(`  [${taskIndex}/${tasks.length}] FAIL ${task.asset.symbol} ${task.market.exchange} ${task.market.exchangeSymbol} ${task.timeframe}: ${msg}`);
      }

      // Delay between tasks
      await sleep(options.requestDelayMs);
    }

    stats.batches++;

    // Pause between batches (unless last batch)
    if (batchIdx < batches.length - 1) {
      console.log(`[safe] Batch ${batchIdx + 1} done, pausing ${options.pauseBetweenBatchesMs}ms to reduce CPU/RAM pressure... (freemem ${Math.floor(os.freemem()/1024/1024)}MB load ${os.loadavg()[0].toFixed(2)})`);
      await sleep(options.pauseBetweenBatchesMs);
    }

    // Yield event loop
    await new Promise((resolve) => setImmediate(resolve));
  }

  console.log("\n=== SAFE SYNC DONE ===");
  console.log(`Assets: ${stats.assets}, Markets: ${stats.markets}, Tasks: ${stats.tasks}, Batches: ${stats.batches}`);
  console.log(`Fetched: ${stats.fetched}, Written: ${stats.written}, Created: ${stats.created}, Updated: ${stats.updated}, Errors: ${stats.errors}, Backpressure pauses: ${stats.pausedDueToBackpressure}`);

  return stats;
}
