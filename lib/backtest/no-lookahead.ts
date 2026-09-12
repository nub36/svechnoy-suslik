/**
 * P2-A — no-lookahead: ДВЕ РАЗНЫЕ гарантии, которые запрещено смешивать.
 *
 * ГАРАНТИЯ A — СТРУКТУРНАЯ (доказуема кодом и проверяется пробой).
 * Данные, которые движок выдаёт источнику решений через
 * `SignalContext` (bar, barAt, position), не содержат будущего:
 * `barAt(index + k)` бросает исключение при любом k > 0,
 * `barAt(firstVisibleIndex − 1)` — тоже, `visibleBars` равен фактически
 * доступному числу баров (index − firstVisibleIndex + 1). Это
 * проверяется `probeProvider`: на каждом баре проба АКТИВНО пытается
 * прочитать будущее и прошлое за пределами окна. Гарантия A относится к
 * КАНАЛУ ДВИЖКА и не зависит от того, что делает вызывающий код.
 *
 * ГАРАНТИЯ B — ВНЕШНЕЕ СОСТОЯНИЕ ИСТОЧНИКА РЕШЕНИЙ (в JS недоказуема).
 * Провайдер-функция может держать будущие бары в замыкании, в глобале,
 * в заранее вычисленном массиве или получить их из сети. Отозвать уже
 * выданные данные язык не позволяет, поэтому НИ ОДИН тест не может
 * сертифицировать произвольный колбэк. Именно здесь была ошибка
 * исходной версии P2-A: контрфактическая проверка выдавалась за
 * доказательство no-lookahead, хотя «отравление» будущего подменяет
 * только массив, переданный движку, — массив, скопированный замыканием,
 * остаётся нетронутым, и читер проходит проверку зелёным.
 *
 * Поэтому в этом модуле:
 *  1) `probeProvider` — проба структурного барьера (гарантия A);
 *  2) `diagnoseDecisionInvariance` — КОНТРФАКТИЧЕСКАЯ ДИАГНОСТИКА
 *     (не сертификация): подменяет будущее в канале движка и сравнивает
 *     решения до границы. Каждый отчёт несёт поле `guarantee` и
 *     непустой `limitations`;
 *     `assertDecisionInvariance` сохранён как устаревшее имя-обёртка;
 *  3) `certifySignalAdapter` — сертификация АДАПТЕРА для P2-B: структурная
 *     проба + воспроизводимость (ловит Date.now()/random/состояние
 *     замыкания) + достаточность заявленного `requiredLookbackBars`
 *     (сравнение прогонов с объявленной и увеличенной историей) +
 *     контрфактическая диагностика. Сертифицируется формула
 *     «context-channel-only»: адаптер получает рыночные данные только
 *     через контекст движка. Собственная выборка данных адаптера
 *     сертифицируется ревью кода, а не этим инструментом.
 *
 * Все инструменты чистые и детерминированные (без Date.now, random,
 * env, fs, сети).
 */

import {
  type BacktestBar,
  type BacktestInput,
  type BacktestResult,
  type SignalAdapter,
  type SignalDecision,
  type SignalDecisionKind,
  type SignalProvider,
  type SignalSource,
  type SplitName,
  isSignalAdapter,
  signalProviderFromList
} from "./contract";
import { runBacktest } from "./engine";
import { validateSignalAdapter } from "./validate";

/* ------------------------------------------------------------------ */
/* Гарантия A: структурная проба                                        */
/* ------------------------------------------------------------------ */

/** Записанное решение источника сигналов на одном баре. */
export interface RecordedDecision {
  readonly index: number;
  readonly time: number;
  /** Индекс первого бара, доступного через barAt (начало warmup-окна). */
  readonly firstVisibleIndex: number;
  /**
   * Сколько баров было ВИДНО (index − firstVisibleIndex + 1). При
   * warmup > 0 это меньше index + 1: прежнее «index + 1» было ложным
   * заявлением о доступной истории.
   */
  readonly visibleBars: number;
  readonly kind: SignalDecisionKind | "NO_SIGNAL";
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
  /** Была ли открыта позиция на момент оценки сигнала. */
  readonly positionOpen: boolean;
}

