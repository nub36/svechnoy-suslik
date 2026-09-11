/**
 * SMC overlay projection (P1-A) — семантические regression-тесты.
 *
 * Что ДОКАЗЫВАЕТ этот файл (а не просто «функции вызываются»):
 *  1. фикстура реально оценивается (status="evaluated") — иначе тесты падают;
 *  2. проекция на общем горизонте H совпадает с СУЩЕСТВУЮЩЕЙ оценкой
 *     стратегии на том же H (direction/scores/reasons/candleTime/price);
 *  3. strategy-view = точное отображение существующего
 *     evaluateMarketsAtCommonHorizon + decideAggregationAtCommonHorizon
 *     + aggregateAssetGroup, без «улучшений»;
 *  4. no-lookahead: будущие свечи после H не меняют DTO (и честно видно,
 *     что они были отброшены);
 *  5. confirmedAt > engineAsOf не проходит — guard реально бьёт;
 *  6. детерминизм и стабильность идентичностей (id — ключи движка);
 *  7. ms→seconds без off-by-1000; невалидное — падение;
 *  8. reason→factIds только по точному ключу движка, эвристик нет;
 *  9. range position без clamp (<0 и >1 сохраняются);
 * 10. lifecycle-состояния и времена — дословно;
 * 11. агрегат физически не может содержать факты;
 * 12. модуль чистый: нет Prisma/сети/React/DOM/часов, импорт — только
 *     движок и стратегический слой.
 *
 * Никаких ok(true, placeholder), никаких «не вышло — mock», никаких
 * проглоченных ошибок чтения исходников.
 *
 * Run: npx tsx scripts/test-smc-projection.ts
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SMC_ENGINE_VERSION,
  SMC_OVERLAY_CONTRACT_VERSION,
  SMC_PROJECTION_WINDOW,
  SMC_PROJECTION_WINDOW_MAX,
  SMC_PROJECTION_WINDOW_MIN,
  SmcChartTimeError,
  fromChartTime,
  isChartTimeConvertible,
  requireEpochMs,
  toChartTime,
  toEpochMs,
  type SmcDtoHorizon,
  type SmcDtoMarketProjection,
  type SmcDtoOverlays,
} from "../lib/chart/smc-contract";
import {
  SmcProjectionError,
  applySmcProjectionWindow,
  assertFactsNotBeyondAsOf,
  projectRange,
  projectSmcMarket,
  projectStrategyView,
  projectWhy,
} from "../lib/chart/smc-projection";
import {
  evaluateMarketsAtCommonHorizon,
  evaluateSmartMoneyWithCandles,
  mapSmcReasonsToStrategyReasons,
  type SmartMoneyFilters,
  type SmartMoneyMarketMeta,
} from "../lib/strategies/smart-money";
import {
  decideAggregationAtCommonHorizon,
  truncateCandlesToHorizon,
} from "../lib/strategies/common-horizon";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import {
  defaultSmcScoringConfig,
  type SmcScoringConfig,
} from "../lib/smc/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import {
  smcPivotKey,
  SMCTIMEFRAME_MS,
  type SmcRawCandle,
} from "../lib/smc/types";

/* ------------------------------------------------------------------ */
/* Каркас                                                              */
/* ------------------------------------------------------------------ */

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

function throwsLabel(fn: () => unknown, label: string): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) {
    ok(false, `${label} (исключение НЕ выброшено)`);
    return;
  }
  passed++;
}

function throwsType<T extends Error>(
  fn: () => unknown,
  ctor: new (...args: never[]) => T,
  label: string
): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  if (thrown === null) {
    ok(false, `${label} (исключение НЕ выброшено)`);
    return;
  }
  ok(thrown instanceof ctor, `${label} (выброшено ${String(thrown)})`);
}

/* Чтение исходников ОТНОСИТЕЛЬНО КОРНЯ; ошибка чтения = падение теста. */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function readSource(relPath: string): string {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(
      `не найден исходник ${relPath} (ожидался ${abs}) — проверка не может «пройти вслепую»`
    );
  }
  const text = readFileSync(abs, "utf8");
  if (text.trim().length === 0) {
    throw new Error(`пустой исходник ${relPath} — чтение не удалось, тест не пройден`);
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Фикстуры                                                            */
/* ------------------------------------------------------------------ */

const T0 = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z — ровно на 1h-сетке
const HOUR = SMCTIMEFRAME_MS["1h"];
/** Последняя закрытая свеча ряда — бар 26; он же общий горизонт H. */
const H = T0 + 26 * HOUR;

function mkAt(
  openMs: number,
  open: number,
  close: number,
  high: number,
  low: number
): SmcRawCandle {
  return {
    openTime: new Date(openMs),
    open,
    high,
    low,
    close,
    closed: true,
  };
}

function mk(i: number, open: number, close: number, high?: number, low?: number): SmcRawCandle {
  return mkAt(
    T0 + i * HOUR,
    open,
    close,
    high ?? Math.max(open, close),
    low ?? Math.min(open, close)
  );
}

function flat(i: number): SmcRawCandle {
  const b = i * 0.01;
  return mk(i, 86 + b, 87 + b, 90 + b, 84 + b);
}

function flats(from: number, to: number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  for (let i = from; i <= to; i++) out.push(flat(i));
  return out;
}

/**
 * Каноническая OB-фикстура движка (та же, что в test-smc-evaluate.ts):
 * swing+internal BOS, 4 FVG, swing+internal OB, range [84,108],
 * LONG 75/10. Ряд ПЕРЕСЫЩЕН фактами — «пустые» ветки тестов невозможны.
 */
function canonicalFixture(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 105, 84.05),
    flat(6),
    mk(7, 86.07, 87.07, 90.07, 82),
    ...flats(8, 13),
    mk(14, 90, 86, 90.14, 84),
    mk(15, 91, 104, 108, 91),
    mk(16, 103, 101, 103.5, 95),
    mk(17, 107, 109, 109.5, 106.5),
    ...flats(18, 26),
  ];
}

/** Треугольная волна, заканчивающаяся точно на endMs (для 5m-отказов). */
function waveEndingAt(endMs: number, count: number, tfMs: number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  let prev = 100;
  for (let i = count - 1; i >= 0; i--) {
    const openMs = endMs - i * tfMs;
    const t = i % 48;
    const tri = t <= 24 ? t : 48 - t;
    const close = 100 + 2 * tri;
    out.push(
      mkAt(openMs, prev, close, Math.max(prev, close) + 1, Math.min(prev, close) - 1)
    );
    prev = close;
  }
  return out;
}

/** Окно 1..1 — как в test-smc-evaluate.ts (иначе 27 баров неdense). */
const cfg: SmcScoringConfig = {
  ...defaultSmcScoringConfig("1h"),
  swingLeft: 1,
  swingRight: 1,
  internalLeft: 1,
  internalRight: 1,
};
const cfgDefault = defaultSmcScoringConfig("1h");
const NO_FILTERS: SmartMoneyFilters = { top500Only: false, minimumQuoteVolume24h: 0 };
const TOP100_FILTERS: SmartMoneyFilters = { top500Only: true, minimumQuoteVolume24h: 0 };

function meta(exchange: string, marketId: number): SmartMoneyMarketMeta {
  return {
    exchange,
    market: `${exchange}*BTCUSDT`,
    marketId,
    timeframe: "1h",
    assetRank: 1,
    quoteVolume24h: 1_000_000,
  };
}

const EXCHANGES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];

function fiveMarkets(candles: SmcRawCandle[] = canonicalFixture()) {
  return EXCHANGES.map((exchange, i) => ({
    meta: meta(exchange, i + 1),
    candles,
  }));
}

type ProjectionInput = Parameters<typeof projectSmcMarket>[0];

function projectOne(
  candles: SmcRawCandle[],
  windowEndMs: number,
  overrides: Partial<ProjectionInput> = {}
): SmcDtoMarketProjection {
  return projectSmcMarket({
    meta: meta("BINANCE", 1),
    assetSymbol: "BTC",
    candles,
    config: cfg,
    filters: NO_FILTERS,
    windowEnd: new Date(windowEndMs),
    strategySlug: "smart-money-suslik",
    strategyVersion: 1,
    ...overrides,
  });
}

const base = projectOne(canonicalFixture(), H);

function allIds(overlays: SmcDtoOverlays): Set<string> {
  const ids = new Set<string>();
  for (const p of overlays.pivots) ids.add(p.id);
  for (const l of overlays.levels) ids.add(l.pivotId);
  for (const e of overlays.events) ids.add(e.id);
  for (const l of overlays.liquidity) ids.add(l.id);
  for (const f of overlays.fvgs) ids.add(f.id);
  for (const o of overlays.orderBlocks) ids.add(o.id);
  if (overlays.range !== null) ids.add(overlays.range.id);
  for (const d of overlays.displacements) ids.add(d.id);
  return ids;
}

