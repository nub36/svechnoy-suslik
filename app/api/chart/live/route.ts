import { NextResponse } from "next/server";
import {
  parseExchangeParam,
  parseSymbolParam,
  parseTimeframeParam,
} from "@/lib/chart/params";

export const dynamic = "force-dynamic";

/**
 * LIVE current candle for visualization ONLY — does NOT affect Signal Engine
 * Signal Engine uses ONLY CLOSED candles from PostgreSQL
 * This endpoint is for /coin/BTC live-like chart without F5
 *
 * Returns:
 * - latestClosed from DB (closed=true)
 * - current from DB (closed=false) if exists
 * - live from exchange (lightweight getCandles 2) for truly moving price every few seconds, without DB write
 * - serverTime
 *
 * Load: only 1-2 candles, not hundreds
 */

const ALLOWED_TIMEFRAMES = ["5m", "15m", "1h", "4h", "1d"] as const;

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const symbol = searchParams.get("symbol")?.trim().toUpperCase();
  const exchange = searchParams.get("exchange")?.trim();
  const timeframe = searchParams.get("timeframe")?.trim();

  const symbolCheck = parseSymbolParam(symbol);
  const exchangeCheck = parseExchangeParam(exchange);
  const timeframeCheck = parseTimeframeParam(timeframe);

  const firstInvalid = [symbolCheck, exchangeCheck, timeframeCheck].find((c) => !c.ok);
  if (firstInvalid && !firstInvalid.ok) {
    return NextResponse.json({ error: firstInvalid.message }, { status: 400 });
  }

  if (!symbol || !exchange || !timeframe || !ALLOWED_TIMEFRAMES.includes(timeframe as any)) {
    return NextResponse.json({ error: "Неверные параметры: нужны symbol, exchange, timeframe" }, { status: 400 });
  }

  try {
    const { prisma } = await import("@/lib/prisma");
    const asset = await prisma.asset.findUnique({ where: { symbol }, select: { id: true } });
    if (!asset) {
      return NextResponse.json({ error: `Актив ${symbol} не найден` }, { status: 404 });
    }
    const market = await prisma.market.findFirst({
      where: { assetId: asset.id, exchange, enabled: true, status: "ACTIVE", quote: "USDT", marketType: "SPOT" },
      select: { id: true, exchange: true, exchangeSymbol: true },
    });
    if (!market) {
      return NextResponse.json({ error: `Рынок ${symbol} на ${exchange} недоступен` }, { status: 404 });
    }

    // DB latest closed and latest any (including open)
    const latestClosedDb = await prisma.candle.findFirst({
      where: { marketId: market.id, timeframe, closed: true },
      orderBy: { openTime: "desc" },
      select: { openTime: true, closeTime: true, open: true, high: true, low: true, close: true, volume: true, closed: true, updatedAt: true },
    });
    const latestAnyDb = await prisma.candle.findFirst({
      where: { marketId: market.id, timeframe },
      orderBy: { openTime: "desc" },
      select: { openTime: true, closeTime: true, open: true, high: true, low: true, close: true, volume: true, closed: true, updatedAt: true, createdAt: true },
    });

    // Live from exchange — lightweight, no DB write, for visualization every few seconds
    // Use existing exchange adapters getCandles limit 2 — last candle is current open with live close price
    let liveFromExchange: any = null;
    let liveError: string | null = null;
    try {
      const { exchanges } = await import("@/lib/exchanges");
      const adapter = exchanges.find((e: any) => e.name === exchange);
      if (adapter) {
        const candles = await adapter.getCandles(market.exchangeSymbol, timeframe as any, 2);
        if (candles.length > 0) {
          const last = candles[candles.length - 1];
          liveFromExchange = {
            openTime: last.openTime.toISOString(),
            closeTime: last.closeTime?.toISOString() ?? null,
            open: last.open,
            high: last.high,
            low: last.low,
            close: last.close,
            volume: last.volume,
            closed: last.closed,
            time: Math.floor(last.openTime.getTime() / 1000),
          };
        }
      }
    } catch (e: any) {
      liveError = e.message ?? String(e);
      // fail-closed for live exchange, still return DB data
    }

    const toApi = (c: any) =>
      c
        ? {
            openTime: c.openTime.toISOString(),
            closeTime: c.closeTime?.toISOString() ?? null,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
            volume: c.volume,
            closed: c.closed,
            time: Math.floor(c.openTime.getTime() / 1000),
            updatedAt: c.updatedAt?.toISOString() ?? null,
            createdAt: c.createdAt?.toISOString() ?? null,
          }
        : null;

    return NextResponse.json({
      market: { exchange: market.exchange, exchangeSymbol: market.exchangeSymbol },
      timeframe,
      serverTime: new Date().toISOString(),
      latestClosedDb: toApi(latestClosedDb),
      latestAnyDb: toApi(latestAnyDb),
      currentDb: latestAnyDb && !latestAnyDb.closed ? toApi(latestAnyDb) : null,
      liveFromExchange,
      liveError,
      // For client: current candle to display is liveFromExchange if available and its openTime >= latestClosed, else currentDb, else null
      // Historical remains CLOSED only
    });
  } catch (error) {
    console.error("[api/chart/live] error:", error);
    return NextResponse.json({ error: "База данных временно недоступна" }, { status: 503 });
  }
}
