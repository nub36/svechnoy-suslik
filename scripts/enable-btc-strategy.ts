/**
 * Enable BTC Strategy for main site 3000 — makes strategy visible and enabled.
 * 
 * Usage on VPS:
 *   cd ~/svechnoy-suslik
 *   npx tsx scripts/enable-btc-strategy.ts
 *   npx tsx scripts/enable-btc-strategy.ts --enable
 *   npx tsx scripts/enable-btc-strategy.ts --disable
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const args = process.argv.slice(2);
  const enable = !args.includes("--disable");
  const showOnly = args.includes("--show") || args.includes("--dry-run");

  console.log(`=== ENABLE BTC STRATEGY — ${enable ? "ENABLE" : "DISABLE"} — for site 3000 ===`);

  const strategies = await prisma.strategy.findMany({
    orderBy: { id: "asc" },
  });

  console.log(`Found ${strategies.length} strategies:`);
  for (const s of strategies) {
    console.log(`  id=${(s as any).id} slug=${(s as any).slug} v${(s as any).version} enabled=${(s as any).enabled} status=${(s as any).status} timeframes=${(s as any).timeframes.join(",")} minExchanges=${(s as any).minExchanges}`);
  }

  const trendSuslik = strategies.find((s: any) => s.slug === "trend-suslik");
  const smartMoney = strategies.find((s: any) => s.slug === "smart-money-suslik");

  if (!trendSuslik && !smartMoney) {
    console.error("No trend-suslik or smart-money-suslik found — need to seed strategies");
    console.log("Run: npx tsx scripts/seed-strategies.ts");
    process.exit(1);
  }

  if (showOnly) {
    console.log("\nDry-run — not changing DB");
    await prisma.$disconnect();
    return;
  }

  // Enable trend-suslik for BTC pilot — also fix timeframes to include 1h for signal worker
  if (trendSuslik) {
    console.log(`\n${enable ? "Enabling" : "Disabling"} trend-suslik id=${trendSuslik.id}...`);
    const updated = await prisma.strategy.update({
      where: { id: trendSuslik.id },
      data: {
        enabled: enable,
        status: enable ? "PUBLISHED" : "DRAFT",
        timeframes: ["15m", "1h", "4h", "1d"],
        minExchanges: 2,
      },
    });
    console.log(`  Updated: enabled=${updated.enabled} status=${updated.status} timeframes=${updated.timeframes.join(",")} minExchanges=${updated.minExchanges}`);
  }

  // For smart-money, keep DRAFT for now unless explicitly enabled
  if (smartMoney && args.includes("--enable-smart-money")) {
    console.log(`\nEnabling smart-money-suslik id=${smartMoney.id}...`);
    const updated = await prisma.strategy.update({
      where: { id: smartMoney.id },
      data: {
        enabled: enable,
        status: enable ? "PUBLISHED" : "DRAFT",
      },
    });
    console.log(`  Updated: enabled=${updated.enabled} status=${updated.status}`);
  } else if (smartMoney) {
    console.log(`\nSmart Money strategy id=${smartMoney.id} remains ${smartMoney.status} enabled=${smartMoney.enabled} — use --enable-smart-money to enable it`);
  }

  // Show signals count
  const signalsCount = await prisma.signal.count();
  const activeSignals = await prisma.signal.count({ where: { status: "ACTIVE" } });
  console.log(`\nSignals in DB: total=${signalsCount} active=${activeSignals}`);

  if (activeSignals > 0) {
    const lastSignals = await prisma.signal.findMany({
      orderBy: { createdAt: "desc" },
      take: 5,
      include: { strategy: { select: { slug: true, version: true } } },
    });
    console.log(`Last 5 signals:`);
    for (const sig of lastSignals) {
      console.log(`  id=${sig.id} ${sig.symbol} ${sig.timeframe} ${sig.direction} score=${sig.score} entry=${sig.entry} strategy=${sig.strategy.slug} v${sig.strategy.version} status=${sig.status} created=${sig.createdAt.toISOString()}`);
    }
  }

  console.log(`\n=== DONE ===`);
  console.log(`Strategy ${enable ? "enabled" : "disabled"} for site 3000`);
  console.log(`Next steps on VPS:`);
  console.log(`  npm run build && pm2 restart svechnoy-suslik --update-env`);
  console.log(`  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run`);
  console.log(`  npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run`);
  console.log(`  Check http://89.125.24.50:3000/strategies and /signals and /admin`);

  await prisma.$disconnect();
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
