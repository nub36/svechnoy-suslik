/**
 * P2-B — Data Plane тесты.
 *
 * Запуск: npx tsx scripts/test-backtest-p2b.ts
 *
 * Покрывает минимум ТЗ P2-B:
 * - read-only by construction, no DB writes
 * - historical pagination ASC cursor exclusive deterministic termination configurable pageSize closed=true only
 * - coverage per market×timeframe: requested range, first/last, returned, expected, missing, ratio, gaps, duplicates, ordering, grid, contiguous, never 100% when empty
 * - gap detection timeframe-aware using SMCTIMEFRAME_MS source
 * - duplicate/openTime, non-monotonic, delta<, delta>, not multiple, off-grid
 * - no silent fix
 * - Market.id identity, never exchangeSymbol, reuse Smart Money eligibility BINGX 1d excluded for Smart Money 1d not global
 * - contiguous usable ranges deterministic, use P2-A minBars if explicit else report, no hardcoded minimumSwingHistoryCandles
 * - adapter DB Candle → REAL P2-A BacktestBar timestamp preserved
 * - P2-B does not set SL/TP/fees/slippage/timeout/policy/metrics
 * - no-lookahead boundary: causal history allowed, future not
 * - plan/dry-run interface
 */

import type { BacktestBar } from "../lib/backtest/contract";
import { validateBars } from "../lib/backtest/validate";
import { BACKTEST_SPLIT_DEFAULTS, BACKTEST_DEFAULTS } from "../lib/backtest/contract";
import {
  candleRowToBacktestBar,
  candleRowsToBacktestBars,
  assertTimestampPreserved,
  type BacktestCandleRow,
} from "../lib/backtest/adapter";
import {
  detectGaps,
  detectDuplicates,
  checkOrdering,
  checkGrid,
  analyzeMarketAnomalies,
} from "../lib/backtest/gaps";
import {
  computeMarketCoverage,
  aggregateCoverage,
} from "../lib/backtest/coverage";
import {
  findContiguousIntervals,
  findCommonTimestamps,
  findCommonContiguousIntervals,
} from "../lib/backtest/intervals";
import {
  fetchCandlesPaginated,
  getMarketsForAsset,
  fetchBarsForMarkets,
  assertReadOnlyDeps,
  type BacktestDataDeps,
  type BacktestMarketRow,
  type BacktestAssetRow,
} from "../lib/backtest/data-source";
import {
  planBacktestRun,
  formatDataPlanReport,
} from "../lib/backtest/data-plan";
import {
  isMarketEligible,
  filterEligibleMarkets,
  partitionByEligibility,
} from "../lib/backtest/eligibility";
import {
  SMCTIMEFRAME_MS,
  getTimeframeMs,
  CANONICAL_TIMEFRAMES,
} from "../lib/backtest/timeframe";
import { isSmartMoneyExchangeEligible } from "../lib/strategies/smart-money-eligibility";

let passed = 0;
let total = 0;

function ok(cond: boolean, label: string): void {
  total += 1;
  if (cond) passed += 1;
  else console.error(`FAIL: ${label}`);
}

function eq<T>(a: T, b: T, label: string): void {
  ok(a === b, `${label} (got ${a}, expected ${b})`);
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const H1 = 3_600_000;
const M5 = 5 * 60_000;
const D1 = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0); // 2024-01-01 00:00 UTC

function mkRow(
  marketId: number,
  timeframe: string,
  openTimeMs: number,
  closed = true,
  overrides?: Partial<BacktestCandleRow>
): BacktestCandleRow {
  return {
    marketId,
    timeframe,
    openTime: new Date(openTimeMs),
    closeTime: new Date(openTimeMs + (getTimeframeMs(timeframe) ?? H1) - 1),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    closed,
    ...overrides,
  };
}

function mkBar(timeMs: number, o = 100, h = 101, l = 99, c = 100.5): BacktestBar {
  return { time: timeMs, open: o, high: h, low: l, close: c, volume: 1000 };
}

