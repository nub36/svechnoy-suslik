/**
 * TASK A — 15M PRODUCTION READINESS
 * Analyze 11 aggregated 15m SHORT events from historical baseline
 * Do NOT change scoring, do NOT write Signal
 * Run on VPS with production DB: npx tsx scripts/analyze-15m-signals.ts --timeframe=15m
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import { evaluateMarketsAtCommonHorizon, type SmartMoneyMarketMeta } from "../lib/strategies/smart-money";
import { buildSmartMoneySignalCandidate } from "../lib/signals/smart-money-candidate";
import { selectQuorumClosedHorizon } from "../lib/strategies/common-horizon-quorum";

const prisma = new PrismaClient();

type SignalDetail = {
  signalCandleTime: Date;
  asOf: Date;
  direction: string;
  scorePerExchange: Array<{ exchange: string; longScore: number | null; shortScore: number | null; direction: string }>;
  confirmation: string;
  confirmationCount: number;
  confirmationTotal: number;
  participatingExchanges: string[];
  aI: Record<string, { long: number; short: number; label: string }>;
  referenceExchange: string | null;
  referencePrice: number | null;
  aggregatePrice: number | null;
  atrAtSignal: number | null;
  nextBarAvailable: boolean;
  nextBarOpen: number | null;
  nextBarOpenTime: Date | null;
};

function parseArgs() {
  const args = process.argv.slice(2);
  let timeframe: SmcTimeframe = "15m";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--timeframe" && args[i + 1]) timeframe = args[i + 1] as SmcTimeframe;
    if (args[i].startsWith("--timeframe=")) timeframe = args[i].split("=")[1] as SmcTimeframe;
  }
  return { timeframe };
}

async function main() {
  const { timeframe } = parseArgs();
  console.log(`=== TASK A — 15M SIGNAL LIST ANALYSIS — ${timeframe} ===`);

  // Load BTC asset and markets
  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true, rank: true } });
  if (!asset) throw new Error("BTC not found");
  const markets = await prisma.market.findMany({
    where: { assetId: asset.id, enabled: true, status: "ACTIVE", marketType: "SPOT", quote: "USDT" },
    select: { id: true, exchange: true, exchangeSymbol: true, quoteVolume24h: true },
    orderBy: { exchange: "asc" },
  });
  console.log(`Markets: ${markets.length}`);

  // Load CLOSED candles for all markets for timeframe
  const allCandles: Array<{ meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] }> = [];
  for (const m of markets) {
    const rows = await prisma.candle.findMany({
      where: { marketId: m.id, timeframe, closed: true },
      orderBy: { openTime: "asc" },
      take: 1000,
      select: { openTime: true, open: true, high: true, low: true, close: true, closed: true },
    });
    allCandles.push({
      meta: {
        exchange: m.exchange,
        market: m.exchangeSymbol,
        marketId: m.id,
        timeframe,
        assetRank: asset.rank,
        quoteVolume24h: m.quoteVolume24h,
      },
      candles: rows as any,
    });
  }

  // We need to walk through history: for each common horizon, evaluate
  // Simplified: use quorum selection to get all common horizons over last 500 bars
  const tfMs = SMCTIMEFRAME_MS[timeframe];
  const now = new Date();
  // For historical replay, we need to iterate over time
  // We'll collect unique openTimes from BINANCE as reference
  const binance = allCandles.find((c) => c.meta.exchange === "BINANCE");
  if (!binance) throw new Error("BINANCE not found");
  const times = binance.candles.map((c) => c.openTime).slice(-500); // last 500

  const cfg = defaultSmcScoringConfig(timeframe);
  const filters = { top500Only: false, minimumQuoteVolume24h: 0 };
  const signals: SignalDetail[] = [];

  for (const t of times) {
    const asOf = new Date(t.getTime() + tfMs);
    // Truncate each market to t
    const truncatedMarkets = allCandles.map((mc) => {
      const candles = mc.candles.filter((c) => c.openTime.getTime() <= t.getTime());
      return { meta: mc.meta, candles };
    }).filter((mc) => mc.candles.length > 0 && mc.candles[mc.candles.length - 1].openTime.getTime() === t.getTime());

    if (truncatedMarkets.length < 3) continue;

    // Check quorum
    const quorumSel = selectQuorumClosedHorizon(
      truncatedMarkets.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles })),
      timeframe,
      { now: asOf, minExchanges: 3 }
    );
    if (quorumSel.status !== "ok" || !quorumSel.commonHorizon || quorumSel.commonHorizon.getTime() !== t.getTime()) continue;
    if (quorumSel.freshCount < 3) continue;

    const freshIds = new Set(quorumSel.freshMarkets.map((f) => f.marketId));
    const freshMarkets = truncatedMarkets.filter((m) => freshIds.has(m.meta.marketId));

    const result = buildSmartMoneySignalCandidate({
      markets: freshMarkets as any,
      timeframe,
      smcConfig: cfg,
      filters,
      now: asOf,
      strategyId: 999,
      strategyVersion: 1,
      strategySlug: "smart-money-suslik",
      symbol: "BTC",
      minExchanges: 3,
      policy: "QUORUM",
      nextBarCandles: undefined,
    });

    if (result.status === "ok" && result.candidate.score >= 72) {
      const c = result.candidate;
      signals.push({
        signalCandleTime: c.signalCandleTime,
        asOf: c.asOf,
        direction: c.direction,
        scorePerExchange: c.metadata.perExchange.map((p) => ({ exchange: p.exchange, longScore: p.longScore, shortScore: p.shortScore, direction: p.direction })),
        confirmation: c.metadata.confirmation,
        confirmationCount: c.confirmationCount,
        confirmationTotal: c.confirmationTotal,
        participatingExchanges: c.metadata.perExchange.filter((p) => p.evaluable).map((p) => p.exchange),
        aI: Object.fromEntries(c.metadata.perExchange[0]?.reasons.map((r) => [r.code, { long: r.longPoints, short: r.shortPoints, label: r.label }]) || []),
        referenceExchange: c.referenceExchange,
        referencePrice: c.referencePrice,
        aggregatePrice: c.aggregatePrice,
        atrAtSignal: c.atrAtSignal,
        nextBarAvailable: false,
        nextBarOpen: null,
        nextBarOpenTime: null,
      });
    }
  }

  console.log(`\nFound ${signals.length} aggregated signals >=72`);
  for (const s of signals) {
    console.log(`\n--- ${s.signalCandleTime.toISOString()} ${s.direction} ${s.confirmation} ref=${s.referenceExchange} refPrice=${s.referencePrice} atr=${s.atrAtSignal}`);
    console.log(`  Scores: ${s.scorePerExchange.map((p) => `${p.exchange}:${p.direction} L${p.longScore} S${p.shortScore}`).join(", ")}`);
    console.log(`  Participating: ${s.participatingExchanges.join(", ")}`);
    console.log(`  A-I: ${JSON.stringify(s.aI)}`);
  }

  // Spacing
  if (signals.length > 1) {
    const sorted = signals.sort((a, b) => a.signalCandleTime.getTime() - b.signalCandleTime.getTime());
    const gaps: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const gapMs = sorted[i].signalCandleTime.getTime() - sorted[i - 1].signalCandleTime.getTime();
      gaps.push(gapMs / tfMs);
    }
    gaps.sort((a, b) => a - b);
    const min = Math.min(...gaps);
    const max = Math.max(...gaps);
    const median = gaps[Math.floor(gaps.length / 2)];
    const p25 = gaps[Math.floor(gaps.length * 0.25)];
    const p75 = gaps[Math.floor(gaps.length * 0.75)];
    console.log(`\n=== SPACING (bars) === min=${min} p25=${p25} median=${median} p75=${p75} max=${max}`);
    const clusters = {
      adjacent: gaps.filter((g) => g === 1).length,
      le2: gaps.filter((g) => g <= 2).length,
      le4: gaps.filter((g) => g <= 4).length,
      le8: gaps.filter((g) => g <= 8).length,
    };
    console.log(`Clusters: adjacent=${clusters.adjacent} <=2=${clusters.le2} <=4=${clusters.le4} <=8=${clusters.le8}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
