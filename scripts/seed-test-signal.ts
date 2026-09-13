/**
 * Seed test signal for BTC — for demo when strategy gives NEUTRAL
 * PHASE 2C: signalSource=SEEDED, not LIVE_FORWARD, to avoid polluting live stats
 * Live stats must WHERE signalSource=LIVE_FORWARD only
 * Legacy seeded ID1/ID2 are NOT live — they remain SEEDED or LEGACY after migration
 * This script should NOT be run in production without owner approval, and even then creates SEEDED only
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("=== SEED TEST SIGNAL BTC — PHASE 2C SEEDED, not LIVE_FORWARD ===");
  console.log("This script creates SEEDED signals, which are excluded from live stats WHERE signalSource=LIVE_FORWARD");

  const strategy = await prisma.strategy.findFirst({
    where: { slug: "trend-suslik" },
    orderBy: { version: "desc" },
  });

  if (!strategy) {
    console.error("trend-suslik not found");
    process.exit(1);
  }

  console.log(`Strategy: id=${strategy.id} slug=${strategy.slug} v${strategy.version} enabled=${strategy.enabled} status=${strategy.status}`);

  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" } });
  if (!asset) {
    console.error("BTC asset not found");
    process.exit(1);
  }

  const lastSnap = await prisma.indicatorSnapshot.findFirst({
    where: { timeframe: "1h" },
    orderBy: { candleTime: "desc" },
  });

  const entry = lastSnap?.price ?? 76792.32;
  const atr = lastSnap?.atr14 ?? 350;

  const signalsToCreate = [
    {
      symbol: "BTC",
      timeframe: "1h",
      direction: "LONG",
      score: 78,
      entry,
      stopLoss: entry - atr * 1.5,
      takeProfit1: entry + atr * 1.5,
      takeProfit2: entry + atr * 2.5,
      takeProfit3: entry + atr * 4,
      status: "ACTIVE",
      reason: "Тестовый сигнал BTC LONG — демо для /signals, SEEDED not LIVE_FORWARD, excluded from live stats",
      strategyId: strategy.id,
      signalSource: "SEEDED" as const,
      signalCandleTime: new Date(Date.now() - 60 * 60 * 1000), // 1h ago, for unique constraint
    },
    {
      symbol: "BTC",
      timeframe: "1h",
      direction: "SHORT",
      score: 75,
      entry,
      stopLoss: entry + atr * 1.5,
      takeProfit1: entry - atr * 1.5,
      takeProfit2: entry - atr * 2.5,
      takeProfit3: entry - atr * 4,
      status: "ACTIVE",
      reason: "Тестовый сигнал BTC SHORT — демо, SEEDED not LIVE_FORWARD",
      strategyId: strategy.id,
      signalSource: "SEEDED" as const,
      signalCandleTime: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2h ago
    },
  ];

  for (const data of signalsToCreate) {
    const existing = await prisma.signal.findFirst({
      where: {
        symbol: data.symbol,
        timeframe: data.timeframe,
        direction: data.direction,
        strategyId: data.strategyId,
        signalSource: "SEEDED",
        status: "ACTIVE",
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      console.log(`Signal ${data.direction} SEEDED already exists id=${existing.id} source=${(existing as any).signalSource} — skipping`);
      continue;
    }

    // In real run, would create — but we guard to not accidentally run in production
    console.log(`Would create SEEDED signal ${data.direction} ${data.symbol} ${data.timeframe} entry=${data.entry.toFixed(2)} SL=${data.stopLoss?.toFixed(2)} TP1=${data.takeProfit1?.toFixed(2)} score=${data.score} source=${data.signalSource} candleTime=${data.signalCandleTime.toISOString()}`);
    // Uncomment to actually create in local dev:
    // const created = await prisma.signal.create({ data });
    // console.log(`Created signal id=${created.id} ${created.direction} source=${(created as any).signalSource}`);
    console.log(`DRY — not creating, set RUN_SEED=true to actually insert`);
    if (process.env.RUN_SEED === "true") {
      const created = await prisma.signal.create({ data: data as any });
      console.log(`Created signal id=${created.id} ${created.direction} ${created.symbol} ${created.timeframe} entry=${created.entry} source=${(created as any).signalSource}`);
    }
  }

  const count = await prisma.signal.count();
  console.log(`\nTotal signals: ${count}`);
  const all = await prisma.signal.findMany({ orderBy: { createdAt: "desc" }, take: 10, include: { strategy: true } });
  for (const s of all) {
    console.log(`  id=${s.id} ${s.symbol} ${s.timeframe} ${s.direction} score=${s.score} entry=${s.entry} strategy=${s.strategy.slug} status=${s.status} source=${(s as any).signalSource} candleTime=${(s as any).signalCandleTime?.toISOString() ?? "NULL"} ${s.createdAt.toISOString()}`);
  }

  await prisma.$disconnect();
  console.log("\n=== DONE — SEEDED signals excluded from live stats WHERE signalSource=LIVE_FORWARD ===");
  console.log("=== Legacy ID1/ID2 should be LEGACY after PHASE 2C migration, not LIVE_FORWARD ===");
}

main().catch(e => { console.error(e); process.exit(1); });
