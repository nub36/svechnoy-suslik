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
import { isInTopUniverse } from "../universe";
import type { CandleData } from "../exchanges/types";
import {
  periodsAreStandard,
  configToAnalysisParams,
  type TrendSuslikConfig
} from "./config";
import {
  runTrendSuslik,
  type Direction,
  type StrategyReason
} from "./trend-suslik";
import {
  analyzeCandlesWithParams,
  minCandlesForParams
} from "../analysis/analyze";

/**
 * Minimalnyj nabor, kotoryj runtime zhdyot
 * ot IndicatorSnapshot + Market + Asset.
 */
export type SnapshotInput = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  assetSymbol: string;
  /**
   * Место актива в рейтинге (Asset.rank), null —
   * актив вне рейтинга. Legacy-флаг Asset.top500
   * рантаймом НЕ используется: фильтр top500Only
   * проверяет принадлежность основному ranked
   * universe (Top-100, см. lib/universe.ts).
   */
  assetRank: number | null;
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
  status: "filtered" | "no-snapshot" | "cannot-evaluate";
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
    assetRank: number | null;
    quoteVolume24h: number | null;
  },
  config: TrendSuslikConfig
): string | null {
  // Legacy-поле config.filters.top500Only (имя
  // сохранено для совместимости старых JSON-конфигов):
  // true = «только основной ranked universe», то есть
  // Top-100 по rank (lib/universe.ts), а НЕ флаг
  // Asset.top500.
  if (
    config.filters.top500Only &&
    !isInTopUniverse(input.assetRank)
  ) {
    return (
      "aktiv vne osnovnogo universa Top-100 " +
      "(filtr top500Only: trebuetsya rank 1..100)"
    );
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
 * Sravnenie cen s otnositelnoj tolerancej.
 *
 * input.price (IndicatorSnapshot.price) i computed.price
 * (Candle.close) prohodyat raznye preobrazovaniya
 * PostgreSQL float8 -> JS number v raznyh zaprosah,
 * poetomu strogoe === hrupko. CandleTime pri etom
 * ostaetsya TOCHNYM ogranicheniem, a cena schitaetsya
 * sovpadayushchej pri otnositelnoj pogreshnosti <= 1e-9:
 * okruglenie double dva poryadka menshe, lyuboe realnoe
 * dvizhenie ceny — na mnozhestva bolshe.
 */
export function priceMatches(
  a: number,
  b: number
): boolean {
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b)
  ) {
    return false;
  }

  if (a === b) {
    return true;
  }

  const scale = Math.max(
    Math.abs(a),
    Math.abs(b)
  );

  if (scale === 0) {
    return false;
  }

  return (
    Math.abs(a - b) / scale <= 1e-9
  );
}

function cannotEvaluate(
  input: SnapshotInput,
  reason: string
): SkippedMarket {
  return {
    status: "cannot-evaluate",
    exchange: input.exchange,
    market: input.exchangeSymbol,
    marketId: input.marketId,
    reason
  };
}

/**
 * Nestandartnye periody: raschyot TOLKO po zakrytym
 * svecham s fakticheskimi periodami config.
 *
 * Fiksirovannyj IndicatorSnapshot (RSI14, EMA20/50/200,
 * MACD 12/26/9, ATR14, Volume20) zdes NE ispolzuetsya
 * NI V KAKOM VIDE: pozicionnaya podstanovka znachenij
 * s drugimi periodami dala by lozhnyj scoring.
 *
 * Lyubaya problema s istoriej — net svechej, istorii
 * malo, poslednyaya svecha ne na candleTime snapshot,
 * rashozhdenie ceny, oshibka raschyota — daet
 * "cannot-evaluate": rynok sejchas nelzya chestno
 * otzenit, golosa v agregacii on ne daet.
 */
function evaluateWithCandles(
  input: SnapshotInput,
  config: TrendSuslikConfig,
  candles: CandleData[]
): MarketStrategyResult {
  const params = configToAnalysisParams(config);
  const required = minCandlesForParams(params);

  if (candles.length === 0) {
    return cannotEvaluate(
      input,
      "nestandartnye periody: istoriya zakrytyh svechej " +
        "ne peredana — scoring po fiksirovannomu snapshot " +
        "s drugimi periodami zapreshchyon"
    );
  }

  /*
   * Tolko zakrytye svechi NE POZJE candleTime snapshot.
   * Svechi posle candleTime v raschyote ne uchastvuyut
   * nikogda; analyzeCandlesWithParams dopolnitelno
   * sortiruet istoriyu ot staryh k novym.
   */
  const history = candles
    .filter(
      (c) =>
        c.closed &&
        c.openTime.getTime() <=
          input.candleTime.getTime()
    )
    .sort(
      (a, b) =>
        a.openTime.getTime() -
        b.openTime.getTime()
    );

  if (history.length < required) {
    return cannotEvaluate(
      input,
      `nestandartnye periody: istorii ne hvataet — ` +
        `nuzhno >= ${required} zakrytyh svechej ` +
        `do candleTime, est ${history.length}`
    );
  }

  const computed = analyzeCandlesWithParams(
    history,
    params
  );

  if (!computed) {
    return cannotEvaluate(
      input,
      "nestandartnye periody: raschyot indikatorov nevozmozhen"
    );
  }

  if (
    computed.candleTime.getTime() !==
    input.candleTime.getTime()
  ) {
    return cannotEvaluate(
      input,
      `nestandartnye periody: poslednyaya rasschitannaya ` +
        `svecha ${computed.candleTime.toISOString()} ` +
        `ne sovpadaet s candleTime snapshot ` +
        `${input.candleTime.toISOString()}`
    );
  }

  if (!priceMatches(computed.price, input.price)) {
    return cannotEvaluate(
      input,
      `nestandartnye periody: cena snapshot ${input.price} ` +
        `ne sovpadaet s cenoj svechi ${computed.price} — ` +
        "dannye rassinhronizirovany"
    );
  }

  const result = runTrendSuslik(
    computed,
    config,
    {
      emaFast: config.ema.fast,
      emaMedium: config.ema.medium,
      emaSlow: config.ema.slow,
      rsi: config.rsi.period,
      macdFast: config.macd.fast,
      macdSlow: config.macd.slow,
      macdSignal: config.macd.signal,
      volume: config.volume.period
    }
  );

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
 * Raschyot strategii po odnomu snapshotu (odna birzha).
 *
 * 1) periodsAreStandard(config) === true — znacheniya
 *    berutsya iz IndicatorSnapshot kak ran'she.
 *
 * 2) periodsAreStandard(config) === false — TOLKO closed
 *    candles PostgreSQL + analyzeCandlesWithParams
 *    s fakticheskimi periodami config. Fixed snapshot
 *    dlya scoringa NE ispolzuetsya; pri nedostatke
 *    istorii rynok ottalkivaetsya kak "cannot-evaluate".
 *
 * candles (esli peredany) — istoriya svechej etogo rynka
 * i tajmfrejma, lyuboj poryadok: funkciya sama otbiraet
 * zakrytye svechi do candleTime snapshot.
 */
export function evaluateSnapshot(
  input: SnapshotInput,
  config: TrendSuslikConfig,
  candles?: CandleData[]
): MarketStrategyResult {
  const filterReason = applyStrategyFilters(
    {
      assetRank: input.assetRank,
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

  if (!periodsAreStandard(config)) {
    return evaluateWithCandles(
      input,
      config,
      candles ?? []
    );
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
