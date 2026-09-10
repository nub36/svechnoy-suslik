/**
 * Smart Money — runtime adapter tests (Phase 3B).
 * Запуск: npx tsx scripts/test-smart-money.ts
 *
 * Проверяет минимум из ТЗ Phase 3B:
 * - evaluable mapping;
 * - LONG / SHORT / NEUTRAL evaluated, CANNOT_EVALUATE → skipped;
 * - hard failure reasons;
 * - 9 SMC reasons;
 * - score invariant;
 * - minimumSignalScore → minimumScore;
 * - malformed config;
 * - Trend unchanged;
 * - only CLOSED;
 * - insufficient history no fallback;
 * - latest 500 + ASC;
 * - multi-exchange minExchanges=2, conflict, NEUTRAL не голосует;
 * - deterministic;
 * - no lookahead;
 * - CLI self-test existence;
 * - no Signal writes.
 */

import { readFileSync } from "node:fs";
import { defaultSmcScoringConfig, type SmcScoringConfig } from "../lib/smc/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import { isSmcTimeframe, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import {
  SMART_MONEY_SLUG,
  validateSmartMoneyConfig,
  validateSmartMoneyRuntime,
  evaluateSmartMoneyWithCandles,
  loadSmartMoneyCandles,
  mapSmcReasonsToStrategyReasons,
} from "../lib/strategies/smart-money";
import {
  parseSmartMoneyArgs,
  validateCliArgs,
} from "./smart-money-cli-args";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { validateTrendSuslikConfig } from "../lib/strategies/config";
import { runTrendSuslik } from "../lib/strategies/trend-suslik";

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

async function main(): Promise<void> {
console.log("Smart Money — Phase 3B checks");

// 1 evaluable mapping: LONG should be evaluated
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const r = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
  ok(r.status === "evaluated" && r.direction === "LONG", "evaluable mapping: canonical → LONG evaluated");
}

// 2 SHORT: mirror canonical should be SHORT
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const neg = canonical().map((c) => ({
    openTime: c.openTime,
    open: -c.open,
    high: -c.low,
    low: -c.high,
    close: -c.close,
    closed: true as const,
  })) as SmcRawCandle[];
  const r = evaluateSmartMoneyWithCandles(meta, neg, cfg);
  ok(r.status === "evaluated" && r.direction === "SHORT", "SHORT mirror → evaluated SHORT");
}

// 3 NEUTRAL remains EvaluatedMarket
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1, minimumScore: 90 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const r = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
  ok(r.status === "evaluated" && r.direction === "NEUTRAL", "NEUTRAL остаётся evaluated (не skipped)");
}

// 4 CANNOT_EVALUATE → Skipped cannot-evaluate
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const short = flats(0, 2);
  const r = evaluateSmartMoneyWithCandles(meta, short, cfg);
  ok(r.status === "cannot-evaluate", "CANNOT_EVALUATE → Skipped cannot-evaluate");
}

// 5 hard failure reasons present
{
  const cfg = defaultSmcScoringConfig("1h");
  const short = flats(0, 2);
  // need enough for SWING but not? For default S=20 need 84, we have 3 → INSUFFICIENT_HISTORY
  const asOf = new Date(short[short.length - 1].openTime.getTime() + HOUR);
  const ev = evaluateSmc(short, cfg, asOf);
  ok(!ev.availability.evaluable && ev.availability.hardFailures.some((f) => f.code === "INSUFFICIENT_HISTORY"), "hard failure reason INSUFFICIENT_HISTORY");
}

// 6 9 SMC reasons preserved
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const r = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
  if (r.status === "evaluated") {
    ok(r.reasons.length === 9 || r.reasons.length === 10, "9 SMC reasons preserved (9 + optional conflict)");
    ok(r.reasons.some((x) => x.label.includes("SWING_TREND")), "reason SWING_TREND preserved");
    ok(r.reasons.some((x) => x.label.includes("RECENT_SWING_BOS")), "reason RECENT_SWING_BOS preserved");
    ok(r.reasons.some((x) => x.label.includes("FVG")), "reason FVG preserved");
  } else ok(false, "9 reasons: expected evaluated");
}

