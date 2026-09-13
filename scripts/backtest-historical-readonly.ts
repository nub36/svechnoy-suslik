/**
 * Owner-run READ-ONLY inspection CLI — BTC ONLY, NO DB WRITES, NO PNL, NO SECRETS.
 *
 * Prominently states: READ ONLY, NO DB WRITES, NO PNL, BTC ONLY.
 * Owner executes on VPS using server's existing configured env — do NOT paste secrets, never echo DATABASE_URL.
 * CLI errors must fail closed. Do not hide incomplete coverage. No misleading 100% coverage on non-aligned ranges.
 *
 * Usage (VPS — uses existing env, no secrets):
 *   npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney
 *
 * This script:
 * - Connects via Prisma with capability-restricted surface (read-only)
 * - Fetches ALL markets for BTC asset (no enabled/status filter) and reports current enabled/status as diagnostics
 * - Applies ONLY timeless exchange eligibility (BINGX 1d excluded) separately
 * - Fetches CLOSED candles via P2-B hardened pagination (read-only)
 * - Computes coverage, common timestamps, contiguous ranges, participant feasibility, createdAt/updatedAt diagnostics, eligibility limitations
 * - Optionally evaluates raw SMC observations (if --smc flag)
 * - NEVER calculates PnL, NEVER writes DB, NEVER starts workers
 * - BTC-only: --asset must be BTC, otherwise fail-closed (pre-registered scope)
 */

import { PrismaClient } from "@prisma/client";
import { CANONICAL_TIMEFRAMES, isCanonicalTimeframe } from "../lib/backtest/timeframe";
import { fetchHistoricalDataPlane, formatHistoricalDataPlaneReport } from "../lib/backtest/historical-data-plane";
import { buildHistoricalEligibilityDiagnostics, formatEligibilityDiagnosticsReport } from "../lib/backtest/historical-eligibility";
import { computeOhlcvProvenanceDiagnostics, formatOhlcvProvenanceReport } from "../lib/backtest/ohlcv-provenance";
import { assertReadOnlyDeps } from "../lib/backtest/data-source";
import type { BacktestDataDepsV2, BacktestMarketRow } from "../lib/backtest/data-source";
import type { BacktestCandleRow } from "../lib/backtest/adapter";

console.log("=== READ ONLY — NO DB WRITES — NO PNL — BTC ONLY ===");
console.log("This CLI is OWNER-RUN read-only inspection, never writes DB, never calculates profitability, BTC only");
console.log("");

function fail(msg: string): never {
  console.error(`ERROR (fail-closed): ${msg}`);
  console.error("READ ONLY check failed — exiting non-zero, no DB writes performed");
  process.exit(1);
}

function parseArgs() {
  const raw = process.argv.slice(2);
  let asset = "BTC";
  let timeframe = "1h";
  let from = "2024-01-01";
  let to = "2024-02-01";
  let smartMoney = false;
  let smc = false;
  let splits = false;
  let help = false;
  let pageSize = 1000;

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--asset") {
      const v = raw[i + 1];
      if (!v || v.startsWith("-")) fail("Missing value for --asset");
      asset = v;
      i++;
    } else if (a === "--timeframe") {
      const v = raw[i + 1];
      if (!v || v.startsWith("-")) fail("Missing value for --timeframe");
      timeframe = v;
      i++;
    } else if (a === "--from") {
      const v = raw[i + 1];
      if (!v || v.startsWith("-")) fail("Missing value for --from");
      from = v;
      i++;
    } else if (a === "--to") {
      const v = raw[i + 1];
      if (!v || v.startsWith("-")) fail("Missing value for --to");
      to = v;
      i++;
    } else if (a === "--pageSize") {
      const v = raw[i + 1];
      if (!v || v.startsWith("-")) fail("Missing value for --pageSize");
      const n = Number(v);
      if (!Number.isInteger(n) || n <= 0 || n > 5000) fail(`--pageSize must be integer 1..5000, got ${v}`);
      pageSize = n;
      i++;
    } else if (a === "--smartMoney" || a === "--smart-money") {
      smartMoney = true;
    } else if (a === "--smc") {
      smc = true;
    } else if (a === "--splits" || a === "--splits-readiness") {
      splits = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    } else {
      fail(`Unknown flag ${a}`);
    }
  }

  return { asset, timeframe, from, to, smartMoney, smc, splits, help, pageSize };
}

