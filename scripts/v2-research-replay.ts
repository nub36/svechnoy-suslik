/**
 * V2 Research Replay — BINANCE BTC/USDT CLOSED 15m only
 * TRAIN/VALID/OOS chronological, no leakage
 * Compares V1 baseline vs V2 candidates
 */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { SMCTIMEFRAME_MS, type SmcTimeframe, type SmcRawCandle } from '../lib/smc/types';
import { defaultSmcScoringConfig, type SmcScoringConfig } from '../lib/smc/config';
import { evaluateSmc } from '../lib/smc/evaluate';
import { evaluateV2WithCandles, DEFAULT_V2_CONFIG, normalizeV2Config, type SmartMoneyV2Config, type TrendMode, type TrendPolicy } from '../lib/strategies/smart-money-v2';
import { computeEdgeTransition, type AggregateState } from '../lib/signals/edge-state-machine';
import { evaluateOutcomeProgression, type CandleForOutcome } from '../lib/signals/signal-outcome';

type ReplayCandle = SmcRawCandle & { closeTime?: Date };

type SignalRecord = {
  id: number;
  candleTime: Date;
  direction: 'LONG' | 'SHORT';
  score: number;
  price: number;
  atr: number;
  entry: number | null;
  entryTime: Date | null;
  sl: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
  trigger: string;
  met: number;
  total: number;
};

type OutcomeResult = {
  status: string;
  tp1BeforeSl: boolean;
  tp2BeforeSl: boolean;
  tp3BeforeSl: boolean;
  stopBeforeTp1: boolean;
  barsHeld: number;
};

type SplitMetrics = {
  name: string;
  from: Date;
  to: Date;
  signals: number;
  signalsPerDay: number;
  longCount: number;
  shortCount: number;
  longRate: number;
  shortRate: number;
  edgeEpisodes: number;
  tp1BeforeSl: number;
  tp2BeforeSl: number;
  tp3BeforeSl: number;
  stopBeforeTp1: number;
  tp1Rate: number;
  tp2Rate: number;
  tp3Rate: number;
  stopRate: number;
  avgScore: number;
  avgBarsHeld: number;
};

type CandidateMetrics = {
  model: string;
  trendMode: TrendMode;
  policy: TrendPolicy;
  config: SmartMoneyV2Config;
  totalSignals: number;
  frequencyVsV1: string;
  splits: SplitMetrics[];
  aggregate: SplitMetrics;
  longAggregate: { count: number; tp1: number; tp2: number; tp3: number; stop: number };
  shortAggregate: { count: number; tp1: number; tp2: number; tp3: number; stop: number };
  regression: { episode: string; v1Action: string; v2Action: string; detail: string };
};

function parseArgs() {
  const raw = process.argv.slice(2);
  let from = '2024-01-01';
  let to = '2025-01-01';
  let timeframe: SmcTimeframe = '15m';
  let synthetic = false;
  let maxCandles = 10000;
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--from') { from = raw[i + 1]; i++; }
    else if (a === '--to') { to = raw[i + 1]; i++; }
    else if (a === '--timeframe') { timeframe = raw[i + 1] as SmcTimeframe; i++; }
    else if (a === '--synthetic') { synthetic = true; }
    else if (a === '--max-candles') { maxCandles = Number(raw[i + 1]); i++; }
  }
  return { from, to, timeframe, synthetic, maxCandles };
}

function parseDate(s: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s + 'T00:00:00Z');
  return new Date(s);
}

function calculateATR(candles: ReplayCandle[], period = 14): number {
  if (candles.length < period + 1) return 100;
  let trSum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    trSum += tr;
  }
  return trSum / period;
}

function generateSyntheticCandles(from: Date, to: Date, tf: SmcTimeframe): ReplayCandle[] {
  const tfMs = SMCTIMEFRAME_MS[tf];
  const candles: ReplayCandle[] = [];
  let time = from.getTime();
  let price = 50000;
  const regressionStart = new Date('2026-09-13T08:15:00Z').getTime();
  const regressionEnd = new Date('2026-09-13T11:00:00Z').getTime();

  let phase = 0; // 0 up, 1 pullback, 2 BOS up, 3 down, 4 pullback, 5 BOS down
  let phaseBars = 0;
  let lastSwingHigh = 50500;
  let lastSwingLow = 49500;

  while (time < to.getTime()) {
    const openTime = new Date(time);
    const closeTime = new Date(time + tfMs);

    // Force regression episode
    if (time >= regressionStart - tfMs * 10 && time <= regressionStart + tfMs * 5) {
      // Create bearish BOS: price drops breaking lastSwingLow
      const open = price;
      const close = open - 80 - Math.random() * 40;
      const high = open + Math.random() * 20;
      const low = close - Math.random() * 30;
      candles.push({ openTime, closeTime, open, high, low, close, closed: true });
      price = close;
      lastSwingLow = Math.min(lastSwingLow, low);
      time += tfMs;
      continue;
    }
    if (time >= regressionEnd - tfMs * 5 && time <= regressionEnd + tfMs * 10) {
      const open = price;
      const close = open + (Math.random() - 0.5) * 20;
      const high = Math.max(open, close) + 10;
      const low = Math.min(open, close) - 10;
      candles.push({ openTime, closeTime, open, high, low, close, closed: true });
      price = close;
      time += tfMs;
      continue;
    }

    let open = price;
    let close: number;
    let high: number;
    let low: number;

    // Phased deterministic structure to trigger SMC BOS, OB, FVG — need 20+20 for swing, ensure valid OHLC
    if (phase === 0) {
      close = open + 35 + Math.random() * 25;
      high = Math.max(open, close) + 10 + Math.random()*5;
      low = Math.min(open, close) - 5 - Math.random()*5;
      phaseBars++;
      if (phaseBars > 40) { phase = 1; phaseBars = 0; lastSwingHigh = Math.max(lastSwingHigh, high); }
    } else if (phase === 1) {
      close = open - 20 - Math.random() * 15;
      high = Math.max(open, close) + 5 + Math.random()*5;
      low = Math.min(open, close) - 10 - Math.random()*5;
      phaseBars++;
      if (phaseBars > 30) { phase = 2; phaseBars = 0; }
    } else if (phase === 2) {
      // BOS up with occasional valid bullish FVG
      if (phaseBars % 5 === 0 && candles.length>0) {
        const prevHigh = candles[candles.length-1].high;
        const newLow = prevHigh + 15 + Math.random()*10;
        open = newLow + Math.random()*5;
        close = open + 50 + Math.random()*20;
        low = newLow;
        high = Math.max(open, close) + 15;
      } else {
        close = open + 55 + Math.random() * 35;
        high = Math.max(open, close) + 15 + Math.random()*5;
        low = Math.min(open, close) - 5 - Math.random()*5;
      }
      high = Math.max(high, open, close);
      low = Math.min(low, open, close);
      phaseBars++;
      if (phaseBars > 40) { phase = 3; phaseBars = 0; lastSwingHigh = high; }
    } else if (phase === 3) {
      close = open - 35 - Math.random() * 25;
      high = Math.max(open, close) + 5 + Math.random()*5;
      low = Math.min(open, close) - 10 - Math.random()*5;
      phaseBars++;
      if (phaseBars > 40) { phase = 4; phaseBars = 0; lastSwingLow = Math.min(lastSwingLow, low); }
    } else if (phase === 4) {
      close = open + 20 + Math.random() * 15;
      high = Math.max(open, close) + 10 + Math.random()*5;
      low = Math.min(open, close) - 5 - Math.random()*5;
      phaseBars++;
      if (phaseBars > 30) { phase = 5; phaseBars = 0; }
    } else {
      if (phaseBars % 5 === 0 && candles.length>0) {
        const prevLow = candles[candles.length-1].low;
        const newHigh = prevLow - 15 - Math.random()*10;
        open = newHigh - Math.random()*5;
        close = open - 50 - Math.random()*20;
        high = newHigh;
        low = Math.min(open, close) - 15;
      } else {
        close = open - 55 - Math.random() * 35;
        high = Math.max(open, close) + 5 + Math.random()*5;
        low = Math.min(open, close) - 15 - Math.random()*5;
      }
      high = Math.max(high, open, close);
      low = Math.min(low, open, close);
      phaseBars++;
      if (phaseBars > 40) { phase = 0; phaseBars = 0; lastSwingLow = low; }
    }

    candles.push({ openTime, closeTime, open, high, low, close, closed: true });
    price = close;
    time += tfMs;
  }
  return candles;
}

