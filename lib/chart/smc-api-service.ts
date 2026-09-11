/**
 * P1-B — Smart Money chart API: service-слой границы.
 *
 * ТОНКИЙ read-only boundary над принятой P1-A проекцией:
 * загрузка Strategy/Market/Candle из PostgreSQL (через injected deps,
 * тот же способ, что и существующий runtime) + вызов projectSmcChart().
 * НИКАКИХ вычислений SMC здесь нет — только подготовка/валидация
 * входа и вызов существующей P1-A проекции.
 *
 * ГАРАНТИИ READ-ONLY:
 *  - интерфейс SmcChartApiDeps содержит ТОЛЬКО чтение:
 *    findUnique/findFirst/findMany; никаких create/update/upsert/delete/
 *    $executeRaw — это проверяется статически в scripts/test-smc-api-service.ts;
 *  - нет Signal writes, нет Strategy/Market/Candle writes;
 *  - нет worker'ов и внешних бирж: свечи — только PostgreSQL CLOSED;
 *  - `now` передаётся вызывающим кодом (route), сервис часы сам не читает.
 *
 * ДАННЫЕ:
 *  - Strategy: slug smart-money-suslik (latest version), config проходит
 *    существующий validateSmartMoneyRuntime; engineering-config fallback
 *    ЗАПРЕЩЁН (нет стратегии / невалидна → явная ошибка, не тихий дефолт);
 *  - Strategy.enabled/status НЕ влияют на выдачу: оверлеи графика — это
 *    вид конфигурации, а НЕ переключатель global Strategy.enabled (UI-кнопка
 *    «Смарт Мани» будет позже и только UI-state) — чтение без записи;
 *  - Market: enabled + ACTIVE + SPOT + USDT (convention /api/chart/*);
 *  - Candle: переиспользуется loadSmartMoneyCandles — последние 500 CLOSED
 *    (DESC take 500 → reverse ASC), тот же bounded-query, что в runtime;
 *  - eligibility/common-horizon/no-lookahead — целиком внутри P1-A проекции,
 *    здесь НЕ дублируются и НЕ ослабляются (BINGX 1d — через Option A).
 *
 * ERROR SEMANTICS (deterministic, без stack/secrets клиенту):
 *  - INVALID_SYMBOL / INVALID_TIMEFRAME  → 400
 *  - ASSET_NOT_FOUND                     → 404
 *  - STRATEGY_TIMEFRAME_UNSUPPORTED      → 400 (staged-lock Phase 3C)
 *  - STRATEGY_MISSING / STRATEGY_INVALID → 503 (не настроено, не тихий дефолт)
 *  - нет рынков / нет данных / нет общего горизонта / cannot-evaluate —
 *    НЕ ошибки HTTP: семантика уже в P1-A DTO (aggregate.status,
 *    per-market status). Второй competing contract НЕ создаётся.
 *    cannot-evaluate НИКОГДА не превращается в direction=NEUTRAL.
 *  - исключения БД — ловит route (503, convention /api/chart/candles).
 *
 * ЧИСТОТА: без Next/React/DOM, без fetch, без Signal; только чистые
 * функции + переданный prisma-подобный объект (тестируется без БД).
 */

import {
  parseSymbolParam,
  parseTimeframeParam,
} from "./params";
import {
  projectSmcChart,
  type SmcChartProjectionInput,
} from "./smc-projection";
import type { SmcChartProjection } from "./smc-contract";
import {
  isSmcTimeframe,
  type SmcRawCandle,
  type SmcTimeframe,
} from "../smc/types";
import {
  SMART_MONEY_SLUG,
  loadSmartMoneyCandles,
  validateSmartMoneyRuntime,
  type SmartMoneyMarketMeta,
} from "../strategies/smart-money";

// ------------------------------------------------------------------
// Injected deps: ТОЛЬКО чтение (форма, которой удовлетворяет и
// PrismaClient, и детерминированный fake из теста)
// ------------------------------------------------------------------

export type SmcChartApiAssetRow = {
  id: number;
  symbol: string;
  rank: number | null;
};

export type SmcChartApiStrategyRow = {
  slug: string;
  version: number;
  /** Strategy.config (JSON) — валидируется validateSmartMoneyRuntime. */
  config: unknown;
  timeframes: unknown;
  minExchanges: unknown;
};

export type SmcChartApiMarketRow = {
  id: number;
  exchange: string;
  exchangeSymbol: string;
  quoteVolume24h: number | null;
};

export type SmcChartApiCandleRow = {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  closed: boolean;
};

/** Read-only-срез БД: ни одного write-метода. */
export interface SmcChartApiDeps {
  asset: {
    findUnique(args: unknown): Promise<SmcChartApiAssetRow | null>;
  };
  strategy: {
    findFirst(args: unknown): Promise<SmcChartApiStrategyRow | null>;
  };
  market: {
    findMany(args: unknown): Promise<SmcChartApiMarketRow[]>;
  };
  candle: {
    findMany(args: unknown): Promise<SmcChartApiCandleRow[]>;
  };
}

// ------------------------------------------------------------------
// Результат
// ------------------------------------------------------------------

export type SmcChartApiErrorCode =
  | "INVALID_SYMBOL"
  | "INVALID_TIMEFRAME"
  | "ASSET_NOT_FOUND"
  | "STRATEGY_TIMEFRAME_UNSUPPORTED"
  | "STRATEGY_MISSING"
  | "STRATEGY_INVALID";

export type SmcChartApiResult =
  | { ok: true; projection: SmcChartProjection }
  | {
      ok: false;
      code: SmcChartApiErrorCode;
      status: 400 | 404 | 503;
      /** Безопасное русское сообщение (без stack/secrets). */
      error: string;
    };

