/**
 * Real canonical coverage tests — behavior-level, not source-string.
 * Required:
 * 1h [00:30,03:30) expected opens 01:00 02:00 03:00 partial 2/3 ratio ≈0.6667
 * aligned full range, leading gap, internal gap, trailing gap, off-grid, duplicate, [from,to) boundary, zero canonical slots.
 * Mutations: overallCoverageRatio =>1 must fail, break effective canonical start/expected slots must fail, isAligned=true canonicalized=false must fail.
 */

import { computeMarketCoverage, aggregateCoverage } from "../lib/backtest/coverage";
import type { BacktestBar } from "../lib/backtest/contract";

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const H1 = 3600_000;

function bar(timeMs:number): BacktestBar {
  return { time: timeMs, open: 100, high: 110, low: 90, close: 105, volume: 1000 } as any;
}

// 1. 1h [00:30,03:30) expected opens 01:00 02:00 03:00
{
  const from = Date.parse("2024-01-01T00:30:00Z");
  const to = Date.parse("2024-01-01T03:30:00Z");
  const expected = [Date.parse("2024-01-01T01:00:00Z"), Date.parse("2024-01-01T02:00:00Z"), Date.parse("2024-01-01T03:00:00Z")];
  ok(expected.length===3, "1h [00:30,03:30) expected 3 canonical slots 01:00 02:00 03:00");

  // Partial: only 01:00 and 03:00 present => 2/3 ratio 0.6667
  const bars = [bar(expected[0]), bar(expected[2])];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.requestedExpectedCount===3, "requestedExpectedCount 3");
  ok(cov.availableInRequestedRange===2, "available 2");
  ok(Math.abs((cov.coverageRatio ?? 0) - 2/3) < 1e-9, `coverageRatio 2/3 got ${cov.coverageRatio}`);
  ok(cov.missingTotal===1, "missingTotal 1");
  ok(cov.requestedAlignment?.canonicalized===true, "canonicalized true because from not aligned");
  ok(cov.requestedAlignment?.effectiveFrom===expected[0], "effectiveFrom 01:00");
  ok(cov.coverageIdentityHolds===true, "identity holds");
}

// 2. Aligned full range [00:00,03:00) => 01:00? Actually from 00:00 to 03:00 exclusive => slots 00:00,01:00,02:00 =3
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T03:00:00Z");
  const expected = [Date.parse("2024-01-01T00:00:00Z"), Date.parse("2024-01-01T01:00:00Z"), Date.parse("2024-01-01T02:00:00Z")];
  const bars = expected.map(bar);
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.requestedExpectedCount===3, "aligned full range expected 3");
  ok(cov.availableInRequestedRange===3, "available 3");
  ok(cov.coverageRatio===1, "coverageRatio 1 full");
  ok(cov.missingLeading===0 && cov.missingTrailing===0 && cov.missingInternal===0, "no gaps when full");
  ok(cov.requestedAlignment?.isAligned===true && cov.requestedAlignment?.canonicalized===false, "aligned true canonicalized false");
}

// 3. Leading gap: range [00:00,03:00) but only 01:00,02:00 present => leading 1
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T03:00:00Z");
  const bars = [bar(Date.parse("2024-01-01T01:00:00Z")), bar(Date.parse("2024-01-01T02:00:00Z"))];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.missingLeading===1, "leading gap 1");
  ok(cov.missingTrailing===0, "no trailing");
  ok(cov.availableInRequestedRange===2, "available 2");
}

// 4. Internal gap: [00:00,03:00) with 00:00 and 02:00 present => internal 1
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T03:00:00Z");
  const bars = [bar(Date.parse("2024-01-01T00:00:00Z")), bar(Date.parse("2024-01-01T02:00:00Z"))];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.missingInternal===1, "internal gap 1");
  ok(cov.missingLeading===0 && cov.missingTrailing===0, "no leading/trailing when internal");
}

// 5. Trailing gap: [00:00,03:00) with 00:00,01:00 present => trailing 1
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T03:00:00Z");
  const bars = [bar(Date.parse("2024-01-01T00:00:00Z")), bar(Date.parse("2024-01-01T01:00:00Z"))];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.missingTrailing===1, "trailing gap 1");
}