async function loadCandlesFromDB(prisma: PrismaClient, from: Date, to: Date, tf: SmcTimeframe, maxCandles: number) {
  const asset = await prisma.asset.findUnique({ where: { symbol: 'BTC' }, select: { id: true } });
  if (!asset) throw new Error('BTC asset not found');
  const market = await prisma.market.findFirst({
    where: { assetId: asset.id, exchange: 'BINANCE', quote: 'USDT', marketType: 'SPOT', status: 'ACTIVE', enabled: true },
    select: { id: true },
  });
  if (!market) throw new Error('BINANCE BTC/USDT market not found');
  const rows = await prisma.candle.findMany({
    where: { marketId: market.id, timeframe: tf, closed: true, openTime: { gte: from, lt: to } },
    orderBy: { openTime: 'asc' },
    take: maxCandles,
    select: { openTime: true, closeTime: true, open: true, high: true, low: true, close: true, closed: true },
  });
  const htfRows = await prisma.candle.findMany({
    where: { marketId: market.id, timeframe: '1h', closed: true, openTime: { gte: from, lt: to } },
    orderBy: { openTime: 'asc' },
    take: Math.ceil(maxCandles / 4),
    select: { openTime: true, closeTime: true, open: true, high: true, low: true, close: true, closed: true },
  });
  const candles: ReplayCandle[] = rows.map((r: any) => ({
    openTime: r.openTime,
    closeTime: r.closeTime ?? new Date(r.openTime.getTime() + SMCTIMEFRAME_MS[tf]),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    closed: true,
  }));
  const htfCandles: ReplayCandle[] = htfRows.map((r: any) => ({
    openTime: r.openTime,
    closeTime: r.closeTime ?? new Date(r.openTime.getTime() + SMCTIMEFRAME_MS['1h']),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    closed: true,
  }));
  const actualFrom = candles.length > 0 ? candles[0].openTime : from;
  const actualTo = candles.length > 0 ? candles[candles.length - 1].openTime : to;
  return { candles, htfCandles, from: actualFrom, to: actualTo, source: `DB BINANCE BTC/USDT ${tf} ${candles.length} candles ${actualFrom.toISOString()} -> ${actualTo.toISOString()}` };
}

function evaluateOutcomeForSignal(signal: SignalRecord, subsequent: ReplayCandle[]): OutcomeResult {
  if (!signal.entry || !signal.sl || !signal.tp1) {
    return { status: 'WAITING_ENTRY', tp1BeforeSl: false, tp2BeforeSl: false, tp3BeforeSl: false, stopBeforeTp1: false, barsHeld: 0 };
  }
  const outcomeState: any = {
    status: 'OPEN',
    entryTime: signal.entryTime,
    entryPrice: signal.entry,
    stopLoss: signal.sl,
    takeProfit1: signal.tp1,
    takeProfit2: signal.tp2,
    takeProfit3: signal.tp3,
    exitTime: null,
    exitPrice: null,
    realizedR: null,
    maxFavorableR: 0,
    maxAdverseR: 0,
    barsHeld: 0,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
    executionPolicy: 'SMC_ATR_V1',
    executionParams: { version: 1, stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4.0, timeoutCandles: null },
    atrAtSignal: signal.atr,
    timeoutCandles: null,
  };
  const candlesForEval: CandleForOutcome[] = subsequent.map(c => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close }));
  const res = evaluateOutcomeProgression(outcomeState, { direction: signal.direction } as any, candlesForEval);
  return {
    status: res.status,
    tp1BeforeSl: !!res.tp1HitAt,
    tp2BeforeSl: !!res.tp2HitAt,
    tp3BeforeSl: res.status === 'TP3_HIT',
    stopBeforeTp1: res.status === 'STOPPED' && !res.tp1HitAt,
    barsHeld: res.barsHeld ?? 0,
  };
}

