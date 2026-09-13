#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Diagnostic harness for 5 exchanges BTC/USDT raw streams — 30 sec per exchange
 * FIXED to distinguish WS_FRAMES vs TRADE_EVENTS vs TICKER_EVENTS vs KLINE_EVENTS
 * GATE root cause: was parsing result.p instead of result.price
 * BYBIT: one WS frame can contain array of trades — count TRADE_EVENTS separately
 * KUCOIN: ticker every 100ms more frequent than match
 */

type Exchange = "BINANCE" | "BYBIT" | "GATE" | "KUCOIN" | "BINGX";

type Stats = {
  exchange: Exchange;
  connectionType: string;
  connected: boolean;
  wsFrames: number;
  controlFrames: number;
  tradeEvents: number;
  tickerEvents: number;
  klineEvents: number;
  messagesReceived: number; // total frames
  messagesPerSec: number;
  priceUpdatesPerSec: number;
  uniquePrices: number;
  avgPriceInterval: number;
  maxPriceGap: number;
  maxGap: number;
  reconnects: number;
  errors: number;
  prices: Set<string>;
  priceTimes: number[];
  intervals: number[];
  lastTime: number;
  lastPriceTime: number;
  startTime: number;
  endTime: number;
};

function createStats(exchange: Exchange, connectionType: string): Stats {
  return {
    exchange,
    connectionType,
    connected: false,
    wsFrames: 0,
    controlFrames: 0,
    tradeEvents: 0,
    tickerEvents: 0,
    klineEvents: 0,
    messagesReceived: 0,
    messagesPerSec: 0,
    priceUpdatesPerSec: 0,
    uniquePrices: 0,
    avgPriceInterval: 0,
    maxPriceGap: 0,
    maxGap: 0,
    reconnects: 0,
    errors: 0,
    prices: new Set(),
    priceTimes: [],
    intervals: [],
    lastTime: 0,
    lastPriceTime: 0,
    startTime: Date.now(),
    endTime: 0,
  };
}

function finalizeStats(s: Stats) {
  s.endTime = Date.now();
  const durationSec = (s.endTime - s.startTime) / 1000;
  s.messagesPerSec = durationSec > 0 ? s.wsFrames / durationSec : 0;
  s.priceUpdatesPerSec = durationSec > 0 ? (s.tradeEvents + s.tickerEvents) / durationSec : 0;
  s.uniquePrices = s.prices.size;
  if (s.intervals.length > 0) {
    s.maxGap = Math.max(...s.intervals);
  }
  if (s.priceTimes.length > 1) {
    const gaps: number[] = [];
    for (let i = 1; i < s.priceTimes.length; i++) {
      gaps.push(s.priceTimes[i] - s.priceTimes[i - 1]);
    }
    if (gaps.length > 0) {
      const sum = gaps.reduce((a, b) => a + b, 0);
      s.avgPriceInterval = sum / gaps.length;
      s.maxPriceGap = Math.max(...gaps);
    }
  }
}

function printStats(s: Stats) {
  console.log(`\n=== ${s.exchange} ===`);
  console.log(`EXCHANGE: ${s.exchange}`);
  console.log(`CONNECTION TYPE: ${s.connectionType}`);
  console.log(`CONNECTED: ${s.connected}`);
  console.log(`WS_FRAMES: ${s.wsFrames}`);
  console.log(`CONTROL_FRAMES: ${s.controlFrames}`);
  console.log(`TRADE_EVENTS: ${s.tradeEvents}`);
  console.log(`TICKER_EVENTS: ${s.tickerEvents}`);
  console.log(`KLINE_EVENTS: ${s.klineEvents}`);
  console.log(`MESSAGES RECEIVED (frames): ${s.wsFrames}`);
  console.log(`MESSAGES/SEC (frames): ${s.messagesPerSec.toFixed(2)}`);
  console.log(`PRICE_UPDATES_PER_SEC (trade+ticker): ${s.priceUpdatesPerSec.toFixed(2)}`);
  console.log(`UNIQUE_PRICES: ${s.uniquePrices}`);
  console.log(`AVG_PRICE_INTERVAL: ${s.avgPriceInterval.toFixed(0)}ms`);
  console.log(`MAX_PRICE_GAP: ${s.maxPriceGap.toFixed(0)}ms`);
  console.log(`MAX_GAP (any msg): ${s.maxGap.toFixed(0)}ms`);
  console.log(`RECONNECTS: ${s.reconnects}`);
  console.log(`ERRORS: ${s.errors}`);
  console.log(`DURATION: ${((s.endTime - s.startTime) / 1000).toFixed(1)}s`);
}

