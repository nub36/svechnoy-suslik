/**
 * Smart Money V2 — Strategy Runtime adapter
 * - Reference exchange model (BINANCE default), not 3/5 voting
 * - SMC confirmations + trend direction
 * - MODE DISABLED/DRY_RUN/FORWARD_TEST/LIVE (LIVE not enabled in this task)
 * - Reuses existing SMC evaluateSmc and edge state machine
 * - V1/V2 state independent via strategyId
 */

import {
  defaultSmcScoringConfig,
  assertValidSmcScoringConfig,
  type SmcScoringConfig,
  type SmcScoringWeights,
} from "../smc/config";
import { evaluateSmc } from "../smc/evaluate";
import {
  isSmcTimeframe,
  SMCTIMEFRAME_MS,
  type SmcTimeframe,
  type SmcRawCandle,
} from "../smc/types";
import { SmcInputError } from "../smc/validate";
import type { Direction } from "./trend-suslik";

export const SMART_MONEY_V2_SLUG = "smart-money-v2";
export const SMART_MONEY_V2_NAME = "Smart Money V2";
export const SMART_MONEY_V2_VERSION = 2;

export type TrendMode = "OFF" | "MARKET_STRUCTURE" | "EMA" | "HTF" | "COMBINED";
export type TrendPolicy = "SCORE_BOOST" | "TIERING" | "HARD_ALIGNMENT";
export type StrategyMode = "DISABLED" | "DRY_RUN" | "FORWARD_TEST" | "LIVE";

export type SmcConfirmationConfig = {
  enabled: boolean;
  weight: number;
  required: boolean; // true = core required, false = optional weighted
};

export type SmcConfirmationsV2 = {
  bos: SmcConfirmationConfig; // Break of Structure
  choch: SmcConfirmationConfig; // Change of Character
  orderBlock: SmcConfirmationConfig; // Order Block (swing + internal combined for V2)
  fvg: SmcConfirmationConfig; // Fair Value Gap
  liquiditySweep: SmcConfirmationConfig; // Liquidity Sweep
  displacement: SmcConfirmationConfig; // Displacement / impulse
  rangePosition: SmcConfirmationConfig; // Premium/Discount
  confluence: SmcConfirmationConfig; // OB+FVG confluence
  internalStructure: SmcConfirmationConfig; // Internal structure bias
};

export type TrendContextV2 = {
  enabled: boolean;
  mode: TrendMode;
  policy: TrendPolicy;
  emaFast: number;
  emaSlow: number;
  emaSlopeLookback: number;
  htfTimeframe: SmcTimeframe;
  weight: number;
  counterTrendPenalty: number;
};

export type SmartMoneyV2Config = {
  // Basic
  mode: StrategyMode;
  symbol: string; // BTC default
  timeframe: SmcTimeframe; // 15m default
  referenceExchange: string; // BINANCE default
  minimumSignalScore: number;
  // SMC base (reuse existing SMC scoring config)
  swingLeft: number;
  swingRight: number;
  internalLeft: number;
  internalRight: number;
  atrPeriod: number;
  structureEventFreshBars: number;
  sweepFreshBars: number;
  orderBlockFreshBars: number;
  fvgFreshBars: number;
  eqBand: number;
  weights: SmcScoringWeights; // 9 weights sum 100
  // V2 specific
  confirmations: SmcConfirmationsV2;
  trend: TrendContextV2;
  // ATR SL/TP reuse
  atr: {
    period: number;
    stopMultiplier: number;
    takeProfit1Multiplier: number;
    takeProfit2Multiplier: number;
    takeProfit3Multiplier: number;
  };
  filters: {
    minimumQuoteVolume24h: number;
    top500Only: boolean;
  };
  // Execution
  execution: {
    closedCandleOnly: boolean;
    cooldownCandles: number;
  };
};

