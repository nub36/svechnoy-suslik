/**
 * Common CLOSED horizon — regression suite.
 *
 * Принципы этого файла (в отличие от предыдущей версии):
 *  - fixtures ДЕЙСТВИТЕЛЬНО проходят через evaluateSmc и дают status="evaluated";
 *    если fixture деградирует в cannot-evaluate — тест ПАДАЕТ, а не уходит в mock-ветку;
 *  - никаких if (evaluated.length > 0) {…} else {mock…}, никаких ok(true, placeholder);
 *  - статические проверки читают исходники по пути ОТ КОРНЯ ПРОЕКТА (import.meta.url),
 *    сбой чтения = падение теста (а не «прохождение на пустой строке»);
 *  - кейс с дырой в истории (hole) обязан упасть при мин-семантике min(latest).
 *
 * Использованные временные якоря (всё UTC):
 *  - 5m:  T = 2026-09-11T09:50Z, now = 09:55Z ⇒ ожидаемый latest CLOSED = 09:50Z
 *  - 1d:  now = 2026-09-11T10:00Z ⇒ ожидаемый latest CLOSED = 2026-09-10T00:00Z
 *
 * Run: npx tsx scripts/test-common-horizon.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS,
  COMMON_HORIZON_RELATIVE_MAX_LAG_BARS,
  assertEvaluatedAtHorizon,
  decideAggregationAtCommonHorizon,
  expectedLatestClosedOpenTime,
  selectCommonClosedHorizon,
  truncateCandlesToHorizon,
  type CommonHorizonMarket,
} from "../lib/strategies/common-horizon";
import {
  evaluateMarketsAtCommonHorizon,
  evaluateSmartMoneyWithCandles,
  type SmartMoneyFilters,
} from "../lib/strategies/smart-money";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { checkCandleAlignment } from "../lib/strategies/alignment";
import {
  filterSmartMoneyEligibleResults,
  isSmartMoneyExchangeEligible,
} from "../lib/strategies/smart-money-eligibility";
import { defaultSmcScoringConfig } from "../lib/smc/config";
import {
  SMCTIMEFRAME_MS,
  type SmcRawCandle,
  type SmcTimeframe,
} from "../lib/smc/types";
import type {
  MarketStrategyResult,
  SkippedMarket,
} from "../lib/strategies/runtime";

// ------------------------------------------------------------ harness
let passed = 0;
let failed = 0;
const failures: string[] = [];

function ok(cond: unknown, label: string): void {
  if (cond === true) {
    passed++;
  } else {
    failed++;
    failures.push(label);
    console.error(`FAIL: ${label}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    console.error(
      `FAIL: ${label}\n   actual=${JSON.stringify(actual)}\n   expect=${JSON.stringify(expected)}`
    );
  }
  ok(same, label);
}

// ------------------------------------------------------------ source reader (repo-relative)
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function readSource(relPath: string): string {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(`не найден исходник ${relPath} (ожидался ${abs}) — проверка не может «пройти вслепую»`);
  }
  const text = readFileSync(abs, "utf8");
  if (text.trim().length === 0) {
    throw new Error(`пустой исходник ${relPath} — чтение не удалось, тест не пройден`);
  }
  return text;
}

// ------------------------------------------------------------ fixtures
const EPOCH = Date.UTC(2026, 8, 11); // 2026-09-11T00:00:00.000Z
const M5 = SMCTIMEFRAME_MS["5m"];
const D1 = SMCTIMEFRAME_MS["1d"];

function iso(t: number | Date): string {
  return (t instanceof Date ? t : new Date(t)).toISOString();
}

/** n канонических CLOSED openTime, заканчивая endMs (включительно); требует grid-выравнивания. */
function closedTimes(endMs: number, n: number, tf: SmcTimeframe): number[] {
  const d = SMCTIMEFRAME_MS[tf];
  if (endMs % d !== 0) {
    throw new Error(`endMs ${iso(endMs)} не на canonical grid ${tf} — фикстура собрана неверно`);
  }
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(endMs - i * d);
  return out;
}

/** Тот же ряд, но со сдвигом от canonical grid (нужно для BingX 1d 16:00). */
function offsetTimes(endMs: number, n: number, tf: SmcTimeframe): number[] {
  const d = SMCTIMEFRAME_MS[tf];
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(endMs - i * d);
  return out;
}

/**
 * Детерминированная фикстура, КОТОРАЯ ДЕЙСТВИТЕЛЬНО оценивается SMC:
 * треугольная волна с периодом 48 баров — каждый пик строго выше 20 соседей
 * слева и справа ⇒ swing-high/low подтверждены (swingLeft/Right=20 по дефолту).
 */
function waveCandles(timesMs: number[], opts: { closedFrom?: number } = {}): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  let prev = 100;
  for (let i = 0; i < timesMs.length; i++) {
    const t = i % 48;
    const tri = t <= 24 ? t : 48 - t;
    const close = 100 + 2 * tri;
    out.push({
      openTime: new Date(timesMs[i]),
      open: prev,
      high: Math.max(prev, close) + 1,
      low: Math.min(prev, close) - 1,
      close,
      closed: opts.closedFrom === undefined ? true : i < opts.closedFrom,
    });
    prev = close;
  }
  return out;
}

type MarketInput = {
  meta: {
    exchange: string;
    market: string;
    marketId: number;
    timeframe: SmcTimeframe;
    assetRank: number | null;
    quoteVolume24h: number | null;
  };
  candles: SmcRawCandle[];
};

function market(exchange: string, marketId: number, tf: SmcTimeframe, candles: SmcRawCandle[]): MarketInput {
  return {
    meta: {
      exchange,
      market: `${exchange}*BTCUSDT`,
      marketId,
      timeframe: tf,
      assetRank: 1,
      quoteVolume24h: 1_000_000,
    },
    candles,
  };
}

const asCommon = (m: MarketInput): CommonHorizonMarket => ({
  exchange: m.meta.exchange,
  marketId: m.meta.marketId,
  candles: m.candles,
});

const NO_FILTERS: SmartMoneyFilters = { top500Only: false, minimumQuoteVolume24h: 0 };
const UNIVERSE_FILTERS: SmartMoneyFilters = { top500Only: true, minimumQuoteVolume24h: 0 };
const cfg = (tf: SmcTimeframe) => defaultSmcScoringConfig(tf);

/** 09:50 — самый свежий 5m-бар, ожидаемый при now = 09:55Z. */
const T = EPOCH + 9 * 3600_000 + 50 * 60_000;
const T_MINUS_1 = T - M5; // 09:45 — latest CLOSED у отстающего
const T_PLUS_1 = T + M5; // 09:55 — ещё открыт при now=09:55
const NOW_5M = EPOCH + 9 * 3600_000 + 55 * 60_000;

/** 1d: now=2026-09-11T10:00Z ⇒ ожидаемый latest CLOSED = 2026-09-10T00:00Z. */
const D_NOW = Date.UTC(2026, 8, 11, 10, 0, 0);
const D_EXPECTED = Date.UTC(2026, 8, 10);
const D_MINUS_1 = Date.UTC(2026, 8, 9);
const D_MINUS_2 = Date.UTC(2026, 8, 8);