/** Результат активной пробы структурного барьера no-lookahead. */
export interface LookaheadProbe {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** Что именно доказано этой пробой. */
  readonly guarantee: "structural-context-barrier";
  /** Чем эта проба НЕ является (всегда непустой список). */
  readonly limitations: readonly string[];
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

/**
 * Ограничения структурной пробы: они одинаковы для любого прогона и
 * публикуются вместе с результатом, чтобы «зелёная проба» не читалась
 * как «стратегия не имеет lookahead».
 */
export const PROBE_LIMITATIONS: readonly string[] = Object.freeze([
  "Проба доказывает только guarantee A: SignalContext (bar/barAt/position) не отдаёт будущее и не выходит за warmup-окно. Это свойство канала данных движка, а не свойства стратегии.",
  "Проба НЕ доказывает guarantee B: источник решений может держать будущие бары в замыкании, глобале, заранее вычисленном массиве или получить их из сети — JS не позволяет отозвать выданные данные.",
  "Зелёная проба не означает ни прибыльности, ни корректности финансовой логики."
]);

function decisionOf(
  decision: SignalDecision | null | undefined
): {
  kind: RecordedDecision["kind"];
  stopLoss: number | null;
  takeProfit: number | null;
} {
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

function sameBar(a: BacktestBar, b: BacktestBar): boolean {
  return (
    a.time === b.time &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

/**
 * Активная проба: прогон с источником решений, обёрнутым так, что на
 * каждом баре проба (а) записывает решение, (б) проверяет заявленную
 * видимость, (в) пытается читать будущее и прошлое за пределами
 * warmup-окна, (г) проверяет законные чтения на границах окна.
 *
 * `provider` принимает ЛЮБУЮ форму источника (функция, список или
 * адаптер). Для адаптера обёртка сохраняется адаптером же — с тем же
 * adapterId/version/requiredLookbackBars, — поэтому движок поднимает
 * warmup по заявлению адаптера, а проба остаётся структурной.
 */
export function probeProvider(args: {
  readonly bars: readonly BacktestBar[];
  readonly provider: SignalSource;
  readonly config?: BacktestInput["config"];
  readonly segment?: BacktestInput["segment"];
}): LookaheadProbe {
  const probedAdapter: SignalAdapter | null = isSignalAdapter(args.provider)
    ? args.provider
    : null;
  const innerProvider: SignalProvider = isSignalAdapter(args.provider)
    ? args.provider.decide
    : typeof args.provider === "function"
      ? args.provider
      : signalProviderFromList(args.provider);
  const decisions: RecordedDecision[] = [];
  const guardFailures: { index: number; requested: number }[] = [];
  const windowFailures: { index: number; requested: number }[] = [];
  const errors: string[] = [];

  const wrapper: SignalProvider = (context) => {
    // (б) видимость: visibleBars = index − firstVisibleIndex + 1, то
    //     есть РОВНО число баров, достижимых через barAt.
    const expectedVisible = context.index - context.firstVisibleIndex + 1;

    if (context.visibleBars !== expectedVisible) {
      errors.push(
        `видимость нарушена на баре ${String(context.index)}: visibleBars=${String(
          context.visibleBars
        )}, ожидается index − firstVisibleIndex + 1 = ${String(expectedVisible)}`
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

    // (в) прошлое за пределами warmup-окна.
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

    // (г) законное чтение текущего бара.
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

    // (г) законное чтение ПЕРВОГО видимого бара (граница warmup-окна):
    //     движок обязан отдавать каузальную историю, а не «обрезать» её.
    const expectedFirst = args.bars[context.firstVisibleIndex];

    if (expectedFirst !== undefined) {
      try {
        const first = context.barAt(context.firstVisibleIndex);

        if (!sameBar(first, expectedFirst)) {
          errors.push(
            `barAt(firstVisibleIndex=${String(
              context.firstVisibleIndex
            )}) вернул не тот бар, который передан движку`
          );
        }
      } catch {
        errors.push(
          `barAt(firstVisibleIndex=${String(
            context.firstVisibleIndex
          )}) бросил исключение на законном индексе`
        );
      }
    }

    const decision = innerProvider(context);
    const recorded = decisionOf(decision);

    decisions.push({
      index: context.index,
      time: context.bar.time,
      firstVisibleIndex: context.firstVisibleIndex,
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
    signals:
      probedAdapter === null
        ? wrapper
        : {
            adapterId: probedAdapter.adapterId,
            version: probedAdapter.version,
            requiredLookbackBars: probedAdapter.requiredLookbackBars,
            decide: wrapper
          },
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
    guarantee: "structural-context-barrier",
    limitations: PROBE_LIMITATIONS,
    decisions,
    barsProbed: decisions.length,
    guardFailures,
    windowFailures,
    outcome
  };
}

/* ------------------------------------------------------------------ */
/* Контрфактическая ДИАГНОСТИКА (не сертификация)                       */
/* ------------------------------------------------------------------ */

/**
 * «Отравление» будущего: бары с индекса fromIndex (включительно)
 * умножаются на коэффициент. time сохраняются, OHLC-инварианты
 * выполняются (масштабирование всех четырёх цен их не нарушает),
 * монотонность сетки не меняется.
 *
 * ВАЖНО: подменяется только массив, ПЕРЕДАННЫЙ ДВИЖКУ. Копии баров,
 * которые источник решений сделал сам (в замыкании, в глобале, в
 * кэше), остаются прежними — именно поэтому результат этой проверки
 * нельзя называть доказательством отсутствия lookahead.
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

/**
 * Ограничения контрфактической диагностики. Публикуются в КАЖДОМ
 * отчёте (и в успешном тоже): ok:true здесь означает «решения не
 * изменились при подмене будущего в канале движка», а НЕ «lookahead
 * отсутствует».
 */
export const INVARIANCE_LIMITATIONS: readonly string[] = Object.freeze([
  "Это ДИАГНОСТИКА, а не сертификация: подменяется будущее только в массиве, переданном движку. Источник решений, держащий будущие бары в замыкании, глобале, кэше или заранее вычисленном срезе, проходит её зелёным — это доказанный предел метода (регрессия: closureCheater в scripts/test-backtest-engine.ts и scripts/test-backtest-hardening.ts).",
  "ok:true НЕ означает отсутствие lookahead и НЕ означает прибыльность.",
  "Провайдер, использующий Date.now(), Math.random(), env или сеть, может менять решения по причинам, не связанным с будущими барами: такая нестабильность этой проверкой не объясняется.",
  "Крючок rebind — единственный способ подменить будущее и в собственном держателе источника решений: без него диагностика сравнивает два идентичных прогона и вырождается. Даже с rebind она не покрывает замыкания, скопировавшие бары заранее.",
  "Доказуемая гарантия — только структурная (probeProvider / certifySignalAdapter). Для внешнего источника решений обязателен контракт адаптера: рыночные данные поступают ИСКЛЮЧИТЕЛЬНО через SignalContext, а собственная выборка данных адаптера проверяется ревью кода."
]);

export interface InvarianceReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /** Что именно проверено: контрфакт в канале движка, не сертификация. */
  readonly guarantee: "counterfactual-diagnostic";
  /** Всегда непустой список: пределы метода (INVARIANCE_LIMITATIONS). */
  readonly limitations: readonly string[];
  /** Сколько решений совпало (должно равняться boundaryIndex). */
  readonly comparedDecisions: number;
  readonly comparedTrades: number;
}

function invarianceReport(args: {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly comparedDecisions: number;
  readonly comparedTrades: number;
}): InvarianceReport {
  return {
    ok: args.ok,
    errors: args.errors,
    guarantee: "counterfactual-diagnostic",
    limitations: INVARIANCE_LIMITATIONS,
    comparedDecisions: args.comparedDecisions,
    comparedTrades: args.comparedTrades
  };
}

/**
 * Контрфактическая ДИАГНОСТИКА: замена всего будущего В МАССИВЕ,
 * ПЕРЕДАННОМ ДВИЖКУ, не меняет ни одного решения и ни одной сделки,
 * закрывшейся до границы.
 *
 * boundaryIndex — первый индекс, с которого данные «отравлены».
 *
 * Метод ловит lookahead, приходящий через канал движка, и НЕ ловит
 * lookahead из замыканий/глобалов (см. INVARIANCE_LIMITATIONS).
 */
export function diagnoseDecisionInvariance(args: {
  readonly bars: readonly BacktestBar[];
  readonly provider: SignalSource;
  readonly config?: BacktestInput["config"];
  readonly segment?: BacktestInput["segment"];
  readonly boundaryIndex: number;
  readonly factor?: number;
  /**
   * Необязательный крючок: вызывается ПЕРЕД каждым из двух прогонов с
   * тем массивом баров, который будет передан движку (сначала исходный,
   * затем «отравленный»).
   *
   * Это ЕДИНСТВЕННЫЙ способ дать диагностике реальную силу против
   * источника решений, который берёт данные из собственного держателя
   * (модульной переменной, поля объекта, кэша): без rebind подмена
   * будущего до такого источника не доходит, и проверка вырождается в
   * сравнение идентичных прогонов. Оба исхода покрыты тестами в
   * scripts/test-backtest-hardening.ts.
   */
  readonly rebind?: (bars: readonly BacktestBar[]) => void;
}): InvarianceReport {
  const errors: string[] = [];
  const factor = args.factor ?? 3.5;

  if (
    !Number.isInteger(args.boundaryIndex) ||
    args.boundaryIndex < 1 ||
    args.boundaryIndex > args.bars.length
  ) {
    return invarianceReport({
      ok: false,
      errors: [
        `boundaryIndex должен быть целым в [1, ${String(args.bars.length)}]`
      ],
      comparedDecisions: 0,
      comparedTrades: 0
    });
  }

  if (args.rebind !== undefined) {
    args.rebind(args.bars);
  }

  const baselineProbe = probeProvider({
    bars: args.bars,
    provider: args.provider,
    config: args.config,
    segment: args.segment
  });

  const poisonedBars = poisonFutureBars(
    args.bars,
    args.boundaryIndex,
    factor
  );

  if (args.rebind !== undefined) {
    args.rebind(poisonedBars);
  }

  const poisonedProbe = probeProvider({
    bars: poisonedBars,
    provider: args.provider,
    config: args.config,
    segment: args.segment
  });

  // Держатель источника решений возвращается в исходное состояние:
  // диагностика не должна оставлять побочных эффектов.
  if (args.rebind !== undefined) {
    args.rebind(args.bars);
  }

  if (!baselineProbe.outcome.ok) {
    return invarianceReport({
      ok: false,
      errors: [
        `базовый прогон не выполнен: ${baselineProbe.errors.join("; ")}`
      ],
      comparedDecisions: 0,
      comparedTrades: 0
    });
  }

  if (!poisonedProbe.outcome.ok) {
    return invarianceReport({
      ok: false,
      errors: [
        `прогон на «отравленном» будущем не выполнен: ${poisonedProbe.errors.join("; ")}`
      ],
      comparedDecisions: 0,
      comparedTrades: 0
    });
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
        `решение на баре ${String(a.index)} изменилось вместе с будущим (lookahead в канале движка): ${JSON.stringify(a)} vs ${JSON.stringify(b)}`
      );
    }
  }

  if (JSON.stringify(baseline.trades) !== JSON.stringify(poisoned.trades)) {
    errors.push(
      "сделки, закрытые до границы, изменились вместе с будущим (lookahead в канале движка)"
    );
  }

  if (
    JSON.stringify(baseline.skipped) !== JSON.stringify(poisoned.skipped) ||
    JSON.stringify(baseline.rejected) !== JSON.stringify(poisoned.rejected)
  ) {
    errors.push(
      "skipped/rejected до границы изменились вместе с будущим (lookahead в канале движка)"
    );
  }

  if (!baselineProbe.ok || !poisonedProbe.ok) {
    errors.push(
      `структурный барьер no-lookahead не удержан: ${[
        ...baselineProbe.errors,
        ...poisonedProbe.errors
      ].join("; ")}`
    );
  }

  return invarianceReport({
    ok: errors.length === 0,
    errors,
    comparedDecisions,
    comparedTrades: baseline.trades.length
  });
}

/**
 * @deprecated Имя сохранено для совместимости с P2-A тестами и
 * вызывающим кодом. Семантика — КОНТРФАКТИЧЕСКАЯ ДИАГНОСТИКА, а не
 * сертификация no-lookahead: используйте `diagnoseDecisionInvariance`
 * и читайте `limitations` в отчёте.
 */
export const assertDecisionInvariance = diagnoseDecisionInvariance;

/* ------------------------------------------------------------------ */
/* Сертификация адаптера (контракт для P2-B)                            */
/* ------------------------------------------------------------------ */

/** Сравнение решений двух прогонов (поэлементно). */
function compareDecisions(
  a: readonly RecordedDecision[],
  b: readonly RecordedDecision[],
  options: { readonly includeVisibility: boolean }
): { readonly errors: string[]; readonly compared: number } {
  const errors: string[] = [];

  if (a.length !== b.length) {
    errors.push(
      `число решений различается: ${String(a.length)} vs ${String(b.length)}`
    );
  }

  const compared = Math.min(a.length, b.length);

  for (let i = 0; i < compared; i += 1) {
    const left = a[i];
    const right = b[i];
    const differences: string[] = [];

    if (left.index !== right.index) {
      differences.push(`index ${String(left.index)}→${String(right.index)}`);
    }

    if (left.time !== right.time) {
      differences.push(`time ${String(left.time)}→${String(right.time)}`);
    }

    if (left.kind !== right.kind) {
      differences.push(`kind ${left.kind}→${right.kind}`);
    }

    if (left.stopLoss !== right.stopLoss) {
      differences.push(
        `stopLoss ${String(left.stopLoss)}→${String(right.stopLoss)}`
      );
    }

    if (left.takeProfit !== right.takeProfit) {
      differences.push(
        `takeProfit ${String(left.takeProfit)}→${String(right.takeProfit)}`
      );
    }

    if (left.positionOpen !== right.positionOpen) {
      differences.push(
        `positionOpen ${String(left.positionOpen)}→${String(right.positionOpen)}`
      );
    }

    // Видимость сравнивается только между прогонами с ОДИНАКОВЫМ
    // warmup: при увеличенной истории firstVisibleIndex legitimately
    // отличается, это не lookahead и не ошибка.
    if (
      options.includeVisibility &&
      (left.firstVisibleIndex !== right.firstVisibleIndex ||
        left.visibleBars !== right.visibleBars)
    ) {
      differences.push(
        `видимость ${String(left.firstVisibleIndex)}/${String(
          left.visibleBars
        )}→${String(right.firstVisibleIndex)}/${String(right.visibleBars)}`
      );
    }

    if (differences.length > 0) {
      errors.push(
        `решение на баре ${String(left.index)} разошлось: ${differences.join(", ")}`
      );
    }
  }

  return { errors, compared };
}

export interface DeterminismReplay {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly comparedDecisions: number;
}

export interface LookbackReplay {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly comparedDecisions: number;
  /** warmup, соответствующий заявленному requiredLookbackBars. */
  readonly declaredWarmupBars: number;
  /** warmup, которым история намеренно увеличена для проверки. */
  readonly extraWarmupBars: number;
  /** Индекс первого бара истории в каждом из двух прогонов. */
  readonly declaredHistoryStartIndex: number | null;
  readonly extraHistoryStartIndex: number | null;
  /**
   * true, если увеличенная история уперлась в начало массива: тогда
   * оба прогона видят одинаковую историю и проверка вырождена
   * (публикуется как ограничение, а не как успех).
   */
  readonly historyClampedAtZero: boolean;
}

export interface AdapterCertification {
  readonly ok: boolean;
  readonly errors: readonly string[];
  /**
   * ЧТО именно сертифицировано: канал данных движка (гарантия A) плюс
   * воспроизводимость и достаточность заявленной истории адаптера.
   * Замыкания и собственная выборка данных адаптера НЕ сертифицируются.
   */
  readonly guarantee: "context-channel-only";
  /** Всегда непустой список ограничений (см. CERTIFICATION_LIMITATIONS). */
  readonly limitations: readonly string[];
  readonly adapterId: string;
  readonly adapterVersion: string;
  readonly requiredLookbackBars: number;
  readonly window: { readonly startIndex: number; readonly endIndexExclusive: number };
  /** Структурная проба (гарантия A) в сертифицируемом окне. */
  readonly structuralProbe: LookaheadProbe | null;
  /** Два одинаковых прогона: ловит Date.now()/random/состояние замыкания. */
  readonly determinism: DeterminismReplay | null;
  /** Заявленный lookback против увеличенного: достаточность требования. */
  readonly lookbackReplay: LookbackReplay | null;
  /** Контрфактическая диагностика (со своими ограничениями). */
  readonly invariance: InvarianceReport | null;
}

export const CERTIFICATION_LIMITATIONS: readonly string[] = Object.freeze([
  "Сертифицируется КАНАЛ ДАННЫХ ДВИЖКА (guarantee A): SignalContext.bar/barAt/position не отдают будущее и не выходят за warmup-окно.",
  "Замыкания, глобалы, заранее вычисленные массивы, Date.now(), Math.random(), env, сеть и файловая система внутри decide НЕ сертифицируемы средствами JS (guarantee B отсутствует). Воспроизводимость (determinism) ловит лишь нестабильные решения, но не доказывает их каузальность.",
  "Контрфактическая диагностика (invariance) ловит lookahead только через массив, переданный движку: источник решений с собственным срезом будущего проходит её зелёным.",
  "Требуемый контракт P2-B: рыночные данные поступают адаптеру ИСКЛЮЧИТЕЛЬНО через SignalContext. Собственная выборка данных адаптера (источник баров, кэши, внешние факторы) сертифицируется ревью кода, а не этим инструментом.",
  "Сертификация не говорит ничего о прибыльности и не заменяет независимую проверку на VPS."
]);

function certification(args: {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly limitations?: readonly string[];
  readonly adapter: SignalAdapter | null;
  readonly window: { startIndex: number; endIndexExclusive: number };
  readonly structuralProbe?: LookaheadProbe | null;
  readonly determinism?: DeterminismReplay | null;
  readonly lookbackReplay?: LookbackReplay | null;
  readonly invariance?: InvarianceReport | null;
}): AdapterCertification {
  const adapter = args.adapter;

  return {
    ok: args.ok,
    errors: args.errors,
    guarantee: "context-channel-only",
    limitations: args.limitations ?? CERTIFICATION_LIMITATIONS,
    adapterId: adapter === null ? "" : adapter.adapterId,
    adapterVersion: adapter === null ? "" : adapter.version,
    requiredLookbackBars: adapter === null ? 1 : adapter.requiredLookbackBars,
    window: {
      startIndex: args.window.startIndex,
      endIndexExclusive: args.window.endIndexExclusive
    },
    structuralProbe: args.structuralProbe ?? null,
    determinism: args.determinism ?? null,
    lookbackReplay: args.lookbackReplay ?? null,
    invariance: args.invariance ?? null
  };
}

/** Имя сегмента для сертификационного окна: решения не видят его (слепой OOS). */
const CERTIFICATION_SEGMENT_NAME: SplitName = "OOS";

/**
 * Сертификация адаптера источника решений.
 *
 * Проверяются четыре вещи:
 *  1) структурный барьер движка (проба на каждом баре окна);
 *  2) воспроизводимость: два идентичных прогона дают идентичные решения
 *     (Date.now()/random/накапливаемое состояние замыкания — отказ);
 *  3) достаточность заявленного requiredLookbackBars: прогон с
 *     увеличенной (но всё ещё каузальной) историей обязан дать те же
 *     решения — иначе адаптер читает глубже, чем объявил, и в
 *     сегментном прогоне его поведение зависит от длины разгона;
 *  4) контрфактическая диагностика (со своими ограничениями).
 *
 * Успех означает guarantee = "context-channel-only" и НЕ означает, что
 * адаптер не имеет lookahead через собственные замыкания (это
 * недоказуемо в JS) и НЕ означает прибыльность.
 */
export function certifySignalAdapter(args: {
  readonly bars: readonly BacktestBar[];
  readonly adapter: SignalAdapter;
  readonly config?: BacktestInput["config"];
  readonly startIndex?: number;
  readonly endIndexExclusive?: number;
  /** Насколько глубже заявленного lookback поднять историю (по умолчанию 25). */
  readonly extraLookbackBars?: number;
  /** Граница контрфактического диагноза (по умолчанию середина окна). */
  readonly boundaryIndex?: number;
}): AdapterCertification {
  const errors: string[] = [];
  const barsCount = Array.isArray(args.bars) ? args.bars.length : 0;

  const adapterErrors = validateSignalAdapter(args.adapter);

  if (adapterErrors.length > 0) {
    return certification({
      ok: false,
      errors: adapterErrors,
      adapter: null,
      window: { startIndex: 0, endIndexExclusive: barsCount }
    });
  }

  const startIndex = args.startIndex ?? 0;
  const endIndexExclusive = args.endIndexExclusive ?? barsCount;

  if (
    !Number.isInteger(startIndex) ||
    startIndex < 0 ||
    startIndex >= barsCount
  ) {
    errors.push(
      `startIndex должен быть целым в [0, ${String(Math.max(0, barsCount - 1))}]`
    );
  }

  if (
    !Number.isInteger(endIndexExclusive) ||
    endIndexExclusive <= startIndex ||
    endIndexExclusive > barsCount
  ) {
    errors.push(
      `endIndexExclusive должен быть целым в (${String(startIndex)}, ${String(barsCount)}]`
    );
  }

  const extra = args.extraLookbackBars ?? 25;

  if (!Number.isInteger(extra) || extra < 0) {
    errors.push("extraLookbackBars должен быть целым ≥ 0");
  }

  if (errors.length > 0) {
    return certification({
      ok: false,
      errors,
      adapter: args.adapter,
      window: { startIndex, endIndexExclusive }
    });
  }

  const segment = {
    name: CERTIFICATION_SEGMENT_NAME,
    startIndex,
    endIndexExclusive
  };

  const requiredLookbackBars = args.adapter.requiredLookbackBars;
  // Диагностика принимает SignalSource: адаптер передаётся ЦЕЛИКОМ,
  // чтобы разгон соответствовал его заявлению.
  const adapterProvider: SignalSource = args.adapter;
  const declaredWarmupBars = Math.max(0, requiredLookbackBars - 1);
  const extraWarmupBars = declaredWarmupBars + extra;

  const withWarmup = (warmupBars: number): BacktestInput["config"] => ({
    ...(args.config ?? {}),
    warmupBars
  });

  /* 1) структурная проба + 2) воспроизводимость (одинаковые прогоны) */

  const structuralProbe = probeProvider({
    bars: args.bars,
    provider: args.adapter,
    config: withWarmup(declaredWarmupBars),
    segment
  });

  const repeatProbe = probeProvider({
    bars: args.bars,
    provider: args.adapter,
    config: withWarmup(declaredWarmupBars),
    segment
  });

  const determinismComparison = compareDecisions(
    structuralProbe.decisions,
    repeatProbe.decisions,
    { includeVisibility: true }
  );

  const determinism: DeterminismReplay = {
    ok: determinismComparison.errors.length === 0,
    errors: determinismComparison.errors.map(
      (item) =>
        `воспроизводимость: ${item} (Date.now()/random/состояние замыкания недопустимы)`
    ),
    comparedDecisions: determinismComparison.compared
  };

  /* 3) достаточность заявленного lookback */

  const extraProbe = probeProvider({
    bars: args.bars,
    provider: args.adapter,
    config: withWarmup(extraWarmupBars),
    segment
  });

  const lookbackComparison = compareDecisions(
    structuralProbe.decisions,
    extraProbe.decisions,
    // Видимость здесь LEGITIMATELY различается: история намеренно глубже.
    { includeVisibility: false }
  );

  const declaredHistoryStartIndex = structuralProbe.outcome.ok
    ? structuralProbe.outcome.result.metadata.historyStartIndex
    : null;
  const extraHistoryStartIndex = extraProbe.outcome.ok
    ? extraProbe.outcome.result.metadata.historyStartIndex
    : null;
  const historyClampedAtZero =
    extraHistoryStartIndex !== null &&
    declaredHistoryStartIndex !== null &&
    extraHistoryStartIndex === declaredHistoryStartIndex;

  const lookbackErrors = lookbackComparison.errors.map(
    (item) =>
      `заявленный requiredLookbackBars=${String(requiredLookbackBars)} недостаточен: ${item}`
  );

  if (!extraProbe.outcome.ok) {
    lookbackErrors.push(
      `прогон с увеличенной историей не выполнен: ${extraProbe.errors.join("; ")}`
    );
  }

  const lookbackReplay: LookbackReplay = {
    ok: lookbackErrors.length === 0,
    errors: lookbackErrors,
    comparedDecisions: lookbackComparison.compared,
    declaredWarmupBars,
    extraWarmupBars,
    declaredHistoryStartIndex,
    extraHistoryStartIndex,
    historyClampedAtZero
  };

  /* 4) контрфактическая диагностика */

  const windowLength = endIndexExclusive - startIndex;
  const boundaryIndex =
    args.boundaryIndex ?? startIndex + Math.max(1, Math.floor(windowLength / 2));

  const invariance = diagnoseDecisionInvariance({
    bars: args.bars,
    provider: adapterProvider,
    config: withWarmup(declaredWarmupBars),
    segment,
    boundaryIndex
  });

  const limitations = [...CERTIFICATION_LIMITATIONS];

  if (historyClampedAtZero) {
    limitations.push(
      `проверка достаточности lookback вырождена: увеличенная история уперлась в начало массива (historyStartIndex=${String(
        declaredHistoryStartIndex
      )} в обоих прогонах) — добавьте баров до окна или уменьшите extraLookbackBars`
    );
  }

  if (invariance.ok === false) {
    limitations.push(
      `контрфактическая диагностика не прошла: ${invariance.errors.join("; ")}`
    );
  }

  errors.push(...determinism.errors, ...lookbackErrors);

  if (!structuralProbe.ok) {
    errors.push(
      `структурный барьер no-lookahead не удержан: ${structuralProbe.errors.join("; ")}`
    );
  }

  return certification({
    ok: errors.length === 0,
    errors,
    limitations,
    adapter: args.adapter,
    window: { startIndex, endIndexExclusive },
    structuralProbe,
    determinism,
    lookbackReplay,
    invariance
  });
}
