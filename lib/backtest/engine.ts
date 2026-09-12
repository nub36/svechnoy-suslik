/**
 * P2-A — детерминированный движок исполнения.
 *
 * Чистая функция: (бары, источник решений, конфиг) → результат.
 * БЕЗ Prisma/PostgreSQL/сети/workers/process.env/текущего времени/
 * случайности (единственный внешний импорт во всём слое — sha256 в
 * serialize.ts, который тоже детерминирован).
 *
 * Цикл по барам (окно = сегмент или весь набор), на каждом баре i:
 *   1) исполнение отложенного входа (open бара i) — вход ВСЕГДА на баре,
 *      СЛЕДУЮЩЕМ за баром сигнала, и ВСЕГДА исполняется: гэп за уровень
 *      больше не отменяет сделку, а открывает и сразу закрывает её по
 *      тому же open (пункт 4a политики);
 *   2) сопровождение открытой позиции по OHLC бара i (гэп → same-bar
 *      политика → SL → TP → timeout → конец окна);
 *   3) оценка сигнала на ЗАКРЫТОМ баре i и постановка входа на i+1
 *      (скаляры решения снэпшотятся, пункт 22).
 *
 * Порядок (2)→(3) означает, что стратегия видит результат собственного
 * стопаута в том же баре и может дать новый сигнал (вход всё равно
 * только на следующем баре) — это законная информация, а не lookahead.
 *
 * NO-LOOKAHEAD — ДВЕ РАЗНЫЕ ГАРАНТИИ (пункт 20 политики, см.
 * no-lookahead.ts):
 *   A. СТРУКТУРНАЯ (здесь обеспечена кодом): источник решений получает
 *      SignalContext без массива баров, barAt(i) бросает при i > index и
 *      при i < firstVisibleIndex, visibleBars = index − firstVisibleIndex
 *      + 1, вход только по open следующего бара. Метка сегмента
 *      (TRAIN/VALIDATION/OOS) в контекст НЕ передаётся — слепой OOS.
 *   B. ВНЕШНЕЕ СОСТОЯНИЕ источника решений (замыкания, глобалы, сеть,
 *      собственная выборка данных) средствами JS не сертифицируется:
 *      для неё существует контракт SignalAdapter (данные только через
 *      SignalContext) и certifySignalAdapter, а не «доказательство».
 *
 * Разгон истории: warmup = max(config.warmupBars, requiredLookbackBars − 1)
 * баров ПЕРЕД окном — это каузальное прошлое, а не утечка.
 *
 * Отказы структурированы по стадиям: config → adapter → bars → provider
 * → arithmetic. Стадия "arithmetic" означает, что при конечном входе
 * арифметика потеряла конечность (overflow): успешный результат не может
 * содержать ни одного NaN/Infinity (пункт 17).
 */

import {
  entryFillPrice,
  exitFillPrice,
  feeForSide,
  grossPnl,
  plannedRewardRisk,
  plannedRiskAmount,
  riskAmount,
  slippageCost
} from "./costs";
import {
  BACKTEST_CONTRACT_VERSION,
  BACKTEST_ENGINE_NAME,
  type BacktestBar,
  type BacktestInput,
  type BacktestMetadata,
  type BacktestOutcome,
  type BacktestResult,
  type BacktestTrade,
  type DecisionCounts,
  type Direction,
  type EntryDecision,
  type EquityPoint,
  type ExitReason,
  type OpenPositionView,
  type RejectReason,
  type RejectedSignal,
  type ResolvedBacktestConfig,
  type SegmentWindow,
  type SignalAdapter,
  type SignalContext,
  type SignalDecision,
  type SignalProvider,
  type SkippedSignal,
  deepFreeze,
  isEntryDecision,
  isSignalAdapter,
  resolveBacktestConfig,
  signalProviderFromList
} from "./contract";
import { computeBacktestMetrics } from "./metrics";
import { fingerprintBars, fingerprintConfig } from "./serialize";
import {
  findNonFiniteNumbers,
  validateBars,
  validateDecisionObject,
  validateEntryDecisionShape,
  validateSegmentWindow,
  validateSignalAdapter
} from "./validate";

/**
 * Отложенный вход: решение принято на баре signalIndex.
 *
 * Скаляры и факты СНЭПШОТЯТСЯ в момент принятия (пункт 22 политики):
 * ссылка на объект решения вызывающего кода не сохраняется, поэтому
 * последующая мутация этого объекта не может изменить уже
 * запланированную сделку.
 */
