/**
 * P1-C — Smart Money UI integration: детерминированные проверки.
 *
 * Запуск: npx tsx scripts/test-smc-panel.ts
 *
 * ПРИНЦИПЫ (без placeholder/vacuous-тестов):
 *  - проекции для view-model берутся РЕАЛЬНЫЕ: принятый P1-B сервис
 *    buildSmcChartProjection на детерминированном read-only fake deps
 *    (только findUnique/findFirst/findMany) — БЕЗ production БД и БЕЗ её
 *    мутаций; у fake нет write-методов, поэтому любая попытка записи
 *    падает TypeError (поведенческий no-write гарант). Деградация
 *    fixture в cannot-evaluate там, где ожидается оценка, — падение
 *    теста, а не mock-ветка;
 *  - request/race-логика проверяется на чистой машине состояний
 *    reduceSmcState (React не нужен): toggle OFF/ON, смена symbol/
 *    timeframe, устаревший ответ, abort, unmount, сетевая ошибка,
 *    битый 200;
 *  - рендер панели проверяется через react-dom/server
 *    (renderToStaticMarkup) — это СУЩЕСТВУЮЩАЯ зависимость проекта,
 *    новых test-зависимостей нет, DOM-фреймворк не добавляется;
 *  - статические проверки читают исходники от корня проекта
 *    (import.meta.url); сбой чтения = падение теста;
 *  - покрытия: 18 обязательных пунктов P1-C (нумерация в метках —
 *    «(1)»…«(18)»).
 *
 * Временные якоря — те же, что в принятых P1-A/P1-B тестах:
 *  - 1h canonical: openTime 2026-01-01T00:00Z + i*1h
 *  - 5m: T = 2026-09-11T09:50Z, now = 09:55Z
 *  - 1d: now = 2026-09-11T10:00Z, ожидаемый latest CLOSED = 2026-09-10T00:00Z
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  buildSmcChartProjection,
  type SmcChartApiAssetRow,
  type SmcChartApiCandleRow,
  type SmcChartApiDeps,
  type SmcChartApiMarketRow,
  type SmcChartApiStrategyRow,
} from "../lib/chart/smc-api-service";
import type {
  SmcAggregateSummaryDto,
  SmcChartProjection,
} from "../lib/chart/smc-contract";
import { SMART_MONEY_SLUG } from "../lib/strategies/smart-money";
import { SMCTIMEFRAME_MS, type SmcRawCandle } from "../lib/smc/types";

import {
  SMC_API_PATH,
  SMC_HORIZON_STATUS_LABELS,
  SMC_NETWORK_ERROR_MESSAGE,
  SMC_PANEL_OFF,
  SMC_VERDICT_LABELS,
  SMC_VERDICT_NOTES,
  SmartMoneyPanel,
  buildSmcPanelViewModel,
  buildSmcRequestUrl,
  createSmcControllerState,
  formatSmcScore,
  formatSmcUtcMs,
  isSmcAbortError,
  isSmcRequestReady,
  parseSmcBody,
  reduceSmcState,
  smcAggregateVerdict,
  smcDirectionLabel,
  smcHttpErrorMessage,
  smcMarketStatusLabel,
  toSmcWhyRows,
  type SmcControllerState,
  type SmcPanelState,
  type SmcPanelViewModel,
} from "../components/chart/SmartMoneyPanel";

/**
 * tsx/esbuild при tsconfig `jsx: "preserve"` трансформирует JSX в
 * classic React.createElement (Next в production использует automatic
 * runtime, поэтому в компоненте React не импортирован). Тестовый shim
 * даёт classic-трансформе ссылку на React в global scope — на
 * production-код и на сборку Next не влияет.
 */
(globalThis as { React?: unknown }).React = React;

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

// ------------------------------------------------------------ source reader
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
    throw new Error(`пустой исходник ${relPath} — тест не пройден`);
  }
  return text;
}

/**
 * Удаление комментариев перед статическим сканом: в пояснениях P1-C
 * сознательно названы запрещённые сущности (Prisma/Signal/BINGX и т.д.),
 * поэтому сканируется только КОД.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

function extractBetween(
  text: string,
  startMarker: string,
  endMarker: string,
  label: string
): string {
  const start = text.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`${label}: не найден стартовый маркер ${startMarker}`);
  }
  const end = text.indexOf(endMarker, start + startMarker.length);
  if (end === -1) {
    throw new Error(`${label}: не найден концевой маркер ${endMarker}`);
  }
  return text.slice(start, end);
}

/** Все строки произвольной структуры (для скана формулировок). */
function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
  return out;
}

/** Запрещённые формулировки: score — не вероятность и не процент. */
const FORBIDDEN_CLAIMS =
  /вероятн|шанс|probabilit|likelihood|chance|гарантир|предсказан|прогноз/i;

// ------------------------------------------------------------ fixtures (те же, что в P1-A/P1-B)
const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;
const EPOCH = Date.UTC(2026, 8, 11);
const T_5M = EPOCH + 9 * HOUR + 50 * 60_000; // 09:50Z
const NOW_5M = EPOCH + 9 * HOUR + 55 * 60_000; // 09:55Z
const D_NOW = Date.UTC(2026, 8, 11, 10, 0, 0);
const D_EXPECTED = Date.UTC(2026, 8, 10);
const NAMES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];

function mk(
  i: number,
  o: number,
  c: number,
  high?: number,
  low?: number
): SmcRawCandle {
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

/** Реально evaluable fixture: при окнах 1/1 даёт LONG 75/10. */
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

/**
 * Точное зеркальное отражение цены (p → K − p, high ↔ low): тот же
 * рынок наоборот. Даёт реально оцениваемый SHORT 10/75 — проверка
 * SHORT идёт на настоящем прогоне движка, а не на подделанном DTO.
 */
const MIRROR_K = 200;
function mirrored(candles: SmcRawCandle[]): SmcRawCandle[] {
  return candles.map((c) => ({
    ...c,
    open: MIRROR_K - c.open,
    close: MIRROR_K - c.close,
    high: MIRROR_K - c.low,
    low: MIRROR_K - c.high,
  }));
}

function closedTimes(endMs: number, n: number, tf: keyof typeof SMCTIMEFRAME_MS): number[] {
  const d = SMCTIMEFRAME_MS[tf];
  if (endMs % d !== 0) {
    throw new Error(`endMs ${endMs} не на canonical grid ${tf}`);
  }
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(endMs - i * d);
  return out;
}

function waveCandles(timesMs: number[]): SmcRawCandle[] {
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
      closed: true,
    });
    prev = close;
  }
  return out;
}

const STANDARD_WEIGHTS = {
  swingStructureBias: 20,
  recentSwingBos: 15,
  internalStructure: 10,
  liquiditySweep: 10,
  swingOrderBlock: 15,
  internalOrderBlock: 5,
  fvg: 10,
  rangePosition: 10,
  confluence: 5,
};

function strategyRaw(overrides: Record<string, number> = {}): Record<string, unknown> {
  return {
    minimumSignalScore: overrides.minimumSignalScore ?? 72,
    swingLeft: overrides.swingLeft ?? 20,
    swingRight: overrides.swingRight ?? 20,
    internalLeft: overrides.internalLeft ?? 3,
    internalRight: overrides.internalRight ?? 3,
    atrPeriod: 14,
    structureEventFreshBars: 10,
    sweepFreshBars: 5,
    orderBlockFreshBars: 20,
    fvgFreshBars: 20,
    eqBand: 0.02,
    weights: STANDARD_WEIGHTS,
    filters: { minimumQuoteVolume24h: 0, top500Only: false },
  };
}

type FakeStore = {
  assets: SmcChartApiAssetRow[];
  strategies: SmcChartApiStrategyRow[];
  markets: SmcChartApiMarketRow[];
  candles: Map<number, SmcRawCandle[]>;
};

/** Детерминированный fake: ТОЛЬКО чтение (форма SmcChartApiDeps/Prisma). */
function makeDeps(store: FakeStore): SmcChartApiDeps {
  return {
    asset: {
      findUnique: async (args: unknown) => {
        const symbol = (args as { where?: { symbol?: string } }).where?.symbol;
        const row = store.assets.find((a) => a.symbol === symbol);
        return row === undefined ? null : { ...row };
      },
    },
    strategy: {
      findFirst: async (args: unknown) => {
        const slug = (args as { where?: { slug?: string } }).where?.slug;
        const matching = store.strategies
          .filter((s) => s.slug === slug)
          .sort((a, b) => b.version - a.version);
        return matching[0] === undefined ? null : { ...matching[0] };
      },
    },
    market: {
      findMany: async () => store.markets.map((m) => ({ ...m })),
    },
    candle: {
      findMany: async (args: unknown) => {
        const a = args as {
          where?: { marketId?: number; closed?: boolean };
          take?: number;
        };
        const w = a.where ?? {};
        const rows: SmcChartApiCandleRow[] = (store.candles.get(w.marketId ?? -1) ?? [])
          .filter((c) => w.closed === undefined || c.closed === w.closed)
          .map((c) => ({ ...c }));
        // Prisma-семантика loader'а: DESC по openTime, take N.
        rows.sort((x, y) => y.openTime.getTime() - x.openTime.getTime());
        return a.take !== undefined ? rows.slice(0, a.take) : rows;
      },
    },
  };
}

const ASSET_BTC: SmcChartApiAssetRow = { id: 1, symbol: "BTCUSDT", rank: 1 };

function marketRow(id: number, exchange: string): SmcChartApiMarketRow {
  return { id, exchange, exchangeSymbol: "BTCUSDT", quoteVolume24h: 1_000_000 };
}

interface RealProjectionInput {
  timeframe: "5m" | "15m" | "1h" | "4h" | "1d";
  markets: SmcChartApiMarketRow[];
  candles: Map<number, SmcRawCandle[]>;
  strategy: SmcChartApiStrategyRow;
  now: Date;
  label: string;
}