export const DEFAULT_CONFIRMATIONS: SmcConfirmationsV2 = {
  bos: { enabled: true, weight: 20, required: true },
  choch: { enabled: true, weight: 15, required: false },
  orderBlock: { enabled: true, weight: 15, required: true },
  fvg: { enabled: true, weight: 10, required: false },
  liquiditySweep: { enabled: true, weight: 10, required: false },
  displacement: { enabled: true, weight: 10, required: false },
  rangePosition: { enabled: true, weight: 10, required: false },
  confluence: { enabled: true, weight: 5, required: false },
  internalStructure: { enabled: true, weight: 5, required: false },
};

export const DEFAULT_TREND: TrendContextV2 = {
  enabled: true,
  mode: "MARKET_STRUCTURE",
  policy: "SCORE_BOOST",
  emaFast: 20,
  emaSlow: 50,
  emaSlopeLookback: 5,
  htfTimeframe: "1h",
  weight: 15,
  counterTrendPenalty: 10,
};

export const DEFAULT_V2_CONFIG: SmartMoneyV2Config = {
  mode: "DISABLED",
  symbol: "BTC",
  timeframe: "15m",
  referenceExchange: "BINANCE",
  minimumSignalScore: 65,
  swingLeft: 20,
  swingRight: 20,
  internalLeft: 3,
  internalRight: 3,
  atrPeriod: 14,
  structureEventFreshBars: 10,
  sweepFreshBars: 5,
  orderBlockFreshBars: 20,
  fvgFreshBars: 20,
  eqBand: 0.02,
  weights: {
    swingStructureBias: 20,
    recentSwingBos: 15,
    internalStructure: 10,
    liquiditySweep: 10,
    swingOrderBlock: 15,
    internalOrderBlock: 5,
    fvg: 10,
    rangePosition: 10,
    confluence: 5,
  },
  confirmations: { ...DEFAULT_CONFIRMATIONS },
  trend: { ...DEFAULT_TREND },
  atr: {
    period: 14,
    stopMultiplier: 1.5,
    takeProfit1Multiplier: 1.5,
    takeProfit2Multiplier: 2.5,
    takeProfit3Multiplier: 4,
  },
  filters: {
    minimumQuoteVolume24h: 0,
    top500Only: false,
  },
  execution: {
    closedCandleOnly: true,
    cooldownCandles: 3,
  },
};

