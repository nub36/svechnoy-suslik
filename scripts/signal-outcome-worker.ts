/**
 * Signal Outcome Lifecycle Tracker — generic for all strategies
 * - Handles WAITING_ENTRY -> OPEN via exact NEXT_BAR_OPEN
 * - Handles OPEN / TP1_HIT / TP2_HIT progression via evaluateOutcomeProgression
 * - No strategy logic, no EDGE, no quorum — only outcome lifecycle
 * - Concurrency=1, bounded batch, advisory lock, VPS 2GB safe
 * - Supports --dry-run and --signal-id for safe diagnostics
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import { buildInitialOutcome, evaluateOutcomeProgression, type OutcomeState, type CandleForOutcome } from "../lib/signals/signal-outcome";
import type { SmartMoneySignalCandidate } from "../lib/signals/smart-money-candidate";

const prisma = new PrismaClient();

const OUTCOME_LOCK_KEY = 727925; // separate from OHLCV locks

const TERMINAL_STATUSES = new Set(["STOPPED", "TP3_HIT", "EXPIRED"]);
const NON_TERMINAL_STATUSES = ["OPEN", "TP1_HIT", "TP2_HIT"] as const;
const PENDING_ENTRY_STATUSES = ["WAITING_ENTRY", "ENTRY_DATA_MISSING"] as const;
const SUPPORTED_POLICIES = ["SMC_ATR_V1", "NEXT_BAR_OPEN"];

function parseArgs() {
  const raw = process.argv.slice(2);
  let once = false;
  let dryRun = false;
  let signalId: number | null = null;
  let batchSize = 20;
  let help = false;

  for (const a of raw) {
    if (a === "--once") once = true;
    else if (a === "--dry-run") dryRun = true;
    else if (a.startsWith("--signal-id=")) {
      const v = Number(a.split("=")[1]);
      if (Number.isInteger(v) && v > 0) signalId = v;
    } else if (a.startsWith("--batch-size=")) {
      const v = Number(a.split("=")[1]);
      if (Number.isInteger(v) && v >= 1 && v <= 100) batchSize = v;
    } else if (a === "--help" || a === "-h") help = true;
  }

  // Default to once for PM2 --once mode
  if (!once && !raw.includes("--no-once")) {
    // If no explicit mode, default once for safety
    once = true;
  }

  return { once, dryRun, signalId, batchSize, help };
}

function printHelp() {
  console.log(`
Signal Outcome Tracker — lifecycle WAITING_ENTRY → OPEN → TP1/TP2/TP3/STOP

Usage:
  npx tsx scripts/signal-outcome-worker.ts --once --dry-run --signal-id=4
  npx tsx scripts/signal-outcome-worker.ts --once --batch-size=20
  npx tsx scripts/signal-outcome-worker.ts --once --dry-run

Options:
  --once              single pass (default, for PM2 cron)
  --dry-run           READ-ONLY, no DB writes, shows expected transitions
  --signal-id=N       process only specific Signal id (for diagnostics)
  --batch-size=N      max pending outcomes per pass 1..100 default 20
  --help, -h          this help

Lifecycle:
  WAITING_ENTRY → exact NEXT_BAR_OPEN (openTime = signalCandleTime + tf) → OPEN
  OPEN / TP1_HIT / TP2_HIT → subsequent CLOSED reference candles → evaluateOutcomeProgression
  Terminal STOPPED / TP3_HIT / EXPIRED immutable

Safety:
  - exact candle only, no nearest/aggregate/referencePrice fallback
  - ATR frozen from Signal.atrAtSignal / Outcome.atrAtSignal, not recalculated
  - SL/TP from saved executionParams via buildInitialOutcome (no duplicate math)
  - atomic Signal+Outcome promotion in one transaction
  - idempotent repeated runs
  - LEGACY signals without executionPolicy ignored
  - advisory lock 727925 prevents overlap
`);
}

function timeframeMs(tf: string): number {
  const ms = (SMCTIMEFRAME_MS as any)[tf];
  if (!ms) throw new Error(`Unsupported timeframe ${tf}`);
  return ms;
}

function isSupportedPolicy(policy: string | null | undefined): boolean {
  if (!policy) return false;
  return SUPPORTED_POLICIES.some(p => policy.includes(p));
}

async function findReferenceMarket(assetId: number, referenceExchange: string) {
  // Try exact ACTIVE SPOT USDT market
  let market = await prisma.market.findFirst({
    where: {
      assetId,
      exchange: referenceExchange,
      enabled: true,
      status: "ACTIVE",
      marketType: "SPOT",
      quote: "USDT",
    },
    select: { id: true, exchange: true, exchangeSymbol: true },
  });
  if (market) return market;
  // Fallback: any market for this exchange+asset (even if not ACTIVE) for historical backfill
  market = await prisma.market.findFirst({
    where: {
      assetId,
      exchange: referenceExchange,
    },
    select: { id: true, exchange: true, exchangeSymbol: true },
  });
  return market;
}

async function findExactNextCandle(marketId: number, timeframe: string, expectedOpenTime: Date) {
  const candle = await prisma.candle.findFirst({
    where: {
      marketId,
      timeframe,
      openTime: expectedOpenTime,
    },
    select: { openTime: true, open: true, high: true, low: true, close: true, closed: true },
  });
  return candle;
}

async function findFirstCandleAfter(marketId: number, timeframe: string, afterTime: Date) {
  const candle = await prisma.candle.findFirst({
    where: {
      marketId,
      timeframe,
      openTime: { gt: afterTime },
    },
    orderBy: { openTime: "asc" },
    select: { openTime: true, open: true, high: true, low: true, close: true, closed: true },
  });
  return candle;
}

async function findSubsequentClosedCandles(marketId: number, timeframe: string, entryTime: Date, take = 500) {
  const candles = await prisma.candle.findMany({
    where: {
      marketId,
      timeframe,
      openTime: { gt: entryTime },
      closed: true,
    },
    orderBy: { openTime: "asc" },
    take,
    select: { openTime: true, open: true, high: true, low: true, close: true },
  });
  return candles as CandleForOutcome[];
}

function buildMinimalCandidateFromSignal(signal: any, outcome: any): SmartMoneySignalCandidate | null {
  // Need direction, timeframe, signalCandleTime, atrAtSignal, executionParams, executionPolicy
  if (!signal.signalCandleTime) return null;
  if (!signal.direction || (signal.direction !== "LONG" && signal.direction !== "SHORT")) return null;
  const tf = signal.timeframe as SmcTimeframe;
  if (!tf) return null;

  const atr = signal.atrAtSignal ?? outcome.atrAtSignal ?? null;
  const execParams = outcome.executionParams ?? signal.metadata?.executionParams ?? { version: 1, stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4.0, timeoutCandles: null };
  const execPolicy = signal.executionPolicy ?? outcome.executionPolicy ?? "SMC_ATR_V1";

  // Minimal candidate for outcome functions
  const candidate = {
    strategyId: signal.strategyId,
    symbol: signal.symbol,
    timeframe: tf,
    signalCandleTime: signal.signalCandleTime,
    direction: signal.direction,
    score: signal.score,
    longScore: null,
    shortScore: null,
    referenceExchange: signal.referenceExchange,
    referencePrice: signal.referencePrice ?? null,
    aggregatePrice: signal.aggregatePrice ?? null,
    referenceFallback: signal.referenceFallback ?? false,
    entry: null,
    entryTime: null,
    executionStatus: "WAITING_ENTRY" as any,
    atrAtSignal: atr,
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    takeProfit3: null,
    executionPolicy: execPolicy as any,
    executionParams: execParams as any,
    reason: signal.reason ?? "",
    metadata: signal.metadata ?? {},
    signalSource: signal.signalSource ?? "LIVE_FORWARD",
    asOf: new Date(signal.signalCandleTime.getTime() + timeframeMs(tf)),
    commonHorizon: signal.signalCandleTime,
    participantCount: signal.participantCount ?? 0,
    evaluatedCount: signal.evaluatedCount ?? 0,
    confirmationCount: signal.confirmationCount ?? 0,
    confirmationTotal: signal.confirmationTotal ?? 0,
  } as SmartMoneySignalCandidate;

  return candidate;
}

async function processPendingEntry(signal: any, outcome: any, dryRun: boolean) {
  const tf = signal.timeframe;
  const tfMs = timeframeMs(tf);
  const expectedNext = new Date(signal.signalCandleTime.getTime() + tfMs);

  console.log(`\n[ENTRY] Signal id=${signal.id} ${signal.symbol} ${tf} ${signal.direction} candle=${signal.signalCandleTime.toISOString()} expectedNext=${expectedNext.toISOString()} currentOutcome=${outcome.status}`);

  // Find asset and market
  const asset = await prisma.asset.findUnique({ where: { symbol: signal.symbol }, select: { id: true, symbol: true } });
  if (!asset) {
    console.log(`  No asset found for symbol ${signal.symbol} — skip`);
    return { action: "skip_no_asset" };
  }

  const refExchange = signal.referenceExchange || "BINANCE";
  const market = await findReferenceMarket(asset.id, refExchange);
  if (!market) {
    console.log(`  No market found for asset ${asset.symbol} exchange ${refExchange} — skip (will retry later)`);
    return { action: "skip_no_market" };
  }

  const exactCandle = await findExactNextCandle(market.id, tf, expectedNext);

  if (!exactCandle) {
    const firstAfter = await findFirstCandleAfter(market.id, tf, signal.signalCandleTime);
    if (firstAfter && firstAfter.openTime.getTime() !== expectedNext.getTime()) {
      console.log(`  GAP detected: first candle after signal is ${firstAfter.openTime.toISOString()} expected ${expectedNext.toISOString()} → ENTRY_DATA_MISSING`);
      if (dryRun) {
        console.log(`  DRY-RUN would set ENTRY_DATA_MISSING for signal ${signal.id}`);
        return { action: "would_entry_data_missing", expectedNext, firstAfter };
      }
      // Update to ENTRY_DATA_MISSING if not already
      if (outcome.status !== "ENTRY_DATA_MISSING") {
        await prisma.$transaction(async (tx: any) => {
          await tx.signal.update({
            where: { id: signal.id },
            data: { status: "ENTRY_DATA_MISSING" },
          });
          await tx.signalOutcome.update({
            where: { signalId: signal.id },
            data: { status: "ENTRY_DATA_MISSING" },
          });
        });
        console.log(`  Updated to ENTRY_DATA_MISSING`);
        return { action: "set_entry_data_missing" };
      }
      return { action: "already_entry_data_missing" };
    }
    console.log(`  Exact next candle not yet available (expected ${expectedNext.toISOString()}) — remain WAITING_ENTRY`);
    return { action: "remain_waiting" };
  }

  console.log(`  Exact next candle FOUND: openTime=${exactCandle.openTime.toISOString()} open=${exactCandle.open} closed=${exactCandle.closed} high=${exactCandle.high} low=${exactCandle.low} close=${exactCandle.close}`);

  // ATR frozen check
  const atr = signal.atrAtSignal ?? outcome.atrAtSignal;
  if (atr === null || atr === undefined) {
    console.log(`  ATR missing (signal.atrAtSignal=${signal.atrAtSignal} outcome.atrAtSignal=${outcome.atrAtSignal}) — fail closed → ENTRY_DATA_MISSING`);
    if (dryRun) {
      console.log(`  DRY-RUN would set ENTRY_DATA_MISSING due to missing ATR`);
      return { action: "would_entry_data_missing_atr" };
    }
    await prisma.$transaction(async (tx: any) => {
      await tx.signal.update({ where: { id: signal.id }, data: { status: "ENTRY_DATA_MISSING" } });
      await tx.signalOutcome.update({ where: { signalId: signal.id }, data: { status: "ENTRY_DATA_MISSING" } });
    });
    return { action: "set_entry_data_missing_atr" };
  }

  // Build candidate for buildInitialOutcome
  const candidate = buildMinimalCandidateFromSignal(signal, outcome);
  if (!candidate) {
    console.log(`  Cannot build candidate from signal — skip`);
    return { action: "skip_cannot_build_candidate" };
  }

  const initial = buildInitialOutcome({ candidate: candidate as any, nextBar: exactCandle as any });
  console.log(`  buildInitialOutcome → status=${initial.status} entry=${initial.entryPrice} SL=${initial.stopLoss} TP1=${initial.takeProfit1} TP2=${initial.takeProfit2} TP3=${initial.takeProfit3}`);

  if (initial.status !== "OPEN") {
    console.log(`  Initial outcome not OPEN (status=${initial.status}) — set accordingly`);
    if (dryRun) {
      console.log(`  DRY-RUN would set status ${initial.status}`);
      return { action: `would_${initial.status}`, initial };
    }
    await prisma.$transaction(async (tx: any) => {
      await tx.signal.update({
        where: { id: signal.id },
        data: {
          status: initial.status === "OPEN" ? "ACTIVE" : initial.status,
          entry: initial.entryPrice,
          stopLoss: initial.stopLoss,
          takeProfit1: initial.takeProfit1,
          takeProfit2: initial.takeProfit2,
          takeProfit3: initial.takeProfit3,
          nextBarOpenPrice: initial.entryPrice,
          nextBarOpenTime: initial.entryTime,
        },
      });
      await tx.signalOutcome.update({
        where: { signalId: signal.id },
        data: {
          status: initial.status,
          entryTime: initial.entryTime,
          entryPrice: initial.entryPrice,
          stopLoss: initial.stopLoss,
          takeProfit1: initial.takeProfit1,
          takeProfit2: initial.takeProfit2,
          takeProfit3: initial.takeProfit3,
          executionPolicy: initial.executionPolicy,
          executionParams: initial.executionParams as any,
          atrAtSignal: initial.atrAtSignal,
          timeoutCandles: initial.timeoutCandles,
        },
      });
    });
    return { action: `set_${initial.status}`, initial };
  }

  // Promotion WAITING_ENTRY → OPEN atomic
  if (outcome.status === "OPEN" && outcome.entryPrice === initial.entryPrice) {
    console.log(`  Already OPEN with same entry ${outcome.entryPrice} — idempotent skip`);
    return { action: "idempotent_already_open" };
  }

  if (dryRun) {
    console.log(`  DRY-RUN would PROMOTE WAITING_ENTRY → OPEN:`);
    console.log(`    entryTime=${initial.entryTime?.toISOString()} entryPrice=${initial.entryPrice}`);
    console.log(`    SL=${initial.stopLoss} TP1=${initial.takeProfit1} TP2=${initial.takeProfit2} TP3=${initial.takeProfit3} ATR=${initial.atrAtSignal}`);
    return { action: "would_promote_open", initial, exactCandle };
  }

  console.log(`  PROMOTING WAITING_ENTRY → OPEN atomically (Signal+Outcome)`);
  await prisma.$transaction(async (tx: any) => {
    await tx.signal.update({
      where: { id: signal.id },
      data: {
        status: "ACTIVE",
        entry: initial.entryPrice,
        stopLoss: initial.stopLoss,
        takeProfit1: initial.takeProfit1,
        takeProfit2: initial.takeProfit2,
        takeProfit3: initial.takeProfit3,
        nextBarOpenPrice: initial.entryPrice,
        nextBarOpenTime: initial.entryTime,
      },
    });
    await tx.signalOutcome.update({
      where: { signalId: signal.id },
      data: {
        status: "OPEN",
        entryTime: initial.entryTime,
        entryPrice: initial.entryPrice,
        stopLoss: initial.stopLoss,
        takeProfit1: initial.takeProfit1,
        takeProfit2: initial.takeProfit2,
        takeProfit3: initial.takeProfit3,
        executionPolicy: initial.executionPolicy,
        executionParams: initial.executionParams as any,
        atrAtSignal: initial.atrAtSignal,
        timeoutCandles: initial.timeoutCandles,
        maxFavorableR: 0,
        maxAdverseR: 0,
        barsHeld: 0,
      },
    });
  });
  console.log(`  PROMOTED to OPEN`);
  return { action: "promoted_open", initial };
}

async function processProgression(signal: any, outcome: any, dryRun: boolean) {
  console.log(`\n[PROGRESSION] Signal id=${signal.id} ${signal.symbol} ${signal.timeframe} ${signal.direction} outcome=${outcome.status} entry=${outcome.entryPrice} @ ${outcome.entryTime?.toISOString()}`);

  if (TERMINAL_STATUSES.has(outcome.status)) {
    console.log(`  Terminal status ${outcome.status} — immutable skip`);
    return { action: "skip_terminal" };
  }

  if (!outcome.entryTime || !outcome.entryPrice) {
    console.log(`  No entryTime/entryPrice in outcome — cannot progress — skip`);
    return { action: "skip_no_entry" };
  }

  const asset = await prisma.asset.findUnique({ where: { symbol: signal.symbol }, select: { id: true } });
  if (!asset) {
    console.log(`  No asset — skip`);
    return { action: "skip_no_asset" };
  }
  const refExchange = signal.referenceExchange || outcome.referenceExchange || "BINANCE";
  const market = await findReferenceMarket(asset.id, refExchange);
  if (!market) {
    console.log(`  No market — skip`);
    return { action: "skip_no_market" };
  }

  const subsequent = await findSubsequentClosedCandles(market.id, signal.timeframe, outcome.entryTime, 500);
  console.log(`  Found ${subsequent.length} subsequent CLOSED candles after entry`);

  if (subsequent.length === 0) {
    console.log(`  No subsequent candles — remain ${outcome.status}`);
    return { action: "remain_no_subsequent" };
  }

  const candidate = buildMinimalCandidateFromSignal(signal, outcome);
  if (!candidate) {
    console.log(`  Cannot build candidate — skip`);
    return { action: "skip_cannot_build_candidate" };
  }

  // Reconstruct OutcomeState for progression
  const outcomeState: OutcomeState = {
    status: outcome.status as any,
    entryTime: outcome.entryTime,
    entryPrice: outcome.entryPrice,
    stopLoss: outcome.stopLoss,
    takeProfit1: outcome.takeProfit1,
    takeProfit2: outcome.takeProfit2,
    takeProfit3: outcome.takeProfit3,
    exitTime: outcome.exitTime ?? null,
    exitPrice: outcome.exitPrice ?? null,
    realizedR: outcome.realizedR ?? null,
    maxFavorableR: outcome.maxFavorableR ?? null,
    maxAdverseR: outcome.maxAdverseR ?? null,
    barsHeld: outcome.barsHeld ?? null,
    tp1HitAt: outcome.tp1HitAt ?? null,
    tp2HitAt: outcome.tp2HitAt ?? null,
    tp3HitAt: outcome.tp3HitAt ?? null,
    executionPolicy: outcome.executionPolicy ?? "SMC_ATR_V1",
    executionParams: outcome.executionParams ?? candidate.executionParams,
    atrAtSignal: outcome.atrAtSignal ?? candidate.atrAtSignal,
    timeoutCandles: outcome.timeoutCandles ?? null,
  };

  const progressed = evaluateOutcomeProgression(outcomeState, candidate as any, subsequent);

  console.log(`  evaluateOutcomeProgression: ${outcome.status} → ${progressed.status} barsHeld=${progressed.barsHeld} tp1HitAt=${progressed.tp1HitAt?.toISOString()} tp2HitAt=${progressed.tp2HitAt?.toISOString()} tp3HitAt=${progressed.tp3HitAt?.toISOString()} exit=${progressed.exitPrice} R=${progressed.realizedR}`);

  if (progressed.status === outcome.status &&
      progressed.tp1HitAt?.getTime() === outcome.tp1HitAt?.getTime() &&
      progressed.tp2HitAt?.getTime() === outcome.tp2HitAt?.getTime() &&
      progressed.tp3HitAt?.getTime() === outcome.tp3HitAt?.getTime()) {
    console.log(`  No change — idempotent skip`);
    return { action: "idempotent_no_change", progressed };
  }

  if (dryRun) {
    console.log(`  DRY-RUN would update outcome ${outcome.status} → ${progressed.status}`);
    return { action: `would_${progressed.status}`, progressed };
  }

  await prisma.signalOutcome.update({
    where: { signalId: signal.id },
    data: {
      status: progressed.status,
      exitTime: progressed.exitTime,
      exitPrice: progressed.exitPrice,
      realizedR: progressed.realizedR,
      maxFavorableR: progressed.maxFavorableR,
      maxAdverseR: progressed.maxAdverseR,
      barsHeld: progressed.barsHeld,
      tp1HitAt: progressed.tp1HitAt,
      tp2HitAt: progressed.tp2HitAt,
      tp3HitAt: progressed.tp3HitAt,
      stopLoss: progressed.stopLoss,
      takeProfit1: progressed.takeProfit1,
      takeProfit2: progressed.takeProfit2,
      takeProfit3: progressed.takeProfit3,
    },
  });
  console.log(`  Updated outcome to ${progressed.status}`);
  return { action: `set_${progressed.status}`, progressed };
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`=== SIGNAL OUTCOME WORKER — ${args.dryRun ? "DRY-RUN" : "LIVE"} once=${args.once} batchSize=${args.batchSize} signalId=${args.signalId ?? "all"} ===`);

  // Advisory lock
  let lockHandle: any = null;
  try {
    const { acquireDedicatedLock } = await import("../lib/ohlcv/lock");
    lockHandle = await acquireDedicatedLock(OUTCOME_LOCK_KEY);
    if (!lockHandle) {
      console.error(`Single-instance guard: outcome tracker already running (lock ${OUTCOME_LOCK_KEY} held) — refusing overlapping`);
      process.exit(1);
    }
    console.log(`Advisory lock ${OUTCOME_LOCK_KEY} acquired`);
  } catch (e) {
    console.error(`Lock error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }

  try {
    if (args.signalId) {
      // Single signal diagnostics
      const signal = await prisma.signal.findUnique({
        where: { id: args.signalId },
        include: { outcome: true },
      });
      if (!signal) {
        console.log(`Signal id=${args.signalId} not found`);
        process.exit(0);
      }
      console.log(`\n--- SIGNAL id=${signal.id} ---`);
      console.log(`symbol=${signal.symbol} tf=${signal.timeframe} dir=${signal.direction} score=${signal.score} status=${signal.status} signalCandleTime=${signal.signalCandleTime?.toISOString()} ref=${signal.referenceExchange} policy=${signal.executionPolicy} entry=${signal.entry} atr=${signal.atrAtSignal}`);
      console.log(`outcome=${signal.outcome ? `${signal.outcome.status} entry=${signal.outcome.entryPrice} SL=${signal.outcome.stopLoss} TP1=${signal.outcome.takeProfit1}` : "none"}`);
      console.log(`metadata=${JSON.stringify(signal.metadata ?? {}, null, 2).slice(0, 1000)}`);

      if (!signal.signalCandleTime) {
        console.log(`LEGACY signal without signalCandleTime — ignored (no auto mutation)`);
        process.exit(0);
      }
      if (!isSupportedPolicy(signal.executionPolicy as any)) {
        console.log(`Unsupported executionPolicy ${signal.executionPolicy} — LEGACY ignored`);
        process.exit(0);
      }

      const outcome = signal.outcome;
      if (!outcome) {
        console.log(`No outcome row — cannot track (LEGACY without outcome ignored)`);
        process.exit(0);
      }

      if ((PENDING_ENTRY_STATUSES as readonly string[]).includes(outcome.status)) {
        await processPendingEntry(signal, outcome, args.dryRun);
      } else if ((NON_TERMINAL_STATUSES as readonly string[]).includes(outcome.status as any) || outcome.status === "OPEN") {
        await processProgression(signal, outcome, args.dryRun);
      } else {
        console.log(`Outcome status ${outcome.status} terminal or not tracked — skip`);
      }
    } else {
      // Batch pending entry
      console.log(`\n--- Phase 1: WAITING_ENTRY / ENTRY_DATA_MISSING → OPEN ---`);
      const pendingEntries = await prisma.signalOutcome.findMany({
        where: {
          status: { in: [...PENDING_ENTRY_STATUSES] as any },
          signal: {
            signalCandleTime: { not: null },
            executionPolicy: { not: null },
          },
        },
        include: { signal: true },
        take: args.batchSize,
        orderBy: { signalId: "asc" },
      });

      console.log(`Found ${pendingEntries.length} pending entry outcomes`);

      let promoted = 0;
      for (const row of pendingEntries) {
        const sig = (row as any).signal;
        if (!sig) continue;
        if (!isSupportedPolicy(sig.executionPolicy as any)) {
          console.log(`Skip signal id=${sig.id} unsupported policy ${sig.executionPolicy} (LEGACY ignored)`);
          continue;
        }
        if (!sig.signalCandleTime) {
          console.log(`Skip signal id=${sig.id} no signalCandleTime (LEGACY)`);
          continue;
        }
        const res = await processPendingEntry(sig, row, args.dryRun);
        if (res.action === "promoted_open") promoted++;
      }
      console.log(`Phase 1 done: promoted ${promoted}/${pendingEntries.length}`);

      // Phase 2: progression
      console.log(`\n--- Phase 2: OPEN / TP1_HIT / TP2_HIT → progression ---`);
      const openOutcomes = await prisma.signalOutcome.findMany({
        where: {
          status: { in: [...NON_TERMINAL_STATUSES, "OPEN"] as any },
          signal: {
            signalCandleTime: { not: null },
          },
        },
        include: { signal: true },
        take: args.batchSize,
        orderBy: { signalId: "asc" },
      });

      console.log(`Found ${openOutcomes.length} open outcomes for progression`);

      let progressedCount = 0;
      for (const row of openOutcomes) {
        const sig = (row as any).signal;
        if (!sig) continue;
        if (!isSupportedPolicy(sig.executionPolicy as any) && !isSupportedPolicy(row.executionPolicy as any)) {
          console.log(`Skip signal id=${sig.id} unsupported policy`);
          continue;
        }
        const res = await processProgression(sig, row, args.dryRun);
        if (res.action.startsWith("set_")) progressedCount++;
      }
      console.log(`Phase 2 done: progressed ${progressedCount}/${openOutcomes.length}`);
    }

    console.log(`\n=== OUTCOME WORKER DONE ===`);
  } catch (e) {
    console.error(`Worker failed: ${e instanceof Error ? e.message : String(e)}`);
    console.error((e as Error).stack);
    process.exitCode = 1;
  } finally {
    try {
      const { releaseDedicatedLock } = await import("../lib/ohlcv/lock");
      await releaseDedicatedLock(lockHandle);
      console.log(`Lock ${OUTCOME_LOCK_KEY} released`);
    } catch {}
    await prisma.$disconnect();
  }
}

main();