// 7 score invariant
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const ev = evaluateSmc(canonical(), cfg, new Date(canonical()[canonical().length - 1].openTime.getTime() + HOUR));
  const comps = ev.reasons.filter((r) => r.code !== "DIRECTION_CONFLICT");
  const sumL = comps.reduce((s, r) => s + r.longPoints, 0);
  const sumS = comps.reduce((s, r) => s + r.shortPoints, 0);
  ok(sumL === ev.longScore && sumS === ev.shortScore, "score invariant: sum longPoints/shortPoints === scores");
  ok(ev.longScore !== null && ev.longScore >= 0 && ev.longScore <= 100, "scores 0..100");
}

// 8 minimumSignalScore → minimumScore
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
  ok(res.ok && (res as { ok: true; config: SmcScoringConfig }).config.minimumScore === 72, "minimumSignalScore 72 → minimumScore 72");
}

// 9 malformed config
{
  const bad = {
    minimumSignalScore: 72,
    swingLeft: 20,
    // missing many
    weights: { swingStructureBias: 20, recentSwingBos: 15, internalStructure: 10, liquiditySweep: 10, swingOrderBlock: 15, internalOrderBlock: 5, fvg: 10, rangePosition: 10, confluence: 5 },
  };
  const res = validateSmartMoneyConfig(bad as unknown, "1h");
  ok(!res.ok, "malformed config → error");
  const bad2 = {
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
  const res2 = validateSmartMoneyConfig(bad2 as unknown, "1h");
  ok(!res2.ok, "both thresholds → error");
}

// 10 Trend config unchanged
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
  ok(r.ok === true, "Trend config unchanged (valid)");
}

// 11 Trend runtime unchanged (basic scoring still works)
{
  const trendRaw = {
    minimumSignalScore: 70,
    weights: { trend: 30, mediumTrend: 15, rsi: 20, macd: 20, volume: 15 },
    ema: { fast: 20, medium: 50, slow: 200 },
    rsi: { period: 14, longMin: 52, longMax: 72, shortMin: 28, shortMax: 48 },
    macd: { fast: 12, slow: 26, signal: 9 },
    atr: { period: 14, stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4 },
    volume: { period: 20, minimumRatio: 1 },
    execution: { closedCandleOnly: true, cooldownCandles: 3 },
    filters: { minimumQuoteVolume24h: 0, top500Only: false },
  };
  const cfg = validateTrendSuslikConfig(trendRaw);
  if (cfg.ok) {
    const analysis = {
      candleTime: new Date(),
      price: 100,
      rsi14: 60,
      ema20: 101,
      ema50: 99,
      ema200: 90,
      macd: 1,
      macdSignal: 0.5,
      macdHist: 0.5,
      atr14: 1,
      volume: 1e6,
      avgVolume20: 5e5,
      volumeRatio: 2,
    };
    const res = runTrendSuslik(analysis, cfg.config);
    ok(typeof res.longScore === "number" && typeof res.shortScore === "number", "Trend runtime unchanged (runTrendSuslik works)");
  } else ok(false, "Trend runtime: config should be ok");
}

// 12 only CLOSED candle
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const bad = canonical().map((c) => ({ ...c }));
  (bad[0] as SmcRawCandle).closed = false as unknown as boolean;
  const r = evaluateSmartMoneyWithCandles(meta, bad, cfg);
  ok(r.status === "cannot-evaluate", "only CLOSED — не-CLOSED → cannot-evaluate");
}

// 13 insufficient history no fallback
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 20, swingRight: 20, internalLeft: 3, internalRight: 3 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const few = flats(0, 10); // 11 << 84
  const r = evaluateSmartMoneyWithCandles(meta, few, cfg);
  ok(r.status === "cannot-evaluate" && r.reason.includes("INSUFFICIENT_HISTORY"), "insufficient history → cannot-evaluate, no fallback to NEUTRAL");
}

