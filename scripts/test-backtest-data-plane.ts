/**
 * Data plane + eligibility + provenance + read-only SQL tests — Phase A.
 */

import { assertReadOnlySql, assertReadOnlyPrismaMethod, buildReadOnlyTransactionSql } from "../lib/backtest/read-only-sql";
import { buildHistoricalEligibilityDiagnostics, formatEligibilityDiagnosticsReport } from "../lib/backtest/historical-eligibility";
import { computeOhlcvProvenanceDiagnostics, formatOhlcvProvenanceReport, auditCandleWritePaths } from "../lib/backtest/ohlcv-provenance";
import { fetchHistoricalDataPlane } from "../lib/backtest/historical-data-plane";
import type { BacktestDataDepsV2, BacktestMarketRow } from "../lib/backtest/data-source";
import type { SmcRawCandle } from "../lib/smc/types";

let passed = 0;
let total = 0;

function ok(cond: boolean, label: string): void {
  total++;
  if (cond) passed++;
  else console.error(`FAIL: ${label}`);
}

const H1 = 3_600_000;
const T0 = Date.UTC(2024, 0, 1, 0, 0, 0, 0);

function mkCandleRow(marketId: number, openTimeMs: number, timeframe = "1h") {
  return {
    marketId,
    timeframe,
    openTime: new Date(openTimeMs),
    closeTime: new Date(openTimeMs + H1 - 1),
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 1000,
    closed: true,
  };
}

