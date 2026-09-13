#!/usr/bin/env tsx
// @ts-nocheck
/**
 * 60 SECOND PRODUCTION-LIKE BENCHMARK for 5 exchanges BTC/USDT
 * Measures raw msgs/s, render updates/s, unique prices, max UI freeze, reconnects
 * Simulates UI coalescing (100ms) and series.update() performance
 */

type Exchange = "BINANCE" | "BYBIT" | "GATE" | "KUCOIN" | "BINGX";

type BenchStats = {
  exchange: Exchange;
  rawMsgs: number;
  rawMsgsPerSec: number;
  renderUpdates: number;
  renderPerSec: number;
  uniquePrices: number;
  maxFreezeMs: number;
  reconnects: number;
  errors: number;
  tradeMsgs: number;
  klineMsgs: number;
  lastRenderTime: number;
  maxGap: number;
  lastMsgTime: number;
  prices: Set<string>;
  start: number;
  end: number;
};

function createBench(ex: Exchange): BenchStats {
  return {
    exchange: ex,
    rawMsgs: 0,
    rawMsgsPerSec: 0,
    renderUpdates: 0,
    renderPerSec: 0,
    uniquePrices: 0,
    maxFreezeMs: 0,
    reconnects: 0,
    errors: 0,
    tradeMsgs: 0,
    klineMsgs: 0,
    lastRenderTime: 0,
    maxGap: 0,
    lastMsgTime: 0,
    prices: new Set(),
    start: Date.now(),
    end: 0,
  };
}

function finalizeBench(s: BenchStats) {
  s.end = Date.now();
  const dur = (s.end - s.start) / 1000;
  s.rawMsgsPerSec = dur > 0 ? s.rawMsgs / dur : 0;
  s.renderPerSec = dur > 0 ? s.renderUpdates / dur : 0;
  s.uniquePrices = s.prices.size;
}

// Simulate UI coalescing: max 10 renders/sec (100ms)
class Coalescer {
  private latestPrice: string | null = null;
  private lastRender = 0;
  private raf: any = null;
  public renders = 0;
  public maxFreeze = 0;
  private lastRenderTime = 0;

  constructor(private onRender: (price: string) => void) {}

  push(price: string) {
    this.latestPrice = price;
    const now = Date.now();
    if (now - this.lastRender < 100) {
      if (this.raf === null) {
        this.raf = setTimeout(() => {
          this.raf = null;
          if (this.latestPrice) {
            this.doRender(this.latestPrice);
          }
        }, 100 - (now - this.lastRender));
      }
      return;
    }
    this.doRender(price);
  }

  private doRender(price: string) {
    const now = Date.now();
    if (this.lastRenderTime) {
      const gap = now - this.lastRenderTime;
      if (gap > this.maxFreeze) this.maxFreeze = gap;
    }
    this.lastRenderTime = now;
    this.lastRender = now;
    this.renders++;
    this.onRender(price);
  }

  stop() {
    if (this.raf) clearTimeout(this.raf);
  }
}

