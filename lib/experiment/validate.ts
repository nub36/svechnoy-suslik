/**
 * P2-C — валидаторы хронологии, идентичности и изоляции OOS.
 *
 * Все проверки — чистые функции, возвращающие структурированный отчёт
 * (список ошибок). Никаких «починок»: расхождение между заявленным и
 * фактическим делает результат НЕПРИГОДНЫМ, а не «приблизительно
 * верным».
 *
 * Что здесь ловится:
 *  - несовпадение разбиения с P2-A-контрактом (пересечения, дыры,
 *    нехронологичность, пустые сегменты, warmup в будущее);
 *  - результат чужого сегмента (в том числе подменённый OOS);
 *  - результат чужой конфигурации (не совпал отпечаток конфига P2-A);
 *  - результат чужого рынка/таймфрейма/диапазона данных (не совпал
 *    отпечаток баров, заявленный шаг сетки или границы диапазона);
 *  - результат, собранный не P2-A (несовместимая версия контракта);
 *  - внутренне противоречивый результат (грубая подделка метрик);
 *  - утечка за границы сегмента (переиспользуется P2-A-инвариант);
 *  - использование OOS при выборе конфигурации.
 */

import {
  BACKTEST_CONTRACT_VERSION,
  type BacktestResult,
  type ChronologicalSplit,
  type SegmentWindow,
  type SplitName
} from "../backtest/contract";
import {
  canonicalJson,
  fingerprintConfig,
  fingerprintResult
} from "../backtest/serialize";
import { SPLIT_NAMES, assertNoSegmentLeakage } from "../backtest/splits";
import {
  EXPERIMENT_LIMITATIONS,
  type EvidenceMetrics,
  type ExperimentRecord,
  type ExperimentSubject,
  type ResolvedVariant,
  type SegmentReport
} from "./contract";
import { projectEvidence, projectSegmentReport } from "./report";
import { assertRankingIndependentOfOos } from "./selection";

/**
 * Каноническая КОПИЯ ограничений честности (hardening #1, FIX 2).
 *
 * Источник истины — замороженный `EXPERIMENT_LIMITATIONS` контракта; копия
 * снимается ОДИН раз при загрузке модуля, тоже замораживается и служит
 * защитой от подмены/мутации экспортированного массива. Сверка ниже
 * сравнивает опубликованный список с этой копией ПОЭЛЕМЕНТНО (длина +
 * порядок + точный текст), а не только на «непустоту» и `includes`:
 * усечённый, пустой или переписанный список отвергается.
 */
const CANONICAL_LIMITATIONS: readonly string[] = Object.freeze([
  ...EXPERIMENT_LIMITATIONS
]);

export interface ValidationReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

function report(errors: readonly string[]): ValidationReport {
  return { ok: errors.length === 0, errors };
}

/** Окно сегмента из разбиения. */
export function windowOf(
  split: ChronologicalSplit,
  segment: SplitName
): SegmentWindow {
  return segment === "TRAIN"
    ? split.train
    : segment === "VALIDATION"
      ? split.validation
      : split.oos;
}

/**
 * Хронологичность разбиения: TRAIN → VALIDATION → OOS, стыковка
 * вплотную, без пересечений и дыр, каждый сегмент непустой, warmup
 * смотрит только в прошлое.
 */
