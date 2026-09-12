/**
 * P2-A — доказуемость no-lookahead (переиспользуемый инструмент).
 *
 * Тест «на доверие» здесь не работает, поэтому no-lookahead проверяется
 * двумя независимыми способами:
 *
 *  1) СТРУКТУРНО (probeProvider): на каждом баре движок активно
 *     пытается прочитать будущее через SignalContext.barAt(index + k).
 *     Любая такая попытка обязана бросить исключение; если хоть раз не
 *     бросила — проба красная.
 *
 *  2) КОНТРФАКТИЧЕСКИ (assertDecisionInvariance): прогон повторяется на
 *     данных, у которых все бары ПОСЛЕ границы заменены «отравленной»
 *     серией (те же time, цены умножены на коэффициент — OHLC-инварианты
 *     сохраняются). Решения на барах до границы обязаны совпасть
 *     ПОЭЛЕМЕНТНО, как и сделки, закрывшиеся до границы. Если стратегия
 *     хоть как-то использует будущее, её решения изменятся вместе с
 *     будущими барами — это и есть обнаружимый lookahead.
 *
 * Оба инструмента чистые и детерминированные: они пригодны для
 * сертификации ЛЮБОГО будущего провайдера решений (P2-B/P2-C), а не
 * только для тестов P2-A.
 */

import {
  type BacktestBar,
  type BacktestInput,
  type BacktestResult,
  type SignalDecision,
  type SignalDecisionKind,
  type SignalProvider
} from "./contract";
import { runBacktest } from "./engine";

/** Записанное решение провайдера на одном баре. */
export interface RecordedDecision {
  readonly index: number;
  readonly time: number;
  /** Сколько баров было видно провайдеру (обязано быть index + 1). */
  readonly visibleBars: number;
  readonly kind: SignalDecisionKind | "NO_SIGNAL";
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  /** Была ли открыта позиция на момент оценки сигнала. */
  readonly positionOpen: boolean;
}

/** Результат активной пробы барьера no-lookahead. */
export interface LookaheadProbe {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly decisions: readonly RecordedDecision[];
  /** Сколько баров было оценено. */
  readonly barsProbed: number;
  /** Попытки чтения будущего, которые НЕ были заблокированы. */
  readonly guardFailures: readonly { index: number; requested: number }[];
  /** Попытки чтения до warmup-окна, которые НЕ были заблокированы. */
  readonly windowFailures: readonly { index: number; requested: number }[];
  readonly outcome: ReturnType<typeof runBacktest>;
}

/** Насколько далеко в будущее заглядывает проба на каждом баре. */
const PROBE_OFFSETS: readonly number[] = [1, 2, 10, 1000];

function decisionOf(
  decision: SignalDecision | null | undefined
): { kind: RecordedDecision["kind"]; stopLoss: number | null; takeProfit: number | null } {
  if (decision === null || decision === undefined) {
    return { kind: "NO_SIGNAL", stopLoss: null, takeProfit: null };
  }

  if (decision.kind === "LONG" || decision.kind === "SHORT") {
    return {
      kind: decision.kind,
      stopLoss: decision.stopLoss,
      takeProfit: decision.takeProfit
    };
  }

  return { kind: decision.kind, stopLoss: null, takeProfit: null };
}

/**
 * Активная проба: прогон с провайдером-обёрткой, который на каждом баре
 * (а) записывает решение, (б) проверяет видимость, (в) пытается читать
 * будущее и прошлое за пределами warmup-окна.
 */