// 14 latest 500 semantics + ASC
{
  const many: SmcRawCandle[] = [];
  for (let i = 0; i < 700; i++) many.push(mk(i, 100 + i * 0.1, 101 + i * 0.1, 102 + i * 0.1, 99 + i * 0.1));
  const mockPrisma = {
    candle: {
      findMany: async (args: unknown) => {
        const o = args as { orderBy: { openTime: string }; take: number };
        if (o.orderBy.openTime !== "desc") throw new Error("must be desc");
        if (o.take !== 500) throw new Error("must be 500");
        const desc = [...many].sort((a, b) => b.openTime.getTime() - a.openTime.getTime());
        return desc.slice(0, 500).map((c) => ({
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
  const loaded = await loadSmartMoneyCandles(mockPrisma as never, 1, "1h");
  ok(loaded.length === 500, "latest 500: loaded 500");
  ok(loaded[0].openTime.getTime() === many[200].openTime.getTime(), "latest 500: oldest of loaded is 200 (newest 500)");
  let asc = true;
  for (let i = 1; i < loaded.length; i++) if (loaded[i].openTime.getTime() <= loaded[i - 1].openTime.getTime()) asc = false;
  ok(asc, "ascending after fetch");
}

// 15 multi-exchange minExchanges=2
{
  const mkEval = (dir: "LONG" | "SHORT" | "NEUTRAL", id: number) => ({
    status: "evaluated" as const,
    exchange: "EX" + id,
    market: "BTCUSDT",
    marketId: id,
    candleTime: new Date(),
    price: 100,
    longScore: dir === "LONG" ? 80 : 10,
    shortScore: dir === "SHORT" ? 80 : 10,
    direction: dir,
    reasons: [],
    warnings: [],
  });
  const r1 = aggregateAssetGroup("BTC", "1h", SMART_MONEY_SLUG, 1, [mkEval("LONG", 1)], 2);
  ok(r1.direction === "NEUTRAL", "multi-exchange: 1 LONG при пороге 2 → NEUTRAL");
  const r2 = aggregateAssetGroup("BTC", "1h", SMART_MONEY_SLUG, 1, [mkEval("LONG", 1), mkEval("LONG", 2)], 2);
  ok(r2.direction === "LONG" && r2.longVotes === 2, "multi-exchange: 2 LONG → LONG");
}

// 16 conflict
{
  const mkEval = (dir: "LONG" | "SHORT", id: number) => ({
    status: "evaluated" as const,
    exchange: "EX" + id,
    market: "BTCUSDT",
    marketId: id,
    candleTime: new Date(),
    price: 100,
    longScore: 80,
    shortScore: 0,
    direction: dir as "LONG" | "SHORT",
    reasons: [],
    warnings: [],
  });
  const r = aggregateAssetGroup(
    "BTC",
    "1h",
    SMART_MONEY_SLUG,
    1,
    [mkEval("LONG", 1), mkEval("LONG", 2), mkEval("SHORT", 3), mkEval("SHORT", 4)],
    2
  );
  ok(r.conflict && r.direction === "NEUTRAL", "conflict: LONG 2 + SHORT 2 → NEUTRAL conflict");
}

// 17 NEUTRAL does not vote
{
  const mkEval = (dir: "LONG" | "SHORT" | "NEUTRAL", id: number) => ({
    status: "evaluated" as const,
    exchange: "EX" + id,
    market: "BTCUSDT",
    marketId: id,
    candleTime: new Date(),
    price: 100,
    longScore: 10,
    shortScore: 10,
    direction: dir,
    reasons: [],
    warnings: [],
  });
  const r = aggregateAssetGroup("BTC", "1h", SMART_MONEY_SLUG, 1, [mkEval("NEUTRAL", 1), mkEval("NEUTRAL", 2)], 2);
  ok(r.direction === "NEUTRAL" && r.longVotes === 0 && r.shortVotes === 0 && r.neutralVotes === 2, "NEUTRAL does not vote");
  const r2 = aggregateAssetGroup("BTC", "1h", SMART_MONEY_SLUG, 1, [mkEval("LONG", 1), mkEval("NEUTRAL", 2)], 2);
  ok(r2.longVotes === 1 && r2.direction === "NEUTRAL", "NEUTRAL не считается за LONG");
}

// 18 deterministic result
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const meta = { exchange: "BINANCE", market: "BTCUSDT", marketId: 1, timeframe: "1h" as SmcTimeframe, assetRank: 1, quoteVolume24h: 1e9 };
  const a = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
  const b = evaluateSmartMoneyWithCandles(meta, canonical(), cfg);
  ok(JSON.stringify(a) === JSON.stringify(b), "deterministic result");
}

// 19 no lookahead
{
  const cfg: SmcScoringConfig = { ...defaultSmcScoringConfig("1h"), swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };
  const full = [...canonical(), ...flats(27, 35)];
  const asOf = T0 + (18 + 1) * HOUR;
  const prefix = full.slice(0, 19);
  const eFull = evaluateSmc(full, cfg, new Date(asOf));
  const ePref = evaluateSmc(prefix, cfg, new Date(asOf));
  ok(JSON.stringify(eFull) === JSON.stringify(ePref), "no lookahead: full vs prefix");
}

// 20 CLI self-test existence
{
  const txt = readFileSync("scripts/smart-money-readonly.ts", "utf-8");
  ok(txt.includes("--self-test") && txt.includes("--symbol") && txt.includes("--market-id"), "CLI self-test + symbol/market-id exists");
  ok(!txt.includes("prisma.signal.create"), "CLI no Signal writes");
}

// 21 no Signal imports/writes in adapter
{
  const txt = readFileSync("lib/strategies/smart-money.ts", "utf-8");
  ok(!txt.includes("prisma.signal"), "no Signal writes in smart-money adapter");
  ok(!txt.includes("lib/signals") && !txt.includes("signal-worker"), "no Signal Engine imports");
}

// 22 no Prisma schema/migration side effect (just check file not touched — we already didn't modify schema.prisma in commit)
// We test that schema still has Strategy and Signal but no new model
{
  const schema = readFileSync("prisma/schema.prisma", "utf-8");
  ok(!schema.includes("model SmartMoney"), "no Prisma schema change");
  ok(schema.includes("model Strategy") && schema.includes("model Signal"), "schema still has Strategy/Signal");
  ok(!schema.includes("model Smc"), "no SM model added");
}

// 23 CLI parser — обе формы, защита от поглощения, валидация (реальные проверки, не txt.includes)
{
  const p1 = parseSmartMoneyArgs(["--symbol", "BTC", "--timeframe", "1h"]);
  ok(
    p1.args.symbol === "BTC" && p1.args.timeframe === "1h" && p1.errors.length === 0,
    "parser: --symbol BTC --timeframe 1h"
  );
  const p2 = parseSmartMoneyArgs(["--symbol=BTC", "--timeframe=1h"]);
  ok(
    p2.args.symbol === "BTC" && p2.args.timeframe === "1h" && p2.errors.length === 0,
    "parser: --symbol=BTC --timeframe=1h"
  );
  const p3 = parseSmartMoneyArgs(["--market-id", "123"]);
  ok(p3.args.marketId === 123 && p3.errors.length === 0, "parser: --market-id 123");
  const p4 = parseSmartMoneyArgs(["--market-id=123"]);
  ok(p4.args.marketId === 123 && p4.errors.length === 0, "parser: --market-id=123");
  const p4b = parseSmartMoneyArgs(["--marketId", "456"]);
  ok(p4b.args.marketId === 456 && p4b.errors.length === 0, "parser: --marketId 456 legacy alias spaced");
  const p4c = parseSmartMoneyArgs(["--marketId=789"]);
  ok(p4c.args.marketId === 789 && p4c.errors.length === 0, "parser: --marketId=789 legacy alias =");
}

{
  const p5 = parseSmartMoneyArgs(["--symbol", "--timeframe", "1h"]);
  ok(
    p5.errors.length > 0 && p5.errors[0].includes("--symbol"),
    "parser: --symbol --timeframe не поглощает флаг"
  );
  const p6 = parseSmartMoneyArgs(["--market-id", "--self-test"]);
  ok(
    p6.errors.length > 0 && p6.errors[0].includes("--market-id"),
    "parser: --market-id --self-test не поглощает флаг"
  );
}

{
  const p7 = parseSmartMoneyArgs(["--symbol", "BTC", "--market-id", "123"]);
  ok(
    validateCliArgs(p7) !== null &&
      (validateCliArgs(p7) as string).includes("ровно один"),
    "parser: оба --symbol и --market-id → ошибка"
  );
  const p8 = parseSmartMoneyArgs(["--timeframe", "1h"]);
  ok(validateCliArgs(p8) !== null, "parser: ни symbol ни market-id → ошибка");
}

{
  const p9 = parseSmartMoneyArgs(["--market-id", "abc"]);
  ok(p9.errors.length > 0, "parser: malformed --market-id abc → ошибка");
  const p9b = parseSmartMoneyArgs(["--market-id="]);
  ok(p9b.errors.length > 0, "parser: --market-id= пусто → ошибка");
  const p9c = parseSmartMoneyArgs(["--market-id", "12.5"]);
  ok(p9c.errors.length > 0, "parser: --market-id 12.5 не целое → ошибка");
  const p9d = parseSmartMoneyArgs(["--market-id", "-5"]);
  ok(p9d.errors.length > 0, "parser: --market-id -5 отрицательное → ошибка");
}

{
  const p10 = parseSmartMoneyArgs(["--symbol", "BTC"]);
  ok(p10.args.timeframe === "1h" && p10.errors.length === 0, "parser: default timeframe остаётся 1h");
  const p11 = parseSmartMoneyArgs(["--symbol", "BTC", "--timeframe", "4h"]);
  ok(p11.args.timeframe === "4h", "parser: --timeframe 4h spaced");
  const p12 = parseSmartMoneyArgs(["--symbol=BTC", "--timeframe", "1h"]);
  ok(
    p12.args.symbol === "BTC" && p12.args.timeframe === "1h",
    "parser: смешанная форма --symbol=BTC + --timeframe 1h"
  );
}


// 24 pure parser module is side-effect-free: import does not launch CLI/DB
{
  const pure = readFileSync("scripts/smart-money-cli-args.ts", "utf-8");
  ok(!pure.includes("PrismaClient") && !pure.includes("prisma.") && !pure.includes("$disconnect"), "pure parser: no Prisma/DB imports");
  ok(!pure.includes("process.exit") && !pure.includes("process.argv"), "pure parser: no process.exit / argv side effect (кроме параметра функции)");
  // The pure module exports parseSmartMoneyArgs/validateCliArgs and is importable without DB
  ok(pure.includes("export function parseSmartMoneyArgs") && pure.includes("export function validateCliArgs"), "pure parser: exports parseSmartMoneyArgs + validateCliArgs");
  // Importing pure module did not trigger CLI main (this file itself imported it and still ran — if it had side effect we'd have exited)
  ok(typeof parseSmartMoneyArgs === "function" && typeof validateCliArgs === "function", "pure parser: import does not launch CLI (functions available)");
  // CLI теперь импортирует из pure модуля и не экспортирует парсер (или по крайней мере не содержит мёртвого кода getArg/hasFlag/includes guard)
  const cliTxt = readFileSync("scripts/smart-money-readonly.ts", "utf-8");
  ok(cliTxt.includes('from "./smart-money-cli-args"'), "CLI imports parser from pure module");
  ok(!cliTxt.includes("function getArg") && !cliTxt.includes("function hasFlag") && !cliTxt.includes("function parseArgs()"), "dead getArg/hasFlag/parseArgs удалены из CLI");
  ok(!cliTxt.includes('includes("smart-money-readonly")') && !cliTxt.includes("includes('smart-money-readonly')"), "fragile substring guard удалён из CLI");
  // Pure module itself is not importing CLI (no circular)
  ok(!pure.includes("smart-money-readonly"), "pure parser не импортирует CLI (нет цикла)");
}

{
  const txt = readFileSync("scripts/smart-money-readonly.ts", "utf-8");
  ok(
    txt.includes("--symbol BTC") && txt.includes("--symbol=BTC"),
    "help показывает обе формы --symbol BTC и --symbol=BTC"
  );
  ok(
    txt.includes("--market-id 123") && txt.includes("--market-id=123"),
    "help показывает обе формы --market-id"
  );
}

console.log(`\nИтог: ${passed}/${total}`);
if (passed !== total) {
  console.error(`FAILED ${total - passed} checks`);
  process.exit(1);
}
console.log("Все проверки Phase 3B пройдены.");

}

main().catch((e) => { console.error(e); process.exit(1); });
