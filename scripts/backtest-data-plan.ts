/**
 * P2-B — read-only planning CLI — HARDENED.
 *
 * Запуск:
 *   npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --pageSize 500
 *   npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1d --from 2024-01-01 --to 2024-02-01 --smartMoney
 *
 * Только SIMULATED / NO DB, никаких writes, никаких workers, никакого
 * DB connection, никакого env DB.
 *
 * Fail-closed parser:
 * - missing value, unknown flag, duplicate flag → exit non-zero
 * - invalid timeframe → exit non-zero (unknown explicit invalid, never healthy)
 * - invalid date, timezone-less ambiguous datetime → exit non-zero
 * - from>=to → exit non-zero
 * - pageSize <=0 / fractional / excessive → exit non-zero
 *
 * Timestamp semantics:
 * - Require ISO 8601 with explicit Z or offset (e.g. 2024-01-01T00:00:00Z or 2024-01-01T00:00:00+00:00)
 *   OR date-only UTC YYYY-MM-DD which is interpreted as 00:00:00Z UTC (documented).
 * - Timezone-less datetime like 2024-01-01T00:00:00 is REJECTED as ambiguous.
 *
 * No mock counts as PostgreSQL discovery — output labeled SIMULATED / NO DB.
 */

import { planBacktestRun, formatDataPlanReport } from "../lib/backtest/data-plan";
import { getTimeframeMs, CANONICAL_TIMEFRAMES, isCanonicalTimeframe } from "../lib/backtest/timeframe";
import type { BacktestMarketRow } from "../lib/backtest/data-source";
import { MAX_PAGE_SIZE } from "../lib/backtest/data-source";

interface ParsedArgs {
  asset: string;
  timeframe: string;
  from: string;
  to: string;
  pageSize: number;
  smartMoney: boolean;
  help: boolean;
}

function fail(msg: string): never {
  console.error(`ERROR: ${msg}`);
  console.error(`Use --help for usage. Fail-closed.`);
  process.exit(1);
}

function isDateOnlyUTC(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function hasExplicitTimezone(s: string): boolean {
  // Has Z or offset +HH:MM / -HH:MM / +HHMM / +HH at end
  return /Z$/i.test(s) || /[+-]\d{2}:?\d{2}$/.test(s) || /[+-]\d{2}$/.test(s);
}

function isAmbiguousDateTime(s: string): boolean {
  // Contains T but no timezone
  return s.includes("T") && !hasExplicitTimezone(s);
}

function parseISODateStrict(input: string, label: string): Date {
  if (isAmbiguousDateTime(input)) {
    fail(
      `${label} '${input}' is timezone-less ambiguous datetime. Require ISO with Z/offset (e.g. 2024-01-01T00:00:00Z) or date-only UTC YYYY-MM-DD`
    );
  }

  let isoString: string;

  if (isDateOnlyUTC(input)) {
    // date-only UTC documented as 00:00:00Z
    isoString = `${input}T00:00:00Z`;
  } else {
    isoString = input;
    if (!hasExplicitTimezone(isoString)) {
      // If no explicit timezone and not date-only, reject unless it's already Z?
      // We already rejected T without timezone, but allow e.g. 2024-01-01 (handled) or full ISO with Z/offset
      // For safety, require explicit timezone for any datetime
      fail(
        `${label} '${input}' must have explicit timezone Z or offset, or be date-only YYYY-MM-DD UTC. Got '${input}'`
      );
    }
  }

  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) {
    fail(`${label} '${input}' invalid date (parsed as NaN)`);
  }

  return d;
}