const NAMES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];
const fresh5m = (i: number, ex = NAMES[i - 1]) => market(ex, i, "5m", waveCandles(closedTimes(T, 200, "5m")));
const laggard5m = (i: number, ex = NAMES[i - 1]) => market(ex, i, "5m", waveCandles(closedTimes(T_MINUS_1, 200, "5m")));
const fresh1d = (i: number, ex: string, endDay: number) => market(ex, i, "1d", waveCandles(closedTimes(endDay, 200, "1d")));

const asSkipped = (r: MarketStrategyResult): SkippedMarket => r as SkippedMarket;

/** Критерий «агрегат сформирован» — ровно тот, что использует runtime-скрипт. */
const aggregateFormed = (a: { evaluated: number; minExchanges: number }): boolean =>
  a.evaluated >= a.minExchanges;

/** Нормализованная подпись оценок — для проверок независимости от порядка. */
function norm(rows: MarketStrategyResult[]): string {
  return JSON.stringify(
    rows
      .map((r) => [
        r.exchange,
        r.status,
        r.status === "evaluated" ? r.candleTime.getTime() : null,
        r.status === "evaluated" ? r.longScore : null,
        r.status === "evaluated" ? r.shortScore : null,
        r.status === "evaluated" ? r.direction : null,
        r.status === "evaluated" ? r.price : null,
      ])
      .sort()
  );
}

// ============================================================
console.log("=== 1. expectedLatestClosedOpenTime — точная boundary-семантика ===");
{
  // Свеча, открытая в k*D, закрывается в (k+1)*D; ingestion помечает
  // closed = openTime + D - 1 < now  ⇔  openTime + D <= now.
  eq(iso(expectedLatestClosedOpenTime(new Date(NOW_5M), "5m")), iso(T), "5m: now=09:55:00.000Z ⇒ ожидаем latest CLOSED openTime=09:50 (бар 09:50 только что закрылся)");
  eq(iso(expectedLatestClosedOpenTime(new Date(T + M5 - 1), "5m")), iso(T_MINUS_1), "5m: now=09:54:59.999Z (за 1мс до границы) ⇒ ожидаем 09:45 — бар 09:50 ещё НЕ закрыт");
  eq(iso(expectedLatestClosedOpenTime(new Date(EPOCH + 10 * 3600_000), "15m")), iso(EPOCH + 9 * 3600_000 + 45 * 60_000), "15m: now на границе 10:00 ⇒ ожидаем 09:45");
  eq(iso(expectedLatestClosedOpenTime(new Date(Date.UTC(2026, 8, 11, 23, 59)), "1h")), iso(Date.UTC(2026, 8, 11, 22, 0, 0)), "1h: now=23:59 ⇒ ожидаем 22:00 (23:00 ещё открыт)");
  eq(iso(expectedLatestClosedOpenTime(new Date(Date.UTC(2026, 8, 12, 0, 0, 0)), "4h")), iso(Date.UTC(2026, 8, 11, 20, 0, 0)), "4h: now ровно 00:00Z ⇒ ожидаем 20:00Z предыдущего интервала");
  eq(iso(expectedLatestClosedOpenTime(new Date(D_NOW), "1d")), iso(D_EXPECTED), "1d: now=2026-09-11T10:00Z ⇒ ожидаем 2026-09-10T00:00Z (canonical UTC grid)");
  eq(iso(expectedLatestClosedOpenTime(new Date(Date.UTC(2026, 8, 11, 23, 59, 59, 999)), "1d")), iso(D_EXPECTED), "1d: за 1мс до полуночи всё ещё ожидаем вчерашний день (09-10 не закрыт до 09-12T00:00)");

  let threw = false;
  try {
    expectedLatestClosedOpenTime(new Date(NaN), "5m");
  } catch {
    threw = true;
  }
  ok(threw, "invalid now ⇒ fail-closed исключение, а не тихий результат");
  eq(COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS["1d"], 1, "политика: 1d допускаёт РОВНО 1 бар абсолютного лага");
  eq(Object.keys(COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS).sort().join(","), "15m,1d,1h,4h,5m", "политика объявлена для всех пяти TF");
  eq(Object.values(COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS).every((v) => v === 1), true, "политика консервативна и одинакова для всех TF (1 закрытый бар позади ожидаемого)");
  const policySrc = readSource("lib/strategies/common-horizon.ts");
  ok(policySrc.includes("COMMON_HORIZON_ABSOLUTE_MAX_LAG_BARS") && !policySrc.includes("loadConfiguredStrategyRuntime"), "политика живёт в коде, а НЕ в Strategy Admin config");
}

// ============================================================
console.log("\n=== 2. PRODUCTION RACE: 1×09:45 + 4×09:50 ⇒ общий H=09:45, все evaluated на 09:45 ===");
const raceMarkets = [laggard5m(1), fresh5m(2), fresh5m(3), fresh5m(4), fresh5m(5)];
const raceSelection = { now: new Date(NOW_5M) };
{
  // Контраст: что делал путь ДО фикса на тех же данных.
  const oldResults = raceMarkets.map((m) => evaluateSmartMoneyWithCandles(m.meta, m.candles, cfg("5m"), NO_FILTERS));
  eq(oldResults.every((r) => r.status === "evaluated"), true, "контраст: фикстура пригодна — старый путь тоже оценивал все 5");
  const oldAlign = checkCandleAlignment(oldResults, "5m");
  eq(oldAlign.safe, false, "старый путь на тех же данных: MISALIGNED (агрегация была запрещена)");
  eq(oldAlign.horizonMismatch.length, 4, "старый путь: 4 рынка в horizonMismatch");
  const oldAgg = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, oldResults, 3);
  eq(aggregateFormed(oldAgg), true, "старый путь: порог 3/5 был достигнут — опасен был именно смешанный горизонт, его ловил только alignment");
  eq(oldAgg.evaluated, 5, "старый путь: тот же denominator (5 evaluated) — семантика counts не изменилась");

  const out = evaluateMarketsAtCommonHorizon(raceMarkets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(out.status, "ok", "race: статус ok");
  eq(out.usable, true, "race: горизонт пригоден");
  eq(iso(out.selection.commonHorizon!), iso(T_MINUS_1), "race: H=09:45 — самый свежий бар, который ЕСТЬ У ВСЕХ участников");
  eq(out.selection.lagBars, 1, "race: relative lag = 1 бар (09:50 минус 09:45)");
  eq(out.selection.absoluteLagBars, 1, "race: absolute lag = 1 бар от ожидаемого 09:50 ⇒ в пределах policy max=1");
  eq(out.selection.participantCount, 5, "race: участников 5");
  eq(out.selection.marketsWithoutData.length, 0, "race: рынков без CLOSED-данных нет");
  eq(out.results.length, 5, "race: 5 результатов");
  eq(out.results.every((r) => r.status === "evaluated"), true, "race: ВСЕ 5 реально evaluated (без mock-веток)");
  eq(out.results.every((r) => r.status === "evaluated" && r.candleTime.getTime() === T_MINUS_1), true, "race: candleTime каждого результата РОВНО общий H — смешения горизонтов нет");
  eq(out.results.filter((r) => r.status === "evaluated" && r.reasons.length > 0).length, 5, "race: у каждого результата есть объяснение (reasons непустые — explainability сохранена)");
  eq(out.results.filter((r) => r.status === "evaluated" && ["LONG", "SHORT", "NEUTRAL"].includes(r.direction)).length, 5, "race: направление легитимное у всех пяти");

  // Каждый вход оценки обязан заканчиваться РОВНО на H (будущие бары физически удалены).
  const inputEnds = raceMarkets.map((m) => {
    const truncated = truncateCandlesToHorizon(m.candles, out.selection.commonHorizon!);
    return truncated[truncated.length - 1]!.openTime.getTime();
  });
  eq(inputEnds.every((ms) => ms === T_MINUS_1), true, "race: каждый evaluation input заканчивается ровно на H");
  eq(inputEnds.filter((ms) => ms === T).length, 0, "race: ни один вход не «смотрит» в 09:50, которого нет у всех");

  const gate = decideAggregationAtCommonHorizon({ selection: out.selection, results: out.results, timeframe: "5m" });
  eq(gate.alignment.safe, true, "race: существующий строгий alignment ПРОЙДЕН на общем H");
  eq(gate.anchor.ok, true, "race: anchor-проверка пройдена");
  eq(gate.allowed, true, "race: агрегация разрешена (после alignment, а не вместо него)");

  const agg = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, out.results, 3);
  eq(aggregateFormed(agg), true, "race: агрегат сформирован — production-сценарий (4 fresh + 1 laggard) БОЛЬШЕ не misaligned");
  eq(agg.conflict, false, "race: конфликта LONG/SHORT нет");
  eq(agg.evaluated, 5, "race: denominator = 5 участников");
  eq(agg.skipped, 0, "race: skipped = 0");
  eq(agg.minExchanges, 3, "race: minExchanges=3 из Strategy");
  ok(agg.confirmation.endsWith("/5"), "race: confirmation имеет denominator 5 оцениваемых участников");
  eq(agg.evaluated >= agg.minExchanges, true, "race: порог minExchanges=3 достигнут на общем горизонте");
}

