/**
 * Signal Engine — testovyj CLI.
 *
 * Rezhim:
 *   --self-test (po umolchaniyu)  batareya proverok VOVSE bez bazy:
 *                                 urovni riska, cooldown,
 *                                 closedCandleOnly, planirovanie,
 *                                 dedup, audit chistoty modulya.
 *
 * Etot skript NE importit @prisma/client i ne hodit v set,
 * poetomu rabotaet v lyuboj pesochnice.
 *
 * Primer:
 *   npx tsx scripts/test-signal-engine.ts --self-test
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  validateTrendSuslikConfig,
  type TrendSuslikConfig
} from "../lib/strategies/config";
import {
  aggregateAssetGroup,
  type AssetAggregation,
  type EvaluatedMarket,
  type MarketStrategyResult,
  type SnapshotInput
} from "../lib/strategies/runtime";
import {
  computeRiskLevels,
  isCandleClosed,
  isCooldownActive,
  planSignals,
  signalKey,
  timeframeMs
} from "../lib/signals/engine";
import type { StrategyReason } from "../lib/strategies/trend-suslik";

const SCRIPT_DIR = dirname(
  fileURLToPath(import.meta.url)
);
const ROOT_DIR = join(SCRIPT_DIR, "..");

/* ================================================================
 * Fiksury
 * ================================================================ */

const BASE_CANDLE = new Date(
  "2026-09-09T10:00:00.000Z"
);
const NOW = new Date("2026-09-09T11:00:00.000Z");

