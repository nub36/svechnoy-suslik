/**
 * BingX public WebSocket provider — client-side, DISPLAY ONLY
 * Endpoint: wss://open-api-ws.bingx.com/market
 * Channels: BTC-USDT@trade (realtime), BTC-USDT@kline_1min (on update)
 * Uses gzip compression (pako) — need to decompress ArrayBuffer
 * Docs: https://bingx-api.github.io/docs-v3/#/en/Spot/Websocket%20Market%20Data
 */

import type { LiveCandle, LiveTick, LiveStatusCallback, LiveUpdateCallback, LiveTickCallback } from "./types";
import { timeframeToBingxInterval } from "./types";

export class BingxLiveProvider {
  private ws: WebSocket | null = null;
  private shouldReconnect = true;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private lastMessageTime = 0;

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
    return "BINGX";
  }

  connect() {
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this.doConnect();
  }

  private async decompressMessage(data: any): Promise<string | null> {
    try {
      // BingX sends gzip compressed data as ArrayBuffer or Blob
      if (data instanceof ArrayBuffer) {
        // Try DecompressionStream if available (browser), fallback to pako via dynamic import
        if (typeof DecompressionStream !== "undefined") {
          try {
            const ds = new DecompressionStream("gzip");
            const writer = ds.writable.getWriter();
            writer.write(new Uint8Array(data));
            writer.close();
            const reader = ds.readable.getReader();
            const chunks: Uint8Array[] = [];
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              if (value) chunks.push(value);
            }
            const total = chunks.reduce((acc, c) => acc + c.length, 0);
            const merged = new Uint8Array(total);
            let offset = 0;
            for (const c of chunks) {
              merged.set(c, offset);
              offset += c.length;
            }
            return new TextDecoder().decode(merged);
          } catch {
            // fallback to pako
          }
        }
        // Fallback: try to use pako if available, otherwise try as text
        try {
          // Dynamic import pako if installed, else try TextDecoder direct
          const pako = await import("pako").then((m: any) => m.default || m).catch(() => null);
          if (pako) {
            const decompressed = pako.ungzip(new Uint8Array(data), { to: "string" });
            return decompressed as string;
          }
        } catch {}
        // Last fallback: try as text
        return new TextDecoder().decode(data);
      } else if (data instanceof Blob) {
        const ab = await data.arrayBuffer();
        return this.decompressMessage(ab);
      } else if (typeof data === "string") {
        return data;
      }
      return null;
    } catch {
      return null;
    }
  }

  private doConnect() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    const url = "wss://open-api-ws.bingx.com/market";
    this.opts.onStatus("CONNECTING", `BingX ${this.opts.exchangeSymbol}`);

    try {
      const ws = new WebSocket(url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;
    } catch (e: any) {
      this.opts.onStatus("ERROR", e.message);
      this.scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.lastMessageTime = Date.now();
      const interval = timeframeToBingxInterval(this.opts.timeframe);
      const tradeChannel = `${this.opts.exchangeSymbol}@trade`;
      const klineChannel = `${this.opts.exchangeSymbol}@kline_${interval}`;

      try {
        const sub = (dataType: string) =>
          JSON.stringify({
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            reqType: "sub",
            dataType,
          });
        this.ws!.send(sub(tradeChannel));
        this.ws!.send(sub(klineChannel));
      } catch {}

      this.opts.onStatus("LIVE", "BingX connected");
      this.startStaleCheck();
    };

    this.ws.onmessage = async (event) => {
      try {
        let text: string | null = null;

        if (typeof event.data === "string") {
          text = event.data;
        } else {
          text = await this.decompressMessage(event.data);
        }

        if (!text) return;

        // Ping/Pong handling
        if (text.includes("ping") || text === "Ping" || text.includes("Ping")) {
          try {
            this.ws!.send("Pong");
            // Also try JSON pong
            this.ws!.send(JSON.stringify({ ping: Date.now() }));
          } catch {}
          return;
        }

        this.lastMessageTime = Date.now();

        const msg = JSON.parse(text);
        const dataType: string = msg.dataType || "";

        // Trade: {dataType:"BTC-USDT@trade", data:[{p:price, q:qty, T:time}]}
        if (dataType.endsWith("@trade")) {
          const trades = msg.data;
          if (Array.isArray(trades)) {
            for (const t of trades) {
              const price = parseFloat(t.p ?? t.price);
              if (!Number.isFinite(price)) continue;
              if (this.opts.onTick) {
                const tick: LiveTick = {
                  exchange: "BINGX",
                  symbol: this.opts.symbol,
                  exchangeSymbol: this.opts.exchangeSymbol,
                  price,
                  volume: parseFloat(t.q ?? t.qty) || undefined,
                  eventTime: Number(t.T ?? t.time) || Date.now(),
                  rawTime: Number(t.T ?? t.time),
                };
                this.opts.onTick(tick);
              }
            }
          } else if (trades && typeof trades === "object") {
            const price = parseFloat(trades.p ?? trades.price);
            if (Number.isFinite(price) && this.opts.onTick) {
              const tick: LiveTick = {
                exchange: "BINGX",
                symbol: this.opts.symbol,
                exchangeSymbol: this.opts.exchangeSymbol,
                price,
                volume: parseFloat(trades.q) || undefined,
                eventTime: Number(trades.T) || Date.now(),
                rawTime: Number(trades.T),
              };
              this.opts.onTick(tick);
            }
          }
          this.opts.onStatus("LIVE");
        }
        // Kline: {dataType:"BTC-USDT@kline_1min", data:{K:{t,T,o,c,h,l,v}, E, e, s}}
        else if (dataType.includes("@kline_")) {
          const d = msg.data;
          if (!d) return;
          const k = d.K || d.k || d;
          if (!k) return;
          const openTime = Number(k.t ?? k.startTime);
          const closeTime = Number(k.T ?? k.closeTime);
          const open = parseFloat(k.o ?? k.open);
          const high = parseFloat(k.h ?? k.high);
          const low = parseFloat(k.l ?? k.low);
          const close = parseFloat(k.c ?? k.close);
          const volume = parseFloat(k.v ?? k.volume ?? 0);

          if (!Number.isFinite(openTime) || !Number.isFinite(open)) return;

          const candle: LiveCandle = {
            symbol: this.opts.symbol,
            exchange: "BINGX",
            exchangeSymbol: this.opts.exchangeSymbol,
            timeframe: this.opts.timeframe,
            openTime,
            closeTime: Number.isFinite(closeTime) ? closeTime : undefined,
            open,
            high,
            low,
            close,
            volume,
            closed: false,
            time: Math.floor(openTime / 1000),
            eventTime: Number(d.E ?? msg.E) || Date.now(),
          };

          this.opts.onStatus("LIVE");
          this.opts.onCandle(candle);
        }
        // Ticker or lastPrice also contains price, treat as tick
        else if (dataType.endsWith("@ticker") || dataType.endsWith("@lastPrice") || dataType.endsWith("@bookTicker")) {
          const d = msg.data;
          const price = parseFloat(d?.c ?? d?.price ?? d?.p ?? d?.lastPrice);
          if (Number.isFinite(price) && this.opts.onTick) {
            const tick: LiveTick = {
              exchange: "BINGX",
              symbol: this.opts.symbol,
              exchangeSymbol: this.opts.exchangeSymbol,
              price,
              eventTime: Date.now(),
            };
            this.opts.onTick(tick);
            this.opts.onStatus("LIVE");
          }
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.opts.onStatus("ERROR", "BingX WS error");
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