export function assertSplitChronological(
  split: ChronologicalSplit,
  barsCount: number
): ValidationReport {
  const errors: string[] = [];
  const ordered: readonly SegmentWindow[] = [
    split.train,
    split.validation,
    split.oos
  ];

  if (split.barsCount !== barsCount) {
    errors.push(
      `split.barsCount=${String(split.barsCount)} ≠ фактическое число баров ${String(barsCount)}`
    );
  }

  if (split.train.name !== "TRAIN" || split.validation.name !== "VALIDATION" || split.oos.name !== "OOS") {
    errors.push("split: имена сегментов не соответствуют TRAIN/VALIDATION/OOS");
  }

  if (split.train.startIndex !== 0) {
    errors.push(
      `split: TRAIN обязан начинаться с 0 (есть ${String(split.train.startIndex)})`
    );
  }

  if (split.train.endIndexExclusive !== split.validation.startIndex) {
    errors.push(
      `split: TRAIN.end=${String(split.train.endIndexExclusive)} ≠ VALIDATION.start=${String(split.validation.startIndex)} (дыра или пересечение)`
    );
  }

  if (split.validation.endIndexExclusive !== split.oos.startIndex) {
    errors.push(
      `split: VALIDATION.end=${String(split.validation.endIndexExclusive)} ≠ OOS.start=${String(split.oos.startIndex)} (дыра или пересечение)`
    );
  }

  if (split.oos.endIndexExclusive !== barsCount) {
    errors.push(
      `split: OOS.end=${String(split.oos.endIndexExclusive)} ≠ barsCount=${String(barsCount)} (покрытие неполное)`
    );
  }

  for (const window of ordered) {
    if (window.endIndexExclusive <= window.startIndex) {
      errors.push(
        `split: сегмент ${window.name} пуст ([${String(window.startIndex)}, ${String(window.endIndexExclusive)}))`
      );
    }

    if (window.startIndex < 0 || window.endIndexExclusive > barsCount) {
      errors.push(
        `split: сегмент ${window.name} вне набора баров (${String(barsCount)})`
      );
    }

    const warmup = split.warmupStart[window.name];

    if (warmup > window.startIndex) {
      errors.push(
        `split: warmupStart(${window.name})=${String(warmup)} позже начала сегмента — warmup обязан смотреть в прошлое`
      );
    }

    if (warmup < 0) {
      errors.push(`split: warmupStart(${window.name}) отрицательный`);
    }
  }

  // Явная проверка непересечения всех пар (защита от «стыковки» выше).
  for (let i = 0; i < ordered.length; i += 1) {
    for (let j = i + 1; j < ordered.length; j += 1) {
      const a = ordered[i];
      const b = ordered[j];

      if (a.startIndex < b.endIndexExclusive && b.startIndex < a.endIndexExclusive) {
        errors.push(
          `split: сегменты ${a.name} и ${b.name} перекрываются ([${String(a.startIndex)}, ${String(a.endIndexExclusive)}) ∩ [${String(b.startIndex)}, ${String(b.endIndexExclusive)}))`
        );
      }
    }
  }

  return report(errors);
}

