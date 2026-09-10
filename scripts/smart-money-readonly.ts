/**
 * Smart Money — read-only diagnostic CLI (Phase 3B).
 *
 * ТРЕБОВАНИЯ:
 * - Только explicit --symbol BTC или --market-id N (никакого default scan, Top-100).
 * - Только PostgreSQL CLOSED свечи (orderBy DESC take 500 → reverse).
 * - Никаких writes (Signal create/update отсутствует).
 * - Печать: market, exchange, candles count, evaluable, longScore, shortScore, direction, reasons.
 * - Для symbol-mode — multi-exchange aggregation через существующий aggregateAssetGroup.
 * - CLI self-test (--self-test) без БД, покрывает ключевые инварианты.
 *
 * Примеры:
 *   npx tsx scripts/smart-money-readonly.ts --symbol BTC --timeframe 1h
 *   npx tsx scripts/smart-money-readonly.ts --market-id 123 --timeframe 1h
 *   npx tsx scripts/smart-money-readonly.ts --self-test
 */

import { isSmcTimeframe, SMCTIMEFRAME_MS, type SmcTimeframe, type SmcRawCandle } from "../lib/smc/types";
import { defaultSmcScoringConfig, type SmcScoringConfig } from "../lib/smc/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import {
  SMART_MONEY_SLUG,
  validateSmartMoneyConfig,
  validateSmartMoneyRuntime,
  evaluateSmartMoneyWithCandles,
  loadSmartMoneyCandles,
  applySmartMoneyFilters,
  DEFAULT_SMART_MONEY_FILTERS,
  type SmartMoneyFilters,
} from "../lib/strategies/smart-money";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { checkCandleAlignment, canAggregateSafely } from "../lib/strategies/alignment";
import { fileURLToPath } from "node:url";
import { validateTrendSuslikConfig } from "../lib/strategies/config";

import {
  parseSmartMoneyArgs,
  validateCliArgs,
  type Args,
} from "./smart-money-cli-args";

function printHelp(): void {
  console.log(`
Smart Money — read-only diagnostic CLI (Phase 3B + Phase 3E diagnostic)

Использование:
  npx tsx scripts/smart-money-readonly.ts --symbol BTC [--timeframe 1h]
  npx tsx scripts/smart-money-readonly.ts --market-id 123 [--timeframe 1h]
  npx tsx scripts/smart-money-readonly.ts --symbol BTC --timeframe 15m --diagnostic-canonical-config
  npx tsx scripts/smart-money-readonly.ts --self-test
  npx tsx scripts/smart-money-readonly.ts --help

Опции:
  --symbol BTC           актив (например BTC, без USDT)  (также --symbol=BTC)
  --market-id 123        конкретный Market.id            (также --market-id=123, --marketId 123 / --marketId=123)
  --timeframe 1h         таймфрейм: 5m, 15m, 1h, 4h, 1d (по умолчанию 1h) (также --timeframe=1h)
  --self-test            проверки без БД (pure adapter, инварианты)
  --diagnostic-canonical-config  DIAGNOSTIC ONLY: canonical SMC config, bypasses Strategy.timeframes, read-only, shows per-exchange + alignment guard
  --help                 эта справка

Правила:
  - Требуется ровно один из --symbol / --market-id (никакого default Top-100 скана).
  - Только чтение: никаких Signal INSERT/UPDATE.
  - Свечи берутся из PostgreSQL Candle where closed=true, последние 500 DESC → reverse → ASC.
  - Для --symbol агрегация по активу через существующий aggregateAssetGroup.
  - Без --diagnostic-canonical-config: Strategy.timeframes строго проверяется (Phase 3C staged ["1h"]).
  - С --diagnostic-canonical-config: используется canonical engineering config (minimumSignalScore 72, swing 20/20 etc.), Strategy SMC params игнорируются; фильтры/minExchanges берутся из Strategy если семантически безопасно, иначе default — явно логируется;loud DIAGNOSTIC ONLY баннер.
  - Принимаются обе формы --flag value и --flag=value; флаг без значения — ошибка (например --symbol --timeframe не поглотит --timeframe).
`);
}

// ---------------------------------------------------------------
// Self-test without DB (pure adapter checks)
// ---------------------------------------------------------------

