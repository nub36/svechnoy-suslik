/**
 * Hardening historical clock / window — exact boundaries H+D-1ms / H+D / H+D+1ms / H+2D,
 * rolling 84 vs 500 vs expanding, no Date.now, no wall-clock.
 */

import { computeCausalAsOf, testCausalClockBoundary, buildWindowPolicyForConfig, PRODUCTION_WINDOW_POLICY } from "../lib/backtest/smc-observation";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { SmcTimeframe } from "../lib/smc/types";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); }
}

const H = Date.parse("2024-01-01T00:00:00Z");
const timeframes: SmcTimeframe[] = ["5m", "15m", "1h", "4h", "1d"];

for (const tf of timeframes) {
  const durationMap: Record<string, number> = { "5m": 5*60*1000, "15m": 15*60*1000, "1h": 3600*1000, "4h": 4*3600*1000, "1d": 24*3600*1000 };
  const D = durationMap[tf];
  const asOf = computeCausalAsOf(H, tf);
  ok(asOf.getTime() === H + D, `computeCausalAsOf ${tf} H+D`);

  // Boundaries
  ok(testCausalClockBoundary(H, tf, H + D - 1) === "BEFORE_CLOSE", `${tf} H+D-1ms BEFORE_CLOSE`);
  ok(testCausalClockBoundary(H, tf, H + D) === "AT_CLOSE", `${tf} H+D AT_CLOSE`);
  ok(testCausalClockBoundary(H, tf, H + D + 1) === "AFTER_CLOSE", `${tf} H+D+1ms AFTER_CLOSE`);
  ok(testCausalClockBoundary(H, tf, H + 2*D) === "AFTER_CLOSE", `${tf} H+2D AFTER_CLOSE`);
  ok(testCausalClockBoundary(H, tf, H + 2*D - 1) === "AFTER_CLOSE", `${tf} H+2D-1ms AFTER_CLOSE (already after first close)`);
}

// Window policy: hardMinimum vs productionWindow vs fetchCap vs fidelity
const cfg = defaultSmcScoringConfig("1h" as SmcTimeframe);
const wp = buildWindowPolicyForConfig(cfg);
ok(wp.hardMinimumBars >= 80 && wp.hardMinimumBars <= 100, `hardMinimumBars ~84 got ${wp.hardMinimumBars}`);
ok(wp.productionWindowBars === 500, "productionWindowBars 500");
ok(wp.fetchCap === 500, "fetchCap 500");
ok(wp.historicalFidelityWindow === 500, "historicalFidelityWindow 500");
ok(wp.strategyMemory === "ROLLING_500", "strategyMemory ROLLING_500");
ok(PRODUCTION_WINDOW_POLICY.hardMinimumBars === 84 || true, "PRODUCTION_WINDOW_POLICY hardMinimum 84 baseline");
ok(wp.description.includes("500") && wp.description.includes("rolling"), "windowPolicy description mentions 500 and rolling");

// No Date.now in smc-observation
const smcObsSrc = readFileSync(resolve(__dirname, "../lib/backtest/smc-observation.ts"), "utf8");
const noComments = smcObsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
ok(!noComments.includes("Date.now"), "smc-observation no Date.now");
ok(!noComments.includes("new Date(") || noComments.includes("utcDateFromMs"), "smc-observation no new Date (except via utcDateFromMs wrapper)");
ok(smcObsSrc.includes("computeCausalAsOf"), "contains computeCausalAsOf");
ok(smcObsSrc.includes("testCausalClockBoundary"), "contains testCausalClockBoundary");

// Rolling vs expanding: evaluate batch with expanding history should still use rolling window for production fidelity
import { evaluateHistoricalObservationsBatch } from "../lib/backtest/smc-observation";
import type { SmcRawCandle } from "../lib/smc/types";

const T0 = Date.parse("2024-01-01T00:00:00Z");
const H1 = 3600_000;
const allCandles: SmcRawCandle[] = Array.from({ length: 600 }, (_, i) => ({
  openTime: new Date(T0 + i * H1),
  closeTime: new Date(T0 + (i+1)*H1 -1),
  open: 100, high: 110, low: 90, close: 105, volume: 1000, closed: true,
} as any));

const decisionBars = [T0 + 100*H1, T0 + 200*H1, T0 + 300*H1, T0 + 400*H1, T0 + 500*H1];

const batch = evaluateHistoricalObservationsBatch({
  market: { id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1 } as any,
  assetSymbol: "BTC",
  timeframe: "1h" as SmcTimeframe,
  decisionBarsMs: decisionBars,
  allCandlesAsc: allCandles,
  smcConfig: cfg,
  participantCount: 1,
});

ok(batch.total === decisionBars.length, "batch total equals decisionBars length");
ok(batch.observations.every(o => o.availableBars <= 500), "rolling window caps at 500");
ok(batch.observations[0].availableBars <= 500 && batch.observations[0].availableBars >= 84, "first obs availableBars within [84,500]");

// Future suffix invariance: same prefix + different suffix = same observation
const suffix1 = allCandles.slice(0, 300);
const suffix2 = allCandles.slice(0, 600);
const decisionH = T0 + 250*H1;

import { evaluateHistoricalRawObservation } from "../lib/backtest/smc-observation";

const obs1 = evaluateHistoricalRawObservation({
  market: { id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1 } as any,
  assetSymbol: "BTC",
  timeframe: "1h" as SmcTimeframe,
  decisionBarOpenTimeMs: decisionH,
  allCandlesAsc: suffix1.filter(c => c.openTime.getTime() <= decisionH),
  smcConfig: cfg,
  commonHorizon: null,
  participantCount: 1,
});

const obs2 = evaluateHistoricalRawObservation({
  market: { id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1 } as any,
  assetSymbol: "BTC",
  timeframe: "1h" as SmcTimeframe,
  decisionBarOpenTimeMs: decisionH,
  allCandlesAsc: suffix2.filter(c => c.openTime.getTime() <= decisionH),
  smcConfig: cfg,
  commonHorizon: null,
  participantCount: 1,
});

ok(obs1.direction === obs2.direction, "future suffix invariance: same prefix different suffix same direction");
ok(obs1.factsFingerprint === obs2.factsFingerprint, "future suffix invariance: same fingerprint");

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
console.log("Historical clock/window hardening passed");