(async () => {
  console.log("=== Data plane / eligibility / provenance / read-only SQL tests ===");

  // 1. Read-only SQL allowlist
  const sel = assertReadOnlySql("SELECT * FROM Candle WHERE marketId=1");
  ok(sel.ok, "SELECT allowed");

  const withCte = assertReadOnlySql("WITH recent AS (SELECT * FROM Candle) SELECT * FROM recent");
  ok(withCte.ok, "WITH (CTE) allowed");

  const insert = assertReadOnlySql("INSERT INTO Candle VALUES (1)");
  ok(!insert.ok, "INSERT forbidden");

  const update = assertReadOnlySql("UPDATE Candle SET close=100 WHERE id=1");
  ok(!update.ok, "UPDATE forbidden");

  const del = assertReadOnlySql("DELETE FROM Candle WHERE id=1");
  ok(!del.ok, "DELETE forbidden");

  const create = assertReadOnlySql("CREATE TABLE foo (id int)");
  ok(!create.ok, "CREATE forbidden");

  const drop = assertReadOnlySql("DROP TABLE Candle");
  ok(!drop.ok, "DROP forbidden");

  const truncate = assertReadOnlySql("TRUNCATE TABLE Candle");
  ok(!truncate.ok, "TRUNCATE forbidden");

  const lock = assertReadOnlySql("LOCK TABLE Candle IN EXCLUSIVE MODE");
  ok(!lock.ok, "LOCK forbidden");

  const copy = assertReadOnlySql("COPY Candle TO '/tmp/file'");
  ok(!copy.ok, "COPY forbidden");

  const advLock = assertReadOnlySql("SELECT pg_advisory_lock(1)");
  ok(!advLock.ok, "pg_advisory_lock forbidden");

  const forUpdate = assertReadOnlySql("SELECT * FROM Candle FOR UPDATE");
  ok(!forUpdate.ok, "SELECT FOR UPDATE forbidden");

  const forShare = assertReadOnlySql("SELECT * FROM Candle FOR SHARE");
  ok(!forShare.ok, "SELECT FOR SHARE forbidden");

  const multi = assertReadOnlySql("SELECT * FROM Candle; DELETE FROM Candle");
  ok(!multi.ok, "multiple statements forbidden");

  const prismaFind = assertReadOnlyPrismaMethod("findMany");
  ok(prismaFind.ok, "Prisma findMany allowed");

  const prismaCreate = assertReadOnlyPrismaMethod("create");
  ok(!prismaCreate.ok, "Prisma create forbidden");

  const prismaUpdate = assertReadOnlyPrismaMethod("update");
  ok(!prismaUpdate.ok, "Prisma update forbidden");

  const roSql = buildReadOnlyTransactionSql();
  ok(roSql === "SET TRANSACTION READ ONLY", "read-only transaction SQL");

  // 2. Historical eligibility diagnostics
  const diagNull = buildHistoricalEligibilityDiagnostics(null);
  ok(diagNull.methodology === null, "null methodology");
  ok(diagNull.reconstructability === "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY", "cannot reconstruct when null");
  ok(!diagNull.canReportProfitability, "cannot report profitability when null");
  ok(diagNull.fields.length === 5, "5 fields");

  const diagE1 = buildHistoricalEligibilityDiagnostics("E1");
  ok(diagE1.methodology === "E1", "E1 methodology");
  ok(diagE1.fields.every((f) => f.currentValueUsed === true), "E1 currentValueUsed true");

  const diagE2 = buildHistoricalEligibilityDiagnostics("E2");
  ok(diagE2.methodology === "E2", "E2 methodology");
  ok(diagE2.fields.every((f) => f.currentValueUsed === false), "E2 currentValueUsed false");

  const diagE3 = buildHistoricalEligibilityDiagnostics("E3");
  ok(diagE3.methodology === "E3", "E3 methodology");
  ok(diagE3.reconstructability === "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY", "E3 cannot reconstruct");

  const reportE1 = formatEligibilityDiagnosticsReport(diagE1);
  ok(reportE1.includes("E1") && reportE1.includes("Asset.rank"), "E1 report contains E1 and Asset.rank");

  // 3. OHLCV provenance
  const provRows = [
    {
      marketId: 1,
      timeframe: "1h",
      openTime: new Date(T0),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
      closed: true,
      createdAt: new Date(T0),
      updatedAt: new Date(T0),
    },
    {
      marketId: 1,
      timeframe: "1h",
      openTime: new Date(T0 + H1),
      open: 100,
      high: 101,
      low: 99,
      close: 100.5,
      volume: 1000,
      closed: true,
      createdAt: new Date(T0),
      updatedAt: new Date(T0 + 1000), // updated after creation
    },
  ];

  const provDiag = computeOhlcvProvenanceDiagnostics(provRows as any);
  ok(provDiag.totalRows === 2, "provenance totalRows 2");
  ok(provDiag.rowsWithCreatedAt === 2, "rowsWithCreatedAt 2");
  ok(provDiag.rowsWhereUpdatedAtDiffersFromCreatedAt === 1, "diff 1");
  ok(provDiag.knownLimitations.length > 0, "knownLimitations non-empty");
  ok(provDiag.writePathAudits.length > 0, "writePathAudits non-empty");
  ok(provDiag.writePathAudits[0].file === "lib/ohlcv/sync.ts", "write path audit file");

  const provReport = formatOhlcvProvenanceReport(provDiag);
  ok(provReport.includes("createdAt") && provReport.includes("updatedAt"), "provenance report contains createdAt/updatedAt");

  const auditOk = auditCandleWritePaths(["lib/ohlcv/sync.ts"]);
  ok(auditOk.ok, "audit ok when only expected file");

  const auditUnexpected = auditCandleWritePaths(["lib/ohlcv/sync.ts", "lib/other.ts"]);
  ok(!auditUnexpected.ok && auditUnexpected.unexpected.length === 1, "audit fails on unexpected file");

  // 4. Historical data plane with mock deps
  const market1: BacktestMarketRow = {
    id: 1,
    exchange: "BINANCE",
    exchangeSymbol: "BTCUSDT",
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  };
  const market2: BacktestMarketRow = {
    id: 2,
    exchange: "BINGX",
    exchangeSymbol: "BTCUSDT",
    assetId: 1,
    enabled: true,
    status: "ACTIVE",
  };

  const candlesMap = new Map<number, any[]>();
  const rows1: any[] = [];
  const rows2: any[] = [];
  for (let i = 0; i < 10; i++) {
    rows1.push(mkCandleRow(1, T0 + i * H1, "1h"));
    rows2.push(mkCandleRow(2, T0 + i * H1, "1h"));
  }
  candlesMap.set(1, rows1);
  candlesMap.set(2, rows2);

  const rows1d_1: any[] = [];
  const rows1d_2: any[] = [];
  for (let i = 0; i < 10; i++) {
    rows1d_1.push(mkCandleRow(1, T0 + i * 24 * H1, "1d"));
    rows1d_2.push(mkCandleRow(2, T0 + i * 24 * H1, "1d"));
  }
  const candlesMap1d = new Map<number, any[]>();
  candlesMap1d.set(1, rows1d_1);
  candlesMap1d.set(2, rows1d_2);

  const deps: BacktestDataDepsV2 = {
    findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }) => {
      const all = candlesMap.get(marketId) ?? [];
      let filtered = all.filter((r) => {
        const t = r.openTime.getTime();
        return t >= from.getTime() && t < to.getTime();
      });
      if (cursorOpenTime) {
        filtered = filtered.filter((r) => r.openTime.getTime() > cursorOpenTime.getTime());
      }
      filtered.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
      return filtered.slice(0, take);
    },
  };

  const planeReport = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from: new Date(T0),
    to: new Date(T0 + 10 * H1),
    markets: [market1, market2],
    deps,
    isSmartMoneyRunner: false,
  });

  ok(planeReport.marketsCount === 2, "plane marketsCount 2");
  ok(planeReport.totalReturned === 20, `plane totalReturned 20 (got ${planeReport.totalReturned})`);
  ok(planeReport.overallCoverageRatio === 1, `plane coverage ratio 1 (got ${planeReport.overallCoverageRatio})`);
  ok(planeReport.readOnly === true && planeReport.noPnl === true, "plane readOnly/noPnl");
  ok(planeReport.commonTimestamps.length === 10, `common timestamps 10 (got ${planeReport.commonTimestamps.length})`);

  // With Smart Money, BINGX should be ineligible for 1d but eligible for 1h
  const planeSmart1h = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1h",
    from: new Date(T0),
    to: new Date(T0 + 10 * H1),
    markets: [market1, market2],
    deps,
    isSmartMoneyRunner: true,
  });
  ok(planeSmart1h.eligibleMarketsCount === 2, "smartMoney 1h both eligible");

  const deps1d: BacktestDataDepsV2 = {
    findCandlesPage: async ({ marketId, from, to, cursorOpenTime, take }) => {
      const all = candlesMap1d.get(marketId) ?? [];
      let filtered = all.filter((r) => {
        const t = r.openTime.getTime();
        return t >= from.getTime() && t < to.getTime();
      });
      if (cursorOpenTime) {
        filtered = filtered.filter((r) => r.openTime.getTime() > cursorOpenTime.getTime());
      }
      filtered.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
      return filtered.slice(0, take);
    },
  };

  const planeSmart1d = await fetchHistoricalDataPlane({
    assetSymbol: "BTC",
    timeframe: "1d",
    from: new Date(T0),
    to: new Date(T0 + 10 * 24 * H1),
    markets: [market1, market2],
    deps: deps1d,
    isSmartMoneyRunner: true,
  });
  ok(planeSmart1d.eligibleMarketsCount === 1, `smartMoney 1d BINGX excluded, eligible 1 (got ${planeSmart1d.eligibleMarketsCount})`);
  ok(planeSmart1d.ineligibleMarkets.length === 1 && planeSmart1d.ineligibleMarkets[0].exchange === "BINGX", "ineligible is BINGX");

  console.log(`\nPassed ${passed}/${total}`);
  if (passed !== total) {
    console.error(`FAIL: ${total - passed} failed`);
    process.exit(1);
  }
  console.log("All data plane tests passed");
})();
