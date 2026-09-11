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
 * - other adapters (binance, bybit, gate, kucoin) also pass raw openTime unchanged
 * - Observed DB fact: BINGX BTC 1d candles in PostgreSQL use 16:00 UTC openTime boundary,
 *   while the other four observed exchanges use 00:00 UTC. Adapter correctly reflects exchange
 *   data without resampling. We do NOT assert engineered cause (e.g., CST/UTC+8) beyond observation.
 * - other TF (5m/15m/1h/4h) observed as UTC-grid aligned for all 5 exchanges (badStep 0)
 *
 * Observed diagnostic fact: 5m/15m/4h checked for canonical grid + same horizon; when aligned, safe.
 * 1d observed misaligned: BINGX 16:00 UTC vs others 00:00 UTC. Until normalized (exclude BINGX from 1d universe
 * or proven UTC-00 normalization without fabricated OHLC), 1d multi-exchange aggregation must be REFUSED.
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
import {
  isSmartMoneyExchangeEligible,
  filterSmartMoneyEligibleResults,
} from "../lib/strategies/smart-money-eligibility";
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

  function mkRes(ex: string, ms: number) {
    return {
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
    };
  }

  // CASE 1: 15m all 5 @15:00 => safe true (canonical + same horizon)
  {
    const ts = Date.UTC(2026, 0, 10, 15, 0, 0);
    const results = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"].map((ex) => mkRes(ex, ts));
    const c = checkCandleAlignment(results as any, "15m");
    ok(c.safe === true && c.aligned === true, "15m all 5 @15:00 => safe true");
    ok(c.offGrid.length === 0, "15m all 5 offGrid empty");
    ok(c.horizonMismatch.length === 0, "15m all 5 horizonMismatch empty");
    ok(c.referenceCandleTime?.getTime() === ts, "15m reference is 15:00");
    ok(canAggregateSafely(c) === true, "15m canAggregateSafely true");
  }

  // CASE 2: 15m 4 @15:00, 1 @14:45 => safe false, horizonMismatch identifies stale
  {
    const ts1500 = Date.UTC(2026, 0, 10, 15, 0, 0);
    const ts1445 = Date.UTC(2026, 0, 10, 14, 45, 0);
    const results = [
      mkRes("BINANCE", ts1500),
      mkRes("BYBIT", ts1500),
      mkRes("GATE", ts1445),
      mkRes("KUCOIN", ts1500),
      mkRes("BINGX", ts1500),
    ];
    const c = checkCandleAlignment(results as any, "15m");
    ok(c.safe === false, "15m 4@15:00 1@14:45 => safe false");
    ok(c.offGrid.length === 0, "15m stale offGrid empty (all on-grid)");
    ok(c.horizonMismatch.length === 1 && c.horizonMismatch[0].exchange === "GATE", "15m horizonMismatch is GATE stale");
    ok(c.horizonMismatch[0].candleTime.getTime() === ts1445, "15m stale candleTime 14:45");
    ok(!canAggregateSafely(c), "15m stale cannot aggregate");
  }

  // CASE 3: 5m 4 @15:15, 1 @15:10 => safe false
  {
    const ts1515 = Date.UTC(2026, 0, 10, 15, 15, 0);
    const ts1510 = Date.UTC(2026, 0, 10, 15, 10, 0);
    const results = [mkRes("BINANCE", ts1515), mkRes("BYBIT", ts1515), mkRes("GATE", ts1510), mkRes("KUCOIN", ts1515), mkRes("BINGX", ts1515)];
    const c = checkCandleAlignment(results as any, "5m");
    ok(c.safe === false, "5m 4@15:15 1@15:10 => safe false");
    ok(c.horizonMismatch.length === 1 && c.horizonMismatch[0].exchange === "GATE", "5m horizonMismatch GATE");
  }

  // CASE 4: 4h 4 @12:00, 1 @08:00 => safe false
  {
    const ts1200 = Date.UTC(2026, 0, 10, 12, 0, 0);
    const ts0800 = Date.UTC(2026, 0, 10, 8, 0, 0);
    const results = [mkRes("BINANCE", ts1200), mkRes("BYBIT", ts1200), mkRes("GATE", ts1200), mkRes("KUCOIN", ts1200), mkRes("BINGX", ts0800)];
    const c = checkCandleAlignment(results as any, "4h");
    ok(c.safe === false, "4h 4@12:00 1@08:00 => safe false");
    ok(c.horizonMismatch.length === 1 && c.horizonMismatch[0].exchange === "BINGX", "4h horizonMismatch BINGX");
    // Both times are on-grid for 4h (00,04,08,12...) so offGrid empty, but horizon differs
    ok(c.offGrid.length === 0, "4h offGrid empty (both on-grid)");
  }

  // CASE 5: 1d 4 @00:00 UTC, BINGX @16:00 UTC => safe false, BINGX offGrid
  {
    const ts00 = Date.UTC(2026, 0, 10, 0, 0, 0);
    const ts16 = Date.UTC(2026, 0, 10, 16, 0, 0);
    const results = [mkRes("BINANCE", ts00), mkRes("BYBIT", ts00), mkRes("GATE", ts00), mkRes("KUCOIN", ts00), mkRes("BINGX", ts16)];
    const c = checkCandleAlignment(results as any, "1d");
    ok(c.safe === false && c.aligned === false, "1d 4@00 1@16 => safe false");
    ok(c.offGrid.length === 1 && c.offGrid[0].exchange === "BINGX", "1d offGrid is BINGX");
    ok(c.horizonMismatch.length === 1 && c.horizonMismatch[0].exchange === "BINGX", "1d horizonMismatch BINGX");
    ok(c.offGrid[0].offsetMs !== 0, "1d BINGX offset non-zero");
    ok(!canAggregateSafely(c), "1d BINGX cannot aggregate");
  }

  // CASE 6: 1d all 5 same UTC midnight => safe true
  {
    const ts = Date.UTC(2026, 0, 10, 0, 0, 0);
    const results = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"].map((ex) => mkRes(ex, ts));
    const c = checkCandleAlignment(results as any, "1d");
    ok(c.safe === true, "1d all 5 same midnight => safe true");
    ok(c.offGrid.length === 0 && c.horizonMismatch.length === 0, "1d all aligned no mismatches");
  }

  // CASE 7: zero evaluated => safe false
  {
    const c = checkCandleAlignment([] as any, "1h");
    ok(c.safe === false, "zero evaluated => safe false");
    ok(c.referenceCandleTime === null, "zero evaluated reference null");
    ok(c.totalEvaluated === 0, "zero evaluated total 0");
    ok(!canAggregateSafely(c), "zero cannot aggregate");
  }

  // CASE 8: one evaluated canonical => temporal safe true, but minExchanges separate
  {
    const ts = Date.UTC(2026, 0, 10, 12, 0, 0);
    const results = [mkRes("BINANCE", ts)];
    const c = checkCandleAlignment(results as any, "1h");
    ok(c.safe === true, "one evaluated canonical => safe true (temporal)");
    ok(c.horizonMismatch.length === 0, "one evaluated horizonMismatch empty");
    ok(c.offGrid.length === 0, "one evaluated offGrid empty");
    // Document: minExchanges still enforced at aggregation layer separately
    const { aggregateAssetGroup } = await import("../lib/strategies/runtime");
    const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, results as any, 3);
    ok(agg.direction === "NEUTRAL" && agg.evaluated === 1 && agg.minExchanges === 3, "one evaluated with minExchanges 3 => NEUTRAL (separate requirement)");
  }

  // Prove unsafe path does NOT call aggregateAssetGroup via pure helper
  {
    const ts1500 = Date.UTC(2026, 0, 10, 15, 0, 0);
    const ts1445 = Date.UTC(2026, 0, 10, 14, 45, 0);
    const results = [mkRes("BINANCE", ts1500), mkRes("BYBIT", ts1445)];
    const c = checkCandleAlignment(results as any, "15m");
    const { shouldAggregateAssetGroup } = await import("../lib/strategies/alignment");
    ok(shouldAggregateAssetGroup(c) === false, "unsafe check shouldAggregate false");
    ok(canAggregateSafely(c) === false, "unsafe canAggregate false");
  }

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

  // Eligibility (Strategy-layer, Option A narrow): BINGX ineligible ONLY for 1d aggregation.
  // Per-exchange evaluation above remains visible for all exchanges; only aggregation uses eligible subset.
  const eligibleResults = filterSmartMoneyEligibleResults(results, timeframe);
  if (eligibleResults.length !== results.length) {
    const excluded = results.filter(
      (r) => !isSmartMoneyExchangeEligible(r.exchange, timeframe)
    );
    console.log(
      `\n  eligibility: excluded ${excluded.map((e) => e.exchange).join(", ")} for ${timeframe} (Smart Money policy: BINGX ineligible for 1d; ${eligibleResults.length}/${results.length} eligible)`
    );
  } else {
    console.log(`\n  eligibility: all ${results.length} markets eligible for ${timeframe} (BINGX eligible on 5m/15m/1h/4h)`);
  }

  // Alignment guard before aggregation — generic for 5m/15m/1h/4h/1d (after eligibility)
  // candleTime is latest CLOSED candle openTime; same timeframe + same candleTime => same interval [candleTime, candleTime+tf)
  const alignment = checkCandleAlignment(eligibleResults, timeframe);
  console.log(`\n=== Выравнивание окон (alignment) ${timeframe} ===`);
  if (alignment.referenceCandleTime) {
    console.log(`  referenceCandleTime: ${alignment.referenceCandleTime.toISOString()} (all evaluated must equal this)`);
  } else {
    console.log(`  referenceCandleTime: — (no evaluated markets)`);
  }
  for (const d of alignment.details) {
    const gridFlag = d.aligned ? "GRID_OK" : "OFF_GRID";
    const horizonFlag = alignment.horizonMismatch.some((h) => h.exchange === d.exchange && h.marketId === d.marketId) ? "HORIZON_MISMATCH" : "HORIZON_OK";
    console.log(`  ${d.exchange}: candleTime=${d.candleTime.toISOString()} UTC hour=${d.utcHour} offset=${d.offsetMs}ms ${gridFlag} ${horizonFlag}`);
  }
  if (alignment.offGrid.length > 0) {
    console.log(`  ⚠ OFF_GRID ${alignment.offGrid.length}/${alignment.totalEvaluated}: ${alignment.offGrid.map((o) => `${o.exchange} ${o.candleTime.toISOString()} offset=${o.offsetMs}ms`).join("; ")}`);
  }
  if (alignment.horizonMismatch.length > 0) {
    console.log(`  ⚠ HORIZON_MISMATCH ${alignment.horizonMismatch.length}/${alignment.totalEvaluated}: reference=${alignment.referenceCandleTime?.toISOString() ?? "—"} mismatched ${alignment.horizonMismatch.map((h) => `${h.exchange} ${h.candleTime.toISOString()}`).join("; ")}`);
  }
  if (!alignment.safe) {
    console.log(`  ⚠ MISALIGNED — cannot-aggregate for multi-exchange ${timeframe}: ${alignment.reason ?? "unsafe"}`);
    console.log(`  Пояснение: требуется (A) canonical grid (openTime % tfMs ===0) и (B) одинаковый latest CLOSED candleTime у всех рынков.`);
  } else {
    console.log(`  ✓ ALIGNED ${alignment.alignedCount}/${alignment.totalEvaluated} safe — можно агрегировать (grid OK + same horizon)`);
  }

  if (!canAggregateSafely(alignment)) {
    console.log(`\n=== MULTI-EXCHANGE AGGREGATION REFUSED ${asset.symbol} ${timeframe} ${SMART_MONEY_SLUG} v${strategyVersion} ===`);
    console.log(`  reason: ${alignment.reason ?? "unsafe alignment"}`);
    if (alignment.referenceCandleTime) console.log(`  referenceCandleTime: ${alignment.referenceCandleTime.toISOString()}`);
    if (alignment.offGrid.length > 0) console.log(`  offGrid: ${alignment.offGrid.map((o) => `${o.exchange} ${o.candleTime.toISOString()}`).join(", ")}`);
    if (alignment.horizonMismatch.length > 0) console.log(`  horizonMismatch: ${alignment.horizonMismatch.map((h) => `${h.exchange} ${h.candleTime.toISOString()}`).join(", ")}`);
    console.log(`  Действие: per-exchange результаты выше валидны, но multi-exchange агрегация НЕ вычисляется (aggregateAssetGroup не вызван).`);
  } else {
    const agg = aggregateAssetGroup(asset.symbol, timeframe, SMART_MONEY_SLUG, strategyVersion, eligibleResults, minExchanges);
    console.log(`\n=== Агрегация ${asset.symbol} ${timeframe} ${SMART_MONEY_SLUG} v${strategyVersion} ===`);
    console.log(`  direction: ${agg.direction} ${agg.conflict ? "(КОНФЛИКТ)" : ""}`);
    console.log(`  votes: LONG ${agg.longVotes} SHORT ${agg.shortVotes} NEUTRAL ${agg.neutralVotes} evaluated ${agg.evaluated} skipped ${agg.skipped}`);
    console.log(`  confirmation: ${agg.confirmation} (порог ${agg.minExchanges})`);
    console.log(`  explanation: ${agg.explanation}`);
    if (agg.evaluated === 1) {
      console.log(`  note: single evaluated — temporal safe, но minExchanges=${agg.minExchanges} проверяется отдельно.`);
    }
  }

  const signalCount = await prisma.signal.count().catch(() => 0);
  console.log(`\nSignal в БД (только чтение): ${signalCount} (записей не создано — DIAGNOSTIC ONLY)`);

  // Summary: generic — safe only if grid OK + same horizon
  if (["5m", "15m", "4h"].includes(timeframe)) {
    if (alignment.safe) {
      console.log(`\nВывод Phase3E: ${timeframe} — safe (grid OK + same horizon, badStep 0), можно разблокировать после diagnostic.`);
    } else {
      console.log(`\nВывод Phase3E: ${timeframe} — MISALIGNED (offGrid ${alignment.offGrid.length}, horizonMismatch ${alignment.horizonMismatch.length}), разблокировка требует проверки.`);
    }
  }
  if (timeframe === "1d") {
    if (alignment.safe) {
      console.log(`\nВывод Phase3E 1d: safe — all 5 at same UTC midnight.`);
    } else {
      console.log(`\nВывод Phase3E 1d: misaligned (observed BINGX 16:00 UTC vs others 00:00 UTC) — 1d пока НЕЛЬЗЯ разблокировать. Нужно: нормализация или исключение BINGX из 1d, без фабрикации OHLC.`);
    }
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
