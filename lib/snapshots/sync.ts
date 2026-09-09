import { PrismaClient } from "@prisma/client";
import type { CandleData, Timeframe } from "../exchanges/types";
import { analyzeCandles } from "../analysis/analyze";

export type SnapshotOptions = {
  top: number;
  timeframe: Timeframe;
  historyLimit: number;
};

export type SnapshotStats = {
  assets: number;
  markets: number;
  created: number;
  updated: number;
  skipped: number;
  errors: number;

  byExchange: Record<
    string,
    {
      markets: number;
      created: number;
      updated: number;
      skipped: number;
      errors: number;
    }
  >;
};

export const DEFAULT_SNAPSHOT_OPTIONS: SnapshotOptions = {
  top: 10,
  timeframe: "1h",
  historyLimit: 300
};

function dbCandleToAnalysisCandle(candle: {
  openTime: Date;
  closeTime: Date | null;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
}): CandleData {
  return {
    openTime: candle.openTime,
    closeTime: candle.closeTime ?? undefined,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    closed: candle.closed
  };
}

export async function runSnapshotSync(
  prisma: PrismaClient,
  options: SnapshotOptions
): Promise<SnapshotStats> {
  const assets = await prisma.asset.findMany({
    where: {
      enabled: true,
      rank: {
        lte: options.top,
        not: null
      }
    },

    orderBy: {
      rank: "asc"
    },

    take: options.top,

    include: {
      markets: {
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        },

        orderBy: {
          exchange: "asc"
        }
      }
    }
  });

  const stats: SnapshotStats = {
    assets: assets.length,
    markets: 0,
    created: 0,
    updated: 0,
    skipped: 0,
    errors: 0,
    byExchange: {}
  };

  for (const asset of assets) {
    console.log(
      `\n→ #${asset.rank} ${asset.symbol} (${asset.markets.length} рынков)`
    );

    for (const market of asset.markets) {
      stats.markets += 1;

      if (!stats.byExchange[market.exchange]) {
        stats.byExchange[market.exchange] = {
          markets: 0,
          created: 0,
          updated: 0,
          skipped: 0,
          errors: 0
        };
      }

      const exchangeStats =
        stats.byExchange[market.exchange];

      exchangeStats.markets += 1;

      try {
        /*
         * Берём только ЗАКРЫТЫЕ свечи.
         *
         * Сначала получаем последние N
         * от новой к старой, потом
         * разворачиваем перед анализом.
         */
        const dbCandles =
          await prisma.candle.findMany({
            where: {
              marketId: market.id,
              timeframe: options.timeframe,
              closed: true
            },

            orderBy: {
              openTime: "desc"
            },

            take: options.historyLimit,

            select: {
              openTime: true,
              closeTime: true,
              open: true,
              high: true,
              low: true,
              close: true,
              volume: true,
              closed: true
            }
          });

        if (dbCandles.length < 200) {
          console.warn(
            `  ${market.exchange.padEnd(8)} ` +
            `${market.exchangeSymbol.padEnd(16)} ` +
            `пропуск: только ${dbCandles.length} закрытых свечей`
          );

          stats.skipped += 1;
          exchangeStats.skipped += 1;

          continue;
        }

        const candles =
          dbCandles
            .reverse()
            .map(dbCandleToAnalysisCandle);

        const analysis =
          analyzeCandles(candles);

        if (!analysis) {
          console.warn(
            `  ${market.exchange.padEnd(8)} ` +
            `${market.exchangeSymbol.padEnd(16)} ` +
            `пропуск: анализ не рассчитан`
          );

          stats.skipped += 1;
          exchangeStats.skipped += 1;

          continue;
        }

        /*
         * Проверяем, существовал ли snapshot,
         * чтобы статистика отличала INSERT
         * от UPDATE.
         */
        const existing =
          await prisma.indicatorSnapshot.findUnique({
            where: {
              marketId_timeframe_candleTime: {
                marketId: market.id,
                timeframe: options.timeframe,
                candleTime:
                  analysis.candleTime
              }
            },

            select: {
              id: true
            }
          });

        await prisma.indicatorSnapshot.upsert({
          where: {
            marketId_timeframe_candleTime: {
              marketId: market.id,
              timeframe: options.timeframe,
              candleTime:
                analysis.candleTime
            }
          },

          create: {
            marketId: market.id,
            timeframe: options.timeframe,
            candleTime:
              analysis.candleTime,

            price:
              analysis.price,

            rsi14:
              analysis.rsi14,

            ema20:
              analysis.ema20,

            ema50:
              analysis.ema50,

            ema200:
              analysis.ema200,

            macd:
              analysis.macd,

            macdSignal:
              analysis.macdSignal,

            macdHist:
              analysis.macdHist,

            atr14:
              analysis.atr14,

            volume:
              analysis.volume,

            avgVolume20:
              analysis.avgVolume20,

            volumeRatio:
              analysis.volumeRatio
          },

          update: {
            price:
              analysis.price,

            rsi14:
              analysis.rsi14,

            ema20:
              analysis.ema20,

            ema50:
              analysis.ema50,

            ema200:
              analysis.ema200,

            macd:
              analysis.macd,

            macdSignal:
              analysis.macdSignal,

            macdHist:
              analysis.macdHist,

            atr14:
              analysis.atr14,

            volume:
              analysis.volume,

            avgVolume20:
              analysis.avgVolume20,

            volumeRatio:
              analysis.volumeRatio,

            calculatedAt:
              new Date()
          }
        });

        if (existing) {
          stats.updated += 1;
          exchangeStats.updated += 1;
        } else {
          stats.created += 1;
          exchangeStats.created += 1;
        }

        console.log(
          `  ${market.exchange.padEnd(8)} ` +
          `${market.exchangeSymbol.padEnd(16)} ` +
          `${options.timeframe} ` +
          `${existing ? "обновлён" : "создан"} ` +
          `время=${analysis.candleTime.toISOString()} ` +
          `цена=${analysis.price.toFixed(4)} ` +
          `RSI=${analysis.rsi14?.toFixed(2) ?? "—"} ` +
          `VR=${analysis.volumeRatio?.toFixed(2) ?? "—"}x`
        );
      } catch (error) {
        stats.errors += 1;
        exchangeStats.errors += 1;

        console.error(
          `  ✗ ${market.exchange} ` +
          `${market.exchangeSymbol}:`,
          error instanceof Error
            ? error.message
            : error
        );
      }
    }
  }

  return stats;
}