interface PendingEntry {
  readonly signalIndex: number;
  readonly signalTime: number;
  readonly entryIndex: number;
  /** Опорная цена решения — close бара сигнала (знаменатель R). */
  readonly plannedEntryReference: number;
  readonly direction: Direction;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly label: string;
  readonly facts: readonly string[];
}

/** Открытая позиция (внутреннее представление). */
interface OpenPosition {
  readonly direction: Direction;
  readonly signalIndex: number;
  readonly signalTime: number;
  readonly entryIndex: number;
  readonly entryTime: number;
  /** Опорная цена сигнала (close бара сигнала) — плановый риск. */
  readonly plannedEntryReference: number;
  readonly plannedEntryPrice: number;
  readonly entryPrice: number;
  readonly feeEntry: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly label: string;
  readonly facts: readonly string[];
}

const EMPTY_DECISION_COUNTS: DecisionCounts = {
  LONG: 0,
  SHORT: 0,
  NEUTRAL: 0,
  CANNOT_EVALUATE: 0,
  NO_SIGNAL: 0
};

/**
 * Нормализация входа: замороженные копии баров, чтобы провайдер или
 * вызывающий код не могли изменить данные во время прогона.
 */
function freezeBars(bars: readonly BacktestBar[]): readonly BacktestBar[] {
  return bars.map((bar) =>
    Object.freeze(
      bar.volume === undefined
        ? {
            time: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close
          }
        : {
            time: bar.time,
            open: bar.open,
            high: bar.high,
            low: bar.low,
            close: bar.close,
            volume: bar.volume
          }
    )
  );
}

/** Проверка, что уровни строго обрамляют опорную цену. */
function levelsBracket(
  direction: Direction,
  reference: number,
  stopLoss: number,
  takeProfit: number
): boolean {
  return direction === "LONG"
    ? stopLoss < reference && reference < takeProfit
    : takeProfit < reference && reference < stopLoss;
}

/**
 * Прогон бэктеста.
 *
 * Любая несогласованность входа/конфига/провайдера — структурированный
 * отказ (ок = false) с перечнем ошибок; частичных результатов нет.
 */