/** Внутренняя согласованность результата P2-A (ловит грубую подделку). */
export function assertResultSelfConsistency(
  result: BacktestResult
): ValidationReport {
  const errors: string[] = [];

  if (result.metrics.trades !== result.trades.length) {
    errors.push(
      `result: metrics.trades=${String(result.metrics.trades)} ≠ числу записей сделок ${String(result.trades.length)}`
    );
  }

  if (result.equityCurve.length !== result.trades.length + 1) {
    errors.push(
      `result: equityCurve.length=${String(result.equityCurve.length)} ≠ trades + 1`
    );
  }

  const exitSum = Object.values(result.metrics.exitReasonCounts).reduce(
    (accumulator, value) => accumulator + value,
    0
  );

  if (exitSum !== result.trades.length) {
    errors.push(
      `result: сумма exitReasonCounts=${String(exitSum)} ≠ trades=${String(result.trades.length)}`
    );
  }

  const decisionSum = Object.values(result.input.decisionCounts).reduce(
    (accumulator, value) => accumulator + value,
    0
  );

  if (decisionSum !== result.input.signalsEvaluated) {
    errors.push(
      `result: сумма decisionCounts=${String(decisionSum)} ≠ signalsEvaluated=${String(result.input.signalsEvaluated)}`
    );
  }

  for (const [key, value] of Object.entries(result.metrics)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      errors.push(
        `result: нефинитное значение метрики ${key}=${String(value)} (NaN/±Infinity)`
      );
    }
  }

  // FIX 5 (hardening #1): нефинитные входы бухгалтерии — ЯВНЫЙ fail-closed,
  // без опоры на вызвавшего. NaN/±Infinity в initialEquity/finalEquity/
  // totalNetPnl или в точке equityCurve не должны ни проходить, ни
  // ослаблять допуск (1e-9 * |Infinity| = Infinity «принимает» всё).
  const accountingInputs: readonly (readonly [string, number])[] = [
    ["config.initialEquity", result.config.initialEquity],
    ["metrics.finalEquity", result.metrics.finalEquity],
    ["metrics.totalNetPnl", result.metrics.totalNetPnl]
  ];

  for (const [name, value] of accountingInputs) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push(
        `result: нефинитное значение ${name}=${String(value)} (NaN/±Infinity; сверка эквити fail-closed)`
      );
    }
  }

  for (let index = 0; index < result.equityCurve.length; index += 1) {
    const equity = result.equityCurve[index].equity;

    if (typeof equity !== "number" || !Number.isFinite(equity)) {
      errors.push(
        `result: нефинитная точка equityCurve[${String(index)}].equity=${String(equity)} (NaN/±Infinity; сверка эквити fail-closed)`
      );

      break;
    }
  }

  // C0 (FIX 4, hardening #1): finalEquity обязан ТОЧНО совпасть с
  // последней точкой equityCurve. Допуск накопления сюда НЕ применяется:
  // любое ПРЕДСТАВИМОЕ ненулевое расхождение (в том числе 1e-12 и доли
  // допуска сверки ниже) отвергается.
  const lastEquityPoint =
    result.equityCurve.length === 0
      ? null
      : result.equityCurve[result.equityCurve.length - 1];

  if (lastEquityPoint === null) {
    errors.push("result: equityCurve пуст — finalEquity не с чем сверить");
  } else {
    const curveDelta = Math.abs(
      result.metrics.finalEquity - lastEquityPoint.equity
    );

    if (curveDelta !== 0) {
      errors.push(
        `result: finalEquity=${String(result.metrics.finalEquity)} ≠ последней точке equityCurve=${String(lastEquityPoint.equity)} (расхождение ${String(curveDelta)}); допуск накопления на эту сверку НЕ распространяется`
      );
    }
  }

  // C0: сверка с initialEquity + totalNetPnl — с допуском ТОЛЬКО на
  // накопление плавающей точки (hardened P2-A суммирует в порядке
  // сделок); значимая бухгалтерская ошибка допуск не проходит.
  const equityReconciliation = Math.abs(
    result.metrics.finalEquity -
      (result.config.initialEquity + result.metrics.totalNetPnl)
  );
  const equityTolerance =
    1e-9 * Math.max(1, Math.abs(result.config.initialEquity));

  if (!Number.isFinite(equityTolerance)) {
    errors.push(
      `result: допуск сверки нефинитен (${String(equityTolerance)}) — initialEquity обязан быть конечным (fail-closed)`
    );
  } else if (!(equityReconciliation <= equityTolerance)) {
    errors.push(
      `result: finalEquity расходится с initialEquity + totalNetPnl на ${String(equityReconciliation)} (допуск ${String(equityTolerance)}; C0 — только накопление плавающей точки)`
    );
  }

  if (
    result.metrics.wins + result.metrics.losses + result.metrics.breakeven !==
    result.metrics.trades
  ) {
    errors.push("result: wins + losses + breakeven ≠ trades");
  }

  for (let i = 1; i < result.trades.length; i += 1) {
    if (result.trades[i].signalIndex < result.trades[i - 1].exitIndex) {
      errors.push(
        `result: сделка ${String(result.trades[i].id)} перекрывает предыдущую (две позиции одновременно)`
      );

      break;
    }
  }

  return report(errors);
}

