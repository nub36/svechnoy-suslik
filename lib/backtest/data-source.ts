/**
 * P2-B — Data Plane: read-only исторический раннер между PostgreSQL
 * Candle/Market/Asset и P2-A движком.
 *
 * БЕЗОПАСНОСТЬ ПО КОНСТРУКЦИИ:
 * - только findMany/findUnique/count, никаких create/update/upsert/delete
 * - никаких $executeRaw/$queryRawUnsafe/exchange API/workers/Signal Engine
 * - только CLOSED=true, только Market.id как identity (не exchangeSymbol)
 * - chunked/cursor ASC, deterministic termination, configurable pageSize
 * - никаких schema changes, никаких DB writes
 *
 * П2-Б НЕ устанавливает SL/TP/fees/slippage/timeout/policy/metrics — это P2-A.
 * Он лишь поставляет BacktestBar[] и coverage/gap/duplicate/order/contiguous
 * отчёты.
 *
 * Зависимости инжектируются (read-only by construction). Для тестов
 * используются in-memory фикстуры, без PostgreSQL/network/env.
 */

import type { BacktestBar } from "./contract";
import { candleRowsToBacktestBars, type BacktestCandleRow } from "./adapter";

/* ------------------------------------------------------------------ */
/* Типы строк, совместимые с Prisma schema                            */
/* ------------------------------------------------------------------ */

export type BacktestMarketRow = {
  readonly id: number;
  readonly exchange: string;
  readonly exchangeSymbol: string;
  readonly assetId: number;
  readonly enabled: boolean;
  readonly status: string;
  readonly base?: string;
  readonly quote?: string;
  readonly marketType?: string;
  readonly quoteVolume24h?: number | null;
};

export type BacktestAssetRow = {
  readonly id: number;
  readonly symbol: string;
  readonly rank?: number | null;
};

/**
 * Read-only зависимости. Намеренно узкий интерфейс: только то, что
 * нужно для исторического чтения. Любые методы записи отсутствуют
 * в типе — компилятор не даст вызвать create/update/delete.
 */
export interface BacktestDataDeps {
  readonly asset: {
    findUnique(args: {
      where: { symbol: string };
    }): Promise<BacktestAssetRow | null>;
  };
  readonly market: {
    findMany(args: {
      where: {
        assetId: number;
        enabled?: boolean;
        status?: string;
      };
      orderBy?: { id: "asc" } | { quoteVolume24h: "desc" } | unknown;
    }): Promise<BacktestMarketRow[]>;
  };
  readonly candle: {
    findMany(args: {
      where: {
        marketId: number;
        timeframe: string;
        closed: boolean;
        openTime: { gte?: Date; lt?: Date; gt?: Date };
      };
      orderBy: { openTime: "asc" };
      take?: number;
    }): Promise<BacktestCandleRow[]>;
    count(args: {
      where: {
        marketId: number;
        timeframe: string;
        closed: boolean;
        openTime: { gte?: Date; lt?: Date };
      };
    }): Promise<number>;
  };
}

/* ------------------------------------------------------------------ */
/* Пагинация: chunked ASC, exclusive cursor, deterministic            */
/* ------------------------------------------------------------------ */

export interface FetchCandlesOptions {
  readonly pageSize: number;
  readonly from: Date;
  readonly to: Date;
}

export interface FetchCandlesResult {
  readonly rows: BacktestCandleRow[];
  readonly bars: BacktestBar[];
  readonly pages: number;
  readonly hasMore: boolean; // всегда false после завершения, для отчётности
}

/**
 * Историческая выборка с пагинацией:
 * - bounded: WHERE openTime >= from AND openTime < to
 * - only closed=true
 * - ASC по openTime, stable identity (openTime)
 * - exclusive cursor: WHERE openTime > lastSeen (не >=, чтобы не
 *   дублировать)
 * - deterministic termination: стоп когда страница < pageSize или пусто
 * - configurable pageSize
 * - никаких дубликатов между страницами при корректной БД (уникальный
 *   индекс [marketId, timeframe, openTime]); дубликаты ловятся выше
 *   в coverage слое, если фикстура их содержит
 */
