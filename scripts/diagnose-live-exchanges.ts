#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Diagnostic harness for 5 exchanges BTC/USDT raw streams — 30 sec per exchange
 * Measures: EXCHANGE, CONNECTION TYPE, CONNECTED, MESSAGES RECEIVED, MESSAGES/SEC, UNIQUE PRICE VALUES, AVG INTERVAL, MAX GAP, RECONNECTS, ERRORS
 * Separately: trade/ticker vs kline
 * No React, raw exchange WS
 */

type Exchange = "BINANCE" | "BYBIT" | "GATE" | "KUCOIN" | "BINGX";

type Stats = {
  exchange: Exchange;
  connectionType: string;
  connected: boolean;
  messagesReceived: number;
  messagesPerSec: number;
  uniquePriceValues: number;
  avgIntervalMs: number;
  maxGapMs: number;
  reconnects: number;
  errors: number;
  tradeMessages: number;
  klineMessages: number;
  prices: Set<string>;
  intervals: number[];
  lastTime: number;
  startTime: number;
  endTime: number;
};

function createStats(exchange: Exchange, connectionType: string): Stats {
  return {
    exchange,
    connectionType,
    connected: false,
    messagesReceived: 0,
    messagesPerSec: 0,
    uniquePriceValues: 0,
    avgIntervalMs: 0,
    maxGapMs: 0,
    reconnects: 0,
    errors: 0,
    tradeMessages: 0,
    klineMessages: 0,
    prices: new Set(),
    intervals: [],
    lastTime: 0,
    startTime: Date.now(),
    endTime: 0,
  };
}

function finalizeStats(s: Stats) {
  s.endTime = Date.now();
  const durationSec = (s.endTime - s.startTime) / 1000;
  s.messagesPerSec = durationSec > 0 ? s.messagesReceived / durationSec : 0;
  s.uniquePriceValues = s.prices.size;
  if (s.intervals.length > 0) {
    const sum = s.intervals.reduce((a, b) => a + b, 0);
    s.avgIntervalMs = sum / s.intervals.length;
    s.maxGapMs = Math.max(...s.intervals);
  }
}

function printStats(s: Stats) {
  console.log(`\n=== ${s.exchange} ===`);
  console.log(`EXCHANGE: ${s.exchange}`);
  console.log(`CONNECTION TYPE: ${s.connectionType}`);
  console.log(`CONNECTED: ${s.connected}`);
  console.log(`MESSAGES RECEIVED: ${s.messagesReceived}`);
  console.log(`MESSAGES/SEC: ${s.messagesPerSec.toFixed(2)}`);
  console.log(`UNIQUE PRICE VALUES: ${s.uniquePriceValues}`);
  console.log(`AVG INTERVAL: ${s.avgIntervalMs.toFixed(0)}ms`);
  console.log(`MAX GAP: ${s.maxGapMs.toFixed(0)}ms`);
  console.log(`RECONNECTS: ${s.reconnects}`);
  console.log(`ERRORS: ${s.errors}`);
  console.log(`TRADE MESSAGES: ${s.tradeMessages}`);
  console.log(`KLINE MESSAGES: ${s.klineMessages}`);
  console.log(`DURATION: ${((s.endTime - s.startTime) / 1000).toFixed(1)}s`);
}

async function testBinance(durationMs = 30000): Promise<Stats> {
  const stats = createStats("BINANCE", "WebSocket combined trade+kline wss://stream.binance.com:9443/stream");
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    try {
      const url = "wss://stream.binance.com:9443/stream?streams=btcusdt@trade/btcusdt@kline_5m";
      ws = new WebSocket(url);
      stats.connected = false;

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const stream = msg.stream || "";
          const data = msg.data || msg;
          const now = Date.now();
          if (stats.lastTime) {
            stats.intervals.push(now - stats.lastTime);
          }
          stats.lastTime = now;
          stats.messagesReceived++;

          if (stream.includes("@trade") || data.e === "trade") {
            stats.tradeMessages++;
            if (data.p) stats.prices.add(data.p);
          } else if (stream.includes("@kline") || data.e === "kline") {
            stats.klineMessages++;
            const k = data.k;
            if (k?.c) stats.prices.add(k.c);
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => {
        stats.errors++;
      };

      ws.onclose = () => {
        if (stats.connected) {
          // if closed early, count as reconnect attempt but we finalize
        }
      };

      setTimeout(() => {
        try {
          ws?.close();
        } catch {}
        finalizeStats(stats);
        printStats(stats);
        resolve(stats);
      }, durationMs);
    } catch (e) {
      stats.errors++;
      finalizeStats(stats);
      printStats(stats);
      resolve(stats);
    }
  });
}