/* ================================================================== */
console.log("=== 1. Фикстура реально оценивается (никаких mock-веток) ===");
{
  eq(base.market.status, "evaluated", "1a: market.status = evaluated (не cannot-evaluate)");
  eq(base.market.direction, "LONG", "1b: direction = LONG (75/10)");
  eq([base.market.longScore, base.market.shortScore], [75, 10], "1c: scores = 75 / 10");
  eq(base.market.evaluable, true, "1d: evaluable = true");
  eq(base.market.candleTime, H, "1e: candleTime = ровно windowEnd (H)");
  eq(base.market.price, canonicalFixture()[26]!.close, "1f: price = close(H)");
  eq(base.market.reason, null, "1g: у evaluated нет причины отказа");
  eq(base.overlays.counts.pivots, 12, "1h: 12 пивотов (6 swing + 6 internal)");
  eq(base.overlays.counts.events, 2, "1i: 2 структурных события");
  eq(base.overlays.counts.fvgs, 4, "1j: 4 FVG-зоны");
  eq(base.overlays.counts.orderBlocks, 2, "1k: 2 order block (swing+internal)");
  eq(base.overlays.counts.liquidity, 7, "1l: 7 уровней ликвидности");
  eq(base.overlays.counts.range, 1, "1m: dealing range присутствует");
  eq(base.overlays.counts.displacements, 1, "1n: displacement присутствует");
  eq(base.why.length, 9, "1o: все 9 scoring-причин сохранены");
  eq(base.contractVersion, SMC_OVERLAY_CONTRACT_VERSION, "1p: contractVersion = 1");
  eq(base.engineVersion, SMC_ENGINE_VERSION, "1q: engineVersion = SMC1");
}

/* ================================================================== */
console.log("\n=== 2. Эквивалентность существующей оценке стратегии на том же H ===");
{
  const candles = canonicalFixture();
  const reference = evaluateSmartMoneyWithCandles(
    meta("BINANCE", 1),
    truncateCandlesToHorizon(candles, new Date(H)),
    cfg,
    NO_FILTERS
  );
  ok(reference.status === "evaluated", "2a: референс сам evaluated — иначе сравнение вакуумно");
  if (reference.status === "evaluated") {
    eq(base.market.direction, reference.direction, "2b: direction совпадает с оценкой стратегии");
    eq(base.market.longScore, reference.longScore, "2c: longScore совпадает");
    eq(base.market.shortScore, reference.shortScore, "2d: shortScore совпадает");
    eq(base.market.candleTime, reference.candleTime.getTime(), "2e: candleTime совпадает (якорь на H)");
    eq(base.market.price, reference.price, "2f: price совпадает");
    const mapped = mapSmcReasonsToStrategyReasons(
      base.why.map((w) => ({
        code: w.code,
        label: w.label,
        longPoints: w.longPoints,
        shortPoints: w.shortPoints,
        maxPoints: w.maxPoints,
        value: w.value,
      }))
    );
    eq(mapped.length, reference.reasons.length, "2g: количество причин = как у адаптера (9)");
    eq(mapped.map((r) => r.label), reference.reasons.map((r) => r.label),
      "2h: ярлыки причин совпадают дословно ([CODE] label) — ничего не перефразировано");
    eq(mapped.map((r) => [r.long, r.short, r.weight]),
      base.why.map((w) => [w.longPoints > 0, w.shortPoints > 0, w.maxPoints]),
      "2i: булевы/весовые представления выводятся из тех же чисел");
  }
  const direct = evaluateSmc(candles, cfg, new Date(H + HOUR));
  eq(base.why.map((w) => [w.code, w.longPoints, w.shortPoints, w.maxPoints]),
    direct.reasons.map((r) => [r.code, r.longPoints, r.shortPoints, r.maxPoints]),
    "2j: why-строки = причины движка без изменений (своего scoring нет)");
  eq(base.overlays.fvgs.length, direct.fvgs.length, "2k: число FVG = числу FVG движка");
  eq(base.overlays.orderBlocks.length,
    direct.swingOrderBlocks.length + direct.internalOrderBlocks.length,
    "2l: число OB = swing+internal движка");
  eq(base.overlays.events.length,
    (direct.swingStructure?.events.length ?? 0) + (direct.internalStructure?.events.length ?? 0),
    "2m: число событий = движку");
  eq(base.overlays.liquidity.length, direct.liquidity.length, "2n: число уровней ликвидности = движку");
}

/* ================================================================== */
console.log("\n=== 3. Strategy-view против существующего runtime-пути (5 рынков) ===");
{
  const markets = fiveMarkets();
  // now ровно на границе закрытия СЛЕДУЮЩЕГО бара ⇒ ожидаемый latest CLOSED = H
  const now = new Date(H + HOUR);
  const view = projectStrategyView({
    markets,
    timeframe: "1h",
    config: cfg,
    now,
    minExchanges: 3,
    strategySlug: "smart-money-suslik",
    strategyVersion: 1,
    assetSymbol: "BTC",
  });

  const outcome = evaluateMarketsAtCommonHorizon(markets, "1h", cfg, NO_FILTERS, now);
  const gate = decideAggregationAtCommonHorizon({
    selection: outcome.selection,
    results: outcome.results,
    timeframe: "1h",
  });
  const agg = aggregateAssetGroup("BTC", "1h", "smart-money-suslik", 1, outcome.results, 3);

  ok(outcome.usable === true && gate.allowed === true, "3a: референс usable, гейт разрешает");
  eq(view.horizon.status, outcome.status, "3b: статус горизонта — из существующего выбора");
  eq(view.horizon.commonHorizon, H, "3c: общий горизонт = H (бар 26), а не «новейший по бирже»");
  eq(view.horizon.windowEnd, H, "3d: view.windowEnd = общий H");
  eq(view.horizon.engineAsOf, H + HOUR, "3e: view.engineAsOf = H + D");
  eq(view.horizon.expectedLatestClosed, outcome.selection.expectedLatestClosed.getTime(),
    "3f: ожидаемый latest CLOSED — из common-horizon слоя");
  eq([view.horizon.relativeLagBars, view.horizon.absoluteLagBars],
    [outcome.selection.lagBars, outcome.selection.absoluteLagBars],
    "3g: оба лага прокинуты, не пересчитаны");
  eq([view.horizon.relativeMaxLagBars, view.horizon.absoluteMaxLagBars],
    [outcome.selection.relativeMaxLagBars, outcome.selection.absoluteMaxLagBars],
    "3h: лимиты свежести — из слоя (политику не меняем)");
  eq(view.horizon.reason, outcome.selection.reason, "3i: причина — дословный текст слоя");
  ok(view.aggregate !== null, "3j: агрегат есть");
  eq(view.aggregate!.direction, agg.direction, "3k: направление = aggregateAssetGroup");
  eq(view.aggregate!.confirmation, agg.confirmation, "3l: confirmation = существующая строка голосов");
  eq(view.aggregate!.minExchanges, agg.minExchanges, "3m: minExchanges из Strategy");
  eq(view.aggregate!.conflict, agg.conflict, "3n: conflict-флаг сохранён");
  eq(view.aggregate!.explanation, agg.explanation, "3o: explanation дословно");
  eq(view.aggregate!.votes,
    { long: agg.longVotes, short: agg.shortVotes, neutral: agg.neutralVotes, evaluated: agg.evaluated, skipped: agg.skipped },
    "3p: votes/evaluated/skipped = counts runtime (denominator не «улучшен»");
  eq(view.aggregate!.participants.participantCount, outcome.participantCount, "3q: участников — из outcome");
  eq(view.aggregate!.participants.filteredCount, outcome.filteredCount, "3r: filtered — из outcome");
  eq([view.aggregate!.gate.allowed, view.aggregate!.gate.alignmentSafe, view.aggregate!.gate.anchorOk],
    [gate.allowed, gate.alignment.safe, gate.anchor.ok],
    "3s: гейт/alignment/anchor прокинуты как есть");
  eq(view.aggregate!.gate.totalEvaluated, gate.alignment.totalEvaluated, "3t: totalEvaluated из alignment");
  eq(view.markets.length, 5, "3u: 5 проекций участников");
  eq(view.markets.map((m) => m.market.marketId), [1, 2, 3, 4, 5], "3v: порядок = порядок входа");
  ok(view.markets.every((m) => m.market.candleTime === H), "3w: каждый участник заякорен ровно на H");
  ok(view.markets.every((m) => m.overlays.counts.events > 0 && m.overlays.counts.fvgs > 0),
    "3x: у каждого участника есть события и FVG (не пустые заглушки)");
  eq(view.aggregate!.perMarket.map((p) => [p.exchange, p.status, p.direction]),
    outcome.results.map((r) => [r.exchange, r.status, r.status === "evaluated" ? r.direction : null]),
    "3y: perMarket = поштучный вердикт участников");
  ok(view.markets.every((m) => m.horizon.mode === "strategy"), "3z: режим участников = strategy");
  eq(view.horizon.candlesInWindow, null, "3aa: на уровне view окна нет (оно — свойство рынка)");
  eq(base.horizon.mode, "exchange", "3ab: одиночная проекция по умолчанию = exchange-режим");
}