async function benchBinance(durationMs = 60000): Promise<BenchStats> {
  const stats = createBench("BINANCE");
  return new Promise((resolve) => {
    try {
      const url = "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@kline_5m";
      const ws = new WebSocket(url);
      const coalescer = new Coalescer((price) => {
        stats.renderUpdates++;
      });

      ws.onopen = () => {
        stats.start = Date.now();
        stats.lastMsgTime = Date.now();
        stats.lastRenderTime = Date.now();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const data = msg.data || msg;
          const now = Date.now();
          if (stats.lastMsgTime) {
            const gap = now - stats.lastMsgTime;
            if (gap > stats.maxGap) stats.maxGap = gap;
          }
          stats.lastMsgTime = now;
          stats.rawMsgs++;

          if (data.e === "trade") {
            stats.tradeMsgs++;
            if (data.p) {
              stats.prices.add(data.p);
              coalescer.push(data.p);
            }
          } else if (data.e === "kline") {
            stats.klineMsgs++;
            if (data.k?.c) {
              stats.prices.add(data.k.c);
            }
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;
      ws.onclose = () => {
        stats.reconnects++;
      };

      setTimeout(() => {
        try {
          coalescer.stop();
          ws.close();
        } catch {}
        stats.maxFreezeMs = coalescer.maxFreeze;
        finalizeBench(stats);
        console.log(`\n=== BINANCE BENCH 60s ===`);
        console.log(`raw msgs/s: ${stats.rawMsgsPerSec.toFixed(2)}`);
        console.log(`render updates/s: ${stats.renderPerSec.toFixed(2)}`);
        console.log(`unique prices: ${stats.uniquePrices}`);
        console.log(`max UI freeze: ${stats.maxFreezeMs}ms (gap between renders)`);
        console.log(`max msg gap: ${stats.maxGap}ms`);
        console.log(`reconnects: ${stats.reconnects}`);
        console.log(`trade: ${stats.tradeMsgs}, kline: ${stats.klineMsgs}`);
        resolve(stats);
      }, durationMs);
    } catch {
      stats.errors++;
      finalizeBench(stats);
      resolve(stats);
    }
  });
}

async function benchBybit(durationMs = 60000): Promise<BenchStats> {
  const stats = createBench("BYBIT");
  return new Promise((resolve) => {
    try {
      const url = "wss://stream.bybit.com/v5/public/spot";
      const ws = new WebSocket(url);
      const coalescer = new Coalescer(() => stats.renderUpdates++);

      ws.onopen = () => {
        stats.start = Date.now();
        stats.lastMsgTime = Date.now();
        try {
          ws.send(JSON.stringify({ op: "subscribe", args: ["publicTrade.BTCUSDT", "kline.5.BTCUSDT"] }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.op === "pong" || msg.success) return;
          const now = Date.now();
          if (stats.lastMsgTime) {
            const gap = now - stats.lastMsgTime;
            if (gap > stats.maxGap) stats.maxGap = gap;
          }
          stats.lastMsgTime = now;
          stats.rawMsgs++;

          if (msg.topic?.startsWith("publicTrade.")) {
            stats.tradeMsgs++;
            for (const t of msg.data || []) {
              if (t.p) {
                stats.prices.add(t.p);
                coalescer.push(t.p);
              }
            }
          } else if (msg.topic?.startsWith("kline.")) {
            stats.klineMsgs++;
            for (const k of msg.data || []) {
              if (k.close) stats.prices.add(k.close);
            }
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try {
          coalescer.stop();
          ws.close();
        } catch {}
        stats.maxFreezeMs = coalescer.maxFreeze;
        finalizeBench(stats);
        console.log(`\n=== BYBIT BENCH 60s ===`);
        console.log(`raw msgs/s: ${stats.rawMsgsPerSec.toFixed(2)}`);
        console.log(`render updates/s: ${stats.renderPerSec.toFixed(2)}`);
        console.log(`unique prices: ${stats.uniquePrices}`);
        console.log(`max UI freeze: ${stats.maxFreezeMs}ms`);
        console.log(`max msg gap: ${stats.maxGap}ms`);
        console.log(`reconnects: ${stats.reconnects}`);
        console.log(`trade: ${stats.tradeMsgs}, kline: ${stats.klineMsgs}`);
        resolve(stats);
      }, durationMs);
    } catch {
      stats.errors++;
      finalizeBench(stats);
      resolve(stats);
    }
  });
}

async function benchGate(durationMs = 60000): Promise<BenchStats> {
  const stats = createBench("GATE");
  return new Promise((resolve) => {
    try {
      const url = "wss://api.gateio.ws/ws/v4/";
      const ws = new WebSocket(url);
      const coalescer = new Coalescer(() => stats.renderUpdates++);

      ws.onopen = () => {
        stats.start = Date.now();
        stats.lastMsgTime = Date.now();
        const now = Math.floor(Date.now() / 1000);
        try {
          ws.send(JSON.stringify({ time: now, channel: "spot.trades", event: "subscribe", payload: ["BTC_USDT"] }));
          ws.send(JSON.stringify({ time: now, channel: "spot.candlesticks", event: "subscribe", payload: ["5m", "BTC_USDT"] }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const now = Date.now();
          if (stats.lastMsgTime) {
            const gap = now - stats.lastMsgTime;
            if (gap > stats.maxGap) stats.maxGap = gap;
          }
          stats.lastMsgTime = now;
          stats.rawMsgs++;

          if (msg.channel === "spot.trades" && msg.result?.p) {
            stats.tradeMsgs++;
            stats.prices.add(msg.result.p);
            coalescer.push(msg.result.p);
          } else if (msg.channel === "spot.candlesticks" && msg.result?.c) {
            stats.klineMsgs++;
            stats.prices.add(msg.result.c);
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try {
          coalescer.stop();
          ws.close();
        } catch {}
        stats.maxFreezeMs = coalescer.maxFreeze;
        finalizeBench(stats);
        console.log(`\n=== GATE BENCH 60s ===`);
        console.log(`raw msgs/s: ${stats.rawMsgsPerSec.toFixed(2)}`);
        console.log(`render updates/s: ${stats.renderPerSec.toFixed(2)}`);
        console.log(`unique prices: ${stats.uniquePrices}`);
        console.log(`max UI freeze: ${stats.maxFreezeMs}ms`);
        console.log(`max msg gap: ${stats.maxGap}ms`);
        console.log(`reconnects: ${stats.reconnects}`);
        console.log(`trade: ${stats.tradeMsgs}, kline: ${stats.klineMsgs}`);
        resolve(stats);
      }, durationMs);
    } catch {
      stats.errors++;
      finalizeBench(stats);
      resolve(stats);
    }
  });
}

async function benchKucoin(durationMs = 60000): Promise<BenchStats> {
  const stats = createBench("KUCOIN");
  return new Promise(async (resolve) => {
    try {
      const res = await fetch("https://api.kucoin.com/api/v1/bullet-public", { method: "POST" });
      if (!res.ok) throw new Error(`bullet ${res.status}`);
      const bullet = await res.json();
      const endpoint = bullet.data.instanceServers[0].endpoint;
      const token = bullet.data.token;
      const pingInterval = bullet.data.instanceServers[0].pingInterval || 18000;

      const url = `${endpoint}?token=${token}&connectId=${Date.now()}`;
      const ws = new WebSocket(url);
      const coalescer = new Coalescer(() => stats.renderUpdates++);
      let pingTimer: any = null;

      ws.onopen = () => {
        stats.start = Date.now();
        stats.lastMsgTime = Date.now();
        try {
          const id = Date.now();
          ws.send(JSON.stringify({ id, type: "subscribe", topic: "/market/match:BTC-USDT", privateChannel: false, response: true }));
          ws.send(JSON.stringify({ id: id + 1, type: "subscribe", topic: "/market/candles:BTC-USDT_1min", privateChannel: false, response: true }));
        } catch {}
        pingTimer = setInterval(() => {
          try {
            ws.send(JSON.stringify({ id: Date.now(), type: "ping" }));
          } catch {}
        }, pingInterval - 2000);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "welcome" || msg.type === "ack" || msg.type === "pong") return;
          const now = Date.now();
          if (stats.lastMsgTime) {
            const gap = now - stats.lastMsgTime;
            if (gap > stats.maxGap) stats.maxGap = gap;
          }
          stats.lastMsgTime = now;
          stats.rawMsgs++;

          if (msg.topic?.startsWith("/market/match:")) {
            stats.tradeMsgs++;
            if (msg.data?.price) {
              stats.prices.add(msg.data.price);
              coalescer.push(msg.data.price);
            }
          } else if (msg.topic?.startsWith("/market/candles:")) {
            stats.klineMsgs++;
            const c = msg.data?.candles;
            if (Array.isArray(c) && c[2]) stats.prices.add(c[2]);
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try {
          clearInterval(pingTimer);
          coalescer.stop();
          ws.close();
        } catch {}
        stats.maxFreezeMs = coalescer.maxFreeze;
        finalizeBench(stats);
        console.log(`\n=== KUCOIN BENCH 60s ===`);
        console.log(`raw msgs/s: ${stats.rawMsgsPerSec.toFixed(2)}`);
        console.log(`render updates/s: ${stats.renderPerSec.toFixed(2)}`);
        console.log(`unique prices: ${stats.uniquePrices}`);
        console.log(`max UI freeze: ${stats.maxFreezeMs}ms`);
        console.log(`max msg gap: ${stats.maxGap}ms`);
        console.log(`reconnects: ${stats.reconnects}`);
        console.log(`trade: ${stats.tradeMsgs}, kline: ${stats.klineMsgs}`);
        resolve(stats);
      }, durationMs);
    } catch (e: any) {
      console.error(`KUCOIN bench error: ${e.message}`);
      stats.errors++;
      finalizeBench(stats);
      resolve(stats);
    }
  });
}

async function benchBingx(durationMs = 60000): Promise<BenchStats> {
  const stats = createBench("BINGX");
  return new Promise((resolve) => {
    try {
      const url = "wss://open-api-ws.bingx.com/market";
      const ws = new WebSocket(url);
      // @ts-ignore
      ws.binaryType = "arraybuffer";
      const coalescer = new Coalescer(() => stats.renderUpdates++);

      ws.onopen = () => {
        stats.start = Date.now();
        stats.lastMsgTime = Date.now();
        try {
          const sub = (dt: string) => JSON.stringify({ id: `${Date.now()}-${Math.random()}`, reqType: "sub", dataType: dt });
          ws.send(sub("BTC-USDT@trade"));
          ws.send(sub("BTC-USDT@kline_5min"));
        } catch {}
      };

      ws.onmessage = async (ev) => {
        try {
          let text: string;
          if (typeof ev.data === "string") {
            text = ev.data;
          } else if (ev.data instanceof ArrayBuffer) {
            try {
              const ds = new (globalThis as any).DecompressionStream("gzip");
              const writer = ds.writable.getWriter();
              writer.write(new Uint8Array(ev.data));
              writer.close();
              const reader = ds.readable.getReader();
              const chunks: Uint8Array[] = [];
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                if (value) chunks.push(value);
              }
              const total = chunks.reduce((a, c) => a + c.length, 0);
              const merged = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                merged.set(c, off);
                off += c.length;
              }
              text = new TextDecoder().decode(merged);
            } catch {
              text = new TextDecoder().decode(ev.data);
            }
          } else {
            text = String(ev.data);
          }

          if (!text) return;
          if (text.includes("ping") || text === "Ping") {
            try {
              ws.send("Pong");
            } catch {}
            return;
          }

          const now = Date.now();
          if (stats.lastMsgTime) {
            const gap = now - stats.lastMsgTime;
            if (gap > stats.maxGap) stats.maxGap = gap;
          }
          stats.lastMsgTime = now;
          stats.rawMsgs++;

          const msg = JSON.parse(text);
          const dt = msg.dataType || "";
          if (dt.endsWith("@trade")) {
            stats.tradeMsgs++;
            const trades = msg.data;
            if (Array.isArray(trades)) {
              for (const t of trades) {
                if (t.p) {
                  stats.prices.add(t.p);
                  coalescer.push(t.p);
                }
              }
            } else if (trades?.p) {
              stats.prices.add(trades.p);
              coalescer.push(trades.p);
            }
          } else if (dt.includes("@kline_")) {
            stats.klineMsgs++;
            const k = msg.data?.K || msg.data?.k || msg.data;
            if (k?.c) stats.prices.add(k.c);
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try {
          coalescer.stop();
          ws.close();
        } catch {}
        stats.maxFreezeMs = coalescer.maxFreeze;
        finalizeBench(stats);
        console.log(`\n=== BINGX BENCH 60s ===`);
        console.log(`raw msgs/s: ${stats.rawMsgsPerSec.toFixed(2)}`);
        console.log(`render updates/s: ${stats.renderPerSec.toFixed(2)}`);
        console.log(`unique prices: ${stats.uniquePrices}`);
        console.log(`max UI freeze: ${stats.maxFreezeMs}ms`);
        console.log(`max msg gap: ${stats.maxGap}ms`);
        console.log(`reconnects: ${stats.reconnects}`);
        console.log(`trade: ${stats.tradeMsgs}, kline: ${stats.klineMsgs}`);
        resolve(stats);
      }, durationMs);
    } catch {
      stats.errors++;
      finalizeBench(stats);
      resolve(stats);
    }
  });
}

async function main() {
  console.log("=== 60 SECOND PRODUCTION-LIKE BENCHMARK FOR 5 EXCHANGES BTC/USDT ===");
  const duration = 60000;
  const results: BenchStats[] = [];

  console.log("\n--- BINANCE ---");
  results.push(await benchBinance(duration));
  console.log("\n--- BYBIT ---");
  results.push(await benchBybit(duration));
  console.log("\n--- GATE ---");
  results.push(await benchGate(duration));
  console.log("\n--- KUCOIN ---");
  results.push(await benchKucoin(duration));
  console.log("\n--- BINGX ---");
  results.push(await benchBingx(duration));

  console.log("\n\n=== FINAL BENCHMARK TABLE ===");
  console.log("EXCHANGE | raw msgs/s | render updates/s | unique prices | max UI freeze | max gap | reconnects | trade | kline");
  for (const r of results) {
    console.log(
      `${r.exchange} | ${r.rawMsgsPerSec.toFixed(2)} | ${r.renderPerSec.toFixed(2)} | ${r.uniquePrices} | ${r.maxFreezeMs}ms | ${r.maxGap}ms | ${r.reconnects} | ${r.tradeMsgs} | ${r.klineMsgs}`
    );
  }

  console.log("\nGoal: no artificial 3s pauses, render 4-10/s, raw trade high freq, no fake smoothness");
}

main().catch(console.error);