async function testBybit(durationMs = 30000): Promise<Stats> {
  const stats = createStats("BYBIT", "WebSocket publicTrade+kline wss://stream.bybit.com/v5/public/spot");
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    try {
      const url = "wss://stream.bybit.com/v5/public/spot";
      ws = new WebSocket(url);

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
        try {
          ws!.send(JSON.stringify({ op: "subscribe", args: ["publicTrade.BTCUSDT", "kline.5.BTCUSDT"] }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.op === "pong" || msg.success) return;
          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.messagesReceived++;

          if (msg.topic?.startsWith("publicTrade.")) {
            stats.tradeMessages++;
            for (const t of msg.data || []) {
              if (t.p) stats.prices.add(t.p);
            }
          } else if (msg.topic?.startsWith("kline.")) {
            stats.klineMessages++;
            for (const k of msg.data || []) {
              if (k.close) stats.prices.add(k.close);
            }
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;
      ws.onclose = () => {};

      setTimeout(() => {
        try {
          ws?.close();
        } catch {}
        finalizeStats(stats);
        printStats(stats);
        resolve(stats);
      }, durationMs);
    } catch {
      stats.errors++;
      finalizeStats(stats);
      printStats(stats);
      resolve(stats);
    }
  });
}

async function testGate(durationMs = 30000): Promise<Stats> {
  const stats = createStats("GATE", "WebSocket spot.trades+spot.candlesticks wss://api.gateio.ws/ws/v4/");
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    try {
      const url = "wss://api.gateio.ws/ws/v4/";
      ws = new WebSocket(url);

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
        const now = Math.floor(Date.now() / 1000);
        try {
          ws!.send(JSON.stringify({ time: now, channel: "spot.trades", event: "subscribe", payload: ["BTC_USDT"] }));
          ws!.send(JSON.stringify({ time: now, channel: "spot.candlesticks", event: "subscribe", payload: ["5m", "BTC_USDT"] }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.messagesReceived++;

          if (msg.channel === "spot.trades" && msg.result?.p) {
            stats.tradeMessages++;
            stats.prices.add(msg.result.p);
          } else if (msg.channel === "spot.candlesticks" && msg.result?.c) {
            stats.klineMessages++;
            stats.prices.add(msg.result.c);
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try {
          ws?.close();
        } catch {}
        finalizeStats(stats);
        printStats(stats);
        resolve(stats);
      }, durationMs);
    } catch {
      stats.errors++;
      finalizeStats(stats);
      printStats(stats);
      resolve(stats);
    }
  });
}

async function testKucoin(durationMs = 30000): Promise<Stats> {
  const stats = createStats("KUCOIN", "WebSocket bullet-public + /market/match + /market/candles wss://ws-api-spot.kucoin.com/");
  return new Promise(async (resolve) => {
    try {
      // Fetch bullet token
      const res = await fetch("https://api.kucoin.com/api/v1/bullet-public", { method: "POST" });
      if (!res.ok) throw new Error(`bullet HTTP ${res.status}`);
      const bullet = await res.json();
      if (bullet.code !== "200000" || !bullet.data?.token) throw new Error("bullet token failed");
      const endpoint = bullet.data.instanceServers[0].endpoint;
      const token = bullet.data.token;
      const pingInterval = bullet.data.instanceServers[0].pingInterval || 18000;

      const url = `${endpoint}?token=${token}&connectId=${Date.now()}`;
      const ws = new WebSocket(url);
      let pingTimer: any = null;

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
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
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.messagesReceived++;

          if (msg.topic?.startsWith("/market/match:")) {
            stats.tradeMessages++;
            if (msg.data?.price) stats.prices.add(msg.data.price);
          } else if (msg.topic?.startsWith("/market/candles:")) {
            stats.klineMessages++;
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
          ws.close();
        } catch {}
        finalizeStats(stats);
        printStats(stats);
        resolve(stats);
      }, durationMs);
    } catch (e: any) {
      console.error(`KUCOIN error: ${e.message}`);
      stats.errors++;
      finalizeStats(stats);
      printStats(stats);
      resolve(stats);
    }
  });
}