/* ================================================================== */
console.log("\n=== 4. Отказ горизонта: НИКАКОГО выдуманного агрегата ===");
{
  const fourHealthy = EXCHANGES.slice(0, 4).map((e, i) => ({ meta: meta(e, i + 1), candles: canonicalFixture() }));
  // 4 здоровых + участник без CLOSED-данных (eligibility+filters прошёл) → veto
  const out = projectStrategyView({
    markets: [...fourHealthy, { meta: meta("BINGX", 5), candles: [] }],
    timeframe: "1h",
    config: cfg,
    now: new Date(H + HOUR),
    minExchanges: 3,
    strategySlug: "smart-money-suslik",
    strategyVersion: 1,
    assetSymbol: "BTC",
  });
  eq(out.horizon.status, "data_unavailable", "4a: участник без данных → DATA_UNAVAILABLE");
  eq(out.aggregate, null, "4b: агрегат НЕ выдуман (тихого успеха на 4 нет)");
  eq(out.markets.length, 0, "4c: оверлеев нет — заякоривать не на чем");
  eq(out.horizon.marketsWithoutData.map((m) => m.exchange), ["BINGX"], "4d: виновник назван явно");
  ok(out.horizon.reason!.includes("DATA_UNAVAILABLE"), "4e: различимая причина для оператора");

  // Равномерная древность: все участники согласованы, но данным 3 суток
  const ancientEnd = Date.UTC(2026, 0, 1) - 3 * 86_400_000;
  const ancient = EXCHANGES.map((e, i) => ({
    meta: meta(e, i + 1),
    candles: waveEndingAt(ancientEnd, 200, SMCTIMEFRAME_MS["5m"]),
  }));
  const stale = projectStrategyView({
    markets: ancient.map((m) => ({ ...m, meta: { ...m.meta, timeframe: "5m" as const } })),
    timeframe: "5m",
    config: defaultSmcScoringConfig("5m"),
    now: new Date(Date.UTC(2026, 0, 4)),
    minExchanges: 3,
    strategySlug: "smart-money-suslik",
    strategyVersion: 1,
    assetSymbol: "BTC",
  });
  eq(stale.horizon.status, "absolute_stale", "4f: равномерная древность → ABSOLUTE_STALE");
  eq(stale.aggregate, null, "4g: на древних данных агрегат не выдаётся");
  eq(stale.markets.length, 0, "4h: и оверлеи тоже не выдаются");
  ok(stale.horizon.reason!.includes("ABSOLUTE_STALE"), "4i: причина абсолютной старости видна");
}

/* ================================================================== */
console.log("\n=== 5. NO-LOOKAHEAD: будущее за H не влияет ===");
{
  const full = canonicalFixture();
  const lastMs = full[26]!.openTime.getTime();
  const withFuture = [
    ...full,
    mkAt(lastMs + 1 * HOUR, 1, 99_999, 100_000, 0),
    mkAt(lastMs + 2 * HOUR, 99_999, 1, 99_999, 0),
    mkAt(lastMs + 3 * HOUR, 50_000, 60_000, 60_000, 40_000),
  ];
  const appended = projectOne(withFuture, H);
  eq(JSON.stringify([appended.market, appended.overlays, appended.why]),
    JSON.stringify([base.market, base.overlays, base.why]),
    "5a: вердикт + ВСЕ факты + причины идентичны при наличии будущих свечей");
  eq(appended.horizon.windowEnd, base.horizon.windowEnd, "5a2: точка отсчёта не сдвинулась");
  eq(appended.horizon.engineAsOf, base.horizon.engineAsOf, "5a3: engineAsOf не сдвинулся");
  eq(appended.horizon.droppedBeyondWindowEnd, 3,
    "5b: 3 будущих свечи реально были ОТБРОШЕНЫ (иначе проверка была бы вакуумной)");
  eq(appended.horizon.candlesInWindow, base.horizon.candlesInWindow, "5c: в движок ушло столько же свечей");

  // Незакрытая свеча на самой границе H не participates
  const openAtH = withFuture.slice(0, 26).concat([
    { ...withFuture[26]!, closed: false },
    ...withFuture.slice(27),
  ]);
  const openProj = projectOne(openAtH, H);
  eq(openProj.horizon.droppedUnclosed, 1, "5d: незакрытая свеча на границе отброшена (CLOSED-only)");
  eq(openProj.horizon.windowEnd, H, "5e: windowEnd остался H");
  ok(openProj.market.status === "evaluated",
    "5f: рынок всё ещё оценивается по закрытым свечам (27-я — незакрытая → окно 26 баров)");
  eq(openProj.horizon.candlesInWindow, 26, "5g: в окне ровно 26 закрытых свечей");

  // Окно движка == существующее усечение (тождество контракта)
  const truncated = truncateCandlesToHorizon(openAtH, new Date(H));
  eq(openProj.horizon.candlesInWindow, truncated.length,
    "5h: число свечей в окне проекции == truncateCandlesToHorizon+CLOSED");
}

/* ================================================================== */
console.log("\n=== 6. Guard no-lookahead бьёт по-настоящему ===");
{
  const okShape: SmcDtoOverlays = JSON.parse(JSON.stringify(base.overlays));
  let threw = false;
  try {
    assertFactsNotBeyondAsOf(okShape, H + HOUR, "test");
  } catch {
    threw = true;
  }
  eq(threw, false, "6a: корректная проекция проходит guard");

  const allWithin = [
    ...okShape.pivots.map((p) => p.confirmedAt),
    ...okShape.levels.map((l) => l.confirmedAt),
    ...okShape.events.map((e) => e.confirmedAt),
    ...okShape.liquidity.map((l) => l.createdAt),
    ...okShape.fvgs.map((f) => f.confirmedAt),
    ...okShape.orderBlocks.map((o) => o.confirmedAt),
    ...okShape.displacements.map((d) => d.confirmedAt),
  ];
  eq(allWithin.length > 20, true, "6b: проверено >20 времён подтверждения (не пустой список)");
  eq(allWithin.filter((t) => t > H + HOUR).length, 0, "6c: ни одно confirmedAt не больше engineAsOf");
  eq(allWithin.filter((t) => t % 1000 !== 0).length, 0, "6d: все времена проекции кратны секунде (ms-выровнены)");

  throwsType(
    () => assertFactsNotBeyondAsOf(
      { ...okShape, events: [{ ...okShape.events[0]!, confirmedAt: H + HOUR + 1 }] },
      H + HOUR,
      "test-lookahead"
    ),
    SmcProjectionError,
    "6e: fact с confirmedAt > engineAsOf → guard бросает"
  );
  throwsType(
    () => assertFactsNotBeyondAsOf(
      { ...okShape, liquidity: [{ ...okShape.liquidity[0]!, createdAt: H + 2 }] },
      H + 1,
      "test-liquidity"
    ),
    SmcProjectionError,
    "6f: то же для liquidity.createdAt"
  );
}

/* ================================================================== */
console.log("\n=== 7. Детерминизм и независимость от порядка рынков ===");
{
  const markets = fiveMarkets();
  const now = new Date(H + HOUR);
  const viewArgs = {
    markets,
    timeframe: "1h" as const,
    config: cfg,
    now,
    minExchanges: 3,
    strategySlug: "smart-money-suslik",
    strategyVersion: 1,
    assetSymbol: "BTC",
  };
  const v1 = projectStrategyView(viewArgs);
  const v2 = projectStrategyView(viewArgs);
  eq(JSON.stringify(v1), JSON.stringify(v2), "7a: повторный вызов → байт-в-байт тот же DTO");

  const reversed = projectStrategyView({ ...viewArgs, markets: [...markets].reverse() });
  const norm = (v: ReturnType<typeof projectStrategyView>) => {
    const perMarket = [...(v.aggregate?.perMarket ?? [])].map((p) =>
      JSON.stringify([p.marketId, p.status, p.direction, p.longScore, p.shortScore, p.candleTime])
    ).sort();
    const mkts = [...v.markets].map((m) =>
      JSON.stringify([m.market.marketId, m.market.direction, m.market.longScore, m.horizon.windowEnd, allIds(m.overlays).size])
    ).sort();
    return JSON.stringify([v.horizon.commonHorizon, v.horizon.status, perMarket, mkts]);
  };
  eq(norm(reversed), norm(v1), "7b: reverse-порядок → тот же H, статус, вердикты и id-множества");
  eq(reversed.horizon.commonHorizon, v1.horizon.commonHorizon, "7c: общий горизонт не зависит от порядка");
  eq(reversed.markets.map((m) => m.market.marketId), [5, 4, 3, 2, 1],
    "7d:Проекции следуют порядку входа (детерминированно, без сортировок по магическому признаку)");

  const shuffled = projectStrategyView({ ...viewArgs, markets: [markets[2]!, markets[0]!, markets[4]!, markets[1]!, markets[3]!] });
  eq(norm(shuffled), norm(v1), "7e: перестановка → нормализованный результат идентичен");
}

