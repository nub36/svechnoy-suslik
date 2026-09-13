/**
 * Signal Worker — BTC ONLY pilot — 3001 test → 3000 production
 * + PHASE 2A/2B/2C Smart Money FINAL HARDENING
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
Signal Worker — BTC ONLY — 3001 test → 3000 production + PHASE 2A/2B/2C Smart Money FINAL HARDENING

Usage:
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=trend-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --no-dry-run --enable-smart-money-write
    (requires ENV SMART_MONEY_WRITE_ENABLED=true for PHASE 2C AND guard)

Options:
  --symbol <symbol>               Asset symbol (default BTC)
  --timeframe <tf>                Timeframe 5m/15m/1h/4h/1d (default 1h)
  --strategy <slug>               trend-suslik (default) or smart-money-suslik
  --common-horizon-policy <pol>   STRICT or QUORUM (default QUORUM for smart-money)
  --dry-run                       Dry run, no DB writes (default)
  --no-dry-run --once             Live run, creates real signals (trend) or requires BOTH --enable-smart-money-write AND ENV SMART_MONEY_WRITE_ENABLED=true for smart-money (PHASE 2C AND guard)
  --enable-smart-money-write      Explicit flag to allow smart-money persistence (PHASE 2C: needs ALSO SMART_MONEY_WRITE_ENABLED=true)
  --help                          Show help

PHASE 2C Guard AND:
  Smart Money default = DRY-RUN / WRITE DISABLED.
  Live write needs BOTH --no-dry-run AND --enable-smart-money-write AND ENV SMART_MONEY_WRITE_ENABLED=true.
  Truth table:
    flag false / env false => BLOCKED
    flag true  / env false => BLOCKED
    flag false / env true  => BLOCKED
    flag true  / env true  => ALLOWED
  This prevents accidental writes from old PM2 or missing env.

What it does (trend-suslik):
  - Loads enabled PUBLISHED strategies
  - Loads BTC ACTIVE SPOT USDT markets, BINGX 1d excluded
  - Loads last IndicatorSnapshot per market
  - Evaluates via Strategy Runtime
  - Aggregates with minExchanges, creates Signal with entry/SL/TP via ATR

What it does (smart-money-suslik) PHASE 2C FINAL HARDENING:
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
  - Builds immutable candidate via buildSmartMoneySignalCandidate() — same payload dry-run == live, deepFreeze
  - Reference exchange deterministic priority BINANCE>BYBIT>GATE>KUCOIN>BINGX, independent of score, fallback metadata
  - ATR from reference exchange only, frozen at signal candle, stored for reproducibility
  - Entry: NEXT_BAR_OPEN only, no optimistic fallback to REFERENCE_CLOSE. If next bar not available, entry=NULL WAITING_ENTRY.
    Next bar openTime must be exactly signalCandleTime+tf, gap => ENTRY_DATA_MISSING
  - SL/TP only after real NEXT_BAR_OPEN entry appears: LONG SL=entry-ATR*stop TP=entry+ATR*tp SHORT opposite
  - Persists Signal immutable observation (signalCandleTime,direction,score,referenceExchange,referencePrice,aggregatePrice,atrAtSignal,metadata)
    and SignalOutcome separate (signalId UNIQUE, status WAITING_ENTRY/OPEN/TP1_HIT/TP2_HIT/TP3_HIT/STOPPED/EXPIRED/ENTRY_DATA_MISSING)
  - Unique identity [strategyId, symbol, timeframe, signalCandleTime] without direction — prevents LONG and SHORT on same candle
  - SignalSource enum LIVE_FORWARD/SEEDED/BACKTEST/LEGACY, default LEGACY, new real rows explicit LIVE_FORWARD
  - Score semantics: LONG=longScore SHORT=shortScore metadata stores both
  - Confirmation structured: participantCount/evaluatedCount/longVotes/shortVotes/neutralVotes/minExchanges/confirmationCount/Total
`);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`=== SIGNAL WORKER — BTC ${args.symbol} ${args.timeframe} strategy=${args.strategy} policy=${args.commonHorizonPolicy} ${args.dryRun ? "DRY-RUN" : "LIVE"} enableWriteFlag=${args.enableSmartMoneyWrite} envWrite=${process.env.SMART_MONEY_WRITE_ENABLED} ===`);

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
    const flag = args.enableSmartMoneyWrite;
    const env = process.env.SMART_MONEY_WRITE_ENABLED === "true";
    const allowed = flag && env;
    if (!allowed) {
      console.log(`WARNING: smart-money-suslik live requested but AND guard not satisfied (flag=${flag} env=${env} need both true) — forcing dryRun=true`);
      console.log(`Need BOTH --enable-smart-money-write AND SMART_MONEY_WRITE_ENABLED=true`);
      args.dryRun = true;
    }
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
        console.log(`To enable live write (PHASE 2C, after owner approval, AND guard):`);
        console.log(`  SMART_MONEY_WRITE_ENABLED=true npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --no-dry-run --enable-smart-money-write`);
      }
    } else {
      console.log(`\nLIVE run complete — signals created in DB (if AND guard satisfied).`);
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