export function probeProvider(args: {
  readonly bars: readonly BacktestBar[];
  readonly provider: SignalProvider;
  readonly config?: BacktestInput["config"];
  readonly segment?: BacktestInput["segment"];
}): LookaheadProbe {
  const decisions: RecordedDecision[] = [];
  const guardFailures: { index: number; requested: number }[] = [];
  const windowFailures: { index: number; requested: number }[] = [];
  const errors: string[] = [];

  const wrapper: SignalProvider = (context) => {
    // (б) видимость: visibleBars обязан равняться index + 1.
    if (context.visibleBars !== context.index + 1) {
      errors.push(
        `видимость нарушена на баре ${String(context.index)}: visibleBars=${String(context.visibleBars)}`
      );
    }

    // (в) будущее: каждое обращение обязано бросить исключение.
    for (const offset of PROBE_OFFSETS) {
      const requested = context.index + offset;

      try {
        const leaked = context.barAt(requested);

        guardFailures.push({ index: context.index, requested });

        if (leaked === undefined) {
          errors.push(
            `barAt(${String(requested)}) вернул undefined вместо исключения`
          );
        }
      } catch {
        // Ожидаемое поведение: барьер сработал.
      }
    }

    // (в) прошлое за пределами warmup-окна сегмента.
    if (context.firstVisibleIndex > 0) {
      try {
        context.barAt(context.firstVisibleIndex - 1);
        windowFailures.push({
          index: context.index,
          requested: context.firstVisibleIndex - 1
        });
      } catch {
        // Ожидаемое поведение.
      }
    }

    // (в) законное чтение текущего и предыдущего бара должно работать.
    try {
      if (context.barAt(context.index) !== context.bar) {
        errors.push(
          `barAt(index) не вернул текущий бар на ${String(context.index)}`
        );
      }
    } catch {
      errors.push(
        `barAt(index) бросил исключение на законном индексе ${String(context.index)}`
      );
    }

    const decision = args.provider(context);
    const recorded = decisionOf(decision);

    decisions.push({
      index: context.index,
      time: context.bar.time,
      visibleBars: context.visibleBars,
      kind: recorded.kind,
      stopLoss: recorded.stopLoss,
      takeProfit: recorded.takeProfit,
      positionOpen: context.position !== null
    });

    return decision;
  };

  const outcome = runBacktest({
    bars: args.bars,
    signals: wrapper,
    config: args.config,
    segment: args.segment
  });

  if (!outcome.ok) {
    errors.push(...outcome.errors);
  }

  return {
    ok:
      errors.length === 0 &&
      guardFailures.length === 0 &&
      windowFailures.length === 0,
    errors,
    decisions,
    barsProbed: decisions.length,
    guardFailures,
    windowFailures,
    outcome
  };
}

/**
 * «Отравление» будущего: бары с индекса fromIndex (включительно)
 * умножаются на коэффициент. time сохраняются, OHLC-инварианты
 * выполняются (масштабирование всех четырёх цен их не нарушает),
 * монотонность сетки не меняется.
 */
export function poisonFutureBars(
  bars: readonly BacktestBar[],
  fromIndex: number,
  factor = 3.5
): readonly BacktestBar[] {
  return bars.map((bar, index) => {
    if (index < fromIndex) {
      return bar;
    }

    return {
      time: bar.time,
      open: bar.open * factor,
      high: bar.high * factor,
      low: bar.low * factor,
      close: bar.close * factor,
      ...(bar.volume === undefined ? {} : { volume: bar.volume })
    };
  });
}

/** Снимок прогона, пригодный для поэлементного сравнения. */
export interface DecisionTrace {
  readonly decisions: readonly RecordedDecision[];
  readonly trades: readonly {
    id: number;
    signalIndex: number;
    entryIndex: number;
    exitIndex: number;
    direction: string;
    plannedEntryPrice: number;
    plannedExitPrice: number;
    exitReason: string;
  }[];
  readonly skipped: readonly { index: number; reason: string }[];
  readonly rejected: readonly { index: number; reason: string }[];
}

function traceOf(
  decisions: readonly RecordedDecision[],
  result: BacktestResult,
  upToIndexExclusive: number
): DecisionTrace {
  return {
    decisions: decisions.filter((item) => item.index < upToIndexExclusive),
    trades: result.trades
      .filter((trade) => trade.exitIndex < upToIndexExclusive)
      .map((trade) => ({
        id: trade.id,
        signalIndex: trade.signalIndex,
        entryIndex: trade.entryIndex,
        exitIndex: trade.exitIndex,
        direction: trade.direction,
        plannedEntryPrice: trade.plannedEntryPrice,
        plannedExitPrice: trade.plannedExitPrice,
        exitReason: trade.exitReason
      })),
    skipped: result.skippedSignals
      .filter((item) => item.index < upToIndexExclusive)
      .map((item) => ({ index: item.index, reason: item.reason })),
    rejected: result.rejectedSignals
      .filter((item) => item.index < upToIndexExclusive)
      .map((item) => ({ index: item.index, reason: item.reason }))
  };
}

