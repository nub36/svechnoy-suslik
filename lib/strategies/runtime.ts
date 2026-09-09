/**
 * Strategy Runtime: chistye funkcii bez dostupa k BD.
 *
 * Etot modul NIKOGDA ne importit Prisma i ne hodit v set.
 * On poluchaet gotovye dannye (snapshot + rynok + aktiv),
 * proverennyj config i vozvrashchaet rezultat birzhi
 * i agregaciyu po aktivu.
 *
 * Zagruzka iz PostgreSQL zhivyot v CLI-skriptah,
 * poetomu eti zhe funkcii testiruyutsya v self-test
 * bez bazy odin v odin s prod-putyom.
 */

import type {
  MarketAnalysis
} from "../analysis/analyze";
import type {
  TrendSuslikConfig
} from "./config";
import {
  runTrendSuslik,
  type Direction,
  type StrategyReason
} from "./trend-suslik";

/**
 * Minimalnyj nabor, kotoryj runtime zhdyot
 * ot IndicatorSnapshot + Market + Asset.
 */
export type SnapshotInput = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  assetSymbol: string;
  assetTop500: boolean;
  quoteVolume24h: number | null;

  timeframe: string;
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

export type EvaluatedMarket = {
  status: "evaluated";
  exchange: string;
  market: string;
  marketId: number;
  candleTime: Date;
  price: number;
  longScore: number;
  shortScore: number;
  direction: Direction;
  reasons: StrategyReason[];
  warnings: string[];
};

export type SkippedMarket = {
  status: "filtered" | "no-snapshot";
  exchange: string;
  market: string;
  marketId: number;
  reason: string;
};

export type MarketStrategyResult =
  | EvaluatedMarket
  | SkippedMarket;

export type AssetAggregation = {
  asset: string;
  timeframe: string;
  strategySlug: string;
  strategyVersion: number;

  direction: Direction;
  conflict: boolean;

  longVotes: number;
  shortVotes: number;
  neutralVotes: number;
  evaluated: number;
  skipped: number;

  /** Naprimer "4/5". */
  confirmation: string;
  minExchanges: number;

  explanation: string;
  markets: MarketStrategyResult[];
};

/**
 * Filtry iz Strategy.config.filters.
 * Vozvrashchaet prichinu otseva ili null, esli mozhno schitat.
 */
export function applyStrategyFilters(
  input: {
    assetTop500: boolean;
    quoteVolume24h: number | null;
  },
  config: TrendSuslikConfig
): string | null {
  if (
    config.filters.top500Only &&
    !input.assetTop500
  ) {
    return "aktiv vne Top-500 (filtr top500Only)";
  }

  const volume = input.quoteVolume24h ?? 0;

  if (
    volume <
    config.filters.minimumQuoteVolume24h
  ) {
    return (
      `obyom 24ch ${volume.toFixed(0)} USDT ` +
      `nizhe minimuma ${config.filters.minimumQuoteVolume24h}`
    );
  }

  return null;
}

export function snapshotToAnalysis(
  input: SnapshotInput
): MarketAnalysis {
  return {
    candleTime: input.candleTime,
    price: input.price,
    rsi14: input.rsi14,
    ema20: input.ema20,
    ema50: input.ema50,
    ema200: input.ema200,
    macd: input.macd,
    macdSignal: input.macdSignal,
    macdHist: input.macdHist,
    atr14: input.atr14,
    volume: input.volume ?? 0,
    avgVolume20: input.avgVolume20,
    volumeRatio: input.volumeRatio
  };
}

/**
 * Raschyot strategii po odnomu snapshotu (odna birzha).
 */
export function evaluateSnapshot(
  input: SnapshotInput,
  config: TrendSuslikConfig
): MarketStrategyResult {
  const filterReason = applyStrategyFilters(
    {
      assetTop500: input.assetTop500,
      quoteVolume24h: input.quoteVolume24h
    },
    config
  );

  if (filterReason) {
    return {
      status: "filtered",
      exchange: input.exchange,
      market: input.exchangeSymbol,
      marketId: input.marketId,
      reason: filterReason
    };
  }

  const analysis = snapshotToAnalysis(input);
  const result = runTrendSuslik(analysis, config);

  return {
    status: "evaluated",
    exchange: input.exchange,
    market: input.exchangeSymbol,
    marketId: input.marketId,
    candleTime: input.candleTime,
    price: input.price,
    longScore: result.longScore,
    shortScore: result.shortScore,
    direction: result.direction,
    reasons: result.reasons,
    warnings: result.warnings
  };
}

/**
 * Multibirzhevoe podtverzhdenie po aktivu:
 * Asset + timeframe + Strategy slug + version.
 *
 * - LONG/SHORT trebuet >= minExchanges golosov;
 * - esli porog odnovremenno vzyali LONG i SHORT —
 *   eto KONFLIKT: napravlenie ne vydumyvaem,
 *   vozvrashchaem NEUTRAL s oby'asneniem;
 * - propushchennye rynki (filtry / net snapshot)
 *   v golosovanii ne uchastvuyut.
 */
export function aggregateAssetGroup(
  asset: string,
  timeframe: string,
  strategySlug: string,
  strategyVersion: number,
  markets: MarketStrategyResult[],
  minExchanges: number
): AssetAggregation {
  const evaluated = markets.filter(
    (
      m
    ): m is EvaluatedMarket =>
      m.status === "evaluated"
  );

  const longVotes = evaluated.filter(
    (m) => m.direction === "LONG"
  ).length;

  const shortVotes = evaluated.filter(
    (m) => m.direction === "SHORT"
  ).length;

  const neutralVotes = evaluated.filter(
    (m) => m.direction === "NEUTRAL"
  ).length;

  const total = evaluated.length;
  const skipped = markets.length - total;

  const longOk = longVotes >= minExchanges;
  const shortOk = shortVotes >= minExchanges;

  let direction: Direction = "NEUTRAL";
  let conflict = false;
  let confirmation = `0/${total}`;
  let explanation: string;

  if (total === 0) {
    explanation =
      "net ocenennyh rynkov: vse otseyany filtrami " +
      "ili bez snapshotov";
  } else if (longOk && shortOk) {
    conflict = true;
    confirmation =
      `LONG ${longVotes}/${total} · ` +
      `SHORT ${shortVotes}/${total}`;
    explanation =
      `KONFLIKT: LONG (${longVotes}) i SHORT (${shortVotes}) ` +
      `odnovremenno nabrali porog ${minExchanges}. ` +
      "Napravlenie ne opredeleno, nuzhen ruchnoj razbor.";
  } else if (longOk) {
    direction = "LONG";
    confirmation = `${longVotes}/${total}`;
    explanation =
      `LONG podtverzhdyon: ${longVotes} iz ${total} ` +
      `(porog ${minExchanges})`;
  } else if (shortOk) {
    direction = "SHORT";
    confirmation = `${shortVotes}/${total}`;
    explanation =
      `SHORT podtverzhdyon: ${shortVotes} iz ${total} ` +
      `(porog ${minExchanges})`;
  } else {
    const best = Math.max(longVotes, shortVotes);
    confirmation = `${best}/${total}`;
    explanation =
      `podtverzhdeniya net: LONG ${longVotes}, ` +
      `SHORT ${shortVotes}, NEUTRAL ${neutralVotes} ` +
      `pri poroge ${minExchanges}`;
  }

  return {
    asset,
    timeframe,
    strategySlug,
    strategyVersion,
    direction,
    conflict,
    longVotes,
    shortVotes,
    neutralVotes,
    evaluated: total,
    skipped,
    confirmation,
    minExchanges,
    explanation,
    markets
  };
}
