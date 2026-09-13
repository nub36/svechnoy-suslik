import { buildTopUniverseCoins } from "@/lib/market-universe";
import { TOP_UNIVERSE_SIZE } from "@/lib/universe";

export type Coin = {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
  market_cap_rank: number;
};

/**
 * Рыночные данные CoinGecko (кэш 60 секунд).
 *
 * Universe: Топ-100 по капитализации (единственный источник истины —
 * lib/universe.ts). Порядок и состав строит buildTopUniverseCoins:
 * детерминированная сортировка по market_cap_rank, дедупликация по
 * символу, без рангов вне 1..100 — та же вселенная, что у /api/search,
 * /api/chart/markets и /admin/data.
 *
 * ВАЖНО: при недоступности источника возвращается
 * пустой список, а НЕ демо-данные: показывать
 * выдуманные цены как реальные запрещено.
 * Пустой список интерфейс честно помечает
 * «Нет данных».
 */
export async function getTopCoins(
  limit = TOP_UNIVERSE_SIZE
): Promise<Coin[]> {
  try {
    /* Одна страница: пагинация вселенной Top-100 не нужна;
       per_page ограничен 250 на стороне API. */
    const perPage = Math.min(Math.max(1, Math.trunc(limit)), 250);

    const res = await fetch(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${String(perPage)}&page=1&sparkline=false&price_change_percentage=24h`,
      { next: { revalidate: 60 } }
    );

    if (!res.ok) {
      throw new Error(
        "Источник рынка временно недоступен"
      );
    }

    return buildTopUniverseCoins(await res.json(), limit) as Coin[];
  } catch {
    return [];
  }
}
