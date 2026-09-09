import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const config = {
  minimumSignalScore: 70,

  weights: {
    trend: 30,
    mediumTrend: 15,
    rsi: 20,
    macd: 20,
    volume: 15
  },

  ema: {
    fast: 20,
    medium: 50,
    slow: 200
  },

  rsi: {
    period: 14,
    longMin: 52,
    longMax: 72,
    shortMin: 28,
    shortMax: 48
  },

  macd: {
    fast: 12,
    slow: 26,
    signal: 9
  },

  atr: {
    period: 14,
    stopMultiplier: 1.5,
    takeProfit1Multiplier: 1.5,
    takeProfit2Multiplier: 2.5,
    takeProfit3Multiplier: 4
  },

  volume: {
    period: 20,
    minimumRatio: 1
  },

  execution: {
    closedCandleOnly: true,
    cooldownCandles: 3
  },

  filters: {
    minimumQuoteVolume24h: 1000000,
    top500Only: true
  }
};

async function main() {
  const existing =
    await prisma.strategy.findFirst({
      where: {
        slug: "trend-suslik",
        version: 1
      }
    });

  if (existing) {
    await prisma.strategy.update({
      where: {
        id: existing.id
      },

      data: {
        name: "Трендовый Суслик",
        description:
          "Трендовая стратегия на основе EMA, RSI, MACD, объёма и ATR.",
        enabled: true,
        status: "PUBLISHED",
        config,
        timeframes: [
          "15m",
          "1h",
          "4h",
          "1d"
        ],
        minExchanges: 3
      }
    });

    console.log(
      "✓ Трендовый Суслик v1 обновлён"
    );

    return;
  }

  await prisma.strategy.create({
    data: {
      name: "Трендовый Суслик",
      slug: "trend-suslik",

      description:
        "Трендовая стратегия на основе EMA, RSI, MACD, объёма и ATR.",

      version: 1,
      enabled: true,
      status: "PUBLISHED",

      config,

      timeframes: [
        "15m",
        "1h",
        "4h",
        "1d"
      ],

      minExchanges: 3
    }
  });

  console.log(
    "✓ Трендовый Суслик v1 создан"
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