/**
 * C3: проверить, что спроецированные свидетельства не содержат
 * нефинитных чисел. `null` — законное отсутствие значения.
 */
export function assertFiniteEvidenceMetrics(
  metrics: EvidenceMetrics
): ValidationReport {
  const errors: string[] = [];

  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      errors.push(
        `evidence: нефинитное значение ${key}=${String(value)} (C3 — в ранжирование не попадает)`
      );
    }
  }

  return report(errors);
}

/**
 * C6: границы честности обязаны присутствовать в записи и совпадать с
 * контрактными формулировками — отчёт нельзя пересказать сильнее, чем
 * он есть.
 */
export function assertLimitationsPresent(
  record: ExperimentRecord
): ValidationReport {
  const errors: string[] = [];
  const published = record.limitations;

  if (!Array.isArray(published) || published.length === 0) {
    errors.push("limitations: список границ честности пуст");

    return report(errors);
  }

  // FIX 2 (hardening #1): сверка с НЕИЗМЕНЯЕМОЙ канонической копией —
  // поэлементно (длина + порядок + точный текст). `includes` недостаточно:
  // усечённый/дополненный/переписанный список должен отвергаться, а не
  // «проходить по одному совпадению».
  if (published.length !== CANONICAL_LIMITATIONS.length) {
    errors.push(
      `limitations: число формулировок ${String(published.length)} ≠ каноническому ${String(CANONICAL_LIMITATIONS.length)} — усечение/дополнение списка запрещено`
    );
  }

  const common = Math.min(published.length, CANONICAL_LIMITATIONS.length);

  for (let index = 0; index < common; index += 1) {
    if (published[index] !== CANONICAL_LIMITATIONS[index]) {
      errors.push(
        `limitations: формулировка #${String(index)} не совпадает с канонической «${CANONICAL_LIMITATIONS[index].slice(0, 72)}…»`
      );
    }
  }

  return report(errors);
}

/**
 * Идентичность сегментного результата: сегмент, окно, версия контракта,
 * бары (рынок/диапазон), таймфрейм, конфиг конфигурации.
 */
export function assertSegmentIdentity(args: {
  readonly result: BacktestResult;
  readonly segment: SplitName;
  readonly window: SegmentWindow;
  readonly subject: ExperimentSubject;
  readonly variant: ResolvedVariant;
}): ValidationReport {
  const { result, segment, window, subject, variant } = args;
  const errors: string[] = [];
  const metadata = result.metadata;

  if (metadata.contractVersion !== BACKTEST_CONTRACT_VERSION) {
    errors.push(
      `result: contractVersion=${String(metadata.contractVersion)} ≠ ${BACKTEST_CONTRACT_VERSION} (результат собран не текущим P2-A)`
    );
  }

  if (metadata.segment !== segment) {
    errors.push(
      `result: metadata.segment=${String(metadata.segment)} ≠ ожидаемому ${segment} — результат чужого сегмента (например, подмена OOS)`
    );
  }

  if (metadata.segmentStartIndex !== window.startIndex) {
    errors.push(
      `result: segmentStartIndex=${String(metadata.segmentStartIndex)} ≠ ${String(window.startIndex)}`
    );
  }

  if (metadata.segmentEndIndexExclusive !== window.endIndexExclusive) {
    errors.push(
      `result: segmentEndIndexExclusive=${String(metadata.segmentEndIndexExclusive)} ≠ ${String(window.endIndexExclusive)}`
    );
  }

  if (metadata.barsCount !== window.endIndexExclusive - window.startIndex) {
    errors.push(
      `result: barsCount=${String(metadata.barsCount)} ≠ длине окна сегмента ${String(window.endIndexExclusive - window.startIndex)}`
    );
  }

  if (metadata.barsFingerprint !== subject.dataRange.barsFingerprint) {
    errors.push(
      "result: barsFingerprint не совпадает с отпечатком данных субъекта — результат другого рынка/набора баров"
    );
  }

  if (subject.market.timeframeMs !== null) {
    if (metadata.timeframeMs === null) {
      errors.push(
        `result: заявлен таймфрейм ${String(subject.market.timeframeMs)} мс, но сетка результата неравномерна (timeframeMs=null)`
      );
    } else if (metadata.timeframeMs !== subject.market.timeframeMs) {
      errors.push(
        `result: timeframeMs=${String(metadata.timeframeMs)} ≠ заявленному ${String(subject.market.timeframeMs)} — подмена таймфрейма`
      );
    }
  }

  const { firstBarTime, lastBarTime } = subject.dataRange;

  if (
    metadata.firstBarTime !== null &&
    firstBarTime !== null &&
    metadata.firstBarTime < firstBarTime
  ) {
    errors.push("result: первый бар сегмента раньше начала заявленного диапазона");
  }

  if (
    metadata.lastBarTime !== null &&
    lastBarTime !== null &&
    metadata.lastBarTime > lastBarTime
  ) {
    errors.push("result: последний бар сегмента позже конца заявленного диапазона");
  }

  if (fingerprintConfig(result.config) !== variant.configFingerprint) {
    errors.push(
      "result: отпечаток конфига P2-A не совпадает с конфигом конфигурации — результат чужой конфигурации"
    );
  }

  return report(errors);
}

