import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/**
 * Какие рынки есть для графика.
 *
 * Без параметров: список активов, у которых есть
 * включённые SPOT USDT-рынки со свечами в PostgreSQL.
 * С ?symbol=BTC: биржи этого актива и доступные таймфреймы
 * (только те, по которым реально лежат свечи).
 *
 * Никаких обращений к биржам — только существующие
 * PostgreSQL Candle/Market/Asset.
 */

export async function GET(
  request: Request
) {
  const { searchParams } = new URL(
    request.url
  );

  const symbol = searchParams
    .get("symbol")
    ?.trim()
    .toUpperCase();

  try {
    // Ленивый импорт: ошибка клиента Prisma
    // превращается в честный 503, а не в падение модуля.
    const { prisma } = await import(
      "@/lib/prisma"
    );

    if (!symbol) {
      const assets =
        await prisma.asset.findMany({
          where: {
            enabled: true,
            markets: {
              some: {
                enabled: true,
                status: "ACTIVE",
                quote: "USDT",
                marketType: "SPOT",
                candles: {
                  some: {}
                }
              }
            }
          },
          select: {
            symbol: true,
            name: true,
            rank: true
          },
          orderBy: {
            rank: "asc"
          },
          take: 100
        });

      return NextResponse.json({
        symbols: assets.map((a: { symbol: string; name: string | null; rank: number | null }) => ({
          symbol: a.symbol,
          name: a.name,
          rank: a.rank
        }))
      });
    }

    const asset =
      await prisma.asset.findUnique({
        where: { symbol },
        select: {
          id: true,
          symbol: true,
          name: true,
          rank: true,
          top500: true
        }
      });

    if (!asset) {
      return NextResponse.json(
        {
          error:
            "Актив не найден в базе. Прогоните rank-assets и OHLCV worker."
        },
        { status: 404 }
      );
    }

    const markets =
      await prisma.market.findMany({
        where: {
          assetId: asset.id,
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT",
          candles: { some: {} }
        },
        select: {
          id: true,
          exchange: true,
          exchangeSymbol: true
        },
        orderBy: {
          exchange: "asc"
        }
      });

    const result = [];

    for (const market of markets) {
      const grouped =
        await prisma.candle.groupBy({
          by: ["timeframe"],
          where: {
            marketId: market.id
          },
          _count: { _all: true },
          _max: {
            openTime: true
          }
        });

      result.push({
        marketId: market.id,
        exchange: market.exchange,
        exchangeSymbol:
          market.exchangeSymbol,
        timeframes: grouped
          .map((g: { timeframe: string; _count: { _all: number }; _max: { openTime: Date | null } }) => ({
            timeframe: g.timeframe,
            count: g._count._all,
            lastCandleTime: g._max.openTime
          }))
          .sort((a: { timeframe: string }, b: { timeframe: string }) =>
            a.timeframe.localeCompare(
              b.timeframe
            )
          )
      });
    }

    if (result.length === 0) {
      return NextResponse.json(
        {
          asset: {
            symbol: asset.symbol,
            name: asset.name,
            rank: asset.rank
          },
          markets: [],
          error: null
        },
        { status: 200 }
      );
    }

    return NextResponse.json({
      asset: {
        symbol: asset.symbol,
        name: asset.name,
        rank: asset.rank,
        top500: asset.top500
      },
      markets: result,
      error: null
    });
  } catch {
    return NextResponse.json(
      {
        error:
          "База данных временно недоступна"
      },
      { status: 503 }
    );
  }
}
