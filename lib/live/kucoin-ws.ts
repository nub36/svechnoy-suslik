/**
 * KuCoin public WebSocket provider — client-side, DISPLAY ONLY
 * Requires bullet token via REST POST https://api.kucoin.com/api/v1/bullet-public
 * Endpoint: wss://ws-api-spot.kucoin.com/?token=...
 * Channels: /market/match:SYMBOL (trades) and /market/candles:SYMBOL_Interval (kline)
 * Docs: https://www.kucoin.com/docs/websocket/basic-info/create-connection
 */

import type { LiveCandle, LiveTick, LiveStatusCallback, LiveUpdateCallback, LiveTickCallback } from "./types";
import { timeframeToKucoinInterval } from "./types";

type BulletResponse = {
  code: string;
  data: {
    token: string;
    instanceServers: {
      endpoint: string;
      pingInterval: number;
      pingTimeout: number;
    }[];
  };
};

export class KucoinLiveProvider {
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;
  private pingInterval = 18000;
  private bulletEndpoint = "wss://ws-api-spot.kucoin.com/";
  private token: string | null = null;

  constructor(
    private opts: {
      symbol: string;
      exchangeSymbol: string; // BTC-USDT
      timeframe: string;
      onTick?: LiveTickCallback;
      onCandle: LiveUpdateCallback;
      onStatus: LiveStatusCallback;
    }
  ) {}

  get name() {
    return "KUCOIN";
  }

  connect() {
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  private async fetchBulletToken(): Promise<{ endpoint: string; token: string; pingInterval: number } | null> {
    try {
      const res = await fetch("https://api.kucoin.com/api/v1/bullet-public", {
        method: "POST",
      });
      if (!res.ok) return null;
      const data: BulletResponse = await res.json();
      if (data.code !== "200000" || !data.data?.token) return null;
      const server = data.data.instanceServers[0];
      return {
        endpoint: server.endpoint,
        token: data.data.token,
        pingInterval: server.pingInterval || 18000,
      };
    } catch {
      return null;
    }
  }

  private async doConnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    this.opts.onStatus("CONNECTING", `KuCoin ${this.opts.exchangeSymbol}`);

    // Get bullet token
    const bullet = await this.fetchBulletToken();
    if (!bullet) {
      this.opts.onStatus("ERROR", "KuCoin bullet token failed");
      this.scheduleReconnect();
      return;
    }

    this.bulletEndpoint = bullet.endpoint;
    this.token = bullet.token;
    this.pingInterval = bullet.pingInterval;

    const url = `${bullet.endpoint}?token=${bullet.token}&connectId=${Date.now()}`;

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

      const interval = timeframeToKucoinInterval(this.opts.timeframe);
      // For LIVE PRICE: ticker pushes every 100ms (price, best bid/ask) — more frequent than match
      // For trades: match gives execution, but ticker is better for price display
      // Use both: ticker for price, match as additional, candles for OHLC
      const tickerTopic = `/market/ticker:${this.opts.exchangeSymbol}`;
      const matchTopic = `/market/match:${this.opts.exchangeSymbol}`;
      const candleTopic = `/market/candles:${this.opts.exchangeSymbol}_${interval}`;

      try {
        const idBase = Date.now();
        this.ws!.send(
          JSON.stringify({
            id: idBase,
            type: "subscribe",
            topic: tickerTopic,
            privateChannel: false,
            response: true,
          })
        );
        this.ws!.send(
          JSON.stringify({
            id: idBase + 1,
            type: "subscribe",
            topic: matchTopic,
            privateChannel: false,
            response: true,
          })
        );
        this.ws!.send(
          JSON.stringify({
            id: idBase + 2,
            type: "subscribe",
            topic: candleTopic,
            privateChannel: false,
            response: true,
          })
        );
      } catch {}

      this.opts.onStatus("LIVE", "KuCoin connected");
      this.startStaleCheck();
      this.startPing();
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.lastMessageTime = Date.now();

        if (msg.type === "welcome" || msg.type === "ack" || msg.type === "pong") {
          return;
        }

        if (msg.type === "message") {
          const topic: string = msg.topic || "";
          const data = msg.data;

          if (!data) return;

          // Ticker: /market/ticker:BTC-USDT, data {price, size, bestAsk, bestBid, Time} — push every 100ms, best for LIVE PRICE
          if (topic.startsWith("/market/ticker:")) {
            const price = parseFloat(data.price);
            if (!Number.isFinite(price)) return;
            if (this.opts.onTick) {
              const tick: LiveTick = {
                exchange: "KUCOIN",
                symbol: this.opts.symbol,
                exchangeSymbol: this.opts.exchangeSymbol,
                price,
                volume: parseFloat(data.size) || undefined,
                eventTime: Number(data.Time || data.time) || Date.now(),
                rawTime: Number(data.Time || data.time),
              };
              this.opts.onTick(tick);
            }
            this.opts.onStatus("LIVE");
          }
          // Match (trade): topic /market/match:BTC-USDT, data {symbol, price, size, time}
          else if (topic.startsWith("/market/match:")) {
            const price = parseFloat(data.price);
            if (!Number.isFinite(price)) return;
            if (this.opts.onTick) {
              const tick: LiveTick = {
                exchange: "KUCOIN",
                symbol: this.opts.symbol,
                exchangeSymbol: this.opts.exchangeSymbol,
                price,
                volume: parseFloat(data.size) || undefined,
                eventTime: Number(data.time) || Date.now(),
                rawTime: Number(data.time),
              };
              this.opts.onTick(tick);
            }
            this.opts.onStatus("LIVE");
          }
          // Candles: topic /market/candles:BTC-USDT_1min, data {symbol, candles:[startTime, open, close, high, low, volume, turnover], time}
          else if (topic.startsWith("/market/candles:")) {
            const candles = data.candles;
            if (!Array.isArray(candles) || candles.length < 6) return;
            const startTimeSec = Number(candles[0]);
            const openTime = startTimeSec * 1000;
            const open = parseFloat(candles[1]);
            const close = parseFloat(candles[2]);
            const high = parseFloat(candles[3]);
            const low = parseFloat(candles[4]);
            const volume = parseFloat(candles[5]);

            if (!Number.isFinite(openTime) || !Number.isFinite(open)) return;

            const candle: LiveCandle = {
              symbol: this.opts.symbol,
              exchange: "KUCOIN",
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
              eventTime: Number(data.time) || Date.now(),
            };

            this.opts.onStatus("LIVE");
            this.opts.onCandle(candle);
          }
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.opts.onStatus("ERROR", "KuCoin WS error");
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
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ id: Date.now(), type: "ping" }));
        } catch {}
      }
    }, this.pingInterval - 2000 > 0 ? this.pingInterval - 2000 : 10000);
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