export function normalizeV2Config(raw: unknown): SmartMoneyV2Config {
  const r = (raw ?? {}) as Record<string, unknown>;
  const conf = (r.confirmations ?? {}) as Record<string, unknown>;
  const trend = (r.trend ?? {}) as Record<string, unknown>;
  const weights = (r.weights ?? {}) as Record<string, unknown>;
  const atr = (r.atr ?? {}) as Record<string, unknown>;
  const filters = (r.filters ?? {}) as Record<string, unknown>;
  const execution = (r.execution ?? {}) as Record<string, unknown>;

  function getConf(key: string): SmcConfirmationConfig {
    const c = conf[key] as Record<string, unknown> | undefined;
    const def = (DEFAULT_CONFIRMATIONS as any)[key] as SmcConfirmationConfig;
    if (!c) return { ...def };
    return {
      enabled: typeof c.enabled === "boolean" ? c.enabled : def.enabled,
      weight: typeof c.weight === "number" ? c.weight : def.weight,
      required: typeof c.required === "boolean" ? c.required : def.required,
    };
  }

  return {
    mode: (typeof r.mode === "string" && ["DISABLED","DRY_RUN","FORWARD_TEST","LIVE"].includes(r.mode) ? r.mode : DEFAULT_V2_CONFIG.mode) as StrategyMode,
    symbol: typeof r.symbol === "string" ? r.symbol.toUpperCase() : DEFAULT_V2_CONFIG.symbol,
    timeframe: (isSmcTimeframe(r.timeframe) ? r.timeframe : DEFAULT_V2_CONFIG.timeframe) as SmcTimeframe,
    referenceExchange: typeof r.referenceExchange === "string" ? r.referenceExchange.toUpperCase() : DEFAULT_V2_CONFIG.referenceExchange,
    minimumSignalScore: typeof r.minimumSignalScore === "number" ? r.minimumSignalScore : DEFAULT_V2_CONFIG.minimumSignalScore,
    swingLeft: typeof r.swingLeft === "number" ? r.swingLeft : DEFAULT_V2_CONFIG.swingLeft,
    swingRight: typeof r.swingRight === "number" ? r.swingRight : DEFAULT_V2_CONFIG.swingRight,
    internalLeft: typeof r.internalLeft === "number" ? r.internalLeft : DEFAULT_V2_CONFIG.internalLeft,
    internalRight: typeof r.internalRight === "number" ? r.internalRight : DEFAULT_V2_CONFIG.internalRight,
    atrPeriod: typeof r.atrPeriod === "number" ? r.atrPeriod : DEFAULT_V2_CONFIG.atrPeriod,
    structureEventFreshBars: typeof r.structureEventFreshBars === "number" ? r.structureEventFreshBars : DEFAULT_V2_CONFIG.structureEventFreshBars,
    sweepFreshBars: typeof r.sweepFreshBars === "number" ? r.sweepFreshBars : DEFAULT_V2_CONFIG.sweepFreshBars,
    orderBlockFreshBars: typeof r.orderBlockFreshBars === "number" ? r.orderBlockFreshBars : DEFAULT_V2_CONFIG.orderBlockFreshBars,
    fvgFreshBars: typeof r.fvgFreshBars === "number" ? r.fvgFreshBars : DEFAULT_V2_CONFIG.fvgFreshBars,
    eqBand: typeof r.eqBand === "number" ? r.eqBand : DEFAULT_V2_CONFIG.eqBand,
    weights: {
      swingStructureBias: typeof weights.swingStructureBias === "number" ? weights.swingStructureBias : DEFAULT_V2_CONFIG.weights.swingStructureBias,
      recentSwingBos: typeof weights.recentSwingBos === "number" ? weights.recentSwingBos : DEFAULT_V2_CONFIG.weights.recentSwingBos,
      internalStructure: typeof weights.internalStructure === "number" ? weights.internalStructure : DEFAULT_V2_CONFIG.weights.internalStructure,
      liquiditySweep: typeof weights.liquiditySweep === "number" ? weights.liquiditySweep : DEFAULT_V2_CONFIG.weights.liquiditySweep,
      swingOrderBlock: typeof weights.swingOrderBlock === "number" ? weights.swingOrderBlock : DEFAULT_V2_CONFIG.weights.swingOrderBlock,
      internalOrderBlock: typeof weights.internalOrderBlock === "number" ? weights.internalOrderBlock : DEFAULT_V2_CONFIG.weights.internalOrderBlock,
      fvg: typeof weights.fvg === "number" ? weights.fvg : DEFAULT_V2_CONFIG.weights.fvg,
      rangePosition: typeof weights.rangePosition === "number" ? weights.rangePosition : DEFAULT_V2_CONFIG.weights.rangePosition,
      confluence: typeof weights.confluence === "number" ? weights.confluence : DEFAULT_V2_CONFIG.weights.confluence,
    },
    confirmations: {
      bos: getConf("bos"),
      choch: getConf("choch"),
      orderBlock: getConf("orderBlock"),
      fvg: getConf("fvg"),
      liquiditySweep: getConf("liquiditySweep"),
      displacement: getConf("displacement"),
      rangePosition: getConf("rangePosition"),
      confluence: getConf("confluence"),
      internalStructure: getConf("internalStructure"),
    },
    trend: {
      enabled: typeof trend.enabled === "boolean" ? trend.enabled : DEFAULT_TREND.enabled,
      mode: (typeof trend.mode === "string" && ["OFF","MARKET_STRUCTURE","EMA","HTF","COMBINED"].includes(trend.mode) ? trend.mode : DEFAULT_TREND.mode) as TrendMode,
      policy: (typeof trend.policy === "string" && ["SCORE_BOOST","TIERING","HARD_ALIGNMENT"].includes(trend.policy) ? trend.policy : DEFAULT_TREND.policy) as TrendPolicy,
      emaFast: typeof trend.emaFast === "number" ? trend.emaFast : DEFAULT_TREND.emaFast,
      emaSlow: typeof trend.emaSlow === "number" ? trend.emaSlow : DEFAULT_TREND.emaSlow,
      emaSlopeLookback: typeof trend.emaSlopeLookback === "number" ? trend.emaSlopeLookback : DEFAULT_TREND.emaSlopeLookback,
      htfTimeframe: (isSmcTimeframe(trend.htfTimeframe) ? trend.htfTimeframe : DEFAULT_TREND.htfTimeframe) as SmcTimeframe,
      weight: typeof trend.weight === "number" ? trend.weight : DEFAULT_TREND.weight,
      counterTrendPenalty: typeof trend.counterTrendPenalty === "number" ? trend.counterTrendPenalty : DEFAULT_TREND.counterTrendPenalty,
    },
    atr: {
      period: typeof atr.period === "number" ? atr.period : DEFAULT_V2_CONFIG.atr.period,
      stopMultiplier: typeof atr.stopMultiplier === "number" ? atr.stopMultiplier : DEFAULT_V2_CONFIG.atr.stopMultiplier,
      takeProfit1Multiplier: typeof atr.takeProfit1Multiplier === "number" ? atr.takeProfit1Multiplier : DEFAULT_V2_CONFIG.atr.takeProfit1Multiplier,
      takeProfit2Multiplier: typeof atr.takeProfit2Multiplier === "number" ? atr.takeProfit2Multiplier : DEFAULT_V2_CONFIG.atr.takeProfit2Multiplier,
      takeProfit3Multiplier: typeof atr.takeProfit3Multiplier === "number" ? atr.takeProfit3Multiplier : DEFAULT_V2_CONFIG.atr.takeProfit3Multiplier,
    },
    filters: {
      minimumQuoteVolume24h: typeof filters.minimumQuoteVolume24h === "number" ? filters.minimumQuoteVolume24h : DEFAULT_V2_CONFIG.filters.minimumQuoteVolume24h,
      top500Only: typeof filters.top500Only === "boolean" ? filters.top500Only : DEFAULT_V2_CONFIG.filters.top500Only,
    },
    execution: {
      closedCandleOnly: typeof execution.closedCandleOnly === "boolean" ? execution.closedCandleOnly : DEFAULT_V2_CONFIG.execution.closedCandleOnly,
      cooldownCandles: typeof execution.cooldownCandles === "number" ? execution.cooldownCandles : DEFAULT_V2_CONFIG.execution.cooldownCandles,
    },
  };
}

