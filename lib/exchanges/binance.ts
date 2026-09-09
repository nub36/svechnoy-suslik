import {
  CandleData,
  ExchangeAdapter,
  ExchangeTicker,
  Timeframe
} from "./types";

const API = "https://api.binance.com";

export const binance: ExchangeAdapter = {
  name: "BINANCE",

  async getUsdtTickers(): Promise<ExchangeTicker[]> {
    const [exchangeInfoRes, tickerRes] =
      await Promise.all([
        fetch(`${API}/api/v3/exchangeInfo`, {
          cache: "no-store"
        }),
        fetch(`${API}/api/v3/ticker/24hr`, {
          cache: "no-store"
        })
      ]);

    if (!exchangeInfoRes.ok || !tickerRes.ok) {
      throw new Error("Binance API недоступен");
    }

    const info = await exchangeInfoRes.json();
    const tickers = await tickerRes.json();

    const symbols = new Map<string, any>();

    for (const s of info.symbols ?? []) {
      if (
        s.quoteAsset === "USDT" &&
        s.status === "TRADING" &&
        s.isSpotTradingAllowed !== false
      ) {
        symbols.set(s.symbol, s);
      }
    }

    const result: ExchangeTicker[] = [];

    for (const ticker of tickers) {
      const meta = symbols.get(ticker.symbol);
      if (!meta) continue;

      result.push({
        exchange: "BINANCE",
        exchangeSymbol: ticker.symbol,
        base: meta.baseAsset,
        quote: meta.quoteAsset,
        price: Number(ticker.lastPrice) || 0,
        volume24h: Number(ticker.volume) || 0,
        quoteVolume24h: Number(ticker.quoteVolume) || 0,
        change24h:
          Number(ticker.priceChangePercent) || 0,
        active: true
      });
    }

    return result;
  },

  async getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit = 300
  ): Promise<CandleData[]> {
    const response = await fetch(
      `${API}/api/v3/klines` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${timeframe}` +
      `&limit=${Math.min(limit, 1000)}`,
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(
        `Binance candles HTTP ${response.status}`
      );
    }

    const rows = await response.json();
    const now = Date.now();

    return rows
      .map((row: any[]) => ({
        openTime: new Date(Number(row[0])),
        closeTime: new Date(Number(row[6])),
        open: Number(row[1]),
        high: Number(row[2]),
        low: Number(row[3]),
        close: Number(row[4]),
        volume: Number(row[5]),
        closed: Number(row[6]) < now
      }))
      .sort(
        (a: CandleData, b: CandleData) =>
          a.openTime.getTime() -
          b.openTime.getTime()
      );
  }
};
