// @ts-nocheck
/**
 * TASK 5 — HISTORICAL EDGE REPLAY
 * Build read-only historical replay of all 15m common horizons
 * Output episodes: episode #, start candle, direction, end/rearm candle, duration bars, peak score, confirmation min/max
 * For measured 08:15..10:45 expected ONE SHORT episode
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import { selectQuorumClosedHorizon } from "../lib/strategies/common-horizon-quorum";
import { buildSmartMoneySignalCandidate } from "../lib/signals/smart-money-candidate";
import { computeEdgeTransition, type StrategySignalStateRow } from "../lib/signals/edge-state-machine";
import type { SmcRawCandle } from "../lib/smc/types";

const prisma = new PrismaClient();

async function main() {
  const tf: SmcTimeframe = "15m";
  console.log(`=== HISTORICAL EDGE REPLAY — ${tf} ===`);
  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true, rank: true } });
  if (!asset) throw new Error("BTC not found");
  const markets = await prisma.market.findMany({ where: { assetId: asset.id, enabled: true, status: "ACTIVE", marketType: "SPOT", quote: "USDT" }, select: { id: true, exchange: true, exchangeSymbol: true, quoteVolume24h: true } });
  const allCandles: Array<{ meta: any; candles: SmcRawCandle[] }> = [];
  for (const m of markets) {
    const rows = await prisma.candle.findMany({ where: { marketId: m.id, timeframe: tf, closed: true }, orderBy: { openTime: "asc" }, take: 1000, select: { openTime: true, open: true, high: true, low: true, close: true, closed: true } });
    allCandles.push({ meta: { exchange: m.exchange, market: m.exchangeSymbol, marketId: m.id, timeframe: tf, assetRank: asset.rank, quoteVolume24h: m.quoteVolume24h }, candles: rows as SmcRawCandle[] });
  }

  const binance = allCandles.find((c) => c.meta.exchange === "BINANCE");
  if (!binance) throw new Error("BINANCE not found");
  const times = binance.candles.map((c) => c.openTime);
  const cfg = defaultSmcScoringConfig(tf);
  const filters = { top500Only: false, minimumQuoteVolume24h: 0 };

  let stateRow: StrategySignalStateRow | null = null;
  let episodes: Array<{ episode: number; start: Date; direction: string; end: Date | null; durationBars: number | null; peakScore: number; confirmations: string[] }> = [];
  let currentEpisode: any = null;
  let episodeCount = 0;

  for (const t of times) {
    const asOf = new Date(t.getTime() + SMCTIMEFRAME_MS[tf]);
    const truncated = allCandles.map((mc) => ({ meta: mc.meta, candles: mc.candles.filter((c: any) => c.openTime.getTime() <= t.getTime()) })).filter((mc) => mc.candles.length > 0 && mc.candles[mc.candles.length - 1].openTime.getTime() === t.getTime());
    if (truncated.length < 3) continue;
    const quorumSel = selectQuorumClosedHorizon(truncated.map((m) => ({ exchange: m.meta.exchange, marketId: m.meta.marketId, candles: m.candles })), tf, { now: asOf, minExchanges: 3 });
    if (quorumSel.status !== "ok" || !quorumSel.commonHorizon) continue;
    if (quorumSel.freshCount < 3) continue;
    if (quorumSel.commonHorizon.getTime() !== t.getTime()) continue;

    const freshIds = new Set(quorumSel.freshMarkets.map((f) => f.marketId));
    const freshMarkets = truncated.filter((m) => freshIds.has(m.meta.marketId));
    const candidateRes = buildSmartMoneySignalCandidate({ markets: freshMarkets as any, timeframe: tf, smcConfig: cfg, filters, now: asOf, strategyId: 1, strategyVersion: 1, strategySlug: "smart-money-suslik", symbol: "BTC", minExchanges: 3, policy: "QUORUM" });

    let aggregate: string;
    let score: number | null = null;
    let confirmation: string | null = null;
    if (candidateRes.status === "ok") {
      aggregate = candidateRes.candidate.direction;
      score = candidateRes.candidate.score;
      confirmation = candidateRes.candidate.confirmationCount + "/" + candidateRes.candidate.confirmationTotal;
    } else {
      const reason = candidateRes.reason;
      if (reason.includes("NEUTRAL")) aggregate = "NEUTRAL";
      else aggregate = "DATA_UNAVAILABLE";
    }

    const transition = computeEdgeTransition({ previousStateRow: stateRow, currentAggregate: aggregate as any, currentCandleTime: t, emitOnBootstrap: false });

    if (transition.action === "NOOP_SAME_HORIZON" || transition.action === "REFUSE_OLDER_HORIZON") {
      continue;
    } else if (transition.action === "PRESERVE_UNAVAILABLE") {
      if (stateRow) {
        stateRow = { ...stateRow, lastEvaluatedCandleTime: t, lastEvaluationStatus: aggregate } as any;
      } else {
        stateRow = { strategyId: 1, symbol: "BTC", timeframe: tf, lastEvaluatedCandleTime: t, aggregateState: "NEUTRAL", lastSignalCandleTime: null, lastSignalDirection: null, lastEvaluationStatus: aggregate };
      }
    } else {
      if (transition.shouldEmit) {
        if (currentEpisode) {
          currentEpisode.end = t;
          currentEpisode.durationBars = Math.round((t.getTime() - currentEpisode.start.getTime()) / SMCTIMEFRAME_MS[tf]);
          episodes.push(currentEpisode);
        }
        episodeCount++;
        currentEpisode = {
          episode: episodeCount,
          start: t,
          direction: transition.emitDirection,
          end: null,
          durationBars: null,
          peakScore: score,
          confirmations: confirmation ? [confirmation] : [],
          trigger: transition.triggerType,
        };
        stateRow = {
          strategyId: 1,
          symbol: "BTC",
          timeframe: tf,
          lastEvaluatedCandleTime: t,
          aggregateState: aggregate,
          lastSignalCandleTime: t,
          lastSignalDirection: transition.emitDirection as any,
          lastEvaluationStatus: aggregate,
        };
      } else if (transition.action === "REARM" && currentEpisode) {
        currentEpisode.end = t;
        currentEpisode.durationBars = Math.round((t.getTime() - currentEpisode.start.getTime()) / SMCTIMEFRAME_MS[tf]);
        episodes.push(currentEpisode);
        currentEpisode = null;
        const savedRow = stateRow;
        const prevSigTime: Date | null = savedRow ? savedRow.lastSignalCandleTime : null;
        const prevSigDir: any = savedRow ? savedRow.lastSignalDirection : null;
        stateRow = {
          strategyId: 1,
          symbol: "BTC",
          timeframe: tf,
          lastEvaluatedCandleTime: t,
          aggregateState: "NEUTRAL",
          lastSignalCandleTime: prevSigTime,
          lastSignalDirection: prevSigDir,
          lastEvaluationStatus: "NEUTRAL",
        };
      } else {
        if (currentEpisode && score != null && score > currentEpisode.peakScore) {
          currentEpisode.peakScore = score;
          if (confirmation) currentEpisode.confirmations.push(confirmation);
        }
        const savedRow2 = stateRow;
        const prevSigTime: Date | null = savedRow2 ? savedRow2.lastSignalCandleTime : null;
        const prevSigDir: any = savedRow2 ? savedRow2.lastSignalDirection : null;
        stateRow = {
          strategyId: 1,
          symbol: "BTC",
          timeframe: tf,
          lastEvaluatedCandleTime: t,
          aggregateState: aggregate,
          lastSignalCandleTime: prevSigTime,
          lastSignalDirection: prevSigDir,
          lastEvaluationStatus: aggregate,
        };
      }
    }
  }

  if (currentEpisode) episodes.push(currentEpisode);

  console.log(`\n=== EPISODES (expected ONE SHORT episode for 08:15..10:45) ===`);
  for (const ep of episodes) {
    console.log(`Episode #${ep.episode} start=${(ep.start as Date).toISOString()} dir=${ep.direction} end=${ep.end?.toISOString() ?? "null"} durationBars=${ep.durationBars ?? "null"} peakScore=${ep.peakScore} confirmations=${ep.confirmations.join(",")} trigger=${(ep as any).trigger}`);
  }
  console.log(`\nTotal episodes: ${episodes.length}`);
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
