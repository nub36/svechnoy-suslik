export type ExchangeName =
  | "BINANCE"
  | "BYBIT"
  | "GATE"
  | "KUCOIN"
  | "BINGX";

export type Timeframe =
  | "5m"
  | "15m"
  | "1h"
  | "4h"
  | "1d";

export type ExchangeTicker = {
  exchange: ExchangeName;
  exchangeSymbol: string;
  base: string;
  quote: string;
  price: number;
  volume24h: number;
  quoteVolume24h: number;
  change24h: number;
  active: boolean;
};

export type CandleData = {
  openTime: Date;
  closeTime?: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
};

export interface ExchangeAdapter {
  name: ExchangeName;

  getUsdtTickers(): Promise<ExchangeTicker[]>;

  getCandles(
    symbol: string,
    timeframe: Timeframe,
    limit?: number
  ): Promise<CandleData[]>;
}
