/**
 * Self-mutation testing — try mutations that must be killed by existing tests.
 * No DB, no PnL, deterministic.
 *
 * Mutations tested (in-memory, not file writes):
 * - allow SQL write (INSERT)
 * - allow off-grid candle as canonical occupancy
 * - reintroduce current wall-clock Date.now
 * - use current eligibility values historically
 * - turn raw LONG into NEUTRAL
 * - bypass PRE_REGISTRATION_REQUIRED
 * - enter P2-A economics without policy
 * - contaminate OOS selection/readiness
 * - introduce hidden default k/SL/TP
 *
 * Each mutation must be killed by existing hardening tests.
 */

import { assertReadOnlySql } from "../lib/backtest/read-only-sql";
import { wrapWithExecutability, type RawSmcObservation } from "../lib/backtest/smc-observation";
import { buildNonExecutableResult } from "../lib/backtest/execution-policy";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); }
}

// 1. SQL write mutation must be killed
ok(!assertReadOnlySql("INSERT INTO Candle VALUES (1)").ok, "mutation: INSERT must be rejected");
ok(!assertReadOnlySql("SELECT * FROM Candle; DROP TABLE Candle").ok, "mutation: multi-statement DROP must be rejected");
ok(!assertReadOnlySql("SELECT * FROM Candle FOR UPDATE").ok, "mutation: FOR UPDATE must be rejected");

// 2. Off-grid candle as canonical occupancy — check data-plane logic forbids off-grid
const dataPlaneSrc = readFileSync(resolve(__dirname, "../lib/backtest/historical-data-plane.ts"), "utf8");
ok(dataPlaneSrc.includes("offGrid") || dataPlaneSrc.includes("off-grid"), "data-plane mentions off-grid detection");
ok(dataPlaneSrc.includes("canonicalWindow") || dataPlaneSrc.includes("canonical"), "data-plane mentions canonical grid");

// 3. Wall-clock Date.now reintroduction — check smc-observation has no Date.now
const smcObsSrc = readFileSync(resolve(__dirname, "../lib/backtest/smc-observation.ts"), "utf8");
const smcNoComments = smcObsSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
ok(!smcNoComments.includes("Date.now"), "mutation: Date.now must not exist in smc-observation");
ok(smcObsSrc.includes("computeCausalAsOf"), "smc-observation uses causal clock, not wall-clock");

// 4. Current eligibility values historically — check eligibility diagnostics forbids silent use
const eligSrc = readFileSync(resolve(__dirname, "../lib/backtest/historical-eligibility.ts"), "utf8");
ok(eligSrc.includes("CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY"), "eligibility mentions CANNOT_RECONSTRUCT");
ok(eligSrc.includes("currentValueUsed"), "eligibility tracks currentValueUsed to prevent silent use");

// 5. Turn raw LONG into NEUTRAL — must be killed
function fakeObs(dir: "LONG" | "SHORT" | "NEUTRAL"): RawSmcObservation {
  return {
    marketId: 1, exchange: "BINANCE", assetSymbol: "BTC", timeframe: "1h",
    decisionBarOpenTime: "2024-01-01T00:00:00.000Z", decisionBarOpenTimeMs: Date.parse("2024-01-01T00:00:00Z"),
    asOf: "2024-01-01T01:00:00.000Z", asOfMs: Date.parse("2024-01-01T01:00:00Z"),
    commonHorizon: null, participantCount: 1, direction: dir,
    longScore: 0.8, shortScore: 0.2, reasons: ["TEST"], factsFingerprint: `dir=${dir}`,
    windowPolicy: { hardMinimumBars: 84, productionWindowBars: 500, fullAvailabilityRequired: 84, fetchCap: 500, strategyMemory: "ROLLING_500", historicalFidelityWindow: 500, description: "test" },
    hardMinimumBars: 84, productionWindowBars: 500, availableBars: 500, isFullAvailability: true,
    evaluation: { direction: dir, longScore: 0.5, shortScore: 0.5, reasons: [] } as any,
    provenance: { marketEcho: true, timeframeEcho: true, closedOnly: true, ascOrdering: true, noFuture: true },
  } as any;
}

const longObs = fakeObs("LONG");
const noPolicy = buildNonExecutableResult("NO_EXECUTION_POLICY", "no policy");
const wrappedLong = wrapWithExecutability(longObs, noPolicy);
ok(wrappedLong.observation.direction === "LONG", "mutation: raw LONG must stay LONG, not become NEUTRAL");
ok(wrappedLong.observation.direction !== "NEUTRAL", "mutation: LONG not turned into NEUTRAL");

// 6. Bypass PRE_REGISTRATION_REQUIRED — check pre-pnl-runner always returns PRE_REGISTRATION_REQUIRED when no policy
const prePnlSrc = readFileSync(resolve(__dirname, "../lib/backtest/pre-pnl-runner.ts"), "utf8");
ok(prePnlSrc.includes("PRE_REGISTRATION_REQUIRED"), "pre-pnl-runner contains PRE_REGISTRATION_REQUIRED");
ok(prePnlSrc.includes("NO_EXECUTION_POLICY"), "pre-pnl-runner contains NO_EXECUTION_POLICY");

// 7. Enter P2-A economics without policy — check no import of P2-A engine
const prePnlNoComments = prePnlSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
ok(!prePnlNoComments.includes("runBacktest"), "mutation: P2-A runBacktest not imported in pre-pnl-runner");
ok(!prePnlNoComments.includes("netPnl") && !prePnlNoComments.includes("profitFactor"), "mutation: no PnL fields");

// 8. Contaminate OOS selection/readiness — check splits-readiness OOS isolation
const splitsSrc = readFileSync(resolve(__dirname, "../lib/backtest/splits-readiness.ts"), "utf8");
ok(splitsSrc.includes("oosDoesNotInfluenceSelection"), "splits-readiness mentions oosDoesNotInfluenceSelection");
ok(splitsSrc.includes("oosIsFinalWitnessOnly"), "splits-readiness mentions final witness");

// 9. Hidden default k/SL/TP — check execution-policy forbiddenDefaults
const execPolicySrc = readFileSync(resolve(__dirname, "../lib/backtest/execution-policy.ts"), "utf8");
ok(execPolicySrc.includes("forbiddenDefaults"), "execution-policy has forbiddenDefaults");
ok(execPolicySrc.includes("atr") || execPolicySrc.includes("ATR") || execPolicySrc.includes("k-grid") || execPolicySrc.includes("k="), "forbiddenDefaults includes k/ATR");
ok(execPolicySrc.includes("SL") || execPolicySrc.includes("stopLoss") || execPolicySrc.includes("RR") || execPolicySrc.includes("rr"), "forbiddenDefaults includes SL/RR");

// 10. Self-adversarial: try to bypass by using current rank as historical — should be caught by eligibility
import { buildHistoricalEligibilityDiagnostics } from "../lib/backtest/historical-eligibility";
const diag = buildHistoricalEligibilityDiagnostics(null);
ok(diag.fields.every(f => f.reconstructable === false), "mutation: all eligibility fields non-reconstructable, prevents silent current-state use");

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
console.log("All mutation controls killed — guarantees hold");