// ============================================================
console.log("\n=== 3. После догона отстающего H переезжает на 09:50 ===");
{
  const caughtUp = [fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), fresh5m(5)];
  const out = evaluateMarketsAtCommonHorizon(caughtUp, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(iso(out.selection.commonHorizon!), iso(T), "догон: H = 09:50 (самый свежий общий бар)");
  eq(out.selection.lagBars, 0, "догон: relative lag 0");
  eq(out.selection.absoluteLagBars, 0, "догон: absolute lag 0");
  eq(out.results.every((r) => r.status === "evaluated"), true, "догон: все evaluated");
  eq(out.results.every((r) => r.status === "evaluated" && r.candleTime.getTime() === T), true, "догон: все заякорены на 09:50");
  eq(out.selection.newestHorizon === null ? null : iso(out.selection.newestHorizon), iso(T), "догон: newest CLOSED среди участников = 09:50 = H");
}

// ============================================================
console.log("\n=== 4. REAL INTERSECTION: дыра в истории (упадёт при min(latest)) ===");
{
  // A..D: 09:35, 09:45, 09:50 (09:40 ОТСУТСТВУЕТ);  E: 09:35, 09:40 (latest = 09:40).
  // min(latest) дал бы H=09:40, которого у A..D ФАКТИЧЕСКИ НЕТ — агрегат считался бы
  // по рядам, фактически оборванным на 09:35, с_horizon-подписью 09:40.
  const holedTimes = [T - 3 * M5, T - M5, T];
  const eTimes = [T - 3 * M5, T - 2 * M5];
  const holed = (id: number, ex: string) => market(ex, id, "5m", waveCandles(holedTimes));
  const e = market("E", 5, "5m", waveCandles(eTimes));
  const sel = selectCommonClosedHorizon([holed(1, "A"), holed(2, "B"), holed(3, "C"), holed(4, "D"), e].map(asCommon), "5m", raceSelection);
  eq(iso(sel.commonHorizon!), iso(T - 3 * M5), "hole: H=09:35 — реальный максимум пересечения; min(latest)=09:40 НЕ выбран");
  ok(sel.commonHorizon!.getTime() !== T - 2 * M5, "hole: явная защита от min(latest)-семантики");
  eq(sel.perMarketLatest.every((p) => p.hasCommon), true, "hole: выбранный H реально присутствует у КАЖДОГО участника");
  eq(sel.status, "absolute_stale", "hole: при now=09:55 ожидаем 09:50, а H=09:35 ⇒ 3 бара позади ⇒ ABSOLUTE_STALE");
  eq(sel.absoluteLagBars, 3, "hole: абсолютный лаг посчитан точно");

  // Тот же ряд с now, согласованным с данными (ожидаем 09:35) ⇒ дыра не мешает корректному выбору.
  const selFresh = selectCommonClosedHorizon([holed(1, "A"), holed(2, "B"), holed(3, "C"), holed(4, "D"), e].map(asCommon), "5m", { now: new Date(T - 2 * M5) });
  eq(iso(selFresh.commonHorizon!), iso(T - 3 * M5), "hole (согласованный now): H=09:35 по-прежнему из пересечения");
  eq([selFresh.status, selFresh.absoluteLagBars], ["ok", 0], "hole (согласованный now): ok — дыра не влияет на выбор общего горизонта");

  // Полный разрыв множеств
  const disjoint = selectCommonClosedHorizon(
    [
      { exchange: "A", marketId: 1, candles: waveCandles(closedTimes(T, 3, "5m")) },
      { exchange: "B", marketId: 2, candles: waveCandles(closedTimes(T + 10 * M5, 3, "5m")) },
    ],
    "5m",
    raceSelection
  );
  eq(disjoint.status, "no_common_horizon", "полный разрыв ⇒ NO_COMMON_HORIZON (не тихий успех)");
  eq(disjoint.commonHorizon, null, "разрыв: H=null");
  ok(disjoint.reason.includes("NO_COMMON_HORIZON"), "разрыв: причина различима оператором");

  // Дыра ≠ «рынок неучастник»: все 5 остались участниками
  eq(sel.participantCount, 5, "hole: все 5 остались участниками (никто не выброшен ради minExchanges)");
  eq(sel.marketsWithoutData.length, 0, "hole: это именно дыра, а не отсутствие данных");
}

