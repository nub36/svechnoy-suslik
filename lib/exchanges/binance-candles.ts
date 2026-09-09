import {
  CandleData,
  Timeframe
} from "./candles";

const API = "https://api.binance.com";

export async function getBinanceCandles(
  symbol: string,
  timeframe: Timeframe,
  limit = 300
): Promise<CandleData[]> {
  const url =
    `${API}/api/v3/klines` +
    `?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${timeframe}` +
    `&limit=${Math.min(limit, 1000)}`;

  const response = await fetch(url, {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error(
      `Binance candles: HTTP ${response.status}`
    );
  }

  const rows = await response.json();

  const now = Date.now();

  return rows.map((row: any[]) => ({
    openTime: new Date(Number(row[0])),
    closeTime: new Date(Number(row[6])),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closed: Number(row[6]) < now
  }));
}
