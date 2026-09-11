/**
 * Smart Money Suslik — Strategy Runtime adapter (Phase 3B).
 *
 * Цель: подключить проверенный evaluateSmc() к СУЩЕСТВУЮЩЕМУ
 * Strategy Runtime проекта БЕЗ создания второго runtime.
 *
 * Архитектура:
 * - SMC требует последовательность CLOSED свечей (history-based),
 *   а не один IndicatorSnapshot. SnapshotInput НЕ ломается;
 *   SMC идёт отдельным history-адаптером.
 * - DB fetch отделён от pure evaluateSmc (чистая функция);
 *   загрузчик делает ТОЛЬКО PostgreSQL SELECT.
 * - Каждый Market/exchange — свои свечи → независимая оценка,
 *   затем reused aggregateAssetGroup (multi-exchange).
 * - CANNOT_EVALUATE → SkippedMarket cannot-evaluate;
 *   NEUTRAL → EvaluatedMarket с direction NEUTRAL (ещё один голос).
 * - Config: Strategy JSON minimumSignalScore ↔ SmcScoringConfig.minimumScore
 *   (один threshold, два имени НЕ допускается).
 * - НЕ Signal Engine: никаких Signal writes и workers.
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
import { isInTopUniverse } from "../universe";
import {
  aggregateAssetGroup as existingAggregate,
  type MarketStrategyResult,
  type EvaluatedMarket,
  type SkippedMarket,
  type AssetAggregation,
} from "./runtime";
import type { Direction, StrategyReason } from "./trend-suslik";
import {
  selectCommonClosedHorizon,
  truncateCandlesToHorizon,
  type CommonHorizonSelection,
  type CommonHorizonStatus,
} from "./common-horizon";

// Re-export aggregation for convenience
export { existingAggregate as aggregateAssetGroup };

export const SMART_MONEY_SLUG = "smart-money-suslik";
export const SMART_MONEY_NAME = "Смарт Мани Суслик";

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isInteger(value: unknown): value is number {
  return isFiniteNumber(value) && Number.isInteger(value);
}

// ---------------------------------------------------------------
// Filters (same semantics as TrendSuslik top500Only + volume)
// ---------------------------------------------------------------

export type SmartMoneyFilters = {
  minimumQuoteVolume24h: number;
  top500Only: boolean;
};

export const DEFAULT_SMART_MONEY_FILTERS: SmartMoneyFilters = {
  minimumQuoteVolume24h: 0,
  top500Only: false,
};

/**
 * Логика фильтров идентична lib/strategies/runtime.applyStrategyFilters
 * (Top-100 universe, минимальный объём 24ч). Вынесена отдельно,
 * чтобы не зависеть от TrendSuslikConfig и не трогать его валидацию.
 */
export function applySmartMoneyFilters(
  input: { assetRank: number | null; quoteVolume24h: number | null },
  filters: SmartMoneyFilters
): string | null {
  if (filters.top500Only && !isInTopUniverse(input.assetRank)) {
    return (
      "aktiv vne osnovnogo universa Top-100 " +
      "(filtr top500Only: trebuetsya rank 1..100)"
    );
  }
  const volume = input.quoteVolume24h ?? 0;
  if (volume < filters.minimumQuoteVolume24h) {
    return (
      `obyom 24ch ${volume.toFixed(0)} USDT ` +
      `nizhe minimuma ${filters.minimumQuoteVolume24h}`
    );
  }
  return null;
}

// ---------------------------------------------------------------
// Config validation — minimumSignalScore ↔ SmcScoringConfig.minimumScore
// ---------------------------------------------------------------

export type ValidateSmcConfigResult =
  | { ok: true; config: SmcScoringConfig; filters: SmartMoneyFilters }
  | { ok: false; errors: string[] };

const WEIGHT_KEYS = [
  "swingStructureBias",
  "recentSwingBos",
  "internalStructure",
  "liquiditySweep",
  "swingOrderBlock",
  "internalOrderBlock",
  "fvg",
  "rangePosition",
  "confluence",
] as const;