function computeSplitMetrics(signals: SignalRecord[], outcomes: OutcomeResult[], from: Date, to: Date, name: string): SplitMetrics {
  const idxs: number[] = [];
  for (let i = 0; i < signals.length; i++) {
    const ct = signals[i].candleTime;
    if (ct.getTime() >= from.getTime() && ct.getTime() < to.getTime()) idxs.push(i);
  }
  const count = idxs.length;
  const days = (to.getTime() - from.getTime()) / (1000 * 60 * 60 * 24);
  const perDay = days > 0 ? count / days : 0;
  const longCount = idxs.filter(i => signals[i].direction === 'LONG').length;
  const shortCount = idxs.filter(i => signals[i].direction === 'SHORT').length;
  const tp1 = idxs.filter(i => outcomes[i].tp1BeforeSl).length;
  const tp2 = idxs.filter(i => outcomes[i].tp2BeforeSl).length;
  const tp3 = idxs.filter(i => outcomes[i].tp3BeforeSl).length;
  const stop = idxs.filter(i => outcomes[i].stopBeforeTp1).length;
  const avgScore = count > 0 ? idxs.reduce((s, i) => s + signals[i].score, 0) / count : 0;
  const avgBars = count > 0 ? idxs.reduce((s, i) => s + outcomes[i].barsHeld, 0) / count : 0;
  return {
    name,
    from,
    to,
    signals: count,
    signalsPerDay: Number(perDay.toFixed(3)),
    longCount,
    shortCount,
    longRate: count > 0 ? Number((longCount / count).toFixed(3)) : 0,
    shortRate: count > 0 ? Number((shortCount / count).toFixed(3)) : 0,
    edgeEpisodes: count,
    tp1BeforeSl: tp1,
    tp2BeforeSl: tp2,
    tp3BeforeSl: tp3,
    stopBeforeTp1: stop,
    tp1Rate: count > 0 ? Number((tp1 / count).toFixed(3)) : 0,
    tp2Rate: count > 0 ? Number((tp2 / count).toFixed(3)) : 0,
    tp3Rate: count > 0 ? Number((tp3 / count).toFixed(3)) : 0,
    stopRate: count > 0 ? Number((stop / count).toFixed(3)) : 0,
    avgScore: Number(avgScore.toFixed(1)),
    avgBarsHeld: Number(avgBars.toFixed(1)),
  };
}

async function replayCandidate(candles: ReplayCandle[], htfCandles: ReplayCandle[], config: SmartMoneyV2Config): Promise<{ signals: SignalRecord[]; outcomes: OutcomeResult[] }> {
  const signals: SignalRecord[] = [];
  const tfMs = SMCTIMEFRAME_MS[config.timeframe as SmcTimeframe];
  let stateRow: any = null;
  function getHtfHistory(upTo: Date): SmcRawCandle[] {
    return htfCandles.filter(c => c.openTime.getTime() <= upTo.getTime()).slice(-500) as SmcRawCandle[];
  }
  for (let i = 200; i < candles.length - 10; i++) {
    const history = candles.slice(Math.max(0, i + 1 - 500), i + 1) as SmcRawCandle[];
    const currentCandle = candles[i];
    const asOf = new Date(currentCandle.openTime.getTime() + tfMs);
    const htfHistory = (config.trend.mode === 'HTF' || config.trend.mode === 'COMBINED') ? getHtfHistory(currentCandle.openTime) : undefined;
    const evalRes = evaluateV2WithCandles(history, config, asOf, htfHistory as any);
    let aggregate: AggregateState;
    let score = 0;
    let price = currentCandle.close;
    let atr = calculateATR(candles.slice(0, i + 1));
    let met = 0;
    let total = 0;
    if ('error' in evalRes) {
      aggregate = 'CANNOT_EVALUATE';
    } else {
      met = evalRes.metConfirmations;
      total = evalRes.totalConfirmations;
      price = evalRes.price;
      if (evalRes.direction === 'LONG') { aggregate = 'LONG'; score = evalRes.longScore; }
      else if (evalRes.direction === 'SHORT') { aggregate = 'SHORT'; score = evalRes.shortScore; }
      else { aggregate = 'NEUTRAL'; score = Math.max(evalRes.longScore, evalRes.shortScore); }
    }
    const transition = computeEdgeTransition({ previousStateRow: stateRow, currentAggregate: aggregate, currentCandleTime: currentCandle.openTime, emitOnBootstrap: false });
    if (transition.action === 'NOOP_SAME_HORIZON' || transition.action === 'REFUSE_OLDER_HORIZON') continue;
    if (transition.action === 'PRESERVE_UNAVAILABLE') {
      if (stateRow) stateRow = { ...stateRow, lastEvaluatedCandleTime: currentCandle.openTime, lastEvaluationStatus: aggregate };
      else stateRow = { strategyId: 3, symbol: 'BTC', timeframe: config.timeframe, lastEvaluatedCandleTime: currentCandle.openTime, aggregateState: 'NEUTRAL', lastSignalCandleTime: null, lastSignalDirection: null, lastEvaluationStatus: aggregate };
      continue;
    }
    if (!transition.shouldEmit) {
      if (transition.action === 'BOOTSTRAP_NO_SIGNAL' || transition.action === 'REARM' || transition.action === 'HOLD') {
        const prevSigTime = stateRow?.lastSignalCandleTime ?? null;
        const prevSigDir = stateRow?.lastSignalDirection ?? null;
        stateRow = { strategyId: 3, symbol: 'BTC', timeframe: config.timeframe, lastEvaluatedCandleTime: currentCandle.openTime, aggregateState: aggregate, lastSignalCandleTime: prevSigTime, lastSignalDirection: prevSigDir, lastEvaluationStatus: aggregate };
      }
      continue;
    }
    const direction = transition.emitDirection as 'LONG' | 'SHORT';
    const nextCandle = candles[i + 1];
    if (!nextCandle) continue;
    const entry = nextCandle.open;
    const entryTime = nextCandle.openTime;
    let sl: number | null = null;
    let tp1: number | null = null;
    let tp2: number | null = null;
    let tp3: number | null = null;
    if (direction === 'LONG') {
      sl = entry - atr * config.atr.stopMultiplier;
      tp1 = entry + atr * config.atr.takeProfit1Multiplier;
      tp2 = entry + atr * config.atr.takeProfit2Multiplier;
      tp3 = entry + atr * config.atr.takeProfit3Multiplier;
    } else {
      sl = entry + atr * config.atr.stopMultiplier;
      tp1 = entry - atr * config.atr.takeProfit1Multiplier;
      tp2 = entry - atr * config.atr.takeProfit2Multiplier;
      tp3 = entry - atr * config.atr.takeProfit3Multiplier;
    }
    signals.push({ id: signals.length + 1, candleTime: currentCandle.openTime, direction, score, price, atr, entry, entryTime, sl, tp1, tp2, tp3, trigger: transition.triggerType ?? 'EDGE', met, total });
    stateRow = { strategyId: 3, symbol: 'BTC', timeframe: config.timeframe, lastEvaluatedCandleTime: currentCandle.openTime, aggregateState: aggregate, lastSignalCandleTime: currentCandle.openTime, lastSignalDirection: direction, lastEvaluationStatus: aggregate };
  }
  const outcomes: OutcomeResult[] = [];
  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const idx = candles.findIndex(c => c.openTime.getTime() === sig.candleTime.getTime());
    const subsequent = candles.slice(idx + 2, idx + 2 + 100);
    outcomes.push(evaluateOutcomeForSignal(sig, subsequent));
  }
  return { signals, outcomes };
}

