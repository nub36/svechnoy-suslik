import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

/**
 * Strukturnye tipy dlya yavnoj annotacii callbackov:
 * s realnym (sgenerirovannym) klientom Prisma oni sovmestimy,
 * a v pesochnice bez prisma generate zamenyayut implicit any.
 */
type RankedMarket = {
  quoteVolume24h: number | null;
};

type RankedAsset = {
  id: number;
  symbol: string;
  markets: RankedMarket[];
};

type RankedItem = {
  id: number;
  symbol: string;
  exchangeCount: number;
  totalVolume: number;
  maxVolume: number;
  liquidityScore: number;
};


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
      (asset: RankedAsset) =>
        !EXCLUDED.has(asset.symbol) &&
        asset.markets.length > 0
    )
    .map((asset: RankedAsset): RankedItem => {
      const volumes = asset.markets
        .map((m: RankedMarket) => m.quoteVolume24h ?? 0)
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
      (a: RankedItem, b: RankedItem) =>
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
        top500: i < 500,
        exchangeCount: item.exchangeCount,
        totalVolume24h: item.totalVolume,
        maxVolume24h: item.maxVolume,
        liquidityScore: item.liquidityScore
      }
    });
  }

  const top500 = ranked.slice(0, 500);

  console.log("");
  console.log(`Всего рейтинговых активов: ${ranked.length}`);
  console.log(`В Top-500: ${top500.length}`);
  console.log("");
  console.log("Top-20:");

  top500.slice(0, 20).forEach((item: RankedItem, index: number) => {
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
