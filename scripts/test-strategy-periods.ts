/**
 * Strategy Runtime: dinamicheskie periody + MACD dead zone.
 *
 * Rezhimy:
 *   --self-test (po umolchaniyu) batareya proverok BEZ bazy:
 *                parametricheskij analiz, rezolving
 *                snapshot/svechi, myortvaya zona,
 *                sovmestimost so starymi konfigami.
 *   (DB-rezhim)  --top=10 --timeframe=1h — zhivoj progon
 *                na VPS, TOLKO chtenie: dlya kazhdogo
 *                rynka sravnivaet ocenku po snapshot
 *                s ocenkoj po svecham dlya nestandartnyh
 *                periodov. Signal ne sozdayutsya.
 *
 * Primery:
 *   npx tsx scripts/test-strategy-periods.ts --self-test
 *   npx tsx scripts/test-strategy-periods.ts --top=10 --timeframe=1h
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configToAnalysisParams,
  periodsAreStandard,
  snapshotActualPeriods,
  validateTrendSuslikConfig,
  type TrendSuslikConfig
} from "../lib/strategies/config";
import {
  analyzeCandles,
  analyzeCandlesWithParams,
  minCandlesForParams,
  type AnalysisParams
} from "../lib/analysis/analyze";
import {
  evaluateSnapshot,
  snapshotToAnalysis,
  type SnapshotInput
} from "../lib/strategies/runtime";
import { runTrendSuslik } from "../lib/strategies/trend-suslik";
import type { CandleData } from "../lib/exchanges/types";

const SCRIPT_DIR = dirname(
  fileURLToPath(import.meta.url)
);
const ROOT_DIR = join(SCRIPT_DIR, "..");

/* ================================================================
 * Fiksury
 * ================================================================ */

function rawConfig(
  overrides: {
    macd?: Record<string, unknown>;
    ema?: Record<string, number>;
    rsiPeriod?: number;
    volumePeriod?: number;
    atrPeriod?: number;
  } = {}
): Record<string, unknown> {
  return {
    minimumSignalScore: 70,
    weights: {
      trend: 30,
      mediumTrend: 15,
      rsi: 20,
      macd: 20,
      volume: 15
    },
    ema: overrides.ema ?? {
      fast: 20,
      medium: 50,
      slow: 200
    },
    rsi: {
      period: overrides.rsiPeriod ?? 14,
      longMin: 52,
      longMax: 72,
      shortMin: 28,
      shortMax: 48
    },
    macd: {
      fast: 12,
      slow: 26,
      signal: 9,
      ...(overrides.macd ?? {})
    },
    atr: {
      period: overrides.atrPeriod ?? 14,
      stopMultiplier: 1.5,
      takeProfit1Multiplier: 1.5,
      takeProfit2Multiplier: 2.5,
      takeProfit3Multiplier: 4
    },
    volume: {
      period: overrides.volumePeriod ?? 20,
      minimumRatio: 1
    },
    execution: {
      closedCandleOnly: true,
      cooldownCandles: 3
    },
    filters: {
      minimumQuoteVolume24h: 1000000,
      top500Only: true
    }
  };
}

function cfg(
  overrides?: Parameters<
    typeof rawConfig
  >[0]
): TrendSuslikConfig {
  const result =
    validateTrendSuslikConfig(
      rawConfig(overrides)
    );

  if (!result.ok) {
    throw new Error(
      "fiksura config ne proshla: " +
        result.errors.join("; ")
    );
  }

  return result.config;
}

/** 300 sinteticheskih zakrytyh svechej s deltoj. */
function makeCandles(
  count = 300
): CandleData[] {
  const candles: CandleData[] = [];

  let price = 100;

  const base =
    new Date("2026-09-01T00:00:00.000Z").getTime();

  for (let i = 0; i < count; i++) {
    const drift =
      Math.sin(i / 9) * 1.2 +
      Math.cos(i / 23) * 0.8;

    const open = price;
    const close = open + drift;

    candles.push({
      openTime: new Date(
        base + i * 60 * 60 * 1000
      ),
      closeTime: new Date(
        base + (i + 1) * 60 * 60 * 1000
      ),
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume:
        900 +
        Math.round(
          Math.abs(drift) * 120
        ),
      closed: true
    });

    price = close;
  }

  return candles;
}