/* ------------------------------------------------------------------ */
/* Принятие внешних результатов (путь интеграции с P2-B в будущем)      */
/* ------------------------------------------------------------------ */

/**
 * Сегментный результат, заявленный извне (не рассчитанный этим
 * прогоном). P2-C принимает его ТОЛЬКО после полной сверки идентичности.
 */
export interface SubmittedSegmentResult {
  readonly configurationId: string;
  readonly subjectFingerprint: string;
  readonly segment: SplitName;
  readonly window: SegmentWindow;
  readonly result: BacktestResult;
  /**
   * Сохранённый сегментный отчёт (C7). Если передан, его
   * `resultFingerprint` обязан совпадать с
   * `fingerprintResult(result)` — подмена сохранённого отчёта (в том
   * числе OOS) отвергается валидацией.
   */
  readonly report?: SegmentReport | null;
}

export interface ExpectedAssignment {
  readonly subject: ExperimentSubject;
  readonly subjectFingerprint: string;
  readonly split: ChronologicalSplit;
  readonly variant: ResolvedVariant;
}

/** Полная сверка принятого извне результата. */
export function validateSubmittedSegmentResult(
  submission: SubmittedSegmentResult,
  expected: ExpectedAssignment
): ValidationReport {
  const errors: string[] = [];

  if (!SPLIT_NAMES.includes(submission.segment)) {
    errors.push(
      `submission.segment: неизвестный сегмент ${String(submission.segment)}`
    );
  }

  if (submission.configurationId !== expected.variant.configurationId) {
    errors.push(
      `submission.configurationId=${String(submission.configurationId)} ≠ ${expected.variant.configurationId} — результат приписан чужой конфигурации`
    );
  }

  if (submission.subjectFingerprint !== expected.subjectFingerprint) {
    errors.push(
      "submission.subjectFingerprint не совпадает — результат другого субъекта (стратегия/рынок/диапазон)"
    );
  }

  const expectedWindow = windowOf(expected.split, submission.segment);

  if (
    submission.window.startIndex !== expectedWindow.startIndex ||
    submission.window.endIndexExclusive !== expectedWindow.endIndexExclusive
  ) {
    errors.push(
      `submission.window=[${String(submission.window.startIndex)}, ${String(submission.window.endIndexExclusive)}) ≠ окну ${submission.segment} из разбиения [${String(expectedWindow.startIndex)}, ${String(expectedWindow.endIndexExclusive)})`
    );
  }

  if (submission.report !== undefined && submission.report !== null) {
    const actualFingerprint = fingerprintResult(submission.result);

    if (submission.report.segment !== submission.segment) {
      errors.push(
        `submission.report.segment=${String(submission.report.segment)} ≠ ${String(submission.segment)} — сохранён отчёт другого сегмента`
      );
    }

    if (submission.report.resultFingerprint !== actualFingerprint) {
      errors.push(
        `submission.report.resultFingerprint=${String(submission.report.resultFingerprint)} ≠ fingerprintResult(result)=${actualFingerprint} — подмена сохранённого сегментного отчёта`
      );
    }

    // R2 (hardening #1): `SegmentReport` — ДЕТЕРМИНИРОВАННАЯ проекция
    // `BacktestResult` (пункт 21 контракта), поэтому подлинного
    // `resultFingerprint` НЕДОСТАТОЧНО: отчёт сверяется ПОЭЛЕМЕНТНО с
    // пересчитанной проекцией. Отчёт с подменёнными метриками при
    // подлинном отпечатке отвергается.
    const expectedReport = projectSegmentReport(
      submission.result,
      submission.segment,
      expectedWindow
    );
    const reportRecord = submission.report as unknown as Readonly<
      Record<string, unknown>
    >;
    const expectedRecord = expectedReport as unknown as Readonly<
      Record<string, unknown>
    >;

    const canonicalField = (value: unknown): string => {
      try {
        return (
          (canonicalJson(value) as string | undefined) ??
          `undefined:${String(value)}`
        );
      } catch {
        return `unrepresentable:${String(value)}`;
      }
    };
    const briefField = (value: unknown): string => {
      const text = canonicalField(value);

      return text.length > 160 ? `${text.slice(0, 160)}…` : text;
    };

    for (const field of Object.keys(expectedRecord)) {
      if (
        canonicalField(reportRecord[field]) !== canonicalField(expectedRecord[field])
      ) {
        errors.push(
          `submission.report.${field}=${briefField(reportRecord[field])} ≠ пересчитанной проекции ${briefField(expectedRecord[field])} — отчёт обязан быть детерминированной проекцией результата (R2)`
        );
      }
    }

    for (const field of Object.keys(reportRecord)) {
      if (!Object.prototype.hasOwnProperty.call(expectedRecord, field)) {
        errors.push(
          `submission.report.${field} отсутствует в пересчитанной проекции результата (R2)`
        );
      }
    }

    errors.push(
      ...assertFiniteEvidenceMetrics(projectEvidence(submission.report)).errors
    );
  }

  errors.push(
    ...assertSegmentIdentity({
      result: submission.result,
      segment: submission.segment,
      window: expectedWindow,
      subject: expected.subject,
      variant: expected.variant
    }).errors,
    ...assertResultSelfConsistency(submission.result).errors,
    ...assertNoSegmentLeakage(submission.result, expectedWindow).errors.map(
      (error) => `leakage: ${error}`
    )
  );

  return report(errors);
}

