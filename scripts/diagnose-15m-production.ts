/**
 * PRODUCTION DIAGNOSTICS BTC 15m — for VPS run
 * Shows SERVER UTC, EXPECTED CLOSED 15M, per-exchange latest, COMMON HORIZON, SIGNAL WORKER EVALUATED
 * Proves timestamp semantics: openTime = OPEN 16:15..16:30, closeTime = row[6], closed = closeTime < now
 * Checks why new horizons not appearing after 16:30/16:45
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import { expectedLatestClosedOpenTime } from "../lib/strategies/common-horizon";
import { selectQuorumClosedHorizon } from "../lib/strategies/common-horizon-quorum";
import type { SmcRawCandle } from "../lib/smc/types";

const prisma = new PrismaClient();

async function main() {
  const tf: SmcTimeframe = "15m";
  const now = new Date();
  const serverUtc = now.toISOString();
  const expectedClosed = expectedLatestClosedOpenTime(now, tf);

  console.log(`\n=== BTC 15m PRODUCTION DIAGNOSTICS ===`);
  console.log(`SERVER UTC: ${serverUtc}`);
  console.log(`EXPECTED CLOSED 15M: ${expectedClosed.toISOString()} (floor(now/D)*D - D)`);
  console.log(`  now=${now.toISOString()} D=15m => floor=${new Date(Math.floor(now.getTime()/SMCTIMEFRAME_MS[tf])*SMCTIMEFRAME_MS[tf]).toISOString()} minus D => ${expectedClosed.toISOString()}`);
  console.log(`  Semantics: openTime=OPEN, e.g., 16:15 OPEN means candle 16:15..16:30, closeTime approx 16:29:59, closed=true when closeTime < now`);
  console.log(`  Therefore at 16:30:00, 16:15 becomes CLOSED; at 16:43:55, latest CLOSED is still 16:15 (16:30 closes at 16:45); at 16:45:00, 16:30 becomes CLOSED; at 16:46, expected becomes 16:30`);

  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true } });
  if (!asset) throw new Error("BTC asset not found");
  const markets = await prisma.market.findMany({
    where: { assetId: asset.id, enabled: true, status: "ACTIVE", marketType: "SPOT", quote: "USDT" },
    select: { id: true, exchange: true, exchangeSymbol: true },
    orderBy: { exchange: "asc" },
  });

  console.log(`\nMarkets: ${markets.length} for BTC`);

  const perExchangeLatest: Record<string, { latestClosed: Date | null; latestAny: Date | null; count: number; last5: any[] }> = {};

  for (const m of markets) {
    const rows = await prisma.candle.findMany({
      where: { marketId: m.id, timeframe: tf },
      orderBy: { openTime: "desc" },
      take: 10,
      select: { openTime: true, closeTime: true, close: true, closed: true, createdAt: true, updatedAt: true },
    });
    const closedRows = rows.filter((r: any) => r.closed);
    const latestClosed = closedRows.length > 0 ? closedRows[0].openTime : null;
    const latestAny = rows.length > 0 ? rows[0].openTime : null;
    perExchangeLatest[m.exchange] = {
      latestClosed,
      latestAny,
      count: rows.length,
      last5: rows.slice(0, 5),
    };
  }

  console.log(`\n--- Per-exchange last 5 candles (real field names: openTime, closeTime, close, closed, createdAt, updatedAt) ---`);
  for (const [ex, data] of Object.entries(perExchangeLatest)) {
    console.log(`\n${ex} latest CLOSED: ${data.latestClosed?.toISOString() ?? "none"} latest ANY: ${data.latestAny?.toISOString() ?? "none"} count: ${data.count}`);
    for (const r of data.last5) {
      console.log(`  openTime=${r.openTime.toISOString()} closeTime=${r.closeTime?.toISOString() ?? "null"} close=${r.close} closed=${r.closed} createdAt=${r.createdAt?.toISOString()} updatedAt=${r.updatedAt?.toISOString()}`);
    }
  }

  console.log(`\n--- MAX timestamp CLOSED 15m per exchange ---`);
  for (const [ex, data] of Object.entries(perExchangeLatest)) {
    console.log(`${ex.padEnd(8)} latest CLOSED: ${data.latestClosed?.toISOString() ?? "none"}`);
  }

  // Build quorum selection using CLOSED candles up to 500
  const allCandles: Array<{ meta: any; candles: SmcRawCandle[] }> = [];
  for (const m of markets) {
    const rows = await prisma.candle.findMany({
      where: { marketId: m.id, timeframe: tf, closed: true },
      orderBy: { openTime: "asc" },
      take: 500,
      select: { openTime: true, open: true, high: true, low: true, close: true, closed: true },
    });
    allCandles.push({
      meta: { exchange: m.exchange, marketId: m.id },
      candles: rows as any,
    });
  }

  const quorumSel = selectQuorumClosedHorizon(
    allCandles.map((c) => ({ exchange: c.meta.exchange, marketId: c.meta.marketId, candles: c.candles })),
    tf,
    { now, minExchanges: 3 }
  );

  console.log(`\n--- COMMON HORIZON (QUORUM) ---`);
  console.log(`status=${quorumSel.status} expectedLatestClosed=${quorumSel.expectedLatestClosed.toISOString()} commonHorizon=${quorumSel.commonHorizon?.toISOString() ?? "null"} fresh=${quorumSel.freshCount} stale=${quorumSel.staleCount}`);
  console.log(`fresh: ${quorumSel.freshMarkets.map((f) => `${f.exchange}@${f.latest?.toISOString()}`).join(", ")}`);
  console.log(`stale: ${quorumSel.staleMarkets.map((s) => `${s.exchange}@${s.latest?.toISOString()}(${s.reason})`).join("; ")}`);
  console.log(`reason: ${quorumSel.reason}`);

  // Compare
  console.log(`\n--- Comparison ---`);
  console.log(`SERVER UTC: ${serverUtc}`);
  console.log(`EXPECTED CLOSED 15M (math): ${expectedClosed.toISOString()}`);
  console.log(`BINANCE latest CLOSED: ${perExchangeLatest["BINANCE"]?.latestClosed?.toISOString() ?? "none"}`);
  console.log(`BYBIT latest CLOSED: ${perExchangeLatest["BYBIT"]?.latestClosed?.toISOString() ?? "none"}`);
  console.log(`GATE latest CLOSED: ${perExchangeLatest["GATE"]?.latestClosed?.toISOString() ?? "none"}`);
  console.log(`KUCOIN latest CLOSED: ${perExchangeLatest["KUCOIN"]?.latestClosed?.toISOString() ?? "none"}`);
  console.log(`BINGX latest CLOSED: ${perExchangeLatest["BINGX"]?.latestClosed?.toISOString() ?? "none"}`);
  console.log(`COMMON HORIZON: ${quorumSel.commonHorizon?.toISOString() ?? "null"} (quorum status ${quorumSel.status})`);
  console.log(`SIGNAL WORKER EVALUATED: should be commonHorizon when status=ok, else expectedLatestClosed or null`);

  // Check ingestion lag
  console.log(`\n--- Ingestion lag check ---`);
  const nowMs = now.getTime();
  for (const [ex, data] of Object.entries(perExchangeLatest)) {
    if (data.latestClosed) {
      const lagMs = nowMs - data.latestClosed.getTime();
      const lagBars = Math.round(lagMs / SMCTIMEFRAME_MS[tf]);
      console.log(`${ex} lag from latest CLOSED: ${lagBars} bars (${Math.floor(lagMs/1000)}s)`);
      if (lagBars > 2) {
        console.log(`  WARNING: ${ex} lag >2 bars may indicate OHLCV worker stalled or exchange API issue`);
      }
    }
  }

  // Timestamp semantics proof from code
  console.log(`\n--- Timestamp semantics proof ---`);
  console.log(`From lib/exchanges/binance.ts:`);
  console.log(`  openTime: new Date(Number(row[0]))`);
  console.log(`  closeTime: new Date(Number(row[6]))`);
  console.log(`  closed: Number(row[6]) < now`);
  console.log(`=> openTime is OPEN, e.g., 16:15 OPEN = candle 16:15..16:30, closeTime ~16:29:59, closed true after 16:30`);
  console.log(`From common-horizon.ts expectedLatestClosedOpenTime:`);
  console.log(`  floorMs = floor(now/D)*D, return floorMs - D`);
  console.log(`=> At 16:43:55, floor=16:30, minus 15m => 16:15, so 16:15 is latest CLOSED, NOT lagging`);
  console.log(`=> At 16:46:00, floor=16:45, minus 15m => 16:30, so after 16:45, expected becomes 16:30`);

  // Check OHLCV worker cadence
  console.log(`\n--- OHLCV worker cadence check ---`);
  console.log(`ecosystem.config.js: ohlcv-btc interval 120000ms = 2m, sequential 25 tasks ~10-20s runtime, advisory lock 727923`);
  console.log(`At 16:45:00, 16:30 candle closes, OHLCV worker should ingest it within 2m (by 16:47)`);
  console.log(`If after 16:47 DB still shows latest CLOSED 16:15, then ingestion stalled — check pm2 logs`);

  // Check StrategySignalState
  try {
    // @ts-ignore
    const states = await prisma.strategySignalState.findMany({ where: { symbol: "BTC", timeframe: "15m" } });
    console.log(`\n--- StrategySignalState BTC 15m ---`);
    for (const st of states) {
      console.log(`id=${st.id} strategyId=${st.strategyId} aggregate=${st.aggregateState} lastEvaluated=${st.lastEvaluatedCandleTime?.toISOString()} lastSignal=${st.lastSignalCandleTime?.toISOString()} dir=${st.lastSignalDirection} evalStatus=${st.lastEvaluationStatus}`);
    }
    if (states.length === 0) console.log("No StrategySignalState yet — bootstrap will be BOOTSTRAP_NO_SIGNAL");
  } catch (e: any) {
    console.log(`\nStrategySignalState query failed (table may not exist): ${e.message}`);
  }

  // Check latest real Signal
  try {
    const latestSignals = await prisma.signal.findMany({
      where: { symbol: "BTC", timeframe: "15m" },
      orderBy: { signalCandleTime: "desc" },
      take: 5,
      include: { outcome: true },
    });
    console.log(`\n--- Latest 5 BTC 15m Signals ---`);
    for (const s of latestSignals) {
      console.log(`id=${s.id} candle=${s.signalCandleTime?.toISOString()} dir=${s.direction} score=${s.score} trigger=${s.triggerType} conf=${s.confirmationCount}/${s.confirmationTotal} status=${s.status} outcome=${s.outcome?.status} created=${s.createdAt.toISOString()}`);
    }
    if (latestSignals.length === 0) console.log("No BTC 15m signals yet — may be WAITING_FOR_NATURAL_EDGE if current aggregate NEUTRAL/HOLD");
  } catch (e: any) {
    console.log(`\nSignal query failed: ${e.message}`);
  }

  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