async function testBinance(durationMs = 30000, symbolRaw = "BTC"): Promise<Stats> {
  const symbol = symbolRaw.toUpperCase();
  const binanceSym = `${symbol}USDT`.toLowerCase();
  const stats = createStats("BINANCE", `WebSocket combined trade+kline wss://stream.binance.com:9443/stream ${symbol}`);
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    try {
      const url = `wss://stream.binance.com:9443/stream?streams=${binanceSym}@trade/${binanceSym}@kline_5m`;
      ws = new WebSocket(url);

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
        stats.lastPriceTime = Date.now();
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const stream = msg.stream || "";
          const data = msg.data || msg;
          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.wsFrames++;
          stats.messagesReceived++;

          if (stream.includes("@trade") || data.e === "trade") {
            stats.tradeEvents++;
            if (data.p) {
              stats.prices.add(data.p);
              stats.priceTimes.push(now);
            }
          } else if (stream.includes("@kline") || data.e === "kline") {
            stats.klineEvents++;
            const k = data.k;
            if (k?.c) stats.prices.add(k.c);
          } else {
            stats.controlFrames++;
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;
      ws.onclose = () => {};

      setTimeout(() => {
        try { ws?.close(); } catch {}
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

async function testBybit(durationMs = 30000, symbolRaw = "BTC"): Promise<Stats> {
  const symbol = symbolRaw.toUpperCase();
  const bybitSym = `${symbol}USDT`;
  const stats = createStats("BYBIT", `WebSocket publicTrade+kline wss://stream.bybit.com/v5/public/spot ${symbol}`);
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    try {
      const url = "wss://stream.bybit.com/v5/public/spot";
      ws = new WebSocket(url);

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
        stats.lastPriceTime = Date.now();
        try {
          ws!.send(JSON.stringify({ op: "subscribe", args: [`publicTrade.${bybitSym}`, `kline.5.${bybitSym}`] }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.op === "pong" || msg.success) {
            stats.controlFrames++;
            return;
          }
          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.wsFrames++;

          if (msg.topic?.startsWith("publicTrade.")) {
            const trades = msg.data || [];
            // One WS frame can contain ARRAY of trades — count each
            for (const t of trades) {
              stats.tradeEvents++;
              if (t.p) {
                stats.prices.add(t.p);
                stats.priceTimes.push(now);
              }
            }
          } else if (msg.topic?.startsWith("kline.")) {
            stats.klineEvents++;
            for (const k of msg.data || []) {
              if (k.close) stats.prices.add(k.close);
            }
          } else {
            stats.controlFrames++;
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try { ws?.close(); } catch {}
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

async function testGate(durationMs = 30000, symbolRaw = "BTC"): Promise<Stats> {
  const symbol = symbolRaw.toUpperCase();
  const gateSym = `${symbol}_USDT`;
  const stats = createStats("GATE", `WebSocket spot.trades+spot.tickers+spot.candlesticks wss://api.gateio.ws/ws/v4/ ${symbol}`);
  return new Promise((resolve) => {
    let ws: WebSocket | null = null;
    try {
      const url = "wss://api.gateio.ws/ws/v4/";
      ws = new WebSocket(url);

      ws.onopen = () => {
        stats.connected = true;
        stats.startTime = Date.now();
        stats.lastTime = Date.now();
        stats.lastPriceTime = Date.now();
        const now = Math.floor(Date.now() / 1000);
        try {
          ws!.send(JSON.stringify({ time: now, channel: "spot.trades", event: "subscribe", payload: [gateSym] }));
          ws!.send(JSON.stringify({ time: now, channel: "spot.tickers", event: "subscribe", payload: [gateSym] }));
          ws!.send(JSON.stringify({ time: now, channel: "spot.candlesticks", event: "subscribe", payload: ["5m", gateSym] }));
        } catch {}
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.wsFrames++;

          if (msg.channel === "spot.trades" && msg.result) {
            const r = msg.result;
            const price = r.price ?? r.p;
            if (price) {
              stats.tradeEvents++;
              stats.prices.add(String(price));
              stats.priceTimes.push(now);
            }
          } else if (msg.channel === "spot.tickers" && msg.result) {
            const r = msg.result;
            const price = r.last ?? r.price;
            if (price) {
              stats.tickerEvents++;
              stats.prices.add(String(price));
              stats.priceTimes.push(now);
            }
          } else if (msg.channel === "spot.candlesticks" && msg.result) {
            stats.klineEvents++;
            if (msg.result.c) stats.prices.add(String(msg.result.c));
          } else {
            // Could be subscribe ack
            if (msg.event === "subscribe" || msg.channel === "spot.pong") {
              stats.controlFrames++;
            } else {
              // Log unknown for debugging
              // console.log("GATE unknown:", JSON.stringify(msg).slice(0,200));
              stats.controlFrames++;
            }
          }
        } catch (e) {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try { ws?.close(); } catch {}
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

async function testKucoin(durationMs = 30000, symbolRaw = "BTC"): Promise<Stats> {
  const symbol = symbolRaw.toUpperCase();
  const kucoinSym = `${symbol}-USDT`;
  const stats = createStats("KUCOIN", `WebSocket bullet-public + ticker+match+candles wss://ws-api-spot.kucoin.com/ ${symbol}`);
  return new Promise(async (resolve) => {
    try {
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
        stats.lastPriceTime = Date.now();
        try {
          const id = Date.now();
          ws.send(JSON.stringify({ id, type: "subscribe", topic: `/market/ticker:${kucoinSym}`, privateChannel: false, response: true }));
          ws.send(JSON.stringify({ id: id + 1, type: "subscribe", topic: `/market/match:${kucoinSym}`, privateChannel: false, response: true }));
          ws.send(JSON.stringify({ id: id + 2, type: "subscribe", topic: `/market/candles:${kucoinSym}_1min`, privateChannel: false, response: true }));
        } catch {}
        pingTimer = setInterval(() => {
          try { ws.send(JSON.stringify({ id: Date.now(), type: "ping" })); } catch {}
        }, pingInterval - 2000);
      };

      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data as string);
          if (msg.type === "welcome" || msg.type === "ack" || msg.type === "pong") {
            stats.controlFrames++;
            return;
          }
          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.wsFrames++;

          if (msg.topic?.startsWith("/market/ticker:")) {
            stats.tickerEvents++;
            if (msg.data?.price) {
              stats.prices.add(msg.data.price);
              stats.priceTimes.push(now);
            }
          } else if (msg.topic?.startsWith("/market/match:")) {
            stats.tradeEvents++;
            if (msg.data?.price) {
              stats.prices.add(msg.data.price);
              stats.priceTimes.push(now);
            }
          } else if (msg.topic?.startsWith("/market/candles:")) {
            stats.klineEvents++;
            const c = msg.data?.candles;
            if (Array.isArray(c) && c[2]) stats.prices.add(c[2]);
          } else {
            stats.controlFrames++;
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

async function testBingx(durationMs = 30000, symbolRaw = "BTC"): Promise<Stats> {
  const symbol = symbolRaw.toUpperCase();
  const bingxSym = `${symbol}-USDT`;
  const stats = createStats("BINGX", `WebSocket wss://open-api-ws.bingx.com/market trade+kline gzip ${symbol}`);
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
        stats.lastPriceTime = Date.now();
        try {
          const sub = (dt: string) => JSON.stringify({ id: `${Date.now()}-${Math.random()}`, reqType: "sub", dataType: dt });
          ws!.send(sub(`${bingxSym}@trade`));
          ws!.send(sub(`${bingxSym}@kline_5min`));
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
              for (const c of chunks) { merged.set(c, off); off += c.length; }
              text = new TextDecoder().decode(merged);
            } catch {
              text = new TextDecoder().decode(ev.data);
            }
          } else {
            text = String(ev.data);
          }

          if (!text) return;
          if (text.includes("ping") || text === "Ping") {
            try { ws!.send("Pong"); } catch {}
            stats.controlFrames++;
            return;
          }

          const now = Date.now();
          if (stats.lastTime) stats.intervals.push(now - stats.lastTime);
          stats.lastTime = now;
          stats.wsFrames++;

          const msg = JSON.parse(text);
          const dt = msg.dataType || "";
          if (dt.endsWith("@trade")) {
            const trades = msg.data;
            if (Array.isArray(trades)) {
              for (const t of trades) {
                if (t.p) {
                  stats.tradeEvents++;
                  stats.prices.add(t.p);
                  stats.priceTimes.push(now);
                }
              }
            } else if (trades?.p) {
              stats.tradeEvents++;
              stats.prices.add(trades.p);
              stats.priceTimes.push(now);
            }
          } else if (dt.includes("@kline_")) {
            stats.klineEvents++;
            const k = msg.data?.K || msg.data?.k || msg.data;
            if (k?.c) stats.prices.add(k.c);
          } else {
            stats.controlFrames++;
          }
        } catch {
          stats.errors++;
        }
      };

      ws.onerror = () => stats.errors++;

      setTimeout(() => {
        try { ws?.close(); } catch {}
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

function parseSymbolArg(): string {
  const arg = process.argv.find((a) => a.startsWith("--symbol="));
  if (arg) {
    const v = arg.split("=")[1]?.toUpperCase();
    if (v && /^[A-Z0-9]{1,20}$/.test(v)) return v;
  }
  return "BTC";
}

async function main() {
  const symbol = parseSymbolArg(); // BTC or SOL etc.
  console.log(`=== DIAGNOSTIC HARNESS FOR 5 EXCHANGES ${symbol}/USDT — 30s each (FIXED) ===`);
  console.log(`Start: ${new Date().toISOString()}`);
  console.log("Metrics: WS_FRAMES, CONTROL_FRAMES, TRADE_EVENTS, TICKER_EVENTS, KLINE_EVENTS, PRICE_UPDATES_PER_SEC, etc.");
  console.log("GATE root cause fix: was parsing result.p instead of result.price");

  const duration = 30000;
  const results: Stats[] = [];

  console.log(`\n--- Testing BINANCE ${symbol} ---`);
  results.push(await testBinance(duration, symbol));

  console.log(`\n--- Testing BYBIT ${symbol} ---`);
  results.push(await testBybit(duration, symbol));

  console.log(`\n--- Testing GATE (PRIORITY 1 FIX) ${symbol} ---`);
  results.push(await testGate(duration, symbol));

  console.log(`\n--- Testing KUCOIN (ticker+match) ${symbol} ---`);
  results.push(await testKucoin(duration, symbol));

  console.log(`\n--- Testing BINGX ${symbol} ---`);
  results.push(await testBingx(duration, symbol));

  console.log("\n\n=== SUMMARY TABLE ===");
  console.log("EXCHANGE | WS_FRAMES | CONTROL | TRADE_EVENTS | TICKER_EVENTS | KLINE_EVENTS | PRICE_UPDATES/SEC | UNIQUE | AVG_PRICE_INTERVAL | MAX_PRICE_GAP | MAX_GAP | RECONNECTS | ERRORS");
  for (const r of results) {
    console.log(
      `${r.exchange} | ${r.wsFrames} | ${r.controlFrames} | ${r.tradeEvents} | ${r.tickerEvents} | ${r.klineEvents} | ${r.priceUpdatesPerSec.toFixed(2)} | ${r.uniquePrices} | ${r.avgPriceInterval.toFixed(0)}ms | ${r.maxPriceGap.toFixed(0)}ms | ${r.maxGap.toFixed(0)}ms | ${r.reconnects} | ${r.errors}`
    );
  }

  console.log("\n=== ROOT CAUSE ANALYSIS ===");
  for (const r of results) {
    if (r.exchange === "GATE") {
      console.log(`GATE: tradeEvents=${r.tradeEvents} tickerEvents=${r.tickerEvents} — if trade still 0 but ticker>0, use ticker for LIVE PRICE; if both 0, subscription/parser still wrong`);
    }
    if (r.exchange === "BYBIT") {
      console.log(`BYBIT: tradeEvents=${r.tradeEvents} (individual trades, not frames) — one frame can contain array of trades, so tradeEvents should be >= wsFrames if high freq`);
    }
    if (r.exchange === "KUCOIN") {
      console.log(`KUCOIN: tickerEvents=${r.tickerEvents} tradeEvents=${r.tradeEvents} — ticker every 100ms expected more frequent, use ticker for LIVE PRICE`);
    }
  }

  console.log("\n=== END ===");
}

main().catch(console.error);
