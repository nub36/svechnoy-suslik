/**
 * Smart Money — DIAGNOSTIC ONLY read-only verification (Phase 3E).
 *
 * EXPLICIT separate script — canonical engineering config, read-only,
 * never mutates Strategy, never writes Signal, never runs workers.
 *
 * Purpose: allow
 *   BTC 5m / 15m / 4h / 1d  read-only runtime verification
 * before enabling those TF, even though Strategy.timeframes=["1h"].
 *
 * Safety:
 * - loud DIAGNOSTIC ONLY banner
 * - uses defaultSmcScoringConfig(timeframe) exclusively (canonical 72/20 etc.)
 * - Strategy SMC params are IGNORED; only filters/minExchanges from Strategy are
 *   optionally reused if semantically safe and clearly logged (otherwise DEFAULT)
 * - PostgreSQL CLOSED candles only (DESC take 500 → reverse ASC)
 * - does NOT check Strategy.timeframes — bypasses Phase 3C staged reject
 * - alignment guard before aggregation: BINGX 1d at UTC 16 vs others UTC 00 => REFUSE
 *
 * BINGX 1d audit (see lib/exchanges/bingx.ts):
 * - endpoint: https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=BTC-USDT&interval=1d&limit=...
 * - interval mapping: "1d" -> "1d" (bingxInterval), duration 86400000ms
 * - adapter passes raw exchange openTime unchanged: Number(row[0]) as openTime, closeTime=openTime+duration-1, closed=closeTime<now
 * - other adapters (binance, bybit D, gate 1d, kucoin 1day) also pass raw openTime unchanged but their exchanges define 1d at UTC 00
 * - BingX 1d is defined at UTC+8 midnight => UTC 16 previous day, hence misaligned. Adapter correctly reflects exchange's definition; we do NOT resample/rewriting here.
 * - other TF (5m/15m/1h/4h) are UTC-grid aligned for all 5 exchanges (verified VPS badStep 0)
 *
 * Report after VPS: 5m/15m/4h can safely be unlocked (all 5 exchanges canonical-aligned, badStep 0, badClosedCloseTime 0, 299-306 CLOSED each). 1d requires normalization: either exclude BINGX from 1d universe or normalize BINGX daily to UTC 00 (needs proven project rule, not fabricated OHLC). Until then 1d multi-exchange aggregation must be REFUSED.
 *
 * Usage:
 *   npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 5m
 *   npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 15m
 *   npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 4h
 *   npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 1d   (shows per-exchange, but aggregation REFUSED)
 *   npx tsx scripts/smart-money-diagnostic.ts --market-id 123 --timeframe 1h
 *   npx tsx scripts/smart-money-diagnostic.ts --self-test
 */

import { isSmcTimeframe, type SmcTimeframe } from "../lib/smc/types";
import { defaultSmcScoringConfig, type SmcScoringConfig } from "../lib/smc/config";
import {
  SMART_MONEY_SLUG,
  validateSmartMoneyRuntime,
  evaluateSmartMoneyWithCandles,
  loadSmartMoneyCandles,
  DEFAULT_SMART_MONEY_FILTERS,
  type SmartMoneyFilters,
} from "../lib/strategies/smart-money";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { checkCandleAlignment, canAggregateSafely } from "../lib/strategies/alignment";
import { fileURLToPath } from "node:url";
import { parseSmartMoneyArgs, validateCliArgs } from "./smart-money-cli-args";

function printHelp(): void {
  console.log(`
Smart Money — DIAGNOSTIC ONLY (Phase 3E) — canonical config, read-only

Usage:
  npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 5m
  npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 15m
  npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 4h
  npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 1d
  npx tsx scripts/smart-money-diagnostic.ts --market-id 123 --timeframe 1h
  npx tsx scripts/smart-money-diagnostic.ts --self-test
  npx tsx scripts/smart-money-diagnostic.ts --help

This script is DIAGNOSTIC ONLY:
- loud banner, canonical SMC config (72/20 etc.), Strategy SMC params IGNORED
- bypasses Strategy.timeframes check (allows 5m/15m/4h/1d even when Strategy=["1h"])
- filters/minExchanges: uses Strategy DB values if semantically safe, otherwise DEFAULT — clearly logged
- CLOSED candles only (500 DESC → reverse ASC)
- alignment guard before aggregation: 1d BINGX UTC16 vs others UTC00 => REFUSE multi-exchange aggregate
- never writes Strategy, never writes Signal, never runs workers

For normal production behavior (still rejects TF not in Strategy), use:
  npx tsx scripts/smart-money-readonly.ts --symbol BTC --timeframe 1h
  npx tsx scripts/smart-money-readonly.ts --symbol BTC --timeframe 15m --diagnostic-canonical-config  (also diagnostic)
`);
}

