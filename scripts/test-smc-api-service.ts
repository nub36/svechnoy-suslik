/**
 * P1-B — Smart Money chart API: проверки service-границы.
 *
 * Запуск: npx tsx scripts/test-smc-api-service.ts
 *
 * ПРИНЦИПЫ (без placeholder/vacuous-тестов):
 *  - сервис (lib/chart/smc-api-service.ts) тестируется через детерминированный
 *    fake SmcChartApiDeps, структурно совместимый с Prisma, — БЕЗ production БД
 *    и БЕЗ её мутаций: у fake ТОЛЬКО findUnique/findFirst/findMany, поэтому
 *    любая попытка write из сервиса падает TypeError — поведенческий no-write
 *    гарант, а не мок-тест «route returns 200»;
 *  - fixtures ДЕЙСТВИТЕЛЬНО проходят через evaluateSmc и дают evaluated;
 *    деградация в cannot-evaluate — падение теста, а не mock-ветка;
 *  - «exact DTO projection preservation» проверяется независимым вызовом
 *    projectSmcChart на ТЕХ ЖЕ входных данных (JSON-равенство);
 *  - статические проверки читают исходники от корня проекта (import.meta.url);
 *    сбой чтения = падение теста;
 *  - no future/open candle leakage доказывается на реальных оценках
 *    (лишняя OPEN-свеча после горизонта не меняет DTO);
 *  - deterministic = JSON-равенство двух независимых прогонов сервиса.
 *
 * Временные якоря (UTC, canonical grid) — те же, что в P1-A:
 *  - 1h canonical: openTime 2026-01-01T00:00Z + i*1h
 *  - 5m: T = 2026-09-11T09:50Z, now = 09:55Z
 *  - 1d: now = 2026-09-11T10:00Z, ожидаемый latest CLOSED = 2026-09-10T00:00Z
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildSmcChartProjection,
  type SmcChartApiDeps,
  type SmcChartApiRequest,
  type SmcChartApiStrategyRow,
  type SmcChartApiAssetRow,
  type SmcChartApiMarketRow,
  type SmcChartApiCandleRow,
} from "../lib/chart/smc-api-service";
import {
  projectSmcChart,
} from "../lib/chart/smc-projection";
import {
  validateSmartMoneyRuntime,
  SMART_MONEY_SLUG,
  type SmartMoneyMarketMeta,
} from "../lib/strategies/smart-money";
import {
  SMCTIMEFRAME_MS,
  type SmcRawCandle,
  type SmcTimeframe,
} from "../lib/smc/types";

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

// ------------------------------------------------------------ fixtures (те же, что в P1-A)
const T0 = Date.UTC(2026, 0, 1);
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

/** Реально evaluable fixture (как в P1-A): направленный рынок с
 * импульсами — при swing/internal окнах 1/1 даёт LONG 75/10 с FVG,
 * OB, range, displacement. */
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

const EPOCH = Date.UTC(2026, 8, 11);
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

// ------------------------------------------------------------ Strategy JSON fixture
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

