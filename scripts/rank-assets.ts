import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const EXCLUDED = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "USDP",
  "DAI",
  "USDE",
  "USDS",
  "PYUSD",
  "RLUSD",
  "USD1",
  "USDG",
  "USDQ",
  "USDD",
  "GUSD",
  "LUSD",
  "FRAX",
  "EUR",
  "EURC",
  "EURI"
]);

async function main() {
  console.log("🐿️ Суслик строит глобальный рейтинг... (SAFE MODE: no global rank=null clear before repopulate)");

  const assets = await prisma.asset.findMany({
    include: {
      markets: {
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT"
        }
      }
    }
  });

  const ranked = assets
    .filter(
      (asset: { symbol: string; markets: { quoteVolume24h: number | null }[] }) =>
        !EXCLUDED.has(asset.symbol) &&
        asset.markets.length > 0
    )
    .map((asset: { id: number; symbol: string; markets: { quoteVolume24h: number | null }[] }) => {
      const volumes = asset.markets
        .map((m: { quoteVolume24h: number | null }) => m.quoteVolume24h ?? 0)
        .filter((v: number) => v > 0)
        .sort((a: number, b: number) => b - a);

      const totalVolume =
        volumes.reduce((sum: number, v: number) => sum + v, 0);

      const maxVolume = volumes[0] ?? 0;

      const exchangeCount = volumes.length;

      /*
       * Ликвидность:
       * 70% — крупнейший рынок актива
       * 30% — остальные площадки
       *
       * Дополнительный небольшой бонус за присутствие
       * на нескольких биржах.
       */
      const secondaryVolume =
        Math.max(0, totalVolume - maxVolume);

      const rawLiquidity =
        maxVolume * 0.7 +
        secondaryVolume * 0.3;

      const exchangeBonus =
        1 + Math.min(exchangeCount - 1, 4) * 0.05;

      const liquidityScore =
        rawLiquidity * exchangeBonus;

      return {
        id: asset.id,
        symbol: asset.symbol,
        exchangeCount,
        totalVolume,
        maxVolume,
        liquidityScore
      };
    })
    .sort(
      (a: { liquidityScore: number }, b: { liquidityScore: number }) =>
        b.liquidityScore - a.liquidityScore
    );

  if (ranked.length === 0) {
    console.error("No ranked assets — aborting to avoid clearing ranks (safe guard)");
    return;
  }

  console.log(`Ranked ${ranked.length} assets, will update ranks without prior global clear (safe)`);

  // SAFE: Update ranked assets first, without clearing all ranks before
  // If crash mid-loop, old ranks remain for not-yet-updated assets, so TOP-50 not fully empty
  // Previously: updateMany rank=null for ALL, then loop — crash left site with rank=null empty
  let updated = 0;
  try {
    for (let i = 0; i < ranked.length; i++) {
      const item = ranked[i];
      await prisma.asset.update({
        where: { id: item.id },
        data: {
          rank: i + 1,
          top500: i < 500,
          exchangeCount: item.exchangeCount,
          totalVolume24h: item.totalVolume,
          maxVolume24h: item.maxVolume,
          liquidityScore: item.liquidityScore
        }
      });
      updated++;
      if ((i + 1) % 100 === 0) {
        console.log(`  Updated ${i + 1}/${ranked.length}...`);
      }
    }
    console.log(`✓ Updated ${updated}/${ranked.length} ranked assets`);
  } catch (e) {
    console.error(`Error during ranked updates after ${updated} items: ${e instanceof Error ? e.message : String(e)}`);
    console.error(`SAFE: Not clearing remaining ranks — old ranks preserved for not-yet-updated assets, site still shows TOP-50 (possibly stale but not empty)`);
    throw e;
  }

  // After successful loop, clear ranks for assets NOT in ranked list (those without markets or excluded)
  // This is safe because ranked list already persisted
  try {
    const rankedIds = new Set(ranked.map((r: { id: number }) => r.id));
    // Find assets that currently have rank not null but are not in ranked list
    const toClear = await prisma.asset.findMany({
      where: { rank: { not: null }, id: { notIn: Array.from(rankedIds) } },
      select: { id: true }
    });
    if (toClear.length > 0) {
      console.log(`Clearing ${toClear.length} assets that are no longer ranked (no markets/excluded)`);
      await prisma.asset.updateMany({
        where: { id: { in: toClear.map((c: { id: number }) => c.id) } },
        data: { rank: null, top500: false }
      });
    } else {
      console.log(`No stale ranked assets to clear`);
    }
  } catch (e) {
    console.error(`Error clearing stale ranks (non-critical): ${e instanceof Error ? e.message : String(e)}`);
    // Non-critical, don't throw
  }

  // Историческая сводка Top-500 (legacy, только
  // информирование); вывод ниже НЕ описание universe.
  const top500 = ranked.slice(0, 500);

  console.log("");
  console.log(`Всего рейтинговых активов: ${ranked.length}`);
  console.log(`В Top-500: ${top500.length}`);
  console.log("");
  console.log("Top-20:");

  top500.slice(0, 20).forEach((item: { symbol: string; exchangeCount: number; totalVolume: number }, index: number) => {
    console.log(
      `${String(index + 1).padStart(3)}. ` +
      `${item.symbol.padEnd(10)} ` +
      `бирж: ${item.exchangeCount} ` +
      `объём: $${Math.round(item.totalVolume).toLocaleString("ru-RU")}`
    );
  });
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
