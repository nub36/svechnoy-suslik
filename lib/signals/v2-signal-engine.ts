/**
 * Smart Money V2 Signal Engine — reference market BINANCE BTC/USDT CLOSED 15m only
 * - No 3/5 exchange voting as directional confirmation
 * - V2 determines LONG/SHORT itself via evaluateV2WithCandles
 * - Independent StrategySignalState via strategyId
 * - EDGE/HOLD/REARM/REVERSAL lifecycle reused from edge-state-machine
 * - Signal persistence isolated: V2 signal only -> save V2, V1 signal only -> save V1, both same or conflicting -> save BOTH (different strategyId, unique constraint per strategyId)
 * - No dedup against V1
 * - AND guard for writes, strict atomicity Signal+Outcome+State
 */

import { prisma } from '../prisma';
import { isSmcTimeframe, SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from '../smc/types';
import { normalizeV2Config, type SmartMoneyV2Config } from '../strategies/smart-money-v2';
import { evaluateV2WithCandles } from '../strategies/smart-money-v2';
import { computeEdgeTransition, type AggregateState } from './edge-state-machine';
import { buildSetupKeyFromCandidate } from './setup-key';

type V2EngineResult = {
  evaluatedMarkets: number;
  signalsCreated: number;
  signalsSkippedDuplicate: number;
  neutralGroups: number;
  longSignals: number;
  shortSignals: number;
  errors: string[];
};

function isUnavailableStatus(s: string | null | undefined): boolean {
  if (!s) return false;
  const u = s.toUpperCase();
  return u.includes('CANNOT') || u.includes('DATA_UNAVAILABLE') || u.includes('QUORUM') || u.includes('FUTURE') || u.includes('STALE');
}
function isEvaluableAggregate(a: AggregateState): boolean {
  return a === 'NEUTRAL' || a === 'LONG' || a === 'SHORT';
}

export async function runSmartMoneyV2Engine(opts: {
  timeframe: string;
  dryRun: boolean;
  symbol: string;
  strategies: any[];
  result: V2EngineResult;
  enableSmartMoneyWrite?: boolean;
  emitOnBootstrap?: boolean;
}): Promise<void> {
  const { timeframe, dryRun, symbol, strategies, result, enableSmartMoneyWrite, emitOnBootstrap } = opts;

  if (!isSmcTimeframe(timeframe)) {
    result.errors.push(`Timeframe ${timeframe} not in SMC whitelist`);
    return;
  }
  const tf = timeframe as SmcTimeframe;

  let strategy = strategies.find((s: any) => s.slug === 'smart-money-v2');
  if (!strategy) {
    const anyV2 = await prisma.strategy.findFirst({
      where: { slug: 'smart-money-v2' },
      orderBy: { version: 'desc' },
    });
    if (!anyV2) {
      result.errors.push('Strategy smart-money-v2 not found — need seed-smart-money-v2');
      return;
    }
    strategy = anyV2 as any;
    console.log(`  Using fallback V2 strategy id=${strategy.id} slug=${strategy.slug} enabled=${strategy.enabled} mode=${(strategy as any).mode} status=${strategy.status}`);
  }

  console.log(`\nStrategy ${strategy.slug} v${strategy.version} id=${strategy.id} mode=${(strategy as any).mode} timeframes=${strategy.timeframes.join(',')}`);

  if (!strategy.timeframes.includes(timeframe)) {
    console.log(`  Skipped timeframe ${timeframe} not in strategy timeframes ${strategy.timeframes.join(',')}`);
    result.errors.push(`Timeframe ${timeframe} not in strategy timeframes`);
    return;
  }

  const rawConfig = strategy.config;
  const v2Config: SmartMoneyV2Config = normalizeV2Config(rawConfig);

  if (v2Config.mode === 'LIVE') {
    result.errors.push('V2 mode LIVE blocked per task — use DISABLED/DRY_RUN/FORWARD_TEST');
    return;
  }
  if (v2Config.referenceExchange !== 'BINANCE') {
    console.log(`  WARNING: V2 referenceExchange is ${v2Config.referenceExchange}, expected BINANCE per task, but will use ${v2Config.referenceExchange}`);
  }
  if (v2Config.symbol !== symbol) {
    console.log(`  Note: V2 config symbol ${v2Config.symbol} vs requested ${symbol}, using requested ${symbol}`);
  }

  console.log(`  V2 Config: minScore=${v2Config.minimumSignalScore} ref=${v2Config.referenceExchange} ${v2Config.symbol} ${v2Config.timeframe} trend=${v2Config.trend.mode} policy=${v2Config.trend.policy} confirmations enabled=${Object.values(v2Config.confirmations).filter(c=>c.enabled).length}`);

  const asset = await prisma.asset.findUnique({
    where: { symbol },
    select: { id: true, symbol: true, rank: true },
  });
  if (!asset) {
    result.errors.push(`Asset ${symbol} not found`);
    return;
  }

  const referenceMarket = await prisma.market.findFirst({
    where: {
      assetId: asset.id,
      exchange: v2Config.referenceExchange,
      quote: 'USDT',
      marketType: 'SPOT',
      status: 'ACTIVE',
      enabled: true,
    },
    orderBy: { exchange: 'asc' },
    select: { id: true, exchange: true, exchangeSymbol: true, quoteVolume24h: true },
  });

  if (!referenceMarket) {
    result.errors.push(`Reference market not found for ${v2Config.referenceExchange} ${symbol}/USDT SPOT ACTIVE`);
    return;
  }

  console.log(`  Reference market: ${referenceMarket.exchange} ${referenceMarket.exchangeSymbol} id=${referenceMarket.id}`);

  const rows = await prisma.candle.findMany({
    where: { marketId: referenceMarket.id, timeframe, closed: true },
    orderBy: { openTime: 'desc' },
    take: 500,
    select: { openTime: true, open: true, high: true, low: true, close: true, closed: true },
  });
  rows.reverse();
  const candles: SmcRawCandle[] = rows.map((r: any) => ({
    openTime: r.openTime,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    closed: r.closed,
  }));

  console.log(`  Loaded ${candles.length} CLOSED ${timeframe} candles for reference ${referenceMarket.exchange}`);

  if (candles.length === 0) {
    result.errors.push(`No CLOSED candles for reference market ${referenceMarket.exchange} ${timeframe}`);
    return;
  }

  let htfCandles: SmcRawCandle[] | undefined = undefined;
  if (v2Config.trend.enabled && (v2Config.trend.mode === 'HTF' || v2Config.trend.mode === 'COMBINED')) {
    const htfTf = v2Config.trend.htfTimeframe;
    const htfRows = await prisma.candle.findMany({
      where: { marketId: referenceMarket.id, timeframe: htfTf, closed: true },
      orderBy: { openTime: 'desc' },
      take: 500,
      select: { openTime: true, open: true, high: true, low: true, close: true, closed: true },
    });
    htfRows.reverse();
    htfCandles = htfRows.map((r: any) => ({
      openTime: r.openTime,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      closed: r.closed,
    }));
    console.log(`  Loaded ${htfCandles!.length} HTF ${htfTf} candles for trend`);
  }

  const now = new Date();
  const evalResult = evaluateV2WithCandles(candles, v2Config, now, htfCandles);

  let currentAggregate: AggregateState;
  let currentCandleTime: Date | null = null;
  let v2Eval: any = null;

  if ('error' in evalResult) {
    console.log(`  V2 evaluation error: ${evalResult.error}`);
    currentAggregate = 'CANNOT_EVALUATE';
    currentCandleTime = candles[candles.length - 1]?.openTime ?? now;
  } else {
    v2Eval = evalResult;
    currentCandleTime = evalResult.candleTime;
    if (evalResult.direction === 'LONG') currentAggregate = 'LONG';
    else if (evalResult.direction === 'SHORT') currentAggregate = 'SHORT';
    else currentAggregate = 'NEUTRAL';
    console.log(`  V2 eval: dir=${evalResult.direction} longScore=${evalResult.longScore} shortScore=${evalResult.shortScore} met=${evalResult.metConfirmations}/${evalResult.totalConfirmations} independent ${evalResult.independentMet}/${evalResult.independentTotal} trend=${evalResult.trendContext.mode} ${evalResult.trendContext.direction} boost=${evalResult.trendContext.boost}`);
    const confStr = evalResult.confirmations.map((c: any) => `${c.code}(${c.v2Key}) L${c.longPoints} S${c.shortPoints} ${c.enabled ? 'on' : 'off'} ${c.category}`).join(', ');
    console.log(`  Confirmations: ${confStr}`);
  }

  let stateRow: any = null;
  try {
    stateRow = await prisma.strategySignalState.findUnique({
      where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } },
    });
  } catch (e: any) {
    console.log(`  StrategySignalState table not exists yet — fail-closed for live, in-memory for dry-run`);
    stateRow = null;
  }

  console.log(`\n=== V2 EDGE STATE MACHINE ===`);
  console.log(`Previous: ${stateRow ? `${stateRow.aggregateState} lastEval=${stateRow.lastEvaluatedCandleTime?.toISOString()} lastSignal=${stateRow.lastSignalCandleTime?.toISOString()} ${stateRow.lastSignalDirection}` : 'null (bootstrap)'}`);
  console.log(`Current: ${currentAggregate} candle=${currentCandleTime?.toISOString()}`);

  const transition = computeEdgeTransition({
    previousStateRow: stateRow ? {
      strategyId: stateRow.strategyId,
      symbol: stateRow.symbol,
      timeframe: stateRow.timeframe,
      lastEvaluatedCandleTime: stateRow.lastEvaluatedCandleTime,
      aggregateState: stateRow.aggregateState,
      lastSignalCandleTime: stateRow.lastSignalCandleTime,
      lastSignalDirection: stateRow.lastSignalDirection,
      lastEvaluationStatus: stateRow.lastEvaluationStatus,
    } : null,
    currentAggregate,
    currentCandleTime: currentCandleTime || now,
    emitOnBootstrap: emitOnBootstrap || false,
  });

  console.log(`Transition: ${transition.previousState ?? 'null'} -> ${transition.currentAggregate} action=${transition.action} shouldEmit=${transition.shouldEmit} emitDir=${transition.emitDirection} trigger=${transition.triggerType} reason=${transition.reason}`);

  result.evaluatedMarkets = 1;

  const flagEnabled = enableSmartMoneyWrite === true;
  const envEnabled = process.env.SMART_MONEY_WRITE_ENABLED === 'true' || process.env.SMART_MONEY_V2_WRITE_ENABLED === 'true';
  const writeAllowed = flagEnabled && envEnabled;

  console.log(`\n=== V2 WRITE GUARD AND === flag=${flagEnabled} env=${envEnabled} => allowed=${writeAllowed} mode=${v2Config.mode}`);

  if (v2Config.mode === 'DISABLED') {
    console.log(`V2 mode DISABLED — no signal emission even if EDGE, only state would be updated in LIVE but currently blocked (first deliverable NOT LIVE)`);
    if (dryRun) {
      console.log(`DRY-RUN: would ${transition.shouldEmit ? 'EMIT' : 'update state to ' + currentAggregate}`);
      if (transition.shouldEmit) {
        result.signalsCreated++;
        if (transition.emitDirection === 'LONG') result.longSignals++;
        else result.shortSignals++;
      } else {
        result.neutralGroups++;
      }
      return;
    }
    console.log(`WRITE BLOCKED — V2 DISABLED mode, forcing dry-run`);
    result.neutralGroups++;
    return;
  }

  if (transition.action === 'NOOP_SAME_HORIZON') {
    console.log(`Idempotent no-op same horizon`);
    result.signalsSkippedDuplicate++;
    return;
  }
  if (transition.action === 'REFUSE_OLDER_HORIZON') {
    console.log(`Refuse older horizon`);
    result.errors.push(`Refuse older horizon ${transition.currentCandleTime.toISOString()}`);
    return;
  }
  if (transition.action === 'PRESERVE_UNAVAILABLE') {
    console.log(`Preserve unavailable ${currentAggregate}`);
    if (dryRun) {
      console.log(`DRY-RUN — would preserve`);
      result.neutralGroups++;
      return;
    }
    if (!writeAllowed) {
      console.log(`WRITE BLOCKED — dry-run forced`);
      result.neutralGroups++;
      return;
    }
    try {
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.strategySignalState.findUnique({ where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } } });
        if (existing) {
          if (existing.lastEvaluatedCandleTime && existing.lastEvaluatedCandleTime.getTime() === transition.currentCandleTime.getTime()) return;
          if (existing.lastEvaluatedCandleTime && transition.currentCandleTime.getTime() < existing.lastEvaluatedCandleTime.getTime()) throw new Error('Refuse older horizon in tx');
          await tx.strategySignalState.update({
            where: { id: existing.id },
            data: {
              lastEvaluatedCandleTime: transition.currentCandleTime,
              lastEvaluationStatus: currentAggregate,
              metadata: { lastReason: transition.reason, lastAction: transition.action, v2: true } as any,
            },
          });
        } else {
          await tx.strategySignalState.create({
            data: {
              strategyId: strategy.id,
              symbol,
              timeframe,
              lastEvaluatedCandleTime: transition.currentCandleTime,
              aggregateState: 'NEUTRAL',
              lastEvaluationStatus: currentAggregate,
              metadata: { bootstrapFromUnavailable: true, lastReason: transition.reason, v2: true } as any,
            },
          });
        }
      });
      result.neutralGroups++;
    } catch (e: any) {
      console.error(`  Error preserving: ${e.message}`);
      result.errors.push(`Preserve error: ${e.message}`);
    }
    return;
  }

  if (!transition.shouldEmit) {
    console.log(`\nNo emit action=${transition.action}`);
    if (dryRun) {
      console.log(`DRY-RUN — would update state to ${currentAggregate}`);
      result.neutralGroups++;
      return;
    }
    if (!writeAllowed) {
      console.log(`WRITE BLOCKED`);
      result.neutralGroups++;
      return;
    }
    try {
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.strategySignalState.findUnique({ where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } } });
        if (existing) {
          if (existing.lastEvaluatedCandleTime && existing.lastEvaluatedCandleTime.getTime() === transition.currentCandleTime.getTime()) {
            const prevWasUnavailable = isUnavailableStatus(existing.lastEvaluationStatus);
            const currIsEvaluable = isEvaluableAggregate(currentAggregate);
            if (prevWasUnavailable && currIsEvaluable) {
              // allow re-evaluate
            } else {
              return;
            }
          }
          if (existing.lastEvaluatedCandleTime && transition.currentCandleTime.getTime() < existing.lastEvaluatedCandleTime.getTime()) throw new Error('Refuse older horizon');
          await tx.strategySignalState.update({
            where: { id: existing.id },
            data: {
              lastEvaluatedCandleTime: transition.currentCandleTime,
              aggregateState: currentAggregate,
              lastEvaluationStatus: currentAggregate,
              metadata: { lastReason: transition.reason, lastAction: transition.action, v2: true } as any,
            },
          });
        } else {
          await tx.strategySignalState.create({
            data: {
              strategyId: strategy.id,
              symbol,
              timeframe,
              lastEvaluatedCandleTime: transition.currentCandleTime,
              aggregateState: currentAggregate,
              lastEvaluationStatus: currentAggregate,
              metadata: { lastReason: transition.reason, lastAction: transition.action, v2: true } as any,
            },
          });
        }
      });
      console.log(`  State updated to ${currentAggregate}`);
      result.neutralGroups++;
    } catch (e: any) {
      console.error(`  Error updating state: ${e.message}`);
      result.errors.push(`State update error: ${e.message}`);
    }
    return;
  }

  if (!v2Eval) {
    console.log(`  Inconsistent emit without eval`);
    result.errors.push('Emit true but no eval');
    return;
  }

  const atr = (() => {
    if (candles.length < 15) return 100;
    let trSum = 0;
    for (let i = candles.length - 14; i < candles.length; i++) {
      const c = candles[i];
      const prev = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
      trSum += tr;
    }
    return trSum / 14;
  })();

  const direction = v2Eval.direction as 'LONG' | 'SHORT';
  const price = v2Eval.price;

  let stopLoss: number | null = null;
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;

  if (direction === 'LONG') {
    stopLoss = price - atr * v2Config.atr.stopMultiplier;
    tp1 = price + atr * v2Config.atr.takeProfit1Multiplier;
    tp2 = price + atr * v2Config.atr.takeProfit2Multiplier;
    tp3 = price + atr * v2Config.atr.takeProfit3Multiplier;
  } else if (direction === 'SHORT') {
    stopLoss = price + atr * v2Config.atr.stopMultiplier;
    tp1 = price - atr * v2Config.atr.takeProfit1Multiplier;
    tp2 = price - atr * v2Config.atr.takeProfit2Multiplier;
    tp3 = price - atr * v2Config.atr.takeProfit3Multiplier;
  }

  const score = direction === 'LONG' ? v2Eval.longScore : v2Eval.shortScore;
  const confirmationCount = v2Eval.metConfirmations;
  const confirmationTotal = v2Eval.totalConfirmations;

  const confFiltered = v2Eval.confirmations.filter((c: any) => c.longPoints > 0 || c.shortPoints > 0).map((c: any) => `[${c.code}:${c.v2Key}]`).join(';');
  const reason = `V2 ${v2Config.trend.mode} ${v2Config.trend.policy} dir=${direction} score=${score} conf ${confirmationCount}/${confirmationTotal} independent ${v2Eval.independentMet}/${v2Eval.independentTotal} trend=${v2Eval.trendContext.direction} boost=${v2Eval.trendContext.boost} | ${confFiltered} | ref ${v2Config.referenceExchange} price ${price}`;

  const candidateForSetup = {
    strategyId: strategy.id,
    symbol,
    timeframe: tf,
    signalCandleTime: currentCandleTime!,
    direction,
    score,
    referenceExchange: v2Config.referenceExchange,
    referencePrice: price,
    metadata: {
      v2: true,
      trendMode: v2Config.trend.mode,
      trendPolicy: v2Config.trend.policy,
      confirmations: v2Eval.confirmations,
      independentMet: v2Eval.independentMet,
      independentTotal: v2Eval.independentTotal,
      derivedTotal: v2Eval.derivedTotal,
      contextTotal: v2Eval.contextTotal,
    },
  } as any;

  const setupKey = buildSetupKeyFromCandidate(candidateForSetup, strategy.version);

  console.log(`\n=== V2 CANDIDATE FOR EMIT (${transition.triggerType}) ===`);
  console.log(`candle=${currentCandleTime?.toISOString()} dir=${direction} score=${score} setupKey=${setupKey.slice(0,80)}...`);
  console.log(`ref=${v2Config.referenceExchange} price=${price} atr=${atr.toFixed(2)} SL~${stopLoss?.toFixed(2)} TP1~${tp1?.toFixed(2)}`);

  if (dryRun) {
    console.log(`\nDRY-RUN — would EMIT ${direction} trigger ${transition.triggerType} at ${currentCandleTime?.toISOString()} but persist nothing`);
    result.signalsCreated++;
    if (direction === 'LONG') result.longSignals++;
    else result.shortSignals++;
    return;
  }

  if (!writeAllowed) {
    console.log(`\nWRITE BLOCKED — need BOTH --enable-smart-money-write AND SMART_MONEY_V2_WRITE_ENABLED=true`);
    result.signalsCreated++;
    if (direction === 'LONG') result.longSignals++;
    else result.shortSignals++;
    return;
  }

  console.log(`\nLIVE WRITE ALLOWED — transactional V2 emit Signal+Outcome+State`);

  try {
    await prisma.$transaction(async (tx: any) => {
      const existingState = await tx.strategySignalState.findUnique({ where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } } });
      if (existingState) {
        if (existingState.lastEvaluatedCandleTime && existingState.lastEvaluatedCandleTime.getTime() === transition.currentCandleTime.getTime()) {
          const prevWasUnavailable = isUnavailableStatus(existingState.lastEvaluationStatus);
          const currIsEvaluable = isEvaluableAggregate(currentAggregate);
          if (prevWasUnavailable && currIsEvaluable) {
            console.log(`  Same horizon but prev provisional ${existingState.lastEvaluationStatus} -> evaluable ${currentAggregate}: allowing`);
          } else {
            console.log(`  Concurrent same horizon already processed — idempotent no-op`);
            return;
          }
        }
        if (existingState.lastEvaluatedCandleTime && transition.currentCandleTime.getTime() < existingState.lastEvaluatedCandleTime.getTime()) throw new Error('Refuse older horizon inside tx');
        if (existingState.aggregateState === currentAggregate && existingState.lastSignalCandleTime && existingState.lastSignalCandleTime.getTime() === currentCandleTime!.getTime()) {
          console.log(`  Duplicate signal same candle — skip inside tx`);
          return;
        }
      }

      const created = await tx.signal.create({
        data: {
          symbol,
          timeframe,
          direction,
          score,
          entry: null,
          stopLoss: null,
          takeProfit1: null,
          takeProfit2: null,
          takeProfit3: null,
          status: 'WAITING_ENTRY',
          reason: reason.slice(0, 1000),
          strategyId: strategy.id,
          signalCandleTime: currentCandleTime,
          referenceExchange: v2Config.referenceExchange,
          referencePrice: price,
          aggregatePrice: null,
          executionPolicy: 'SMC_ATR_V1',
          signalSource: 'LIVE_FORWARD',
          metadata: {
            v2: true,
            trendMode: v2Config.trend.mode,
            trendPolicy: v2Config.trend.policy,
            confirmations: v2Eval.confirmations,
            independentMet: v2Eval.independentMet,
            independentTotal: v2Eval.independentTotal,
            derivedTotal: v2Eval.derivedTotal,
            contextTotal: v2Eval.contextTotal,
            referenceFallback: false,
            longVotes: direction === 'LONG' ? 1 : 0,
            shortVotes: direction === 'SHORT' ? 1 : 0,
            policy: 'REFERENCE_ONLY',
            triggerType: transition.triggerType,
            setupKey,
            edgeTransition: transition,
          } as any,
          atrAtSignal: atr,
          nextBarOpenPrice: null,
          nextBarOpenTime: null,
          participantCount: 1,
          evaluatedCount: 1,
          longVotes: direction === 'LONG' ? 1 : 0,
          shortVotes: direction === 'SHORT' ? 1 : 0,
          neutralVotes: 0,
          confirmationCount,
          confirmationTotal,
          commonHorizonPolicy: 'REFERENCE_ONLY',
          referenceFallback: false,
          setupKey,
          triggerType: transition.triggerType,
        },
      });
      console.log(`  CREATED V2 signal id=${created.id} ${created.direction} ${created.symbol} ${created.timeframe} candle=${created.signalCandleTime?.toISOString()} trigger=${created.triggerType}`);

      const outcome = await tx.signalOutcome.create({
        data: {
          signalId: created.id,
          status: 'WAITING_ENTRY',
          entryTime: null,
          entryPrice: null,
          stopLoss: null,
          takeProfit1: null,
          takeProfit2: null,
          takeProfit3: null,
          executionPolicy: 'SMC_ATR_V1',
          executionParams: {
            version: 1,
            stopMultiplier: v2Config.atr.stopMultiplier,
            takeProfit1Multiplier: v2Config.atr.takeProfit1Multiplier,
            takeProfit2Multiplier: v2Config.atr.takeProfit2Multiplier,
            takeProfit3Multiplier: v2Config.atr.takeProfit3Multiplier,
            timeoutCandles: null,
          } as any,
          atrAtSignal: atr,
          timeoutCandles: null,
        },
      });
      console.log(`  CREATED V2 outcome id=${outcome.id} status=${outcome.status}`);

      if (existingState) {
        await tx.strategySignalState.update({
          where: { id: existingState.id },
          data: {
            lastEvaluatedCandleTime: transition.currentCandleTime,
            aggregateState: currentAggregate,
            lastSignalCandleTime: currentCandleTime,
            lastSignalDirection: direction,
            lastEvaluationStatus: currentAggregate,
            metadata: { lastReason: transition.reason, lastAction: transition.action, lastTrigger: transition.triggerType, setupKey, v2: true } as any,
          },
        });
      } else {
        await tx.strategySignalState.create({
          data: {
            strategyId: strategy.id,
            symbol,
            timeframe,
            lastEvaluatedCandleTime: transition.currentCandleTime,
            aggregateState: currentAggregate,
            lastSignalCandleTime: currentCandleTime,
            lastSignalDirection: direction,
            lastEvaluationStatus: currentAggregate,
            metadata: { lastReason: transition.reason, lastAction: transition.action, lastTrigger: transition.triggerType, setupKey, v2: true } as any,
          },
        });
      }
      console.log(`  V2 State updated to ${currentAggregate}`);
    });

    result.signalsCreated++;
    if (direction === 'LONG') result.longSignals++;
    else result.shortSignals++;
  } catch (e: any) {
    if (e.code === 'P2002' || e.message?.includes('Unique constraint') || e.message?.includes('unique')) {
      console.log(`  Duplicate unique [strategyId,symbol,timeframe,signalCandleTime] — idempotent`);
      result.signalsSkippedDuplicate++;
    } else {
      console.error(`  V2 Transaction failed rollback: ${e.message}`);
      result.errors.push(`V2 Transaction error: ${e.message}`);
    }
  }
}
