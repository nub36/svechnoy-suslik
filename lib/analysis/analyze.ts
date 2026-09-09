import type { CandleData } from "../exchanges/types";
import { atr, ema, macd, rsi, sma } from "../indicators";

export type MarketAnalysis = {
  candleTime: Date;
  price: number;

  rsi14: number | null;

  ema20: number | null;
  ema50: number | null;
  ema200: number | null;

  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;

  atr14: number | null;

  volume: number;
  avgVolume20: number | null;
  volumeRatio: number | null;
};

export function analyzeCandles(
  candles: CandleData[]
): MarketAnalysis | null {
  const closed = candles
    .filter((c) => c.closed)
    .sort(
      (a, b) =>
        a.openTime.getTime() -
        b.openTime.getTime()
    );

  if (closed.length < 200) {
    return null;
  }

  const last =
    closed[closed.length - 1];

  const closes =
    closed.map((c) => c.close);

  const volumes =
    closed.map((c) => c.volume);

  const macdResult =
    macd(closes);

  const avgVolume20 =
    sma(volumes, 20);

  const volumeRatio =
    avgVolume20 !== null &&
    avgVolume20 > 0
      ? last.volume / avgVolume20
      : null;

  return {
    candleTime: last.openTime,
    price: last.close,

    rsi14:
      rsi(closes, 14),

    ema20:
      ema(closes, 20),

    ema50:
      ema(closes, 50),

    ema200:
      ema(closes, 200),

    macd:
      macdResult?.macd ?? null,

    macdSignal:
      macdResult?.signal ?? null,

    macdHist:
      macdResult?.histogram ?? null,

    atr14:
      atr(closed, 14),

    volume:
      last.volume,

    avgVolume20,
    volumeRatio
  };
}
