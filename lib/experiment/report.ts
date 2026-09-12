/**
 * P2-C — отчёт: проекция результатов P2-A, сравнение конфигураций,
 * каноническая сериализация и детерминированный текстовый вид.
 *
 * Ключевое правило (пункт 1 политики контракта): P2-C НЕ пересчитывает
 * метрики. Каждое число копируется из `BacktestResult`/`BacktestMetrics`
 * P2-A поле-в-поле; единственные «новые» значения — это группировки
 * уже имеющихся записей (skipped/rejected по кодам причин) и отпечатки.
 * Маркер `provenance: "p2a-metrics-verbatim"` пишется в каждый
 * сегментный отчёт, чтобы происхождение числа было видно в выводе.
 *
 * Сравнение конфигураций: ВСЕ объявленные варианты присутствуют в
 * строках отчёта (включая отклонённые, с причиной). Порядок —
 * детерминированный и не зависящий от результата. Три блока
 * свидетельств разделены: TRAIN (selection), VALIDATION (confirmation),
 * OOS (final, в выборе не участвует).
 */

import {
  type BacktestResult,
  type ExitReason,
  type RejectReason,
  type SegmentWindow,
  type SkipReason,
  type SplitName
} from "../backtest/contract";
import { deepFreeze } from "../backtest/immutable";
import {
  canonicalJson,
  canonicalNumber,
  fingerprintOf,
  fingerprintResult,
  sha256Hex
} from "../backtest/serialize";
import {
  EXPERIMENT_CONTRACT_VERSION,
  EXPERIMENT_LAYER_NAME,
  METRICS_PROVENANCE,
  type ComparisonRow,
  type ComparisonView,
  type EvidenceBlocks,
  type EvidenceEntry,
  type EvidenceMetrics,
  type ExperimentRecord,
  type SegmentReport,
  type VariantRecord
} from "./contract";

const ZERO_EXIT_COUNTS: Readonly<Record<ExitReason, number>> = {
  STOP_LOSS: 0,
  TAKE_PROFIT: 0,
  TIMEOUT: 0,
  END_OF_DATA: 0,
  SEGMENT_END: 0
};

const ZERO_SKIP_COUNTS: Readonly<Record<SkipReason, number>> = {
  "position-open": 0,
  "no-next-bar": 0,
  "segment-boundary": 0
};

const ZERO_REJECT_COUNTS: Readonly<Record<RejectReason, number>> = {
  "invalid-levels": 0,
  "levels-on-wrong-side": 0,
  "entry-levels-breached-at-open": 0,
  "entry-fill-outside-levels": 0
};

/**
 * Проекция результата P2-A в сегментный отчёт.
 *
 * `expectedWindow` используется только как запасное значение для
 * границ окна; источником истины является `result.metadata`, а
 * согласованность окна и результата проверяется отдельно
 * (`assertSegmentIdentity` в validate.ts).
 */
