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
  console.log("🐿️ Суслик строит глобальный рейтинг...");

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
      asset =>
        !EXCLUDED.has(asset.symbol) &&
        asset.markets.length > 0
    )
    .map(asset => {
      const volumes = asset.markets
        .map(m => m.quoteVolume24h ?? 0)
        .filter(v => v > 0)
        .sort((a, b) => b - a);

      const totalVolume =
        volumes.reduce((sum, v) => sum + v, 0);

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
      (a, b) =>
        b.liquidityScore - a.liquidityScore
    );

  await prisma.asset.updateMany({
    data: {
      top500: false,
      rank: null
    }
  });

  for (let i = 0; i < ranked.length; i++) {
    const item = ranked[i];

    await prisma.asset.update({
      where: {
        id: item.id
      },

      data: {
        rank: i + 1,
        // Legacy-флаг для первых 500 мест:
        // сохраняется ради совместимости старых
        // данных. Основной universe — rank <= 100
        // (lib/universe.ts), НЕ этот флаг.
        top500: i < 500,
        exchangeCount: item.exchangeCount,
        totalVolume24h: item.totalVolume,
        maxVolume24h: item.maxVolume,
        liquidityScore: item.liquidityScore
      }
    });
  }

  // Историческая сводка Top-500 (legacy, только
  // информирование); вывод ниже НЕ описание universe.
  const top500 = ranked.slice(0, 500);

  console.log("");
  console.log(`Всего рейтинговых активов: ${ranked.length}`);
  console.log(`В Top-500: ${top500.length}`);
  console.log("");
  console.log("Top-20:");

  top500.slice(0, 20).forEach((item, index) => {
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