export async function fetchCandlesPaginated(
  deps: BacktestDataDeps,
  marketId: number,
  timeframe: string,
  from: Date,
  to: Date,
  pageSize: number
): Promise<FetchCandlesResult> {
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`pageSize должен быть целым >0, получен ${pageSize}`);
  }

  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new Error("from должен быть валидной Date");
  }

  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new Error("to должен быть валидной Date");
  }

  if (from.getTime() >= to.getTime()) {
    throw new Error("from должен быть < to");
  }

  const allRows: BacktestCandleRow[] = [];
  let cursor: Date | null = null;
  let pages = 0;

  while (true) {
    const where: {
      marketId: number;
      timeframe: string;
      closed: boolean;
      openTime: { gte?: Date; lt?: Date; gt?: Date };
    } = {
      marketId,
      timeframe,
      closed: true,
      openTime: {},
    };

    if (cursor === null) {
      where.openTime.gte = from;
      where.openTime.lt = to;
    } else {
      // exclusive cursor: > lastSeen, но всё ещё < to
      where.openTime.gt = cursor;
      where.openTime.lt = to;
    }

    const page = await deps.candle.findMany({
      where,
      orderBy: { openTime: "asc" },
      take: pageSize,
    });

    pages += 1;

    if (page.length === 0) {
      break;
    }

    allRows.push(...page);

    if (page.length < pageSize) {
      break;
    }

    // cursor = last openTime (exclusive для следующей страницы)
    cursor = page[page.length - 1].openTime;
  }

  const bars = candleRowsToBacktestBars(allRows);

  return { rows: allRows, bars, pages, hasMore: false };
}

/**
 * Получить рынки для актива по symbol. Использует Market.id как
 * identity, не exchangeSymbol.
 */
export async function getMarketsForAsset(
  deps: BacktestDataDeps,
  assetSymbol: string
): Promise<{ asset: BacktestAssetRow; markets: BacktestMarketRow[] }> {
  const asset = await deps.asset.findUnique({
    where: { symbol: assetSymbol },
  });

  if (!asset) {
    throw new Error(`Asset ${assetSymbol} не найден`);
  }

  const markets = await deps.market.findMany({
    where: { assetId: asset.id, enabled: true, status: "ACTIVE" },
    orderBy: { id: "asc" },
  });

  return { asset, markets };
}

/**
 * Выборка баров для нескольких рынков с одной пагинацией на рынок.
 * Возвращает Map marketId -> bars.
 */
export async function fetchBarsForMarkets(
  deps: BacktestDataDeps,
  markets: readonly BacktestMarketRow[],
  timeframe: string,
  from: Date,
  to: Date,
  pageSize: number
): Promise<Map<number, BacktestBar[]>> {
  const result = new Map<number, BacktestBar[]>();

  for (const m of markets) {
    const fetched = await fetchCandlesPaginated(
      deps,
      m.id,
      timeframe,
      from,
      to,
      pageSize
    );
    result.set(m.id, fetched.bars);
  }

  return result;
}

/**
 * Проверка read-only контракта deps: в рантайме убедиться, что нет
 * методов записи. Используется в тестах и в CLI --plan для защиты.
 */
export function assertReadOnlyDeps(deps: BacktestDataDeps): {
  ok: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // @ts-expect-error — проверяем отсутствие запрещённых методов
  if (typeof deps.candle.create === "function") {
    errors.push("candle.create forbidden in P2-B");
  }
  // @ts-expect-error
  if (typeof deps.candle.update === "function") {
    errors.push("candle.update forbidden");
  }
  // @ts-expect-error
  if (typeof deps.candle.upsert === "function") {
    errors.push("candle.upsert forbidden");
  }
  // @ts-expect-error
  if (typeof deps.candle.delete === "function") {
    errors.push("candle.delete forbidden");
  }
  // @ts-expect-error
  if (typeof deps.candle.createMany === "function") {
    errors.push("candle.createMany forbidden");
  }
  // @ts-expect-error
  if (typeof deps.candle.updateMany === "function") {
    errors.push("candle.updateMany forbidden");
  }
  // @ts-expect-error
  if (typeof deps.candle.deleteMany === "function") {
    errors.push("candle.deleteMany forbidden");
  }
  // @ts-expect-error
  if (typeof deps.market.create === "function") {
    errors.push("market.create forbidden");
  }
  // @ts-expect-error
  if (typeof deps.market.update === "function") {
    errors.push("market.update forbidden");
  }
  // @ts-expect-error
  if (typeof deps.market.upsert === "function") {
    errors.push("market.upsert forbidden");
  }
  // @ts-expect-error
  if (typeof deps.market.delete === "function") {
    errors.push("market.delete forbidden");
  }
  // @ts-expect-error
  if (typeof deps.asset.create === "function") {
    errors.push("asset.create forbidden");
  }
  // @ts-expect-error
  if (typeof deps.asset.update === "function") {
    errors.push("asset.update forbidden");
  }
  // @ts-expect-error
  if (typeof deps.asset.upsert === "function") {
    errors.push("asset.upsert forbidden");
  }
  // @ts-expect-error
  if (typeof deps.asset.delete === "function") {
    errors.push("asset.delete forbidden");
  }

  // @ts-expect-error
  if (typeof (deps as unknown as { $executeRaw?: unknown }).$executeRaw === "function") {
    errors.push("$executeRaw forbidden");
  }
  // @ts-expect-error
  if (
    typeof (deps as unknown as { $queryRawUnsafe?: unknown }).$queryRawUnsafe ===
    "function"
  ) {
    errors.push("$queryRawUnsafe forbidden");
  }

  return { ok: errors.length === 0, errors };
}
