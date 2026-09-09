import { exchanges } from "../lib/exchanges";
import { analyzeCandles } from "../lib/analysis/analyze";
import { runTrendSuslik } from "../lib/strategies/trend-suslik";

const symbols: Record<string, string> = {
  BINANCE: "BTCUSDT",
  BYBIT: "BTCUSDT",
  GATE: "BTC_USDT",
  KUCOIN: "BTC-USDT",
  BINGX: "BTC-USDT"
};

async function main() {
  console.log("");
  console.log(
    "🐿️ Трендовый Суслик • BTC/USDT • 1H"
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

      const strategy =
        runTrendSuslik(analysis);

      results.push({
        exchange: exchange.name,
        direction: strategy.direction,
        score: strategy.score
      });

      console.log(
        `${exchange.name.padEnd(8)} ` +
        `${strategy.direction.padEnd(7)} ` +
        `сила=${String(strategy.score).padEnd(3)} ` +
        `LONG=${String(strategy.longScore).padEnd(3)} ` +
        `SHORT=${String(strategy.shortScore).padEnd(3)} ` +
        `RSI=${analysis.rsi14?.toFixed(2)} ` +
        `объём=${analysis.volumeRatio?.toFixed(2)}x`
      );

      for (const reason of strategy.reasons) {
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

  if (long >= 3) {
    console.log(
      "ИТОГ: LONG подтверждён биржами"
    );
  } else if (short >= 3) {
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

main().catch(console.error);