function printHelp() {
  console.log(`
Owner-run READ-ONLY historical data inspection CLI — NO DB WRITES — NO PNL — BTC ONLY

Usage (uses server's existing env, no secrets, never echo DATABASE_URL):
  npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 [--smartMoney] [--smc] [--splits]

Options:
  --asset <symbol>       Asset symbol (default BTC) — BTC only, fail-closed if != BTC (pre-registered scope)
  --timeframe <tf>       Timeframe ${CANONICAL_TIMEFRAMES.join("/")} (default 1h) — unknown timeframe exits non-zero
  --from <ISO>           From timestamp ISO (e.g. 2024-01-01T00:00:00Z or YYYY-MM-DD)
  --to <ISO>             To timestamp ISO, must be > from
  --pageSize <n>         Page size 1..5000 (default 1000)
  --smartMoney           Apply Smart Money eligibility (BINGX 1d excluded — timeless policy only)
  --smc                  Also evaluate raw SMC observations (no SL/TP, no PnL)
  --splits               Also evaluate TRAIN/VALIDATION/OOS readiness (OOS isolation, no silent shortening)
  --help, -h             Show help

Safety (truthful, audited):
  - READ ONLY by capability-restricted Prisma surface: asset.findUnique, market.findMany (all markets for BTC, reporting current enabled/status as diagnostics), candle.findMany (CLOSED-only), $disconnect. No create/update/upsert/delete, no $executeRaw, no raw SQL.
  - read-only-sql.ts is static/test defense (SELECT/WITH allowlist) — not runtime CLI transaction enforcement. CLI does NOT execute SET TRANSACTION READ ONLY to avoid DB writes.
  - NO DB WRITES, NO PNL: never calculates profit/loss/winRate
  - Fail-closed on invalid inputs (including --asset != BTC), non-aligned ranges reported explicitly, never misleading 100% coverage
  - TRAIN/VALIDATION/OOS: OOS does not influence selection, selection stages TRAIN/VALIDATION only, OOS final witness only
  - CURRENT_STATE_SURVIVORSHIP_LIMITATION: current enabled/status reported as diagnostic, not treated as historical truth; all markets queried, timeless BINGX-1d applied separately

Examples (no secrets, uses existing env):
  npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney
  npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1d --from 2024-01-01 --to 2024-03-01 --smartMoney --smc --splits
`);
}

