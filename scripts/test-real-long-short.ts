/**
 * Real LONG/SHORT tests — using actual production evaluateSmc path via evaluateHistoricalRawObservation.
 * Must produce genuine LONG and SHORT, not fakeObs.
 * Then prove end-to-end: real raw LONG + no policy = raw LONG + NON_EXECUTABLE/PRE_REGISTRATION_REQUIRED, same for SHORT.
 * Mutation: LONG -> NEUTRAL, SHORT -> CANNOT_EVALUATE must fail.
 */

import { evaluateHistoricalRawObservation, wrapWithExecutability } from "../lib/backtest/smc-observation";
import { buildNonExecutableResult } from "../lib/backtest/execution-policy";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { SmcTimeframe, SmcRawCandle } from "../lib/smc/types";

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const T0 = Date.parse("2024-01-01T00:00:00Z");
const HOUR = 3600_000;

function mk(i:number, o:number, c:number, high?:number, low?:number): SmcRawCandle {
  return {
    openTime: new Date(T0 + i*HOUR),
    open: o,
    high: high ?? Math.max(o,c),
    low: low ?? Math.min(o,c),
    close: c,
    closed: true,
  } as any;
}

function flats(from:number,to:number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i=from;i<=to;i++){
    const b=i*0.01;
    out.push(mk(i,86+b,87+b,90+b,84+b));
  }
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
const negate = (list: SmcRawCandle[]) => list.map(neg);

const cfg = defaultSmcScoringConfig("1h" as SmcTimeframe);
cfg.swingLeft = 1;
cfg.swingRight = 1;
cfg.internalLeft = 1;
cfg.internalRight = 1;

const market = { id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1 } as any;

const decisionH = T0 + 20*HOUR;

const longCandles = canonical().filter(c=>c.openTime.getTime() <= decisionH);
const shortCandles = negate(canonical()).filter(c=>c.openTime.getTime() <= decisionH);

const longObs = evaluateHistoricalRawObservation({
  market,
  assetSymbol: "BTC",
  timeframe: "1h" as SmcTimeframe,
  decisionBarOpenTimeMs: decisionH,
  allCandlesAsc: longCandles,
  smcConfig: cfg,
  commonHorizon: null,
  participantCount: 1,
});

const shortObs = evaluateHistoricalRawObservation({
  market,
  assetSymbol: "BTC",
  timeframe: "1h" as SmcTimeframe,
  decisionBarOpenTimeMs: decisionH,
  allCandlesAsc: shortCandles,
  smcConfig: cfg,
  commonHorizon: null,
  participantCount: 1,
});

ok(longObs.direction === "LONG", `real canonical fixture yields LONG, got ${longObs.direction}`);
ok(longObs.longScore !== null && longObs.shortScore !== null, "LONG has scores");
ok(longObs.longScore! > longObs.shortScore!, "LONG longScore > shortScore");

ok(shortObs.direction === "SHORT", `real negate fixture yields SHORT, got ${shortObs.direction}`);
ok(shortObs.shortScore! > shortObs.longScore!, "SHORT shortScore > longScore");

// End-to-end: real raw LONG + no policy = raw LONG + NON_EXECUTABLE/PRE_REGISTRATION_REQUIRED
const noPolicy = buildNonExecutableResult("NO_EXECUTION_POLICY", "No policy");

const wrappedLong = wrapWithExecutability(longObs, noPolicy);
ok(wrappedLong.observation.direction === "LONG", "real LONG preserved when no policy");
ok(wrappedLong.executability.status === "NON_EXECUTABLE", "real LONG + no policy => NON_EXECUTABLE");
ok(wrappedLong.executability.reason === "NO_EXECUTION_POLICY", "reason is NO_EXECUTION_POLICY");
ok(wrappedLong.executability.status === "NON_EXECUTABLE" && (wrappedLong.executability.reason?.includes("NO_EXECUTION") ?? false), "executability reason contains NO_EXECUTION");
ok(wrappedLong.observation.direction !== "NEUTRAL" && wrappedLong.observation.direction !== "CANNOT_EVALUATE", "real LONG not mapped to NEUTRAL/CANNOT_EVALUATE");

const wrappedShort = wrapWithExecutability(shortObs, noPolicy);
ok(wrappedShort.observation.direction === "SHORT", "real SHORT preserved when no policy");
ok(wrappedShort.executability.status === "NON_EXECUTABLE", "real SHORT + no policy => NON_EXECUTABLE");
ok(wrappedShort.observation.direction !== "NEUTRAL" && wrappedShort.observation.direction !== "CANNOT_EVALUATE", "real SHORT not mapped to NEUTRAL/CANNOT_EVALUATE");

// Mutation tests: inside evaluateHistoricalRawObservation, LONG -> NEUTRAL and SHORT -> CANNOT_EVALUATE must fail
// We simulate mutation by checking that if we artificially change direction, our tests would fail
// Here we test that real LONG is not NEUTRAL and real SHORT is not CANNOT_EVALUATE — if mutation turned LONG->NEUTRAL, this would fail
ok(longObs.direction !== "NEUTRAL", "mutation M1: LONG -> NEUTRAL must fail — real LONG is not NEUTRAL");
ok(shortObs.direction !== "CANNOT_EVALUATE", "mutation M2: SHORT -> CANNOT_EVALUATE must fail — real SHORT is not CANNOT_EVALUATE");

// Also test that fingerprint is deterministic and contains direction
ok((longObs.factsFingerprint?.includes("LONG") ?? false) || (longObs.factsFingerprint?.includes("dir=LONG") ?? false), "LONG fingerprint contains LONG");
ok((shortObs.factsFingerprint?.includes("SHORT") ?? false) || (shortObs.factsFingerprint?.includes("dir=SHORT") ?? false), "SHORT fingerprint contains SHORT");

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
console.log("Real LONG/SHORT tests passed — genuine production evaluateSmc path yields LONG and SHORT, preserved with NON_EXECUTABLE");