export function projectSegmentReport(
  result: BacktestResult,
  segment: SplitName,
  expectedWindow: SegmentWindow
): SegmentReport {
  const { metrics, metadata, input } = result;

  const skippedByReason: Record<SkipReason, number> = { ...ZERO_SKIP_COUNTS };

  for (const skipped of result.skippedSignals) {
    skippedByReason[skipped.reason] += 1;
  }

  const rejectedByReason: Record<RejectReason, number> = {
    ...ZERO_REJECT_COUNTS
  };

  for (const rejected of result.rejectedSignals) {
    rejectedByReason[rejected.reason] += 1;
  }

  const exitReasonCounts: Record<ExitReason, number> = {
    ...ZERO_EXIT_COUNTS,
    ...metrics.exitReasonCounts
  };

  return deepFreeze({
    provenance: METRICS_PROVENANCE,
    segment,
    startIndex: metadata.segmentStartIndex ?? expectedWindow.startIndex,
    endIndexExclusive:
      metadata.segmentEndIndexExclusive ?? expectedWindow.endIndexExclusive,
    barsCount: metadata.barsCount,
    firstBarTime: metadata.firstBarTime,
    lastBarTime: metadata.lastBarTime,
    timeframeMs: metadata.timeframeMs,
    gridGaps: metadata.gridGaps,
    trades: metrics.trades,
    longTrades: metrics.longTrades,
    shortTrades: metrics.shortTrades,
    wins: metrics.wins,
    losses: metrics.losses,
    breakeven: metrics.breakeven,
    winRate: metrics.winRate,
    grossPnl: metrics.totalGrossPnl,
    netPnl: metrics.totalNetPnl,
    netWinTotal: metrics.netWinTotal,
    netLossTotal: metrics.netLossTotal,
    grossWinTotal: metrics.grossWinTotal,
    grossLossTotal: metrics.grossLossTotal,
    fees: metrics.totalFees,
    slippageCost: metrics.totalSlippageCost,
    finalEquity: metrics.finalEquity,
    profitFactor: metrics.profitFactor,
    profitFactorState: metrics.profitFactorState,
    expectancy: metrics.expectancy,
    avgR: metrics.avgR,
    medianR: metrics.medianR,
    avgGrossR: metrics.avgGrossR,
    medianGrossR: metrics.medianGrossR,
    avgRActualFill: metrics.avgRActualFill,
    medianRActualFill: metrics.medianRActualFill,
    avgWin: metrics.avgWin,
    avgLoss: metrics.avgLoss,
    largestWin: metrics.largestWin,
    largestLoss: metrics.largestLoss,
    maxRealizedDrawdown: metrics.maxDrawdown,
    maxRealizedDrawdownPct: metrics.maxDrawdownPct,
    realizedDrawdownPeakTime: metrics.maxDrawdownPeakTime,
    realizedDrawdownTroughTime: metrics.maxDrawdownTroughTime,
    maxMtmDrawdown: metrics.maxDrawdownMarkToMarket,
    maxMtmDrawdownPct: metrics.maxDrawdownMarkToMarketPct,
    maxAdverseExcursionDrawdown: metrics.maxAdverseExcursionDrawdown,
    maxAdverseExcursionDrawdownPct: metrics.maxAdverseExcursionDrawdownPct,
    equityNonPositive: metrics.equityNonPositive,
    maxConsecutiveWins: metrics.maxConsecutiveWins,
    maxConsecutiveLosses: metrics.maxConsecutiveLosses,
    avgBarsHeld: metrics.avgBarsHeld,
    maxBarsHeld: metrics.maxBarsHeld,
    exitReasonCounts: Object.freeze(exitReasonCounts),
    timeoutExits: exitReasonCounts.TIMEOUT,
    sameBarAmbiguityTrades: metrics.sameBarAmbiguityTrades,
    gapThroughTrades: metrics.gapThroughTrades,
    openAtEndTrades: metrics.openAtEndTrades,
    signalsEvaluated: input.signalsEvaluated,
    decisionCounts: Object.freeze({ ...input.decisionCounts }),
    cannotEvaluate: input.decisionCounts.CANNOT_EVALUATE,
    neutral: input.decisionCounts.NEUTRAL,
    noSignal: input.decisionCounts.NO_SIGNAL,
    skippedByReason: Object.freeze(skippedByReason),
    rejectedByReason: Object.freeze(rejectedByReason),
    resultFingerprint: fingerprintResult(result)
  });
}

/** Подмножество метрик, допустимое для сравнения конфигураций. */
export function projectEvidence(report: SegmentReport): EvidenceMetrics {
  return deepFreeze({
    trades: report.trades,
    grossPnl: report.grossPnl,
    netPnl: report.netPnl,
    winRate: report.winRate,
    profitFactor: report.profitFactor,
    profitFactorState: report.profitFactorState,
    expectancy: report.expectancy,
    avgR: report.avgR,
    medianR: report.medianR,
    avgRActualFill: report.avgRActualFill,
    medianRActualFill: report.medianRActualFill,
    maxRealizedDrawdown: report.maxRealizedDrawdown,
    maxRealizedDrawdownPct: report.maxRealizedDrawdownPct,
    maxMtmDrawdown: report.maxMtmDrawdown,
    maxAdverseExcursionDrawdown: report.maxAdverseExcursionDrawdown,
    maxAdverseExcursionDrawdownPct: report.maxAdverseExcursionDrawdownPct,
    maxConsecutiveLosses: report.maxConsecutiveLosses
  });
}

