/**
 * Signal Engine — BTC ONLY pilot, production-ready, NO forbidden copy.
 * Создает реальные сигналы LONG/SHORT в PostgreSQL из подтвержденных агрегаций Strategy Runtime.
 * 
 * Только enabled=true + status=PUBLISHED стратегии.
 * Каждый сигнал хранит: символ, таймфрейм, направление, score, entry, SL/TP1-3 через ATR, reason, strategyId.
 * Защита от дубликатов: один сигнал на Strategy version + symbol + timeframe + candleTime + direction.
 * Учитывает execution.closedCandleOnly и cooldownCandles.
 * 
 * BTC ONLY для пилота 3001→3000, BINGX excluded 1d через eligibility.
 *
 * PHASE 2A — Smart Money DRY-RUN path:
 * - использует ТОЛЬКО production functions evaluateSmc(), selectCommonClosedHorizon(),
 *   truncateCandlesToHorizon(), aggregateAssetGroup(), isSmartMoneyExchangeEligible()
 * - raw CLOSED candles, common horizon, no IndicatorSnapshot for SMC
 * - NEVER prisma.signal.create for smart-money (guarded)
 */

import { prisma } from "../prisma";
import { validateTrendSuslikConfig } from "../strategies/config";
import { evaluateSnapshot, aggregateAssetGroup, type SnapshotInput } from "../strategies/runtime";
import { isSmartMoneyExchangeEligible } from "../strategies/smart-money-eligibility";
import { validateSmartMoneyConfig } from "../strategies/smart-money";
import {
  evaluateMarketsAtCommonHorizon,
  type SmartMoneyMarketMeta,
} from "../strategies/smart-money";
import { evaluateSmc } from "../smc/evaluate";
import { isSmcTimeframe, SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../smc/types";
import {
  formatCommonHorizonReport,
  decideAggregationAtCommonHorizon,
  truncateCandlesToHorizon,
} from "../strategies/common-horizon";

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
// TREND SUSLIK path (existing, untouched logic)
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
// SMART MONEY DRY-RUN path — uses production SMC functions only
// ---------------------------------------------------------------------------

async function runSmartMoneyEngine(opts: {
  timeframe: string;
  dryRun: boolean;
  symbol: string;
  strategies: any[];
  eligibleMarkets: any[];
  asset: { id: number; symbol: string; rank: number | null };
  result: SignalEngineResult;
}): Promise<void> {
  const { timeframe, dryRun, symbol, strategies, eligibleMarkets, asset, result } = opts;

  if (!isSmcTimeframe(timeframe)) {
    result.errors.push(`Timeframe ${timeframe} not in SMC whitelist`);
    return;
  }
  const tf = timeframe as SmcTimeframe;

  // Find smart-money strategy (enabled preferred, fallback any for dry-run)
  let strategy = strategies.find((s: any) => s.slug === "smart-money-suslik");
  if (!strategy) {
    // Fallback: load any smart-money from DB (even disabled) for dry-run
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

  console.log(`\nStrategy ${strategy.slug} v${strategy.version} id=${strategy.id} minExchanges=${strategy.minExchanges} timeframes=${strategy.timeframes.join(",")}`);

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

  // Load CLOSED raw candles for each eligible market (500 latest)
  type LoadedMarket = { meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] };
  const loaded: LoadedMarket[] = [];
  const allMarketCount = eligibleMarkets.length;
  const exchangeEligibleCount = eligibleMarkets.length;
  const exchangeExcluded: string[] = [];

  // For report: we need total markets before eligibility (passed in opts already filtered, so we need original count from caller)
  // Caller already filtered by eligibility, but we still compute excluded list from asset markets if needed.
  // For simplicity, we report eligible = loaded.length initial.

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

  // Evaluate at common horizon using production function
  const outcome = evaluateMarketsAtCommonHorizon(loaded, tf, smcConfig, filters, now);

  // Detailed horizon report
  console.log(`\n=== COMMON HORIZON ===`);
  console.log(`now=${now.toISOString()} timeframe=${tf}`);
  if (outcome.selection.commonHorizon) {
    console.log(`COMMON HORIZON: ${outcome.selection.commonHorizon.toISOString()}`);
  } else {
    console.log(`COMMON HORIZON: null (status=${outcome.status})`);
  }
  console.log(`status=${outcome.selection.status} usable=${outcome.usable} participantCount=${outcome.selection.participantCount} filteredCount=${outcome.filteredCount}`);
  console.log(`expectedLatestClosed=${outcome.selection.expectedLatestClosed.toISOString()} lagBars=${outcome.selection.lagBars} absoluteLagBars=${outcome.selection.absoluteLagBars}`);

  // Per-exchange horizon inclusion
  for (const p of outcome.selection.perMarketLatest) {
    const included = p.hasCommon && outcome.selection.status === "ok";
    const horizonStr = outcome.selection.commonHorizon ? outcome.selection.commonHorizon.toISOString() : "null";
    const latestStr = p.latest ? p.latest.toISOString() : "no data";
    console.log(`${p.exchange} horizon=${included ? horizonStr : latestStr} ${included ? "INCLUDED" : "EXCLUDED"} latest=${latestStr} hasCommon=${p.hasCommon}`);
  }
  if (outcome.selection.marketsWithoutData.length > 0) {
    for (const m of outcome.selection.marketsWithoutData) {
      console.log(`${m.exchange} horizon=null EXCLUDED (no CLOSED data) marketId=${m.marketId}`);
    }
  }

  // Format common horizon report (production function)
  const reportLines = formatCommonHorizonReport({
    selection: outcome.selection,
    timeframe: tf,
    marketCount: allMarketCount + exchangeExcluded.length, // best effort
    exchangeEligibleCount,
    exchangeExcluded,
    filteredCount: outcome.filteredCount,
  });
  for (const line of reportLines) console.log(`  ${line}`);

  if (!outcome.usable || outcome.selection.status !== "ok" || !outcome.selection.commonHorizon) {
    console.log(`\nNO SIGNAL — common horizon unusable: ${outcome.selection.reason}`);
    result.neutralGroups++;
    result.evaluatedMarkets = loaded.length;
    result.evaluatedAssets = 1;
    return;
  }

  const commonHorizon = outcome.selection.commonHorizon;
  const tfMs = SMCTIMEFRAME_MS[tf];
  const asOf = new Date(commonHorizon.getTime() + tfMs);

  // Aggregation gate check (production)
  const gate = decideAggregationAtCommonHorizon({
    selection: outcome.selection,
    results: outcome.results,
    timeframe: tf,
  });

  console.log(`\n=== GATE CHECK ===`);
  console.log(`allowed=${gate.allowed} alignment.safe=${gate.alignment.safe} anchor.ok=${gate.anchor.ok}`);
  if (gate.refusalReasons.length > 0) {
    console.log(`refusalReasons: ${gate.refusalReasons.join("; ")}`);
  }
  if (!gate.allowed) {
    console.log(`NO SIGNAL — gate refused`);
    result.neutralGroups++;
    result.evaluatedMarkets = loaded.length;
    result.evaluatedAssets = 1;
    return;
  }

  // Per-exchange detailed evaluation using production evaluateSmc
  console.log(`\n=== PER-EXCHANGE SMC EVALUATION (raw CLOSED candles, same asOf) ===`);
  console.log(`asOf=${asOf.toISOString()} (effectiveCloseTime of common horizon + tf)`);

  for (const lm of loaded) {
    const truncated = truncateCandlesToHorizon(lm.candles, commonHorizon);
    const resultForMarket = outcome.results.find((r) => r.marketId === lm.meta.marketId);

    if (truncated.length === 0) {
      console.log(`\n${lm.meta.exchange} marketId=${lm.meta.marketId} horizon=${commonHorizon.toISOString()} NO CANDLES after truncation -> CANNOT_EVALUATE`);
      continue;
    }

    // Production evaluateSmc for detailed facts
    let fullEval: ReturnType<typeof evaluateSmc> | null = null;
    try {
      fullEval = evaluateSmc(truncated, smcConfig, asOf);
    } catch (e: any) {
      console.log(`\n${lm.meta.exchange} marketId=${lm.meta.marketId} horizon=${commonHorizon.toISOString()} evaluateSmc threw: ${e.message}`);
      continue;
    }

    const marketResult = resultForMarket;
    const direction = fullEval.direction;
    const longScore = fullEval.longScore;
    const shortScore = fullEval.shortScore;
    const evaluable = fullEval.availability.evaluable;
    const hardFailures = fullEval.availability.hardFailures.map((f) => `${f.code}:${f.label}`).join("; ") || "none";
    const softUnavailable = fullEval.availability.softUnavailable.map((f) => f.code).join(", ") || "none";

    console.log(`\n--- ${lm.meta.exchange} ---`);
    console.log(`exchange=${lm.meta.exchange} horizon=${commonHorizon.toISOString()} direction=${direction} longScore=${longScore} shortScore=${shortScore} evaluable=${evaluable}`);
    console.log(`hardFailures=${hardFailures}`);
    console.log(`softUnavailable=${softUnavailable}`);
    console.log(`A-I contributions:`);
    for (const r of fullEval.reasons) {
      console.log(`  ${r.code} long=${r.longPoints} short=${r.shortPoints} max=${r.maxPoints} label="${r.label}" value=${r.value ?? "null"}`);
    }
    if (marketResult) {
      console.log(`MarketStrategyResult: status=${marketResult.status} ${marketResult.status === "evaluated" ? `direction=${marketResult.direction} longScore=${marketResult.longScore} shortScore=${marketResult.shortScore} candleTime=${marketResult.candleTime.toISOString()} price=${marketResult.price}` : `reason=${(marketResult as any).reason}`}`);
    }

    // Dealing range, OB, FVG summary
    if (fullEval.dealingRange?.current) {
      const dr = fullEval.dealingRange.current;
      const pc = fullEval.dealingRange.priceContext;
      console.log(`DealingRange: dir=${dr.direction} low=${dr.low} high=${dr.high} eq=${dr.equilibrium} zone=${pc?.zone ?? "null"} pos=${pc?.position?.toFixed(4) ?? "null"}`);
    }
    if (fullEval.swingStructure) {
      console.log(`Swing phase=${fullEval.swingStructure.phase} pivots=${fullEval.swingStructure.pivots.length} events=${fullEval.swingStructure.events.length}`);
    }
    if (fullEval.internalStructure) {
      console.log(`Internal phase=${fullEval.internalStructure.phase}`);
    }
  }

  // Aggregation
  const aggregation = aggregateAssetGroup(
    symbol,
    timeframe,
    strategy.slug,
    strategy.version,
    outcome.results as any,
    strategy.minExchanges
  );

  console.log(`\n=== AGGREGATION ===`);
  console.log(`eligible=${eligibleMarkets.length} evaluated=${aggregation.evaluated} skipped=${aggregation.skipped} minExchanges=${aggregation.minExchanges}`);
  console.log(`longVotes=${aggregation.longVotes} shortVotes=${aggregation.shortVotes} neutralVotes=${aggregation.neutralVotes}`);
  console.log(`direction=${aggregation.direction} confirmation=${aggregation.confirmation} conflict=${aggregation.conflict}`);
  console.log(`explanation: ${aggregation.explanation}`);

  result.evaluatedMarkets = loaded.length;
  result.evaluatedAssets = 1;

  if (aggregation.direction === "NEUTRAL") {
    result.neutralGroups++;
    console.log(`\nNEUTRAL — no signal. Reason: ${aggregation.explanation}`);
    if (aggregation.conflict) {
      console.log(`Conflict detected: LONG and SHORT both reached minExchanges — fail-safe NEUTRAL`);
    } else if (aggregation.evaluated < strategy.minExchanges) {
      console.log(`Insufficient evaluated exchanges: ${aggregation.evaluated} < minExchanges ${strategy.minExchanges}`);
    } else {
      console.log(`No side reached minExchanges threshold`);
    }
    return;
  }

  // Candidate signal (dry-run only, no DB write for smart-money)
  const evaluated = aggregation.markets.filter((m: any) => m.status === "evaluated") as any[];
  const avgPrice = evaluated.length > 0 ? evaluated.reduce((sum: number, m: any) => sum + m.price, 0) / evaluated.length : 0;
  const maxScore = aggregation.direction === "LONG" ? Math.max(...evaluated.map((m: any) => m.longScore)) : Math.max(...evaluated.map((m: any) => m.shortScore));

  console.log(`\nSignal candidate (DRY-RUN, no DB write): ${aggregation.direction} avgPrice=${avgPrice.toFixed(2)} maxScore=${maxScore} commonHorizon=${commonHorizon.toISOString()} asOf=${asOf.toISOString()} confirmation=${aggregation.confirmation}`);

  // GUARD: NEVER create real Signal for smart-money in PHASE 2A
  // Even if dryRun=false, we must not write. This is intentional for PHASE 2A.
  if (strategy.slug === "smart-money-suslik") {
    console.log(`  PHASE 2A GUARD: prisma.signal.create is FORBIDDEN for smart-money-suslik — dry-run only, no DB write`);
    result.signalsCreated++;
    if (aggregation.direction === "LONG") result.longSignals++;
    else result.shortSignals++;
    return;
  }

  // The following would be for future live, but currently blocked above
  if (dryRun) {
    console.log(`  DRY-RUN — not inserting, would create signal`);
    result.signalsCreated++;
    if (aggregation.direction === "LONG") result.longSignals++;
    else result.shortSignals++;
    return;
  }
}

// ---------------------------------------------------------------------------
// Main entry — supports both trend-suslik and smart-money-suslik
// ---------------------------------------------------------------------------

export async function runSignalEngineForBtc(opts: {
  timeframe?: string;
  top?: number;
  dryRun?: boolean;
  symbol?: string;
  strategy?: string;
}): Promise<SignalEngineResult> {
  const timeframe = opts.timeframe ?? "1h";
  const top = opts.top ?? 10;
  const dryRun = opts.dryRun ?? true;
  const symbol = opts.symbol ?? "BTC";
  const strategySlug = (opts as any).strategy ?? "trend-suslik";

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

  // 1. Load enabled PUBLISHED strategies (or any for smart-money dry-run)
  let strategies = await prisma.strategy.findMany({
    where: { enabled: true, status: "PUBLISHED" },
    orderBy: { id: "asc" },
  });

  if (strategies.length === 0) {
    // Fallback: try to find any strategy and enable it for BTC pilot (trend only)
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
        // For smart-money dry-run, allow disabled strategy
        strategies.push(anyStrategy as any);
        console.log(`Dry-run: using strategy id=${anyStrategy.id} slug=${anyStrategy.slug} enabled=${anyStrategy.enabled} status=${anyStrategy.status}`);
      } else {
        result.errors.push(`Found strategy id=${anyStrategy.id} slug=${anyStrategy.slug} but enabled=${anyStrategy.enabled} status=${anyStrategy.status} — dryRun, not auto-enabling`);
        return result;
      }
    }
  }

  // Filter strategies by requested slug if provided
  if (strategySlug) {
    const filtered = strategies.filter((s: any) => s.slug === strategySlug);
    if (filtered.length > 0) {
      strategies = filtered;
    } else if (strategySlug === "smart-money-suslik") {
      // For smart-money, try to load directly even if not in enabled list
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

  // 2. Load BTC asset
  const asset = await prisma.asset.findUnique({
    where: { symbol },
    select: { id: true, symbol: true, rank: true },
  });

  if (!asset) {
    result.errors.push(`Asset ${symbol} not found`);
    return result;
  }

  console.log(`Asset: ${asset.symbol} id=${asset.id} rank=${asset.rank}`);

  // 3. Load markets for BTC, ACTIVE SPOT USDT, enabled
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

  // Filter by Smart Money eligibility (BINGX 1d excluded) — same policy for both engines
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

  // 4. Dispatch to correct engine
  if (strategySlug === "smart-money-suslik") {
    await runSmartMoneyEngine({
      timeframe,
      dryRun,
      symbol,
      strategies,
      eligibleMarkets,
      asset: asset as any,
      result,
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
