/**
 * Zhivoj test strategii na svezhih svechah birzh.
 *
 * V otlichie ot test-strategy-runtime (kotoryj chitaet
 * IndicatorSnapshot iz BD), etot skript beret svechi
 * napryamuyu s 5 birzh i schitaet analiz na letu.
 *
 * Konfiguraciya VSEGDA iz PostgreSQL Strategy.config
 * (enabled + PUBLISHED), posle strogoj validacii.
 */

import { PrismaClient } from "@prisma/client";
import { exchanges } from "../lib/exchanges";
import { analyzeCandles } from "../lib/analysis/analyze";
import {
  validateStrategyRuntime
} from "../lib/strategies/config";
import { runTrendSuslik } from "../lib/strategies/trend-suslik";

const prisma = new PrismaClient();

const symbols: Record<string, string> = {
  BINANCE: "BTCUSDT",
  BYBIT: "BTCUSDT",
  GATE: "BTC_USDT",
  KUCOIN: "BTC-USDT",
  BINGX: "BTC-USDT"
};

async function main() {
  const strategy =
    await prisma.strategy.findFirst({
      where: {
        slug: "trend-suslik",
        enabled: true,
        status: "PUBLISHED"
      },
      orderBy: { version: "desc" }
    });

  if (!strategy) {
    throw new Error(
      "Strategiya trend-suslik (enabled+PUBLISHED) " +
        "ne najdena v PostgreSQL"
    );
  }

  const validation = validateStrategyRuntime({
    config: strategy.config,
    timeframes: strategy.timeframes,
    minExchanges: strategy.minExchanges
  });

  if (!validation.ok) {
    console.error(
      "❌ Strategy.config nevaliden:"
    );

    for (const e of validation.errors) {
      console.error(`   - ${e}`);
    }

    throw new Error(
      "validaciya Strategy.config ne proshla"
    );
  }

  const { config, minExchanges } = validation;

  console.log("");
  console.log(
    "🐿️ Трендовый Суслик • BTC/USDT • 1H"
  );
  console.log(
    `config: ${strategy.slug} v${strategy.version}, ` +
      `minScore=${config.minimumSignalScore}, ` +
      `minExchanges=${minExchanges}`
  );
  console.log("");

  const results: {
    exchange: string;
    direction: string;
    score: number;
  }[] = [];

  for (const exchange of exchanges) {
    try {
      const candles =
        await exchange.getCandles(
          symbols[exchange.name],
          "1h",
          300
        );

      const analysis =
        analyzeCandles(candles);

      if (!analysis) {
        throw new Error(
          "Недостаточно закрытых свечей"
        );
      }

      const strategyResult =
        runTrendSuslik(analysis, config);

      results.push({
        exchange: exchange.name,
        direction: strategyResult.direction,
        score: strategyResult.score
      });

      console.log(
        `${exchange.name.padEnd(8)} ` +
        `${strategyResult.direction.padEnd(7)} ` +
        `сила=${String(strategyResult.score).padEnd(3)} ` +
        `LONG=${String(strategyResult.longScore).padEnd(3)} ` +
        `SHORT=${String(strategyResult.shortScore).padEnd(3)} ` +
        `RSI=${analysis.rsi14?.toFixed(2)} ` +
        `объём=${analysis.volumeRatio?.toFixed(2)}x`
      );

      for (const reason of strategyResult.reasons) {
        const state =
          reason.long
            ? "LONG ✓"
            : reason.short
              ? "SHORT ✓"
              : "—";

        console.log(
          `    ${state.padEnd(8)} ` +
          `${reason.label} ` +
          `[${reason.weight}] ` +
          `${reason.value ?? ""}`
        );
      }

      for (const w of strategyResult.warnings) {
        console.log(`    ⚠ ${w}`);
      }

      console.log("");
    } catch (error) {
      console.error(
        `${exchange.name}:`,
        error
      );
    }
  }

  const long =
    results.filter(
      r => r.direction === "LONG"
    ).length;

  const short =
    results.filter(
      r => r.direction === "SHORT"
    ).length;

  const neutral =
    results.filter(
      r => r.direction === "NEUTRAL"
    ).length;

  console.log("----------------------------");

  console.log(
    `LONG ${long}/5 · ` +
    `SHORT ${short}/5 · ` +
    `NEUTRAL ${neutral}/5`
  );

  if (long >= minExchanges) {
    console.log(
      "ИТОГ: LONG подтверждён биржами"
    );
  } else if (short >= minExchanges) {
    console.log(
      "ИТОГ: SHORT подтверждён биржами"
    );
  } else {
    console.log(
      "ИТОГ: подтверждённого сигнала нет"
    );
  }

  console.log("----------------------------");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