/* ================================================================== */
console.log("\n=== 8. Стабильные идентичности: id = ключи движка, не выдумка ===");
{
  const engine = evaluateSmc(canonicalFixture(), cfg, new Date(H + HOUR));
  const byId = new Map<string, { layer: string; kind: string; price: number; eventTime: number }>();
  for (const p of base.overlays.pivots) byId.set(p.id, p);
  eq(byId.size, base.overlays.pivots.length, "8a: id пивотов уникальны внутри проекции");

  // каждый id = smcPivotKey(...) от тех же полей
  const enginePivots = [
    ...(engine.swingStructure?.pivots ?? []),
    ...(engine.internalStructure?.pivots ?? []),
  ];
  eq(enginePivots.length, base.overlays.pivots.length, "8b: все пивоты движка спроецированы");
  let keyOk = true;
  for (const pivot of enginePivots) {
    const expect = smcPivotKey("1h", pivot.layer, pivot.kind, pivot.eventTime.getTime());
    if (expect !== pivot.key || !byId.has(expect)) keyOk = false;
  }
  eq(keyOk, true, "8c: id каждого пивота == smcPivotKey(tf,layer,kind,eventTimeMs) — никакой frontend-генерации");

  // FVG id = SMC1|FVG|tf|dir|eventTime (ключ движка), и он же в projection
  let fvgKeyOk = base.overlays.fvgs.length > 0;
  for (const f of base.overlays.fvgs) {
    if (f.id !== `SMC1|FVG|1h|${f.dir}|${f.eventTime}`) fvgKeyOk = false;
  }
  eq(fvgKeyOk, true, `8d: id FVG совпадают с формой ключа движка (${base.overlays.fvgs.length} шт.)`);
  ok(base.overlays.orderBlocks.every((o) => o.id.startsWith(`${SMC_ENGINE_VERSION}|OB|`)),
    "8e: id OB — ключи движка с префиксом SMC1|OB");
  ok(base.overlays.liquidity.every((l) => l.id.startsWith(`${SMC_ENGINE_VERSION}|LQ|`)),
    "8f: id ликвидности — ключи движка");
  ok(base.overlays.range !== null && base.overlays.range.id.startsWith(`${SMC_ENGINE_VERSION}|RANGE|`),
    "8g: id dealing range — ключ движка");

  const w500 = projectOne(canonicalFixture(), H, { windowSize: SMC_PROJECTION_WINDOW });
  const w100 = projectOne(canonicalFixture(), H, { windowSize: SMC_PROJECTION_WINDOW_MIN });
  eq(JSON.stringify(w100.overlays), JSON.stringify(w500.overlays),
    "8i: окно 100 против 500 на 27-баровом ряду даёт идентичные факты (окно не «улучшает» результат)");
  const idsA = allIds(w500.overlays);
  const idsB = allIds(w100.overlays);
  eq(idsA.size === idsB.size && [...idsA].every((id) => idsB.has(id)), true,
    "8j: множества id совпадают между окнами");
}

/* ================================================================== */
console.log("\n=== 9. ms → seconds: ровно, без off-by-1000, fail-closed ===");
{
  eq(toChartTime(1_767_276_000_000), 1_767_276_000, "9a: toChartTime(ровные мс) = мс/1000");
  eq(toChartTime(0), 0, "9b: граница 0 → 0");
  eq(toChartTime(1000), 1, "9c: 1000 → 1");
  eq(fromChartTime(1), 1000, "9d: обратная конвертация точна");
  eq(fromChartTime(toChartTime(H)), H, "9e: round-trip на H — точный");
  eq(toChartTime(H) * 1000, H, "9f: H*1000-инвариант (никакого смещения на бар)");

  for (const bad of [NaN, Infinity, -Infinity, -1, 999, 1000.5, 1.5]) {
    throwsType(() => toChartTime(bad), SmcChartTimeError, `9g: toChartTime(${String(bad)}) падает`);
  }
  throwsType(() => toChartTime("1000" as unknown as number), SmcChartTimeError, "9h: строка → падение");
  eq(isChartTimeConvertible(H), true, "9i: convertible для сеточного времени");
  eq(isChartTimeConvertible(H + 1), false, "9j: не convertible для смещённого на 1мс");
  eq(isChartTimeConvertible(-1000), false, "9k: отрицательное — не convertible");

  throwsType(() => fromChartTime(1.5), SmcChartTimeError, "9l: fromChartTime(1.5) падает");
  throwsType(() => fromChartTime(-1), SmcChartTimeError, "9m: fromChartTime(-1) падает");
  throwsType(() => toEpochMs(new Date(NaN)), SmcChartTimeError, "9n: Date(NaN) → падение");
  throwsType(() => toEpochMs("2026-01-01" as unknown as Date), SmcChartTimeError, "9o: строка вместо Date → падение");
  eq(toEpochMs(null), null, "9p: null разрешён (отсутствие lifecycle-события)");
  eq(toEpochMs(undefined), null, "9q: undefined разрешён тем же правилом");
  throwsType(() => requireEpochMs(null, "fvg.confirmedAt"), SmcChartTimeError, "9r: requireEpochMs(null) падает");
  eq(toEpochMs(new Date(H)), H, "9s: toEpochMs(Date) = ms");

  // КАЖДОЕ время всех проекций обратимо без потерь (это и есть анти-off-by-1000)
  let checked = 0;
  let broken = 0;
  for (const m of [base, ...fiveMarkets().map((_, i) => projectOne(canonicalFixture(), H, { meta: meta(EXCHANGES[i]!, i + 1) }))]) {
    const times: number[] = [];
    const push = (v: number | null): void => {
      if (v !== null) times.push(v);
    };
    push(m.horizon.windowEnd);
    push(m.horizon.engineAsOf);
    push(m.market.candleTime);
    for (const p of m.overlays.pivots) { push(p.eventTime); push(p.confirmedAt); }
    for (const e of m.overlays.events) { push(e.eventTime); push(e.confirmedAt); }
    for (const f of m.overlays.fvgs) { push(f.eventTime); push(f.confirmedAt); push(f.zoneEnd); }
    for (const o of m.overlays.orderBlocks) { push(o.eventTime); push(o.confirmedAt); push(o.impulseEndAt); }
    for (const l of m.overlays.liquidity) { push(l.eventTime); push(l.createdAt); push(l.resolvedAt); }
    if (m.overlays.range !== null) { push(m.overlays.range.eventTime); push(m.overlays.range.confirmedAt); }
    for (const t of times) {
      checked++;
      try {
        if (fromChartTime(toChartTime(t)) !== t) broken++;
      } catch {
        broken++;
      }
    }
  }
  ok(checked > 300, `9t: проверено ${checked} временных значений (много, не одна пара)`);
  eq(broken, 0, "9u: round-trip ms→s→ms без единой потери");
  ok(base.horizon.engineAsOf !== null && base.horizon.windowEnd !== null,
    "9v: на уровне рынка engineAsOf/windowEnd заполнены (null — только на уровне view)");
  eq((base.horizon.engineAsOf ?? 0) - (base.horizon.windowEnd ?? 0), SMCTIMEFRAME_MS["1h"],
    "9v2: engineAsOf − windowEnd == ровно D таймфрейма");
}

/* ================================================================== */
console.log("\n=== 10. Точка доступности движка: тождество с truncateCandlesToHorizon ===");
{
  const candles = canonicalFixture();
  for (const tf of ["5m", "15m", "1h", "4h", "1d"] as const) {
    const D = SMCTIMEFRAME_MS[tf];
    const endMs = tf === "1d" ? Date.UTC(2026, 0, 10) : Date.UTC(2026, 0, 10, 12);
    const series = waveEndingAt(endMs, 120, D);
    const win = applySmcProjectionWindow({ candles: series, timeframe: tf, windowEnd: new Date(endMs), windowSize: 500 });
    eq(win.engineAsOfMs, endMs + D, `10a[${tf}]: engineAsOf = windowEnd + D`);
    const truncated = truncateCandlesToHorizon(series, new Date(endMs));
    eq(win.candles.length, truncated.length, `10b[${tf}]: то же множество свечей, что у существующего усечения`);
    eq(win.candles.length, 120, `10c[${tf}]: весь ряд внутри окна (120 <= 500)`);
    eq(win.windowTruncated, false, `10d[${tf}]: усечения по правилу «последние 500» не было`);
    eq(win.windowStartMs, series[0]!.openTime.getTime(), `10e[${tf}]: windowStart = первый бар ряда`);
  }
  // Граница включительности: бар ровно на windowEnd ВХОДИТ, на windowEnd + D — нет
  const boundary = applySmcProjectionWindow({
    candles: canonicalFixture(),
    timeframe: "1h",
    windowEnd: new Date(T0 + 20 * HOUR),
    windowSize: 500,
  });
  eq(boundary.candles[boundary.candles.length - 1]!.openTime.getTime(), T0 + 20 * HOUR,
    "10f: свеча ровно на windowEnd включается (CLOSED-бар на границе)");
  eq(boundary.droppedBeyondWindowEnd, 6, "10g: 6 более новых баров отброшены");
  eq(boundary.candles.length, 21, "10h: в окне бары 0..20");
}

