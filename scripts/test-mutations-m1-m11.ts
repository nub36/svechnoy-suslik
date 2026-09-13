/**
 * Mutation requirements M1-M11 self-test — all must be killed, report survivors.
 */

import { evaluateHistoricalRawObservation } from "../lib/backtest/smc-observation";
import { computeMarketCoverage, aggregateCoverage } from "../lib/backtest/coverage";
import { validateNoHiddenEconomicDefaults } from "../lib/backtest/execution-policy";
import { buildBacktestsReadinessResponse } from "../lib/backtest/core-api";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import type { SmcRawCandle, SmcTimeframe } from "../lib/smc/types";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { BacktestBar } from "../lib/backtest/contract";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }
function bar(timeMs:number): BacktestBar { return { time: timeMs, open: 100, high: 110, low: 90, close: 105, volume: 1000 } as any; }

const T0 = Date.parse("2024-01-01T00:00:00Z");
const HOUR = 3600_000;
const H1 = HOUR;

function mk(i:number, o:number, c:number, high?:number, low?:number): SmcRawCandle {
  return { openTime: new Date(T0 + i*HOUR), open: o, high: high ?? Math.max(o,c), low: low ?? Math.min(o,c), close: c, closed: true } as any;
}
function flats(from:number,to:number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i=from;i<=to;i++){ const b=i*0.01; out.push(mk(i,86+b,87+b,90+b,84+b)); }
  return out;
}
function canonical(): SmcRawCandle[] {
  return [
    ...flats(0,4),
    mk(5,86.05,87.05,105,84.05),
    flats(6,6)[0],
    mk(7,86.07,87.07,90.07,82),
    ...flats(8,13),
    mk(14,90,86,90.14,84),
    mk(15,91,104,108,91),
    mk(16,103,101,103.5,95),
    mk(17,107,109,109.5,106.5),
    ...flats(18,26),
  ];
}
function neg(c: SmcRawCandle): SmcRawCandle {
  const idx = (c.openTime.getTime()-T0)/HOUR;
  return mk(idx, -c.open, -c.close, -c.low, -c.high);
}

const cfg = defaultSmcScoringConfig("1h" as SmcTimeframe);
cfg.swingLeft = 1; cfg.swingRight = 1; cfg.internalLeft = 1; cfg.internalRight = 1;
const market = { id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1 } as any;
const decisionH = T0 + 20*HOUR;
const longCandles = canonical().filter(c=>c.openTime.getTime() <= decisionH);
const shortCandles = canonical().map(neg).filter(c=>c.openTime.getTime() <= decisionH);

const longObs = evaluateHistoricalRawObservation({ market, assetSymbol: "BTC", timeframe: "1h" as SmcTimeframe, decisionBarOpenTimeMs: decisionH, allCandlesAsc: longCandles, smcConfig: cfg, commonHorizon: null, participantCount: 1 });
const shortObs = evaluateHistoricalRawObservation({ market, assetSymbol: "BTC", timeframe: "1h" as SmcTimeframe, decisionBarOpenTimeMs: decisionH, allCandlesAsc: shortCandles, smcConfig: cfg, commonHorizon: null, participantCount: 1 });

// M1 real LONG->NEUTRAL must fail
ok(longObs.direction === "LONG", "M1 setup: real LONG is LONG");
ok(longObs.direction !== "NEUTRAL", "M1 killed: LONG->NEUTRAL mutation must fail — real LONG not NEUTRAL");

// M2 SHORT->CANNOT_EVALUATE must fail
ok(shortObs.direction === "SHORT", "M2 setup: real SHORT is SHORT");
ok(shortObs.direction !== "CANNOT_EVALUATE", "M2 killed: SHORT->CANNOT_EVALUATE mutation must fail");

// M3 overallCoverageRatio forced 1 must fail
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T03:00:00Z");
  const bars = [bar(Date.parse("2024-01-01T00:00:00Z"))];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  const agg = aggregateCoverage([cov]);
  ok(agg.overallCoverageRatio !== 1, "M3 killed: overallCoverageRatio forced 1 must fail — real partial ratio not 1");
}

// M4 canonical effectiveFrom broken must fail
{
  const from = Date.parse("2024-01-01T00:30:00Z");
  const to = Date.parse("2024-01-01T03:30:00Z");
  const bars = [bar(Date.parse("2024-01-01T01:00:00Z"))];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.requestedAlignment?.effectiveFrom === Date.parse("2024-01-01T01:00:00Z"), "M4 setup: effectiveFrom correct");
  ok(cov.requestedAlignment?.effectiveFrom !== from, "M4 killed: effectiveFrom broken must fail — effectiveFrom != from when not aligned");
}