/**
 * Строгая валидация Strategy.config для Smart Money.
 *
 * Ожидаемая плоская форма (совместимая с Trend плоскостью):
 * {
 *   minimumSignalScore: 72,           // ← единственное имя threshold
 *   filters: { minimumQuoteVolume24h, top500Only } // опционально
 *   swingLeft, swingRight, internalLeft, internalRight, atrPeriod,
 *   structureEventFreshBars, sweepFreshBars, orderBlockFreshBars, fvgFreshBars,
 *   eqBand,
 *   weights: { swingStructureBias, recentSwingBos, ... 9 полей }
 *   // tf опционально: если есть, должен совпадать с аргументом tf;
 *   // если нет — берётся tf аргумента.
 * }
 *
 * minimumScore (SMC имя) в Strategy JSON ЗАПРЕЩЁН — только
 * minimumSignalScore (единый порог стратегии). Наличие обоих
 * или отсутствие обоих — ошибка.
 */
export function validateSmartMoneyConfig(
  raw: unknown,
  tf: SmcTimeframe
): ValidateSmcConfigResult {
  const errors: string[] = [];

  if (!isRecord(raw)) {
    return { ok: false, errors: ["config: ozhidaetsya JSON-obekt"] };
  }

  if (!isSmcTimeframe(tf)) {
    return {
      ok: false,
      errors: [`tf "${String(tf)}" vne belogo spiska`],
    };
  }

  // ---- Phase 3D-C: top-level allowed keys (exact Strategy JSON shape) ----
  // Audit: seed config (scripts/seed-smart-money-args.ts CANONICAL_SMC_CONFIG)
  // + current DB id=2 (no advanced groups) + all existing tests use:
  // minimumSignalScore, swingLeft/Right, internalLeft/Right, atrPeriod,
  // structureEventFreshBars, sweepFreshBars, orderBlockFreshBars, fvgFreshBars,
  // eqBand, weights, filters, optional tf, plus 4 Phase3D advanced groups.
  // minimumScore is allowed only to give proper threshold-uniqueness error.
  const ALLOWED_TOP_LEVEL = new Set([
    "minimumSignalScore",
    "minimumScore",
    "swingLeft",
    "swingRight",
    "internalLeft",
    "internalRight",
    "atrPeriod",
    "structureEventFreshBars",
    "sweepFreshBars",
    "orderBlockFreshBars",
    "fvgFreshBars",
    "eqBand",
    "weights",
    "filters",
    "tf",
    "displacement",
    "fvg",
    "liquidity",
    "orderBlock",
  ]);
  for (const key of Object.keys(raw as Record<string, unknown>)) {
    if (!ALLOWED_TOP_LEVEL.has(key)) {
      errors.push(`config.${key}: neizvestnoe pole`);
    }
  }

  // ---- threshold uniqueness ----
  const hasSignal = Object.prototype.hasOwnProperty.call(
    raw,
    "minimumSignalScore"
  );
  const hasScore = Object.prototype.hasOwnProperty.call(
    raw,
    "minimumScore"
  );

  if (hasSignal && hasScore) {
    errors.push(
      "config: dopuskaetsya tolko odno pole poroga — minimumSignalScore (minimumScore zapreshchen v Strategy JSON)"
    );
  }

  let minimumScore: number | null = null;
  if (hasSignal) {
    const v = (raw as Record<string, unknown>).minimumSignalScore;
    if (!isInteger(v)) {
      errors.push("config.minimumSignalScore: ozhidaetsya celoe chislo");
    } else if (v < 0 || v > 100) {
      errors.push(
        "config.minimumSignalScore: dolzhno byt 0..100"
      );
    } else {
      minimumScore = v;
    }
  } else if (hasScore) {
    errors.push(
      "config.minimumScore: ispolzujte minimumSignalScore v Strategy JSON (minimumScore — vnutrennee pole SmcScoringConfig)"
    );
  } else {
    errors.push(
      "config.minimumSignalScore: obyazatelnoe pole (mapitsya v SmcScoringConfig.minimumScore)"
    );
  }

  // ---- optional tf in raw — if present must match argument ----
  if (
    (raw as Record<string, unknown>).tf !== undefined &&
    (raw as Record<string, unknown>).tf !== tf
  ) {
    errors.push(
      `config.tf: esli ukazano, dolzhno sovpadat s timeframe strategii (${tf}), polucheno ${String(
        (raw as Record<string, unknown>).tf
      )}`
    );
  }

  // ---- numeric params ----
  function checkInt(
    field: string,
    min: number,
    max: number
  ): number | null {
    const v = (raw as Record<string, unknown>)[field];
    if (v === undefined) {
      errors.push(`config.${field}: obyazatelnoe pole`);
      return null;
    }
    if (!isInteger(v)) {
      errors.push(`config.${field}: ozhidaetsya celoe chislo`);
      return null;
    }
    if (v < min || v > max) {
      errors.push(`config.${field}: dolzhno byt ${min}..${max}`);
      return null;
    }
    return v as number;
  }

  function checkNumber(
    field: string,
    min: number,
    max: number,
    allowMaxExclusive = false
  ): number | null {
    const v = (raw as Record<string, unknown>)[field];
    if (v === undefined) {
      errors.push(`config.${field}: obyazatelnoe pole`);
      return null;
    }
    if (!isFiniteNumber(v)) {
      errors.push(`config.${field}: ozhidaetsya chislo`);
      return null;
    }
    if (v < min || (allowMaxExclusive ? v >= max : v > max)) {
      errors.push(
        `config.${field}: dolzhno byt ${min}..${max}${allowMaxExclusive ? " (max exclusive)" : ""}`
      );
      return null;
    }
    return v as number;
  }

  const swingLeft = checkInt("swingLeft", 1, 500);
  const swingRight = checkInt("swingRight", 1, 500);
  const internalLeft = checkInt("internalLeft", 1, 500);
  const internalRight = checkInt("internalRight", 1, 500);
  const atrPeriod = checkInt("atrPeriod", 1, 500);

  function checkFresh(field: string): number | null {
    const v = (raw as Record<string, unknown>)[field];
    if (v === undefined) {
      errors.push(`config.${field}: obyazatelnoe pole`);
      return null;
    }
    if (!isInteger(v) || (v as number) < 0) {
      errors.push(`config.${field}: ozhidaetsya celoe >= 0`);
      return null;
    }
    return v as number;
  }

  const structureEventFreshBars = checkFresh(
    "structureEventFreshBars"
  );
  const sweepFreshBars = checkFresh("sweepFreshBars");
  const orderBlockFreshBars = checkFresh("orderBlockFreshBars");
  const fvgFreshBars = checkFresh("fvgFreshBars");

  const eqBandRaw = (raw as Record<string, unknown>).eqBand;
  let eqBand: number | null = null;
  if (eqBandRaw === undefined) {
    errors.push("config.eqBand: obyazatelnoe pole");
  } else if (!isFiniteNumber(eqBandRaw) || eqBandRaw < 0 || eqBandRaw >= 0.5) {
    errors.push("config.eqBand: ozhidaetsya 0 <= eqBand < 0.5");
  } else {
    eqBand = eqBandRaw as number;
  }

  // ---- weights (strict unknown inner keys) ----
  let weights: SmcScoringWeights | null = null;
  const rawWeights = (raw as Record<string, unknown>).weights;
  if (!isRecord(rawWeights)) {
    errors.push("config.weights: ozhidaetsya obekt");
  } else {
    const allowedWeights = new Set(WEIGHT_KEYS as unknown as string[]);
    for (const key of Object.keys(rawWeights as Record<string, unknown>)) {
      if (!allowedWeights.has(key)) {
        errors.push(`config.weights.${key}: neizvestnoe pole`);
      }
    }
    let sum = 0;
    const w: Record<string, number> = {};
    for (const key of WEIGHT_KEYS) {
      const v = (rawWeights as Record<string, unknown>)[key];
      if (!isInteger(v) || (v as number) < 0 || (v as number) > 100) {
        errors.push(
          `config.weights.${key}: ozhidaetsya celoe 0..100`
        );
      } else {
        w[key] = v as number;
        sum += v as number;
      }
    }
    if (errors.length === 0 && sum !== 100) {
      errors.push(
        `config.weights: summa vesov dolzhna byt rovno 100 (sejchas ${sum})`
      );
    }
    if (errors.length === 0) {
      weights = w as unknown as SmcScoringWeights;
    }
  }

  // ---- filters (strict unknown inner keys) ----
  let filters: SmartMoneyFilters = DEFAULT_SMART_MONEY_FILTERS;
  const rawFilters = (raw as Record<string, unknown>).filters;
  if (rawFilters !== undefined) {
    if (!isRecord(rawFilters)) {
      errors.push("config.filters: ozhidaetsya obekt");
    } else {
      const allowedFilters = new Set(["minimumQuoteVolume24h", "top500Only"]);
      for (const key of Object.keys(rawFilters as Record<string, unknown>)) {
        if (!allowedFilters.has(key)) {
          errors.push(`config.filters.${key}: neizvestnoe pole`);
        }
      }
      const rawMinVol = (rawFilters as Record<string, unknown>)
        .minimumQuoteVolume24h;
      const rawTop = (rawFilters as Record<string, unknown>).top500Only;
      let minVol: number | null = null;
      let top: boolean | null = null;

      if (rawMinVol === undefined) {
        errors.push("config.filters.minimumQuoteVolume24h: obyazatelnoe pole");
      } else if (!isFiniteNumber(rawMinVol) || (rawMinVol as number) < 0) {
        errors.push(
          "config.filters.minimumQuoteVolume24h: ozhidaetsya chislo >= 0"
        );
      } else {
        minVol = rawMinVol as number;
      }

      if (rawTop === undefined) {
        errors.push("config.filters.top500Only: obyazatelnoe pole");
      } else if (typeof rawTop !== "boolean") {
        errors.push("config.filters.top500Only: ozhidaetsya boolean");
      } else {
        top = rawTop;
      }

      if (minVol !== null && top !== null) {
        filters = {
          minimumQuoteVolume24h: minVol,
          top500Only: top,
        };
      }
    }
  }

  const rawRec = raw as Record<string, unknown>;
  const advancedCopy: Partial<SmcScoringConfig> = {};
  if (Object.prototype.hasOwnProperty.call(rawRec, "displacement")) {
    (advancedCopy as any).displacement = rawRec.displacement;
  }
  if (Object.prototype.hasOwnProperty.call(rawRec, "fvg")) {
    (advancedCopy as any).fvg = rawRec.fvg;
  }
  if (Object.prototype.hasOwnProperty.call(rawRec, "liquidity")) {
    (advancedCopy as any).liquidity = rawRec.liquidity;
  }
  if (Object.prototype.hasOwnProperty.call(rawRec, "orderBlock")) {
    (advancedCopy as any).orderBlock = rawRec.orderBlock;
  }

  if (
    errors.length > 0 ||
    minimumScore === null ||
    swingLeft === null ||
    swingRight === null ||
    internalLeft === null ||
    internalRight === null ||
    atrPeriod === null ||
    structureEventFreshBars === null ||
    sweepFreshBars === null ||
    orderBlockFreshBars === null ||
    fvgFreshBars === null ||
    eqBand === null ||
    weights === null
  ) {
    const hasAdvanced = Object.keys(advancedCopy).length > 0;
    if (!hasAdvanced) {
      return {
        ok: false,
        errors: errors.length > 0 ? errors : ["config: neizvestnaya oshibka"],
      };
    }
    if (
      minimumScore === null ||
      swingLeft === null ||
      swingRight === null ||
      internalLeft === null ||
      internalRight === null ||
      atrPeriod === null ||
      structureEventFreshBars === null ||
      sweepFreshBars === null ||
      orderBlockFreshBars === null ||
      fvgFreshBars === null ||
      eqBand === null ||
      weights === null
    ) {
      return {
        ok: false,
        errors: errors.length > 0 ? errors : ["config: neizvestnaya oshibka"],
      };
    }
  }

  const candidate: SmcScoringConfig = {
    tf,
    minimumScore,
    swingLeft: swingLeft as number,
    swingRight: swingRight as number,
    internalLeft: internalLeft as number,
    internalRight: internalRight as number,
    atrPeriod: atrPeriod as number,
    structureEventFreshBars: structureEventFreshBars as number,
    sweepFreshBars: sweepFreshBars as number,
    orderBlockFreshBars: orderBlockFreshBars as number,
    fvgFreshBars: fvgFreshBars as number,
    eqBand: eqBand as number,
    weights: weights as SmcScoringWeights,
    ...(Object.keys(advancedCopy).length > 0 ? advancedCopy : {}),
  };

  try {
    assertValidSmcScoringConfig(candidate);
  } catch (e) {
    const msg =
      e instanceof SmcInputError ? e.message : String((e as Error).message);
    if (!errors.some((er) => er.includes(msg))) {
      errors.push(msg);
    } else if (errors.length === 0) {
      errors.push(msg);
    }
    return { ok: false, errors };
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, config: candidate, filters };
}


