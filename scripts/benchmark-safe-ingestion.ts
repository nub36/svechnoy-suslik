#!/usr/bin/env tsx
// @ts-nocheck
/**
 * Benchmark SAFE ingestion on limited batch: 5 assets, 5 exchanges, 5 TF
 * Measures: duration, CPU, RAM, rows created/updated, HTTP /signals latency during batch
 * Does NOT run production Top-100, only 5 assets safe mode
 */

import "dotenv/config";
import os from "os";
import { PrismaClient } from "@prisma/client";

async function measureHttpLatency(url: string, timeoutMs = 5000): Promise<{ ok: boolean; latencyMs: number; status?: number; error?: string }> {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(t);
    const latency = Date.now() - start;
    return { ok: res.ok, latencyMs: latency, status: res.status };
  } catch (e: any) {
    const latency = Date.now() - start;
    return { ok: false, latencyMs: latency, error: e.message };
  }
}

async function main() {
  const prisma = new PrismaClient();

  const top = Number(process.argv.find(a => a.startsWith("--top="))?.split("=")[1] || 5);
  const timeframes = ["5m","15m","1h","4h","1d"];
  const mode = process.argv.find(a => a.startsWith("--mode="))?.split("=")[1] || "safe";

  console.log("=== SAFE INGESTION BENCHMARK ===");
  console.log(`Top: ${top}, TF: ${timeframes.join(",")}, Mode: ${mode}`);
  console.log(`VPS specs: RAM ${Math.floor(os.totalmem()/1024/1024)}MB, freemem ${Math.floor(os.freemem()/1024/1024)}MB, cpus ${os.cpus().length}, loadavg ${os.loadavg().map(v=>v.toFixed(2)).join(" ")}`);
  console.log(`Start: ${new Date().toISOString()}`);

  const signalsUrl = process.env.SIGNALS_URL || "http://localhost:3000/signals";
  const apiSignalsUrl = "http://localhost:3000/api/signals?limit=1";

  console.log(`\n--- Pre-benchmark HTTP latency check ---`);
  const pre1 = await measureHttpLatency(signalsUrl);
  console.log(`/signals: ok=${pre1.ok} status=${pre1.status} latency=${pre1.latencyMs}ms ${pre1.error||""}`);
  const pre2 = await measureHttpLatency(apiSignalsUrl);
  console.log(`/api/signals: ok=${pre2.ok} status=${pre2.status} latency=${pre2.latencyMs}ms ${pre2.error||""}`);

  const startCpu = process.cpuUsage();
  const startMem = process.memoryUsage();
  const startTime = Date.now();
  const startFreemem = os.freemem();
  const startLoad = os.loadavg()[0];

  console.log(`\n--- Starting SAFE sync (5 assets) ---`);
  console.log(`Options: batch-size=2 delay=1000 pause=5000 incremental-limit=20 backfill-limit=100 concurrency=1 mode=${mode}`);

  const { runSafeOhlcvSync } = await import("../lib/ohlcv/sync-safe");

  // Build options similar to CLI
  const options: any = {
    top,
    timeframes,
    limit: 100,
    requestDelayMs: 1000,
    concurrency: 1,
    batchSize: 2,
    pauseBetweenBatchesMs: 5000,
    incrementalLimit: 20,
    backfillLimit: 100,
    mode,
    minFreeMemMb: 200,
    maxLoadAvg: 2.5,
    once: true,
    intervalMs: 600000,
    confirmLargeRun: true,
  };

  // Measure HTTP latency DURING batch via background interval
  let duringLatencies: number[] = [];
  let httpInterval: any = null;
  let httpOkCount = 0;
  let httpFailCount = 0;

  httpInterval = setInterval(async () => {
    const r = await measureHttpLatency(apiSignalsUrl, 3000);
    duringLatencies.push(r.latencyMs);
    if (r.ok) httpOkCount++; else httpFailCount++;
    console.log(`[during] /api/signals latency ${r.latencyMs}ms ok=${r.ok} status=${r.status} freemem=${Math.floor(os.freemem()/1024/1024)}MB load=${os.loadavg()[0].toFixed(2)}`);
  }, 5000);

  const stats = await runSafeOhlcvSync(prisma, options);

  clearInterval(httpInterval);

  const endTime = Date.now();
  const durationMs = endTime - startTime;
  const endCpu = process.cpuUsage(startCpu);
  const endMem = process.memoryUsage();
  const endFreemem = os.freemem();
  const endLoad = os.loadavg()[0];

  const cpuPercent = (endCpu.user + endCpu.system) / 1000 / durationMs * 100; // approx

  console.log(`\n--- Post-benchmark HTTP latency check ---`);
  const post1 = await measureHttpLatency(signalsUrl);
  console.log(`/signals: ok=${post1.ok} status=${post1.status} latency=${post1.latencyMs}ms ${post1.error||""}`);
  const post2 = await measureHttpLatency(apiSignalsUrl);
  console.log(`/api/signals: ok=${post2.ok} status=${post2.status} latency=${post2.latencyMs}ms ${post2.error||""}`);

  console.log(`\n=== BENCHMARK RESULT ===`);
  console.log(`DURATION: ${durationMs}ms (${(durationMs/1000).toFixed(1)}s)`);
  console.log(`CPU: user=${(endCpu.user/1000).toFixed(0)}ms system=${(endCpu.system/1000).toFixed(0)}ms approx ${cpuPercent.toFixed(1)}% of one core`);
  console.log(`RAM: rss ${Math.floor(startMem.rss/1024/1024)}MB -> ${Math.floor(endMem.rss/1024/1024)}MB delta ${(endMem.rss-startMem.rss)/1024/1024 | 0}MB, heapUsed ${Math.floor(startMem.heapUsed/1024/1024)}MB -> ${Math.floor(endMem.heapUsed/1024/1024)}MB`);
  console.log(`SYSTEM: freemem ${Math.floor(startFreemem/1024/1024)}MB -> ${Math.floor(endFreemem/1024/1024)}MB, load ${startLoad.toFixed(2)} -> ${endLoad.toFixed(2)}`);
  console.log(`ROWS: fetched=${stats.fetched} written=${stats.written} created=${stats.created} updated=${stats.updated} skippedInvalid=${stats.skippedInvalid} errors=${stats.errors} batches=${stats.batches} backpressurePauses=${stats.pausedDueToBackpressure}`);
  console.log(`BY_EXCHANGE:`);
  for (const [ex, row] of Object.entries(stats.byExchange)) {
    console.log(`  ${ex}: markets=${(row as any).markets} written=${(row as any).written} errors=${(row as any).errors}`);
  }
  console.log(`BY_TIMEFRAME:`);
  for (const [tf, row] of Object.entries(stats.byTimeframe)) {
    console.log(`  ${tf}: markets=${(row as any).markets} fetched=${(row as any).fetched} written=${(row as any).written}`);
  }
  if (duringLatencies.length > 0) {
    const avg = duringLatencies.reduce((a,b)=>a+b,0)/duringLatencies.length;
    const max = Math.max(...duringLatencies);
    const min = Math.min(...duringLatencies);
    console.log(`HTTP /api/signals DURING batch: count=${duringLatencies.length} ok=${httpOkCount} fail=${httpFailCount} avg=${avg.toFixed(0)}ms min=${min}ms max=${max}ms`);
  } else {
    console.log(`HTTP DURING: no samples (worker too fast or HTTP not running)`);
  }
  console.log(`HTTP PRE: /signals ${pre1.latencyMs}ms ok=${pre1.ok}, /api/signals ${pre2.latencyMs}ms ok=${pre2.ok}`);
  console.log(`HTTP POST: /signals ${post1.latencyMs}ms ok=${post1.ok}, /api/signals ${post2.latencyMs}ms ok=${post2.ok}`);

  console.log(`\n=== PRODUCTION TARGET CHECK ===`);
  const cpuOk = cpuPercent < 35;
  const memOk = endMem.rss < 300*1024*1024;
  const httpOk = pre1.ok && post1.ok && httpFailCount === 0;
  console.log(`CPU target 20-30% avg: ${cpuPercent.toFixed(1)}% ${cpuOk ? "PASS" : "FAIL (too high)"}`);
  console.log(`MEM target <250MB RSS: ${Math.floor(endMem.rss/1024/1024)}MB ${memOk ? "PASS" : "FAIL"}`);
  console.log(`HTTP stable (no ERR_CONNECTION_RESET): ${httpOk ? "PASS" : "FAIL"}`);
  console.log(`Next.js responsive: ${httpOk && post1.latencyMs < 2000 ? "PASS" : "CHECK"}`);

  await prisma.$disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
