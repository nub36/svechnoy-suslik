/**
 * Signal Engine: chistye funkcii bez dostupa k BD i seti.
 *
 * Etot modul NIKOGDA ne importit Prisma i ne hodit v set
 * (proveryaetsya samotestom po tekstu faila).
 *
 * Vhod:
 * - agregaciya multibirzhevogo podtverzhdeniya iz runtime
 *   (AssetAggregation);
 * - proverennyj config strategii (validateTrendSuslikConfig);
 * - snapshoty uchastvovavshih rynkov (dlya ATR i indikatorov);
 * - vremya poslednego signala po rynku (dlya cooldown).
 *
 * Vyhod: chernoviki signalov (SignalDraft) i prichiny otkazov.
 * Zapis v BD zhivet tolko v scripts/signal-worker.ts (--apply).
 *
 * POMNI (pravilo proekta): score — sila sovpadeniya uslovij
 * strategii (0..100), a NE veroyatnost uspeshnoj sdelki.
 */

import type { StrategyReason } from "../strategies/trend-suslik";
import {
  type TrendSuslikAtr,
  type TrendSuslikConfig
} from "../strategies/config";
import type {
  AssetAggregation,
  MarketStrategyResult,
  SnapshotInput
} from "../strategies/runtime";

/**
 * Dlitelnost svechi v millisekundah.
 * Tolko razreshennye config timeframes (5m..1d).
 */
const TIMEFRAME_MS: Record<string, number> = {
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "4h": 4 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000
};

export function timeframeMs(timeframe: string): number | null {
  return TIMEFRAME_MS[timeframe] ?? null;
}

export type RiskLevels = {
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
};

/**
 * SL/TP cherez ATR multipliers iz config strategii.
 *
 * LONG:  SL pod cenoj,  TP nad cenoj.
 * SHORT: SL nad cenoj,  TP pod cenoj.
 *
 * Esli ATR net (null / <= 0 / ne chislo) — urovni NE vydumyvayutsya:
 * vozvrashchayutsya null, a planirovshchik otkazet v signale.
 */
export function computeRiskLevels(
  direction: "LONG" | "SHORT",
  entry: number,
  atr14: number | null,
  atrCfg: TrendSuslikAtr
): RiskLevels {
  const empty: RiskLevels = {
    stopLoss: null,
    takeProfit1: null,
    takeProfit2: null,
    takeProfit3: null
  };

  if (
    atr14 === null ||
    !Number.isFinite(atr14) ||
    atr14 <= 0 ||
    !Number.isFinite(entry)
  ) {
    return empty;
  }

  const sign = direction === "LONG" ? 1 : -1;

  return {
    stopLoss:
      entry - sign * atrCfg.stopMultiplier * atr14,

    takeProfit1:
      entry + sign * atrCfg.takeProfit1Multiplier * atr14,

    takeProfit2:
      entry + sign * atrCfg.takeProfit2Multiplier * atr14,

    takeProfit3:
      entry + sign * atrCfg.takeProfit3Multiplier * atr14
  };
}

/**
 * Zakryta li svecha na moment `now`.
 * Neizvestnyj tajmfrejm schitaetsya NE zakrytoj
 * (engine ne rabotaet s tem, chego ne ponimaet).
 */
export function isCandleClosed(
  candleTime: Date,
  timeframe: string,
  now: Date
): boolean {
  const tf = timeframeMs(timeframe);

  if (tf === null) {
    return false;
  }

  return (
    candleTime.getTime() + tf <= now.getTime()
  );
}

/**
 * cooldown iz config.execution.cooldownCandles:
 * skolko svechej posle poslednego signala nado propustit.
 *
 * true = signal sejchas NELZYA.
 * cooldownCandles <= 0 — cooldown vyklyuchen.
 * Kandidat RANSHE poslednego signala tozhe zapreshen
 * (zapreshchaem rabotat s ustarevshim snapshotom).
 */
export function isCooldownActive(
  lastSignalCandleTime: Date,
  candidateCandleTime: Date,
  timeframe: string,
  cooldownCandles: number
): boolean {
  if (cooldownCandles <= 0) {
    return false;
  }

  const tf = timeframeMs(timeframe);

  if (tf === null) {
    return true;
  }

  const diff =
    candidateCandleTime.getTime() -
    lastSignalCandleTime.getTime();

  return diff < cooldownCandles * tf;
}

/**
 * Znacheniya indikatorov v moment signala
 * (kopiya iz IndicatorSnapshot, dlya indicatorsJson).
 */
