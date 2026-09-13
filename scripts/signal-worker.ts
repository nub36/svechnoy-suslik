/**
 * Signal Worker — BTC ONLY pilot — 3001 test → 3000 production
 * Запускает Signal Engine для генерации реальных LONG/SHORT сигналов.
 * 
 * Usage:
 *   npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
 *   npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once
 *   npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run
 * 
 * На VPS:
 *   cd ~/svechnoy-suslik
 *   npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
 *   npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { runSignalEngineForBtc } from "../lib/signals/signal-engine";

const prisma = new PrismaClient();

function parseArgs() {
  const raw = process.argv.slice(2);
  let symbol = "BTC";
  let timeframe = "1h";
  let dryRun = true;
  let help = false;

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--symbol") {
      symbol = raw[i + 1];
      i++;
    } else if (a === "--timeframe") {
      timeframe = raw[i + 1];
      i++;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--no-dry-run" || a === "--live" || a === "--once") {
      dryRun = false;
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }

  return { symbol, timeframe, dryRun, help };
}

function printHelp() {
  console.log(`
Signal Worker — BTC ONLY — 3001 test → 3000 production

Usage:
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run

Options:
  --symbol <symbol>    Asset symbol (default BTC) — BTC only pilot
  --timeframe <tf>     Timeframe 5m/15m/1h/4h/1d (default 1h)
  --dry-run            Dry run, no DB writes (default)
  --no-dry-run --once  Live run, creates real signals in DB
  --help               Show help

What it does:
  - Loads enabled PUBLISHED strategies (trend-suslik)
  - Loads BTC ACTIVE SPOT USDT markets, filters BINGX 1d excluded
  - Loads last IndicatorSnapshot per market for timeframe
  - Evaluates via Strategy Runtime (real production path)
  - Aggregates per asset/timeframe with minExchanges confirmation
  - Creates Signal with entry/SL/TP via ATR multipliers
  - Duplicate protection: one signal per strategy+symbol+timeframe+candleTime+direction
  - Cooldown: respects execution.cooldownCandles

VPS Production (3000):
  cd ~/svechnoy-suslik
  git pull
  npx prisma generate
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run
  pm2 logs svechnoy-suslik

Test on 3001:
  PORT=3001 npm run dev
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
`);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`=== SIGNAL WORKER — BTC ${args.symbol} ${args.timeframe} ${args.dryRun ? "DRY-RUN" : "LIVE"} — 3001 TEST → 3000 PROD ===`);

  if (args.symbol !== "BTC") {
    console.error(`Only BTC supported for pilot, got ${args.symbol}`);
    process.exit(1);
  }

  const allowedTf = ["5m", "15m", "1h", "4h", "1d"];
  if (!allowedTf.includes(args.timeframe)) {
    console.error(`Timeframe must be one of ${allowedTf.join(", ")}, got ${args.timeframe}`);
    process.exit(1);
  }

  try {
    const result = await runSignalEngineForBtc({
      symbol: args.symbol,
      timeframe: args.timeframe,
      dryRun: args.dryRun,
    });

    console.log(`\n=== DONE ===`);
    console.log(`Signals created: ${result.signalsCreated} (LONG ${result.longSignals} SHORT ${result.shortSignals})`);
    console.log(`Evaluated markets: ${result.evaluatedMarkets} assets: ${result.evaluatedAssets} neutral: ${result.neutralGroups}`);
    
    if (args.dryRun) {
      console.log(`\nDRY-RUN complete — no DB writes. Use --no-dry-run --once to create real signals.`);
      console.log(`To enable on main site 3000:`);
      console.log(`  1. On VPS: cd ~/svechnoy-suslik && git pull && npx prisma generate && npm run build`);
      console.log(`  2. Ensure strategy enabled: npx tsx scripts/enable-btc-strategy.ts`);
      console.log(`  3. Run: npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run`);
      console.log(`  4. pm2 restart svechnoy-suslik --update-env && pm2 logs svechnoy-suslik`);
      console.log(`  5. Check http://89.125.24.50:3000/signals and /admin`);
    } else {
      console.log(`\nLIVE run complete — signals created in DB, visible on site 3000 after restart.`);
    }
  } catch (e) {
    console.error("Signal worker failed:", (e as Error).message);
    console.error((e as Error).stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
