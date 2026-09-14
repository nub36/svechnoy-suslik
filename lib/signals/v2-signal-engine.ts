/**
 * Smart Money V2 Signal Engine — BINANCE BTC/USDT CLOSED 15m ONLY
 * V2 MARKET CONTRACT:
 * - ONE reference market: BINANCE BTC/USDT 15m CLOSED candles
 * - Execution: BINANCE BTCUSDT CLOSED 15m -> V2 confirmations -> score -> direction -> V2 state machine -> optional V2 Signal
 * - NOT: 5 exchanges, eligible markets, exchange votes, quorum, minExchanges, 3/5, 5/5
 * - Do NOT use BINGX, BYBIT, GATE, KUCOIN anywhere in V2 signal decision
 * - Other exchange data may remain elsewhere in website/V1, but V2 must not load it
 *
 * V2 CONFIRMATIONS: exactly 7 logical, no double count
 * INDEPENDENT: BOS, Order Block, FVG, Liquidity Sweep, Range Position
 * DERIVED: OB+FVG Confluence (bonus 5 only, not re-adding OB/FVG weights)
 * CONTEXT: Internal Structure
 * TREND CONTEXT: MARKET_STRUCTURE/EMA/HTF/COMBINED separate
 * CHOCH/Displacement disabled
 * Exchange count NOT a confirmation
 *
 * Double counting fix: BOS internals (SWING_TREND + RECENT_SWING_BOS) aggregate into ONE BOS confirmation max once, at most BOS weight 20
 * OB internals (SWING_ORDER_BLOCK + INTERNAL_ORDER_BLOCK) aggregate into ONE OB confirmation max once, at most OB weight 20
 * Confluence only explicit derived bonus
 *
 * ONE effective mode from DB column authoritative
 * FORWARD_TEST: persist State, persist natural Signals when EDGE, Outcome tracker, /signals displays V2
 * DISABLED: no writes
 * LIVE: STILL BLOCKED
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
  }

  // ONE effective operating mode — DB column authoritative
  const dbMode = (strategy as any).mode as string;
  const rawConfig = strategy.config;
  let v2Config: SmartMoneyV2Config = normalizeV2Config(rawConfig);
  if (dbMode && ["DISABLED","DRY_RUN","FORWARD_TEST","LIVE"].includes(dbMode)) {
    (v2Config as any).mode = dbMode as any;
  }
  if (dbMode && (rawConfig as any)?.mode && dbMode !== (rawConfig as any).mode) {
    console.log(`  WARNING: DB mode ${dbMode} != config JSON mode ${(rawConfig as any).mode} — using DB mode as authoritative`);
  }

  const effectiveMode = v2Config.mode;

  // Enforce BINANCE only per V2 market contract
  if (v2Config.referenceExchange !== 'BINANCE') {
    console.log(`  V2 CONTRACT: referenceExchange ${v2Config.referenceExchange} overridden to BINANCE per V2 market contract`);
    v2Config.referenceExchange = 'BINANCE';
  }
  if (v2Config.symbol !== 'BTC') {
    console.log(`  V2 CONTRACT: symbol ${v2Config.symbol} overridden to BTC`);
    v2Config.symbol = 'BTC';
  }

  console.log(`\n=== SMART MONEY V2 ===`);
  console.log(`Strategy: smart-money-v2 v${strategy.version}`);
  console.log(`Mode: ${effectiveMode} (DB authoritative)`);
  console.log(`Reference: BINANCE BTCUSDT`);
  console.log(`Timeframe: ${timeframe}`);
  console.log(`Symbol: ${symbol}`);

  if (effectiveMode === 'LIVE') {
    result.errors.push('V2 mode LIVE blocked — use DISABLED/DRY_RUN/FORWARD_TEST, LIVE gated until research/forward validation complete');
    console.log(`LIVE BLOCKED — V2 LIVE not allowed yet`);
    return;
  }

  if (!strategy.timeframes.includes(timeframe)) {
    console.log(`  Skipped timeframe ${timeframe} not in strategy timeframes ${strategy.timeframes.join(',')}`);
    result.errors.push(`Timeframe ${timeframe} not in strategy timeframes`);
    return;
  }

  const asset = await prisma.asset.findUnique({
    where: { symbol },
    select: { id: true, symbol: true, rank: true },
  });
  if (!asset) {
    result.errors.push(`Asset ${symbol} not found`);
    return;
  }

  // V2 ONLY: BINANCE BTC/USDT SPOT ACTIVE — no other exchanges
  const referenceMarket = await prisma.market.findFirst({
    where: {
      assetId: asset.id,
      exchange: 'BINANCE',
      quote: 'USDT',
      marketType: 'SPOT',
      status: 'ACTIVE',
      enabled: true,
    },
    orderBy: { exchange: 'asc' },
    select: { id: true, exchange: true, exchangeSymbol: true, quoteVolume24h: true },
  });

  if (!referenceMarket) {
    result.errors.push(`Reference market not found for BINANCE ${symbol}/USDT SPOT ACTIVE — V2 requires BINANCE only`);
    return;
  }

  console.log(`Reference market: ${referenceMarket.exchange} ${referenceMarket.exchangeSymbol} id=${referenceMarket.id}`);

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

  if (candles.length === 0) {
    result.errors.push(`No CLOSED candles for BINANCE ${symbol} ${timeframe} — V2 requires CLOSED candles only`);
    return;
  }

  const lastCandle = candles[candles.length - 1];
  console.log(`Candle: CLOSED ${lastCandle.openTime.toISOString()}`);
  console.log(`Candles loaded: ${candles.length} CLOSED ${timeframe} BINANCE only`);

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
    console.log(`HTF Candles loaded: ${htfCandles!.length} CLOSED ${htfTf} for trend ${v2Config.trend.mode}`);
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

    console.log(`\n=== V2 ===`);
    console.log(`direction=${evalResult.direction} longScore=${evalResult.longScore} shortScore=${evalResult.shortScore} met=${evalResult.metConfirmations}/${evalResult.totalConfirmations} independent ${evalResult.independentMet}/${evalResult.independentTotal} trend=${evalResult.trendContext.mode} ${evalResult.trendContext.direction} boost=${evalResult.trendContext.boost}`);
    console.log(`Candle time: ${evalResult.candleTime.toISOString()} price=${evalResult.price}`);

    // Score breakdown proving no double counting
    console.log(`\n--- V2 Score Breakdown (no double count) ---`);
    console.log(`Total logical confirmations: ${evalResult.totalConfirmations} (BOS, ORDER_BLOCK, FVG, LIQUIDITY_SWEEP, RANGE_POSITION, CONFLUENCE, INTERNAL_STRUCTURE)`);
    console.log(`Met: ${evalResult.metConfirmations}/${evalResult.totalConfirmations}`);
    console.log(`Categories: INDEPENDENT ${evalResult.independentTotal} (BOS, OB, FVG, Sweep, Range), DERIVED ${evalResult.derivedTotal} (Confluence bonus 5 only), CONTEXT ${evalResult.contextTotal} (Internal)`);
    for (const c of evalResult.confirmations) {
      const met = c.longPoints > 0 || c.shortPoints > 0 ? 'MET' : 'not met';
      console.log(`  ${c.code}(${c.v2Key}) ${met} L${c.longPoints} S${c.shortPoints} cat=${c.category} smc=${c.smcCode || 'none'} label=${c.label}`);
    }
    // Prove BOS and OB aggregated
    const bos = evalResult.confirmations.filter((c:any)=>c.v2Key==='bos');
    const ob = evalResult.confirmations.filter((c:any)=>c.v2Key==='orderBlock');
    console.log(`BOS count: ${bos.length} (should be 1, aggregated SWING_TREND+RECENT_SWING_BOS) — ${bos.length===1?'OK no double count':'FAIL double count'}`);
    console.log(`ORDER_BLOCK count: ${ob.length} (should be 1, aggregated SWING+INTERNAL) — ${ob.length===1?'OK no double count':'FAIL double count'}`);
    const confluence = evalResult.confirmations.find((c:any)=>c.v2Key==='confluence');
    if (confluence) {
      console.log(`CONFLUENCE: L${confluence.longPoints} S${confluence.shortPoints} — should be only derived bonus 5, not re-adding OB/FVG weights — ${confluence.longPoints<=5 && confluence.shortPoints<=5 ? 'OK bonus only' : 'check bonus'}`);
    }
    console.log(`--- End Breakdown ---`);
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

  console.log(`\n=== State ===`);
  console.log(`previous=${stateRow ? `${stateRow.aggregateState} lastEval=${stateRow.lastEvaluatedCandleTime?.toISOString()} lastSignal=${stateRow.lastSignalCandleTime?.toISOString()} ${stateRow.lastSignalDirection}` : 'null (bootstrap)'}`);
  console.log(`current=${currentAggregate} candle=${currentCandleTime?.toISOString()}`);

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

  console.log(`action=${transition.action} shouldEmit=${transition.shouldEmit} emitDir=${transition.emitDirection} trigger=${transition.triggerType} reason=${transition.reason}`);
  console.log(`Transition: ${transition.previousState ?? 'null'} -> ${transition.currentAggregate}`);

  result.evaluatedMarkets = 1;

  const flagEnabled = enableSmartMoneyWrite === true;
  const envEnabled = process.env.SMART_MONEY_WRITE_ENABLED === 'true' || process.env.SMART_MONEY_V2_WRITE_ENABLED === 'true';
  const writeAllowed = flagEnabled && envEnabled;

  console.log(`\n=== V2 WRITE GUARD AND === flag=${flagEnabled} env=${envEnabled} => allowed=${writeAllowed} effectiveMode=${effectiveMode} dbMode=${dbMode} configMode=${(rawConfig as any)?.mode}`);

  if (effectiveMode === 'DISABLED') {
    console.log(`V2 mode DISABLED — no signal emission, no state persistence`);
    if (dryRun) {
      console.log(`DRY-RUN DISABLED: would ${transition.shouldEmit ? 'EMIT' : 'update state to ' + currentAggregate} but blocked`);
      if (transition.shouldEmit) {
        result.signalsCreated++;
        if (transition.emitDirection === 'LONG') result.longSignals++;
        else result.shortSignals++;
      } else {
        result.neutralGroups++;
      }
      return;
    }
    console.log(`WRITE BLOCKED — V2 DISABLED mode, state NOT persisted`);
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
    console.log(`\nNo emit action=${transition.action} — will update state to ${currentAggregate}`);
    if (dryRun) {
      console.log(`DRY-RUN — would update state to ${currentAggregate} at ${transition.currentCandleTime?.toISOString()} but persist nothing`);
      result.neutralGroups++;
      return;
    }
    if (!writeAllowed) {
      console.log(`WRITE BLOCKED — need AND guard`);
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
      console.log(`  State updated to ${currentAggregate} — ${transition.action} ${transition.reason}`);
      if (transition.action === 'BOOTSTRAP_NO_SIGNAL') {
        console.log(`  BOOTSTRAP: null -> NEUTRAL BOOTSTRAP_NO_SIGNAL — State created, 0 Signal (per V2 spec)`);
      }
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
  const reason = `V2 ${v2Config.trend.mode} ${v2Config.trend.policy} dir=${direction} score=${score} conf ${confirmationCount}/${confirmationTotal} independent ${v2Eval.independentMet}/${v2Eval.independentTotal} trend=${v2Eval.trendContext.direction} boost=${v2Eval.trendContext.boost} | ${confFiltered} | ref BINANCE price ${price}`;

  const candidateForSetup = {
    strategyId: strategy.id,
    symbol,
    timeframe: tf,
    signalCandleTime: currentCandleTime!,
    direction,
    score,
    referenceExchange: 'BINANCE',
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
  console.log(`ref=BINANCE price=${price} atr=${atr.toFixed(2)} SL~${stopLoss?.toFixed(2)} TP1~${tp1?.toFixed(2)}`);

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

  console.log(`\nLIVE WRITE ALLOWED — transactional V2 emit Signal+Outcome+State (BINANCE only)`);

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
          referenceExchange: 'BINANCE',
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