export type SmartMoneyRuntimeValidation =
  | {
      ok: true;
      // smcConfig per timeframe (key = timeframe string)
      configs: Record<string, SmcScoringConfig>;
      filters: SmartMoneyFilters;
      timeframes: string[];
      minExchanges: number;
    }
  | { ok: false; errors: string[] };

export function validateSmartMoneyRuntime(input: {
  config: unknown;
  timeframes: unknown;
  minExchanges: unknown;
}): SmartMoneyRuntimeValidation {
  const errors: string[] = [];

  let timeframes: string[] | null = null;
  if (
    !Array.isArray(input.timeframes) ||
    input.timeframes.length === 0
  ) {
    errors.push("timeframes: nuzhen neaustoj spisok tajmfrejmov");
  } else {
    const allowed = new Set<string>(["5m", "15m", "1h", "4h", "1d"]);
    const bad = (input.timeframes as unknown[]).filter(
      (tf) => typeof tf !== "string" || !allowed.has(tf as string)
    );
    if (bad.length > 0) {
      errors.push(
        "timeframes: nedopustimye znacheniya: " +
          bad.map((x) => String(x)).join(", ")
      );
    } else {
      timeframes = [...(input.timeframes as string[])];
    }
  }

  let minExchanges: number | null = null;
  if (!isInteger(input.minExchanges)) {
    errors.push("minExchanges: ozhidaetsya celoe chislo");
  } else if (
    (input.minExchanges as number) < 1 ||
    (input.minExchanges as number) > 5
  ) {
    errors.push("minExchanges: dolzhno byt ot 1 do 5");
  } else {
    minExchanges = input.minExchanges as number;
  }

  if (timeframes === null || minExchanges === null) {
    return { ok: false, errors };
  }

  // Validate config for each timeframe to ensure tf coherence
  const configs: Record<string, SmcScoringConfig> = {};
  let filters: SmartMoneyFilters | null = null;

  for (const tf of timeframes) {
    const res = validateSmartMoneyConfig(
      input.config,
      tf as SmcTimeframe
    );
    if (!res.ok) {
      errors.push(...res.errors.map((e) => `[${tf}] ${e}`));
      break;
    }
    configs[tf] = res.config;
    if (filters === null) {
      filters = res.filters;
    } else {
      // Filters must be identical across tf validations (same raw)
      if (
        filters.minimumQuoteVolume24h !==
          res.filters.minimumQuoteVolume24h ||
        filters.top500Only !== res.filters.top500Only
      ) {
        errors.push("config.filters: dolzhny byt odinakovy dlya vseh tf");
        break;
      }
    }
  }

  if (errors.length > 0 || filters === null) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    configs,
    filters,
    timeframes,
    minExchanges,
  };
}