async function runSelfTest(): Promise<number> {
  console.log("Smart Money CLI — self-test (без БД)");

  let passed = 0;
  let total = 0;
  function ok(cond: boolean, label: string): void {
    total += 1;
    if (cond) {
      passed += 1;
      console.log(`  ✓ ${label}`);
    } else {
      console.error(`  ✗ FAIL: ${label}`);
    }
  }

  const T0 = Date.UTC(2026, 0, 1);
  const HOUR = 3_600_000;
  function mk(i: number, o: number, c: number, high?: number, low?: number): SmcRawCandle {
    return {
      openTime: new Date(T0 + i * HOUR),
      open: o,
      high: high ?? Math.max(o, c),
      low: low ?? Math.min(o, c),
      close: c,
      closed: true,
    };
  }
  function flats(from: number, to: number): SmcRawCandle[] {
    const out: SmcRawCandle[] = [];
    for (let i = from; i <= to; i++) {
      const b = i * 0.01;
      out.push(mk(i, 86 + b, 87 + b, 90 + b, 84 + b));
    }
    return out;
  }

  // Canonical fixture from test-smc-evaluate (LONG 80)
  function canonical(): SmcRawCandle[] {
    return [
      ...flats(0, 4),
      mk(5, 86.05, 87.05, 105, 84.05),
      flats(6, 6)[0],
      mk(7, 86.07, 87.07, 90.07, 82),
      ...flats(8, 13),
      mk(14, 90, 86, 90.14, 84),
      mk(15, 91, 104, 108, 91),
      mk(16, 103, 101, 103.5, 95),
      mk(17, 107, 109, 109.5, 106.5),
      ...flats(18, 26),
    ];
  }

  // 1. minimumSignalScore → minimumScore mapping
  {
    const raw = {
      minimumSignalScore: 72,
      swingLeft: 20,
      swingRight: 20,
      internalLeft: 3,
      internalRight: 3,
      atrPeriod: 14,
      structureEventFreshBars: 10,
      sweepFreshBars: 5,
      orderBlockFreshBars: 20,
      fvgFreshBars: 20,
      eqBand: 0.02,
      weights: {
        swingStructureBias: 20,
        recentSwingBos: 15,
        internalStructure: 10,
        liquiditySweep: 10,
        swingOrderBlock: 15,
        internalOrderBlock: 5,
        fvg: 10,
        rangePosition: 10,
        confluence: 5,
      },
    };
    const res = validateSmartMoneyConfig(raw, "1h");
    ok(res.ok === true && (res as { ok: true; config: SmcScoringConfig }).config.minimumScore === 72, "1: minimumSignalScore 72 мапится в minimumScore 72");
  }

  // 2. malformed config: missing minimumSignalScore
  {
    const raw = {
      swingLeft: 20,
      swingRight: 20,
      internalLeft: 3,
      internalRight: 3,
      atrPeriod: 14,
      structureEventFreshBars: 10,
      sweepFreshBars: 5,
      orderBlockFreshBars: 20,
      fvgFreshBars: 20,
      eqBand: 0.02,
      weights: {
        swingStructureBias: 20,
        recentSwingBos: 15,
        internalStructure: 10,
        liquiditySweep: 10,
        swingOrderBlock: 15,
        internalOrderBlock: 5,
        fvg: 10,
        rangePosition: 10,
        confluence: 5,
      },
    };
    const res = validateSmartMoneyConfig(raw, "1h" as SmcTimeframe);
    ok(res.ok === false, "2: malformed config без minimumSignalScore — ошибка");
  }

  // 3. malformed: оба порога одновременно
  {
    const raw = {
      minimumSignalScore: 72,
      minimumScore: 72,
      swingLeft: 20,
      swingRight: 20,
      internalLeft: 3,
      internalRight: 3,
      atrPeriod: 14,
      structureEventFreshBars: 10,
      sweepFreshBars: 5,
      orderBlockFreshBars: 20,
      fvgFreshBars: 20,
      eqBand: 0.02,
      weights: {
        swingStructureBias: 20,
        recentSwingBos: 15,
        internalStructure: 10,
        liquiditySweep: 10,
        swingOrderBlock: 15,
        internalOrderBlock: 5,
        fvg: 10,
        rangePosition: 10,
        confluence: 5,
      },
    };
    const res = validateSmartMoneyConfig(raw as unknown, "1h" as SmcTimeframe);
    ok(res.ok === false, "3: оба порога minimumSignalScore и minimumScore — ошибка");
  }

  // 4. Trend config unchanged
  {
    const trendRaw = {
      minimumSignalScore: 72,
      weights: { trend: 30, mediumTrend: 15, rsi: 20, macd: 20, volume: 15 },
      ema: { fast: 20, medium: 50, slow: 200 },
      rsi: { period: 14, longMin: 52, longMax: 72, shortMin: 28, shortMax: 48 },
      macd: { fast: 12, slow: 26, signal: 9 },
      atr: { period: 14, stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4 },
      volume: { period: 20, minimumRatio: 1 },
      execution: { closedCandleOnly: true, cooldownCandles: 3 },
      filters: { minimumQuoteVolume24h: 1000000, top500Only: true },
    };
    const r = validateTrendSuslikConfig(trendRaw);
    ok(r.ok === true, "4: Trend config остаётся валидным (unchanged)");
  }

  // 5. only CLOSED candle: feed with closed=false → cannot-evaluate
  {
    const cfg = defaultSmcScoringConfig("1h");
    // shallow copy but swap tf to small for test? use small windows to reduce history need
    const smallCfg: SmcScoringConfig = { ...cfg, swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const bad = canonical().map((c) => ({ ...c }));
    (bad[bad.length - 1] as SmcRawCandle).closed = false as unknown as boolean;
    const meta = {
      exchange: "BINANCE",
      market: "BTCUSDT",
      marketId: 1,
      timeframe: "1h" as SmcTimeframe,
      assetRank: 1,
      quoteVolume24h: 1e9,
    };
    const res = evaluateSmartMoneyWithCandles(meta, bad, smallCfg);
    ok(res.status === "cannot-evaluate", "5: свеча с closed=false → cannot-evaluate");
  }

  // 6. insufficient history no fallback → cannot-evaluate, not fallback to NEUTRAL/evaluated
  {
    const cfg = defaultSmcScoringConfig("1h");
    const smallCfg: SmcScoringConfig = { ...cfg, swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const short = flats(0, 2); // 3 свечи << 8 нужных
    const meta = {
      exchange: "BINANCE",
      market: "BTCUSDT",
      marketId: 1,
      timeframe: "1h" as SmcTimeframe,
      assetRank: 1,
      quoteVolume24h: 1e9,
    };
    const res = evaluateSmartMoneyWithCandles(meta, short, smallCfg);
    ok(res.status === "cannot-evaluate" && res.reason.includes("INSUFFICIENT_HISTORY"), "6: insufficient history → cannot-evaluate (INSUFFICIENT_HISTORY), без fallback");
  }

  // 7. ascending after fetch: loader semantics covered via pure sort check; мы тестим что несортированный массив → cannot-evaluate (валидатор ловит)
  {
    const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const cand = canonical();
    const unsorted = [cand[5], cand[3], cand[4], ...cand.slice(6)]; // нарушили порядок
    const meta = {
      exchange: "BINANCE",
      market: "BTCUSDT",
      marketId: 1,
      timeframe: "1h" as SmcTimeframe,
      assetRank: 1,
      quoteVolume24h: 1e9,
    };
    const res = evaluateSmartMoneyWithCandles(meta, unsorted, cfg);
    ok(res.status === "cannot-evaluate" && res.reason.includes("openTime"), "7: несортированные свечи → cannot-evaluate (ascending контракт)");
  }

  // 8. latest 500 semantics proof via loader mock
  {
    // Mock prisma
    const many: SmcRawCandle[] = [];
    for (let i = 0; i < 700; i++) {
      many.push(mk(i, 100 + i * 0.1, 101 + i * 0.1, 102 + i * 0.1, 99 + i * 0.1));
    }
    // Simulate DB rows: they would be DESC take 500 → последние 200..699? Actually 700 total, last 500 are 200..699 (newest). Our loader does DESC take 500 then reverse → ASC 200..699.
    // Проверим нашу функцию loadSmartMoneyCandles делает именно так.
    const mockPrisma = {
      candle: {
        findMany: async (args: unknown) => {
          const opts = args as { where: unknown; orderBy: { openTime: string }; take: number };
          // verify semantics: should query DESC
          ok(opts.orderBy.openTime === "desc", "8a: loader запрашивает orderBy openTime DESC");
          ok(opts.take === 500, "8b: loader берёт take 500");
          // Simulate DB: sort DESC from many, take 500, return in DESC order
          const desc = [...many].sort((a, b) => b.openTime.getTime() - a.openTime.getTime());
          const takenDesc = desc.slice(0, 500);
          return takenDesc.map((c) => ({
            openTime: c.openTime,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            closed: c.closed,
          }));
        },
      },
    };
    const loaded = await loadSmartMoneyCandles(mockPrisma as unknown as never, 1, "1h");
    ok(loaded.length === 500, "8c: загружено ровно 500 самых новых");
    ok(
      loaded[0].openTime.getTime() === many[200].openTime.getTime() &&
        loaded[499].openTime.getTime() === many[699].openTime.getTime(),
      "8d: после reverse получаем ASC и самые новые 500 (не старые)"
    );
    // Проверяем ASC
    let asc = true;
    for (let i = 1; i < loaded.length; i++) {
      if (loaded[i].openTime.getTime() <= loaded[i - 1].openTime.getTime()) asc = false;
    }
    ok(asc, "8e: ASC после fetch");
  }

  // 9. CANNOT_EVALUATE vs NEUTRAL
  {
    const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1, minimumScore: 72 };
    // NEUTRAL fixture: evaluable but scores 20/15? Use small threshold high → neutral
    // Для canonical @40h after flats, long maybe 40 short maybe something <72 → NEUTRAL evaluated.
    // Мы сгенерим недостаточную историю для CANNOT и evaluable low-score для NEUTRAL.
    const neutralCandles = canonical(); // @18 should be LONG, but with high threshold 90 → NEUTRAL evaluable
    const highThresh: SmcScoringConfig = { ...cfg, minimumScore: 90 };
    const meta = {
      exchange: "BINANCE",
      market: "BTCUSDT",
      marketId: 1,
      timeframe: "1h" as SmcTimeframe,
      assetRank: 1,
      quoteVolume24h: 1e9,
    };
    const resNeutral = evaluateSmartMoneyWithCandles(meta, neutralCandles, highThresh);
    ok(
      resNeutral.status === "evaluated" && (resNeutral as { direction: string }).direction === "NEUTRAL",
      "9a: NEUTRAL остаётся evaluated (не skipped), когда обе стороны ниже порога"
    );

    const shortCant = flats(0, 2);
    const resCant = evaluateSmartMoneyWithCandles(meta, shortCant, cfg);
    ok(resCant.status === "cannot-evaluate", "9b: CANNOT_EVALUATE → Skipped cannot-evaluate");
  }

  // 10. 9 SMC reasons preserved
  {
    const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const meta = {
      exchange: "BINANCE",
      market: "BTCUSDT",
      marketId: 1,
      timeframe: "1h" as SmcTimeframe,
      assetRank: 1,
      quoteVolume24h: 1e9,
    };
    const res = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
    if (res.status === "evaluated") {
      ok(res.reasons.length === 9 || res.reasons.length === 10, "10a: 9 SMC причин сохранены (9 + опционально conflict)");
      const hasSwingTrend = res.reasons.some((r) => r.label.includes("SWING_TREND"));
      ok(hasSwingTrend, "10b: SWING_TREND присутствует в маппинге");
      // Invariant sum
      const sumLong = res.reasons
        .filter((r) => !r.label.includes("DIRECTION_CONFLICT"))
        .reduce((s, r) => s + (r.long ? r.weight : 0), 0);
      // Мы маппим weight=maxPoints, long=true если original longPoints>0, так что sumLong не обязательно равен longScore если mapping weight vs points отличается? Но наш mapping сохраняет maxPoints vs points? Проверим инвариант через raw evaluateSmc.
      // Для детальной проверки используем raw evaluateSmc напрямую.
      const rawEval = evaluateSmc(canonical(), cfg, new Date(canonical()[canonical().length - 1].openTime.getTime() + HOUR));
      const sumPointsLong = rawEval.reasons.filter((r) => r.code !== "DIRECTION_CONFLICT").reduce((s, r) => s + r.longPoints, 0);
      ok(sumPointsLong === rawEval.longScore, "10c: score инвариант longPoints sum == longScore");
      ok(rawEval.reasons.length === 9 || rawEval.reasons.length === 10, "10d: raw reasons 9 (или 10 с conflict)");
    } else {
      ok(false, "10: evaluable fixture должен быть evaluated");
    }
  }

  // 11. multi-exchange minExchanges=2, conflict, NEUTRAL does not vote
  {
    const markets = [
      { status: "evaluated" as const, exchange: "BINANCE", market: "BTCUSDT", marketId: 1, candleTime: new Date(), price: 100, longScore: 80, shortScore: 10, direction: "LONG" as const, reasons: [], warnings: [] },
      { status: "evaluated" as const, exchange: "BYBIT", market: "BTCUSDT", marketId: 2, candleTime: new Date(), price: 100, longScore: 10, shortScore: 85, direction: "SHORT" as const, reasons: [], warnings: [] },
      { status: "evaluated" as const, exchange: "GATE", market: "BTCUSDT", marketId: 3, candleTime: new Date(), price: 100, longScore: 10, shortScore: 10, direction: "NEUTRAL" as const, reasons: [], warnings: [] },
    ];
    // minExchanges 2 → LONG 1, SHORT 1 → нет подтверждения
    const agg1 = aggregateAssetGroup("BTC", "1h", SMART_MONEY_SLUG, 1, markets, 2);
    ok(agg1.direction === "NEUTRAL" && !agg1.conflict, "11a: 1 LONG +1 SHORT при пороге 2 → NEUTRAL без конфликта (NEUTRAL не голосует)");

    // Добавим второй LONG → LONG 2/3 → LONG
    const markets2 = [
      ...markets,
      { status: "evaluated" as const, exchange: "KUCOIN", market: "BTCUSDT", marketId: 4, candleTime: new Date(), price: 100, longScore: 80, shortScore: 0, direction: "LONG" as const, reasons: [], warnings: [] },
    ];
    const agg2 = aggregateAssetGroup("BTC", "1h", SMART_MONEY_SLUG, 1, markets2, 2);
    ok(agg2.direction === "LONG" && agg2.longVotes === 2 && agg2.conflict === false, "11b: LONG 2/4 при пороге 2 → LONG");

    // Конфликт: 2 LONG и 2 SHORT
    const markets3 = [
      { status: "evaluated" as const, exchange: "BINANCE", market: "BTCUSDT", marketId: 1, candleTime: new Date(), price: 100, longScore: 80, shortScore: 0, direction: "LONG" as const, reasons: [], warnings: [] },
      { status: "evaluated" as const, exchange: "BYBIT", market: "BTCUSDT", marketId: 2, candleTime: new Date(), price: 100, longScore: 80, shortScore: 0, direction: "LONG" as const, reasons: [], warnings: [] },
      { status: "evaluated" as const, exchange: "GATE", market: "BTCUSDT", marketId: 3, candleTime: new Date(), price: 100, longScore: 0, shortScore: 80, direction: "SHORT" as const, reasons: [], warnings: [] },
      { status: "evaluated" as const, exchange: "KUCOIN", market: "BTCUSDT", marketId: 4, candleTime: new Date(), price: 100, longScore: 0, shortScore: 80, direction: "SHORT" as const, reasons: [], warnings: [] },
    ];
    const agg3 = aggregateAssetGroup("BTC", "1h", SMART_MONEY_SLUG, 1, markets3, 2);
    ok(agg3.direction === "NEUTRAL" && agg3.conflict === true, "11c: конфликт LONG 2 и SHORT 2 при пороге 2 → NEUTRAL + conflict");
  }

  // 12. deterministic result
  {
    const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const meta = {
      exchange: "BINANCE",
      market: "BTCUSDT",
      marketId: 1,
      timeframe: "1h" as SmcTimeframe,
      assetRank: 1,
      quoteVolume24h: 1e9,
    };
    const a = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
    const b = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
    ok(JSON.stringify(a) === JSON.stringify(b), "12: детерминированный результат (два запуска идентичны)");
  }

  // 13. no lookahead (future injection)
  {
    const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
    const full = [...canonical(), ...flats(27, 35)];
    const asOfIdx = 18;
    const asOfMs = T0 + (asOfIdx + 1) * HOUR;
    const prefix = full.slice(0, asOfIdx + 1);
    const evalFull = evaluateSmc(full, cfg, new Date(asOfMs));
    const evalPrefix = evaluateSmc(prefix, cfg, new Date(asOfMs));
    ok(JSON.stringify(evalFull) === JSON.stringify(evalPrefix), "13: no lookahead — evaluateSmc(full,T) ≡ evaluateSmc(prefix,T)");
  }

  // 14. no Signal imports (static check)
  {
    const fs = await import("node:fs");
    const txt = fs.readFileSync("lib/strategies/smart-money.ts", "utf-8");
    const hasSignalWrite = /prisma\.signal\.create|prisma\.signal\.update|signal-worker|lib\/signals/.test(txt);
    ok(!hasSignalWrite, "14: нет Signal импортов/writes в smart-money адаптере");
    const cliTxt = fs.readFileSync("scripts/smart-money-readonly.ts", "utf-8");
    const hasSignalCli = /prisma\.signal\.create/.test(cliTxt);
    ok(!hasSignalCli, "14b: CLI не содержит Signal writes");
  }

  // 15. validate runtime sanity
  {
    const raw = {
      minimumSignalScore: 72,
      swingLeft: 20,
      swingRight: 20,
      internalLeft: 3,
      internalRight: 3,
      atrPeriod: 14,
      structureEventFreshBars: 10,
      sweepFreshBars: 5,
      orderBlockFreshBars: 20,
      fvgFreshBars: 20,
      eqBand: 0.02,
      weights: {
        swingStructureBias: 20,
        recentSwingBos: 15,
        internalStructure: 10,
        liquiditySweep: 10,
        swingOrderBlock: 15,
        internalOrderBlock: 5,
        fvg: 10,
        rangePosition: 10,
        confluence: 5,
      },
      filters: { minimumQuoteVolume24h: 1000000, top500Only: true },
    };
    const rt = validateSmartMoneyRuntime({ config: raw, timeframes: ["1h", "4h"], minExchanges: 2 });
    ok(rt.ok === true && rt.minExchanges === 2, "15: validateSmartMoneyRuntime принимает timeframes и minExchanges=2");
    const badRt = validateSmartMoneyRuntime({ config: raw, timeframes: [], minExchanges: 2 });
    ok(badRt.ok === false, "15b: пустые timeframes — ошибка");
  }

  // 16+. CLI parser — обе формы, защита от поглощения флага, валидация
  {
    const p1 = parseSmartMoneyArgs(["--symbol", "BTC", "--timeframe", "1h"]);
    ok(
      p1.args.symbol === "BTC" && p1.args.timeframe === "1h" && p1.errors.length === 0,
      "16a: --symbol BTC --timeframe 1h"
    );
    const p2 = parseSmartMoneyArgs(["--symbol=BTC", "--timeframe=1h"]);
    ok(
      p2.args.symbol === "BTC" && p2.args.timeframe === "1h" && p2.errors.length === 0,
      "16b: --symbol=BTC --timeframe=1h"
    );
    const p3 = parseSmartMoneyArgs(["--market-id", "123"]);
    ok(
      p3.args.marketId === 123 && p3.errors.length === 0,
      "16c: --market-id 123"
    );
    const p4 = parseSmartMoneyArgs(["--market-id=123"]);
    ok(p4.args.marketId === 123 && p4.errors.length === 0, "16d: --market-id=123");
    const p4b = parseSmartMoneyArgs(["--marketId", "456"]);
    ok(p4b.args.marketId === 456 && p4b.errors.length === 0, "16d2: --marketId 456 legacy alias");
    const p4c = parseSmartMoneyArgs(["--marketId=789"]);
    ok(p4c.args.marketId === 789 && p4c.errors.length === 0, "16d3: --marketId=789 legacy alias");
    const p5 = parseSmartMoneyArgs(["--symbol", "--timeframe", "1h"]);
    ok(
      p5.errors.length > 0 && p5.errors[0].includes("--symbol"),
      "16e: --symbol --timeframe не поглощает флаг (ошибка)"
    );
    const p6 = parseSmartMoneyArgs(["--market-id", "--self-test"]);
    ok(
      p6.errors.length > 0 && p6.errors[0].includes("--market-id"),
      "16f: --market-id --self-test не поглощает флаг"
    );
    const p7 = parseSmartMoneyArgs([
      "--symbol",
      "BTC",
      "--market-id",
      "123",
    ]);
    ok(
      validateCliArgs(p7) !== null &&
        (validateCliArgs(p7) as string).includes("ровно один"),
      "16g: оба --symbol и --market-id → ошибка ровно один"
    );
    const p8 = parseSmartMoneyArgs(["--timeframe", "1h"]);
    ok(
      validateCliArgs(p8) !== null,
      "16h: ни symbol ни market-id → ошибка"
    );
    const p9 = parseSmartMoneyArgs(["--market-id", "abc"]);
    ok(p9.errors.length > 0, "16i: malformed --market-id abc → ошибка");
    const p9b = parseSmartMoneyArgs(["--market-id="]);
    ok(p9b.errors.length > 0, "16i2: --market-id= (пусто) → ошибка");
    const p9c = parseSmartMoneyArgs(["--market-id", "12.5"]);
    ok(p9c.errors.length > 0, "16i3: --market-id 12.5 (не целое) → ошибка");
    const p10 = parseSmartMoneyArgs(["--symbol", "BTC"]);
    ok(p10.args.timeframe === "1h", "16j: default timeframe остаётся 1h");
    const p11 = parseSmartMoneyArgs([
      "--symbol",
      "BTC",
      "--timeframe",
      "4h",
    ]);
    ok(p11.args.timeframe === "4h", "16k: --timeframe 4h spaced");
    const p12 = parseSmartMoneyArgs([
      "--symbol=BTC",
      "--timeframe",
      "1h",
    ]);
    ok(
      p12.args.symbol === "BTC" && p12.args.timeframe === "1h",
      "16l: смешанная форма --symbol=BTC + --timeframe 1h"
    );
  }

  console.log(`\nИтог self-test: ${passed}/${total}`);
  return passed === total ? 0 : 1;
}

// ---------------------------------------------------------------
// DB modes
// ---------------------------------------------------------------

let db: unknown | null = null;
async function getDb(): Promise<unknown> {
  if (!db) {
    const mod = await import("@prisma/client");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db = new (mod as unknown as { PrismaClient: new () => unknown }).PrismaClient();
  }
  return db!;
}
async function closeDb(): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = db as unknown as { $disconnect?: () => Promise<void> } | null;
  if (d && typeof d.$disconnect === "function") await d.$disconnect();
  db = null;
}

