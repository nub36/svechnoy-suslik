/**
 * PHASE 2C — SignalOutcome tracker contract — FINAL HARDENING
 *
 * Separate immutable Signal observation vs mutable SignalOutcome execution state.
 *
 * Signal:
 *   signalCandleTime, direction, score, referenceExchange, referencePrice, aggregatePrice,
 *   atrAtSignal, metadata, createdAt — immutable observation at H
 *
 * SignalOutcome:
 *   signalId UNIQUE, status WAITING_ENTRY/OPEN/TP1_HIT/TP2_HIT/TP3_HIT/STOPPED/EXPIRED/ENTRY_DATA_MISSING
 *   entryTime, entryPrice, stopLoss, tp1/2/3, exitTime, exitPrice, realizedR, maxFavR/maxAdvR, barsHeld, updatedAt
 *   plus tp1HitAt/tp2HitAt/tp3HitAt, timeoutCandles versioned part of executionPolicy
 *
 * Contract:
 * - WAITING_ENTRY when H+D CLOSED available entry = OPEN(H+D) evaluation from this candle
 * - Same-bar pessimistic SL first
 * - Gap behavior open beyond SL/TP use actual open per backtest contract
 * - TP lifecycle TP1/TP2 milestones TP3/STOP/EXPIRED terminal
 * - No partial sizing yet
 * - Timeout/expiry deterministic timeoutCandles per timeframe versioned part of executionPolicy — design only
 */

import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../smc/types";
import type { SmartMoneySignalCandidate } from "./smart-money-candidate";

export type OutcomeStatus =
  | "WAITING_ENTRY"
  | "OPEN"
  | "TP1_HIT"
  | "TP2_HIT"
  | "TP3_HIT"
  | "STOPPED"
  | "EXPIRED"
  | "ENTRY_DATA_MISSING";

