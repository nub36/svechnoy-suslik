import { bybit } from "../lib/exchanges/bybit";

import {
  rsi,
  ema,
  macd,
  atr
} from "../lib/indicators";

async function main() {
  console.log(
    "🐿️ Получаем BTCUSDT 1H с Bybit..."
  );

  const candles =
    await bybit.getCandles(
      "BTCUSDT",
      "1h",
      300
    );

  const closed =
    candles.filter(c => c.closed);

  const closes =
    closed.map(c => c.close);

  const last =
    closed[closed.length - 1];

  console.log({
    candles: closed.length,
    candleTime:
      last.openTime.toISOString(),

    close:
      last.close,

    RSI14:
      rsi(closes, 14),

    EMA20:
      ema(closes, 20),

    EMA50:
      ema(closes, 50),

    EMA200:
      ema(closes, 200),

    MACD:
      macd(closes),

    ATR14:
      atr(closed, 14)
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
