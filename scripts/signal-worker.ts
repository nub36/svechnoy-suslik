/**
 * Signal Worker — prod-vorker Signal Engine.
 *
 * REZHIMY:
 *   (po umolchaniyu)  DRY-RUN: polnyj cikl do chernovikov,
 *                     ZAPISI V BD NET.
 *   --apply            boevoj prohod: zapis signalov v PostgreSQL
 *                     (createMany + skipDuplicates: dubli
 *                     nevozmozhny i na urovne UNIQUE v BD).
 *
 * Konturnye garanti:
 * - berutsya tolko enabled=true + status=PUBLISHED strategii;
 * - config prohodit validateStrategyRuntime pered raschyotom;
 * - signaly tolko pri multibirzhevom podtverzhdenii
 *   (minExchanges iz Strategy);
 * - na odin signal: Strategy version + Market + timeframe +
 *   candleTime + direction (UNIQUE v BD);
 * - uchityvayutsya execution.closedCandleOnly
 *   i execution.cooldownCandles;
 * - bez ATR14 signal ne sozdaetsya (SL/TP ne vydumyvayutsya).
 *
 * Primery:
 *   npx tsx scripts/signal-worker.ts --top=10 --timeframe=1h
 *   npx tsx scripts/signal-worker.ts --top=10 --timeframe=1h --apply
 */

import type { PrismaClient } from "@prisma/client";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configToAnalysisParams,
  periodsAreStandard,
  validateStrategyRuntime,
  type TrendSuslikConfig
} from "../lib/strategies/config";
import { minCandlesForParams } from "../lib/analysis/analyze";
import type { CandleData } from "../lib/exchanges/types";
import {
  aggregateAssetGroup,
  evaluateSnapshot,
  type AssetAggregation,
  type MarketStrategyResult,
  type SnapshotInput
} from "../lib/strategies/runtime";
import {
  planSignals,
  signalKey,
  type SignalDraft
} from "../lib/signals/engine";

type Db = PrismaClient;

let db: Db | null = null;

/**
 * Prisma podklyuchaetsya LENIVO — tolko pri zapuske workera.
 */
async function getDb(): Promise<Db> {
  if (!db) {
    const mod = await import("@prisma/client");
    db = new mod.PrismaClient();
  }

  return db;
}

async function closeDb(): Promise<void> {
  if (db) {
    await db.$disconnect();
    db = null;
  }
}

const SCRIPT_DIR = dirname(
  fileURLToPath(import.meta.url)
);

/* ================================================================
 * Argumenty
 * ================================================================ */

type Args = {
  top: number;
  timeframe: string;
  strategy: string | null;
  apply: boolean;
};

function getArg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")[1];
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseArgs(): Args {
  const top = Number(getArg("top") ?? "10");
  const timeframe = getArg("timeframe") ?? "1h";
  const strategy = getArg("strategy") ?? null;

  return {
    top: Number.isInteger(top) && top > 0 ? top : 10,
    timeframe,
    strategy,
    apply: hasFlag("apply")
  };
}

function printHelp(): void {
  console.log(
    [
      "Signal Worker",
      "",
      "  --top=10           skolko aktivov Top-N obrabatyvat",
      "  --timeframe=1h     tajmfrejm (5m, 15m, 1h, 4h, 1d)",
      "  --strategy=slug    tolko odna strategiya (po umolchaniyu vse)",
      "  --apply            BOEVOJ rezhim: zapis signalov v BD",
      "                     (bez etogo flaga — DRY-RUN, zapisi net)",
      "",
      "Po umolchaniyu: --top=10 --timeframe=1h, DRY-RUN."
    ].join("\n")
  );
}

/* ================================================================
 * Zagruzka dannyh iz BD
 * ================================================================ */

type MarketBatch = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  input: SnapshotInput | null;

  /**
   * Istoriya zakrytyh svech dlya nestandartnyh periodov
   * config (raschyot po PostgreSQL, bez obrashcheniya
   * k birzham). Dlya standartnyh periodov — pustoj spisok.
   */
  candles: CandleData[];
};

