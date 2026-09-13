/**
 * Signal Worker — BTC ONLY pilot — 3001 test → 3000 production
 * + PHASE 2A/2B Smart Money
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
  let enableSmartMoneyWrite = false;
  let commonHorizonPolicy: "STRICT" | "QUORUM" = "QUORUM";
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
    } else if (a === "--common-horizon-policy") {
      const v = raw[i + 1];
      if (v === "STRICT" || v === "QUORUM") commonHorizonPolicy = v;
      i++;
    } else if (a.startsWith("--common-horizon-policy=")) {
      const v = a.split("=")[1];
      if (v === "STRICT" || v === "QUORUM") commonHorizonPolicy = v as any;
    } else if (a === "--enable-smart-money-write") {
      enableSmartMoneyWrite = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--no-dry-run" || a === "--live" || a === "--once") {
      dryRun = false;
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }

  return { symbol, timeframe, strategy, dryRun, enableSmartMoneyWrite, commonHorizonPolicy, help };
}

function printHelp() {
  console.log(`
Signal Worker — BTC ONLY — 3001 test → 3000 production + PHASE 2A/2B Smart Money

Usage:
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=trend-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --no-dry-run --enable-smart-money-write

Options:
  --symbol <symbol>               Asset symbol (default BTC)
  --timeframe <tf>                Timeframe 5m/15m/1h/4h/1d (default 1h)
  --strategy <slug>               trend-suslik (default) or smart-money-suslik
  --common-horizon-policy <pol>   STRICT or QUORUM (default QUORUM for smart-money, PHASE 2B)
  --dry-run                       Dry run, no DB writes (default)
  --no-dry-run --once             Live run, creates real signals (trend-suslik) or requires --enable-smart-money-write for smart-money
  --enable-smart-money-write      Explicit flag to allow smart-money persistence (PHASE 2B guard, also needs SMART_MONEY_WRITE_ENABLED env or this flag)
  --help                          Show help

PHASE 2B Guard:
  Smart Money default = DRY-RUN / WRITE DISABLED.
  Live write needs BOTH --no-dry-run AND --enable-smart-money-write (or ENV SMART_MONEY_WRITE_ENABLED=true).
  This prevents old PM2 accidentally writing SMC signals.

What it does (trend-suslik):
  - Loads enabled PUBLISHED strategies
  - Loads BTC ACTIVE SPOT USDT markets, BINGX 1d excluded
  - Loads last IndicatorSnapshot per market
  - Evaluates via Strategy Runtime
  - Aggregates with minExchanges, creates Signal with entry/SL/TP via ATR

What it does (smart-money-suslik) PHASE 2B:
  - Loads Strategy smart-money-suslik (even if disabled for dry-run)
  - Validates via validateSmartMoneyConfig (production)
  - Loads CLOSED raw candles (500 latest)
  - Determines ONE common CLOSED horizon via policy STRICT or QUORUM (default QUORUM)
    QUORUM: expected latest CLOSED T from wall clock, fresh participants with T, stale SKIPPED, requires fresh>=minExchanges
    STRICT: intersection over all participants, lagging can rollback to T-1 or refuse
  - Truncates each exchange to H via truncateCandlesToHorizon()
  - Evaluates via evaluateSmc() with identical asOf
  - CANNOT_EVALUATE/stale does not vote
  - Aggregates via aggregateAssetGroup() with minExchanges
  - Builds immutable candidate via buildSmartMoneySignalCandidate() — same payload dry-run == live
  - Reference exchange deterministic priority BINANCE>BYBIT>GATE>KUCOIN>BINGX, independent of score
  - ATR from reference exchange only, stored for reproducibility
  - Entry: NEXT_BAR_OPEN preferred for forward stats (causal-safe), REFERENCE_CLOSE fallback
  - Persists with signalCandleTime, referenceExchange, referencePrice, aggregatePrice, executionPolicy SMC_ATR_V1, signalSource LIVE_FORWARD, metadata Json, atrAtSignal
  - Unique identity [strategyId, symbol, timeframe, signalCandleTime] without direction — prevents LONG and SHORT on same candle
`);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`=== SIGNAL WORKER — BTC ${args.symbol} ${args.timeframe} strategy=${args.strategy} policy=${args.commonHorizonPolicy} ${args.dryRun ? "DRY-RUN" : "LIVE"} enableWrite=${args.enableSmartMoneyWrite} ===`);

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

  if (args.strategy === "smart-money-suslik" && !args.dryRun && !args.enableSmartMoneyWrite && process.env.SMART_MONEY_WRITE_ENABLED !== "true") {
    console.log(`WARNING: smart-money-suslik live requested but write guard not enabled — forcing dryRun=true`);
    console.log(`Need --enable-smart-money-write or SMART_MONEY_WRITE_ENABLED=true`);
    args.dryRun = true;
  }

  try {
    const result = await runSignalEngineForBtc({
      symbol: args.symbol,
      timeframe: args.timeframe,
      strategy: args.strategy,
      dryRun: args.dryRun,
      enableSmartMoneyWrite: args.enableSmartMoneyWrite,
      commonHorizonPolicy: args.commonHorizonPolicy,
    } as any);

    console.log(`\n=== DONE ===`);
    console.log(`Signals created: ${result.signalsCreated} (LONG ${result.longSignals} SHORT ${result.shortSignals})`);
    console.log(`Evaluated markets: ${result.evaluatedMarkets} assets: ${result.evaluatedAssets} neutral: ${result.neutralGroups}`);

    if (args.dryRun) {
      console.log(`\nDRY-RUN complete — no DB writes.`);
      if (args.strategy === "smart-money-suslik") {
        console.log(`To enable live write (PHASE 2B, after owner approval):`);
        console.log(`  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --no-dry-run --enable-smart-money-write`);
        console.log(`  Or ENV: SMART_MONEY_WRITE_ENABLED=true`);
      }
    } else {
      console.log(`\nLIVE run complete — signals created in DB (if guard enabled).`);
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