async function runSelfTest(): Promise<number> {
  console.log("Smart Money Diagnostic — self-test (pure, no DB) — alignment + canonical");
  let passed = 0;
  let total = 0;
  function ok(c: boolean, l: string) {
    total++;
    if (c) {
      passed++;
      console.log(`  ✓ ${l}`);
    } else console.error(`  ✗ FAIL: ${l}`);
  }

  // Test alignment helper: 1d BINGX 16 UTC vs others 00 UTC => misaligned
  {
    const mkRes = (ex: string, hourUTC: number) => ({
      status: "evaluated" as const,
      exchange: ex,
      market: "BTCUSDT",
      marketId: 1,
      candleTime: new Date(Date.UTC(2026, 0, 10, hourUTC, 0, 0)),
      price: 100,
      longScore: 80,
      shortScore: 10,
      direction: "LONG" as const,
      reasons: [],
      warnings: [],
    });
    const resultsMisaligned = [
      mkRes("BINANCE", 0),
      mkRes("BYBIT", 0),
      mkRes("GATE", 0),
      mkRes("KUCOIN", 0),
      mkRes("BINGX", 16),
    ];
    const check = checkCandleAlignment(resultsMisaligned as any, "1d");
    ok(!check.aligned, "1d BINGX 16 vs others 00 => misaligned");
    ok(check.misaligned.length === 1 && check.misaligned[0].exchange === "BINGX", "1d misaligned is BINGX only");
    ok(!!check.reason?.includes("BINGX") && !!check.reason?.includes("16"), "1d reason mentions BINGX 16");
    ok(!canAggregateSafely(check), "1d cannot aggregate safely when misaligned");
  }

  // 5m/15m/1h/4h all UTC 00 aligned => aligned
  {
    const mkRes = (ex: string, ms: number) => ({
      status: "evaluated" as const,
      exchange: ex,
      market: "BTCUSDT",
      marketId: 1,
      candleTime: new Date(ms),
      price: 100,
      longScore: 80,
      shortScore: 10,
      direction: "LONG" as const,
      reasons: [],
      warnings: [],
    });
    const hourAligned = Date.UTC(2026, 0, 10, 12, 0, 0); // 12:00 UTC = aligned for 1h, 4h, etc.
    const resultsAligned = [
      mkRes("BINANCE", hourAligned),
      mkRes("BYBIT", hourAligned),
      mkRes("GATE", hourAligned),
      mkRes("KUCOIN", hourAligned),
      mkRes("BINGX", hourAligned),
    ];
    for (const tf of ["5m", "15m", "1h", "4h"] as SmcTimeframe[]) {
      const c = checkCandleAlignment(resultsAligned as any, tf);
      ok(c.aligned, `${tf} all UTC top => aligned`);
      ok(canAggregateSafely(c), `${tf} can aggregate when aligned`);
    }
  }

  // Only CLOSED, deterministic etc. already covered by existing self-test in readonly; here just alignment

  console.log(`\nDiagnostic self-test: ${passed}/${total}`);
  return passed === total ? 0 : 1;
}

let db: unknown | null = null;
async function getDb(): Promise<unknown> {
  if (!db) {
    const mod = await import("@prisma/client");
    db = new (mod as unknown as { PrismaClient: new () => unknown }).PrismaClient();
  }
  return db!;
}
async function closeDb(): Promise<void> {
  const d = db as unknown as { $disconnect?: () => Promise<void> } | null;
  if (d && typeof d.$disconnect === "function") await d.$disconnect();
  db = null;
}

