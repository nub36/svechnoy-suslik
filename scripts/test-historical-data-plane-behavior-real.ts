/**
 * Plane-level behavior tests using REAL production-built historical data plane.
 * Must test non-aligned partial range, overallCoverageRatio !=1, effectiveCanonicalRange, isAligned/canonicalized.
 * Mutations at historical-data-plane projection level must be killed.
 */

import { fetchHistoricalDataPlane } from "../lib/backtest/historical-data-plane";
import type { BacktestDataDepsV2, BacktestMarketRow } from "../lib/backtest/data-source";

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const H1 = 3600_000;
const T0 = Date.UTC(2024,0,1,0,0,0,0);

function mkRow(marketId:number, openTimeMs:number, timeframe="1h"){
  return {
    marketId,
    timeframe,
    openTime: new Date(openTimeMs),
    closeTime: new Date(openTimeMs+H1-1),
    open: 100, high: 101, low: 99, close: 100.5, volume: 1000, closed: true,
  };
}

const market1: BacktestMarketRow = { id: 1, exchange: "BINANCE", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE" };
const market2: BacktestMarketRow = { id: 2, exchange: "BYBIT", exchangeSymbol: "BTCUSDT", assetId: 1, enabled: true, status: "ACTIVE" };

(async () => {
  // Build candles: market1 has full 10 bars, market2 has partial 2 bars -> overallCoverageRatio !=1
  const fullRows: any[] = [];
  const partialRows: any[] = [];
  for (let i=0;i<10;i++){
    fullRows.push(mkRow(1, T0 + i*H1));
    if (i<2) partialRows.push(mkRow(2, T0 + i*H1));
  }
  const mapFull = new Map<number, any[]>();
  mapFull.set(1, fullRows);
  mapFull.set(2, partialRows);

  const depsPartial: BacktestDataDepsV2 = {
    findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }: any) => {
      const all = mapFull.get(marketId) ?? [];
      let filtered = all.filter((r:any)=>{ const t=r.openTime.getTime(); return t>=from.getTime() && t<to.getTime(); });
      if (cursorOpenTime) filtered = filtered.filter((r:any)=>r.openTime.getTime() > cursorOpenTime.getTime());
      filtered.sort((a:any,b:any)=>a.openTime.getTime()-b.openTime.getTime());
      return filtered.slice(0, take);
    },
  };

  // 1. Non-aligned partial range [00:30,03:30) — should be canonicalized, isAligned false, canonicalized true, effectiveCanonicalRange from 01:00
  const fromNonAligned = new Date(Date.parse("2024-01-01T00:30:00Z"));
  const toNonAligned = new Date(Date.parse("2024-01-01T03:30:00Z"));
  const planeNonAligned = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from: fromNonAligned,
    to: toNonAligned,
    markets: [market1],
    deps: {
      findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }: any) => {
        // Provide 3 bars at 01:00,02:00,03:00 but only 2 present to test partial
        const all = [mkRow(marketId, Date.parse("2024-01-01T01:00:00Z")), mkRow(marketId, Date.parse("2024-01-01T03:00:00Z"))];
        let filtered = all.filter((r:any)=>r.openTime.getTime()>=from.getTime() && r.openTime.getTime()<to.getTime());
        if (cursorOpenTime) filtered = filtered.filter((r:any)=>r.openTime.getTime()>cursorOpenTime.getTime());
        return filtered.slice(0, take);
      },
    } as any,
    isSmartMoneyRunner: false,
  });

  ok(planeNonAligned.effectiveCanonicalRange !== null, "plane non-aligned has effectiveCanonicalRange");
  ok(planeNonAligned.effectiveCanonicalRange?.isAligned === false, "non-aligned isAligned false");
  ok(planeNonAligned.effectiveCanonicalRange?.canonicalized === true, "non-aligned canonicalized true");
  ok(planeNonAligned.effectiveCanonicalRange?.expectedSlots === 3, "non-aligned expectedSlots 3 (01:00,02:00,03:00)");
  ok(planeNonAligned.effectiveCanonicalRange?.from === "2024-01-01T01:00:00.000Z", `effective from 01:00 got ${planeNonAligned.effectiveCanonicalRange?.from}`);
  ok(planeNonAligned.overallCoverageRatio !== null && Math.abs(planeNonAligned.overallCoverageRatio - 2/3) < 1e-9, `overallCoverageRatio 2/3 for partial, got ${planeNonAligned.overallCoverageRatio}`);
  ok(planeNonAligned.warnings.some(w=>w.toLowerCase().includes("canonical") || w.includes("not on canonical")), "warnings mention canonical not aligned");

  // 2. overallCoverageRatio !=1 via plane built from partial markets
  const fromAligned = new Date(T0);
  const toAligned = new Date(T0 + 10*H1);
  const planePartial = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from: fromAligned,
    to: toAligned,
    markets: [market1, market2],
    deps: depsPartial,
    isSmartMoneyRunner: false,
  });

  ok(planePartial.marketsCount===2, "plane partial marketsCount 2");
  ok(planePartial.overallCoverageRatio !== null && planePartial.overallCoverageRatio < 1, `overallCoverageRatio !=1, got ${planePartial.overallCoverageRatio}`);
  ok(planePartial.aggregatedCoverage.totalRequestedExpected === 20, `totalRequestedExpected 20 (10+10) got ${planePartial.aggregatedCoverage.totalRequestedExpected}`);
  ok(planePartial.aggregatedCoverage.totalAvailableInRequested === 12, `totalAvailable 12 (10+2) got ${planePartial.aggregatedCoverage.totalAvailableInRequested}`);
  ok(Math.abs((planePartial.overallCoverageRatio ?? 0) - 0.6) < 1e-9, `overallCoverageRatio 0.6 got ${planePartial.overallCoverageRatio}`);

  // 3. effectiveCanonicalRange for aligned full range
  const planeFull = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from: new Date(T0),
    to: new Date(T0 + 3*H1),
    markets: [market1],
    deps: {
      findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }: any) => {
        const all = [mkRow(marketId, T0), mkRow(marketId, T0+H1), mkRow(marketId, T0+2*H1)];
        let f = all.filter((r:any)=>r.openTime.getTime()>=from.getTime() && r.openTime.getTime()<to.getTime());
        if (cursorOpenTime) f = f.filter((r:any)=>r.openTime.getTime()>cursorOpenTime.getTime());
        return f.slice(0, take);
      },
    } as any,
    isSmartMoneyRunner: false,
  });

  ok(planeFull.effectiveCanonicalRange?.isAligned === true, "aligned full isAligned true");
  ok(planeFull.effectiveCanonicalRange?.canonicalized === false, "aligned full canonicalized false");
  ok(planeFull.effectiveCanonicalRange?.expectedSlots === 3, "aligned full expectedSlots 3");
  ok(planeFull.overallCoverageRatio === 1, "aligned full overallCoverageRatio 1");

  // 4. Mutations at historical-data-plane projection level must be killed
  // Mutation: force overallCoverageRatio to 1 when partial — should be killed (real is <1)
  ok(planePartial.overallCoverageRatio !== 1, "mutation kill: projection forced overallCoverageRatio 1 must fail — real partial <1");
  // Mutation: break effectiveCanonicalRange from — should be killed
  ok(planeNonAligned.effectiveCanonicalRange?.from !== fromNonAligned.toISOString(), "mutation kill: effectiveCanonicalRange from broken must fail — effective from != requested from when non-aligned");
  // Mutation: falsify isAligned/canonicalized
  ok(!(planeNonAligned.effectiveCanonicalRange?.isAligned === true && planeNonAligned.effectiveCanonicalRange?.canonicalized === false), "mutation kill: isAligned true canonicalized false falsified must fail for non-aligned");
  // Mutation: off-grid counted as available — plane should have offGrid separate and not counted
  const planeOffGrid = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from: new Date(T0),
    to: new Date(T0 + 2*H1),
    markets: [market1],
    deps: {
      findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }: any) => {
        const all = [mkRow(marketId, T0), { ...mkRow(marketId, T0+30*60*1000), openTime: new Date(T0+30*60*1000) }]; // 00:30 off-grid
        let f = all.filter((r:any)=>r.openTime.getTime()>=from.getTime() && r.openTime.getTime()<to.getTime());
        if (cursorOpenTime) f = f.filter((r:any)=>r.openTime.getTime()>cursorOpenTime.getTime());
        return f.slice(0, take);
      },
    } as any,
    isSmartMoneyRunner: false,
  });
  ok(planeOffGrid.marketResults[0].offGrid === 1, "off-grid detected 1");
  ok(planeOffGrid.marketResults[0].coverage.availableInRequestedRange === 1, "off-grid not counted as available");
  ok(planeOffGrid.overallCoverageRatio === 0.5, "off-grid plane ratio 0.5");

  console.log(`\nPassed ${passed}/${passed+failed}`);
  if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
  console.log("Historical data plane real behavior tests passed — non-aligned, ratio !=1, effectiveCanonicalRange, isAligned/canonicalized, projection mutations killed");
})();