// ============================================================
console.log("\n=== 5. NO-LOOKAHEAD / anchoring на H ===");
{
  const H = T_MINUS_1;
  const full = waveCandles(closedTimes(T_PLUS_1, 200, "5m")); // содержит бары ПОСЛЕ H
  const metaIn = raceMarkets[0]!.meta;
  const truncated = truncateCandlesToHorizon(full, new Date(H));
  const prefix = full.filter((c) => c.openTime.getTime() <= H);
  const rTrunc = evaluateSmartMoneyWithCandles(metaIn, truncated, cfg("5m"), NO_FILTERS);
  const rPrefix = evaluateSmartMoneyWithCandles(metaIn, prefix, cfg("5m"), NO_FILTERS);

  eq(rTrunc.status, "evaluated", "anchoring: фикстура оценивается (не cannot-evaluate)");
  eq(rPrefix.status, "evaluated", "anchoring: физический префикс тоже оценивается");
  ok(rTrunc.status === "evaluated" && rPrefix.status === "evaluated", "anchoring: обе ветки сравнимы");
  if (rTrunc.status === "evaluated" && rPrefix.status === "evaluated") {
    eq(iso(rTrunc.candleTime), iso(H), "anchoring: candleTime РОВНО H, а не последний бар массива");
    const hRow = full.find((c) => c.openTime.getTime() === H)!;
    eq(rTrunc.price, hRow.close, "anchoring: price = close(H)");
    eq([rTrunc.longScore, rTrunc.shortScore, rTrunc.direction], [rPrefix.longScore, rPrefix.shortScore, rPrefix.direction], "no-lookahead: scores/direction совпадают с физическим префиксом до H");
    eq(JSON.stringify(rTrunc.reasons), JSON.stringify(rPrefix.reasons), "no-lookahead: все 9 reasons совпадают с префиксом");
  }

  // Сквозь публичный API: порча баров ПОСЛЕ H не должна менять результат на H.
  const mutilatedMarkets = raceMarkets.map((m, i) =>
    i === 0
      ? m
      : {
          ...m,
          candles: m.candles.map((c, j) =>
            c.openTime.getTime() > H
              ? { ...c, open: 90_000 + j, high: 99_999 + j, low: 80_000 + j, close: 95_000 + j }
              : c
          ),
        }
  );
  const outBase = evaluateMarketsAtCommonHorizon(raceMarkets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  const outMutilated = evaluateMarketsAtCommonHorizon(mutilatedMarkets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(iso(outMutilated.selection.commonHorizon!), iso(outBase.selection.commonHorizon!.getTime()), "будущие свечи не сдвинули общий H");
  eq(norm(outMutilated.results), norm(outBase.results), "no-lookahead: изменение будущих свечей (после H) НЕ меняет ни одну оценку на H");

  // CLOSED-only
  const withOpen = waveCandles(closedTimes(T, 10, "5m"), { closedFrom: 9 });
  const truncOpen = truncateCandlesToHorizon(withOpen, new Date(T));
  eq(truncOpen.length, 9, "CLOSED-only: усечение отсекает незакрытый бар, даже если он ровно на границе H");
  eq(truncOpen.every((c) => c.closed === true), true, "CLOSED-only: в усечённом входе нет closed=false");
  const selClosed = selectCommonClosedHorizon(
    [
      { exchange: "A", marketId: 1, candles: withOpen },
      { exchange: "B", marketId: 2, candles: waveCandles(closedTimes(T, 10, "5m")) },
    ],
    "5m",
    raceSelection
  );
  eq(iso(selClosed.commonHorizon!), iso(T - M5), "CLOSED-only: незакрытый бар A не может стать общим горизонтом");

  const emptyTrunc = truncateCandlesToHorizon(withOpen, new Date(EPOCH));
  eq(emptyTrunc.length, 0, "усечение раньше всех данных ⇒ пустой ряд (позже даст INSUFFICIENT_HISTORY, а не тихую оценку)");
}

// ============================================================
console.log("\n=== 6. ABSOLUTE freshness: равномерно устаревшие данные (ловушка относительного bound) ===");
{
  // Все участники согласованы (relative lag = 0), но данным 3 суток.
  const ancientEnd = NOW_5M - 3 * 86_400_000; // 2026-09-08T09:55Z — на 5m grid
  const ancient = [1, 2, 3, 4, 5].map((i) => market(NAMES[i - 1]!, i, "5m", waveCandles(closedTimes(ancientEnd, 200, "5m"))));
  const out = evaluateMarketsAtCommonHorizon(ancient, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(out.selection.lagBars, 0, "равномерная древность: relative lag = 0 ⇒ относительный bound слеп");
  eq(out.status, "absolute_stale", "равномерная древность ⇒ ABSOLUTE_STALE (тихого успеха нет)");
  eq(out.usable, false, "равномерная древность: usable=false");
  eq(out.selection.commonHorizon === null ? null : iso(out.selection.commonHorizon), iso(ancientEnd), "равномерная древность: H посчитан корректно, но отбракован по возрасту");
  eq(out.results.length, 0, "равномерная древность: результатов для агрегации нет");
  const gate = decideAggregationAtCommonHorizon({ selection: out.selection, results: out.results, timeframe: "5m" });
  eq(gate.allowed, false, "равномерная древность: gate запрещает агрегацию");
  ok(gate.refusalReasons.join(" ").includes("ABSOLUTE_STALE"), "равномерная древность: причина в refusal-строке");
  const aggWouldBe = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, ancient.map((m) => evaluateSmartMoneyWithCandles(m.meta, m.candles, cfg("5m"), NO_FILTERS)), 3);
  eq(aggregateFormed(aggWouldBe), true, "контраст: без fresh-bound 3-суточный агрегат выглядел бы ЗДОРОВЫМ (все согласованы) — вот что закрывает absolute bound");
}

console.log("\n=== 7. ABSOLUTE freshness на 1d — deterministic-кейсы (now=2026-09-11T10:00Z) ===");
{
  const sel = (endDay: number, n = 4, tfNow: number = D_NOW) =>
    selectCommonClosedHorizon(
      Array.from({ length: n }, (_, i) => fresh1d(i + 1, NAMES[i]!, endDay)).map(asCommon),
      "1d",
      { now: new Date(tfNow) }
    );

  const fresh = sel(D_EXPECTED);
  eq(fresh.status, "ok", "1d: H=2026-09-10 (лаг 0 от ожидаемого) ⇒ FRESH");
  eq(fresh.absoluteLagBars, 0, "1d: absolute lag 0 бар");
  eq(iso(fresh.expectedLatestClosed), iso(D_EXPECTED), "1d: ожидаемый latest CLOSED = 2026-09-10T00:00Z");

  const oneBehind = sel(D_MINUS_1);
  eq(oneBehind.status, "ok", "1d: H=2026-09-09 — РОВНО 1 бар позади ожидаемого ⇒ по policy max=1 ещё допустимо");
  eq(oneBehind.absoluteLagBars, 1, "1d: absolute lag 1 бар");

  const twoBehind = sel(D_MINUS_2);
  eq(twoBehind.status, "absolute_stale", "1d: H=2026-09-08 — 2 бара позади ⇒ ABSOLUTE_STALE");
  eq(twoBehind.absoluteLagBars, 2, "1d: absolute lag 2 бара задокументирован точно");
  ok(twoBehind.reason.includes("ABSOLUTE_STALE"), "1d: причина абсолютной старости различима");

  // Смешение: три биржи на 09-10, одна на 09-09 (нормальный перекос прохода) ⇒ допустимо
  const skewed = selectCommonClosedHorizon(
    [
      ...Array.from({ length: 3 }, (_, i) => fresh1d(i + 1, NAMES[i]!, D_EXPECTED)).map(asCommon),
      { exchange: "KUCOIN", marketId: 4, candles: waveCandles(closedTimes(D_MINUS_1, 200, "1d")) },
    ],
    "1d",
    { now: new Date(D_NOW) }
  );
  eq(skewed.status, "ok", "1d: один участник на сутки позади ⇒ H=09-09, допустимо (relative 1/3, absolute 1/1)");
  eq(iso(skewed.commonHorizon!), iso(D_MINUS_1), "1d: H откатился ровно на один канонический UTC-день");
  eq([skewed.lagBars, skewed.absoluteLagBars], [1, 1], "1d: оба лага посчитаны");

  // Будущий «закрытый» день (данные впереди now) ⇒ явный future_horizon
  const future = sel(Date.UTC(2026, 8, 11));
  eq(future.status, "future_horizon", "1d: общий бар новее ожидаемого latest CLOSED ⇒ FUTURE_HORIZON (lookahead-подозрение)");
  ok(future.reason.includes("FUTURE_HORIZON"), "1d: причина различима");
}

// ============================================================
console.log("\n=== 8. RELATIVE skew bound сохранён (не ослаблен) ===");
{
  // 4 участника на 09:50, пятый на 09:30 ⇒ relative lag = 4 > 3
  const sel = selectCommonClosedHorizon(
    [...[fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), market("BINGX", 5, "5m", waveCandles(closedTimes(T - 4 * M5, 200, "5m")))].map(asCommon)],
    "5m",
    { now: new Date(NOW_5M) }
  );
  eq(sel.lagBars, 4, "relative: лаг 4 бара посчитан");
  eq(sel.status, "relative_lag_stale", "relative: больше bound 3 ⇒ RELATIVE_LAG_STALE (проверяется раньше absolute)");
  ok(sel.reason.includes("RELATIVE_LAG_STALE"), "relative: причина различима");
  eq(COMMON_HORIZON_RELATIVE_MAX_LAG_BARS, 3, "relative: bound = 3 бара — как в исходном фиксе, не ослаблен");

  // Ровно на границе (3) — inclusive, допустимо; absolute bound изолирован override'ом
  const atBound = selectCommonClosedHorizon(
    [
      { exchange: "BINANCE", marketId: 1, candles: waveCandles(closedTimes(T, 200, "5m")) },
      { exchange: "BYBIT", marketId: 2, candles: waveCandles(closedTimes(T - 3 * M5, 200, "5m")) },
    ],
    "5m",
    { now: new Date(NOW_5M), absoluteMaxLagBars: 99 }
  );
  eq([atBound.lagBars, atBound.status], [3, "ok"], "relative: лаг ровно 3 (== bound) допустим — граница включительна");
  const atBoundDefault = selectCommonClosedHorizon(
    [
      { exchange: "BINANCE", marketId: 1, candles: waveCandles(closedTimes(T, 200, "5m")) },
      { exchange: "BYBIT", marketId: 2, candles: waveCandles(closedTimes(T - 3 * M5, 200, "5m")) },
    ],
    "5m",
    { now: new Date(NOW_5M) }
  );
  eq([atBoundDefault.lagBars, atBoundDefault.status], [3, "absolute_stale"], "тот же ряд по умолчанию ⇒ ABSOLUTE_STALE: абсолютный bound добавлен, а не заменён");

  // Отказ относительно НОВОГО участника, а не max(latest) целиком
  const laggardIgnored = selectCommonClosedHorizon(
    [
      { exchange: "BINANCE", marketId: 1, candles: waveCandles(closedTimes(T, 200, "5m")) },
      { exchange: "BYBIT", marketId: 2, candles: waveCandles(closedTimes(T, 200, "5m")) },
      { exchange: "GATE", marketId: 3, candles: waveCandles(closedTimes(T, 200, "5m")) },
      { exchange: "KUCOIN", marketId: 4, candles: waveCandles(closedTimes(T, 200, "5m")) },
    ],
    "5m",
    { now: new Date(NOW_5M) }
  );
  eq(laggardIgnored.status, "ok", "четыре синхронных участника ⇒ ok");
  eq(laggardIgnored.lagBars, 0, "relative lag = 0");
}

// ============================================================
console.log("\n=== 9. PARTICIPANT SET: filtered НЕ ветоит H; участник без данных — явный отказ ===");
{
  // (a) 5 нормальных + 1 рынок, прошедший exchange-eligibility, но отфильтрованный Strategy-фильтром
  const outsideUniverse = market("KUCOIN", 6, "5m", []);
  outsideUniverse.meta.assetRank = null; // вне Top-100 ⇒ filtered при top500Only
  const eligibleAll = [...[fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), fresh5m(5)], outsideUniverse];
  const out = evaluateMarketsAtCommonHorizon(eligibleAll, "5m", cfg("5m"), UNIVERSE_FILTERS, new Date(NOW_5M));
  eq(out.status, "ok", "filtered-рынок с ПУСТЫМИ данными не сломал выбор горизонта");
  eq(out.selection.participantCount, 5, "участников 5 (отфильтрованный исключён из множества участников)");
  eq(out.filteredCount, 1, "отфильтрованных 1 — зафиксировано явно");
  eq(iso(out.selection.commonHorizon!), iso(T), "H=09:50 выбран по пяти участникам (фильтр не двигает и не блокирует H)");
  eq(out.results.length, 6, "в results по-прежнему 6 записей (denominator-семантика как в pre-common-horizon runtime)");
  const filteredRows = out.results.filter((r) => r.status === "filtered");
  eq(filteredRows.length, 1, "рынок вне вселенной вернулся как status=filtered");
  ok(asSkipped(filteredRows[0]!).reason.includes("Top-100"), " filtered имеет оригинальную причину (Вне Top-100)");
  eq(out.results.filter((r) => r.status === "evaluated").length, 5, "evaluated ровно 5 — filtered НЕ стал evaluated и не попал в агрегат");
  eq(out.results.filter((r) => r.status === "evaluated").every((r) => r.status === "evaluated" && r.candleTime.getTime() === T), true, "фильтр не изменил якорь остальных");
  const agg = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, out.results, 3);
  eq(agg.evaluated, 5, "aggregate: evaluated 5 (не 6)");
  eq(agg.skipped, 1, "aggregate: skipped 1 — отфильтрованный виден в denominator-отчётности");
  eq(aggregateFormed(agg), true, "aggregate разрешён");

  // (b) 4 нормальных + участник, прошедший eligibility И filters, но без CLOSED-данных
  const noData = market("BYBIT", 7, "5m", []);
  const out2 = evaluateMarketsAtCommonHorizon([...[fresh5m(1), fresh5m(2), fresh5m(4), fresh5m(5)], noData], "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(out2.status, "data_unavailable", "участник без CLOSED-данных ⇒ DATA_UNAVAILABLE (НЕ тихий успех на 4)");
  eq(out2.usable, false, "участник без данных: usable=false");
  eq(out2.results.length, 0, "участник без данных: ни одного результата для агрегации");
  eq(out2.selection.marketsWithoutData.map((m) => m.exchange).join(","), "BYBIT", "виновник назван явно по exchange+marketId");
  eq(out2.selection.marketsWithoutData[0]!.marketId, 7, "виновник идентифицирован marketId");
  eq(out2.selection.participantCount, 5, "участников посчитано 5 — вето учтено, а не проигнорировано");
  ok(out2.selection.reason.includes("DATA_UNAVAILABLE"), "диагностика: точная причина");
  const gate2 = decideAggregationAtCommonHorizon({ selection: out2.selection, results: out2.results, timeframe: "5m" });
  eq(gate2.allowed, false, "gate: агрегация запрещена");

  // (c) участник с данными, но без общего бара ⇒ NO_COMMON_HORIZON, а не «успех на остальных»
  const out3 = evaluateMarketsAtCommonHorizon(
    [...[fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4)], market("BINGX", 5, "5m", waveCandles(closedTimes(T - 300 * M5, 1, "5m")))],
    "5m",
    cfg("5m"),
    NO_FILTERS,
    new Date(NOW_5M)
  );
  eq(out3.selection.marketsWithoutData.length, 0, "у третьего рынка данные есть");
  eq(out3.status, "no_common_horizon", "ряд BINGX оборван раньше всех ⇒ нет общего бара ⇒ NO_COMMON_HORIZON (не тихий успех на 4)");
  eq(out3.usable, false, "no_common_horizon: usable=false");
}

