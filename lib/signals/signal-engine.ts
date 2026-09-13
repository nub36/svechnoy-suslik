/**
 * Signal Engine — BTC ONLY pilot, production-ready, NO forbidden copy.
 * PHASE 2C FINAL HARDENING — last code phase before VPS migration.
 *
 * Key PHASE 2C changes:
 * - No optimistic fallback entry = nextBarOpenPrice ?? referencePrice FORBIDDEN
 *   If NEXT_BAR_OPEN policy and next candle not yet available: entryPrice=NULL, entryTime=NULL, executionStatus=WAITING_ENTRY
 *   referencePrice analytic only, not executable.
 * - Next bar openTime must strictly = signalCandleTime + tf duration, if missing no silent gap skip => ENTRY_DATA_MISSING
 * - No SL/TP from non-existing entry. ATR frozen at signalCandleTime, levels calculated only after entry appears.
 *   LONG SL=entry-ATR*stop TP=entry+ATR*tp SHORT opposite.
 * - Separate Signal immutable observation vs SignalOutcome execution state
 * - SignalSource enum LIVE_FORWARD/SEEDED/BACKTEST/LEGACY, default LEGACY safe, new real rows explicit LIVE_FORWARD
 * - Score semantics LONG=longScore SHORT=shortScore, metadata stores both
 * - Confirmation structured: participantCount/evaluatedCount/longVotes/shortVotes/neutralVotes/minExchanges/confirmationCount/Total etc
 * - QUORUM data-quality guard referenceFallback metadata
 * - Candidate deepFreeze recursive
 * - Write guard AND (CLI --enable-smart-money-write AND ENV SMART_MONEY_WRITE_ENABLED=true)
 * - No backtest writing to Signal table, live stats WHERE signalSource=LIVE_FORWARD
 */

