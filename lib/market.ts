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

export async function getTopCoins(limit = 500): Promise<Coin[]> {
  try {
    const pages = Math.ceil(Math.min(limit, 500) / 250);
    const result: Coin[] = [];

    for (let page = 1; page <= pages; page++) {
      const res = await fetch(
        `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=250&page=${page}&sparkline=false&price_change_percentage=24h`,
        { next: { revalidate: 60 } }
      );

      if (!res.ok) {
        throw new Error("Источник рынка временно недоступен");
      }

      result.push(...(await res.json()));
    }

    return result.slice(0, limit);
  } catch {
    return demoCoins;
  }
}

const demoCoins: Coin[] = [
  {
    id: "bitcoin",
    symbol: "btc",
    name: "Bitcoin",
    current_price: 78573.4,
    market_cap: 1560000000000,
    total_volume: 55040000000,
    price_change_percentage_24h: -0.64
  },
  {
    id: "ethereum",
    symbol: "eth",
    name: "Ethereum",
    current_price: 2491.04,
    market_cap: 304560000000,
    total_volume: 39110000000,
    price_change_percentage_24h: 0.12
  },
  {
    id: "solana",
    symbol: "sol",
    name: "Solana",
    current_price: 103.78,
    market_cap: 60910000000,
    total_volume: 6820000000,
    price_change_percentage_24h: -0.21
  }
];
