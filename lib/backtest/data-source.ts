/**
 * P2-B — источник данных для бэктестов — HARDENED.
 *
 * Читает CLOSED-only Candle данные из PostgreSQL через Prisma.
 * Архитектурно: узкий read-only интерфейс, без прямых зависимостей от всей Prisma схемы.
 * Никаких create/update/upsert/delete/createMany/updateMany/deleteMany/$executeRaw/$executeRawUnsafe/$queryRawUnsafe.
 *
 * Реальность:
 * - Candle является authoritative таблицей OHLCV (Exchange→Market→Candle)
 * - Market.id — identity для Symbol, без дублирования exchange/symbol в Candle
 * - Candle хранит closed flag; P2-B читает только WHERE closed=true
 * - chunked / cursor-based запросы ASC для больших диапазонов
 * - детерминированный порядок, без случайности, без Date.now()
 * - никаких записей в БД
 *
 * Безопасность:
 * - архитектурно read-only: узкий интерфейс BacktestDataDeps предоставляет только чтение.
 * - Проверка assertReadOnlyDeps является диагностической, а не JS sandbox — реальная безопасность
 *   достигается архитектурным ограничением интерфейса, а не runtime инспекцией.
 * - Denylist расширен: $executeRawUnsafe включён.
 *
 * Исторический as-of:
 * - BacktestBar.time = openTime ms UTC
 * - Бар каузально закрыт в time + D (D = SMCTIMEFRAME_MS[timeframe])
 * - P2-B загружает исторические closed свечи, которые сегодня closed=true, как raw dataset;
 *   no-lookahead enforced в P2-A evaluation time (SignalContext.barAt), а не фильтрацией по wall-clock now.
 *   Никакого Date.now() / new Date() без аргументов.
 *
 * HARDENING #2 (this commit):
 * - maxRows — ЖЁСТКАЯ ВЕРХНЯЯ ГРАНИЦА РЕЗУЛЬТАТА (см. ниже) в обеих версиях API;
 * - V2 валидирует форму строки (openTime/OHLCV) fail-closed;
 * - публичные результаты глубоко заморожены; строки копируются, чтобы
 *   заморозка не меняла объекты, принадлежащие провайдеру (Prisma).
 *
 * maxRows КОНТРАКТ:
 * - успешный fetch НИКОГДА не возвращает больше maxRows строк;
 * - если очередная страница вывела бы результат за границу — fail closed
 *   (структурированный throw), а НЕ молчаливое усечение: частичный
 *   результат выглядел бы как «данных больше нет» и исказил бы coverage
 *   и бэктест. Границы: ровно maxRows — успех; maxRows − 1 — успех, если
 *   данных ровно столько; maxRows + 1 (лишняя строка) — отказ.
 *
 * ПРОВАЙДЕР-КОНТРАКТ (provider-owned rows/Dates во время пагинации):
 * - во время пагинации V1/V2 удерживают ССЫЛКИ на накопленные строки и на
 *   Date-объект cursor, принадлежащие провайдеру; копирование выполняется
 *   только при финальной публикации результата;
 * - контракт провайдера: строки и Date, возвращённые провайдером, не
 *   мутируются после возврата (read-only deps; Prisma-строки этому
 *   соответствуют);
 * - наружу публикуются КОПИИ строк и Date, поэтому мутация результата
 *   потребителем не затрагивает ни объекты провайдера, ни последующие
 *   fetch-и (JS-ограничение: Object.freeze не защищает Date.setTime у
 *   собственной копии потребителя);
 * - финальная output-ASC-проверка (V1: "final array not strictly ASC",
 *   V2: "final not strictly ASC") — defense-in-depth против НЕКОТОРЫХ
 *   нарушений контракта (пост-фактум мутация уже принятой строки): без неё
 *   успешный результат мог бы быть не-ASC или с дубликатами timestamp.
 *   Проверка обязана оставаться в коде, даже если при добросовестном
 *   провайдере выглядит избыточной (test-pin: scripts/test-backtest-p2b.ts §5d).
 *
 * HARDENING pagination termination:
 * - assert strict ASC per page and overall
 * - assert marketId/timeframe/closed/range for each row
 * - cursor strictly advancing (>)
 * - reject duplicates
 * - bounded maxPages/maxRows
 * - pageSize upper bound MAX_PAGE_SIZE
 * - no spread push for huge pages (loop)
 * - structured failure not infinite loop / OOM
 * - do not silently sort malformed pages
 */

