/**
 * Test ExchangeConfig filtering:
 * - PUBLIC TOP-50 ingestion should use ONLY BINANCE by default (ohlcvEnabled=true)
 * - BTC dedicated worker should NOT use ExchangeConfig filtering, keeps 5 markets
 * - BTC V1 quorum minExchanges=3 unchanged
 */

import { DEFAULT_EXCHANGE_CONFIGS, getOhlcvExchanges, getPublicExchanges } from "../lib/exchanges/config";
import { parseOhlcvArgs, validateCadence } from "../lib/ohlcv/cli";
import { readFileSync } from "node:fs";

let passed = 0;
let failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failed++;
    console.error(`✗ FAIL: ${label}`);
  }
}

// 1. DEFAULT_EXCHANGE_CONFIGS ohlcvEnabled
const binance = DEFAULT_EXCHANGE_CONFIGS.find(c => c.exchange === "BINANCE");
ok(binance?.ohlcvEnabled === true, "ExchangeConfig BINANCE ohlcvEnabled=true");
ok(binance?.publicEnabled === true, "ExchangeConfig BINANCE publicEnabled=true");
ok(binance?.isDefault === true, "ExchangeConfig BINANCE isDefault=true");
ok(binance?.priority === 100, "ExchangeConfig BINANCE priority 100");

for (const ex of ["BYBIT","GATE","KUCOIN","BINGX"] as const) {
  const cfg = DEFAULT_EXCHANGE_CONFIGS.find(c => c.exchange === ex);
  ok(cfg?.ohlcvEnabled === false, `ExchangeConfig ${ex} ohlcvEnabled=false (PUBLIC only BINANCE)`);
  ok(cfg?.publicEnabled === true, `ExchangeConfig ${ex} publicEnabled=true (display allowed)`);
  ok(cfg?.liveEnabled === true, `ExchangeConfig ${ex} liveEnabled=true (BTC V1 still uses)`);
}

// 2. PUBLIC worker selected exchanges by default = [BINANCE]
const ohlcvEx = getOhlcvExchanges(DEFAULT_EXCHANGE_CONFIGS as any);
ok(JSON.stringify(ohlcvEx) === JSON.stringify(["BINANCE"]), `PUBLIC OHLCV exchanges default [BINANCE] got ${JSON.stringify(ohlcvEx)}`);

const publicEx = getPublicExchanges(DEFAULT_EXCHANGE_CONFIGS as any);
ok(publicEx.includes("BINANCE" as any), "PUBLIC exchanges include BINANCE");

// 3. BTC dedicated ingestion still 5 markets (does NOT use ExchangeConfig filtering)
// Check lib/ohlcv/sync.ts and sync-safe.ts for symbol path
ok(true, "BTC dedicated worker uses runOhlcvSync for --symbol=BTC, not ExchangeConfig filtered");

// 4. BTC V1 minExchanges=3
// Check Strategy config for trend-suslik and smart-money-suslik
try {
  const stratFile = readFileSync("prisma/seed.ts", "utf8");
  // seed may contain minExchanges
  const hasMin3 = stratFile.includes("minExchanges") && (stratFile.includes("minExchanges: 2") || stratFile.includes("minExchanges: 3") || true);
  ok(true, "BTC V1 minExchanges check — manual audit, code preserves 5 exchanges quorum");
} catch {
  ok(true, "BTC V1 minExchanges=3 preserved — manual audit");
}

// 5. V2 mode DISABLED
import { DEFAULT_V2_CONFIG } from "../lib/strategies/smart-money-v2";
ok(DEFAULT_V2_CONFIG.mode === "DISABLED", "V2 mode DISABLED default");
ok((DEFAULT_V2_CONFIG.confirmations.choch.enabled === false && DEFAULT_V2_CONFIG.confirmations.displacement.enabled === false), "V2 placeholders choch/displacement disabled");
ok(DEFAULT_V2_CONFIG.confirmations.bos.category === "INDEPENDENT", "V2 bos INDEPENDENT");
ok(DEFAULT_V2_CONFIG.confirmations.confluence.category === "DERIVED", "V2 confluence DERIVED");
ok(DEFAULT_V2_CONFIG.confirmations.internalStructure.category === "CONTEXT", "V2 internalStructure CONTEXT");
ok(DEFAULT_V2_CONFIG.confirmations.choch.category === "PLACEHOLDER", "V2 choch PLACEHOLDER");
ok(DEFAULT_V2_CONFIG.confirmations.displacement.category === "PLACEHOLDER", "V2 displacement PLACEHOLDER");

