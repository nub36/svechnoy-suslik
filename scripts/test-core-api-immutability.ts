/**
 * Core API immutability — deep-freeze public response, test nested prePnl.status cannot change, arrays cannot push, future consumers cannot mutate readiness.
 */

import { buildBacktestsReadinessResponse } from "../lib/backtest/core-api";

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const resp = buildBacktestsReadinessResponse();

// 1. Top-level frozen
ok(Object.isFrozen(resp), "core-api response top-level frozen");

// 2. Nested objects frozen
ok(Object.isFrozen(resp.p2a), "p2a frozen");
ok(Object.isFrozen(resp.p2b), "p2b frozen");
ok(Object.isFrozen(resp.p2c), "p2c frozen");
ok(Object.isFrozen(resp.prePnl), "prePnl frozen");
ok(Object.isFrozen(resp.ownerCli), "ownerCli frozen");

// 3. Nested prePnl.status cannot change — try mutation should fail or be ignored
let mutationFailed = false;
try {
  (resp.prePnl as any).status = "HACKED";
  if ((resp.prePnl.status as string) !== "HACKED") mutationFailed = true;
} catch {
  mutationFailed = true;
}
ok(mutationFailed, "mutation M10: nested prePnl.status cannot change — deep-freeze prevents mutation");

// 4. Arrays cannot push
let pushFailed = false;
try {
  (resp.limitations as any).push("HACKED");
  if (!resp.limitations.includes("HACKED" as any)) pushFailed = true;
} catch {
  pushFailed = true;
}
ok(pushFailed, "arrays cannot push — limitations frozen");
ok(Object.isFrozen(resp.limitations), "limitations array frozen");

// 5. Future consumers cannot mutate readiness — try to mutate p2a status
let p2aMutFailed = false;
try {
  (resp.p2a as any).status = "MUTATED";
  if ((resp.p2a.status as string) !== "MUTATED") p2aMutFailed = true;
} catch {
  p2aMutFailed = true;
}
ok(p2aMutFailed, "p2a.status cannot be mutated");

// 6. Deep-freeze check: all nested objects recursively frozen
function isDeepFrozen(obj:any, visited=new Set()): boolean {
  if (obj === null || typeof obj !== "object") return true;
  if (visited.has(obj)) return true;
  visited.add(obj);
  if (!Object.isFrozen(obj)) return false;
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === "object") {
      if (!isDeepFrozen(val, visited)) return false;
    }
  }
  return true;
}
ok(isDeepFrozen(resp), "entire core-api response is deep-frozen");

// 7. Test that pre-pnl diagnostics are deep-frozen (from runner)
import { runPrePnlDiagnostics } from "../lib/backtest/pre-pnl-runner";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../lib/smc/types";

(async () => {
  const H1 = 3600_000;
  const T0 = Date.UTC(2024,0,1);
  const candles: SmcRawCandle[] = Array.from({ length: 100 }, (_, i) => ({
    openTime: new Date(T0 + i*H1),
    open: 100, high: 101, low: 99, close: 100.5, closed: true,
  } as any));
  const diag = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    from: new Date(T0),
    to: new Date(T0+100*H1),
    markets: [{ id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE" } as any],
    deps: { findCandlesPage: async ()=>[] as any } as any,
    smcConfig: defaultSmcScoringConfig("1h" as SmcTimeframe),
    allCandlesPerMarket: new Map([[1, candles]]),
    decisionBarsMs: [T0+50*H1],
    executionPolicy: null,
    eligibilityMethodology: null,
  });
  ok(Object.isFrozen(diag), "pre-pnl diagnostics top-level frozen");
  ok(isDeepFrozen(diag), "pre-pnl diagnostics deep-frozen");
  let diagMutFailed = false;
  try {
    (diag as any).status = "HACKED";
    if ((diag.status as string) !== "HACKED") diagMutFailed = true;
  } catch {
    diagMutFailed = true;
  }
  ok(diagMutFailed, "pre-pnl diagnostics status cannot be mutated");

  console.log(`\nPassed ${passed}/${passed+failed}`);
  if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
  console.log("Core API immutability passed — deep-freeze prevents nested mutation");
})();