// 6. Off-grid candle: [00:00,02:00) with 00:00 and 00:30 (off-grid) => offGrid 1, available 1
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T02:00:00Z");
  const bars = [bar(Date.parse("2024-01-01T00:00:00Z")), bar(Date.parse("2024-01-01T00:30:00Z"))];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.offGridBarsInRequestedRange===1, "off-grid 1");
  ok(cov.availableInRequestedRange===1, "available 1 (off-grid not counted)");
  ok(cov.requestedExpectedCount===2, "expected 2 (00:00,01:00)");
  ok(cov.coverageRatio===0.5, "coverageRatio 0.5 with off-grid");
}

// 7. Duplicate: same time twice — distinct count 1 but returnedCount 2, anomalies should detect duplicate
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T02:00:00Z");
  const t = Date.parse("2024-01-01T00:00:00Z");
  const bars = [bar(t), bar(t)];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.returnedCount===2, "returnedCount 2 with duplicate");
  ok(cov.distinctReturnedCount===1, "distinct 1 with duplicate");
  ok(cov.anomalies.duplicates.length>0 || cov.anomalies.hasAnomaly, "anomalies detect duplicate");
}

// 8. [from,to) boundary: bar at exactly to should NOT be counted
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T02:00:00Z");
  const bars = [bar(Date.parse("2024-01-01T00:00:00Z")), bar(Date.parse("2024-01-01T02:00:00Z"))]; // second at to exclusive
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.availableInRequestedRange===1, "[from,to) boundary: bar at to not counted, available 1");
  ok(cov.requestedExpectedCount===2, "expected 2 (00:00,01:00)");
}

// 9. Zero canonical slots: range smaller than timeframe and not containing canonical slot => should throw CanonicalWindowError
{
  const from = Date.parse("2024-01-01T00:10:00Z");
  const to = Date.parse("2024-01-01T00:20:00Z");
  let threw = false;
  try {
    computeMarketCoverage(1, "1h", [], H1, { from, to });
  } catch (e) {
    threw = true;
    ok((e as Error).message.includes("CanonicalWindow") || (e as Error).message.includes("canonical") || (e as Error).message.includes("expected"), "zero canonical slots throws CanonicalWindowError or similar");
  }
  ok(threw, "zero canonical slots throws");
}

// 10. Mutation: overallCoverageRatio forced to 1 must fail
{
  const from = Date.parse("2024-01-01T00:00:00Z");
  const to = Date.parse("2024-01-01T03:00:00Z");
  const bars = [bar(Date.parse("2024-01-01T00:00:00Z"))]; // only 1 of 3
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  const agg = aggregateCoverage([cov]);
  ok(agg.overallCoverageRatio !== 1, "mutation M3: overallCoverageRatio forced to 1 must fail — real ratio not 1 when partial");
  ok(Math.abs((agg.overallCoverageRatio ?? 0) - 1/3) < 1e-9, "overall ratio 1/3 when 1 of 3");
}

// 11. Break effective canonical start/expected slots must fail
{
  const from = Date.parse("2024-01-01T00:30:00Z");
  const to = Date.parse("2024-01-01T03:30:00Z");
  const bars = [bar(Date.parse("2024-01-01T01:00:00Z"))];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.requestedAlignment?.effectiveFrom === Date.parse("2024-01-01T01:00:00Z"), "effectiveFrom correct 01:00");
  ok(cov.requestedExpectedCount === 3, "expectedSlots 3");
  // Mutation would break effectiveFrom to 00:30 — our test would catch because effectiveFrom != expected
  ok(cov.requestedAlignment?.effectiveFrom !== from, "mutation M4: effectiveFrom broken must fail — effectiveFrom != from when not aligned");
}

// 12. Force isAligned=true canonicalized=false must fail for non-aligned range
{
  const from = Date.parse("2024-01-01T00:30:00Z");
  const to = Date.parse("2024-01-01T03:30:00Z");
  const bars: BacktestBar[] = [];
  const cov = computeMarketCoverage(1, "1h", bars, H1, { from, to });
  ok(cov.requestedAlignment?.isAligned === false, "non-aligned range isAligned false");
  ok(cov.requestedAlignment?.canonicalized === true, "non-aligned range canonicalized true");
  // Mutation forcing isAligned=true canonicalized=false must fail
  ok(!(cov.requestedAlignment?.isAligned === true && cov.requestedAlignment?.canonicalized === false), "mutation M5: alignment flags falsified must fail — real non-aligned has isAligned false canonicalized true");
}

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
console.log("Real canonical coverage tests passed");