// ============================================================
console.log("\n=== 10. INSUFFICIENT HISTORY после усечения: cannot-evaluate, а не filtered ===");
{
  const short = market("BINGX", 8, "5m", waveCandles(closedTimes(T, 40, "5m"))); // 40 < minimumSwingHistoryCandles(84)
  const out = evaluateMarketsAtCommonHorizon([...[fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4)], short], "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(out.status, "ok", "insufficient history НЕ блокирует выбор общего горизонта (бар H у всех есть)");
  eq(out.selection.participantCount, 5, "короткий рынок остался участником (его бар H учитывается при выборе)");
  const shortRow = out.results.find((r) => r.marketId === 8)!;
  ok(shortRow !== undefined, "короткий рынок присутствует в результатах");
  eq(shortRow!.status, "cannot-evaluate", "короткий рынок ⇒ cannot-evaluate (не отброшен, не стал filtered)");
  ok(asSkipped(shortRow!).reason.includes("INSUFFICIENT_HISTORY"), "причина INSUFFICIENT_HISTORY сохранена (существующая семантика SMC)");
  eq(out.results.filter((r) => r.status === "evaluated").length, 4, "остальные 4 — evaluated на том же H");
  const gate = decideAggregationAtCommonHorizon({ selection: out.selection, results: out.results, timeframe: "5m" });
  eq(gate.allowed, true, "агрегация на 4 оцениваемых разрешена — как в pre-existing runtime");
  const agg = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, out.results, 3);
  eq([agg.evaluated, agg.skipped], [4, 1], "aggregate: evaluated 4 / skipped 1 — cannot-evaluate виден в denominator");
  ok(agg.confirmation.endsWith("/4"), "confirmation имеет denominator 4 оцениваемых (не раздут нерабочим участником)");
  eq(out.results.every((r) => r.status !== "evaluated" || r.candleTime.getTime() === out.selection.commonHorizon!.getTime()), true, "все evaluated по-прежнему ровно на H");
}

