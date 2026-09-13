/**
 * Seed Smart Money V2 — additive, no DROP/TRUNCATE
 * Creates 3 strategies if not exist: trend-suslik v1, smart-money-suslik v1, smart-money-v2 v2
 * V1 untouched, V2 new with MODE DISABLED/DRY_RUN default DISABLED LIVE off
 */

import { PrismaClient } from "@prisma/client";
import { DEFAULT_V2_CONFIG } from "../lib/strategies/smart-money-v2";

const prisma = new PrismaClient();

async function ensureTrendSuslik() {
  const existing = await prisma.strategy.findFirst({ where: { slug: "trend-suslik", version: 1 } });
  if (existing) {
    console.log(`✓ trend-suslik v1 exists id=${existing.id} — untouched`);
    return existing;
  }
  const created = await prisma.strategy.create({
    data: {
      name: "Трендовый Суслик",
      slug: "trend-suslik",
      description: "Трендовая стратегия на основе EMA, RSI, MACD, объёма и ATR.",
      version: 1,
      enabled: true,
      status: "PUBLISHED",
      mode: "DISABLED",
      config: {
        minimumSignalScore: 70,
        weights: { trend: 30, mediumTrend: 15, rsi: 20, macd: 20, volume: 15 },
        ema: { fast: 20, medium: 50, slow: 200 },
        rsi: { period: 14, longMin: 52, longMax: 72, shortMin: 28, shortMax: 48 },
        macd: { fast: 12, slow: 26, signal: 9 },
        atr: { period: 14, stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4 },
        volume: { period: 20, minimumRatio: 1 },
        execution: { closedCandleOnly: true, cooldownCandles: 3 },
        filters: { minimumQuoteVolume24h: 1000000, top500Only: true },
      },
      timeframes: ["15m", "1h", "4h", "1d"],
      minExchanges: 3,
    },
  });
  console.log(`✓ trend-suslik v1 created id=${created.id}`);
  return created;
}

async function ensureSmartMoneyV1() {
  const existing = await prisma.strategy.findFirst({ where: { slug: "smart-money-suslik", version: 1 } });
  if (existing) {
    console.log(`✓ smart-money-suslik v1 exists id=${existing.id} — untouched per task`);
    return existing;
  }
  // If not exists, create minimal V1 (should already exist in prod)
  const created = await prisma.strategy.create({
    data: {
      name: "Smart Money Suslik V1",
      slug: "smart-money-suslik",
      description: "Smart Money V1 — BOS, CHOCH, Order Blocks, FVG, Liquidity Sweep, 5 exchanges quorum 3/5",
      version: 1,
      enabled: true,
      status: "PUBLISHED",
      mode: "DISABLED",
      config: {
        minimumSignalScore: 72,
        swingLeft: 20,
        swingRight: 20,
        internalLeft: 3,
        internalRight: 3,
        atrPeriod: 14,
        structureEventFreshBars: 10,
        sweepFreshBars: 5,
        orderBlockFreshBars: 20,
        fvgFreshBars: 20,
        eqBand: 0.02,
        weights: {
          swingStructureBias: 20,
          recentSwingBos: 15,
          internalStructure: 10,
          liquiditySweep: 10,
          swingOrderBlock: 15,
          internalOrderBlock: 5,
          fvg: 10,
          rangePosition: 10,
          confluence: 5,
        },
        filters: { minimumQuoteVolume24h: 0, top500Only: false },
      },
      timeframes: ["5m", "15m", "1h", "4h", "1d"],
      minExchanges: 3,
    },
  });
  console.log(`✓ smart-money-suslik v1 created id=${created.id}`);
  return created;
}

async function ensureSmartMoneyV2() {
  const existing = await prisma.strategy.findFirst({ where: { slug: "smart-money-v2", version: 2 } });
  if (existing) {
    console.log(`✓ smart-money-v2 v2 exists id=${existing.id} — will update config to default if needed but preserve mode`);
    // Ensure mode not LIVE
    if (existing.mode === "LIVE") {
      await prisma.strategy.update({ where: { id: existing.id }, data: { mode: "DISABLED" } });
      console.log(`  → Fixed mode from LIVE to DISABLED per task`);
    }
    return existing;
  }

  const created = await prisma.strategy.create({
    data: {
      name: "Smart Money V2",
      slug: "smart-money-v2",
      description: "Smart Money V2 — reference exchange BINANCE BTC/USDT CLOSED 15m, SMC confirmations N/M not exchanges N/M, trend context MARKET_STRUCTURE/EMA/HTF/COMBINED, SCORE_BOOST/TIERING/HARD_ALIGNMENT, EDGE/RE-ARM state machine reused, V1/V2 state independent",
      version: 2,
      enabled: false,
      status: "DRAFT",
      mode: "DISABLED",
      config: DEFAULT_V2_CONFIG as any,
      timeframes: ["15m"],
      minExchanges: 1,
    },
  });
  console.log(`✓ smart-money-v2 v2 created id=${created.id} mode=DISABLED LIVE off`);
  return created;
}

async function main() {
  console.log("Seeding 3 strategies: trend-suslik v1, smart-money-suslik v1, smart-money-v2 v2");

  await ensureTrendSuslik();
  await ensureSmartMoneyV1();
  await ensureSmartMoneyV2();

  const all = await prisma.strategy.findMany({ where: { slug: { in: ["trend-suslik", "smart-money-suslik", "smart-money-v2"] } }, orderBy: [{ slug: "asc" }, { version: "asc" }] });
  console.log("\nFinal strategies:");
  for (const s of all) {
    console.log(`- ${s.slug} v${s.version} id=${s.id} enabled=${s.enabled} status=${s.status} mode=${(s as any).mode} timeframes=${s.timeframes.join(",")} minEx=${s.minExchanges}`);
  }

  console.log("\n✓ 3 strategies must exist — check passed if count >=3");
  if (all.length < 3) {
    console.error("ERROR: Expected 3 strategies");
    process.exit(1);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
