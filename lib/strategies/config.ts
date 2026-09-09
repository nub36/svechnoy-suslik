/**
 * Tipizirovannaya konfiguraciya strategii «Trendovyi Suslik»
 * i strogaya validaciya Strategy.config iz PostgreSQL.
 *
 * Pravilo arhitektury:
 * runtime NIKOGDA ne chitaet Strategy.config napryamuyu.
 * Snachala validateTrendSuslikConfig(), tolko potom raschyot.
 *
 * Naturnye kommentarii zdes na translitre soznatelno:
 * etot fail chitaetsya i iz testovyh CLI-skriptov.
 */

import type { AnalysisParams } from "../analysis/analyze";

export type TrendSuslikWeights = {
  trend: number;
  mediumTrend: number;
  rsi: number;
  macd: number;
  volume: number;
};

export type TrendSuslikEma = {
  fast: number;
  medium: number;
  slow: number;
};

export type TrendSuslikRsi = {
  period: number;
  longMin: number;
  longMax: number;
  shortMin: number;
  shortMax: number;
};

export type TrendSuslikMacd = {
  fast: number;
  slow: number;
  signal: number;

  /**
   * Myortvaya zona MACD: dolya ot ceny.
   * |histogram| <= deadZoneRatio * price ne dayet
   * ballov ni LONG, ni SHORT (slabyj shum ryadom
   * s nulem ne schitaetsya impul'som).
   * 0 = zona vyklyuchena (staroe povedenie).
   */
  deadZoneRatio: number;
};

export type TrendSuslikAtr = {
  period: number;
  stopMultiplier: number;
  takeProfit1Multiplier: number;
  takeProfit2Multiplier: number;
  takeProfit3Multiplier: number;
};

export type TrendSuslikVolume = {
  period: number;
  minimumRatio: number;
};

export type TrendSuslikExecution = {
  closedCandleOnly: boolean;
  cooldownCandles: number;
};

export type TrendSuslikFilters = {
  minimumQuoteVolume24h: number;

  /**
   * Legacy-имя поля (production JSON-конфиги уже
   * существуют в БД — переименование запрещено).
   * Семантика со ЭТАПА A-fix: true = анализировать
   * только основной ranked universe проекта (Top-100
   * по Asset.rank, lib/universe.ts), а НЕ флаг
   * Asset.top500.
   */
  top500Only: boolean;
};

export type TrendSuslikConfig = {
  minimumSignalScore: number;
  weights: TrendSuslikWeights;
  ema: TrendSuslikEma;
  rsi: TrendSuslikRsi;
  macd: TrendSuslikMacd;
  atr: TrendSuslikAtr;
  volume: TrendSuslikVolume;
  execution: TrendSuslikExecution;
  filters: TrendSuslikFilters;
};

/**
 * Periody indikatorov, kotorie fakticheski hranit IndicatorSnapshot.
 *
 * Snapshot sejchas soderzhit fiksirovannyi nabor:
 * ema20 / ema50 / ema200, rsi14, macd(12,26,9),
 * atr14, srednij obyom za 20 svechej.
 *
 * Runtime ispolzuet eti znacheniya pozicionno:
 * config.ema.fast -> ema20, medium -> ema50, slow -> ema200.
 * Esli periody v Strategy.config otlichayutsya,
 * runtime prodolzhaet rabotu, no vozvrashchaet warnings.
 * Proizvolnye periody potrebuyut rasshireniya shemy snapshotov.
 */
export const SNAPSHOT_INDICATOR_PERIODS = {
  emaFast: 20,
  emaMedium: 50,
  emaSlow: 200,
  rsi: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  atr: 14,
  volume: 20
} as const;

export const ALLOWED_TIMEFRAMES = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
] as const;

export type AllowedTimeframe =
  (typeof ALLOWED_TIMEFRAMES)[number];

/**
 * Fakticheskie periody, s kotorymi schitalas poverty
 * analiz (snapshot ili raschyot po svecham).
 * Ispolzuetsya dlya chestnyh warnings:
 * net preduprezhdenij, kogda periody sovpadayut.
 */
export type ActualPeriods = {
  emaFast: number;
  emaMedium: number;
  emaSlow: number;
  rsi: number;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  volume: number;
};

/** Fiksirovannye periody snapshot v vide ActualPeriods. */
export function snapshotActualPeriods(): ActualPeriods {
  const snap = SNAPSHOT_INDICATOR_PERIODS;

  return {
    emaFast: snap.emaFast,
    emaMedium: snap.emaMedium,
    emaSlow: snap.emaSlow,
    rsi: snap.rsi,
    macdFast: snap.macdFast,
    macdSlow: snap.macdSlow,
    macdSignal: snap.macdSignal,
    volume: snap.volume
  };
}