export type CandleForOutcome = {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type OutcomeState = {
  status: OutcomeStatus;
  entryTime: Date | null;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  exitTime: Date | null;
  exitPrice: number | null;
  realizedR: number | null;
  maxFavorableR: number | null;
  maxAdverseR: number | null;
  barsHeld: number | null;
  tp1HitAt: Date | null;
  tp2HitAt: Date | null;
  tp3HitAt: Date | null;
  executionPolicy: string;
  executionParams: any;
  atrAtSignal: number | null;
  timeoutCandles: number | null;
};

export type OutcomeEvalInput = {
  candidate: SmartMoneySignalCandidate;
  nextBar: CandleForOutcome | null; // H+D
  subsequentCandles: CandleForOutcome[]; // after entry, chronological
  now: Date;
};

function timeframeMs(tf: SmcTimeframe): number {
  return SMCTIMEFRAME_MS[tf];
}

/**
 * Build initial outcome from candidate + next bar
 * If next bar not available => WAITING_ENTRY
 * If next bar time != H+D exact => ENTRY_DATA_MISSING, no silent gap skip
 */
export function buildInitialOutcome(input: { candidate: SmartMoneySignalCandidate; nextBar: CandleForOutcome | null }): OutcomeState {
  const { candidate, nextBar } = input;
  const tfMs = timeframeMs(candidate.timeframe);
  const expectedNext = new Date(candidate.signalCandleTime.getTime() + tfMs);

  if (!nextBar) {
    return {
      status: "WAITING_ENTRY",
      entryTime: null,
      entryPrice: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      exitTime: null,
      exitPrice: null,
      realizedR: null,
      maxFavorableR: null,
      maxAdverseR: null,
      barsHeld: null,
      tp1HitAt: null,
      tp2HitAt: null,
      tp3HitAt: null,
      executionPolicy: candidate.executionPolicy,
      executionParams: candidate.executionParams,
      atrAtSignal: candidate.atrAtSignal,
      timeoutCandles: (candidate.executionParams as any).timeoutCandles ?? null,
    };
  }

  if (nextBar.openTime.getTime() !== expectedNext.getTime()) {
    return {
      status: "ENTRY_DATA_MISSING",
      entryTime: null,
      entryPrice: null,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      exitTime: null,
      exitPrice: null,
      realizedR: null,
      maxFavorableR: null,
      maxAdverseR: null,
      barsHeld: null,
      tp1HitAt: null,
      tp2HitAt: null,
      tp3HitAt: null,
      executionPolicy: candidate.executionPolicy,
      executionParams: candidate.executionParams,
      atrAtSignal: candidate.atrAtSignal,
      timeoutCandles: (candidate.executionParams as any).timeoutCandles ?? null,
    };
  }

  const atr = candidate.atrAtSignal;
  if (atr === null) {
    return {
      status: "ENTRY_DATA_MISSING",
      entryTime: nextBar.openTime,
      entryPrice: nextBar.open,
      stopLoss: null,
      takeProfit1: null,
      takeProfit2: null,
      takeProfit3: null,
      exitTime: null,
      exitPrice: null,
      realizedR: null,
      maxFavorableR: null,
      maxAdverseR: null,
      barsHeld: null,
      tp1HitAt: null,
      tp2HitAt: null,
      tp3HitAt: null,
      executionPolicy: candidate.executionPolicy,
      executionParams: candidate.executionParams,
      atrAtSignal: atr,
      timeoutCandles: (candidate.executionParams as any).timeoutCandles ?? null,
    };
  }

  const entryPrice = nextBar.open;
  const entryTime = nextBar.openTime;
  const params = candidate.executionParams;

  let sl: number, tp1: number, tp2: number, tp3: number;
  if (candidate.direction === "LONG") {
    sl = entryPrice - atr * params.stopMultiplier;
    tp1 = entryPrice + atr * params.takeProfit1Multiplier;
    tp2 = entryPrice + atr * params.takeProfit2Multiplier;
    tp3 = entryPrice + atr * params.takeProfit3Multiplier;
  } else {
    sl = entryPrice + atr * params.stopMultiplier;
    tp1 = entryPrice - atr * params.takeProfit1Multiplier;
    tp2 = entryPrice - atr * params.takeProfit2Multiplier;
    tp3 = entryPrice - atr * params.takeProfit3Multiplier;
  }

  return {
    status: "OPEN",
    entryTime,
    entryPrice,
    stopLoss: sl,
    takeProfit1: tp1,
    takeProfit2: tp2,
    takeProfit3: tp3,
    exitTime: null,
    exitPrice: null,
    realizedR: null,
    maxFavorableR: 0,
    maxAdverseR: 0,
    barsHeld: 0,
    tp1HitAt: null,
    tp2HitAt: null,
    tp3HitAt: null,
    executionPolicy: candidate.executionPolicy,
    executionParams: candidate.executionParams,
    atrAtSignal: atr,
    timeoutCandles: (candidate.executionParams as any).timeoutCandles ?? null,
  };
}

/**
 * Evaluate subsequent candles for outcome progression
 * - Same-bar pessimistic: SL first
 * - Gap: if open beyond SL/TP, use actual open per backtest contract
 * - TP milestones: TP1_HIT, TP2_HIT, terminal TP3/STOP/EXPIRED
 */
export function evaluateOutcomeProgression(
  outcome: OutcomeState,
  candidate: SmartMoneySignalCandidate,
  candles: CandleForOutcome[]
): OutcomeState {
  if (outcome.status === "WAITING_ENTRY" || outcome.status === "ENTRY_DATA_MISSING") {
    return outcome;
  }
  if (outcome.status === "STOPPED" || outcome.status === "TP3_HIT" || outcome.status === "EXPIRED") {
    return outcome; // terminal
  }

  const entryPrice = outcome.entryPrice!;
  const sl = outcome.stopLoss!;
  const tp1 = outcome.takeProfit1!;
  const tp2 = outcome.takeProfit2!;
  const tp3 = outcome.takeProfit3!;
  const isLong = candidate.direction === "LONG";

  let current = { ...outcome };
  let maxFav = current.maxFavorableR ?? 0;
  let maxAdv = current.maxAdverseR ?? 0;
  let bars = current.barsHeld ?? 0;

  for (const candle of candles) {
    bars += 1;

    // Calculate R for this candle's high/low relative to entry
    // For LONG: favorable = (high - entry)/ (entry - sl) ??? Actually R = (price - entry)/ATR*mult? Simpler: use distance to SL as 1R
    // RealizedR = (exit - entry) / (entry - sl) for LONG, (entry - exit)/(sl - entry) for SHORT
    // For maxFav/Adv, track best/worst price seen
    const high = candle.high;
    const low = candle.low;
    const open = candle.open;

    // Gap check at open: if open already beyond SL or TP
    if (isLong) {
      if (open <= sl) {
        // Gap below SL — use actual open
        return {
          ...current,
          status: "STOPPED",
          exitTime: candle.openTime,
          exitPrice: open,
          realizedR: (open - entryPrice) / (entryPrice - sl), // negative
          maxFavorableR: maxFav,
          maxAdverseR: Math.min(maxAdv, (open - entryPrice) / (entryPrice - sl)),
          barsHeld: bars,
        };
      }
      if (open >= tp3) {
        return {
          ...current,
          status: "TP3_HIT",
          exitTime: candle.openTime,
          exitPrice: open,
          realizedR: (open - entryPrice) / (entryPrice - sl),
          maxFavorableR: Math.max(maxFav, (open - entryPrice) / (entryPrice - sl)),
          maxAdverseR: maxAdv,
          barsHeld: bars,
          tp1HitAt: current.tp1HitAt ?? candle.openTime,
          tp2HitAt: current.tp2HitAt ?? candle.openTime,
          tp3HitAt: candle.openTime,
        };
      }
      if (open >= tp2 && !current.tp2HitAt) {
        current.tp2HitAt = candle.openTime;
        if (!current.tp1HitAt) current.tp1HitAt = candle.openTime;
        current.status = "TP2_HIT";
      } else if (open >= tp1 && !current.tp1HitAt) {
        current.tp1HitAt = candle.openTime;
        current.status = "TP1_HIT";
      }
    } else {
      // SHORT
      if (open >= sl) {
        return {
          ...current,
          status: "STOPPED",
          exitTime: candle.openTime,
          exitPrice: open,
          realizedR: (entryPrice - open) / (sl - entryPrice),
          maxFavorableR: maxFav,
          maxAdverseR: Math.min(maxAdv, (entryPrice - open) / (sl - entryPrice)),
          barsHeld: bars,
        };
      }
      if (open <= tp3) {
        return {
          ...current,
          status: "TP3_HIT",
          exitTime: candle.openTime,
          exitPrice: open,
          realizedR: (entryPrice - open) / (sl - entryPrice),
          maxFavorableR: Math.max(maxFav, (entryPrice - open) / (sl - entryPrice)),
          maxAdverseR: maxAdv,
          barsHeld: bars,
          tp1HitAt: current.tp1HitAt ?? candle.openTime,
          tp2HitAt: current.tp2HitAt ?? candle.openTime,
          tp3HitAt: candle.openTime,
        };
      }
      if (open <= tp2 && !current.tp2HitAt) {
        current.tp2HitAt = candle.openTime;
        if (!current.tp1HitAt) current.tp1HitAt = candle.openTime;
        current.status = "TP2_HIT";
      } else if (open <= tp1 && !current.tp1HitAt) {
        current.tp1HitAt = candle.openTime;
        current.status = "TP1_HIT";
      }
    }

    // Same-bar pessimistic: check SL first, then TP
    if (isLong) {
      // Update maxFav/Adv based on high/low
      const favR = (high - entryPrice) / (entryPrice - sl);
      const advR = (low - entryPrice) / (entryPrice - sl);
      maxFav = Math.max(maxFav, favR);
      maxAdv = Math.min(maxAdv, advR);

      if (low <= sl) {
        // SL hit — pessimistic first
        return {
          ...current,
          status: "STOPPED",
          exitTime: candle.openTime,
          exitPrice: sl,
          realizedR: -1,
          maxFavorableR: maxFav,
          maxAdverseR: maxAdv,
          barsHeld: bars,
        };
      }
      if (high >= tp3) {
        return {
          ...current,
          status: "TP3_HIT",
          exitTime: candle.openTime,
          exitPrice: tp3,
          realizedR: (tp3 - entryPrice) / (entryPrice - sl),
          maxFavorableR: maxFav,
          maxAdverseR: maxAdv,
          barsHeld: bars,
          tp1HitAt: current.tp1HitAt ?? candle.openTime,
          tp2HitAt: current.tp2HitAt ?? candle.openTime,
          tp3HitAt: candle.openTime,
        };
      }
      if (high >= tp2 && !current.tp2HitAt) {
        current.tp2HitAt = candle.openTime;
        if (!current.tp1HitAt) current.tp1HitAt = candle.openTime;
        current.status = "TP2_HIT";
      } else if (high >= tp1 && !current.tp1HitAt) {
        current.tp1HitAt = candle.openTime;
        current.status = "TP1_HIT";
      }
    } else {
      // SHORT
      const favR = (entryPrice - low) / (sl - entryPrice);
      const advR = (entryPrice - high) / (sl - entryPrice);
      maxFav = Math.max(maxFav, favR);
      maxAdv = Math.min(maxAdv, advR);

      if (high >= sl) {
        return {
          ...current,
          status: "STOPPED",
          exitTime: candle.openTime,
          exitPrice: sl,
          realizedR: -1,
          maxFavorableR: maxFav,
          maxAdverseR: maxAdv,
          barsHeld: bars,
        };
      }
      if (low <= tp3) {
        return {
          ...current,
          status: "TP3_HIT",
          exitTime: candle.openTime,
          exitPrice: tp3,
          realizedR: (entryPrice - tp3) / (sl - entryPrice),
          maxFavorableR: maxFav,
          maxAdverseR: maxAdv,
          barsHeld: bars,
          tp1HitAt: current.tp1HitAt ?? candle.openTime,
          tp2HitAt: current.tp2HitAt ?? candle.openTime,
          tp3HitAt: candle.openTime,
        };
      }
      if (low <= tp2 && !current.tp2HitAt) {
        current.tp2HitAt = candle.openTime;
        if (!current.tp1HitAt) current.tp1HitAt = candle.openTime;
        current.status = "TP2_HIT";
      } else if (low <= tp1 && !current.tp1HitAt) {
        current.tp1HitAt = candle.openTime;
        current.status = "TP1_HIT";
      }
    }

    current.maxFavorableR = maxFav;
    current.maxAdverseR = maxAdv;
    current.barsHeld = bars;
  }

  // Timeout check (design only, not enforced yet — timeoutCandles versioned part of executionPolicy)
  // If timeoutCandles set and bars >= timeout, EXPIRED
  if (current.timeoutCandles !== null && current.timeoutCandles !== undefined && bars >= current.timeoutCandles) {
    const lastCandle = candles[candles.length - 1];
    const exitPrice = lastCandle ? lastCandle.close : entryPrice;
    const realizedR = isLong ? (exitPrice - entryPrice) / (entryPrice - sl) : (entryPrice - exitPrice) / (sl - entryPrice);
    return {
      ...current,
      status: "EXPIRED",
      exitTime: lastCandle?.openTime ?? null,
      exitPrice,
      realizedR,
      barsHeld: bars,
    };
  }

  return current;
}

/**
 * Full evaluation from candidate through nextBar + subsequent
 */
export function evaluateFullOutcome(input: OutcomeEvalInput): OutcomeState {
  const initial = buildInitialOutcome({ candidate: input.candidate, nextBar: input.nextBar });
  if (initial.status !== "OPEN" && initial.status !== "TP1_HIT" && initial.status !== "TP2_HIT") {
    return initial;
  }
  return evaluateOutcomeProgression(initial, input.candidate, input.subsequentCandles);
}
