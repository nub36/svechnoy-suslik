import type { PrismaClient } from "@prisma/client";
import type { Timeframe } from "../exchanges/types";

/**
 * План запуска snapshot worker — read-only.
 *
 * collectSnapshotPlan делает ТОЛЬКО SELECT-запросы
 * (Asset/Market/Candle/IndicatorSnapshot, агрегаты в
 * PostgreSQL), ничего не пишет и не обращается к API бирж.
 *
 * Показывает по каждому таймфрейму: скольким рынкам хватит
 * истории (>= historyLimit закрытых свечей), скольким не
 * хватит, сколько снапшотов потенциально будет создано
 * (нет свежего снапшота) и сколько обновлено.
 */

export type SnapshotPlanOptions = {
  top: number;
  timeframes: Timeframe[];
  historyLimit: number;
};

export type SnapshotPlanTfRow = {
  timeframe: string;
  markets: number;
  withEnoughHistory: number;
  withoutEnoughHistory: number;
  createdPotential: number;
  updatedPotential: number;
};

export type SnapshotPlanStats = {
  assets: number;
  markets: number;
  historyLimit: number;
  rows: SnapshotPlanTfRow[];
};

export async function collectSnapshotPlan(
  prisma: PrismaClient,
  options: SnapshotPlanOptions
): Promise<SnapshotPlanStats> {
  const assets = await prisma.asset.findMany({
    where: {
      enabled: true,
      rank: {
        lte: options.top,
        not: null
      }
    },
    orderBy: { rank: "asc" },
    take: options.top,
    select: { id: true }
  });

  const assetIds = assets.map(
    (a: { id: number }) => a.id
  );

  if (assetIds.length === 0) {
    return {
      assets: 0,
      markets: 0,
      historyLimit: options.historyLimit,
      rows: []
    };
  }

  const markets =
    await prisma.market.findMany({
      where: {
        assetId: { in: assetIds },
        enabled: true,
        status: "ACTIVE",
        quote: "USDT",
        marketType: "SPOT"
      },
      select: { id: true }
    });

  const marketIds = markets.map(
    (m: { id: number }) => m.id
  );

  const rows: SnapshotPlanTfRow[] = [];

  for (const timeframe of options.timeframes) {
    // рынки с достаточной историей (read-only агрегат)
    const enough = (await prisma
      .$queryRaw<{ markets: number }[]>`
      SELECT COUNT(*)::int AS "markets"
      FROM (
        SELECT c."marketId"
        FROM "Candle" c
        WHERE c."marketId" = ANY(${marketIds})
          AND c.timeframe = ${timeframe}
          AND c.closed = true
        GROUP BY c."marketId"
        HAVING COUNT(*) >= ${options.historyLimit}
      ) t
    `) as unknown as { markets: number }[];

    const withEnough =
      enough[0]?.markets ?? 0;

    // уже существующие снапшоты по этим рынкам и ТФ
    const existing = (await prisma
      .$queryRaw<{ total: number }[]>`
      SELECT COUNT(*)::int AS "total"
      FROM "IndicatorSnapshot" s
      WHERE s."marketId" = ANY(${marketIds})
        AND s.timeframe = ${timeframe}
    `) as unknown as { total: number }[];

    const existingCount =
      existing[0]?.total ?? 0;

    rows.push({
      timeframe,
      markets: marketIds.length,
      withEnoughHistory: withEnough,
      withoutEnoughHistory:
        marketIds.length - withEnough,
      createdPotential: Math.max(
        withEnough - existingCount,
        0
      ),
      updatedPotential: Math.min(
        existingCount,
        withEnough
      )
    });
  }

  return {
    assets: assetIds.length,
    markets: marketIds.length,
    historyLimit: options.historyLimit,
    rows
  };
}

/** Строки отчёта плана (чистая функция). */
export function formatSnapshotPlanReport(
  options: SnapshotPlanOptions,
  stats: SnapshotPlanStats
): string[] {
  const lines: string[] = [];

  lines.push(
    "Режим PLAN: PostgreSQL не изменяется, API бирж не вызываются, IndicatorSnapshot не пишутся"
  );
  lines.push(`Top-N: ${options.top}`);
  lines.push(`Таймфреймы: ${options.timeframes.join(", ")}`);
  lines.push(`Нужная история (свечей на рынок): ${options.historyLimit}`);
  lines.push(`Активов выбрано: ${stats.assets}`);
  lines.push(`Рынков (активные SPOT USDT): ${stats.markets}`);

  if (stats.rows.length === 0) {
    lines.push("Данных для плана нет (активы/рынки не найдены)");

    return lines;
  }

  for (const row of stats.rows) {
    lines.push(
      `  ${row.timeframe.padEnd(4)} ` +
        `истории хватает=${row.withEnoughHistory} ` +
        `не хватает=${row.withoutEnoughHistory} ` +
        `создано будет ≈${row.createdPotential} ` +
        `обновлено будет ≈${row.updatedPotential}`
    );
  }

  return lines;
}