async function runSymbolMode(symbol: string, timeframe: SmcTimeframe, diagnostic = false): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = (await getDb()) as any;

  const asset = await prisma.asset.findFirst({
    where: { symbol: symbol.toUpperCase() },
  });

  if (!asset) {
    console.error(`Asset ${symbol} не найден`);
    return 1;
  }

  console.log(`\nАктив: ${asset.symbol} (rank ${asset.rank ?? "—"}, id ${asset.id})`);
  console.log(`Таймфрейм: ${timeframe}`);
  if (diagnostic) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  DIAGNOSTIC ONLY — CANONICAL CONFIG — READ-ONLY            ║`);
    console.log(`║  Strategy SMC params IGNORED, canonical engineering config ║`);
    console.log(`║  No Signal writes, no workers, CLOSED candles only        ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
  }

  // Попытка загрузить Strategy конфиг для smart-money, fallback к default
  let smcConfig: SmcScoringConfig;
  let filters: SmartMoneyFilters = DEFAULT_SMART_MONEY_FILTERS;
  let minExchanges = 2;
  let strategyVersion = 1;

  try {
    const strat = await prisma.strategy.findFirst({
      where: { slug: SMART_MONEY_SLUG },
      orderBy: { version: "desc" as never },
    });
    if (diagnostic) {
      // DIAGNOSTIC: canonical SMC config regardless of Strategy.timeframes
      smcConfig = defaultSmcScoringConfig(timeframe);
      if (strat) {
        const rt = validateSmartMoneyRuntime({
          config: strat.config,
          timeframes: strat.timeframes,
          minExchanges: strat.minExchanges,
        });
        if (rt.ok) {
          // Use real Strategy operator filters/minExchanges if semantically safe (they are independent of TF)
          filters = rt.filters;
          minExchanges = rt.minExchanges;
          strategyVersion = strat.version;
          console.log(
            `DIAGNOSTIC: Стратегия ${strat.slug} v${strat.version} найдена — Strategy SMC params IGNORED, canonical config for ${timeframe} (minimumScore=${smcConfig.minimumScore}) используется.`,
          );
          console.log(
            `DIAGNOSTIC filters/minExchanges: using Strategy DB values (minExchanges=${minExchanges}, filters=${JSON.stringify(filters)}) — явно логируется, canonical SMC params only`,
          );
        } else {
          console.log(
            `DIAGNOSTIC: Стратегия ${SMART_MONEY_SLUG} в БД невалидна (${rt.errors.join("; ")}) — используется canonical config + DEFAULT filters/minExchanges (2)`,
          );
          filters = DEFAULT_SMART_MONEY_FILTERS;
          minExchanges = 2;
          strategyVersion = strat.version;
        }
      } else {
        console.log(
          `DIAGNOSTIC: Стратегия ${SMART_MONEY_SLUG} не найдена — используется canonical defaultSmcScoringConfig(${timeframe}) с minimumScore=72 + DEFAULT filters/minExchanges`,
        );
        filters = DEFAULT_SMART_MONEY_FILTERS;
        minExchanges = 2;
      }
      console.log(`DIAGNOSTIC ONLY: no Strategy mutation, no Signal writes, CLOSED candles only, workers not started`);
    } else if (strat) {
      const rt = validateSmartMoneyRuntime({
        config: strat.config,
        timeframes: strat.timeframes,
        minExchanges: strat.minExchanges,
      });
      if (rt.ok) {
        const cfgForTf = rt.configs[timeframe];
        if (!cfgForTf) {
          console.error(
            `Стратегия ${SMART_MONEY_SLUG} не поддерживает timeframe ${timeframe} (доступно: ${rt.timeframes.join(", ")})`
          );
          return 1;
        }
        smcConfig = cfgForTf;
        filters = rt.filters;
        minExchanges = rt.minExchanges;
        strategyVersion = strat.version;
        console.log(
          `Стратегия ${strat.slug} v${strat.version} найдена в БД (minimumScore=${smcConfig.minimumScore}, minExchanges=${minExchanges})`
        );
      } else {
        console.warn(`Стратегия ${SMART_MONEY_SLUG} в БД невалидна: ${rt.errors.join("; ")} — используется default`);
        smcConfig = defaultSmcScoringConfig(timeframe);
      }
    } else {
      console.log(`Стратегия ${SMART_MONEY_SLUG} не найдена в БД — используется defaultSmcScoringConfig(${timeframe}) с minimumScore=72`);
      smcConfig = defaultSmcScoringConfig(timeframe);
    }
  } catch (e) {
    console.warn(`Ошибка загрузки Strategy: ${String(e)} — используется default`);
    smcConfig = defaultSmcScoringConfig(timeframe);
  }

  const markets = await prisma.market.findMany({
    where: {
      assetId: asset.id,
      enabled: true,
      status: "ACTIVE",
      marketType: "SPOT",
      quote: "USDT",
    },
    orderBy: { exchange: "asc" },
  });

  if (markets.length === 0) {
    console.error(`Нет активных SPOT USDT рынков для ${asset.symbol}`);
    return 1;
  }

  console.log(`Рынков к проверке: ${markets.length}`);
  console.log(`Фильтры: top500Only=${filters.top500Only}, minimumQuoteVolume24h=${filters.minimumQuoteVolume24h}`);
  console.log(`Свечи: последние 500 CLOSED (DESC take 500 → reverse)`);

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
      // Проверка ASC: каждый openTime > предыдущего
      let asc = true;
      for (let i = 1; i < candles.length; i++) {
        if (candles[i].openTime.getTime() <= candles[i - 1].openTime.getTime()) {
          asc = false;
          break;
        }
      }
      console.log(`  ASC check: ${asc ? "OK" : "FAIL"}`);
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

  // Phase 3E: cross-exchange candle-window alignment guard before aggregation
  const alignment = checkCandleAlignment(results, timeframe);
  console.log(`\n=== Выравнивание окон (alignment) ${timeframe} ===`);
  for (const d of alignment.details) {
    console.log(`  ${d.exchange}: candleTime=${d.candleTime.toISOString()} UTC hour=${d.utcHour} offset=${d.offsetMs}ms ${d.aligned ? "ALIGNED" : "MISALIGNED"}`);
  }
  if (!alignment.aligned) {
    console.log(`  ⚠ MISALIGNED — cannot-aggregate for multi-exchange ${timeframe}: ${alignment.reason}`);
    console.log(`  Пояснение: для ${timeframe} окна должны быть выровнены к canonical UTC границе (openTime % ${"SMCTIMEFRAME_MS[timeframe]"} ===0). BINGX 1d в 16 UTC не совпадает с остальными 00 UTC — это разные daily периоды, агрегация запрещена.`);
    if (timeframe === "1d") {
      console.log(`  Вывод 1d: оценивается per-exchange независимо, но multi-exchange агрегация REFUSED. Для разблокировки 1d требуется нормализация BINGX daily к UTC 00 или исключение BINGX из 1d universe.`);
    }
  } else {
    console.log(`  ✓ ALIGNED ${alignment.alignedCount}/${alignment.totalEvaluated} — можно агрегировать`);
  }

  // Aggregation (if misaligned for 1d, we still compute but mark as not aggregatable)
  const agg = aggregateAssetGroup(
    asset.symbol,
    timeframe,
    SMART_MONEY_SLUG,
    strategyVersion,
    results,
    minExchanges
  );

  if (!canAggregateSafely(alignment) && timeframe === "1d") {
    console.log(`\n=== Агрегация ${asset.symbol} ${timeframe} ${SMART_MONEY_SLUG} v${strategyVersion} — REFUSED (misaligned) ===`);
    console.log(`  direction: ${agg.direction} ${agg.conflict ? "(КОНФЛИКТ)" : ""} — НЕДОСТОВЕРНО для 1d из-за misalignment`);
    console.log(`  votes: LONG ${agg.longVotes} SHORT ${agg.shortVotes} NEUTRAL ${agg.neutralVotes} evaluated ${agg.evaluated} skipped ${agg.skipped}`);
    console.log(`  confirmation: ${agg.confirmation} (порог ${agg.minExchanges})`);
    console.log(`  explanation: ${agg.explanation} — ОТКЛОНЕНО: cross-exchange daily windows не выровнены (BINGX 16 UTC vs 00 UTC)`);
    console.log(`  Действие: per-exchange результаты выше валидны, но multi-exchange сигнал для 1d НЕ формируется.`);
  } else {
    console.log(`\n=== Агрегация ${asset.symbol} ${timeframe} ${SMART_MONEY_SLUG} v${strategyVersion} ===`);
    console.log(`  direction: ${agg.direction} ${agg.conflict ? "(КОНФЛИКТ)" : ""}`);
    console.log(`  votes: LONG ${agg.longVotes} SHORT ${agg.shortVotes} NEUTRAL ${agg.neutralVotes} evaluated ${agg.evaluated} skipped ${agg.skipped}`);
    console.log(`  confirmation: ${agg.confirmation} (порог ${agg.minExchanges})`);
    console.log(`  explanation: ${agg.explanation}`);
  }

  const discBefore = await prisma.signal.count().catch(() => 0);
  console.log(`\nSignal в БД (только чтение): ${discBefore} (записей не создано)`);
  return 0;
}

