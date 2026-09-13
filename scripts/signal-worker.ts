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
  let strategy = "trend-suslik";
  let dryRun = true;
  let help = false;

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--symbol") {
      symbol = raw[i + 1];
      i++;
    } else if (a.startsWith("--symbol=")) {
      symbol = a.split("=")[1];
    } else if (a === "--timeframe") {
      timeframe = raw[i + 1];
      i++;
    } else if (a.startsWith("--timeframe=")) {
      timeframe = a.split("=")[1];
    } else if (a === "--strategy") {
      strategy = raw[i + 1];
      i++;
    } else if (a.startsWith("--strategy=")) {
      strategy = a.split("=")[1];
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--no-dry-run" || a === "--live" || a === "--once") {
      dryRun = false;
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }

  return { symbol, timeframe, strategy, dryRun, help };
}

function printHelp() {
  console.log(`
Signal Worker — BTC ONLY — 3001 test → 3000 production + PHASE 2A Smart Money DRY-RUN

Usage:
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=trend-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run

Options:
  --symbol <symbol>    Asset symbol (default BTC) — BTC only pilot
  --timeframe <tf>     Timeframe 5m/15m/1h/4h/1d (default 1h)
  --strategy <slug>    Strategy slug: trend-suslik (default) or smart-money-suslik (PHASE 2A dry-run only)
  --dry-run            Dry run, no DB writes (default)
  --no-dry-run --once  Live run, creates real signals in DB (trend-suslik only, smart-money is always dry-run in PHASE 2A)
  --help               Show help

What it does (trend-suslik):
  - Loads enabled PUBLISHED strategies (trend-suslik)
  - Loads BTC ACTIVE SPOT USDT markets, filters BINGX 1d excluded
  - Loads last IndicatorSnapshot per market for timeframe
  - Evaluates via Strategy Runtime (real production path)
  - Aggregates per asset/timeframe with minExchanges confirmation
  - Creates Signal with entry/SL/TP via ATR multipliers

What it does (smart-money-suslik) PHASE 2A DRY-RUN:
  - Loads Strategy smart-money-suslik (even if disabled, dry-run allowed)
  - Validates config via validateSmartMoneyConfig (production function)
  - Loads eligible BTC markets BINGX 1d excluded via isSmartMoneyExchangeEligible()
  - Loads CLOSED raw candles (500 latest, closed=true only)
  - Determines ONE common CLOSED causal horizon via selectCommonClosedHorizon()
  - Truncates each exchange to that horizon via truncateCandlesToHorizon()
  - Evaluates via evaluateSmc() for every participant with identical asOf
  - CANNOT_EVALUATE/stale exchanges must not vote
  - Aggregates via aggregateAssetGroup() using Strategy.minExchanges
  - Outputs candidate LONG/SHORT/NEUTRAL with full A-I explanation
  - NEVER prisma.signal.create for smart-money (PHASE 2A guard)

VPS Production (3000):
  cd ~/svechnoy-suslik
  git pull
  npx prisma generate
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=trend-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=trend-suslik --once --no-dry-run
  pm2 logs svechnoy-suslik

Test on 3001:
  PORT=3001 npm run dev
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=trend-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run
`);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`=== SIGNAL WORKER — BTC ${args.symbol} ${args.timeframe} strategy=${args.strategy} ${args.dryRun ? "DRY-RUN" : "LIVE"} — 3001 TEST → 3000 PROD ===`);

  if (args.symbol !== "BTC") {
    console.error(`Only BTC supported for pilot, got ${args.symbol}`);
    process.exit(1);
  }

  const allowedTf = ["5m", "15m", "1h", "4h", "1d"];
  if (!allowedTf.includes(args.timeframe)) {
    console.error(`Timeframe must be one of ${allowedTf.join(", ")}, got ${args.timeframe}`);
    process.exit(1);
  }

  const allowedStrategies = ["trend-suslik", "smart-money-suslik"];
  if (!allowedStrategies.includes(args.strategy)) {
    console.error(`Strategy must be one of ${allowedStrategies.join(", ")}, got ${args.strategy}`);
    process.exit(1);
  }

  if (args.strategy === "smart-money-suslik" && !args.dryRun) {
    console.log(`WARNING: smart-money-suslik in PHASE 2A is DRY-RUN only — forcing dryRun=true, no DB writes`);
    args.dryRun = true;
  }

  try {
    const result = await runSignalEngineForBtc({
      symbol: args.symbol,
      timeframe: args.timeframe,
      strategy: args.strategy,
      dryRun: args.dryRun,
    } as any);

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
