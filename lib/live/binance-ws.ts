/**
 * Binance public kline WebSocket provider — client-side only
 * DISPLAY ONLY, NOT for Signal Engine
 * Endpoint: wss://stream.binance.com:9443/ws/{symbol}@kline_{interval}
 * Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams#kline-candlestick-streams
 */

import type { LiveCandle, LiveStatusCallback, LiveUpdateCallback } from "./types";
import { timeframeToBinanceInterval } from "./types";

export class BinanceLiveProvider {
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private lastUpdateTime = 0;

  constructor(
    private opts: {
      symbol: string; // BTC
      exchangeSymbol: string; // BTCUSDT
      timeframe: string; // 5m
      onCandle: LiveUpdateCallback;
      onStatus: LiveStatusCallback;
    }
  ) {}

  get name() {
    return "BINANCE";
  }

  connect() {
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  private doConnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    const interval = timeframeToBinanceInterval(this.opts.timeframe);
    const streamName = `${this.opts.exchangeSymbol.toLowerCase()}@kline_${interval}`;
    const url = `wss://stream.binance.com:9443/ws/${streamName}`;

    this.opts.onStatus("CONNECTING", `Binance ${streamName}`);

    try {
      this.ws = new WebSocket(url);
    } catch (e: any) {
      this.opts.onStatus("ERROR", e.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastUpdateTime = Date.now();
      this.opts.onStatus("LIVE", "Binance connected");
      this.startStaleCheck();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Binance kline stream: { e: "kline", k: { t, T, o, h, l, c, v, x, ... } }
        const k = msg.k;
        if (!k) return;

        const openTime = k.t; // ms
        const closeTime = k.T;
        const open = parseFloat(k.o);
        const high = parseFloat(k.h);
        const low = parseFloat(k.l);
        const close = parseFloat(k.c);
        const volume = parseFloat(k.v);
        const closed = k.x === true; // true if this kline closed

        if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return;

        const candle: LiveCandle = {
          symbol: this.opts.symbol,
          exchange: "BINANCE",
          exchangeSymbol: this.opts.exchangeSymbol,
          timeframe: this.opts.timeframe,
          openTime,
          closeTime,
          open,
          high,
          low,
          close,
          volume,
          closed,
          time: Math.floor(openTime / 1000),
        };

        this.lastUpdateTime = Date.now();
        this.opts.onStatus("LIVE");
        this.opts.onCandle(candle);
      } catch (e) {
        // ignore parse errors
      }
    };

    this.ws.onerror = () => {
      this.opts.onStatus("ERROR", "Binance WS error");
    };

    this.ws.onclose = () => {
      this.stopStaleCheck();
      if (this.shouldReconnect) {
        this.opts.onStatus("RECONNECTING", `reconnect attempt ${this.reconnectAttempts + 1}`);
        this.scheduleReconnect();
      } else {
        this.opts.onStatus("CLOSED");
      }
    };
  }

  private startStaleCheck() {
    this.stopStaleCheck();
    // If no update for 30s, mark STALE
    this.staleTimer = setInterval(() => {
      if (Date.now() - this.lastUpdateTime > 30000) {
        this.opts.onStatus("STALE", "no data 30s");
      }
    }, 10000);
  }

  private stopStaleCheck() {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (!this.shouldReconnect) return;

    // Exponential backoff + jitter: 1s,2s,4s,8s,16s,32s max 60s
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    const jitter = Math.random() * 1000;
    const delay = base + jitter;
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.doConnect();
    }, delay);
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopStaleCheck();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }
    this.opts.onStatus("CLOSED");
  }

  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }
}
