/**
 * LiveMarketDataProvider factory — DISPLAY ONLY
 * Chooses provider based on exchange, with fallback to polling for complex exchanges
 * Priority for live: if Binance market exists, use Binance WS; else selected exchange WS; else polling
 */

import type { LiveCandle, LiveStatusCallback, LiveUpdateCallback } from "./types";
import { BinanceLiveProvider } from "./binance-ws";
import { BybitLiveProvider } from "./bybit-ws";
import { PollingLiveProvider } from "./generic-ws";

export type ProviderOptions = {
  symbol: string;
  exchange: string; // selected exchange
  exchangeSymbol: string; // e.g., BTCUSDT
  timeframe: string;
  availableExchanges?: string[]; // for fallback logic
  onCandle: LiveUpdateCallback;
  onStatus: LiveStatusCallback;
};

export type LiveProvider = {
  connect(): void;
  disconnect(): void;
  isConnected(): boolean;
  name: string;
};

export function createLiveProvider(opts: ProviderOptions): LiveProvider {
  const exchange = opts.exchange.toUpperCase();

  // Prefer native WS for BINANCE and BYBIT (implemented)
  // For GATE, KUCOIN, BINGX — use polling fallback that still uses /api/chart/live which itself fetches from exchange REST
  // This ensures coverage for all exchanges without complex WS auth

  if (exchange === "BINANCE") {
    return new BinanceLiveProvider({
      symbol: opts.symbol,
      exchangeSymbol: opts.exchangeSymbol,
      timeframe: opts.timeframe,
      onCandle: opts.onCandle,
      onStatus: opts.onStatus,
    }) as unknown as LiveProvider;
  }

  if (exchange === "BYBIT") {
    return new BybitLiveProvider({
      symbol: opts.symbol,
      exchangeSymbol: opts.exchangeSymbol,
      timeframe: opts.timeframe,
      onCandle: opts.onCandle,
      onStatus: opts.onStatus,
    }) as unknown as LiveProvider;
  }

  // Fallback: polling provider (still live-like every 3s, uses exchange REST via /api/chart/live)
  return new PollingLiveProvider({
    symbol: opts.symbol,
    exchange,
    exchangeSymbol: opts.exchangeSymbol,
    timeframe: opts.timeframe,
    onCandle: opts.onCandle,
    onStatus: opts.onStatus,
  }) as unknown as LiveProvider;
}

/**
 * Fallback policy for exchange selection
 * Given available markets for asset, and user preferred exchange, choose actual exchange
 */
export const EXCHANGE_PRIORITY = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"] as const;

export function selectExchangeWithFallback(
  availableExchanges: string[],
  preferred?: string
): string | null {
  if (availableExchanges.length === 0) return null;
  if (preferred && availableExchanges.includes(preferred.toUpperCase())) {
    return preferred.toUpperCase();
  }
  // Fallback by priority
  for (const pri of EXCHANGE_PRIORITY) {
    if (availableExchanges.includes(pri)) return pri;
  }
  // Otherwise first available
  return availableExchanges[0];
}
