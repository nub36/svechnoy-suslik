/**
 * Seed test signal for BTC — for demo when strategy gives NEUTRAL
 * Creates a real LONG signal so /signals page shows data
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("=== SEED TEST SIGNAL BTC — for /signals demo ===");

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

  // Get last price from IndicatorSnapshot
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
      reason: "Тестовый сигнал BTC LONG — демо для /signals, trend-suslik v1, 5/5 бирж, ATR 350, entry по последней закрытой свече 11:00 UTC, для проверки что страница сигналов работает после деплоя 3001→3000",
      strategyId: strategy.id,
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
      reason: "Тестовый сигнал BTC SHORT — демо, проверка /signals и /coin/BTC, после включения стратегии",
      strategyId: strategy.id,
    },
  ];

  for (const data of signalsToCreate) {
    const existing = await prisma.signal.findFirst({
      where: {
        symbol: data.symbol,
        timeframe: data.timeframe,
        direction: data.direction,
        strategyId: data.strategyId,
        status: "ACTIVE",
      },
      orderBy: { createdAt: "desc" },
    });

    if (existing) {
      console.log(`Signal ${data.direction} already exists id=${existing.id} — skipping`);
      continue;
    }

    const created = await prisma.signal.create({ data });
    console.log(`Created signal id=${created.id} ${created.direction} ${created.symbol} ${created.timeframe} entry=${created.entry.toFixed(2)} SL=${created.stopLoss?.toFixed(2)} TP1=${created.takeProfit1?.toFixed(2)} score=${created.score}`);
  }

  const count = await prisma.signal.count();
  console.log(`\nTotal signals: ${count}`);
  const all = await prisma.signal.findMany({ orderBy: { createdAt: "desc" }, take: 10, include: { strategy: true } });
  for (const s of all) {
    console.log(`  id=${s.id} ${s.symbol} ${s.timeframe} ${s.direction} score=${s.score} entry=${s.entry} strategy=${s.strategy.slug} status=${s.status} ${s.createdAt.toISOString()}`);
  }

  await prisma.$disconnect();
  console.log("\n=== DONE — check http://89.125.24.50:3000/signals ===");
}

main().catch(e => { console.error(e); process.exit(1); });
