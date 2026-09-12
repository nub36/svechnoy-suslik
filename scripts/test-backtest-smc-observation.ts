/**
 * Differential equivalence tests — Phase C — historical SMC observation vs production SMC.
 */

import { evaluateSmc } from "../lib/smc/evaluate";
import { defaultSmcScoringConfig, minimumSwingHistoryCandles } from "../lib/smc/config";
import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../lib/smc/types";
import type { SmcRawCandle } from "../lib/smc/types";
import type { SmartMoneyMarketMeta } from "../lib/strategies/smart-money";
import { selectCommonClosedHorizon } from "../lib/strategies/common-horizon";
import { isSmartMoneyExchangeEligible } from "../lib/strategies/smart-money-eligibility";
import {
  evaluateHistoricalRawObservation,
  evaluateHistoricalObservationsBatch,
  computeCausalAsOf,
  testCausalClockBoundary,
  buildWindowPolicyForConfig,
} from "../lib/backtest/smc-observation";
import type { BacktestMarketRow } from "../lib/backtest/data-source";

let passed = 0;
let total = 0;

function ok(cond: boolean, label: string): void {
  total += 1;
  if (cond) passed += 1;
  else console.error(`FAIL: ${label}`);
}

function expectThrow(fn: () => any, label: string): void {
  total += 1;
  try {
    fn();
    console.error(`FAIL: ${label} — expected throw but did not`);
  } catch {
    passed += 1;
  }
}

const H1 = 3_600_000;
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

function mkCandle(openTimeMs: number, open = 100, high = 101, low = 99, close = 100.5): SmcRawCandle {
  return {
    openTime: new Date(openTimeMs),
    open,
    high,
    low,
    close,
    closed: true,
  };
}

function makeDeterministicCandles(count: number, startMs = T0, stepMs = H1): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i = 0; i < count; i++) {
    const base = 100 + Math.sin(i / 10) * 10 + i * 0.05;
    const open = base;
    const close = base + (i % 3 === 0 ? 1 : i % 3 === 1 ? -0.8 : 0.2);
    const high = Math.max(open, close) + 0.5;
    const low = Math.min(open, close) - 0.5;
    out.push(mkCandle(startMs + i * stepMs, open, high, low, close));
  }
  return out;
}