export function validateV2Config(config: SmartMoneyV2Config, timeframes: string[], minExchanges: number): string[] {
  const errors: string[] = [];

  if (!["DISABLED","DRY_RUN","FORWARD_TEST","LIVE"].includes(config.mode)) {
    errors.push(`mode: expected DISABLED/DRY_RUN/FORWARD_TEST/LIVE got ${config.mode}`);
  }
  if (config.mode === "LIVE") {
    errors.push("mode LIVE not allowed in this task — use DISABLED or DRY_RUN");
  }
  if (!/^[A-Z0-9]{1,20}$/.test(config.symbol)) {
    errors.push(`symbol: expected 1..20 uppercase got ${config.symbol}`);
  }
  if (!isSmcTimeframe(config.timeframe)) {
    errors.push(`timeframe: expected SmcTimeframe got ${config.timeframe}`);
  }
  if (!["BINANCE","BYBIT","GATE","KUCOIN","BINGX"].includes(config.referenceExchange)) {
    errors.push(`referenceExchange: expected BINANCE/BYBIT/GATE/KUCOIN/BINGX got ${config.referenceExchange}`);
  }
  if (!Number.isInteger(config.minimumSignalScore) || config.minimumSignalScore < 0 || config.minimumSignalScore > 100) {
    errors.push("minimumSignalScore: 0..100");
  }

  // SMC base
  for (const f of ["swingLeft","swingRight","internalLeft","internalRight"] as const) {
    const v = config[f];
    if (!Number.isInteger(v) || v < 1 || v > 500) errors.push(`${f}: 1..500`);
  }
  if (!Number.isInteger(config.atrPeriod) || config.atrPeriod < 1) errors.push("atrPeriod: >=1");
  for (const f of ["structureEventFreshBars","sweepFreshBars","orderBlockFreshBars","fvgFreshBars"] as const) {
    const v = config[f];
    if (!Number.isInteger(v) || v < 0) errors.push(`${f}: >=0`);
  }
  if (!Number.isFinite(config.eqBand) || config.eqBand < 0 || config.eqBand >= 0.5) errors.push("eqBand: 0<=x<0.5");

  const weightKeys = Object.keys(DEFAULT_V2_CONFIG.weights) as (keyof SmcScoringWeights)[];
  let sum = 0;
  for (const k of weightKeys) {
    const v = config.weights[k];
    if (!Number.isInteger(v) || v < 0 || v > 100) errors.push(`weights.${k}: 0..100`);
    sum += v;
  }
  if (sum !== 100) errors.push(`weights sum must be 100 got ${sum}`);

  // Confirmations
  for (const [key, c] of Object.entries(config.confirmations)) {
    if (typeof c.enabled !== "boolean") errors.push(`confirmations.${key}.enabled: boolean`);
    if (!Number.isInteger(c.weight) || c.weight < 0 || c.weight > 100) errors.push(`confirmations.${key}.weight: 0..100`);
    if (typeof c.required !== "boolean") errors.push(`confirmations.${key}.required: boolean`);
  }

  // Trend
  if (typeof config.trend.enabled !== "boolean") errors.push("trend.enabled: boolean");
  if (!["OFF","MARKET_STRUCTURE","EMA","HTF","COMBINED"].includes(config.trend.mode)) errors.push(`trend.mode: OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED got ${config.trend.mode}`);
  if (!["SCORE_BOOST","TIERING","HARD_ALIGNMENT"].includes(config.trend.policy)) errors.push(`trend.policy: SCORE_BOOST/TIERING/HARD_ALIGNMENT got ${config.trend.policy}`);
  if (config.trend.mode !== "OFF" && config.trend.policy === "HARD_ALIGNMENT") {
    // Warn but allow, default should not be HARD_ALIGNMENT without research
    // Not error, just note
  }
  if (!Number.isInteger(config.trend.emaFast) || config.trend.emaFast < 1) errors.push("trend.emaFast: >=1");
  if (!Number.isInteger(config.trend.emaSlow) || config.trend.emaSlow < 1) errors.push("trend.emaSlow: >=1");
  if (config.trend.emaFast >= config.trend.emaSlow) errors.push("trend: emaFast < emaSlow required");
  if (!Number.isInteger(config.trend.emaSlopeLookback) || config.trend.emaSlopeLookback < 1) errors.push("trend.emaSlopeLookback: >=1");
  if (!isSmcTimeframe(config.trend.htfTimeframe)) errors.push(`trend.htfTimeframe: SmcTimeframe got ${config.trend.htfTimeframe}`);

  // ATR
  if (!Number.isInteger(config.atr.period) || config.atr.period < 1) errors.push("atr.period: >=1");

  // Timeframes
  if (!Array.isArray(timeframes) || timeframes.length === 0) errors.push("timeframes: non-empty required");
  if (!Number.isInteger(minExchanges) || minExchanges < 1 || minExchanges > 5) errors.push("minExchanges: 1..5");

  // Try SMC config validation
  try {
    const smcConfig: SmcScoringConfig = {
      tf: config.timeframe as SmcTimeframe,
      minimumScore: config.minimumSignalScore,
      swingLeft: config.swingLeft,
      swingRight: config.swingRight,
      internalLeft: config.internalLeft,
      internalRight: config.internalRight,
      atrPeriod: config.atrPeriod,
      structureEventFreshBars: config.structureEventFreshBars,
      sweepFreshBars: config.sweepFreshBars,
      orderBlockFreshBars: config.orderBlockFreshBars,
      fvgFreshBars: config.fvgFreshBars,
      eqBand: config.eqBand,
      weights: config.weights,
    };
    assertValidSmcScoringConfig(smcConfig);
  } catch (e) {
    errors.push(`SMC config invalid: ${e instanceof Error ? e.message : String(e)}`);
  }

  return errors;
}

