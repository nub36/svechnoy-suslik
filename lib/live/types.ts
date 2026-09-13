/**
 * LIVE market data types — DISPLAY ONLY, NOT for Signal Engine
 * Signal Engine uses ONLY canonical CLOSED PostgreSQL candles
 * This layer is for visualization: public exchange WebSocket trade + kline
 */

export type LiveTick = {
  exchange: string; // BINANCE, BYBIT, GATE, KUCOIN, BINGX
  symbol: string; // BTC
  exchangeSymbol: string; // BTCUSDT / BTC_USDT / BTC-USDT
  price: number;
  volume?: number;
  eventTime: number; // ms
  rawTime?: number; // exchange raw time ms if available
};

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
  eventTime?: number; // ms when received
};

export type LiveStatus = "CONNECTING" | "LIVE" | "RECONNECTING" | "STALE" | "CLOSED" | "ERROR" | "NO_MARKET";

export type LiveTickCallback = (tick: LiveTick) => void;
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
  // Gate: 10s,1m,5m,15m,30m,1h,4h,8h,1d,7d
  // Our TFs are subset that exists
  const map: Record<string, string> = {
    "5m": "5m",
    "15m": "15m",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
  };
  return map[tf] ?? tf;
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
  const map: Record<string, string> = {
    "5m": "5min",
    "15m": "15min",
    "1h": "1h",
    "4h": "4h",
    "1d": "1d",
  };
  return map[tf] ?? tf;
}

// Symbol format converters
export function toBinanceSymbol(sym: string): string {
  // BTC -> BTCUSDT, or if already contains USDT keep, remove separators
  const upper = sym.toUpperCase().replace(/[-_]/g, "");
  if (upper.endsWith("USDT")) return upper;
  return `${upper}USDT`;
}

export function toBybitSymbol(sym: string): string {
  return toBinanceSymbol(sym);
}

export function toGateSymbol(sym: string): string {
  // BTCUSDT -> BTC_USDT, BTC -> BTC_USDT
  const upper = sym.toUpperCase().replace(/[-]/g, "_");
  if (upper.includes("_")) return upper;
  // assume BTCUSDT -> BTC_USDT, strip USDT
  if (upper.endsWith("USDT")) {
    const base = upper.slice(0, -4);
    return `${base}_USDT`;
  }
  return `${upper}_USDT`;
}

export function toKucoinSymbol(sym: string): string {
  // BTCUSDT -> BTC-USDT, BTC -> BTC-USDT
  const upper = sym.toUpperCase().replace(/[_]/g, "-");
  if (upper.includes("-")) return upper;
  if (upper.endsWith("USDT")) {
    const base = upper.slice(0, -4);
    return `${base}-USDT`;
  }
  return `${upper}-USDT`;
}

export function toBingxSymbol(sym: string): string {
  return toKucoinSymbol(sym);
}