async function runMarketMode(marketId: number, timeframe: SmcTimeframe, diagnostic = false): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prisma = (await getDb()) as any;

  const market = await prisma.market.findUnique({
    where: { id: marketId },
    include: { asset: true },
  });
  if (!market) {
    console.error(`Market id=${marketId} не найден`);
    return 1;
  }

  console.log(`\nMarket: ${market.exchange} ${market.exchangeSymbol} (id ${market.id})`);
  console.log(`Asset: ${market.asset.symbol} rank ${market.asset.rank ?? "—"}`);
  console.log(`Таймфрейм: ${timeframe}`);
  if (diagnostic) {
    console.log(`
╔══════════════════════════════════════════════════════════════╗`);
    console.log(`║  DIAGNOSTIC ONLY — CANONICAL CONFIG — READ-ONLY            ║`);
    console.log(`╚══════════════════════════════════════════════════════════════╝`);
  }

  let smcConfig: SmcScoringConfig;
  let filters: SmartMoneyFilters = DEFAULT_SMART_MONEY_FILTERS;
  try {
    const strat = await prisma.strategy.findFirst({
      where: { slug: SMART_MONEY_SLUG },
      orderBy: { version: "desc" as never },
    });
    if (diagnostic) {
      smcConfig = defaultSmcScoringConfig(timeframe);
      if (strat) {
        const rt = validateSmartMoneyRuntime({
          config: strat.config,
          timeframes: strat.timeframes,
          minExchanges: strat.minExchanges,
        });
        if (rt.ok) {
          filters = rt.filters;
          console.log(`DIAGNOSTIC: Стратегия ${strat.slug} v${strat.version} — canonical config for ${timeframe} (minimumScore=${smcConfig.minimumScore}), filters from DB ${JSON.stringify(filters)}`);
        } else {
          console.log(`DIAGNOSTIC: Стратегия невалидна — canonical config + DEFAULT filters`);
          filters = DEFAULT_SMART_MONEY_FILTERS;
        }
      } else {
        console.log(`DIAGNOSTIC: Стратегия ${SMART_MONEY_SLUG} не найдена — canonical defaultSmcScoringConfig(${timeframe})`);
        filters = DEFAULT_SMART_MONEY_FILTERS;
      }
      console.log(`DIAGNOSTIC ONLY: no mutation, CLOSED only`);
    } else if (strat) {
      const rt = validateSmartMoneyRuntime({
        config: strat.config,
        timeframes: strat.timeframes,
        minExchanges: strat.minExchanges,
      });
      if (rt.ok && rt.configs[timeframe]) {
        smcConfig = rt.configs[timeframe];
        filters = rt.filters;
        console.log(`Стратегия ${strat.slug} v${strat.version} from DB (minimumScore=${smcConfig.minimumScore})`);
      } else {
        console.log(`Стратегия не подходит для ${timeframe} или невалидна — default`);
        smcConfig = defaultSmcScoringConfig(timeframe);
      }
    } else {
      console.log(`Стратегия ${SMART_MONEY_SLUG} не найдена — defaultSmcScoringConfig(${timeframe})`);
      smcConfig = defaultSmcScoringConfig(timeframe);
    }
  } catch {
    smcConfig = defaultSmcScoringConfig(timeframe);
  }

  const meta = {
    exchange: market.exchange as string,
    market: market.exchangeSymbol as string,
    marketId: market.id as number,
    timeframe,
    assetRank: market.asset.rank as number | null,
    quoteVolume24h: market.quoteVolume24h as number | null,
  };

  const candles = await loadSmartMoneyCandles(prisma, market.id, timeframe);
  console.log(`candles: ${candles.length} CLOSED (последние 500 DESC→ASC)`);
  if (candles.length > 0) {
    console.log(`  first: ${candles[0].openTime.toISOString()} close=${candles[0].close}`);
    console.log(`  last:  ${candles[candles.length - 1].openTime.toISOString()} close=${candles[candles.length - 1].close}`);
  }

  const result = evaluateSmartMoneyWithCandles(meta, candles, smcConfig, filters);

  console.log(`\nРезультат:`);
  if (result.status === "evaluated") {
    console.log(`  evaluable: true`);
    console.log(`  exchange: ${result.exchange} market: ${result.market} marketId: ${result.marketId}`);
    console.log(`  candleTime: ${result.candleTime.toISOString()} price: ${result.price}`);
    console.log(`  longScore: ${result.longScore} shortScore: ${result.shortScore} direction: ${result.direction}`);
    console.log(`  reasons:`);
    for (const r of result.reasons) {
      const mark = r.long ? "LONG" : r.short ? "SHORT" : "—";
      console.log(`    [${mark.padEnd(5)} w=${r.weight}] ${r.label} ${r.value ?? ""}`);
    }
  } else {
    console.log(`  evaluable: false`);
    console.log(`  status: ${result.status}`);
    console.log(`  reason: ${result.reason}`);
  }

  // Print hard failures detail if any: already in reason
  return 0;
}

