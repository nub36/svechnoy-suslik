import {
  CandleData,
  ExchangeAdapter,
  ExchangeTicker,
  Timeframe
} from "./types";

const API = "https://api.gateio.ws/api/v4";

function gateInterval(timeframe: Timeframe): string {
  const map: Record<Timeframe, string> = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d"
  };

  return map[timeframe];
}

function timeframeMs(timeframe: Timeframe): number {
  const map: Record<Timeframe, number> = {
    "5m": 300000,
    "15m": 900000,
    "1h": 3600000,
    "4h": 14400000,
    "1d": 86400000
  };

  return map[timeframe];
}

export const gate: ExchangeAdapter = {
  name: "GATE",

  async getUsdtTickers(): Promise<ExchangeTicker[]> {
    const [pairsRes, tickerRes] = await Promise.all([
      fetch(`${API}/spot/currency_pairs`, {
        cache: "no-store"
      }),
      fetch(`${API}/spot/tickers`, {
        cache: "no-store"
      })
    ]);

    if (!pairsRes.ok || !tickerRes.ok) {
      throw new Error("Gate API недоступен");
    }

    const pairs = await pairsRes.json();
    const tickers = await tickerRes.json();

    const symbols = new Map<string, any>();

    for (const pair of pairs) {
      if (
        pair.quote === "USDT" &&
        pair.trade_status === "tradable"
      ) {
        symbols.set(pair.id, pair);
      }
    }

    const result: ExchangeTicker[] = [];

    for (const ticker of tickers) {
      const meta =
        symbols.get(ticker.currency_pair);

      if (!meta) continue;

      result.push({
        exchange: "GATE",
        exchangeSymbol:
          ticker.currency_pair,
        base: meta.base,
        quote: meta.quote,
        price: Number(ticker.last) || 0,
        volume24h:
          Number(ticker.base_volume) || 0,
        quoteVolume24h:
          Number(ticker.quote_volume) || 0,
        change24h:
          Number(ticker.change_percentage) || 0,
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
      `${API}/spot/candlesticks` +
      `?currency_pair=${encodeURIComponent(symbol)}` +
      `&interval=${gateInterval(timeframe)}` +
      `&limit=${Math.min(limit, 1000)}`,
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(
        `Gate candles HTTP ${response.status}`
      );
    }

    const rows = await response.json();

    const now = Date.now();
    const duration = timeframeMs(timeframe);

    const result: CandleData[] =
      rows.map((row: any[]) => {
        /*
         * Gate:
         * 0 timestamp
         * 1 quote volume
         * 2 close
         * 3 high
         * 4 low
         * 5 open
         * 6 base volume
         */
        const openTime =
          Number(row[0]) * 1000;

        const closeTime =
          openTime + duration - 1;

        return {
          openTime: new Date(openTime),
          closeTime: new Date(closeTime),
          open: Number(row[5]),
          high: Number(row[3]),
          low: Number(row[4]),
          close: Number(row[2]),
          volume: Number(row[6]),
          closed: closeTime < now
        };
      });

    return result.sort(
      (a, b) =>
        a.openTime.getTime() -
        b.openTime.getTime()
    );
  }
};