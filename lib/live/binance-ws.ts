/**
 * Binance public WebSocket provider — client-side only, DISPLAY ONLY
 * Provides both trade (price tick) and kline (candle) streams
 * Endpoint: wss://stream.binance.com:9443/stream?streams=...
 * Docs: https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams
 */

import type { LiveCandle, LiveTick, LiveStatusCallback, LiveUpdateCallback, LiveTickCallback } from "./types";
import { timeframeToBinanceInterval } from "./types";

export class BinanceLiveProvider {
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private lastTradeTime = 0;

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
    const lower = this.opts.exchangeSymbol.toLowerCase();
    // Combined stream: trade for LIVE PRICE (high freq) + kline for forming candle
    const streams = `${lower}@trade/${lower}@kline_${interval}`;
    const url = `wss://stream.binance.com:9443/stream?streams=${streams}`;

    this.opts.onStatus("CONNECTING", `Binance ${streams}`);

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
      this.opts.onStatus("LIVE", "Binance connected");
      this.startStaleCheck();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        // Combined stream format: {stream: "btcusdt@trade", data: {...}}
        const stream: string = msg.stream || "";
        const data = msg.data || msg; // fallback if not combined

        this.lastMessageTime = Date.now();

        if (stream.includes("@trade") || data.e === "trade") {
          // Trade event: {e:trade, E:eventTime, s:symbol, p:price, q:qty, T:tradeTime}
          const price = parseFloat(data.p);
          if (!Number.isFinite(price)) return;
          const eventTime = data.E || data.T || Date.now();
          this.lastTradeTime = Date.now();

          if (this.opts.onTick) {
            const tick: LiveTick = {
              exchange: "BINANCE",
              symbol: this.opts.symbol,
              exchangeSymbol: this.opts.exchangeSymbol,
              price,
              volume: parseFloat(data.q) || undefined,
              eventTime,
              rawTime: data.T,
            };
            this.opts.onTick(tick);
          }

          // Also update LIVE status to show real messages
          this.opts.onStatus("LIVE");
        } else if (stream.includes("@kline") || data.e === "kline") {
          const k = data.k;
          if (!k) return;
          const openTime = k.t;
          const closeTime = k.T;
          const open = parseFloat(k.o);
          const high = parseFloat(k.h);
          const low = parseFloat(k.l);
          const close = parseFloat(k.c);
          const volume = parseFloat(k.v);
          const closed = k.x === true;

          if (!Number.isFinite(open) || !Number.isFinite(close)) return;

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
            eventTime: data.E || Date.now(),
          };

          this.opts.onStatus("LIVE");
          this.opts.onCandle(candle);
        }
      } catch {
        // ignore parse errors
      }
    };

    this.ws.onerror = () => {
      this.opts.onStatus("ERROR", "Binance WS error");
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
      const now = Date.now();
      if (now - this.lastMessageTime > 10000) {
        this.opts.onStatus("STALE", `no data ${Math.round((now - this.lastMessageTime) / 1000)}s`);
      }
    }, 3000);
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
    const base = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
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