/* ================================================================== */
console.log("\n=== 11. Окно проекции = правило runtime (CLOSED-only, DESC→ASC последние N) ===");
{
  const withOpen = canonicalFixture().slice(0, 27).map((c, i) => (i === 26 ? { ...c, closed: false } : c));
  const w = applySmcProjectionWindow({ candles: withOpen, timeframe: "1h", windowEnd: new Date(H), windowSize: 500 });
  eq(w.droppedUnclosed, 1, "11a: незакрытая свеча отброшена");
  eq(w.candles.every((c) => c.closed === true), true, "11b: в окне только CLOSED");

  const many = waveEndingAt(H, 700, HOUR);
  const trunc = applySmcProjectionWindow({ candles: many, timeframe: "1h", windowEnd: new Date(H), windowSize: 500 });
  eq(trunc.candles.length, 500, "11c: 700 баров обрезаны до последних 500 (правило loadSmartMoneyCandles)");
  eq(trunc.windowTruncated, true, "11d: факт обрезки зафиксирован в метаданных");
  eq(trunc.windowStartMs, many[200]!.openTime.getTime(), "11e: windowStart = бар №200 (хвост сохранён)");
  eq(trunc.candles[499]!.openTime.getTime(), H, "11f: последний бар окна = windowEnd");
  eq(SMC_PROJECTION_WINDOW, 500, "11g: каноническое окно = 500");

  for (const bad of [SMC_PROJECTION_WINDOW_MIN - 1, SMC_PROJECTION_WINDOW_MAX + 1, 0, -5, 10.5, NaN]) {
    throwsType(
      () => applySmcProjectionWindow({ candles: canonicalFixture(), timeframe: "1h", windowEnd: new Date(H), windowSize: bad }),
      SmcProjectionError,
      `11h: windowSize=${String(bad)} вне 100..500 → падение (никакого тихого дефолта)`
    );
  }
  throwsType(
    () => applySmcProjectionWindow({ candles: canonicalFixture(), timeframe: "2h" as unknown as "1h", windowEnd: new Date(H) }),
    SmcProjectionError,
    "11i: неизвестный timeframe → падение"
  );
  throwsType(
    () => applySmcProjectionWindow({ candles: canonicalFixture(), timeframe: "1h", windowEnd: new Date(NaN) }),
    SmcChartTimeError,
    "11j: windowEnd=Invalid Date → падение"
  );
}

/* ================================================================== */
console.log("\n=== 12. WHY → факты: только точное ключевое соответствие ===");
{
  const mapped = base.why.filter((w) => w.factIds.length > 0);
  eq(mapped.map((w) => w.code).sort(), ["FVG", "INTERNAL_ORDER_BLOCK", "SWING_ORDER_BLOCK"].sort(),
    `12a: смэплено ровно OB(swing/internal) и FVG (${mapped.length} шт.) — те reasons, где value === ключ`);
  const obIds = new Set(base.overlays.orderBlocks.map((o) => o.id));
  const fvgIds = new Set(base.overlays.fvgs.map((f) => f.id));
  const swingRows = mapped.filter((w) => w.code === "SWING_ORDER_BLOCK");
  const internalRows = mapped.filter((w) => w.code === "INTERNAL_ORDER_BLOCK");
  const fvgRows = mapped.filter((w) => w.code === "FVG");
  eq(swingRows.length, 1, "12b: ровно одна swing-OB причина с фактом");
  ok(swingRows[0]!.factIds.every((id) => obIds.has(id)), "12c: swing OB id реально существует в orderBlocks");
  ok(!fvgRows[0]!.factIds.some((id) => obIds.has(id)), "12d: FVG-причина НЕ ссылается на OB (перепутанных слоёв нет)");
  ok(fvgRows[0]!.factIds.every((id) => fvgIds.has(id)), "12e: FVG id реально существует в fvgs");
  ok(swingRows[0]!.factIds[0]!.includes("|swing|"), "12f: swing-OB указывает на swing-зону");
  ok(internalRows[0]!.factIds[0]!.includes("|internal|"), "12g: internal-OB указывает на internal-зону");
  eq(swingRows[0]!.value, swingRows[0]!.factIds[0], "12h: value == id факта (без перекодирования)");

  // не-ключевые payload'ы НЕ сопоставляются, даже когда «похожи»
  const nonKeys = base.why.filter((w) => w.value !== null && w.factIds.length === 0);
  ok(nonKeys.length >= 3, `12i: неключевые payload'ы остались без связей (${nonKeys.length} шт.)`);
  eq(nonKeys.every((w) => !allIds(base.overlays).has(w.value!)), true,
    "12j: сопоставления не было ровно потому, что payload не является id");
  eq(base.why.filter((w) => w.code === "RECENT_SWING_BOS").map((w) => [w.value, w.factIds]), [["BOS:up", []]],
    "12k: BOS-причина (payload 'BOS:up') НЕ связывается угадыванием по направлению");
  eq(base.why.filter((w) => w.code === "RANGE_POSITION").map((w) => w.factIds), [[]],
    "12l: range-причина (payload 'pos=…') не связывается");
  eq(base.why.filter((w) => w.code === "OB_FVG_CONFLUENCE").map((w) => w.factIds), [[]],
    "12m: confluence (payload null) не связывается");

  // юнит-правило: ключ есть в списках → связь; ключ несуществующий → []
  const fakeEvaluation = {
    reasons: [
      { code: "FVG", label: "l", longPoints: 10, shortPoints: 0, maxPoints: 10, value: base.overlays.fvgs[0]!.id },
      { code: "FVG", label: "l", longPoints: 0, shortPoints: 0, maxPoints: 10, value: "SMC1|FVG|1h|up|1" },
      { code: "FVG", label: "l", longPoints: 0, shortPoints: 0, maxPoints: 10, value: "BTC loves FVG" },
      { code: "FVG", label: "l", longPoints: 0, shortPoints: 0, maxPoints: 10, value: null },
    ],
  } as unknown as Parameters<typeof projectWhy>[0];
  eq(projectWhy(fakeEvaluation, base.overlays).map((w) => w.factIds),
    [[base.overlays.fvgs[0]!.id], [], [], []],
    "12n: projectWhy: точное совпадение id → связь; всё остальное (включая правдоподобный мусор) → []");
  eq(projectWhy(null, base.overlays), [], "12o: нет evaluation → нет причин");
}

/* ================================================================== */
console.log("\n=== 13. Range: position БЕЗ clamp (regression §33) ===");
{
  const engine = evaluateSmc(canonicalFixture(), cfg, new Date(H + HOUR));
  const current = engine.dealingRange!.current!;
  const ctx = engine.dealingRange!.priceContext!;
  const projected = projectRange(engine);
  ok(projected !== null, "13a: range спроецирован (фикстура его даёт)");
  eq(projected!.position, ctx.position, "13b: position переложен дословно (тот же number)");
  eq(projected!.position > 0 && projected!.position < 1, true, "13c: в этой фикстуре position внутри [0,1]");
  eq(projected!.outsideRange, ctx.outsideRange, "13d: outsideRange — отдельный флаг, вынесен как есть");
  eq(projected!.zone, ctx.zone, "13e: zone = premium/discount/equilibrium литерал движка");
  eq(projected!.eqBand, ctx.eqBand, "13f: eqBand прокинут");
  eq([projected!.low, projected!.high, projected!.equilibrium], [current.low, current.high, current.equilibrium],
    "13g: low/high/equilibrium — дословно");
  eq(projected!.id, current.key, "13h: id = ключ движка");
  eq(projected!.historyVersions, engine.dealingRange!.history.length, "13i: число версий range сохранено");

  // искусственные position<0 и >1 — значение НЕ должно быть зажато
  const synth = (position: number, outsideRange: boolean) =>
    projectRange({
      dealingRange: {
        asOf: new Date(H),
        history: [],
        current: {
          key: "SMC1|RANGE|1h|up|E",
          tf: "1h",
          direction: "up",
          anchorStartPivotKey: "SMC1|P|1h|swing|low|1",
          anchorEndPivotKey: "SMC1|P|1h|swing|high|2",
          low: 100,
          high: 200,
          eventTime: new Date(H - 5 * HOUR),
          confirmedAt: new Date(H - 4 * HOUR),
          replacedAt: null,
          equilibrium: 150,
        },
        priceContext: { price: 100 + position * 100, position, eqBand: 0.02, zone: outsideRange ? "DISCOUNT" : "EQUILIBRIUM", outsideRange },
      },
    } as unknown as ReturnType<typeof evaluateSmc>);
  eq(synth(-0.91, true)!.position, -0.91, "13j: отрицательный position сохранён (observed 5m ≈ -0.91)");
  eq(synth(2.24, true)!.position, 2.24, "13k: position > 1 сохранён (observed 1d ≈ 2.24)");
  eq(synth(0, false)!.position, 0, "13l: граница 0");
  eq(synth(1, false)!.position, 1, "13m: граница 1");
  eq(synth(0.5, false)!.outsideRange, false, "13n: внутри-диапазона не превращается в outside");
  eq(synth(-3, true)!.outsideRange, true, "13o: outsideRange остаётся true");
  eq(projectRange(null), null, "13p: нет range → null (не «пустой объект»)");
}

