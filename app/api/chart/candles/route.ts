import { NextResponse } from "next/server";
import {
  emaSeries,
  macdSeries,
  rsiSeries,
  smaSeries
} from "@/lib/indicators";

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

  const limitRaw = Number(
    searchParams.get("limit") ?? "300"
  );
  const limit =
    Number.isInteger(limitRaw) &&
    limitRaw >= 50 &&
    limitRaw <= 1000
      ? limitRaw
      : 300;

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
          closed: true
        },
        orderBy: {
          openTime: "desc"
        },
        take: limit,
        select: {
          openTime: true,
          open: true,
          high: true,
          low: true,
          close: true,
          volume: true
        }
      });

    if (candles.length === 0) {
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
        message:
          "Нет данных: по этому рынку и таймфрейму свечей ещё нет"
      });
  }

    // от старых к новым
    candles.reverse();

    const times = candles.map((c: CandleRow) =>
      Math.floor(
        c.openTime.getTime() / 1000
      )
    );

    const closes = candles.map(
      (c: CandleRow) => c.close
    );

    const ohlc = candles.map((c: CandleRow) => ({
      time: Math.floor(
        c.openTime.getTime() / 1000
      ),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close
    }));

    const volume = candles.map((c: CandleRow) => ({
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
      count: ohlc.length
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
