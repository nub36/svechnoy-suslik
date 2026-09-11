/**
 * P1-A — Smart Money projection: проверки DTO/проекции.
 *
 * Запуск: npx tsx scripts/test-smc-projection.ts
 *
 * ПРИНЦИПЫ (без placeholder/vacuous-тестов):
 *  - fixtures ДЕЙСТВИТЕЛЬНО проходят через evaluateSmc и дают
 *    status="evaluated" с реальными фактами; если fixture деградирует
 *    в cannot-evaluate — тест ПАДАЕТ, а не уходит в mock-ветку;
 *  - «projection == existing Strategy evaluation at same H» проверяется
 *    независимым вызовом evaluateSmartMoneyWithCandles / результатов
 *    evaluateMarketsAtCommonHorizon на ТЕХ ЖЕ свечах;
 *  - статические проверки читают исходники по пути ОТ КОРНЯ ПРОЕКТА
 *    (import.meta.url); сбой чтения = падение теста;
 *  - no-lookahead доказывается на реальных оценках (full vs truncated),
 *    а не декларацией;
 *  - deterministic = JSON-равенство двух независимых прогонов;
 *  - stable IDs = ключи DTO ПОБИТОВО равны ключам движка (сверка с
 *    сырой оценкой на тех же свечах), никаких собственных ID.
 *
 * Временные якоря (всё UTC, canonical grid):
 *  - 5m:  T = 2026-09-11T09:50Z, now = 09:55Z ⇒ ожидаемый latest CLOSED = 09:50Z
 *  - 1d:  now = 2026-09-11T10:00Z ⇒ ожидаемый latest CLOSED = 2026-09-10T00:00Z
 *  - 1h canonical-фикстура: openTime 2026-01-01T00:00Z + i*1h
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  chartTimeToMs,
  msToChartTime,
  scoreReasonFactIds,
  SMC_FVG_KEY_PREFIX,
  SMC_OB_KEY_PREFIX,
  type SmcAggregateSummaryDto,
  type SmcMarketOverlayDto,
} from "../lib/chart/smc-contract";
import {
  projectMarketOverlay,
  projectSmcChart,
  SmcProjectionError,
} from "../lib/chart/smc-projection";
import {
  defaultSmcScoringConfig,
  type SmcScoringConfig,
} from "../lib/smc/config";
import {
  evaluateSmc,
  type SmcEvaluation,
} from "../lib/smc/evaluate";
import {
  SMCTIMEFRAME_MS,
  type SmcRawCandle,
  type SmcStructureResult,
  type SmcTimeframe,
} from "../lib/smc/types";
import {
  truncateCandlesToHorizon,
} from "../lib/strategies/common-horizon";
import {
  evaluateMarketsAtCommonHorizon,
  evaluateSmartMoneyWithCandles,
  type SmartMoneyFilters,
  type SmartMoneyMarketMeta,
} from "../lib/strategies/smart-money";

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

function throws(
  fn: () => unknown,
  label: string,
  matcher?: RegExp
): void {
  try {
    fn();
    console.error(`FAIL: ${label} (не бросило исключение)`);
    failed++;
    failures.push(label);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const good = matcher === undefined || matcher.test(msg);
    if (!good) {
      console.error(`FAIL: ${label} (неподходящее сообщение: ${msg})`);
      failed++;
      failures.push(label);
    } else {
      passed++;
    }
  }
}

// ------------------------------------------------------------ source reader (repo-relative)
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
    throw new Error(
      `пустой исходник ${relPath} — чтение не удалось, тест не пройден`
    );
  }
  return text;
}

// ------------------------------------------------------------ fixtures
const NO_FILTERS: SmartMoneyFilters = {
  top500Only: false,
  minimumQuoteVolume24h: 0,
};
const UNIVERSE_FILTERS: SmartMoneyFilters = {
  top500Only: true,
  minimumQuoteVolume24h: 0,
};

const T0 = Date.UTC(2026, 0, 1); // 2026-01-01T00:00:00Z
const HOUR = 3_600_000;

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

/** Реально evaluable fixture: направленный рынок с импульсами —
 * SMC даёт LONG 75/10 с FVG, OB, range, displacement (проверено движком). */
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

const EPOCH = Date.UTC(2026, 8, 11); // 2026-09-11T00:00:00.000Z
const M5 = SMCTIMEFRAME_MS["5m"];
const D1 = SMCTIMEFRAME_MS["1d"];

function closedTimes(
  endMs: number,
  n: number,
  tf: SmcTimeframe
): number[] {
  const d = SMCTIMEFRAME_MS[tf];
  if (endMs % d !== 0) {
    throw new Error(`endMs ${endMs} не на canonical grid ${tf}`);
  }
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i--) out.push(endMs - i * d);
  return out;
}

/** Треугольная волна (период 48 баров): каждый пик строго выше 20 соседей
 * слева/справа ⇒ swing-структура подтверждена при дефолтных окнах 20/20. */
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

const T = EPOCH + 9 * 3600_000 + 50 * 60_000; // 09:50Z
const NOW_5M = EPOCH + 9 * 3600_000 + 55 * 60_000; // 09:55Z
const D_NOW = Date.UTC(2026, 8, 11, 10, 0, 0);
const D_EXPECTED = Date.UTC(2026, 8, 10);

const NAMES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];

function meta(
  exchange: string,
  marketId: number,
  timeframe: SmcTimeframe,
  rank: number | null = 1
): SmartMoneyMarketMeta {
  return {
    exchange,
    market: "BTCUSDT",
    marketId,
    timeframe,
    assetRank: rank,
    quoteVolume24h: 1_000_000,
  };
}

function market(
  exchange: string,
  marketId: number,
  timeframe: SmcTimeframe,
  candles: SmcRawCandle[],
  rank: number | null = 1
): { meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] } {
  return { meta: meta(exchange, marketId, timeframe, rank), candles };
}

/** Config с узкими окнами: canonical-фикстура (27 свечей) реально
 * оценивается с обоими слоями структуры (swing + internal). */
function canonicalCfg(): SmcScoringConfig {
  return {
    ...defaultSmcScoringConfig("1h"),
    swingLeft: 1,
    swingRight: 1,
    internalLeft: 1,
    internalRight: 1,
  };
}

function lastOpenMs(candles: SmcRawCandle[]): number {
  return candles[candles.length - 1].openTime.getTime();
}

// ------------------------------------------------------------ fake evaluation builder
const AS_OF_MS = T0 + 27 * HOUR;
const AS_OF = new Date(AS_OF_MS);

function fakeStructure(
  overrides: Partial<SmcStructureResult> = {}
): SmcStructureResult {
  return {
    tf: "1h",
    layer: "swing",
    phase: "TREND_UP",
    pivots: [],
    events: [],
    levels: [],
    ...overrides,
  };
}

function fakeEvaluation(
  overrides: Partial<SmcEvaluation> = {}
): SmcEvaluation {
  return {
    tf: "1h",
    asOf: AS_OF,
    availability: { evaluable: true, hardFailures: [], softUnavailable: [] },
    internalStructure: null,
    swingStructure: null,
    displacements: [],
    fvgs: [],
    liquidity: [],
    internalOrderBlocks: [],
    swingOrderBlocks: [],
    dealingRange: null,
    longScore: 0,
    shortScore: 0,
    direction: "NEUTRAL",
    reasons: [],
    ...overrides,
  };
}

function d(ms: number): Date {
  return new Date(ms);
}

const META_1H = meta("BINANCE", 1, "1h");

