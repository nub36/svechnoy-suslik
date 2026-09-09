export type Coin = {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
};

/**
 * Рыночные данные CoinGecko (кэш 60 секунд).
 *
 * ВАЖНО: при недоступности источника возвращается
 * пустой список, а НЕ демо-данные: показывать
 * выдуманные цены как реальные запрещено.
 * Пустой список интерфейс честно помечает
 * «Нет данных».
 */
export async function getTopCoins(
  limit = 500
): Promise<Coin[]> {
  try {
    const pages = Math.ceil(
      Math.min(limit, 500) / 250
    );

    const result: Coin[] = [];

    for (let page = 1; page <= pages; page++) {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false&price_change_percentage=24h`,
        { next: { revalidate: 60 } }
      );

      if (!res.ok) {
        throw new Error(
          "Источник рынка временно недоступен"
        );
      }

      result.push(...(await res.json()));
    }

    return result.slice(0, limit);
  } catch {
    return [];
  }
}