function evidenceEntry(
  variant: VariantRecord,
  segment: SplitName
): EvidenceEntry {
  const record = variant.segments === null ? null : variant.segments[segment];
  const report = record === null || record.report === null ? null : record.report;

  return {
    configurationId: variant.configurationId,
    label: variant.label,
    inputOrder: variant.inputOrder,
    presentationOrder: variant.presentationOrder,
    status: variant.status,
    rejectionReason: variant.rejection === null ? null : variant.rejection.reason,
    metrics: report === null ? null : projectEvidence(report)
  };
}

/**
 * Три РАЗДЕЛЬНЫХ блока свидетельств. Именно эта разделённость и делает
 * изоляцию OOS структурной: ранжирование принимает только
 * `trainSelection` либо `validationConfirmation`.
 */
export function buildEvidenceBlocks(
  variants: readonly VariantRecord[]
): EvidenceBlocks {
  return deepFreeze({
    trainSelection: variants.map((variant) => evidenceEntry(variant, "TRAIN")),
    validationConfirmation: variants.map((variant) =>
      evidenceEntry(variant, "VALIDATION")
    ),
    oosFinal: variants.map((variant) => evidenceEntry(variant, "OOS"))
  });
}

function comparisonRow(variant: VariantRecord): ComparisonRow {
  return {
    presentationOrder: variant.presentationOrder,
    inputOrder: variant.inputOrder,
    configurationId: variant.configurationId,
    label: variant.label,
    status: variant.status,
    rejectionReason:
      variant.rejection === null ? null : variant.rejection.reason,
    rejectionStage: variant.rejection === null ? null : variant.rejection.stage,
    rejectionErrors:
      variant.rejection === null ? [] : [...variant.rejection.errors],
    train: variant.segments === null ? null : variant.segments.TRAIN.report,
    validation:
      variant.segments === null ? null : variant.segments.VALIDATION.report,
    oos: variant.segments === null ? null : variant.segments.OOS.report
  };
}

/**
 * Сравнение конфигураций: все варианты, без сортировки по результату и
 * без отбрасывания проигравших.
 */
export function buildComparison(record: ExperimentRecord): ComparisonView {
  const rows = record.variants.map(comparisonRow);
  const canonical = canonicalJson({ scope: "experiment-comparison", record });

  return deepFreeze({
    contractVersion: EXPERIMENT_CONTRACT_VERSION,
    layer: EXPERIMENT_LAYER_NAME,
    subject: record.subject,
    subjectFingerprint: record.subjectFingerprint,
    split: record.split,
    orderPolicy: record.orderPolicy,
    inputFingerprint: record.inputFingerprint,
    resultFingerprint: record.resultFingerprint,
    counts: record.counts,
    rows,
    trainSelectionEvidence: record.evidence.trainSelection,
    validationConfirmationEvidence: record.evidence.validationConfirmation,
    oosFinalEvidence: record.evidence.oosFinal,
    selection: record.selection,
    oosIsolation: record.oosIsolation,
    limitations: record.limitations,
    reportFingerprint: sha256Hex(canonical),
    canonicalReport: canonical
  });
}

/** Каноническая (байт-в-байт воспроизводимая) форма записи эксперимента. */
export function canonicalExperiment(record: ExperimentRecord): string {
  return canonicalJson({ scope: "experiment", record });
}

/** Отпечаток записи эксперимента. */
export function fingerprintExperiment(record: ExperimentRecord): string {
  return sha256Hex(canonicalExperiment(record));
}

