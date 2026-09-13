/**
 * Bybit public WebSocket provider — client-side, DISPLAY ONLY
 * Provides trade + kline streams
 * Endpoint: wss://stream.bybit.com/v5/public/spot
 * Docs: https://bybit-exchange.github.io/docs/v5/ws/connect
 */

import type { LiveCandle, LiveTick, LiveStatusCallback, LiveUpdateCallback, LiveTickCallback } from "./types";
import { timeframeToBybitInterval } from "./types";

export class BybitLiveProvider {
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;

  constructor(
    private opts: {
      symbol: string;
      exchangeSymbol: string;
      timeframe: string;
      onTick?: LiveTickCallback;
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
    this.opts.onStatus("CONNECTING", `Bybit ${this.opts.exchangeSymbol}`);

    try {
      this.ws = new WebSocket(url);
    } catch (e: any) {
      this.opts.onStatus("ERROR", e.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageTime = Date.now();
      const interval = timeframeToBybitInterval(this.opts.timeframe);
      const klineTopic = `kline.${interval}.${this.opts.exchangeSymbol}`;
      const tradeTopic = `publicTrade.${this.opts.exchangeSymbol}`;
      try {
        this.ws!.send(JSON.stringify({ op: "subscribe", args: [tradeTopic, klineTopic] }));
      } catch {}
      this.opts.onStatus("LIVE", "Bybit connected");
      this.startStaleCheck();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.op === "pong" || msg.success === true) {
          // heartbeat ack
          return;
        }
        this.lastMessageTime = Date.now();

        // Trade: {topic:"publicTrade.BTCUSDT", type:"snapshot", ts, data:[{T:timestamp, p:price, v:volume, s:side}]}
        if (msg.topic && msg.topic.startsWith("publicTrade.")) {
          if (!msg.data || !Array.isArray(msg.data) || msg.data.length === 0) return;
          // Bybit may send multiple trades, use last for price
          for (const t of msg.data) {
            const price = parseFloat(t.p);
            if (!Number.isFinite(price)) continue;
            if (this.opts.onTick) {
              const tick: LiveTick = {
                exchange: "BYBIT",
                symbol: this.opts.symbol,
                exchangeSymbol: this.opts.exchangeSymbol,
                price,
                volume: parseFloat(t.v) || undefined,
                eventTime: Number(t.T) || msg.ts || Date.now(),
                rawTime: Number(t.T),
              };
              this.opts.onTick(tick);
            }
          }
          this.opts.onStatus("LIVE");
        }
        // Kline: {topic:"kline.5.BTCUSDT", data:[{start, end, open, high, low, close, volume, confirm}]}
        else if (msg.topic && msg.topic.startsWith("kline.")) {
          if (!msg.data || !Array.isArray(msg.data) || msg.data.length === 0) return;
          const k = msg.data[msg.data.length - 1];
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
            eventTime: msg.ts || Date.now(),
          };

          this.opts.onStatus("LIVE");
          this.opts.onCandle(candle);
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.opts.onStatus("ERROR", "Bybit WS error");
    };

    this.ws.onclose = () => {
      this.stopStaleCheck();
      this.stopPing();
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
      if (Date.now() - this.lastMessageTime > 10000) {
        this.opts.onStatus("STALE", `no data ${Math.round((Date.now() - this.lastMessageTime) / 1000)}s`);
      }
    }, 3000);
  }

  private stopStaleCheck() {
    if (this.staleTimer) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
  }

  private startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ op: "ping" }));
        } catch {}
      }
    }, 20000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (!this.shouldReconnect) return;
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    const jitter = Math.random() * 1000;
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => this.doConnect(), base + jitter);
  }

  disconnect() {
    this.shouldReconnect = false;
    this.stopStaleCheck();
    this.stopPing();
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
