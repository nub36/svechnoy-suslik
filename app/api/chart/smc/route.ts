import { NextResponse } from "next/server";
import {
  buildSmcChartProjection,
  type SmcChartApiDeps,
} from "@/lib/chart/smc-api-service";

export const dynamic = "force-dynamic";

/**
 * GET /api/chart/smc?symbol=BTC&timeframe=1h
 *
 * Smart Money overlays для графика — ТОЛЬКО чтение.
 *
 * Тонкий boundary над принятой P1-A проекцией (lib/chart/smc-projection.ts):
 * вся подготовка/валидация входа и вызов проекции — в
 * lib/chart/smc-api-service.ts; здесь только query-параметры,
 * ленивый prisma и маппинг результата в HTTP.
 *
 * ГАРАНТИИ:
 *  - только GET: никаких POST/PUT/PATCH/DELETE;
 *  - никаких Prisma create/update/upsert/delete, никаких Signal writes,
 *    никаких Strategy/Market/Candle writes (deps интерфейса — только
 *    findUnique/findFirst/findMany);
 *  - никаких обращений к биржам и запуска worker'ов: свечи — только
 *    PostgreSQL CLOSED через существующий bounded loader (500);
 *  - eligibility (BINGX 1d — Option A), common CLOSED horizon и
 *    no-lookahead — внутри P1-A проекции, здесь не дублируются;
 *  - Strategy читается из PostgreSQL (slug smart-money-suslik, latest
 *    version); Strategy.enabled/status НЕ влияют на выдачу и НЕ меняются —
 *    оверлеи графика не зависят от global Strategy.enabled.
 *
 * Ответ:
 *  - 200: точный P1-A SmcChartProjection DTO (второго contract нет);
 *    cannot-evaluate / нет рынков / нет общего горизонта — семантика
 *    внутри DTO (aggregate.status, per-market status), НЕ превращается
 *    в direction=NEUTRAL и НЕ прячется под успешный aggregate;
 *  - 400/404/503: { error } с безопасным русским сообщением
 *    (codes: INVALID_SYMBOL, INVALID_TIMEFRAME, ASSET_NOT_FOUND,
 *    STRATEGY_TIMEFRAME_UNSUPPORTED, STRATEGY_MISSING, STRATEGY_INVALID);
 *    техническая причина БД — только в server-лог (503, как
 *    /api/chart/candles и /api/chart/markets).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const symbol = searchParams.get("symbol");
  const timeframe = searchParams.get("timeframe");
  // Wall clock читается ОДИН раз здесь (вызывающий код) и передаётся
  // в pure-слой — сервис и проекция сами Date.now не вызывают.
  const now = new Date();

  try {
    // Ленивый импорт: ошибка клиента Prisma превращается в честный
    // 503, а не в падение модуля (convention /api/chart/candles).
    const { prisma } = await import("@/lib/prisma");

    // Read-only адаптер: только методы чтения, которые использует
    // сервис (структурная форма SmcChartApiDeps).
    const deps: SmcChartApiDeps = {
      asset: {
        findUnique: (args) =>
          prisma.asset.findUnique(
            args as Parameters<
              typeof prisma.asset.findUnique
            >[0]
          ),
      },
      strategy: {
        findFirst: (args) =>
          prisma.strategy.findFirst(
            args as Parameters<
              typeof prisma.strategy.findFirst
            >[0]
          ),
      },
      market: {
        findMany: (args) =>
          prisma.market.findMany(
            args as Parameters<
              typeof prisma.market.findMany
            >[0]
          ),
      },
      candle: {
        findMany: (args) =>
          prisma.candle.findMany(
            args as Parameters<
              typeof prisma.candle.findMany
            >[0]
          ),
      },
    };

    const result = await buildSmcChartProjection(deps, {
      symbol,
      timeframe,
      now,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error },
        { status: result.status }
      );
    }

    return NextResponse.json(result.projection);
  } catch (error) {
    // Техническая причина — в server-лог; клиенту —
    // безопасное русское сообщение без stack/secrets.
    console.error(
      "[api/chart/smc] Ошибка чтения Smart Money данных:",
      error
    );

    return NextResponse.json(
      {
        error: "База данных временно недоступна",
      },
      { status: 503 }
    );
  }
}