/**
 * Отпечаток результата эксперимента: сегментные результаты P2-A в
 * порядке представления.
 *
 * `inputOrder` сюда намеренно НЕ входит: это характеристика объявления
 * входа, а не результата. Она сохраняется в записи (происхождение) и
 * участвует в `inputFingerprint` через упорядоченный список
 * идентичностей, поэтому при политике `configuration-id` отпечаток
 * результата не зависит от порядка объявления, а при `input-order` —
 * зависит (порядок строк меняется).
 */
export function fingerprintSegmentResults(
  variants: readonly VariantRecord[]
): string {
  const payload = variants.map((variant) => ({
    configurationId: variant.configurationId,
    status: variant.status,
    rejection: variant.rejection,
    segments:
      variant.segments === null
        ? null
        : {
            TRAIN: variant.segments.TRAIN.result,
            VALIDATION: variant.segments.VALIDATION.result,
            OOS: variant.segments.OOS.result
          }
  }));

  return fingerprintOf({ scope: "experiment-results", payload });
}

/* ------------------------------------------------------------------ */
/* Детерминированный текстовый вид (для CLI/отладки; не для хранения)   */
/* ------------------------------------------------------------------ */

function num(value: number | null | undefined): string {
  if (value === null || value === undefined) {
    return "null";
  }

  return String(canonicalNumber(value));
}

function pct(value: number | null): string {
  return value === null ? "n/a" : `${String(canonicalNumber(value))}%`;
}

/** Компактное представление причин (только ненулевые) — честность отчёта. */
function reasonCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).filter(([, value]) => value !== 0);

  if (entries.length === 0) {
    return "";
  }

  return entries
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, value]) => `${reason}:${String(value)}`)
    .join(",");
}

function segmentLine(report: SegmentReport | null, segment: SplitName): string {
  const name = segment.padEnd(10, " ");

  if (report === null) {
    return `  ${name} — нет результата (вариант отклонён)`;
  }

  const skipped = reasonCounts(
    report.skippedByReason as Readonly<Record<string, number>>
  );
  const rejected = reasonCounts(
    report.rejectedByReason as Readonly<Record<string, number>>
  );

  return [
    `  ${name}`,
    `trades=${String(report.trades)}`,
    `gross=${num(report.grossPnl)}`,
    `net=${num(report.netPnl)}`,
    `winRate=${pct(report.winRate)}`,
    `PF=${num(report.profitFactor)}(${report.profitFactorState})`,
    `exp=${num(report.expectancy)}`,
    `avgR=${num(report.avgR)}`,
    `medR=${num(report.medianR)}`,
    `avgR.actualFill=${num(report.avgRActualFill)}`,
    `medR.actualFill=${num(report.medianRActualFill)}`,
    `ddRealized=${num(report.maxRealizedDrawdown)}/${pct(report.maxRealizedDrawdownPct)}`,
    `ddMTM=${num(report.maxMtmDrawdown)}/${pct(report.maxMtmDrawdownPct)}`,
    `ddMAE=${num(report.maxAdverseExcursionDrawdown)}/${pct(report.maxAdverseExcursionDrawdownPct)}`,
    `consLoss=${String(report.maxConsecutiveLosses)}`,
    `ambiguity=${String(report.sameBarAmbiguityTrades)}`,
    `gap=${String(report.gapThroughTrades)}`,
    `timeout=${String(report.timeoutExits)}`,
    `openAtEnd=${String(report.openAtEndTrades)}`,
    `cannotEvaluate=${String(report.cannotEvaluate)}`,
    `neutral=${String(report.neutral)}`,
    `noSignal=${String(report.noSignal)}`,
    skipped === "" ? "" : `skipped={${skipped}}`,
    rejected === "" ? "" : `rejected={${rejected}}`
  ]
    .filter((part) => part !== "")
    .join(" ")
}

/**
 * Человекочитаемая форма отчёта. Детерминированная: никаких дат,
 * никаких случайных идентификаторов, числа нормализованы P2-A-округлением.
 */