async function testBingx(durationMs = 30000): Promise<Stats> {
  const stats = createStats("BINGX", "WebSocket wss://open-api-ws.bingx.com/market trade+kline gzip");
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    try {
      const url = "wss://open-api-ws.bingx.com/market";
      ws = new WebSocket(url);
      // @ts-ignore
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
        try {
          const sub = (dt: string) => JSON.stringify({ id: `${Date.now()}-${Math.random()}`, reqType: "sub", dataType: dt });
          ws!.send(sub("BTC-USDT@trade"));
          ws!.send(sub("BTC-USDT@kline_5min"));
        } catch {}
      };

      ws.onmessage = async (ev) => {
        try {
          let text: string;
          if (typeof ev.data === "string") {
            text = ev.data;
          } else if (ev.data instanceof ArrayBuffer) {
            // Try decompress with DecompressionStream if available, else TextDecoder
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
              // Fallback try as text
              text = new TextDecoder().decode(ev.data);
            }
          } else {
            text = String(ev.data);
          }

          if (!text) return;
          if (text.includes("ping") || text === "Ping") {
            try {
              ws!.send("Pong");
            } catch {}
            return;
          }

          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.messagesReceived++;

          const msg = JSON.parse(text);
          const dt = msg.dataType || "";
          if (dt.endsWith("@trade")) {
            stats.tradeMessages++;
            const trades = msg.data;
            if (Array.isArray(trades)) {
              for (const t of trades) {
                if (t.p) stats.prices.add(t.p);
              }
            } else if (trades?.p) {
              stats.prices.add(trades.p);
            }
          } else if (dt.includes("@kline_")) {
            stats.klineMessages++;
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
          ws?.close();
        } catch {}
        finalizeStats(stats);
        printStats(stats);
        resolve(stats);
      }, durationMs);
    } catch {
      stats.errors++;
      finalizeStats(stats);
      printStats(stats);
      resolve(stats);
    }
  });
}

async function main() {
  console.log("=== DIAGNOSTIC HARNESS FOR 5 EXCHANGES BTC/USDT — 30s each ===");
  console.log(`Start: ${new Date().toISOString()}`);

  const duration = 30000;

  const results: Stats[] = [];

  console.log("\n--- Testing BINANCE ---");
  results.push(await testBinance(duration));

  console.log("\n--- Testing BYBIT ---");
  results.push(await testBybit(duration));

  console.log("\n--- Testing GATE ---");
  results.push(await testGate(duration));

  console.log("\n--- Testing KUCOIN ---");
  results.push(await testKucoin(duration));

  console.log("\n--- Testing BINGX ---");
  results.push(await testBingx(duration));

  console.log("\n\n=== SUMMARY TABLE ===");
  console.log("EXCHANGE | TYPE | CONNECTED | MSGS | MSGS/SEC | UNIQUE PRICES | AVG INTERVAL | MAX GAP | RECONNECTS | ERRORS | TRADE | KLINE");
  for (const r of results) {
    console.log(
      `${r.exchange} | ${r.connectionType.slice(0, 30)} | ${r.connected} | ${r.messagesReceived} | ${r.messagesPerSec.toFixed(2)} | ${r.uniquePriceValues} | ${r.avgIntervalMs.toFixed(0)}ms | ${r.maxGapMs.toFixed(0)}ms | ${r.reconnects} | ${r.errors} | ${r.tradeMessages} | ${r.klineMessages}`
    );
  }

  console.log("\n=== RAW VALIDATION ===");
  console.log("Check if trade stream is high freq (>1 msg/sec for BTC) vs kline (often 1-2 sec)");
  for (const r of results) {
    const freq = r.tradeMessages > 10 ? "HIGH FREQ (good for LIVE PRICE)" : r.tradeMessages > 0 ? "LOW FREQ" : "NO TRADE";
    const klineFreq = r.klineMessages > 0 ? `${r.klineMessages} kline msgs in 30s` : "NO KLINE";
    console.log(`${r.exchange}: trade ${freq}, kline ${klineFreq}`);
  }

  console.log("\n=== END ===");
}

main().catch(console.error);
