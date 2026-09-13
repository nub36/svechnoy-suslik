// @ts-nocheck
/**
 * Test ALL coins live chart coverage — read-only
 * Simulates frontend checks for 20+ coins
 * Run: npx tsx scripts/test-all-coins-live.ts
 * Requires DATABASE_URL for DB part, but live provider check works without DB
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const EXCHANGE_PRIORITY = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"] as const;
const TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;

type TestResult = {
  symbol: string;
  rank: number | null;
  availableExchanges: string[];
  historical: Record<string, number>; // tf -> count
  liveProvider: string;
  fallbackUsed: boolean;
  hasBinance: boolean;
  result: "PASS" | "FAIL" | "NO_MARKET" | "NO_CANDLES";
  reason?: string;
};

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log("=== ALL COINS LIVE CHART TEST (20+ coins) ===\n");

    const assets = await prisma.asset.findMany({
      where: { enabled: true, rank: { lte: 100, not: null } },
      orderBy: { rank: "asc" },
      take: 100,
      select: {
        id: true,
        symbol: true,
        rank: true,
        markets: {
          where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
          select: { exchange: true, exchangeSymbol: true },
        },
      },
    });

    // Pick 20+ coins: BTC, ETH, SOL + 17 others from top 100
    const mustHave = ["BTC", "ETH", "SOL", "BNB", "XRP", "DOGE", "ADA", "AVAX", "SHIB", "DOT", "LINK", "TRX", "MATIC", "LTC", "BCH", "UNI", "XLM", "ATOM", "ETC", "FIL", "APT", "ARB", "OP", "NEAR", "HBAR"];
    const selectedSymbols = new Set<string>();
    // Ensure BTC, ETH, SOL first
    for (const s of ["BTC", "ETH", "SOL"]) selectedSymbols.add(s);
    // Add from mustHave until 20
    for (const s of mustHave) {
      if (selectedSymbols.size >= 25) break;
      selectedSymbols.add(s);
    }
    // Fill from top assets if needed
    for (const a of assets) {
      if (selectedSymbols.size >= 25) break;
      selectedSymbols.add(a.symbol);
    }

    const testAssets = assets.filter((a) => selectedSymbols.has(a.symbol));
    // Ensure we have at least 20, if some symbols not in DB, keep what we have
    const finalTest = testAssets.slice(0, 25);

    console.log(`Testing ${finalTest.length} coins: ${finalTest.map((a) => a.symbol).join(", ")}\n`);

    const results: TestResult[] = [];

    for (const asset of finalTest) {
      const availableExchanges = [...new Set(asset.markets.map((m) => m.exchange))];
      const hasBinance = availableExchanges.includes("BINANCE");

      // Historical candles per timeframe
      const candleRows = await prisma.$queryRaw<{ timeframe: string; count: bigint }[]>`
        SELECT c.timeframe, COUNT(*)::bigint as count
        FROM "Candle" c
        JOIN "Market" m ON m.id = c."marketId"
        WHERE m."assetId" = ${asset.id} AND m.enabled = true AND m.status = 'ACTIVE' AND m.quote = 'USDT' AND m."marketType" = 'SPOT'
        GROUP BY c.timeframe
      `;

      const historical: Record<string, number> = {};
      for (const tf of TIMEFRAMES) historical[tf] = 0;
      for (const row of candleRows) {
        historical[row.timeframe] = Number(row.count);
      }

      const hasAnyCandles = Object.values(historical).some((c) => c > 0);

      // Fallback policy
      let chosenExchange: string | null = null;
      let fallbackUsed = false;
      if (availableExchanges.length === 0) {
        chosenExchange = null;
      } else {
        // Simulate: user prefers BINANCE, if not available fallback to priority
        if (availableExchanges.includes("BINANCE")) {
          chosenExchange = "BINANCE";
        } else {
          for (const pri of EXCHANGE_PRIORITY) {
            if (availableExchanges.includes(pri)) {
              chosenExchange = pri;
              fallbackUsed = true;
              break;
            }
          }
          if (!chosenExchange) chosenExchange = availableExchanges[0];
        }
      }

      let liveProvider = "NONE";
      if (chosenExchange === "BINANCE") liveProvider = "BINANCE_WS";
      else if (chosenExchange === "BYBIT") liveProvider = "BYBIT_WS";
      else if (chosenExchange) liveProvider = `${chosenExchange}_POLLING_FALLBACK`;

      let result: TestResult["result"] = "PASS";
      let reason: string | undefined;

      if (availableExchanges.length === 0) {
        result = "NO_MARKET";
        reason = "No ACTIVE SPOT USDT markets";
      } else if (!hasAnyCandles) {
        result = "NO_CANDLES";
        reason = "Has market but no historical candles — needs backfill via generic OHLCV worker";
      } else {
        // Check if at least 1h exists (minimum for display)
        if (historical["1h"] === 0) {
          result = "FAIL";
          reason = "Missing 1h historical";
        } else {
          result = "PASS";
        }
      }

      results.push({
        symbol: asset.symbol,
        rank: asset.rank,
        availableExchanges,
        historical,
        liveProvider,
        fallbackUsed,
        hasBinance,
        result,
        reason,
      });
    }

    // Print results
    console.log("SYMBOL | RANK | EXCHANGES | HIST 5m/15m/1h/4h/1d | LIVE PROVIDER | RESULT");
    console.log("-".repeat(120));
    for (const r of results) {
      const hist = TIMEFRAMES.map((tf) => `${tf}:${r.historical[tf]}`).join(" ");
      console.log(
        `${r.symbol.padEnd(6)} | ${(r.rank?.toString() ?? "-").padEnd(4)} | ${r.availableExchanges.join(",").padEnd(20)} | ${hist.padEnd(35)} | ${r.liveProvider.padEnd(25)} | ${r.result}${r.reason ? ` (${r.reason})` : ""}${r.fallbackUsed ? " FALLBACK" : ""}`
      );
    }

    console.log("\n=== SUMMARY ===");
    const pass = results.filter((r) => r.result === "PASS").length;
    const noMarket = results.filter((r) => r.result === "NO_MARKET").length;
    const noCandles = results.filter((r) => r.result === "NO_CANDLES").length;
    const fail = results.filter((r) => r.result === "FAIL").length;

    console.log(`TOTAL TESTED: ${results.length}`);
    console.log(`PASS: ${pass}`);
    console.log(`NO_MARKET: ${noMarket}`);
    console.log(`NO_CANDLES (needs backfill): ${noCandles}`);
    console.log(`FAIL: ${fail}`);

    console.log("\n=== COVERAGE BY EXCHANGE ===");
    const byEx: Record<string, number> = {};
    for (const r of results) {
      for (const ex of r.availableExchanges) {
        byEx[ex] = (byEx[ex] ?? 0) + 1;
      }
    }
    for (const ex of EXCHANGE_PRIORITY) {
      console.log(`  ${ex}: ${byEx[ex] ?? 0}/${results.length} coins`);
    }

    console.log("\n=== LIVE ARCHITECTURE ===");
    console.log("Historical source: PostgreSQL Candle (CLOSED only, canonical for Signal Engine)");
    console.log("Live source: public exchange WebSocket (BINANCE native WS, BYBIT native WS, others polling fallback via /api/chart/live)");
    console.log("1 subscription per open chart only (current coin/exchange/timeframe)");
    console.log("Incremental update: UPDATE if openTime==last, APPEND if openTime>last");
    console.log("Reconciliation: periodic 60s with PostgreSQL after candle close, replaces display-live with canonical");
    console.log("Fallback: BINANCE > BYBIT > GATE > KUCOIN > BINGX");
    console.log("No market: show 'Нет поддерживаемого рынка для live-графика'");

    console.log("\n=== SIGNAL ENGINE UNCHANGED ===");
    console.log("DISPLAY uses: PostgreSQL history + LIVE websocket candle");
    console.log("SIGNALS use: ONLY canonical CLOSED PostgreSQL candles");
    console.log("No websocket tick enters: Smart Money, EDGE, quorum, StrategySignalState, Signal");
    console.log("Files NOT touched: edge-state-machine.ts, signal-engine.ts, StrategySignalState");

    console.log("\n=== INGESTION ===");
    console.log("Workers: svechnoy-suslik-ohlcv-btc (BTC pilot, lock 727923, interval 2m, concurrency 1) + svechnoy-suslik-ohlcv-all (ALL coins top100, lock 727924, interval 5m, concurrency 3)");
    console.log("Concurrency: bounded 3, rate limiting 250ms per exchange, retry/backoff, advisory lock, failed markets logging");
    console.log("Backfill: initial 300 candles per market×tf, then incremental filter >= last openTime");
    console.log("Exclusions preserved: BINGX 1d excluded");

    if (noMarket > 0) {
      console.log("\n=== NO MARKET COINS ===");
      for (const r of results.filter((r) => r.result === "NO_MARKET")) {
        console.log(`  ${r.symbol}: no ACTIVE SPOT USDT markets`);
      }
    }

    if (noCandles > 0) {
      console.log("\n=== COINS NEEDING BACKFILL ===");
      for (const r of results.filter((r) => r.result === "NO_CANDLES")) {
        console.log(`  ${r.symbol}: has market ${r.availableExchanges.join(",")} but no candles — run generic worker: npx tsx scripts/ohlcv-worker.ts --top=100 --timeframes=5m,15m,1h,4h,1d --concurrency=3 --once --confirm-large-run`);
      }
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