export function formatExperimentReport(view: ComparisonView): string {
  const lines: string[] = [];
  const { subject } = view;

  lines.push(
    `EXPERIMENT ${view.contractVersion} / ${view.layer}`,
    `subject: strategy=${subject.strategy.slug}@${subject.strategy.version} market=${subject.market.asset}${
      subject.market.exchange === null ? "" : `@${subject.market.exchange}`
    } timeframe=${subject.market.timeframe} bars=${String(subject.dataRange.barsCount)}`,
    `dataRange: ${num(subject.dataRange.firstBarTime)}..${num(subject.dataRange.lastBarTime)}`,
    `subjectFingerprint: ${view.subjectFingerprint}`,
    `split: TRAIN [${String(view.split.train.startIndex)}, ${String(
      view.split.train.endIndexExclusive
    )}) VALIDATION [${String(view.split.validation.startIndex)}, ${String(
      view.split.validation.endIndexExclusive
    )}) OOS [${String(view.split.oos.startIndex)}, ${String(
      view.split.oos.endIndexExclusive
    )})`,
    `warmupStart: TRAIN=${String(view.split.warmupStart.TRAIN)} VALIDATION=${String(
      view.split.warmupStart.VALIDATION
    )} OOS=${String(view.split.warmupStart.OOS)}`,
    `orderPolicy: ${view.orderPolicy} (порядок не зависит от результата)`,
    `counts: declared=${String(view.counts.declared)} evaluated=${String(
      view.counts.evaluated
    )} rejected=${String(view.counts.rejected)}`,
    `selection: ${view.selection.policy.kind}${
      view.selection.performed
        ? ` → selected=${String(view.selection.selectedLabel)} [${String(
            view.selection.selectedConfigurationId
          ).slice(0, 12)}…]`
        : " → ничего не выбиралось"
    }`,
    `selection.rationale: ${view.selection.rationale}`,
    `oosIsolation: oosConsultedForSelection=${String(
      view.oosIsolation.oosConsultedForSelection
    )} oosConsultedForRanking=${String(
      view.oosIsolation.oosConsultedForRanking
    )} mechanism=${view.oosIsolation.mechanism}`,
    `limitations (${String(view.limitations.length)}):`,
    ...view.limitations.map((item) => `  - ${item}`),
    `inputFingerprint: ${view.inputFingerprint}`,
    `resultFingerprint: ${view.resultFingerprint}`,
    `reportFingerprint: ${view.reportFingerprint}`,
    ""
  );

  if (view.selection.ranking !== null) {
    lines.push(
      `ranking (явный, stage=${view.selection.ranking.stage}, критерии=${view.selection.ranking.criteria.join(
        ","
      )}, OOS не читался):`
    );

    for (const entry of view.selection.ranking.order) {
      lines.push(
        `  ${String(entry.rank)}. ${entry.label} [${entry.configurationId.slice(0, 12)}…]${
          entry.tieBreakApplied ? " (tie-break по configurationId)" : ""
        }`
      );
    }

    for (const excluded of view.selection.ranking.excludedFromRanking) {
      const row = view.rows.find(
        (candidate) => candidate.configurationId === excluded.configurationId
      );
      const name = row === undefined
        ? excluded.configurationId.slice(0, 12)
        : row.label;

      lines.push(
        `  — ${name} [${excluded.configurationId.slice(
          0,
          12
        )}…] исключён из ранжирования: ${excluded.reason}`
      );
    }

    lines.push("");
  }

  for (const row of view.rows) {
    lines.push(
      `#${String(row.presentationOrder)} [${row.status}] ${row.label}`,
      `  configurationId: ${row.configurationId}`,
      `  inputOrder: ${String(row.inputOrder)}`
    );

    if (row.rejectionReason !== null) {
      lines.push(
        `  ОТКЛОНЁН: stage=${String(row.rejectionStage)} reason=${row.rejectionReason}`,
        ...row.rejectionErrors.map((error) => `    - ${error}`)
      );
    }

    lines.push(
      segmentLine(row.train, "TRAIN"),
      segmentLine(row.validation, "VALIDATION"),
      `${segmentLine(row.oos, "OOS")}  ← финальное свидетельство, в выборе НЕ участвует`,
      ""
    );
  }

  return lines.join("\n");
}
