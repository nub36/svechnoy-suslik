/**
 * Public TOP-50 lightweight ingestion worker
 * - Serves Top-50 + manually added coins BINANCE FIRST
 * - Concurrency=1 small rotating batches incremental backpressure slow backfill
 * - BTC separate OHLCV worker preserved
 * - Fixes restart loop bug: interval 300000 (5m) satisfies validation 5m requires <=300000
 * - No Top100x5 heavy worker
 */

import "dotenv/config";
import { parseOhlcvArgs, validateCadence } from "../lib/ohlcv/cli";
import { runSafeOhlcvSync } from "../lib/ohlcv/sync-safe";

async function main() {
  const argv = process.argv.slice(2);

  let options: ReturnType<typeof parseOhlcvArgs>;
  try {
    options = parseOhlcvArgs(argv, process.env);
  } catch (e) {
    console.error(`[public-top50-worker] CLI error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  // Force safe defaults for public-top50 — ONLY BINANCE by default via ExchangeConfig
  const safeOptions = {
    ...options,
    top: options.top ?? 50,
    timeframes: options.timeframes ?? ["5m", "15m", "1h", "4h", "1d"] as any,
    batchSize: (options as any).batchSize ?? 2,
    pauseBetweenBatchesMs: (options as any).pauseBetweenBatchesMs ?? 10000,
    incrementalLimit: (options as any).incrementalLimit ?? 20,
    backfillLimit: (options as any).backfillLimit ?? 100,
    concurrency: 1,
    mode: (options as any).mode ?? "safe",
    minFreeMemMb: (options as any).minFreeMemMb ?? 200,
    maxLoadAvg: (options as any).maxLoadAvg ?? 2.0,
    useExchangeConfig: true,
  };

  // Validate cadence — interval must be <=300000 for 5m
  const cadenceError = validateCadence({ timeframes: safeOptions.timeframes as string[], intervalMs: safeOptions.intervalMs, once: safeOptions.once });
  if (cadenceError) {
    console.error(`[public-top50-worker] Cadence error: ${cadenceError}`);
    console.error(`[public-top50-worker] Fix: use --interval <=300000 (5m) or exclude 5m or --once`);
    process.exit(1);
  }

  console.log(`[public-top50-worker] Starting TOP-50 public ingestion`);
  console.log(`[public-top50-worker] top=${safeOptions.top} timeframes=${safeOptions.timeframes.join(",")} batchSize=${safeOptions.batchSize} delay=${safeOptions.requestDelayMs} pause=${safeOptions.pauseBetweenBatchesMs} incremental=${safeOptions.incrementalLimit} backfill=${safeOptions.backfillLimit} concurrency=1 mode=${safeOptions.mode} interval=${safeOptions.intervalMs} once=${safeOptions.once}`);

  const { prisma } = await import("../lib/prisma");

  // Use safe sync with coverageMap, backpressure, BINANCE FIRST priority
  const result = await runSafeOhlcvSync(prisma as any, safeOptions as any);

  console.log(`[public-top50-worker] Completed: markets=${result.markets} fetched=${result.fetched} written=${result.written} created=${result.created} updated=${result.updated} errors=${result.errors}`);

  if (!safeOptions.once) {
    console.log(`[public-top50-worker] Continuous mode interval=${safeOptions.intervalMs}ms — sleeping`);
    const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
    while (true) {
      await sleep(safeOptions.intervalMs);
      console.log(`[public-top50-worker] Next cycle...`);
      try {
        const cycleResult = await runSafeOhlcvSync(prisma as any, safeOptions as any);
        console.log(`[public-top50-worker] Cycle completed: markets=${cycleResult.markets} fetched=${cycleResult.fetched} written=${cycleResult.written} errors=${cycleResult.errors}`);
      } catch (e) {
        console.error(`[public-top50-worker] Cycle error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }
}

main().catch((e) => {
  console.error(`[public-top50-worker] Fatal: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