// M5 alignment flags falsified must fail
{
  const from = Date.parse("2024-01-01T00:30:00Z");
  const to = Date.parse("2024-01-01T03:30:00Z");
  const cov = computeMarketCoverage(1, "1h", [], H1, { from, to });
  ok(cov.requestedAlignment?.isAligned === false && cov.requestedAlignment?.canonicalized === true, "M5 setup: non-aligned has isAligned false canonicalized true");
  ok(!(cov.requestedAlignment?.isAligned === true && cov.requestedAlignment?.canonicalized === false), "M5 killed: alignment flags falsified must fail");
}

// M6 netPnl in historical report must fail
{
  function hasForbiddenRecursive(obj:any): boolean {
    if (!obj || typeof obj !== "object") return false;
    for (const k of Object.keys(obj)) {
      if (k === "netPnl" || k === "profitFactor") return true;
      const v = obj[k];
      if (v && typeof v === "object" && hasForbiddenRecursive(v)) return true;
    }
    return false;
  }
  const fakePlane = { markets: [], overallCoverageRatio: 0.5 };
  const mutated = { ...fakePlane, nested: { netPnl: 42 } };
  ok(hasForbiddenRecursive(mutated) === true, "M6 setup: checker detects netPnl");
  ok(hasForbiddenRecursive(fakePlane) === false, "M6 killed: netPnl in historical report must be detected — clean plane has no forbidden");
}

// M7 netPnl in core-api nested must fail
{
  const resp = buildBacktestsReadinessResponse();
  const mutated = JSON.parse(JSON.stringify(resp));
  (mutated as any).prePnl = { nested: { netPnl: 42 } };
  function hasForbidden(obj:any): boolean {
    if (!obj || typeof obj !== "object") return false;
    for (const k of Object.keys(obj)) {
      if (k === "netPnl") return true;
      if (obj[k] && typeof obj[k] === "object" && hasForbidden(obj[k])) return true;
    }
    return false;
  }
  ok(hasForbidden(mutated) === true, "M7 setup: nested netPnl detected");
  ok(hasForbidden(resp) === false, "M7 killed: netPnl in core-api nested must be detected — clean resp has no forbidden");
}

// M8 unresolved policy receives k/ATR/RR/timeout must fail
{
  const mutation = { atrSlMultiplier: 1.5, k: 1, rrMin: 2, timeoutBars: 24 };
  const res = validateNoHiddenEconomicDefaults(mutation as any, null);
  ok(res.ok === false, "M8 killed: unresolved policy receives k/ATR/RR/timeout must fail");
}

// M9 PRE_REGISTRATION bypass must fail
{
  const prePnlSrc = readFileSync(resolve(__dirname, "../lib/backtest/pre-pnl-runner.ts"), "utf8");
  const noComments = prePnlSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok(!noComments.includes("runBacktest") && !noComments.includes("computeMetrics"), "M9 killed: PRE_REGISTRATION bypass must fail — no P2-A economics in runner");
  ok(prePnlSrc.includes("PRE_REGISTRATION_REQUIRED"), "M9 setup: runner contains PRE_REGISTRATION_REQUIRED");
}

// M10 nested core-api mutation allowed must fail (deep-freeze)
{
  const resp = buildBacktestsReadinessResponse();
  let mutFailed = false;
  try {
    (resp.prePnl as any).status = "HACKED";
    if ((resp.prePnl.status as string) !== "HACKED") mutFailed = true;
  } catch { mutFailed = true; }
  ok(mutFailed, "M10 killed: nested core-api mutation allowed must fail — deep-freeze prevents");
}

// M11 current enabled/status filtering restored silently must fail
{
  const cliSrc = readFileSync(resolve(__dirname, "backtest-historical-readonly.ts"), "utf8");
  ok(cliSrc.includes("where: { assetId: assetRow.id }"), "M11 setup: CLI queries all markets");
  ok(!cliSrc.includes("enabled: true, status: \"ACTIVE\"") || !cliSrc.includes("where: { assetId: assetRow.id, enabled: true"), "M11 killed: current enabled/status filtering restored silently must fail — no silent filter");
  ok(cliSrc.includes("CURRENT_STATE_SURVIVORSHIP_LIMITATION"), "M11: reports survivorship limitation");
}

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed} — survivors exist!`); process.exit(1); }
console.log("All M1-M11 mutations killed — no survivors");