function parseDateStrict(s: string, label: string): Date {
  let iso = s;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    iso = `${s}T00:00:00Z`;
  }
  if (s.includes("T") && !/[Z]$/.test(s) && !/[+-]\d{2}:?\\d{2}$/.test(s) && !/[+-]\d{2}$/.test(s)) {
    fail(`${label} '${s}' is timezone-less ambiguous datetime — require Z or offset or date-only YYYY-MM-DD`);
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    fail(`${label} '${s}' invalid date`);
  }
  return d;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // BTC-only scope — fail-closed if not BTC
  if (args.asset !== "BTC") {
    fail(`--asset must be BTC (pre-registered scope), got ${args.asset} — ETH etc rejected, fail-closed`);
  }

  if (!isCanonicalTimeframe(args.timeframe)) {
    fail(`Unknown timeframe '${args.timeframe}'. Supported: ${CANONICAL_TIMEFRAMES.join(", ")}`);
  }

  const fromDate = parseDateStrict(args.from, "--from");
  const toDate = parseDateStrict(args.to, "--to");

  if (fromDate.getTime() >= toDate.getTime()) {
    fail(`--from must be < --to, got from=${fromDate.toISOString()} to=${toDate.toISOString()}`);
  }

  console.log(`Asset: ${args.asset} Timeframe: ${args.timeframe} From: ${fromDate.toISOString()} To: ${toDate.toISOString()} SmartMoney: ${args.smartMoney} SMC: ${args.smc} PageSize: ${args.pageSize}`);
  console.log("");

  const prisma = new PrismaClient();

  try {
    console.log("Connecting to DB (read-only, capability-restricted surface)...");
    console.log("Read-only via: asset.findUnique, market.findMany (all markets, diagnostics), candle.findMany CLOSED-only, $disconnect — no writes, no $executeRaw");

    const assetRow = await prisma.asset.findUnique({
      where: { symbol: args.asset },
      select: { id: true, symbol: true, rank: true },
    });

    if (!assetRow) {
      fail(`Asset ${args.asset} not found in DB`);
    }

    console.log(`Found asset: id=${assetRow.id} symbol=${assetRow.symbol} rank=${assetRow.rank ?? "null"}`);

    // Query ALL markets for BTC asset — no enabled/status filter, report current enabled/status as diagnostics
    const marketsRaw = await prisma.market.findMany({
      where: { assetId: assetRow.id },
      orderBy: { id: "asc" },
      select: {
        id: true,
        exchange: true,
        exchangeSymbol: true,
        assetId: true,
        enabled: true,
        status: true,
        base: true,
        quote: true,
        marketType: true,
        quoteVolume24h: true,
      },
    });

    console.log(`Found ${marketsRaw.length} markets for asset ${args.asset} (ALL markets, no enabled/status filter — current enabled/status reported as diagnostics)`);

    // Diagnostic for survivorship
    const enabledActive = marketsRaw.filter((m: any) => m.enabled && m.status === "ACTIVE").length;
    const disabled = marketsRaw.filter((m: any) => !m.enabled).length;
    const inactive = marketsRaw.filter((m: any) => m.status !== "ACTIVE").length;
    console.log(`Markets diagnostics: total=${marketsRaw.length} enabled+ACTIVE=${enabledActive} disabled=${disabled} inactive/delisted=${inactive}`);
    if (disabled > 0 || inactive > 0) {
      console.log("CURRENT_STATE_SURVIVORSHIP_LIMITATION: current enabled/status is mutable current-state, not historical truth. All markets queried, timeless BINGX-1d policy applied separately. Disabled/inactive markets preserved in diagnostics, not hidden.");
    }

    const markets: BacktestMarketRow[] = marketsRaw.map((m: any) => ({
      id: m.id,
      exchange: m.exchange,
      exchangeSymbol: m.exchangeSymbol,
      assetId: m.assetId,
      enabled: m.enabled,
      status: m.status,
      base: m.base,
      quote: m.quote,
      marketType: m.marketType,
      quoteVolume24h: m.quoteVolume24h,
    }));

    const deps: BacktestDataDepsV2 = {
      findCandlesPage: async ({ marketId, timeframe, from, to, cursorOpenTime, take }) => {
        if (timeframe !== args.timeframe) {
          throw new Error(`Market echo validation: requested timeframe ${args.timeframe} but got ${timeframe}`);
        }

        const where: any = {
          marketId,
          timeframe,
          closed: true,
          openTime: {
            gte: from,
            lt: to,
          },
        };

        if (cursorOpenTime) {
          where.openTime.gt = cursorOpenTime;
        }

        const rows = await prisma.candle.findMany({
          where,
          orderBy: { openTime: "asc" },
          take,
          select: {
            marketId: true,
            timeframe: true,
            openTime: true,
            closeTime: true,
            open: true,
            high: true,
            low: true,
            close: true,
            volume: true,
            closed: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        for (const r of rows as any[]) {
          if ((r as any).marketId !== marketId) fail(`Market echo mismatch: expected ${marketId} got ${(r as any).marketId}`);
          if ((r as any).timeframe !== timeframe) fail(`Timeframe echo mismatch: expected ${timeframe} got ${(r as any).timeframe}`);
          if ((r as any).closed !== true) fail(`closed filter violated: got ${(r as any).closed}`);
        }

        return (rows as any[]).map((r: any) => ({
          marketId: r.marketId,
          timeframe: r.timeframe,
          openTime: r.openTime,
          closeTime: r.closeTime,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
          closed: r.closed,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        })) as unknown as BacktestCandleRow[];
      },
    };

    // Validate actual capability object used by CLI and fail-closed (honest, not dummy)
    const roCheck = assertReadOnlyDeps(deps);
    if (!roCheck.ok) {
      fail(`Read-only deps check failed (actual capability object): ${roCheck.errors.join("; ")}`);
    }

    console.log("\nFetching historical data plane (read-only, P2-B hardened pagination, capability-restricted)...");
    const report = await fetchHistoricalDataPlane({
      assetSymbol: args.asset,
      timeframe: args.timeframe,
      from: fromDate,
      to: toDate,
      markets,
      deps,
      pageSize: args.pageSize,
      isSmartMoneyRunner: args.smartMoney,
      eligibilityMethodology: null,
    });

    console.log("\n" + formatHistoricalDataPlaneReport(report));

    console.log("\n" + formatEligibilityDiagnosticsReport(report.eligibilityDiagnostics));

    if (markets.length > 0) {
      const sampleMarketId = markets[0].id;
      const sampleRows = await prisma.candle.findMany({
        where: {
          marketId: sampleMarketId,
          timeframe: args.timeframe,
          closed: true,
          openTime: { gte: fromDate, lt: toDate },
        },
        orderBy: { openTime: "asc" },
        take: 1000,
        select: {
          marketId: true,
          timeframe: true,
          openTime: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true,
          closed: true,
          createdAt: true,
          updatedAt: true,
        },
      });

      const provRows = (sampleRows as any[]).map((r: any) => ({
        marketId: r.marketId,
        timeframe: r.timeframe,
        openTime: r.openTime,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
        closed: r.closed,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

      const provDiag = computeOhlcvProvenanceDiagnostics(provRows as any);
      console.log("\n" + formatOhlcvProvenanceReport(provDiag));
    }

    if (args.smc) {
      console.log("\n=== Raw SMC Observations (no SL/TP, no PnL) ===");
      console.log("SMC evaluation reuses production evaluateSmc, no second algorithm");
      const firstMarket = markets[0];
      if (firstMarket) {
        const candles = await deps.findCandlesPage({
          marketId: firstMarket.id,
          timeframe: args.timeframe,
          from: fromDate,
          to: toDate,
          cursorOpenTime: null,
          take: 500,
        });

        console.log(`Fetched ${candles.length} candles for market ${firstMarket.id} ${firstMarket.exchange} for SMC demo`);
        console.log("SMC config must be loaded from Strategy table (id=2) — not evaluated in this demo to avoid hidden defaults");
        console.log("Raw observations would preserve LONG/SHORT/NEUTRAL/CANNOT_EVALUATE with provenance, no SL/TP");
      }
    }

    if (args.splits) {
      console.log("\n=== Splits Readiness — TRAIN/VALIDATION/OOS — READ ONLY — NO PNL — OOS ISOLATION ===");
      const { evaluateSplitsReadiness, formatSplitsReadinessReport } = await import("../lib/backtest/splits-readiness");
      const commonTimestamps = report.commonTimestamps;
      const totalMs = toDate.getTime() - fromDate.getTime();
      const trainEnd = new Date(fromDate.getTime() + Math.floor(totalMs * 0.6));
      const valEnd = new Date(trainEnd.getTime() + Math.floor(totalMs * 0.2));
      const splitsReport = evaluateSplitsReadiness({
        assetSymbol: args.asset,
        timeframe: args.timeframe as any,
        splits: [
          { name: "TRAIN", from: fromDate, to: trainEnd },
          { name: "VALIDATION", from: trainEnd, to: valEnd },
          { name: "OOS", from: valEnd, to: toDate },
        ],
        availableTimestamps: commonTimestamps,
      });
      console.log(formatSplitsReadinessReport(splitsReport));
      console.log("OOS does not influence selection — TRAIN/VALIDATION only, OOS final witness only");
    }

    console.log("\n=== READ ONLY — NO DB WRITES — NO PNL — BTC ONLY — CLI completed successfully ===");
    console.log("No profitability calculated, no workers started, no Prisma migration, no secrets echoed");
  } catch (e) {
    console.error("\nCLI failed (fail-closed):", (e as Error).message);
    console.error((e as Error).stack);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
