/**
 * LiveMarketDataProvider factory — DISPLAY ONLY, all 5 exchanges native WS
 * Provides both trade (tick) for LIVE PRICE and kline for forming candle
 * 1 subscription per open chart only
 */

import type { LiveCandle, LiveStatusCallback, LiveUpdateCallback, LiveTickCallback } from "./types";
import { BinanceLiveProvider } from "./binance-ws";
import { BybitLiveProvider } from "./bybit-ws";
import { GateLiveProvider } from "./gate-ws";
import { KucoinLiveProvider } from "./kucoin-ws";
import { BingxLiveProvider } from "./bingx-ws";
import { PollingLiveProvider } from "./generic-ws";
import { toBinanceSymbol, toBybitSymbol, toGateSymbol, toKucoinSymbol, toBingxSymbol } from "./types";

export type ProviderOptions = {
  symbol: string;
  exchange: string;
  exchangeSymbol: string;
  timeframe: string;
  availableExchanges?: string[];
  onTick?: LiveTickCallback;
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

  const common = {
    symbol: opts.symbol,
    exchangeSymbol: opts.exchangeSymbol,
    timeframe: opts.timeframe,
    onTick: opts.onTick,
    onCandle: opts.onCandle,
    onStatus: opts.onStatus,
  };

  switch (exchange) {
    case "BINANCE":
      return new BinanceLiveProvider({
        ...common,
        exchangeSymbol: toBinanceSymbol(opts.exchangeSymbol),
      }) as unknown as LiveProvider;
    case "BYBIT":
      return new BybitLiveProvider({
        ...common,
        exchangeSymbol: toBybitSymbol(opts.exchangeSymbol),
      }) as unknown as LiveProvider;
    case "GATE":
      return new GateLiveProvider({
        ...common,
        exchangeSymbol: toGateSymbol(opts.exchangeSymbol),
      }) as unknown as LiveProvider;
    case "KUCOIN":
      return new KucoinLiveProvider({
        ...common,
        exchangeSymbol: toKucoinSymbol(opts.exchangeSymbol),
      }) as unknown as LiveProvider;
    case "BINGX":
      return new BingxLiveProvider({
        ...common,
        exchangeSymbol: toBingxSymbol(opts.exchangeSymbol),
      }) as unknown as LiveProvider;
    default:
      // Ultimate fallback polling (should rarely be used, only if exchange unknown)
      return new PollingLiveProvider({
        symbol: opts.symbol,
        exchange,
        exchangeSymbol: opts.exchangeSymbol,
        timeframe: opts.timeframe,
        onTick: opts.onTick,
        onCandle: opts.onCandle,
        onStatus: opts.onStatus,
      }) as unknown as LiveProvider;
  }
}

export const EXCHANGE_PRIORITY = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"] as const;

export function selectExchangeWithFallback(
  availableExchanges: string[],
  preferred?: string
): { actual: string | null; requested: string | null; isFallback: boolean } {
  if (availableExchanges.length === 0) return { actual: null, requested: preferred?.toUpperCase() || null, isFallback: false };
  const req = preferred?.toUpperCase() || null;
  if (req && availableExchanges.includes(req)) {
    return { actual: req, requested: req, isFallback: false };
  }
  // Fallback by priority
  for (const pri of EXCHANGE_PRIORITY) {
    if (availableExchanges.includes(pri)) {
      return { actual: pri, requested: req, isFallback: req !== null && req !== pri };
    }
  }
  return { actual: availableExchanges[0], requested: req, isFallback: req !== null && req !== availableExchanges[0] };
}