import { prisma } from "../prisma";
import { validateTrendSuslikConfig } from "../strategies/config";
import { evaluateSnapshot, aggregateAssetGroup, type SnapshotInput } from "../strategies/runtime";
import { isSmartMoneyExchangeEligible } from "../strategies/smart-money-eligibility";
import { validateSmartMoneyConfig } from "../strategies/smart-money";
import { evaluateMarketsAtCommonHorizon, type SmartMoneyMarketMeta } from "../strategies/smart-money";
import { isSmcTimeframe, SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../smc/types";
import { formatCommonHorizonReport, decideAggregationAtCommonHorizon, truncateCandlesToHorizon } from "../strategies/common-horizon";
import { selectQuorumClosedHorizon } from "../strategies/common-horizon-quorum";
import { buildSmartMoneySignalCandidate } from "./smart-money-candidate";

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
// TREND SUSLIK path (existing, untouched logic, but entry now nullable in schema)
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
          signalSource: "LEGACY", // trend signals are legacy classification
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
// SMART MONEY path — PHASE 2C FINAL HARDENING
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
  commonHorizonPolicy?: "STRICT" | "QUORUM";
}): Promise<void> {
  const { timeframe, dryRun, symbol, strategies, eligibleMarkets, asset, result, enableSmartMoneyWrite, commonHorizonPolicy } = opts;

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

  console.log(`\nStrategy ${strategy.slug} v${strategy.version} id=${strategy.id} minExchanges=${strategy.minExchanges} timeframes=${strategy.timeframes.join(",")} policy=${policy}`);

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
  console.log(`  Filters: top500Only=${filters.top500Only} minimumQuoteVolume24h=${filters.minimumQuoteVolume24h}`);

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

  console.log(`  Loaded CLOSED candles: ${loaded.length} markets, each up to 500 (CLOSED only, ASC)`);

  const now = new Date();

  if (policy === "QUORUM") {
    const quorumSel = selectQuorumClosedHorizon(
      loaded.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles })),
      tf,
      { now, minExchanges: strategy.minExchanges }
    );
    console.log(`\n=== QUORUM POLICY ===`);
    console.log(`now=${now.toISOString()} expectedLatestClosed=${quorumSel.expectedLatestClosed.toISOString()} status=${quorumSel.status} fresh=${quorumSel.freshCount} stale=${quorumSel.staleCount}`);
    console.log(`fresh: ${quorumSel.freshMarkets.map((f) => f.exchange).join(", ") || "none"}`);
    console.log(`stale: ${quorumSel.staleMarkets.map((s) => `${s.exchange}(${s.reason})`).join("; ") || "none"}`);
    console.log(`reason: ${quorumSel.reason}`);
  }

  // Build candidate — PHASE 2C: no optimistic fallback, entry NULL if next bar not available
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
    // nextBarCandles not loaded in this path — outcome will be WAITING_ENTRY until next bar appears
    nextBarCandles: undefined,
  });

  if (builderResult.selection) {
    console.log(`\n=== COMMON HORIZON (${policy}) ===`);
    console.log(`now=${now.toISOString()} timeframe=${tf}`);
    if (builderResult.selection.commonHorizon) {
      console.log(`COMMON HORIZON: ${builderResult.selection.commonHorizon.toISOString()}`);
    } else {
      console.log(`COMMON HORIZON: null (status=${(builderResult.selection as any).status})`);
    }
    console.log(`status=${(builderResult.selection as any).status} participantCount=${(builderResult.selection as any).participantCount}`);
    if ((builderResult.selection as any).expectedLatestClosed) {
      console.log(`expectedLatestClosed=${(builderResult.selection as any).expectedLatestClosed.toISOString()}`);
    }

    const perMarket = (builderResult.selection as any).perMarketLatest ?? [];
    for (const p of perMarket) {
      const horizonStr = builderResult.selection.commonHorizon ? builderResult.selection.commonHorizon.toISOString() : "null";
      const latestStr = p.latest ? p.latest.toISOString() : "no data";
      const included = p.hasCommon && (builderResult.selection as any).status === "ok";
      console.log(`${p.exchange} horizon=${included ? horizonStr : latestStr} ${included ? "INCLUDED" : "EXCLUDED"} latest=${latestStr} hasCommon=${p.hasCommon}`);
    }

    if (policy === "STRICT") {
      const reportLines = formatCommonHorizonReport({
        selection: builderResult.selection as any,
        timeframe: tf,
        marketCount: eligibleMarkets.length,
        exchangeEligibleCount: eligibleMarkets.length,
        exchangeExcluded: [],
        filteredCount: (builderResult as any).filteredCount ?? 0,
      });
      for (const line of reportLines) console.log(`  ${line}`);
    }

    const gate = decideAggregationAtCommonHorizon({
      selection: builderResult.selection as any,
      results: builderResult.results as any,
      timeframe: tf,
    });
    console.log(`\n=== GATE CHECK === allowed=${gate.allowed} alignment.safe=${gate.alignment.safe} anchor.ok=${gate.anchor.ok}`);
    if (gate.refusalReasons.length > 0) console.log(`refusalReasons: ${gate.refusalReasons.join("; ")}`);
  }

  if (builderResult.status === "no_signal") {
    console.log(`\nNO SIGNAL — ${builderResult.reason}`);
    if (builderResult.insufficientReason) console.log(`Insufficient reason: ${builderResult.insufficientReason}`);
    result.neutralGroups++;
    result.evaluatedMarkets = loaded.length;
    result.evaluatedAssets = 1;
    return;
  }

  const { candidate, aggregation } = builderResult;

  console.log(`\n=== PER-EXCHANGE SMC EVALUATION (raw CLOSED, same asOf) ===`);
  console.log(`asOf=${candidate.asOf.toISOString()} signalCandleTime=${candidate.signalCandleTime.toISOString()} executionStatus=${candidate.executionStatus}`);
  for (const per of candidate.metadata.perExchange) {
    console.log(`\n--- ${per.exchange} ---`);
    console.log(`exchange=${per.exchange} direction=${per.direction} longScore=${per.longScore} shortScore=${per.shortScore} evaluable=${per.evaluable} price=${per.price}`);
    console.log(`hardFailures=${per.hardFailures.join("; ") || "none"}`);
    console.log(`softUnavailable=${per.softUnavailable.join(", ") || "none"}`);
    console.log(`A-I:`);
    for (const r of per.reasons) {
      console.log(`  ${r.code} long=${r.longPoints} short=${r.shortPoints} max=${r.maxPoints} label=${r.label}`);
    }
  }

  console.log(`\n=== AGGREGATION (structured confirmation) ===`);
  console.log(`eligible=${eligibleMarkets.length} participantCount=${candidate.participantCount} evaluated=${candidate.evaluatedCount} skipped=${aggregation.skipped} minExchanges=${candidate.metadata.minExchanges}`);
  console.log(`longVotes=${aggregation.longVotes} shortVotes=${aggregation.shortVotes} neutralVotes=${aggregation.neutralVotes}`);
  console.log(`direction=${aggregation.direction} confirmation=${aggregation.confirmation} (${candidate.confirmationCount}/${candidate.confirmationTotal}) conflict=${aggregation.conflict}`);
  console.log(`score semantics: LONG=longScore SHORT=shortScore => score=${candidate.score} longScore=${candidate.longScore} shortScore=${candidate.shortScore}`);
  console.log(`reference=${candidate.referenceExchange} referencePrice=${candidate.referencePrice} (analytic only) aggregatePrice=${candidate.aggregatePrice} (info only) fallback=${candidate.referenceFallback}`);
  console.log(`explanation: ${aggregation.explanation}`);

  console.log(`\n=== CANDIDATE (immutable, deepFreeze) ===`);
  console.log(`signalCandleTime=${candidate.signalCandleTime.toISOString()} direction=${candidate.direction} score=${candidate.score}`);
  console.log(`executionStatus=${candidate.executionStatus} entry=${candidate.entry} entryTime=${candidate.entryTime?.toISOString() ?? "NULL (WAITING_ENTRY)"}`);
  console.log(`ATR frozen at signal: ${candidate.atrAtSignal} period=${candidate.metadata.atrPeriod}`);
  if (candidate.executionStatus === "READY") {
    console.log(`SL=${candidate.stopLoss} TP1=${candidate.takeProfit1} TP2=${candidate.takeProfit2} TP3=${candidate.takeProfit3} (anchored to real NEXT_BAR_OPEN)`);
  } else {
    console.log(`SL/TP=NULL — no entry yet, will be calculated only after real NEXT_BAR_OPEN appears (ATR frozen but not applied)`);
  }
  console.log(`reason: ${candidate.reason}`);
  console.log(`metadata keys: ${Object.keys(candidate.metadata).join(", ")}`);

  result.evaluatedMarkets = loaded.length;
  result.evaluatedAssets = 1;

  // WRITE GUARD AND — PHASE 2C: both flag AND env must be true
  const flagEnabled = enableSmartMoneyWrite === true;
  const envEnabled = process.env.SMART_MONEY_WRITE_ENABLED === "true";
  const writeAllowed = flagEnabled && envEnabled;

  console.log(`\n=== WRITE GUARD AND (PHASE 2C) === flag=${flagEnabled} env=${envEnabled} => allowed=${writeAllowed}`);
  console.log(`Truth table: flag false/env false=blocked, flag true/env false=blocked, flag false/env true=blocked, flag true/env true=allowed`);

  if (candidate.direction === "NEUTRAL") {
    result.neutralGroups++;
    console.log(`\nNEUTRAL — no signal persisted`);
    return;
  }

  if (dryRun) {
    console.log(`\nDRY-RUN — candidate NOT persisted (would create signal with status ${candidate.executionStatus})`);
    result.signalsCreated++;
    if (candidate.direction === "LONG") result.longSignals++;
    else result.shortSignals++;
    return;
  }

  if (!writeAllowed) {
    console.log(`\nPHASE 2C GUARD: write BLOCKED — need BOTH --enable-smart-money-write AND SMART_MONEY_WRITE_ENABLED=true`);
    console.log(`DRY-RUN forced — candidate NOT persisted`);
    result.signalsCreated++;
    if (candidate.direction === "LONG") result.longSignals++;
    else result.shortSignals++;
    return;
  }

  // Live persistence — same candidate, no re-evaluation, explicit LIVE_FORWARD
  // No backtest writing to Signal table — backtest separate contour
  console.log(`\nLIVE WRITE ALLOWED — persisting candidate (same payload as dry-run) with signalSource=LIVE_FORWARD`);
  try {
    const created = await prisma.signal.create({
      data: {
        symbol: candidate.symbol,
        timeframe: candidate.timeframe,
        direction: candidate.direction,
        score: candidate.score,
        entry: candidate.entry, // NULL if WAITING_ENTRY — no optimistic fallback
        stopLoss: candidate.stopLoss, // NULL if WAITING_ENTRY
        takeProfit1: candidate.takeProfit1,
        takeProfit2: candidate.takeProfit2,
        takeProfit3: candidate.takeProfit3,
        status: candidate.executionStatus === "READY" ? "ACTIVE" : candidate.executionStatus, // WAITING_ENTRY or ENTRY_DATA_MISSING
        reason: candidate.reason.slice(0, 1000),
        strategyId: candidate.strategyId,
        signalCandleTime: candidate.signalCandleTime,
        referenceExchange: candidate.referenceExchange,
        referencePrice: candidate.referencePrice, // analytic only
        aggregatePrice: candidate.aggregatePrice,
        executionPolicy: candidate.executionPolicy,
        signalSource: "LIVE_FORWARD", // explicit, not default LEGACY
        metadata: candidate.metadata as any,
        atrAtSignal: candidate.atrAtSignal,
        nextBarOpenPrice: candidate.entry, // entry = nextBarOpenPrice when READY, else null
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
      },
    });
    console.log(`  CREATED signal id=${created.id} ${created.direction} ${created.symbol} ${created.timeframe} candleTime=${created.signalCandleTime?.toISOString()} score=${created.score} ref=${created.referenceExchange} status=${created.status} source=${created.signalSource}`);

    // Create SignalOutcome — separate model, does not mutate Signal
    try {
      const outcome = await prisma.signalOutcome.create({
        data: {
          signalId: created.id,
          status: candidate.executionStatus === "READY" ? "OPEN" : candidate.executionStatus, // WAITING_ENTRY or ENTRY_DATA_MISSING or OPEN
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
      console.log(`  CREATED outcome id=${outcome.id} signalId=${outcome.signalId} status=${outcome.status} entry=${outcome.entryPrice} @ ${outcome.entryTime?.toISOString() ?? "NULL"}`);
    } catch (e: any) {
      console.error(`  Failed to create outcome for signal ${created.id}: ${e.message} — Signal remains, outcome can be created later by tracker`);
      // Do not fail signal creation if outcome fails — outcome can be backfilled
    }

    result.signalsCreated++;
    if (candidate.direction === "LONG") result.longSignals++;
    else result.shortSignals++;
  } catch (e: any) {
    if (e.code === "P2002" || e.message?.includes("Unique constraint") || e.message?.includes("unique")) {
      console.log(`  Duplicate unique constraint [strategyId,symbol,timeframe,signalCandleTime] — same candle already has signal, blocked (LONG then SHORT on same candle not allowed)`);
      result.signalsSkippedDuplicate++;
    } else {
      console.error(`  Error creating signal: ${e.message}`);
      result.errors.push(`Create signal error: ${e.message}`);
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
  commonHorizonPolicy?: "STRICT" | "QUORUM";
}): Promise<SignalEngineResult> {
  const timeframe = opts.timeframe ?? "1h";
  const top = opts.top ?? 10;
  const dryRun = opts.dryRun ?? true;
  const symbol = opts.symbol ?? "BTC";
  const strategySlug = (opts as any).strategy ?? "trend-suslik";
  const enableSmartMoneyWrite = (opts as any).enableSmartMoneyWrite ?? false;
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