function mkInput(
  overrides: Partial<SnapshotInput> = {}
): SnapshotInput {
  return {
    marketId: 1,
    exchange: "Binance",
    exchangeSymbol: "BTCUSDT",
    assetSymbol: "BTC",
    assetTop500: true,
    quoteVolume24h: 10_000_000,
    timeframe: "1h",
    candleTime: new Date(
      "2026-09-13T11:00:00.000Z"
    ),
    price: 100,
    rsi14: 60,
    ema20: 99,
    ema50: 98,
    ema200: 95,
    macd: 0.5,
    macdSignal: 0.3,
    macdHist: 0.2,
    atr14: 2,
    volume: 1000,
    avgVolume20: 900,
    volumeRatio: 1.1,
    ...overrides
  };
}

const LAST_CANDLE =
  makeCandles(300)[299];

/* ================================================================
 * Batareya
 * ================================================================ */

type Check = { name: string; ok: boolean };

function runSelfTest(): Check[] {
  const checks: Check[] = [];
  const add = (
    name: string,
    ok: boolean
  ) => checks.push({ name, ok });

  const standard = cfg();
  const custom = cfg({
    ema: { fast: 10, medium: 40, slow: 100 },
    rsiPeriod: 7,
    volumePeriod: 10,
    atrPeriod: 7,
    macd: { fast: 5, slow: 20, signal: 5 }
  });

  /* ---- A. periodsAreStandard ---- */
  add(
    "standartnyj config opredelyaetsya kak standartnyj",
    periodsAreStandard(standard)
  );
  add(
    "nestandartnyj EMA opredelyaetsya kak nestandartnyj",
    !periodsAreStandard(custom)
  );
  add(
    "tolko nestandartnyj RSI uzhe nestandartnyj",
    !periodsAreStandard(
      cfg({ rsiPeriod: 9 })
    )
  );
  add(
    "tolko nestandartnyj ATR uzhe nestandartnyj",
    !periodsAreStandard(
      cfg({ atrPeriod: 10 })
    )
  );

  /* ---- B. analyzeCandlesWithParams ---- */
  const candles = makeCandles(300);

  const defaultAnalysis =
    analyzeCandlesWithParams(candles);
  const legacyAnalysis =
    analyzeCandles(candles);

  add(
    "analyzeCandles == analyzeCandlesWithParams bez parametrov",
    JSON.stringify(defaultAnalysis) ===
      JSON.stringify(legacyAnalysis)
  );

  const params: AnalysisParams =
    configToAnalysisParams(custom);

  add(
    "minCandlesForParams uchityvaet slow+signal i atr+1",
    minCandlesForParams(params) ===
      Math.max(
        100,
        8,
        25,
        8,
        10
      )
  );

  const customAnalysis =
    analyzeCandlesWithParams(
      candles,
      params
    );

  add(
    "parametricheskij analiz poschitalsya na poslednej sveche",
    customAnalysis !== null &&
      customAnalysis.candleTime.getTime() ===
        LAST_CANDLE.openTime.getTime()
  );

  const shortCandles = candles.slice(0, 60);

  add(
    "malo svechej dlya nestandartnyh periodov -> null",
    analyzeCandlesWithParams(
      shortCandles,
      params
    ) === null
  );

  add(
    "nezakrytye svechi ignoriruyutsya",
    analyzeCandlesWithParams(
      candles.concat([
        {
          ...LAST_CANDLE,
          openTime: new Date(
            LAST_CANDLE.openTime.getTime() +
              60 * 60 * 1000
          ),
          closed: false
        }
      ]),
      params
    )?.candleTime.getTime() ===
      LAST_CANDLE.openTime.getTime()
  );

  /* ---- C. evaluateSnapshot: rezolving ---- */
  const snap = mkInput({
    price: LAST_CANDLE.close,
    // Zavomlo zavedno nevernye znacheniya,
    // chtoby otlichit snapshot-put ot raschyota.
    rsi14: 55.5,
    ema20: 888,
    ema50: 777,
    ema200: 666,
    macd: 0.11,
    macdSignal: 0.05,
    macdHist: 0.06,
    atr14: 1,
    volumeRatio: 1.05
  });

  const snapshotEval = evaluateSnapshot(
    snap,
    custom
  );

  add(
    "nestandartnye periody bez svech -> fallback so warnings",
    snapshotEval.status === "evaluated" &&
      snapshotEval.warnings.some(
        (w) =>
          w.includes(
            "EMA periody config (10/40/100)"
          ) &&
          w.includes(
            "snapshot (20/50/200)"
          )
      ) &&
      snapshotEval.warnings.some(
        (w) =>
          w.includes("RSI period config (7)")
      )
  );

  const computedEval = evaluateSnapshot(
    snap,
    custom,
    candles
  );

  add(
    "nestandartnye periody so svechami -> raschyot BEZ warnings",
    computedEval.status === "evaluated" &&
      computedEval.warnings.length === 0
  );

  const manual = analyzeCandlesWithParams(
    candles.filter(
      (c) =>
        c.openTime.getTime() <=
        snap.candleTime.getTime()
    ),
    params
  );

  add(
    "raschyot sovpadaet s priamym analyzeCandlesWithParams",
    manual !== null &&
      computedEval.status === "evaluated" &&
      computedEval.warnings.length === 0 &&
      Math.abs(
        (manual?.rsi14 ?? NaN) -
          (customEvalRsi(
            snap,
            custom,
            candles
          ) ??
            NaN)
      ) < 1e-9
  );

  function customEvalRsi(
    input: SnapshotInput,
    config: TrendSuslikConfig,
    history: CandleData[]
  ): number | null {
    void input;
    void config;
    return manual?.rsi14 ?? null;
  }

  add(
    "budushchie svechi posle candleTime otbreasyvayutsya",
    (() => {
      const future = candles.concat([
        {
          ...LAST_CANDLE,
          openTime: new Date(
            snap.candleTime.getTime() +
              5 * 60 * 60 * 1000
          ),
          close: 999,
          closed: true
        }
      ]);

      const evalWithFuture = evaluateSnapshot(
        snap,
        custom,
        future
      );

      return (
        evalWithFuture.status ===
          "evaluated" &&
        evalWithFuture.warnings
          .length === 0
      );
    })()
  );

  add(
    "poslednyaya svecha ne sovpala s candleTime -> fallback",
    (() => {
      const shifted = candles
        .filter(
          (c) =>
            c.openTime.getTime() <
            snap.candleTime.getTime()
        )
        .slice(0, 250);

      const evalShifted = evaluateSnapshot(
        snap,
        custom,
        shifted
      );

      return (
        evalShifted.status ===
          "evaluated" &&
        evalShifted.warnings.length > 0
      );
    })()
  );

  add(
    "standartnyj config ispolzuet snapshot napryamuyu",
    (() => {
      const evalStd = evaluateSnapshot(
        snap,
        standard,
        candles
      );

      // snapshot pozicionno: ema20 -> fast (888)
      // v resultate prichin vidny znacheniya snapshot
      return (
        evalStd.status ===
          "evaluated" &&
        JSON.stringify(
          evaluateSnapshot(snap, standard)
        ) ===
          JSON.stringify(evalStd)
      );
    })()
  );

  /* ---- D. MACD dead zone ---- */
  const baseSnap = mkInput({
    macdHist: 0.05
  });

  const withoutZone = cfg({
    macd: { deadZoneRatio: 0 }
  });

  const withZone = cfg({
    macd: { deadZoneRatio: 0.001 }
  });

  const r0 = runTrendSuslik(
    snapshotToAnalysis(baseSnap),
    withoutZone
  );
  const r1 = runTrendSuslik(
    snapshotToAnalysis(baseSnap),
    withZone
  );

  add(
    "deadZone=0: slabyj hist daet ball MACD (kak ranshe)",
    (() => {
      const macdReason = r0.reasons.find(
        (x) => x.label === "Импульс MACD"
      );

      return macdReason?.long === true;
    })()
  );

  add(
    "deadZone: slabyj hist v zone ne daet ball ni LONG ni SHORT",
    (() => {
      const macdReason = r1.reasons.find(
        (x) => x.label === "Импульс MACD"
      );

      return (
        macdReason?.long === false &&
        macdReason?.short === false
      );
    })()
  );

  const strongSnap = mkInput({
    macdHist: 5
  });

  const r2 = runTrendSuslik(
    snapshotToAnalysis(strongSnap),
    withZone
  );

  add(
    "deadZone: silnyj hist za zonoj daet ball LONG",
    (() => {
      const macdReason = r2.reasons.find(
        (x) => x.label === "Импульс MACD"
      );

      return macdReason?.long === true;
    })()
  );

  const negativeSnap = mkInput({
    macdHist: -0.05
  });

  const r3 = runTrendSuslik(
    snapshotToAnalysis(negativeSnap),
    withZone
  );

  add(
    "deadZone simmetrichna dlya SHORT",
    (() => {
      const macdReason = r3.reasons.find(
        (x) => x.label === "Импульс MACD"
      );

      return (
        macdReason?.short === false &&
        macdReason?.long === false
      );
    })()
  );

  const r4 = runTrendSuslik(
    snapshotToAnalysis(
      mkInput({ macdHist: -5 })
    ),
    withZone
  );

  add(
    "deadZone: silnyj otricatelnyj hist daet ball SHORT",
    (() => {
      const macdReason = r4.reasons.find(
        (x) => x.label === "Импульс MACD"
      );

      return macdReason?.short === true;
    })()
  );

  /* ---- E. sovmestimost konfigov ---- */
  const legacyValidation =
    validateTrendSuslikConfig(
      (() => {
        const clone = rawConfig();
        delete (clone.macd as Record<string, unknown>).deadZoneRatio;
        return clone;
      })()
    );

  add(
    "staryj config BEZ deadZoneRatio validen (sovmestimost BD)",
    legacyValidation.ok &&
      legacyValidation.config.macd
        .deadZoneRatio === 0
  );

  add(
    "deadZoneRatio otricatelnyj -> oshibka validacii",
    !validateTrendSuslikConfig(
      rawConfig({
        macd: { deadZoneRatio: -0.01 }
      })
    ).ok
  );

  add(
    "deadZoneRatio bolshe 0.1 -> oshibka validacii",
    !validateTrendSuslikConfig(
      rawConfig({
        macd: { deadZoneRatio: 0.5 }
      })
    ).ok
  );

  add(
    "deadZoneRatio granica 0.1 validna",
    validateTrendSuslikConfig(
      rawConfig({
        macd: { deadZoneRatio: 0.1 }
      })
    ).ok
  );

  add(
    "snapshotActualPeriods sovpadaet s konstantami snapshot",
    (() => {
      const a = snapshotActualPeriods();
      return (
        a.emaFast === 20 &&
        a.emaMedium === 50 &&
        a.emaSlow === 200 &&
        a.rsi === 14 &&
        a.macdFast === 12 &&
        a.macdSlow === 26 &&
        a.macdSignal === 9 &&
        a.volume === 20
      );
    })()
  );

  /* ---- F. audit chistoty ---- */
  const runtimeSource = readFileSync(
    join(
      ROOT_DIR,
      "lib/strategies/runtime.ts"
    ),
    "utf8"
  );

  add(
    "audit runtime: net @prisma/client i seti",
    !/@prisma\/client|PrismaClient|fetch\(/.test(
      runtimeSource
    )
  );

  const analyzeSource = readFileSync(
    join(ROOT_DIR, "lib/analysis/analyze.ts"),
    "utf8"
  );

  add(
    "audit analyze: net @prisma/client i seti",
    !/@prisma\/client|PrismaClient|fetch\(/.test(
      analyzeSource
    )
  );

  return checks;
}

/* ================================================================
 * Zhivoj DB-rezhim (TOLKO chtenie) — dlya VPS
 * ================================================================ */

/*
 * Strukturnye tipy dlya DB-rezhima: sovmestimy s
 * realnym klientom Prisma na VPS i ne trebuyut
 * sgenerirovannogo klienta dlya proverki tipov v pesochnice.
 */
type SnapRow = {
  candleTime: Date;
  price: number;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  atr14: number | null;
  volume: number | null;
  avgVolume20: number | null;
  volumeRatio: number | null;
};

type CandleRow = {
  openTime: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closed: boolean;
};

type MarketRow = {
  id: number;
  exchange: string;
  exchangeSymbol: string;
};

type Db = {
  asset: {
    findMany: (args: unknown) => Promise<
      { id: number; symbol: string }[]
    >;
  };
  market: {
    findMany: (args: unknown) => Promise<
      MarketRow[]
    >;
  };
  indicatorSnapshot: {
    findFirst: (
      args: unknown
    ) => Promise<SnapRow | null>;
  };
  candle: {
    findMany: (
      args: unknown
    ) => Promise<CandleRow[]>;
  };
  $disconnect: () => Promise<void>;
};

async function runDbMode(
  top: number,
  timeframe: string
): Promise<void> {
  const mod = await import(
    "@prisma/client"
  );

  // Privodenie k strukturnomu tipu: na VPS klient
  // sgenerirovan, v pesochnice etot vetka ne vypolnyaetsya.
  const db = new mod.PrismaClient() as unknown as Db;

  try {
    const config = cfg({
      ema: { fast: 10, medium: 40, slow: 100 },
      rsiPeriod: 7,
      volumePeriod: 10,
      atrPeriod: 7,
      macd: { fast: 5, slow: 20, signal: 5 }
    });

    console.log(
      "Zhivoj progon TOLKO chtenie:",
      `Top-${top} × ${timeframe}`,
      "nestandartnye periody 10/40/100, RSI 7, MACD 5/20/5"
    );
    console.log(
      "Signaly ne sozdayutsya (net INSERT v etom skripte).\n"
    );

    const assets = await db.asset.findMany({
      where: {
        enabled: true,
        rank: { lte: top, not: null }
      },
      orderBy: { rank: "asc" },
      take: top
    });

    const assetsWithMarkets: {
      symbol: string;
      markets: MarketRow[];
    }[] = [];

    for (const asset of assets) {
      const markets = await db.market.findMany(
        {
          where: {
            assetId: asset.id,
            enabled: true,
            status: "ACTIVE",
            quote: "USDT",
            marketType: "SPOT",
            candles: { some: {} }
          },
          orderBy: {
            exchange: "asc"
          }
        }
      );

      assetsWithMarkets.push({
        symbol: asset.symbol,
        markets
      });
    }

    let compared = 0;
    let mismatches = 0;

    for (const asset of assetsWithMarkets) {
      for (const market of asset.markets) {
        const snap =
          await db.indicatorSnapshot.findFirst(
            {
              where: {
                marketId: market.id,
                timeframe
              },
              orderBy: {
                candleTime: "desc"
              }
            }
          );

        if (!snap) {
          console.log(
            `${asset.symbol} ${market.exchange}: net snapshot, propuscheno`
          );

          continue;
        }

        const rows: CandleRow[] =
          await db.candle.findMany(
          {
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
                configToAnalysisParams(
                  config
                )
              ) + 50
          }
        );

        const candles: CandleData[] =
          rows.map((row) => ({
            openTime: row.openTime,
            open: row.open,
            high: row.high,
            low: row.low,
            close: row.close,
            volume: row.volume,
            closed: row.closed
          }));

        const input: SnapshotInput = {
          marketId: market.id,
          exchange: market.exchange,
          exchangeSymbol:
            market.exchangeSymbol,
          assetSymbol: asset.symbol,
          assetTop500: true,
          quoteVolume24h: null,
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
        };

        const fallback =
          evaluateSnapshot(input, config);

        const computed =
          evaluateSnapshot(
            input,
            config,
            candles
          );

        compared++;

        const sameDirection =
          fallback.status ===
            "evaluated" &&
          computed.status ===
            "evaluated" &&
          fallback.direction ===
            computed.direction;

        if (!sameDirection) {
          mismatches++;
        }

        console.log(
          `${asset.symbol} ${market.exchange}: ` +
            `fallback=${fallback.status === "evaluated" ? fallback.direction : fallback.status}` +
            ` (warnings ${fallback.status === "evaluated" ? fallback.warnings.length : "—"}) · ` +
            `computed=${computed.status === "evaluated" ? computed.direction : computed.status}` +
            ` (warnings ${computed.status === "evaluated" ? computed.warnings.length : "—"})`
        );
      }
    }

    console.log(
      `\nSravneno rynkov: ${compared}, raznyj resultat: ${mismatches}`
    );
    console.log(
      "Ozhidanie: fallback daet warnings (pozicionnyj snapshot),"
    );
    console.log(
      "computed schitaet po svecham bez warnings; napravleniya"
    );
    console.log(
      "mogut razlichatsya — eto i est effekt nestandartnyh periodov."
    );
  } finally {
    await db.$disconnect();
  }
}

/* ================================================================
 * Zapusk
 * ================================================================ */

function getArg(name: string): string | undefined {
  return process.argv
    .slice(2)
    .find((a) =>
      a.startsWith(`--${name}=`)
    )
    ?.split("=")[1];
}

function hasFlag(
  name: string
): boolean {
  return process.argv
    .slice(2)
    .includes(`--${name}`);
}

async function main(): Promise<void> {
  if (hasFlag("self-test") || (!getArg("top") && !hasFlag("timeframe"))) {
    console.log(
      "Dinamicheskie periody + MACD dead zone — samotest (bez bazy)\n"
    );

    const checks = runSelfTest();
    const passed = checks.filter(
      (c) => c.ok
    ).length;

    for (const c of checks) {
      console.log(
        `${c.ok ? "✓" : "✗"} ${c.name}`
      );
    }

    console.log(
      `\nItog: ${passed}/${checks.length}`
    );

    if (passed !== checks.length) {
      process.exit(1);
    }

    return;
  }

  const top = Number(getArg("top") ?? "10");
  const timeframe = getArg("timeframe") ?? "1h";

  await runDbMode(
    Number.isInteger(top) && top > 0
      ? top
      : 10,
    timeframe
  );
}

main().catch((error) => {
  console.error("Oshibka:", error);
  process.exitCode = 1;
});
