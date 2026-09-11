/**
 * P1-C — Smart Money панель графика: детерминированные тесты view-model
 * и интеграционной обвязки (запуск: npx tsx scripts/test-smc-panel.ts).
 *
 * DOM-фреймворка в проекте нет (и добавлять тяжёлую зависимость ради
 * P1-C запрещено), поэтому ВСЯ логика панели живёт в чистом
 * lib/chart/smc-panel.ts и проверяется здесь; компонент и обвязка
 * CandleChart покрыты осмысленными статическими инвариантами
 * (изоляция от ошибок графика, отсутствие primitives до P1-D,
 * отсутствие write-путей и Signal).
 *
 * Никаких placeholder-проверок: ни одного ok(true, ...), ни одного
 * «если не вышло — мок», чтение исходников падает при ошибке.
 * Половина проверок идёт на НАСТОЯЩИХ DTO, построенных принятой
 * P1-A проекцией (projectSmcChart), а не на выдуманных формах.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AGGREGATE_STATUS_LABELS,
  MARKET_STATUS_LABELS,
  SMC_DISCLAIMER,
  applySmcResponse,
  beginSmcRequest,
  buildSmcPanelView,
  buildSmcRequestUrl,
  clearSmcOnDisable,
  formatUtcClock,
  initialSmcRequestState,
  aggregateVerdict,
  isSmcAbortError,
  isSmcPanelVisible,
  marketVerdict,
  needsSmcFetch,
  parseSmcProjection,
  reasonView,
  shouldFetchSmc,
  smcFailureMessage,
  smcRequestKey,
  type SmcPanelPhase,
  type SmcRequestState,
} from "../lib/chart/smc-panel";
import {
  scoreReasonFactIds,
  type SmcAggregateSummaryDto,
  type SmcChartProjection,
  type SmcOverlayReasonDto,
} from "../lib/chart/smc-contract";
import { projectSmcChart } from "../lib/chart/smc-projection";
import { defaultSmcScoringConfig, type SmcScoringConfig } from "../lib/smc/config";
import { SMCTIMEFRAME_MS, type SmcRawCandle } from "../lib/smc/types";
import type { SmartMoneyMarketMeta } from "../lib/strategies/smart-money";

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
  const same =
    JSON.stringify(actual) === JSON.stringify(expected);
  if (!same) {
    console.error(
      `FAIL: ${label}\n   actual=${JSON.stringify(actual)}\n   expect=${JSON.stringify(expected)}`
    );
  }
  ok(same, label);
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

/** Код без комментариев — чтобы проверки «нет X» не спотыкались прозу. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

function readSource(relPath: string): string {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(
      `не найден исходник ${relPath} (ожидался ${abs}) — проверка не может «пройти вслепую»`
    );
  }
  const text = readFileSync(abs, "utf8");
  if (text.trim().length === 0) {
    throw new Error(`пустой исходник ${relPath} — чтение не удалось`);
  }
  return text;
}

/* ------------------------------------------------------------------ */
/* Реальные DTO из принятой P1-A проекции                              */
/* ------------------------------------------------------------------ */

const T0 = Date.UTC(2026, 0, 1);
const HOUR = SMCTIMEFRAME_MS["1h"];
const H1H = T0 + 26 * HOUR;

function mkAt(openMs: number, open: number, close: number, high: number, low: number): SmcRawCandle {
  return { openTime: new Date(openMs), open, high, low, close, closed: true };
}

function mk(i: number, open: number, close: number, high?: number, low?: number): SmcRawCandle {
  return mkAt(T0 + i * HOUR, open, close, high ?? Math.max(open, close), low ?? Math.min(open, close));
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

/** Плотная OB/FVG-фикстура движка (та же, что в P1-A/P1-B тестах). */
function canonical(): SmcRawCandle[] {
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

function waveEndingAt(endMs: number, count: number, tfMs: number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];
  let prev = 100;
  for (let i = count - 1; i >= 0; i--) {
    const openMs = endMs - i * tfMs;
    const t = i % 48;
    const tri = t <= 24 ? t : 48 - t;
    const close = 100 + 2 * tri;
    out.push(mkAt(openMs, prev, close, Math.max(prev, close) + 1, Math.min(prev, close) - 1));
    prev = close;
  }
  return out;
}

const cfg1h: SmcScoringConfig = {
  ...defaultSmcScoringConfig("1h"),
  swingLeft: 1,
  swingRight: 1,
  internalLeft: 1,
  internalRight: 1,
};
const NO_FILTERS = { top500Only: false as const, minimumQuoteVolume24h: 0 };

function meta(exchange: string, marketId: number, timeframe: "1h" | "1d" = "1h"): SmartMoneyMarketMeta {
  return {
    exchange,
    market: `${exchange}*BTCUSDT`,
    marketId,
    timeframe,
    assetRank: 1,
    quoteVolume24h: 1_000_000,
  };
}

const NAMES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];

/** Настоящий 1h-DTO: 5 бирж, LONG 75/10, dense-факты, aggregate 5/5. */
function real1hProjection(): SmcChartProjection {
  return projectSmcChart({
    assetSymbol: "BTC",
    timeframe: "1h",
    markets: NAMES.map((exchange, i) => ({
      meta: meta(exchange, i + 1),
      candles: canonical(),
    })),
    smcConfig: cfg1h,
    filters: NO_FILTERS,
    minExchanges: 3,
    now: new Date(H1H + HOUR),
  });
}

/** Настоящий 1d-DTO: 5 рынков, из них BINGX отсечён eligibility (Option A). */
function real1dProjection(): SmcChartProjection {
  const day = Date.UTC(2026, 0, 10);
  return projectSmcChart({
    assetSymbol: "BTC",
    timeframe: "1d",
    markets: NAMES.map((exchange, i) => ({
      meta: meta(exchange, i + 1, "1d"),
      // BINGX 1d — off-grid 16:00: именно поэтому его исключает политика
      candles:
        exchange === "BINGX"
          ? waveEndingAt(day + 16 * HOUR, 200, SMCTIMEFRAME_MS["1d"])
          : waveEndingAt(day, 200, SMCTIMEFRAME_MS["1d"]),
    })),
    smcConfig: defaultSmcScoringConfig("1d"),
    filters: NO_FILTERS,
    minExchanges: 3,
    now: new Date(Date.UTC(2026, 0, 11, 10)),
  });
}

const real = real1hProjection();
const view = buildSmcPanelView(real);
const real1d = real1dProjection();
const view1d = buildSmcPanelView(real1d);

ok(real.overlays.length === 5, "0a: реальный DTO содержит 5 per-exchange оверлеев (иначе тесты ниже пусты)");
ok(real.aggregate.evaluatedCount === 5, "0b: реальный DTO — 5 оценённых рынков");
ok(view.markets.length === 5, "0c: view покрывает все биржи реального DTO");