async function runSymbolDiagnostic(symbol: string, timeframe: SmcTimeframe): Promise<number> {
  const prisma = (await getDb()) as any;

  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  DIAGNOSTIC ONLY — CANONICAL CONFIG — READ-ONLY            ║
║  Strategy SMC params IGNORED, canonical 72/20 etc.        ║
║  CLOSED candles only, no Signal writes, no workers        ║
╚══════════════════════════════════════════════════════════════╝
`);

  const asset = await prisma.asset.findFirst({ where: { symbol: symbol.toUpperCase() } });
  if (!asset) {
    console.error(`Asset ${symbol} не найден`);
    return 1;
  }
  console.log(`\nАктив: ${asset.symbol} (rank ${asset.rank ?? "—"}, id ${asset.id})`);
  console.log(`Таймфрейм: ${timeframe} — DIAGNOSTIC canonical config`);

  // Load Strategy for filters/minExchanges documentation, but use canonical SMC config
  let smcConfig: SmcScoringConfig = defaultSmcScoringConfig(timeframe);
  let filters: SmartMoneyFilters = DEFAULT_SMART_MONEY_FILTERS;
  let minExchanges = 2;
  let strategyVersion = 1;
  try {
    const strat = await prisma.strategy.findFirst({
      where: { slug: SMART_MONEY_SLUG },
      orderBy: { version: "desc" as never },
    });
    if (strat) {
      const rt = validateSmartMoneyRuntime({
        config: strat.config,
        timeframes: strat.timeframes,
        minExchanges: strat.minExchanges,
      });
      if (rt.ok) {
        filters = rt.filters;
        minExchanges = rt.minExchanges;
        strategyVersion = strat.version;
        console.log(
          `DIAGNOSTIC: Стратегия ${strat.slug} v${strat.version} найдена — Strategy SMC params IGNORED, canonical for ${timeframe} (minimumScore=${smcConfig.minimumScore}).`,
        );
        console.log(
          `DIAGNOSTIC filters/minExchanges: using Strategy DB values (minExchanges=${minExchanges}, filters=${JSON.stringify(filters)}) — явно логируется`,
        );
      } else {
        console.log(
          `DIAGNOSTIC: Стратегия ${SMART_MONEY_SLUG} в БД невалидна (${rt.errors.join("; ")}) — using canonical + DEFAULT filters/minExchanges (2)`,
        );
      }
    } else {
      console.log(
        `DIAGNOSTIC: Стратегия ${SMART_MONEY_SLUG} не найдена — canonical defaultSmcScoringConfig(${timeframe}) + DEFAULT filters`,
      );
    }
  } catch (e) {
    console.warn(`DIAGNOSTIC: Ошибка загрузки Strategy: ${String(e)} — using canonical + DEFAULT`);
  }

  console.log(`DIAGNOSTIC ONLY: no Strategy mutation, no Signal writes, CLOSED only`);
  console.log(`Фильтры (DIAGNOSTIC): top500Only=${filters.top500Only}, minimumQuoteVolume24h=${filters.minimumQuoteVolume24h}`);
  console.log(`Свечи: последние 500 CLOSED (DESC take 500 → reverse)`);

  const markets = await prisma.market.findMany({
    where: { assetId: asset.id, enabled: true, status: "ACTIVE", marketType: "SPOT", quote: "USDT" },
    orderBy: { exchange: "asc" },
  });
  if (markets.length === 0) {
    console.error(`Нет активных SPOT USDT рынков для ${asset.symbol}`);
    return 1;
  }
  console.log(`Рынков к проверке: ${markets.length}`);

  const results: import("../lib/strategies/runtime").MarketStrategyResult[] = [];

  for (const m of markets) {
    const meta = {
      exchange: m.exchange as string,
      market: m.exchangeSymbol as string,
      marketId: m.id as number,
      timeframe,
      assetRank: asset.rank as number | null,
      quoteVolume24h: m.quoteVolume24h as number | null,
    };
    const candles = await loadSmartMoneyCandles(prisma, m.id, timeframe);
    const result = evaluateSmartMoneyWithCandles(meta, candles, smcConfig, filters);
    results.push(result);

    console.log(`\n— ${m.exchange} ${m.exchangeSymbol} (id ${m.id}) —`);
    console.log(`  candles: ${candles.length} CLOSED (ASC после fetch)`);
    if (candles.length > 0) {
      console.log(`  last candle: ${candles[candles.length - 1].openTime.toISOString()} close=${candles[candles.length - 1].close}`);
      let asc = true;
      for (let i = 1; i < candles.length; i++) {
        if (candles[i].openTime.getTime() <= candles[i - 1].openTime.getTime()) asc = false;
      }
      console.log(`  ASC check: ${asc ? "OK" : "FAIL"}`);
      // Also log alignment per market
      const { isCanonicalAligned } = await import("../lib/strategies/alignment");
      const al = isCanonicalAligned(candles[candles.length - 1].openTime, timeframe);
      console.log(`  alignment: ${al ? "ALIGNED" : "MISALIGNED"} (openTime % timeframeMs ${al ? "==0" : "!=0"} UTC ${candles[candles.length - 1].openTime.getUTCHours()}:00)`);
    }
    if (result.status === "evaluated") {
      console.log(`  evaluable: true`);
      console.log(`  longScore: ${result.longScore} shortScore: ${result.shortScore} direction: ${result.direction}`);
      console.log(`  reasons (${result.reasons.length}):`);
      for (const r of result.reasons) {
        const mark = r.long ? "LONG" : r.short ? "SHORT" : "—";
        console.log(`    [${mark.padEnd(5)} w=${String(r.weight).padStart(2)}] ${r.label} ${r.value ?? ""}`);
      }
    } else {
      console.log(`  evaluable: false`);
      console.log(`  status: ${result.status} reason: ${result.reason}`);
    }
  }

  // Alignment guard before aggregation
  const alignment = checkCandleAlignment(results, timeframe);
  console.log(`\n=== Выравнивание окон (alignment) ${timeframe} ===`);
  for (const d of alignment.details) {
    console.log(`  ${d.exchange}: candleTime=${d.candleTime.toISOString()} UTC hour=${d.utcHour} offset=${d.offsetMs}ms ${d.aligned ? "ALIGNED" : "MISALIGNED"}`);
  }
  if (!alignment.aligned) {
    console.log(`  ⚠ MISALIGNED — cannot-aggregate for multi-exchange ${timeframe}: ${alignment.reason}`);
    console.log(`  Пояснение: для ${timeframe} окна должны быть выровнены к canonical UTC границе. BINGX 1d в 16 UTC не совпадает с остальными 00 UTC — разные daily периоды, агрегация запрещена.`);
    if (timeframe === "1d") {
      console.log(`  Вывод 1d: оценивается per-exchange независимо, но multi-exchange агрегация REFUSED. Для разблокировки 1d требуется нормализация BINGX daily к UTC 00 или исключение BINGX из 1d universe.`);
    }
  } else {
    console.log(`  ✓ ALIGNED ${alignment.alignedCount}/${alignment.totalEvaluated} — можно агрегировать`);
  }

  const agg = aggregateAssetGroup(asset.symbol, timeframe, SMART_MONEY_SLUG, strategyVersion, results, minExchanges);
  if (!canAggregateSafely(alignment) && timeframe === "1d") {
    console.log(`\n=== Агрегация ${asset.symbol} ${timeframe} ${SMART_MONEY_SLUG} v${strategyVersion} — REFUSED (misaligned) ===`);
    console.log(`  direction: ${agg.direction} ${agg.conflict ? "(КОНФЛИКТ)" : ""} — НЕДОСТОВЕРНО для 1d из-за misalignment`);
    console.log(`  votes: LONG ${agg.longVotes} SHORT ${agg.shortVotes} NEUTRAL ${agg.neutralVotes} evaluated ${agg.evaluated} skipped ${agg.skipped}`);
    console.log(`  confirmation: ${agg.confirmation} (порог ${agg.minExchanges})`);
    console.log(`  explanation: ${agg.explanation} — ОТКЛОНЕНО: cross-exchange daily windows не выровнены`);
    console.log(`  Действие: per-exchange результаты выше валидны, но multi-exchange сигнал для 1d НЕ формируется.`);
  } else {
    console.log(`\n=== Агрегация ${asset.symbol} ${timeframe} ${SMART_MONEY_SLUG} v${strategyVersion} ${alignment.aligned ? "" : "— ALIGNED, can aggregate"} ===`);
    console.log(`  direction: ${agg.direction} ${agg.conflict ? "(КОНФЛИКТ)" : ""}`);
    console.log(`  votes: LONG ${agg.longVotes} SHORT ${agg.shortVotes} NEUTRAL ${agg.neutralVotes} evaluated ${agg.evaluated} skipped ${agg.skipped}`);
    console.log(`  confirmation: ${agg.confirmation} (порог ${agg.minExchanges})`);
    console.log(`  explanation: ${agg.explanation}`);
  }

  const signalCount = await prisma.signal.count().catch(() => 0);
  console.log(`\nSignal в БД (только чтение): ${signalCount} (записей не создано — DIAGNOSTIC ONLY)`);

  // Summary report: can 5m/15m/4h be unlocked?
  if (["5m", "15m", "4h"].includes(timeframe)) {
    if (alignment.aligned) {
      console.log(`\nВывод Phase3E: ${timeframe} — all 5 exchanges canonical-aligned (badStep 0), можно SAFELY разблокировать после этого diagnostic (при сохранении CLOSED-only и minExchanges).`);
    } else {
      console.log(`\nВывод Phase3E: ${timeframe} — MISALIGNED, разблокировка требует доп. проверки.`);
    }
  }
  if (timeframe === "1d") {
    console.log(`\nВывод Phase3E 1d: misaligned BINGX 16 UTC vs 00 UTC — 1d multi-exchange пока НЕЛЬЗЯ разблокировать. Нужно: нормализация BINGX к UTC 00 или исключение BINGX из 1d, без фабрикации OHLC.`);
  }

  return 0;
}

async function runMarketDiagnostic(marketId: number, timeframe: SmcTimeframe): Promise<number> {
  const prisma = (await getDb()) as any;
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  DIAGNOSTIC ONLY — CANONICAL CONFIG — READ-ONLY            ║
╚══════════════════════════════════════════════════════════════╝
`);
  const market = await prisma.market.findUnique({ where: { id: marketId }, include: { asset: true } });
  if (!market) {
    console.error(`Market id=${marketId} не найден`);
    return 1;
  }
  console.log(`\nMarket: ${market.exchange} ${market.exchangeSymbol} (id ${market.id})`);
  console.log(`Asset: ${market.asset.symbol} rank ${market.asset.rank ?? "—"}`);
  console.log(`Таймфрейм: ${timeframe} — DIAGNOSTIC canonical`);

  let smcConfig: SmcScoringConfig = defaultSmcScoringConfig(timeframe);
  let filters: SmartMoneyFilters = DEFAULT_SMART_MONEY_FILTERS;
  try {
    const strat = await prisma.strategy.findFirst({ where: { slug: SMART_MONEY_SLUG }, orderBy: { version: "desc" as never } });
    if (strat) {
      const rt = validateSmartMoneyRuntime({ config: strat.config, timeframes: strat.timeframes, minExchanges: strat.minExchanges });
      if (rt.ok) filters = rt.filters;
      console.log(`DIAGNOSTIC: canonical config for ${timeframe} (minimumScore=${smcConfig.minimumScore}), filters ${JSON.stringify(filters)}`);
    }
  } catch {}
  console.log(`DIAGNOSTIC ONLY: CLOSED only, no writes`);

  const meta = {
    exchange: market.exchange as string,
    market: market.exchangeSymbol as string,
    marketId: market.id as number,
    timeframe,
    assetRank: market.asset.rank as number | null,
    quoteVolume24h: market.quoteVolume24h as number | null,
  };
  const candles = await loadSmartMoneyCandles(prisma, market.id, timeframe);
  console.log(`candles: ${candles.length} CLOSED`);
  if (candles.length > 0) {
    console.log(`  first: ${candles[0].openTime.toISOString()}`);
    console.log(`  last: ${candles[candles.length - 1].openTime.toISOString()}`);
  }
  const result = evaluateSmartMoneyWithCandles(meta, candles, smcConfig, filters);
  console.log(`\nРезультат: ${result.status}`);
  if (result.status === "evaluated") {
    console.log(`  longScore ${result.longScore} shortScore ${result.shortScore} direction ${result.direction}`);
    for (const r of result.reasons) console.log(`    [${r.long ? "LONG" : r.short ? "SHORT" : "—"} w=${r.weight}] ${r.label} ${r.value ?? ""}`);
  } else console.log(`  reason: ${result.reason}`);
  return 0;
}

