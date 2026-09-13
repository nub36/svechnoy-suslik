/**
 * Generic fallback provider for exchanges without easy public WS kline
 * Uses polling of /api/chart/live every 3s as fallback — still DISPLAY ONLY
 * This ensures coverage for GATE, KUCOIN, BINGX where WS is more complex
 * But we still have interface same as WS providers
 */

import type { LiveCandle, LiveStatusCallback, LiveUpdateCallback } from "./types";

export class PollingLiveProvider {
  private timer: NodeJS.Timeout | null = null;
  private abort: AbortController | null = null;
  private shouldRun = true;
  private lastUpdate = 0;

  constructor(
    private opts: {
      symbol: string;
      exchange: string;
      exchangeSymbol: string;
      timeframe: string;
      onCandle: LiveUpdateCallback;
      onStatus: LiveStatusCallback;
    }
  ) {}

  connect() {
    this.shouldRun = true;
    this.opts.onStatus("CONNECTING", `${this.opts.exchange} polling`);
    this.startPolling();
  }

  private startPolling() {
    this.stopPolling();
    const poll = async () => {
      if (!this.shouldRun) return;
      this.abort?.abort();
      this.abort = new AbortController();
      try {
        const res = await fetch(
          `/api/chart/live?symbol=${encodeURIComponent(this.opts.symbol)}&exchange=${encodeURIComponent(this.opts.exchange)}&timeframe=${encodeURIComponent(this.opts.timeframe)}`,
          { signal: this.abort.signal, cache: "no-store" }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const raw = data.liveFromExchange || data.currentDb || data.latestAnyDb;
        if (!raw) {
          this.opts.onStatus("STALE", "no candle");
          return;
        }
        const candle: LiveCandle = {
          symbol: this.opts.symbol,
          exchange: this.opts.exchange,
          exchangeSymbol: this.opts.exchangeSymbol,
          timeframe: this.opts.timeframe,
          openTime: new Date(raw.openTime).getTime(),
          closeTime: raw.closeTime ? new Date(raw.closeTime).getTime() : undefined,
          open: raw.open,
          high: raw.high,
          low: raw.low,
          close: raw.close,
          volume: raw.volume,
          closed: raw.closed,
          time: raw.time,
        };
        this.lastUpdate = Date.now();
        this.opts.onStatus("LIVE", `${this.opts.exchange} polling live`);
        this.opts.onCandle(candle);
      } catch (e: any) {
        if (e.name === "AbortError") return;
        if (Date.now() - this.lastUpdate > 30000) {
          this.opts.onStatus("STALE", e.message);
        } else {
          this.opts.onStatus("RECONNECTING", e.message);
        }
      }
    };

    // Immediate poll
    void poll();
    // Every 3s
    this.timer = setInterval(poll, 3000);
  }

  private stopPolling() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.abort?.abort();
    this.abort = null;
  }

  disconnect() {
    this.shouldRun = false;
    this.stopPolling();
    this.opts.onStatus("CLOSED");
  }

  isConnected(): boolean {
    return this.shouldRun && this.timer !== null;
  }
}
