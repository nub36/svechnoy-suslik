import type { CandleData } from "../exchanges/types";
import { atr, ema, macd, rsi, sma } from "../indicators";

export type MarketAnalysis = {
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

  volume: number;
  avgVolume20: number | null;
  volumeRatio: number | null;
};

/**
 * Periody indikatorov dlya parametricheskogo analiza.
 * Po umolchaniyu sovpadayut s naborom IndicatorSnapshot
 * (ema 20/50/200, rsi 14, macd 12/26/9, atr 14, obyom 20),
 * poetomu analyzeCandlesWithParams bez parametrov
 * daet tot zhe rezultat, chto i analyzeCandles.
 */
export type AnalysisParams = {
  emaFast: number;
  emaMedium: number;
  emaSlow: number;
  rsi: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  atr: number;
  volume: number;
};

export const DEFAULT_ANALYSIS_PARAMS: AnalysisParams = {
  emaFast: 20,
  emaMedium: 50,
  emaSlow: 200,
  rsi: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atr: 14,
  volume: 20
};

/**
 * Skolko zakrytyh svechej nuzhno dlya nabora periodov.
 * RSI i EMA trebuyut period znachenij, MACD —
 * slow + signal, ATR — period + 1 svecha.
 */
export function minCandlesForParams(
  params: AnalysisParams
): number {
  return Math.max(
    params.emaSlow,
    params.rsi + 1,
    params.macdSlow + params.macdSignal,
    params.atr + 1,
    params.volume
  );
}

/**
 * Analiz s proizvolnymi periodami.
 * Ispolzuetsya togda, kogda periody strategii
 * otlichayutsya ot fiksirovannyh periodov
 * IndicatorSnapshot: raschyot idet po zakrytym
 * svecham PostgreSQL, bez obrashcheniya k birzham.
 *
 * Poslednyaya svecha spiska schitaetsya tekuchej,
 * poetomu spisok dolzhen byt otsortirovan
 * ot staryh k novym i soderzhat tolko zakrytye svechi.
 */
export function analyzeCandlesWithParams(
  candles: CandleData[],
  params: AnalysisParams = DEFAULT_ANALYSIS_PARAMS
): MarketAnalysis | null {
  const closed = candles
    .filter((c) => c.closed)
    .sort(
      (a, b) =>
        a.openTime.getTime() -
        b.openTime.getTime()
    );

  if (closed.length < minCandlesForParams(params)) {
    return null;
  }

  const last =
    closed[closed.length - 1];

  const closes =
    closed.map((c) => c.close);

  const volumes =
    closed.map((c) => c.volume);

  const macdResult =
    macd(
      closes,
      params.macdFast,
      params.macdSlow,
      params.macdSignal
    );

  const avgVolume =
    sma(volumes, params.volume);

  const volumeRatio =
    avgVolume !== null &&
    avgVolume > 0
      ? last.volume / avgVolume
      : null;

  return {
    candleTime: last.openTime,
    price: last.close,

    rsi14:
      rsi(closes, params.rsi),

    ema20:
      ema(closes, params.emaFast),

    ema50:
      ema(closes, params.emaMedium),

    ema200:
      ema(closes, params.emaSlow),

    macd:
      macdResult?.macd ?? null,

    macdSignal:
      macdResult?.signal ?? null,

    macdHist:
      macdResult?.histogram ?? null,

    atr14:
      atr(closed, params.atr),

    volume:
      last.volume,

    avgVolume20: avgVolume,
    volumeRatio
  };
}

/**
 * Standartnyj analiz s fiksirovannymi periodami
 * snapshot (20/50/200, 14, 12/26/9, ATR 14, obyom 20).
 * Sohranyaet prezhnee povedenie odin v odin.
 */
export function analyzeCandles(
  candles: CandleData[]
): MarketAnalysis | null {
  return analyzeCandlesWithParams(
    candles,
    DEFAULT_ANALYSIS_PARAMS
  );
}