/**
 * Helper: построить SmcScoringConfig из Strategy JSON
 * плюс timeframe. Удобен для CLI и loader-слоя.
 * Если raw невалиден — бросает SmcInputError.
 */
export function smcConfigFromStrategy(
  raw: unknown,
  tf: SmcTimeframe
): SmcScoringConfig {
  const res = validateSmartMoneyConfig(raw, tf);
  if (!res.ok) {
    throw new SmcInputError(
      `SmartMoney config invalid: ${res.errors.join("; ")}`
    );
  }
  return res.config;
}

/**
 * Helper: default config для timeframe, если Strategy row
 * ещё не создана (future slug). Production minimumSignalScore=72.
 */
export function defaultSmartMoneyConfigForTf(
  tf: SmcTimeframe
): SmcScoringConfig {
  return defaultSmcScoringConfig(tf);
}

// ---------------------------------------------------------------
// Mapping of SMC reasons → StrategyReason (preserve 9 SMC codes)
// ---------------------------------------------------------------

/**
 * Сохраняем 9 SMC reason codes в StrategyReason массиве:
 * каждый SmcScoreReason → StrategyReason с code в метке
 * (`[CODE] человекочитаемый лейбл`) и value = payload.
 * long/short булевы отражают наличие points > 0.
 */
