import { PrismaClient } from "@prisma/client";
import { exchanges } from "../exchanges";
import type { CandleData, ExchangeName, Timeframe } from "../exchanges/types";
import { sleep, withRetry } from "./retry";

export type OhlcvWorkerOptions = {
  top: number;
  timeframes: Timeframe[];
  limit: number;
  requestDelayMs: number;
  symbol?: string;
};

export const DEFAULT_OHLCV_OPTIONS: OhlcvWorkerOptions = {
  top: 10,
  timeframes: ["1h"],
  limit: 300,
  requestDelayMs: 250,
  symbol: undefined
};

function isValidCandle(candle: CandleData): boolean {
  return (
    candle.openTime instanceof Date &&
    !Number.isNaN(candle.openTime.getTime()) &&
    Number.isFinite(candle.open) &&
    Number.isFinite(candle.high) &&
    Number.isFinite(candle.low) &&
    Number.isFinite(candle.close) &&
    Number.isFinite(candle.volume) &&
    candle.high >= candle.low &&
    candle.high >= candle.open &&
    candle.high >= candle.close &&
    candle.low <= candle.open &&
    candle.low <= candle.close &&
    candle.volume >= 0
  );
}

export async function upsertCandles(
  prisma: PrismaClient,
  marketId: number,
  timeframe: Timeframe,
  candles: CandleData[]
): Promise<{ written: number; skipped: number }> {
  const valid = candles.filter(isValidCandle);
  const skipped = candles.length - valid.length;
  let written = 0;

  const chunkSize = 50;

  for (let i = 0; i < valid.length; i += chunkSize) {
    const chunk = valid.slice(i, i + chunkSize);

    await prisma.$transaction(
      chunk.map((candle) =>
        prisma.candle.upsert({
          where: {
            marketId_timeframe_openTime: {
              marketId,
              timeframe,
              openTime: candle.openTime
            }
          },
          create: {
            marketId,
            timeframe,
            openTime: candle.openTime,
            closeTime: candle.closeTime ?? null,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            closed: candle.closed
          },
          update: {
            closeTime: candle.closeTime ?? null,
            open: candle.open,
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            closed: candle.closed
          }
        })
      )
    );

    written += chunk.length;
  }

  return { written, skipped };
}

export type SyncStats = {
  assets: number;
  markets: number;
  fetched: number;
  written: number;
  /** Новых свечей (по дельте count до/после upsert). */
  created: number;
  /** Перезаписанных существующих свечей. */
  updated: number;
  skippedInvalid: number;
  errors: number;
  byExchange: Record<string, { markets: number; written: number; errors: number }>;
  byTimeframe: Record<
    string,
    {
      markets: number;
      fetched: number;
      written: number;
      created: number;
      updated: number;
      skippedInvalid: number;
      errors: number;
    }
  >;
};

