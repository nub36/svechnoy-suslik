/**
 * Готовность Top-100 universe к отображению графиков — ЧИСТАЯ свёртка.
 *
 * Диагностика (admin/data) получает строки агрегатного SQL-запроса
 * (один read-only проход: активы Top-100 + число активных SPOT USDT
 * рынков + число рынков с ЗАКРЫТЫМИ свечами) и превращает их в
 * понятный отчёт. Модуль ничего не читает из БД, не кэширует и не
 * пишет — только функция-свёртка, чтобы её можно было тестировать
 * детерминированно в node.
 */

import { TOP_UNIVERSE_SIZE } from "@/lib/universe";

/** Строка агрегата readiness-запроса (см. app/admin/data/page.tsx). */
export interface UniverseReadinessRow {
  symbol: string;
  rank: number;
  /** Активные SPOT USDT-рынки актива (0 — рынков нет). */
  markets: number;
  /** Из них — рынки, по которым есть хотя бы одна ЗАКРЫТАЯ свеча. */
  candleMarkets: number;
}

export type ReadinessReason =
  | "no-market"
  | "no-candles";

export interface ReadinessAssetStatus {
  symbol: string;
  rank: number;
  markets: number;
  candleMarkets: number;
  /** true — по активу реально есть закрытые свечи (график доступен). */
  hasChartData: boolean;
  /** null, если готов полностью. */
  reason: ReadinessReason | null;
}

export interface TopUniverseReadinessSummary {
  /** Сколько активов Top-100 реально найдено в БД (≤ TOP_UNIVERSE_SIZE). */
  universe: number;
  /** Целевой размер вселенной (константа продукта). */
  universeTarget: number;
  /** Активы хотя бы с одним активным SPOT USDT рынком. */
  withMarket: number;
  /** Активы, по которым ЕСТЬ закрытые свечи (CHART DATA AVAILABLE). */
  withChartData: number;
  /** Проблемные активы, отсортированы по рангу (детерминированно). */
  missing: ReadinessAssetStatus[];
}

/**
 * Свёртка строк в итог. Инварианты: счётчики не выдумываются —
 * withMarket/withChartData считаются по фактическим строкам;
 * пустой вход (в БД ещё нет топ-рангов) даёт universe 0 —
 * страница обязана показать это честно.
 */
export function summarizeTopUniverseReadiness(
  rows: readonly UniverseReadinessRow[]
): TopUniverseReadinessSummary {
  const statuses: ReadinessAssetStatus[] = rows.map((row) => {
    const markets = Number.isFinite(row.markets) ? Math.max(0, Math.trunc(row.markets)) : 0;
    const candleMarkets =
      Number.isFinite(row.candleMarkets) ? Math.max(0, Math.trunc(row.candleMarkets)) : 0;
    const hasChartData = markets > 0 && candleMarkets > 0;

    return {
      symbol: row.symbol,
      rank: Number.isFinite(row.rank) ? Math.trunc(row.rank) : 0,
      markets,
      candleMarkets,
      hasChartData,
      reason:
        markets === 0
          ? "no-market"
          : candleMarkets === 0
            ? "no-candles"
            : null
    };
  });

  statuses.sort((a, b) =>
    a.rank !== b.rank
      ? a.rank - b.rank
      : a.symbol < b.symbol
        ? -1
        : a.symbol > b.symbol
          ? 1
          : 0
  );

  return {
    universe: statuses.length,
    universeTarget: TOP_UNIVERSE_SIZE,
    withMarket: statuses.filter((s) => s.markets > 0).length,
    withChartData: statuses.filter((s) => s.hasChartData).length,
    missing: statuses.filter((s) => s.reason !== null)
  };
}

/** Человекочитаемое объяснение причины (RU, для UI и тестов). */
export function readinessReasonText(reason: ReadinessReason): string {
  return reason === "no-market"
    ? "нет активных SPOT USDT-рынков"
    : "нет закрытых свечей по реальным рынкам";
}