export function mapSmcReasonsToStrategyReasons(
  smcReasons: ReadonlyArray<{
    code: string;
    label: string;
    longPoints: number;
    shortPoints: number;
    maxPoints: number;
    value: string | null;
  }>
): StrategyReason[] {
  return smcReasons.map((r) => ({
    label: `[${r.code}] ${r.label}`,
    long: r.longPoints > 0,
    short: r.shortPoints > 0,
    weight: r.maxPoints,
    value:
      r.value !== null
        ? `${r.value} (${r.longPoints}/${r.shortPoints})`
        : `${r.longPoints}/${r.shortPoints}`,
  }));
}

// ---------------------------------------------------------------
// Pure SMC → StrategyRuntime adapter (history-based)
// ---------------------------------------------------------------

export type SmartMoneyMarketMeta = {
  exchange: string;
  market: string;
  marketId: number;
  timeframe: SmcTimeframe;
  assetRank: number | null;
  quoteVolume24h: number | null;
};

function cannotEvaluate(
  meta: SmartMoneyMarketMeta,
  reason: string
): SkippedMarket {
  return {
    status: "cannot-evaluate",
    exchange: meta.exchange,
    market: meta.market,
    marketId: meta.marketId,
    reason,
  };
}

function filtered(
  meta: SmartMoneyMarketMeta,
  reason: string
): SkippedMarket {
  return {
    status: "filtered",
    exchange: meta.exchange,
    market: meta.market,
    marketId: meta.marketId,
    reason,
  };
}