/** Periody strategii v vide AnalysisParams dlya raschyota po svecham. */
export function configToAnalysisParams(
  config: TrendSuslikConfig
): AnalysisParams {
  return {
    emaFast: config.ema.fast,
    emaMedium: config.ema.medium,
    emaSlow: config.ema.slow,
    rsi: config.rsi.period,
    macdFast: config.macd.fast,
    macdSlow: config.macd.slow,
    macdSignal: config.macd.signal,
    atr: config.atr.period,
    volume: config.volume.period
  };
}

/**
 * Vse periody strategii sovpadayut s fiksirovannym
 * naborom IndicatorSnapshot? Esli da — znacheniya
 * berutsya napryamuyu iz snapshot, sviechi ne nuzhny.
 */
export function periodsAreStandard(
  config: TrendSuslikConfig
): boolean {
  const snap = SNAPSHOT_INDICATOR_PERIODS;

  return (
    config.ema.fast === snap.emaFast &&
    config.ema.medium === snap.emaMedium &&
    config.ema.slow === snap.emaSlow &&
    config.rsi.period === snap.rsi &&
    config.macd.fast === snap.macdFast &&
    config.macd.slow === snap.macdSlow &&
    config.macd.signal === snap.macdSignal &&
    config.atr.period === snap.atr &&
    config.volume.period === snap.volume
  );
}

export type ConfigValidationResult =
  | { ok: true; config: TrendSuslikConfig }
  | { ok: false; errors: string[] };

export type StrategyRuntimeValidation =
  | {
      ok: true;
      config: TrendSuslikConfig;
      timeframes: string[];
      minExchanges: number;
    }
  | { ok: false; errors: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isFiniteNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value)
  );
}

function isInteger(value: unknown): value is number {
  return (
    isFiniteNumber(value) &&
    Number.isInteger(value)
  );
}

function checkNumber(
  errors: string[],
  section: string,
  field: string,
  value: unknown,
  opts: {
    min?: number;
    max?: number;
    integer?: boolean;
    gtZero?: boolean;
  }
): number | null {
  const label = `${section}.${field}`;

  if (!isFiniteNumber(value)) {
    errors.push(`${label}: ozhidaetsya chislo`);
    return null;
  }

  if (opts.integer && !Number.isInteger(value)) {
    errors.push(`${label}: ozhidaetsya celoe chislo`);
    return null;
  }

  if (opts.gtZero && value <= 0) {
    errors.push(`${label}: dolzhno byt > 0`);
    return null;
  }

  if (opts.min !== undefined && value < opts.min) {
    errors.push(
      `${label}: dolzhno byt >= ${opts.min}`
    );
    return null;
  }

  if (opts.max !== undefined && value > opts.max) {
    errors.push(
      `${label}: dolzhno byt <= ${opts.max}`
    );
    return null;
  }

  return value;
}

function checkBoolean(
  errors: string[],
  section: string,
  field: string,
  value: unknown
): boolean | null {
  if (typeof value !== "boolean") {
    errors.push(
      `${section}.${field}: ozhidaetsya boolean`
    );
    return null;
  }

  return value;
}

/**
 * Strogaya validaciya Strategy.config.
 * Lishnie neizvestnye klyuchi razresheny (forward-compat),
 * vse obyazatelnye polya proveryayutsya.
 */