type AssetBatch = {
  strategyId: number;
  strategyVersion: number;
  strategySlug: string;
  symbol: string;
  markets: MarketBatch[];
};

async function loadBatches(
  database: Db,
  strategyId: number,
  strategyVersion: number,
  strategySlug: string,
  config: TrendSuslikConfig,
  top: number,
  timeframe: string
): Promise<AssetBatch[]> {
  const assets = await database.asset.findMany({
    where: {
      enabled: true,
      rank: { lte: top, not: null }
    },
    orderBy: { rank: "asc" },
    take: top,
    include: {
      markets: {
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        },
        orderBy: { exchange: "asc" }
      }
    }
  });

  const batches: AssetBatch[] = [];

  for (const asset of assets) {
    if (
      config.filters.top500Only &&
      !asset.top500
    ) {
      continue;
    }

    const markets: MarketBatch[] = [];

    for (const market of asset.markets) {
      const snap =
        await database.indicatorSnapshot.findFirst({
          where: {
            marketId: market.id,
            timeframe
          },
          orderBy: { candleTime: "desc" }
        });

      let history: CandleData[] = [];

      if (snap && !periodsAreStandard(config)) {
        // Nestandartnye periody: indikatory schitaem
        // po zakrytym svecham PostgreSQL tochno na
        // candleTime snapshot. Tolko chtenie.
        const rows = await database.candle.findMany({
          where: {
            marketId: market.id,
            timeframe,
            closed: true,
            openTime: {
              lte: snap.candleTime
            }
          },
          orderBy: {
            openTime: "desc"
          },
          take:
            minCandlesForParams(
              configToAnalysisParams(config)
            ) + 50
        });

        history = rows.map(
          (
            row: {
              openTime: Date;
              closeTime: Date | null;
              open: number;
              high: number;
              low: number;
              close: number;
              volume: number;
              closed: boolean;
            }
          ) => ({
            openTime: row.openTime,
            closeTime: row.closeTime ?? undefined,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            closed: row.closed
          })
        );
      }

      markets.push({
        marketId: market.id,
        exchange: market.exchange,
        exchangeSymbol: market.exchangeSymbol,
        candles: history,
        input: snap
          ? {
              marketId: market.id,
              exchange: market.exchange,
              exchangeSymbol:
                market.exchangeSymbol,
              assetSymbol: asset.symbol,
              assetTop500: asset.top500,
              quoteVolume24h:
                market.quoteVolume24h,
              timeframe,
              candleTime: snap.candleTime,
              price: snap.price,
              rsi14: snap.rsi14,
              ema20: snap.ema20,
              ema50: snap.ema50,
              ema200: snap.ema200,
              macd: snap.macd,
              macdSignal: snap.macdSignal,
              macdHist: snap.macdHist,
              atr14: snap.atr14,
              volume: snap.volume,
              avgVolume20: snap.avgVolume20,
              volumeRatio: snap.volumeRatio
            }
          : null
      });
    }

    batches.push({
      strategyId,
      strategyVersion,
      strategySlug,
      symbol: asset.symbol,
      markets
    });
  }

  return batches;
}

async function loadCooldownMap(
  database: Db,
  strategyId: number,
  strategyVersion: number,
  timeframe: string,
  direction: string
): Promise<Map<number, Date>> {
  const rows = await database.signal.groupBy({
    by: ["marketId"],
    where: {
      strategyId,
      strategyVersion,
      timeframe,
      direction
    },
    _max: { candleTime: true }
  });

  const map = new Map<number, Date>();

  for (const row of rows) {
    if (row._max.candleTime) {
      map.set(
        row.marketId,
        row._max.candleTime
      );
    }
  }

  return map;
}