/**
 * РЕАЛЬНАЯ проекция через принятый P1-B сервис. Если сервис вернул
 * ошибку — тест падает (нельзя «пройти» на заглушке).
 */
async function realProjection(input: RealProjectionInput): Promise<SmcChartProjection> {
  const deps = makeDeps({
    assets: [ASSET_BTC],
    strategies: [input.strategy],
    markets: input.markets,
    candles: input.candles,
  });

  const result = await buildSmcChartProjection(deps, {
    symbol: "BTCUSDT",
    timeframe: input.timeframe,
    now: input.now,
  });

  if (!result.ok) {
    throw new Error(
      `fixture «${input.label}» не собрался: ${result.code} — ${result.error}`
    );
  }

  return result.projection;
}

function strategy(
  version: number,
  timeframe: string,
  minExchanges: number,
  configOverrides: Record<string, number> = {}
): SmcChartApiStrategyRow {
  return {
    slug: SMART_MONEY_SLUG,
    version,
    config: strategyRaw(configOverrides),
    timeframes: [timeframe],
    minExchanges,
  };
}

// ------------------------------------------------------------ render helpers
const TIMEFRAME_LABELS: Record<string, string> = {
  "5m": "5 минут",
  "15m": "15 минут",
  "1h": "1 час",
  "4h": "4 часа",
  "1d": "1 день",
};

function timeframeLabelOf(tf: string): string {
  return TIMEFRAME_LABELS[tf] ?? tf;
}

function renderPanel(panel: SmcPanelState, viewModel: SmcPanelViewModel | null): string {
  return renderToStaticMarkup(
    createElement(SmartMoneyPanel, {
      panel,
      viewModel,
      timeframeLabelOf,
    })
  );
}