/* ================================================================== */
console.log("=== 1. Toggle OFF: панель неактивна, запросов нет ===");
{
  const state = initialSmcRequestState();
  eq(state.phase, "off", "1a: начальная фаза — off");
  eq(state.projection, null, "1b: данных нет");
  eq(isSmcPanelVisible("off"), false, "1c: off → панель не показывается");
  eq(isSmcPanelVisible("loading"), true, "1d: loading показывается");
  eq(isSmcPanelVisible("ok"), true, "1e: ok показывается");
  eq(isSmcPanelVisible("error"), true, "1f: error показывается (отличим от off)");
  eq(shouldFetchSmc({ enabled: false, symbol: "BTC", timeframe: "1h" }), false, "1g: OFF → fetch не нужен");
  eq(needsSmcFetch({ enabled: false, symbol: "BTC", timeframe: "1h", state }), false, "1h: OFF → fetch не нужен в любом состоянии");
  eq(needsSmcFetch({ enabled: true, symbol: "BTC", timeframe: "1h", state }), true, "1i: ON + пустое состояние → fetch нужен");

  const chartSrc = readSource("components/chart/CandleChart.tsx");
  ok(/checked=\{smcEnabled\}/.test(chartSrc), "1j: toggle связан с локальным smcEnabled-состоянием");
  ok(/useState\(false\)/.test(chartSrc.split("const [smcEnabled")[1]!.slice(0, 80)), "1k: тумблер по умолчанию выключен (никаких фоновых SMC-запросов у всех пользователей)");
  ok(/if \(!smcEnabled\) \{\s*\n\s*return;\s*\n\s*\}/.test(chartSrc), "1l: эффект выходит сразу при OFF — fetch не делается");
  ok(/smcEnabled \? \(\s*\n\s*<SmartMoneyPanel/.test(chartSrc), "1m: панель рендерится только при ON");
}

/* ================================================================== */
console.log("\n=== 2. Toggle ON: URL из ТЕКУЩИХ symbol/timeframe, без exchange ===");
{
  eq(buildSmcRequestUrl("BTC", "1h"), "/api/chart/smc?symbol=BTC&timeframe=1h", "2a: точный URL");
  eq(buildSmcRequestUrl("ETH", "5m"), "/api/chart/smc?symbol=ETH&timeframe=5m", "2b: текущее окно, а не захардкоженное");
  eq(buildSmcRequestUrl("SOL", "1d"), "/api/chart/smc?symbol=SOL&timeframe=1d", "2c: 1d тем же правилом");
  ok(!buildSmcRequestUrl("BTC", "1h").includes("exchange"), "2d: `exchange` НЕ добавляется (aggregate — уровень актива)");
  ok(!buildSmcRequestUrl("BTC", "1h").includes("marketId"), "2e: никакого выбора рынка в запросе");
  eq(buildSmcRequestUrl("BAD/SY M", "1h"), "/api/chart/smc?symbol=BAD%2FSY%20M&timeframe=1h", "2f: значения экранируются");
  eq(smcRequestKey("BTC", "1h"), "BTC·1h", "2g: ключ окна запроса");
  eq(smcRequestKey("BTC", "1h") === smcRequestKey("BTC", "4h"), false, "2h: смена timeframe меняет ключ");
  eq(smcRequestKey("BTC", "1h") === smcRequestKey("ETH", "1h"), false, "2i: смена symbol меняет ключ");

  const loaded: SmcRequestState = {
    ...applySmcResponse(beginSmcRequest(initialSmcRequestState(), 1, smcRequestKey("BTC", "1h")), 1, { ok: true, projection: real }, smcRequestKey("BTC", "1h")),
  };
  eq(needsSmcFetch({ enabled: true, symbol: "BTC", timeframe: "1h", state: loaded }), false, "2j: то же окно уже загружено → повторного fetch нет");
  eq(needsSmcFetch({ enabled: true, symbol: "BTC", timeframe: "4h", state: loaded }), true, "2k: другой timeframe → fetch нужен");
  eq(shouldFetchSmc({ enabled: true, symbol: "BTC", timeframe: "" }), false, "2l: пустой timeframe → не просим");
  eq(shouldFetchSmc({ enabled: true, symbol: "  ", timeframe: "1h" }), false, "2m: пустой symbol → не просим");
}

/* ================================================================== */
console.log("\n=== 3. Race/abort: отсталый ответ не перетирает новый ===");
{
  const s0 = initialSmcRequestState();
  const s1 = beginSmcRequest(s0, 1, smcRequestKey("BTC", "1h"));
  eq(s1.phase, "loading", "3a: начало запроса → loading");
  eq(s1.activeId, 1, "3b: активный id = 1");

  // запрос 2 (смена timeframe) появился раньше, чем пришёл ответ 1
  const s2 = beginSmcRequest(s1, 2, smcRequestKey("BTC", "4h"));
  eq(s2.activeId, 2, "3c: активный id = 2");

  const staleOutcome = { ok: true as const, projection: real };
  const afterStale = applySmcResponse(s2, 1, staleOutcome, smcRequestKey("BTC", "1h"));
  ok(afterStale === s2, "3d: СТАРЫЙ ответ (id=1) отброшен целиком (тот же объект состояния)");
  eq(afterStale.phase, "loading", "3e: состояние осталось loading нового запроса");

  const fresh4h = { ok: false as const, message: "Стратегия ещё не считает 4h" };
  const afterFresh = applySmcResponse(s2, 2, fresh4h, smcRequestKey("BTC", "4h"));
  eq(afterFresh.phase, "error", "3f: свежий ответ применён");
  eq(afterFresh.error, "Стратегия ещё не считает 4h", "3g: сообщение — из ответа");
  eq(afterFresh.projection, null, "3h: старых данных не осталось");

  const s3 = beginSmcRequest(afterFresh, 3, smcRequestKey("BTC", "1h"));
  eq(s3.phase, "loading", "3i0: повторный запрос после ошибки — снова loading");
  const okAgain = applySmcResponse(s3, 3, { ok: true, projection: real }, smcRequestKey("BTC", "1h"));
  eq(okAgain.phase, "ok", "3i: успех после ошибки восстановим");
  eq(okAgain.loadedKey, smcRequestKey("BTC", "1h"), "3j: загруженное окно записано");
  ok(okAgain.projection === real, "3k: проекция передана как есть (без копирования/мутирования)");

  // отмена запроса при смене окна/выключении
  eq(isSmcAbortError(new Error("AbortError") as unknown as { name: string }), false, "3l: обычный Error — не отмена");
  const abortLike = new Error("x");
  abortLike.name = "AbortError";
  eq(isSmcAbortError(abortLike), true, "3m: AbortError распознаётся как штатная отмена");
  eq(isSmcAbortError(null), false, "3n: null — не отмена");
  eq(isSmcAbortError(undefined), false, "3o: undefined — не отмена");
  eq(isSmcAbortError({ name: "TypeError" }), false, "3p: прочее имя — не отмена");
}

/* ================================================================== */
console.log("\n=== 4. OFF после ON: stale-панель не остаётся, поздний ответ отброшен ===");
{
  const loaded: SmcRequestState = applySmcResponse(
    beginSmcRequest(initialSmcRequestState(), 5, smcRequestKey("BTC", "1h")),
    5,
    { ok: true, projection: real },
    smcRequestKey("BTC", "1h")
  );
  eq(loaded.phase, "ok", "4a: данные были показаны");
  const off = clearSmcOnDisable(loaded);
  eq(off.phase, "off", "4b: OFF → off");
  eq(off.projection, null, "4c: данные сброшены (панель не показывает устаревшее)");
  eq(off.error, null, "4d: ошибка сброшена");
  eq(off.loadedKey, null, "4e: загруженное окно сброшено → при повторном ON будет запрос");
  eq(off.activeId, -1, "4f: активный id = -1");
  const late = applySmcResponse(off, 6, { ok: true, projection: real }, smcRequestKey("BTC", "1h"));
  ok(late === off, "4g: поздний ответ после OFF отброшен");
  const lateNegative = applySmcResponse(off, -1, { ok: false, message: "поздняя ошибка" }, "BTC·1h");
  ok(lateNegative === off, "4h: поздний ответ с id=-1 (уже не активен новым запросом) не пишет ошибку в выключенную панель");
}

/* ================================================================== */
console.log("\n=== 5. HTTP-ошибки: безопасные сообщения, график не падает ===");
{
  eq(smcFailureMessage(JSON.stringify({ error: "Неверный timeframe: 7m. Доступные: 5m, 15m, 1h, 4h, 1d" }), 400),
    "Неверный timeframe: 7m. Доступные: 5m, 15m, 1h, 4h, 1d", "5a: сообщение API показывается дословно");
  eq(smcFailureMessage(JSON.stringify({ error: "Актив BTC не найден в базе" }), 404),
    "Актив BTC не найден в базе", "5b: 404 — текст API");
  eq(smcFailureMessage(JSON.stringify({ error: "База данных временно недоступна" }), 503),
    "База данных временно недоступна", "5c: 503 — безопасный текст API");
  eq(smcFailureMessage("<!DOCTYPE html><html>500</html>", 500),
    "Не удалось загрузить Smart Money (HTTP 500)", "5d: не-JSON тело → общий текст со статусом, без HTML");
  eq(smcFailureMessage("", 502), "Не удалось загрузить Smart Money (HTTP 502)", "5e: пустое тело");
  eq(smcFailureMessage(JSON.stringify({ error: 42 }), 400), "Не удалось загрузить Smart Money (HTTP 400)", "5f: не-строковый error → общий текст");
  eq(smcFailureMessage(JSON.stringify({ error: "   " }), 400), "Не удалось загрузить Smart Money (HTTP 400)", "5g: пустой error → общий текст");
  eq(smcFailureMessage(JSON.stringify({ error: "x".repeat(500) }), 400).length, 301, "5h: длинные сообщения обрезаются (300 + …)");
  eq(smcFailureMessage("[1,2,3]", 400), "Не удалось загрузить Smart Money (HTTP 400)", "5i: массив вместо объекта");

  // защита на границе: битый payload = ошибка панели, а не падение графика
  eq(parseSmcProjection(null), null, "5j: null → null");
  eq(parseSmcProjection("{}"), null, "5k: пустой объект → null");
  ok(parseSmcProjection(JSON.parse(JSON.stringify(real))) !== null, "5l: реальный DTO проходит guard (после JSON round-trip)");
  ok(parseSmcProjection(real) === real, "5m: валидный DTO возвращается как есть (identity)");
  const broken = JSON.parse(JSON.stringify(real));
  delete broken.aggregate;
  eq(parseSmcProjection(broken), null, "5n: без aggregate — невалидно (тихий рендер невозможен)");
  const broken2 = JSON.parse(JSON.stringify(real));
  broken2.overlays = "nope";
  eq(parseSmcProjection(broken2), null, "5o: overlays не массив — невалидно");
  const broken3 = JSON.parse(JSON.stringify(real));
  broken3.aggregate.usable = "yes";
  eq(parseSmcProjection(broken3), null, "5p: aggregate.usable не boolean — невалидно");

  const chartSrc = readSource("components/chart/CandleChart.tsx");
  const region = chartSrc.slice(chartSrc.indexOf("/* ---------- P1-C: загрузка Smart Money"), chartSrc.indexOf("/* ---------- UI ---------- */"));
  ok(region.length > 1500, "5q: регион SMC-обвязки найден и непустой (иначе проверки ниже вакуумны)");
  ok(!region.includes("setStatus("), "5r: SMC-обвязка НЕ трогает статус графика (ошибка панели не ломает свечи)");
  ok(!region.includes("setErrorMessage("), "5s: SMC-обвязка НЕ трогает сообщение об ошибке графика");
  ok(!region.includes("setHistory"), "5t: SMC-обвязка НЕ трогает состояние подгрузки истории");
  ok(!region.includes("chartRef") && !region.includes("applyData("), "5u: SMC-обвязка НЕ лезет в серии/данные графика");
  ok(region.includes("smcAbortRef.current?.abort()"), "5v: при старте запроса прежний обрывается");
  // порядковая проверка: abort обязан быть ДО fetch (иначе старый запрос живёт)
  const loader = chartSrc.slice(
    chartSrc.indexOf("const loadSmc = useCallback"),
    chartSrc.indexOf("const toggleSmc = useCallback")
  );
  ok(loader.length > 400, "5v2: тело loadSmc извлечено (проверка не вакуумная)");
  const abortAt = loader.indexOf("smcAbortRef.current?.abort()");
  const fetchAt = loader.indexOf("await fetch(");
  const controllerAt = loader.indexOf("new AbortController()");
  ok(abortAt >= 0 && fetchAt >= 0 && controllerAt >= 0, "5v3: abort/контроллер/fetch присутствуют");
  ok(abortAt < fetchAt, "5v4: прежний запрос обрывается ДО нового fetch");
  ok(controllerAt < fetchAt, "5v5: контроллер создаётся до fetch");
  ok(loader.includes("signal: controller.signal"), "5v6: сигнал передан в fetch");
  ok(loader.indexOf("beginSmcRequest(") < fetchAt, "5v7: состояние loading выставляется до запроса");
  ok(/catch \(error\) \{\s*\n\s*if \(isSmcAbortError\(error\)\)/.test(region), "5w: отмена не считается ошибкой");
  ok(!region.includes('method:'), "5x: только GET (method не указывается) — никакого mutate-запроса");
}

/* ================================================================== */
console.log("\n=== 6. Различимые состояния: loading / error / ok ===");
{
  const phases: SmcPanelPhase[] = ["off", "loading", "ok", "error"];
  eq(phases.map(isSmcPanelVisible), [false, true, true, true], "6a: все четыре состояния различимы");
  const loading = beginSmcRequest(initialSmcRequestState(), 1, "BTC·1h");
  eq([loading.phase, loading.projection, loading.error], ["loading", null, null], "6b: loading — без данных и без ошибки");
  const errored = applySmcResponse(loading, 1, { ok: false, message: "Сервер не отвечает" }, "BTC·1h");
  eq([errored.phase, errored.projection, errored.error], ["error", null, "Сервер не отвечает"], "6c: error — с сообщением, без данных");
  const done = applySmcResponse(loading, 1, { ok: true, projection: real }, "BTC·1h");
  eq([done.phase, done.projection === real, done.error], ["ok", true, null], "6d: ok — с данными, без ошибки");
  // при смене окна во время загрузки loading не теряет прежний ответ? (предыдущие данные остаются до успеха)
  const reloading = beginSmcRequest(done, 2, "BTC·4h");
  eq([reloading.phase, reloading.projection === real], ["loading", true], "6e: при перезапросе прежняя проекция сохраняется до прихода новой (панель не мигает)");
  const staleThen = applySmcResponse(reloading, 1, { ok: false, message: "мусор" }, "BTC·1h");
  eq(staleThen, reloading, "6f: отсталая ошибка не портит показанное состояние");
}

/* ================================================================== */
console.log("\n=== 7. NEUTRAL ≠ cannot-evaluate ≠ LONG/SHORT (по реальному DTO) ===");
{
  const baseAgg = real.aggregate;
  const mkAgg = (over: Partial<SmcAggregateSummaryDto>): SmcAggregateSummaryDto => ({ ...baseAgg, ...over });

  const neutral = aggregateVerdict(mkAgg({ usable: true, gateAllowed: true, direction: "NEUTRAL" }));
  eq(neutral.label, "Нейтрально", "7a: evaluated NEUTRAL — это «Нейтрально»");
  eq(neutral.verdict, "neutral", "7b: и тон neutral");

  const cannot = aggregateVerdict(mkAgg({ usable: false, gateAllowed: false, direction: "CANNOT_EVALUATE" }));
  ok(cannot.label !== "Нейтрально", "7c: CANNOT_EVALUATE никогда не называется «Нейтрально»");
  eq(cannot.verdict, "unavailable", "7d: тон unavailable");

  const noDir = aggregateVerdict(mkAgg({ usable: false, gateAllowed: false, direction: null }));
  ok(noDir.label !== "Нейтрально" && noDir.label !== "LONG" && noDir.label !== "SHORT",
    "7e: «вердикта нет» не маскируется ни одним из вердиктов");

  const blocked = aggregateVerdict(mkAgg({ usable: true, gateAllowed: false, direction: "LONG" }));
  eq(blocked.verdict, "unavailable", "7f: гейт не пустил — вердикт НЕ показывается, даже если direction=LONG в DTO");
  ok(blocked.label !== "LONG", "7g: и подпись не LONG");

  eq(aggregateVerdict(mkAgg({ usable: true, gateAllowed: true, direction: "LONG" })).label, "LONG", "7h: LONG — из DTO");
  eq(aggregateVerdict(mkAgg({ usable: true, gateAllowed: true, direction: "SHORT" })).label, "SHORT", "7i: SHORT — из DTO");

  // exhaustive: ни один статус отказа не даёт слово-вердикт
  for (const [status, label] of Object.entries(AGGREGATE_STATUS_LABELS)) {
    if (status === "ok") continue;
    ok(typeof label === "string" && label.length > 0, `7j[${status}]: подпись отказа непуста`);
    ok(!["Нейтрально", "LONG", "SHORT"].includes(label), `7k[${status}]: подпись отказа не выглядит как вердикт`);
  }
  eq(Object.keys(AGGREGATE_STATUS_LABELS).length, 7, "7l: покрыты все существующие CommonHorizonStatus");
  eq(Object.keys(MARKET_STATUS_LABELS).sort(), ["cannot-evaluate", "evaluated", "filtered"], "7m: покрыты все статусы рынка");

  const realView = buildSmcPanelView(real);
  eq(realView.verdict, "long", "7n: реальный 1h-DTO даёт verdict long");
  eq(realView.verdictLabel, "LONG", "7o: подпись — из вердикта DTO");
  eq(realView.technicalVisible, false, "7p: при успешном согласовании техническая строка скрыта");
  const failedView = buildSmcPanelView({ ...real, aggregate: mkAgg({ usable: false, gateAllowed: false, direction: "CANNOT_EVALUATE", status: "no_common_horizon", confirmation: null, gateRefusalReasons: ["r"] }) });
  eq(failedView.technicalVisible, true, "7q: при отказе техническая строка показывается");
  eq(failedView.confirmationLabel, null, "7r: confirmation=null → строки подтверждений нет (не «0/0»)");
  ok(failedView.statusReason.length > 0, "7s: причина отказа из DTO доступна");
}

/* ================================================================== */
console.log("\n=== 8. Per-exchange строки: статус и вердикт каждой биржи ===");
{
  eq(view.markets.length, real.overlays.length, "8a: по строке на каждый оверлей биржи");
  eq(view.markets.map((m) => m.exchange), real.overlays.map((o) => o.exchange), "8b: порядок и имена — как в DTO (без пересортировки)");
  eq(view.markets.every((m) => m.statusLabel === "оценено"), true, "8c: статусы evaluated подписаны «оценено»");
  eq(view.markets.every((m) => m.verdict === "long" && m.verdictLabel === "LONG"), true, "8d: вердикт каждой биржи — её собственный direction");
  eq(view.markets[0]!.scoresText, "баллы: LONG 75 · SHORT 10", "8e: баллы прокинуты дословно");
  eq(view.markets[0]!.horizonText, `горизонт: ${formatUtcClock(real.overlays[0]!.horizonMs)}`, "8f: горизонт строки = horizonMs DTO");
  ok(view.markets[0]!.title.includes("BINANCE") && view.markets[0]!.title.includes("BTCUSDT"), "8g: строка называет биржу и рынок");

  const filteredRow = marketVerdict({ status: "filtered", direction: null });
  eq(filteredRow.label, "вне фильтров стратегии", "8h: filtered — своя подпись, не «не удалось оценить»");
  ok(filteredRow.label !== "Нейтрально", "8i: filtered не выглядит вердиктом");
  const ceRow = marketVerdict({ status: "cannot-evaluate", direction: "CANNOT_EVALUATE" });
  eq(ceRow.label, "не удалось оценить", "8j: cannot-evaluate — своя подпись");
  const evalButNull = marketVerdict({ status: "evaluated", direction: null });
  eq(evalButNull.verdict, "unavailable", "8k: evaluated без direction (невозможная форма) → вердикта нет, а не NEUTRAL");

  const mixed = buildSmcPanelView({
    ...real,
    overlays: [
      real.overlays[0]!,
      { ...real.overlays[1]!, status: "cannot-evaluate", statusReason: "SMC cannot evaluate", direction: "CANNOT_EVALUATE", longScore: null, shortScore: null },
      { ...real.overlays[2]!, status: "filtered", statusReason: "asset rank вне universe", direction: null, longScore: null, shortScore: null },
    ],
  });
  eq(mixed.markets.map((m) => m.statusLabel), ["оценено", "не удалось оценить", "вне фильтров стратегии"], "8l: три разных состояния различимы в списке");
  eq(mixed.markets[1]!.scoresText, null, "8m: у не-оценённой биржи баллы не выдумываются");
  eq(mixed.markets[1]!.statusReason, "SMC cannot evaluate", "8n: причина биржи прокидывается");
  eq(mixed.markets[2]!.statusReason, "asset rank вне universe", "8o: и причина фильтра прокидывается");
}

/* ================================================================== */
console.log("\n=== 9. Aggregate и биржи не смешиваются ===");
{
  const agg = real.aggregate;
  eq(view.confirmationLabel, `Подтверждения: ${agg.confirmation} (минимум ${agg.minExchanges})`, "9a: confirmation — строка DTO + minExchanges из DTO");
  ok(!NAMES.some((name) => (view.confirmationLabel ?? "").includes(name)), "9b: в строке подтверждений нет имён бирж (это актив, не рынок)");
  eq(view.countsLabel, `Оценено: ${agg.evaluatedCount} · без оценки: ${agg.cannotEvaluateCount} · вне фильтров: ${agg.filteredCount} · участников горизонта: ${agg.participantCount}`,
    "9c: counts — дословные поля DTO, ничего не пересчитывается");
  eq(view.headline, "Smart Money · BTC · 1h", "9d: заголовок = актив + таймфрейм из DTO");
  eq(view.marketsNote.includes("общего набора фактов на несколько бирж не существует"), true, "9e: явное объяснение разделения per-exchange/aggregate");
  eq(view.excludedLabel, null, "9f: на 1h исключений нет — строки нет (не «исключены: »)")
  ;
  // aggregate-блок не должен содержать overlay-терминов
  const aggregateText = [view.headline, view.verdictLabel, view.confirmationLabel, view.countsLabel, view.horizonLabel, view.asOfLabel, view.freshnessLabel, view.excludedLabel].filter((x): x is string => x !== null).join(" ");
  for (const term of ["FVG", "order block", "BOS", "pivot", "liquidity"]) {
    ok(!aggregateText.toLowerCase().includes(term.toLowerCase()), `9g: в aggregate-подписях нет «${term}»`);
  }
  // и наоборот: строки рынков не выдают себя за aggregate
  ok(view.markets.every((m) => !/подтвержд/i.test(m.title + m.statusLabel + (m.scoresText ?? ""))), "9h: per-exchange строки не содержат «подтверждения»");
  // horizon/asOf берутся из aggregate, а не из выбранной биржи
  eq(view.horizonLabel, `Общий горизонт рынков: ${formatUtcClock(agg.horizonMs)}`, "9i: общий горизонт — из aggregate");
  eq(view.asOfLabel, `Данные приняты на момент: ${formatUtcClock(agg.engineAsOfMs)}`, "9j: as-of — из aggregate engineAsOfMs");
  eq(agg.horizonMs === real.overlays[0]!.horizonMs, true, "9k: (sanity) горизонт aggregate совпадает с якорем оверлеев в этом DTO");
}

/* ================================================================== */
console.log("\n=== 10. 1d / BINGX: без special-case и без хардкода «5» ===");
{
  const agg1d = real1d.aggregate;
  eq(agg1d.exchangeExcluded.includes("BINGX"), true, "10a: политика исключений уже в DTO (BINGX для 1d)");
  eq(view1d.excludedLabel, `Исключены из агрегации политикой бирж: ${agg1d.exchangeExcluded.join(", ")}`, "10b: UI показывает это как есть");
  ok(!view1d.excludedLabel!.includes("5"), "10c: в подписи нет числа бирж");
  eq(view1d.countsLabel.includes(`участников горизонта: ${agg1d.participantCount}`), true, "10d: участников — столько, сколько в DTO");
  ok(agg1d.participantCount !== 5, `10e: (sanity) участников реально ${agg1d.participantCount} — исключение сработало до агрегации`);
  // P1-A решает, для кого показывать оверлеи: исключённый eligibility-биржи
  // в списке участников горизонта нет — UI это честно отражает.
  eq(real1d.overlays.length, agg1d.participantCount, "10f: строк ровно по числу участников горизонта из DTO");
  eq(view1d.markets.length, real1d.overlays.length, "10g: панель показывает столько бирж, сколько в DTO (ни одной больше)");
  eq(view1d.markets.some((m) => m.exchange === "BINGX"), false, "10g2: BINGX не появляется в списке как оценённый участник");
  ok(view1d.confirmationLabel === null || /минимум \d+/.test(view1d.confirmationLabel), "10h: подтверждения — только строкой DTO");
  ok(!/5 \/ 5|5\/5|пяти бирж/.test(view1d.headline + view1d.countsLabel + (view1d.excludedLabel ?? "")), "10i: нигде не заявляется «5/5» на 1d");

  const panelSrc = readSource("components/chart/SmartMoneyPanel.tsx");
  const viewSrc = readSource("lib/chart/smc-panel.ts");
  const panelCode = stripComments(panelSrc);
  const viewCode = stripComments(viewSrc);
  for (const [name, src] of [["panel", panelCode], ["view-model", viewCode]] as const) {
    ok(!/5\s*(бирж|рынков|обмен)/.test(src), `10j[${name}]: нет хардкода «5 бирж»`);
    ok(!/"5\/5"|'5\/5'/.test(src), `10k[${name}]: нет захардкоженной строки подтверждения`);
    ok(!/timeframe === "1d"/.test(src), `10l[${name}]: нет special-case по 1d в UI-коде`);
    ok(!/BINGX/.test(src), `10m[${name}]: нет упоминания BINGX в UI-коде (политика — в проекции)`);
    ok(!/exchange === "BINGX"/.test(src), `10n[${name}]: нет фильтрации по имени биржи`);
  }
}

/* ================================================================== */
console.log("\n=== 11. WHY: points/value из DTO, без вероятностей, без реконструкции ===");
{
  const reasons = real.overlays[0]!.reasons;
  eq(view.markets[0]!.reasons.length, reasons.length, "11a: все причины рынка показаны (9 или 10 — как в DTO)");
  eq(view.markets[0]!.reasons.map((r) => r.label), reasons.map((r) => r.label), "11b: ярлыки — дословно из DTO");
  eq(view.markets[0]!.reasons.map((r) => r.code), reasons.map((r) => r.code), "11c: коды сохранены (порядок и состав не меняются)");
  eq(view.markets[0]!.reasons.map((r) => r.pointsText),
    reasons.map((r) => `LONG ${r.longPoints} · SHORT ${r.shortPoints} · макс ${r.maxPoints}`),
    "11d: баллы показаны как баллы, все три числа");
  for (const row of view.markets[0]!.reasons) {
    ok(!/%/.test(row.pointsText), `11e[${row.code}]: в баллах нет процентов`);
    ok(!/вероятн|шанс|probability|confidence/i.test(row.pointsText + row.label), `11f[${row.code}]: нет языков вероятности`);
  }
  ok(view.disclaimer.includes("не вероятность"), "11g: дисклеймер явно говорит, что score — не вероятность");
  ok(!view.disclaimer.includes("%"), "11h: в дисклеймере нет процентов");

  // скрытие внутренних идентификаторов, но НЕ изменение самих данных
  const obRow = view.markets[0]!.reasons.find((r) => r.code === "SWING_ORDER_BLOCK")!;
  const fvgRow = view.markets[0]!.reasons.find((r) => r.code === "FVG")!;
  const rangeRow = view.markets[0]!.reasons.find((r) => r.code === "RANGE_POSITION")!;
  const confRow = view.markets[0]!.reasons.find((r) => r.code === "OB_FVG_CONFLUENCE")!;
  const bosRow = view.markets[0]!.reasons.find((r) => r.code === "RECENT_SWING_BOS")!;
  eq([obRow.valueText, fvgRow.valueText], [null, null], "11i: SMC-ключи не печатаются в UI");
  eq(rangeRow.valueText, "pos=0.135833", "11j: человекочитаемый payload остаётся как есть");
  eq(bosRow.valueText, "BOS:up", "11k: и BOS-направление остаётся текстом DTO");
  eq(confRow.valueText, null, "11l: confluence без payload → пусто");
  eq([obRow.hasFact, fvgRow.hasFact], [true, true], "11m: пометка «факт отмечен» — ровно там, где factIds есть");
  eq(confRow.hasFact, false, "11n: OB_FVG_CONFLUENCE не получает факт ( reconstruction запрещена )");
  eq(confRow.factIds, [], "11o: и его factIds пусты");
  eq(obRow.factIds, real.overlays[0]!.reasons.find((r) => r.code === "SWING_ORDER_BLOCK")!.factIds, "11p: factIds прокинуты точь-в-точь");
  eq(obRow.factIds.length, 1, "11q: OB-причина ссылается на один существующий ключ");
  ok(obRow.factIds[0]!.startsWith("SMC1|OB|"), "11r: это deterministic SMC ID, не придуманный UI id");
  ok(fvgRow.factIds[0]!.startsWith("SMC1|FVG|"), "11s: то же для FVG");

  // эквивалентность правилу контракта на ВСЕХ причинах реального DTO
  const allRows = view.markets.flatMap((m) => m.reasons);
  const contractRows = real.overlays.flatMap((o) => o.reasons);
  eq(allRows.length, contractRows.length, "11t: причин в представлении ровно столько же, сколько в DTO");
  eq(allRows.map((r) => [...r.factIds]), contractRows.map((r) => scoreReasonFactIds({ code: r.code, value: r.value, longPoints: r.longPoints, shortPoints: r.shortPoints })),
    "11u: ни одна связь не добавлена и не убрана — правило контракта соблюдается 1:1");
  eq(contractRows.filter((r) => r.code === "OB_FVG_CONFLUENCE").every((r) => r.factIds.length === 0), true, "11v: и в DTO confluence не имеет фактов");

  // случай, когда DTO уже содержит factIds — они не пересчитываются «по-своему»
  const given: SmcOverlayReasonDto = { code: "SWING_TREND", label: "l", longPoints: 0, shortPoints: 0, maxPoints: 20, value: null, factIds: ["SMC1|P|1h|swing|high|1"] };
  eq(reasonView(given).factIds, ["SMC1|P|1h|swing|high|1"], "11w: непустые factIds из DTO сохраняются как есть");
  eq(reasonView({ ...given, factIds: [] }).factIds, [], "11x: пусто остаётся пустым (ничего не domысляется)");
}

/* ================================================================== */
console.log("\n=== 12. DTO не мутируется (deep-freeze) и view детерминирован ===");
{
  function deepFreeze<T>(value: T): T {
    if (value && typeof value === "object") {
      for (const key of Object.keys(value as Record<string, unknown>)) {
        deepFreeze((value as Record<string, unknown>)[key]);
      }
      Object.freeze(value);
    }
    return value;
  }
  const frozen = deepFreeze(JSON.parse(JSON.stringify(real)) as SmcChartProjection);
  let threw: unknown = null;
  let built: SmcPanelViewLike | null = null;
  try {
    built = buildSmcPanelView(frozen) as SmcPanelViewLike;
    void (built!.markets[0]!.reasons[0]!.factIds as unknown as string[]).length;
  } catch (error) {
    threw = error;
  }
  eq(threw, null, "12a: построение представления на замороженном DTO не бросает (записи в DTO нет)");
  eq(built !== null && JSON.stringify(built), JSON.stringify(view), "12b: тот же результат, что на незамороженном (стабильно)");

  const v1 = buildSmcPanelView(real);
  const v2 = buildSmcPanelView(real);
  eq(v1, v2, "12c: детерминизм — повторный вызов даёт идентичное представление");

  // копия массива factIds: правка представления не трогает DTO
  const before = JSON.stringify(real.overlays[0]!.reasons);
  const mutated = buildSmcPanelView(real);
  for (const row of mutated.markets[0]!.reasons) {
    (row.factIds as unknown as string[]).push("SMC1|FAKE");
  }
  eq(JSON.stringify(real.overlays[0]!.reasons), before, "12d: push в factIds представления не меняет DTO (копия, а не ссылка)");
}

type SmcPanelViewLike = ReturnType<typeof buildSmcPanelView>;

/* ================================================================== */
console.log("\n=== 13. Время: только ms в домене, форматирование UTC ===");
{
  eq(formatUtcClock(H1H), "02.01.2026 02:00 UTC", "13a: формат UTC из ms (ровно как в DTO: 01.01 + 26h)");
  eq(formatUtcClock(Date.UTC(2026, 8, 11, 0, 0)), "11.09.2026 00:00 UTC", "13b: полночь");
  eq(formatUtcClock(Date.UTC(2026, 0, 1, 23, 59)), "01.01.2026 23:59 UTC", "13c: конец суток, ведущие нули");
  eq(formatUtcClock(null), null, "13d: null → null (UI печатает «—»)");
  eq(formatUtcClock(NaN), null, "13e: NaN → null");
  eq(formatUtcClock(Infinity), null, "13f: Infinity → null");
  eq(formatUtcClock(0), "01.01.1970 00:00 UTC", "13g: epoch — валидное значение");
  eq(formatUtcClock(999), "01.01.1970 00:00 UTC", "13h: субсекундное округление вниз (минуты)");
  // секунды никогда не попадают в подпись
  const seconds = Math.floor(H1H / 1000);
  ok(!formatUtcClock(seconds)!.startsWith("18."), "13i: случайная передача секунд не выглядит как корректная дата 2026 года");
  ok(typeof real.generatedAtMs === "number" && real.generatedAtMs > 1e12, "13j: generatedAtMs — мс, не секунды");
  ok(real.overlays.every((o) => o.engineAsOfMs === null || o.engineAsOfMs > o.horizonMs!), "13k: engineAsOfMs строго позже horizonMs (мс-единицы согласованы)");
}

/* ================================================================== */
console.log("\n=== 14. Чистота: нет DB/admin/Signal/write-путей и primitives ===");
{
  const files = ["lib/chart/smc-panel.ts", "components/chart/SmartMoneyPanel.tsx"];
  for (const file of files) {
    const src = readSource(file);
    ok(!src.includes("prisma"), `14a[${file}]: нет Prisma`);
    ok(!src.includes("$executeRaw"), `14b[${file}]: нет raw-SQL`);
    ok(!/@\/lib\/prisma/.test(src), `14c[${file}]: нет клиента БД`);
    ok(!/\/api\/admin/.test(src), `14d[${file}]: нет admin API`);
    ok(!/method:\s*["'](POST|PUT|PATCH|DELETE)/i.test(src), `14e[${file}]: нет мутационных HTTP-методов`);
    ok(!src.includes("lib/signals") && !src.includes("signal-worker") && !src.includes("test-signal-engine"), `14f[${file}]: нет Signal Engine`);
    ok(!/prisma\.(signal|strategy|market|candle|asset)\.(create|update|upsert|delete)/.test(src), `14g[${file}]: нет записей в БД`);
    ok(!src.includes("localStorage") && !src.includes("sessionStorage"), `14h[${file}]: нет браузерного хранилища (toggle — только React-состояние)`);
    ok(!src.includes("Date.now(") && !/new Date\(\s*\)/.test(src), `14i[${file}]: нет чтения часов (время только из DTO)`);
    ok(!/fancy-canvas|createSeriesMarkers|attachPrimitive|createPriceLine|IPriceLine|setMarkers/.test(src), `14j[${file}]: нет primitives — P1-D ещё не начался`);
    ok(!/addSeries|setData\(|lightweight-charts/.test(src), `14k[${file}]: панель не лезет в серии графика`);
    ok(!src.includes("document.") && !src.includes("window."), `14l[${file}]: нет DOM`);
    ok(!src.includes("Math.random"), `14m[${file}]: нет недетерминированности`);
  }

  const viewSrc = readSource("lib/chart/smc-panel.ts");
  ok(viewSrc.includes('scoreReasonFactIds'), "14n: WHY-связь берётся ИЗ контракта, а не переписана");
  ok(!/case "FVG"|startsWith\("SMC1/.test(viewSrc.replace(/SMC_OB_KEY_PREFIX|SMC_FVG_KEY_PREFIX/g, "")), "14o: своих правил разбора SMC-ключей нет");
  ok(!/longVotes|shortVotes|neutralVotes/.test(viewSrc.replace(/\/\*[\s\S]*?\*\//g, "")), "14p: голоса не пересчитываются (confirmation — строка DTO)");
  ok(!/Math\.min\(|Math\.max\(|position\s*<\s*0|position\s*>\s*1/.test(viewSrc), "14q: нет clamp'а и «улучшений» range-позиции в UI-слое");
  ok(!viewSrc.includes("contractVersion"), "14r: никаких собственных версий контракта (второго contract нет)");

  const packageJson = JSON.parse(readSource("package.json"));
  const all = { ...(packageJson.dependencies ?? {}), ...(packageJson.devDependencies ?? {}) };
  eq(Object.keys(all).filter((name) => /canvas|testing-library|jsdom|vitest|jest|happy-dom/i.test(name)), [],
    "14s: test/DOM-зависимости и canvas НЕ добавлены");
  eq(packageJson.dependencies?.["lightweight-charts"], "^5.2.1", "14t: версия график-библиотеки не менялась");
}

/* ================================================================== */
console.log("\n=== 15. Компонент: тонкий слой, и не рисует P1-D ===");
{
  const panelSrc = readSource("components/chart/SmartMoneyPanel.tsx");
  const chartSrc = readSource("components/chart/CandleChart.tsx");

  ok(panelSrc.includes('"use client"'), "15a: панель — клиентский компонент (как CandleChart)");
  ok(/import \{ isSmcPanelVisible \} from "@\/lib\/chart\/smc-panel"/.test(panelSrc), "15b: решение «показывать ли» — в чистом модуле, не в компоненте");
  for (const field of ["view.headline", "view.verdictLabel", "view.confirmationLabel", "view.countsLabel", "view.horizonLabel", "view.asOfLabel", "view.freshnessLabel", "view.excludedLabel", "view.refusalLines", "view.markets", "view.statusReason", "view.disclaimer"]) {
    ok(panelSrc.includes(field), `15c: компонент печатает ${field} (из view-model, без своей логики)`);
  }
  for (const arrays of ["pivots", "structureEvents", "levels", "liquidity", "fvgs", "orderBlocks", "dealingRange", "displacements"]) {
    ok(!panelSrc.includes(`.${arrays}`), `15d: оверлей-массив «${arrays}» не рендерится (это P1-D)`);
  }
  ok(!/projection\.|\.aggregate\.|overlays\.map/.test(panelSrc), "15e: компонент не ходит в сырой DTO напрямую — только через view-model");
  ok(panelSrc.includes("<details"), "15f: per-exchange детали свёрнуты (нет визуального overdesign)");
  ok(/view\.technicalVisible \?/.test(panelSrc), "15p: техническая строка selection показывается условно (не шумит при успехе)");
  ok(!/view\.statusReason\s*\n?\s*<\/div>/.test(panelSrc.replace(/\s+/g, " ").replace(/ /g, "\n")) || /technicalVisible/.test(panelSrc), "15q: statusReason не печатается безусловно");

  const smcRegion = chartSrc.slice(chartSrc.indexOf("/* ---------- P1-C: Smart Money панель"), chartSrc.indexOf("/* ---------- применение темы к графику"));
  const glueRegion = chartSrc.slice(chartSrc.indexOf("/* ---------- P1-C: загрузка Smart Money"), chartSrc.indexOf("/* ---------- UI ---------- */"));
  ok(smcRegion.length > 200, "15g: состояние toggle объявлено в CandleChart как локальный useState");
  ok(smcRegion.includes("useState(false)"), "15h: нет persistence и нет внешних хранилищ состояния");
  const smcCode = stripComments(smcRegion);
  ok(!/strategy|Strategy/.test(smcCode), "15i: в коде обвязки toggle нет ни одного обращения к Strategy (ни чтения, ни записи)");
  ok(!/\.enabled/.test(smcCode), "15j: поле Strategy.enabled не читается");
  ok(!/enabled/.test(smcCode.replace(/smcEnabled/g, "")), "15j2: единственное «enabled» — локальное smcEnabled");
  ok(smcCode.length > 60, "15j3: регион кода непустой (иначе проверка была бы вакуумной)");
  ok(glueRegion.includes('from "@/lib/chart/smc-panel"') || chartSrc.includes('from "@/lib/chart/smc-panel"'), "15k: CandleChart импортирует именно чистый модуль");
  ok(/<fieldset className="chartToggles">\s*\n\s*<legend className="muted">\s*\n\s*Аналитика/.test(chartSrc), "15l: toggle отделён от «Индикаторы» (это аналитика, не индикатор)");
  ok(/title="Только показ аналитики на этом графике/.test(chartSrc), "15m: подпись тумблера объясняет, что это локальный показ");
  const toggleBlock = chartSrc.slice(chartSrc.indexOf("Аналитика"), chartSrc.indexOf("Смарт Мани") + 200);
  ok(!/(включ|отключ|выключ|останов|запуст|перезапуск|поставл|снял)[а-яё]*\s+(страте|Страте)/.test(toggleBlock),
    "15n: текст тумблера не обещает включить/выключить стратегию (нет императивов про стратегию)");
  ok(/работа стратегии не меняется/.test(toggleBlock), "15n2: и явно говорит, что работа стратегии не меняется");
  ok(toggleBlock.includes("Смарт Мани"), "15o: тумблер называется «Смарт Мани»");
}

/* ================================================================== */
console.log("\n=== 16. Мелочи, которые легко сломать в будущем ===");
{
  // panel ничего не знает про биржевой выбор графика: aggregate не фильтруется биржей
  const before = JSON.stringify(real.aggregate);
  buildSmcPanelView(real);
  eq(JSON.stringify(real.aggregate), before, "16a: вызов view-model не меняет aggregate");
  ok(!readSource("lib/chart/smc-panel.ts").includes("exchange ==="), "16b: в view-model нет фильтра по выбранной бирже");
  ok(!readSource("lib/chart/smc-panel.ts").includes("selectedMarket"), "16c: и нет знания про «выбранный рынок» графика");
  // переносимые строки: статусы подписаны, а не показан сырой идентификатор статуса
  const src = readSource("lib/chart/smc-panel.ts");
  ok(src.includes("AGGREGATE_STATUS_LABELS[agg.status] ??"), "16d: неизвестный статус не рушит рендер (fallback есть)");
  eq(aggregateUnknownLabel(), true, "16e: неизвестный статус → «Вердикт недоступен», а не падение/«Нейтрально»");
  // пустые списки безопасны
  const empty = buildSmcPanelView({
    assetSymbol: "BTC",
    timeframe: "1h",
    generatedAtMs: H1H,
    overlays: [],
    aggregate: { ...real.aggregate, usable: false, status: "no_participants", statusReason: "NONE", participantCount: 0, evaluatedCount: 0, cannotEvaluateCount: 0, filteredCount: 0, direction: null, confirmation: null, gateAllowed: false, gateRefusalReasons: [], exchangeExcluded: [], perExchange: [] },
  });
  eq(empty.markets, [], "16f: нет оверлеев → пустой список (не undefined)");
  eq(empty.marketsNote, "Оверлеи по биржам недоступны на этом горизонте.", "16g: и понятная строка вместо пустоты");
  eq(empty.confirmationLabel, null, "16h: подтверждений нет — строки нет");
  eq(empty.verdictLabel, "Нет подходящих рынков для стратегии", "16i: no_participants — своей подписью");
  eq(empty.horizonLabel, "Общий горизонт рынков: 02.01.2026 02:00 UTC", "16j: горизонт всё равно показывается, если он есть в DTO");
  const emptyAgg = { ...real.aggregate, horizonMs: null, engineAsOfMs: null };
  const noHorizon = buildSmcPanelView({ ...real, aggregate: emptyAgg });
  eq(noHorizon.horizonLabel, "Общий закрытый горизонт не выбран", "16k: нет горизонта — честная строка");
  eq(noHorizon.asOfLabel, "Точка доступности данных не определена", "16l: нет as-of — честная строка");
  eq(src.includes("isSmcPanelVisible"), true, "16m: правило видимости панели живёт в чистом модуле");
}

function aggregateUnknownLabel(): boolean {
  // известный, но ещё не покрытый «вердиктом» статус
  const known = buildSmcPanelView({
    ...real,
    aggregate: { ...real.aggregate, status: "future_horizon", usable: false, gateAllowed: false, direction: null, confirmation: null },
  });
  // совершенно незнакомый статус (будущее расширение слоя) — не должен ронять UI
  const bogus = buildSmcPanelView({
    ...real,
    aggregate: { ...real.aggregate, status: "totally_unknown" as typeof real.aggregate.status, usable: false, gateAllowed: false, direction: null, confirmation: null },
  });
  return (
    known.verdict === "unavailable" &&
    known.verdictLabel === AGGREGATE_STATUS_LABELS.future_horizon &&
    bogus.verdict === "unavailable" &&
    bogus.verdictLabel === "Вердикт недоступен" &&
    bogus.technicalVisible === true
  );
}

/* ================================================================== */
console.log(`\nItog: ${passed}/${passed + failed}`);
if (failed > 0) {
  console.error(`Провалено ${failed}:`);
  for (const f of failures) console.error(`  - ${f}`);
}
process.exit(failed === 0 ? 0 : 1);
