/**
 * Signal Engine — BTC ONLY pilot, production-ready, NO forbidden copy.
 * PHASE 2C + EDGE/RE-ARM V1 — SMC EVENT SEMANTICS
 *
 * Key PHASE 2C: no optimistic fallback, WAITING_ENTRY, ENTRY_DATA_MISSING, SL/TP only after real NEXT_BAR_OPEN, Signal vs Outcome, LEGACY default, AND guard
 * EDGE V1:
 *   Aggregate states: NEUTRAL, LONG, SHORT, CANNOT_EVALUATE/DATA_UNAVAILABLE/QUORUM_NOT_MET etc
 *   Transitions:
 *     NEUTRAL->LONG/SHORT = EMIT EDGE
 *     LONG->LONG, SHORT->SHORT = HOLD
 *     LONG->NEUTRAL, SHORT->NEUTRAL = RE-ARM
 *     LONG->SHORT, SHORT->LONG = EMIT reversal
 *     Any->UNAVAILABLE = PRESERVE (no re-arm) — SHORT->DATA_UNAVAILABLE->SHORT must NOT emit second
 *   Persistent: StrategySignalState unique [strategyId,symbol,timeframe] survives PM2 restart
 *   Idempotent: same horizon twice no-op, older horizon refused
 *   Transactional: Signal+Outcome+State in ONE prisma.$transaction, P2002 idempotent, concurrent safe
 *   Bootstrap: no state + current SHORT => BOOTSTRAP SHORT NO SIGNAL default, only after SHORT->NEUTRAL->SHORT or reversal. Optional --emit-on-bootstrap default false
 *   Dry-run: NEVER mutates StrategySignalState, READ-ONLY load, logs proposed transition
 */