/** Валидный Strategy JSON (форма production, см. test-smart-money). */
function strategyRaw(
  overrides: {
    minimumSignalScore?: number;
    swingLeft?: number;
    swingRight?: number;
    internalLeft?: number;
    internalRight?: number;
  } = {}
): Record<string, unknown> {
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

// ------------------------------------------------------------ fake deps (READ-ONLY)
type FakeStore = {
  assets: SmcChartApiAssetRow[];
  strategies: SmcChartApiStrategyRow[];
  markets: SmcChartApiMarketRow[];
  /** marketId → свечи ASC (fake сам применит DESC+take как Prisma). */
  candles: Map<number, SmcRawCandle[]>;
};

/**
 * Детерминированный fake: структурная форма SmcChartApiDeps и Prisma.
 * Содержит ТОЛЬКО методы чтения — если сервис попытается что-то записать,
 * получит TypeError (поведенческий no-write гарант).
 */
function makeDeps(store: FakeStore): SmcChartApiDeps {
  return {
    asset: {
      findUnique: async (args: unknown) => {
        const where = (args as { where?: { symbol?: string } }).where ?? {};
        const symbol = where.symbol;
        const row = store.assets.find((a) => a.symbol === symbol);
        return row === undefined ? null : { ...row };
      },
    },
    strategy: {
      findFirst: async (args: unknown) => {
        const where = (args as { where?: { slug?: string } }).where ?? {};
        const matching = store.strategies.filter(
          (s) => s.slug === where.slug
        );
        if (matching.length === 0) return null;
        matching.sort((a, b) => b.version - a.version);
        return { ...matching[0] };
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
        const rows: SmcChartApiCandleRow[] =
          (store.candles.get(w.marketId ?? -1) ?? [])
            .filter(
              (c) => w.closed === undefined || c.closed === w.closed
            )
            .map((c) => ({ ...c }));
        // Prisma-семантика loader'а: DESC по openTime, take N.
        rows.sort((a, b) => b.openTime.getTime() - a.openTime.getTime());
        const taken = a.take !== undefined ? rows.slice(0, a.take) : rows;
        return taken;
      },
    },
  };
}

/** Строка рынка (fixtures используют один актив, fake отдаёт все рынки). */
function marketRow(
  id: number,
  exchange: string,
  _assetId: number,
  quoteVolume24h: number | null = 1_000_000
): SmcChartApiMarketRow {
  return {
    id,
    exchange,
    exchangeSymbol: "BTCUSDT",
    quoteVolume24h,
  };
}

const ASSET_BTC: SmcChartApiAssetRow = {
  id: 1,
  symbol: "BTCUSDT",
  rank: 1,
};

function btcStore(
  markets: SmcChartApiMarketRow[],
  candles: Map<number, SmcRawCandle[]>,
  strategies: SmcChartApiStrategyRow[] = [
    {
      slug: SMART_MONEY_SLUG,
      version: 1,
      config: strategyRaw(),
      timeframes: ["5m", "15m", "1h", "4h", "1d"],
      minExchanges: 3,
    },
  ]
): FakeStore {
  return {
    assets: [ASSET_BTC],
    strategies,
    markets,
    candles,
  };
}

function req(
  symbol: string | null | undefined,
  timeframe: string | null | undefined,
  now = new Date(NOW_5M)
): SmcChartApiRequest {
  return { symbol, timeframe, now };
}

// ------------------------------------------------------------ MAIN
async function main(): Promise<void> {
  console.log("SMC API Service — P1-B checks");

  // ================================================================
  // 1. Статика: read-only гарантии и только-GET route
  // ================================================================
  {
    const service = readSource("lib/chart/smc-api-service.ts");
    const route = readSource("app/api/chart/smc/route.ts");

    // Route: только GET (никаких POST/PUT/PATCH/DELETE).
    const routeVerbs = [...route.matchAll(/export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
    eq(routeVerbs, ["GET"], "read-only route: экспортируется ТОЛЬКО GET");

    // Route: нет write-вызовов Prisma и нет Signal.
    const writeCall = /\b(createMany|updateMany|deleteMany|upsert|executeRaw|queryRaw|signals?)\s*\(/;
    const createCall = /\bcreate\s*\(/;
    const updateCall = /\bupdate\s*\(/;
    const deleteCall = /\bdelete\s*\(/;
    ok(
      !writeCall.test(route) && !createCall.test(route) && !updateCall.test(route) && !deleteCall.test(route),
      "read-only route: нет Prisma create/update/upsert/delete/$executeRaw/$queryRaw/signal"
    );

    // Service: интерфейс deps — только четыре read-среза и только find*.
    const depsBlock =
      /export interface SmcChartApiDeps \{[\s\S]*?\n\}/.exec(service)?.[0] ?? "";
    ok(depsBlock.length > 0, "service: интерфейс SmcChartApiDeps найден");
    ok(
      /\basset:\s*\{[\s\S]*?findUnique\s*\(/m.test(depsBlock) &&
        /\bstrategy:\s*\{[\s\S]*?findFirst\s*\(/m.test(depsBlock) &&
        /\bmarket:\s*\{[\s\S]*?findMany\s*\(/m.test(depsBlock) &&
        /\bcandle:\s*\{[\s\S]*?findMany\s*\(/m.test(depsBlock),
      "service: deps = asset.findUnique + strategy.findFirst + market.findMany + candle.findMany"
    );
    ok(
      !/\b(create|update|upsert|delete|executeRaw|queryRaw|signals?)\s*\(/.test(depsBlock),
      "service: в интерфейсе deps нет write-методов"
    );

    // Service: импорты только из чистых chart/smc/strategies-слоёв.
    const specifiers: string[] = [];
    for (const m of service.matchAll(/from\s+["']([^"']+)["']/g)) {
      specifiers.push(m[1]);
    }
    const badSpecifiers = specifiers.filter(
      (s) =>
        !/^\.\.\/(smc|strategies)\//.test(s) &&
        s !== "./params" &&
        s !== "./smc-projection" &&
        s !== "./smc-contract"
    );
    ok(
      badSpecifiers.length === 0,
      `service: нет Next/React/Prisma/DB-импортов (нарушения: ${JSON.stringify(badSpecifiers)})`
    );

    // Ни route, ни service не хардкодят engineering config.
    ok(
      !/defaultSmcScoringConfig/.test(route) && !/defaultSmcScoringConfig/.test(service),
      "service/route: нет hardcoded defaultSmcScoringConfig (Strategy берётся из БД)"
    );
    ok(
      /SMART_MONEY_SLUG/.test(service),
      "service: используется существующий SMART_MONEY_SLUG"
    );
  }

  // ================================================================
  // 2. Валидация параметров (malformed/unsupported)
  // ================================================================
  {
    const deps = makeDeps(btcStore([], new Map()));

    const badSymbol = await buildSmcChartProjection(deps, req("bt c!", "1h"));
    ok(!badSymbol.ok && badSymbol.code === "INVALID_SYMBOL" && badSymbol.status === 400, "400: malformed symbol → INVALID_SYMBOL");

    const longSymbol = await buildSmcChartProjection(deps, req("AAAAAAAAAAAAAAAAA", "1h"));
    ok(!longSymbol.ok && longSymbol.code === "INVALID_SYMBOL" && longSymbol.status === 400, "400: слишком длинный symbol → INVALID_SYMBOL");

    const missingSymbol = await buildSmcChartProjection(deps, req(null, "1h"));
    ok(!missingSymbol.ok && missingSymbol.code === "INVALID_SYMBOL" && missingSymbol.status === 400, "400: symbol отсутствует → INVALID_SYMBOL");

    const badTf = await buildSmcChartProjection(deps, req("BTCUSDT", "2h"));
    ok(!badTf.ok && badTf.code === "INVALID_TIMEFRAME" && badTf.status === 400, "400: unsupported timeframe 2h → INVALID_TIMEFRAME");

    const malformedTf = await buildSmcChartProjection(deps, req("BTCUSDT", "1H"));
    ok(!malformedTf.ok && malformedTf.code === "INVALID_TIMEFRAME" && malformedTf.status === 400, "400: malformed timeframe 1H (регистр) → INVALID_TIMEFRAME");

    const missingTf = await buildSmcChartProjection(deps, req("BTCUSDT", null));
    ok(!missingTf.ok && missingTf.code === "INVALID_TIMEFRAME" && missingTf.status === 400, "400: timeframe отсутствует → INVALID_TIMEFRAME");

    const badNow = await buildSmcChartProjection(deps, req("BTCUSDT", "1h", new Date("not-a-date")));
    ok(!badNow.ok && badNow.status === 400, "400: невалидный now → 400 (не 500)");
  }

  // ================================================================
  // 3. Asset/markets/data отсутствуют
  // ================================================================
  {
    const deps = makeDeps(btcStore([], new Map()));

    const missingAsset = await buildSmcChartProjection(
      makeDeps({
        assets: [],
        strategies: btcStore([], new Map()).strategies,
        markets: [],
        candles: new Map(),
      }),
      req("BTCUSDT", "1h")
    );
    ok(
      !missingAsset.ok && missingAsset.code === "ASSET_NOT_FOUND" && missingAsset.status === 404,
      "404: актив отсутствует → ASSET_NOT_FOUND"
    );

    // Актив есть, рынков нет → НЕ ошибка: честный DTO no_participants.
    const noMarkets = await buildSmcChartProjection(deps, req("BTCUSDT", "1h"));
    ok(noMarkets.ok, "no-markets: сервис вернул DTO (не 500/не подделка)");
    if (noMarkets.ok) {
      eq(noMarkets.projection.overlays, [], "no-markets: overlays []");
      eq(noMarkets.projection.aggregate.status, "no_participants", "no-markets: aggregate.status = no_participants");
      ok(!noMarkets.projection.aggregate.usable, "no-markets: aggregate unusable");
      eq(noMarkets.projection.aggregate.direction, null, "no-markets: direction null (не NEUTRAL)");
    }

    // Рынки есть, свечей нет → честный DTO data_unavailable.
    const noCandles = await buildSmcChartProjection(
      makeDeps(btcStore([marketRow(11, "BINANCE", 1)], new Map())),
      req("BTCUSDT", "1h")
    );
    ok(noCandles.ok, "no-candles: сервис вернул DTO (не 500)");
    if (noCandles.ok) {
      eq(noCandles.projection.aggregate.status, "data_unavailable", "no-candles: aggregate.status = data_unavailable");
      eq(noCandles.projection.overlays, [], "no-candles: overlays []");
      eq(noCandles.projection.aggregate.direction, null, "no-candles: direction null (не NEUTRAL)");
    }
  }

  // ================================================================
  // 4. Strategy: отсутствует / невалидна / timeframe не поддержан
  // ================================================================
  {
    const candles = new Map([[11, canonical()]]);
    const markets = [marketRow(11, "BINANCE", 1)];

    const noStrategy = await buildSmcChartProjection(
      makeDeps({ assets: [ASSET_BTC], strategies: [], markets, candles }),
      req("BTCUSDT", "1h")
    );
    ok(
      !noStrategy.ok && noStrategy.code === "STRATEGY_MISSING" && noStrategy.status === 503,
      "503: стратегия отсутствует → STRATEGY_MISSING (без тихого дефолта)"
    );

    const invalidStrategy = await buildSmcChartProjection(
      makeDeps({
        assets: [ASSET_BTC],
        strategies: [
          {
            slug: SMART_MONEY_SLUG,
            version: 1,
            config: { minimumSignalScore: 72 },
            timeframes: ["1h"],
            minExchanges: 3,
          },
        ],
        markets,
        candles,
      }),
      req("BTCUSDT", "1h")
    );
    ok(
      !invalidStrategy.ok && invalidStrategy.code === "STRATEGY_INVALID" && invalidStrategy.status === 503,
      "503: невалидный config → STRATEGY_INVALID (без тихого дефолта)"
    );

    const tfUnsupported = await buildSmcChartProjection(
      makeDeps({
        assets: [ASSET_BTC],
        strategies: [
          {
            slug: SMART_MONEY_SLUG,
            version: 1,
            config: strategyRaw(),
            timeframes: ["1h"],
            minExchanges: 3,
          },
        ],
        markets,
        candles,
      }),
      req("BTCUSDT", "4h")
    );
    ok(
      !tfUnsupported.ok && tfUnsupported.code === "STRATEGY_TIMEFRAME_UNSUPPORTED" && tfUnsupported.status === 400,
      "400: timeframe вне Strategy.timeframes (staged-lock) → STRATEGY_TIMEFRAME_UNSUPPORTED"
    );
  }

  // ================================================================
  // 5. Valid 1h: real evaluable fixture, exact DTO preservation,
  //    confluence → [], OB/FVG exact factIds
  // ================================================================
  {
    const candles = canonical();
    const markets = [marketRow(11, "BINANCE", 1)];
    const strategies: SmcChartApiStrategyRow[] = [
      {
        slug: SMART_MONEY_SLUG,
        version: 7,
        config: strategyRaw({ swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 }),
        timeframes: ["1h"],
        minExchanges: 1,
      },
    ];
    const store = btcStore(markets, new Map([[11, candles]]), strategies);
    const deps = makeDeps(store);
    const now = new Date(candles[candles.length - 1].openTime.getTime() + HOUR);
    const result = await buildSmcChartProjection(deps, req("btcusdt", "1h", now));

    ok(result.ok, "valid 1h: сервис вернул ok");
    if (!result.ok) return;
    const projection = result.projection;

    // symbol нормализован (btcusdt → BTCUSDT).
    eq(projection.assetSymbol, "BTCUSDT", "valid 1h: symbol нормализован");
    eq(projection.overlays.length, 1, "valid 1h: 1 оверлей");
    const overlay = projection.overlays[0];
    eq(overlay.status, "evaluated", "valid 1h: evaluated (fixture реально оценивается)");
    eq(overlay.direction, "LONG", "valid 1h: direction LONG");
    eq(overlay.longScore, 75, "valid 1h: longScore 75");
    eq(overlay.shortScore, 10, "valid 1h: shortScore 10");

    // exact DTO projection preservation: независимый вызов P1-A проекции
    // на ТЕХ ЖЕ входах (та же Strategy-config валидация, те же свечи).
    const runtime = validateSmartMoneyRuntime({
      config: strategies[0].config,
      timeframes: strategies[0].timeframes,
      minExchanges: strategies[0].minExchanges,
    });
    ok(runtime.ok, "exact DTO: эталонная валидация Strategy ок");
    if (!runtime.ok) return;
    const direct = projectSmcChart({
      assetSymbol: "BTCUSDT",
      timeframe: "1h",
      markets: [
        {
          meta: {
            exchange: "BINANCE",
            market: "BTCUSDT",
            marketId: 11,
            timeframe: "1h" as SmcTimeframe,
            assetRank: 1,
            quoteVolume24h: 1_000_000,
          },
          candles,
        },
      ],
      smcConfig: runtime.configs["1h"],
      filters: runtime.filters,
      minExchanges: runtime.minExchanges,
      now,
      strategyVersion: 7,
    });
    eq(
      JSON.stringify(projection),
      JSON.stringify(direct),
      "exact DTO: сервисный DTO побайтово равен прямому вызову P1-A проекции"
    );

    // aggregate не содержит overlay-массивов.
    const aggKeys = Object.keys(projection.aggregate);
    ok(
      !aggKeys.some((k) => ["pivots", "structureEvents", "levels", "liquidity", "fvgs", "orderBlocks", "dealingRange", "displacements"].includes(k)),
      "valid 1h: aggregate не содержит overlay-полей"
    );

    // WHY→factIds: exact OB/FVG сохранены; confluence → [].
    const fvgReason = overlay.reasons.find((r) => r.code === "FVG");
    const swingObReason = overlay.reasons.find((r) => r.code === "SWING_ORDER_BLOCK");
    const confluenceReason = overlay.reasons.find((r) => r.code === "OB_FVG_CONFLUENCE");
    ok(
      fvgReason !== undefined &&
        fvgReason.value !== null &&
        JSON.stringify(fvgReason.factIds) === JSON.stringify([fvgReason.value]) &&
        overlay.fvgs.some((f) => f.key === fvgReason.value),
      "valid 1h: exact FVG factId не потерян"
    );
    ok(
      swingObReason !== undefined &&
        swingObReason.value !== null &&
        JSON.stringify(swingObReason.factIds) === JSON.stringify([swingObReason.value]) &&
        overlay.orderBlocks.some((o) => o.key === swingObReason.value),
      "valid 1h: exact OB factId не потерян"
    );
    ok(
      confluenceReason !== undefined && confluenceReason.factIds.length === 0,
      "valid 1h: OB_FVG_CONFLUENCE factIds === []"
    );

    // deterministic: повторный прогон побайтово одинаков.
    const again = await buildSmcChartProjection(makeDeps(store), req("BTCUSDT", "1h", now));
    ok(again.ok, "deterministic: повторный прогон ok");
    if (again.ok) {
      eq(
        JSON.stringify(again.projection),
        JSON.stringify(projection),
        "deterministic: два прогона сервиса дают побайтово одинаковый DTO"
      );
    }
  }

  // ================================================================
  // 6. Valid 5m: 5 бирж, общий горизонт, все evaluated
  // ================================================================
  {
    const markets = NAMES.map((ex, i) => marketRow(21 + i, ex, 1));
    const candles = new Map(
      NAMES.map((_, i) => [21 + i, waveCandles(closedTimes(T, 200, "5m"))])
    );
    const strategies: SmcChartApiStrategyRow[] = [
      {
        slug: SMART_MONEY_SLUG,
        version: 2,
        config: strategyRaw(),
        timeframes: ["5m"],
        minExchanges: 3,
      },
    ];
    const result = await buildSmcChartProjection(
      makeDeps(btcStore(markets, candles, strategies)),
      req("BTCUSDT", "5m", new Date(NOW_5M))
    );
    ok(result.ok, "valid 5m: сервис вернул ok");
    if (!result.ok) return;
    const p = result.projection;
    eq(p.overlays.length, 5, "valid 5m: 5 per-exchange оверлеев");
    ok(p.overlays.every((o) => o.status === "evaluated"), "valid 5m: все 5 evaluated");
    eq(p.aggregate.status, "ok", "valid 5m: aggregate.status ok");
    eq(p.aggregate.horizonMs, T, "valid 5m: общий горизонт 09:50Z");
    eq(p.aggregate.participantCount, 5, "valid 5m: participantCount 5");
    eq(p.aggregate.exchangeExcluded, [], "valid 5m: eligibility ничего не исключила");
    ok(p.aggregate.gateAllowed, "valid 5m: aggregation gate пустил");
    eq(p.aggregate.direction, "NEUTRAL", "valid 5m: честный NEUTRAL (wave fixture)");
  }

  // ================================================================
  // 7. Valid 1d: Option A — BINGX исключён, 4/4
  // ================================================================
  {
    const markets = NAMES.map((ex, i) => marketRow(31 + i, ex, 1));
    const candles = new Map(
      NAMES.map((_, i) => [31 + i, waveCandles(closedTimes(D_EXPECTED, 200, "1d"))])
    );
    const strategies: SmcChartApiStrategyRow[] = [
      {
        slug: SMART_MONEY_SLUG,
        version: 3,
        config: strategyRaw(),
        timeframes: ["1d"],
        minExchanges: 3,
      },
    ];
    const result = await buildSmcChartProjection(
      makeDeps(btcStore(markets, candles, strategies)),
      req("BTCUSDT", "1d", new Date(D_NOW))
    );
    ok(result.ok, "valid 1d: сервис вернул ok");
    if (!result.ok) return;
    const p = result.projection;
    eq(
      p.overlays.map((o) => o.exchange),
      ["BINANCE", "BYBIT", "GATE", "KUCOIN"],
      "valid 1d: BINGX исключён Option A (4 оверлея)"
    );
    eq(p.aggregate.exchangeExcluded, ["BINGX"], "valid 1d: aggregate.exchangeExcluded = [BINGX]");
    eq(p.aggregate.horizonMs, D_EXPECTED, "valid 1d: общий горизонт 2026-09-10T00:00Z");
    eq(p.aggregate.participantCount, 4, "valid 1d: participantCount 4");
    ok(p.aggregate.usable && p.aggregate.status === "ok", "valid 1d: горизонт usable");
    ok(
      p.overlays.every((o) => o.status === "evaluated" && o.horizonMs === D_EXPECTED),
      "valid 1d: все оверлеи evaluated на общем горизонте"
    );
  }

  // ================================================================
  // 8. Cannot-evaluate: честная семантика, не NEUTRAL
  // ================================================================
  {
    const markets = [marketRow(41, "BINANCE", 1)];
    const shortHistory = flats(0, 2);
    const strategies: SmcChartApiStrategyRow[] = [
      {
        slug: SMART_MONEY_SLUG,
        version: 4,
        config: strategyRaw(), // дефолтные окна 20/20: нужна история >= 84
        timeframes: ["1h"],
        minExchanges: 1,
      },
    ];
    const result = await buildSmcChartProjection(
      makeDeps(btcStore(markets, new Map([[41, shortHistory]]), strategies)),
      req("BTCUSDT", "1h", new Date(shortHistory[2].openTime.getTime() + HOUR))
    );
    ok(result.ok, "cannot-evaluate: сервис вернул ok (семантика в DTO)");
    if (!result.ok) return;
    const p = result.projection;
    const overlay = p.overlays[0];
    eq(overlay.status, "cannot-evaluate", "cannot-evaluate: per-market status");
    eq(overlay.direction, null, "cannot-evaluate: direction null (НЕ NEUTRAL)");
    eq(overlay.longScore, null, "cannot-evaluate: longScore null");
    ok(
      (overlay.statusReason ?? "").includes("INSUFFICIENT_HISTORY"),
      "cannot-evaluate: причина INSUFFICIENT_HISTORY сохранена"
    );
    eq(p.aggregate.direction, null, "cannot-evaluate: aggregate.direction null (НЕ NEUTRAL)");
    eq(p.aggregate.evaluatedCount, 0, "cannot-evaluate: evaluatedCount 0");
    eq(p.aggregate.cannotEvaluateCount, 1, "cannot-evaluate: cannotEvaluateCount 1");
    ok(!p.aggregate.gateAllowed, "cannot-evaluate: gate не пустил агрегацию");
  }

  // ================================================================
  // 9. No future/open candle leakage (CLOSED-only)
  // ================================================================
  {
    const candles = canonical();
    const markets = [marketRow(51, "BINANCE", 1)];
    const strategies: SmcChartApiStrategyRow[] = [
      {
        slug: SMART_MONEY_SLUG,
        version: 5,
        config: strategyRaw({ swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 }),
        timeframes: ["1h"],
        minExchanges: 1,
      },
    ];
    const now = new Date(candles[candles.length - 1].openTime.getTime() + HOUR);
    const result = await buildSmcChartProjection(
      makeDeps(btcStore(markets, new Map([[51, candles]]), strategies)),
      req("BTCUSDT", "1h", now)
    );
    ok(result.ok, "leakage: базовый прогон ok");
    if (!result.ok) return;

    // OPEN-свеча «из будущего» в хранилище (после последней CLOSED):
    // loader берёт только closed=true → DTO не должен измениться.
    const futureOpen: SmcRawCandle = {
      openTime: new Date(candles[candles.length - 1].openTime.getTime() + HOUR),
      open: 87,
      high: 88,
      low: 86,
      close: 87.5,
      closed: false,
    };
    const withFuture = new Map<number, SmcRawCandle[]>([
      [51, [...candles, futureOpen]],
    ]);
    const result2 = await buildSmcChartProjection(
      makeDeps(btcStore(markets, withFuture, strategies)),
      req("BTCUSDT", "1h", now)
    );
    ok(result2.ok, "leakage: прогон с OPEN-свечой ok");
    if (result2.ok) {
      eq(
        JSON.stringify(result2.projection),
        JSON.stringify(result.projection),
        "leakage: OPEN-свеча после H не влияет на DTO (CLOSED-only)"
      );
      const allConfirmed = result2.projection.overlays[0]
        ? [
            ...result2.projection.overlays[0].pivots.map((x) => x.confirmedAtMs),
            ...result2.projection.overlays[0].fvgs.map((x) => x.confirmedAtMs),
          ]
        : [];
      ok(
        allConfirmed.every((ms) => ms <= now.getTime()),
        "leakage: все confirmedAtMs <= engineAsOf"
      );
    }

    // CLOSED-свеча «из будущего» (openTime > ожидаемого latest CLOSED) —
    // common-horizon пайплайн обязан отбраковать горизонт (future_horizon),
    // а НЕ тихо оценить смешанные данные: fail-closed без утечки.
    const futureClosed: SmcRawCandle = {
      openTime: new Date(candles[candles.length - 1].openTime.getTime() + 2 * HOUR),
      open: 87,
      high: 89,
      low: 86,
      close: 88,
      closed: true,
    };
    const withFutureClosed = new Map<number, SmcRawCandle[]>([
      [51, [...candles, futureClosed]],
    ]);
    const result3 = await buildSmcChartProjection(
      makeDeps(btcStore(markets, withFutureClosed, strategies)),
      req("BTCUSDT", "1h", now)
    );
    ok(result3.ok, "leakage: прогон с CLOSED-свечой из будущего ok (отказ честно в DTO)");
    if (result3.ok) {
      eq(
        result3.projection.aggregate.status,
        "future_horizon",
        "leakage: CLOSED-свеча из будущего → aggregate.status = future_horizon (не тихий успех)"
      );
      eq(result3.projection.overlays, [], "leakage: overlays [] — никакие факты не утекли");
      eq(result3.projection.aggregate.direction, null, "leakage: direction null (НЕ NEUTRAL)");
      ok(
        !result3.projection.aggregate.usable,
        "leakage: aggregate unusable (агрегация запрещена)"
      );
      // Без будущей свечи та же конфигурация оценивается — отказ вызван
      // именно будущей свечой, а не поломкой пайплайна.
      eq(result.projection.overlays[0].status, "evaluated", "leakage: контрольный прогон без будущей свечи evaluated");
    }
  }

  // ================================================================
  // 10. Поведенческий no-write: fake без write-методов + сервис
  //     (любая попытка записи = TypeError, а не тихий успех)
  // ================================================================
  {
    const candles = canonical();
    const markets = [marketRow(61, "BINANCE", 1)];
    const strategies: SmcChartApiStrategyRow[] = [
      {
        slug: SMART_MONEY_SLUG,
        version: 6,
        config: strategyRaw({ swingLeft: 1, swingRight: 1, internalLeft: 1, internalRight: 1 }),
        timeframes: ["1h"],
        minExchanges: 1,
      },
    ];
    const deps = makeDeps(btcStore(markets, new Map([[61, candles]]), strategies));
    const writeNames = ["create", "createMany", "update", "updateMany", "upsert", "delete", "deleteMany", "$executeRaw"];
    const slices = [deps.asset, deps.strategy, deps.market, deps.candle] as const;
    for (const slice of slices) {
      for (const name of writeNames) {
        ok(
          !(name in slice),
          `no-write: fake-срез не имеет метода ${name} (сервис физически не может писать)`
        );
      }
    }
    const result = await buildSmcChartProjection(
      deps,
      req("BTCUSDT", "1h", new Date(candles[candles.length - 1].openTime.getTime() + HOUR))
    );
    ok(result.ok && result.projection.overlays.length === 1, "no-write: полный прогон на read-only fake успешен");
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