/* ================================================================== */
console.log("\n=== 14. Lifecycle-состояния и времена — дословно ===");
{
  const engine = evaluateSmc(canonicalFixture(), cfg, new Date(H + HOUR));

  const fvgExpect = new Map(engine.fvgs.map((f) => [f.key, {
    dir: f.direction,
    top: f.top,
    bottom: f.bottom,
    ce: f.ce,
    gapSize: f.gapSize,
    sizeAtr: f.sizeAtr,
    fillFraction: f.fillFraction,
    state: f.state,
    firstTouchedAt: toEpochMs(f.firstTouchedAt),
    ceTouchedAt: toEpochMs(f.ceTouchedAt),
    filledByExcursionAt: toEpochMs(f.fullFilledByExcursionAt),
    invalidatedByCloseAt: toEpochMs(f.invalidatedByCloseAt),
    expiredAt: toEpochMs(f.expiredAt),
  }]));
  eq(base.overlays.fvgs.length, fvgExpect.size, "14a: все FVG движка присутствуют");
  eq(base.overlays.fvgs.every((f) => JSON.stringify(fvgExpect.get(f.id)) === JSON.stringify({
    dir: f.dir, top: f.top, bottom: f.bottom, ce: f.ce, gapSize: f.gapSize, sizeAtr: f.sizeAtr,
    fillFraction: f.fillFraction, state: f.state,
    firstTouchedAt: f.firstTouchedAt, ceTouchedAt: f.ceTouchedAt,
    filledByExcursionAt: f.filledByExcursionAt, invalidatedByCloseAt: f.invalidatedByCloseAt, expiredAt: f.expiredAt,
  })), true, "14b: ни состояние, ни одно lifecycle-время FVG не изменены");
  ok(base.overlays.fvgs.some((f) => f.state !== "OPEN"), "14c: в фикстуре есть НЕ-OPEN состояния (тест не сводится к «открытые зоны»)");
  const FVG_STATES = ["OPEN", "TOUCHED", "CE_MITIGATED", "FILLED_BY_EXCURSION", "EXPIRED", "INVALIDATED"];
  eq(base.overlays.fvgs.every((f) => FVG_STATES.includes(f.state)), true,
    "14d: каждое состояние FVG — из множества движка (новых не придумано)");
  eq(base.overlays.fvgs.every((f) => engine.fvgs.find((e) => e.key === f.id)!.state === f.state), true,
    "14d2: и то же самое состояние, что у движка, побарно");
  ok(base.overlays.fvgs.some((f) => f.state === "TOUCHED"), "14d3: TOUCHED присутствует (покрыт не только «чистый» случай)");

  const engineOb = [...engine.swingOrderBlocks, ...engine.internalOrderBlocks];
  const obExpect = new Map(engineOb.map((o) => [o.key, { state: o.state, retests: o.retests, maxPenetrationFraction: o.maxPenetrationFraction, firstTouchedAt: toEpochMs(o.firstTouchedAt), firstMitigatedAt: toEpochMs(o.firstMitigatedAt), invalidatedAt: toEpochMs(o.invalidatedAt), expiredAt: toEpochMs(o.expiredAt), hasFvgInImpulse: o.hasFvgInImpulse, hasLiquiditySweepBeforeImpulse: o.hasLiquiditySweepBeforeImpulse, preConfirmationTouches: o.preConfirmationTouches }]));
  eq(base.overlays.orderBlocks.length, obExpect.size, "14e: все OB присутствуют");
  eq(base.overlays.orderBlocks.every((o) => JSON.stringify(obExpect.get(o.id)) === JSON.stringify({
    state: o.state, retests: o.retests, maxPenetrationFraction: o.maxPenetrationFraction,
    firstTouchedAt: o.firstTouchedAt, firstMitigatedAt: o.firstMitigatedAt, invalidatedAt: o.invalidatedAt, expiredAt: o.expiredAt,
    hasFvgInImpulse: o.hasFvgInImpulse, hasLiquiditySweepBeforeImpulse: o.hasLiquiditySweepBeforeImpulse,
    preConfirmationTouches: o.preConfirmationTouches,
  })), true, "14f: состояния/митигация/экспирация OB — дословно");

  const lqExpect = new Map(engine.liquidity.map((l) => [l.key, { state: l.state, side: l.side, origin: l.origin, resolvedAt: toEpochMs(l.resolvedAt), resolvedByCandleTime: toEpochMs(l.resolvedByCandleTime), sweepPenetrationAtr: l.sweepPenetrationAtr }]));
  eq(base.overlays.liquidity.length, lqExpect.size, "14g: все уровни ликвидности присутствуют");
  eq(base.overlays.liquidity.every((l) => JSON.stringify(lqExpect.get(l.id)) === JSON.stringify({ state: l.state, side: l.side, origin: l.origin, resolvedAt: l.resolvedAt, resolvedByCandleTime: l.resolvedByCandleTime, sweepPenetrationAtr: l.sweepPenetrationAtr })), true,
    "14h: side/origin/state/sweep-времени — дословно (EQH/EQL не «сливаются» в один тип)");
  ok(base.overlays.liquidity.some((l) => l.origin === "EQH_EQL") || base.overlays.liquidity.every((l) => l.origin === "STRUCTURAL"),
    "14i: происхождение уровня сохранено в допустимом множестве движка");

  const swingLevels = engine.swingStructure?.levels ?? [];
  const internalLevels = engine.internalStructure?.levels ?? [];
  const lvlExpect = new Map([...swingLevels, ...internalLevels].map((l) => [l.pivotKey, { state: l.state, consumedAt: toEpochMs(l.consumedAt), consumedByEventId: l.consumedByEventKey }]));
  eq(base.overlays.levels.length, lvlExpect.size, "14j: все структурные уровни присутствуют");
  eq(base.overlays.levels.every((l) => JSON.stringify(lvlExpect.get(l.pivotId)) === JSON.stringify({ state: l.state, consumedAt: l.consumedAt, consumedByEventId: l.consumedByEventId })), true,
    "14k: AVAILABLE/CONSUMED и consumedAt/consumedByEventKey — дословно");
  ok(base.overlays.levels.some((l) => l.state === "CONSUMED"), "14l: в фикстуре есть CONSUMED-уровень (состояние реально прокинуто)");

  const evExpect = new Map([...(engine.swingStructure?.events ?? []), ...(engine.internalStructure?.events ?? [])].map((e) => [e.key, { type: e.type, dir: e.dir, brokenLevelPrice: e.brokenLevelPrice, brokenPivotId: e.brokenPivotKey, anchorPrice: e.protectedAnchor?.price ?? null }]));
  eq(base.overlays.events.every((e) => {
    const x = evExpect.get(e.id);
    return x !== undefined && x.type === e.type && x.dir === e.dir && x.brokenLevelPrice === e.brokenLevelPrice &&
      x.brokenPivotId === e.brokenPivotId && x.anchorPrice === (e.protectedAnchor?.price ?? null);
  }), true, "14m: тип события (BOS/CHOCH), направление, пробитый уровень и protectedAnchor — дословно");
}

/* ================================================================== */
console.log("\n=== 15. Swing vs internal: слои не смешиваются ===");
{
  const engine = evaluateSmc(canonicalFixture(), cfg, new Date(H + HOUR));
  const swingPivots = engine.swingStructure?.pivots.length ?? 0;
  const internalPivots = engine.internalStructure?.pivots.length ?? 0;
  eq(base.overlays.pivots.filter((p) => p.layer === "swing").length, swingPivots, "15a: число swing-пивотов совпадает");
  eq(base.overlays.pivots.filter((p) => p.layer === "internal").length, internalPivots, "15b: число internal-пивотов совпадает");
  ok(swingPivots > 0 && internalPivots > 0, "15c: оба слоя непусты (иначе сравнение было бы вакуумным)");
  eq(base.overlays.events.every((e) => e.layer === "swing" || e.layer === "internal"), true, "15d: у каждого события есть слой");
  eq(new Set(base.overlays.pivots.map((p) => p.layer)).size, 2, "15e: в проекции присутствуют ОБА слоя");
  eq(base.overlays.orderBlocks.filter((o) => o.layer === "swing").length, engine.swingOrderBlocks.length, "15f: swing OB не смешан с internal");
  eq(base.overlays.orderBlocks.filter((o) => o.layer === "internal").length, engine.internalOrderBlocks.length, "15g: internal OB — отдельно");
  eq(base.overlays.phases.swing, engine.swingStructure?.phase, "15h: фаза swing сохранена");
  eq(base.overlays.phases.internal, engine.internalStructure?.phase, "15i: фаза internal сохранена");
  eq(base.overlays.pivots.every((p) => p.price > 0 && p.confirmedAt >= p.eventTime), true,
    "15j: внутренняя согласованность: подтверждение не раньше события");
  // Документированный порядок движка: сначала highs, затем lows, внутри — по подтверждению.
  for (const layer of ["swing", "internal"] as const) {
    for (const kind of ["high", "low"] as const) {
      const row = base.overlays.pivots.filter((p) => p.layer === layer && p.kind === kind).map((p) => p.confirmedAt);
      ok(row.length > 0, `15k[${layer}/${kind}]: ряд непустой (проверка есть над чем делать)`);
      eq([...row].sort((a, b) => a - b), row, `15k[${layer}/${kind}]: хронологический порядок по confirmedAt сохранён`);
    }
    const kinds = base.overlays.pivots.filter((p) => p.layer === layer).map((p) => p.kind);
    const firstLow = kinds.indexOf("low");
    const lastHigh = kinds.lastIndexOf("high");
    eq(firstLow === -1 || lastHigh === -1 || lastHigh < firstLow, true,
      `15k2[${layer}]: highs идут перед lows (порядок регистрации движка сохранён, не пересортирован)`);
  }
}

