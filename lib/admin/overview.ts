/**
 * Запросы Overview (/admin) одним проверяемым блоком.
 *
 * Вынесено из app/admin/page.tsx после VPS-ревью
 * 8a1ae16: при добавлении запроса в Promise.all
 * деструктурирование не было сдвинуто, и переменные
 * получили чужие значения (assets ← счётчик рынков
 * Top-100 и т.д.). Здесь порядок запросов и порядок
 * имён заданы КОНСТАНТОЙ OVERVIEW_QUERY_ORDER и
 * проверяются тестом на подставной БД
 * (scripts/test-admin-consistency.ts): перестановка
 * запросов местами больше не может пройти зелёной.
 *
 * Чистый модуль: без Next, без синглтонов — БД
 * передаётся аргументом структурного типа.
 */

import { topUniverseRankFilter } from "../universe";

export type OverviewStrategyRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  version: number;
  enabled: boolean;
  status: string;
  timeframes: string[];
  minExchanges: number;
};

export type OverviewLastClosedRow = {
  t: Date | null;
};

type RankUniverseFilter = {
  rank: { gte: number; lte: number; not: null };
};

export type OverviewDb = {
  strategy: {
    findMany(args: {
      /**
       * orderBy — ИЗМЕНЯЕМЫЙ массив: реальный Prisma
       * StrategyFindManyArgs ждёт
       * StrategyOrderByWithRelationInput[], и readonly-
       * массив не присваиваем этому типу (TS2345 на VPS
       * с настоящим сгенерированным клиентом; stub
       * клиента в песочнице это не ловит).
       */
      orderBy: Array<
        { slug: "asc" } | { version: "desc" }
      >;
    }): Promise<unknown>;
  };

  asset: {
    count(args: {
      where: { enabled: true } & RankUniverseFilter;
    }): Promise<number>;
  };

  market: {
    count(args: {
      where: {
        enabled: true;
        status: "ACTIVE";
        quote: "USDT";
        marketType: "SPOT";
        asset?: RankUniverseFilter;
      };
    }): Promise<number>;
    findMany(args: {
      where: {
        enabled: true;
        status: "ACTIVE";
        quote: "USDT";
        marketType: "SPOT";
      };
      select: { exchange: true };
      distinct: ["exchange"];
    }): Promise<unknown>;
  };

  signal: {
    count(args: {
      where: { status: string };
    }): Promise<number>;
  };

  candle: {
    count(): Promise<number>;
  };

  $queryRaw(
    query: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<unknown>;
};

/** Порядок запросов = порядок позиций promises. */
export const OVERVIEW_QUERY_ORDER = [
  "strategies",
  "assetsTop100",
  "marketsTop100",
  "marketsActiveTotal",
  "candles",
  "signalsActive",
  "exchangesDistinct",
  "lastClosed1h"
] as const;

export type OverviewPromises = [
  Promise<OverviewStrategyRow[]>,
  Promise<number>,
  Promise<number>,
  Promise<number>,
  Promise<number>,
  Promise<number>,
  Promise<{ exchange: string }[]>,
  Promise<OverviewLastClosedRow[]>
];

export function buildOverviewQueries(db: OverviewDb): {
  names: typeof OVERVIEW_QUERY_ORDER;
  promises: OverviewPromises;
} {
  return {
    names: OVERVIEW_QUERY_ORDER,
    promises: [
      // 1 strategies: список стратегий (реальный)
      db.strategy.findMany({
        orderBy: [
          { slug: "asc" },
          { version: "desc" }
        ]
      }) as Promise<OverviewStrategyRow[]>,

      // 2 assetsTop100: активы основного universe
      db.asset.count({
        where: {
          enabled: true,
          ...topUniverseRankFilter()
        }
      }),

      // 3 marketsTop100: рынки активов universe
      db.market.count({
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT",
          asset: topUniverseRankFilter()
        }
      }),

      // 4 marketsActiveTotal: ВСЕ активные
      // SPOT USDT-рынки БД (без ограничения Top-100)
      db.market.count({
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        }
      }),

      // 5 candles
      db.candle.count(),

      // 6 signalsActive
      db.signal.count({
        where: { status: "ACTIVE" }
      }),

      // 7 exchangesDistinct: факт о ДАННЫХ в БД
      db.market.findMany({
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        },
        select: { exchange: true },
        distinct: ["exchange"]
      }) as Promise<{ exchange: string }[]>,

      // 8 lastClosed1h: последняя ЗАКРЫТАЯ 1h свеча
      db
        .$queryRaw`
        SELECT MAX(c."openTime") FILTER (
          WHERE c.closed = true
        ) AS t
        FROM "Candle" c
        WHERE c.timeframe = '1h'
      `
        .then(
          (rows) =>
            rows as OverviewLastClosedRow[]
        )
    ]
  };
}
