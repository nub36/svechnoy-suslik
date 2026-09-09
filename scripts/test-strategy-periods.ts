/**
 * Strategy Runtime: dinamicheskie periody + MACD dead zone.
 *
 * Rezhimy:
 *   --self-test (po umolchaniyu) batareya proverok BEZ bazy:
 *                parametricheskij analiz, rezolving
 *                snapshot/svechi, myortvaya zona,
 *                sovmestimost so starymi konfigami.
 *   (DB-rezhim)  --top=10 --timeframe=1h — zhivoj progon
 *                na VPS, TOLKO chtenie: nestandartnye
 *                periody schitayutsya strogo po zakrytym
 *                svecham PostgreSQL; rynok bez dostatochnoj
 *                istorii ottalkivaetsya kak cannot-evaluate
 *                (fallback na fiksirovannyj snapshot
 *                zapreshchyon). Signal ne sozdayutsya.
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
  type AnalysisParams,
  type MarketAnalysis
} from "../lib/analysis/analyze";
import {
  evaluateSnapshot,
  priceMatches,
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
    assetRank: 42,
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

  /* ---- C. evaluateSnapshot: bez fallbacka na snapshot ---- */
  const snap = mkInput({
    price: LAST_CANDLE.close,
    // Zavedno nevernye dlya raschyota znacheniya:
    // esli by snapshot uchastvoval, rezultat byl by inym.
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
    "nestandartnye periody bez svech -> cannot-evaluate",
    snapshotEval.status === "cannot-evaluate" &&
      snapshotEval.reason.includes("ne peredana")
  );

  add(
    "cannot-evaluate ne daet napravleniya i ballov",
    snapshotEval.status !== "evaluated"
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

  // Rezultat dolzhen sovpadat s priamoj svyazkoj
  // analyzeCandlesWithParams + runTrendSuslik
  const manual = analyzeCandlesWithParams(
    candles.filter(
      (c) =>
        c.openTime.getTime() <=
        snap.candleTime.getTime()
    ),
    params
  );

  const manualResult =
    manual === null
      ? null
      : runTrendSuslik(manual, custom, {
          emaFast: custom.ema.fast,
          emaMedium: custom.ema.medium,
          emaSlow: custom.ema.slow,
          rsi: custom.rsi.period,
          macdFast: custom.macd.fast,
          macdSlow: custom.macd.slow,
          macdSignal: custom.macd.signal,
          volume: custom.volume.period
        });

  add(
    "rezultat sovpadaet s analyzeCandlesWithParams + runTrendSuslik",
    manual !== null &&
      manualResult !== null &&
      computedEval.status === "evaluated" &&
      computedEval.longScore ===
        manualResult.longScore &&
      computedEval.shortScore ===
        manualResult.shortScore &&
      computedEval.direction ===
        manualResult.direction
  );

  add(
    "svechi posle candleTime nikogda ne uchastvuyut (identichnyj rezultat)",
    (() => {
      const future = candles.concat([
        {
          ...LAST_CANDLE,
          openTime: new Date(
            snap.candleTime.getTime() +
              5 * 60 * 60 * 1000
          ),
          close: 999,
          high: 1000,
          low: 998,
          open: 999,
          volume: 99999,
          closed: true
        }
      ]);

      const evalWithFuture =
        evaluateSnapshot(snap, custom, future);
      const evalWithout =
        evaluateSnapshot(snap, custom, candles);

      return (
        evalWithFuture.status === "evaluated" &&
        JSON.stringify(evalWithFuture) ===
          JSON.stringify(evalWithout)
      );
    })()
  );

  add(
    "tolko svechi posle candleTime -> istorii net (est 0)",
    (() => {
      const onlyFuture: CandleData[] = [
        {
          ...LAST_CANDLE,
          openTime: new Date(
            snap.candleTime.getTime() +
              60 * 60 * 1000
          ),
          closed: true
        }
      ];

      const result = evaluateSnapshot(
        snap,
        custom,
        onlyFuture
      );

      return (
        result.status === "cannot-evaluate" &&
        result.reason.includes("est 0")
      );
    })()
  );

  add(
    "poslednyaya svecha ne sovpala s candleTime -> cannot-evaluate",
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
          "cannot-evaluate" &&
        evalShifted.reason.includes(
          "ne sovpadaet s candleTime"
        )
      );
    })()
  );

  add(
    "GLAVNOE: nestandartnye periody + malo istorii NE ochenivayutsya po snapshot",
    (() => {
      // Znacheniya snapshot takovy, chto standartnyj
      // config dayet LONG: kontrol dokazyvaet, chto
      // eti znacheniya priveli by k scoringu, esli by
      // snapshot ispolzovalsya. Nestandartnyj config
      // s korotkoj istoriej dolzhen ottalknut rynok.
      const longSnap = mkInput({
        price: 100,
        rsi14: 60,
        ema20: 101,
        ema50: 98,
        ema200: 95,
        macdHist: 1,
        volumeRatio: 2
      });

      const control = evaluateSnapshot(
        longSnap,
        standard
      );

      const guarded = evaluateSnapshot(
        longSnap,
        custom,
        candles.slice(0, 60)
      );

      return (
        control.status === "evaluated" &&
        control.direction === "LONG" &&
        guarded.status === "cannot-evaluate"
      );
    })()
  );

  add(
    "prichina nedostatka istorii soderzhit tochnye chisla",
    (() => {
      const guarded = evaluateSnapshot(
        mkInput(),
        custom,
        candles.slice(0, 60)
      );

      return (
        guarded.status === "cannot-evaluate" &&
        guarded.reason.includes("nuzhno >= 100") &&
        guarded.reason.includes("est 60")
      );
    })()
  );

  add(
    "tsena: rashozhdenie 1e-12 otnositelno — tolerance, raschyot idet",
    (() => {
      const eps = LAST_CANDLE.close * 1e-12;

      const evalTol = evaluateSnapshot(
        mkInput({
          price: LAST_CANDLE.close + eps
        }),
        custom,
        candles
      );

      return evalTol.status === "evaluated";
    })()
  );

  add(
    "tsena: realnoe rashozhdenie (1%) -> cannot-evaluate",
    (() => {
      const evalBad = evaluateSnapshot(
        mkInput({
          price: LAST_CANDLE.close * 1.01
        }),
        custom,
        candles
      );

      return (
        evalBad.status === "cannot-evaluate" &&
        evalBad.reason.includes(
          "rassinhronizirovany"
        )
      );
    })()
  );

  add(
    "priceMatches: NaN i Infinity ne prohodyat",
    !priceMatches(NaN, 100) &&
      !priceMatches(100, Infinity)
  );

  add(
    "standartnyj config ispolzuet snapshot napryamuyu",
    (() => {
      const evalStd = evaluateSnapshot(
        snap,
        standard,
        candles
      );

      return (
        evalStd.status === "evaluated" &&
        JSON.stringify(
          evaluateSnapshot(snap, standard)
        ) === JSON.stringify(evalStd)
      );
    })()
  );

  /* ---- C2. Granitsy minCandlesForParams protiv realnyh indikatorov ---- */
  function analysisComplete(
    a: MarketAnalysis | null
  ): boolean {
    return (
      a !== null &&
      a.rsi14 !== null &&
      a.ema20 !== null &&
      a.ema50 !== null &&
      a.ema200 !== null &&
      a.macd !== null &&
      a.macdSignal !== null &&
      a.macdHist !== null &&
      a.atr14 !== null &&
      a.avgVolume20 !== null &&
      a.volumeRatio !== null
    );
  }

  function boundaryCase(
    label: string,
    config: TrendSuslikConfig,
    expectedMin: number
  ): void {
    const p = configToAnalysisParams(config);

    add(
      `granitsa ${label}: minCandlesForParams = ${expectedMin}`,
      minCandlesForParams(p) === expectedMin
    );

    const exact = analyzeCandlesWithParams(
      makeCandles(expectedMin),
      p
    );

    add(
      `granitsa ${label}: rovno ${expectedMin} svechej — vse indikatory poschitany`,
      analysisComplete(exact)
    );

    const less = analyzeCandlesWithParams(
      makeCandles(expectedMin - 1),
      p
    );

    add(
      `granitsa ${label}: ${expectedMin - 1} svechej — null`,
      less === null
    );
  }

  // Standartnyj nabor: max(200, 15, 35, 15, 20) = 200
  boundaryCase(
    "standart (20/50/200, RSI14, MACD 12/26/9, ATR14, V20)",
    standard,
    200
  );

  // MACD dominiruet: max(10, 6, 35+7, 5, 6) = 42
  boundaryCase(
    "MACD 5/35/7 + EMA 3/5/10",
    cfg({
      ema: { fast: 3, medium: 5, slow: 10 },
      rsiPeriod: 5,
      atrPeriod: 4,
      volumePeriod: 6,
      macd: { fast: 5, slow: 35, signal: 7 }
    }),
    42
  );

  // MACD dominiruet: max(10, 6, 17+9, 5, 6) = 26
  boundaryCase(
    "MACD 8/17/9 + EMA 3/5/10",
    cfg({
      ema: { fast: 3, medium: 5, slow: 10 },
      rsiPeriod: 5,
      atrPeriod: 4,
      volumePeriod: 6,
      macd: { fast: 8, slow: 17, signal: 9 }
    }),
    26
  );

  // MACD dominiruet: max(10, 6, 26+9, 5, 6) = 35
  boundaryCase(
    "MACD 12/26/9 + EMA 3/5/10",
    cfg({
      ema: { fast: 3, medium: 5, slow: 10 },
      rsiPeriod: 5,
      atrPeriod: 4,
      volumePeriod: 6
    }),
    35
  );

  // EMA slow > 200: max(300, 15, 35, 15, 20) = 300
  boundaryCase(
    "EMA slow 300",
    cfg({ ema: { fast: 20, medium: 50, slow: 300 } }),
    300
  );

  // RSI dominiruet: max(10, 21+1, 5+4, 5, 6) = 22
  boundaryCase(
    "RSI 21 + EMA 3/5/10 + MACD 3/5/4",
    cfg({
      ema: { fast: 3, medium: 5, slow: 10 },
      rsiPeriod: 21,
      atrPeriod: 4,
      volumePeriod: 6,
      macd: { fast: 3, slow: 5, signal: 4 }
    }),
    22
  );

  // ATR dominiruet: max(10, 5, 9, 20+1, 6) = 21
  boundaryCase(
    "ATR 20 + EMA 3/5/10",
    cfg({
      ema: { fast: 3, medium: 5, slow: 10 },
      rsiPeriod: 4,
      atrPeriod: 20,
      volumePeriod: 6,
      macd: { fast: 3, slow: 5, signal: 4 }
    }),
    21
  );

  // Volume dominiruet: max(10, 5, 9, 5, 30) = 30
  boundaryCase(
    "Volume 30 + EMA 3/5/10",
    cfg({
      ema: { fast: 3, medium: 5, slow: 10 },
      rsiPeriod: 4,
      atrPeriod: 4,
      volumePeriod: 30,
      macd: { fast: 3, slow: 5, signal: 4 }
    }),
    30
  );

  add(
    "legacy analyzeCandles trebuet te zhe 200, chto i minCandlesForParams(default)",
    analyzeCandles(makeCandles(199)) === null &&
      analyzeCandles(makeCandles(200)) !== null &&
      analyzeCandlesWithParams(
        makeCandles(199)
      ) === null &&
      analyzeCandlesWithParams(
        makeCandles(200)
      ) !== null
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
  quoteVolume24h: number | null;
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
    let evaluatedCount = 0;
    let cannotCount = 0;

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
          assetRank: 42,
          quoteVolume24h: market.quoteVolume24h,
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

        const computed = evaluateSnapshot(
          input,
          config,
          candles
        );

        compared++;

        if (computed.status === "evaluated") {
          evaluatedCount++;

          console.log(
            `${asset.symbol} ${market.exchange}: ` +
              `${computed.direction} ` +
              `score ${Math.max(computed.longScore, computed.shortScore)}`
          );
        } else {
          if (computed.status === "cannot-evaluate") {
            cannotCount++;
          }

          console.log(
            `${asset.symbol} ${market.exchange}: ` +
              `${computed.status} — ${computed.reason}`
          );
        }
      }
    }

    console.log(
      `\nRynkov provereno: ${compared}, ` +
        `oceneno po svecham: ${evaluatedCount}, ` +
        `cannot-evaluate: ${cannotCount}`
    );
    console.log(
      "Ozhidanie: nestandartnye periody schitayutsya tolko"
    );
    console.log(
      "po svecham; rynki bez dostatochnoj istorii —"
    );
    console.log(
      "cannot-evaluate, NIKAKOGO scoringa po snapshot."
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
