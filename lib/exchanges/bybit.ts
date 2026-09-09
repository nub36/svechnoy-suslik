import {
  CandleData,
  ExchangeAdapter,
  ExchangeTicker,
  Timeframe
} from "./types";

const API = "https://api.bybit.com";

function bybitInterval(timeframe: Timeframe): string {
  const map: Record<Timeframe, string> = {
    "5m": "5",
    "15m": "15",
    "1h": "60",
    "4h": "240",
    "1d": "D"
  };

  return map[timeframe];
}

function timeframeMs(timeframe: Timeframe): number {
  const map: Record<Timeframe, number> = {
    "5m": 5 * 60 * 1000,
    "15m": 15 * 60 * 1000,
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "1d": 24 * 60 * 60 * 1000
  };

  return map[timeframe];
}

export const bybit: ExchangeAdapter = {
  name: "BYBIT",

  async getUsdtTickers(): Promise<ExchangeTicker[]> {
    const [symbolsRes, tickerRes] = await Promise.all([
      fetch(
        `${API}/v5/market/instruments-info?category=spot&limit=1000`,
        { cache: "no-store" }
      ),
      fetch(
        `${API}/v5/market/tickers?category=spot`,
        { cache: "no-store" }
      )
    ]);

    if (!symbolsRes.ok || !tickerRes.ok) {
      throw new Error("Bybit API недоступен");
    }

    const symbolsJson = await symbolsRes.json();
    const tickerJson = await tickerRes.json();

    if (symbolsJson.retCode !== 0) {
      throw new Error(
        `Bybit instruments: ${symbolsJson.retMsg}`
      );
    }

    if (tickerJson.retCode !== 0) {
      throw new Error(
        `Bybit tickers: ${tickerJson.retMsg}`
      );
    }

    const symbols = new Map<string, any>();

    for (const s of symbolsJson.result?.list ?? []) {
      if (
        s.quoteCoin === "USDT" &&
        s.status === "Trading"
      ) {
        symbols.set(s.symbol, s);
      }
    }

    const result: ExchangeTicker[] = [];

    for (const ticker of tickerJson.result?.list ?? []) {
      const meta = symbols.get(ticker.symbol);

      if (!meta) continue;

      result.push({
        exchange: "BYBIT",
        exchangeSymbol: ticker.symbol,
        base: meta.baseCoin,
        quote: meta.quoteCoin,
        price: Number(ticker.lastPrice) || 0,
        volume24h: Number(ticker.volume24h) || 0,
        quoteVolume24h:
          Number(ticker.turnover24h) || 0,
        change24h:
          (Number(ticker.price24hPcnt) || 0) * 100,
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
    const interval = bybitInterval(timeframe);

    const response = await fetch(
      `${API}/v5/market/kline` +
        `?category=spot` +
        `&symbol=${encodeURIComponent(symbol)}` +
        `&interval=${interval}` +
        `&limit=${Math.min(limit, 1000)}`,
      {
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(
        `Bybit candles HTTP ${response.status}`
      );
    }

    const json = await response.json();

    if (json.retCode !== 0) {
      throw new Error(
        `Bybit candles: ${json.retMsg}`
      );
    }

    const duration = timeframeMs(timeframe);
    const now = Date.now();

    const candles: CandleData[] =
      (json.result?.list ?? []).map(
        (row: string[]) => {
          const openTime =
            Number(row[0]);

          const closeTime =
            openTime + duration - 1;

          return {
            openTime: new Date(openTime),
            closeTime: new Date(closeTime),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
            closed: closeTime < now
          };
        }
      );

    /*
     * Bybit отдаёт свечи от новых к старым.
     * Наш движок всегда работает:
     *
     * старая -> новая
     */
    return candles.sort(
      (a, b) =>
        a.openTime.getTime() -
        b.openTime.getTime()
    );
  }
};