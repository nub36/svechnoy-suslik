/**
 * P2-A — хронологическое разбиение TRAIN / VALIDATION / OOS.
 *
 * Политика (contract.ts, пункт 14):
 *  - разбиение ТОЛЬКО по индексам баров, строго хронологически:
 *    TRAIN → VALIDATION → OOS, без random, без shuffling, без
 *    пересечений и без пропусков (границы стыкуются вплотную);
 *  - TRAIN = floor(barsCount × trainFraction), VALIDATION =
 *    floor(barsCount × validationFraction), OOS = остаток — детерминированная
 *    арифметика без «округления до красивого»;
 *  - утечка исключена конструкцией: вход никогда не пересекает границу
 *    сегмента (engine.ts отбрасывает сигнал на последнем баре сегмента),
 *    открытая позиция на границе закрывается по close последнего бара
 *    сегмента (exitReason "SEGMENT_END");
 *  - чтение истории ДО начала сегмента разрешено в пределах warmupBars
 *    (это прошлое, а не будущее) и фиксируется в warmupStart;
 *  - assertNoSegmentLeakage — проверяемый инвариант результата: любая
 *    сделка целиком внутри окна сегмента, entryIndex = signalIndex + 1.
 *
 * P2-A НЕ выбирает параметры и НЕ сравнивает сегменты ради оптимизации:
 * summarizeSegments() — только детерминированная сводка для отчёта.
 */

import {
  type BacktestBar,
  type BacktestInput,
  type BacktestMetrics,
  type BacktestResult,
  type BacktestTrade,
  type ChronologicalSplit,
  type ChronologicalSplitConfig,
  type SegmentRun,
  type SegmentedBacktest,
  type SignalDecisionList,
  type SignalProvider,
  type SplitName,
  BACKTEST_SPLIT_DEFAULTS,
  resolveBacktestConfig
} from "./contract";
import { runBacktest } from "./engine";

export const SPLIT_NAMES: readonly SplitName[] = ["TRAIN", "VALIDATION", "OOS"];

export type SplitCheck =
  | { readonly ok: true; readonly split: ChronologicalSplit }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Границы сегментов: [0, trainEnd) / [trainEnd, validationEnd) /
 * [validationEnd, barsCount).
 */
export function chronologicalSplit(
  barsCount: number,
  config?: Partial<ChronologicalSplitConfig>,
  warmupBars = 0
): SplitCheck {
  const errors: string[] = [];
  const trainFraction =
    config?.trainFraction ?? BACKTEST_SPLIT_DEFAULTS.trainFraction;
  const validationFraction =
    config?.validationFraction ?? BACKTEST_SPLIT_DEFAULTS.validationFraction;
  const minBarsPerSegment =
    config?.minBarsPerSegment ?? BACKTEST_SPLIT_DEFAULTS.minBarsPerSegment;

  if (!Number.isInteger(barsCount) || barsCount < 0) {
    errors.push("barsCount: целое ≥ 0");
  }

  for (const [name, value] of [
    ["trainFraction", trainFraction],
    ["validationFraction", validationFraction]
  ] as const) {
    if (!Number.isFinite(value) || value <= 0 || value >= 1) {
      errors.push(`${name}: число в интервале (0, 1)`);
    }
  }

  if (
    Number.isFinite(trainFraction) &&
    Number.isFinite(validationFraction) &&
    trainFraction + validationFraction >= 1
  ) {
    errors.push(
      "trainFraction + validationFraction должен быть < 1 (OOS обязан быть непустым)"
    );
  }

  if (!Number.isInteger(minBarsPerSegment) || minBarsPerSegment < 1) {
    errors.push("minBarsPerSegment: целое ≥ 1");
  }

  if (!Number.isInteger(warmupBars) || warmupBars < 0) {
    errors.push("warmupBars: целое ≥ 0");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const trainEnd = Math.floor(barsCount * trainFraction);
  const validationEnd = trainEnd + Math.floor(barsCount * validationFraction);
  const oosEnd = barsCount;

  const sizes: Record<SplitName, number> = {
    TRAIN: trainEnd,
    VALIDATION: validationEnd - trainEnd,
    OOS: oosEnd - validationEnd
  };

  for (const name of SPLIT_NAMES) {
    if (sizes[name] < minBarsPerSegment) {
      errors.push(
        `${name}: ${String(sizes[name])} баров < minBarsPerSegment=${String(minBarsPerSegment)} (barsCount=${String(barsCount)})`
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    split: {
      barsCount,
      train: { name: "TRAIN", startIndex: 0, endIndexExclusive: trainEnd },
      validation: {
        name: "VALIDATION",
        startIndex: trainEnd,
        endIndexExclusive: validationEnd
      },
      oos: {
        name: "OOS",
        startIndex: validationEnd,
        endIndexExclusive: oosEnd
      },
      warmupStart: {
        TRAIN: Math.max(0, 0 - warmupBars),
        VALIDATION: Math.max(0, trainEnd - warmupBars),
        OOS: Math.max(0, validationEnd - warmupBars)
      }
    }
  };
}

/* ------------------------------------------------------------------ */
/* Инвариант отсутствия утечки                                          */
/* ------------------------------------------------------------------ */

export interface LeakageReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Проверка, что прогон сегмента не «заглянул» за его границы.
 *
 * Инварианты:
 *  1) signalIndex внутри [startIndex, endIndexExclusive);
 *  2) entryIndex = signalIndex + 1 (вход только на следующем баре);
 *  3) entryIndex/exitIndex внутри окна (вход не пересекает границу);
 *  4) сделки хронологичны и не перекрываются (одна позиция): сигнал
 *     новой сделки не раньше выхода предыдущей, вход — строго позже
 *     (перезаход на баре выхода законен, вход — на следующем баре);
 *  5) exitTime ≥ entryTime и time баров монотонны в пределах сделки.
 */