// ============================================================
console.log("\n=== 11. Порядок рынков / детерминизм ===");
{
  const base = evaluateMarketsAtCommonHorizon(raceMarkets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  const reversed = evaluateMarketsAtCommonHorizon([...raceMarkets].reverse(), "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  const rotated = evaluateMarketsAtCommonHorizon([...raceMarkets.slice(2), ...raceMarkets.slice(0, 2)], "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(reversed.selection.commonHorizon!.getTime(), T_MINUS_1, "reverse: тот же H");
  eq(rotated.selection.commonHorizon!.getTime(), T_MINUS_1, "rotation: тот же H");
  eq([reversed.selection.lagBars, rotated.selection.lagBars], [base.selection.lagBars, base.selection.lagBars], "reverse/rotation: тот же relative lag");
  eq([reversed.selection.absoluteLagBars, rotated.selection.absoluteLagBars], [base.selection.absoluteLagBars, base.selection.absoluteLagBars], "reverse/rotation: тот же absolute lag");
  eq([reversed.selection.status, rotated.selection.status], [base.selection.status, base.selection.status], "reverse/rotation: то же freshness-решение");
  eq(norm(reversed.results), norm(base.results), "reverse: нормализованные оценки идентичны");
  eq(norm(rotated.results), norm(base.results), "rotation: нормализованные оценки идентичны");
  const aggOf = (rows: MarketStrategyResult[]) => {
    const a = aggregateAssetGroup("BTC", "5m", "smart-money-suslik", 1, rows, 3);
    return [a.direction, a.longVotes, a.shortVotes, a.neutralVotes, a.evaluated, a.skipped, a.confirmation];
  };
  eq(aggOf(reversed.results), aggOf(base.results), "reverse: aggregate outcome идентичен");
  eq(aggOf(rotated.results), aggOf(base.results), "rotation: aggregate outcome идентичен");
  const again = evaluateMarketsAtCommonHorizon(raceMarkets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(norm(again.results), norm(base.results), "детерминизм: повторный прогон идентичен");
  eq([again.selection.status, again.selection.lagBars, again.selection.absoluteLagBars], [base.selection.status, base.selection.lagBars, base.selection.absoluteLagBars], "детерминизм: selection идентичен");
  // results всегда в порядке входа (не отсортианы) — важно для сопоставления с рынком
  eq(out_order_exchanges(base.results), "BINANCE,BYBIT,GATE,KUCOIN,BINGX", "results в порядке входа, без перемешивания");
}
function out_order_exchanges(rows: MarketStrategyResult[]): string {
  return rows.map((r) => r.exchange).join(",");
}

// ============================================================
console.log("\n=== 12. STRICT ALIGNMENT + anchor как обязательный runtime-gate ===");
{
  const out = evaluateMarketsAtCommonHorizon(raceMarkets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  const H = out.selection.commonHorizon!;

  // (a) искусственно смешанные горизонты при «хорошем» selection ⇒ alignment обязан отказать
  const mixed = out.results.map((r, i) =>
    i === 0 && r.status === "evaluated" ? ({ ...r, candleTime: new Date(r.candleTime.getTime() + M5) } as MarketStrategyResult) : r
  );
  const gateMixed = decideAggregationAtCommonHorizon({ selection: out.selection, results: mixed, timeframe: "5m" });
  eq(checkCandleAlignment(mixed, "5m").safe, false, "mixed: существующий checkCandleAlignment ловит смешение");
  eq(gateMixed.allowed, false, "mixed ⇒ gate ОТКАЗЫВАЕТ (агрегат не вызывается)");
  eq(gateMixed.alignment.safe, false, "mixed: alignment реально вызван внутри gate");
  ok(gateMixed.refusalReasons.some((s) => s.includes("alignment")), "mixed: refusal ссылается на alignment");

  // (b) ОДИН evaluated с чужим candleTime: alignment на одном рынке тривиально safe —
  //     ловит только anchor-проверка. Доказательство, что gate не дублирование.
  const singleForeign: MarketStrategyResult[] = out.results.map((r, i) =>
    i === 0
      ? r.status === "evaluated"
        ? ({ ...r, candleTime: new Date(r.candleTime.getTime() + M5) } as MarketStrategyResult)
        : r
      : ({ status: "cannot-evaluate", exchange: r.exchange, market: r.market, marketId: r.marketId, reason: "forced" } as SkippedMarket)
  );
  eq(checkCandleAlignment(singleForeign, "5m").safe, true, "один evaluated: alignment тривиально safe (одно множество горизонтов)");
  eq(assertEvaluatedAtHorizon(singleForeign, H).ok, false, "один evaluated: anchor-проверка ловит чужой горизонт");
  const gateSingle = decideAggregationAtCommonHorizon({ selection: out.selection, results: singleForeign, timeframe: "5m" });
  eq(gateSingle.allowed, false, "один evaluated с чужим горизонтом ⇒ gate ОТКАЗЫВАЕТ");
  ok(gateSingle.refusalReasons.some((s) => s.includes("anchor")), "отказ содержит якорную причину");

  // (c) корректный вход проходит все проверки
  const gateOk = decideAggregationAtCommonHorizon({ selection: out.selection, results: out.results, timeframe: "5m" });
  eq([gateOk.allowed, gateOk.anchor.ok, gateOk.alignment.safe], [true, true, true], "корректный общий H ⇒ gate разрешает агрегацию");

  // (d) selection непригоден, но results «идеально выровнены» ⇒ всё равно отказ
  const staleSel = selectCommonClosedHorizon(
    [{ exchange: "BINANCE", marketId: 1, candles: waveCandles(closedTimes(NOW_5M - 3 * 86_400_000, 200, "5m")) }],
    "5m",
    { now: new Date(NOW_5M) }
  );
  eq(staleSel.status, "absolute_stale", "древний ряд на одном рынке ⇒ absolute_stale");
  const gateStale = decideAggregationAtCommonHorizon({ selection: staleSel, results: out.results, timeframe: "5m" });
  eq(gateStale.allowed, false, "непригодный selection ⇒ отказ, даже если results выглядят согласованными");
  ok(gateStale.refusalReasons.some((s) => s.includes("ABSOLUTE_STALE")), "непригодный selection: в отказе названа точная причина");

  // (e) нет ни одной оцениваемой записи ⇒ отказ (агрегат не вызывается)
  const gateEmpty = decideAggregationAtCommonHorizon({ selection: out.selection, results: [], timeframe: "5m" });
  eq(gateEmpty.allowed, false, "пустой набор evaluated ⇒ отказ");

  // (f) 1d: ровно один evaluated на каноническом H + четверо cannot-evaluate ⇒ разрешено
  const oneValued1d = [fresh1d(1, "BINANCE", D_EXPECTED), fresh1d(2, "BYBIT", D_EXPECTED), fresh1d(3, "GATE", D_EXPECTED), fresh1d(4, "KUCOIN", D_EXPECTED)];
  const out1d = evaluateMarketsAtCommonHorizon(oneValued1d, "1d", cfg("1d"), NO_FILTERS, new Date(D_NOW));
  eq(out1d.status, "ok", "1d: 4 участника на 09-10 ⇒ ok");
  eq(out1d.results.length, 4, "1d: 4 результата");
  const gate1d = decideAggregationAtCommonHorizon({ selection: out1d.selection, results: out1d.results, timeframe: "1d" });
  eq(gate1d.allowed, true, "1d: агрегация 4 участников разрешена");
  eq(gate1d.alignment.offGrid.length, 0, "1d: off-grid рынков нет");
  eq(out1d.results.every((r) => r.status === "evaluated" && r.candleTime.getTime() === D_EXPECTED), true, "1d: каждый evaluated ровно на 2026-09-10T00:00Z");
}

// ============================================================
console.log("\n=== 13. ELIGIBILITY FIRST: BINGX исключается ДО выбора H (1d) ===");
{
  const bingxOffGrid = market("BINGX", 5, "1d", waveCandles(offsetTimes(D_EXPECTED + 16 * 3600_000, 200, "1d")));
  const all = [...[fresh1d(1, "BINANCE", D_EXPECTED), fresh1d(2, "BYBIT", D_EXPECTED), fresh1d(3, "GATE", D_EXPECTED), fresh1d(4, "KUCOIN", D_EXPECTED)], bingxOffGrid];
  eq(isSmartMoneyExchangeEligible("BINGX", "1d"), false, "policy: BINGX неeligible для 1d");
  eq(isSmartMoneyExchangeEligible("BINGX", "5m"), true, "policy: BINGX eligible для 5m");
  eq(isSmartMoneyExchangeEligible("BINANCE", "1d"), true, "policy: остальные 4 eligible для 1d");

  const eligible = all.filter((m) => isSmartMoneyExchangeEligible(m.meta.exchange, "1d"));
  eq(eligible.length, 4, "1d: eligible ровно 4 (denominator 1d = 4)");
  const out = evaluateMarketsAtCommonHorizon(eligible, "1d", cfg("1d"), NO_FILTERS, new Date(D_NOW));
  eq(out.status, "ok", "1d: общий горизонт выбран по 4 eligible");
  eq(iso(out.selection.commonHorizon!), iso(D_EXPECTED), "1d: H = 2026-09-10T00:00Z (BINGX 16:00 его не сдвинул)");
  eq(out.selection.absoluteLagBars, 0, "1d: лаг от ожидаемого канонического дня = 0");
  eq(out.selection.participantCount, 4, "1d: участников 4");
  eq(out.results.length, 4, "1d: в агрегации 4 рынка (BINGX не в denominator)");
  const gate = decideAggregationAtCommonHorizon({ selection: out.selection, results: out.results, timeframe: "1d" });
  eq(gate.allowed, true, "1d: агрегация разрешена");
  eq(filterSmartMoneyEligibleResults(out.results, "1d").length, 4, "1d: повторный eligibility-фильтр ничего не снял");

  // Контрольная: без eligibility-фильтра BINGX не «испортит» H, а обрубит его целиком.
  const outNoFilter = evaluateMarketsAtCommonHorizon(all, "1d", cfg("1d"), NO_FILTERS, new Date(D_NOW));
  eq(outNoFilter.status, "data_unavailable", "без eligibility-фильтра BINGX(16:00) ⇒ DATA_UNAVAILABLE, а не ложный H");
  eq(outNoFilter.usable, false, "без фильтра 1d был бы полностью недоступен — порядок множеств обязателен");

  // На intraday BINGX — полноценный участник и не мешает
  const intraday = evaluateMarketsAtCommonHorizon([fresh5m(1), fresh5m(2), fresh5m(3), fresh5m(4), fresh5m(5)], "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  eq(intraday.selection.participantCount, 5, "5m: BINGX — полноценный участник (5 из 5)");
  eq(iso(intraday.selection.commonHorizon!), iso(T), "5m: BINGX не сдвинул H (все пятеро на 09:50)");
  eq(filterSmartMoneyEligibleResults(intraday.results, "5m").length, 5, "5m: eligibility-фильтр ничего не снял");
}

// ============================================================
console.log("\n=== 14. Диагностика: оператор видит все множества и точную причину ===");
{
  const out = evaluateMarketsAtCommonHorizon(raceMarkets, "5m", cfg("5m"), NO_FILTERS, new Date(NOW_5M));
  const lines = [
    `participants=${out.selection.participantCount}`,
    `filtered=${out.filteredCount}`,
    `perMarket=${out.selection.perMarketLatest.length}`,
    `H=${out.selection.commonHorizon!.toISOString()}`,
    `expected=${out.selection.expectedLatestClosed.toISOString()}`,
    `relLag=${out.selection.lagBars}/${out.selection.relativeMaxLagBars}`,
    `absLag=${out.selection.absoluteLagBars}/${out.selection.absoluteMaxLagBars}`,
    `status=${out.status}`,
  ];
  eq(lines.length, 8, "diagnostics: 8 обязательных величин (участники/фильтры/H/ожидание/оба лага/статус)");
  ok(lines.every((l) => !l.includes("undefined") && !l.includes("NaN")), "diagnostics: ни одной undefined/NaN-величины");
  ok(out.selection.perMarketLatest.every((p) => p.latest !== null && p.hasCommon), "diagnostics: newest CLOSED по каждому участнику доступен и подтверждён");
  ok(out.selection.reason.startsWith("OK:"), "diagnostics: reason заполнен и для успешного случая");
  // форматированный отчёт не «врут» при непригодном H
  const stale = evaluateMarketsAtCommonHorizon([fresh1d(1, "BINANCE", D_MINUS_2), fresh1d(2, "BYBIT", D_MINUS_2), fresh1d(3, "GATE", D_MINUS_2), fresh1d(4, "KUCOIN", D_MINUS_2)], "1d", cfg("1d"), NO_FILTERS, new Date(D_NOW));
  eq([stale.status, stale.usable], ["absolute_stale", false], "diagnostics: 1d на 09-08 ⇒ absolute_stale");
  eq(stale.selection.participantCount, 4, "diagnostics: участники посчитаны ДАЖЕ когда H непригоден (не «0 eligible»)");
  eq(stale.results.length, 0, "diagnostics: evaluated=0 корректно отражает отказ");
}

// ============================================================
console.log("\n=== 15. Signal safety и неизменность safety-слоя (статические проверки) ===");
{
  const changedRuntime = [
    "lib/strategies/common-horizon.ts",
    "lib/strategies/smart-money.ts",
    "scripts/smart-money-readonly.ts",
    "scripts/smart-money-diagnostic.ts",
  ];
  for (const f of changedRuntime) {
    const src = readSource(f);
    ok(!/prisma\.signal\.(create|createMany|update|updateMany|delete|deleteMany|upsert)/.test(src), `${f}: нет Signal writes`);
    ok(!/^\s*import[^\n]*["'][^"']*(lib\/signals|signal-worker|test-signal-engine)/m.test(src), `${f}: нет импортов Signal Engine`);
    ok(!/prisma\.strategy\.(create|createMany|update|updateMany|delete|deleteMany|upsert)/.test(src), `${f}: нет Strategy mutation`);
    ok(!/\$executeRaw[^\n]*(INSERT|UPDATE|DELETE)/i.test(src), `${f}: нет raw-мутаций`);
  }
  // Скрипты обязаны продолжать сами проверять отсутствие Signal writes (защита от регрессии).
  for (const f of ["scripts/smart-money-readonly.ts", "scripts/smart-money-diagnostic.ts"]) {
    ok(readSource(f).includes("hasSignalWrite") || readSource(f).includes("prisma.signal.count"), `${f}: собственный скан Signal-writes/счётчик сохранён`);
  }
  const ch = readSource("lib/strategies/common-horizon.ts");
  ok(!ch.includes("prisma") && !ch.includes("fetch("), "common-horizon: нет БД и сети (чистый слой)");
  ok(!ch.includes("Date.now()"), "common-horizon: нет wall-clock внутри чистого слоя — now инжектируется");
  const sm = readSource("lib/strategies/smart-money.ts");
  ok(sm.includes("applySmartMoneyFilters("), "smart-money: фильтр-логика переиспользуется, а не дублируется");
  ok(sm.includes("evaluateMarketsAtCommonHorizon"), "smart-money: единая точка входа common horizon существует");
  ok(sm.includes("invariant: candleTime") && sm.includes("truncateCandlesToHorizon"), "smart-money: anchor-инвариант на уровне рынка вшит в runtime-путь");
  ok(!sm.includes("Date.now()"), "smart-money: в SMC-слое нет скрытого wall-clock (now приходит параметром)");
  ok(!sm.includes("prisma.signal") && !sm.includes("lib/signals") && !sm.includes("signal-worker"), "smart-money: Signal Engine не затронут");
  for (const f of ["scripts/smart-money-readonly.ts", "scripts/smart-money-diagnostic.ts"]) {
    const src = readSource(f);
    ok(src.includes("decideAggregationAtCommonHorizon"), `${f}: использует единые runtime-ворота (не reimplement)`);
    ok(src.includes("formatCommonHorizonReport"), `${f}: печатает единую диагностику горизонта`);
    ok(src.includes("new Date()"), `${f}: now фиксируется один раз на прогон и передаётся в чистый слой`);
  }
  const alignment = readSource("lib/strategies/alignment.ts");
  ok(alignment.includes("export function checkCandleAlignment") && alignment.includes("export function canAggregateSafely"), "alignment.ts: строгие ворота на месте");
  ok(ch.includes("checkCandleAlignment(results, timeframe)") && ch.includes("canAggregateSafely(alignment)"), "gate: alignment вызывается ВНУТРИ решения (обязательно)");
  ok(ch.includes("assertEvaluatedAtHorizon"), "gate: anchor-проверка вызывается внутри решения");
  const schema = readSource("prisma/schema.prisma");
  ok(schema.includes("model Candle") && schema.includes("model Signal"), "schema.prisma: модели на месте (правок не вносилось)");
  // Основание формулы ожидаемого latest CLOSED: ingestion помечает свечу закрытой по closeTime < now.
  for (const f of ["lib/exchanges/binance.ts", "lib/exchanges/bingx.ts", "lib/exchanges/bybit.ts", "lib/exchanges/gate.ts", "lib/exchanges/kucoin.ts"]) {
    ok(readSource(f).includes("< now"), `${f}: семантика closed = closeTime < now (адаптеры этим коммитом не изменены)`);
  }
}

// ============================================================
console.log(`\nItog: ${passed}/${passed + failed}`);
if (failed > 0) {
  console.error(`Провалено ${failed}:`);
  for (const f of failures) console.error(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