function seedLikeRawConfig(): unknown {
  return {
    minimumSignalScore: 70,

    weights: {
      trend: 30,
      mediumTrend: 15,
      rsi: 20,
      macd: 20,
      volume: 15
    },

    ema: { fast: 20, medium: 50, slow: 200 },

    rsi: {
      period: 14,
      longMin: 52,
      longMax: 72,
      shortMin: 28,
      shortMax: 48
    },

    macd: { fast: 12, slow: 26, signal: 9 },

    atr: {
      period: 14,
      stopMultiplier: 1.5,
      takeProfit1Multiplier: 1.5,
      takeProfit2Multiplier: 2.5,
      takeProfit3Multiplier: 4
    },

    volume: { period: 20, minimumRatio: 1 },

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

function seedLikeConfig(): TrendSuslikConfig {
  const result = validateTrendSuslikConfig(
    seedLikeRawConfig()
  );

  if (!result.ok) {
    throw new Error(
      "fiksura config ne proshla validaciyu: " +
        result.errors.join("; ")
    );
  }

  return result.config;
}

function mkSnap(
  marketId: number,
  exchange: string,
  exchangeSymbol: string,
  overrides: Partial<SnapshotInput> = {}
): SnapshotInput {
  return {
    marketId,
    exchange,
    exchangeSymbol,
    assetSymbol: "BTC",
    assetTop500: true,
    quoteVolume24h: 10_000_000,

    timeframe: "1h",
    candleTime: BASE_CANDLE,
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

const FAKE_REASONS: StrategyReason[] = [
  {
    label: "Основной тренд EMA medium / slow",
    long: true,
    short: false,
    weight: 30,
    value: "EMA50 98.00 · EMA200 95.00"
  }
];

function mkEval(
  marketId: number,
  exchange: string,
  exchangeSymbol: string,
  direction: "LONG" | "SHORT" | "NEUTRAL",
  overrides: Partial<EvaluatedMarket> = {}
): EvaluatedMarket {
  return {
    status: "evaluated",
    exchange,
    market: exchangeSymbol,
    marketId,
    candleTime: BASE_CANDLE,
    price: 100,

    longScore:
      direction === "LONG" ? 80 : 40,
    shortScore:
      direction === "SHORT" ? 80 : 40,

    direction,
    reasons: FAKE_REASONS,
    warnings: [],

    ...overrides
  };
}

function mkFiltered(
  marketId: number,
  exchange: string,
  exchangeSymbol: string
): MarketStrategyResult {
  return {
    status: "filtered",
    exchange,
    market: exchangeSymbol,
    marketId,
    reason: "aktiv vne Top-500 (filtr top500Only)"
  };
}

function aggregate(
  markets: MarketStrategyResult[],
  minExchanges: number,
  timeframe = "1h"
): AssetAggregation {
  return aggregateAssetGroup(
    "BTC",
    timeframe,
    "trend-suslik",
    1,
    markets,
    minExchanges
  );
}

function approx(
  actual: number | null,
  expected: number,
  eps = 1e-9
): boolean {
  return (
    actual !== null &&
    Math.abs(actual - expected) < eps
  );
}

/* ================================================================
 * Batareya proverok
 * ================================================================ */

type Check = { name: string; ok: boolean };

function runSelfTest(): Check[] {
  const checks: Check[] = [];
  const add = (name: string, ok: boolean) =>
    checks.push({ name, ok });

  const config = seedLikeConfig();

  /* ---- A. timeframeMs ---- */
  add(
    "timeframeMs: 5m = 300000",
    timeframeMs("5m") === 5 * 60 * 1000
  );
  add(
    "timeframeMs: 1h = 3600000",
    timeframeMs("1h") === 60 * 60 * 1000
  );
  add(
    "timeframeMs: 1d = 86400000",
    timeframeMs("1d") === 24 * 60 * 60 * 1000
  );
  add(
    "timeframeMs: neizvestnyj 2h -> null",
    timeframeMs("2h") === null
  );

  /* ---- B. computeRiskLevels ---- */
  const longRisk = computeRiskLevels(
    "LONG",
    100,
    2,
    config.atr
  );

  add(
    "risk LONG: SL = entry - 1.5*ATR = 97",
    approx(longRisk.stopLoss, 97)
  );
  add(
    "risk LONG: TP1 = 103, TP2 = 105, TP3 = 108",
    approx(longRisk.takeProfit1, 103) &&
      approx(longRisk.takeProfit2, 105) &&
      approx(longRisk.takeProfit3, 108)
  );
  add(
    "risk LONG: poryadok SL < entry < TP1 < TP2 < TP3",
    longRisk.stopLoss !== null &&
      longRisk.takeProfit1 !== null &&
      longRisk.takeProfit2 !== null &&
      longRisk.takeProfit3 !== null &&
      longRisk.stopLoss < 100 &&
      100 < longRisk.takeProfit1 &&
      longRisk.takeProfit1 < longRisk.takeProfit2 &&
      longRisk.takeProfit2 < longRisk.takeProfit3
  );

  const shortRisk = computeRiskLevels(
    "SHORT",
    100,
    2,
    config.atr
  );

  add(
    "risk SHORT: SL = 103, TP1 = 97, TP2 = 95, TP3 = 92",
    approx(shortRisk.stopLoss, 103) &&
      approx(shortRisk.takeProfit1, 97) &&
      approx(shortRisk.takeProfit2, 95) &&
      approx(shortRisk.takeProfit3, 92)
  );
  add(
    "risk SHORT: poryadok TP3 < TP2 < TP1 < entry < SL",
    shortRisk.stopLoss !== null &&
      shortRisk.takeProfit1 !== null &&
      shortRisk.takeProfit2 !== null &&
      shortRisk.takeProfit3 !== null &&
      shortRisk.takeProfit3 < shortRisk.takeProfit2 &&
      shortRisk.takeProfit2 < shortRisk.takeProfit1 &&
      shortRisk.takeProfit1 < 100 &&
      100 < shortRisk.stopLoss
  );

  const noAtrRisk = computeRiskLevels(
    "LONG",
    100,
    null,
    config.atr
  );

  add(
    "risk: ATR null -> vse urovni null (ne vydumyvaem)",
    noAtrRisk.stopLoss === null &&
      noAtrRisk.takeProfit1 === null &&
      noAtrRisk.takeProfit2 === null &&
      noAtrRisk.takeProfit3 === null
  );

  const zeroAtrRisk = computeRiskLevels(
    "SHORT",
    100,
    0,
    config.atr
  );

  add(
    "risk: ATR 0 -> vse urovni null",
    zeroAtrRisk.stopLoss === null &&
      zeroAtrRisk.takeProfit1 === null
  );

  /* ---- C. isCandleClosed ---- */
  add(
    "closedCandle: 10:00 1h na 11:00 — zakryta (granica)",
    isCandleClosed(BASE_CANDLE, "1h", NOW)
  );
  add(
    "closedCandle: 10:00 1h na 10:59:59 — eshyo net",
    !isCandleClosed(
      BASE_CANDLE,
      "1h",
      new Date("2026-09-09T10:59:59.000Z")
    )
  );
  add(
    "closedCandle: neizvestnyj tajmfrejm — schitaetsya nezakrytoj",
    !isCandleClosed(BASE_CANDLE, "2h", NOW)
  );

  /* ---- D. isCooldownActive ---- */
  const last = new Date("2026-09-09T08:00:00.000Z");

  add(
    "cooldown: 2 svechi iz 3 nazad — aktivен",
    isCooldownActive(
      last,
      BASE_CANDLE,
      "1h",
      3
    )
  );
  add(
    "cooldown: rovno 3 svechi nazad — propusk razreshen",
    !isCooldownActive(
      new Date("2026-09-09T07:00:00.000Z"),
      BASE_CANDLE,
      "1h",
      3
    )
  );
  add(
    "cooldown: 3 svechi + 1 min — razreshen",
    !isCooldownActive(
      new Date("2026-09-09T06:59:00.000Z"),
      BASE_CANDLE,
      "1h",
      3
    )
  );
  add(
    "cooldown: cooldownCandles=0 — vyklyuchen",
    !isCooldownActive(
      last,
      BASE_CANDLE,
      "1h",
      0
    )
  );
  add(
    "cooldown: kandidat ranshe poslednego signala — zapreshen",
    isCooldownActive(
      BASE_CANDLE,
      new Date("2026-09-09T09:00:00.000Z"),
      "1h",
      3
    )
  );

  /* ---- E. planSignals: NEUTRAL i konflikt ---- */
  const neutralAgg = aggregate(
    [
      mkEval(1, "Binance", "BTCUSDT", "LONG"),
      mkEval(2, "Bybit", "BTC/USDT:USDT", "NEUTRAL"),
      mkEval(3, "Gate", "BTC_USDT", "NEUTRAL")
    ],
    3
  );

  const neutralPlan = planSignals({
    aggregation: neutralAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map(),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "plan NEUTRAL: signalov net",
    neutralPlan.planned.length === 0
  );
  add(
    "plan NEUTRAL: est globalnaya prichina",
    neutralPlan.globalReason !== null
  );

  const conflictAgg = aggregate(
    [
      mkEval(1, "Binance", "BTCUSDT", "LONG"),
      mkEval(2, "Bybit", "BTC/USDT:USDT", "LONG"),
      mkEval(3, "Gate", "BTC_USDT", "LONG"),
      mkEval(4, "KuCoin", "BTC-USDT", "SHORT"),
      mkEval(5, "BingX", "BTC-USDT", "SHORT"),
      mkEval(6, "MEXC", "BTCUSDT", "SHORT")
    ],
    3
  );

  add(
    "fiksura konflikta: agregaciya daet NEUTRAL + conflict",
    conflictAgg.direction === "NEUTRAL" &&
      conflictAgg.conflict
  );

  const conflictPlan = planSignals({
    aggregation: conflictAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map(),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "plan KONFLIKT: signalov net, prichina pro KONFLIKT",
    conflictPlan.planned.length === 0 &&
      conflictPlan.globalReason !== null &&
      conflictPlan.globalReason.includes("KONFLIKT")
  );

  /* ---- F. planSignals: LONG 2/3 (porog 2) ---- */
  const longMarkets = [
    mkEval(1, "Binance", "BTCUSDT", "LONG"),
    mkEval(2, "Bybit", "BTC/USDT:USDT", "LONG"),
    mkEval(3, "Gate", "BTC_USDT", "NEUTRAL")
  ];
  const longAgg = aggregate(longMarkets, 2);

  const snapMap = new Map<number, SnapshotInput>([
    [1, mkSnap(1, "Binance", "BTCUSDT")],
    [2, mkSnap(2, "Bybit", "BTC/USDT:USDT")],
    [3, mkSnap(3, "Gate", "BTC_USDT")]
  ]);

  const longPlan = planSignals({
    aggregation: longAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: snapMap,
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "plan LONG 2/3: 2 chernovika (tolko golosovavshie za LONG)",
    longPlan.planned.length === 2
  );
  add(
    "plan LONG: NEUTRAL-rynok v skipped s prichinoj",
    longPlan.skipped.some(
      (s) =>
        s.marketId === 3 &&
        s.reason.includes("NEUTRAL")
    )
  );

  const draft = longPlan.planned[0];

  add(
    "chernovik: polya strategii i napravlenie",
    draft.strategyId === 7 &&
      draft.strategySlug === "trend-suslik" &&
      draft.strategyVersion === 1 &&
      draft.direction === "LONG" &&
      draft.timeframe === "1h"
  );
  add(
    "chernovik: entry = cena snapshot, score iz ocenki birzhi",
    draft.entry === 100 && draft.score === 80
  );
  add(
    "chernovik: SL/TP iz ATR multipliers config",
    approx(draft.stopLoss, 97) &&
      approx(draft.takeProfit1, 103) &&
      approx(draft.takeProfit2, 105) &&
      approx(draft.takeProfit3, 108) &&
      draft.atr14 === 2
  );
  add(
    "chernovik: candleTime i indicators iz snapshot",
    draft.candleTime.getTime() ===
      BASE_CANDLE.getTime() &&
      draft.indicators.rsi14 === 60 &&
      draft.indicators.macdHist === 0.2 &&
      draft.indicators.price === 100
  );
  add(
    "chernovik: reasons i warnings peredany iz runtime",
    draft.reasons.length === 1 &&
      draft.reasons[0].label ===
        FAKE_REASONS[0].label
  );
  add(
    "chernovik: reason soderzhit napravlenie i potverzhdenie",
    draft.reason.includes("LONG") &&
      draft.reason.includes("2/3")
  );

  /* ---- G. closedCandleOnly ---- */
  const openCandleSnap = mkSnap(
    2,
    "Bybit",
    "BTC/USDT:USDT",
    {
      candleTime: new Date(
        "2026-09-09T10:30:00.000Z"
      )
    }
  );
  const evalOpen = mkEval(
    2,
    "Bybit",
    "BTC/USDT:USDT",
    "LONG",
    {
      candleTime: new Date(
        "2026-09-09T10:30:00.000Z"
      )
    }
  );
  const aggOpen = aggregate(
    [
      longMarkets[0],
      evalOpen,
      longMarkets[2]
    ],
    2
  );

  const planOpenClosedOnly = planSignals({
    aggregation: aggOpen,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map([
      [1, snapMap.get(1)!],
      [2, openCandleSnap],
      [3, snapMap.get(3)!]
    ]),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "closedCandleOnly=true: nezakrytaya svecha -> skip",
    planOpenClosedOnly.planned.length === 1 &&
      planOpenClosedOnly.skipped.some(
        (s) =>
          s.marketId === 2 &&
          s.reason.includes("closedCandleOnly")
      )
  );

  const configNoClosed: TrendSuslikConfig = {
    ...config,
    execution: {
      ...config.execution,
      closedCandleOnly: false
    }
  };

  const planOpenAllowed = planSignals({
    aggregation: aggOpen,
    config: configNoClosed,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map([
      [1, snapMap.get(1)!],
      [2, openCandleSnap],
      [3, snapMap.get(3)!]
    ]),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "closedCandleOnly=false: nezakrytaya svecha planiruetsya",
    planOpenAllowed.planned.length === 2
  );

  /* ---- H. cooldown v planirovanii ---- */
  const planCooldown = planSignals({
    aggregation: longAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: snapMap,
    lastSignalCandleTimeByMarketId: new Map([
      [
        1,
        new Date("2026-09-09T08:00:00.000Z")
      ]
    ]),
    existingKeys: new Set()
  });

  add(
    "cooldown 3: signal 2 svechi nazad -> rynok v skip",
    planCooldown.planned.length === 1 &&
      planCooldown.planned[0].marketId === 2 &&
      planCooldown.skipped.some(
        (s) =>
          s.marketId === 1 &&
          s.reason.includes("cooldown")
      )
  );

  const planCooldownExpired = planSignals({
    aggregation: longAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: snapMap,
    lastSignalCandleTimeByMarketId: new Map([
      [
        1,
        new Date("2026-09-09T07:00:00.000Z")
      ]
    ]),
    existingKeys: new Set()
  });

  add(
    "cooldown 3: proshlo rovno 3 svechi -> signal planiruetsya",
    planCooldownExpired.planned.length === 2
  );

  /* ---- I. ATR net ---- */
  const snapNoAtr = mkSnap(
    2,
    "Bybit",
    "BTC/USDT:USDT",
    { atr14: null }
  );

  const planNoAtr = planSignals({
    aggregation: longAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map([
      [1, snapMap.get(1)!],
      [2, snapNoAtr],
      [3, snapMap.get(3)!]
    ]),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "ATR14 null: rynok propuschen, drugie planiruyutsya",
    planNoAtr.planned.length === 1 &&
      planNoAtr.planned[0].marketId === 1 &&
      planNoAtr.skipped.some(
        (s) =>
          s.marketId === 2 &&
          s.reason.includes("ATR14")
      )
  );

  /* ---- J. dedup ---- */
  const dupKey = signalKey(
    2,
    BASE_CANDLE,
    "LONG"
  );

  const planDup = planSignals({
    aggregation: longAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: snapMap,
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set([dupKey])
  });

  add(
    "dedup: sushchestvuyushchij klyuch -> skip, ostalnye planiruyutsya",
    planDup.planned.length === 1 &&
      planDup.planned[0].marketId === 1 &&
      planDup.skipped.some(
        (s) =>
          s.marketId === 2 &&
          s.reason.includes("uzhe est v BD")
      )
  );

  /* ---- K. SHORT 2/3 ---- */
  const shortAgg = aggregate(
    [
      mkEval(11, "Binance", "BTCUSDT", "SHORT"),
      mkEval(12, "Bybit", "BTC/USDT:USDT", "SHORT"),
      mkEval(13, "Gate", "BTC_USDT", "NEUTRAL")
    ],
    2
  );

  const shortPlan = planSignals({
    aggregation: shortAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map([
      [
        11,
        mkSnap(11, "Binance", "BTCUSDT", {
          price: 100
        })
      ],
      [
        12,
        mkSnap(12, "Bybit", "BTC/USDT:USDT", {
          price: 100
        })
      ],
      [13, mkSnap(13, "Gate", "BTC_USDT")]
    ]),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "plan SHORT 2/3: 2 chernovika SHORT",
    shortPlan.planned.length === 2 &&
      shortPlan.planned.every(
        (d) => d.direction === "SHORT"
      )
  );
  add(
    "plan SHORT: SL vyshe vhoda, TP nizhe",
    shortPlan.planned.every(
      (d) =>
        d.stopLoss !== null &&
        d.takeProfit1 !== null &&
        d.stopLoss > d.entry &&
        d.takeProfit1 < d.entry
    )
  );

  /* ---- L. prochie otkazy ---- */
  const badTfAgg = aggregate(
    [mkEval(1, "Binance", "BTCUSDT", "LONG")],
    1,
    "2h"
  );

  const planBadTf = planSignals({
    aggregation: badTfAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map(),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "neizvestnyj tajmfrejm agregacii -> globalnyj otkaz",
    planBadTf.planned.length === 0 &&
      planBadTf.globalReason !== null &&
      planBadTf.globalReason.includes("tajmfrejm")
  );

  const planNoSnap = planSignals({
    aggregation: aggregate(
      [mkEval(99, "Binance", "BTCUSDT", "LONG")],
      1
    ),
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map(),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "net snapshot dlya rynka -> skip s prichinoj",
    planNoSnap.planned.length === 0 &&
      planNoSnap.skipped[0]?.reason.includes(
        "net snapshot"
      )
  );

  const filteredAgg = aggregate(
    [
      mkEval(1, "Binance", "BTCUSDT", "LONG"),
      mkFiltered(4, "KuCoin", "BTC-USDT"),
      mkEval(2, "Bybit", "BTC/USDT:USDT", "LONG")
    ],
    2
  );

  const planFiltered = planSignals({
    aggregation: filteredAgg,
    config,
    strategyId: 7,
    strategySlug: "trend-suslik",
    symbol: "BTC",
    now: NOW,
    snapshotByMarketId: new Map([
      [1, snapMap.get(1)!],
      [2, snapMap.get(2)!]
    ]),
    lastSignalCandleTimeByMarketId: new Map(),
    existingKeys: new Set()
  });

  add(
    "otsyannyj filtrom rynok popadaet v skipped s svoej prichinoj",
    planFiltered.skipped.some(
      (s) =>
        s.marketId === 4 &&
        s.reason.includes("Top-500")
    )
  );

  /* ---- M. audit chistoty modulya ---- */
  const engineSource = readFileSync(
    join(ROOT_DIR, "lib/signals/engine.ts"),
    "utf8"
  );

  add(
    "audit engine: net importa @prisma/client i PrismaClient",
    !/@prisma\/client|PrismaClient/.test(
      engineSource
    )
  );
  add(
    "audit engine: net setevyh vyzovov fetch(",
    !engineSource.includes("fetch(")
  );
  add(
    "audit engine: net zapisnyh operacij create/upsert",
    !/\.create\(|createMany|upsert\(/.test(
      engineSource
    )
  );

  const workerSource = readFileSync(
    join(ROOT_DIR, "scripts/signal-worker.ts"),
    "utf8"
  );

  const createManyCount = workerSource.split(
    "createMany("
  ).length - 1;

  const writeSignalsCount = workerSource.split(
    "writeSignals("
  ).length - 1;

  const defIdx = workerSource.indexOf(
    "async function writeSignals("
  );
  const applyIdx = workerSource.indexOf(
    "if (apply) {"
  );
  const callIdx = workerSource.lastIndexOf(
    "writeSignals("
  );

  add(
    "audit worker: createMany tolko odin raz (v writeSignals)",
    createManyCount === 1
  );
  add(
    "audit worker: writeSignals obyavlena i vyzvana odin raz",
    writeSignalsCount === 2
  );
  add(
    "audit worker: zapis tolko vnutri if (apply)",
    defIdx !== -1 &&
      applyIdx !== -1 &&
      defIdx < applyIdx &&
      callIdx > applyIdx
  );

  return checks;
}

/* ================================================================
 * Zapusk
 * ================================================================ */

function main(): void {
  console.log(
    "Signal Engine — samotest (bez bazy i seti)\n"
  );

  const checks = runSelfTest();
  const passed = checks.filter((c) => c.ok).length;

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
}

main();
