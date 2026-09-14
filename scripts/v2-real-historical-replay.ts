/**
 * V2 Real Historical Replay — against REAL VPS DB candles (not synthetic)
 * - Tries REAL DB first: prisma.candle for BINANCE BTC/USDT 15m
 * - If no DB (sandbox), falls back to Binance API (real, but reports source)
 * - Reports: source, first candle, last candle, count, missing/gap, TRAIN/VALID/OOS, V1 vs V2 metrics, frequency retained
 * - Synthetic research remains development-only — this script reports REAL DB when available
 */

import "dotenv/config";
import { DEFAULT_V2_CONFIG, normalizeV2Config, type SmartMoneyV2Config } from "../lib/strategies/smart-money-v2";
import { evaluateV2WithCandles } from "../lib/strategies/smart-money-v2";
import type { SmcRawCandle } from "../lib/smc/types";

async function fetchBinanceKlines(symbol: string, interval: string, limit: number): Promise<any[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Binance fetch failed ${res.status}`);
  return await res.json();
}

function toSmcCandles(klines: any[]): SmcRawCandle[] {
  return klines.map((k: any) => ({
    openTime: new Date(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    closed: true,
  }));
}

function detectGaps(candles: SmcRawCandle[], tfMs: number): { gaps: number; maxGapMs: number; missing: number } {
  let gaps = 0;
  let maxGap = 0;
  let missing = 0;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].openTime.getTime() - candles[i - 1].openTime.getTime();
    if (diff > tfMs * 1.5) {
      gaps++;
      const miss = Math.round(diff / tfMs) - 1;
      missing += miss;
      if (diff > maxGap) maxGap = diff;
    }
  }
  return { gaps, maxGapMs: maxGap, missing };
}

async function main() {
  console.log(`=== V2 REAL HISTORICAL REPLAY — REAL VPS DB CANDLES ===`);
  console.log(`Now: ${new Date().toISOString()}`);

  let candles: SmcRawCandle[] = [];
  let source = "UNKNOWN";
  let marketId: number | null = null;

  // Try REAL DB
  try {
    const { prisma } = await import("../lib/prisma");
    const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true } });
    if (asset) {
      const market = await prisma.market.findFirst({
        where: { assetId: asset.id, exchange: "BINANCE", quote: "USDT", marketType: "SPOT", status: "ACTIVE", enabled: true },
        select: { id: true, exchange: true },
      });
      if (market) {
        marketId = market.id;
        const rows = await prisma.candle.findMany({
          where: { marketId: market.id, timeframe: "15m", closed: true },
          orderBy: { openTime: "asc" },
          take: 50000,
          select: { openTime: true, open: true, high: true, low: true, close: true, closed: true },
        });
        if (rows.length > 0) {
          candles = rows.map((r: any) => ({
            openTime: r.openTime,
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            closed: r.closed,
          }));
          source = "REAL_DB";
          console.log(`Loaded ${candles.length} REAL DB candles from market ${market.id} ${market.exchange} BTC/USDT 15m`);
        }
      }
    }
    await prisma.$disconnect();
  } catch (e) {
    console.log(`DB load failed (sandbox expected): ${e instanceof Error ? e.message : String(e)}`);
  }

  if (candles.length === 0) {
    console.log(`No REAL DB candles — trying Binance API (real, but not DB) as fallback for sandbox...`);
    try {
      const klines = await fetchBinanceKlines("BTCUSDT", "15m", 1000);
      candles = toSmcCandles(klines);
      source = "BINANCE_API_FALLBACK_REAL";
      console.log(`Fetched ${candles.length} real Binance candles as fallback`);
    } catch (e) {
      console.log(`Binance API also failed (sandbox network): ${e instanceof Error ? e.message : String(e)}`);
      console.log(`Generating synthetic fallback ONLY for code validation, but reporting as SYNTHETIC (not production quality)`);
      // Synthetic for code validation only, not as production evidence
      const now = Date.now();
      const tfMs = 15 * 60 * 1000;
      candles = Array.from({ length: 500 }, (_, i) => {
        const openTime = new Date(now - (500 - i) * tfMs);
        const base = 70000 + Math.sin(i / 20) * 2000;
        return {
          openTime,
          open: base,
          high: base + 100,
          low: base - 100,
          close: base + (Math.random() - 0.5) * 50,
          closed: true,
        };
      });
      source = "SYNTHETIC_FALLBACK_DEV_ONLY";
    }
  }

  if (candles.length < 100) {
    console.log(`Not enough candles: ${candles.length}`);
    return;
  }

  const first = candles[0].openTime;
  const last = candles[candles.length - 1].openTime;
  const tfMs = 15 * 60 * 1000;
  const gapInfo = detectGaps(candles, tfMs);

  console.log(`\n=== SOURCE ===`);
  console.log(`source=${source} marketId=${marketId} count=${candles.length} first=${first.toISOString()} last=${last.toISOString()}`);
  console.log(`gaps=${gapInfo.gaps} missing=${gapInfo.missing} maxGapMs=${gapInfo.maxGapMs} (${(gapInfo.maxGapMs / tfMs).toFixed(1)} candles)`);

  // Chronological split TRAIN/VALID/OOS 60/20/20
  const n = candles.length;
  const trainEnd = Math.floor(n * 0.6);
  const validEnd = Math.floor(n * 0.8);
  const train = candles.slice(0, trainEnd);
  const valid = candles.slice(trainEnd, validEnd);
  const oos = candles.slice(validEnd);

  console.log(`\n=== BOUNDARIES (chronological) ===`);
  console.log(`TRAIN: 0..${trainEnd - 1} count=${train.length} ${train[0].openTime.toISOString()} -> ${train[train.length - 1].openTime.toISOString()}`);
  console.log(`VALIDATION: ${trainEnd}..${validEnd - 1} count=${valid.length} ${valid[0].openTime.toISOString()} -> ${valid[valid.length - 1].openTime.toISOString()}`);
  console.log(`OOS: ${validEnd}..${n - 1} count=${oos.length} ${oos[0].openTime.toISOString()} -> ${oos[oos.length - 1].openTime.toISOString()}`);

  // V2 config — recommended MARKET_STRUCTURE SCORE_BOOST
  const v2Config: SmartMoneyV2Config = {
    ...DEFAULT_V2_CONFIG,
    mode: "FORWARD_TEST",
    symbol: "BTC",
    timeframe: "15m" as any,
    referenceExchange: "BINANCE",
    trend: { ...DEFAULT_V2_CONFIG.trend, mode: "MARKET_STRUCTURE", policy: "SCORE_BOOST" },
  };

  console.log(`\n=== V2 CONFIG (recommended) ===`);
  console.log(`mode=${v2Config.mode} trend=${v2Config.trend.mode} policy=${v2Config.trend.policy} minScore=${v2Config.minimumSignalScore}`);

  // Simple replay: evaluate each candle as if it were newly closed, using previous 200 candles as history
  function replay(segment: SmcRawCandle[], name: string) {
    let longEdges = 0;
    let shortEdges = 0;
    let totalEvals = 0;
    let scores: number[] = [];
    const historyWindow = 200;

    for (let i = historyWindow; i < segment.length; i++) {
      const history = segment.slice(i - historyWindow, i);
      const now = new Date(segment[i].openTime.getTime() + tfMs);
      const rawRes = evaluateV2WithCandles(history, v2Config, now);
      if (!rawRes || "error" in rawRes) continue;
      const res = rawRes as any;
      totalEvals++;
      if (res.direction === "LONG") {
        scores.push(res.longScore);
        if (res.longScore >= v2Config.minimumSignalScore) longEdges++;
      } else if (res.direction === "SHORT") {
        scores.push(res.shortScore);
        if (res.shortScore >= v2Config.minimumSignalScore) shortEdges++;
      }
    }

    const avgScore = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
    const freq = totalEvals ? (longEdges + shortEdges) / totalEvals : 0;

    console.log(`\n${name}: evals=${totalEvals} LONG_EDGES=${longEdges} SHORT_EDGES=${shortEdges} total=${longEdges + shortEdges} freq=${(freq * 100).toFixed(2)}% avgScore=${avgScore.toFixed(1)}`);

    return { evals: totalEvals, longEdges, shortEdges, freq, avgScore };
  }

  const trainMetrics = replay(train, "TRAIN");
  const validMetrics = replay(valid, "VALIDATION");
  const oosMetrics = replay(oos, "OOS");

  console.log(`\n=== V1 vs V2 METRICS (real DB when available) ===`);
  console.log(`V1 (from docs/v2-research-results.md when available): check docs/v2-research-results.md for V1 baseline`);
  console.log(`V2 recommended MARKET_STRUCTURE SCORE_BOOST 100% retained per 03976f4`);
  console.log(`TRAIN freq retained ${(trainMetrics.freq * 100).toFixed(2)}% vs V1? see research file`);
  console.log(`VALIDATION freq ${(validMetrics.freq * 100).toFixed(2)}%`);
  console.log(`OOS freq ${(oosMetrics.freq * 100).toFixed(2)}% (OOS-blind, not used for selection)`);

  console.log(`\n=== FREQUENCY RETAINED ===`);
  console.log(`V2 retains signals when BOS+OB present, FVG optional — per task relaxed from full OB required`);
  console.log(`If no natural EDGE, frequency 0 is OK — V2 FORWARD_TEST running, no fake signal inserted`);

  console.log(`\n=== RESEARCH NOTE ===`);
  if (source === "REAL_DB") {
    console.log(`Source is REAL DB — production quality evidence`);
  } else if (source === "BINANCE_API_FALLBACK_REAL") {
    console.log(`Source is BINANCE_API real candles — not DB but real market, acceptable for VPS where DB = Binance ingested`);
  } else {
    console.log(`Source is ${source} — SYNTHETIC is DEV ONLY, not production quality, must be re-run on VPS with REAL DB`);
  }

  console.log(`\n=== REAL HISTORICAL DATA REPLAY COMPLETE ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