export function runBacktest(input: BacktestInput): BacktestOutcome {
  const resolved = resolveBacktestConfig(input.config);

  if (!resolved.ok) {
    return { ok: false, stage: "config", errors: resolved.errors };
  }

  const config: ResolvedBacktestConfig = resolved.config;

  if (!Array.isArray(input.bars)) {
    return {
      ok: false,
      stage: "bars",
      errors: ["bars: ожидается массив свечей"]
    };
  }

  const segment: SegmentWindow | null = input.segment ?? null;
  const startIndex = segment === null ? 0 : segment.startIndex;
  const endIndexExclusive =
    segment === null ? input.bars.length : segment.endIndexExclusive;

  if (segment !== null) {
    const segmentErrors = validateSegmentWindow(
      input.bars.length,
      segment.startIndex,
      segment.endIndexExclusive
    );

    if (segmentErrors.length > 0) {
      return { ok: false, stage: "bars", errors: segmentErrors };
    }
  }

  const barsCheck = validateBars(input.bars, config);

  if (!barsCheck.ok) {
    return { ok: false, stage: "bars", errors: barsCheck.errors };
  }

  const bars = freezeBars(input.bars);

  /* ---------- источник решений: провайдер / список / адаптер ---------- */

  const adapter: SignalAdapter | null = isSignalAdapter(input.signals)
    ? input.signals
    : null;

  if (adapter !== null) {
    const adapterErrors = validateSignalAdapter(adapter);

    if (adapterErrors.length > 0) {
      return { ok: false, stage: "adapter", errors: adapterErrors };
    }
  }

  const signalSource = input.signals;
  const provider: SignalProvider = isSignalAdapter(signalSource)
    ? signalSource.decide
    : typeof signalSource === "function"
      ? signalSource
      : signalProviderFromList(signalSource);

  const signalSourceKind: "adapter" | "provider" | "list" = isSignalAdapter(
    signalSource
  )
    ? "adapter"
    : typeof signalSource === "function"
      ? "provider"
      : "list";

  /**
   * Требуемая каузальная история (пункт 19 политики): адаптер обязан
   * объявить, сколько закрытых баров ему нужно. Для «голой» функции и
   * списка требование не выдумывается — берётся только config.warmupBars.
   */
  const requiredLookbackBars =
    adapter === null ? 1 : adapter.requiredLookbackBars;
  const historyBars = Math.max(
    config.warmupBars,
    Math.max(0, requiredLookbackBars - 1)
  );
  const warmupStartIndex = Math.max(0, startIndex - historyBars);

  const trades: BacktestTrade[] = [];
  const skippedSignals: SkippedSignal[] = [];
  const rejectedSignals: RejectedSignal[] = [];
  const decisionCounts: Record<keyof DecisionCounts, number> = {
    ...EMPTY_DECISION_COUNTS
  };

  const providerErrors: string[] = [];
  let pending: PendingEntry | null = null;
  let open: OpenPosition | null = null;
  let tradeIdCounter = 0;
  let signalsEvaluated = 0;

  const reject = (
    index: number,
    time: number,
    kind: Direction,
    reason: RejectReason,
    detail: string,
    referencePrice: number,
    stopLoss: number,
    takeProfit: number,
    entryIndex: number | null = null,
    entryTime: number | null = null
  ): void => {
    rejectedSignals.push(
      Object.freeze({
        index,
        time,
        kind,
        reason,
        detail,
        // Неконечные значения входа нормализуются в null: успешный
        // результат обязан быть конечным целиком (пункт 17), а причина
        // отказа видна в detail.
        referencePrice: Number.isFinite(referencePrice)
          ? referencePrice
          : null,
        stopLoss: Number.isFinite(stopLoss) ? stopLoss : null,
        takeProfit: Number.isFinite(takeProfit) ? takeProfit : null,
        entryIndex,
        entryTime
      })
    );
  };

  for (let i = startIndex; i < endIndexExclusive; i += 1) {
    const bar = bars[i];

    /* ---------------- 1. исполнение отложенного входа --------------- */

    if (pending !== null && pending.entryIndex === i) {
      // Пункт 4a политики (исправлено аудитом): вход исполняется ВСЕГДА
      // по open бара N+1. Гэп через уровень больше НЕ удаляет сделку из
      // выборки — иначе терялся класс убыточных исходов и смещались
      // winRate/PF/drawdown/expectancy. Если open оказался за уровнем,
      // позиция открывается и закрывается по тому же open общим гэповым
      // правилом (пункт 7): валовый PnL ≈ 0, чистый — минус издержки.
      const plannedEntryPrice = bar.open;
      const entryPrice = entryFillPrice(
        plannedEntryPrice,
        pending.direction,
        config
      );

      open = {
        direction: pending.direction,
        signalIndex: pending.signalIndex,
        signalTime: pending.signalTime,
        entryIndex: i,
        entryTime: bar.time,
        plannedEntryReference: pending.plannedEntryReference,
        plannedEntryPrice,
        entryPrice,
        feeEntry: feeForSide(entryPrice, config.quantity, config),
        stopLoss: pending.stopLoss,
        takeProfit: pending.takeProfit,
        label: pending.label,
        facts: pending.facts
      };

      pending = null;
    }

    /* ---------------- 2. сопровождение открытой позиции ------------- */

    if (open !== null) {
      const barsHeld = i - open.entryIndex + 1;
      let plannedExitPrice: number | null = null;
      let exitReason: ExitReason | null = null;
      let gapThrough = false;
      let sameBarAmbiguity = false;

      // 2a. гэп через уровень на open. ВОЗМОЖЕН и на баре входа
      //     (пункт 4a): тогда позиция открывается и закрывается по
      //     одному и тому же open, а убыток равен издержкам.
      if (open.direction === "LONG") {
        if (bar.open <= open.stopLoss) {
          plannedExitPrice = bar.open;
          exitReason = "STOP_LOSS";
          gapThrough = true;
        } else if (bar.open >= open.takeProfit) {
          plannedExitPrice = bar.open;
          exitReason = "TAKE_PROFIT";
          gapThrough = true;
        }
      } else {
        if (bar.open >= open.stopLoss) {
          plannedExitPrice = bar.open;
          exitReason = "STOP_LOSS";
          gapThrough = true;
        } else if (bar.open <= open.takeProfit) {
          plannedExitPrice = bar.open;
          exitReason = "TAKE_PROFIT";
          gapThrough = true;
        }
      }

      // 2b. внутриварные касания.
      if (plannedExitPrice === null) {
        const slHit =
          open.direction === "LONG"
            ? bar.low <= open.stopLoss
            : bar.high >= open.stopLoss;
        const tpHit =
          open.direction === "LONG"
            ? bar.high >= open.takeProfit
            : bar.low <= open.takeProfit;

        if (slHit && tpHit) {
          sameBarAmbiguity = true;

          if (config.sameBarPolicy === "optimistic") {
            plannedExitPrice = open.takeProfit;
            exitReason = "TAKE_PROFIT";
          } else if (config.sameBarPolicy === "open-proximity") {
            const distanceToSl = Math.abs(bar.open - open.stopLoss);
            const distanceToTp = Math.abs(bar.open - open.takeProfit);

            // При равенстве дистанций — SL (пессимистичный tie-break).
            if (distanceToTp < distanceToSl) {
              plannedExitPrice = open.takeProfit;
              exitReason = "TAKE_PROFIT";
            } else {
              plannedExitPrice = open.stopLoss;
              exitReason = "STOP_LOSS";
            }
          } else {
            plannedExitPrice = open.stopLoss;
            exitReason = "STOP_LOSS";
          }
        } else if (slHit) {
          plannedExitPrice = open.stopLoss;
          exitReason = "STOP_LOSS";
        } else if (tpHit) {
          plannedExitPrice = open.takeProfit;
          exitReason = "TAKE_PROFIT";
        }
      }

      // 2c. timeout — только если уровни на этом баре не сработали
      //     (внутриварное касание хронологически раньше close).
      if (
        plannedExitPrice === null &&
        config.timeoutBars !== null &&
        barsHeld >= config.timeoutBars
      ) {
        plannedExitPrice = bar.close;
        exitReason = "TIMEOUT";
      }

      // 2d. конец окна: открытая позиция закрывается по close.
      if (plannedExitPrice === null && i === endIndexExclusive - 1) {
        plannedExitPrice = bar.close;
        exitReason = segment === null ? "END_OF_DATA" : "SEGMENT_END";
      }

      if (plannedExitPrice !== null && exitReason !== null) {
        const exitPrice = exitFillPrice(
          plannedExitPrice,
          open.direction,
          config
        );
        const feeExit = feeForSide(exitPrice, config.quantity, config);
        const gross = grossPnl(
          open.direction,
          open.entryPrice,
          exitPrice,
          config.quantity
        );
        const fees = open.feeEntry + feeExit;
        // Первичный знаменатель R — ПЛАНОВЫЙ риск (известен на баре
        // сигнала), фактический риск исполнения — только диагностика.
        const plannedRisk = plannedRiskAmount(
          open.plannedEntryReference,
          open.stopLoss,
          config.quantity
        );
        const actualFillRisk = riskAmount(
          open.entryPrice,
          open.stopLoss,
          config.quantity
        );

        trades.push(
          Object.freeze({
            id: tradeIdCounter,
            direction: open.direction,
            signalIndex: open.signalIndex,
            signalTime: open.signalTime,
            entryIndex: open.entryIndex,
            entryTime: open.entryTime,
            plannedEntryReference: open.plannedEntryReference,
            plannedEntryPrice: open.plannedEntryPrice,
            entryPrice: open.entryPrice,
            exitIndex: i,
            exitTime: bar.time,
            plannedExitPrice,
            exitPrice,
            exitReason,
            gapThrough,
            sameBarAmbiguity,
            barsHeld,
            quantity: config.quantity,
            stopLoss: open.stopLoss,
            takeProfit: open.takeProfit,
            plannedRisk,
            riskAmount: actualFillRisk,
            plannedRewardRisk: plannedRewardRisk(
              open.plannedEntryReference,
              open.stopLoss,
              open.takeProfit
            ),
            grossPnl: gross,
            feeEntry: open.feeEntry,
            feeExit,
            feesTotal: fees,
            slippageCost: slippageCost(
              open.direction,
              open.plannedEntryPrice,
              open.entryPrice,
              plannedExitPrice,
              exitPrice,
              config.quantity
            ),
            netPnl: gross - fees,
            grossR: plannedRisk === 0 ? 0 : gross / plannedRisk,
            rMultiple: plannedRisk === 0 ? 0 : (gross - fees) / plannedRisk,
            grossRActualFill:
              actualFillRisk === 0 ? 0 : gross / actualFillRisk,
            rMultipleActualFill:
              actualFillRisk === 0 ? 0 : (gross - fees) / actualFillRisk,
            label: open.label,
            facts: open.facts
          })
        );

        tradeIdCounter += 1;
        open = null;
      }
    }

    /* ---------------- 3. оценка сигнала на закрытом баре i ---------- */

    signalsEvaluated += 1;

    const positionView: OpenPositionView | null =
      open === null
        ? null
        : Object.freeze({
            direction: open.direction,
            entryIndex: open.entryIndex,
            entryTime: open.entryTime,
            entryPrice: open.entryPrice,
            stopLoss: open.stopLoss,
            takeProfit: open.takeProfit,
            barsHeld: i - open.entryIndex + 1
          });

    const context: SignalContext = Object.freeze({
      index: i,
      // visibleBars обязан равняться index − firstVisibleIndex + 1, то
      // есть ЧИСЛУ БАРОВ, ДОСТИЖИМЫХ через barAt. При warmup > 0 (и при
      // обязательном разгоне адаптера) это меньше i + 1: прежнее
      // i + 1 было ложным заявлением о доступной истории.
      visibleBars: i - warmupStartIndex + 1,
      firstVisibleIndex: warmupStartIndex,
      bar,
      barAt: (requested: number) => {
        if (!Number.isInteger(requested)) {
          throw new Error(
            `no-lookahead: barAt(${String(requested)}) — индекс должен быть целым`
          );
        }

        if (requested > i) {
          throw new Error(
            `no-lookahead: barAt(${String(requested)}) при текущем индексе ${String(i)} — чтение будущих баров запрещено`
          );
        }

        if (requested < warmupStartIndex) {
          throw new Error(
            `segment-window: barAt(${String(requested)}) вне окна (warmup с ${String(warmupStartIndex)})`
          );
        }

        return bars[requested];
      },
      position: positionView
      // Метка сегмента из контекста УБРАНА: решения не должны знать,
      // прогоняются ли они в TRAIN/VAL/OOS (слепой OOS). Инженер
      // передаёт сегмент провайдеру сам — и тогда утечка становится
      // явной, проверяемой и не маскируется движком.
    });

    let decision: SignalDecision | null;

    try {
      decision = provider(context);
    } catch (error) {
      providerErrors.push(
        `signals на баре ${String(i)} (time=${String(bar.time)}): ${
          error instanceof Error ? error.message : String(error)
        }`
      );

      break;
    }

    if (decision === null || decision === undefined) {
      decisionCounts.NO_SIGNAL += 1;

      continue;
    }

    if (
      decision.kind !== "LONG" &&
      decision.kind !== "SHORT" &&
      decision.kind !== "NEUTRAL" &&
      decision.kind !== "CANNOT_EVALUATE"
    ) {
      providerErrors.push(
        `signals на баре ${String(i)}: неизвестный kind=${String(decision.kind)}`
      );

      break;
    }

    // Любое решение проверяется в момент принятия: скаляры конечны,
    // label — строка (если задан), facts — массив строк (если задан).
    const objectShape = validateDecisionObject(decision);

    if (!objectShape.ok) {
      providerErrors.push(
        `signals на баре ${String(i)} (time=${String(bar.time)}): ${objectShape.detail}`
      );

      break;
    }

    decisionCounts[decision.kind] += 1;

    if (!isEntryDecision(decision)) {
      // NEUTRAL и CANNOT_EVALUATE: сделки нет (считаются раздельно).
      continue;
    }

    // LONG/SHORT: одна позиция одновременно, пирамидинга нет.
    if (open !== null) {
      skippedSignals.push(
        Object.freeze({
          index: i,
          time: bar.time,
          kind: decision.kind,
          reason: "position-open"
        })
      );

      continue;
    }

    // Согласованность уровней относительно close бара СИГНАЛА: если
    // они не обрамляют close, решение внутренне противоречиво.
    const shape = validateEntryDecisionShape(decision);

    if (!shape.ok) {
      reject(
        i,
        bar.time,
        decision.kind,
        "invalid-levels",
        shape.detail,
        bar.close,
        decision.stopLoss,
        decision.takeProfit
      );

      continue;
    }

    if (!levelsBracket(decision.kind, bar.close, decision.stopLoss, decision.takeProfit)) {
      reject(
        i,
        bar.time,
        decision.kind,
        "levels-on-wrong-side",
        decision.kind === "LONG"
          ? `для LONG требуется sl < close < tp, есть sl=${String(decision.stopLoss)} close=${String(bar.close)} tp=${String(decision.takeProfit)}`
          : `для SHORT требуется tp < close < sl, есть tp=${String(decision.takeProfit)} close=${String(bar.close)} sl=${String(decision.stopLoss)}`,
        bar.close,
        decision.stopLoss,
        decision.takeProfit
      );

      continue;
    }

    if (i + 1 >= endIndexExclusive) {
      // Следующего бара в окне нет: вход невозможен (no-lookahead).
      skippedSignals.push(
        Object.freeze({
          index: i,
          time: bar.time,
          kind: decision.kind,
          reason: segment === null ? "no-next-bar" : "segment-boundary"
        })
      );

      continue;
    }

    pending = {
      signalIndex: i,
      signalTime: bar.time,
      entryIndex: i + 1,
      // Снэшот плановых скаляров: опорная цена = close бара сигнала.
      plannedEntryReference: bar.close,
      direction: decision.kind,
      stopLoss: decision.stopLoss,
      takeProfit: decision.takeProfit,
      label: decision.label ?? "",
      facts: Object.freeze([...(decision.facts ?? [])])
    };
  }

  if (providerErrors.length > 0) {
    return { ok: false, stage: "provider", errors: providerErrors };
  }

  // Недостижимо при корректном цикле (позиция закрывается на последнем
  // баре окна), но защита от рассинхронизации политики нужна явно.
  if (open !== null) {
    return {
      ok: false,
      stage: "provider",
      errors: [
        "инвариант нарушен: позиция осталась открытой после конца окна"
      ]
    };
  }

  const equityCurve: EquityPoint[] = [
    Object.freeze({
      tradeIndex: -1,
      time: bars[startIndex].time,
      equity: config.initialEquity
    })
  ];

  let runningEquity = config.initialEquity;

  for (const trade of trades) {
    runningEquity += trade.netPnl;

    equityCurve.push(
      Object.freeze({
        tradeIndex: trade.id,
        time: trade.exitTime,
        equity: runningEquity
      })
    );
  }

  const windowBars = bars.slice(startIndex, endIndexExclusive);
  const windowCheck = validateBars(windowBars, config);
  const metrics = computeBacktestMetrics({
    trades,
    bars,
    startIndex,
    endIndexExclusive,
    config
  });

  const metadata: BacktestMetadata = Object.freeze({
    contractVersion: BACKTEST_CONTRACT_VERSION,
    engine: BACKTEST_ENGINE_NAME,
    configFingerprint: fingerprintConfig(config),
    barsFingerprint: fingerprintBars(bars),
    barsCount: windowBars.length,
    firstBarTime: windowCheck.firstBarTime,
    lastBarTime: windowCheck.lastBarTime,
    timeframeMs: windowCheck.timeframeMs,
    gridGaps: windowCheck.gridGaps,
    maxGapMs: windowCheck.maxGapMs,
    segment: segment === null ? null : segment.name,
    segmentStartIndex: segment === null ? null : segment.startIndex,
    segmentEndIndexExclusive:
      segment === null ? null : segment.endIndexExclusive,
    warmupStartIndex: segment === null ? null : warmupStartIndex,
    signalSourceKind,
    adapterId: adapter === null ? null : adapter.adapterId,
    adapterVersion: adapter === null ? null : adapter.version,
    requiredLookbackBars,
    historyStartIndex: warmupStartIndex
  });

  // ГЛУБОКАЯ заморозка (пункт 18 политики): вложенные объекты
  // (config.slippage, config.fees, каждая сделка, facts, equity-точки,
  // metrics.exitReasonCounts) тоже неизменяемы, поэтому вызывающий код
  // не может подменить значение после расчёта и получить расхождение
  // между configFingerprint и фактическими параметрами.
  const result = deepFreeze<BacktestResult>({
    metadata,
    config,
    input: {
      barsCount: windowBars.length,
      signalsEvaluated,
      decisionCounts: { ...decisionCounts }
    },
    trades,
    skippedSignals,
    rejectedSignals,
    equityCurve,
    metrics
  });

  /* -------- полная арифметика: никаких NaN/Infinity в ok:true -------- */

  // Вход проверен на конечность, но конечные значения могут дать
  // overflow (quantity=1e308 × цена → Infinity). Такой результат нельзя
  // публиковать как успех: serializeResult бросил бы исключение, а
  // downstream увидел бы maxDrawdown=0 и profitFactorState="no-losses".
  const nonFinite = findNonFiniteNumbers(result, "result");

  if (nonFinite.length > 0) {
    return {
      ok: false,
      stage: "arithmetic",
      errors: [
        `арифметика потеряла конечность при конечном входе (overflow/точность): ${nonFinite.join(
          "; "
        )}`
      ]
    };
  }

  return { ok: true, result };
}
