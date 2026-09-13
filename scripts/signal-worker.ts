/**
 * Signal Worker — BTC ONLY pilot — 3001 test → 3000 production
 * + PHASE 2A/2B/2C + EDGE/RE-ARM V1
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
  let emitOnBootstrap = false;
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
    } else if (a === "--emit-on-bootstrap") {
      emitOnBootstrap = true;
    } else if (a === "--dry-run") {
      dryRun = true;
    } else if (a === "--no-dry-run" || a === "--live" || a === "--once") {
      dryRun = false;
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }

  return { symbol, timeframe, strategy, dryRun, enableSmartMoneyWrite, emitOnBootstrap, commonHorizonPolicy, help };
}

function printHelp() {
  console.log(`
Signal Worker — BTC ONLY — EDGE/RE-ARM V1

Usage:
  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=15m --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM
  SMART_MONEY_WRITE_ENABLED=true npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=15m --strategy=smart-money-suslik --no-dry-run --enable-smart-money-write

Options:
  --symbol <symbol>               BTC only (default BTC)
  --timeframe <tf>                5m/15m/1h/4h/1d (default 1h)
  --strategy <slug>               trend-suslik or smart-money-suslik
  --common-horizon-policy <pol>   STRICT or QUORUM (default QUORUM)
  --dry-run                       Dry run, no DB writes (default) — also does NOT mutate StrategySignalState
  --no-dry-run --once             Live run, requires BOTH --enable-smart-money-write AND ENV SMART_MONEY_WRITE_ENABLED=true for smart-money
  --enable-smart-money-write      Explicit flag for SMC persistence (needs ALSO ENV true — AND guard)
  --emit-on-bootstrap             Optional: if no state row and current SHORT/LONG, emit immediately. Default false = BOOTSTRAP without signal
  --help

EDGE STATE MACHINE V1:
  Aggregate states: NEUTRAL, LONG, SHORT, CANNOT_EVALUATE/DATA_UNAVAILABLE/QUORUM_NOT_MET etc
  Transitions:
    NEUTRAL->LONG/SHORT = EMIT (EDGE)
    LONG->LONG, SHORT->SHORT = HOLD (no emit)
    LONG->NEUTRAL, SHORT->NEUTRAL = RE-ARM
    LONG->SHORT, SHORT->LONG = EMIT reversal
    Any -> UNAVAILABLE = PRESERVE (no re-arm, no emit) — SHORT->DATA_UNAVAILABLE->SHORT must NOT emit second
  Idempotent: same horizon twice no-op, older horizon refused
  Persistent: StrategySignalState table survives PM2 restart, unique [strategyId,symbol,timeframe]
  Transactional: Signal+Outcome+State update in ONE prisma.$transaction, P2002 idempotent, concurrent safe
  Bootstrap: no state + current SHORT => BOOTSTRAP SHORT NO SIGNAL default, only after SHORT->NEUTRAL->SHORT or reversal. Owner can --emit-on-bootstrap but default false.
  Dry-run: NEVER mutates StrategySignalState, READ-ONLY load, logs proposed transition

PHASE 2C Guard AND:
  flag false/env false BLOCKED, flag true/env false BLOCKED, flag false/env true BLOCKED, flag true/env true ALLOWED
`);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`=== SIGNAL WORKER — BTC ${args.symbol} ${args.timeframe} strategy=${args.strategy} policy=${args.commonHorizonPolicy} ${args.dryRun ? "DRY-RUN" : "LIVE"} enableWrite=${args.enableSmartMoneyWrite} emitOnBootstrap=${args.emitOnBootstrap} envWrite=${process.env.SMART_MONEY_WRITE_ENABLED} ===`);

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
      emitOnBootstrap: args.emitOnBootstrap,
      commonHorizonPolicy: args.commonHorizonPolicy,
    } as any);

    console.log(`\n=== DONE ===`);
    console.log(`Signals created: ${result.signalsCreated} (LONG ${result.longSignals} SHORT ${result.shortSignals})`);
    console.log(`Evaluated markets: ${result.evaluatedMarkets} assets: ${result.evaluatedAssets} neutral: ${result.neutralGroups}`);

    if (args.dryRun) {
      console.log(`\nDRY-RUN complete — no DB writes, no StrategySignalState mutation.`);
      if (args.strategy === "smart-money-suslik") {
        console.log(`To enable live write (after owner approval, AND guard + EDGE semantics):`);
        console.log(`  SMART_MONEY_WRITE_ENABLED=true npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=15m --strategy=smart-money-suslik --no-dry-run --enable-smart-money-write`);
        console.log(`  Default bootstrap SHORT => NO SIGNAL, only after SHORT->NEUTRAL->SHORT or reversal. Use --emit-on-bootstrap to override (not recommended).`);
      }
    } else {
      console.log(`\nLIVE run complete — signals created in DB (if AND guard satisfied) with transactional State update.`);
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