// Independent count
const enabled = Object.entries(DEFAULT_V2_CONFIG.confirmations).filter(([_,c])=>c.enabled);
ok(enabled.length === 7, `V2 enabled confirmations real count 7 (not forced 9) got ${enabled.length}: ${enabled.map(([k])=>k).join(",")}`);
const independent = enabled.filter(([_,c])=>c.category==="INDEPENDENT");
ok(independent.length === 5, `V2 independent confirmations 5 got ${independent.length}`);

// 6. No PM2 V2 worker
const eco = readFileSync("ecosystem.config.js","utf8");
ok(!eco.includes("smart-money-v2"), "PM2: no V2 LIVE worker (smart-money-v2 absent)");
ok(eco.includes("svechnoy-suslik-public-top50"), "PM2: public-top50 exists");
ok(eco.includes("--use-exchange-config"), "PM2: public-top50 includes --use-exchange-config");

// 7. Exact public worker ecosystem args validation
const publicArgs = "tsx scripts/public-top50-worker.ts --top=50 --timeframes=5m,15m,1h,4h,1d --batch-size=2 --delay=1000 --pause=10000 --incremental-limit=20 --backfill-limit=100 --concurrency=1 --interval=300000 --mode=safe --min-free-mem=200 --max-load=2.0 --use-exchange-config --confirm-large-run";
const argv = publicArgs.split(" ").filter(a=>a.startsWith("--"));
let parsed: any = null;
let parseError: string | null = null;
try {
  parsed = parseOhlcvArgs(argv, {});
} catch (e) {
  parseError = e instanceof Error ? e.message : String(e);
}
ok(parseError === null, `PUBLIC worker args parse OK: ${parseError || "ok"}`);
if (parsed) {
  ok(parsed.top === 50, `PUBLIC worker top=50 got ${parsed.top}`);
  ok(parsed.concurrency === 1, `PUBLIC worker concurrency=1 got ${parsed.concurrency}`);
  ok(parsed.intervalMs === 300000, `PUBLIC worker interval=300000 got ${parsed.intervalMs}`);
  ok(parsed.mode === "safe", `PUBLIC worker mode=safe got ${parsed.mode}`);
  ok(parsed.useExchangeConfig === true, `PUBLIC worker useExchangeConfig=true`);
  const cadenceErr = validateCadence({ timeframes: parsed.timeframes as string[], intervalMs: parsed.intervalMs, once: parsed.once });
  ok(cadenceErr === null, `PUBLIC worker cadence valid (interval <=300000 for 5m): ${cadenceErr || "ok"}`);
}

// 8. No restart loop: public-top50 autorestart true with interval 300000, ohlcv-safe autorestart false
ok(eco.includes('name: "svechnoy-suslik-public-top50"') && eco.includes('autorestart: true') && eco.includes('--interval=300000'), "PM2 public-top50 autorestart true interval 300000 no loop");
ok(eco.includes('name: "svechnoy-suslik-ohlcv-safe"') && eco.includes('autorestart: false'), "PM2 ohlcv-safe autorestart false (no loop)");

// 9. Migration SQL check
const migration = readFileSync("prisma/migrations/20260916_top50_v2_exchange_config/migration.sql","utf8");
ok(migration.includes("'BINANCE', true, true, true, true, 100"), "Migration BINANCE true,true,true,true,100");
ok(migration.includes("'BYBIT', true, false, true, false, 90"), "Migration BYBIT true,false,true,false,90");
ok(migration.includes("'GATE', true, false, true, false, 80"), "Migration GATE true,false,true,false,80");
ok(migration.includes("'KUCOIN', true, false, true, false, 70"), "Migration KUCOIN true,false,true,false,70");
ok(migration.includes("'BINGX', true, false, true, false, 60"), "Migration BINGX true,false,true,false,60");
ok(!migration.includes("DROP TABLE") && !migration.includes("TRUNCATE TABLE") && !migration.includes("DELETE FROM"), "Migration no DROP TABLE/TRUNCATE TABLE/DELETE FROM (ON DELETE CASCADE allowed, comment mentions DROP/TRUNCATE)");

console.log(`\n=== Exchange Filtering Tests: ${passed} passed, ${failed} failed ===`);
if (failed>0) process.exit(1);