/**
 * Чистый адаптер: CLOSED свечи + SmcScoringConfig → MarketStrategyResult.
 *
 * - Фильтры применяются ДО SMC (top500Only, объём).
 * - SMC CANNOT_EVALUATE → SkippedMarket cannot-evaluate (hard failures).
 * - SMC NEUTRAL остаётся evaluated с direction NEUTRAL.
 * - 9 SMC reasons сохраняются в StrategyReason с code.
 * - Только closed=true свечи допускаются: не-CLOSED вход даёт
 *   cannot-evaluate (контракт SmcInputError перехватывается).
 * - Недостаточно истории → cannot-evaluate, никакого fallback.
 * - Детерминирован и без lookahead (evaluateSmc честно ограничен horizon).
 *
 * candles: должны быть ASC по openTime (loader уже reverse),
 * но функция сама НЕ сортирует тихо — нарушение контракта → cannot-evaluate.
 */
export function evaluateSmartMoneyWithCandles(
  meta: SmartMoneyMarketMeta,
  candles: SmcRawCandle[],
  smcConfig: SmcScoringConfig,
  filters: SmartMoneyFilters = DEFAULT_SMART_MONEY_FILTERS
): MarketStrategyResult {
  // 0. tf coherence: config tf должен совпадать с рынком timeframe
  if (smcConfig.tf !== meta.timeframe) {
    return cannotEvaluate(
      meta,
      `konfig tf ${smcConfig.tf} ne sovpadaet s timeframe rynka ${meta.timeframe}`
    );
  }

  // 1. Strategy filters (identical semantics to Trend)
  const filterReason = applySmartMoneyFilters(
    {
      assetRank: meta.assetRank,
      quoteVolume24h: meta.quoteVolume24h,
    },
    filters
  );
  if (filterReason) {
    return filtered(meta, filterReason);
  }

  // 2. Empty / only check: need at least 1 CLOSED
  if (!Array.isArray(candles) || candles.length === 0) {
    return cannotEvaluate(
      meta,
      "nestandartnoe: istoriya zakrytyh svechej pusta — SMC trebuet posledovatelnost CLOSED candles"
    );
  }

  // 3. Validate strict ascending and closed already? Let evaluateSmc do it, but we catch contract violations.
  // 4. Determine asOf = effectiveCloseTime последней CLOSED свечи horizon
  //    Если свечи уже отсортированы ASC, последняя — max openTime.
  //    Для несортированного входа effectiveCloseTime последней в массиве ≠ max — но contract violation будет пойман validateAndPrepare.
  const last = candles[candles.length - 1];
  const tfMs = SMCTIMEFRAME_MS[smcConfig.tf];
  const asOf = new Date(last.openTime.getTime() + tfMs);

  let evaluation: ReturnType<typeof evaluateSmc>;
  try {
    evaluation = evaluateSmc(candles, smcConfig, asOf);
  } catch (e) {
    const msg =
      e instanceof SmcInputError
        ? e.message
        : e instanceof Error
          ? e.message
          : String(e);
    return cannotEvaluate(meta, `SMC input contract: ${msg}`);
  }

  // 5. Hard failure → cannot-evaluate (no scores fabrication)
  if (
    !evaluation.availability.evaluable ||
    evaluation.direction === "CANNOT_EVALUATE" ||
    evaluation.longScore === null ||
    evaluation.shortScore === null
  ) {
    const hard = evaluation.availability.hardFailures
      .map((f) => `${f.code}: ${f.label}`)
      .join("; ");
    const reason = hard
      ? `SMC cannot evaluate — ${hard}`
      : "SMC cannot evaluate";
    return cannotEvaluate(meta, reason);
  }

  // 6. Evaluable (включая NEUTRAL) → EvaluatedMarket
  const price = last.close;
  const candleTime = last.openTime;

  // Invariant: sum of longPoints/shortPoints across 9 reasons == scores
  const direction = evaluation.direction as Direction; // LONG | SHORT | NEUTRAL

  return {
    status: "evaluated",
    exchange: meta.exchange,
    market: meta.market,
    marketId: meta.marketId,
    candleTime,
    price,
    longScore: evaluation.longScore,
    shortScore: evaluation.shortScore,
    direction,
    reasons: mapSmcReasonsToStrategyReasons(evaluation.reasons),
    warnings: [], // SMC softUnavailable уже в reasons (0-point), warnings пусты
  };
}