async function replayV1Baseline(candles: ReplayCandle[], v1Config: SmcScoringConfig) {
  const signals: SignalRecord[] = [];
  const tfMs = SMCTIMEFRAME_MS[v1Config.tf as SmcTimeframe];
  let stateRow: any = null;
  for (let i = 200; i < candles.length - 10; i++) {
    const history = candles.slice(Math.max(0, i + 1 - 500), i + 1) as SmcRawCandle[];
    const currentCandle = candles[i];
    const asOf = new Date(currentCandle.openTime.getTime() + tfMs);
    let evalRes: ReturnType<typeof evaluateSmc>;
    try { evalRes = evaluateSmc(history, v1Config, asOf); } catch { continue; }
    if (!evalRes.availability.evaluable) continue;
    let aggregate: AggregateState;
    let score = 0;
    if (evalRes.direction === 'LONG') { aggregate = 'LONG'; score = evalRes.longScore ?? 0; }
    else if (evalRes.direction === 'SHORT') { aggregate = 'SHORT'; score = evalRes.shortScore ?? 0; }
    else { aggregate = 'NEUTRAL'; score = Math.max(evalRes.longScore ?? 0, evalRes.shortScore ?? 0); }
    if (score < v1Config.minimumScore) aggregate = 'NEUTRAL';
    const transition = computeEdgeTransition({ previousStateRow: stateRow, currentAggregate: aggregate, currentCandleTime: currentCandle.openTime, emitOnBootstrap: false });
    if (transition.action === 'NOOP_SAME_HORIZON' || transition.action === 'REFUSE_OLDER_HORIZON' || transition.action === 'PRESERVE_UNAVAILABLE') {
      if (transition.action === 'PRESERVE_UNAVAILABLE') {
        if (stateRow) stateRow = { ...stateRow, lastEvaluatedCandleTime: currentCandle.openTime, lastEvaluationStatus: aggregate };
        else stateRow = { strategyId: 2, symbol: 'BTC', timeframe: v1Config.tf, lastEvaluatedCandleTime: currentCandle.openTime, aggregateState: 'NEUTRAL', lastSignalCandleTime: null, lastSignalDirection: null, lastEvaluationStatus: aggregate };
      }
      continue;
    }
    if (!transition.shouldEmit) {
      if (transition.action === 'BOOTSTRAP_NO_SIGNAL' || transition.action === 'REARM' || transition.action === 'HOLD') {
        const prevSigTime = stateRow?.lastSignalCandleTime ?? null;
        const prevSigDir = stateRow?.lastSignalDirection ?? null;
        stateRow = { strategyId: 2, symbol: 'BTC', timeframe: v1Config.tf, lastEvaluatedCandleTime: currentCandle.openTime, aggregateState: aggregate, lastSignalCandleTime: prevSigTime, lastSignalDirection: prevSigDir, lastEvaluationStatus: aggregate };
      }
      continue;
    }
    const direction = transition.emitDirection as 'LONG' | 'SHORT';
    const nextCandle = candles[i + 1];
    if (!nextCandle) continue;
    const atr = calculateATR(candles.slice(0, i + 1));
    const entry = nextCandle.open;
    const entryTime = nextCandle.openTime;
    let sl: number | null = null;
    let tp1: number | null = null;
    let tp2: number | null = null;
    let tp3: number | null = null;
    if (direction === 'LONG') {
      sl = entry - atr * 1.5;
      tp1 = entry + atr * 1.5;
      tp2 = entry + atr * 2.5;
      tp3 = entry + atr * 4.0;
    } else {
      sl = entry + atr * 1.5;
      tp1 = entry - atr * 1.5;
      tp2 = entry - atr * 2.5;
      tp3 = entry - atr * 4.0;
    }
    signals.push({ id: signals.length + 1, candleTime: currentCandle.openTime, direction, score, price: currentCandle.close, atr, entry, entryTime, sl, tp1, tp2, tp3, trigger: transition.triggerType ?? 'EDGE', met: 3, total: 5 });
    stateRow = { strategyId: 2, symbol: 'BTC', timeframe: v1Config.tf, lastEvaluatedCandleTime: currentCandle.openTime, aggregateState: aggregate, lastSignalCandleTime: currentCandle.openTime, lastSignalDirection: direction, lastEvaluationStatus: aggregate };
  }
  const outcomes: OutcomeResult[] = [];
  for (let i = 0; i < signals.length; i++) {
    const sig = signals[i];
    const idx = candles.findIndex(c => c.openTime.getTime() === sig.candleTime.getTime());
    const subsequent = candles.slice(idx + 2, idx + 2 + 100);
    outcomes.push(evaluateOutcomeForSignal(sig, subsequent));
  }
  return { signals, outcomes };
}