function fail(
  code: SmcChartApiErrorCode,
  status: 400 | 404 | 503,
  error: string
): SmcChartApiResult {
  return { ok: false, code, status, error };
}

// ------------------------------------------------------------------
// Вход
// ------------------------------------------------------------------

export interface SmcChartApiRequest {
  /** Сырой symbol из query (нормализуется существующим parseSymbolParam). */
  symbol: string | null | undefined;
  /** Сырой timeframe из query (белый список 5m/15m/1h/4h/1d). */
  timeframe: string | null | undefined;
  /** Injected wall clock (route передаёт new Date(); сервис сам не читает). */
  now: Date;
}

// ------------------------------------------------------------------
// Каноническая точка входа P1-B
// ------------------------------------------------------------------

/**
 * Читает актив, реальную Smart Money Strategy и CLOSED-свечи рынков
 * из переданных deps и возвращает P1-A DTO через существующую
 * проекцию. Все вычисления SMC — внутри projectSmcChart (P1-A),
 * второго алгоритма/contract'а здесь нет.
 */
export async function buildSmcChartProjection(
  deps: SmcChartApiDeps,
  request: SmcChartApiRequest
): Promise<SmcChartApiResult> {
  // 1. Валидация параметров существующими chart-парсерами
  //    (те же conventions, что и /api/chart/candles).
  const symbolCheck = parseSymbolParam(request.symbol);
  if (!symbolCheck.ok) {
    return fail("INVALID_SYMBOL", 400, symbolCheck.message);
  }
  const timeframeCheck = parseTimeframeParam(request.timeframe);
  if (!timeframeCheck.ok) {
    return fail("INVALID_TIMEFRAME", 400, timeframeCheck.message);
  }
  const timeframe = timeframeCheck.value;
  // Fail-closed: белый список chart API обязан совпадать со SmcTimeframe.
  if (!isSmcTimeframe(timeframe)) {
    return fail(
      "INVALID_TIMEFRAME",
      400,
      `Неверный timeframe: ${timeframe}. Доступные: 5m, 15m, 1h, 4h, 1d`
    );
  }
  if (
    !(request.now instanceof Date) ||
    !Number.isFinite(request.now.getTime())
  ) {
    return fail(
      "INVALID_TIMEFRAME",
      400,
      "Некорректный параметр now (ожидается валидная дата)"
    );
  }

  const symbol = symbolCheck.value;
  const tf = timeframe as SmcTimeframe;

  // 2. Актив (404 как в /api/chart/candles).
  const asset = await deps.asset.findUnique({
    where: { symbol },
    select: { id: true, symbol: true, rank: true },
  });
  if (asset === null) {
    return fail(
      "ASSET_NOT_FOUND",
      404,
      `Актив ${symbol} не найден в базе`
    );
  }

  // 3. Реальная Smart Money Strategy (latest version). Никакого
  //    engineering-config fallback: отсутствует/невалидна — честная
  //    ошибка. enabled/status не читаются и не меняются.
  const strategy = await deps.strategy.findFirst({
    where: { slug: SMART_MONEY_SLUG },
    orderBy: { version: "desc" },
  });
  if (strategy === null) {
    return fail(
      "STRATEGY_MISSING",
      503,
      `Стратегия ${SMART_MONEY_SLUG} не найдена в базе — Smart Money не настроен`
    );
  }

  const runtime = validateSmartMoneyRuntime({
    config: strategy.config,
    timeframes: strategy.timeframes,
    minExchanges: strategy.minExchanges,
  });
  if (!runtime.ok) {
    return fail(
      "STRATEGY_INVALID",
      503,
      `Конфиг стратегии ${SMART_MONEY_SLUG} v${strategy.version} невалиден: ${runtime.errors.join("; ")}`
    );
  }

  const smcConfig = runtime.configs[tf];
  if (smcConfig === undefined) {
    return fail(
      "STRATEGY_TIMEFRAME_UNSUPPORTED",
      400,
      `Стратегия ${SMART_MONEY_SLUG} не поддерживает timeframe ${tf} (доступно: ${runtime.timeframes.join(", ")})`
    );
  }

  // 4. Рынки актива (convention /api/chart/markets: enabled, ACTIVE,
  //    SPOT, USDT). Пустой список НЕ ошибка: проекция честно вернёт
  //    aggregate.status = no_participants (семантика P1-A DTO).
  const markets = await deps.market.findMany({
    where: {
      assetId: asset.id,
      enabled: true,
      status: "ACTIVE",
      marketType: "SPOT",
      quote: "USDT",
    },
    orderBy: { exchange: "asc" },
  });

  // 5. Свечи: существующий bounded loader (500 CLOSED, DESC→reverse).
  const marketsData: Array<{
    meta: SmartMoneyMarketMeta;
    candles: SmcRawCandle[];
  }> = [];
  for (const m of markets) {
    const candles = await loadSmartMoneyCandles(deps, m.id, tf);
    marketsData.push({
      meta: {
        exchange: m.exchange,
        market: m.exchangeSymbol,
        marketId: m.id,
        timeframe: tf,
        assetRank: asset.rank,
        quoteVolume24h: m.quoteVolume24h,
      },
      candles,
    });
  }

  // 6. Существующая P1-A проекция — единственное место SMC-вычислений.
  const input: SmcChartProjectionInput = {
    assetSymbol: asset.symbol,
    timeframe: tf,
    markets: marketsData,
    smcConfig,
    filters: runtime.filters,
    minExchanges: runtime.minExchanges,
    now: request.now,
    strategyVersion: strategy.version,
  };
  const projection = projectSmcChart(input);

  return { ok: true, projection };
}