// ---------------------------------------------------------------
// DB loader — отделён от pure evaluate (только PostgreSQL)
// ---------------------------------------------------------------

/**
 * Загрузчик последних 500 CLOSED свечей PostgreSQL для рынка.
 *
 * Семантика: orderBy openTime DESC take 500 → reverse в памяти,
 * чтобы вернуть ASC. НЕ orderBy ASC + take 500 (вернёт старые).
 *
 * prisma: любой объект с prisma.candle.findMany (PrismaClient).
 * timeframe: строка ТФ (валидируется isSmcTimeframe вне, но здесь
 * просто прокидывается в WHERE).
 */
export async function loadSmartMoneyCandles(
  prisma: {
    candle: {
      findMany: (args: unknown) => Promise<
        Array<{
          openTime: Date;
          open: number;
          high: number;
          low: number;
          close: number;
          closed: boolean;
        }>
      >;
    };
  },
  marketId: number,
  timeframe: string
): Promise<SmcRawCandle[]> {
  const rows = await prisma.candle.findMany({
    where: {
      marketId,
      timeframe,
      closed: true,
    },
    orderBy: {
      openTime: "desc",
    },
    take: 500,
    select: {
      openTime: true,
      open: true,
      high: true,
      low: true,
      close: true,
      closed: true,
    },
  } as unknown as never);

  // Reverse в памяти → ASC для SMC (canonical ascending contract)
  rows.reverse();

  return rows.map((r) => ({
    openTime: r.openTime,
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    closed: r.closed,
  }));
}

/**
 * Удобный high-level helper для CLI/скриптов: загрузка + pure оценка.
 * DB fetch и pure вычисление разделены сигнатурой (candles параметр),
 * но здесь объединены для удобства.
 */
export async function evaluateSmartMoneyMarketFromDb(
  prisma: Parameters<typeof loadSmartMoneyCandles>[0],
  meta: SmartMoneyMarketMeta,
  smcConfig: SmcScoringConfig,
  filters: SmartMoneyFilters = DEFAULT_SMART_MONEY_FILTERS
): Promise<{ candles: SmcRawCandle[]; result: MarketStrategyResult }> {
  const candles = await loadSmartMoneyCandles(
    prisma,
    meta.marketId,
    meta.timeframe
  );
  const result = evaluateSmartMoneyWithCandles(
    meta,
    candles,
    smcConfig,
    filters
  );
  return { candles, result };
}

