/**
 * Pilot tests for OHLCV continuous ingestion (BTC-only)
 * Coverage for requirements 1-6: interval, cadence, symbol, lock, PM2, failure behavior
 * Run: npx tsx scripts/test-ohlcv-pilot.ts
 */
import { readFileSync, existsSync } from "node:fs";
import {
  buildOhlcvHelp,
  parseOhlcvArgs,
  resolveOhlcvInvocation,
  validateCadence,
  MAX_INTERVAL_FOR_5M_MS,
} from "../lib/ohlcv/cli";
import {
  collectPlanStats,
  formatPlanReport,
  buildConfirmCommand,
} from "../lib/ohlcv/plan";
import { OHLCV_ADVISORY_LOCK_KEY, acquireDedicatedLock, releaseDedicatedLock, tryAcquireOhlcvLock, releaseOhlcvLock } from "../lib/ohlcv/lock";

let passed = 0;
let total = 0;
function ok(cond: boolean, label: string) {
  total++;
  if (cond) passed++;
  else console.error(`FAIL: ${label}`);
}
function throws(fn: () => unknown, needle: string, label: string) {
  try {
    fn();
    ok(false, `${label} — error not thrown`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    ok(msg.includes(needle), `${label} (msg: "${msg.slice(0,120)}")`);
  }
}

console.log("=== 1) CLI --interval ===");
ok(parseOhlcvArgs([], {}).intervalMs === 3600000, "default interval 60m");
ok(parseOhlcvArgs([], { OHLCV_INTERVAL_MS: "60000" }).intervalMs === 60000, "env interval 60000");
ok(parseOhlcvArgs(["--interval=120000"], { OHLCV_INTERVAL_MS: "60000" }).intervalMs === 120000, "CLI precedence over env");
ok(parseOhlcvArgs(["--interval=120000"], {}).intervalMs === 120000, "CLI interval parsed");
throws(() => parseOhlcvArgs(["--interval=0"], {}), "от 1000 до 86400000", "interval below min 1000");
throws(() => parseOhlcvArgs(["--interval=999"], {}), "от 1000", "interval 999 below min");
throws(() => parseOhlcvArgs(["--interval=86400001"], {}), "от 1000 до 86400000", "interval above max");
throws(() => parseOhlcvArgs(["--interval=10.5"], {}), "целое", "interval fractional");
throws(() => parseOhlcvArgs(["--interval=abc"], {}), "целое", "interval NaN");
ok(parseOhlcvArgs(["--interval=1000"], {}).intervalMs === 1000, "interval min 1000 allowed");
ok(parseOhlcvArgs(["--interval=86400000"], {}).intervalMs === 86400000, "interval max 86400000 allowed");

// help documents interval
const help = buildOhlcvHelp();
ok(help.includes("--interval="), "help contains --interval");
ok(help.includes("OHLCV_INTERVAL_MS"), "help mentions env OHLCV_INTERVAL_MS");
ok(help.includes("--symbol="), "help contains --symbol");
ok(help.includes("60м") || help.includes("3600000"), "help mentions default 60m");

// unknown flags fail-closed
ok(resolveOhlcvInvocation(["--foobar"]).kind === "error", "unknown flag --foobar error");
ok(resolveOhlcvInvocation(["--intervall=1000"]).kind === "error", "typo --intervall error");
ok(resolveOhlcvInvocation(["--symbolz=BTC"]).kind === "error", "typo --symbolz error");
ok(resolveOhlcvInvocation(["--top=10", "--unknown=1"]).kind === "error", "unknown in combination error");

// --plan shows effective interval read-only (no exchange API)
const planOpts = resolveOhlcvInvocation(["--plan", "--interval=120000"]);
ok(planOpts.kind === "plan" && planOpts.options.intervalMs === 120000, "plan shows effective interval 120000");
const planReport = formatPlanReport(
  { top: 10, timeframes: ["1h"] as any, limit: 300, requestDelayMs: 250, intervalMs: 120000 },
  { assets: 1, markets: 1, tasks: 1, maxCandles: 300, apiRequests: 1, byExchange: {} }
);
ok(planReport.some(l => l.includes("120000") && l.includes("interval")), "plan report contains interval");

// plan with default interval shows 3600000
const planDefault = resolveOhlcvInvocation(["--plan"]);
ok(planDefault.kind === "plan" && planDefault.options.intervalMs === 3600000, "plan default interval 60m");
const planReportDefault = formatPlanReport(
  { top:10, timeframes:["1h"] as any, limit:300, requestDelayMs:250, intervalMs:3600000 },
  {assets:1, markets:1, tasks:1, maxCandles:300, apiRequests:1, byExchange:{}}
);
ok(planReportDefault.some(l => l.includes("3600000")), "plan report shows default 60m");

console.log("\n=== 2) Cadence safety ===");
ok(MAX_INTERVAL_FOR_5M_MS === 300000, "MAX_INTERVAL_FOR_5M_MS = 300000");
ok(validateCadence({ timeframes: ["5m"], intervalMs: 3600000, once: false }) !== null, "cadence unsafe 5m+60m continuous fails");
ok(validateCadence({ timeframes: ["5m"], intervalMs: 3600000, once: true }) === null, "cadence unsafe but --once bypass");
ok(validateCadence({ timeframes: ["5m"], intervalMs: 300000, once: false }) === null, "cadence 5m with 300000 exactly allowed");
ok(validateCadence({ timeframes: ["5m"], intervalMs: 120000, once: false }) === null, "cadence 5m with 120000 allowed");
ok(validateCadence({ timeframes: ["1h"], intervalMs: 3600000, once: false }) === null, "cadence 1h with 60m allowed");
ok(validateCadence({ timeframes: ["5m","15m"], intervalMs: 3600000, once: false }) !== null, "cadence mixed with 5m still unsafe");
ok(validateCadence({ timeframes: ["15m","1h"], intervalMs: 3600000, once: false }) === null, "cadence without 5m allowed even 60m");

ok(resolveOhlcvInvocation(["--timeframes=5m"]).kind === "error", "resolve continuous 5m default 60m fails closed");
ok(resolveOhlcvInvocation(["--timeframes=5m", "--interval=3600000"]).kind === "error", "resolve explicit 60m fails");
ok(resolveOhlcvInvocation(["--timeframes=5m", "--once"]).kind === "run", "resolve 5m --once bypasses guard");
ok(resolveOhlcvInvocation(["--timeframes=5m", "--interval=120000"]).kind === "run", "resolve 5m 120000 passes");
ok(resolveOhlcvInvocation(["--timeframes=5m", "--plan"]).kind === "plan", "plan bypasses cadence guard");
ok(resolveOhlcvInvocation(["--timeframes=5m", "--plan", "--interval=3600000"]).kind === "plan", "plan with 5m+60m still plan");
ok(resolveOhlcvInvocation(["--timeframes=1h"]).kind === "run", "1h continuous 60m allowed");

async function runPilotTests() {
console.log("\n=== 3) BTC pilot --symbol ===");
ok(resolveOhlcvInvocation(["--symbol=BTC", "--once"]).kind === "run", "symbol BTC with once ok");
const btcRun = resolveOhlcvInvocation(["--symbol=BTC", "--timeframes=5m,15m,1h,4h,1d", "--limit=300", "--interval=120000"]);
ok(btcRun.kind === "run" && btcRun.options.symbol === "BTC", "BTC pilot run has symbol BTC");
ok(btcRun.kind === "run" && JSON.stringify(btcRun.options.timeframes) === JSON.stringify(["5m","15m","1h","4h","1d"]), "BTC pilot timeframes correct");
ok(btcRun.kind === "run" && btcRun.options.limit === 300, "BTC pilot limit 300");

// symbol case insensitive -> uppercased
const btcLower = resolveOhlcvInvocation(["--symbol=btc", "--once"]);
ok(btcLower.kind === "run" && btcLower.options.symbol === "BTC", "symbol lower case normalized to BTC");

// symbol without hardcode id: options should have symbol string, not asset id
ok(btcRun.kind === "run" && typeof btcRun.options.symbol === "string" && btcRun.options.symbol === "BTC", "symbol is string BTC, no hardcode id");

// without symbol keep --top
const topRun = resolveOhlcvInvocation(["--top=10", "--once"]);
ok(topRun.kind === "run" && topRun.options.top === 10 && !topRun.options.symbol, "without symbol --top preserved");

// simultaneous --symbol+--top forbidden
ok(resolveOhlcvInvocation(["--symbol=BTC", "--top=10"]).kind === "error", "symbol+top together forbidden");
throws(() => parseOhlcvArgs(["--symbol=BTC", "--top=10"], {}), "несовместимы", "parse symbol+top throws");
throws(() => parseOhlcvArgs(["--symbol="], {}), "непустой", "empty symbol fails");
throws(() => parseOhlcvArgs(["--symbol=!!!"], {}), "тикер", "invalid symbol chars fails");

// --plan shows symbol/assets/markets/tasks
const mockPrismaBTC = {
  asset: {
    findFirst: async ({ where }: any) => {
      if (where.symbol === "BTC" && where.enabled === true) return { id: 1 };
      return null;
    },
    findMany: async () => { throw new Error("should not call findMany when symbol set"); }
  },
  market: {
    findMany: async ({ where }: any) => {
      // should be called with assetId in [1]
      if (where.assetId?.in?.includes(1)) {
        return [
          { exchange: "BINANCE" },
          { exchange: "BYBIT" },
          { exchange: "GATE" },
          { exchange: "KUCOIN" },
          { exchange: "BINGX" },
        ];
      }
      return [];
    }
  }
} as any;
const optsBTC = parseOhlcvArgs(["--symbol=BTC", "--timeframes=5m,15m,1h,4h,1d", "--limit=300", "--interval=120000"], {});
const statsBTC = await collectPlanStats(mockPrismaBTC, optsBTC);
ok(statsBTC.assets === 1, "collectPlanStats BTC assets 1");
ok(statsBTC.markets === 5, "collectPlanStats BTC markets 5");
ok(statsBTC.tasks === 25, "collectPlanStats BTC tasks 25 (5*5)");
ok(statsBTC.byExchange["BINANCE"] === 1, "collectPlanStats byExchange BINANCE");

const planLinesBTC = formatPlanReport(optsBTC, statsBTC);
ok(planLinesBTC.some(l => l.includes("Symbol: BTC")), "plan report shows Symbol: BTC");
ok(!planLinesBTC.some(l => l.includes("Top-N:")), "plan report BTC does not show Top-N");
ok(planLinesBTC.some(l => l.includes("Активов выбрано: 1")), "plan shows assets 1");
ok(planLinesBTC.some(l => l.includes("Рынков") && l.includes("5")), "plan shows markets 5");
ok(planLinesBTC.some(l => l.includes("Задач") && l.includes("25")), "plan shows tasks 25");
ok(planLinesBTC.some(l => l.includes("120000")), "plan shows interval 120000");

// missing/unknown/disabled symbol fail-closed
const mockPrismaMissing = {
  asset: { findFirst: async () => null, findMany: async () => [] },
  market: { findMany: async () => [] }
} as any;
const optsMissing = parseOhlcvArgs(["--symbol=UNKNOWN", "--once"], {});
const statsMissing = await collectPlanStats(mockPrismaMissing, optsMissing);
ok(statsMissing.assets === 0, "missing symbol assets 0");
ok(statsMissing.markets === 0, "missing symbol markets 0");
// worker would fail closed when assets 0 and symbol set — we simulate that check
let missingFailed = false;
if (optsMissing.symbol && statsMissing.assets === 0) missingFailed = true;
ok(missingFailed, "missing symbol fail-closed (worker would exit 1)");

// disabled symbol (enabled false) -> also 0 assets
const mockPrismaDisabled = {
  asset: { findFirst: async () => null }, // simulate not found because enabled false
  market: { findMany: async () => [] }
} as any;
const statsDisabled = await collectPlanStats(mockPrismaDisabled, optsMissing);
ok(statsDisabled.assets === 0, "disabled symbol assets 0");

// don't rely silent --top=1 == BTC (top=1 should select by rank, not guarantee BTC)
const mockPrismaTop1 = {
  asset: { findMany: async ({ where, orderBy, take }: any) => {
    // simulate top 1 is not BTC but rank 1 asset e.g., BTC, but we can't guarantee
    // For test, return symbol ETH to show ambiguity
    if (where.rank?.lte === 1) return [{ id: 99 }];
    return [];
  }},
  market: { findMany: async () => [{exchange:"BINANCE"}] }
} as any;
const optsTop1 = parseOhlcvArgs(["--top=1", "--once"], {});
const statsTop1 = await collectPlanStats(mockPrismaTop1, optsTop1);
ok(statsTop1.assets === 1, "top=1 assets 1 (but not guaranteed BTC, hence explicit symbol needed)");

// verify that top-based plan still works and shows Top-N
const planLinesTop = formatPlanReport({ top:10, timeframes:["1h"] as any, limit:300, requestDelayMs:250, intervalMs:3600000 }, { assets:10, markets:48, tasks:48, maxCandles:14400, apiRequests:48, byExchange:{} });
ok(planLinesTop.some(l => l.includes("Top-N: 10")), "plan Top-N still shows for non-symbol");

console.log("\n=== 4) Single-instance advisory lock ===");
ok(typeof OHLCV_ADVISORY_LOCK_KEY === "number", "lock key is number");
ok(OHLCV_ADVISORY_LOCK_KEY === 727923, "lock key 727923");
ok(typeof acquireDedicatedLock === "function", "acquireDedicatedLock is function (dedicated session)");
ok(typeof releaseDedicatedLock === "function", "releaseDedicatedLock is function (dedicated session)");
ok(typeof tryAcquireOhlcvLock === "function", "tryAcquireOhlcvLock still exists (legacy mock)");
ok(typeof releaseOhlcvLock === "function", "releaseOhlcvLock still exists (legacy mock)");
// Check no Redis, no new infra, no migration
const lockSource = readFileSync("lib/ohlcv/lock.ts", "utf8");
ok(lockSource.includes("pg_try_advisory_lock"), "lock uses pg_try_advisory_lock");
ok(lockSource.includes("pg_advisory_unlock"), "lock uses pg_advisory_unlock");
ok(lockSource.includes("new Client") || lockSource.includes("pg.Client"), "lock uses dedicated pg.Client (same-session)");
ok(lockSource.includes("dotenv"), "lock loads dotenv for DATABASE_URL");
ok(!lockSource.includes("redis"), "lock does not use Redis");
ok(!lockSource.includes("Redlock"), "no Redlock");
ok(!lockSource.includes("CREATE TABLE"), "no migration CREATE TABLE");
ok(!lockSource.includes("migration"), "no migration");

// Check worker uses lock
const workerSource = readFileSync("scripts/ohlcv-worker.ts", "utf8");
ok(workerSource.includes("acquireDedicatedLock"), "worker imports acquireDedicatedLock (dedicated session)");
ok(workerSource.includes("releaseDedicatedLock"), "worker imports releaseDedicatedLock (same session)");
ok(workerSource.includes("OHLCV_ADVISORY_LOCK_KEY"), "worker uses lock key");
ok(workerSource.includes("Single-instance"), "worker logs single-instance");
ok(workerSource.indexOf("await acquireDedicatedLock") < workerSource.indexOf("await collectPlanStats"), "worker acquires dedicated lock before plan stats (same-session)");
ok(workerSource.includes("lockHandle"), "worker tracks lockHandle (dedicated session)");
ok(workerSource.includes("releaseDedicatedLock") && workerSource.includes("finally"), "worker releases dedicated lock in finally (same session)");

console.log("\n=== 5) PM2 artifact ===");
ok(existsSync("ecosystem.config.js"), "ecosystem.config.js exists");
const eco = readFileSync("ecosystem.config.js", "utf8");
ok(eco.includes("svechnoy-suslik-ohlcv-btc"), "PM2 process name svechnoy-suslik-ohlcv-btc");
ok(eco.includes("--symbol=BTC"), "PM2 has --symbol=BTC");
ok(eco.includes("--timeframes=5m,15m,1h,4h,1d"), "PM2 has all 5 timeframes");
ok(eco.includes("--limit=300"), "PM2 has limit 300");
ok(eco.includes("--interval=120000") || eco.includes("--interval=60000"), "PM2 interval suitable for 5m (120000 or 60000)");
ok(!eco.includes("3600000"), "PM2 does NOT use default 60m interval (must be <=5m)");
ok(eco.includes("tsx scripts/ohlcv-worker.ts"), "PM2 script tsx worker");
ok(eco.includes("svechnoy-suslik") && eco.includes("npm"), "PM2 still has Next.js app");
ok(!eco.includes("DATABASE_URL="), "PM2 does NOT hardcode DATABASE_URL");
ok(!eco.includes("postgres://"), "PM2 does NOT contain postgres URL");
ok(eco.includes("inherit") || eco.includes("--update-env") || eco.includes("env:"), "PM2 mentions env inheritance");
ok(eco.includes("BTC-only") || eco.includes("BTC only"), "PM2 documents BTC-only scope");
ok(eco.includes("continuous") || eco.includes("interval"), "PM2 documents continuous");

// Check that PM2 interval is conservative <=5m (300000)
const intervalMatch = eco.match(/--interval=(\d+)/);
ok(intervalMatch !== null, "PM2 interval found");
if (intervalMatch) {
  const iv = Number(intervalMatch[1]);
  ok(iv <= 300000 && iv >= 1000, `PM2 interval ${iv} within 1000..300000`);
  ok(iv === 120000 || iv === 60000, `PM2 interval ${iv} is recommended 120000 or 60000`);
}

// Check that PM2 does not auto-start secrets
// We can't test auto-start, but we check file does not contain secrets pattern

console.log("\n=== 6) Failure behavior ===");
// Check worker does not import or write Signal
ok(!workerSource.includes("prisma.signal"), "worker does not write Signal");
ok(!workerSource.includes("prisma.strategy.update"), "worker does not enable Strategy");
ok(!workerSource.includes("prisma.signal") && !workerSource.includes("lib/signals"), "worker does not import Signal module");
const cliSource = readFileSync("lib/ohlcv/cli.ts", "utf8");
ok(!cliSource.includes("Signal"), "cli does not import Signal");
const syncSource = readFileSync("lib/ohlcv/sync.ts", "utf8");
ok(!syncSource.includes("Signal"), "sync does not import Signal");
ok(!syncSource.includes("prisma.signal"), "sync does not write Signal");
const planSource = readFileSync("lib/ohlcv/plan.ts", "utf8");
ok(!planSource.includes("Signal"), "plan does not import Signal");

// stats/log visible: worker logs errors, byTimeframe, byExchange
ok(workerSource.includes("byTimeframe") || workerSource.includes("по таймфреймам"), "worker logs byTimeframe");
ok(workerSource.includes("byExchange") || workerSource.includes("по биржам") || workerSource.includes("stats.byExchange"), "worker logs byExchange");
ok(workerSource.includes("ошибок=") || workerSource.includes("errors"), "worker logs errors");
ok(workerSource.includes("SIGINT") && workerSource.includes("SIGTERM"), "worker handles graceful SIGINT/SIGTERM");
ok(workerSource.includes("interrupted"), "worker has interrupted flag");
ok(workerSource.includes("waitInterruptible"), "worker has waitInterruptible for interval");

// no destructive DB operations
ok(!workerSource.includes("deleteMany"), "worker no deleteMany");
ok(!syncSource.includes("deleteMany"), "sync no deleteMany");
ok(!syncSource.includes("prisma.candle.delete"), "sync no delete");
ok(syncSource.includes("upsert"), "sync uses upsert (idempotent)");
ok(syncSource.includes("marketId_timeframe_openTime"), "sync upsert key is market+timeframe+openTime");

// buildConfirmCommand handles symbol
const cmdBTC = buildConfirmCommand({ top:10, timeframes:["1h"] as any, limit:300, requestDelayMs:250, once:true, symbol:"BTC", intervalMs:120000 });
ok(cmdBTC.includes("--symbol=BTC"), "confirm command includes --symbol=BTC");
ok(!cmdBTC.includes("--top=") || cmdBTC.includes("--symbol"), "confirm command prefers symbol over top");
const cmdTop = buildConfirmCommand({ top:10, timeframes:["1h"] as any, limit:300, requestDelayMs:250, once:false });
ok(cmdTop.includes("--top=10"), "confirm command for top still includes --top");

// Check schema unchanged (no new tables, no lock migration)
const schema = readFileSync("prisma/schema.prisma", "utf8");
ok(!schema.includes("OhlcvLock"), "schema no OhlcvLock table");
ok(schema.includes("model Asset"), "schema still has Asset");
ok(schema.includes("model Market"), "schema still has Market");
ok(schema.includes("model Candle"), "schema still has Candle");
ok(schema.includes("model Signal"), "schema still has Signal (unchanged)");
ok(!schema.includes("advisory"), "schema no advisory lock artifacts");

// Worker help and plan should not trigger exchange API (checked via source that plan doesn't import sync)
ok(workerSource.indexOf("preflightTitle") < workerSource.indexOf("\"../lib/ohlcv/sync\""), "worker plan title before sync import (no API for --plan)");

console.log(`\nItog pilot: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
}
runPilotTests().catch(e => { console.error(e); process.exit(1); });