export type SignalIndicators = {
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

export type SignalDraft = {
  strategyId: number;
  strategySlug: string;
  strategyVersion: number;
  symbol: string;
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  score: number;
  entry: number;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  atr14: number | null;
  reason: string;
  reasons: StrategyReason[];
  warnings: string[];
  indicators: SignalIndicators;
  candleTime: Date;
};

export type SkippedMarketRecord = {
  exchange: string;
  market: string;
  marketId: number;
  reason: string;
};

export type PlanSignalsInput = {
  aggregation: AssetAggregation;
  config: TrendSuslikConfig;
  strategyId: number;
  strategySlug: string;
  symbol: string;
  now: Date;

  /** Snapshoty po marketId (dlya ATR i indikatorov). */
  snapshotByMarketId: Map<number, SnapshotInput>;

  /**
   * Vremya svechi POSLEDNEGO signala
   * etoj strategii + rynok + timeframe + napravlenie.
   */
  lastSignalCandleTimeByMarketId: Map<number, Date>;

  /**
   * Klyuchi uzhe sushchestvuyushchih signalov v BD:
   * `${marketId}|${candleTime.toISOString()}|${direction}`.
   * Zashchita ot dublej do zapisi (v BD est eshe i UNIQUE).
   */
  existingKeys: Set<string>;
};

export type PlanSignalsResult = {
  planned: SignalDraft[];
  skipped: SkippedMarketRecord[];

  /**
   * Globalnaya prichina otkaza (NEUTRAL / konflikt /
   * neizvestnyj tajmfrejm). null esli planirovanie rabotalo.
   */
  globalReason: string | null;
};

export function signalKey(
  marketId: number,
  candleTime: Date,
  direction: string
): string {
  return (
    `${marketId}|${candleTime.toISOString()}|` +
    `${direction}`
  );
}

/**
 * Glavnaya funkciya engine: iz agregacii — chernoviki signalov.
 *
 * Pravila:
 * - signaly sozdayutsya TOLKO pri podtverzhdennom napravlenii
 *   (LONG ili SHORT); NEUTRAL i KONFLIKT — signalov net;
 * - signal poluchaet tolko rynok, kotoryj SAM progolosoval
 *   za podtverzhdennoe napravlenie;
 * - uchityvayutsya execution.closedCandleOnly
 *   i execution.cooldownCandles iz config;
 * - bez ATR14 signal NE sozdaetsya: SL/TP ne vydumyvaem;
 * - dubli otseivayutsya po existingKeys
 *   (i dubliruyutsya UNIQUE v BD pri zapisi).
 */
export function planSignals(
  input: PlanSignalsInput
): PlanSignalsResult {
  const {
    aggregation,
    config,
    strategyId,
    strategySlug,
    symbol,
    now,
    snapshotByMarketId,
    lastSignalCandleTimeByMarketId,
    existingKeys
  } = input;

  const planned: SignalDraft[] = [];
  const skipped: SkippedMarketRecord[] = [];

  if (
    aggregation.direction !== "LONG" &&
    aggregation.direction !== "SHORT"
  ) {
    return {
      planned,
      skipped,
      globalReason:
        aggregation.conflict
          ? aggregation.explanation
          : `signalov net: ${aggregation.explanation}`
    };
  }

  const direction = aggregation.direction;
  const tf = timeframeMs(aggregation.timeframe);

  if (tf === null) {
    return {
      planned,
      skipped,
      globalReason:
        `neizvestnyj tajmfrejm ` +
        `${aggregation.timeframe}: signalov net`
    };
  }

  for (const m of aggregation.markets) {
    const record: SkippedMarketRecord = {
      exchange: m.exchange,
      market: m.market,
      marketId: m.marketId,
      reason: ""
    };

    if (m.status !== "evaluated") {
      record.reason = m.reason;
      skipped.push(record);
      continue;
    }

    if (m.direction !== direction) {
      record.reason =
        `rynok dal ${m.direction}, ` +
        `podtverzhdeno ${direction}: signal ne nuzhen`;
      skipped.push(record);
      continue;
    }

    const snap = snapshotByMarketId.get(m.marketId);

    if (!snap) {
      record.reason =
        "net snapshot dlya raschyota urovnej riska";
      skipped.push(record);
      continue;
    }

    if (
      config.execution.closedCandleOnly &&
      !isCandleClosed(m.candleTime, aggregation.timeframe, now)
    ) {
      record.reason =
        "svecha eshyo ne zakryta " +
        "(execution.closedCandleOnly)";
      skipped.push(record);
      continue;
    }

    const lastSignal =
      lastSignalCandleTimeByMarketId.get(m.marketId);

    if (
      lastSignal &&
      isCooldownActive(
        lastSignal,
        m.candleTime,
        aggregation.timeframe,
        config.execution.cooldownCandles
      )
    ) {
      record.reason =
        `cooldown ${config.execution.cooldownCandles} svechej: ` +
        `poslednij signal ${lastSignal.toISOString()}`;
      skipped.push(record);
      continue;
    }

    const atr14 = snap.atr14;

    if (
      atr14 === null ||
      !Number.isFinite(atr14) ||
      atr14 <= 0
    ) {
      record.reason =
        "net ATR14: SL/TP ne rasschitat, " +
        "signal bez urovnej riska ne sozdaetsya";
      skipped.push(record);
      continue;
    }

    const key = signalKey(
      m.marketId,
      m.candleTime,
      direction
    );

    if (existingKeys.has(key)) {
      record.reason =
        "signal uzhe est v BD " +
        "(strategy version + market + timeframe + " +
        "candleTime + direction)";
      skipped.push(record);
      continue;
    }

    const risk = computeRiskLevels(
      direction,
      m.price,
      atr14,
      config.atr
    );

    const score =
      direction === "LONG"
        ? m.longScore
        : m.shortScore;

    const reason =
      `${direction} ${aggregation.confirmation} birzh ` +
      `(porog ${aggregation.minExchanges}) · ` +
      `score ${score} · ${aggregation.explanation}`;

    planned.push({
      strategyId,
      strategySlug,
      strategyVersion: aggregation.strategyVersion,
      symbol,
      marketId: m.marketId,
      exchange: m.exchange,
      exchangeSymbol: m.market,
      timeframe: aggregation.timeframe,
      direction,
      score,
      entry: m.price,
      stopLoss: risk.stopLoss,
      takeProfit1: risk.takeProfit1,
      takeProfit2: risk.takeProfit2,
      takeProfit3: risk.takeProfit3,
      atr14,
      reason,
      reasons: m.reasons,
      warnings: m.warnings,
      indicators: {
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
      },
      candleTime: m.candleTime
    });
  }

  return {
    planned,
    skipped,
    globalReason: null
  };
}

/**
 * Dlya auditov: tip ispolzuetsya testami i workerom,
 * chtoby sluchajno ne rasshivat kontrakt MarketStrategyResult.
 */
export type EngineMarketResult = MarketStrategyResult;
