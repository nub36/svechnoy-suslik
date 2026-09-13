/**
 * Asset service — add coin, archive coin, Top-50 public selection
 * Additive, no destructive cascade
 */

import { prisma } from "@/lib/prisma";
import { exchanges } from "@/lib/exchanges";

export type AddCoinInput = {
  symbol: string;
  name?: string;
  rank?: number;
};

export type AddCoinResult = {
  asset: { id: number; symbol: string; name: string | null; rank: number | null };
  marketsDiscovered: { exchange: string; exchangeSymbol: string; created: boolean }[];
};

function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function validateSymbol(symbol: string): string | null {
  if (!symbol) return "Symbol required";
  const s = normalizeSymbol(symbol);
  if (!/^[A-Z0-9]{1,20}$/.test(s)) return "Symbol must be 1..20 uppercase letters/digits";
  return null;
}

/**
 * Add coin: creates Asset if not exists, then discovers markets on supported exchanges
 * BINANCE first, then others by priority
 */
export async function addCoin(input: AddCoinInput): Promise<AddCoinResult> {
  const symErr = validateSymbol(input.symbol);
  if (symErr) throw new Error(symErr);

  const symbol = normalizeSymbol(input.symbol);
  const name = input.name?.trim() || null;
  const rank = input.rank ?? null;

  // Check if already exists and not archived
  let asset = await prisma.asset.findUnique({ where: { symbol } });

  if (asset) {
    if (asset.archivedAt) {
      // Unarchive
      asset = await prisma.asset.update({
        where: { id: asset.id },
        data: { archivedAt: null, enabled: true, name: name || asset.name, rank: rank ?? asset.rank },
      });
    } else {
      // Update name/rank if provided
      if (name || rank !== null) {
        asset = await prisma.asset.update({
          where: { id: asset.id },
          data: { name: name || asset.name, rank: rank ?? asset.rank, enabled: true },
        });
      }
    }
  } else {
    asset = await prisma.asset.create({
      data: {
        symbol,
        name,
        rank,
        enabled: true,
        top500: rank !== null && rank <= 500,
      },
    });
  }

  // Discover markets on supported exchanges — BINANCE first
  const exchangePriority = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];
  const sortedExchanges = [...exchanges].sort((a, b) => {
    const aIdx = exchangePriority.indexOf(a.name);
    const bIdx = exchangePriority.indexOf(b.name);
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });

  const marketsDiscovered: { exchange: string; exchangeSymbol: string; created: boolean }[] = [];

  for (const ex of sortedExchanges) {
    try {
      // Try to get market info — adapter may have method to check if symbol exists
      // For simplicity, we try to construct exchangeSymbol and check if adapter can fetch 1 candle or ticker
      // Use exchange-specific symbol format
      let exchangeSymbol: string;
      if (ex.name === "BINANCE") exchangeSymbol = `${symbol}USDT`;
      else if (ex.name === "BYBIT") exchangeSymbol = `${symbol}USDT`;
      else if (ex.name === "GATE") exchangeSymbol = `${symbol}_USDT`;
      else if (ex.name === "KUCOIN") exchangeSymbol = `${symbol}-USDT`;
      else if (ex.name === "BINGX") exchangeSymbol = `${symbol}-USDT`;
      else exchangeSymbol = `${symbol}USDT`;

      // Check if market already exists
      const existingMarket = await prisma.market.findFirst({
        where: {
          exchange: ex.name,
          exchangeSymbol,
          assetId: asset.id,
        },
      });

      if (existingMarket) {
        // Ensure enabled and ACTIVE
        if (!existingMarket.enabled || existingMarket.status !== "ACTIVE") {
          await prisma.market.update({
            where: { id: existingMarket.id },
            data: { enabled: true, status: "ACTIVE", base: symbol, quote: "USDT" },
          });
        }
        marketsDiscovered.push({ exchange: ex.name, exchangeSymbol, created: false });
        continue;
      }

      // Try to verify market exists by attempting to fetch 1 candle (optional, but we can attempt)
      // For now, we optimistically create market if exchange is BINANCE (always try), for others try fetch
      let shouldCreate = false;
      if (ex.name === "BINANCE") {
        shouldCreate = true; // BINANCE first, always create if not exists
      } else {
        try {
          const candles = await ex.getCandles(exchangeSymbol, "1h", 1);
          if (candles && candles.length > 0) shouldCreate = true;
        } catch {
          // If fetch fails, don't create — market may not exist on this exchange
          shouldCreate = false;
        }
      }

      if (shouldCreate) {
        await prisma.market.create({
          data: {
            exchange: ex.name,
            exchangeSymbol,
            marketType: "SPOT",
            base: symbol,
            quote: "USDT",
            enabled: true,
            status: "ACTIVE",
            assetId: asset.id,
          },
        });
        marketsDiscovered.push({ exchange: ex.name, exchangeSymbol, created: true });
      }
    } catch (e) {
      console.error(`[addCoin] Failed to discover ${symbol} on ${ex.name}:`, e instanceof Error ? e.message : String(e));
    }
  }

  return {
    asset: { id: asset.id, symbol: asset.symbol, name: asset.name, rank: asset.rank },
    marketsDiscovered,
  };
}

/**
 * Archive coin — soft delete, preserves OHLCV/Signals/Outcomes
 */
export async function archiveCoin(symbol: string): Promise<{ id: number; symbol: string; archivedAt: Date }> {
  const symErr = validateSymbol(symbol);
  if (symErr) throw new Error(symErr);

  const normalized = normalizeSymbol(symbol);

  const asset = await prisma.asset.findUnique({ where: { symbol: normalized } });
  if (!asset) throw new Error(`Asset ${normalized} not found`);

  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { archivedAt: new Date(), enabled: false },
  });

  // Do NOT delete markets/candles/signals/outcomes — soft archive only
  return { id: updated.id, symbol: updated.symbol, archivedAt: updated.archivedAt! };
}

/**
 * Unarchive coin
 */
export async function unarchiveCoin(symbol: string): Promise<{ id: number; symbol: string }> {
  const normalized = normalizeSymbol(symbol);
  const asset = await prisma.asset.findUnique({ where: { symbol: normalized } });
  if (!asset) throw new Error(`Asset ${normalized} not found`);

  const updated = await prisma.asset.update({
    where: { id: asset.id },
    data: { archivedAt: null, enabled: true },
  });

  return { id: updated.id, symbol: updated.symbol };
}

/**
 * Get Top-50 public assets from DB (rank 1..50, enabled, not archived)
 */
export async function getTop50Assets() {
  const assets = await prisma.asset.findMany({
    where: {
      enabled: true,
      archivedAt: null,
      rank: { gte: 1, lte: 50, not: null },
    },
    orderBy: { rank: "asc" },
    take: 50,
    include: {
      markets: {
        where: { enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
        select: { exchange: true, exchangeSymbol: true, price: true, quoteVolume24h: true, volume24h: true, change24h: true },
      },
    },
  });

  return assets;
}

/**
 * Get public exchange configs, with BINANCE default fallback
 */
export async function getExchangeConfigs() {
  const configs = await prisma.exchangeConfig.findMany({
    orderBy: [{ priority: "desc" }, { exchange: "asc" }],
  });

  // If no configs in DB (first run), return defaults
  if (configs.length === 0) {
    const { DEFAULT_EXCHANGE_CONFIGS } = await import("@/lib/exchanges/config");
    return DEFAULT_EXCHANGE_CONFIGS;
  }

  return configs;
}
