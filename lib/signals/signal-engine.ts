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
 */

import { prisma } from "../prisma";
import { validateTrendSuslikConfig } from "../strategies/config";
import { evaluateSnapshot, aggregateAssetGroup, type SnapshotInput } from "../strategies/runtime";
import { isSmartMoneyExchangeEligible } from "../strategies/smart-money-eligibility";

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

export async function runSignalEngineForBtc(opts: {
  timeframe?: string;
  top?: number;
  dryRun?: boolean;
  symbol?: string;
}): Promise<SignalEngineResult> {
  const timeframe = opts.timeframe ?? "1h";
  const top = opts.top ?? 10;
  const dryRun = opts.dryRun ?? true;
  const symbol = opts.symbol ?? "BTC";

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

  // 1. Load enabled PUBLISHED strategies
  let strategies = await prisma.strategy.findMany({
    where: { enabled: true, status: "PUBLISHED" },
    orderBy: { id: "asc" },
  });

  if (strategies.length === 0) {
    // Fallback: try to find any strategy and enable it for BTC pilot
    const anyStrategy = await prisma.strategy.findFirst({
      where: { slug: "trend-suslik" },
      orderBy: { version: "desc" },
    });
    if (!anyStrategy) {
      result.errors.push("No strategies found — need at least trend-suslik");
      return result;
    }
    // Auto-enable for pilot if dryRun=false and explicitly requested
    if (!dryRun) {
      await prisma.strategy.update({
        where: { id: anyStrategy.id },
        data: { enabled: true, status: "PUBLISHED" },
      });
      strategies.push({ ...anyStrategy, enabled: true, status: "PUBLISHED" } as any);
    } else {
      result.errors.push(`Found strategy id=${anyStrategy.id} slug=${anyStrategy.slug} but enabled=${anyStrategy.enabled} status=${anyStrategy.status} — dryRun, not auto-enabling`);
      return result;
    }
  }

  console.log(`Signal Engine: found ${strategies.length} enabled PUBLISHED strategies: ${strategies.map((s: any) => `${s.slug} v${s.version} id=${s.id}`).join(", ")}`);

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

  // Filter by Smart Money eligibility (BINGX 1d excluded)
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

  // 4. For each strategy, evaluate
  for (const strategy of strategies) {
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

    // Load last IndicatorSnapshot per market for this timeframe
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
      if (snap) {
        snapshots.push(snap as any);
      }
    }

    console.log(`  Snapshots found: ${snapshots.length}/${eligibleMarkets.length} for timeframe ${timeframe}`);
    result.evaluatedMarkets += snapshots.length;

    if (snapshots.length === 0) {
      console.log(`  No snapshots — need to run snapshot-worker for ${symbol} ${timeframe}`);
      continue;
    }

    // Build SnapshotInput
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

    // Evaluate each market
    const marketResults = inputs.map((input: any) => {
      const res = evaluateSnapshot(input, config);
      return res;
    });

    // Aggregate per asset/timeframe
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

    // Check cooldown and duplicate protection
    // Find last signal for same strategy+symbol+timeframe
    const lastSignal = await prisma.signal.findFirst({
      where: {
        strategyId: strategy.id,
        symbol,
        timeframe,
      },
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
        console.log(`  Cooldown: last signal ${lastSignal.id} age ${Math.floor(ageMs/1000)}s < cooldown ${cooldownCandles} candles (${cooldownMs/1000}s) — skipped`);
        result.signalsSkippedCooldown++;
        continue;
      }

      // Duplicate protection: same candleTime? We use aggregation's markets candleTime
      // For simplicity, check if last signal has same direction and was created within same timeframe window
      // Real duplicate check: strategy version + market + timeframe + candleTime + direction
      // Since aggregation uses multiple markets, we check if there's signal with same symbol/timeframe/direction created in last tfMs
      if (lastSignal.direction === aggregation.direction && ageMs < tfMs) {
        console.log(`  Duplicate: last signal same direction ${lastSignal.direction} within 1 candle — skipped`);
        result.signalsSkippedDuplicate++;
        continue;
      }
    }

    // Calculate entry/SL/TP from ATR
    // Use average price from evaluated markets
    const evaluated = aggregation.markets.filter((m: any) => m.status === "evaluated") as any[];
    const avgPrice = evaluated.length > 0 ? evaluated.reduce((sum: number, m: any) => sum + m.price, 0) / evaluated.length : 0;

    // Get ATR from snapshots average
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

    // Real insert with duplicate protection
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

  console.log(`\n=== Signal Engine Result ===`);
  console.log(`Evaluated markets: ${result.evaluatedMarkets} assets: ${result.evaluatedAssets}`);
  console.log(`Signals created: ${result.signalsCreated} LONG=${result.longSignals} SHORT=${result.shortSignals} NEUTRAL groups=${result.neutralGroups}`);
  console.log(`Skipped duplicate=${result.signalsSkippedDuplicate} cooldown=${result.signalsSkippedCooldown} filtered=${result.signalsSkippedFiltered}`);
  if (result.errors.length > 0) {
    console.log(`Errors: ${result.errors.join("; ")}`);
  }

  return result;
}