/* ------------------------------------------------------------------ */
/* Изоляция OOS в записи эксперимента                                   */
/* ------------------------------------------------------------------ */

/**
 * Проверка того, что OOS не участвовал в выборе/ранжировании:
 * флаги, стадия и ВОСПРОИЗВОДИМОСТЬ записанного порядка из
 * TRAIN/VALIDATION-свидетельств.
 */
export function assertOosIsolation(record: ExperimentRecord): ValidationReport {
  const errors: string[] = [];
  const { selection, oosIsolation, evidence } = record;

  if (selection.oosConsulted !== false) {
    errors.push("selection.oosConsulted обязан быть false");
  }

  if (oosIsolation.oosConsultedForSelection !== false) {
    errors.push("oosIsolation.oosConsultedForSelection обязан быть false");
  }

  if (oosIsolation.oosConsultedForRanking !== false) {
    errors.push("oosIsolation.oosConsultedForRanking обязан быть false");
  }

  if (selection.policy.kind !== "none") {
    if (selection.policy.stage === ("OOS" as never)) {
      errors.push("selectionPolicy.stage=OOS запрещён");
    }
  }

  if (selection.ranking !== null) {
    if (selection.ranking.stage === ("OOS" as never)) {
      errors.push("ranking.stage=OOS запрещён");
    }

    const independence = assertRankingIndependentOfOos(selection.ranking, {
      trainSelection: evidence.trainSelection,
      validationConfirmation: evidence.validationConfirmation
    });

    errors.push(...independence.errors);
  } else if (oosIsolation.rankingIndependenceVerified) {
    errors.push(
      "oosIsolation.rankingIndependenceVerified=true при отсутствии ранжирования"
    );
  }

  // Выбор (если он выполнен) обязан указывать на вариант, присутствующий
  // в отчёте: «победитель из ниоткуда» невозможен.
  if (selection.performed && selection.selectedConfigurationId !== null) {
    const found = record.variants.some(
      (variant) =>
        variant.configurationId === selection.selectedConfigurationId &&
        variant.status === "evaluated"
    );

    if (!found) {
      errors.push(
        "selection.selectedConfigurationId не соответствует ни одному оценённому варианту отчёта"
      );
    }
  }

  return report(errors);
}