// ------------------------------------------------------------ MAIN
async function main(): Promise<void> {
  console.log("SMC Projection — P1-A checks");

  // ================================================================
  // 1. Модули чисты (static, source-read)
  // ================================================================
  {
    const contract = readSource("lib/chart/smc-contract.ts");
    const projection = readSource("lib/chart/smc-projection.ts");

    // контракт: только type-only импорты (нет runtime-зависимостей)
    const contractBadImports = contract
      .split("\n")
      .filter((l) => /^import\b/.test(l))
      .filter((l) => !/^import\s+type\b/.test(l));
    ok(
      contractBadImports.length === 0,
      `contract: все импорты type-only (нарушений: ${contractBadImports.length})`
    );

    // проекция: импорты только из ../smc/*, ../strategies/*, ./smc-contract
    const specifiers: string[] = [];
    for (const m of projection.matchAll(/from\s+["']([^"']+)["']/g)) {
      specifiers.push(m[1]);
    }
    const badSpecifiers = specifiers.filter(
      (s) => !/^\.\.\/(smc|strategies)\//.test(s) && s !== "./smc-contract"
    );
    ok(
      badSpecifiers.length === 0,
      `projection: импорты только smc/strategies/contract (нарушения: ${JSON.stringify(badSpecifiers)})`
    );

    const forbidden: Array<[string, RegExp]> = [
      ["Date.now(", /Date\.now\(/],
      ["Math.random", /Math\.random/],
      ["localStorage.", /localStorage\./],
      ["window.", /window\./],
      ["document.", /document\./],
      ["fetch(", /\bfetch\s*\(/],
      ["@prisma/client", /@prisma\/client/],
      ["next/", /["']next\//],
      ["react", /["']react/],
      ["Signal-модуль", /["']signal["']|new\s+Signal\b/],
    ];
    for (const [name, re] of forbidden) {
      ok(
        !re.test(contract) && !re.test(projection),
        `чистота: нет ${name} ни в contract, ни в projection`
      );
    }

    // aggregate DTO статически не содержит overlay-типов/полей
    const aggBlock =
      /export interface SmcAggregateSummaryDto \{[\s\S]*?\n\}/.exec(
        contract
      )?.[0] ?? "";
    ok(
      aggBlock.length > 0,
      "aggregate: интерфейс SmcAggregateSummaryDto найден в contract"
    );
    ok(
      !/OverlayDto/.test(aggBlock),
      "aggregate (static): нет ссылок на OverlayDto-типы"
    );
    ok(
      !/\b(pivots|structureEvents|levels|liquidity|fvgs|orderBlocks|dealingRange|displacements)\b/.test(
        aggBlock
      ),
      "aggregate (static): нет overlay-полей в интерфейсе"
    );
  }

  // ================================================================
  // 2. ms → lightweight-chart seconds
  // ================================================================
  {
    eq(msToChartTime(1_752_600_000), 1_752_600, "msToChartTime: ровное деление");
    eq(msToChartTime(1_752_600_999), 1_752_600, "msToChartTime: floor на дробных секундах");
    eq(chartTimeToMs(1_752_600), 1_752_600_000, "chartTimeToMs: обратная конвертация");
    eq(chartTimeToMs(msToChartTime(T0)), T0, "roundtrip: ms → seconds → ms не теряет секундную сетку");
    ok(
      msToChartTime(T0) < T0 / 100 && Number.isInteger(msToChartTime(T0)),
      "домены разделены: domain ms (~1.7e12) → chart seconds (~1.7e9)"
    );
  }

  // ================================================================
  // 3. WHY → factIds: только exact existing key mapping
  // ================================================================
  {
    const obKey = "SMC1|OB|1h|up|swing|SMC1|E|1h|swing|BOS|up|P|1|2";
    const fvgKey = "SMC1|FVG|1h|down|1767290400000";
    const why = (
      code: string,
      value: string | null,
      longPoints = 0,
      shortPoints = 0
    ) => ({ code, value, longPoints, shortPoints });

    eq(
      scoreReasonFactIds(why("SWING_ORDER_BLOCK", obKey, 15, 0), []),
      [obKey],
      "factIds: SWING_ORDER_BLOCK value === exact ob.key"
    );
    eq(
      scoreReasonFactIds(why("INTERNAL_ORDER_BLOCK", obKey, 5, 0), []),
      [obKey],
      "factIds: INTERNAL_ORDER_BLOCK value === exact ob.key"
    );
    eq(
      scoreReasonFactIds(why("FVG", fvgKey, 0, 10), []),
      [fvgKey],
      "factIds: FVG value === exact fvg.key"
    );
    eq(
      scoreReasonFactIds(why("SWING_ORDER_BLOCK", null), []),
      [],
      "factIds: OB reason без value → []"
    );
    eq(
      scoreReasonFactIds(why("FVG", null), []),
      [],
      "factIds: FVG reason без value → []"
    );
    eq(
      scoreReasonFactIds(why("SWING_ORDER_BLOCK", fvgKey), []),
      [],
      "factIds: OB reason с FVG-ключом (чужой формат) → []"
    );
    eq(
      scoreReasonFactIds(why("FVG", obKey), []),
      [],
      "factIds: FVG reason с OB-ключом (чужой формат) → []"
    );
    for (const code of [
      "SWING_TREND",
      "RECENT_SWING_BOS",
      "INTERNAL_TREND",
      "LIQUIDITY_SWEEP",
      "RANGE_POSITION",
      "DIRECTION_CONFLICT",
    ]) {
      eq(
        scoreReasonFactIds(why(code, "TREND_UP"), []),
        [],
        `factIds: ${code} не является exact ключом → []`
      );
    }
    eq(
      scoreReasonFactIds(why("LIQUIDITY_SWEEP", "SELL_SIDE @2026-01-01T00:00:00.000Z", 10, 0), []),
      [],
      "factIds: LIQUIDITY_SWEEP value (side@time) не восстанавливает level key → []"
    );
    eq(
      scoreReasonFactIds(why("SOME_UNKNOWN_WHY", fvgKey, 1, 0), []),
      [],
      "factIds: неизвестный reason-код → []"
    );

    // confluence: ровно те же выбранные факты (swing preferred, потом internal)
    eq(
      scoreReasonFactIds(why("OB_FVG_CONFLUENCE", null, 5, 0), [
        why("SWING_ORDER_BLOCK", obKey, 15, 0),
        why("INTERNAL_ORDER_BLOCK", obKey + "|i", 5, 0),
        why("FVG", fvgKey, 10, 0),
      ]),
      [obKey, fvgKey],
      "factIds: confluence с points = [выбранный swing OB key, FVG key]"
    );
    eq(
      scoreReasonFactIds(why("OB_FVG_CONFLUENCE", null, 5, 0), [
        why("SWING_ORDER_BLOCK", null, 0, 0),
        why("INTERNAL_ORDER_BLOCK", obKey + "|i", 5, 0),
        why("FVG", fvgKey, 10, 0),
      ]),
      [obKey + "|i", fvgKey],
      "factIds: confluence при отсутствии swing OB = [internal OB key, FVG key]"
    );
    eq(
      scoreReasonFactIds(why("OB_FVG_CONFLUENCE", null, 0, 0), [
        why("SWING_ORDER_BLOCK", obKey, 15, 0),
        why("FVG", fvgKey, 10, 0),
      ]),
      [],
      "factIds: confluence без points → []"
    );
  }

  // ================================================================
  // 4. Реально evaluable fixture + projection == Strategy at same H
  // ================================================================
  {
    const cfg = canonicalCfg();
    const candles = canonical();
    const now = new Date(lastOpenMs(candles) + HOUR);
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [market("BINANCE", 1, "1h", candles)],
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now,
    });

    ok(projection.overlays.length === 1, "fixture: 1 рынок → 1 оверлей");
    const overlay = projection.overlays[0];
    ok(overlay.status === "evaluated", "fixture реально оценивается: evaluated (не mock)");
    eq(overlay.direction, "LONG", "fixture: direction LONG");
    eq(overlay.longScore, 75, "fixture: longScore 75");
    eq(overlay.shortScore, 10, "fixture: shortScore 10");

    // существующая Strategy-оценка на ТЕХ ЖЕ свечах, усечённых до H
    const H = lastOpenMs(candles);
    const truncated = truncateCandlesToHorizon(candles, new Date(H));
    const strategyResult = evaluateSmartMoneyWithCandles(
      meta("BINANCE", 1, "1h"),
      truncated,
      cfg,
      NO_FILTERS
    );
    ok(strategyResult.status === "evaluated", "equality: strategy evaluated на том же H");
    if (strategyResult.status === "evaluated") {
      eq(overlay.direction, strategyResult.direction, "equality: direction == Strategy");
      eq(overlay.longScore, strategyResult.longScore, "equality: longScore == Strategy");
      eq(overlay.shortScore, strategyResult.shortScore, "equality: shortScore == Strategy");
      eq(overlay.horizonMs, strategyResult.candleTime.getTime(), "equality: horizonMs == Strategy candleTime");
    }

    // и через существующий multi-exchange пайплайн
    const outcome = evaluateMarketsAtCommonHorizon(
      [{ meta: meta("BINANCE", 1, "1h"), candles }],
      "1h",
      cfg,
      NO_FILTERS,
      now
    );
    const result0 = outcome.results[0];
    ok(result0 !== undefined && result0.status === "evaluated", "equality: common-horizon пайплайн evaluated");
    if (result0 !== undefined && result0.status === "evaluated") {
      eq(overlay.direction, result0.direction, "equality: direction == evaluateMarketsAtCommonHorizon");
      eq(overlay.longScore, result0.longScore, "equality: longScore == evaluateMarketsAtCommonHorizon");
      eq(overlay.shortScore, result0.shortScore, "equality: shortScore == evaluateMarketsAtCommonHorizon");
    }

    // факты реальные и непустые
    ok(overlay.pivots.length > 0, "fixture: pivots непусты");
    ok(
      overlay.pivots.some((p) => p.layer === "swing") &&
        overlay.pivots.some((p) => p.layer === "internal"),
      "fixture: swing и internal слои pivots"
    );
    ok(overlay.structureEvents.length > 0, "fixture: BOS/CHOCH события есть");
    ok(overlay.levels.length > 0, "fixture: structural levels есть");
    ok(overlay.liquidity.length > 0, "fixture: liquidity есть");
    ok(overlay.fvgs.length > 0, "fixture: FVG есть");
    ok(overlay.orderBlocks.length > 0, "fixture: order blocks есть");
    ok(overlay.displacements.length > 0, "fixture: displacement есть");
    ok(
      overlay.dealingRange !== null && overlay.dealingRange.priceContext !== null,
      "fixture: dealing range + price context есть"
    );

    // score-инвариант в DTO (как в движке: сумма по компонентам == scores)
    const comps = overlay.reasons.filter((r) => r.code !== "DIRECTION_CONFLICT");
    const sumL = comps.reduce((s, r) => s + r.longPoints, 0);
    const sumS = comps.reduce((s, r) => s + r.shortPoints, 0);
    eq(sumL, overlay.longScore, "DTO score invariant: Σ longPoints == longScore");
    eq(sumS, overlay.shortScore, "DTO score invariant: Σ shortPoints == shortScore");

    // stable IDs: ключи DTO ПОБИТОВО равны ключам сырой оценки на тех же свечах
    const raw = evaluateSmc(truncated, cfg, new Date(H + HOUR));
    const rawKeys = {
      pivots: new Set([
        ...(raw.swingStructure?.pivots ?? []),
        ...(raw.internalStructure?.pivots ?? []),
      ].map((p) => p.key)),
      events: new Set([
        ...(raw.swingStructure?.events ?? []),
        ...(raw.internalStructure?.events ?? []),
      ].map((e) => e.key)),
      levels: new Set([
        ...(raw.swingStructure?.levels ?? []),
        ...(raw.internalStructure?.levels ?? []),
      ].map((l) => l.pivotKey)),
      liquidity: new Set(raw.liquidity.map((l) => l.key)),
      fvgs: new Set(raw.fvgs.map((f) => f.key)),
      orderBlocks: new Set([
        ...raw.swingOrderBlocks,
        ...raw.internalOrderBlocks,
      ].map((o) => o.key)),
      displacements: new Set(raw.displacements.map((x) => x.key)),
    };
    ok(
      overlay.pivots.every((p) => rawKeys.pivots.has(p.key)) &&
        overlay.pivots.length === rawKeys.pivots.size,
      "stable IDs: pivots keys 1:1 с движком"
    );
    ok(
      overlay.structureEvents.every((e) => rawKeys.events.has(e.key)) &&
        overlay.structureEvents.length === rawKeys.events.size,
      "stable IDs: events keys 1:1 с движком"
    );
    ok(
      overlay.levels.every((l) => rawKeys.levels.has(l.pivotKey)) &&
        overlay.levels.length === rawKeys.levels.size,
      "stable IDs: levels keys 1:1 с движком"
    );
    ok(
      overlay.liquidity.every((l) => rawKeys.liquidity.has(l.key)) &&
        overlay.liquidity.length === rawKeys.liquidity.size,
      "stable IDs: liquidity keys 1:1 с движком"
    );
    ok(
      overlay.fvgs.every((f) => rawKeys.fvgs.has(f.key)) &&
        overlay.fvgs.length === rawKeys.fvgs.size,
      "stable IDs: fvgs keys 1:1 с движком"
    );
    ok(
      overlay.orderBlocks.every((o) => rawKeys.orderBlocks.has(o.key)) &&
        overlay.orderBlocks.length === rawKeys.orderBlocks.size,
      "stable IDs: orderBlocks keys 1:1 с движком"
    );
    ok(
      overlay.displacements.every((x) => rawKeys.displacements.has(x.key)) &&
        overlay.displacements.length === rawKeys.displacements.size,
      "stable IDs: displacements keys 1:1 с движком"
    );
    const allKeys = [
      ...overlay.pivots.map((x) => x.key),
      ...overlay.structureEvents.map((x) => x.key),
      ...overlay.levels.map((x) => x.pivotKey),
      ...overlay.liquidity.map((x) => x.key),
      ...overlay.fvgs.map((x) => x.key),
      ...overlay.orderBlocks.map((x) => x.key),
      ...overlay.displacements.map((x) => x.key),
    ];
    ok(
      allKeys.length > 0 && allKeys.every((k) => k.startsWith("SMC1|")),
      "stable IDs: все ключи — deterministic SMC1|-формат"
    );
    ok(
      overlay.engineAsOfMs === H + HOUR,
      "engineAsOfMs === effectiveCloseTime(H)"
    );

    // WHY→factIds exact на РЕАЛЬНОЙ оценке
    const fvgReason = overlay.reasons.find((r) => r.code === "FVG");
    const swingObReason = overlay.reasons.find(
      (r) => r.code === "SWING_ORDER_BLOCK"
    );
    const internalObReason = overlay.reasons.find(
      (r) => r.code === "INTERNAL_ORDER_BLOCK"
    );
    ok(
      fvgReason !== undefined &&
        fvgReason.value !== null &&
        fvgReason.value.startsWith(SMC_FVG_KEY_PREFIX),
      "factIds (real): FVG reason value — exact fvg.key формата"
    );
    ok(
      fvgReason !== undefined &&
        JSON.stringify(fvgReason.factIds) === JSON.stringify([fvgReason.value]) &&
        overlay.fvgs.some((f) => f.key === fvgReason.value),
      "factIds (real): FVG factIds === [fvg.key] и key есть в overlay"
    );
    ok(
      swingObReason !== undefined &&
        swingObReason.value !== null &&
        swingObReason.value.startsWith(SMC_OB_KEY_PREFIX) &&
        JSON.stringify(swingObReason.factIds) ===
          JSON.stringify([swingObReason.value]) &&
        overlay.orderBlocks.some((o) => o.key === swingObReason.value),
      "factIds (real): SWING_ORDER_BLOCK factIds === [ob.key] и key есть в overlay"
    );
    ok(
      internalObReason !== undefined &&
        internalObReason.value !== null &&
        internalObReason.value.startsWith(SMC_OB_KEY_PREFIX) &&
        JSON.stringify(internalObReason.factIds) ===
          JSON.stringify([internalObReason.value]) &&
        overlay.orderBlocks.some((o) => o.key === internalObReason.value),
      "factIds (real): INTERNAL_ORDER_BLOCK factIds === [ob.key] и key есть в overlay"
    );
    const liquidityReason = overlay.reasons.find(
      (r) => r.code === "LIQUIDITY_SWEEP"
    );
    ok(
      liquidityReason !== undefined && liquidityReason.factIds.length === 0,
      "factIds (real): LIQUIDITY_SWEEP без exact key → []"
    );

    // агрегат одного рынка
    const agg = projection.aggregate;
    ok(agg.usable && agg.status === "ok", "aggregate: usable/ok для evaluable fixture");
    eq(agg.horizonMs, H, "aggregate: horizonMs === H");
    eq(agg.engineAsOfMs, H + HOUR, "aggregate: engineAsOfMs === effClose(H)");
    eq(agg.participantCount, 1, "aggregate: participantCount 1");
    eq(agg.evaluatedCount, 1, "aggregate: evaluatedCount 1");
    eq(agg.direction, "LONG", "aggregate: direction LONG при minExchanges 1");
    ok(agg.gateAllowed, "aggregate: gateAllowed true");
    eq(agg.perExchange.length, 1, "aggregate: perExchange 1 сводка");
    eq(agg.perExchange[0].horizonMs, overlay.horizonMs, "aggregate: perExchange.horizonMs == overlay.horizonMs");
  }

  // ================================================================
  // 5. 5-market common horizon summary (wave 5m, все 5 бирж)
  // ================================================================
  {
    const cfg = defaultSmcScoringConfig("5m");
    const mkMarket = (ex: string, i: number) =>
      market(ex, i, "5m", waveCandles(closedTimes(T, 200, "5m")));
    const input = {
      assetSymbol: "BTCUSDT",
      timeframe: "5m" as SmcTimeframe,
      markets: NAMES.map((ex, i) => mkMarket(ex, i + 1)),
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 3,
      now: new Date(NOW_5M),
    };
    const projection = projectSmcChart(input);

    eq(projection.overlays.length, 5, "5-market: 5 per-exchange оверлеев");
    ok(
      projection.overlays.every((o) => o.status === "evaluated"),
      "5-market: все 5 бирж evaluated (fixture реально оценивается)"
    );
    ok(
      projection.overlays.every((o) => o.direction === "NEUTRAL"),
      "5-market: wave fixture → NEUTRAL у всех (честная оценка движка)"
    );
    ok(
      projection.overlays.every(
        (o) =>
          o.pivots.some((p) => p.layer === "swing") &&
          o.pivots.some((p) => p.layer === "internal")
      ),
      "5-market: swing + internal слои у каждой биржи"
    );

    const agg = projection.aggregate;
    ok(agg.usable && agg.status === "ok", "5-market: common horizon usable");
    eq(agg.horizonMs, T, "5-market: common horizon === 09:50Z");
    eq(agg.expectedLatestClosedMs, T, "5-market: expectedLatestClosed === 09:50Z");
    eq(agg.participantCount, 5, "5-market: participantCount 5");
    eq(agg.evaluatedCount, 5, "5-market: evaluatedCount 5");
    eq(agg.cannotEvaluateCount, 0, "5-market: cannotEvaluateCount 0");
    eq(agg.direction, "NEUTRAL", "5-market: aggregate NEUTRAL");
    eq(agg.longVotes, 0, "5-market: longVotes 0");
    eq(agg.shortVotes, 0, "5-market: shortVotes 0");
    eq(agg.neutralVotes, 5, "5-market: neutralVotes 5");
    eq(agg.confirmation, "0/5", "5-market: confirmation 0/5");
    ok(agg.gateAllowed && agg.gateRefusalReasons.length === 0, "5-market: gate пустил агрегацию");
    eq(agg.exchangeExcluded, [], "5-market: eligibility ничего не исключила (5m)");
    eq(
      agg.perExchange.map((s) => s.exchange),
      NAMES,
      "5-market: perExchange в порядке входа"
    );

    // projection == существующая Strategy-оценка на том же H (5 рынков)
    const outcome = evaluateMarketsAtCommonHorizon(
      input.markets,
      "5m",
      cfg,
      NO_FILTERS,
      new Date(NOW_5M)
    );
    let eqCount = 0;
    for (let i = 0; i < 5; i++) {
      const o = projection.overlays[i];
      const r = outcome.results[i];
      const strategy = evaluateSmartMoneyWithCandles(
        input.markets[i].meta,
        truncateCandlesToHorizon(
          input.markets[i].candles,
          new Date(T)
        ),
        cfg,
        NO_FILTERS
      );
      if (
        r !== undefined &&
        strategy.status === "evaluated" &&
        r.status === "evaluated" &&
        o.direction === r.direction &&
        o.direction === strategy.direction &&
        o.longScore === r.longScore &&
        o.longScore === strategy.longScore &&
        o.shortScore === r.shortScore &&
        o.shortScore === strategy.shortScore &&
        o.horizonMs === r.candleTime.getTime() &&
        o.horizonMs === strategy.candleTime.getTime()
      ) {
        eqCount++;
      }
    }
    eq(eqCount, 5, "5-market: все 5 оверлеев == Strategy-оценке на том же H");

    // deterministic: два независимых прогона JSON-равны
    const again = projectSmcChart({
      ...input,
      markets: input.markets.map((m) => ({
        meta: { ...m.meta },
        candles: m.candles.map((c) => ({ ...c })),
      })),
      now: new Date(NOW_5M),
    });
    eq(
      JSON.stringify(again),
      JSON.stringify(projection),
      "deterministic: два прогона дают побайтово одинаковый DTO"
    );
  }

  // ================================================================
  // 6. 5-market LONG (canonical × 5 бирж, 1h)
  // ================================================================
  {
    const cfg = canonicalCfg();
    const now = new Date(lastOpenMs(canonical()) + HOUR);
    const markets = NAMES.map((ex, i) =>
      market(ex, i + 1, "1h", canonical())
    );
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets,
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 3,
      now,
    });
    ok(
      projection.overlays.length === 5 &&
        projection.overlays.every((o) => o.status === "evaluated"),
      "5-market LONG: 5 evaluated оверлеев"
    );
    ok(
      projection.overlays.every(
        (o) => o.direction === "LONG" && o.longScore === 75 && o.shortScore === 10
      ),
      "5-market LONG: direction/scores идентичны на каждой бирже"
    );
    ok(
      projection.overlays.every(
        (o) => o.fvgs.length > 0 && o.orderBlocks.length > 0 && o.dealingRange !== null
      ),
      "5-market LONG: факты (FVG/OB/range) у каждой биржи — per-exchange, без общих"
    );
    const agg = projection.aggregate;
    eq(agg.direction, "LONG", "5-market LONG: aggregate LONG");
    eq(agg.longVotes, 5, "5-market LONG: longVotes 5");
    eq(agg.confirmation, "5/5", "5-market LONG: confirmation 5/5");
  }

  // ================================================================
  // 7. Eligibility: BINGX исключается для 1d (Option A)
  // ================================================================
  {
    const cfg = defaultSmcScoringConfig("1d");
    const markets = NAMES.map((ex, i) =>
      market(ex, i + 1, "1d", waveCandles(closedTimes(D_EXPECTED, 200, "1d")))
    );
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1d",
      markets,
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 3,
      now: new Date(D_NOW),
    });
    eq(
      projection.overlays.map((o) => o.exchange),
      ["BINANCE", "BYBIT", "GATE", "KUCOIN"],
      "1d: BINGX исключён eligibility — 4 оверлея"
    );
    eq(
      projection.aggregate.exchangeExcluded,
      ["BINGX"],
      "1d: aggregate.exchangeExcluded === [BINGX]"
    );
    eq(projection.aggregate.participantCount, 4, "1d: participantCount 4");
    eq(projection.aggregate.horizonMs, D_EXPECTED, "1d: общий горизонт не зависит от BINGX");
    ok(
      projection.aggregate.usable && projection.aggregate.status === "ok",
      "1d: 4/4 участвуют и горизонт usable"
    );
  }

  // ================================================================
  // 8. Strategy filters: top500Only (Top-100) → filtered
  // ================================================================
  {
    const cfg = canonicalCfg();
    const now = new Date(lastOpenMs(canonical()) + HOUR);
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [
        market("BINANCE", 1, "1h", canonical(), 1),
        market("BYBIT", 2, "1h", canonical(), 500),
      ],
      smcConfig: cfg,
      filters: UNIVERSE_FILTERS,
      minExchanges: 1,
      now,
    });
    eq(projection.overlays.length, 2, "filters: 2 оверлея (evaluated + filtered)");
    eq(projection.overlays[0].status, "evaluated", "filters: rank 1 → evaluated");
    eq(projection.overlays[1].status, "filtered", "filters: rank 500 → filtered");
    ok(
      (projection.overlays[1].statusReason ?? "").includes("Top-100"),
      "filters: причина filtered ссылается на Top-100 universe"
    );
    ok(
      projection.overlays[1].pivots.length === 0 &&
        projection.overlays[1].horizonMs === null,
      "filters: filtered-оверлей без фактов и без горизонта"
    );
    eq(projection.aggregate.participantCount, 1, "filters: participantCount 1 (filtered не участник)");
    eq(projection.aggregate.filteredCount, 1, "filters: filteredCount 1");
    eq(projection.aggregate.evaluatedCount, 1, "filters: evaluatedCount 1");

    // все отфильтрованы → no_participants, overlays []
    const allFiltered = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [market("BINANCE", 1, "1h", canonical(), 500)],
      smcConfig: cfg,
      filters: UNIVERSE_FILTERS,
      minExchanges: 1,
      now,
    });
    eq(allFiltered.overlays, [], "filters: все отфильтрованы → overlays []");
    eq(allFiltered.aggregate.status, "no_participants", "filters: status no_participants");
    ok(!allFiltered.aggregate.usable, "filters: aggregate unusable");
    ok(
      (allFiltered.aggregate.statusReason ?? "").length > 0,
      "filters: statusReason непустой"
    );
  }

  // ================================================================
  // 9. Unusable common horizon (relative lag) → явный отказ
  // ================================================================
  {
    const cfg = defaultSmcScoringConfig("1d");
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1d",
      markets: [
        market("BINANCE", 1, "1d", waveCandles(closedTimes(D_EXPECTED, 200, "1d"))),
        market("BYBIT", 2, "1d", waveCandles(closedTimes(D_EXPECTED - 5 * D1, 200, "1d"))),
      ],
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now: new Date(D_NOW),
    });
    eq(projection.overlays, [], "unusable: overlays [] при relative_lag_stale");
    eq(
      projection.aggregate.status,
      "relative_lag_stale",
      "unusable: status relative_lag_stale"
    );
    ok(!projection.aggregate.usable, "unusable: aggregate unusable");
    eq(projection.aggregate.direction, null, "unusable: агрегация не выполнялась (direction null)");
    ok(
      projection.aggregate.gateRefusalReasons.length > 0,
      "unusable: отказ объяснён в gateRefusalReasons"
    );
    ok(
      projection.aggregate.lagBars !== null && projection.aggregate.lagBars >= 5,
      "unusable: диагностика lagBars сохранена"
    );
  }

  // ================================================================
  // 10. NO-LOOKAHEAD / CLOSED-only
  // ================================================================
  {
    const cfg = canonicalCfg();
    const candles = canonical();
    const H = candles[20].openTime.getTime(); // 2026-01-01T20:00Z
    const engineAsOf = H + HOUR;
    const truncated = candles.filter((c) => c.openTime.getTime() <= H);
    ok(truncated.length < candles.length, "no-lookahead: H действительно отсекает свечи");

    const eFull = evaluateSmc(candles, cfg, new Date(engineAsOf));
    const eTrunc = evaluateSmc(truncated, cfg, new Date(engineAsOf));
    const fullDto = projectMarketOverlay(META_1H, eFull, H, engineAsOf);
    const truncDto = projectMarketOverlay(META_1H, eTrunc, H, engineAsOf);
    eq(
      JSON.stringify(fullDto),
      JSON.stringify(truncDto),
      "no-lookahead: проекция на H не видит свечи > H (full ≡ truncated)"
    );
    ok(
      fullDto.pivots.every((p) => p.confirmedAtMs <= engineAsOf) &&
        fullDto.structureEvents.every((e) => e.confirmedAtMs <= engineAsOf) &&
        fullDto.fvgs.every((f) => f.confirmedAtMs <= engineAsOf),
      "no-lookahead: все confirmedAtMs <= engineAsOf"
    );

    // asOf движка ≠ engineAsOf проекции → жёсткий отказ
    throws(
      () => projectMarketOverlay(META_1H, eFull, H, engineAsOf - HOUR),
      "no-lookahead: evaluation.asOf ≠ engineAsOf → SmcProjectionError",
      /lookahead-контракт/
    );

    // подделанная оценка с confirmedAt > engineAsOf → факт НЕ показывается
    const tampered = structuredClone(eTrunc) as SmcEvaluation;
    const fakePivot = {
      key: "SMC1|P|1h|swing|high|9999999999999",
      layer: "swing" as const,
      kind: "high" as const,
      price: 999,
      eventTime: new Date(engineAsOf + 60_000),
      confirmedAt: new Date(engineAsOf + 120_000),
    };
    tampered.swingStructure = {
      ...tampered.swingStructure!,
      pivots: [...tampered.swingStructure!.pivots, fakePivot],
    };
    const tamperedDto = projectMarketOverlay(META_1H, tampered, H, engineAsOf);
    ok(
      !tamperedDto.pivots.some((p) => p.key === fakePivot.key),
      "no-lookahead: факт с confirmedAt > engineAsOf не показывается"
    );
    eq(
      tamperedDto.pivots.length,
      truncDto.pivots.length,
      "no-lookahead: остальные факты сохранены (drop точечный)"
    );

    // CLOSED-only: лишняя OPEN-свеча после H не меняет проекцию
    const withOpen = [
      ...candles,
      {
        openTime: new Date(lastOpenMs(candles) + HOUR),
        open: 87,
        high: 88,
        low: 86,
        close: 87.5,
        closed: false,
      },
    ];
    const pClosed = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [market("BINANCE", 1, "1h", candles)],
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now: new Date(lastOpenMs(candles) + HOUR),
    });
    const pOpen = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [market("BINANCE", 1, "1h", withOpen)],
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now: new Date(lastOpenMs(candles) + HOUR),
    });
    eq(
      JSON.stringify(pClosed),
      JSON.stringify(pOpen),
      "CLOSED-only: OPEN-свеча после H не влияет на проекцию"
    );
  }

  // ================================================================
  // 11. Range position НЕ clamp (<0 и >1), outsideRange сохраняется
  // ================================================================
  {
    const rangeBase = {
      key: "SMC1|RANGE|1h|up|SMC1|E|1h|swing|BOS|up|P|1|2",
      tf: "1h" as const,
      direction: "up" as const,
      anchorStartPivotKey: "P1",
      anchorEndPivotKey: "P2",
      low: 100,
      high: 200,
      eventTime: d(AS_OF_MS - 3 * HOUR),
      confirmedAt: d(AS_OF_MS - 2 * HOUR),
      replacedAt: null,
      equilibrium: 150,
    };
    const evalWithPrice = (price: number): SmcEvaluation =>
      fakeEvaluation({
        longScore: 10,
        shortScore: 0,
        direction: "LONG",
        dealingRange: {
          asOf: AS_OF,
          history: [],
          current: rangeBase,
          priceContext: {
            price,
            position: (price - 100) / 100,
            eqBand: 0.02,
            zone:
              price > 200
                ? "PREMIUM"
                : price < 100
                  ? "DISCOUNT"
                  : "EQUILIBRIUM",
            outsideRange: price > 200 || price < 100,
          },
        },
      });

    const above = projectMarketOverlay(
      META_1H,
      evalWithPrice(250),
      AS_OF_MS - HOUR,
      AS_OF_MS
    );
    ok(above.dealingRange !== null, "range: dealingRange спроецирован");
    eq(above.dealingRange!.priceContext!.position, 1.5, "range: position 1.5 НЕ clamp до 1");
    eq(above.dealingRange!.priceContext!.zone, "PREMIUM", "range: zone PREMIUM");
    ok(above.dealingRange!.priceContext!.outsideRange, "range: outsideRange true (>1)");

    const below = projectMarketOverlay(
      META_1H,
      evalWithPrice(50),
      AS_OF_MS - HOUR,
      AS_OF_MS
    );
    eq(below.dealingRange!.priceContext!.position, -0.5, "range: position -0.5 НЕ clamp до 0");
    eq(below.dealingRange!.priceContext!.zone, "DISCOUNT", "range: zone DISCOUNT");
    ok(below.dealingRange!.priceContext!.outsideRange, "range: outsideRange true (<0)");

    const inside = projectMarketOverlay(
      META_1H,
      evalWithPrice(150),
      AS_OF_MS - HOUR,
      AS_OF_MS
    );
    eq(inside.dealingRange!.priceContext!.position, 0.5, "range: in-range position 0.5");
    eq(inside.dealingRange!.priceContext!.zone, "EQUILIBRIUM", "range: zone EQUILIBRIUM");
    ok(!inside.dealingRange!.priceContext!.outsideRange, "range: outsideRange false внутри");

    // нет активного range → dealingRange: null (без подделки)
    const noRange = projectMarketOverlay(
      META_1H,
      fakeEvaluation({
        longScore: 5,
        shortScore: 0,
        direction: "LONG",
        dealingRange: { asOf: AS_OF, history: [], current: null, priceContext: null },
      }),
      AS_OF_MS - HOUR,
      AS_OF_MS
    );
    eq(noRange.dealingRange, null, "range: current null → dealingRange null");
  }

  // ================================================================
  // 12. Lifecycle states сохраняются 1:1
  // ================================================================
  {
    const t = (offsetMs: number): Date => d(AS_OF_MS - 10 * HOUR + offsetMs);

    const evalLife = fakeEvaluation({
      longScore: 40,
      shortScore: 5,
      direction: "LONG",
      reasons: [],
      swingStructure: fakeStructure({
        layer: "swing",
        pivots: [
          { key: "SMC1|P|1h|swing|high|1", layer: "swing", kind: "high", price: 110, eventTime: t(0), confirmedAt: t(2 * HOUR) },
          { key: "SMC1|P|1h|swing|low|2", layer: "swing", kind: "low", price: 90, eventTime: t(HOUR), confirmedAt: t(3 * HOUR) },
        ],
        events: [
          {
            key: "SMC1|E|1h|swing|BOS|up|SMC1|P|1h|swing|high|1|3",
            layer: "swing", type: "BOS", dir: "up",
            brokenPivotKey: "SMC1|P|1h|swing|high|1",
            brokenLevelPrice: 110, eventTime: t(3 * HOUR), confirmedAt: t(4 * HOUR),
            protectedAnchor: { pivotKey: "SMC1|P|1h|swing|low|2", kind: "low", price: 90, eventTime: t(HOUR), confirmedAt: t(3 * HOUR) },
          },
        ],
        levels: [
          { pivotKey: "SMC1|P|1h|swing|high|1", layer: "swing", kind: "high", price: 110, eventTime: t(0), confirmedAt: t(2 * HOUR), state: "CONSUMED", consumedAt: t(4 * HOUR), consumedByEventKey: "SMC1|E|1h|swing|BOS|up|SMC1|P|1h|swing|high|1|3" },
          { pivotKey: "SMC1|P|1h|swing|low|2", layer: "swing", kind: "low", price: 90, eventTime: t(HOUR), confirmedAt: t(3 * HOUR), state: "AVAILABLE", consumedAt: null, consumedByEventKey: null },
        ],
      }),
      internalStructure: fakeStructure({
        layer: "internal",
        pivots: [
          { key: "SMC1|P|1h|internal|high|3", layer: "internal", kind: "high", price: 105, eventTime: t(0), confirmedAt: t(2 * HOUR) },
          { key: "SMC1|P|1h|internal|low|4", layer: "internal", kind: "low", price: 95, eventTime: t(HOUR), confirmedAt: t(3 * HOUR) },
        ],
        events: [
          {
            key: "SMC1|E|1h|internal|CHOCH|up|SMC1|P|1h|internal|high|3|5",
            layer: "internal", type: "CHOCH", dir: "up",
            brokenPivotKey: "SMC1|P|1h|internal|high|3",
            brokenLevelPrice: 105, eventTime: t(3 * HOUR), confirmedAt: t(4 * HOUR),
            protectedAnchor: { pivotKey: "SMC1|P|1h|internal|high|3", kind: "high", price: 105, eventTime: t(0), confirmedAt: t(2 * HOUR) },
          },
          {
            key: "SMC1|E|1h|internal|CHOCH_INVALIDATED|down|SMC1|P|1h|internal|low|4|6",
            layer: "internal", type: "CHOCH_INVALIDATED", dir: "down",
            brokenPivotKey: "SMC1|P|1h|internal|low|4",
            brokenLevelPrice: 95, eventTime: t(4 * HOUR), confirmedAt: t(5 * HOUR),
            protectedAnchor: null,
          },
        ],
      }),
      liquidity: [
        { key: "SMC1|LQ|1h|BUY_SIDE|STRUCTURAL|1", tf: "1h", side: "BUY_SIDE", origin: "STRUCTURAL", price: 110, sourcePivotKeys: ["SMC1|P|1h|swing|high|1"], eventTime: t(0), createdAt: t(2 * HOUR), state: "OPEN", resolvedAt: null, resolvedByCandleTime: null, sweepPenetrationAtr: null },
        { key: "SMC1|LQ|1h|SELL_SIDE|STRUCTURAL|2", tf: "1h", side: "SELL_SIDE", origin: "STRUCTURAL", price: 90, sourcePivotKeys: ["SMC1|P|1h|swing|low|2"], eventTime: t(HOUR), createdAt: t(3 * HOUR), state: "SWEPT", resolvedAt: t(5 * HOUR), resolvedByCandleTime: t(4 * HOUR), sweepPenetrationAtr: 0.05 },
        { key: "SMC1|LQ|1h|BUY_SIDE|EQH_EQL|3", tf: "1h", side: "BUY_SIDE", origin: "EQH_EQL", price: 108, sourcePivotKeys: [], eventTime: t(HOUR), createdAt: t(3 * HOUR), state: "BROKEN", resolvedAt: t(5 * HOUR), resolvedByCandleTime: t(4 * HOUR), sweepPenetrationAtr: null },
        { key: "SMC1|LQ|1h|SELL_SIDE|EQH_EQL|4", tf: "1h", side: "SELL_SIDE", origin: "EQH_EQL", price: 92, sourcePivotKeys: [], eventTime: t(2 * HOUR), createdAt: t(4 * HOUR), state: "EXPIRED", resolvedAt: null, resolvedByCandleTime: null, sweepPenetrationAtr: null },
      ],
      fvgs: [
        { key: "SMC1|FVG|1h|up|1", tf: "1h", direction: "up", bottom: 100, top: 105, ce: 102.5, gapSize: 5, sizeAtr: 0.2, eventTime: t(0), confirmedAt: t(2 * HOUR), firstTouchedAt: null, ceTouchedAt: null, fullFilledByExcursionAt: null, invalidatedByCloseAt: null, expiredAt: null, fillFraction: 0, state: "OPEN" },
        { key: "SMC1|FVG|1h|up|2", tf: "1h", direction: "up", bottom: 101, top: 106, ce: 103.5, gapSize: 5, sizeAtr: 0.2, eventTime: t(HOUR), confirmedAt: t(3 * HOUR), firstTouchedAt: t(4 * HOUR), ceTouchedAt: null, fullFilledByExcursionAt: null, invalidatedByCloseAt: null, expiredAt: null, fillFraction: 0.4, state: "TOUCHED" },
        { key: "SMC1|FVG|1h|up|3", tf: "1h", direction: "up", bottom: 102, top: 107, ce: 104.5, gapSize: 5, sizeAtr: 0.2, eventTime: t(2 * HOUR), confirmedAt: t(4 * HOUR), firstTouchedAt: t(5 * HOUR), ceTouchedAt: t(6 * HOUR), fullFilledByExcursionAt: null, invalidatedByCloseAt: null, expiredAt: null, fillFraction: 0.6, state: "CE_MITIGATED" },
        { key: "SMC1|FVG|1h|up|4", tf: "1h", direction: "up", bottom: 103, top: 108, ce: 105.5, gapSize: 5, sizeAtr: 0.2, eventTime: t(3 * HOUR), confirmedAt: t(5 * HOUR), firstTouchedAt: t(6 * HOUR), ceTouchedAt: t(7 * HOUR), fullFilledByExcursionAt: t(8 * HOUR), invalidatedByCloseAt: null, expiredAt: null, fillFraction: 1, state: "FILLED_BY_EXCURSION" },
        { key: "SMC1|FVG|1h|up|5", tf: "1h", direction: "up", bottom: 104, top: 109, ce: 106.5, gapSize: 5, sizeAtr: 0.2, eventTime: t(4 * HOUR), confirmedAt: t(6 * HOUR), firstTouchedAt: null, ceTouchedAt: null, fullFilledByExcursionAt: null, invalidatedByCloseAt: null, expiredAt: t(9 * HOUR), fillFraction: 0, state: "EXPIRED" },
        { key: "SMC1|FVG|1h|up|6", tf: "1h", direction: "up", bottom: 105, top: 110, ce: 107.5, gapSize: 5, sizeAtr: 0.2, eventTime: t(5 * HOUR), confirmedAt: t(7 * HOUR), firstTouchedAt: null, ceTouchedAt: null, fullFilledByExcursionAt: null, invalidatedByCloseAt: t(9 * HOUR), expiredAt: null, fillFraction: 0, state: "INVALIDATED" },
      ],
      swingOrderBlocks: [
        { key: "SMC1|OB|1h|up|swing|E1|1", tf: "1h", direction: "up", layer: "swing", bottom: 95, top: 105, eventTime: t(0), impulseStartAt: t(0), impulseEndAt: t(2 * HOUR), structureEventKey: "E1", structureEventType: "BOS", structureEventTime: t(3 * HOUR), confirmedAt: t(4 * HOUR), firstTouchedAt: null, firstMitigatedAt: null, maxPenetrationFraction: 0, retests: 0, invalidatedAt: null, expiredAt: null, preConfirmationTouches: 0, hasFvgInImpulse: false, hasLiquiditySweepBeforeImpulse: false, state: "OPEN" },
        { key: "SMC1|OB|1h|down|swing|E2|2", tf: "1h", direction: "down", layer: "swing", bottom: 85, top: 95, eventTime: t(HOUR), impulseStartAt: t(HOUR), impulseEndAt: t(3 * HOUR), structureEventKey: "E2", structureEventType: "BOS", structureEventTime: t(4 * HOUR), confirmedAt: t(5 * HOUR), firstTouchedAt: t(6 * HOUR), firstMitigatedAt: t(8 * HOUR), maxPenetrationFraction: 0.3, retests: 1, invalidatedAt: null, expiredAt: null, preConfirmationTouches: 0, hasFvgInImpulse: false, hasLiquiditySweepBeforeImpulse: false, state: "MITIGATED" },
      ],
      internalOrderBlocks: [
        { key: "SMC1|OB|1h|up|internal|E3|3", tf: "1h", direction: "up", layer: "internal", bottom: 97, top: 103, eventTime: t(2 * HOUR), impulseStartAt: t(2 * HOUR), impulseEndAt: t(4 * HOUR), structureEventKey: "E3", structureEventType: "CHOCH", structureEventTime: t(5 * HOUR), confirmedAt: t(6 * HOUR), firstTouchedAt: null, firstMitigatedAt: null, maxPenetrationFraction: 0, retests: 0, invalidatedAt: t(9 * HOUR), expiredAt: null, preConfirmationTouches: 1, hasFvgInImpulse: false, hasLiquiditySweepBeforeImpulse: false, state: "INVALIDATED" },
        { key: "SMC1|OB|1h|down|internal|E4|4", tf: "1h", direction: "down", layer: "internal", bottom: 89, top: 99, eventTime: t(3 * HOUR), impulseStartAt: t(3 * HOUR), impulseEndAt: t(5 * HOUR), structureEventKey: "E4", structureEventType: "BOS", structureEventTime: t(6 * HOUR), confirmedAt: t(7 * HOUR), firstTouchedAt: null, firstMitigatedAt: null, maxPenetrationFraction: 0, retests: 0, invalidatedAt: null, expiredAt: t(9 * HOUR), preConfirmationTouches: 0, hasFvgInImpulse: false, hasLiquiditySweepBeforeImpulse: false, state: "EXPIRED" },
      ],
      displacements: [
        { key: "SMC1|D|1h|up|10", tf: "1h", direction: "up", eventTime: t(0), confirmedAt: t(2 * HOUR), bodyAtr: 1.6, rangeAtr: 2.1, closeLocation: 0.65 },
      ],
    });

    const dto = projectMarketOverlay(META_1H, evalLife, AS_OF_MS - HOUR, AS_OF_MS);

    const byKey = <T extends { key: string }>(arr: T[]): Map<string, T> =>
      new Map(arr.map((x) => [x.key, x]));
    const pivotMap = byKey(dto.pivots);
    eq(pivotMap.get("SMC1|P|1h|swing|high|1")?.kind, "high", "lifecycle: swing high pivot сохранён");
    eq(pivotMap.get("SMC1|P|1h|internal|low|4")?.layer, "internal", "lifecycle: internal low pivot сохранён");
    eq(dto.pivots.length, 4, "lifecycle: 4 пивота (2 слоя × 2 рода)");

    eq(
      dto.structureEvents.map((e) => e.type).sort(),
      ["BOS", "CHOCH", "CHOCH_INVALIDATED"],
      "lifecycle: BOS/CHOCH/CHOCH_INVALIDATED сохранены"
    );
    eq(
      dto.structureEvents.find((e) => e.type === "CHOCH")!.protectedAnchorKey,
      "SMC1|P|1h|internal|high|3",
      "lifecycle: protectedAnchor key CHOCH сохранён"
    );
    eq(
      dto.structureEvents.find((e) => e.type === "CHOCH_INVALIDATED")!.protectedAnchorKey,
      null,
      "lifecycle: protectedAnchor null сохранён"
    );

    eq(
      dto.levels.map((l) => l.state).sort(),
      ["AVAILABLE", "CONSUMED"],
      "lifecycle: level states AVAILABLE/CONSUMED"
    );
    eq(
      dto.levels.find((l) => l.state === "CONSUMED")!.consumedByEventKey,
      "SMC1|E|1h|swing|BOS|up|SMC1|P|1h|swing|high|1|3",
      "lifecycle: consumedByEventKey сохранён"
    );

    eq(
      dto.liquidity.map((l) => l.state).sort(),
      ["BROKEN", "EXPIRED", "OPEN", "SWEPT"],
      "lifecycle: liquidity states OPEN/SWEPT/BROKEN/EXPIRED"
    );
    eq(
      dto.liquidity.find((l) => l.state === "SWEPT")!.resolvedAtMs,
      t(5 * HOUR).getTime(),
      "lifecycle: resolvedAt (ms) сохранён"
    );
    eq(
      dto.liquidity.find((l) => l.state === "SWEPT")!.sweepPenetrationAtr,
      0.05,
      "lifecycle: sweepPenetrationAtr сохранён"
    );

    eq(
      dto.fvgs.map((f) => f.state).sort(),
      ["CE_MITIGATED", "EXPIRED", "FILLED_BY_EXCURSION", "INVALIDATED", "OPEN", "TOUCHED"],
      "lifecycle: все 6 FVG-состояний сохранены"
    );
    eq(
      dto.orderBlocks.map((o) => o.state).sort(),
      ["EXPIRED", "INVALIDATED", "MITIGATED", "OPEN"],
      "lifecycle: все 4 OB-состояния сохранены"
    );
    ok(
      dto.orderBlocks.some((o) => o.layer === "swing") &&
        dto.orderBlocks.some((o) => o.layer === "internal"),
      "lifecycle: OB слои swing/internal различимы"
    );
    eq(
      dto.orderBlocks.find((o) => o.state === "MITIGATED")!.firstMitigatedAtMs,
      t(8 * HOUR).getTime(),
      "lifecycle: firstMitigatedAt (ms) сохранён"
    );
    eq(
      dto.displacements.length,
      1,
      "lifecycle: displacement сохранён (optional layer)"
    );
    eq(
      dto.displacements[0].bodyAtr,
      1.6,
      "lifecycle: displacement payload сохранён"
    );
  }

  // ================================================================
  // 13. cannot-evaluate ≠ NEUTRAL
  // ================================================================
  {
    // реальный движок: недостаточно истории → cannot-evaluate (не NEUTRAL)
    const cfg = defaultSmcScoringConfig("1h");
    const short = flats(0, 2);
    const now = new Date(lastOpenMs(short) + HOUR);
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [market("BINANCE", 1, "1h", short)],
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now,
    });
    const overlay = projection.overlays[0];
    eq(overlay.status, "cannot-evaluate", "cannot-evaluate: status отличен от evaluated");
    eq(overlay.direction, null, "cannot-evaluate: direction null (не NEUTRAL)");
    eq(overlay.longScore, null, "cannot-evaluate: longScore null");
    ok(
      (overlay.statusReason ?? "").includes("INSUFFICIENT_HISTORY"),
      "cannot-evaluate: причина содержит INSUFFICIENT_HISTORY"
    );
    ok(
      overlay.pivots.length === 0 && overlay.reasons.length === 0,
      "cannot-evaluate: никаких фактов/причин не подделывается"
    );
    eq(projection.aggregate.evaluatedCount, 0, "cannot-evaluate: aggregate evaluatedCount 0");
    eq(projection.aggregate.cannotEvaluateCount, 1, "cannot-evaluate: aggregate cannotEvaluateCount 1");
    eq(projection.aggregate.direction, null, "cannot-evaluate: агрегация без голосов → direction null");

    // тот же движок, но NEUTRAL-исход (threshold недостижим) → evaluated NEUTRAL
    const neutralCfg: SmcScoringConfig = {
      ...canonicalCfg(),
      minimumScore: 90,
    };
    const neutral = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [market("BINANCE", 1, "1h", canonical())],
      smcConfig: neutralCfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now: new Date(lastOpenMs(canonical()) + HOUR),
    });
    eq(neutral.overlays[0].status, "evaluated", "NEUTRAL: остаётся evaluated");
    eq(neutral.overlays[0].direction, "NEUTRAL", "NEUTRAL: direction NEUTRAL (не cannot-evaluate)");
    ok(
      neutral.overlays[0].longScore !== null,
      "NEUTRAL: scores присутствуют (0..100)"
    );
    eq(neutral.aggregate.direction, "NEUTRAL", "NEUTRAL: агрегация NEUTRAL при 1 голосе NEUTRAL");
  }

  // ================================================================
  // 14. Aggregate DTO не содержит overlays (runtime)
  // ================================================================
  {
    const cfg = canonicalCfg();
    const now = new Date(lastOpenMs(canonical()) + HOUR);
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: NAMES.map((ex, i) => market(ex, i + 1, "1h", canonical())),
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 3,
      now,
    });
    const agg = projection.aggregate as SmcAggregateSummaryDto;
    const aggKeys = Object.keys(agg).sort();
    const allowedAggKeys = [
      "absoluteLagBars",
      "absoluteLagMs",
      "absoluteMaxLagBars",
      "cannotEvaluateCount",
      "confirmation",
      "conflict",
      "direction",
      "engineAsOfMs",
      "evaluatedCount",
      "exchangeExcluded",
      "filteredCount",
      "gateAllowed",
      "gateRefusalReasons",
      "horizonMs",
      "lagBars",
      "lagMs",
      "longVotes",
      "minExchanges",
      "neutralVotes",
      "newestHorizonMs",
      "nowMs",
      "expectedLatestClosedMs",
      "participantCount",
      "perExchange",
      "relativeMaxLagBars",
      "shortVotes",
      "status",
      "statusReason",
      "timeframe",
      "usable",
    ].sort();
    eq(aggKeys, allowedAggKeys, "aggregate (runtime): ровно whitelist-ключи сводки");
    const overlayFieldNames = [
      "pivots",
      "structureEvents",
      "levels",
      "liquidity",
      "fvgs",
      "orderBlocks",
      "dealingRange",
      "displacements",
    ];
    ok(
      !aggKeys.some((k) => overlayFieldNames.includes(k)),
      "aggregate (runtime): нет overlay-полей"
    );
    ok(
      agg.perExchange.every((s) => {
        const keys = Object.keys(s).sort();
        return (
          JSON.stringify(keys) ===
          JSON.stringify(
            ["direction", "exchange", "horizonMs", "longScore", "market", "marketId", "shortScore", "status"].sort()
          )
        );
      }),
      "aggregate (runtime): perExchange — только сводки, без фактов"
    );
    ok(
      agg.perExchange.length === projection.overlays.length &&
        projection.overlays.length === 5,
      "aggregate (runtime): 5 per-exchange сводок строго разделены с 5 оверлеями"
    );
  }

  // ================================================================
  // 15. Валидация входа проекции (fail-closed)
  // ================================================================
  {
    const cfg = canonicalCfg();
    const now = new Date(lastOpenMs(canonical()) + HOUR);
    const base = {
      assetSymbol: "BTCUSDT",
      timeframe: "1h" as SmcTimeframe,
      markets: [market("BINANCE", 1, "1h", canonical())],
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now,
    };
    throws(
      () => projectSmcChart({ ...base, timeframe: "7m" as SmcTimeframe }),
      "validation: timeframe вне белого списка → SmcProjectionError",
      /вне белого списка/
    );
    throws(
      () =>
        projectSmcChart({
          ...base,
          smcConfig: defaultSmcScoringConfig("4h"),
        }),
      "validation: smcConfig.tf ≠ timeframe → SmcProjectionError",
      /не совпадает с timeframe проекции/
    );
    throws(
      () => projectSmcChart({ ...base, minExchanges: 0 }),
      "validation: minExchanges 0 → SmcProjectionError"
    );
    throws(
      () => projectSmcChart({ ...base, minExchanges: 6 }),
      "validation: minExchanges 6 → SmcProjectionError"
    );
    throws(
      () =>
        projectSmcChart({
          ...base,
          filters: { top500Only: "yes" as unknown as boolean, minimumQuoteVolume24h: 0 },
        }),
      "validation: filters некорректны → SmcProjectionError"
    );
    throws(
      () => projectSmcChart({ ...base, now: new Date("not-a-date") }),
      "validation: now невалиден → SmcProjectionError"
    );
    throws(
      () => projectSmcChart({ ...base, assetSymbol: "  " }),
      "validation: assetSymbol пустой → SmcProjectionError"
    );
    throws(
      () =>
        projectMarketOverlay(
          META_1H,
          fakeEvaluation(),
          AS_OF_MS - HOUR,
          Number.NaN
        ),
      "validation: projectMarketOverlay engineAsOfMs не-число → SmcProjectionError"
    );
  }

  // ================================================================
  // 16. ms-домен: все таймстемпы DTO — целые миллисекунды
  // ================================================================
  {
    const cfg = canonicalCfg();
    const projection = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [market("BINANCE", 1, "1h", canonical())],
      smcConfig: cfg,
      filters: NO_FILTERS,
      minExchanges: 1,
      now: new Date(lastOpenMs(canonical()) + HOUR),
    });
    const o = projection.overlays[0] as SmcMarketOverlayDto;
    const msFields: number[] = [
      ...o.pivots.flatMap((p) => [p.eventTimeMs, p.confirmedAtMs]),
      ...o.structureEvents.flatMap((e) => [e.eventTimeMs, e.confirmedAtMs]),
      ...o.levels.flatMap((l) => [l.eventTimeMs, l.confirmedAtMs]),
      ...o.liquidity.flatMap((l) => [l.eventTimeMs, l.createdAtMs]),
      ...o.fvgs.flatMap((f) => [f.eventTimeMs, f.confirmedAtMs]),
      ...o.orderBlocks.flatMap((b) => [
        b.eventTimeMs,
        b.impulseStartAtMs,
        b.impulseEndAtMs,
        b.structureEventTimeMs,
        b.confirmedAtMs,
      ]),
      ...o.displacements.flatMap((x) => [x.eventTimeMs, x.confirmedAtMs]),
      o.horizonMs ?? NaN,
      o.engineAsOfMs ?? NaN,
    ];
    ok(
      msFields.length > 0 &&
        msFields.every((v) => Number.isInteger(v) && v >= 1_000_000_000_000),
      "ms-домен: все DTO-таймстемпы — целые миллисекунды (>= 1e12)"
    );
    ok(
      msFields.every((v) => Number.isInteger(msToChartTime(v)) && msToChartTime(v) >= 1_000_000_000),
      "ms-домен: msToChartTime даёт целые lightweight-chart секунды (~1e9)"
    );
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
