import { PrismaClient } from "@prisma/client";
import { exchanges } from "../lib/exchanges";

const prisma = new PrismaClient();

const STABLE_BASES = new Set([
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

function isAllowedBase(base: string) {
  if (STABLE_BASES.has(base)) {
    return false;
  }

  if (base.includes("(") || base.includes(")")) {
    return false;
  }

  return /^[A-Z0-9]{2,20}$/.test(base);
}

async function main() {
  console.log("🐿️ Суслик пошёл по биржам...\n");

  let totalMarkets = 0;

  for (const exchange of exchanges) {
    console.log(`→ ${exchange.name}`);

    try {
      const tickers =
        await exchange.getUsdtTickers();

      const filtered = tickers
        .filter(
          ticker =>
            ticker.active &&
            ticker.price > 0 &&
            ticker.quoteVolume24h > 0 &&
            isAllowedBase(ticker.base)
        )
        .sort(
          (a, b) =>
            b.quoteVolume24h -
            a.quoteVolume24h
        )
        .slice(0, 500);

      console.log(
        `  Получено подходящих рынков: ${filtered.length}`
      );

      for (const ticker of filtered) {
        const asset = await prisma.asset.upsert({
          where: {
            symbol: ticker.base
          },

          update: {
            enabled: true
          },

          create: {
            symbol: ticker.base,
            enabled: true
          }
        });

        await prisma.market.upsert({
          where: {
            exchange_exchangeSymbol_marketType: {
              exchange: ticker.exchange,
              exchangeSymbol:
                ticker.exchangeSymbol,
              marketType: "SPOT"
            }
          },

          update: {
            base: ticker.base,
            quote: ticker.quote,
            price: ticker.price,
            volume24h: ticker.volume24h,
            quoteVolume24h:
              ticker.quoteVolume24h,
            change24h: ticker.change24h,
            enabled: true,
            status: "ACTIVE",
            lastSyncAt: new Date()
          },

          create: {
            exchange: ticker.exchange,
            exchangeSymbol:
              ticker.exchangeSymbol,
            marketType: "SPOT",
            base: ticker.base,
            quote: ticker.quote,
            price: ticker.price,
            volume24h: ticker.volume24h,
            quoteVolume24h:
              ticker.quoteVolume24h,
            change24h: ticker.change24h,
            enabled: true,
            status: "ACTIVE",
            lastSyncAt: new Date(),
            assetId: asset.id
          }
        });
      }

      totalMarkets += filtered.length;

      console.log("  ✓ Готово\n");
    } catch (error) {
      console.error(
        `  ✗ Ошибка ${exchange.name}:`,
        error
      );
    }
  }

  const assets = await prisma.asset.count();

  const markets = await prisma.market.count();

  console.log("----------------------------");
  console.log(`Активов: ${assets}`);
  console.log(`Рынков в БД: ${markets}`);
  console.log(`Обработано сейчас: ${totalMarkets}`);
  console.log("----------------------------");
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
