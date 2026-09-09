import type {
  MarketAnalysis
} from "../analysis/analyze";
import {
  snapshotActualPeriods,
  type ActualPeriods,
  type TrendSuslikConfig
} from "./config";

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

  /**
   * Nepodtverzhdyonnye nesootvetstviya:
   * naprimer periody EMA v Strategy.config otlichayutsya
   * ot periodov, kotorye fakticheski hranit IndicatorSnapshot.
   * Raschyot pri etom prodolzhaetsya pozicionno
   * (fast -> ema20, medium -> ema50, slow -> ema200),
   * no preduprezhdeniya vidny v CLI i budut vidny v Signal Engine.
   */
  warnings: string[];
};

/**
 * Strategiya «Trendovyj Suslik».
 *
 * VAZHNO:
 * - konfiguraciya prihodit PARAMETROM iz PostgreSQL
 *   (proshhedshaya validateTrendSuslikConfig);
 * - nikakogo hardcoded konfiga vnutri runtime net;
 * - znacheniya indikatorov berutsya iz MarketAnalysis
 *   (v production — iz IndicatorSnapshot);
 * - porogi, vesa i minimumSignalScore — iz config.
 */
export function runTrendSuslik(
  a: MarketAnalysis,
  config: TrendSuslikConfig,
  actualPeriods?: ActualPeriods
): StrategyResult {
  let longScore = 0;
  let shortScore = 0;

  const reasons: StrategyReason[] = [];
  const warnings: string[] = [];

  const w = config.weights;
  const emaPeriods = config.ema;
  const rsiCfg = config.rsi;

  /*
   * Fakticheskie periody analiza: po umolchaniyu —
   * fiksirovannye periody snapshot (staroe povedenie).
   * Esli analiz rasschitan po svecham s periodami
   * config, suda peredayutsya periody config,
   * i warnings ne voznikayut.
   */
  const snap = actualPeriods ?? snapshotActualPeriods();

  if (
    emaPeriods.fast !== snap.emaFast ||
    emaPeriods.medium !== snap.emaMedium ||
    emaPeriods.slow !== snap.emaSlow
  ) {
    warnings.push(
      `EMA periody config (${emaPeriods.fast}/${emaPeriods.medium}/${emaPeriods.slow}) ` +
        `otlichayutsya ot snapshot (${snap.emaFast}/${snap.emaMedium}/${snap.emaSlow}): ` +
        "ispolzovany znacheniya snapshot pozicionno"
    );
  }

  if (rsiCfg.period !== snap.rsi) {
    warnings.push(
      `RSI period config (${rsiCfg.period}) ` +
        `otlichaetsya ot snapshot (${snap.rsi}): ` +
        "ispolzovano znachenie rsi14"
    );
  }

  if (
    config.macd.fast !== snap.macdFast ||
    config.macd.slow !== snap.macdSlow ||
    config.macd.signal !== snap.macdSignal
  ) {
    warnings.push(
      `MACD periody config (${config.macd.fast}/${config.macd.slow}/${config.macd.signal}) ` +
        `otlichayutsya ot snapshot (${snap.macdFast}/${snap.macdSlow}/${snap.macdSignal}): ` +
        "ispolzovano znachenie snapshot"
    );
  }

  if (config.volume.period !== snap.volume) {
    warnings.push(
      `Volume period config (${config.volume.period}) ` +
        `otlichaetsya ot snapshot (${snap.volume}): ` +
        "ispolzovan volumeRatio snapshot"
    );
  }

  /*
   * Snapshot polya (fiks):
   * ema20 -> bystryj, ema50 -> srednij, ema200 -> medlennyj.
   * Podpisi berut periody iz config, chtoby bylo vidno,
   * kakie parametry strategii dejstvovali.
   */
  const emaFastValue = a.ema20;
  const emaMediumValue = a.ema50;
  const emaSlowValue = a.ema200;

  // EMA medium / slow — osnovnoj trend
  const trendLong =
    emaMediumValue !== null &&
    emaSlowValue !== null &&
    emaMediumValue > emaSlowValue &&
    a.price > emaMediumValue;

  const trendShort =
    emaMediumValue !== null &&
    emaSlowValue !== null &&
    emaMediumValue < emaSlowValue &&
    a.price < emaMediumValue;

  if (trendLong) {
    longScore += w.trend;
  }

  if (trendShort) {
    shortScore += w.trend;
  }

  reasons.push({
    label: "Основной тренд EMA medium / slow",
    long: trendLong,
    short: trendShort,
    weight: w.trend,
    value:
      `EMA${emaPeriods.medium} ${emaMediumValue?.toFixed(2) ?? "—"} · ` +
      `EMA${emaPeriods.slow} ${emaSlowValue?.toFixed(2) ?? "—"}`
  });

  // EMA fast / medium — bolee bystryj trend
  const mediumLong =
    emaFastValue !== null &&
    emaMediumValue !== null &&
    emaFastValue > emaMediumValue &&
    a.price > emaFastValue;

  const mediumShort =
    emaFastValue !== null &&
    emaMediumValue !== null &&
    emaFastValue < emaMediumValue &&
    a.price < emaFastValue;

  if (mediumLong) {
    longScore += w.mediumTrend;
  }

  if (mediumShort) {
    shortScore += w.mediumTrend;
  }

  reasons.push({
    label: "Краткосрочный тренд EMA fast / medium",
    long: mediumLong,
    short: mediumShort,
    weight: w.mediumTrend,
    value:
      `EMA${emaPeriods.fast} ${emaFastValue?.toFixed(2) ?? "—"} · ` +
      `EMA${emaPeriods.medium} ${emaMediumValue?.toFixed(2) ?? "—"}`
  });

  // RSI
  const rsiLong =
    a.rsi14 !== null &&
    a.rsi14 >= rsiCfg.longMin &&
    a.rsi14 <= rsiCfg.longMax;

  const rsiShort =
    a.rsi14 !== null &&
    a.rsi14 >= rsiCfg.shortMin &&
    a.rsi14 <= rsiCfg.shortMax;

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
      a.rsi14 !== null
        ? `${a.rsi14.toFixed(2)} ` +
          `(LONG ${rsiCfg.longMin}–${rsiCfg.longMax} · ` +
          `SHORT ${rsiCfg.shortMin}–${rsiCfg.shortMax})`
        : undefined
  });

  /*
   * MACD histogram s myortvoj zonoj:
   * |hist| <= deadZoneRatio * price — shum okolo
   * nulya, ballov ni LONG, ni SHORT.
   * deadZoneRatio = 0 (po umolchaniyu) -> kak ranshe.
   */
  const macdDeadZone =
    config.macd.deadZoneRatio > 0
      ? config.macd.deadZoneRatio *
        Math.abs(a.price)
      : 0;

  const macdLong =
    a.macdHist !== null &&
    a.macdHist > macdDeadZone;

  const macdShort =
    a.macdHist !== null &&
    a.macdHist < -macdDeadZone;

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
      a.macdHist === null
        ? undefined
        : macdDeadZone > 0
          ? `${a.macdHist.toFixed(2)} ` +
            `(myortvaya zona ±${macdDeadZone.toFixed(2)})`
          : a.macdHist.toFixed(2)
  });

  // Obyom ne vybiraet napravlenie,
  // a tolko podtverzhdaet lidiruyushchuyu storonu.
  const volumeConfirmed =
    a.volumeRatio !== null &&
    a.volumeRatio >= config.volume.minimumRatio;

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
        ? `${a.volumeRatio.toFixed(2)}x ` +
          `(мин. ${config.volume.minimumRatio}x)`
        : undefined
  });

  longScore =
    Math.min(100, longScore);

  shortScore =
    Math.min(100, shortScore);

  /*
   * Napravlenie trebuet STROGOGO liderstva:
   * ravenstvo ballov (v tom chisle 0/0 pri
   * minimumSignalScore=0) daet NEUTRAL, a ne sluchajnyj vybor.
   */
  let direction: Direction =
    "NEUTRAL";

  if (
    longScore >= config.minimumSignalScore &&
    longScore > shortScore
  ) {
    direction = "LONG";
  }

  if (
    shortScore >= config.minimumSignalScore &&
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
    reasons,
    warnings
  };
}
