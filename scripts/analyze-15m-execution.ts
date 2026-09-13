/**
 * TASK B — 15M FORWARD EXECUTION REPLAY — FIXED METRICS
 * Using ONLY historical SMC signals and causal evaluation
 * Simulate SMC_ATR_V1 with NEXT_BAR_OPEN, research NOT live trading
 * FIXED: referenceExchange matched by exchange string only, fail-closed, no fallback, ATR from reference, no aggregatePrice for execution
 * FIXED: replay metrics now use timestamps, not terminal status — tp1BeforeStop = tp1HitAt != null && (stopHitAt == null || tp1HitAt < stopHitAt)
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import { buildInitialOutcome, evaluateOutcomeProgression, computeReplayMetrics } from "../lib/signals/signal-outcome";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { selectQuorumClosedHorizon } from "../lib/strategies/common-horizon-quorum";
import { buildSmartMoneySignalCandidate } from "../lib/signals/smart-money-candidate";
import type { SmcRawCandle } from "../lib/smc/types";

const prisma = new PrismaClient();

async function main() {
  const tf: SmcTimeframe = "15m";
  console.log(`=== TASK B — 15M FORWARD EXECUTION REPLAY (FIXED METRICS) — ${tf} ===`);
  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true, rank: true } });
  if (!asset) throw new Error("BTC asset not found");
  const markets = await prisma.market.findMany({ where: { assetId: asset.id, enabled: true, status: "ACTIVE", marketType: "SPOT", quote: "USDT" }, select: { id: true, exchange: true, exchangeSymbol: true, quoteVolume24h: true } });
  const allCandles: Array<{ meta: { exchange: string; market: string; marketId: number; timeframe: SmcTimeframe; assetRank: number | null; quoteVolume24h: number | null }; candles: SmcRawCandle[] }> = [];
  for (const m of markets) {
    const rows = await prisma.candle.findMany({ where: { marketId: m.id, timeframe: tf, closed: true }, orderBy: { openTime: "asc" }, take: 1000, select: { openTime: true, open: true, high: true, low: true, close: true, closed: true } });
    allCandles.push({ meta: { exchange: m.exchange, market: m.exchangeSymbol, marketId: m.id, timeframe: tf, assetRank: asset.rank, quoteVolume24h: m.quoteVolume24h }, candles: rows as SmcRawCandle[] });
  }

  const binance = allCandles.find((c) => c.meta.exchange === "BINANCE");
  if (!binance) throw new Error("BINANCE not found for time iteration");
  const times = binance.candles.map((c) => c.openTime).slice(-500);
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

    const expectedNext = new Date(t.getTime() + SMCTIMEFRAME_MS[tf]);
    const nextBarCandles = allCandles.map((mc) => {
      const nb = mc.candles.find((c) => c.openTime.getTime() === expectedNext.getTime());
      return nb ? { marketId: mc.meta.marketId, exchange: mc.meta.exchange, openTime: nb.openTime, open: nb.open, high: nb.high, low: nb.low, close: nb.close } : null;
    }).filter(Boolean) as Array<{ marketId: number; exchange: string; openTime: Date; open: number; high: number; low: number; close: number }>;

    const candidateRes = buildSmartMoneySignalCandidate({
      markets: freshMarkets as any,
      timeframe: tf,
      smcConfig: cfg,
      filters,
      now: asOf,
      strategyId: 999,
      strategyVersion: 1,
      strategySlug: "smart-money-suslik",
      symbol: "BTC",
      minExchanges: 3,
      policy: "QUORUM",
      nextBarCandles: nextBarCandles.map((n) => ({ marketId: n.marketId, openTime: n.openTime, open: n.open })),
    });

    if (candidateRes.status === "ok" && candidateRes.candidate.score >= 72) {
      const refExchange = candidateRes.candidate.referenceExchange;
      if (refExchange == null) {
        console.log(`  Skip signal at ${candidateRes.candidate.signalCandleTime.toISOString()}: referenceExchange null — fail-closed`);
        continue;
      }
      const refMarket = allCandles.find((mc) => mc.meta.exchange === refExchange);
      if (!refMarket) {
        console.log(`  Skip signal at ${candidateRes.candidate.signalCandleTime.toISOString()}: referenceExchange ${refExchange} not found — fail-closed, no fallback`);
        continue;
      }
      if (refMarket.meta.exchange !== refExchange) {
        console.log(`  Skip: mismatch refMarket ${refMarket.meta.exchange} vs candidate ${refExchange} — fail-closed`);
        continue;
      }
      if (candidateRes.candidate.atrAtSignal == null) {
        console.log(`  Skip: atrAtSignal null for ref ${refExchange}`);
        continue;
      }
      const nextBar = refMarket.candles.find((c) => c.openTime.getTime() === expectedNext.getTime());
      if (!nextBar) {
        console.log(`  Skip: next bar not available on ref ${refExchange} at ${expectedNext.toISOString()}`);
        continue;
      }
      const subsequent = refMarket.candles.filter((c) => c.openTime.getTime() > expectedNext.getTime()).slice(0, 50);
      signals.push({ candidate: candidateRes.candidate, nextBar, subsequent });
    }
  }

  console.log(`Found ${signals.length} RAW qualified signals for execution replay (expected 11 adjacent)`);

  // FIXED METRICS — store timestamps
  type ReplayRow = {
    signalCandleTime: Date;
    entryTime: Date | null;
    entry: number | null;
    sl: number | null;
    tp1: number | null;
    tp2: number | null;
    tp3: number | null;
    tp1HitAt: Date | null;
    tp2HitAt: Date | null;
    tp3HitAt: Date | null;
    stopHitAt: Date | null;
    terminalExitAt: Date | null;
    tp1BeforeStop: boolean;
    tp2BeforeStop: boolean;
    tp3BeforeStop: boolean;
    outcome: any;
  };

  const replayRows: ReplayRow[] = [];
  let rs: number[] = [];
  let maxDD = 0, cum = 0;

  for (const s of signals) {
    const initial = buildInitialOutcome({ candidate: s.candidate, nextBar: s.nextBar as any });
    const final = evaluateOutcomeProgression(initial as any, s.candidate, s.subsequent as any);
    const metrics = computeReplayMetrics(final as any);

    console.log(`\nSignal ${s.candidate.signalCandleTime.toISOString()} ${s.candidate.direction} score=${s.candidate.score} ref=${s.candidate.referenceExchange}`);
    console.log(`  entryTime=${metrics.entryTime?.toISOString()} entry=${initial.entryPrice} SL=${initial.stopLoss} TP1=${initial.takeProfit1} TP2=${initial.takeProfit2} TP3=${initial.takeProfit3} atr=${s.candidate.atrAtSignal}`);
    console.log(`  tp1HitAt=${metrics.tp1HitAt?.toISOString() ?? "null"} tp2HitAt=${metrics.tp2HitAt?.toISOString() ?? "null"} tp3HitAt=${metrics.tp3HitAt?.toISOString() ?? "null"} stopHitAt=${metrics.stopHitAt?.toISOString() ?? "null"} terminal=${metrics.terminalExitAt?.toISOString() ?? "null"} status=${final.status}`);
    console.log(`  tp1BeforeStop=${metrics.tp1BeforeStop} tp2BeforeStop=${metrics.tp2BeforeStop} tp3BeforeStop=${metrics.tp3BeforeStop} R=${final.realizedR} bars=${final.barsHeld} maxFavR=${final.maxFavorableR} maxAdvR=${final.maxAdverseR}`);

    replayRows.push({
      signalCandleTime: s.candidate.signalCandleTime,
      entryTime: metrics.entryTime,
      entry: initial.entryPrice,
      sl: initial.stopLoss,
      tp1: initial.takeProfit1,
      tp2: initial.takeProfit2,
      tp3: initial.takeProfit3,
      tp1HitAt: metrics.tp1HitAt,
      tp2HitAt: metrics.tp2HitAt,
      tp3HitAt: metrics.tp3HitAt,
      stopHitAt: metrics.stopHitAt,
      terminalExitAt: metrics.terminalExitAt,
      tp1BeforeStop: metrics.tp1BeforeStop,
      tp2BeforeStop: metrics.tp2BeforeStop,
      tp3BeforeStop: metrics.tp3BeforeStop,
      outcome: final,
    });

    if (final.realizedR !== null) {
      rs.push(final.realizedR);
      cum += final.realizedR;
      maxDD = Math.min(maxDD, cum);
    }
  }

  // CORRECTED AGGREGATE FROM TIMESTAMPS, not terminal status
  const total = replayRows.length;
  const tp1BeforeSLCount = replayRows.filter((r) => r.tp1BeforeStop).length;
  const tp2BeforeSLCount = replayRows.filter((r) => r.tp2BeforeStop).length;
  const tp3BeforeSLCount = replayRows.filter((r) => r.tp3BeforeStop).length;
  const stopBeforeTP1Count = replayRows.filter((r) => r.stopHitAt != null && r.tp1HitAt == null).length;

  console.log(`\n=== CORRECTED AGGREGATE (from timestamps, not terminal status) ===`);
  console.log(`RAW qualified = ${total}`);
  console.log(`TP1-before-SL = ${tp1BeforeSLCount}/${total} = ${total ? (tp1BeforeSLCount / total * 100).toFixed(1) + "%" : "0"} — previously buggy 18.2% because counted only terminal TP statuses`);
  console.log(`TP2-before-SL = ${tp2BeforeSLCount}/${total} = ${total ? (tp2BeforeSLCount / total * 100).toFixed(1) + "%" : "0"}`);
  console.log(`TP3-before-SL = ${tp3BeforeSLCount}/${total} = ${total ? (tp3BeforeSLCount / total * 100).toFixed(1) + "%" : "0"}`);
  console.log(`STOP before TP1 = ${stopBeforeTP1Count}/${total} = ${total ? (stopBeforeTP1Count / total * 100).toFixed(1) + "%" : "0"}`);

  if (rs.length > 0) {
    const avg = rs.reduce((a, b) => a + b, 0) / rs.length;
    const sorted = [...rs].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const wins = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
    const losses = Math.abs(rs.filter((r) => r < 0).reduce((a, b) => a + b, 0));
    const pf = losses > 0 ? wins / losses : 0;
    console.log(`avg R=${avg.toFixed(2)} median R=${median.toFixed(2)} profit factor=${pf.toFixed(2)} maxDD=${maxDD.toFixed(2)} (R)`);
    console.log(`Do NOT claim profitability: sample only ${total} signals ~6 days`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