async function loadExistingKeys(
  database: Db,
  strategyId: number,
  strategyVersion: number,
  timeframe: string,
  direction: string,
  marketIds: number[],
  candleTimes: Date[]
): Promise<Set<string>> {
  if (
    marketIds.length === 0 ||
    candleTimes.length === 0
  ) {
    return new Set();
  }

  const uniqueTimes = [
    ...new Set(
      candleTimes.map((t) => t.toISOString())
    )
  ].map((iso) => new Date(iso));

  const rows = await database.signal.findMany({
    where: {
      strategyId,
      strategyVersion,
      timeframe,
      direction,
      marketId: { in: marketIds },
      candleTime: { in: uniqueTimes }
    },
    select: {
      marketId: true,
      candleTime: true,
      direction: true
    }
  });

  return new Set(
    rows.map(
      (r: {
        marketId: number;
        candleTime: Date;
        direction: string;
      }) =>
        signalKey(
          r.marketId,
          r.candleTime,
          r.direction
        )
    )
  );
}

/* ================================================================
 * ZAPIS: edinstvennoe mesto createMany v etom faile.
 * Vyzvaetsya tolko v boevom rezhime (--apply).
 * ================================================================ */

async function writeSignals(
  database: Db,
  drafts: SignalDraft[]
): Promise<number> {
  if (drafts.length === 0) {
    return 0;
  }

  const result = await database.signal.createMany({
    data: drafts.map((d) => ({
      strategyId: d.strategyId,
      strategyVersion: d.strategyVersion,
      symbol: d.symbol,
      marketId: d.marketId,
      exchange: d.exchange,
      exchangeSymbol: d.exchangeSymbol,
      timeframe: d.timeframe,
      direction: d.direction,
      score: d.score,
      entry: d.entry,
      stopLoss: d.stopLoss,
      takeProfit1: d.takeProfit1,
      takeProfit2: d.takeProfit2,
      takeProfit3: d.takeProfit3,
      atr14: d.atr14,
      status: "ACTIVE",
      reason: d.reason,
      reasonsJson: d.reasons,
      warningsJson: d.warnings,
      indicatorsJson: d.indicators,
      candleTime: d.candleTime
    })),
    skipDuplicates: true
  });

  return result.count;
}

/* ================================================================
 * Glavnyj cikl
 * ================================================================ */

