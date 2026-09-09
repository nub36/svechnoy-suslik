import {
  CandleData,
  ExchangeAdapter,
  ExchangeTicker,
  Timeframe
} from "./types";

const API = "https://api.kucoin.com";

function kucoinInterval(
  timeframe: Timeframe
): string {
  const map: Record<Timeframe, string> = {
    "5m": "5min",
    "15m": "15min",
    "1h": "1hour",
    "4h": "4hour",
    "1d": "1day"
  };

  return map[timeframe];
}

function timeframeSeconds(
  timeframe: Timeframe
): number {
  const map: Record<Timeframe, number> = {
    "5m": 300,
    "15m": 900,
    "1h": 3600,
    "4h": 14400,
    "1d": 86400
  };

  return map[timeframe];
}

export const kucoin: ExchangeAdapter = {
  name: "KUCOIN",

  async getUsdtTickers(): Promise<ExchangeTicker[]> {
    const [symbolsRes, tickerRes] =
      await Promise.all([
        fetch(`${API}/api/v2/symbols`, {
          cache: "no-store"
        }),
        fetch(
          `${API}/api/v1/market/allTickers`,
          { cache: "no-store" }
        )
      ]);

    if (!symbolsRes.ok || !tickerRes.ok) {
      throw new Error("KuCoin API недоступен");
    }

    const symbolsJson =
      await symbolsRes.json();

    const tickerJson =
      await tickerRes.json();

    const symbols = new Map<string, any>();

    for (
      const s of symbolsJson.data ?? []
    ) {
      if (
        s.quoteCurrency === "USDT" &&
        s.enableTrading
      ) {
        symbols.set(s.symbol, s);
      }
    }

    const result: ExchangeTicker[] = [];

    for (
      const ticker of
      tickerJson.data?.ticker ?? []
    ) {
      const meta =
        symbols.get(ticker.symbol);

      if (!meta) continue;

      const price =
        Number(ticker.last) || 0;

      const baseVolume =
        Number(ticker.vol) || 0;

      result.push({
        exchange: "KUCOIN",
        exchangeSymbol: ticker.symbol,
        base: meta.baseCurrency,
        quote: meta.quoteCurrency,
        price,
        volume24h: baseVolume,
        quoteVolume24h:
          Number(ticker.volValue) ||
          price * baseVolume,
        change24h:
          (Number(ticker.changeRate) || 0) *
          100,
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
    const interval =
      kucoinInterval(timeframe);

    const seconds =
      timeframeSeconds(timeframe);

    /*
     * KuCoin endpoint использует диапазон времени.
     * Добавляем небольшой запас.
     */
    const endAt =
      Math.floor(Date.now() / 1000);

    const startAt =
      endAt -
      seconds * Math.min(limit + 5, 1500);

    const response = await fetch(
      `${API}/api/v1/market/candles` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&type=${interval}` +
      `&startAt=${startAt}` +
      `&endAt=${endAt}`,
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(
        `KuCoin candles HTTP ${response.status}`
      );
    }

    const json = await response.json();

    if (json.code !== "200000") {
      throw new Error(
        `KuCoin candles: ${json.code}`
      );
    }

    const now = Date.now();

    const candles: CandleData[] =
      (json.data ?? [])
        .slice(0, limit)
        .map((row: string[]) => {
          /*
           * KuCoin:
           * time, open, close,
           * high, low, volume, turnover
           */
          const openTime =
            Number(row[0]) * 1000;

          const closeTime =
            openTime + seconds * 1000 - 1;

          return {
            openTime:
              new Date(openTime),
            closeTime:
              new Date(closeTime),
            open: Number(row[1]),
            close: Number(row[2]),
            high: Number(row[3]),
            low: Number(row[4]),
            volume: Number(row[5]),
            closed: closeTime < now
          };
        });

    return candles.sort(
      (a, b) =>
        a.openTime.getTime() -
        b.openTime.getTime()
    );
  }
};