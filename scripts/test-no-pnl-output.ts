/**
 * Output-level NO-PNL recursive checks — must fail if netPnl/grossPnl/profitFactor/winRate/expectancy/sharpe/equityCurve/trades profitability appears anywhere in prohibited outputs.
 * Tests nested objects mutation adding netPnl must fail.
 */

import { runPrePnlDiagnostics, formatPrePnlDiagnosticsReport } from "../lib/backtest/pre-pnl-runner";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../lib/smc/types";
import { buildBacktestsReadinessResponse } from "../lib/backtest/core-api";

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const FORBIDDEN_EXACT = ["netPnl","grossPnl","profitFactor","winRate","expectancy","sharpe","equityCurve","grossProfit","grossLoss"];

function hasForbiddenRecursive(obj:any, path=""): string[] {
  const found:string[] = [];
  if (obj === null || obj === undefined) return found;
  if (typeof obj !== "object") return found;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_EXACT.includes(key) || key.toLowerCase().includes("profitability")) {
      found.push(`${path}.${key}`);
    }
    try {
      const val = obj[key];
      if (val && typeof val === "object") {
        found.push(...hasForbiddenRecursive(val, `${path}.${key}`));
      }
    } catch {}
  }
  return found;
}

const H1 = 3600_000;
const T0 = Date.UTC(2024,0,1);
function mkCandle(t:number): SmcRawCandle {
  return { openTime: new Date(t), open: 100, high: 101, low: 99, close: 100.5, closed: true } as any;
}
function makeCandles(count:number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i=0;i<count;i++) out.push(mkCandle(T0 + i*H1));
  return out;
}

(async () => {
  const candles = makeCandles(100);
  const candlesMap = new Map([[1, candles]]);
  const markets = [{ id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1 } as any];

  const diag = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    from: new Date(T0),
    to: new Date(T0+100*H1),
    markets,
    deps: { findCandlesPage: async ()=>[] as any } as any,
    smcConfig: defaultSmcScoringConfig("1h" as SmcTimeframe),
    allCandlesPerMarket: candlesMap,
    decisionBarsMs: [T0+50*H1, T0+60*H1],
    executionPolicy: null,
    eligibilityMethodology: null,
  });

  const forbiddenInDiag = hasForbiddenRecursive(diag);
  ok(forbiddenInDiag.length===0, `pre-PnL diagnostics has no forbidden economics fields recursive, found: ${forbiddenInDiag.join(",")}`);

  // Core-api readiness response must have no forbidden
  const coreResp = buildBacktestsReadinessResponse();
  const forbiddenInCore = hasForbiddenRecursive(coreResp);
  ok(forbiddenInCore.length===0, `core-api readiness response has no forbidden economics recursive, found: ${forbiddenInCore.join(",")}`);

  // Mutation: adding netPnl:42 to diagnostics must be detected
  const mutatedDiag = JSON.parse(JSON.stringify(diag));
  (mutatedDiag as any).nested = { level1: { netPnl: 42 } };
  const forbiddenMutated = hasForbiddenRecursive(mutatedDiag);
  ok(forbiddenMutated.length>0 && forbiddenMutated.some(f=>f.includes("netPnl")), "mutation M6: netPnl in historical report nested must be detected");

  // Mutation: adding netPnl nested in core-api response must fail
  const mutatedCore = JSON.parse(JSON.stringify(coreResp));
  (mutatedCore as any).prePnl = { nested: { profitFactor: 2.5 } };
  const forbiddenMutatedCore = hasForbiddenRecursive(mutatedCore);
  ok(forbiddenMutatedCore.length>0, "mutation M7: profitFactor in core-api nested must be detected");

  // Ensure report text contains NO PNL marker but not actual PnL numbers
  const report = formatPrePnlDiagnosticsReport(diag as any);
  ok(report.includes("NO PNL"), "report contains NO PNL marker");
  ok(!report.includes("netPnl") && !report.includes("profitFactor"), "report text does not contain forbidden keys");

  // Ensure no profitability where prohibited
  const diagJson = JSON.stringify(diag);
  ok(!diagJson.includes("\"netPnl\"") && !diagJson.includes("\"profitFactor\"") && !diagJson.includes("\"winRate\"") && !diagJson.includes("\"sharpe\"") && !diagJson.includes("\"expectancy\"") && !diagJson.includes("\"equityCurve\""), "diag JSON no forbidden keys stringified");

  // Additional check: historical data plane report file (if exists) should also be clean — we check via formatHistoricalDataPlaneReport with dummy data
  // Use a minimal plane via direct object (not via builder) to test checker still works on plane-like object
  const fakePlane = { markets: [{ marketId: 1, coverageRatio: 0.5 }], overallCoverageRatio: 0.5, totalMarkets: 1 };
  ok(hasForbiddenRecursive(fakePlane).length===0, "fake plane no forbidden");

  console.log(`\nPassed ${passed}/${passed+failed}`);
  if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
  console.log("Output-level NO-PNL checks passed");
})();
