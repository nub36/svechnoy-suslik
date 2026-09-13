import "dotenv/config";
import type { PrismaClient } from "@prisma/client";
import { sleep } from "../lib/ohlcv/retry";
import {
  buildOhlcvHelp,
  formatTimeframeSummary,
  resolveOhlcvInvocation
} from "../lib/ohlcv/cli";
import {
  buildConfirmCommand,
  collectPlanStats,
  evaluateRunScale,
  formatPlanReport,
  preflightTitle
} from "../lib/ohlcv/plan";
import {
  OHLCV_ADVISORY_LOCK_KEY,
  OHLCV_ALL_ADVISORY_LOCK_KEY,
  acquireDedicatedLock,
  releaseDedicatedLock,
  type OhlcvDedicatedLockHandle
} from "../lib/ohlcv/lock";

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

async function waitInterruptible(
  ms: number
): Promise<void> {
  const step = 100;
  let waited = 0;

  while (!interrupted && waited < ms) {
    await sleep(Math.min(step, ms - waited));
    waited += step;
  }
}

async function printVerification(
  prisma: PrismaClient,
  options: { top: number; symbol?: string; timeframes: string[] }
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
  if (options.symbol) {
    console.log(`Symbol запрошен: ${options.symbol}`);
  } else {
    console.log(`Top запрошен: ${options.top}`);
  }
  console.log("");

  for (const timeframe of options.timeframes) {
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
  const invocation = resolveOhlcvInvocation(
    process.argv.slice(2)
  );

  if (invocation.kind === "help") {
    console.log(buildOhlcvHelp());
    return;
  }

  if (invocation.kind === "error") {
    console.error(
      `Ошибка аргументов: ${invocation.message}`
    );
    process.exitCode = 1;
    return;
  }

  const options = invocation.options;

  let lockHandle: OhlcvDedicatedLockHandle | null = null;
  let prisma: PrismaClient | null = null;
  try {
    if (invocation.kind === "run") {
      const useAllLock = !options.symbol && options.top > 1;
      const lockKey = useAllLock ? OHLCV_ALL_ADVISORY_LOCK_KEY : OHLCV_ADVISORY_LOCK_KEY;
      try {
        lockHandle = await acquireDedicatedLock(lockKey);
      } catch (e) {
        console.error(`Single-instance guard error acquiring advisory lock ${lockKey} on dedicated session:`, e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
        return;
      }
      if (!lockHandle) {
        console.error(`Single-instance guard: OHLCV worker already running (dedicated session advisory lock ${lockKey} held). Another instance is active — refusing to start overlapping.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Single-instance lock acquired on dedicated session (advisory lock ${lockKey}).`);
    }

    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();

    const stats = await collectPlanStats(
      prisma!,
      options
    );

    if (options.symbol && stats.assets === 0) {
      console.error(`Ошибка: актив с символом "${options.symbol}" не найден или disabled (enabled=true требуется). Проверьте Asset.symbol в БД.`);
      process.exitCode = 1;
      return;
    }

    console.log(
      preflightTitle(invocation.kind === "plan")
    );

    for (const line of formatPlanReport(options, stats)) {
      console.log(line);
    }

    const scale = evaluateRunScale(
      stats.tasks,
      options.confirmLargeRun
    );

    if (invocation.kind === "plan") {
      console.log("");
      console.log(
        `Предохранитель: порог ${scale.allowed ? "не превышен" : "будет превышен"} ` +
          `(задач: ${stats.tasks}).`
      );
      return;
    }

    if (!scale.allowed) {
      console.error("");
      console.error(scale.message);
      console.error(
        `Команда повтора: ${buildConfirmCommand(options)}`
      );
      process.exitCode = 1;
      return;
    }

    if (scale.message) {
      console.log(scale.message);
    }

    // Determine sync mode
    const isSafeMode = (options as any).mode === "safe" || (options as any).mode === "incremental" || (options as any).mode === "backfill";
    const useSafeForTop = !options.symbol && options.top >= 5;

    console.log("🐿️ OHLCV Worker");
    if (options.symbol) {
      console.log(
        `symbol=${options.symbol} timeframes=${options.timeframes.join(",")} ` +
          `limit=${options.limit} delay=${options.requestDelayMs}ms interval=${options.intervalMs}ms once=${options.once} concurrency=${options.concurrency} mode=${(options as any).mode} batchSize=${(options as any).batchSize}`
      );
    } else {
      console.log(
        `top=${options.top} timeframes=${options.timeframes.join(",")} ` +
          `limit=${options.limit} delay=${options.requestDelayMs}ms interval=${options.intervalMs}ms once=${options.once} concurrency=${options.concurrency} mode=${(options as any).mode} batchSize=${(options as any).batchSize} incrementalLimit=${(options as any).incrementalLimit} backfillLimit=${(options as any).backfillLimit} pause=${(options as any).pauseBetweenBatchesMs} minFreeMem=${(options as any).minFreeMemMb} maxLoad=${(options as any).maxLoadAvg}`
      );
    }

    do {
      const started = Date.now();
      let runStats: any;

      if (isSafeMode || useSafeForTop) {
        const { runSafeOhlcvSync } = await import("../lib/ohlcv/sync-safe");
        const safeStats = await runSafeOhlcvSync(prisma!, options as any);
        runStats = safeStats;
        console.log("\n--- итог прохода (SAFE low-priority incremental) ---");
        console.log(`активов: ${runStats.assets}`);
        console.log(`рынков: ${runStats.markets}`);
        console.log(`задач: ${runStats.tasks}`);
        console.log(`батчей: ${runStats.batches}`);
        console.log(`получено свечей: ${runStats.fetched}`);
        console.log(`записано/обновлено: ${runStats.written}`);
        console.log(`создано новых: ${runStats.created}`);
        console.log(`обновлено существующих: ${runStats.updated}`);
        console.log(`отброшено невалидных: ${runStats.skippedInvalid}`);
        console.log(`ошибок: ${runStats.errors}`);
        console.log(`пауз из-за backpressure: ${runStats.pausedDueToBackpressure}`);
        if (runStats.failedMarkets?.length) {
          console.log(`failed markets: ${runStats.failedMarkets.length}`);
        }
      } else {
        // BTC pilot single asset uses legacy sequential sync (small, safe)
        const { runOhlcvSync } = await import("../lib/ohlcv/sync");
        runStats = await runOhlcvSync(prisma!, options);
        console.log("\n--- итог прохода (BTC pilot sequential) ---");
        console.log(`активов: ${runStats.assets}`);
        console.log(`пар рынок×tf: ${runStats.markets}`);
        console.log(`получено свечей: ${runStats.fetched}`);
        console.log(`записано/обновлено: ${runStats.written}`);
        console.log(`создано новых: ${runStats.created}`);
        console.log(`обновлено существующих: ${runStats.updated}`);
        console.log(`отброшено невалидных: ${runStats.skippedInvalid}`);
        console.log(`ошибок: ${runStats.errors}`);
      }

      console.log("\n--- по таймфреймам ---");
      for (const line of formatTimeframeSummary(runStats.byTimeframe)) {
        console.log(line);
      }

      for (const [exchange, row] of Object.entries(runStats.byExchange)) {
        const r = row as any;
        console.log(
          `  ${exchange.padEnd(8)} рынков=${r.markets} ` +
            `записано=${r.written} ошибок=${r.errors}`
        );
      }

      await printVerification(prisma!, options);

      console.log(`проход ${Date.now() - started}ms`);

      if (!options.once && !interrupted) {
        console.log(
          `следующий проход через ${options.intervalMs}ms (Ctrl+C — остановить)`
        );
        await waitInterruptible(options.intervalMs);
      }
    } while (!options.once && !interrupted);

    if (interrupted) {
      console.log("Остановлено пользователем.");
    }
  } finally {
    if (lockHandle) {
      try {
        await releaseDedicatedLock(lockHandle);
        console.log(`Single-instance lock released from dedicated session (advisory lock ${OHLCV_ALL_ADVISORY_LOCK_KEY} / ${OHLCV_ADVISORY_LOCK_KEY}).`);
      } catch {}
    }
    if (prisma) {
      await prisma.$disconnect();
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