async function main(): Promise<number> {
  const parsed = parseSmartMoneyArgs(process.argv.slice(2));
  const cliError = validateCliArgs(parsed);
  if (cliError) {
    console.error(cliError);
    printHelp();
    return 1;
  }
  const args = parsed.args;
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.selfTest) return runSelfTest();
  if (!isSmcTimeframe(args.timeframe)) {
    console.error(`timeframe "${args.timeframe}" вне списка 5m/15m/1h/4h/1d`);
    return 1;
  }
  const tf = args.timeframe as SmcTimeframe;
  const hasSymbol = parsed.symbolProvided;
  const hasMarketId = parsed.marketIdProvided;
  if (hasSymbol === hasMarketId) {
    console.error("Требуется ровно один из --symbol или --market-id");
    printHelp();
    return 1;
  }
  try {
    if (hasSymbol) {
      const c = await runSymbolDiagnostic(args.symbol as string, tf);
      await closeDb();
      return c;
    } else {
      const c = await runMarketDiagnostic(args.marketId as number, tf);
      await closeDb();
      return c;
    }
  } catch (e) {
    console.error("Ошибка:", e instanceof Error ? e.message : String(e));
    await closeDb();
    return 1;
  }
}

const isDirectRun = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isDirectRun) {
  main()
    .then((c) => process.exit(c))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}

export { runSymbolDiagnostic, runMarketDiagnostic, checkCandleAlignment }; // for tests
