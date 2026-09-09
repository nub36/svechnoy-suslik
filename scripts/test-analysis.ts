import {
  getBinanceCandles
} from "../lib/exchanges/binance-candles";

import {
  rsi,
  ema,
  macd,
  atr
} from "../lib/indicators";

async function main() {
  console.log(
    "🐿️ Получаем BTCUSDT 1H..."
  );

  const candles =
    await getBinanceCandles(
      "BTCUSDT",
      "1h",
      300
    );

  /*
   * Текущая свеча ещё может быть открыта.
   * Для торгового сигнала используем
   * только закрытые свечи.
   */
  const closed =
    candles.filter(c => c.closed);

  const closes =
    closed.map(c => c.close);

  const last =
    closed[closed.length - 1];

  const result = {
    candles: closed.length,
    candleTime:
      last.openTime.toISOString(),
    close: last.close,

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
  };

  console.dir(
    result,
    {
      depth: null
    }
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
