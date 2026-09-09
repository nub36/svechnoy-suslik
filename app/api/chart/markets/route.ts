import { NextResponse } from "next/server";
import { parseSymbolParam } from "@/lib/chart/params";

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
 *
 * Таймфреймы считаются ОДНИМ агрегированным SQL-запросом
 * (GROUP BY на стороне PostgreSQL) — вместо N+1 запросов
 * и без загрузки свечей в Node.js. Prisma groupBy не
 * используется из-за проблем типов на реальном
 * сгенерированном клиенте.
 *
 * $queryRaw вызывается ТОЛЬКО членом объекта:
 * prisma.$queryRaw<T>`...` (см. scripts/test-chart-sql.ts).
 */

type ChartRow = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  timeframe: string;
  candleCount: number;
  lastCandleTime: Date;
};

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

  // Режим БЕЗ symbol — легитимный: это список активов для
  // селектора графика. Валидируем symbol ТОЛЬКО если он
  // передан (регрессия 89e2671: строгая проверка давала 400
  // на запрос списка и ломала селектор «Монета»).
  // Внимание: get() без параметра даёт undefined, а не null.
  const symbolCheck = symbol
    ? parseSymbolParam(symbol)
    : null;

  if (symbolCheck !== null && !symbolCheck.ok) {
    return NextResponse.json(
      { error: symbolCheck.message },
      { status: 400 }
    );
  }

  const symbolValue =
    symbolCheck !== null && symbolCheck.ok
      ? symbolCheck.value
      : null;

  try {
    // Ленивый импорт: ошибка клиента Prisma
    // превращается в честный 503, а не в падение модуля.
    const { prisma } = await import(
      "@/lib/prisma"
    );

    if (!symbolValue) {
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
        where: { symbol: symbolValue },
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

    // ВАЖНО: $queryRaw вызывается строго членом объекта
    // (tagged template с типом результата). Присваивать его
    // переменной нельзя: метод прототипный, отрыв от клиента
    // теряет this и в runtime даёт TypeError, который catch
    // маскирует под «БД недоступна» (реальный 503 на VPS
    // при живой базе). Проверяет scripts/test-chart-sql.ts.
    const rows = await prisma.$queryRaw<ChartRow[]>`
      SELECT
        m.id AS "marketId",
        m.exchange AS "exchange",
        m."exchangeSymbol" AS "exchangeSymbol",
        c.timeframe AS "timeframe",
        COUNT(*)::int AS "candleCount",
        MAX(c."openTime") AS "lastCandleTime"
      FROM "Candle" c
      JOIN "Market" m ON m.id = c."marketId"
      WHERE m."assetId" = ${asset.id}
        AND m.enabled = true
        AND m.status = 'ACTIVE'
        AND m.quote = 'USDT'
        AND m."marketType" = 'SPOT'
      GROUP BY
        m.id, m.exchange,
        m."exchangeSymbol", c.timeframe
      ORDER BY m.exchange, c.timeframe
    `;

    const byMarket = new Map<
      number,
      {
        marketId: number;
        exchange: string;
        exchangeSymbol: string;
        timeframes: {
          timeframe: string;
          count: number;
          lastCandleTime: Date;
        }[];
      }
    >();

    for (const row of rows) {
      let entry = byMarket.get(
        row.marketId
      );

      if (!entry) {
        entry = {
          marketId: row.marketId,
          exchange: row.exchange,
          exchangeSymbol:
            row.exchangeSymbol,
          timeframes: []
        };

        byMarket.set(row.marketId, entry);
      }

      entry.timeframes.push({
        timeframe: row.timeframe,
        count: row.candleCount,
        lastCandleTime: row.lastCandleTime
      });
    }

    const result = [...byMarket.values()];

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
  } catch (error) {
    // Техническая причина — только в server-лог; клиенту —
    // безопасное русское сообщение без stack/secrets.
    console.error(
      "[api/chart/markets] Ошибка запроса рынков:",
      error
    );

    return NextResponse.json(
      {
        error:
          "База данных временно недоступна"
      },
      { status: 503 }
    );
  }
}