/* ================================================================== */
console.log("\n=== 16. cannot-evaluate остаётся явным (не NEUTRAL, не 0-баллы) ===");
{
  const shortProj = projectOne(canonicalFixture(), H, { config: cfgDefault });
  eq(shortProj.market.status, "cannot-evaluate", "16a: 27 баров при swing 20/20 → cannot-evaluate");
  eq(shortProj.market.direction, "CANNOT_EVALUATE", "16b: направление — явный CANNOT_EVALUATE");
  ok(shortProj.market.direction !== "NEUTRAL", "16c: это НЕ NEUTRAL (различие сохранено)");
  eq([shortProj.market.longScore, shortProj.market.shortScore], [null, null], "16d: баллы НЕ выдуманы (null, не 0)");
  eq(shortProj.market.evaluable, false, "16e: evaluable=false");
  ok(shortProj.market.reason!.includes("cannot evaluate"), `16f: причина адаптера прокину (${shortProj.market.reason})`);
  eq(shortProj.overlays.counts.pivots, 0, "16g: hard-failure → оверлеев нет (не «пустые структуры»)");
  eq(shortProj.overlays.phases.swing, null, "16h: фазы тоже null");
  eq(shortProj.why, [], "16i: причин нет");

  const emptyProj = projectOne([], H);
  eq(emptyProj.market.status, "cannot-evaluate", "16j: пустой ряд → cannot-evaluate");
  eq(emptyProj.horizon.candlesInWindow, 0, "16k: окно пустое — видно в метаданных");
  eq(emptyProj.market.direction, "CANNOT_EVALUATE", "16l: направление явно CANNOT_EVALUATE");
  eq(emptyProj.overlays, { ...emptyProj.overlays, counts: { pivots: 0, levels: 0, events: 0, liquidity: 0, fvgs: 0, orderBlocks: 0, range: 0, displacements: 0 } },
    "16m: пустые списки фактов (не undefined/null-поля)");

  // фильтр вселенной: вердикта нет, но ряд биржи по-прежнему показуем
  const outsideUniverse = meta("KUCOIN", 42);
  outsideUniverse.assetRank = null;
  const filteredProj = projectOne(canonicalFixture(), H, { meta: outsideUniverse, filters: TOP100_FILTERS });
  eq(filteredProj.market.status, "filtered", "16n: рынок вне universe → filtered");
  eq(filteredProj.market.direction, null, "16o: у filtered НЕТ направления (не NEUTRAL и не CANNOT_EVALUATE)");
  eq(filteredProj.market.longScore, null, "16p: баллы не выдуманы");
  eq(filteredProj.market.filters.universe, "TOP_100", "16q: legacy-ключ top500Only показан как Top-100");
  eq(filteredProj.market.filters.top500Only, true, "16r: исходный ключ сохранён для отладки");
  ok(filteredProj.overlays.counts.pivots > 0, "16s: факты биржи при этом доступны (это взгляд на ряд, а не вердикт)");
  const insideProj = projectOne(canonicalFixture(), H, { filters: NO_FILTERS });
  eq(insideProj.market.filters.universe, "OFF", "16t: top500Only=false → OFF");
  eq(/500/.test(Object.values(filteredProj.market.filters).join(" ")), false,
    "16u: ни одно ЗНАЧЕНИЕ не говорит «500» — UI показывает Top-100 (legacy-имя ключа остаётся только ключом)");
  ok(Object.keys(filteredProj.market.filters).includes("top500Only"),
    "16u2: имя legacy-ключа сохранено (переименования конфига/схемы нет)");

  // отказ проекта на несогласованном входе — явное нарушение контракта
  const before = projectOne(canonicalFixture(), T0 - HOUR);
  eq(before.market.status, "cannot-evaluate", "16v: windowEnd раньше начала ряда → cannot-evaluate, а не «тихий график»");
  eq(before.horizon.candlesInWindow, 0, "16v2: окно 0 свечей видно в метаданных");
  eq(before.overlays.counts.pivots, 0, "16v3: фактов нет");
  eq(before.horizon.windowEnd, T0 - HOUR, "16v4: точка отсчёта сохранена в ответе (диагностика)");
  throwsType(
    () => projectSmcMarket({
      meta: meta("BINANCE", 1), assetSymbol: "BTC", candles: canonicalFixture(),
      config: defaultSmcScoringConfig("5m"), windowEnd: new Date(H),
      strategySlug: "s", strategyVersion: 1,
    }),
    SmcProjectionError,
    "16w: config.tf ≠ meta.timeframe → падение (защита от чужого конфига)"
  );
}

/* ================================================================== */
console.log("\n=== 17. Агрегат физически не может содержать факты ===");
{
  const view = projectStrategyView({
    markets: fiveMarkets(),
    timeframe: "1h",
    config: cfg,
    now: new Date(H + HOUR),
    minExchanges: 3,
    strategySlug: "smart-money-suslik",
    strategyVersion: 1,
    assetSymbol: "BTC",
    marketCount: 6,
    exchangeExcluded: ["KUCOIN"],
  });
  const aggregate = view.aggregate!;
  eq(Object.keys(aggregate).sort(),
    ["confirmation", "conflict", "direction", "explanation", "gate", "minExchanges", "participants", "perMarket", "votes"],
    "17a: ключи агрегата — ровно разрешённый список (никаких фактовых полей)");
  const serialised = JSON.stringify(aggregate);
  for (const forbidden of ["SMC1|", "confirmedAt", "fvgs", "orderBlocks", "pivots", "\"bottom\"", "\"top\"", "brokenLevelPrice", "overlays"]) {
    ok(!serialised.includes(forbidden), `17b: в агрегате нет «${forbidden}» — «общего FVG пяти бирж» нарисовать нельзя`);
  }
  eq(aggregate.participants.marketCount, 6, "17c: marketCount (до eligibility) прокинут честно");
  eq(aggregate.participants.exchangeEligibleCount, 5, "17d: eligible = переданные рынки");
  eq(aggregate.participants.exchangeExcluded, ["KUCOIN"], "17e: исключённые eligibility-политикой названы");
  eq(aggregate.perMarket.length, 5, "17f: perMarket = по участникам (без фактов)");
  // view-уровень: сами оверлеи живут ТОЛЬКО в markets[i]
  ok(view.markets.every((m) => m.overlays.counts.pivots > 0), "17g: оверлеи есть у проекций рынков");
  eq(Object.keys(view).sort(), ["aggregate", "contractVersion", "engineVersion", "horizon", "markets"],
    "17h: на верхнем уровне view нет поля «overlays» — смешение невозможно по структуре");
  eq(view.markets.every((m) => Object.keys(m.market).includes("marketId") && Object.keys(m.market).includes("exchangeSymbol")), true,
    "17i: каждый факт принадлежит конкретному рынку (marketId/exchangeSymbol в блоке рынка)");

  // сериализуемость контракта (никаких Date в DTO)
  const dates: string[] = [];
  JSON.stringify(view, (key, value) => {
    if (value instanceof Date) dates.push(key);
    return value;
  });
  eq(dates, [], "17j: в DTO нет ни одного Date — только числа/строки/булевы");
  eq(JSON.parse(JSON.stringify(view)).horizon.engineAsOf, view.horizon.engineAsOf,
    "17k: DTO проходит JSON round-trip без потерь");
}

/* ================================================================== */
console.log("\n=== 18. Окно/лимиты: метаданные не дают солгать про полноту ===");
{
  eq(base.horizon.windowRule, SMC_PROJECTION_WINDOW, "18a: окно проекции = 500 (правило runtime)");
  eq(base.horizon.candlesInWindow, 27, "18b: реально в движок ушло 27 баров");
  eq(base.horizon.windowTruncated, false, "18c: обрезки не было — это видно");
  eq(base.horizon.warmupRequired, 8, "18d: warmupRequired = minimumSwingHistoryCandles(cfg 1/1) = 8");
  eq(projectOne(canonicalFixture(), H, { config: cfgDefault }).horizon.warmupRequired, 84,
    "18e: warmupRequired пересчитывается из конфига Стратегии (20/20 → 84), не хардкод");
  ok(SMC_PROJECTION_WINDOW_MIN === 100 && SMC_PROJECTION_WINDOW_MAX === 500,
    "18f: границы окна объявлены (100..500)");
  ok(base.horizon.windowRule === 500 && base.market.timeframe === "1h",
    "18g: окно анализа ≠ размеру universe (Top-100) — разные сущности");
  const long700 = projectOne(waveEndingAt(H, 700, HOUR), H);
  eq(long700.horizon.windowTruncated, true, "18h: при 700 барах усечение зафиксировано");
  eq(long700.horizon.candlesInWindow, 500, "18i: в движок ушло ровно 500");
  eq(long700.horizon.windowEnd, H, "18j: windowEnd остался запрошенным");
}

