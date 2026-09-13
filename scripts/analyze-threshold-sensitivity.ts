/**
 * TASK E — SCORE SENSITIVITY READ-ONLY ONLY
 * Do NOT modify Strategy.config
 * Take already computed historical component points
 * Virtually calculate frequency at thresholds 40,45,50,55,60,65,70,72
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import { evaluateMarketsAtCommonHorizon } from "../lib/strategies/smart-money";
import { selectQuorumClosedHorizon } from "../lib/strategies/common-horizon-quorum";
import { buildSmartMoneySignalCandidate } from "../lib/signals/smart-money-candidate";

const prisma = new PrismaClient();

async function analyzeThreshold(tf: SmcTimeframe, limit: number) {
  console.log(`\n=== THRESHOLD SENSITIVITY ${tf} last ${limit} ===`);
  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true, rank: true } });
  const markets = await prisma.market.findMany({ where: { assetId: asset!.id, enabled: true, status: "ACTIVE", marketType: "SPOT", quote: "USDT" }, select: { id: true, exchange: true, exchangeSymbol: true, quoteVolume24h: true } });
  const allCandles = [];
  for (const m of markets) {
    const rows = await prisma.candle.findMany({ where: { marketId: m.id, timeframe: tf, closed: true }, orderBy: { openTime: "asc" }, take: limit, select: { openTime: true, open: true, high: true, low: true, close: true, closed: true } });
    allCandles.push({ meta: { exchange: m.exchange, market: m.exchangeSymbol, marketId: m.id, timeframe: tf, assetRank: asset!.rank, quoteVolume24h: m.quoteVolume24h }, candles: rows as SmcRawCandle[] });
  }

  const binance = allCandles.find((c) => c.meta.exchange === "BINANCE");
  if (!binance) return;
  const times = binance.candles.map((c) => c.openTime).slice(-500);
  const cfg = defaultSmcScoringConfig(tf);
  const filters = { top500Only: false, minimumQuoteVolume24h: 0 };
  const thresholds = [40, 45, 50, 55, 60, 65, 70, 72];

  const perThreshold: Record<number, { perExchange: { long: number; short: number }; aggregated: { long: number; short: number } }> = {};
  for (const th of thresholds) perThreshold[th] = { perExchange: { long: 0, short: 0 }, aggregated: { long: 0, short: 0 } };

  let totalCommon = 0;

  for (const t of times) {
    const asOf = new Date(t.getTime() + SMCTIMEFRAME_MS[tf]);
    const truncated = allCandles.map((mc) => ({ meta: mc.meta, candles: mc.candles.filter((c) => c.openTime.getTime() <= t.getTime()) })).filter((mc) => mc.candles.length > 0 && mc.candles[mc.candles.length - 1].openTime.getTime() === t.getTime());
    if (truncated.length < 3) continue;
    const quorumSel = selectQuorumClosedHorizon(truncated.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles })), tf, { now: asOf, minExchanges: 3 });
    if (quorumSel.status !== "ok" || !quorumSel.commonHorizon || quorumSel.commonHorizon.getTime() !== t.getTime()) continue;
    if (quorumSel.freshCount < 3) continue;
    totalCommon++;
    const freshIds = new Set(quorumSel.freshMarkets.map((f) => f.marketId));
    const freshMarkets = truncated.filter((m) => freshIds.has(m.meta.marketId));

    // Per-exchange scores at this horizon
    const evalResult = evaluateMarketsAtCommonHorizon(freshMarkets as any, tf, cfg, filters, asOf);
    for (const r of evalResult.results) {
      if (r.status !== "evaluated") continue;
      for (const th of thresholds) {
        if ((r as any).longScore >= th) perThreshold[th].perExchange.long++;
        if ((r as any).shortScore >= th) perThreshold[th].perExchange.short++;
      }
    }

    // Aggregated
    const candidateRes = buildSmartMoneySignalCandidate({ markets: freshMarkets as any, timeframe: tf, smcConfig: cfg, filters, now: asOf, strategyId: 999, strategyVersion: 1, strategySlug: "smart-money-suslik", symbol: "BTC", minExchanges: 3, policy: "QUORUM" });
    if (candidateRes.status === "ok") {
      for (const th of thresholds) {
        if (candidateRes.candidate.score >= th) {
          if (candidateRes.candidate.direction === "LONG") perThreshold[th].aggregated.long++;
          if (candidateRes.candidate.direction === "SHORT") perThreshold[th].aggregated.short++;
        }
      }
    }
  }

  console.log(`Total common evaluable horizons: ${totalCommon}`);
  console.log(`Threshold | per-ex LONG | per-ex SHORT | agg LONG | agg SHORT | per 1000 bars agg`);
  for (const th of thresholds) {
    const aggTotal = perThreshold[th].aggregated.long + perThreshold[th].aggregated.short;
    const per1000 = totalCommon > 0 ? (aggTotal / totalCommon) * 1000 : 0;
    console.log(`${th.toString().padStart(9)} | ${perThreshold[th].perExchange.long.toString().padStart(11)} | ${perThreshold[th].perExchange.short.toString().padStart(12)} | ${perThreshold[th].aggregated.long.toString().padStart(8)} | ${perThreshold[th].aggregated.short.toString().padStart(9)} | ${per1000.toFixed(1)}`);
  }
  console.log(`IMPORTANT: Do not recommend new threshold from frequency alone`);
}

async function main() {
  for (const tf of ["15m", "1h", "4h", "1d"] as SmcTimeframe[]) {
    const limit = tf === "15m" ? 1000 : tf === "1h" ? 2000 : tf === "4h" ? 1000 : 500;
    await analyzeThreshold(tf, limit);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
