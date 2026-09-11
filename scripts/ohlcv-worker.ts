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
  acquireDedicatedLock,
  releaseDedicatedLock,
  type OhlcvDedicatedLockHandle
} from "../lib/ohlcv/lock";

/**
 * OHLCV Worker — управляемый вручную запуск с бирж.
 *
 * Безопасные режимы вызова:
 *
 *   npx tsx scripts/ohlcv-worker.ts --help
 *     справка на русском; БД и биржи НЕ затрагиваются,
 *     клиент Prisma и код синхронизации даже не
 *     импортируются, код выхода 0;
 *   npx tsx scripts/ohlcv-worker.ts --plan --top=10 --timeframes=5m,15m,1h,4h,1d
 *     ПЛАН: read-only SELECT по PostgreSQL (Asset/Market),
 *     оценка задач/свечей/запросов; свечи НЕ пишутся,
 *     API бирж НЕ вызываются, loop не запускается;
 *   npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=1h --once
 *     один проход Top-10 по 1h;
 *   npx tsx scripts/ohlcv-worker.ts --top=10 --timeframes=5m,15m,1h,4h,1d --once
 *
 * Неизвестные/опечатанные флаги (--foobar, --onc, --to=5)
 * дают понятную ошибку и код выхода 1 — воркер с defaults
 * молча НЕ запускается. Клиент Prisma импортируется только
 * в run-режиме, ПОСЛЕ разбора аргументов.
 *
 * Остановка: Ctrl+C (SIGINT/SIGTERM) — воркер завершает
 * текущую операцию, отключается от Prisma и выходит;
 * повторный Ctrl+C — немедленно (код 130).
 */

let interrupted = false;

function onSignal(signal: string) {
  if (interrupted) {
    // повторный Ctrl+C — останавливаемся немедленно
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

/** Ожидание, прерываемое сигналом (без «висящих» часов). */
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
  // 1. Разбор вызова — ДО импортов Prisma/синхронизации/бирж.
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

  // 2. plan/run: загружаем клиент (код синка и адаптеры
  //    бирж — ТОЛЬКО после предохранителя ниже).
  const options = invocation.options;

  let lockHandle: OhlcvDedicatedLockHandle | null = null;
  let prisma: PrismaClient | null = null;
  try {
    // Single-instance guard for continuous/once run (not for --plan/--help)
    // Uses dedicated pg.Client session-level lock: acquire & release on same physical connection,
    // held for entire worker lifetime, auto-released on disconnect/crash.
    if (invocation.kind === "run") {
      try {
        lockHandle = await acquireDedicatedLock(OHLCV_ADVISORY_LOCK_KEY);
      } catch (e) {
        console.error(`Single-instance guard error acquiring advisory lock ${OHLCV_ADVISORY_LOCK_KEY} on dedicated session:`, e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
        return;
      }
      if (!lockHandle) {
        console.error(`Single-instance guard: OHLCV worker already running (dedicated session advisory lock ${OHLCV_ADVISORY_LOCK_KEY} held). Another instance is active — refusing to start overlapping.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Single-instance lock acquired on dedicated session (advisory lock ${OHLCV_ADVISORY_LOCK_KEY}).`);
    }

    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();

    // Читаем масштаб прогона (read-only SELECT).
    const stats = await collectPlanStats(
      prisma!,
      options
    );

    // Symbol fail-closed: если запрошен --symbol, но актив не найден/disabled — ошибка
    if (options.symbol && stats.assets === 0) {
      console.error(`Ошибка: актив с символом "${options.symbol}" не найден или disabled (enabled=true требуется). Проверьте Asset.symbol в БД.`);
      process.exitCode = 1;
      return;
    }

    // семантика заголовка: «Режим PLAN» — только при
    // явном --plan; обычный запуск — «Предварительная
    // оценка запуска» (регрессия UX: PLAN-баннер писался
    // и обычному запуску, заблокированному guard-ом)
    console.log(
      preflightTitle(invocation.kind === "plan")
    );

    for (const line of formatPlanReport(options, stats)) {
      console.log(line);
    }

    // Предохранитель от случайного большого запуска.
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

    const { runOhlcvSync } = await import(
      "../lib/ohlcv/sync"
    );

    console.log("🐿️ OHLCV Worker");
    if (options.symbol) {
      console.log(
        `symbol=${options.symbol} timeframes=${options.timeframes.join(",")} ` +
          `limit=${options.limit} delay=${options.requestDelayMs}ms interval=${options.intervalMs}ms once=${options.once}`
      );
    } else {
      console.log(
        `top=${options.top} timeframes=${options.timeframes.join(",")} ` +
          `limit=${options.limit} delay=${options.requestDelayMs}ms interval=${options.intervalMs}ms once=${options.once}`
      );
    }

    do {
      const started = Date.now();
      const stats = await runOhlcvSync(prisma!, options);

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
        console.log(`Single-instance lock released from dedicated session (advisory lock ${OHLCV_ADVISORY_LOCK_KEY}).`);
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