// ---------------------------------------------------------------
// Main
// ---------------------------------------------------------------

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

  if (args.selfTest) {
    const code = await runSelfTest();
    return code;
  }

  if (!isSmcTimeframe(args.timeframe)) {
    console.error(`timeframe "${args.timeframe}" вне списка 5m/15m/1h/4h/1d`);
    return 1;
  }

  const tf = args.timeframe as SmcTimeframe;

  const hasSymbol = parsed.symbolProvided;
  const hasMarketId = parsed.marketIdProvided;

  if (hasSymbol === hasMarketId) {
    console.error(
      "Требуется ровно один из --symbol или --market-id (никакого default скана)"
    );
    printHelp();
    return 1;
  }

  try {
    const diag = !!args.diagnosticCanonicalConfig;
    if (hasSymbol) {
      const code = await runSymbolMode(args.symbol as string, tf, diag);
      await closeDb();
      return code;
    } else {
      const code = await runMarketMode(args.marketId as number, tf, diag);
      await closeDb();
      return code;
    }
  } catch (e) {
    console.error("Ошибка:", e instanceof Error ? e.message : String(e));
    await closeDb();
    return 1;
  }
}

// CLI entry point — runs only when executed directly (importing parser from pure module does not trigger it)
const isDirectRun =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === process.argv[1];

if (isDirectRun) {
  main()
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