import type { BacktestBar } from "./contract";
import { candleRowsToBacktestBars, type BacktestCandleRow } from "./adapter";
import { isValidTimeframeMs } from "./gaps";
import { deepFreeze } from "./immutable";
import { utcDateFromMs } from "./timeframe";

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
 * Read-only зависимости — старый интерфейс (для совместимости с существующими тестами/CLI).
 * Намеренно узкий: только то, что нужно для исторического чтения.
 */
export interface BacktestDataDeps {
  readonly asset: {
    findUnique(args: { where: { symbol: string } }): Promise<BacktestAssetRow | null>;
  };
  readonly market: {
    findMany(args: {
      where: { assetId: number; enabled?: boolean; status?: string };
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

/**
 * Узкий интерфейс зависимостей для новой hardened пагинации.
 */
export interface BacktestDataDepsV2 {
  findCandlesPage: (args: {
    marketId: number;
    timeframe: string;
    from: Date;
    to: Date;
    cursorOpenTime: Date | null;
    take: number;
  }) => Promise<BacktestCandleRow[]>;
}

/* ------------------------------------------------------------------ */
/* Constants                                                          */
/* ------------------------------------------------------------------ */

export const MAX_PAGE_SIZE = 5000;
export const DEFAULT_PAGE_SIZE = 1000;
export const DEFAULT_MAX_PAGES = 10_000;
export const DEFAULT_MAX_ROWS = 1_000_000;

/* ------------------------------------------------------------------ */
/* Read-only check — diagnostic, not sandbox                          */
/* ------------------------------------------------------------------ */

export function assertReadOnlyDeps(deps: unknown): { ok: boolean; errors: string[] } {
  const errors: string[] = [];

  if (deps === null || typeof deps !== "object") {
    return { ok: false, errors: ["deps: не объект"] };
  }

  const obj = deps as Record<string, unknown>;
  const forbidden = [
    "create",
    "createMany",
    "update",
    "updateMany",
    "upsert",
    "delete",
    "deleteMany",
    "$executeRaw",
    "$executeRawUnsafe",
    "$queryRawUnsafe",
    "$queryRaw",
  ];

  // Top-level check (for V2 deps)
  for (const key of forbidden) {
    if (key in obj) {
      errors.push(`deps содержит запрещённый ключ: ${key}`);
    }
  }

  // Check nested prisma-like objects
  const suspiciousKeys = ["candle", "market", "exchange", "asset", "$transaction", "signal"];
  for (const key of suspiciousKeys) {
    if (key in obj) {
      const inner = obj[key];
      if (inner && typeof inner === "object") {
        const innerObj = inner as Record<string, unknown>;
        for (const f of forbidden) {
          if (f in innerObj) {
            errors.push(`deps.${key} содержит запрещённый метод: ${f}`);
          }
        }
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* Hardened pagination — old signature (for existing callers)         */
/* ------------------------------------------------------------------ */

/**
 * Публичная копия строки Candle: собственная shallow-копия, СОБСТВЕННЫЕ
 * копии Date-полей и глубокая заморозка.
 *
 * Дата копируется (`utcDateFromMs` — из уже полученного ms, без чтения
 * часов), потому что Object.freeze не защищает Date от `setTime`; копия
 * гарантирует, что мутация потребителем не затронет ни объект провайдера
 * (Prisma row), ни последующие выборки. Сам объект строки заморожен, так
 * что подмена поля `openTime` бросает исключение в строгом режиме.
 */
function copyFrozenRow(row: BacktestCandleRow): BacktestCandleRow {
  return deepFreeze({
    marketId: row.marketId,
    timeframe: row.timeframe,
    openTime: utcDateFromMs(row.openTime.getTime()),
    closeTime: row.closeTime ? utcDateFromMs(row.closeTime.getTime()) : null,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    closed: row.closed,
  }) as BacktestCandleRow;
}

function copyFrozenRows(rows: readonly BacktestCandleRow[]): BacktestCandleRow[] {
  const out: BacktestCandleRow[] = new Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    out[i] = copyFrozenRow(rows[i]);
  }
  return Object.freeze(out) as unknown as BacktestCandleRow[];
}

/** Минимальная форма строки: fail-closed ДО любых чтений полей. */
function assertRowShape(row: unknown, context: string): asserts row is BacktestCandleRow {
  if (row === null || typeof row !== "object") {
    throw new Error(`${context}: строка не объект (${String(row)})`);
  }

  const r = row as Partial<BacktestCandleRow>;

  if (!(r.openTime instanceof Date) || !Number.isFinite(r.openTime.getTime())) {
    throw new Error(
      `${context}: openTime должен быть валидным Date, получено ${String(r.openTime)}`
    );
  }

  for (const field of ["open", "high", "low", "close", "volume"] as const) {
    const v = r[field];
    if (typeof v !== "number" || !Number.isFinite(v)) {
      throw new Error(`${context}: ${field} должен быть конечным числом, получено ${String(v)}`);
    }
  }
}

export interface FetchCandlesOptions {
  readonly pageSize: number;
  readonly from: Date;
  readonly to: Date;
}

export interface FetchCandlesResult {
  readonly rows: BacktestCandleRow[];
  readonly bars: BacktestBar[];
  readonly pages: number;
  readonly hasMore: boolean;
}

function validateCommonFetchArgs(
  marketId: number,
  timeframe: string,
  from: Date,
  to: Date,
  pageSize: number
): void {
  if (!Number.isInteger(marketId) || marketId <= 0) {
    throw new Error(`fetchCandlesPaginated: marketId должен быть целым >0, получен ${marketId}`);
  }
  if (typeof timeframe !== "string" || timeframe.trim().length === 0) {
    throw new Error(`fetchCandlesPaginated: timeframe должен быть непустой строкой`);
  }
  if (!(from instanceof Date) || Number.isNaN(from.getTime())) {
    throw new Error(`fetchCandlesPaginated: from invalid Date`);
  }
  if (!(to instanceof Date) || Number.isNaN(to.getTime())) {
    throw new Error(`fetchCandlesPaginated: to invalid Date`);
  }
  if (from.getTime() >= to.getTime()) {
    throw new Error(`fetchCandlesPaginated: from must be < to, got from=${from.toISOString()} to=${to.toISOString()}`);
  }
  if (!Number.isInteger(pageSize) || pageSize <= 0) {
    throw new Error(`fetchCandlesPaginated: pageSize должен быть целым >0, получен ${pageSize}`);
  }
  if (pageSize > MAX_PAGE_SIZE) {
    throw new Error(`fetchCandlesPaginated: pageSize ${pageSize} > MAX_PAGE_SIZE ${MAX_PAGE_SIZE}`);
  }
}

/**
 * Историческая выборка с пагинацией — HARDENED версия старого API.
 * - bounded: WHERE openTime >= from AND openTime < to
 * - only closed=true
 * - ASC по openTime, exclusive cursor >
 * - deterministic termination
 * - fail-closed validation: strict ASC, marketId/timeframe/closed/range, cursor advancing, duplicates
 * - bounded maxPages/maxRows
 * - no spread push huge
 */
export async function fetchCandlesPaginated(
  deps: BacktestDataDeps,
  marketId: number,
  timeframe: string,
  from: Date,
  to: Date,
  pageSize: number,
  opts?: { maxPages?: number; maxRows?: number }
): Promise<FetchCandlesResult> {
  validateCommonFetchArgs(marketId, timeframe, from, to, pageSize);

  const maxPages = opts?.maxPages ?? DEFAULT_MAX_PAGES;
  const maxRows = opts?.maxRows ?? DEFAULT_MAX_ROWS;

  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`fetchCandlesPaginated: maxPages должен быть целым >0`);
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new Error(`fetchCandlesPaginated: maxRows должен быть целым >0`);
  }

  const ro = assertReadOnlyDeps(deps);
  if (!ro.ok) {
    throw new Error(`fetchCandlesPaginated: deps содержит запрещённые методы: ${ro.errors.join("; ")}`);
  }

  const allRows: BacktestCandleRow[] = [];
  const seenTimes = new Set<number>();
  let cursor: Date | null = null;
  let lastCursorMs: number | null = null;
  let pages = 0;

  const fromMs = from.getTime();
  const toMs = to.getTime();

  while (true) {
    if (pages >= maxPages) {
      throw new Error(
        `fetchCandlesPaginated: превышен maxPages ${maxPages} marketId=${marketId} timeframe=${timeframe} pages=${pages} rows=${allRows.length}`
      );
    }
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
      where.openTime.gt = cursor;
      where.openTime.lt = to;
    }

    const page = await deps.candle.findMany({
      where,
      orderBy: { openTime: "asc" },
      take: pageSize,
    });

    if (page.length === 0) {
      break;
    }

    pages += 1;

    if (page.length > pageSize) {
      throw new Error(
        `fetchCandlesPaginated: page returned ${page.length} > take ${pageSize} marketId=${marketId}`
      );
    }

    // MANDATORY FIX 3: maxRows — жёсткая граница вывода.
    // Проверяем ДО накопления, поэтому успешный результат физически не
    // может превысить maxRows; лишняя страница → отказ, не усечение.
    if (allRows.length + page.length > maxRows) {
      throw new Error(
        `fetchCandlesPaginated: maxRows ${maxRows} exceeded marketId=${marketId} timeframe=${timeframe} ` +
          `already=${allRows.length} page=${page.length} — fail closed, усечение запрещено`
      );
    }

    // Validate page strictly ASC
    for (let i = 1; i < page.length; i += 1) {
      const prev = page[i - 1].openTime.getTime();
      const curr = page[i].openTime.getTime();
      if (curr <= prev) {
        throw new Error(
          `fetchCandlesPaginated: page not strictly ASC prev=${prev} curr=${curr} marketId=${marketId} timeframe=${timeframe} index=${i}`
        );
      }
    }

    // Validate each row
    for (let i = 0; i < page.length; i += 1) {
      const row = page[i];
      const t = row.openTime.getTime();

      if (row.marketId !== marketId) {
        throw new Error(`fetchCandlesPaginated: marketId mismatch expected ${marketId} got ${row.marketId} time=${row.openTime.toISOString()}`);
      }
      if (row.timeframe !== timeframe) {
        throw new Error(`fetchCandlesPaginated: timeframe mismatch expected ${timeframe} got ${row.timeframe} time=${row.openTime.toISOString()}`);
      }
      if (row.closed !== true) {
        throw new Error(`fetchCandlesPaginated: closed=false not allowed time=${row.openTime.toISOString()} marketId=${marketId}`);
      }
      if (t < fromMs || t >= toMs) {
        throw new Error(`fetchCandlesPaginated: openTime out of requested [from,to) time=${row.openTime.toISOString()} from=${from.toISOString()} to=${to.toISOString()}`);
      }
      if (seenTimes.has(t)) {
        throw new Error(`fetchCandlesPaginated: duplicate openTime ${row.openTime.toISOString()} (${t}) marketId=${marketId}`);
      }
    }

    // Cursor strictly advancing
    const firstMs = page[0].openTime.getTime();
    if (lastCursorMs !== null && firstMs <= lastCursorMs) {
      throw new Error(`fetchCandlesPaginated: cursor not strictly advancing last=${lastCursorMs} first=${firstMs} marketId=${marketId}`);
    }
    if (cursor !== null && firstMs <= cursor.getTime()) {
      throw new Error(`fetchCandlesPaginated: page ignores cursor cursor=${cursor.toISOString()} first=${page[0].openTime.toISOString()} marketId=${marketId}`);
    }

    // No spread push huge — use loop
    for (let i = 0; i < page.length; i += 1) {
      const r = page[i];
      allRows.push(r);
      seenTimes.add(r.openTime.getTime());
    }

    if (page.length < pageSize) {
      break;
    }

    cursor = page[page.length - 1].openTime;
    lastCursorMs = cursor.getTime();
  }

  // Final ASC check
  for (let i = 1; i < allRows.length; i += 1) {
    if (allRows[i].openTime.getTime() <= allRows[i - 1].openTime.getTime()) {
      throw new Error(`fetchCandlesPaginated: final array not strictly ASC at ${i}`);
    }
  }

  const bars = candleRowsToBacktestBars(allRows);

  // MANDATORY FIX 4: строки копируются (включая Date-поля) и замораживаются
  // глубоко; объекты провайдера при этом НЕ мутируются.
  return deepFreeze({
    rows: copyFrozenRows(allRows),
    bars,
    pages,
    hasMore: false,
  });
}

/* ------------------------------------------------------------------ */
/* New V2 API — object args, for hardened tests                       */
/* ------------------------------------------------------------------ */

export interface FetchCandlesPaginatedArgsV2 {
  readonly deps: BacktestDataDepsV2;
  readonly marketId: number;
  readonly timeframe: string;
  readonly from: Date;
  readonly to: Date;
  readonly pageSize?: number;
  readonly maxPages?: number;
  readonly maxRows?: number;
}

export interface FetchCandlesPageResultV2 {
  readonly marketId: number;
  readonly timeframe: string;
  readonly from: number;
  readonly to: number;
  readonly pageSize: number;
  readonly pagesFetched: number;
  readonly totalRows: number;
  readonly lastCursor: number | null;
}

export async function fetchCandlesPaginatedV2(
  args: FetchCandlesPaginatedArgsV2
): Promise<{ rows: BacktestCandleRow[]; meta: FetchCandlesPageResultV2 }> {
  const { deps, marketId, timeframe, from, to } = args;
  const pageSize = args.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxPages = args.maxPages ?? DEFAULT_MAX_PAGES;
  const maxRows = args.maxRows ?? DEFAULT_MAX_ROWS;

  validateCommonFetchArgs(marketId, timeframe, from, to, pageSize);

  if (!Number.isInteger(maxPages) || maxPages <= 0) {
    throw new Error(`fetchCandlesPaginatedV2: maxPages должен быть целым >0`);
  }
  if (!Number.isInteger(maxRows) || maxRows <= 0) {
    throw new Error(`fetchCandlesPaginatedV2: maxRows должен быть целым >0`);
  }

  const ro = assertReadOnlyDeps(deps);
  if (!ro.ok) {
    throw new Error(`fetchCandlesPaginatedV2: deps содержит запрещённые методы: ${ro.errors.join("; ")}`);
  }

  const allRows: BacktestCandleRow[] = [];
  const seenTimes = new Set<number>();
  let cursor: Date | null = null;
  let lastCursorMs: number | null = null;
  let pagesFetched = 0;

  const fromMs = from.getTime();
  const toMs = to.getTime();

  while (true) {
    if (pagesFetched >= maxPages) {
      throw new Error(`fetchCandlesPaginatedV2: превышен maxPages ${maxPages} marketId=${marketId} timeframe=${timeframe}`);
    }
    // maxRows проверяется НА ДОБАВЛЕНИЕ страницы (ниже), а не на входе в цикл: входная проверка
    // ложно падала бы, когда данных ровно maxRows и последняя страница полная (page.length == pageSize).

    const page = await deps.findCandlesPage({
      marketId,
      timeframe,
      from,
      to,
      cursorOpenTime: cursor,
      take: pageSize,
    });

    if (page.length === 0) break;
    if (page.length > pageSize) {
      throw new Error(`fetchCandlesPaginatedV2: page ${page.length} > take ${pageSize}`);
    }

    // MANDATORY FIX 3: maxRows — жёсткая граница вывода (см. контракт в шапке).
    if (allRows.length + page.length > maxRows) {
      throw new Error(
        `fetchCandlesPaginatedV2: maxRows ${maxRows} exceeded marketId=${marketId} timeframe=${timeframe} ` +
          `already=${allRows.length} page=${page.length} — fail closed, усечение запрещено`
      );
    }

    for (let i = 1; i < page.length; i += 1) {
      if (page[i].openTime.getTime() <= page[i - 1].openTime.getTime()) {
        throw new Error(`fetchCandlesPaginatedV2: page not strictly ASC at ${i} marketId=${marketId}`);
      }
    }

    for (let i = 0; i < page.length; i += 1) {
      const row = page[i];
      // MANDATORY FIX 2 (guard family: malformed/non-finite candle data):
      // форма строки проверяется ДО любых чтений, включая openTime.
      assertRowShape(row, `fetchCandlesPaginatedV2: строка ${i}`);
      const t = row.openTime.getTime();
      if (row.marketId !== marketId) throw new Error(`fetchCandlesPaginatedV2: marketId mismatch expected ${marketId} got ${row.marketId}`);
      if (row.timeframe !== timeframe) throw new Error(`fetchCandlesPaginatedV2: timeframe mismatch expected ${timeframe} got ${row.timeframe}`);
      if (row.closed !== true) throw new Error(`fetchCandlesPaginatedV2: closed=false not allowed time=${row.openTime.toISOString()}`);
      if (t < fromMs || t >= toMs) throw new Error(`fetchCandlesPaginatedV2: openTime out of range time=${row.openTime.toISOString()}`);
      if (seenTimes.has(t)) throw new Error(`fetchCandlesPaginatedV2: duplicate openTime ${row.openTime.toISOString()}`);
    }

    const firstMs = page[0].openTime.getTime();
    if (lastCursorMs !== null && firstMs <= lastCursorMs) {
      throw new Error(`fetchCandlesPaginatedV2: cursor not strictly advancing last=${lastCursorMs} first=${firstMs}`);
    }
    if (cursor !== null && firstMs <= cursor.getTime()) {
      throw new Error(`fetchCandlesPaginatedV2: page ignores cursor cursor=${cursor.toISOString()} first=${page[0].openTime.toISOString()}`);
    }

    for (let i = 0; i < page.length; i += 1) {
      allRows.push(page[i]);
      seenTimes.add(page[i].openTime.getTime());
    }

    pagesFetched += 1;
    cursor = page[page.length - 1].openTime;
    lastCursorMs = cursor.getTime();

    if (page.length < pageSize) break;
  }

  for (let i = 1; i < allRows.length; i += 1) {
    if (allRows[i].openTime.getTime() <= allRows[i - 1].openTime.getTime()) {
      throw new Error(`fetchCandlesPaginatedV2: final not strictly ASC at ${i}`);
    }
  }

  return deepFreeze({
    rows: copyFrozenRows(allRows),
    meta: {
      marketId,
      timeframe,
      from: fromMs,
      to: toMs,
      pageSize,
      pagesFetched,
      totalRows: allRows.length,
      lastCursor: lastCursorMs,
    },
  });
}

/**
 * Одностраничный fetch (для малых диапазонов). Делегирует в пагинированный
 * с maxPages=1 для единообразия валидации.
 */
export async function fetchCandlesSinglePage(
  args: Omit<FetchCandlesPaginatedArgsV2, "maxPages" | "maxRows"> & { take: number }
): Promise<BacktestCandleRow[]> {
  const { rows } = await fetchCandlesPaginatedV2({
    ...args,
    pageSize: args.take,
    maxPages: 1,
    maxRows: args.take,
  });
  return rows;
}

/* ------------------------------------------------------------------ */
/* Helpers: getMarketsForAsset, fetchBarsForMarkets                    */
/* ------------------------------------------------------------------ */

export async function getMarketsForAsset(
  deps: BacktestDataDeps,
  assetSymbol: string
): Promise<{ asset: BacktestAssetRow; markets: BacktestMarketRow[] }> {
  const asset = await deps.asset.findUnique({ where: { symbol: assetSymbol } });
  if (!asset) throw new Error(`Asset ${assetSymbol} не найден`);
  const markets = await deps.market.findMany({
    where: { assetId: asset.id, enabled: true, status: "ACTIVE" },
    orderBy: { id: "asc" },
  });
  return { asset, markets };
}

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
    const fetched = await fetchCandlesPaginated(deps, m.id, timeframe, from, to, pageSize);
    result.set(m.id, fetched.bars);
  }
  return result;
}