export function validateTrendSuslikConfig(
  raw: unknown
): ConfigValidationResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return {
      ok: false,
      errors: ["config: ozhidaetsya JSON-obekt"]
    };
  }

  const minimumSignalScore = checkNumber(
    errors,
    "config",
    "minimumSignalScore",
    raw.minimumSignalScore,
    { min: 0, max: 100 }
  );

  // ---- weights ----
  let weights: TrendSuslikWeights | null = null;

  if (!isRecord(raw.weights)) {
    errors.push("weights: ozhidaetsya obekt");
  } else {
    const trend = checkNumber(
      errors, "weights", "trend",
      raw.weights.trend, { min: 0, max: 100 }
    );
    const mediumTrend = checkNumber(
      errors, "weights", "mediumTrend",
      raw.weights.mediumTrend, { min: 0, max: 100 }
    );
    const rsi = checkNumber(
      errors, "weights", "rsi",
      raw.weights.rsi, { min: 0, max: 100 }
    );
    const macd = checkNumber(
      errors, "weights", "macd",
      raw.weights.macd, { min: 0, max: 100 }
    );
    const volume = checkNumber(
      errors, "weights", "volume",
      raw.weights.volume, { min: 0, max: 100 }
    );

    if (
      trend !== null &&
      mediumTrend !== null &&
      rsi !== null &&
      macd !== null &&
      volume !== null
    ) {
      if (trend + mediumTrend + rsi + macd + volume <= 0) {
        errors.push(
          "weights: summa vesov dolzhna byt > 0"
        );
      } else {
        weights = {
          trend,
          mediumTrend,
          rsi,
          macd,
          volume
        };
      }
    }
  }

  // ---- ema ----
  let ema: TrendSuslikEma | null = null;

  if (!isRecord(raw.ema)) {
    errors.push("ema: ozhidaetsya obekt");
  } else {
    const fast = checkNumber(
      errors, "ema", "fast",
      raw.ema.fast, { integer: true, gtZero: true }
    );
    const medium = checkNumber(
      errors, "ema", "medium",
      raw.ema.medium, { integer: true, gtZero: true }
    );
    const slow = checkNumber(
      errors, "ema", "slow",
      raw.ema.slow, { integer: true, gtZero: true }
    );

    if (fast !== null && medium !== null && slow !== null) {
      if (!(fast < medium && medium < slow)) {
        errors.push(
          "ema: dolzhno byt fast < medium < slow"
        );
      } else {
        ema = { fast, medium, slow };
      }
    }
  }

  // ---- rsi ----
  let rsi: TrendSuslikRsi | null = null;

  if (!isRecord(raw.rsi)) {
    errors.push("rsi: ozhidaetsya obekt");
  } else {
    const period = checkNumber(
      errors, "rsi", "period",
      raw.rsi.period, { integer: true, gtZero: true }
    );
    const longMin = checkNumber(
      errors, "rsi", "longMin",
      raw.rsi.longMin, { min: 0, max: 100 }
    );
    const longMax = checkNumber(
      errors, "rsi", "longMax",
      raw.rsi.longMax, { min: 0, max: 100 }
    );
    const shortMin = checkNumber(
      errors, "rsi", "shortMin",
      raw.rsi.shortMin, { min: 0, max: 100 }
    );
    const shortMax = checkNumber(
      errors, "rsi", "shortMax",
      raw.rsi.shortMax, { min: 0, max: 100 }
    );

    if (
      period !== null &&
      longMin !== null &&
      longMax !== null &&
      shortMin !== null &&
      shortMax !== null
    ) {
      if (longMin > longMax) {
        errors.push(
          "rsi: longMin dolzhen byt <= longMax"
        );
      }

      if (shortMin > shortMax) {
        errors.push(
          "rsi: shortMin dolzhen byt <= shortMax"
        );
      }

      if (longMin <= longMax && shortMin <= shortMax) {
        rsi = {
          period,
          longMin,
          longMax,
          shortMin,
          shortMax
        };
      }
    }
  }

  // ---- macd ----
  let macd: TrendSuslikMacd | null = null;

  if (!isRecord(raw.macd)) {
    errors.push("macd: ozhidaetsya obekt");
  } else {
    const fast = checkNumber(
      errors, "macd", "fast",
      raw.macd.fast, { integer: true, gtZero: true }
    );
    const slow = checkNumber(
      errors, "macd", "slow",
      raw.macd.slow, { integer: true, gtZero: true }
    );
    const signal = checkNumber(
      errors, "macd", "signal",
      raw.macd.signal, { integer: true, gtZero: true }
    );

    /*
     * Myortvaya zona neobyazatel'na dlya obratnoj
     * sovmestimosti s konfigami v BD, kotorye byli
     * sozdany bez etogo polya: otsutstvuet -> 0.
     */
    let deadZoneRatio = 0;

    if (raw.macd.deadZoneRatio !== undefined) {
      const dz = checkNumber(
        errors,
        "macd",
        "deadZoneRatio",
        raw.macd.deadZoneRatio,
        { min: 0, max: 0.1 }
      );

      if (dz !== null) {
        deadZoneRatio = dz;
      }
    }

    if (
      fast !== null &&
      slow !== null &&
      signal !== null
    ) {
      macd = { fast, slow, signal, deadZoneRatio };
    }
  }

  // ---- atr ----
  let atr: TrendSuslikAtr | null = null;

  if (!isRecord(raw.atr)) {
    errors.push("atr: ozhidaetsya obekt");
  } else {
    const period = checkNumber(
      errors, "atr", "period",
      raw.atr.period, { integer: true, gtZero: true }
    );
    const stopMultiplier = checkNumber(
      errors, "atr", "stopMultiplier",
      raw.atr.stopMultiplier, { gtZero: true }
    );
    const takeProfit1Multiplier = checkNumber(
      errors, "atr", "takeProfit1Multiplier",
      raw.atr.takeProfit1Multiplier, { gtZero: true }
    );
    const takeProfit2Multiplier = checkNumber(
      errors, "atr", "takeProfit2Multiplier",
      raw.atr.takeProfit2Multiplier, { gtZero: true }
    );
    const takeProfit3Multiplier = checkNumber(
      errors, "atr", "takeProfit3Multiplier",
      raw.atr.takeProfit3Multiplier, { gtZero: true }
    );

    if (
      period !== null &&
      stopMultiplier !== null &&
      takeProfit1Multiplier !== null &&
      takeProfit2Multiplier !== null &&
      takeProfit3Multiplier !== null
    ) {
      atr = {
        period,
        stopMultiplier,
        takeProfit1Multiplier,
        takeProfit2Multiplier,
        takeProfit3Multiplier
      };
    }
  }

  // ---- volume ----
  let volume: TrendSuslikVolume | null = null;

  if (!isRecord(raw.volume)) {
    errors.push("volume: ozhidaetsya obekt");
  } else {
    const period = checkNumber(
      errors, "volume", "period",
      raw.volume.period, { integer: true, gtZero: true }
    );
    const minimumRatio = checkNumber(
      errors, "volume", "minimumRatio",
      raw.volume.minimumRatio, { min: 0 }
    );

    if (period !== null && minimumRatio !== null) {
      volume = { period, minimumRatio };
    }
  }

  // ---- execution ----
  let execution: TrendSuslikExecution | null = null;

  if (!isRecord(raw.execution)) {
    errors.push("execution: ozhidaetsya obekt");
  } else {
    const closedCandleOnly = checkBoolean(
      errors,
      "execution",
      "closedCandleOnly",
      raw.execution.closedCandleOnly
    );
    const cooldownCandles = checkNumber(
      errors, "execution", "cooldownCandles",
      raw.execution.cooldownCandles,
      { integer: true, min: 0 }
    );

    if (
      closedCandleOnly !== null &&
      cooldownCandles !== null
    ) {
      execution = {
        closedCandleOnly,
        cooldownCandles
      };
    }
  }

  // ---- filters ----
  let filters: TrendSuslikFilters | null = null;

  if (!isRecord(raw.filters)) {
    errors.push("filters: ozhidaetsya obekt");
  } else {
    const minimumQuoteVolume24h = checkNumber(
      errors, "filters", "minimumQuoteVolume24h",
      raw.filters.minimumQuoteVolume24h, { min: 0 }
    );
    const top500Only = checkBoolean(
      errors,
      "filters",
      "top500Only",
      raw.filters.top500Only
    );

    if (
      minimumQuoteVolume24h !== null &&
      top500Only !== null
    ) {
      filters = {
        minimumQuoteVolume24h,
        top500Only
      };
    }
  }

  if (
    errors.length > 0 ||
    minimumSignalScore === null ||
    weights === null ||
    ema === null ||
    rsi === null ||
    macd === null ||
    atr === null ||
    volume === null ||
    execution === null ||
    filters === null
  ) {
    return {
      ok: false,
      errors:
        errors.length > 0
          ? errors
          : ["config: neizvestnaya oshibka validacii"]
    };
  }

  return {
    ok: true,
    config: {
      minimumSignalScore,
      weights,
      ema,
      rsi,
      macd,
      atr,
      volume,
      execution,
      filters
    }
  };
}