// V2 evaluation on reference exchange only
export type V2EvaluationResult = {
  direction: Direction;
  longScore: number;
  shortScore: number;
  confirmations: { code: string; label: string; longPoints: number; shortPoints: number; enabled: boolean; required: boolean }[];
  trendContext: { mode: TrendMode; direction: "UP" | "DOWN" | "NEUTRAL"; boost: number };
  totalConfirmations: number;
  metConfirmations: number;
  referenceExchange: string;
  symbol: string;
  timeframe: SmcTimeframe;
  candleTime: Date;
  price: number;
};

export function evaluateV2WithCandles(
  candles: SmcRawCandle[],
  config: SmartMoneyV2Config,
  now: Date,
  htfCandles?: SmcRawCandle[]
): V2EvaluationResult | { error: string } {
  // Validate closed only
  if (!candles || candles.length === 0) return { error: "empty candles" };

  const tfMs = SMCTIMEFRAME_MS[config.timeframe as SmcTimeframe];
  const last = candles[candles.length - 1];
  const asOf = new Date(last.openTime.getTime() + tfMs);

  let smcEval: ReturnType<typeof evaluateSmc>;
  try {
    const smcConfig: SmcScoringConfig = {
      tf: config.timeframe as SmcTimeframe,
      minimumScore: config.minimumSignalScore,
      swingLeft: config.swingLeft,
      swingRight: config.swingRight,
      internalLeft: config.internalLeft,
      internalRight: config.internalRight,
      atrPeriod: config.atrPeriod,
      structureEventFreshBars: config.structureEventFreshBars,
      sweepFreshBars: config.sweepFreshBars,
      orderBlockFreshBars: config.orderBlockFreshBars,
      fvgFreshBars: config.fvgFreshBars,
      eqBand: config.eqBand,
      weights: config.weights,
    };
    smcEval = evaluateSmc(candles, smcConfig, asOf);
  } catch (e) {
    return { error: `SMC eval failed: ${e instanceof Error ? e.message : String(e)}` };
  }

  if (!smcEval.availability.evaluable) {
    return {
      direction: "NEUTRAL" as Direction,
      longScore: 0,
      shortScore: 0,
      confirmations: [],
      trendContext: { mode: config.trend.mode, direction: "NEUTRAL", boost: 0 },
      totalConfirmations: 0,
      metConfirmations: 0,
      referenceExchange: config.referenceExchange,
      symbol: config.symbol,
      timeframe: config.timeframe,
      candleTime: last.openTime,
      price: last.close,
    };
  }

  // Map SMC reasons to V2 confirmations
  const confirmationMap: Record<string, { code: string; label: string }> = {
    SWING_TREND: { code: "BOS", label: "Break of Structure — swing trend bias" },
    RECENT_SWING_BOS: { code: "BOS", label: "Recent swing BOS" },
    INTERNAL_TREND: { code: "CHOCH", label: "Internal structure / CHOCH" },
    LIQUIDITY_SWEEP: { code: "LIQUIDITY_SWEEP", label: "Liquidity Sweep" },
    SWING_ORDER_BLOCK: { code: "ORDER_BLOCK", label: "Swing Order Block" },
    INTERNAL_ORDER_BLOCK: { code: "ORDER_BLOCK", label: "Internal Order Block" },
    FVG: { code: "FVG", label: "Fair Value Gap" },
    RANGE_POSITION: { code: "RANGE_POSITION", label: "Premium/Discount range position" },
    OB_FVG_CONFLUENCE: { code: "CONFLUENCE", label: "OB + FVG confluence" },
  };

  const confirmations = smcEval.reasons.map(r => {
    const mapped = confirmationMap[r.code] || { code: r.code, label: r.label };
    // Find matching V2 confirmation config
    let v2Key: keyof SmcConfirmationsV2 = "bos";
    if (r.code.includes("SWING_TREND") || r.code.includes("RECENT_SWING_BOS")) v2Key = "bos";
    else if (r.code.includes("INTERNAL_TREND")) v2Key = "internalStructure";
    else if (r.code.includes("LIQUIDITY_SWEEP")) v2Key = "liquiditySweep";
    else if (r.code.includes("ORDER_BLOCK")) v2Key = "orderBlock";
    else if (r.code === "FVG") v2Key = "fvg";
    else if (r.code === "RANGE_POSITION") v2Key = "rangePosition";
    else if (r.code === "OB_FVG_CONFLUENCE") v2Key = "confluence";
    else v2Key = "bos";

    // For displacement, we use SWING_TREND + recent BOS as proxy
    const v2Conf = config.confirmations[v2Key] || { enabled: true, weight: 10, required: false };

    return {
      code: mapped.code,
      label: mapped.label,
      longPoints: r.longPoints,
      shortPoints: r.shortPoints,
      enabled: v2Conf.enabled,
      required: v2Conf.required,
    };
  });

  // Count met confirmations (points >0 and enabled)
  const enabledConfs = Object.values(config.confirmations).filter(c => c.enabled);
  const totalConfirmations = enabledConfs.length;
  let metConfirmations = 0;
  for (const c of confirmations) {
    if (c.enabled && (c.longPoints > 0 || c.shortPoints > 0)) metConfirmations++;
  }

  // Trend context
  let trendDir: "UP" | "DOWN" | "NEUTRAL" = "NEUTRAL";
  let trendBoost = 0;

  if (config.trend.enabled && config.trend.mode !== "OFF") {
    if (config.trend.mode === "EMA" || config.trend.mode === "COMBINED") {
      // Simple EMA trend: fast > slow = UP
      const emaFast = calculateEMA(candles.map(c => c.close), config.trend.emaFast);
      const emaSlow = calculateEMA(candles.map(c => c.close), config.trend.emaSlow);
      if (emaFast.length > 0 && emaSlow.length > 0) {
        const fastLast = emaFast[emaFast.length - 1];
        const slowLast = emaSlow[emaSlow.length - 1];
        if (fastLast > slowLast) trendDir = "UP";
        else if (fastLast < slowLast) trendDir = "DOWN";
      }
    }
    if (config.trend.mode === "MARKET_STRUCTURE" || config.trend.mode === "COMBINED") {
      // Use swing structure bias from SMC
      const swingBias = confirmations.find(c => c.code === "BOS" && c.label.includes("swing trend"));
      if (swingBias) {
        if (swingBias.longPoints > swingBias.shortPoints) trendDir = "UP";
        else if (swingBias.shortPoints > swingBias.longPoints) trendDir = "DOWN";
      }
    }
    if (config.trend.mode === "HTF" || config.trend.mode === "COMBINED") {
      // Use HTF candles if provided
      if (htfCandles && htfCandles.length > 0) {
        const htfLast = htfCandles[htfCandles.length - 1];
        const htfPrev = htfCandles[htfCandles.length - 2];
        if (htfPrev) {
          if (htfLast.close > htfPrev.close) trendDir = "UP";
          else if (htfLast.close < htfPrev.close) trendDir = "DOWN";
        }
      }
    }

    // Apply policy
    if (config.trend.policy === "SCORE_BOOST") {
      if (trendDir === "UP" && smcEval.direction === "LONG") trendBoost = config.trend.weight;
      else if (trendDir === "DOWN" && smcEval.direction === "SHORT") trendBoost = config.trend.weight;
      else if (trendDir !== "NEUTRAL" && smcEval.direction !== "NEUTRAL") trendBoost = -config.trend.counterTrendPenalty;
    } else if (config.trend.policy === "TIERING") {
      // Tiering: boost but not hard block
      if (trendDir === "UP" && smcEval.direction === "LONG") trendBoost = config.trend.weight;
      else if (trendDir === "DOWN" && smcEval.direction === "SHORT") trendBoost = config.trend.weight;
    } else if (config.trend.policy === "HARD_ALIGNMENT") {
      // Hard alignment: if trend disagrees, force NEUTRAL
      if (trendDir === "UP" && smcEval.direction === "SHORT") {
        return {
          direction: "NEUTRAL" as Direction,
          longScore: smcEval.longScore ?? 0,
          shortScore: smcEval.shortScore ?? 0,
          confirmations,
          trendContext: { mode: config.trend.mode, direction: trendDir, boost: -100 },
          totalConfirmations,
          metConfirmations,
          referenceExchange: config.referenceExchange,
          symbol: config.symbol,
          timeframe: config.timeframe,
          candleTime: last.openTime,
          price: last.close,
        };
      }
      if (trendDir === "DOWN" && smcEval.direction === "LONG") {
        return {
          direction: "NEUTRAL" as Direction,
          longScore: smcEval.longScore ?? 0,
          shortScore: smcEval.shortScore ?? 0,
          confirmations,
          trendContext: { mode: config.trend.mode, direction: trendDir, boost: -100 },
          totalConfirmations,
          metConfirmations,
          referenceExchange: config.referenceExchange,
          symbol: config.symbol,
          timeframe: config.timeframe,
          candleTime: last.openTime,
          price: last.close,
        };
      }
    }
  }

  // Apply trend boost to scores
  let longScore = smcEval.longScore ?? 0;
  let shortScore = smcEval.shortScore ?? 0;
  if (trendBoost !== 0) {
    if (trendDir === "UP") longScore = Math.min(100, longScore + trendBoost);
    else if (trendDir === "DOWN") shortScore = Math.min(100, shortScore + trendBoost);
    if (trendBoost < 0) {
      // Counter-trend penalty
      if (trendDir === "UP") shortScore = Math.max(0, shortScore + trendBoost);
      else if (trendDir === "DOWN") longScore = Math.max(0, longScore + trendBoost);
    }
  }

  // Check required core conditions
  const requiredConfs = Object.entries(config.confirmations).filter(([_, c]) => c.required && c.enabled);
  let requiredMet = true;
  for (const [key] of requiredConfs) {
    // Map key to SMC reason
    const codeMap: Record<string, string[]> = {
      bos: ["SWING_TREND", "RECENT_SWING_BOS"],
      choch: ["INTERNAL_TREND"],
      orderBlock: ["SWING_ORDER_BLOCK", "INTERNAL_ORDER_BLOCK"],
      fvg: ["FVG"],
      liquiditySweep: ["LIQUIDITY_SWEEP"],
      displacement: ["SWING_TREND"],
      rangePosition: ["RANGE_POSITION"],
      confluence: ["OB_FVG_CONFLUENCE"],
      internalStructure: ["INTERNAL_TREND"],
    };
    const codes = codeMap[key] || [];
    const hasPoints = confirmations.some(c => codes.includes(c.code) && (c.longPoints > 0 || c.shortPoints > 0));
    if (!hasPoints) {
      requiredMet = false;
      break;
    }
  }

  let finalDirection: Direction = smcEval.direction as Direction;
  if (!requiredMet) {
    finalDirection = "NEUTRAL" as Direction;
  } else if (longScore >= config.minimumSignalScore && shortScore >= config.minimumSignalScore) {
    finalDirection = "NEUTRAL" as Direction; // conflict
  } else if (longScore >= config.minimumSignalScore) {
    finalDirection = "LONG" as Direction;
  } else if (shortScore >= config.minimumSignalScore) {
    finalDirection = "SHORT" as Direction;
  } else {
    finalDirection = "NEUTRAL" as Direction;
  }

  return {
    direction: finalDirection,
    longScore,
    shortScore,
    confirmations,
    trendContext: { mode: config.trend.mode, direction: trendDir, boost: trendBoost },
    totalConfirmations,
    metConfirmations,
    referenceExchange: config.referenceExchange,
    symbol: config.symbol,
    timeframe: config.timeframe,
    candleTime: last.openTime,
    price: last.close,
  };
}

function calculateEMA(prices: number[], period: number): number[] {
  if (prices.length < period) return [];
  const k = 2 / (period + 1);
  const ema: number[] = [];
  let sum = 0;
  for (let i = 0; i < period; i++) sum += prices[i];
  ema.push(sum / period);
  for (let i = period; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[ema.length - 1] * (1 - k));
  }
  return ema;
}
