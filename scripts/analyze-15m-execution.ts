/**
 * TASK B — 15M FORWARD EXECUTION REPLAY
 * Using ONLY historical SMC signals and causal evaluation
 * Simulate SMC_ATR_V1 with NEXT_BAR_OPEN, research NOT live trading
 * For each signal: entry = exact next bar OPEN on referenceExchange, ATR frozen, SL/TP, same-bar pessimistic, gap-through
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import { buildInitialOutcome, evaluateOutcomeProgression } from "../lib/signals/signal-outcome";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { selectQuorumClosedHorizon } from "../lib/strategies/common-horizon-quorum";
import { buildSmartMoneySignalCandidate } from "../lib/signals/smart-money-candidate";
import type { SmcRawCandle } from "../lib/smc/types";

const prisma = new PrismaClient();

async function main() {
  const tf: SmcTimeframe = "15m";
  console.log(`=== TASK B — 15M FORWARD EXECUTION REPLAY — ${tf} ===`);
  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true, rank: true } });
  const markets = await prisma.market.findMany({ where: { assetId: asset!.id, enabled: true, status: "ACTIVE", marketType: "SPOT", quote: "USDT" }, select: { id: true, exchange: true, exchangeSymbol: true, quoteVolume24h: true } });
  const allCandles = [];
  for (const m of markets) {
    const rows = await prisma.candle.findMany({ where: { marketId: m.id, timeframe: tf, closed: true }, orderBy: { openTime: "asc" }, take: 1000, select: { openTime: true, open: true, high: true, low: true, close: true, closed: true } });
    allCandles.push({ meta: { exchange: m.exchange, market: m.exchangeSymbol, marketId: m.id, timeframe: tf, assetRank: asset!.rank, quoteVolume24h: m.quoteVolume24h }, candles: rows as SmcRawCandle[] });
  }

  const binance = allCandles.find((c) => c.meta.exchange === "BINANCE");
  const times = binance!.candles.map((c) => c.openTime).slice(-500);
  const cfg = defaultSmcScoringConfig(tf);
  const filters = { top500Only: false, minimumQuoteVolume24h: 0 };

  const signals: Array<{ candidate: any; nextBar: any; subsequent: any[] }> = [];

  for (let idx = 0; idx < times.length - 1; idx++) {
    const t = times[idx];
    const asOf = new Date(t.getTime() + SMCTIMEFRAME_MS[tf]);
    const truncated = allCandles.map((mc) => ({ meta: mc.meta, candles: mc.candles.filter((c) => c.openTime.getTime() <= t.getTime()) })).filter((mc) => mc.candles.length > 0 && mc.candles[mc.candles.length - 1].openTime.getTime() === t.getTime());
    if (truncated.length < 3) continue;
    const quorumSel = selectQuorumClosedHorizon(truncated.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles })), tf, { now: asOf, minExchanges: 3 });
    if (quorumSel.status !== "ok" || !quorumSel.commonHorizon || quorumSel.commonHorizon.getTime() !== t.getTime()) continue;
    if (quorumSel.freshCount < 3) continue;
    const freshIds = new Set(quorumSel.freshMarkets.map((f) => f.marketId));
    const freshMarkets = truncated.filter((m) => freshIds.has(m.meta.marketId));

    // Need next bar for entry
    const expectedNext = new Date(t.getTime() + SMCTIMEFRAME_MS[tf]);
    const nextBarCandles = allCandles.map((mc) => {
      const nb = mc.candles.find((c) => c.openTime.getTime() === expectedNext.getTime());
      return nb ? { marketId: mc.meta.marketId, openTime: nb.openTime, open: nb.open, high: nb.high, low: nb.low, close: nb.close } : null;
    }).filter(Boolean) as any[];

    const candidateRes = buildSmartMoneySignalCandidate({ markets: freshMarkets as any, timeframe: tf, smcConfig: cfg, filters, now: asOf, strategyId: 999, strategyVersion: 1, strategySlug: "smart-money-suslik", symbol: "BTC", minExchanges: 3, policy: "QUORUM", nextBarCandles: nextBarCandles.map((n) => ({ marketId: n.marketId, openTime: n.openTime, open: n.open })) });

    if (candidateRes.status === "ok" && candidateRes.candidate.score >= 72) {
      const refMarket = allCandles.find((mc) => mc.meta.marketId === candidateRes.candidate.referenceExchange ? true : mc.meta.exchange === candidateRes.candidate.referenceExchange);
      const refCandles = refMarket?.candles || [];
      const nextBar = refCandles.find((c) => c.openTime.getTime() === expectedNext.getTime());
      if (!nextBar) continue;
      const subsequent = refCandles.filter((c) => c.openTime.getTime() > expectedNext.getTime()).slice(0, 50);
      signals.push({ candidate: candidateRes.candidate, nextBar, subsequent });
    }
  }

  console.log(`Found ${signals.length} signals for execution replay`);
  let tp1BeforeSL = 0, tp2Hit = 0, tp3Hit = 0, stopBeforeTP1 = 0;
  let rs: number[] = [];
  let maxDD = 0, cum = 0;

  for (const s of signals) {
    const initial = buildInitialOutcome({ candidate: s.candidate, nextBar: s.nextBar as any });
    const final = evaluateOutcomeProgression(initial as any, s.candidate, s.subsequent as any);
    const entry = initial.entryPrice;
    const sl = initial.stopLoss;
    const tp1 = initial.takeProfit1, tp2 = initial.takeProfit2, tp3 = initial.takeProfit3;
    console.log(`\nSignal ${s.candidate.signalCandleTime.toISOString()} ${s.candidate.direction} score=${s.candidate.score} ref=${s.candidate.referenceExchange}`);
    console.log(`  entry=${entry} SL=${sl} TP1=${tp1} TP2=${tp2} TP3=${tp3} atr=${s.candidate.atrAtSignal}`);
    console.log(`  outcome=${final.status} exit=${final.exitPrice} R=${final.realizedR} bars=${final.barsHeld} maxFavR=${final.maxFavorableR} maxAdvR=${final.maxAdverseR} tp1At=${final.tp1HitAt?.toISOString()} tp2At=${final.tp2HitAt?.toISOString()} tp3At=${final.tp3HitAt?.toISOString()}`);

    if (final.realizedR !== null) {
      rs.push(final.realizedR);
      cum += final.realizedR;
      maxDD = Math.min(maxDD, cum);
    }
    if (final.status === "TP1_HIT" || final.status === "TP2_HIT" || final.status === "TP3_HIT") {
      if (final.tp1HitAt) tp1BeforeSL++;
    }
    if (final.tp2HitAt) tp2Hit++;
    if (final.tp3HitAt) tp3Hit++;
    if (final.status === "STOPPED" && !final.tp1HitAt) stopBeforeTP1++;
  }

  const total = signals.length;
  console.log(`\n=== AGGREGATE (research, NOT live trading, sample only ${total} signals ~6 days) ===`);
  console.log(`signals=${total} TP1-before-SL=${total ? (tp1BeforeSL / total * 100).toFixed(1) + "%" : "0"} TP2 hit=${total ? (tp2Hit / total * 100).toFixed(1) + "%" : "0"} TP3 hit=${total ? (tp3Hit / total * 100).toFixed(1) + "%" : "0"} STOP before TP1=${total ? (stopBeforeTP1 / total * 100).toFixed(1) + "%" : "0"}`);
  if (rs.length > 0) {
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sorted = [...rs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const wins = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const losses = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
    const pf = losses > 0 ? wins / losses : 0;
    console.log(`avg R=${avg.toFixed(2)} median R=${median.toFixed(2)} profit factor=${pf.toFixed(2)} maxDD=${maxDD.toFixed(2)} (R)`);
    console.log(`Do NOT claim profitability: sample only ${total} signals`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