function parseArgs(): ParsedArgs {
  const raw = process.argv.slice(2);
  const seen = new Map<string, number>();

  let asset = "BTC";
  let timeframe = "1h";
  let from = "2024-01-01";
  let to = "2024-02-01";
  let pageSize = 500;
  let smartMoney = false;
  let help = false;

  const knownFlags = new Set([
    "--asset",
    "--timeframe",
    "--from",
    "--to",
    "--pageSize",
    "--smartMoney",
    "--smart-money",
    "--help",
    "-h",
  ]);

  for (let i = 0; i < raw.length; i += 1) {
    const a = raw[i];

    if (!a.startsWith("-")) {
      fail(`Unexpected positional argument '${a}' — unknown flag`);
    }

    if (!knownFlags.has(a)) {
      fail(`Unknown flag '${a}'. Supported: --asset --timeframe --from --to --pageSize --smartMoney --help`);
    }

    // duplicate flag detection
    const canonical = a === "--smart-money" ? "--smartMoney" : a;
    if (canonical !== "--help" && canonical !== "-h") {
      const count = seen.get(canonical) ?? 0;
      if (count >= 1) {
        fail(`Duplicate flag '${a}'`);
      }
      seen.set(canonical, count + 1);
    }

    if (a === "--asset") {
      const v = raw[i + 1];
      if (v === undefined || v.startsWith("-")) fail(`Missing value for --asset`);
      asset = v;
      i += 1;
    } else if (a === "--timeframe") {
      const v = raw[i + 1];
      if (v === undefined || v.startsWith("-")) fail(`Missing value for --timeframe`);
      timeframe = v;
      i += 1;
    } else if (a === "--from") {
      const v = raw[i + 1];
      if (v === undefined || v.startsWith("-")) fail(`Missing value for --from`);
      from = v;
      i += 1;
    } else if (a === "--to") {
      const v = raw[i + 1];
      if (v === undefined || v.startsWith("-")) fail(`Missing value for --to`);
      to = v;
      i += 1;
    } else if (a === "--pageSize") {
      const v = raw[i + 1];
      if (v === undefined || v.startsWith("-")) fail(`Missing value for --pageSize`);
      // check fractional / excessive / <=0
      const num = Number(v);
      if (!Number.isFinite(num)) fail(`--pageSize must be finite number, got '${v}'`);
      if (!Number.isInteger(num)) fail(`--pageSize must be integer, got '${v}' (fractional not allowed)`);
      if (num <= 0) fail(`--pageSize must be >0, got ${num}`);
      if (num > MAX_PAGE_SIZE) fail(`--pageSize ${num} exceeds upper bound ${MAX_PAGE_SIZE}`);
      pageSize = num;
      i += 1;
    } else if (a === "--smartMoney" || a === "--smart-money") {
      smartMoney = true;
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }

  return { asset, timeframe, from, to, pageSize, smartMoney, help };
}

function printHelp(): void {
  console.log(`
P2-B Backtest Data Plan CLI — SIMULATED / NO DB — read-only — HARDENED

Usage:
  npx tsx scripts/backtest-data-plan.ts [options]

Options:
  --asset <symbol>       Asset symbol (default BTC)
  --timeframe <tf>       Timeframe ${CANONICAL_TIMEFRAMES.join("/")} (default 1h) — unknown timeframe exits non-zero
  --from <ISO>           From timestamp: ISO with Z/offset (e.g. 2024-01-01T00:00:00Z) OR date-only YYYY-MM-DD UTC (documented as 00:00:00Z)
  --to <ISO>             To timestamp: same format as --from, must be > from
  --pageSize <n>         Page size integer >0 <=${MAX_PAGE_SIZE}, no fractional (default 500)
  --smartMoney           Apply upstream Smart Money eligibility (BINGX 1d excluded, fail-closed unknown)
  --help, -h             Show help

Timestamp rules (fail-closed):
  - Require explicit timezone: Z or +/-HH:MM
  - OR date-only YYYY-MM-DD interpreted as UTC midnight (documented)
  - Timezone-less datetime like 2024-01-01T00:00:00 REJECTED as ambiguous

Safety:
  - SIMULATED / NO DB — this CLI never connects to PostgreSQL, never uses live DB
  - Mock markets are SIMULATED, not discovered from live DB
  - No DB writes, no workers, no exchange API
  - Unknown timeframe → explicit invalid, never healthy, exit non-zero
  - Duplicate/unknown flag, missing value, from>=to, pageSize invalid → exit non-zero

Examples:
  npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01
  npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1d --from 2024-01-01T00:00:00Z --to 2024-02-01T00:00:00Z --smartMoney
`);
}

async function main(): Promise<void> {
  const { asset, timeframe, from, to, pageSize, smartMoney, help } = parseArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  // timeframe validation fail-closed
  if (!isCanonicalTimeframe(timeframe)) {
    fail(`Unknown timeframe '${timeframe}'. Supported: ${CANONICAL_TIMEFRAMES.join(", ")} — explicit invalid, never healthy`);
  }

  const fromDate = parseISODateStrict(from, "--from");
  const toDate = parseISODateStrict(to, "--to");

  if (fromDate.getTime() >= toDate.getTime()) {
    fail(`--from must be < --to, got from=${fromDate.toISOString()} to=${toDate.toISOString()}`);
  }

  const timeframeMs = getTimeframeMs(timeframe);
  // Should not be null because we validated canonical, but keep for safety
  if (timeframeMs === null) {
    fail(`Internal error: timeframeMs null after canonical check for ${timeframe}`);
  }

  // Mock markets for dry-run (SIMULATED / NO DB) — clearly labeled
  const mockMarkets: BacktestMarketRow[] = [
    { id: 1, exchange: "BINANCE", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 2, exchange: "BYBIT", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 3, exchange: "GATE", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 4, exchange: "KUCOIN", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 5, exchange: "BINGX", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
  ];

  console.log(`=== SIMULATED / NO DB — P2-B Backtest Data Plan ===`);
  console.log(`NOTE: Mock markets below are SIMULATED, NOT discovered from live DB. No DB connection, no env DB.`);

  const plan = planBacktestRun({
    assetSymbol: asset,
    timeframe,
    timeframeMs,
    from: fromDate,
    to: toDate,
    markets: mockMarkets,
    pageSize,
    isSmartMoneyRunner: smartMoney,
    minBarsPerSegment: 10,
  });

  console.log(formatDataPlanReport(plan));
  console.log(`\n-- SIMULATED / NO DB dry-run completed, read-only, no writes, no DB connection`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