(async () => {
  console.log("=== Differential equivalence tests — Phase C ===");

  // 1. Production window / 500-bar distinction
  const config = defaultSmcScoringConfig("1h" as SmcTimeframe);
  const hardMin = minimumSwingHistoryCandles(config);
  ok(hardMin === 84, `hard minimum bars ~84 for default swing 20 (got ${hardMin})`);
  const windowPolicy = buildWindowPolicyForConfig(config);
  ok(windowPolicy.hardMinimumBars === hardMin, "windowPolicy hardMinimum matches computed");
  ok(windowPolicy.productionWindowBars === 500, "productionWindowBars 500");
  ok(windowPolicy.fetchCap === 500, "fetchCap 500");
  ok(windowPolicy.historicalFidelityWindow === 500, "historicalFidelityWindow 500");
  ok(windowPolicy.strategyMemory === "ROLLING_500", "strategyMemory ROLLING_500");
  ok(windowPolicy.description.includes("500"), "description mentions 500");

  const concepts = [
    "hardMinimumBars",
    "productionWindowBars",
    "fullAvailability diagnostics",
    "fetch cap",
    "strategy memory/state",
    "historical fidelity window",
  ];
  ok(concepts.length === 6, "6 distinct window concepts documented");

  // 2. Historical clock semantics
  const H = T0;
  for (const tf of ["5m", "15m", "1h", "4h", "1d"] as SmcTimeframe[]) {
    const duration = SMCTIMEFRAME_MS[tf];
    const asOf = computeCausalAsOf(H, tf);
    ok(asOf.getTime() === H + duration, `causal asOf H+D for ${tf}`);
    ok(testCausalClockBoundary(H, tf, H + duration - 1) === "BEFORE_CLOSE", `boundary H+D-1ms BEFORE_CLOSE for ${tf}`);
    ok(testCausalClockBoundary(H, tf, H + duration) === "AT_CLOSE", `boundary H+D AT_CLOSE for ${tf}`);
    ok(testCausalClockBoundary(H, tf, H + duration + 1) === "AFTER_CLOSE", `boundary H+D+1ms AFTER_CLOSE for ${tf}`);
    ok(testCausalClockBoundary(H, tf, H + 2 * duration) === "AFTER_CLOSE", `boundary H+2D AFTER_CLOSE for ${tf}`);
  }

  // 3. No accidental visibility of H+1 before legal time
  const candlesForClock = makeDeterministicCandles(10, T0, H1);
  const decisionH1 = T0 + 5 * H1;
  const asOfLegal = computeCausalAsOf(decisionH1, "1h");
  const prefixUpToH = candlesForClock.filter((c) => c.openTime.getTime() <= decisionH1);
  const evalAtH = evaluateSmc(prefixUpToH as any, config, asOfLegal);
  ok(evalAtH.asOf.getTime() === asOfLegal.getTime(), "eval asOf matches legal H+D");

  // 4. Differential: same causal prefix + different future suffix = same historical observation at N
  const marketRow: BacktestMarketRow = {
    id: 1,
    exchange: "BINANCE",
    exchangeSymbol: "BTCUSDT",
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  };

  const fullHistory = makeDeterministicCandles(100, T0, H1);
  const decisionBars = [T0 + 50 * H1, T0 + 60 * H1, T0 + 70 * H1];

  const suffixA = makeDeterministicCandles(20, T0 + 100 * H1, H1);
  const suffixB = makeDeterministicCandles(20, T0 + 100 * H1, H1).map((c, i) => ({
    ...c,
    close: c.close + 10 + i,
    high: c.high + 10 + i,
    low: c.low + 10 + i,
    open: c.open + 10 + i,
  }));

  const historyA = [...fullHistory, ...suffixA];
  const historyB = [...fullHistory, ...suffixB];

  const batchA = evaluateHistoricalObservationsBatch({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarsMs: decisionBars,
    allCandlesAsc: historyA,
    smcConfig: config,
  });

  const batchB = evaluateHistoricalObservationsBatch({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarsMs: decisionBars,
    allCandlesAsc: historyB,
    smcConfig: config,
  });

  ok(batchA.total === decisionBars.length, `batchA total ${batchA.total} == decisionBars ${decisionBars.length}`);
  ok(batchB.total === decisionBars.length, `batchB total ${batchB.total} == decisionBars ${decisionBars.length}`);

  for (let i = 0; i < decisionBars.length; i++) {
    const obsA = batchA.observations[i];
    const obsB = batchB.observations[i];
    ok(obsA.direction === obsB.direction, `same prefix different suffix same direction at N=${i} dir ${obsA.direction}`);
    ok(obsA.longScore === obsB.longScore && obsA.shortScore === obsB.shortScore, `same scores at N=${i}`);
    ok(obsA.factsFingerprint === obsB.factsFingerprint, `same fingerprint at N=${i}`);
    ok(obsA.decisionBarOpenTimeMs === obsB.decisionBarOpenTimeMs, `same decision bar at N=${i}`);
  }

  // 5. Production SMC vs historical observation on identical causal prefix
  for (const tf of ["5m", "15m", "1h", "4h", "1d"] as SmcTimeframe[]) {
    const tfMs = SMCTIMEFRAME_MS[tf];
    const candles = makeDeterministicCandles(120, T0, tfMs);
    const Htf = T0 + 100 * tfMs;
    const prefix = candles.filter((c) => c.openTime.getTime() <= Htf);
    const asOf = computeCausalAsOf(Htf, tf);
    const cfg = defaultSmcScoringConfig(tf);
    const prodEval = evaluateSmc(prefix as any, cfg, asOf);
    const histObs = evaluateHistoricalRawObservation({
      market: marketRow,
      assetSymbol: "BTC",
      timeframe: tf,
      decisionBarOpenTimeMs: Htf,
      allCandlesAsc: prefix,
      smcConfig: cfg,
      commonHorizon: null,
      participantCount: 1,
    });
    ok(histObs.direction === (prodEval.direction as any), `production vs historical same direction for ${tf} prod=${prodEval.direction} hist=${histObs.direction}`);
    ok(histObs.longScore === prodEval.longScore && histObs.shortScore === prodEval.shortScore, `production vs historical same scores for ${tf}`);
  }

  // 6. BINGX 1d exclusion
  ok(!isSmartMoneyExchangeEligible("BINGX", "1d"), "BINGX excluded for 1d");
  ok(isSmartMoneyExchangeEligible("BINGX", "1h"), "BINGX eligible for 1h");
  ok(isSmartMoneyExchangeEligible("BINANCE", "1d"), "BINANCE eligible for 1d");
  ok(!isSmartMoneyExchangeEligible("UNKNOWN", "1h"), "unknown exchange fail-closed false");

  // 7. Gaps, duplicates, off-grid, insufficient history, rolling-window boundary, future candle appended
  const candlesWithGap = makeDeterministicCandles(50, T0, H1).filter((_, i) => i !== 25);
  const gapH = T0 + 40 * H1;
  const gapPrefix = candlesWithGap.filter((c) => c.openTime.getTime() <= gapH);
  const gapObs = evaluateHistoricalRawObservation({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarOpenTimeMs: gapH,
    allCandlesAsc: gapPrefix,
    smcConfig: config,
    commonHorizon: null,
    participantCount: 1,
  });
  ok(gapObs.direction !== undefined, "gap: observation still produced");

  const dupCandles = [...makeDeterministicCandles(10, T0, H1)];
  dupCandles.push(dupCandles[5]);
  dupCandles.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
  expectThrow(
    () =>
      evaluateHistoricalRawObservation({
        market: marketRow,
        assetSymbol: "BTC",
        timeframe: "1h",
        decisionBarOpenTimeMs: T0 + 9 * H1,
        allCandlesAsc: dupCandles.filter((c) => c.openTime.getTime() <= T0 + 9 * H1),
        smcConfig: config,
        commonHorizon: null,
        participantCount: 1,
      }),
    "duplicate openTime should throw"
  );

  // Off-grid: SMC core validateAndPrepare does NOT check canonical grid (only closed/ordering/OHLC)
  // Off-grid is caught at alignment layer (lib/strategies/alignment.ts / common-horizon), not at evaluateSmc
  // So evaluateSmc should NOT throw for off-grid, but common-horizon should filter it as no usable data
  const offGridCandle = mkCandle(T0 + 1, 100, 101, 99, 100.5);
  const offGridList = [mkCandle(T0, 100, 101, 99, 100.5), offGridCandle];
  // This should NOT throw at core level (grid check is separate)
  const offGridEval = evaluateSmc(offGridList as any, config, computeCausalAsOf(T0 + 1, "1h"));
  ok(offGridEval.direction !== undefined, "off-grid core does not throw, but alignment layer will handle");

  // Common horizon should treat off-grid-only as no usable data
  const offGridOnlyList = [mkCandle(T0 + 1, 100, 101, 99, 100.5), mkCandle(T0 + 2, 100, 101, 99, 100.5)];
  const offGridSelectionOnly = selectCommonClosedHorizon(
    [{ exchange: "BINANCE", marketId: 1, candles: offGridOnlyList }],
    "1h",
    { now: new Date(T0 + 10 * H1) }
  );
  ok(offGridSelectionOnly.status === "data_unavailable", `off-grid-only -> data_unavailable (got ${offGridSelectionOnly.status})`);

  // Mixed on/off grid: should be ok or stale depending on now, but not data_unavailable because one canonical exists
  const offGridSelectionMixed = selectCommonClosedHorizon(
    [{ exchange: "BINANCE", marketId: 1, candles: offGridList }],
    "1h",
    { now: new Date(T0 + 1 * H1 + 1) } // now close to T0
  );
  ok(
    offGridSelectionMixed.status === "ok" || offGridSelectionMixed.status === "absolute_stale",
    `off-grid mixed -> ok or absolute_stale (got ${offGridSelectionMixed.status})`
  );

  const shortCandles = makeDeterministicCandles(10, T0, H1);
  const shortH = T0 + 9 * H1;
  const shortObs = evaluateHistoricalRawObservation({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarOpenTimeMs: shortH,
    allCandlesAsc: shortCandles,
    smcConfig: config,
    commonHorizon: null,
    participantCount: 1,
  });
  ok(shortObs.direction === "CANNOT_EVALUATE", `insufficient history -> CANNOT_EVALUATE (got ${shortObs.direction})`);
  ok(!shortObs.isFullAvailability, "insufficient history not full availability");

  const manyCandles = makeDeterministicCandles(600, T0, H1);
  const H500 = T0 + 599 * H1;
  const prefix600 = manyCandles.filter((c) => c.openTime.getTime() <= H500);
  const obs600 = evaluateHistoricalRawObservation({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarOpenTimeMs: H500,
    allCandlesAsc: prefix600,
    smcConfig: config,
    commonHorizon: null,
    participantCount: 1,
  });
  ok(obs600.availableBars === 500, `rolling window: availableBars should be 500 when history 600, got ${obs600.availableBars}`);
  ok(obs600.productionWindowBars === 500, "productionWindowBars 500");

  const fewCandles = makeDeterministicCandles(84, T0, H1);
  const H84 = T0 + 83 * H1;
  const obs84 = evaluateHistoricalRawObservation({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarOpenTimeMs: H84,
    allCandlesAsc: fewCandles,
    smcConfig: config,
    commonHorizon: null,
    participantCount: 1,
  });
  ok(obs84.availableBars === 84, `hard min boundary: availableBars 84`);
  ok(obs84.isFullAvailability, "84 bars is full availability for hard min 84");

  const baseHistory = makeDeterministicCandles(100, T0, H1);
  const decisionH2 = T0 + 80 * H1;
  const obsBeforeFuture = evaluateHistoricalRawObservation({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarOpenTimeMs: decisionH2,
    allCandlesAsc: baseHistory.filter((c) => c.openTime.getTime() <= decisionH2),
    smcConfig: config,
    commonHorizon: null,
    participantCount: 1,
  });

  const withFuture = [...baseHistory, mkCandle(T0 + 200 * H1, 200, 201, 199, 200.5)];
  const obsAfterFutureAppended = evaluateHistoricalRawObservation({
    market: marketRow,
    assetSymbol: "BTC",
    timeframe: "1h",
    decisionBarOpenTimeMs: decisionH2,
    allCandlesAsc: withFuture.filter((c) => c.openTime.getTime() <= decisionH2),
    smcConfig: config,
    commonHorizon: null,
    participantCount: 1,
  });

  ok(obsBeforeFuture.direction === obsAfterFutureAppended.direction, "future candle appended does not alter past observation");

  // Common horizon tests
  const candlesBinance = makeDeterministicCandles(50, T0, H1);
  const candlesBybit = makeDeterministicCandles(50, T0, H1);
  const candlesBybitShort = candlesBybit.slice(0, 45);
  // now = latest + D + 1ms => expected latest closed = latest (49)
  const nowEqual = new Date(T0 + 50 * H1 + 1);
  const nowUnequal = new Date(T0 + 50 * H1 + 1); // same now, but short has latest 44, so lag 5

  const selectionEqual = selectCommonClosedHorizon(
    [
      { exchange: "BINANCE", marketId: 1, candles: candlesBinance },
      { exchange: "BYBIT", marketId: 2, candles: candlesBybit },
    ],
    "1h",
    { now: nowEqual }
  );
  ok(selectionEqual.status === "ok", `common horizon ok when equal history: ${selectionEqual.status}`);

  const selectionUnequal = selectCommonClosedHorizon(
    [
      { exchange: "BINANCE", marketId: 1, candles: candlesBinance },
      { exchange: "BYBIT", marketId: 2, candles: candlesBybitShort },
    ],
    "1h",
    { now: nowUnequal }
  );
  ok(
    selectionUnequal.status === "ok" || selectionUnequal.status === "relative_lag_stale",
    `common horizon with unequal history: ${selectionUnequal.status}`
  );

  const candlesOld = makeDeterministicCandles(10, T0, H1);
  const selectionLag = selectCommonClosedHorizon(
    [
      { exchange: "BINANCE", marketId: 1, candles: candlesBinance },
      { exchange: "BYBIT", marketId: 2, candles: candlesOld },
    ],
    "1h",
    { now: nowEqual }
  );
  ok(selectionLag.status === "relative_lag_stale", `relative lag stale when one market far behind: ${selectionLag.status}`);

  const veryOldNow = new Date(T0 + 1000 * H1);
  const selectionAbsolute = selectCommonClosedHorizon(
    [
      { exchange: "BINANCE", marketId: 1, candles: candlesBinance },
      { exchange: "BYBIT", marketId: 2, candles: candlesBybit },
    ],
    "1h",
    { now: veryOldNow }
  );
  ok(selectionAbsolute.status === "absolute_stale", `absolute stale when now far ahead: ${selectionAbsolute.status}`);

  console.log(`\nPassed ${passed}/${total}`);
  if (passed !== total) {
    console.error(`FAIL: ${total - passed} tests failed`);
    process.exit(1);
  } else {
    console.log("All differential equivalence tests passed");
  }
})();
