import {
  CandleData,
  ExchangeAdapter,
  ExchangeTicker,
  Timeframe
} from "./types";

const API =
  "https://open-api.bingx.com";

function bingxInterval(
  timeframe: Timeframe
): string {
  const map: Record<Timeframe, string> = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d"
  };

  return map[timeframe];
}

function timeframeMs(
  timeframe: Timeframe
): number {
  const map: Record<Timeframe, number> = {
    "5m": 300000,
    "15m": 900000,
    "1h": 3600000,
    "4h": 14400000,
    "1d": 86400000
  };

  return map[timeframe];
}

export const bingx: ExchangeAdapter = {
  name: "BINGX",

  async getUsdtTickers(): Promise<ExchangeTicker[]> {
    const [symbolsRes, tickerRes] =
      await Promise.all([
        fetch(
          `${API}/openApi/spot/v1/common/symbols`,
          { cache: "no-store" }
        ),
        fetch(
          `${API}/openApi/spot/v1/ticker/24hr`,
          { cache: "no-store" }
        )
      ]);

    if (!symbolsRes.ok || !tickerRes.ok) {
      throw new Error("BingX API недоступен");
    }

    const symbolsJson =
      await symbolsRes.json();

    const tickerJson =
      await tickerRes.json();

    const symbols =
      new Map<string, any>();

    for (
      const s of
      symbolsJson.data?.symbols ?? []
    ) {
      if (
        typeof s.symbol === "string" &&
        s.symbol.endsWith("-USDT") &&
        Number(s.status) === 1 &&
        s.apiStateBuy !== false &&
        s.apiStateSell !== false
      ) {
        symbols.set(s.symbol, s);
      }
    }

    const tickerList =
      Array.isArray(tickerJson.data)
        ? tickerJson.data
        : tickerJson.data?.tickers ?? [];

    const result: ExchangeTicker[] = [];

    for (const ticker of tickerList) {
      const symbol =
        ticker.symbol ??
        ticker.tradingPair;

      const meta =
        symbols.get(symbol);

      if (!meta || !symbol) {
        continue;
      }

      const base =
        symbol.endsWith("-USDT")
          ? symbol.slice(0, -5)
          : symbol;

      const price =
        Number(ticker.lastPrice) ||
        Number(ticker.last) ||
        0;

      const baseVolume =
        Number(ticker.volume) ||
        Number(ticker.volume24h) ||
        0;

      /*
       * У BingX названия полей могут
       * различаться между версиями API.
       */
      const openPrice =
        Number(ticker.openPrice) || 0;

      let change24h =
        Number(
          ticker.priceChangePercent
        );

      if (
        !Number.isFinite(change24h) ||
        change24h === 0
      ) {
        if (
          openPrice > 0 &&
          price > 0
        ) {
          change24h =
            ((price - openPrice) /
              openPrice) *
            100;
        } else {
          change24h = 0;
        }
      }

      result.push({
        exchange: "BINGX",
        exchangeSymbol: symbol,
        base,
        quote: "USDT",
        price,
        volume24h: baseVolume,
        quoteVolume24h:
          Number(ticker.quoteVolume) ||
          Number(
            ticker.quoteVolume24h
          ) ||
          price * baseVolume,
        change24h,
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
      `${API}/openApi/spot/v2/market/kline` +
      `?symbol=${encodeURIComponent(symbol)}` +
      `&interval=${bingxInterval(timeframe)}` +
      `&limit=${Math.min(limit, 1000)}`,
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(
        `BingX candles HTTP ${response.status}`
      );
    }

    const json =
      await response.json();

    if (Number(json.code) !== 0) {
      throw new Error(
        `BingX candles: ${json.msg}`
      );
    }

    const rows =
      Array.isArray(json.data)
        ? json.data
        : json.data?.data ?? [];

    const duration =
      timeframeMs(timeframe);

    const now = Date.now();

    const candles: CandleData[] =
      rows.map((row: any) => {
        /*
         * Поддержим как массив,
         * так и объектный ответ.
         */
        if (Array.isArray(row)) {
          const openTime =
            Number(row[0]);

          const closeTime =
            openTime + duration - 1;

          return {
            openTime:
              new Date(openTime),
            closeTime:
              new Date(closeTime),
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
            closed: closeTime < now
          };
        }

        const openTime =
          Number(
            row.time ??
            row.openTime ??
            row.timestamp
          );

        const closeTime =
          openTime + duration - 1;

        return {
          openTime:
            new Date(openTime),
          closeTime:
            new Date(closeTime),
          open:
            Number(row.open),
          high:
            Number(row.high),
          low:
            Number(row.low),
          close:
            Number(row.close),
          volume:
            Number(row.volume),
          closed:
            closeTime < now
        };
      });

    return candles
      .filter(
        candle =>
          Number.isFinite(candle.close) &&
          candle.openTime.getTime() > 0
      )
      .sort(
        (a, b) =>
          a.openTime.getTime() -
          b.openTime.getTime()
      );
  }
};