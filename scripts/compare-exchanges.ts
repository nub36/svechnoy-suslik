import {
  exchanges
} from "../lib/exchanges";

import {
  rsi,
  ema,
  macd,
  atr
} from "../lib/indicators";

const symbols: Record<string, string> = {
  BINANCE: "BTCUSDT",
  BYBIT: "BTCUSDT",
  GATE: "BTC_USDT",
  KUCOIN: "BTC-USDT",
  BINGX: "BTC-USDT"
};

async function main() {
  console.log(
    "\n🐿️ BTC/USDT • 1H • сравнение бирж\n"
  );

  for (const exchange of exchanges) {
    try {
      const candles =
        await exchange.getCandles(
          symbols[exchange.name],
          "1h",
          300
        );

      const closed =
        candles.filter(
          candle => candle.closed
        );

      const closes =
        closed.map(
          candle => candle.close
        );

      const last =
        closed[closed.length - 1];

      if (!last) {
        throw new Error(
          "Нет закрытых свечей"
        );
      }

      const macdResult =
        macd(closes);

      console.log(
        `${exchange.name.padEnd(8)} ` +
        `свечей=${String(closed.length).padEnd(4)} ` +
        `время=${last.openTime.toISOString()} ` +
        `close=${last.close.toFixed(2)} ` +
        `RSI=${(rsi(closes, 14) ?? 0).toFixed(2)} ` +
        `EMA200=${(ema(closes, 200) ?? 0).toFixed(2)} ` +
        `MACDh=${(macdResult?.histogram ?? 0).toFixed(2)} ` +
        `ATR=${(atr(closed, 14) ?? 0).toFixed(2)}`
      );
    } catch (error) {
      console.error(
        `${exchange.name.padEnd(8)} ОШИБКА:`,
        error
      );
    }
  }

  console.log("");
}

main();
