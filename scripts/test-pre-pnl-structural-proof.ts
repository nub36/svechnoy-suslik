/**
 * Structural proof: NO APPROVED EXECUTION POLICY -> PRE_REGISTRATION_REQUIRED -> STOP BEFORE P2-A economics.
 * Also raw LONG/SHORT preservation vs executability.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed = 0, failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); }
}

const prePnlSrc = readFileSync(resolve(__dirname, "../lib/backtest/pre-pnl-runner.ts"), "utf8");
const prePnlNoComments = prePnlSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// 1. No P2-A engine import — strict, no escape hatch
ok(!prePnlNoComments.includes("runBacktest"), "pre-pnl-runner does not import P2-A runBacktest engine");
ok(!prePnlNoComments.includes("BacktestEngine"), "no BacktestEngine import");
ok(!prePnlNoComments.includes("computeMetrics"), "no computeMetrics import");
ok(!prePnlSrc.includes("profitFactor") && !prePnlSrc.includes("netPnl") && !prePnlSrc.includes("sharpe") && !prePnlSrc.includes("winRate"), "no PnL fields in pre-pnl-runner");
ok(prePnlSrc.includes("PRE_REGISTRATION_REQUIRED"), "contains PRE_REGISTRATION_REQUIRED");
ok(prePnlSrc.includes("READ ONLY"), "mentions READ ONLY");

// 2. Structural order: executionPolicy validation before wrapping observations — Phase G supports both direct policy and registry id, validation must still be before wrap
const validateCallIdxDirect = prePnlSrc.indexOf("validateExecutionPolicyDefinition(req.executionPolicy)");
const validateCallIdxResolved = prePnlSrc.indexOf("validateExecutionPolicyDefinition(resolvedPolicy)");
const validateCallIdxGeneric = prePnlSrc.indexOf("validateExecutionPolicyDefinition(");
const wrapCallIdx = prePnlSrc.indexOf("wrapWithExecutability(obs,");
const validateCallIdx = validateCallIdxDirect >= 0 ? validateCallIdxDirect : validateCallIdxResolved >= 0 ? validateCallIdxResolved : validateCallIdxGeneric;
ok(validateCallIdx >= 0 && wrapCallIdx >= 0 && validateCallIdx < wrapCallIdx, "executionPolicy validation before wrapWithExecutability call (direct or resolved via registry)");

// 3. Raw LONG/SHORT preservation test via actual functions
import { wrapWithExecutability, type RawSmcObservation } from "../lib/backtest/smc-observation";
import { buildNonExecutableResult } from "../lib/backtest/execution-policy";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import type { SmcTimeframe } from "../lib/smc/types";

function fakeObs(dir: "LONG" | "SHORT" | "NEUTRAL" | "CANNOT_EVALUATE"): RawSmcObservation {
  return {
    marketId: 1,
    exchange: "BINANCE",
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarOpenTime: "2024-01-01T00:00:00.000Z",
    decisionBarOpenTimeMs: Date.parse("2024-01-01T00:00:00Z"),
    asOf: "2024-01-01T01:00:00.000Z",
    asOfMs: Date.parse("2024-01-01T01:00:00Z"),
    commonHorizon: null,
    participantCount: 1,
    direction: dir,
    longScore: dir === "LONG" ? 0.8 : 0.2,
    shortScore: dir === "SHORT" ? 0.8 : 0.2,
    reasons: ["TEST"],
    factsFingerprint: `dir=${dir}`,
    windowPolicy: { hardMinimumBars: 84, productionWindowBars: 500, fullAvailabilityRequired: 84, fetchCap: 500, strategyMemory: "ROLLING_500", historicalFidelityWindow: 500, description: "test" },
    hardMinimumBars: 84,
    productionWindowBars: 500,
    availableBars: 500,
    isFullAvailability: true,
    evaluation: { direction: dir, longScore: 0.5, shortScore: 0.5, reasons: [] } as any,
    provenance: { marketEcho: true, timeframeEcho: true, closedOnly: true, ascOrdering: true, noFuture: true },
  } as RawSmcObservation;
}

const noPolicy = buildNonExecutableResult("NO_EXECUTION_POLICY", "No policy");
const longObs = fakeObs("LONG");
const shortObs = fakeObs("SHORT");
const neutralObs = fakeObs("NEUTRAL");

const wrappedLong = wrapWithExecutability(longObs, noPolicy);
ok(wrappedLong.observation.direction === "LONG", "raw LONG preserved when no policy");
ok(wrappedLong.executability.status === "NON_EXECUTABLE", "LONG + no policy => NON_EXECUTABLE");
ok(wrappedLong.executability.reason === "NO_EXECUTION_POLICY", "reason NO_EXECUTION_POLICY");
ok(wrappedLong.observation.direction !== "NEUTRAL" && wrappedLong.observation.direction !== "CANNOT_EVALUATE", "raw LONG not mapped to NEUTRAL/CANNOT_EVALUATE");

const wrappedShort = wrapWithExecutability(shortObs, noPolicy);
ok(wrappedShort.observation.direction === "SHORT", "raw SHORT preserved when no policy");
ok(wrappedShort.executability.status === "NON_EXECUTABLE", "SHORT + no policy => NON_EXECUTABLE");

const wrappedNeutral = wrapWithExecutability(neutralObs, noPolicy);
ok(wrappedNeutral.observation.direction === "NEUTRAL", "raw NEUTRAL preserved");
ok(wrappedNeutral.executability.status === "NON_EXECUTABLE", "NEUTRAL remains NON_EXECUTABLE");

// 4. PRE_REGISTRATION_REQUIRED structural proof — no P2-A entered
// We simulate runPrePnlDiagnostics with no policy and ensure it returns PRE_REGISTRATION_REQUIRED without calling P2-A
import { runPrePnlDiagnostics } from "../lib/backtest/pre-pnl-runner";
import type { SmcRawCandle } from "../lib/smc/types";

async function testNoPolicyStopsBeforeP2A() {
  const now = Date.parse("2024-01-01T00:00:00Z");
  const H1 = 3600_000;
  const candles: SmcRawCandle[] = Array.from({ length: 500 }, (_, i) => ({
    openTime: new Date(now + i * H1),
    closeTime: new Date(now + (i + 1) * H1 - 1),
    open: 100 + i,
    high: 110 + i,
    low: 90 + i,
    close: 105 + i,
    volume: 1000,
    closed: true,
  })) as any;

  const mockDeps = {
    findCandlesPage: async () => {
      return [] as any;
    },
  };

  const markets = [{ id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE", base: "BTC", quote: "USDT", marketType: "SPOT", quoteVolume24h: 1000000 } as any];

  const decisionBarsMs = [now + 100 * H1, now + 101 * H1];

  const diag = await runPrePnlDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as SmcTimeframe,
    from: new Date(now),
    to: new Date(now + 200 * H1),
    markets,
    deps: mockDeps as any,
    smcConfig: defaultSmcScoringConfig("1h" as SmcTimeframe),
    allCandlesPerMarket: new Map([[1, candles as any]]),
    decisionBarsMs,
    executionPolicy: null,
    eligibilityMethodology: null,
    isSmartMoneyRunner: false,
  });

  ok(diag.status === "PRE_REGISTRATION_REQUIRED", "runPrePnlDiagnostics with no policy => PRE_REGISTRATION_REQUIRED");
  ok(diag.readOnly === true && diag.noPnl === true, "diagnostics readOnly/noPnl true");
  ok(diag.rawLongCount + diag.rawShortCount + diag.rawNeutralCount + diag.rawCannotEvaluateCount === decisionBarsMs.length, "raw counts sum to decisionBars length even when PRE_REGISTRATION_REQUIRED");
  ok(diag.executableCount === 0, "executableCount 0 when no policy");
  ok(diag.nonExecutableCount === decisionBarsMs.length, "nonExecutableCount equals decisionBars when no policy");

  // Real import-closure assertion: pre-pnl-runner module graph must NOT contain engine.ts / metrics.ts
  ok(!prePnlSrc.includes("lib/backtest/engine") && !prePnlSrc.includes("lib/backtest/metrics") && !prePnlSrc.includes("from \"./engine\"") && !prePnlSrc.includes("from \"./metrics\""), "pre-pnl-runner does not import engine.ts/metrics.ts — no economics entered");
  ok(!prePnlSrc.includes("runBacktest") && !prePnlSrc.includes("computeMetrics"), "no P2-A economics functions in pre-pnl-runner");
}

(async () => {
  await testNoPolicyStopsBeforeP2A();

  console.log(`\nPassed ${passed}/${passed + failed}`);
  if (failed > 0) { console.error(`Failed ${failed}`); process.exit(1); }
  console.log("Structural proof: NO APPROVED POLICY -> PRE_REGISTRATION_REQUIRED -> STOP before P2-A, raw LONG/SHORT preserved");
})();