export interface InvarianceReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** Сколько решений совпало (должно равняться boundaryIndex). */
  readonly comparedDecisions: number;
  readonly comparedTrades: number;
}

/**
 * Контрфактическая проверка: замена ВСЕГО будущего не меняет ни одного
 * решения, ни одной закрывшейся до границы сделки.
 *
 * boundaryIndex — первый индекс, с которого данные «отравлены».
 */
export function assertDecisionInvariance(args: {
  readonly bars: readonly BacktestBar[];
  readonly provider: SignalProvider;
  readonly config?: BacktestInput["config"];
  readonly boundaryIndex: number;
  readonly factor?: number;
}): InvarianceReport {
  const errors: string[] = [];
  const factor = args.factor ?? 3.5;

  if (
    !Number.isInteger(args.boundaryIndex) ||
    args.boundaryIndex < 1 ||
    args.boundaryIndex > args.bars.length
  ) {
    return {
      ok: false,
      errors: [
        `boundaryIndex должен быть целым в [1, ${String(args.bars.length)}]`
      ],
      comparedDecisions: 0,
      comparedTrades: 0
    };
  }

  const baselineProbe = probeProvider({
    bars: args.bars,
    provider: args.provider,
    config: args.config
  });

  const poisonedBars = poisonFutureBars(
    args.bars,
    args.boundaryIndex,
    factor
  );

  const poisonedProbe = probeProvider({
    bars: poisonedBars,
    provider: args.provider,
    config: args.config
  });

  if (!baselineProbe.outcome.ok) {
    return {
      ok: false,
      errors: [`базовый прогон не выполнен: ${baselineProbe.errors.join("; ")}`],
      comparedDecisions: 0,
      comparedTrades: 0
    };
  }

  if (!poisonedProbe.outcome.ok) {
    return {
      ok: false,
      errors: [
        `прогон на «отравленном» будущем не выполнен: ${poisonedProbe.errors.join("; ")}`
      ],
      comparedDecisions: 0,
      comparedTrades: 0
    };
  }

  const baseline = traceOf(
    baselineProbe.decisions,
    baselineProbe.outcome.result,
    args.boundaryIndex
  );
  const poisoned = traceOf(
    poisonedProbe.decisions,
    poisonedProbe.outcome.result,
    args.boundaryIndex
  );

  if (baseline.decisions.length !== poisoned.decisions.length) {
    errors.push(
      `число решений до границы различается: ${String(baseline.decisions.length)} vs ${String(poisoned.decisions.length)}`
    );
  }

  const comparedDecisions = Math.min(
    baseline.decisions.length,
    poisoned.decisions.length
  );

  for (let i = 0; i < comparedDecisions; i += 1) {
    const a = baseline.decisions[i];
    const b = poisoned.decisions[i];

    if (
      a.index !== b.index ||
      a.time !== b.time ||
      a.kind !== b.kind ||
      a.stopLoss !== b.stopLoss ||
      a.takeProfit !== b.takeProfit ||
      a.positionOpen !== b.positionOpen
    ) {
      errors.push(
        `решение на баре ${String(a.index)} изменилось вместе с будущим (lookahead): ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
      );
    }
  }

  if (JSON.stringify(baseline.trades) !== JSON.stringify(poisoned.trades)) {
    errors.push(
      `сделки, закрытые до границы, изменились вместе с будущим (lookahead)`
    );
  }

  if (
    JSON.stringify(baseline.skipped) !== JSON.stringify(poisoned.skipped) ||
    JSON.stringify(baseline.rejected) !== JSON.stringify(poisoned.rejected)
  ) {
    errors.push(
      "skipped/rejected до границы изменились вместе с будущим (lookahead)"
    );
  }

  if (!baselineProbe.ok || !poisonedProbe.ok) {
    errors.push(
      `барьер no-lookahead не удержан: ${[...baselineProbe.errors, ...poisonedProbe.errors].join("; ")}`
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    comparedDecisions,
    comparedTrades: baseline.trades.length
  };
}