/**
 * Validaciya vsego, chto nuzhno runtime ot stroki Strategy:
 * config (JSON) + timeframes + minExchanges.
 *
 * enabled/status proveryaet zagruzchik (tolko enabled + PUBLISHED).
 */
export function validateStrategyRuntime(input: {
  config: unknown;
  timeframes: unknown;
  minExchanges: unknown;
}): StrategyRuntimeValidation {
  const errors: string[] = [];

  const configResult = validateTrendSuslikConfig(
    input.config
  );

  if (!configResult.ok) {
    errors.push(...configResult.errors);
  }

  let timeframes: string[] | null = null;

  if (
    !Array.isArray(input.timeframes) ||
    input.timeframes.length === 0
  ) {
    errors.push(
      "timeframes: nuzhen neaustoj spisok tajmfrejmov"
    );
  } else {
    const allowed = new Set<string>([
      ...ALLOWED_TIMEFRAMES
    ]);

    const bad = input.timeframes.filter(
      (tf): boolean =>
        typeof tf !== "string" || !allowed.has(tf)
    );

    if (bad.length > 0) {
      errors.push(
        "timeframes: nedopustimye znacheniya: " +
          bad.map((x) => String(x)).join(", ")
      );
    } else {
      timeframes = [...input.timeframes] as string[];
    }
  }

  let minExchanges: number | null = null;

  if (!isInteger(input.minExchanges)) {
    errors.push(
      "minExchanges: ozhidaetsya celoe chislo"
    );
  } else if (
    input.minExchanges < 1 ||
    input.minExchanges > 5
  ) {
    errors.push(
      "minExchanges: dolzhno byt ot 1 do 5"
    );
  } else {
    minExchanges = input.minExchanges;
  }

  if (
    !configResult.ok ||
    timeframes === null ||
    minExchanges === null
  ) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: configResult.config,
    timeframes,
    minExchanges
  };
}