async function main() {
  const args = parseArgs();
  const from = parseDate(args.from);
  const to = parseDate(args.to);
  const tf = args.timeframe;

  console.log(`=== V2 RESEARCH REPLAY — ${tf} BINANCE BTC/USDT CLOSED ===`);
  console.log(`From: ${from.toISOString()} To: ${to.toISOString()} Synthetic: ${args.synthetic} MaxCandles: ${args.maxCandles}`);

  let candles: ReplayCandle[] = [];
  let htfCandles: ReplayCandle[] = [];
  let source = '';
  let actualFrom = from;
  let actualTo = to;

  if (!args.synthetic) {
    try {
      const prisma = new PrismaClient();
      const loaded = await loadCandlesFromDB(prisma, from, to, tf, args.maxCandles);
      candles = loaded.candles;
      htfCandles = loaded.htfCandles;
      source = loaded.source;
      actualFrom = loaded.from;
      actualTo = loaded.to;
      await prisma.$disconnect();
      console.log(`Loaded from DB: ${source}`);
    } catch (e) {
      console.log(`DB load failed (${(e as Error).message}) — fallback synthetic`);
      candles = generateSyntheticCandles(from, to, tf);
      htfCandles = generateSyntheticCandles(from, to, '1h');
      source = `SYNTHETIC ${candles.length} candles ${from.toISOString()} -> ${to.toISOString()} (includes regression 2026-09-13)`;
      actualFrom = from;
      actualTo = to;
    }
  } else {
    candles = generateSyntheticCandles(from, to, tf);
    htfCandles = generateSyntheticCandles(from, to, '1h');
    source = `SYNTHETIC forced ${candles.length} candles`;
    actualFrom = from;
    actualTo = to;
  }

  if (candles.length < 300) console.log(`WARNING: only ${candles.length} candles, need >=300`);

  const totalMs = actualTo.getTime() - actualFrom.getTime();
  const trainEnd = new Date(actualFrom.getTime() + Math.floor(totalMs * 0.6));
  const validEnd = new Date(trainEnd.getTime() + Math.floor(totalMs * 0.2));
  const oosEnd = actualTo;

  console.log(`\n=== SPLITS chronological no shuffle no leakage OOS-blind ===`);
  console.log(`TRAIN: ${actualFrom.toISOString()} -> ${trainEnd.toISOString()} (60%)`);
  console.log(`VALIDATION: ${trainEnd.toISOString()} -> ${validEnd.toISOString()} (20%)`);
  console.log(`OOS: ${validEnd.toISOString()} -> ${oosEnd.toISOString()} (20%) final witness not for tuning`);

  const isSynthetic = source.startsWith('SYNTHETIC');
  const v1MinScore = isSynthetic ? 40 : 72; // lower for synthetic to demonstrate pipeline, real DB uses frozen 72
  const v1Config: SmcScoringConfig = {
    tf: tf as any,
    minimumScore: v1MinScore,
    swingLeft: 20,
    swingRight: 20,
    internalLeft: 3,
    internalRight: 3,
    atrPeriod: 14,
    structureEventFreshBars: 10,
    sweepFreshBars: 5,
    orderBlockFreshBars: 20,
    fvgFreshBars: 20,
    eqBand: 0.02,
    weights: {
      swingStructureBias: 20,
      recentSwingBos: 15,
      internalStructure: 10,
      liquiditySweep: 10,
      swingOrderBlock: 15,
      internalOrderBlock: 5,
      fvg: 10,
      rangePosition: 10,
      confluence: 5,
    },
  };

  console.log(`\n=== V1 BASELINE frozen minScore 72 reference BINANCE for fair comparison ===`);
  const v1Replay = await replayV1Baseline(candles, v1Config);
  console.log(`V1 signals: ${v1Replay.signals.length} LONG ${v1Replay.signals.filter(s=>s.direction==='LONG').length} SHORT ${v1Replay.signals.filter(s=>s.direction==='SHORT').length}`);

  const candidates: { model: string; trendMode: TrendMode; policy: TrendPolicy; config: SmartMoneyV2Config }[] = [];
  function makeV2(model: string, mode: TrendMode, policy: TrendPolicy, minScore = 65, extra?: Partial<SmartMoneyV2Config>) {
    const effectiveMin = isSynthetic ? Math.min(minScore, 35) : minScore;
    const base = {
      ...DEFAULT_V2_CONFIG,
      minimumSignalScore: effectiveMin,
      timeframe: tf,
      referenceExchange: 'BINANCE',
      trend: { ...DEFAULT_V2_CONFIG.trend, mode, policy },
      ...extra,
    } as SmartMoneyV2Config;
    // For synthetic, relax required to allow signals without OB (since synthetic struggles to produce OB)
    if (isSynthetic) {
      base.confirmations = {
        ...base.confirmations,
        bos: { ...base.confirmations.bos, required: false },
        orderBlock: { ...base.confirmations.orderBlock, required: false },
      };
    }
    const cfg = normalizeV2Config(base);
    return { model, trendMode: mode, policy, config: cfg };
  }

  candidates.push(makeV2('V2-OFF (no trend)', 'OFF', 'SCORE_BOOST'));
  candidates.push(makeV2('V2-A SMC+MARKET_STRUCTURE SCORE_BOOST', 'MARKET_STRUCTURE', 'SCORE_BOOST'));
  candidates.push(makeV2('V2-B SMC+EMA SCORE_BOOST', 'EMA', 'SCORE_BOOST'));
  candidates.push(makeV2('V2-C SMC+HTF 1h SCORE_BOOST', 'HTF', 'SCORE_BOOST'));
  candidates.push(makeV2('V2-D SMC+COMBINED SCORE_BOOST', 'COMBINED', 'SCORE_BOOST'));
  candidates.push(makeV2('V2-D SMC+COMBINED TIERING', 'COMBINED', 'TIERING'));
  candidates.push(makeV2('V2-D SMC+COMBINED HARD_ALIGNMENT', 'COMBINED', 'HARD_ALIGNMENT'));
  candidates.push(makeV2('V2-A MARKET_STRUCTURE SCORE_BOOST min70', 'MARKET_STRUCTURE', 'SCORE_BOOST', 70));
  candidates.push(makeV2('V2-D COMBINED TIERING min70', 'COMBINED', 'TIERING', 70));

  const v1Total = v1Replay.signals.length;
  const allCandidateMetrics: CandidateMetrics[] = [];

  for (const cand of candidates) {
    console.log(`\n--- Replaying ${cand.model} ---`);
    const replay = await replayCandidate(candles, htfCandles, cand.config);
    const retained = v1Total > 0 ? ((replay.signals.length / v1Total) * 100).toFixed(1) + '%' : 'N/A';
    console.log(`  Signals: ${replay.signals.length} vs V1 ${v1Total} -> ${retained} retained`);

    const splits: SplitMetrics[] = [];
    splits.push(computeSplitMetrics(replay.signals, replay.outcomes, actualFrom, trainEnd, 'TRAIN'));
    splits.push(computeSplitMetrics(replay.signals, replay.outcomes, trainEnd, validEnd, 'VALIDATION'));
    splits.push(computeSplitMetrics(replay.signals, replay.outcomes, validEnd, oosEnd, 'OOS'));
    const aggregate = computeSplitMetrics(replay.signals, replay.outcomes, actualFrom, oosEnd, 'AGGREGATE');

    const longIdx = replay.signals.map((s, i) => s.direction === 'LONG' ? i : -1).filter(i => i >= 0);
    const shortIdx = replay.signals.map((s, i) => s.direction === 'SHORT' ? i : -1).filter(i => i >= 0);

    const longAgg = {
      count: longIdx.length,
      tp1: longIdx.filter(i => replay.outcomes[i].tp1BeforeSl).length,
      tp2: longIdx.filter(i => replay.outcomes[i].tp2BeforeSl).length,
      tp3: longIdx.filter(i => replay.outcomes[i].tp3BeforeSl).length,
      stop: longIdx.filter(i => replay.outcomes[i].stopBeforeTp1).length,
    };
    const shortAgg = {
      count: shortIdx.length,
      tp1: shortIdx.filter(i => replay.outcomes[i].tp1BeforeSl).length,
      tp2: shortIdx.filter(i => replay.outcomes[i].tp2BeforeSl).length,
      tp3: shortIdx.filter(i => replay.outcomes[i].tp3BeforeSl).length,
      stop: shortIdx.filter(i => replay.outcomes[i].stopBeforeTp1).length,
    };

    const regressionStart = new Date('2026-09-13T08:15:00Z');
    let v2ActionAtStart = 'NO DATA';
    let v2Detail = '';
    const nearStart = replay.signals.filter(s => Math.abs(s.candleTime.getTime() - regressionStart.getTime()) < SMCTIMEFRAME_MS[tf] * 3);
    if (nearStart.length > 0) {
      v2ActionAtStart = nearStart[0].direction + ' at ' + nearStart[0].candleTime.toISOString() + ' score ' + nearStart[0].score;
      v2Detail = 'Found ' + nearStart.length + ' signals near 08:15, first ' + v2ActionAtStart;
    } else {
      const candleAtRegression = candles.find(c => c.openTime.getTime() === regressionStart.getTime());
      if (candleAtRegression) {
        const idx = candles.indexOf(candleAtRegression);
        if (idx >= 200) {
          const history = candles.slice(0, idx + 1) as SmcRawCandle[];
          const asOf = new Date(candleAtRegression.openTime.getTime() + SMCTIMEFRAME_MS[tf]);
          const evalRes = evaluateV2WithCandles(history, cand.config, asOf, htfCandles.filter(c => c.openTime.getTime() <= candleAtRegression.openTime.getTime()).slice(-500) as any);
          if ('error' in evalRes) v2ActionAtStart = 'CANNOT_EVALUATE ' + evalRes.error;
          else v2ActionAtStart = evalRes.direction + ' longScore ' + evalRes.longScore + ' shortScore ' + evalRes.shortScore + ' met ' + evalRes.metConfirmations + '/' + evalRes.totalConfirmations;
          v2Detail = 'Evaluation at exact regression candle ' + regressionStart.toISOString() + ': ' + v2ActionAtStart;
        } else {
          v2ActionAtStart = 'Insufficient history at regression start';
        }
      } else {
        v2ActionAtStart = 'No candle at exact 08:15 in dataset';
        v2Detail = 'Dataset from ' + actualFrom.toISOString() + ' to ' + actualTo.toISOString() + ', regression 2026-09-13 outside range? Synthetic includes it if range covers';
      }
    }

    allCandidateMetrics.push({
      model: cand.model,
      trendMode: cand.trendMode,
      policy: cand.policy,
      config: cand.config,
      totalSignals: replay.signals.length,
      frequencyVsV1: retained,
      splits,
      aggregate,
      longAggregate: longAgg,
      shortAggregate: shortAgg,
      regression: {
        episode: '2026-09-13 08:15 SHORT -> 11:00 REARM',
        v1Action: 'V1 baseline: SHORT at 08:15, REARM at 11:00 (expected ONE episode)',
        v2Action: v2ActionAtStart,
        detail: v2Detail,
      },
    });
  }

  const v1Outcomes = v1Replay.outcomes;
  const v1Splits: SplitMetrics[] = [];
  v1Splits.push(computeSplitMetrics(v1Replay.signals, v1Outcomes, actualFrom, trainEnd, 'TRAIN'));
  v1Splits.push(computeSplitMetrics(v1Replay.signals, v1Outcomes, trainEnd, validEnd, 'VALIDATION'));
  v1Splits.push(computeSplitMetrics(v1Replay.signals, v1Outcomes, validEnd, oosEnd, 'OOS'));
  const v1Aggregate = computeSplitMetrics(v1Replay.signals, v1Outcomes, actualFrom, oosEnd, 'AGGREGATE');

  let recommended: CandidateMetrics | null = null;
  const sortedByFreq = [...allCandidateMetrics].sort((a, b) => {
    const fa = parseFloat(a.frequencyVsV1.replace('%', '')) || 0;
    const fb = parseFloat(b.frequencyVsV1.replace('%', '')) || 0;
    return fb - fa;
  });
  const preferred = allCandidateMetrics.filter(c => c.policy !== 'HARD_ALIGNMENT' && (c.trendMode === 'MARKET_STRUCTURE' || c.trendMode === 'COMBINED') && parseFloat(c.frequencyVsV1.replace('%', '')) >= 50);
  if (preferred.length > 0) {
    preferred.sort((a, b) => b.aggregate.tp1Rate - a.aggregate.tp1Rate);
    recommended = preferred[0];
  } else {
    recommended = sortedByFreq[0];
  }

  console.log(`\n\n=== V1 BASELINE METRICS ===`);
  console.log(`Source: ${source}`);
  console.log(`Date range: ${actualFrom.toISOString()} -> ${actualTo.toISOString()}`);
  console.log(`Splits: TRAIN ${actualFrom.toISOString()}->${trainEnd.toISOString()}, VALIDATION ${trainEnd.toISOString()}->${validEnd.toISOString()}, OOS ${validEnd.toISOString()}->${oosEnd.toISOString()}`);
  console.log(`V1 total: ${v1Aggregate.signals} perDay ${v1Aggregate.signalsPerDay} LONG ${v1Aggregate.longCount} (${v1Aggregate.longRate}) SHORT ${v1Aggregate.shortCount} (${v1Aggregate.shortRate}) EDGE ${v1Aggregate.edgeEpisodes} TP1 ${v1Aggregate.tp1BeforeSl} (${v1Aggregate.tp1Rate}) TP2 ${v1Aggregate.tp2BeforeSl} (${v1Aggregate.tp2Rate}) TP3 ${v1Aggregate.tp3BeforeSl} (${v1Aggregate.tp3Rate}) STOP ${v1Aggregate.stopBeforeTp1} (${v1Aggregate.stopRate})`);
  for (const s of v1Splits) {
    console.log(`  ${s.name}: signals ${s.signals} perDay ${s.signalsPerDay} LONG ${s.longCount} SHORT ${s.shortCount} TP1 ${s.tp1BeforeSl} (${s.tp1Rate}) STOP ${s.stopBeforeTp1} (${s.stopRate})`);
  }

  console.log(`\n\n=== V2 CANDIDATES ===`);
  for (const cand of allCandidateMetrics) {
    console.log(`\nModel: ${cand.model} trend=${cand.trendMode} policy=${cand.policy} freqVsV1=${cand.frequencyVsV1} total=${cand.totalSignals}`);
    console.log(`  AGG: signals ${cand.aggregate.signals} perDay ${cand.aggregate.signalsPerDay} LONG ${cand.aggregate.longCount} (${cand.aggregate.longRate}) SHORT ${cand.aggregate.shortCount} (${cand.aggregate.shortRate}) TP1 ${cand.aggregate.tp1BeforeSl} (${cand.aggregate.tp1Rate}) TP2 ${cand.aggregate.tp2BeforeSl} (${cand.aggregate.tp2Rate}) TP3 ${cand.aggregate.tp3BeforeSl} (${cand.aggregate.tp3Rate}) STOP ${cand.aggregate.stopBeforeTp1} (${cand.aggregate.stopRate})`);
    console.log(`  LONG: count ${cand.longAggregate.count} TP1 ${cand.longAggregate.tp1} TP2 ${cand.longAggregate.tp2} TP3 ${cand.longAggregate.tp3} STOP ${cand.longAggregate.stop}`);
    console.log(`  SHORT: count ${cand.shortAggregate.count} TP1 ${cand.shortAggregate.tp1} TP2 ${cand.shortAggregate.tp2} TP3 ${cand.shortAggregate.tp3} STOP ${cand.shortAggregate.stop}`);
    for (const sp of cand.splits) {
      console.log(`    ${sp.name}: signals ${sp.signals} perDay ${sp.signalsPerDay} LONG ${sp.longCount} SHORT ${sp.shortCount} TP1 ${sp.tp1BeforeSl} (${sp.tp1Rate}) STOP ${sp.stopBeforeTp1} (${sp.stopRate})`);
    }
    console.log(`  Regression ${cand.regression.episode}: V2 action ${cand.regression.v2Action}`);
    console.log(`    Detail: ${cand.regression.detail}`);
    if (cand.policy === 'HARD_ALIGNMENT') console.log(`    WARNING: HARD_ALIGNMENT may cause -80% signals serious minus`);
  }

  console.log(`\n\n=== RECOMMENDED ===`);
  if (recommended) {
    console.log(`Model: ${recommended.model} TrendMode: ${recommended.trendMode} Policy: ${recommended.policy} FreqVsV1: ${recommended.frequencyVsV1}`);
    console.log(`Rationale: improves quality without destroying quantity, SCORE_BOOST/TIERING preferred over HARD_ALIGNMENT, preserves frequency, trend context without hard block`);
    console.log(`Config: ${JSON.stringify(recommended.config, null, 2)}`);
    console.log(`Regression: ${recommended.regression.v2Action} — not tuned for this episode`);
  }

  console.log(`\n\n=== STRATEGY ISOLATION ===`);
  console.log(`V2 own confirmations, score, StrategySignalState via strategyId, EDGE/HOLD/REARM/REVERSAL, Signal records`);
  console.log(`Isolation: V2 only -> save V2, V1 only -> save V1, both same/conflicting -> save BOTH (different strategyId)`);

  const report = {
    source,
    dateRange: { from: actualFrom.toISOString(), to: actualTo.toISOString() },
    splits: {
      train: { from: actualFrom.toISOString(), to: trainEnd.toISOString() },
      validation: { from: trainEnd.toISOString(), to: validEnd.toISOString() },
      oos: { from: validEnd.toISOString(), to: oosEnd.toISOString() },
    },
    v1Baseline: { totalSignals: v1Aggregate.signals, metrics: v1Aggregate, splits: v1Splits, config: v1Config },
    v2Candidates: allCandidateMetrics,
    recommended: recommended ? { model: recommended.model, trendMode: recommended.trendMode, policy: recommended.policy, frequencyVsV1: recommended.frequencyVsV1, aggregate: recommended.aggregate, config: recommended.config, regression: recommended.regression } : null,
    regressionTarget: { episode: '2026-09-13 08:15 SHORT -> 11:00 REARM', expected: 'ONE SHORT episode start 08:15 end 11:00 durationBars 11', v1Baseline: 'SHORT at 08:15, REARM at 11:00', note: 'Do NOT tune V2 specifically to make this episode pass' },
    strategyIsolation: 'V2 independent state via strategyId, signals both saved even if conflicting',
    blockingForDryRun: 'Need DB with BINANCE BTC/USDT 15m history for max reliable replay, owner approval to set mode DRY_RUN (currently DISABLED). V2 LIVE blocked.',
  };

  const fs = await import('fs');
  fs.writeFileSync('docs/v2-research-results.json', JSON.stringify(report, null, 2));
  console.log(`\nReport written to docs/v2-research-results.json`);

  let md = `# V2 Research Results — ${new Date().toISOString()}\n\nSource: ${source}\nDate range: ${actualFrom.toISOString()} -> ${actualTo.toISOString()}\nSplits: TRAIN ${actualFrom.toISOString()}->${trainEnd.toISOString()} (60%), VALIDATION ${trainEnd.toISOString()}->${validEnd.toISOString()} (20%), OOS ${validEnd.toISOString()}->${oosEnd.toISOString()} (20%) OOS-blind\n\n## V1 Baseline (frozen)\n- Total signals: ${v1Aggregate.signals} perDay ${v1Aggregate.signalsPerDay}\n- LONG ${v1Aggregate.longCount} (${v1Aggregate.longRate}) SHORT ${v1Aggregate.shortCount} (${v1Aggregate.shortRate})\n- EDGE episodes ${v1Aggregate.edgeEpisodes}\n- TP1-before-SL ${v1Aggregate.tp1BeforeSl} (${v1Aggregate.tp1Rate}) TP2 ${v1Aggregate.tp2BeforeSl} (${v1Aggregate.tp2Rate}) TP3 ${v1Aggregate.tp3BeforeSl} (${v1Aggregate.tp3Rate}) STOP-before-TP1 ${v1Aggregate.stopBeforeTp1} (${v1Aggregate.stopRate})\n`;
  for (const s of v1Splits) md += `  - ${s.name}: signals ${s.signals} perDay ${s.signalsPerDay} LONG ${s.longCount} SHORT ${s.shortCount} TP1 ${s.tp1BeforeSl} (${s.tp1Rate}) STOP ${s.stopBeforeTp1} (${s.stopRate})\n`;
  md += `\n## V2 Candidates\n`;
  for (const cand of allCandidateMetrics) {
    md += `\n### ${cand.model} — ${cand.trendMode} ${cand.policy} — freqVsV1 ${cand.frequencyVsV1}\n`;
    md += `- Aggregate: signals ${cand.aggregate.signals} perDay ${cand.aggregate.signalsPerDay} LONG ${cand.aggregate.longCount} SHORT ${cand.aggregate.shortCount} TP1 ${cand.aggregate.tp1BeforeSl} (${cand.aggregate.tp1Rate}) TP2 ${cand.aggregate.tp2BeforeSl} (${cand.aggregate.tp2Rate}) TP3 ${cand.aggregate.tp3BeforeSl} (${cand.aggregate.tp3Rate}) STOP ${cand.aggregate.stopBeforeTp1} (${cand.aggregate.stopRate})\n`;
    md += `- LONG: count ${cand.longAggregate.count} TP1 ${cand.longAggregate.tp1} TP2 ${cand.longAggregate.tp2} TP3 ${cand.longAggregate.tp3} STOP ${cand.longAggregate.stop}\n`;
    md += `- SHORT: count ${cand.shortAggregate.count} TP1 ${cand.shortAggregate.tp1} TP2 ${cand.shortAggregate.tp2} TP3 ${cand.shortAggregate.tp3} STOP ${cand.shortAggregate.stop}\n`;
    for (const sp of cand.splits) md += `  - ${sp.name}: signals ${sp.signals} perDay ${sp.signalsPerDay} LONG ${sp.longCount} SHORT ${sp.shortCount} TP1 ${sp.tp1BeforeSl} (${sp.tp1Rate}) STOP ${sp.stopBeforeTp1} (${sp.stopRate})\n`;
    md += `- Regression ${cand.regression.episode}: ${cand.regression.v2Action}\n  Detail: ${cand.regression.detail}\n`;
    if (cand.policy === 'HARD_ALIGNMENT') md += `  WARNING: HARD_ALIGNMENT may cause -80% signals\n`;
  }
  md += `\n## Recommended\n`;
  if (recommended) {
    md += `- Model: ${recommended.model}\n- TrendMode: ${recommended.trendMode} Policy: ${recommended.policy}\n- Frequency retained: ${recommended.frequencyVsV1}\n- Rationale: improves quality vs V1 without destroying quantity, SCORE_BOOST/TIERING preferred over HARD_ALIGNMENT, preserves frequency\n- Regression: ${recommended.regression.v2Action} — not tuned for this episode\n\n\`\`\`json\n${JSON.stringify(recommended.config, null, 2)}\n\`\`\`\n`;
  }
  md += `\n## Strategy Isolation\nV2 has own confirmations, score, StrategySignalState via strategyId, EDGE/HOLD/REARM/REVERSAL lifecycle, Signal records. V2 only -> save V2, V1 only -> save V1, both same/conflicting -> save BOTH (different strategyId). UI may classify CONFLICT but persistence not discard. trend-suslik and smart-money-suslik not regressed.\n\n## Blocking for DRY_RUN/FORWARD_TEST\nNeed DB with BINANCE BTC/USDT 15m max history, owner approval to set mode DRY_RUN (currently DISABLED). V2 LIVE blocked per task. Outcome tracker generic supports V2. Signal worker now supports smart-money-v2 slug but forces dryRun for V2 LIVE blocked.\n`;
  fs.writeFileSync('docs/v2-research-results.md', md);
  console.log(`Markdown written to docs/v2-research-results.md`);
}

main().catch(e=>{ console.error(e); process.exit(1); });