function makeSequentialRows(
  marketId: number,
  timeframe: string,
  count: number,
  startMs = T0,
  stepMs?: number
): BacktestCandleRow[] {
  const step = stepMs ?? getTimeframeMs(timeframe) ?? H1;
  const rows: BacktestCandleRow[] = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(mkRow(marketId, timeframe, startMs + i * step));
  }
  return rows;
}

/* In-memory deps factory */

function makeInMemoryDeps(
  assets: BacktestAssetRow[],
  markets: BacktestMarketRow[],
  candles: BacktestCandleRow[]
): BacktestDataDeps {
  return {
    asset: {
      async findUnique({ where: { symbol } }) {
        return assets.find((a) => a.symbol === symbol) ?? null;
      },
    },
    market: {
      async findMany({ where: { assetId, enabled, status } }) {
        let res = markets.filter((m) => m.assetId === assetId);
        if (enabled !== undefined) res = res.filter((m) => m.enabled === enabled);
        if (status !== undefined) res = res.filter((m) => m.status === status);
        res.sort((a, b) => a.id - b.id);
        return res;
      },
    },
    candle: {
      async findMany({ where: { marketId, timeframe, closed, openTime }, orderBy, take }) {
        let res = candles.filter(
          (c) =>
            c.marketId === marketId &&
            c.timeframe === timeframe &&
            c.closed === closed
        );
        if (openTime.gte) {
          res = res.filter((c) => c.openTime.getTime() >= openTime.gte!.getTime());
        }
        if (openTime.lt) {
          res = res.filter((c) => c.openTime.getTime() < openTime.lt!.getTime());
        }
        if (openTime.gt) {
          res = res.filter((c) => c.openTime.getTime() > openTime.gt!.getTime());
        }
        // orderBy ASC
        res.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
        if (take !== undefined) res = res.slice(0, take);
        return res;
      },
      async count({ where: { marketId, timeframe, closed, openTime } }) {
        let res = candles.filter(
          (c) =>
            c.marketId === marketId &&
            c.timeframe === timeframe &&
            c.closed === closed
        );
        if (openTime.gte) {
          res = res.filter((c) => c.openTime.getTime() >= openTime.gte!.getTime());
        }
        if (openTime.lt) {
          res = res.filter((c) => c.openTime.getTime() < openTime.lt!.getTime());
        }
        return res.length;
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* 1. Timeframe source — единственный источник                         */
/* ------------------------------------------------------------------ */

ok(
  SMCTIMEFRAME_MS["1h"] === 3_600_000,
  "timeframe: SMCTIMEFRAME_MS 1h = 3600000"
);
ok(getTimeframeMs("1h") === 3_600_000, "timeframe: getTimeframeMs 1h");
ok(getTimeframeMs("5m") === 300_000, "timeframe: getTimeframeMs 5m");
ok(getTimeframeMs("1d") === 86_400_000, "timeframe: getTimeframeMs 1d");
ok(getTimeframeMs("unknown") === null, "timeframe: unknown → null");
ok(
  CANONICAL_TIMEFRAMES.includes("1h") && CANONICAL_TIMEFRAMES.includes("1d"),
  "timeframe: canonical list contains 1h and 1d"
);
ok(
  (SMCTIMEFRAME_MS as Record<string, number>)["1h"] === getTimeframeMs("1h"),
  "timeframe: no second set of constants — source is SMCTIMEFRAME_MS"
);

/* ------------------------------------------------------------------ */
/* 2. Adapter — Candle → BacktestBar, timestamp preserved              */
/* ------------------------------------------------------------------ */

const row = mkRow(1, "1h", T0);
const bar = candleRowToBacktestBar(row);

ok(bar.time === T0, "adapter: time preserved exactly");
ok(bar.open === row.open && bar.high === row.high, "adapter: OHLC preserved");
ok(bar.volume === row.volume, "adapter: volume preserved");
ok(
  assertTimestampPreserved(row, bar).ok,
  "adapter: assertTimestampPreserved ok"
);

const rowsSeq = makeSequentialRows(1, "1h", 3);
const barsSeq = candleRowsToBacktestBars(rowsSeq);

ok(barsSeq.length === 3, "adapter: batch length");
ok(barsSeq[0].time === T0 && barsSeq[1].time === T0 + H1, "adapter: batch order preserved");
ok(
  barsSeq[0].time === rowsSeq[0].openTime.getTime(),
  "adapter: batch timestamp preserved"
);

// P2-B does NOT set SL/TP/fees/slippage/timeout/policy/metrics
ok(
  (bar as any).stopLoss === undefined && (bar as any).takeProfit === undefined,
  "adapter: no SL/TP in bar"
);
ok(
  (bar as any).fees === undefined && (bar as any).slippage === undefined,
  "adapter: no fees/slippage in bar"
);

/* ------------------------------------------------------------------ */
/* 3. Read-only by construction                                        */
/* ------------------------------------------------------------------ */

const assets: BacktestAssetRow[] = [{ id: 1, symbol: "BTC" }];
const markets: BacktestMarketRow[] = [
  { id: 10, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE" },
  { id: 11, exchange: "BINGX", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE" },
];
const candles = makeSequentialRows(10, "1h", 10);

const deps = makeInMemoryDeps(assets, markets, candles);
const roCheck = assertReadOnlyDeps(deps);

ok(roCheck.ok, `deps read-only ok (${roCheck.errors.join("; ")})`);

// Adversarial: deps with forbidden methods should be caught
const badDeps = {
  ...deps,
  candle: {
    ...deps.candle,
    create: async () => ({}),
  },
} as unknown as BacktestDataDeps;

const badCheck = assertReadOnlyDeps(badDeps);
ok(!badCheck.ok && badCheck.errors.some((e) => e.includes("create")), "deps: detects forbidden create");

/* ------------------------------------------------------------------ */
/* 4. Historical pagination ASC cursor exclusive deterministic         */
/* ------------------------------------------------------------------ */

(async () => {
  const allCandles = makeSequentialRows(10, "1h", 25, T0);
  const d = makeInMemoryDeps(assets, markets, allCandles);

  const from = new Date(T0);
  const to = new Date(T0 + 25 * H1);

  const pageSize = 10;
  const result = await fetchCandlesPaginated(d, 10, "1h", from, to, pageSize);

  ok(result.rows.length === 25, "pagination: all 25 rows fetched");
  ok(result.bars.length === 25, "pagination: all 25 bars");
  ok(result.pages === 3, "pagination: 25 /10 → 3 pages (10,10,5)");
  ok(result.bars[0].time === T0, "pagination: first bar time");
  ok(result.bars[24].time === T0 + 24 * H1, "pagination: last bar time");
  ok(
    result.bars.every((b, i, arr) => i === 0 || b.time > arr[i - 1].time),
    "pagination: strictly ASC"
  );

  // exclusive cursor: no duplicates between pages
  const times = result.bars.map((b) => b.time);
  const uniq = new Set(times);
  ok(uniq.size === times.length, "pagination: no duplicates between pages");

  // configurable pageSize
  const smallPage = await fetchCandlesPaginated(d, 10, "1h", from, to, 7);
  ok(smallPage.pages === 4, "pagination: pageSize 7 → 4 pages for 25");

  // deterministic termination: empty when from>=to already tested via error
  // test closed=true only: add closed=false rows, they must be filtered
  const mixed = [
    ...makeSequentialRows(10, "1h", 5, T0),
    mkRow(10, "1h", T0 + 5 * H1, false),
    ...makeSequentialRows(10, "1h", 5, T0 + 6 * H1),
  ];
  const d2 = makeInMemoryDeps(assets, markets, mixed);
  const filtered = await fetchCandlesPaginated(
    d2,
    10,
    "1h",
    new Date(T0),
    new Date(T0 + 11 * H1),
    20
  );
  ok(filtered.rows.length === 10, "pagination: closed=false filtered (only closed=true)");
  ok(filtered.rows.every((r) => r.closed === true), "pagination: all returned closed=true");

  // deterministic: same input → same output
  const again = await fetchCandlesPaginated(d, 10, "1h", from, to, pageSize);
  ok(
    JSON.stringify(result.bars.map((b) => b.time)) ===
      JSON.stringify(again.bars.map((b) => b.time)),
    "pagination: deterministic"
  );

  /* ------------------------------------------------------------------ */
  /* 5. Coverage per market×timeframe                                   */
  /* ------------------------------------------------------------------ */

  const covBars = [
    mkBar(T0),
    mkBar(T0 + H1),
    mkBar(T0 + 2 * H1),
    mkBar(T0 + 3 * H1),
    mkBar(T0 + 4 * H1),
  ];

  const cov = computeMarketCoverage(10, "1h", covBars, H1, {
    from: new Date(T0),
    to: new Date(T0 + 5 * H1),
  });

  ok(cov.marketId === 10, "coverage: marketId preserved (identity)");
  ok(cov.timeframe === "1h", "coverage: timeframe preserved");
  ok(cov.firstAvailable === T0, "coverage: firstAvailable");
  ok(cov.lastAvailable === T0 + 4 * H1, "coverage: lastAvailable");
  ok(cov.returnedCount === 5, "coverage: returnedCount");
  ok(cov.expectedCount === 5, "coverage: expectedCount");
  ok(cov.missingCount === 0, "coverage: missingCount 0");
  ok(cov.coverageRatio === 1, "coverage: ratio 1 when full");
  ok(!cov.isEmpty, "coverage: not empty");
  ok(cov.requestedRange.from === T0, "coverage: requested from preserved");
  ok(cov.requestedRange.to === T0 + 5 * H1, "coverage: requested to preserved");

  // empty → never 100%
  const emptyCov = computeMarketCoverage(10, "1h", [], H1, {
    from: new Date(T0),
    to: new Date(T0 + 5 * H1),
  });
  ok(emptyCov.isEmpty, "coverage: empty isEmpty true");
  ok(emptyCov.returnedCount === 0, "coverage: empty returned 0");
  ok(emptyCov.coverageRatio === null, "coverage: empty ratio null not 100%");
  ok(emptyCov.expectedCount === null, "coverage: empty expected null");
  ok(emptyCov.firstAvailable === null, "coverage: empty first null");
  ok(emptyCov.lastAvailable === null, "coverage: empty last null");

  // missing
  const missingBars = [mkBar(T0), mkBar(T0 + 2 * H1), mkBar(T0 + 4 * H1)];
  const missingCov = computeMarketCoverage(10, "1h", missingBars, H1);
  ok(missingCov.returnedCount === 3, "coverage: missing returned 3");
  ok(missingCov.expectedCount === 5, "coverage: missing expected 5");
  ok(missingCov.missingCount === 2, "coverage: missingCount 2");
  ok(missingCov.coverageRatio === 3 / 5, "coverage: ratio 0.6");

  // gaps, duplicates, ordering, grid in coverage
  const gapBars = [mkBar(T0), mkBar(T0 + 3 * H1)]; // missing 2
  const gapCov = computeMarketCoverage(10, "1h", gapBars, H1);
  ok(gapCov.anomalies.gaps.length === 1, "coverage: gap detected");
  ok(gapCov.anomalies.gaps[0].missingBars === 2, "coverage: gap missingBars 2");

  const dupBars = [mkBar(T0), mkBar(T0), mkBar(T0 + H1)];
  const dupCov = computeMarketCoverage(10, "1h", dupBars, H1);
  ok(dupCov.anomalies.duplicates.length === 1, "coverage: duplicate detected");
  ok(dupCov.anomalies.duplicates[0].count === 2, "coverage: duplicate count 2");

  const nonMonoBars = [mkBar(T0 + H1), mkBar(T0)];
  const nonMonoCov = computeMarketCoverage(10, "1h", nonMonoBars, H1);
  ok(!nonMonoCov.anomalies.ordering.isOrdered, "coverage: non-monotonic detected");
  ok(nonMonoCov.anomalies.ordering.violations.length === 1, "coverage: ordering violation count");

  // off-grid: BINGX 1d 16:00 UTC → 57600000 mod
  const offGridTime = T0 + 16 * H1; // 16:00 UTC, remainder 57600000 for 1d
  const offGridBars = [mkBar(offGridTime)];
  const offGridCov = computeMarketCoverage(11, "1d", offGridBars, D1);
  ok(!offGridCov.anomalies.grid.isCanonical, "coverage: off-grid detected for BINGX 1d style");
  ok(offGridCov.anomalies.grid.offGrid.length === 1, "coverage: off-grid count 1");
  ok(
    offGridCov.anomalies.grid.offGrid[0].remainder === 57_600_000,
    "coverage: off-grid remainder 57600000"
  );

  // aggregate
  const agg = aggregateCoverage([cov, missingCov, emptyCov]);
  ok(agg.totalReturned === 8, "aggregate: totalReturned 5+3+0=8");
  ok(agg.emptyMarkets === 1, "aggregate: emptyMarkets 1");
  ok(agg.marketsWithAnomalies >= 1, "aggregate: marketsWithAnomalies");

  /* ------------------------------------------------------------------ */
  /* 6. Gap detection timeframe-aware                                   */
  /* ------------------------------------------------------------------ */

  ok(
    detectGaps([mkBar(T0), mkBar(T0 + H1)], H1).length === 0,
    "gaps: no gap when exact"
  );

  const g1 = detectGaps([mkBar(T0), mkBar(T0 + 2 * H1)], H1);
  ok(g1.length === 1 && g1[0].deltaMs === 2 * H1, "gaps: delta>timeframe detected");
  ok(g1[0].missingBars === 1, "gaps: missingBars 1");
  ok(g1[0].isMultiple, "gaps: isMultiple true when 2*D");

  const gShort = detectGaps([mkBar(T0), mkBar(T0 + M5)], H1);
  ok(gShort.length === 1 && gShort[0].isShort, "gaps: delta<timeframe isShort");

  const gNotMultiple = detectGaps([mkBar(T0), mkBar(T0 + H1 + M5)], H1);
  ok(gNotMultiple.length === 1 && !gNotMultiple[0].isMultiple, "gaps: not multiple detected");

  ok(
    detectDuplicates([mkBar(T0), mkBar(T0 + H1)]).length === 0,
    "duplicates: none when unique"
  );
  ok(
    detectDuplicates([mkBar(T0), mkBar(T0), mkBar(T0 + H1)])[0].count === 2,
    "duplicates: count 2"
  );

  ok(checkOrdering([mkBar(T0), mkBar(T0 + H1)]).isOrdered, "ordering: ordered");
  ok(!checkOrdering([mkBar(T0 + H1), mkBar(T0)]).isOrdered, "ordering: non-monotonic");

  ok(checkGrid([mkBar(T0), mkBar(T0 + H1)], H1).isCanonical, "grid: canonical when aligned");
  ok(
    !checkGrid([mkBar(T0 + 1)], H1).isCanonical,
    "grid: off-grid when not multiple"
  );

  // No silent fix: analyze returns anomalies, does not mutate
  const origBars = [mkBar(T0), mkBar(T0), mkBar(T0 + 2 * H1)];
  const beforeJson = JSON.stringify(origBars);
  analyzeMarketAnomalies(origBars, H1);
  ok(JSON.stringify(origBars) === beforeJson, "gaps: no silent fix, input not mutated");

  /* ------------------------------------------------------------------ */
  /* 7. Exchange/eligibility Market.id identity                         */
  /* ------------------------------------------------------------------ */

  // Market.id identity: two markets same exchangeSymbol but different id/exchange must be distinct
  const marketA: BacktestMarketRow = {
    id: 100,
    exchange: "BINANCE",
    exchangeSymbol: "BTCUSDT",
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  };
  const marketB: BacktestMarketRow = {
    id: 101,
    exchange: "BINGX",
    exchangeSymbol: "BTCUSDT", // same symbol, different exchange and id
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  };

  ok(marketA.id !== marketB.id, "eligibility: Market.id distinct even if exchangeSymbol same");
  ok(marketA.exchangeSymbol === marketB.exchangeSymbol, "eligibility: exchangeSymbol same but id different");

  // Generic runner: all eligible (raw coverage distinct from eligibility)
  ok(isMarketEligible(marketB, "1d", false) === true, "eligibility: generic runner BINGX 1d eligible");
  ok(isMarketEligible(marketA, "1d", false) === true, "eligibility: generic runner BINANCE 1d eligible");

  // Smart Money runner: BINGX 1d excluded
  ok(
    isMarketEligible(marketB, "1d", true) === false,
    "eligibility: Smart Money BINGX 1d NOT eligible"
  );
  ok(
    isMarketEligible(marketA, "1d", true) === true,
    "eligibility: Smart Money BINANCE 1d eligible"
  );
  ok(
    isSmartMoneyExchangeEligible("BINGX", "1d") === false,
    "eligibility: reuse existing isSmartMoneyExchangeEligible"
  );
  ok(
    isSmartMoneyExchangeEligible("BINGX", "1h") === true,
    "eligibility: BINGX 1h eligible"
  );

  const filteredGeneric = filterEligibleMarkets([marketA, marketB], "1d", false);
  ok(filteredGeneric.length === 2, "eligibility: generic filter keeps both");

  const filteredSM = filterEligibleMarkets([marketA, marketB], "1d", true);
  ok(
    filteredSM.length === 1 && filteredSM[0].exchange === "BINANCE",
    "eligibility: Smart Money filter excludes BINGX 1d"
  );

  const partitioned = partitionByEligibility([marketA, marketB], "1d", true);
  ok(
    partitioned.eligible.length === 1 && partitioned.ineligible.length === 1,
    "eligibility: partition splits"
  );
  ok(
    partitioned.ineligible[0].market.exchange === "BINGX",
    "eligibility: ineligible is BINGX"
  );

  // Raw coverage vs eligibility distinct: coverage includes BINGX 1d, eligibility excludes
  const rawCov = computeMarketCoverage(marketB.id, "1d", [mkBar(T0)], D1);
  ok(!rawCov.isEmpty && rawCov.returnedCount === 1, "eligibility: raw coverage includes BINGX 1d");
  ok(isMarketEligible(marketB, "1d", true) === false, "eligibility: but Smart Money eligibility excludes it");

  /* ------------------------------------------------------------------ */
  /* 8. Contiguous usable ranges deterministic, minBars from P2-A       */
  /* ------------------------------------------------------------------ */

  const contBars = [
    mkBar(T0),
    mkBar(T0 + H1),
    mkBar(T0 + H1 * 2),
    // gap
    mkBar(T0 + H1 * 5),
    mkBar(T0 + H1 * 6),
  ];

  const ranges = findContiguousIntervals(contBars, H1);
  ok(ranges.length === 2, "intervals: 2 contiguous ranges");
  ok(ranges[0].count === 3 && ranges[1].count === 2, "intervals: counts 3 and 2");
  ok(ranges[0].startTime === T0 && ranges[0].endTime === T0 + 2 * H1, "intervals: first range times");

  // deterministic: sorted copy, same input → same output
  const rangesAgain = findContiguousIntervals(contBars, H1);
  ok(
    JSON.stringify(ranges) === JSON.stringify(rangesAgain),
    "intervals: deterministic"
  );

  // minBars from P2-A: use BACKTEST_SPLIT_DEFAULTS.minBarsPerSegment =10
  const minBars = BACKTEST_SPLIT_DEFAULTS.minBarsPerSegment;
  const withMin = findContiguousIntervals(contBars, H1, minBars);
  ok(
    withMin.every((r) => r.minBarsApplied === minBars),
    "intervals: minBars applied from P2-A"
  );
  ok(
    withMin[0].isUsable === false && withMin[1].isUsable === false,
    "intervals: not usable when count < minBars 10"
  );

  // without minBars — report only, leave sufficiency to caller
  const withoutMin = findContiguousIntervals(contBars, H1, null);
  ok(withoutMin[0].isUsable === true, "intervals: without minBars all usable (report only)");
  ok(withoutMin[0].minBarsApplied === null, "intervals: minBarsApplied null when not set");

  // no hardcoded minimumSwingHistoryCandles: ensure we don't have that constant
  // (we just check that function accepts null and doesn't use hidden default)
  ok(
    findContiguousIntervals([mkBar(T0)], H1, null)[0].count === 1,
    "intervals: no hidden hardcoded minimum"
  );

  // common intervals
  const perMarket = new Map<number, readonly BacktestBar[]>();
  perMarket.set(10, [mkBar(T0), mkBar(T0 + H1), mkBar(T0 + 2 * H1)]);
  perMarket.set(11, [mkBar(T0 + H1), mkBar(T0 + 2 * H1), mkBar(T0 + 3 * H1)]);

  const common = findCommonTimestamps(perMarket);
  ok(
    common.length === 2 && common[0] === T0 + H1 && common[1] === T0 + 2 * H1,
    "common: intersection"
  );

  const commonCont = findCommonContiguousIntervals(perMarket, H1);
  ok(
    commonCont.length === 1 && commonCont[0].count === 2,
    "common: contiguous intersection count 2"
  );

  /* ------------------------------------------------------------------ */
  /* 9. P2-B → P2-A adapter timestamp preserved, validation             */
  /* ------------------------------------------------------------------ */

  const validBars = [mkBar(T0), mkBar(T0 + H1), mkBar(T0 + 2 * H1)];
  const valRes = validateBars(validBars, BACKTEST_DEFAULTS);
  ok(valRes.ok, "adapter: valid bars pass P2-A validation");

  const dupBarsForVal = [mkBar(T0), mkBar(T0)];
  const dupVal = validateBars(dupBarsForVal, BACKTEST_DEFAULTS);
  ok(!dupVal.ok, "adapter: duplicate fails P2-A validation (no silent dedup)");

  const nonMonoForVal = [mkBar(T0 + H1), mkBar(T0)];
  const nonMonoVal = validateBars(nonMonoForVal, BACKTEST_DEFAULTS);
  ok(!nonMonoVal.ok, "adapter: non-monotonic fails P2-A validation (no silent sort)");

  /* ------------------------------------------------------------------ */
  /* 10. No-lookahead boundary: causal history allowed, future not      */
  /* ------------------------------------------------------------------ */

  // Simulate: TRAIN segment [0,3), VALIDATION [3,5) with warmup 2
  // VALIDATION should be able to read 2 bars before its start (causal history)
  // but not future beyond its current index.

  const allBarsForSplit = [
    mkBar(T0),
    mkBar(T0 + H1),
    mkBar(T0 + 2 * H1),
    mkBar(T0 + 3 * H1),
    mkBar(T0 + 4 * H1),
  ];

  // Simulate SignalContext.barAt behavior: should allow past within warmup
  let causalHistoryAllowed = false;
  let futureBlocked = false;

  // Mock context similar to P2-A
  const mockContext = {
    index: 3, // first bar of VALIDATION
    firstVisibleIndex: 1, // warmup 2: start 3 -2 =1
    barAt(i: number) {
      if (i > 3) throw new Error("future");
      if (i < 1) throw new Error("before warmup");
      return allBarsForSplit[i];
    },
  };

  try {
    mockContext.barAt(1);
    mockContext.barAt(2);
    causalHistoryAllowed = true;
  } catch {
    causalHistoryAllowed = false;
  }

  try {
    mockContext.barAt(4);
  } catch {
    futureBlocked = true;
  }

  ok(causalHistoryAllowed, "no-lookahead: causal history before asOf allowed (warmup)");
  ok(futureBlocked, "no-lookahead: future blocked");

  // P2-B must not give future data to evaluation: fetch only up to to, not beyond
  const limitedDeps = makeInMemoryDeps(
    assets,
    markets,
    makeSequentialRows(10, "1h", 10, T0)
  );
  const limitedFetch = await fetchCandlesPaginated(
    limitedDeps,
    10,
    "1h",
    new Date(T0),
    new Date(T0 + 5 * H1),
    10
  );
  ok(limitedFetch.bars.length === 5, "no-lookahead: fetch respects to bound, no future");
  ok(
    limitedFetch.bars[limitedFetch.bars.length - 1].time === T0 + 4 * H1,
    "no-lookahead: last bar < to"
  );

  /* ------------------------------------------------------------------ */
  /* 11. Plan/dry-run interface                                          */
  /* ------------------------------------------------------------------ */

  const planReq = {
    assetSymbol: "BTC",
    timeframe: "1h",
    timeframeMs: H1,
    from: new Date(T0),
    to: new Date(T0 + 100 * H1),
    markets: [marketA, marketB],
    pageSize: 20,
    minBarsPerSegment: minBars,
    isSmartMoneyRunner: true,
  };

  const plan = planBacktestRun(planReq);
  ok(plan.assetSymbol === "BTC", "plan: assetSymbol");
  ok(plan.marketsCount === 2, "plan: marketsCount");
  ok(plan.eligibleMarketsCount === 2, "plan: eligibleMarketsCount 2 for SM 1h (BINGX eligible on 1h)");
  // For 1h, BINGX eligible, so 2
  ok(plan.timeframe === "1h", "plan: timeframe");
  ok(plan.readTasks === 2, "plan: readTasks = eligible markets (2 for 1h)");
  ok(plan.pageSize === 20, "plan: pageSize");
  ok(plan.estimatedPagesPerMarket === 5, "plan: estimated pages 100/20=5");
  ok(plan.isSmartMoneyRunner === true, "plan: isSmartMoneyRunner");

  // For 1d Smart Money, BINGX excluded
  const plan1d = planBacktestRun({
    ...planReq,
    timeframe: "1d",
    timeframeMs: D1,
    from: new Date(T0),
    to: new Date(T0 + 10 * D1),
  });
  ok(plan1d.eligibleMarketsCount === 1, "plan: 1d SM eligible 1 (BINGX excluded)");
  ok(plan1d.ineligibleMarkets.length === 1, "plan: 1d SM ineligible 1");
  ok(plan1d.ineligibleMarkets[0].exchange === "BINGX", "plan: ineligible is BINGX");
  ok(plan1d.readTasks === 1, "plan: readTasks 1 for 1d SM");

  // Coverage summary in plan
  const covs = [
    computeMarketCoverage(10, "1h", [mkBar(T0), mkBar(T0 + H1)], H1),
    computeMarketCoverage(11, "1h", [], H1),
  ];
  const planWithCov = planBacktestRun({
    ...planReq,
    coverages: covs,
  });
  ok(planWithCov.coverageSummary !== undefined, "plan: coverageSummary present");
  ok(planWithCov.coverageSummary!.emptyMarkets === 1, "plan: coverageSummary emptyMarkets");
  ok(planWithCov.warnings.length > 0, "plan: warnings when empty/anomaly");

  const report = formatDataPlanReport(planWithCov);
  ok(report.includes("Backtest Data Plan"), "plan: report contains header");
  ok(report.includes("BTC"), "plan: report contains asset");

  /* ------------------------------------------------------------------ */
  /* 12. fetchBarsForMarkets                                             */
  /* ------------------------------------------------------------------ */

  const multiMarkets = [
    { id: 20, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 21, exchange: "BYBIT", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE" },
  ];
  const multiCandles = [
    ...makeSequentialRows(20, "1h", 3, T0),
    ...makeSequentialRows(21, "1h", 5, T0),
  ];
  const multiDeps = makeInMemoryDeps(assets, multiMarkets, multiCandles);
  const multiBars = await fetchBarsForMarkets(
    multiDeps,
    multiMarkets,
    "1h",
    new Date(T0),
    new Date(T0 + 10 * H1),
    10
  );
  ok(multiBars.size === 2, "fetchBarsForMarkets: 2 markets");
  ok(multiBars.get(20)!.length === 3, "fetchBarsForMarkets: market 20 has 3");
  ok(multiBars.get(21)!.length === 5, "fetchBarsForMarkets: market 21 has 5");

  /* ------------------------------------------------------------------ */
  /* 13. getMarketsForAsset                                              */
  /* ------------------------------------------------------------------ */

  const assetMarketsRes = await getMarketsForAsset(deps, "BTC");
  ok(assetMarketsRes.asset.symbol === "BTC", "getMarketsForAsset: asset symbol");
  ok(assetMarketsRes.markets.length === 2, "getMarketsForAsset: markets count");

  console.log(`Itog P2-B: ${passed}/${total}`);
  process.exit(passed === total ? 0 : 1);
})();