export function assertNoSegmentLeakage(
  result: BacktestResult,
  window: { readonly startIndex: number; readonly endIndexExclusive: number }
): LeakageReport {
  const errors: string[] = [];
  const { startIndex, endIndexExclusive } = window;
  let previousExitIndex = -1;

  for (const trade of result.trades) {
    if (trade.signalIndex < startIndex || trade.signalIndex >= endIndexExclusive) {
      errors.push(
        `trade ${String(trade.id)}: signalIndex=${String(trade.signalIndex)} вне окна [${String(startIndex)}, ${String(endIndexExclusive)})`
      );
    }

    if (trade.entryIndex !== trade.signalIndex + 1) {
      errors.push(
        `trade ${String(trade.id)}: entryIndex=${String(trade.entryIndex)} ≠ signalIndex + 1`
      );
    }

    if (trade.entryIndex >= endIndexExclusive) {
      errors.push(
        `trade ${String(trade.id)}: вход за границей сегмента (entryIndex=${String(trade.entryIndex)})`
      );
    }

    if (trade.exitIndex >= endIndexExclusive || trade.exitIndex < startIndex) {
      errors.push(
        `trade ${String(trade.id)}: exitIndex=${String(trade.exitIndex)} вне окна`
      );
    }

    if (trade.exitIndex < trade.entryIndex) {
      errors.push(`trade ${String(trade.id)}: exitIndex < entryIndex`);
    }

    if (trade.exitTime < trade.entryTime) {
      errors.push(`trade ${String(trade.id)}: exitTime < entryTime`);
    }

    if (previousExitIndex >= 0) {
      // Перезаход на том же баре, где закрылась предыдущая сделка,
      // ЗАКОНЕН (стратегия видит собственный стопаут), поэтому сигнал
      // может совпадать с previousExitIndex, а вход — быть ровно на
      // следующем баре. Нарушение — только если сделка началась РАНЬШЕ
      // выхода предыдущей: это означало бы две открытые позиции.
      if (trade.signalIndex < previousExitIndex) {
        errors.push(
          `trade ${String(trade.id)}: сигнал на баре ${String(trade.signalIndex)} раньше выхода предыдущей сделки (${String(previousExitIndex)}) — перекрытие позиций`
        );
      }

      if (trade.entryIndex <= previousExitIndex) {
        errors.push(
          `trade ${String(trade.id)}: вход на баре ${String(trade.entryIndex)} не позже выхода предыдущей сделки (${String(previousExitIndex)}) — перекрытие позиций`
        );
      }
    }

    previousExitIndex = trade.exitIndex;
  }

  for (const skipped of result.skippedSignals) {
    if (skipped.index < startIndex || skipped.index >= endIndexExclusive) {
      errors.push(
        `skippedSignal на индексе ${String(skipped.index)} вне окна сегмента`
      );
    }
  }

  for (const rejected of result.rejectedSignals) {
    if (rejected.index < startIndex || rejected.index >= endIndexExclusive) {
      errors.push(
        `rejectedSignal на индексе ${String(rejected.index)} вне окна сегмента`
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ */
/* Сегментный прогон                                                    */
/* ------------------------------------------------------------------ */

export type SegmentedBacktestOutcome =
  | { readonly ok: true; readonly value: SegmentedBacktest }
  | {
      readonly ok: false;
      readonly stage: "config" | "bars" | "split" | "provider" | "leakage";
      readonly errors: readonly string[];
    };

export interface SegmentedBacktestInput {
  readonly bars: readonly BacktestBar[];
  readonly signals: SignalProvider | SignalDecisionList;
  readonly config?: BacktestInput["config"];
  readonly splitConfig?: Partial<ChronologicalSplitConfig>;
}

function runSegment(
  segment: ChronologicalSplit["train"],
  warmupStartIndex: number,
  input: SegmentedBacktestInput
): SegmentRun {
  const outcome = runBacktest({
    bars: input.bars,
    signals: input.signals,
    config: input.config,
    segment
  });

  return { segment: segment.name, window: segment, warmupStartIndex, outcome };
}

/**
 * Прогон одного и того же источника решений по трём хронологическим
 * сегментам. Каждый сегмент — независимый runBacktest: сделки, метрики
 * и эквити не переносятся через границу (состояние сегмента начинается
 * с initialEquity, открытая позиция закрывается по SEGMENT_END).
 */
export function runSegmentedBacktest(
  input: SegmentedBacktestInput
): SegmentedBacktestOutcome {
  const resolved = resolveBacktestConfig(input.config);

  if (!resolved.ok) {
    return { ok: false, stage: "config", errors: resolved.errors };
  }

  const barsCount = Array.isArray(input.bars) ? input.bars.length : 0;
  const splitCheck = chronologicalSplit(
    barsCount,
    input.splitConfig,
    resolved.config.warmupBars
  );

  if (!splitCheck.ok) {
    return { ok: false, stage: "split", errors: splitCheck.errors };
  }

  const split = splitCheck.split;
  const train = runSegment(split.train, split.warmupStart.TRAIN, input);
  const validation = runSegment(
    split.validation,
    split.warmupStart.VALIDATION,
    input
  );
  const oos = runSegment(split.oos, split.warmupStart.OOS, input);

  const runs: readonly SegmentRun[] = [train, validation, oos];
  const errors: string[] = [];

  for (const run of runs) {
    if (!run.outcome.ok) {
      errors.push(
        `${run.segment}: ${run.outcome.errors.join("; ") || "прогон не выполнен"}`
      );

      continue;
    }

    const leakage = assertNoSegmentLeakage(run.outcome.result, run.window);

    if (!leakage.ok) {
      errors.push(`${run.segment}: утечка за границы сегмента — ${leakage.errors.join("; ")}`);
    }
  }

  if (errors.length > 0) {
    const stage = runs.some((run) => !run.outcome.ok) ? "provider" : "leakage";

    return { ok: false, stage, errors };
  }

  return { ok: true, value: { split, train, validation, oos } };
}

/* ------------------------------------------------------------------ */
/* Сводка (отчёт, не выбор параметров)                                  */
/* ------------------------------------------------------------------ */

export interface SegmentSummary {
  readonly segment: SplitName;
  readonly barsCount: number;
  readonly trades: number;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly profitFactorState: BacktestMetrics["profitFactorState"];
  readonly expectancy: number | null;
  readonly avgR: number | null;
  readonly medianR: number | null;
  readonly totalNetPnl: number;
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number | null;
  readonly maxDrawdownMarkToMarket: number;
  readonly skippedSignals: number;
  readonly rejectedSignals: number;
}

function summarize(
  segment: SplitName,
  run: SegmentRun
): SegmentSummary | null {
  if (!run.outcome.ok) {
    return null;
  }

  const { metrics } = run.outcome.result;

  return {
    segment,
    barsCount: run.window.endIndexExclusive - run.window.startIndex,
    trades: metrics.trades,
    winRate: metrics.winRate,
    profitFactor: metrics.profitFactor,
    profitFactorState: metrics.profitFactorState,
    expectancy: metrics.expectancy,
    avgR: metrics.avgR,
    medianR: metrics.medianR,
    totalNetPnl: metrics.totalNetPnl,
    maxDrawdown: metrics.maxDrawdown,
    maxDrawdownPct: metrics.maxDrawdownPct,
    maxDrawdownMarkToMarket: metrics.maxDrawdownMarkToMarket,
    skippedSignals: run.outcome.result.skippedSignals.length,
    rejectedSignals: run.outcome.result.rejectedSignals.length
  };
}

/**
 * Детерминированная сводка по трём сегментам.
 *
 * ВНИМАНИЕ: это отчёт, а не критерий отбора. Подбор параметров по
 * сводке (и любая «лучшая» конфигурация) — задача P2-B/P2-C и здесь
 * не выполняется намеренно.
 */
export function summarizeSegments(
  segmented: SegmentedBacktest
): readonly SegmentSummary[] {
  const summaries: (SegmentSummary | null)[] = [
    summarize("TRAIN", segmented.train),
    summarize("VALIDATION", segmented.validation),
    summarize("OOS", segmented.oos)
  ];

  return summaries.filter((item): item is SegmentSummary => item !== null);
}

/** Хронологическая проверка набора сделок (утилита для тестов/отчётов). */
export function isChronological(
  trades: readonly BacktestTrade[]
): boolean {
  for (let i = 1; i < trades.length; i += 1) {
    if (trades[i].signalIndex < trades[i - 1].exitIndex) {
      return false;
    }

    if (trades[i].entryTime < trades[i - 1].exitTime) {
      return false;
    }
  }

  return true;
}
