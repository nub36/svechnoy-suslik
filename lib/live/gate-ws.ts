/**
 * Gate.io public WebSocket provider — client-side, DISPLAY ONLY
 * Endpoint: wss://api.gateio.ws/ws/v4/
 * Channels: spot.trades (realtime) and spot.candlesticks (2s update)
 * Docs: https://www.gate.com/docs/developers/apiv4/ws/en/
 */

import type { LiveCandle, LiveTick, LiveStatusCallback, LiveUpdateCallback, LiveTickCallback } from "./types";
import { timeframeToGateInterval } from "./types";

export class GateLiveProvider {
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
      exchangeSymbol: string; // BTC_USDT
      timeframe: string;
      onTick?: LiveTickCallback;
      onCandle: LiveUpdateCallback;
      onStatus: LiveStatusCallback;
    }
  ) {}

  get name() {
    return "GATE";
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

    const url = "wss://api.gateio.ws/ws/v4/";
    this.opts.onStatus("CONNECTING", `Gate ${this.opts.exchangeSymbol}`);

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
      const now = Math.floor(Date.now() / 1000);
      const interval = timeframeToGateInterval(this.opts.timeframe);

      // Subscribe to trades (realtime), tickers (price), and candlesticks (2s)
      // Trade stream is primary for LIVE PRICE, tickers as fallback if trades sparse
      try {
        this.ws!.send(
          JSON.stringify({
            time: now,
            channel: "spot.trades",
            event: "subscribe",
            payload: [this.opts.exchangeSymbol],
          })
        );
        this.ws!.send(
          JSON.stringify({
            time: now,
            channel: "spot.tickers",
            event: "subscribe",
            payload: [this.opts.exchangeSymbol],
          })
        );
        this.ws!.send(
          JSON.stringify({
            time: now,
            channel: "spot.candlesticks",
            event: "subscribe",
            payload: [interval, this.opts.exchangeSymbol],
          })
        );
      } catch {}

      this.opts.onStatus("LIVE", "Gate connected");
      this.startStaleCheck();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.lastMessageTime = Date.now();

        // Trades: {time, channel:"spot.trades", event:"update", result:{id, create_time, create_time_ms, side, currency_pair, amount, price}}
        // Docs example: result.price not result.p
        if (msg.channel === "spot.trades" && msg.result) {
          const r = msg.result;
          // Gate trade result uses price field, not p, and amount not a
          const priceStr = r.price ?? r.p;
          const price = parseFloat(priceStr);
          if (!Number.isFinite(price)) return;
          // create_time_ms like "1606292218213.4578" — parse int part
          let eventTime: number;
          if (r.create_time_ms) {
            const msPart = String(r.create_time_ms).split(".")[0];
            eventTime = Number(msPart);
            if (!Number.isFinite(eventTime)) eventTime = Date.now();
          } else if (r.create_time) {
            eventTime = Number(r.create_time) * 1000;
          } else if (r.t) {
            eventTime = Number(r.t) * 1000;
          } else {
            eventTime = Date.now();
          }
          if (this.opts.onTick) {
            const tick: LiveTick = {
              exchange: "GATE",
              symbol: this.opts.symbol,
              exchangeSymbol: this.opts.exchangeSymbol,
              price,
              volume: parseFloat(r.amount ?? r.a) || undefined,
              eventTime,
              rawTime: eventTime,
            };
            this.opts.onTick(tick);
          }
          this.opts.onStatus("LIVE");
        }
        // Tickers: {channel:"spot.tickers", result:{currency_pair, last, ...}} — fallback price if trades sparse
        else if (msg.channel === "spot.tickers" && msg.result) {
          const r = msg.result;
          const price = parseFloat(r.last ?? r.price);
          if (!Number.isFinite(price)) return;
          if (this.opts.onTick) {
            const tick: LiveTick = {
              exchange: "GATE",
              symbol: this.opts.symbol,
              exchangeSymbol: this.opts.exchangeSymbol,
              price,
              eventTime: Date.now(),
            };
            this.opts.onTick(tick);
          }
          this.opts.onStatus("LIVE");
        }
        // Candlesticks: {channel:"spot.candlesticks", result:{t:sec, o,c,h,l,v, n:"5m_BTC_USDT"}}
        else if (msg.channel === "spot.candlesticks" && msg.result) {
          const r = msg.result;
          const openTimeSec = Number(r.t);
          if (!Number.isFinite(openTimeSec)) return;
          const openTime = openTimeSec * 1000;
          const open = parseFloat(r.o);
          const high = parseFloat(r.h);
          const low = parseFloat(r.l);
          const close = parseFloat(r.c);
          const volume = parseFloat(r.v);
          if (!Number.isFinite(open) || !Number.isFinite(close)) return;

          // Gate does not send closed flag in WS, we infer: if current time > openTime + interval, it's closed? For DISPLAY we mark false
          // Actually closed detection via time: if now > openTime + intervalMs, then closed, but we keep false for forming
          const candle: LiveCandle = {
            symbol: this.opts.symbol,
            exchange: "GATE",
            exchangeSymbol: this.opts.exchangeSymbol,
            timeframe: this.opts.timeframe,
            openTime,
            closeTime: undefined,
            open,
            high,
            low,
            close,
            volume,
            closed: false,
            time: Math.floor(openTime / 1000),
            eventTime: Date.now(),
          };

          this.opts.onStatus("LIVE");
          this.opts.onCandle(candle);
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.opts.onStatus("ERROR", "Gate WS error");
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

  private startPing() {
    this.stopPing();
    // Gate recommends ping every ~5s via spot.ping or websocket ping frame
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          const now = Math.floor(Date.now() / 1000);
          this.ws.send(
            JSON.stringify({
              time: now,
              channel: "spot.ping",
              event: "ping",
            })
          );
        } catch {}
      }
    }, 10000);
  }

  private stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
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