async function main(): Promise<void> {
  if (hasFlag("help")) {
    printHelp();
    return;
  }

  const args = parseArgs();
  const apply = args.apply;

  console.log(
    apply
      ? "REZHIM: BOEVOJ (--apply) — signaly budut zapisany v PostgreSQL"
      : "REZHIM: DRY-RUN — raschyot i vyvod, ZAPISI V BD NET"
  );

  console.log(
    `Parametry: Top-${args.top} × ${args.timeframe}` +
      (args.strategy
        ? ` × strategiya ${args.strategy}`
        : " × vse aktivnye strategii")
  );

  const database = await getDb();

  const strategies = await database.strategy.findMany({
    where: {
      enabled: true,
      status: "PUBLISHED",
      ...(args.strategy
        ? { slug: args.strategy }
        : {})
    },
    orderBy: [{ slug: "asc" }, { version: "desc" }]
  });

  if (strategies.length === 0) {
    console.log(
      "Aktivnyh opublikovannyh strategij net — rabotat nechego."
    );
    return;
  }

  let totalPlanned = 0;
  let totalSkipped = 0;
  let totalCreated = 0;
  const allDrafts: SignalDraft[] = [];

  for (const strategy of strategies) {
    const validation = validateStrategyRuntime({
      config: strategy.config,
      timeframes: strategy.timeframes,
      minExchanges: strategy.minExchanges
    });

    if (!validation.ok) {
      console.log(
        `\n⚠ ${strategy.slug} v${strategy.version}: ` +
          `config ne proshel validaciyu, propuschen:\n  ` +
          validation.errors.join("\n  ")
      );
      continue;
    }

    const { config, minExchanges } =
      validation;

    if (
      !validation.timeframes.includes(
        args.timeframe
      )
    ) {
      console.log(
        `\n⚠ ${strategy.slug} v${strategy.version}: ` +
          `tajmfrejm ${args.timeframe} ne vhodit v ` +
          `[${validation.timeframes.join(", ")}] ` +
          `— strategiya propushena`
      );
      continue;
    }

    console.log(
      `\n=== ${strategy.slug} v${strategy.version} ` +
        `(${args.timeframe}, minExchanges=${minExchanges}) ===`
    );

    const batches = await loadBatches(
      database,
      strategy.id,
      strategy.version,
      strategy.slug,
      config,
      args.top,
      args.timeframe
    );

    for (const batch of batches) {
      const evaluatedMarkets: MarketStrategyResult[] =
        batch.markets.map((m) => {
          if (!m.input) {
            return {
              status: "no-snapshot",
              exchange: m.exchange,
              market: m.exchangeSymbol,
              marketId: m.marketId,
              reason: "net IndicatorSnapshot"
            } as const;
          }

          return evaluateSnapshot(
            m.input,
            config,
            m.candles
          );
        });

      const aggregation = aggregateAssetGroup(
        batch.symbol,
        args.timeframe,
        batch.strategySlug,
        batch.strategyVersion,
        evaluatedMarkets,
        minExchanges
      );

      if (aggregation.evaluated === 0) {
        continue;
      }

      console.log(
        `\n${batch.symbol}: ${aggregation.direction} ` +
          `[${aggregation.confirmation}] ` +
          `${aggregation.explanation}`
      );

      const snapshotByMarketId = new Map(
        batch.markets
          .filter((m) => m.input !== null)
          .map(
            (m) => [m.marketId, m.input!]
          )
      );

      const evaluated = evaluatedMarkets.filter(
        (m) => m.status === "evaluated"
      );

      const isConfirmed =
        aggregation.direction === "LONG" ||
        aggregation.direction === "SHORT";

      const cooldownMap = isConfirmed
        ? await loadCooldownMap(
            database,
            strategy.id,
            strategy.version,
            args.timeframe,
            aggregation.direction
          )
        : new Map<number, Date>();

      const existingKeys = isConfirmed
        ? await loadExistingKeys(
            database,
            strategy.id,
            strategy.version,
            args.timeframe,
            aggregation.direction,
            evaluated.map((m) => m.marketId),
            evaluated.map((m) => m.candleTime)
          )
        : new Set<string>();

      const plan = planSignals({
        aggregation,
        config,
        strategyId: strategy.id,
        strategySlug: strategy.slug,
        symbol: batch.symbol,
        now: new Date(),
        snapshotByMarketId,
        lastSignalCandleTimeByMarketId:
          cooldownMap,
        existingKeys
      });

      totalPlanned += plan.planned.length;
      totalSkipped += plan.skipped.length;
      allDrafts.push(...plan.planned);

      for (const d of plan.planned) {
        console.log(
          `  → ${d.direction} ${d.exchange} ` +
            `${d.exchangeSymbol} score ${d.score} ` +
            `entry ${d.entry} SL ${d.stopLoss ?? "—"} ` +
            `TP ${d.takeProfit1 ?? "—"}/` +
            `${d.takeProfit2 ?? "—"}/` +
            `${d.takeProfit3 ?? "—"} ` +
            `candle ${d.candleTime.toISOString()}`
        );
      }

      for (const s of plan.skipped) {
        console.log(
          `  × ${s.exchange} ${s.market}: ${s.reason}`
        );
      }
    }
  }

  console.log(
    `\n=== Itog: chernovikov ${totalPlanned}, ` +
      `propushcheno ${totalSkipped} ===`
  );

  if (apply) {
    const created = await writeSignals(
      database,
      allDrafts
    );

    totalCreated += created;

    console.log(
      `Zapisano signalov: ${created}` +
        ` (skipDuplicates vkluchyon — dublej net)`
    );
  } else {
    console.log(
      `DRY-RUN: zapis ne vypolnena. ` +
        `Dlya boevogo prohoda dobavte --apply.`
    );
  }
}

main()
  .catch((err) => {
    console.error("Oshibka workera:", err);
    process.exitCode = 1;
  })
  .finally(() => closeDb());