export async function runOhlcvSync(
  prisma: PrismaClient,
  options: OhlcvWorkerOptions
): Promise<SyncStats> {
  const adapterByName = new Map(
    exchanges.map((exchange) => [exchange.name, exchange])
  );

  let assets: Array<{
    id: number;
    rank: number | null;
    symbol: string;
    markets: Array<{ id: number; exchange: string; exchangeSymbol: string }>;
  }>;
  if (options.symbol) {
    const single = await prisma.asset.findFirst({
      where: {
        symbol: options.symbol,
        enabled: true
      },
      include: {
        markets: {
          where: {
            enabled: true,
            status: "ACTIVE",
            quote: "USDT",
            marketType: "SPOT"
          }
        }
      }
    });
    assets = single ? [single as any] : [];
  } else {
    assets = await prisma.asset.findMany({
      where: {
        enabled: true,
        rank: {
          lte: options.top,
          not: null
        }
      },
      orderBy: { rank: "asc" },
      take: options.top,
      include: {
        markets: {
          where: {
            enabled: true,
            status: "ACTIVE",
            quote: "USDT",
            marketType: "SPOT"
          }
        }
      }
    });
  }

  const stats: SyncStats = {
    assets: assets.length,
    markets: 0,
    fetched: 0,
    written: 0,
    created: 0,
    updated: 0,
    skippedInvalid: 0,
    errors: 0,
    byExchange: {},
    byTimeframe: {}
  };

  for (const name of adapterByName.keys()) {
    stats.byExchange[name] = { markets: 0, written: 0, errors: 0 };
  }

  for (const timeframe of options.timeframes) {
    stats.byTimeframe[timeframe] = {
      markets: 0,
      fetched: 0,
      written: 0,
      created: 0,
      updated: 0,
      skippedInvalid: 0,
      errors: 0
    };
  }

  for (const asset of assets) {
    console.log(
      `\n→ #${asset.rank} ${asset.symbol} (${asset.markets.length} рынков)`
    );

    for (const market of asset.markets) {
      const adapter = adapterByName.get(market.exchange as ExchangeName);

      if (!adapter) {
        console.warn(`  нет адаптера для ${market.exchange}`);
        continue;
      }

      const exchangeStats = stats.byExchange[market.exchange] ?? {
        markets: 0,
        written: 0,
        errors: 0
      };
      stats.byExchange[market.exchange] = exchangeStats;

      for (const timeframe of options.timeframes) {
        stats.markets += 1;
        exchangeStats.markets += 1;

        const tfStats = stats.byTimeframe[timeframe];
        tfStats.markets += 1;

        try {
          const last = await prisma.candle.findFirst({
            where: { marketId: market.id, timeframe },
            orderBy: { openTime: "desc" },
            select: { openTime: true }
          });

          const candles = await withRetry(
            `${market.exchange} ${market.exchangeSymbol} ${timeframe}`,
            () =>
              adapter.getCandles(
                market.exchangeSymbol,
                timeframe,
                options.limit
              )
          );

          const incoming = last
            ? candles.filter(
                (candle) => candle.openTime.getTime() >= last.openTime.getTime()
              )
            : candles;

          stats.fetched += incoming.length;
          tfStats.fetched += incoming.length;

          // created/updated по дельте count до/после upsert:
          // сам upsert не сообщает, создана строка или обновлена.
          // Запросы дешёвые (уникальный индекс market+tf+openTime).
          const countBefore =
            incoming.length > 0
              ? await prisma.candle.count({
                  where: { marketId: market.id, timeframe }
                })
              : null;

          const result = await upsertCandles(
            prisma,
            market.id,
            timeframe,
            incoming
          );

          let created = 0;

          if (countBefore !== null) {
            const countAfter = await prisma.candle.count({
              where: { marketId: market.id, timeframe }
            });

            created = Math.min(
              Math.max(countAfter - countBefore, 0),
              result.written
            );
          } else {
            created = result.written;
          }

          const updated = result.written - created;

          stats.written += result.written;
          stats.created += created;
          stats.updated += updated;
          stats.skippedInvalid += result.skipped;
          exchangeStats.written += result.written;
          tfStats.written += result.written;
          tfStats.created += created;
          tfStats.updated += updated;
          tfStats.skippedInvalid += result.skipped;

          await prisma.market.update({
            where: { id: market.id },
            data: { lastSyncAt: new Date() }
          });

          const closed = incoming.filter((c) => c.closed).length;
          const first = incoming[0]?.openTime.toISOString() ?? "нет";
          const lastOpen =
            incoming[incoming.length - 1]?.openTime.toISOString() ?? "нет";

          console.log(
            `  ${market.exchange.padEnd(8)} ${market.exchangeSymbol.padEnd(16)} ` +
              `${timeframe} получено=${incoming.length} ` +
              `закрытых=${closed} записано=${result.written} ` +
              `создано=${created} обновлено=${updated} ` +
              `${first} → ${lastOpen}`
          );
        } catch (error) {
          stats.errors += 1;
          exchangeStats.errors += 1;
          tfStats.errors += 1;
          console.error(
            `  ✗ ${market.exchange} ${market.exchangeSymbol} ${timeframe}:`,
            error instanceof Error ? error.message : error
          );
        }

        await sleep(options.requestDelayMs);
      }
    }
  }

  return stats;
}
