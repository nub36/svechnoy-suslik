// @ts-nocheck
/**
 * Coverage audit for ALL coins live charts
 * Read-only, no DB writes
 * Run on VPS with DATABASE_URL: npx tsx scripts/audit-all-coins-coverage.ts
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const EXCHANGE_PRIORITY = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"] as const;
const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log("=== ALL COINS LIVE CHART COVERAGE AUDIT ===\n");

    const totalAssets = await prisma.asset.count();
    const activeAssets = await prisma.asset.count({ where: { enabled: true } });
    const top100Assets = await prisma.asset.count({ where: { enabled: true, rank: { lte: 100, not: null } } });
    const totalMarkets = await prisma.market.count();
    const activeMarkets = await prisma.market.count({
      where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
    });

    console.log(`TOTAL ASSETS: ${totalAssets}`);
    console.log(`ACTIVE ASSETS (enabled=true): ${activeAssets}`);
    console.log(`TOP100 ACTIVE: ${top100Assets}`);
    console.log(`TOTAL MARKETS: ${totalMarkets}`);
    console.log(`ACTIVE SPOT USDT MARKETS: ${activeMarkets}\n`);

    const assets = await prisma.asset.findMany({
      where: { enabled: true },
      orderBy: { rank: "asc" },
      select: {
        id: true,
        symbol: true,
        rank: true,
        name: true,
        enabled: true,
        markets: {
          where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
          select: { exchange: true, exchangeSymbol: true, id: true },
        },
      },
    });

    console.log(`ASSETS WITH MARKET: ${assets.filter((a) => a.markets.length > 0).length}`);
    console.log(`ASSETS WITHOUT MARKET: ${assets.filter((a) => a.markets.length === 0).length}\n`);

    // Coverage per exchange
    const byExchange: Record<string, number> = {};
    for (const a of assets) {
      for (const m of a.markets) {
        byExchange[m.exchange] = (byExchange[m.exchange] ?? 0) + 1;
      }
    }
    console.log("MARKETS BY EXCHANGE:");
    for (const ex of EXCHANGE_PRIORITY) {
      console.log(`  ${ex}: ${byExchange[ex] ?? 0} assets`);
    }
    console.log("");

    // Candle coverage
    const candleStats = await prisma.$queryRaw<
      { timeframe: string; assets: bigint; markets: bigint; candles: bigint }[]
    >`
      SELECT c.timeframe, COUNT(DISTINCT m."assetId")::bigint as assets, COUNT(DISTINCT c."marketId")::bigint as markets, COUNT(*)::bigint as candles
      FROM "Candle" c
      JOIN "Market" m ON m.id = c."marketId"
      WHERE m.enabled = true AND m.status = 'ACTIVE' AND m.quote = 'USDT' AND m."marketType" = 'SPOT'
      GROUP BY c.timeframe
      ORDER BY c.timeframe
    `;

    console.log("CANDLE COVERAGE BY TIMEFRAME:");
    for (const row of candleStats) {
      console.log(`  ${row.timeframe}: ${row.assets} assets, ${row.markets} markets, ${row.candles} candles`);
    }
    console.log("");

    // Per-asset detailed coverage for top 100
    const topAssets = assets.filter((a) => a.rank !== null && a.rank <= 100).slice(0, 100);

    let withHistorical = 0;
    let withoutHistorical = 0;
    const withoutCandles: string[] = [];
    const partialCoverage: { symbol: string; missing: string[]; exchanges: string[] }[] = [];

    for (const asset of topAssets) {
      const candles = await prisma.$queryRaw<{ timeframe: string; count: bigint }[]>`
        SELECT c.timeframe, COUNT(*)::bigint as count
        FROM "Candle" c
        JOIN "Market" m ON m.id = c."marketId"
        WHERE m."assetId" = ${asset.id} AND m.enabled = true AND m.status = 'ACTIVE' AND m.quote = 'USDT' AND m."marketType" = 'SPOT'
        GROUP BY c.timeframe
      `;

      const tfMap = new Map(candles.map((c) => [c.timeframe, Number(c.count)]));
      const missing = TIMEFRAMES.filter((tf) => !tfMap.has(tf) || tfMap.get(tf) === 0);

      if (missing.length === TIMEFRAMES.length) {
        withoutHistorical++;
        withoutCandles.push(asset.symbol);
      } else {
        withHistorical++;
        if (missing.length > 0) {
          partialCoverage.push({
            symbol: asset.symbol,
            missing,
            exchanges: asset.markets.map((m) => m.exchange),
          });
        }
      }
    }

    console.log(`TOP100 WITH HISTORICAL CANDLES (at least 1 tf): ${withHistorical}`);
    console.log(`TOP100 WITHOUT CANDLES (no tf): ${withoutHistorical}\n`);

    if (withoutCandles.length > 0) {
      console.log(`COINS WITHOUT CANDLES (top100 sample): ${withoutCandles.slice(0, 30).join(", ")}${withoutCandles.length > 30 ? " ..." : ""}\n`);
    }

    if (partialCoverage.length > 0) {
      console.log("PARTIAL COVERAGE (missing timeframes):");
      for (const p of partialCoverage.slice(0, 20)) {
        console.log(`  ${p.symbol}: missing ${p.missing.join(", ")} | exchanges ${p.exchanges.join(", ")}`);
      }
      console.log("");
    }

    // Check BTC-only ingestion config
    console.log("=== ROOT CAUSE ANALYSIS ===\n");
    console.log("Current ecosystem.config.js has:");
    console.log("  svechnoy-suslik-ohlcv-btc: --symbol=BTC only");
    console.log("  No generic --top=100 worker");
    console.log("  So BTC has candles, other coins don't unless manually backfilled\n");

    console.log("TOTAL COINS: " + totalAssets);
    console.log("COINS WITH MARKET: " + assets.filter((a) => a.markets.length > 0).length);
    console.log("COINS WITH HISTORICAL CANDLES (top100): " + withHistorical);
    console.log("COINS WITHOUT CANDLES (top100): " + withoutHistorical);

    console.log("\n=== FALLBACK POLICY ===");
    console.log("Priority: BINANCE > BYBIT > GATE > KUCOIN > BINGX");
    console.log("If selected exchange not available, fallback to first available in priority order");
    console.log("If no market at all: show 'Нет поддерживаемого рынка для live-графика'");

    console.log("\n=== INGESTION RECOMMENDATION ===");
    console.log("Need generic worker: --top=100 --timeframes=5m,15m,1h,4h,1d");
    console.log("With bounded concurrency 3-5, rate limiting, advisory lock, retry/backoff");
    console.log("Initial backfill 300 candles, then incremental sync");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