import { prisma } from "../prisma";
import { validateTrendSuslikConfig } from "../strategies/config";
import { evaluateSnapshot, aggregateAssetGroup, type SnapshotInput } from "../strategies/runtime";
import { isSmartMoneyExchangeEligible } from "../strategies/smart-money-eligibility";
import { validateSmartMoneyConfig } from "../strategies/smart-money";
import { evaluateMarketsAtCommonHorizon, type SmartMoneyMarketMeta } from "../strategies/smart-money";
import { isSmcTimeframe, SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../smc/types";
import { formatCommonHorizonReport, decideAggregationAtCommonHorizon } from "../strategies/common-horizon";
import { selectQuorumClosedHorizon } from "../strategies/common-horizon-quorum";
import { buildSmartMoneySignalCandidate } from "./smart-money-candidate";
import { computeEdgeTransition, type AggregateState } from "./edge-state-machine";
import { buildSetupKeyFromCandidate } from "./setup-key";

export type SignalEngineResult = {
  evaluatedMarkets: number;
  evaluatedAssets: number;
  signalsCreated: number;
  signalsSkippedDuplicate: number;
  signalsSkippedCooldown: number;
  signalsSkippedFiltered: number;
  longSignals: number;
  shortSignals: number;
  neutralGroups: number;
  errors: string[];
};

type IndicatorSnapshotRow = {
  marketId: number;
  timeframe: string;
  candleTime: Date;
  price: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  atr14: number | null;
  volume: number | null;
  avgVolume20: number | null;
  volumeRatio: number | null;
};

// ---------------------------------------------------------------------------
// TREND SUSLIK path (existing, untouched)
// ---------------------------------------------------------------------------

async function runTrendSuslikEngine(opts: {
  timeframe: string;
  dryRun: boolean;
  symbol: string;
  strategies: any[];
  eligibleMarkets: any[];
  asset: { id: number; symbol: string; rank: number | null };
  result: SignalEngineResult;
}): Promise<void> {
  const { timeframe, dryRun, symbol, strategies, eligibleMarkets, asset, result } = opts;

  for (const strategy of strategies) {
    if (strategy.slug !== "trend-suslik") continue;

    const validation = validateTrendSuslikConfig(strategy.config);
    if (!validation.ok) {
      result.errors.push(`Strategy id=${strategy.id} config invalid: ${validation.errors.join("; ")}`);
      continue;
    }
    const config = validation.config;
    console.log(`\nStrategy ${strategy.slug} v${strategy.version} id=${strategy.id} minScore=${config.minimumSignalScore} minExchanges=${strategy.minExchanges} timeframes=${strategy.timeframes.join(",")}`);

    if (!strategy.timeframes.includes(timeframe)) {
      console.log(`  Skipped timeframe ${timeframe} not in strategy timeframes ${strategy.timeframes.join(",")}`);
      continue;
    }

    const snapshots: IndicatorSnapshotRow[] = [];
    for (const market of eligibleMarkets) {
      const snap = await prisma.indicatorSnapshot.findFirst({
        where: { marketId: market.id, timeframe },
        orderBy: { candleTime: "desc" },
        select: {
          marketId: true,
          timeframe: true,
          candleTime: true,
          price: true,
          rsi14: true,
          ema20: true,
          ema50: true,
          ema200: true,
          macd: true,
          macdSignal: true,
          macdHist: true,
          atr14: true,
          volume: true,
          avgVolume20: true,
          volumeRatio: true,
        },
      });
      if (snap) snapshots.push(snap as any);
    }

    console.log(`  Snapshots found: ${snapshots.length}/${eligibleMarkets.length} for timeframe ${timeframe}`);
    result.evaluatedMarkets += snapshots.length;

    if (snapshots.length === 0) {
      console.log(`  No snapshots — need to run snapshot-worker for ${symbol} ${timeframe}`);
      continue;
    }

    const inputs: SnapshotInput[] = snapshots.map((snap: any) => {
      const market = eligibleMarkets.find((m: any) => m.id === snap.marketId)!;
      return {
        marketId: snap.marketId,
        exchange: market.exchange,
        exchangeSymbol: market.exchangeSymbol,
        assetSymbol: symbol,
        assetRank: asset.rank,
        quoteVolume24h: market.quoteVolume24h,
        timeframe: snap.timeframe,
        candleTime: snap.candleTime,
        price: snap.price,
        rsi14: snap.rsi14,
        ema20: snap.ema20,
        ema50: snap.ema50,
        ema200: snap.ema200,
        macd: snap.macd,
        macdSignal: snap.macdSignal,
        macdHist: snap.macdHist,
        atr14: snap.atr14,
        volume: snap.volume,
        avgVolume20: snap.avgVolume20,
        volumeRatio: snap.volumeRatio,
      };
    });

    const marketResults = inputs.map((input: any) => evaluateSnapshot(input, config));

    const aggregation = aggregateAssetGroup(
      symbol,
      timeframe,
      strategy.slug,
      strategy.version,
      marketResults as any,
      strategy.minExchanges
    );

    console.log(`  Aggregation: direction=${aggregation.direction} confirmation=${aggregation.confirmation} evaluated=${aggregation.evaluated} longVotes=${aggregation.longVotes} shortVotes=${aggregation.shortVotes} neutralVotes=${aggregation.neutralVotes} conflict=${aggregation.conflict}`);
    console.log(`  Explanation: ${aggregation.explanation}`);
    result.evaluatedAssets++;

    if (aggregation.direction === "NEUTRAL") {
      result.neutralGroups++;
      console.log(`  NEUTRAL — no signal created`);
      continue;
    }

    const lastSignal = await prisma.signal.findFirst({
      where: { strategyId: strategy.id, symbol, timeframe },
      orderBy: { createdAt: "desc" },
    });

    if (lastSignal) {
      const cooldownCandles = config.execution.cooldownCandles;
      const tfMsMap: Record<string, number> = {
        "5m": 5 * 60 * 1000,
        "15m": 15 * 60 * 1000,
        "1h": 60 * 60 * 1000,
        "4h": 4 * 60 * 60 * 1000,
        "1d": 24 * 60 * 60 * 1000,
      };
      const tfMs = tfMsMap[timeframe] ?? 60 * 60 * 1000;
      const cooldownMs = cooldownCandles * tfMs;
      const ageMs = Date.now() - lastSignal.createdAt.getTime();

      if (ageMs < cooldownMs) {
        console.log(`  Cooldown: last signal ${lastSignal.id} age ${Math.floor(ageMs / 1000)}s < cooldown ${cooldownCandles} candles (${cooldownMs / 1000}s) — skipped`);
        result.signalsSkippedCooldown++;
        continue;
      }

      if (lastSignal.direction === aggregation.direction && ageMs < tfMs) {
        console.log(`  Duplicate: last signal same direction ${lastSignal.direction} within 1 candle — skipped`);
        result.signalsSkippedDuplicate++;
        continue;
      }
    }

    const evaluated = aggregation.markets.filter((m: any) => m.status === "evaluated") as any[];
    const avgPrice = evaluated.length > 0 ? evaluated.reduce((sum: number, m: any) => sum + m.price, 0) / evaluated.length : 0;
    const atrValues = inputs.map((i: any) => i.atr14).filter((v: any) => v !== null && v > 0) as number[];
    const avgAtrReal = atrValues.length > 0 ? atrValues.reduce((a: number, b: number) => a + b, 0) / atrValues.length : 350;

    const entry = avgPrice;
    let stopLoss: number | null = null;
    let tp1: number | null = null;
    let tp2: number | null = null;
    let tp3: number | null = null;

    if (aggregation.direction === "LONG") {
      stopLoss = entry - avgAtrReal * config.atr.stopMultiplier;
      tp1 = entry + avgAtrReal * config.atr.takeProfit1Multiplier;
      tp2 = entry + avgAtrReal * config.atr.takeProfit2Multiplier;
      tp3 = entry + avgAtrReal * config.atr.takeProfit3Multiplier;
    } else if (aggregation.direction === "SHORT") {
      stopLoss = entry + avgAtrReal * config.atr.stopMultiplier;
      tp1 = entry - avgAtrReal * config.atr.takeProfit1Multiplier;
      tp2 = entry - avgAtrReal * config.atr.takeProfit2Multiplier;
      tp3 = entry - avgAtrReal * config.atr.takeProfit3Multiplier;
    }

    const score = aggregation.direction === "LONG" ? Math.max(...evaluated.map((m: any) => m.longScore)) : Math.max(...evaluated.map((m: any) => m.shortScore));
    const reasons = evaluated.flatMap((m: any) => m.reasons.filter((r: any) => r.long || r.short).map((r: any) => r.label)).slice(0, 5).join("; ");

    console.log(`  Signal candidate: ${aggregation.direction} entry=${entry.toFixed(2)} SL=${stopLoss?.toFixed(2)} TP1=${tp1?.toFixed(2)} TP2=${tp2?.toFixed(2)} TP3=${tp3?.toFixed(2)} score=${score} ATR=${avgAtrReal.toFixed(2)}`);

    if (dryRun) {
      console.log(`  DRY-RUN — not inserting, would create signal`);
      result.signalsCreated++;
      if (aggregation.direction === "LONG") result.longSignals++;
      else result.shortSignals++;
      continue;
    }

    try {
      const created = await prisma.signal.create({
        data: {
          symbol,
          timeframe,
          direction: aggregation.direction,
          score,
          entry,
          stopLoss,
          takeProfit1: tp1,
          takeProfit2: tp2,
          takeProfit3: tp3,
          status: "ACTIVE",
          reason: `${aggregation.explanation} | ${reasons} | confirmation ${aggregation.confirmation} | ATR ${avgAtrReal.toFixed(2)} | ${evaluated.length} markets`,
          strategyId: strategy.id,
          signalSource: "LEGACY",
        },
      });
      console.log(`  CREATED signal id=${created.id} ${created.direction} ${created.symbol} ${created.timeframe} score=${created.score}`);
      result.signalsCreated++;
      if (aggregation.direction === "LONG") result.longSignals++;
      else result.shortSignals++;
    } catch (e: any) {
      if (e.code === "P2002" || e.message?.includes("Unique constraint")) {
        console.log(`  Duplicate constraint — skipped`);
        result.signalsSkippedDuplicate++;
      } else {
        console.error(`  Error creating signal: ${e.message}`);
        result.errors.push(`Create signal error: ${e.message}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// SMART MONEY path — EDGE/RE-ARM V1
// ---------------------------------------------------------------------------

async function runSmartMoneyEngine(opts: {
  timeframe: string;
  dryRun: boolean;
  symbol: string;
  strategies: any[];
  eligibleMarkets: any[];
  asset: { id: number; symbol: string; rank: number | null };
  result: SignalEngineResult;
  enableSmartMoneyWrite?: boolean;
  emitOnBootstrap?: boolean;
  commonHorizonPolicy?: "STRICT" | "QUORUM";
}): Promise<void> {
  const { timeframe, dryRun, symbol, strategies, eligibleMarkets, asset, result, enableSmartMoneyWrite, emitOnBootstrap, commonHorizonPolicy } = opts;

  if (!isSmcTimeframe(timeframe)) {
    result.errors.push(`Timeframe ${timeframe} not in SMC whitelist`);
    return;
  }
  const tf = timeframe as SmcTimeframe;
  const policy = commonHorizonPolicy ?? "QUORUM";

  let strategy = strategies.find((s: any) => s.slug === "smart-money-suslik");
  if (!strategy) {
    const anySm = await prisma.strategy.findFirst({
      where: { slug: "smart-money-suslik" },
      orderBy: { version: "desc" },
    });
    if (!anySm) {
      result.errors.push("Strategy smart-money-suslik not found — need seed-smart-money");
      return;
    }
    strategy = anySm as any;
    console.log(`  Using fallback strategy id=${strategy.id} slug=${strategy.slug} enabled=${strategy.enabled} status=${strategy.status} (dry-run allowed)`);
  }

  console.log(`\nStrategy ${strategy.slug} v${strategy.version} id=${strategy.id} minExchanges=${strategy.minExchanges} timeframes=${strategy.timeframes.join(",")} policy=${policy} emitOnBootstrap=${emitOnBootstrap}`);

  if (!strategy.timeframes.includes(timeframe)) {
    console.log(`  Skipped timeframe ${timeframe} not in strategy timeframes ${strategy.timeframes.join(",")}`);
    result.errors.push(`Timeframe ${timeframe} not in strategy timeframes`);
    return;
  }

  const validation = validateSmartMoneyConfig(strategy.config, tf);
  if (!validation.ok) {
    result.errors.push(`Strategy id=${strategy.id} config invalid: ${validation.errors.join("; ")}`);
    console.error(`  Config invalid: ${validation.errors.join("; ")}`);
    return;
  }
  const smcConfig = validation.config;
  const filters = validation.filters;

  console.log(`  Config validated: minimumSignalScore=${smcConfig.minimumScore} swing ${smcConfig.swingLeft}/${smcConfig.swingRight} internal ${smcConfig.internalLeft}/${smcConfig.internalRight} atrPeriod=${smcConfig.atrPeriod}`);

  type LoadedMarket = { meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] };
  const loaded: LoadedMarket[] = [];

  for (const market of eligibleMarkets) {
    const rows = await prisma.candle.findMany({
      where: { marketId: market.id, timeframe, closed: true },
      orderBy: { openTime: "desc" },
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
    const meta: SmartMoneyMarketMeta = {
      exchange: market.exchange,
      market: market.exchangeSymbol,
      marketId: market.id,
      timeframe: tf,
      assetRank: asset.rank,
      quoteVolume24h: market.quoteVolume24h,
    };
    loaded.push({ meta, candles });
  }

  console.log(`  Loaded CLOSED candles: ${loaded.length} markets, each up to 500`);

  const now = new Date();

  if (policy === "QUORUM") {
    const quorumSel = selectQuorumClosedHorizon(
      loaded.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles })),
      tf,
      { now, minExchanges: strategy.minExchanges }
    );
    console.log(`\n=== QUORUM POLICY === now=${now.toISOString()} expectedLatestClosed=${quorumSel.expectedLatestClosed.toISOString()} status=${quorumSel.status} fresh=${quorumSel.freshCount} stale=${quorumSel.staleCount}`);
  }

  // Build candidate — no optimistic fallback
  const builderResult = buildSmartMoneySignalCandidate({
    markets: loaded,
    timeframe: tf,
    smcConfig,
    filters,
    now,
    strategyId: strategy.id,
    strategyVersion: strategy.version,
    strategySlug: strategy.slug,
    symbol,
    minExchanges: strategy.minExchanges,
    policy,
    nextBarCandles: undefined,
  });

  // Determine current aggregate state for edge machine
  let currentAggregate: AggregateState;
  let currentCandleTime: Date | null = null;
  let candidateForEmit: any = null;

  if (builderResult.status === "ok") {
    candidateForEmit = builderResult.candidate;
    currentAggregate = candidateForEmit.direction as AggregateState; // LONG/SHORT
    currentCandleTime = candidateForEmit.signalCandleTime;
  } else {
    // No signal — distinguish NEUTRAL vs UNAVAILABLE
    const sel = builderResult.selection as any;
    const reason = builderResult.reason || "";
    const insufficient = builderResult.insufficientReason || "";

    // Map to AggregateState
    if (insufficient.includes("INSUFFICIENT") || sel?.status === "quorum_not_met") {
      currentAggregate = "QUORUM_NOT_MET";
    } else if (reason.includes("NEUTRAL") || insufficient === "NO_CONFIRMATION" || insufficient === "CONFLICT") {
      currentAggregate = "NEUTRAL";
    } else if (sel?.status === "future_horizon") {
      currentAggregate = "FUTURE_HORIZON";
    } else if (sel?.status === "absolute_stale" || reason.includes("stale")) {
      currentAggregate = "ABSOLUTE_STALE";
    } else if (reason.includes("CANNOT") || insufficient.includes("CANNOT")) {
      currentAggregate = "CANNOT_EVALUATE";
    } else {
      currentAggregate = "DATA_UNAVAILABLE";
    }
    currentCandleTime = sel?.commonHorizon || sel?.expectedLatestClosed || now;
    console.log(`\nNO SIGNAL — mapped to aggregateState=${currentAggregate} reason=${reason} insufficient=${insufficient}`);
  }

  // Load persistent state
  let stateRow: any = null;
  try {
    stateRow = await prisma.strategySignalState.findUnique({
      where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } },
    });
  } catch (e: any) {
    console.log(`  StrategySignalState table not exists yet (migration not applied) — will use in-memory for dry-run, fail-closed for live`);
    stateRow = null;
  }

  console.log(`\n=== EDGE STATE MACHINE V1 ===`);
  console.log(`Previous state: ${stateRow ? `${stateRow.aggregateState} lastEvaluated=${stateRow.lastEvaluatedCandleTime?.toISOString()} lastSignal=${stateRow.lastSignalCandleTime?.toISOString()} ${stateRow.lastSignalDirection}` : "null (bootstrap)"}`);
  console.log(`Current aggregate: ${currentAggregate} candleTime=${currentCandleTime?.toISOString()}`);

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

  console.log(`Transition: ${transition.previousState ?? "null"} -> ${transition.currentAggregate} action=${transition.action} shouldEmit=${transition.shouldEmit} emitDir=${transition.emitDirection} trigger=${transition.triggerType} reason=${transition.reason}`);

  result.evaluatedMarkets = loaded.length;
  result.evaluatedAssets = 1;

  // WRITE GUARD AND
  const flagEnabled = enableSmartMoneyWrite === true;
  const envEnabled = process.env.SMART_MONEY_WRITE_ENABLED === "true";
  const writeAllowed = flagEnabled && envEnabled;

  console.log(`\n=== WRITE GUARD AND === flag=${flagEnabled} env=${envEnabled} => allowed=${writeAllowed}`);

  // Helper to detect unavailable status for same-horizon provisional logic
  function isUnavailableStatus(s: string | null | undefined): boolean {
    if (!s) return false;
    const u = s.toUpperCase();
    return u.includes("CANNOT") || u.includes("DATA_UNAVAILABLE") || u.includes("QUORUM") || u.includes("FUTURE") || u.includes("STALE");
  }
  function isEvaluableAggregate(a: AggregateState): boolean {
    return a === "NEUTRAL" || a === "LONG" || a === "SHORT";
  }

  // Handle idempotent and refuse cases
  if (transition.action === "NOOP_SAME_HORIZON") {
    console.log(`Idempotent no-op — same horizon already evaluated, no state mutation, no signal`);
    result.signalsSkippedDuplicate++;
    return;
  }
  if (transition.action === "REFUSE_OLDER_HORIZON") {
    console.log(`Refuse older horizon — regression, no state mutation`);
    result.errors.push(`Refuse older horizon ${transition.currentCandleTime.toISOString()} < lastEvaluated`);
    return;
  }
  if (transition.action === "PRESERVE_UNAVAILABLE") {
    console.log(`Preserve unavailable — ${currentAggregate} does NOT re-arm, state preserved but lastEvaluated updated`);
    if (dryRun) {
      console.log(`DRY-RUN — would update lastEvaluatedCandleTime to ${transition.currentCandleTime.toISOString()} but preserve aggregateState=${transition.previousState}`);
      result.neutralGroups++;
      return;
    }
    if (!writeAllowed) {
      console.log(`WRITE BLOCKED — dry-run forced for preserve unavailable`);
      result.neutralGroups++;
      return;
    }
    // Update only lastEvaluated, preserve aggregateState — but same-horizon provisional idempotent
    try {
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.strategySignalState.findUnique({ where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } } });
        if (existing) {
          // Same-horizon: if already finalized evaluable, do NOT overwrite with provisional unavailable (preserve finalized)
          // If already provisional unavailable same horizon, NOOP to avoid churn
          if (existing.lastEvaluatedCandleTime && existing.lastEvaluatedCandleTime.getTime() === transition.currentCandleTime.getTime()) {
            // If existing was evaluable finalized, keep it, don't overwrite with unavailable
            // If existing was already unavailable provisional, idempotent NOOP
            return;
          }
          if (existing.lastEvaluatedCandleTime && transition.currentCandleTime.getTime() < existing.lastEvaluatedCandleTime.getTime()) {
            throw new Error(`Refuse older horizon in tx`);
          }
          await tx.strategySignalState.update({
            where: { id: existing.id },
            data: {
              lastEvaluatedCandleTime: transition.currentCandleTime,
              lastEvaluationStatus: currentAggregate,
              metadata: { lastReason: transition.reason, lastAction: transition.action } as any,
            },
          });
        } else {
          await tx.strategySignalState.create({
            data: {
              strategyId: strategy.id,
              symbol,
              timeframe,
              lastEvaluatedCandleTime: transition.currentCandleTime,
              aggregateState: "NEUTRAL",
              lastEvaluationStatus: currentAggregate,
              metadata: { bootstrapFromUnavailable: true, lastReason: transition.reason } as any,
            },
          });
        }
      });
      console.log(`  State preserved for unavailable`);
      result.neutralGroups++;
    } catch (e: any) {
      console.error(`  Error preserving unavailable state: ${e.message}`);
      result.errors.push(`Preserve unavailable error: ${e.message}`);
    }
    return;
  }

  // For NEUTRAL, HOLD, REARM, BOOTSTRAP_NO_SIGNAL — update state only, no signal
  if (!transition.shouldEmit) {
    if (transition.action === "BOOTSTRAP_NO_SIGNAL") {
      console.log(`\nBOOTSTRAP_NO_SIGNAL — ${transition.reason} — state will be created as ${currentAggregate} without signal (default)`);
    } else if (transition.action === "REARM") {
      console.log(`\nRE-ARM — ${transition.reason} — will update state to NEUTRAL`);
    } else if (transition.action === "HOLD") {
      console.log(`\nHOLD — ${transition.reason} — will update lastEvaluated but keep ${transition.previousState}`);
    }

    if (dryRun) {
      console.log(`DRY-RUN — would update state to ${currentAggregate} at ${transition.currentCandleTime.toISOString()} but persist nothing (no Signal, no Outcome, no State mutation)`);
      result.neutralGroups++;
      return;
    }

    if (!writeAllowed) {
      console.log(`WRITE BLOCKED — dry-run forced for state update ${transition.action}`);
      result.neutralGroups++;
      return;
    }

    // Live state-only update — FIX: allow same-horizon re-evaluation if previous was provisional unavailable and current is evaluable
    try {
      await prisma.$transaction(async (tx: any) => {
        const existing = await tx.strategySignalState.findUnique({ where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } } });
        if (existing) {
          if (existing.lastEvaluatedCandleTime && existing.lastEvaluatedCandleTime.getTime() === transition.currentCandleTime.getTime()) {
            // If previous was provisional unavailable and current is evaluable (NEUTRAL/LONG/SHORT), allow re-evaluation (don't NOOP)
            const prevWasUnavailable = isUnavailableStatus(existing.lastEvaluationStatus);
            const currIsEvaluable = isEvaluableAggregate(currentAggregate);
            if (prevWasUnavailable && currIsEvaluable) {
              // allow — provisional 16:15 QUORUM_NOT_MET -> evaluable 16:15 SHORT/NEUTRAL must be processed
            } else {
              return; // idempotent NOOP for finalized or repeated unavailable
            }
          }
          if (existing.lastEvaluatedCandleTime && transition.currentCandleTime.getTime() < existing.lastEvaluatedCandleTime.getTime()) throw new Error("Refuse older horizon");
          await tx.strategySignalState.update({
            where: { id: existing.id },
            data: {
              lastEvaluatedCandleTime: transition.currentCandleTime,
              aggregateState: currentAggregate,
              lastEvaluationStatus: currentAggregate,
              metadata: { lastReason: transition.reason, lastAction: transition.action } as any,
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
              metadata: { lastReason: transition.reason, lastAction: transition.action } as any,
            },
          });
        }
      });
      console.log(`  State updated to ${currentAggregate} at ${transition.currentCandleTime.toISOString()}`);
      result.neutralGroups++;
    } catch (e: any) {
      if (e.code === "P2002" || e.message?.includes("Unique constraint")) {
        console.log(`  Duplicate state unique — idempotent`);
        result.signalsSkippedDuplicate++;
      } else {
        console.error(`  Error updating state: ${e.message}`);
        result.errors.push(`State update error: ${e.message}`);
      }
    }
    return;
  }

  // EMIT path — shouldEmit true
  if (!candidateForEmit) {
    console.log(`  Inconsistent: shouldEmit true but no candidate — no signal`);
    result.errors.push("Emit true but no candidate");
    return;
  }

  const candidate = candidateForEmit;
  const setupKey = buildSetupKeyFromCandidate(candidate, strategy.version);

  console.log(`\n=== CANDIDATE FOR EMIT (${transition.triggerType}) ===`);
  console.log(`signalCandleTime=${candidate.signalCandleTime.toISOString()} direction=${candidate.direction} score=${candidate.score} trigger=${transition.triggerType} setupKey=${setupKey.slice(0, 80)}...`);
  console.log(`reference=${candidate.referenceExchange} refPrice=${candidate.referencePrice} (analytic) fallback=${candidate.referenceFallback}`);
  console.log(`executionStatus=${candidate.executionStatus} entry=${candidate.entry} atr=${candidate.atrAtSignal}`);

  if (dryRun) {
    console.log(`\nDRY-RUN — would EMIT ${transition.emitDirection} with trigger ${transition.triggerType} at ${candidate.signalCandleTime.toISOString()} but persist nothing (no Signal, no Outcome, no State mutation)`);
    console.log(`Previous state ${transition.previousState} -> ${transition.currentAggregate} action ${transition.action}`);
    result.signalsCreated++;
    if (transition.emitDirection === "LONG") result.longSignals++;
    else result.shortSignals++;
    return;
  }

  if (!writeAllowed) {
    console.log(`\nWRITE BLOCKED — need BOTH --enable-smart-money-write AND SMART_MONEY_WRITE_ENABLED=true — dry-run forced, would emit ${transition.emitDirection}`);
    result.signalsCreated++;
    if (transition.emitDirection === "LONG") result.longSignals++;
    else result.shortSignals++;
    return;
  }

  // Transactional write: Signal + Outcome + State update in ONE transaction — STRICT ATOMICITY + provisional fix
  // Either all commit or all rollback. No "backfillable" Signal if Outcome fails.
  // FIX: same-horizon provisional unavailable -> evaluable must be allowed, not blocked as NOOP
  console.log(`\nLIVE WRITE ALLOWED — STRICT ATOMIC transactional emit: Signal+Outcome+State in ONE transaction (provisional fix)`);
  try {
    await prisma.$transaction(async (tx: any) => {
      // Re-check state inside transaction for concurrency — with provisional semantics
      const existingState = await tx.strategySignalState.findUnique({ where: { strategyId_symbol_timeframe: { strategyId: strategy.id, symbol, timeframe } } });
      if (existingState) {
        if (existingState.lastEvaluatedCandleTime && existingState.lastEvaluatedCandleTime.getTime() === transition.currentCandleTime.getTime()) {
          const prevWasUnavailable = isUnavailableStatus(existingState.lastEvaluationStatus);
          const currIsEvaluable = isEvaluableAggregate(currentAggregate);
          if (prevWasUnavailable && currIsEvaluable) {
            // Allow re-evaluation: provisional 16:15 QUORUM_NOT_MET -> 16:15 SHORT must emit
            console.log(`  Same horizon ${transition.currentCandleTime.toISOString()} but prev was provisional ${existingState.lastEvaluationStatus} -> evaluable ${currentAggregate}: allowing re-evaluation (fix)`);
          } else {
            console.log(`  Concurrent same horizon already processed — idempotent no-op inside tx (prevStatus=${existingState.lastEvaluationStatus})`);
            return;
          }
        }
        if (existingState.lastEvaluatedCandleTime && transition.currentCandleTime.getTime() < existingState.lastEvaluatedCandleTime.getTime()) {
          throw new Error(`Refuse older horizon inside tx`);
        }
        if (existingState.aggregateState === currentAggregate && existingState.lastSignalCandleTime && existingState.lastSignalCandleTime.getTime() === candidate.signalCandleTime.getTime()) {
          // But if previous was provisional unavailable, this duplicate check should not block if we are now evaluable and previous had no signal?
          // If lastSignalCandleTime == candidate time, it means we already emitted for this candle, so skip
          // However if previous evaluation was provisional unavailable, lastSignalCandleTime would be from earlier horizon, not this one, so this check is safe
          console.log(`  Duplicate signal already exists for same candle — skip inside tx`);
          // Additional guard: if existing lastEvaluationStatus was unavailable, this duplicate may be false positive? But if lastSignalCandleTime == candidate time, it means signal already exists, so safe to skip
          // To be extra safe, check if existing lastEvaluationStatus was unavailable -> allow? But signal existence means already emitted, so skip
          return;
        }
      }

      // Create Signal — if this throws, nothing committed
      const created = await tx.signal.create({
        data: {
          symbol: candidate.symbol,
          timeframe: candidate.timeframe,
          direction: candidate.direction,
          score: candidate.score,
          entry: candidate.entry,
          stopLoss: candidate.stopLoss,
          takeProfit1: candidate.takeProfit1,
          takeProfit2: candidate.takeProfit2,
          takeProfit3: candidate.takeProfit3,
          status: candidate.executionStatus === "READY" ? "ACTIVE" : candidate.executionStatus,
          reason: candidate.reason.slice(0, 1000),
          strategyId: candidate.strategyId,
          signalCandleTime: candidate.signalCandleTime,
          referenceExchange: candidate.referenceExchange,
          referencePrice: candidate.referencePrice,
          aggregatePrice: candidate.aggregatePrice,
          executionPolicy: candidate.executionPolicy,
          signalSource: "LIVE_FORWARD",
          metadata: { ...candidate.metadata, triggerType: transition.triggerType, setupKey, edgeTransition: transition } as any,
          atrAtSignal: candidate.atrAtSignal,
          nextBarOpenPrice: candidate.entry,
          nextBarOpenTime: candidate.entryTime,
          participantCount: candidate.participantCount,
          evaluatedCount: candidate.evaluatedCount,
          longVotes: candidate.metadata.longVotes,
          shortVotes: candidate.metadata.shortVotes,
          neutralVotes: candidate.metadata.neutralVotes,
          confirmationCount: candidate.confirmationCount,
          confirmationTotal: candidate.confirmationTotal,
          commonHorizonPolicy: candidate.metadata.policy,
          referenceFallback: candidate.referenceFallback,
          setupKey,
          triggerType: transition.triggerType,
        },
      });
      console.log(`  CREATED signal id=${created.id} ${created.direction} ${created.symbol} ${created.timeframe} candle=${created.signalCandleTime?.toISOString()} trigger=${created.triggerType}`);

      // Create Outcome — STRICT: if throws, whole transaction rolls back Signal + State
      const outcome = await tx.signalOutcome.create({
        data: {
          signalId: created.id,
          status: candidate.executionStatus === "READY" ? "OPEN" : candidate.executionStatus,
          entryTime: candidate.entryTime,
          entryPrice: candidate.entry,
          stopLoss: candidate.stopLoss,
          takeProfit1: candidate.takeProfit1,
          takeProfit2: candidate.takeProfit2,
          takeProfit3: candidate.takeProfit3,
          executionPolicy: candidate.executionPolicy,
          executionParams: candidate.executionParams as any,
          atrAtSignal: candidate.atrAtSignal,
          timeoutCandles: (candidate.executionParams as any).timeoutCandles ?? null,
        },
      });
      console.log(`  CREATED outcome id=${outcome.id} signalId=${outcome.signalId} status=${outcome.status}`);

      // Update State — STRICT: if throws after Signal+Outcome, all rollback
      if (existingState) {
        await tx.strategySignalState.update({
          where: { id: existingState.id },
          data: {
            lastEvaluatedCandleTime: transition.currentCandleTime,
            aggregateState: currentAggregate,
            lastSignalCandleTime: candidate.signalCandleTime,
            lastSignalDirection: candidate.direction,
            lastEvaluationStatus: currentAggregate,
            metadata: { lastReason: transition.reason, lastAction: transition.action, lastTrigger: transition.triggerType, setupKey } as any,
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
            lastSignalCandleTime: candidate.signalCandleTime,
            lastSignalDirection: candidate.direction,
            lastEvaluationStatus: currentAggregate,
            metadata: { lastReason: transition.reason, lastAction: transition.action, lastTrigger: transition.triggerType, setupKey } as any,
          },
        });
      }
      console.log(`  State updated transactionally to ${currentAggregate} at ${transition.currentCandleTime.toISOString()}`);
    });

    result.signalsCreated++;
    if (transition.emitDirection === "LONG") result.longSignals++;
    else result.shortSignals++;
  } catch (e: any) {
    // P2002 handling only outside transaction — idempotent duplicate
    if (e.code === "P2002" || e.message?.includes("Unique constraint") || e.message?.includes("unique") || e.message?.includes("Unique constraint failed")) {
      console.log(`  Duplicate unique [strategyId,symbol,timeframe,signalCandleTime] — concurrent same-horizon max one Signal, idempotent`);
      result.signalsSkippedDuplicate++;
    } else {
      console.error(`  Transaction failed — STRICT ATOMIC rollback, no partial Signal/Outcome/State: ${e.message}`);
      result.errors.push(`Transaction error (rolled back): ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function runSignalEngineForBtc(opts: {
  timeframe?: string;
  top?: number;
  dryRun?: boolean;
  symbol?: string;
  strategy?: string;
  enableSmartMoneyWrite?: boolean;
  emitOnBootstrap?: boolean;
  commonHorizonPolicy?: "STRICT" | "QUORUM";
}): Promise<SignalEngineResult> {
  const timeframe = opts.timeframe ?? "1h";
  const top = opts.top ?? 10;
  const dryRun = opts.dryRun ?? true;
  const symbol = opts.symbol ?? "BTC";
  const strategySlug = (opts as any).strategy ?? "trend-suslik";
  const enableSmartMoneyWrite = (opts as any).enableSmartMoneyWrite ?? false;
  const emitOnBootstrap = (opts as any).emitOnBootstrap ?? false;
  const commonHorizonPolicy = (opts as any).commonHorizonPolicy ?? "QUORUM";

  const result: SignalEngineResult = {
    evaluatedMarkets: 0,
    evaluatedAssets: 0,
    signalsCreated: 0,
    signalsSkippedDuplicate: 0,
    signalsSkippedCooldown: 0,
    signalsSkippedFiltered: 0,
    longSignals: 0,
    shortSignals: 0,
    neutralGroups: 0,
    errors: [],
  };

  let strategies = await prisma.strategy.findMany({
    where: { enabled: true, status: "PUBLISHED" },
    orderBy: { id: "asc" },
  });

  if (strategies.length === 0) {
    const anyStrategy = await prisma.strategy.findFirst({
      where: { slug: strategySlug === "smart-money-suslik" ? "smart-money-suslik" : "trend-suslik" },
      orderBy: { version: "desc" },
    });
    if (!anyStrategy) {
      result.errors.push(`No strategies found — need at least ${strategySlug}`);
      return result;
    }
    if (!dryRun && strategySlug === "trend-suslik") {
      await prisma.strategy.update({
        where: { id: anyStrategy.id },
        data: { enabled: true, status: "PUBLISHED" },
      });
      strategies.push({ ...anyStrategy, enabled: true, status: "PUBLISHED" } as any);
    } else {
      if (strategySlug === "smart-money-suslik") {
        strategies.push(anyStrategy as any);
        console.log(`Dry-run: using strategy id=${anyStrategy.id} slug=${anyStrategy.slug} enabled=${anyStrategy.enabled} status=${anyStrategy.status}`);
      } else {
        result.errors.push(`Found strategy id=${anyStrategy.id} slug=${anyStrategy.slug} but enabled=${anyStrategy.enabled} status=${anyStrategy.status} — dryRun, not auto-enabling`);
        return result;
      }
    }
  }

  if (strategySlug) {
    const filtered = strategies.filter((s: any) => s.slug === strategySlug);
    if (filtered.length > 0) {
      strategies = filtered;
    } else if (strategySlug === "smart-money-suslik") {
      const sm = await prisma.strategy.findFirst({
        where: { slug: "smart-money-suslik" },
        orderBy: { version: "desc" },
      });
      if (sm) {
        strategies = [sm as any];
        console.log(`Loaded smart-money strategy directly: id=${sm.id} v${sm.version}`);
      }
    }
  }

  console.log(`Signal Engine: found ${strategies.length} strategies for slug=${strategySlug}: ${strategies.map((s: any) => `${s.slug} v${s.version} id=${s.id}`).join(", ")}`);

  const asset = await prisma.asset.findUnique({
    where: { symbol },
    select: { id: true, symbol: true, rank: true },
  });

  if (!asset) {
    result.errors.push(`Asset ${symbol} not found`);
    return result;
  }

  console.log(`Asset: ${asset.symbol} id=${asset.id} rank=${asset.rank}`);

  const markets = await prisma.market.findMany({
    where: {
      assetId: asset.id,
      enabled: true,
      status: "ACTIVE",
      marketType: "SPOT",
      quote: "USDT",
    },
    select: {
      id: true,
      exchange: true,
      exchangeSymbol: true,
      assetId: true,
      quoteVolume24h: true,
      base: true,
      quote: true,
    },
    orderBy: { exchange: "asc" },
  }) as any[];

  console.log(`Markets: ${markets.length} ACTIVE SPOT USDT enabled for ${symbol}`);

  const eligibleMarkets = markets.filter((m: any) => {
    try {
      return isSmartMoneyExchangeEligible(m.exchange as any, timeframe as any);
    } catch {
      return false;
    }
  });

  console.log(`Eligible markets for timeframe ${timeframe}: ${eligibleMarkets.length}/${markets.length} (BINGX 1d excluded)`);

  if (eligibleMarkets.length === 0) {
    result.errors.push(`No eligible markets for ${symbol} ${timeframe}`);
    return result;
  }

  if (strategySlug === "smart-money-suslik") {
    await runSmartMoneyEngine({
      timeframe,
      dryRun,
      symbol,
      strategies,
      eligibleMarkets,
      asset: asset as any,
      result,
      enableSmartMoneyWrite,
      emitOnBootstrap,
      commonHorizonPolicy,
    });
  } else {
    await runTrendSuslikEngine({
      timeframe,
      dryRun,
      symbol,
      strategies,
      eligibleMarkets,
      asset: asset as any,
      result,
    });
  }

  console.log(`\n=== Signal Engine Result ===`);
  console.log(`Evaluated markets: ${result.evaluatedMarkets} assets: ${result.evaluatedAssets}`);
  console.log(`Signals created: ${result.signalsCreated} LONG=${result.longSignals} SHORT=${result.shortSignals} NEUTRAL groups=${result.neutralGroups}`);
  console.log(`Skipped duplicate=${result.signalsSkippedDuplicate} cooldown=${result.signalsSkippedCooldown} filtered=${result.signalsSkippedFiltered}`);
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.join("; ")}`);
  }

  return result;
}