/**
 * Evaluate markets at the COMMON CLOSED horizon.
 *
 * Set semantics (contract — см. заголовок lib/strategies/common-horizon.ts):
 *  - exchange eligibility (Option A) применяется ВЫЗЫВАЮЩИМ до этого function:
 *    BINGX для 1d сюда не попадает и не может влиять на H / freshness / denominator;
 *  - рынки, которые сама Strategy помечает `filtered` (top500Only /
 *    minimumQuoteVolume24h), НЕ являются участниками common horizon и не могут
 *    наложить вето на горизонт всего актива — при этом они возвращаются в
 *    `results` со статусом `filtered`, ровно как в pre-common-horizon runtime;
 *  - всё остальное — участники. У участника нет CLOSED данных / нет общего
 *    барa / горизонт вне freshness bound → явный unusable статус, а НЕ тихий
 *    успех на выживших. Недостаточная история после усечения сохраняет
 *    существующую per-market cannot-evaluate семантику (видно как skipped).
 *
 * `now` передаётся вызывающим кодом: pure-слой не читает wall clock сам.
 * Логика фильтров НЕ дублируется — переиспользуется applySmartMoneyFilters.
 */
export type CommonHorizonOutcome = {
  selection: CommonHorizonSelection;
  /** Результаты в ПОРЯДКЕ входа: evaluated | cannot-evaluate | filtered. */
  results: MarketStrategyResult[];
  usable: boolean;
  status: CommonHorizonStatus;
  participantCount: number;
  filteredCount: number;
};

export function evaluateMarketsAtCommonHorizon(
  markets: Array<{ meta: SmartMoneyMarketMeta; candles: SmcRawCandle[] }>,
  timeframe: SmcTimeframe,
  smcConfig: SmcScoringConfig,
  filters: SmartMoneyFilters,
  now: Date
): CommonHorizonOutcome {
  const slot: Array<MarketStrategyResult | undefined> = new Array(markets.length);
  const participants: number[] = [];
  let filteredCount = 0;

  for (let i = 0; i < markets.length; i++) {
    const m = markets[i];
    const filterReason = applySmartMoneyFilters(
      {
        assetRank: m.meta.assetRank,
        quoteVolume24h: m.meta.quoteVolume24h,
      },
      filters
    );
    if (filterReason !== null) {
      slot[i] = filtered(m.meta, filterReason);
      filteredCount++;
    } else {
      participants.push(i);
    }
  }

  const selection = selectCommonClosedHorizon(
    participants.map((i) => ({
      exchange: markets[i].meta.exchange,
      marketId: markets[i].meta.marketId,
      candles: markets[i].candles,
    })),
    timeframe,
    { now }
  );

  if (selection.status !== "ok" || selection.commonHorizon === null) {
    return {
      selection,
      results: [],
      usable: false,
      status: selection.status,
      participantCount: selection.participantCount,
      filteredCount,
    };
  }

  const horizon = selection.commonHorizon;

  for (const i of participants) {
    const m = markets[i];
    const truncated = truncateCandlesToHorizon(m.candles, horizon);

    if (truncated.length === 0) {
      // Defensive: H взят из множества этого же рынка, так что недостижимо при
      // честном входе. Ни в коем случае не откатываемся на более свежую свечу.
      slot[i] = cannotEvaluate(
        m.meta,
        `нет CLOSED свечей не позже общего горизонта ${horizon.toISOString()}`
      );
      continue;
    }

    const result = evaluateSmartMoneyWithCandles(
      m.meta,
      truncated,
      smcConfig,
      filters
    );

    if (
      result.status === "evaluated" &&
      result.candleTime.getTime() !== horizon.getTime()
    ) {
      // Anchor-invariant guard (страховка от будущего рефакторинга усечения):
      // чужой горизонт не должен попасть в группу.
      slot[i] = cannotEvaluate(
        m.meta,
        `invariant: candleTime ${result.candleTime.toISOString()} ≠ общий горизонт ${horizon.toISOString()}`
      );
      continue;
    }

    slot[i] = result;
  }

  const results = slot.filter(
    (r): r is MarketStrategyResult => r !== undefined
  );

  return {
    selection,
    results,
    usable: true,
    status: selection.status,
    participantCount: selection.participantCount,
    filteredCount,
  };
}
