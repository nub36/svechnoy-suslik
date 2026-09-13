/**
 * Bybit public kline WebSocket provider — client-side
 * DISPLAY ONLY
 * Endpoint: wss://stream.bybit.com/v5/public/spot
 * Subscribe: {"op":"subscribe","args":["kline.5.BTCUSDT"]}
 */

import type { LiveCandle, LiveStatusCallback, LiveUpdateCallback } from "./types";
import { timeframeToBybitInterval } from "./types";

export class BybitLiveProvider {
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private staleTimer: NodeJS.Timeout | null = null;
  private lastUpdateTime = 0;

  constructor(
    private opts: {
      symbol: string;
      exchangeSymbol: string;
      timeframe: string;
      onCandle: LiveUpdateCallback;
      onStatus: LiveStatusCallback;
    }
  ) {}

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

    const url = "wss://stream.bybit.com/v5/public/spot";
    this.opts.onStatus("CONNECTING", `Bybit ${this.opts.exchangeSymbol} ${this.opts.timeframe}`);

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
      const interval = timeframeToBybitInterval(this.opts.timeframe);
      const args = `kline.${interval}.${this.opts.exchangeSymbol}`;
      try {
        this.ws!.send(JSON.stringify({ op: "subscribe", args: [args] }));
      } catch {}
      this.opts.onStatus("LIVE", "Bybit connected");
      this.startStaleCheck();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Bybit kline: { topic:"kline.5.BTCUSDT", data:[{ start, end, open, high, low, close, volume, confirm }] }
        if (!msg.data || !Array.isArray(msg.data) || msg.data.length === 0) return;
        // Bybit sends array of klines, last is latest
        const k = msg.data[msg.data.length - 1];
        // k: { start: ms, end: ms, open, high, low, close, volume, confirm }
        const openTime = Number(k.start);
        const closeTime = Number(k.end);
        const open = parseFloat(k.open);
        const high = parseFloat(k.high);
        const low = parseFloat(k.low);
        const close = parseFloat(k.close);
        const volume = parseFloat(k.volume);
        const closed = k.confirm === true;

        if (!Number.isFinite(openTime) || !Number.isFinite(open)) return;

        const candle: LiveCandle = {
          symbol: this.opts.symbol,
          exchange: "BYBIT",
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
      } catch {}
    };

    this.ws.onerror = () => {
      this.opts.onStatus("ERROR", "Bybit WS error");
    };

    this.ws.onclose = () => {
      this.stopStaleCheck();
      if (this.shouldReconnect) {
        this.opts.onStatus("RECONNECTING", `reconnect ${this.reconnectAttempts + 1}`);
        this.scheduleReconnect();
      } else {
        this.opts.onStatus("CLOSED");
      }
    };
  }

  private startStaleCheck() {
    this.stopStaleCheck();
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!this.shouldReconnect) return;
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000);
    const jitter = Math.random() * 1000;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), base + jitter);
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