/** Видимый текст без разметки и inline-стилей. */
function visibleText(markup: string): string {
  return markup
    .replace(/style="[^"]*"/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Текст verdict-бейджа (первый freshBadge с точным классом). */
function verdictBadge(markup: string): string | null {
  const match = /class="freshBadge"[^>]*>([^<]*)</.exec(markup);
  return match === null ? null : match[1].trim();
}

// ------------------------------------------------------------ MAIN
async function main(): Promise<void> {
  console.log("SMC Panel — P1-C checks (Smart Money UI integration)");

  const PANEL_SRC = readSource("components/chart/SmartMoneyPanel.tsx");
  const CHART_SRC = readSource("components/chart/CandleChart.tsx");
  const panelCode = stripComments(PANEL_SRC);
  const chartCode = stripComments(CHART_SRC);

  // self-check: стриппер не съел код
  ok(
    panelCode.includes("export function reduceSmcState") &&
      panelCode.includes("export function buildSmcPanelViewModel") &&
      panelCode.includes("export function SmartMoneyPanel"),
    "self-check: stripComments сохранил код панели"
  );
  ok(
    chartCode.includes("const dispatchSmc = useCallback"),
    "self-check: stripComments сохранил код CandleChart"
  );

  const smcSectionRaw = extractBetween(
    CHART_SRC,
    "/* ---------- Smart Money (P1-C)",
    "/* ---------- UI ---------- */",
    "SMC-секция CandleChart"
  );
  const smcCode = stripComments(smcSectionRaw);

  // ================================================================
  // 1. (18) Никаких DB/admin/Signal write-путей; чистота модуля
  // ================================================================
  console.log("\n=== 1. Read-only / no-DB / no-Signal / no-admin (статика) ===");
  {
    ok(!/prisma/i.test(panelCode), "(18) панель: нет Prisma");
    ok(!/@\/lib\/prisma/.test(panelCode), "(18) панель: нет импорта lib/prisma");
    ok(!/fetch\s*\(/.test(panelCode), "(18) панель: нет fetch (запрос делает CandleChart)");
    ok(
      !/\/api\/(admin|strategies|signals)/.test(panelCode),
      "(18) панель: нет admin/strategy/signal endpoint"
    );
    ok(!/localStorage|sessionStorage/.test(panelCode), "(18) панель: нет persistence");
    ok(!/Date\.now/.test(panelCode), "(18) панель: не читает часы");
    ok(
      !/useState|useEffect|useRef/.test(panelCode),
      "(18) панель: презентационная, без собственного state/эффектов"
    );
    ok(
      !/Strategy\s*\.\s*(enabled|status)\s*=/.test(panelCode),
      "(18) панель: не присваивает Strategy.enabled/status"
    );
    ok(
      !/lightweight-charts|fancy-canvas/.test(panelCode),
      "(9-P1D) панель: не импортирует графическую библиотеку — примитивов поверх свечей нет"
    );

    const imports = [...PANEL_SRC.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    eq(
      [...new Set(imports)].sort(),
      ["@/lib/chart/smc-contract", "react"],
      "(18) панель: импорты — только React-типы и принятый DTO P1-A"
    );

    ok(
      !/(interface|type)\s+Smc(ChartProjection|AggregateSummaryDto|MarketOverlayDto|ExchangeSummaryDto|OverlayReasonDto)\b/.test(
        panelCode
      ),
      "панель: второго DTO/контракта нет — типы взяты из lib/chart/smc-contract"
    );

    for (const token of [
      "createSignal",
      "/api/signals",
      "prisma.signal",
      "Signal.create",
      "signalWorker",
      "signal-worker",
      "lib/signals",
    ]) {
      ok(
        !chartCode.includes(token) && !panelCode.includes(token),
        `(18) нет Signal-пути: ${token}`
      );
    }

    ok(!existsSync(resolve(ROOT, "lib/signals")), "(18) lib/signals отсутствует (Signal Engine — будущий P5)");
    ok(
      !existsSync(resolve(ROOT, "scripts/test-signal-engine.ts")),
      "(18) scripts/test-signal-engine.ts отсутствует"
    );
    eq(
      readdirSync(resolve(ROOT, "app/api/chart/smc")).sort(),
      ["route.ts"],
      "(18) P1-B API не расширен: в app/api/chart/smc только route.ts"
    );
    ok(!/method\s*:/.test(chartCode), "(18) CandleChart: все запросы GET (нет method: POST/PUT/…)");
  }

  // ================================================================
  // 2. (8) Изоляция ошибки SMC от свечного графика + race-safety в коде
  // ================================================================
  console.log("\n=== 2. Изоляция от свечей, AbortController/race, отсутствие P1-D ===");
  {
    ok(/new AbortController\(\)/.test(smcCode), "chart-smc: используется AbortController (как у свечей)");
    ok(/signal: controller\.signal/.test(smcCode), "chart-smc: fetch передаёт signal контроллера");
    ok(/smcAbortRef\.current\?\.abort\(\)/.test(smcCode), "chart-smc: предыдущий запрос отменяется");
    ok(/reduceSmcState/.test(smcCode), "chart-smc: переходы через чистую машину состояний");
    ok(/isSmcAbortError/.test(smcCode), "chart-smc: отмена распознаётся и не считается ошибкой");
    eq(
      (smcCode.match(/fetch\s*\(/g) ?? []).length,
      1,
      "chart-smc: ровно один fetch — GET /api/chart/smc"
    );
    ok(/fetch\(url,/.test(smcCode), "chart-smc: fetch идёт по URL из машины состояний");
    ok(!/exchange=|&exchange/.test(smcCode), "chart-smc: в SMC-запросе нет exchange-параметра");
    ok(
      !/setStatus\s*\(|setErrorMessage\s*\(/.test(smcCode),
      "(8) chart-smc: ошибка Smart Money НЕ трогает status/errorMessage свечного графика"
    );
    ok(
      !/loadCandles|loadOlder|applyData/.test(smcCode),
      "(8) chart-smc: не вмешивается в загрузку/отрисовку свечей"
    );
    ok(!/prisma|localStorage|\/api\/admin/.test(smcCode), "(18) chart-smc: нет БД/persistence/admin");

    for (const token of [
      "createSeriesMarkers",
      "paneView",
      "attachDataSource",
      "ISeriesPrimitive",
      "createPriceLine",
      "addSeries",
      "Series(",
      "setData(",
    ]) {
      ok(!smcCode.includes(token), `(9-P1D) chart-smc: нет примитива отрисовки ${token}`);
    }

    // Toggle — русский, UI-only, без Strategy/admin.
    ok(/Смарт Мани/.test(CHART_SRC), "(1) chart: toggle с русским названием «Смарт Мани»");
    ok(
      /smcEnabled \? "Вкл" : "Выкл"/.test(chartCode),
      "(1) chart: toggle показывает «Смарт Мани: Вкл / Выкл»"
    );
    ok(/type: "toggle"/.test(chartCode), "(1) chart: toggle идёт событием машины состояний");
    ok(
      !/Strategy\.enabled/.test(chartCode),
      "(1) chart: Strategy.enabled не читается и не меняется"
    );
    ok(/dispatchSmc\(\{ type: "params", symbol, timeframe \}\)/.test(chartCode), "(5) chart: смена symbol/timeframe диспатчит params");
    ok(
      /dispatchSmc\(\{ type: "unmount" \}\)/.test(chartCode),
      "chart: unmount идёт через ту же машину состояний (abort + панель гаснет)"
    );
    ok(
      /if \(!transition\.changed\)/.test(smcCode),
      "chart-smc: no-op переход не пишет state (устаревший ответ/aborted/unmount)"
    );
    ok(/buildSmcPanelViewModel\(smcPanel\.projection, exchange\)/.test(chartCode), "(13) chart: view-model знает ВЫБРАННУЮ биржу свечей");
  }

  // ================================================================
  // 3. (14) Никакого хардкода числа бирж / special-case eligibility
  // ================================================================
  console.log("\n=== 3. Нет хардкода числа бирж и eligibility special-case ===");
  {
    for (const [name, code] of [
      ["панель", panelCode],
      ["SMC-секция графика", smcCode],
    ] as const) {
      ok(!/\d+\s*\/\s*\d+/.test(code), `(14) ${name}: нет литерала «N/M» — confirmation берётся из DTO`);
      ok(!/BINGX/.test(code), `(14) ${name}: нет хардкода BINGX (eligibility Option A — внутри P1-A)`);
      ok(!/(===|==|!==)\s*(4|5)\b/.test(code), `(14) ${name}: нет магического числа бирж`);
      ok(!/"1d"|'1d'/.test(code), `(14) ${name}: нет special-case таймфрейма 1d`);
    }

    ok(/aggregate\.participantCount/.test(panelCode), "(14) панель: число бирж — из DTO participantCount");
    ok(/aggregate\.confirmation/.test(panelCode), "(14) панель: confirmation — из DTO");
    ok(/aggregate\.exchangeExcluded/.test(panelCode), "(14) панель: исключения eligibility — из DTO");
    ok(/aggregate\.perExchange/.test(panelCode), "(14) панель: список бирж — из DTO perExchange");
  }

  // ================================================================
  // 4. (3)(4) URL = текущий symbol + timeframe, безопасно экранирован
  // ================================================================
  console.log("\n=== 4. URL запроса (symbol + timeframe, encoding, без exchange) ===");
  {
    eq(SMC_API_PATH, "/api/chart/smc", "(3) путь — принятый P1-B endpoint");
    eq(
      buildSmcRequestUrl("BTC", "1h"),
      "/api/chart/smc?symbol=BTC&timeframe=1h",
      "(3) URL = текущий symbol + timeframe (форма принятого API)"
    );

    const url = buildSmcRequestUrl("BTC", "1h");
    ok(!url.includes("exchange"), "(3) в URL нет exchange-параметра (SMC — asset-level)");
    eq([...new URL("https://x.local" + url).searchParams.keys()], ["symbol", "timeframe"], "(3) параметров ровно два");

    const hostileSymbols = [
      "BTC&ETH=1",
      "B TC",
      "BT=C",
      "BTC#frag",
      "BTC+1",
      "BTC/USD",
      "БТЦ",
      'a"b',
      "a'b",
      "%20",
      "BTC?x=1",
      "BTCUSDT",
    ];
    for (const symbol of hostileSymbols) {
      const built = buildSmcRequestUrl(symbol, "1h");
      const parsed = new URL("https://x.local" + built);
      eq(parsed.searchParams.get("symbol"), symbol, `(4) symbol ${JSON.stringify(symbol)} round-trip`);
      eq(parsed.searchParams.get("timeframe"), "1h", `(4) timeframe не искажён для ${JSON.stringify(symbol)}`);
      eq([...parsed.searchParams.keys()].length, 2, `(4) ${JSON.stringify(symbol)} не инъектирует параметры`);
      ok(!/&(?!(symbol|timeframe)=)/.test(built.slice(SMC_API_PATH.length + 1)), `(4) ${JSON.stringify(symbol)}: лишних «&» нет`);
    }

    for (const timeframe of ["5m", "15m", "1h", "4h", "1d", "7m", "1h&x=1", "1 h"]) {
      const parsed = new URL("https://x.local" + buildSmcRequestUrl("BTC", timeframe));
      eq(parsed.searchParams.get("timeframe"), timeframe, `(4) timeframe ${JSON.stringify(timeframe)} round-trip`);
      eq(parsed.searchParams.get("symbol"), "BTC", `(4) symbol не искажён для timeframe ${JSON.stringify(timeframe)}`);
    }

    ok(isSmcRequestReady("BTC", "1h"), "ready: непустые symbol+timeframe");
    ok(!isSmcRequestReady("", "1h"), "ready: пустой symbol — запрос не готов");
    ok(!isSmcRequestReady("BTC", "  "), "ready: пустой timeframe — запрос не готов");
  }

  // ================================================================
  // 5. РЕАЛЬНЫЕ проекции для view-model (LONG/SHORT/NEUTRAL/cannot/1d)
  // ================================================================
  console.log("\n=== 5. Реальные проекции P1-B (fixtures) ===");

  const tightWindows = { swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 };

  const pLong = await realProjection({
    label: "LONG 1h BINANCE",
    timeframe: "1h",
    markets: [marketRow(11, "BINANCE")],
    candles: new Map([[11, canonical()]]),
    strategy: strategy(7, "1h", 1, tightWindows),
    now: new Date(T0 + 27 * HOUR),
  });
  eq(pLong.overlays[0].status, "evaluated", "fixture LONG: overlay реально evaluated");
  eq(pLong.overlays[0].direction, "LONG", "fixture LONG: направление LONG");
  eq(pLong.aggregate.direction, "LONG", "fixture LONG: агрегат LONG");

  const pShort = await realProjection({
    label: "SHORT 1h BINANCE (зеркало)",
    timeframe: "1h",
    markets: [marketRow(12, "BINANCE")],
    candles: new Map([[12, mirrored(canonical())]]),
    strategy: strategy(8, "1h", 1, tightWindows),
    now: new Date(T0 + 27 * HOUR),
  });
  eq(pShort.overlays[0].direction, "SHORT", "fixture SHORT: зеркальная fixture реально даёт SHORT");
  eq(pShort.aggregate.direction, "SHORT", "fixture SHORT: агрегат SHORT");

  const wave5m = waveCandles(closedTimes(T_5M, 200, "5m"));
  const pFive = await realProjection({
    label: "NEUTRAL 5m, 5 бирж",
    timeframe: "5m",
    markets: NAMES.map((ex, i) => marketRow(21 + i, ex)),
    candles: new Map(NAMES.map((_, i) => [21 + i, waveCandles(closedTimes(T_5M, 200, "5m"))])),
    strategy: strategy(2, "5m", 3),
    now: new Date(NOW_5M),
  });
  eq(pFive.aggregate.status, "ok", "fixture 5 бирж: aggregate.status ok");
  eq(pFive.aggregate.participantCount, 5, "fixture 5 бирж: participantCount 5");
  eq(pFive.aggregate.evaluatedCount, 5, "fixture 5 бирж: все 5 оценены");
  eq(pFive.aggregate.direction, "NEUTRAL", "fixture 5 бирж: честный evaluated NEUTRAL");
  ok(pFive.aggregate.gateAllowed, "fixture 5 бирж: gate пустил агрегацию");

  const pTwo = await realProjection({
    label: "NEUTRAL 5m, 2 биржи",
    timeframe: "5m",
    markets: [marketRow(61, "BINANCE"), marketRow(62, "GATE")],
    candles: new Map([
      [61, wave5m],
      [62, wave5m],
    ]),
    strategy: strategy(4, "5m", 1),
    now: new Date(NOW_5M),
  });
  eq(pTwo.aggregate.participantCount, 2, "fixture 2 биржи: participantCount 2");

  const pMix = await realProjection({
    label: "конфликт 1h: BINANCE LONG + BYBIT SHORT",
    timeframe: "1h",
    markets: [marketRow(71, "BINANCE"), marketRow(72, "BYBIT")],
    candles: new Map([
      [71, canonical()],
      [72, mirrored(canonical())],
    ]),
    strategy: strategy(9, "1h", 1, tightWindows),
    now: new Date(T0 + 27 * HOUR),
  });
  eq(pMix.aggregate.perExchange[0].direction, "LONG", "fixture конфликт: BINANCE LONG");
  eq(pMix.aggregate.perExchange[1].direction, "SHORT", "fixture конфликт: BYBIT SHORT");
  eq(pMix.aggregate.direction, "NEUTRAL", "fixture конфликт: агрегат NEUTRAL (не LONG выбранной биржи)");
  ok(pMix.aggregate.conflict, "fixture конфликт: conflict=true");

  const shortHistory = flats(0, 2);
  const pCannot = await realProjection({
    label: "cannot-evaluate 1h (короткая история)",
    timeframe: "1h",
    markets: [marketRow(41, "BINANCE")],
    candles: new Map([[41, shortHistory]]),
    strategy: strategy(5, "1h", 1),
    now: new Date(shortHistory[2].openTime.getTime() + HOUR),
  });
  eq(pCannot.overlays[0].status, "cannot-evaluate", "fixture cannot-evaluate: per-market статус");
  eq(pCannot.aggregate.direction, null, "fixture cannot-evaluate: direction null");
  ok(!pCannot.aggregate.gateAllowed, "fixture cannot-evaluate: gate не пустил");

  const pNone = await realProjection({
    label: "no_participants (рынков нет)",
    timeframe: "5m",
    markets: [],
    candles: new Map(),
    strategy: strategy(6, "5m", 3),
    now: new Date(NOW_5M),
  });
  eq(pNone.aggregate.status, "no_participants", "fixture no_participants: aggregate.status");
  eq(pNone.aggregate.perExchange.length, 0, "fixture no_participants: участников нет");

  const pDay = await realProjection({
    label: "1d Option A (BINGX исключён)",
    timeframe: "1d",
    markets: NAMES.map((ex, i) => marketRow(31 + i, ex)),
    candles: new Map(NAMES.map((_, i) => [31 + i, waveCandles(closedTimes(D_EXPECTED, 200, "1d"))])),
    strategy: strategy(3, "1d", 3),
    now: new Date(D_NOW),
  });
  eq(pDay.aggregate.exchangeExcluded, ["BINGX"], "fixture 1d: BINGX исключён существующей Option A");
  eq(pDay.aggregate.participantCount, 4, "fixture 1d: 4 участника");
  eq(
    pDay.overlays.map((o) => o.exchange),
    ["BINANCE", "BYBIT", "GATE", "KUCOIN"],
    "fixture 1d: оверлеи без BINGX"
  );

  // ================================================================
  // 6. (11)(12)(13)(17) View-model: LONG / SHORT / aggregate vs биржа
  // ================================================================
  console.log("\n=== 6. View-model на реальных проекциях ===");
  {
    const before = JSON.stringify(pLong);
    const vmLong = buildSmcPanelViewModel(pLong, "BINANCE");

    eq(vmLong.verdict, "long", "(11) LONG: verdict long");
    eq(vmLong.verdictLabel, "LONG", "(11) LONG: русский бейдж LONG");
    eq(vmLong.aggregate.directionLabel, "LONG", "(11) LONG: направление агрегата из DTO");
    eq(vmLong.assetSymbol, pLong.assetSymbol, "asset — из DTO");
    eq(vmLong.timeframe, pLong.timeframe, "timeframe — из DTO");
    eq(vmLong.generatedAtLabel, formatSmcUtcMs(pLong.generatedAtMs), "generatedAt — из DTO (ms → UTC)");
    eq(vmLong.aggregate.confirmation, pLong.aggregate.confirmation, "confirmation — из DTO");
    eq(vmLong.aggregate.minExchanges, pLong.aggregate.minExchanges, "minExchanges — из DTO");
    eq(vmLong.aggregate.horizonLabel, formatSmcUtcMs(pLong.aggregate.horizonMs!), "horizon — из DTO");
    eq(vmLong.aggregate.engineAsOfLabel, formatSmcUtcMs(pLong.aggregate.engineAsOfMs!), "asOf — из DTO");
    eq(vmLong.aggregate.statusReason, pLong.aggregate.statusReason, "statusReason — из DTO");
    eq(
      vmLong.exchanges.length,
      pLong.aggregate.perExchange.length,
      "(14) число строк бирж = фактическое число perExchange"
    );
    eq(vmLong.exchanges[0].exchange, "BINANCE", "per-exchange: биржа из DTO");
    eq(vmLong.exchanges[0].market, "BTCUSDT", "per-exchange: рынок из DTO");
    eq(vmLong.exchanges[0].longScore, 75, "per-exchange: баллы LONG из DTO");
    eq(vmLong.exchanges[0].shortScore, 10, "per-exchange: баллы SHORT из DTO");
    eq(vmLong.exchanges[0].statusLabel, "оценён", "per-exchange: статус оценён");
    ok(vmLong.exchanges[0].isSelectedCandleExchange, "(13) выбранная биржа свечей помечена");
    ok(vmLong.hasWhy, "(7) WHY: причины присутствуют");
    eq(
      vmLong.exchanges[0].why.length,
      pLong.overlays[0].reasons.length,
      "(7) WHY: ровно столько причин, сколько в DTO (ничего не добавлено)"
    );
    eq(
      vmLong.exchanges[0].why.map((r) => r.code),
      pLong.overlays[0].reasons.map((r) => r.code),
      "(7) WHY: коды причин совпадают с DTO"
    );
    eq(JSON.stringify(pLong), before, "(17) построение view-model НЕ мутирует входной DTO");

    // ---------------- (16)(17) factIds passthrough ----------------
    const dtoReasons = pLong.overlays[0].reasons;
    const whyRows = vmLong.exchanges[0].why;
    for (let i = 0; i < dtoReasons.length; i++) {
      eq(whyRows[i].factIds, dtoReasons[i].factIds, `(17) factIds ${dtoReasons[i].code}: passthrough без изменений`);
      eq(whyRows[i].value, dtoReasons[i].value, `(17) value ${dtoReasons[i].code}: passthrough`);
      eq(whyRows[i].longPoints, dtoReasons[i].longPoints, `(17) longPoints ${dtoReasons[i].code}: passthrough`);
      eq(whyRows[i].shortPoints, dtoReasons[i].shortPoints, `(17) shortPoints ${dtoReasons[i].code}: passthrough`);
      eq(whyRows[i].maxPoints, dtoReasons[i].maxPoints, `(17) maxPoints ${dtoReasons[i].code}: passthrough`);
      eq(whyRows[i].label, dtoReasons[i].label, `(17) label ${dtoReasons[i].code}: passthrough`);
    }

    const confluence = dtoReasons.find((r) => r.code === "OB_FVG_CONFLUENCE");
    ok(confluence !== undefined, "(16) fixture содержит OB_FVG_CONFLUENCE");
    eq(confluence?.factIds, [], "(16) DTO: OB_FVG_CONFLUENCE factIds = []");
    eq(
      whyRows.find((r) => r.code === "OB_FVG_CONFLUENCE")?.factIds,
      [],
      "(16) view-model: OB_FVG_CONFLUENCE factIds остаётся [] (не реконструируется)"
    );

    const fvg = dtoReasons.find((r) => r.code === "FVG");
    ok(
      fvg !== undefined && fvg.value !== null && fvg.factIds.length === 1 && fvg.factIds[0] === fvg.value,
      "(17) DTO: exact FVG factId = deterministic ключ"
    );
    eq(
      whyRows.find((r) => r.code === "FVG")?.factIds,
      fvg === undefined ? null : [fvg.value],
      "(17) view-model: exact FVG factId сохранён"
    );
    ok(
      pLong.overlays[0].fvgs.some((f) => f.key === fvg?.value),
      "(17) exact FVG factId существует среди фактов DTO (не выдуман)"
    );

    const swingOb = dtoReasons.find((r) => r.code === "SWING_ORDER_BLOCK");
    ok(
      swingOb !== undefined && swingOb.value !== null && swingOb.factIds.length === 1 && swingOb.factIds[0] === swingOb.value,
      "(17) DTO: exact swing OB factId = deterministic ключ"
    );
    eq(
      whyRows.find((r) => r.code === "SWING_ORDER_BLOCK")?.factIds,
      swingOb === undefined ? null : [swingOb.value],
      "(17) view-model: exact swing OB factId сохранён"
    );
    ok(
      pLong.overlays[0].orderBlocks.some((o) => o.key === swingOb?.value),
      "(17) exact OB factId существует среди фактов DTO (не выдуман)"
    );

    // Копия массива factIds не алиасит DTO: мутация копии DTO не трогает.
    const copies = toSmcWhyRows(dtoReasons);
    copies[0].factIds.push("INJECTED");
    eq(dtoReasons[0].factIds, [], "(17) мутация копии factIds не меняет DTO (алиасинга нет)");
    ok(
      !JSON.stringify(copies).includes("SMC1|INJECTED"),
      "(17) инъекция в копию не проникает в DTO-данные"
    );

    // ---------------- (12) SHORT ----------------
    const vmShort = buildSmcPanelViewModel(pShort, "BINANCE");
    eq(vmShort.verdict, "short", "(12) SHORT: verdict short");
    eq(vmShort.verdictLabel, "SHORT", "(12) SHORT: бейдж SHORT");
    eq(vmShort.exchanges[0].longScore, 10, "(12) SHORT: баллы LONG 10 из DTO");
    eq(vmShort.exchanges[0].shortScore, 75, "(12) SHORT: баллы SHORT 75 из DTO");
    ok(vmShort.verdict !== vmLong.verdict, "(11)(12) LONG и SHORT различаются");

    // ---------------- (13) aggregate != выбранная биржа ----------------
    const vmMix = buildSmcPanelViewModel(pMix, "BINANCE");
    const selected = vmMix.exchanges.find((r) => r.isSelectedCandleExchange);
    eq(vmMix.verdict, "neutral", "(13) verdict = агрегат NEUTRAL, а не LONG выбранной биржи");
    eq(selected?.exchange, "BINANCE", "(13) выбранная биржа найдена в per-exchange списке");
    eq(selected?.direction, "LONG", "(13) per-exchange LONG показан отдельно");
    ok(
      selected !== undefined && vmMix.verdictLabel !== selected.directionLabel,
      "(13) агрегат и результат выбранной биржи показаны раздельно"
    );
    ok(vmMix.aggregate.conflict, "(13) конфликт направлений виден из DTO");
    eq(vmMix.aggregate.longVotes, pMix.aggregate.longVotes, "(13) голоса LONG — из DTO");
    eq(vmMix.aggregate.shortVotes, pMix.aggregate.shortVotes, "(13) голоса SHORT — из DTO");

    // Вердикт определяется ТОЛЬКО aggregate.direction: точечная подмена
    // направления выбранной биржи (копия DTO, не оригинал) его не меняет.
    const mutated = JSON.parse(JSON.stringify(pMix)) as SmcChartProjection;
    mutated.aggregate.perExchange[0].direction = "SHORT";
    eq(
      buildSmcPanelViewModel(mutated, "BINANCE").verdict,
      "neutral",
      "(13) verdict не берётся из per-exchange строки выбранной биржи"
    );
    eq(pMix.aggregate.perExchange[0].direction, "LONG", "(13) оригинал DTO при этой проверке не мутирован");

    // Выбранной биржи нет среди участников — она не выдаётся за агрегат.
    const vmAbsent = buildSmcPanelViewModel(pMix, "KUCOIN");
    ok(
      vmAbsent.exchanges.every((r) => !r.isSelectedCandleExchange),
      "(13) если выбранной биржи нет среди участников — ничего не помечается"
    );
    eq(vmAbsent.verdict, "neutral", "(13) вердикт при этом остаётся агрегированным");
    eq(vmAbsent.selectedExchange, "KUCOIN", "(13) выбранная биржа сохранена для подписи свечей");
    ok(
      vmAbsent.candlesScopeLabel.includes("KUCOIN"),
      "(13) подпись свечей называет выбранную биржу"
    );

    // ---------------- (14) число бирж из DTO ----------------
    const vmFive = buildSmcPanelViewModel(pFive, "BYBIT");
    eq(vmFive.exchanges.length, 5, "(14) 5 участников → 5 строк");
    eq(vmFive.exchanges.map((r) => r.exchange), NAMES, "(14) порядок/имена бирж — из DTO");
    eq(vmFive.aggregate.participantCount, 5, "(14) participantCount из DTO");
    eq(vmFive.aggregate.confirmation, pFive.aggregate.confirmation, "(14) confirmation из DTO");
    ok(
      vmFive.smcScopeLabel.includes(String(pFive.aggregate.participantCount)),
      "(14) подпись агрегата содержит фактическое число бирж"
    );

    const vmTwo = buildSmcPanelViewModel(pTwo, "GATE");
    eq(vmTwo.exchanges.length, 2, "(14) 2 участника → 2 строки (нет хардкода пяти бирж)");
    eq(vmTwo.aggregate.participantCount, 2, "(14) participantCount 2 из DTO");
    eq(vmTwo.aggregate.confirmation, pTwo.aggregate.confirmation, "(14) confirmation 2 бирж из DTO");
    ok(
      vmTwo.aggregate.confirmation !== null && vmTwo.aggregate.confirmation.endsWith("/2"),
      "(14) confirmation отражает двух участников"
    );
    ok(vmTwo.smcScopeLabel.includes("участников: 2"), "(14) подпись: число участников из DTO");

    // ---------------- (6) 1d: исключённая биржа из DTO ----------------
    const vmDayBingx = buildSmcPanelViewModel(pDay, "BINGX");
    eq(vmDayBingx.aggregate.exchangeExcluded, ["BINGX"], "(14) исключения eligibility — из DTO");
    eq(vmDayBingx.exchanges.length, 4, "(14) 1d: 4 строки участников (BINGX не в них)");
    ok(
      vmDayBingx.exchanges.every((r) => r.exchange !== "BINGX"),
      "(14) исключённая биржа не выдаётся за участника агрегации"
    );
    ok(vmDayBingx.selectedExchangeExcluded, "(13) выбранная биржа свечей помечена как исключённая");
    ok(
      vmDayBingx.selectedExchangeExcludedNote !== null &&
        vmDayBingx.selectedExchangeExcludedNote.includes("BINGX") &&
        vmDayBingx.selectedExchangeExcludedNote.includes("eligibility"),
      "(13) пояснение: свечи выбранной биржи ≠ её участие в агрегации"
    );
    ok(
      vmDayBingx.exchanges.every((r) => !r.isSelectedCandleExchange),
      "(13) исключённая биржа не помечена как «биржа свечей» в списке участников"
    );

    const vmDayBinance = buildSmcPanelViewModel(pDay, "BINANCE");
    ok(!vmDayBinance.selectedExchangeExcluded, "(13) участвующая биржа не помечена исключённой");
    eq(vmDayBinance.selectedExchangeExcludedNote, null, "(13) для участвующей биржи пояснения нет");
    ok(
      vmDayBinance.exchanges.find((r) => r.exchange === "BINANCE")?.isSelectedCandleExchange === true,
      "(13) участвующая выбранная биржа помечена"
    );
  }

  // ================================================================
  // 7. (10) NEUTRAL != cannot-evaluate; состояния C
  // ================================================================
  console.log("\n=== 7. cannot-evaluate ≠ NEUTRAL (реальные DTO) ===");
  {
    const vmCannot = buildSmcPanelViewModel(pCannot, "BINANCE");
    eq(vmCannot.verdict, "cannot-evaluate", "(10) cannot-evaluate → verdict cannot-evaluate");
    ok(vmCannot.verdict !== "neutral", "(10) cannot-evaluate НЕ равен neutral");
    eq(vmCannot.verdictLabel, "Нет оценки", "(10) бейдж «Нет оценки» (не NEUTRAL)");
    ok(
      SMC_VERDICT_NOTES["cannot-evaluate"] !== SMC_VERDICT_NOTES.neutral,
      "(10) пояснения cannot-evaluate и NEUTRAL различаются"
    );
    ok(
      SMC_VERDICT_NOTES["cannot-evaluate"].includes("не NEUTRAL"),
      "(10) пояснение прямо говорит «Это не NEUTRAL»"
    );
    ok(
      SMC_VERDICT_NOTES.neutral.includes("Оценка выполнена"),
      "(10) пояснение NEUTRAL прямо говорит, что оценка выполнена"
    );
    eq(vmCannot.aggregate.directionLabel, "—", "(10) направление не подменяется нейтралью");
    eq(vmCannot.exchanges[0].direction, null, "(10) per-exchange direction null из DTO");
    eq(vmCannot.exchanges[0].directionLabel, "—", "(10) per-exchange label «—»");
    eq(vmCannot.exchanges[0].status, "cannot-evaluate", "(10) per-exchange статус из DTO");
    eq(vmCannot.exchanges[0].statusLabel, "не оценён", "(10) per-exchange label «не оценён»");
    eq(vmCannot.exchanges[0].longScore, null, "(10) баллов нет — null из DTO");
    eq(formatSmcScore(vmCannot.exchanges[0].longScore), "—", "(10) null-баллы показываются прочерком");
    ok(
      (vmCannot.exchanges[0].statusReason ?? "").includes("INSUFFICIENT_HISTORY"),
      "(10/C) причина «недостаточно данных» сохранена из DTO"
    );
    eq(vmCannot.aggregate.evaluatedCount, 0, "(10/C) evaluatedCount 0");
    eq(vmCannot.aggregate.cannotEvaluateCount, 1, "(10/C) cannotEvaluateCount 1");
    ok(!vmCannot.aggregate.gateAllowed, "(10/C) gate не пустил агрегацию");
    ok(
      vmCannot.aggregate.gateRefusalReasons.length > 0,
      "(10/C) причины отказа gate показаны (unsafe-агрегат не прячется)"
    );
    eq(vmCannot.hasWhy, false, "(10/C) WHY пуст — причины не выдумываются");
    eq(vmCannot.exchanges[0].why.length, 0, "(10/C) у не-оценённой биржи нет причин");

    // РЕАЛЬНЫЙ отказ aggregation gate при usable/ok горизонте: fixture
    // «короткая история» даёт alignment-отказ существующего движка.
    const gateRefusal: SmcAggregateSummaryDto = JSON.parse(
      JSON.stringify(pCannot.aggregate)
    );
    eq(gateRefusal.usable, true, "(C) реальный отказ gate: горизонт usable");
    eq(gateRefusal.status, "ok", "(C) реальный отказ gate: status ok");
    eq(gateRefusal.gateAllowed, false, "(C) реальный отказ gate: gateAllowed false");
    eq(gateRefusal.direction, null, "(C) реальный отказ gate: агрегированного направления нет");
    eq(gateRefusal.confirmation, null, "(C) реальный отказ gate: подтверждения нет");
    ok(
      gateRefusal.gateRefusalReasons.some((reason) => reason.includes("alignment")),
      "(C) причина отказа — alignment из существующего gate (не выдумана)"
    );
    eq(smcAggregateVerdict(gateRefusal), "cannot-evaluate", "(10/C) реальный отказ gate → cannot-evaluate");
    eq(
      smcAggregateVerdict({ ...gateRefusal, evaluatedCount: 1 }),
      "cannot-evaluate",
      "(10/C) отказ gate не прячется под успешный агрегат даже при evaluatedCount > 0"
    );
    eq(
      vmCannot.aggregate.gateRefusalReasons,
      gateRefusal.gateRefusalReasons,
      "(10/C) причины отказа gate доходят до view-model без изменений"
    );

    const vmNone = buildSmcPanelViewModel(pNone, "BINANCE");
    eq(vmNone.verdict, "cannot-evaluate", "(C) no_participants → cannot-evaluate, НЕ neutral");
    eq(vmNone.exchanges.length, 0, "(C) нет участников → нет строк бирж");
    eq(vmNone.aggregate.statusLabel, SMC_HORIZON_STATUS_LABELS.no_participants, "(C) русский label no_participants");

    // NEUTRAL из реальной оценки — отдельное состояние.
    const vmNeutral = buildSmcPanelViewModel(pFive, "BYBIT");
    eq(vmNeutral.verdict, "neutral", "(D/E) evaluated NEUTRAL → verdict neutral");
    eq(vmNeutral.verdictLabel, "NEUTRAL", "(D/E) бейдж NEUTRAL");
    eq(vmNeutral.aggregate.evaluatedCount, 5, "(D/E) все участники оценены");
    ok(vmNeutral.aggregate.gateAllowed, "(D/E) gate пустил — агрегат настоящий");
    ok(vmNeutral.verdict !== vmCannot.verdict, "(10) NEUTRAL и cannot-evaluate — разные вердикты");

    // Точечные вариации РЕАЛЬНОГО aggregate (копии): все отказы → cannot-evaluate.
    const base: SmcAggregateSummaryDto = JSON.parse(JSON.stringify(pFive.aggregate));
    eq(smcAggregateVerdict(base), "neutral", "verdict: базовый evaluated NEUTRAL");
    const variants: Array<[string, SmcAggregateSummaryDto]> = [
      ["gate отказал (unsafe alignment)", { ...base, gateAllowed: false }],
      ["horizon unusable", { ...base, usable: false }],
      ["status relative_lag_stale", { ...base, status: "relative_lag_stale" }],
      ["status absolute_stale", { ...base, status: "absolute_stale" }],
      ["status future_horizon", { ...base, status: "future_horizon" }],
      ["status no_common_horizon", { ...base, status: "no_common_horizon" }],
      ["status data_unavailable", { ...base, status: "data_unavailable" }],
      ["status no_participants", { ...base, status: "no_participants" }],
      ["direction null", { ...base, direction: null }],
      ["direction CANNOT_EVALUATE", { ...base, direction: "CANNOT_EVALUATE" }],
      ["evaluatedCount 0", { ...base, evaluatedCount: 0 }],
    ];
    for (const [label, aggregate] of variants) {
      eq(smcAggregateVerdict(aggregate), "cannot-evaluate", `(10/C) ${label} → cannot-evaluate, НЕ neutral`);
    }
    eq(smcAggregateVerdict({ ...base, direction: "LONG" }), "long", "(11) direction LONG → long");
    eq(smcAggregateVerdict({ ...base, direction: "SHORT" }), "short", "(12) direction SHORT → short");

    // Label-домены исчерпывающие (по фактическим типам DTO).
    eq(
      Object.keys(SMC_HORIZON_STATUS_LABELS).sort(),
      [
        "absolute_stale",
        "data_unavailable",
        "future_horizon",
        "no_common_horizon",
        "no_participants",
        "ok",
        "relative_lag_stale",
      ],
      "labels покрывают весь домен CommonHorizonStatus"
    );
    ok(
      Object.values(SMC_HORIZON_STATUS_LABELS).every((label) => label.trim().length > 0),
      "у каждого статуса горизонта есть непустой русский label"
    );
    eq(smcDirectionLabel(null), "—", "label: direction null → «—»");
    eq(smcDirectionLabel("CANNOT_EVALUATE"), "нет оценки", "label: CANNOT_EVALUATE → «нет оценки»");
    eq(smcMarketStatusLabel("evaluated"), "оценён", "label: evaluated");
    eq(smcMarketStatusLabel("cannot-evaluate"), "не оценён", "label: cannot-evaluate");
    eq(smcMarketStatusLabel("filtered"), "отфильтрован", "label: filtered");
    eq(SMC_VERDICT_LABELS.long, "LONG", "label: long");
    eq(SMC_VERDICT_LABELS["cannot-evaluate"], "Нет оценки", "label: cannot-evaluate");
  }

  // ================================================================
  // 8. (1)(2)(5)(6)(7)(9) Машина состояний: toggle, race, abort, errors
  // ================================================================
  console.log("\n=== 8. Request lifecycle / race safety (чистая машина состояний) ===");
  {
    const initial = createSmcControllerState();
    eq(
      initial,
      { enabled: false, symbol: "", timeframe: "", activeRequestId: 0, panel: { status: "off" } },
      "(1) начальное состояние: OFF, запросов не было"
    );

    // ---------------- (1) toggle OFF ----------------
    {
      const t = reduceSmcState(initial, { type: "toggle", enabled: false, symbol: "BTC", timeframe: "1h" });
      ok(!t.changed, "(1) toggle OFF из OFF — no-op");
      eq(t.fetch, null, "(1) toggle OFF не создаёт запрос");
      eq(t.state.panel, SMC_PANEL_OFF, "(1) панель скрыта");

      const p = reduceSmcState(initial, { type: "params", symbol: "ETH", timeframe: "5m" });
      ok(!p.changed && p.fetch === null, "(1) при OFF смена symbol/timeframe не создаёт запрос");
      eq(p.state.panel, SMC_PANEL_OFF, "(1) при OFF панель остаётся скрытой");
    }

    // ---------------- (2)(3)(9) toggle ON ----------------
    let on = reduceSmcState(initial, { type: "toggle", enabled: true, symbol: "BTC", timeframe: "1h" });
    ok(on.state.enabled, "(2) toggle ON включает Smart Money UI");
    ok(on.fetch !== null, "(2) toggle ON выдаёт запрос");
    eq(on.fetch?.requestId, 1, "(2) первый requestId = 1");
    eq(on.fetch?.url, "/api/chart/smc?symbol=BTC&timeframe=1h", "(3) URL = текущий symbol + timeframe");
    eq(on.state.panel, { status: "loading", symbol: "BTC", timeframe: "1h" }, "(9/A) ON → loading");
    ok(on.abortPrevious, "(2) ON отменяет предыдущий in-flight запрос");

    // ON без symbol: запрос не выдаётся, панель скрыта (не «вечный loading»).
    {
      const noSymbol = reduceSmcState(initial, { type: "toggle", enabled: true, symbol: "", timeframe: "1h" });
      eq(noSymbol.fetch, null, "ON без symbol: запрос не выдаётся");
      eq(noSymbol.state.panel, SMC_PANEL_OFF, "ON без symbol: панель скрыта");
      ok(noSymbol.state.enabled, "ON без symbol: toggle включён");
      const later = reduceSmcState(noSymbol.state, { type: "params", symbol: "ETH", timeframe: "15m" });
      eq(later.fetch?.url, "/api/chart/smc?symbol=ETH&timeframe=15m", "symbol разрешился → запрос выдан");
    }

    // Повторный ON без смены параметров — без второго запроса.
    {
      const readyState: SmcControllerState = {
        ...on.state,
        panel: { status: "ready", symbol: "BTC", timeframe: "1h", projection: pLong },
      };
      const again = reduceSmcState(readyState, { type: "toggle", enabled: true, symbol: "BTC", timeframe: "1h" });
      ok(!again.changed && again.fetch === null, "(2) повторный ON не создаёт дубль запроса");
      eq(again.state.panel.status, "ready", "(2) повторный ON не ломает готовую панель");
    }

    // ---------------- (9) success / HTTP error / network / broken body ----------------
    {
      const success = reduceSmcState(on.state, {
        type: "http-response",
        requestId: 1,
        ok: true,
        httpStatus: 200,
        body: pLong,
      });
      eq(success.state.panel.status, "ready", "(9/F) 200 + DTO → ready");
      eq(
        (success.state.panel as Extract<SmcPanelState, { status: "ready" }>).projection.aggregate.direction,
        "LONG",
        "(9/F) в ready лежит проекция из ответа"
      );
      eq(success.fetch, null, "(9/F) ready не создаёт новых запросов");
      ok(!success.abortPrevious, "(9/F) ready ничего не отменяет");
      on = success;

      const httpError = reduceSmcState(on.state, {
        type: "toggle",
        enabled: true,
        symbol: "BTC",
        timeframe: "7m",
      });
      const errored = reduceSmcState(httpError.state, {
        type: "http-response",
        requestId: httpError.fetch!.requestId,
        ok: false,
        httpStatus: 400,
        body: { error: "Неверный timeframe: 7m. Доступные: 5m, 15m, 1h, 4h, 1d" },
      });
      eq(errored.state.panel.status, "http-error", "(9/B) HTTP 400 → http-error");
      eq(
        (errored.state.panel as Extract<SmcPanelState, { status: "http-error" }>).httpStatus,
        400,
        "(9/B) httpStatus сохранён"
      );
      ok(
        (errored.state.panel as Extract<SmcPanelState, { status: "http-error" }>).message.includes(
          "Неверный timeframe"
        ),
        "(9/B) серверное русское сообщение показано"
      );
      ok(
        (errored.state.panel as Extract<SmcPanelState, { status: "http-error" }>).message.includes("HTTP 400"),
        "(9/B) статус виден пользователю"
      );
      ok(
        !("projection" in errored.state.panel),
        "(9/B) в ошибке нет проекции — ошибка не выдаётся за данные"
      );

      const network = reduceSmcState(httpError.state, {
        type: "network-error",
        requestId: httpError.fetch!.requestId,
        message: SMC_NETWORK_ERROR_MESSAGE,
      });
      eq(network.state.panel.status, "http-error", "(9/B) сетевая ошибка → http-error");
      eq(
        (network.state.panel as Extract<SmcPanelState, { status: "http-error" }>).httpStatus,
        null,
        "(9/B) у сетевой ошибки HTTP-статуса нет"
      );
      eq(
        (network.state.panel as Extract<SmcPanelState, { status: "http-error" }>).message,
        "Ошибка соединения с сервером",
        "(9/B) русское сообщение сетевой ошибки"
      );

      for (const body of [null, {}, { assetSymbol: "BTC" }, [], "text", 42]) {
        const broken = reduceSmcState(httpError.state, {
          type: "http-response",
          requestId: httpError.fetch!.requestId,
          ok: true,
          httpStatus: 200,
          body,
        });
        eq(
          broken.state.panel.status,
          "http-error",
          `(9/B) битый 200 (${JSON.stringify(body)}) → http-error, не ready`
        );
      }
      ok(parseSmcBody(pLong).ok, "parseSmcBody: реальная проекция принимается");
      ok(!parseSmcBody(null).ok, "parseSmcBody: null отклонён");
      ok(!parseSmcBody({}).ok, "parseSmcBody: пустой объект отклонён");
      ok(
        !parseSmcBody({ assetSymbol: "BTC", timeframe: "1h", overlays: [], aggregate: {} }).ok,
        "parseSmcBody: aggregate без status/perExchange отклонён"
      );
      eq(
        smcHttpErrorMessage(503, { error: "База данных временно недоступна" }),
        "База данных временно недоступна (HTTP 503)",
        "(9/B) сообщение 503 из { error }"
      );
      eq(
        smcHttpErrorMessage(404, {}),
        "Не удалось загрузить Smart Money (HTTP 404)",
        "(9/B) fallback-сообщение без серверного error"
      );
    }

    // ---------------- (7) OFF/abort: stale не остаётся видимым ----------------
    {
      const loading = reduceSmcState(initial, { type: "toggle", enabled: true, symbol: "BTC", timeframe: "1h" });
      const off = reduceSmcState(loading.state, { type: "toggle", enabled: false, symbol: "BTC", timeframe: "1h" });
      ok(off.abortPrevious, "(7) OFF отменяет in-flight запрос (abort)");
      eq(off.state.panel, SMC_PANEL_OFF, "(7) OFF скрывает панель");
      ok(!off.state.enabled, "(7) OFF выключает toggle");

      const late = reduceSmcState(off.state, {
        type: "http-response",
        requestId: 1,
        ok: true,
        httpStatus: 200,
        body: pLong,
      });
      ok(!late.changed, "(7) ответ после OFF игнорируется");
      eq(late.state.panel, SMC_PANEL_OFF, "(7) stale-результат не становится видимым");

      const lateAbort = reduceSmcState(off.state, { type: "aborted", requestId: 1 });
      ok(!lateAbort.changed, "(7) aborted после OFF — no-op");

      const ready = reduceSmcState(loading.state, {
        type: "http-response",
        requestId: 1,
        ok: true,
        httpStatus: 200,
        body: pLong,
      }).state;
      eq(ready.panel.status, "ready", "(7) база: ready получен");
      const offFromReady = reduceSmcState(ready, { type: "toggle", enabled: false, symbol: "BTC", timeframe: "1h" });
      eq(offFromReady.state.panel, SMC_PANEL_OFF, "(7) OFF из ready сразу убирает панель");

      const unmounted = reduceSmcState(ready, { type: "unmount" });
      ok(unmounted.abortPrevious, "unmount: in-flight запрос отменяется");
      eq(unmounted.state.panel, SMC_PANEL_OFF, "unmount: панель скрыта");
      ok(!unmounted.state.enabled, "unmount: toggle выключен");
      const afterUnmount = reduceSmcState(unmounted.state, {
        type: "http-response",
        requestId: 1,
        ok: true,
        httpStatus: 200,
        body: pLong,
      });
      ok(!afterUnmount.changed, "unmount: поздний ответ игнорируется (setState после размонтирования нет)");

      ok(isSmcAbortError(new DOMException("Aborted", "AbortError")), "abort: DOMException AbortError распознаётся");
      ok(isSmcAbortError({ name: "AbortError" }), "abort: объект с name=AbortError распознаётся");
      ok(!isSmcAbortError(new Error("network down")), "abort: обычная ошибка не считается отменой");
      ok(!isSmcAbortError(null), "abort: null не считается отменой");
    }

    // ---------------- (5)(6) смена параметров и stale response ----------------
    {
      const first = reduceSmcState(initial, { type: "toggle", enabled: true, symbol: "BTC", timeframe: "1h" });
      eq(first.fetch?.requestId, 1, "(5) запрос 1: BTC 1h");

      const second = reduceSmcState(first.state, { type: "params", symbol: "BTC", timeframe: "4h" });
      eq(second.fetch?.requestId, 2, "(5) смена timeframe → новый запрос (requestId 2)");
      eq(second.fetch?.url, "/api/chart/smc?symbol=BTC&timeframe=4h", "(5) новый URL с новым timeframe");
      ok(second.abortPrevious, "(5) старый запрос отменяется");
      eq(second.state.panel, { status: "loading", symbol: "BTC", timeframe: "4h" }, "(5) панель снова loading");

      const third = reduceSmcState(second.state, { type: "params", symbol: "ETH", timeframe: "4h" });
      eq(third.fetch?.requestId, 3, "(5) смена symbol → новый запрос (requestId 3)");
      eq(third.fetch?.url, "/api/chart/smc?symbol=ETH&timeframe=4h", "(5) новый URL с новым symbol");

      // Один и тот же symbol/timeframe (например сменилась только биржа
      // свечей) — запрос НЕ пересоздаётся: exchange в params не входит.
      const same = reduceSmcState(third.state, { type: "params", symbol: "ETH", timeframe: "4h" });
      ok(!same.changed && same.fetch === null, "(5) смена только exchange не создаёт SMC-запрос");
      ok(
        !/type:\s*"params";[^}]*exchange/.test(panelCode),
        "(5) в событии params нет поля exchange (asset-level, не биржа свечей)"
      );

      // (6) устаревший ответ не перезаписывает новый state.
      const staleWhileLoading = reduceSmcState(third.state, {
        type: "http-response",
        requestId: 2,
        ok: true,
        httpStatus: 200,
        body: pLong,
      });
      ok(!staleWhileLoading.changed, "(6) ответ requestId 2 при активном 3 игнорируется");
      eq(staleWhileLoading.state.panel.status, "loading", "(6) панель остаётся loading нового запроса");

      const fresh = reduceSmcState(third.state, {
        type: "http-response",
        requestId: 3,
        ok: true,
        httpStatus: 200,
        body: pFive,
      });
      eq(fresh.state.panel.status, "ready", "(6) актуальный ответ принимается");
      eq(
        (fresh.state.panel as Extract<SmcPanelState, { status: "ready" }>).projection.timeframe,
        "5m",
        "(6) в state — проекция актуального запроса"
      );

      const staleAfterFresh = reduceSmcState(fresh.state, {
        type: "http-response",
        requestId: 1,
        ok: true,
        httpStatus: 200,
        body: pLong,
      });
      ok(!staleAfterFresh.changed, "(6) запоздалый ответ requestId 1 не overwrite новый state");
      eq(
        (staleAfterFresh.state.panel as Extract<SmcPanelState, { status: "ready" }>).projection.timeframe,
        "5m",
        "(6) state остался на актуальной проекции"
      );

      const staleError = reduceSmcState(fresh.state, {
        type: "network-error",
        requestId: 2,
        message: SMC_NETWORK_ERROR_MESSAGE,
      });
      ok(!staleError.changed, "(6) устаревшая сетевая ошибка не портит актуальный ready");

      const staleAbort = reduceSmcState(fresh.state, { type: "aborted", requestId: 2 });
      ok(!staleAbort.changed, "(6) aborted устаревшего запроса — no-op");
    }
  }

  // ================================================================
  // 9. (9)(10)(11)(12)(13)(15) Рендер панели
  // ================================================================
  console.log("\n=== 9. Рендер панели (react-dom/server, без новых зависимостей) ===");
  {
    const readyLong: SmcPanelState = { status: "ready", symbol: "BTCUSDT", timeframe: "1h", projection: pLong };
    const readyShort: SmcPanelState = { status: "ready", symbol: "BTCUSDT", timeframe: "1h", projection: pShort };
    const readyFive: SmcPanelState = { status: "ready", symbol: "BTCUSDT", timeframe: "5m", projection: pFive };
    const readyMix: SmcPanelState = { status: "ready", symbol: "BTCUSDT", timeframe: "1h", projection: pMix };
    const readyCannot: SmcPanelState = { status: "ready", symbol: "BTCUSDT", timeframe: "1h", projection: pCannot };
    const readyNone: SmcPanelState = { status: "ready", symbol: "BTCUSDT", timeframe: "5m", projection: pNone };
    const readyDay: SmcPanelState = { status: "ready", symbol: "BTCUSDT", timeframe: "1d", projection: pDay };
    const loading: SmcPanelState = { status: "loading", symbol: "BTCUSDT", timeframe: "1h" };
    const httpError: SmcPanelState = {
      status: "http-error",
      symbol: "BTCUSDT",
      timeframe: "7m",
      httpStatus: 400,
      message: smcHttpErrorMessage(400, { error: "Неверный timeframe: 7m" }),
    };

    // (7/A) OFF — панели в DOM нет вообще.
    eq(renderPanel(SMC_PANEL_OFF, null), "", "(7) OFF: панель не рендерится (скрыта)");

    // (9/A) loading.
    const loadingText = visibleText(renderPanel(loading, null));
    ok(loadingText.includes("Смарт Мани"), "(9/A) loading: заголовок «Смарт Мани»");
    ok(loadingText.includes("Загрузка Smart Money"), "(9/A) loading: явная загрузка");
    ok(loadingText.includes("1 час"), "(9/A) loading: текущий timeframe подписан");
    eq(verdictBadge(renderPanel(loading, null)), null, "(9/A) loading: вердикта ещё нет");
    ok(!loadingText.includes("LONG"), "(9/A) loading: LONG не показывается");
    ok(!loadingText.includes("NEUTRAL"), "(9/A) loading: NEUTRAL не показывается");

    // (9/B) HTTP error — изолирован от свечей.
    const errorMarkup = renderPanel(httpError, null);
    const errorText = visibleText(errorMarkup);
    ok(errorText.includes("Неверный timeframe: 7m"), "(9/B) error: сообщение API показано");
    ok(errorText.includes("HTTP 400"), "(9/B) error: статус показан");
    ok(
      errorText.includes("График свечей продолжает работать"),
      "(8) error: явно сказано, что свечной график не сломан"
    );
    eq(verdictBadge(errorMarkup), null, "(9/B) error: вердикт не показывается");
    ok(!errorText.includes("Нет оценки"), "(9/B) error не выдаётся за cannot-evaluate");
    ok(!errorText.includes("NEUTRAL"), "(9/B) error не выдаётся за NEUTRAL");
    ok(!errorText.includes("Почему"), "(9/B) error: WHY не выдумывается");

    // (9/F)(11) LONG.
    const vmLong = buildSmcPanelViewModel(pLong, "BINANCE");
    const longMarkup = renderPanel(readyLong, vmLong);
    const longText = visibleText(longMarkup);
    eq(verdictBadge(longMarkup), "LONG", "(11) LONG: бейдж LONG");
    ok(longText.includes("Почему"), "(7) LONG: раздел «Почему»");
    ok(longText.includes("биржа свечей на графике"), "(13) LONG: выбранная биржа помечена");
    ok(longText.includes("баллы LONG 75"), "(11) LONG: баллы показаны как баллы");
    ok(longText.includes("Баллы") || longText.includes("баллы"), "(15) баллы названы баллами");
    ok(longText.includes("BTCUSDT"), "LONG: актив показан");
    ok(longText.includes("1 час"), "LONG: timeframe показан русским label");
    ok(longText.includes("Свечи на графике — одна биржа: BINANCE"), "(13) LONG: подписан скоуп свечей");
    ok(longText.includes("агрегированная оценка актива"), "(13) LONG: подписан мультибиржевой скоуп SMC");
    ok(
      longText.includes("Результат выбранной биржи НЕ является агрегатом"),
      "(13) LONG: явное разделение выбранной биржи и агрегата"
    );
    ok(longText.includes("Результаты по биржам (1)"), "(14) LONG: число бирж из DTO");

    // (7) WHY: label/points/value из DTO, ничего не добавлено.
    for (const reason of pLong.overlays[0].reasons) {
      ok(longText.includes(reason.label), `(7) WHY: label ${reason.code} показан`);
      ok(
        longText.includes(`баллы LONG ${reason.longPoints}, SHORT ${reason.shortPoints} (максимум ${reason.maxPoints})`),
        `(7) WHY: баллы ${reason.code} показаны из DTO`
      );
      if (reason.value !== null) {
        ok(longText.includes(reason.value), `(7) WHY: value ${reason.code} показан`);
      }
    }
    ok(!longText.includes("factId"), "(8-P1D) factIds не показываются пользователю (они для P1-D)");

    // (12) SHORT.
    const vmShort = buildSmcPanelViewModel(pShort, "BINANCE");
    eq(verdictBadge(renderPanel(readyShort, vmShort)), "SHORT", "(12) SHORT: бейдж SHORT");
    ok(visibleText(renderPanel(readyShort, vmShort)).includes("баллы SHORT 75"), "(12) SHORT: баллы из DTO");

    // (9/D-E) evaluated NEUTRAL.
    const vmFive = buildSmcPanelViewModel(pFive, "BYBIT");
    const fiveMarkup = renderPanel(readyFive, vmFive);
    eq(verdictBadge(fiveMarkup), "NEUTRAL", "(9/E) evaluated NEUTRAL: бейдж NEUTRAL");
    ok(visibleText(fiveMarkup).includes("Оценка выполнена"), "(9/E) NEUTRAL: сказано, что оценка выполнена");
    ok(!visibleText(fiveMarkup).includes("Нет оценки"), "(9/E) NEUTRAL не показан как cannot-evaluate");
    ok(visibleText(fiveMarkup).includes("Результаты по биржам (5)"), "(14) NEUTRAL: 5 бирж из DTO");
    ok(visibleText(fiveMarkup).includes("Голоса бирж"), "(13) NEUTRAL: голоса бирж показаны");
    for (const name of NAMES) {
      ok(visibleText(fiveMarkup).includes(name), `(14) NEUTRAL: биржа ${name} перечислена из DTO`);
    }

    // (13) конфликт: агрегат NEUTRAL при LONG выбранной биржи.
    const vmMix = buildSmcPanelViewModel(pMix, "BINANCE");
    const mixMarkup = renderPanel(readyMix, vmMix);
    eq(verdictBadge(mixMarkup), "NEUTRAL", "(13) конфликт: бейдж агрегата NEUTRAL");
    ok(visibleText(mixMarkup).includes("конфликт направлений"), "(13) конфликт: помечен");
    ok(visibleText(mixMarkup).includes("биржа свечей на графике"), "(13) конфликт: выбранная биржа помечена отдельно");
    ok(
      visibleText(mixMarkup).includes("направление LONG · баллы LONG 75"),
      "(13) конфликт: per-exchange LONG виден в списке бирж"
    );
    ok(visibleText(mixMarkup).includes("Результаты по биржам (2)"), "(14) конфликт: 2 биржи из DTO");

    // (10/C) cannot-evaluate — НЕ NEUTRAL и не «успешный агрегат».
    const vmCannot = buildSmcPanelViewModel(pCannot, "BINANCE");
    const cannotMarkup = renderPanel(readyCannot, vmCannot);
    const cannotText = visibleText(cannotMarkup);
    eq(verdictBadge(cannotMarkup), "Нет оценки", "(10) cannot-evaluate: бейдж «Нет оценки»");
    ok(cannotText.includes("Это не NEUTRAL"), "(10) cannot-evaluate: прямо сказано «не NEUTRAL»");
    ok(!cannotText.includes("Оценка выполнена"), "(10) cannot-evaluate: не называется выполненной оценкой");
    ok(cannotText.includes("INSUFFICIENT_HISTORY"), "(10/C) причина «недостаточно данных» показана");
    ok(cannotText.includes("Агрегация запрещена gate"), "(10/C) отказ агрегации показан, не спрятан");
    ok(!cannotText.includes("Голоса бирж"), "(10/C) пустые голоса не показываются как успех");
    ok(!cannotText.includes("Подтверждение биржами"), "(10/C) пустое confirmation не показывается как успех");
    ok(cannotText.includes("не оценён"), "(10/C) per-exchange статус «не оценён»");
    ok(cannotText.includes("причин нет"), "(10/C) WHY честно пуст");

    const vmNone = buildSmcPanelViewModel(pNone, "BINANCE");
    const noneText = visibleText(renderPanel(readyNone, vmNone));
    eq(verdictBadge(renderPanel(readyNone, vmNone)), "Нет оценки", "(C) no_participants: бейдж «Нет оценки»");
    ok(noneText.includes("нет участников"), "(C) no_participants: причина показана");
    ok(noneText.includes("Участников для оценки нет"), "(C) no_participants: пустой список бирж объяснён");
    ok(!noneText.includes("Оценка выполнена"), "(C) no_participants не показан как выполненный NEUTRAL");
    ok(!noneText.includes("Голоса бирж"), "(C) no_participants: пустые голоса не показываются");

    // (6/14) 1d: исключённая биржа — из DTO.
    const vmDayBingx = buildSmcPanelViewModel(pDay, "BINGX");
    const dayText = visibleText(renderPanel(readyDay, vmDayBingx));
    ok(dayText.includes("Результаты по биржам (4)"), "(14) 1d: 4 участника из DTO");
    ok(dayText.includes("BINGX"), "(14) 1d: исключённая биржа названа (из DTO)");
    ok(dayText.includes("исключена из Smart Money агрегации"), "(13) 1d: пояснение про исключение выбранной биржи");
    ok(dayText.includes("1 день"), "(14) 1d: timeframe подписан");

    // (15) Никаких «вероятностей»/процентов ни в тексте, ни в view-model.
    const rendered = [
      ["loading", loadingText],
      ["http-error", errorText],
      ["LONG", longText],
      ["SHORT", visibleText(renderPanel(readyShort, vmShort))],
      ["NEUTRAL", visibleText(fiveMarkup)],
      ["conflict", visibleText(mixMarkup)],
      ["cannot-evaluate", cannotText],
      ["no_participants", noneText],
      ["1d", dayText],
    ] as const;
    for (const [name, text] of rendered) {
      ok(!FORBIDDEN_CLAIMS.test(text), `(15) рендер ${name}: нет формулировок о вероятности/шансах`);
      ok(!text.includes("%"), `(15) рендер ${name}: нет процентов`);
    }

    const viewModels = [
      ["LONG", vmLong],
      ["SHORT", vmShort],
      ["NEUTRAL", vmFive],
      ["conflict", vmMix],
      ["cannot-evaluate", vmCannot],
      ["no_participants", vmNone],
      ["1d", vmDayBingx],
    ] as const;
    for (const [name, vm] of viewModels) {
      for (const text of collectStrings(vm)) {
        ok(!FORBIDDEN_CLAIMS.test(text), `(15) view-model ${name}: нет формулировок о вероятности — ${text.slice(0, 60)}`);
        ok(!text.includes("%"), `(15) view-model ${name}: нет процентов — ${text.slice(0, 60)}`);
      }
    }

    const staticTexts = [
      ...Object.values(SMC_VERDICT_LABELS),
      ...Object.values(SMC_VERDICT_NOTES),
      ...Object.values(SMC_HORIZON_STATUS_LABELS),
      SMC_NETWORK_ERROR_MESSAGE,
      smcHttpErrorMessage(500, null),
      formatSmcScore(75),
      formatSmcScore(null),
      formatSmcUtcMs(D_EXPECTED),
      smcDirectionLabel("NEUTRAL"),
      smcMarketStatusLabel("cannot-evaluate"),
    ];
    for (const text of staticTexts) {
      ok(!FORBIDDEN_CLAIMS.test(text), `(15) static label: нет вероятностных формулировок — ${text}`);
      ok(!text.includes("%"), `(15) static label: нет процентов — ${text}`);
    }

    // Статически: в исходнике панели нет «%»/вероятностных слов в строковых литералах.
    const literals = [...panelCode.matchAll(/"([^"\\]*)"|'([^'\\]*)'|`([^`\\]*)`/g)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? ""
    );
    ok(literals.length > 30, "self-check: строковые литералы панели извлечены");
    for (const literal of literals) {
      ok(!literal.includes("%"), `(15) исходник: в литерале нет процента — ${literal.slice(0, 60)}`);
      ok(!FORBIDDEN_CLAIMS.test(literal), `(15) исходник: в литерале нет вероятностных слов — ${literal.slice(0, 60)}`);
    }

    // Формат времени/баллов.
    eq(formatSmcUtcMs(D_EXPECTED), "2026-09-10 00:00 UTC", "format: ms → UTC-строка");
    eq(formatSmcUtcMs(pLong.aggregate.horizonMs!), "2026-01-02 02:00 UTC", "format: горизонт LONG-fixture");
    eq(formatSmcScore(0), "0", "format: нулевые баллы — это 0, не прочерк");
    eq(formatSmcScore(null), "—", "format: null-баллы — прочерк");
  }

  // ================================================================
  // 10. (18) Поведенческий no-write: у fake deps нет write-методов
  // ================================================================
  console.log("\n=== 10. Поведенческий no-write (read-only fake deps) ===");
  {
    const deps = makeDeps({
      assets: [ASSET_BTC],
      strategies: [strategy(7, "1h", 1, { swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 })],
      markets: [marketRow(11, "BINANCE")],
      candles: new Map([[11, canonical()]]),
    });
    const writeNames = [
      "create",
      "createMany",
      "update",
      "updateMany",
      "upsert",
      "delete",
      "deleteMany",
      "$executeRaw",
      "$queryRaw",
    ];
    for (const slice of [deps.asset, deps.strategy, deps.market, deps.candle] as const) {
      for (const name of writeNames) {
        ok(!(name in slice), `(18) no-write: у fake-среза нет метода ${name}`);
      }
    }
    // Ни один UI-модуль графика не имеет доступа к БД/Signal.
    const chartDir = resolve(ROOT, "components/chart");
    for (const file of readdirSync(chartDir).sort()) {
      const code = stripComments(readSource(`components/chart/${file}`));
      ok(
        !/prisma|PrismaClient|@\/lib\/db|createSignal|signalWorker/i.test(code),
        `(18) components/chart/${file}: нет доступа к БД/Signal`
      );
    }
  }

  // ------------------------------------------------------------ итог
  console.log(`\nИТОГО: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error("Проваленные проверки:");
    for (const f of failures) console.error(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("КРИТИЧЕСКАЯ ОШИБКА ТЕСТА:", e);
  process.exitCode = 1;
});
