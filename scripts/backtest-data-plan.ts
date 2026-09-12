/**
 * P2-B — read-only planning CLI.
 *
 * Запуск:
 *   npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --pageSize 500
 *   npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1d --from 2024-01-01 --to 2024-02-01 --smartMoney
 *
 * Только SELECT, никаких writes, никаких workers.
 * Если DATABASE_URL не задан или --dry без БД, выводит план без coverage.
 * Если БД доступна, делает только read-only подсчёты через deps.
 *
 * Совместимо с существующей архитектурой --plan для OHLCV worker.
 */

import { planBacktestRun, formatDataPlanReport } from "../lib/backtest/data-plan";
import { getTimeframeMs } from "../lib/backtest/timeframe";
import type { BacktestMarketRow, BacktestAssetRow } from "../lib/backtest/data-source";

function parseArgs(): {
  asset: string;
  timeframe: string;
  from: string;
  to: string;
  pageSize: number;
  smartMoney: boolean;
  help: boolean;
} {
  const args = process.argv.slice(2);
  let asset = "BTC";
  let timeframe = "1h";
  let from = "2024-01-01";
  let to = "2024-02-01";
  let pageSize = 500;
  let smartMoney = false;
  let help = false;

  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === "--asset" && args[i + 1]) asset = args[++i];
    else if (a === "--timeframe" && args[i + 1]) timeframe = args[++i];
    else if (a === "--from" && args[i + 1]) from = args[++i];
    else if (a === "--to" && args[i + 1]) to = args[++i];
    else if (a === "--pageSize" && args[i + 1]) pageSize = Number(args[++i]);
    else if (a === "--smartMoney" || a === "--smart-money") smartMoney = true;
    else if (a === "--help" || a === "-h") help = true;
  }

  return { asset, timeframe, from, to, pageSize, smartMoney, help };
}

function printHelp(): void {
  console.log(`
P2-B Backtest Data Plan CLI — read-only

Usage:
  npx tsx scripts/backtest-data-plan.ts [options]

Options:
  --asset <symbol>       Asset symbol (default BTC)
  --timeframe <tf>       Timeframe 5m/15m/1h/4h/1d (default 1h)
  --from <date>          From date ISO (default 2024-01-01)
  --to <date>            To date ISO (default 2024-02-01)
  --pageSize <n>         Page size for chunked reads (default 500)
  --smartMoney           Apply Smart Money eligibility (BINGX 1d excluded)
  --help, -h             Show help

Examples:
  npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01
  npx tsx scripts/backtest-data-plan.ts --asset BTC --timeframe 1d --smartMoney

Notes:
  - No DB writes, no workers, no exchange API
  - Market.id is identity, never exchangeSymbol
  - Timeframe duration from SMCTIMEFRAME_MS (single source)
  - For full coverage report, set DATABASE_URL and run with real deps (read-only SELECT)
`);
}

async function main(): Promise<void> {
  const { asset, timeframe, from, to, pageSize, smartMoney, help } = parseArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  const fromDate = new Date(from);
  const toDate = new Date(to);

  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    console.error("Invalid from/to date");
    process.exit(1);
  }

  if (fromDate.getTime() >= toDate.getTime()) {
    console.error("from must be < to");
    process.exit(1);
  }

  const timeframeMs = getTimeframeMs(timeframe);

  if (timeframeMs === null) {
    console.warn(`Warning: unknown timeframe ${timeframe}, timeframeMs null — expected count will be n/a`);
  }

  // Mock markets for dry-run (no DB)
  const mockMarkets: BacktestMarketRow[] = [
    { id: 1, exchange: "BINANCE", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 2, exchange: "BYBIT", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 3, exchange: "GATE", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 4, exchange: "KUCOIN", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
    { id: 5, exchange: "BINGX", exchangeSymbol: `${asset}USDT`, assetId: 1, enabled: true, status: "ACTIVE" },
  ];

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
  console.log("\n--dry-run (no DB) completed, read-only, no writes");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
