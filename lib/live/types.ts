/**
 * LIVE market data types — DISPLAY ONLY, NOT for Signal Engine
 * Signal Engine uses ONLY canonical CLOSED PostgreSQL candles
 * This layer is for visualization: public exchange WebSocket kline
 */

export type LiveCandle = {
  symbol: string; // e.g., BTC
  exchange: string; // BINANCE, BYBIT, etc.
  exchangeSymbol: string; // BTCUSDT
  timeframe: string; // 5m,15m,1h,4h,1d
  openTime: number; // ms
  closeTime?: number; // ms
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean; // true if candle closed
  time: number; // sec (openTime/1000) for chart
};

export type LiveStatus = "CONNECTING" | "LIVE" | "RECONNECTING" | "STALE" | "CLOSED" | "ERROR";

export type LiveUpdateCallback = (candle: LiveCandle) => void;
export type LiveStatusCallback = (status: LiveStatus, info?: string) => void;

export interface LiveMarketDataProvider {
  name: string;
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
}

export const EXCHANGE_PRIORITY = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"] as const;

export function timeframeToBinanceInterval(tf: string): string {
  // Binance uses same format: 5m,15m,1h,4h,1d
  return tf;
}

export function timeframeToBybitInterval(tf: string): string {
  const map: Record<string, string> = {
    "5m": "5",
    "15m": "15",
    "1h": "60",
    "4h": "240",
    "1d": "D",
  };
  return map[tf] ?? tf;
}

export function timeframeToGateInterval(tf: string): string {
  // Gate uses same: 5m,15m,1h,4h,1d
  return tf;
}

export function timeframeToKucoinInterval(tf: string): string {
  const map: Record<string, string> = {
    "5m": "5min",
    "15m": "15min",
    "1h": "1hour",
    "4h": "4hour",
    "1d": "1day",
  };
  return map[tf] ?? tf;
}

export function timeframeToBingxInterval(tf: string): string {
  return tf;
}
