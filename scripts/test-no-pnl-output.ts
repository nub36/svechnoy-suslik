/**
 * Output-level NO-PNL recursive checks — must inspect REAL production-built historical plane object AND formatted historical report recursively.
 * Inject nested netPnl and ensure tests fail.
 */

import { runPrePnlDiagnostics, formatPrePnlDiagnosticsReport } from "../lib/backtest/pre-pnl-runner";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../lib/smc/types";
import { buildBacktestsReadinessResponse } from "../lib/backtest/core-api";
import { fetchHistoricalDataPlane, formatHistoricalDataPlaneReport } from "../lib/backtest/historical-data-plane";
import type { BacktestDataDepsV2, BacktestMarketRow } from "../lib/backtest/data-source";

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const FORBIDDEN_EXACT = ["netPnl","grossPnl","profitFactor","winRate","expectancy","sharpe","equityCurve","grossProfit","grossLoss"];

function hasForbiddenRecursive(obj:any, path=""): string[] {
  const found:string[] = [];
  if (obj === null || obj === undefined) return found;
  if (typeof obj !== "object") return found;
  for (const key of Object.keys(obj)) {
    // Allow canReportProfitability flag (diagnostic that profitability cannot be reported)
    if (key === "canReportProfitability") {
      // still recurse into its value (boolean, no need)
    } else if (FORBIDDEN_EXACT.includes(key) || (key.toLowerCase().includes("profitability") && key !== "canReportProfitability")) {
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
function mkRow(marketId:number, openTimeMs:number){
  return { marketId, timeframe: "1h", openTime: new Date(openTimeMs), closeTime: new Date(openTimeMs+H1-1), open: 100, high: 101, low: 99, close: 100.5, volume: 1000, closed: true };
}

(async () => {
  const candles = makeCandles(100);
  const candlesMap = new Map([[1, candles]]);
  const markets = [{ id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1 } as any] as BacktestMarketRow[];

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

  ok(hasForbiddenRecursive(diag).length===0, `pre-PnL diagnostics no forbidden, found: ${hasForbiddenRecursive(diag).join(",")}`);

  // REAL production-built historical plane object
  const deps: BacktestDataDepsV2 = {
    findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }) => {
      const rows: any[] = [];
      for (let i=0;i<10;i++) rows.push(mkRow(marketId, T0 + i*H1));
      let f = rows.filter((r:any)=>r.openTime.getTime()>=from.getTime() && r.openTime.getTime()<to.getTime());
      if (cursorOpenTime) f = f.filter((r:any)=>r.openTime.getTime()>cursorOpenTime.getTime());
      return f.slice(0, take);
    },
  };
  const realPlane = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from: new Date(T0),
    to: new Date(T0 + 10*H1),
    markets,
    deps,
    isSmartMoneyRunner: false,
  });

  const forbiddenInRealPlane = hasForbiddenRecursive(realPlane);
  ok(forbiddenInRealPlane.length===0, `REAL plane object has no forbidden economics, found: ${forbiddenInRealPlane.join(",")}`);

  const formattedPlaneReport = formatHistoricalDataPlaneReport(realPlane);
  ok(!formattedPlaneReport.includes("netPnl") && !formattedPlaneReport.includes("profitFactor") && !formattedPlaneReport.includes("winRate") && !formattedPlaneReport.includes("sharpe"), "formatted historical report text has no forbidden keys");
  ok(formattedPlaneReport.includes("READ ONLY") && formattedPlaneReport.includes("NO PNL"), "formatted historical report contains READ ONLY NO PNL");

  // Inject nested netPnl into REAL plane and ensure detection fails
  const mutatedRealPlane = JSON.parse(JSON.stringify(realPlane));
  (mutatedRealPlane as any).marketResults[0].nested = { level1: { netPnl: 42 } };
  const forbiddenMutatedReal = hasForbiddenRecursive(mutatedRealPlane);
  ok(forbiddenMutatedReal.length>0 && forbiddenMutatedReal.some(f=>f.includes("netPnl")), "M6 REAL: nested netPnl in REAL plane must be detected");

  // Also inject into formatted? Since formatted is string, we test that our checker would fail if string contained forbidden — but we already test object.
  // For completeness, test that formatted report string does NOT contain netPnl, but if we inject into object then format, it still should not contain forbidden because formatter doesn't output netPnl.
  // So we test that hasForbiddenRecursive catches nested even in REAL plane.

  // Core-api
  const coreResp = buildBacktestsReadinessResponse();
  ok(hasForbiddenRecursive(coreResp).length===0, `core-api no forbidden, found: ${hasForbiddenRecursive(coreResp).join(",")}`);

  const mutatedDiag = JSON.parse(JSON.stringify(diag));
  (mutatedDiag as any).nested = { level1: { netPnl: 42 } };
  ok(hasForbiddenRecursive(mutatedDiag).some(f=>f.includes("netPnl")), "mutation M6: netPnl in diagnostics nested must be detected");

  const mutatedCore = JSON.parse(JSON.stringify(coreResp));
  (mutatedCore as any).prePnl = { nested: { profitFactor: 2.5 } };
  ok(hasForbiddenRecursive(mutatedCore).length>0, "mutation M7: profitFactor in core-api nested must be detected");

  const report = formatPrePnlDiagnosticsReport(diag as any);
  ok(report.includes("NO PNL"), "pre-pnl report contains NO PNL");
  ok(!report.includes("netPnl") && !report.includes("profitFactor"), "pre-pnl report text no forbidden");

  ok(!JSON.stringify(diag).includes("\"netPnl\"") && !JSON.stringify(diag).includes("\"profitFactor\""), "diag JSON no forbidden");

  console.log(`\nPassed ${passed}/${passed+failed}`);
  if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
  console.log("Output-level NO-PNL checks passed — REAL plane object + formatted report recursive");
})();