/** Инвариант отсутствия cherry-picking. */
export function assertNoCherryPicking(
  record: ExperimentRecord,
  declaredVariantIds: readonly string[]
): ValidationReport {
  const errors: string[] = [];

  if (record.variants.length !== record.counts.declared) {
    errors.push(
      `variants.length=${String(record.variants.length)} ≠ counts.declared=${String(record.counts.declared)}`
    );
  }

  if (
    record.counts.declared !==
    record.counts.evaluated + record.counts.rejected
  ) {
    errors.push(
      `counts.declared ≠ evaluated + rejected (${String(record.counts.declared)} ≠ ${String(record.counts.evaluated)} + ${String(record.counts.rejected)})`
    );
  }

  if (record.counts.declared !== declaredVariantIds.length) {
    errors.push(
      `counts.declared=${String(record.counts.declared)} ≠ числу объявленных конфигураций ${String(declaredVariantIds.length)}`
    );
  }

  const present = new Set(record.variants.map((variant) => variant.configurationId));

  for (const id of declaredVariantIds) {
    if (!present.has(id)) {
      errors.push(`конфигурация ${id} отсутствует в отчёте (потеряна при сравнении)`);
    }
  }

  const orders = record.variants.map((variant) => variant.presentationOrder);
  const uniqueOrders = new Set(orders);

  if (uniqueOrders.size !== orders.length) {
    errors.push("presentationOrder не уникален — порядок представления повреждён");
  }

  if (
    orders.some(
      (order, index) => order !== index
    )
  ) {
    errors.push("presentationOrder не образует плотную последовательность 0..N−1");
  }

  for (const block of [
    ["trainSelection", record.evidence.trainSelection],
    ["validationConfirmation", record.evidence.validationConfirmation],
    ["oosFinal", record.evidence.oosFinal]
  ] as const) {
    if (block[1].length !== record.variants.length) {
      errors.push(
        `evidence.${block[0]}: ${String(block[1].length)} записей ≠ ${String(record.variants.length)} вариантов (часть конфигураций исключена из свидетельств)`
      );
    }
  }

  for (const variant of record.variants) {
    if (variant.status === "rejected" && variant.rejection === null) {
      errors.push(
        `вариант ${variant.configurationId}: статус rejected без указания причины`
      );
    }

    if (variant.status === "evaluated" && variant.segments === null) {
      errors.push(
        `вариант ${variant.configurationId}: статус evaluated без сегментных результатов`
      );
    }
  }

  return report(errors);
}