/* ================================================================== */
console.log("\n=== 19. 1d/BINGX: denominators честные, eligibility — за вызывающим ===");
{
  const D1 = SMCTIMEFRAME_MS["1d"];
  const dayH = Date.UTC(2026, 0, 10);
  const now1d = new Date(Date.UTC(2026, 0, 11, 10));
  const cfg1d = defaultSmcScoringConfig("1d");
  const four = ["BINANCE", "BYBIT", "GATE", "KUCOIN"].map((e, i) => ({
    meta: { ...meta(e, i + 1), timeframe: "1d" as const },
    candles: waveEndingAt(dayH, 200, D1),
  }));
  const view = projectStrategyView({
    markets: four,
    timeframe: "1d",
    config: cfg1d,
    now: now1d,
    minExchanges: 3,
    strategySlug: "smart-money-suslik",
    strategyVersion: 1,
    assetSymbol: "BTC",
    marketCount: 5,
    exchangeExcluded: ["BINGX"],
  });
  eq(view.horizon.status, "ok", "19a: 1d на 4 eligible — горизонт выбран");
  eq(view.horizon.commonHorizon, dayH, "19b: общий горизонт = канонический UTC-день 2026-01-10");
  eq(view.horizon.expectedLatestClosed, dayH, "19c: ожидаемый latest CLOSED = тот же день (лаг 0)");
  eq(view.horizon.absoluteLagBars, 0, "19d: абсолютный лаг 0");
  eq(view.horizon.timeframeDurationMs, D1, "19e: длительность ТФ — из SMCTIMEFRAME_MS");
  eq(view.horizon.engineAsOf, dayH + D1, "19f: engineAsOf = H + 24h");
  eq(view.aggregate!.participants.marketCount, 5, "19g: «было 5 рынков» видно оператору");
  eq(view.aggregate!.participants.exchangeEligibleCount, 4, "19h: «eligible 4» видно оператору");
  eq(view.markets.length, 4, "19i: проекций — по числу участников, BINGX не вклеен");
  eq(view.markets.every((m) => m.market.candleTime === dayH), true, "19j: все заякорены на каноническом дне");

  // BINGX-1d (off-grid 16:00) если его ошибочно передали → veto, а не «успех на 4»
  const withBingx = [...four, {
    meta: { ...meta("BINGX", 5), timeframe: "1d" as const },
    candles: waveEndingAt(dayH + 16 * 3600_000, 200, D1),
  }];
  const bad = projectStrategyView({
    markets: withBingx, timeframe: "1d", config: cfg1d, now: now1d, minExchanges: 3,
    strategySlug: "smart-money-suslik", strategyVersion: 1, assetSymbol: "BTC", marketCount: 5, exchangeExcluded: [],
  });
  eq(bad.horizon.status, "data_unavailable", "19k: off-grid строки BINGX → DATA_UNAVAILABLE (проекция не «чинит» eligibility)");
  eq(bad.aggregate, null, "19l: и тогда агрегата нет");
  eq(bad.markets.length, 0, "19m: и оверлеев нет");
}

/* ================================================================== */
console.log("\n=== 20. Чистота модулей: никакого второго алгоритма и боковых эффектов ===");
{
  const projectionSrc = readSource("lib/chart/smc-projection.ts");
  const contractSrc = readSource("lib/chart/smc-contract.ts");
  const both: Array<[string, string]> = [["smc-projection", projectionSrc], ["smc-contract", contractSrc]];

  for (const [name, src] of both) {
    ok(!src.includes("prisma"), `20a[${name}]: нет Prisma`);
    ok(!/@\/lib\/prisma/.test(src), `20b[${name}]: нет клиента БД`);
    ok(!/fetch\s*\(/.test(src), `20c[${name}]: нет сети`);
    ok(!src.includes("Date.now("), `20d[${name}]: нет wall-clock (now/windowEnd — только параметром)`);
    ok(!/new Date\(\s*\)/.test(src), `20e[${name}]: нет «текущего времени» из воздуха`);
    ok(!/from\s+"(react|react-dom|next\/)/.test(src), `20f[${name}]: нет React/Next`);
    ok(!/localStorage|sessionStorage|document\.(getElementById|querySelector)|globalThis/.test(src),
      `20g[${name}]: нет DOM/хранилища браузера`);
    ok(!/(?<![.\w])window(?!\w)/.test(src),
      `20g2[${name}]: нет даже затеняющего DOM-глобал идентификатора window`);
    ok(!src.includes('from "lightweight-charts"'), `20h[${name}]: нет импорта UI-библиотеки`);
    ok(!src.includes("Math.random"), `20i[${name}]: нет недетерминированности`);
    ok(!src.includes("lib/signals") && !src.includes("signal-worker") && !src.includes("test-signal-engine"),
      `20j[${name}]: нет Signal Engine`);
    ok(!src.includes("prisma.signal"), `20k[${name}]: нет Signal writes`);
    ok(!/prisma\.strategy\.(create|update|delete|upsert)/.test(src), `20l[${name}]: нет Strategy mutations`);
    ok(!src.includes("$executeRaw"), `20m[${name}]: нет raw-SQL`);
    ok(!/setTimeout|setInterval|Worker|child_process/.test(src), `20n[${name}]: нет таймеров/процессов/воркеров`);
    ok(!/\bINSERT\b|\bUPDATE\b|\bDELETE FROM\b/i.test(src), `20o[${name}]: нет SQL-мутаций`);
    ok(!/\bprocess\.env\b/.test(src), `20p[${name}]: нет чтения окружения`);
  }

  // импорты — только движок, стратегический слой и собственный контракт
  const specs = [...projectionSrc.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  ok(specs.length >= 8, `20q: импортов найдено ${specs.length} (парсер работает, проверка не вакуумная)`);
  const allowed = /^(\.\/smc-contract|\.\.\/smc\/[^/]+|\.\.\/strategies\/[^/]+)$/;
  eq(specs.filter((spec) => !allowed.test(spec)), [],
    "20r: ни одного импорта мимо lib/smc, lib/strategies и собственного контракта");

  // единая точка входа в расчёт — обязательные делегирования
  for (const call of [
    "evaluateSmc(",
    "evaluateSmartMoneyWithCandles(",
    "evaluateMarketsAtCommonHorizon(",
    "decideAggregationAtCommonHorizon(",
    "aggregateAssetGroup(",
    "minimumSwingHistoryCandles(",
    "SMCTIMEFRAME_MS[",
  ]) {
    ok(projectionSrc.includes(call), `20s: проекция переиспользует ${call}`);
  }
  eq(/^import[^;]*truncateCandlesToHorizon[^;]*;/m.test(projectionSrc), false,
    "20s2: окно строится собственным applySmcProjectionWindow, а не заимствуется; тождество усечению доказан тестом 10b");

  // и НЕ содержит собственных детекторов/скоринга
  for (const forbidden of [
    "function findPivots", "function detectPivot", "function evaluateFvg", "function findOrderBlocks",
    "function evaluateLiquidity", "function evaluateDealingRange", "function computeAtr", "function atrValueAt",
    "longScore +=", "shortScore +=", "minimumScore", "weights",
  ]) {
    ok(!projectionSrc.includes(forbidden), `20t: в проекции нет «своего» ${forbidden}`);
  }
  // no-clamp: никаких зажиманий позиции
  for (const clamp of ["Math.min(1,", "Math.max(0,", "clamp("]) {
    ok(!projectionSrc.includes(clamp), `20u: нет clamp'а ${clamp} (позиция вне диапазона сохраняется)`);
  }

  // контракт: версии, id-строки, отсутствие Date в DTO-типах
  ok(contractSrc.includes("SMC_OVERLAY_CONTRACT_VERSION = 1"), "20v: версия контракта = 1");
  ok(contractSrc.includes('SMC_ENGINE_VERSION = "SMC1"'), "20w: тег движка = SMC1");
  const dtoBlock = contractSrc.slice(contractSrc.indexOf("export type SmcDtoHorizon"));
  eq(/\?\s*Date\b|:\s*Date\b/.test(dtoBlock), false,
    "20x: в DTO-типах нет полей типа Date (время только ms-числами)");
  ok(contractSrc.includes('universe: "TOP_100" | "OFF"'), "20y: вселенная названа Top-100 (не Top-500)");
  ok(contractSrc.includes("SMC_PROJECTION_WINDOW = 500"), "20z: окно проекции = 500 (правило runtime)");
  ok(dtoBlock.includes("windowEnd: number | null") && dtoBlock.includes("engineAsOf: number | null"),
    "20aa: windowEnd/engineAsOf объявлены в мс");

  // пакет не изменён: новых зависимостей (в т.ч. fancy-canvas) нет
  const pkg = JSON.parse(readSource("package.json"));
  eq(Object.keys(pkg.dependencies ?? {}).sort(),
    ["@auth/prisma-adapter", "@prisma/client", "bcryptjs", "dotenv", "lightweight-charts", "lucide-react", "next", "next-auth", "pg", "prisma", "react", "react-dom"],
    "20ab: dependencies ровно как в baseline (fancy-canvas НЕ добавлен)");
  eq(Object.keys(pkg.devDependencies ?? {}).sort(),
    ["@types/node", "@types/pg", "@types/react", "@types/react-dom", "tsx", "typescript"],
    "20ac: devDependencies ровно как в baseline");
  eq(pkg.dependencies?.["lightweight-charts"], "^5.2.1", "20ad: lightweight-charts остался 5.2.1 (без апгрейдов)");
}

/* ================================================================== */
console.log(`\nItog: ${passed}/${passed + failed}`);
if (failed > 0) {
  console.error(`Провалено ${failed}:`);
  for (const f of failures) console.error(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
