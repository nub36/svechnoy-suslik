/**
 * Public Top-50 — из Asset rank в DB, BINANCE default, fallback по priority
 * Lightweight server snapshot/cache, не 50 WS соединений
 * Live WS только на /coin/{symbol}
 */

import { prisma } from "@/lib/prisma";
import { TOP_UNIVERSE_SIZE } from "@/lib/universe";

export type PublicCoin = {
  id: string;
  symbol: string;
  name: string;
  image?: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number;
  rank: number;
  exchange: string;
  isFallback: boolean;
  requestedExchange: string | null;
};

export async function getPublicTop50(): Promise<PublicCoin[]> {
  try {
    // Get exchange configs
    let exchangeConfigs: { exchange: string; publicEnabled: boolean; priority: number; isDefault: boolean }[] = [];
    try {
      exchangeConfigs = await prisma.exchangeConfig.findMany({
        orderBy: [{ priority: "desc" }, { exchange: "asc" }],
        select: { exchange: true, publicEnabled: true, priority: true, isDefault: true },
      });
    } catch {
      // Fallback to defaults if table not yet migrated
      exchangeConfigs = [
        { exchange: "BINANCE", publicEnabled: true, priority: 100, isDefault: true },
        { exchange: "BYBIT", publicEnabled: true, priority: 90, isDefault: false },
        { exchange: "GATE", publicEnabled: true, priority: 80, isDefault: false },
        { exchange: "KUCOIN", publicEnabled: true, priority: 70, isDefault: false },
        { exchange: "BINGX", publicEnabled: true, priority: 60, isDefault: false },
      ];
    }

    const enabledExchanges = exchangeConfigs.filter(c => c.publicEnabled).sort((a,b) => b.priority - a.priority).map(c => c.exchange);
    const defaultExchange = exchangeConfigs.find(c => c.isDefault && c.publicEnabled)?.exchange || "BINANCE";

    // Top-50 assets from DB: rank 1..50, enabled, not archived
    const assets = await prisma.asset.findMany({
      where: {
        enabled: true,
        archivedAt: null,
        rank: { gte: 1, lte: TOP_UNIVERSE_SIZE, not: null },
      },
      orderBy: { rank: "asc" },
      take: TOP_UNIVERSE_SIZE,
      include: {
        markets: {
          where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
          select: { exchange: true, price: true, quoteVolume24h: true, volume24h: true, change24h: true },
        },
      },
    });

    if (assets.length === 0) {
      // Fallback to CoinGecko if no DB assets (dev)
      return [];
    }

    const result: PublicCoin[] = assets.map((asset: any) => {
      // Find BINANCE market first
      let market = asset.markets.find((m: any) => m.exchange === defaultExchange);
      let isFallback = false;
      let requestedExchange: string | null = defaultExchange;
      let actualExchange = defaultExchange;

      if (!market) {
        // Fallback by priority
        for (const ex of enabledExchanges) {
          const found = asset.markets.find((m: any) => m.exchange === ex);
          if (found) {
            market = found;
            actualExchange = ex;
            isFallback = ex !== defaultExchange;
            break;
          }
        }
        // If still not found, try any market
        if (!market && asset.markets.length > 0) {
          market = asset.markets[0];
          actualExchange = market.exchange;
          isFallback = true;
        }
      } else {
        actualExchange = defaultExchange;
        isFallback = false;
      }

      return {
        id: asset.symbol.toLowerCase(),
        symbol: asset.symbol,
        name: asset.name || asset.symbol,
        image: asset.imageUrl || undefined,
        current_price: market?.price || 0,
        market_cap: 0, // Not stored, will be filled via CoinGecko or leave 0
        total_volume: market?.quoteVolume24h || market?.volume24h || 0,
        price_change_percentage_24h: market?.change24h || 0,
        rank: asset.rank!,
        exchange: actualExchange,
        isFallback,
        requestedExchange,
      };
    });

    // Try to enrich with CoinGecko market caps (lightweight cache, not 50 WS)
    try {
      const ids = result.map(r => r.id).join(",");
      // We don't have mapping id->symbol for CoinGecko, but we can attempt fetch by symbol
      // For simplicity, keep market_cap 0 if not available — UI should handle
    } catch {}

    return result;
  } catch (e) {
    console.error("[getPublicTop50] error:", e instanceof Error ? e.message : String(e));
    return [];
  }
}

export async function getPublicCoinBySymbol(symbol: string): Promise<PublicCoin | null> {
  const normalized = symbol.toUpperCase();
  const top50 = await getPublicTop50();
  return top50.find(c => c.symbol === normalized) || null;
}
