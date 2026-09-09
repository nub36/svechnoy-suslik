import { NextResponse } from "next/server";
import {
  emaSeries,
  macdSeries,
  rsiSeries,
  smaSeries
} from "@/lib/indicators";
import {
  parseHistoryLimit,
  validateCursor
} from "@/lib/chart/history";

export const dynamic = "force-dynamic";

/**
 * Свечи для графика — ТОЛЬКО чтение существующих
 * PostgreSQL Candle (закрытые). Никаких обращений
 * к API бирж и никакого второго OHLCV-конвейера.
 *
 * Индикаторы считаются существующим слоем
 * lib/indicators (те же функции, что и в анализе),
 * стандартный набор периодов совпадает
 * с IndicatorSnapshot: EMA 20/50/200, SMA 20,
 * RSI 14, MACD 12/26/9.
 */

const ALLOWED_TIMEFRAMES = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
];

type TimePoint = { time: number; value: number };

type CandleRow = {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Компактная серия из emaSeries/... выровненная
 * по свечам: элемент j соответствует индексу j + offset.
 */
function alignCompact(
  compact: number[],
  offset: number,
  times: number[]
): TimePoint[] {
  const result: TimePoint[] = [];

  for (
    let j = 0;
    j < compact.length;
    j++
  ) {
    const index = j + offset;

    if (index >= times.length) {
      break;
    }

    result.push({
      time: times[index],
      value: compact[j]
    });
  }

  return result;
}

function alignNullable(
  series: (number | null)[],
  times: number[]
): TimePoint[] {
  const result: TimePoint[] = [];

  for (let i = 0; i < series.length; i++) {
    const value = series[i];

    if (
      value !== null &&
      value !== undefined &&
      Number.isFinite(value)
    ) {
      result.push({
        time: times[i],
        value
      });
    }
  }

  return result;
}

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
  const exchange = searchParams
    .get("exchange")
    ?.trim();
  const timeframe = searchParams
    .get("timeframe")
    ?.trim();

  const limit = parseHistoryLimit(
    searchParams.get("limit")
  );

  // Cursor-пагинация истории: before = openTime (мс) свечи,
  // СТРОГО старее которой нужны свечи. Никакого OFFSET.
  const beforeRaw =
    searchParams.get("before");

  let beforeMs: number | null = null;

  if (beforeRaw !== null) {
    const cursor = validateCursor(beforeRaw);

    if (!cursor.ok) {
      return NextResponse.json(
        { error: cursor.message },
        { status: 400 }
      );
    }

    beforeMs = cursor.ms;
  }

  if (
    !symbol ||
    !exchange ||
    !timeframe ||
    !ALLOWED_TIMEFRAMES.includes(timeframe)
  ) {
    return NextResponse.json(
      {
        error:
          "Неверные параметры: нужны symbol, exchange и timeframe (5m, 15m, 1h, 4h, 1d)"
      },
      { status: 400 }
    );
  }

  try {
    // Ленивый импорт: ошибка клиента Prisma
    // превращается в честный 503, а не в падение модуля.
    const { prisma } = await import(
      "@/lib/prisma"
    );

    const asset =
      await prisma.asset.findUnique({
        where: { symbol },
        select: { id: true }
      });

    if (!asset) {
      return NextResponse.json(
        {
          error: `Актив ${symbol} не найден в базе`
        },
        { status: 404 }
      );
    }

    const market =
      await prisma.market.findFirst({
        where: {
          assetId: asset.id,
          exchange,
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        },
        select: {
          id: true,
          exchange: true,
          exchangeSymbol: true
        }
      });

    if (!market) {
      return NextResponse.json(
        {
          error: `Рынок ${symbol} на ${exchange} недоступен`
        },
        { status: 404 }
      );
    }

    const candles =
      await prisma.candle.findMany({
        where: {
          marketId: market.id,
          timeframe,
          closed: true,
          ...(beforeMs !== null
            ? {
                openTime: {
                  lt: new Date(beforeMs)
                }
              }
            : {})
        },
        orderBy: {
          openTime: "desc"
        },
        // limit+1: лишняя свеча — только признак hasMore.
        take: limit + 1,
        select: {
          openTime: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true
        }
      });

    const hasMore = candles.length > limit;
    const page = hasMore
      ? candles.slice(0, limit)
      : candles;

    if (page.length === 0) {
      return NextResponse.json({
        market: {
          exchange: market.exchange,
          exchangeSymbol:
            market.exchangeSymbol
        },
        timeframe,
        candles: [],
        volume: [],
        indicators: null,
        hasMore: false,
        nextCursor: null,
        message:
          "Нет данных: по этому рынку и таймфрейму свечей больше нет"
      });
  }

    // от старых к новым
    page.reverse();

    const times = page.map((c: CandleRow) =>
      Math.floor(
        c.openTime.getTime() / 1000
      )
    );

    const closes = page.map(
      (c: CandleRow) => c.close
    );

    const ohlc = page.map((c: CandleRow) => ({
      time: Math.floor(
        c.openTime.getTime() / 1000
      ),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));

    const volume = page.map((c: CandleRow) => ({
      time: Math.floor(
        c.openTime.getTime() / 1000
      ),
      value: c.volume
    }));

    const ema20 = alignCompact(
      emaSeries(closes, 20),
      19,
      times
    );
    const ema50 = alignCompact(
      emaSeries(closes, 50),
      49,
      times
    );
    const ema200 = alignCompact(
      emaSeries(closes, 200),
      199,
      times
    );
    const sma20 = alignNullable(
      smaSeries(closes, 20),
      times
    );
    const rsi14 = alignNullable(
      rsiSeries(closes, 14),
      times
    );

    const macd = macdSeries(
      closes,
      12,
      26,
      9
    );

    return NextResponse.json({
      market: {
        exchange: market.exchange,
        exchangeSymbol:
          market.exchangeSymbol
      },
      timeframe,
      candles: ohlc,
      volume,
      indicators: {
        ema20,
        ema50,
        ema200,
        sma20,
        rsi14,
        macd: {
          macd: alignNullable(
            macd.macd,
            times
          ),
          signal: alignNullable(
            macd.signal,
            times
          ),
          histogram: alignNullable(
            macd.histogram,
            times
          )
        }
      },
      lastCandleTime:
        times[times.length - 1] ?? null,
      count: ohlc.length,
      hasMore,
      nextCursor:
        hasMore && ohlc.length > 0
          ? page[0].openTime.getTime()
          : null
    });
  } catch (error) {
    // Техническая причина — в server-лог; клиенту —
    // безопасное русское сообщение без stack/secrets.
    console.error(
      "[api/chart/candles] Ошибка запроса свечей:",
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
