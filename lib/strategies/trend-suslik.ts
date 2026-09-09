import type {
  MarketAnalysis
} from "../analysis/analyze";

export type Direction =
  | "LONG"
  | "SHORT"
  | "NEUTRAL";

export type StrategyReason = {
  label: string;
  long: boolean;
  short: boolean;
  weight: number;
  value?: string;
};

export type StrategyResult = {
  direction: Direction;

  score: number;
  longScore: number;
  shortScore: number;

  reasons: StrategyReason[];
};

export const trendSuslikConfig = {
  minimumSignalScore: 70,

  weights: {
    trend: 30,
    mediumTrend: 15,
    rsi: 20,
    macd: 20,
    volume: 15
  },

  rsi: {
    longMin: 52,
    longMax: 72,

    shortMin: 28,
    shortMax: 48
  },

  volume: {
    minimumRatio: 1.0
  }
};

export function runTrendSuslik(
  a: MarketAnalysis
): StrategyResult {
  let longScore = 0;
  let shortScore = 0;

  const reasons: StrategyReason[] = [];

  const w =
    trendSuslikConfig.weights;

  // EMA50 / EMA200 — основной тренд
  const trendLong =
    a.ema50 !== null &&
    a.ema200 !== null &&
    a.ema50 > a.ema200 &&
    a.price > a.ema50;

  const trendShort =
    a.ema50 !== null &&
    a.ema200 !== null &&
    a.ema50 < a.ema200 &&
    a.price < a.ema50;

  if (trendLong) {
    longScore += w.trend;
  }

  if (trendShort) {
    shortScore += w.trend;
  }

  reasons.push({
    label: "Основной тренд EMA50 / EMA200",
    long: trendLong,
    short: trendShort,
    weight: w.trend,
    value:
      `EMA50 ${a.ema50?.toFixed(2)} · ` +
      `EMA200 ${a.ema200?.toFixed(2)}`
  });

  // EMA20 / EMA50 — более быстрый тренд
  const mediumLong =
    a.ema20 !== null &&
    a.ema50 !== null &&
    a.ema20 > a.ema50 &&
    a.price > a.ema20;

  const mediumShort =
    a.ema20 !== null &&
    a.ema50 !== null &&
    a.ema20 < a.ema50 &&
    a.price < a.ema20;

  if (mediumLong) {
    longScore += w.mediumTrend;
  }

  if (mediumShort) {
    shortScore += w.mediumTrend;
  }

  reasons.push({
    label: "Краткосрочный тренд EMA20 / EMA50",
    long: mediumLong,
    short: mediumShort,
    weight: w.mediumTrend,
    value:
      `EMA20 ${a.ema20?.toFixed(2)} · ` +
      `EMA50 ${a.ema50?.toFixed(2)}`
  });

  // RSI
  const rsiLong =
    a.rsi14 !== null &&
    a.rsi14 >=
      trendSuslikConfig.rsi.longMin &&
    a.rsi14 <=
      trendSuslikConfig.rsi.longMax;

  const rsiShort =
    a.rsi14 !== null &&
    a.rsi14 >=
      trendSuslikConfig.rsi.shortMin &&
    a.rsi14 <=
      trendSuslikConfig.rsi.shortMax;

  if (rsiLong) {
    longScore += w.rsi;
  }

  if (rsiShort) {
    shortScore += w.rsi;
  }

  reasons.push({
    label: "RSI подтверждает импульс",
    long: rsiLong,
    short: rsiShort,
    weight: w.rsi,
    value:
      a.rsi14?.toFixed(2)
  });

  // MACD histogram
  const macdLong =
    a.macdHist !== null &&
    a.macdHist > 0;

  const macdShort =
    a.macdHist !== null &&
    a.macdHist < 0;

  if (macdLong) {
    longScore += w.macd;
  }

  if (macdShort) {
    shortScore += w.macd;
  }

  reasons.push({
    label: "Импульс MACD",
    long: macdLong,
    short: macdShort,
    weight: w.macd,
    value:
      a.macdHist?.toFixed(2)
  });

  // Объём не выбирает направление,
  // а только подтверждает лидирующую сторону.
  const volumeConfirmed =
    a.volumeRatio !== null &&
    a.volumeRatio >=
      trendSuslikConfig.volume.minimumRatio;

  const leaderBeforeVolume =
    longScore > shortScore
      ? "LONG"
      : shortScore > longScore
        ? "SHORT"
        : null;

  if (volumeConfirmed) {
    if (leaderBeforeVolume === "LONG") {
      longScore += w.volume;
    }

    if (leaderBeforeVolume === "SHORT") {
      shortScore += w.volume;
    }
  }

  reasons.push({
    label: "Подтверждение объёмом",
    long:
      volumeConfirmed &&
      leaderBeforeVolume === "LONG",
    short:
      volumeConfirmed &&
      leaderBeforeVolume === "SHORT",
    weight: w.volume,
    value:
      a.volumeRatio !== null
        ? `${a.volumeRatio.toFixed(2)}x`
        : undefined
  });

  longScore =
    Math.min(100, longScore);

  shortScore =
    Math.min(100, shortScore);

  let direction: Direction =
    "NEUTRAL";

  if (
    longScore >=
      trendSuslikConfig.minimumSignalScore &&
    longScore > shortScore
  ) {
    direction = "LONG";
  }

  if (
    shortScore >=
      trendSuslikConfig.minimumSignalScore &&
    shortScore > longScore
  ) {
    direction = "SHORT";
  }

  return {
    direction,

    score:
      direction === "LONG"
        ? longScore
        : direction === "SHORT"
          ? shortScore
          : Math.max(
              longScore,
              shortScore
            ),

    longScore,
    shortScore,
    reasons
  };
}
