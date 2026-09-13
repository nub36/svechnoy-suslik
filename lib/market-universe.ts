/**
 * Чистая нормализация публичного рынка в единый Top-N universe.
 *
 * Продуктовая вселенная — Топ-100 криптовалют по рыночной капитализации
 * (единственный источник истины — lib/universe.ts). Монеты с внешних
 * API (CoinGecko /coins/markets) и внутренние списки должны показывать
 * ОДНИ И ТЕ ЖЕ активы в ОДНОМ И ТОМ ЖЕ порядке: по рангу капитализации.
 *
 * Функции модуля чистые (без сети/БД/next), чтобы их можно было
 * детерминированно тестировать в node и переиспользовать на сервере.
 * Пустой/мусорный ответ API даёт пустой массив — страницы при этом
 * честно показывают отсутствие данных, а не выдуманные строки.
 */

import { TOP_UNIVERSE_SIZE } from "@/lib/universe";

/** Строка витрины монет (надмножество полей CoinGecko /coins/markets). */
export interface MarketCoinRow {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
  market_cap_rank: number;
}

/**
 * Привести произвольный ответ /coins/markets к Top-limit вселенной:
 *  - выбрасывает мусор (не-объекты, пустые тикеры, нечисловые ранги);
 *  - оставляет только ранги 1..limit (никаких «случайных» монет вне топ-списка);
 *  - дедуплицирует по символу, сохраняя запись с МЕНЬШИМ рангом
 *    (CoinGecko может вернуть один актив дважды в разных листингах);
 *  - сортирует строго по возрастанию rank — детерминированный порядок,
 *    тот же, что у поиска (/api/search) и списка рынков (/api/chart/markets);
 *  - ограничивает первыми limit строками.
 */
export function buildTopUniverseCoins(
  raw: unknown,
  limit: number = TOP_UNIVERSE_SIZE
): MarketCoinRow[] {
  if (!Array.isArray(raw)) return [];

  const bySymbol = new Map<string, MarketCoinRow>();

  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;

    const source = row as Record<string, unknown>;

    const symbol =
      typeof source.symbol === "string" ? source.symbol.toUpperCase().trim() : "";
    const id = typeof source.id === "string" ? source.id.trim() : "";
    const name = typeof source.name === "string" ? source.name.trim() : symbol;

    const rank =
      typeof source.market_cap_rank === "number" &&
      Number.isFinite(source.market_cap_rank)
        ? Math.trunc(source.market_cap_rank)
        : 0;

    if (symbol === "" || id === "" || rank < 1 || rank > limit) continue;

    const num = (key: string): number =>
      typeof source[key] === "number" && Number.isFinite(source[key])
        ? (source[key] as number)
        : 0;

    const image =
      typeof source.image === "string" ? source.image : undefined;

    const next: MarketCoinRow = {
      id,
      symbol,
      name,
      current_price: num("current_price"),
      market_cap: num("market_cap"),
      total_volume: num("total_volume"),
      price_change_percentage_24h: num("price_change_percentage_24h"),
      market_cap_rank: rank
    };

    if (image !== undefined) next.image = image;

    const known = bySymbol.get(symbol);

    /* Первый/наилучший ранг побеждает: детерминированный dedupe. */
    if (known === undefined || rank < known.market_cap_rank) {
      bySymbol.set(symbol, next);
    }
  }

  return [...bySymbol.values()]
    .sort((a, b) =>
      a.market_cap_rank !== b.market_cap_rank
        ? a.market_cap_rank - b.market_cap_rank
        : a.symbol < b.symbol
          ? -1
          : a.symbol > b.symbol
            ? 1
            : 0
    )
    .slice(0, limit);
}
