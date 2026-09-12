/**
 * P2-C — тесты отчёта: дословная проекция метрик P2-A, детерминизм,
 * отпечатки и семантика сравнения конфигураций.
 *
 * Запуск: npx tsx scripts/test-experiment-report.ts
 *
 * Проверяемые свойства:
 *  - каждому сегменту отчёта соответствует РЕЗУЛЬТАТ ЭТОГО сегмента
 *    (TRAIN/VALIDATION/OOS не перепутаны местами);
 *  - каждое число отчёта скопировано из результата P2-A дословно
 *    (P2-C ничего не пересчитывает);
 *  - отпечаток сегментного отчёта равен P2-A `fingerprintResult`;
 *  - сегмент без сделок и состояние PF без убытков представлены честно;
 *  - повторный прогон даёт БАЙТ-В-БАЙТ идентичную каноническую форму;
 *  - изменение конфига/данных меняет отпечатки; изменение только OOS
 *    меняет отпечаток отчёта, но НЕ меняет выбор конфигурации;
 *  - порядок объявления влияет на отчёт только при политике input-order.
 */

import {
  type BacktestBar,
  type BacktestResult,
  type SignalDecision,
  type SignalDecisionList,
  entryDecision
} from "../lib/backtest/contract";
import {
  canonicalJson,
  fingerprintConfig,
  fingerprintResult,
  serializeResult
} from "../lib/backtest/serialize";
import { runBacktest } from "../lib/backtest/engine";
import {
  METRICS_PROVENANCE,
  type ComparisonView,
  type ExperimentInput,
  type ExperimentRecord,
  type ExperimentSubjectInput,
  type SegmentReport,
  type VariantDefinition
} from "../lib/experiment/contract";
import {
  buildComparison,
  canonicalExperiment,
  fingerprintExperiment,
  formatExperimentReport
} from "../lib/experiment/report";
import { runExperiment, runExperimentReport } from "../lib/experiment/run";

let passed = 0;
let total = 0;

function ok(condition: boolean | undefined, label: string): void {
  total += 1;

  if (condition === true) {
    passed += 1;
  } else {
    console.error(`FAIL: ${label}`);
  }
}

/* ------------------------------------------------------------------ */
/* Фикстуры                                                            */
/* ------------------------------------------------------------------ */

const H1 = 3_600_000;
const T0 = 1_700_000_000_000;

function zigzag(count: number): BacktestBar[] {
  const bars: BacktestBar[] = [];
  let price = 100;

  for (let i = 0; i < count; i += 1) {
    const drift = ((i % 7) - 3) * 2;
    const open = price;
    const close = price + drift;

    bars.push({
      time: T0 + i * H1,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close
    });
    price = close;
  }

  return bars;
}

function decisionList(
  bars: readonly BacktestBar[],
  step: number,
  from = 4,
  until?: number
): SignalDecisionList {
  const list: (SignalDecision | null)[] = new Array(bars.length).fill(null);
  const limit = until === undefined ? bars.length : Math.min(until, bars.length);

  for (let i = from, n = 0; i + 1 < limit; i += step, n += 1) {
    const close = bars[i].close;

    list[i] =
      n % 2 === 0
        ? entryDecision("LONG", close - 9, close + 7, `L${String(i)}`)
        : entryDecision("SHORT", close + 9, close - 7, `S${String(i)}`);
  }

  return list;
}

const BARS = zigzag(60);
const LIST = decisionList(BARS, 4);
const TRAIN_ONLY_LIST = decisionList(BARS, 4, 4, 36);

const SUBJECT: ExperimentSubjectInput = {
  strategy: { slug: "suslik-smc", version: "1.4.0" },
  market: {
    asset: "BTCUSDT",
    exchange: "test-exchange",
    timeframe: "1h",
    timeframeMs: H1
  }
};

function variant(
  label: string,
  config: VariantDefinition["config"],
  signals: SignalDecisionList = LIST
): VariantDefinition {
  return { label, params: { label }, config, signals };
}

/** Три конфигурации с РАЗНЫМИ TRAIN-результатами (tie-break не нужен). */
function variants(): VariantDefinition[] {
  return [
    variant("timeout-1", { timeoutBars: 1, warmupBars: 3 }),
    variant("timeout-3", { timeoutBars: 3, warmupBars: 3 }),
    variant("timeout-4", { timeoutBars: 4, warmupBars: 3 })
  ];
}

function input(overrides?: Partial<ExperimentInput>): ExperimentInput {
  return { bars: BARS, subject: SUBJECT, variants: variants(), ...overrides };
}

function mustRun(value: ReturnType<typeof runExperiment>): ExperimentRecord {
  if (!value.ok) {
    console.error(`FAIL: эксперимент не выполнен (${value.stage})`, value.errors);
    process.exit(1);
  }

  return value.record;
}

const RECORD = mustRun(
  runExperiment(
    input({
      selectionPolicy: {
        kind: "select-by-rank",
        stage: "TRAIN",
        criteria: ["netPnl"]
      }
    })
  )
);
const VIEW: ComparisonView = buildComparison(RECORD);

function segmentResult(
  record: ExperimentRecord,
  label: string,
  segment: "TRAIN" | "VALIDATION" | "OOS"
): BacktestResult {
  const found = record.variants.find((item) => item.label === label);
  const result = found?.segments?.[segment].result ?? null;

  if (result === null) {
    console.error(`FAIL: нет результата ${label}/${segment}`);
    process.exit(1);
  }

  return result;
}

function segmentReport(
  view: ComparisonView,
  label: string,
  segment: "train" | "validation" | "oos"
): SegmentReport {
  const report = view.rows.find((row) => row.label === label)?.[segment] ?? null;

  if (report === null) {
    console.error(`FAIL: нет отчёта ${label}/${segment}`);
    process.exit(1);
  }

  return report;
}

/* ------------------------------------------------------------------ */
/* 1. Точное соответствие сегментов                                    */
/* ------------------------------------------------------------------ */

ok(VIEW.rows.length === 3, "отчёт: три строки на три конфигурации");
ok(
  VIEW.rows.map((row) => row.label).join(",") === "timeout-1,timeout-3,timeout-4",
  "отчёт: строки идут в порядке объявления"
);

for (const label of ["timeout-1", "timeout-3", "timeout-4"]) {
  const trainResult = segmentResult(RECORD, label, "TRAIN");
  const validationResult = segmentResult(RECORD, label, "VALIDATION");
  const oosResult = segmentResult(RECORD, label, "OOS");
  const trainReport = segmentReport(VIEW, label, "train");
  const validationReport = segmentReport(VIEW, label, "validation");
  const oosReport = segmentReport(VIEW, label, "oos");

  ok(
    trainResult.metadata.segment === "TRAIN" &&
      validationResult.metadata.segment === "VALIDATION" &&
      oosResult.metadata.segment === "OOS",
    `${label}: результаты P2-A помечены своими сегментами`
  );
  ok(
    trainReport.segment === "TRAIN" &&
      validationReport.segment === "VALIDATION" &&
      oosReport.segment === "OOS",
    `${label}: отчёты помечены своими сегментами`
  );
  ok(
    trainReport.startIndex === RECORD.split.train.startIndex &&
      trainReport.endIndexExclusive === RECORD.split.train.endIndexExclusive &&
      validationReport.startIndex === RECORD.split.validation.startIndex &&
      validationReport.endIndexExclusive === RECORD.split.validation.endIndexExclusive &&
      oosReport.startIndex === RECORD.split.oos.startIndex &&
      oosReport.endIndexExclusive === RECORD.split.oos.endIndexExclusive,
    `${label}: окна отчётов равны окнам разбиения`
  );
  ok(
    trainResult.metadata.segmentStartIndex === trainReport.startIndex &&
      validationResult.metadata.segmentStartIndex === validationReport.startIndex &&
      oosResult.metadata.segmentStartIndex === oosReport.startIndex,
    `${label}: границы отчёта взяты из метаданных результата P2-A`
  );
  ok(
    trainReport.trades !== oosReport.trades ||
      trainReport.netPnl !== oosReport.netPnl ||
      trainReport.maxConsecutiveLosses !== oosReport.maxConsecutiveLosses,
    `${label}: TRAIN и OOS — разные данные (не копия одного сегмента)`
  );
  ok(
    trainReport.provenance === METRICS_PROVENANCE &&
      validationReport.provenance === METRICS_PROVENANCE &&
      oosReport.provenance === METRICS_PROVENANCE,
    `${label}: происхождение метрик помечено во всех сегментах`
  );
}

ok(
  RECORD.split.train.endIndexExclusive === 36 &&
    RECORD.split.validation.endIndexExclusive === 48 &&
    RECORD.split.oos.endIndexExclusive === 60,
  "отчёт: разбиение 60 баров → 36/12/12 (P2-A арифметика)"
);
ok(
  VIEW.split.train.startIndex === 0 && VIEW.split.oos.endIndexExclusive === 60,
  "отчёт: разбиение представлено в отчёте сравнения"
);
ok(
  VIEW.subject.dataRange.barsCount === 60 &&
    VIEW.subject.dataRange.firstBarTime === T0 &&
    VIEW.subject.dataRange.lastBarTime === T0 + 59 * H1,
  "отчёт: диапазон данных представлен в отчёте сравнения"
);

/* ------------------------------------------------------------------ */
/* 2. Дословность метрик P2-A                                          */
/* ------------------------------------------------------------------ */

for (const label of ["timeout-1", "timeout-3", "timeout-4"]) {
  for (const segment of ["TRAIN", "VALIDATION", "OOS"] as const) {
    const result = segmentResult(RECORD, label, segment);
    const report = segmentReport(
      VIEW,
      label,
      segment === "TRAIN" ? "train" : segment === "VALIDATION" ? "validation" : "oos"
    );
    const { metrics, metadata, input: summary } = result;

    const verbatim: [string, boolean][] = [
      ["trades", report.trades === metrics.trades],
      ["longTrades", report.longTrades === metrics.longTrades],
      ["shortTrades", report.shortTrades === metrics.shortTrades],
      ["wins", report.wins === metrics.wins],
      ["losses", report.losses === metrics.losses],
      ["breakeven", report.breakeven === metrics.breakeven],
      ["winRate", report.winRate === metrics.winRate],
      ["grossPnl", report.grossPnl === metrics.totalGrossPnl],
      ["netPnl", report.netPnl === metrics.totalNetPnl],
      ["fees", report.fees === metrics.totalFees],
      ["slippageCost", report.slippageCost === metrics.totalSlippageCost],
      ["netWinTotal", report.netWinTotal === metrics.netWinTotal],
      ["netLossTotal", report.netLossTotal === metrics.netLossTotal],
      ["grossWinTotal", report.grossWinTotal === metrics.grossWinTotal],
      ["grossLossTotal", report.grossLossTotal === metrics.grossLossTotal],
      ["finalEquity", report.finalEquity === metrics.finalEquity],
      ["profitFactor", report.profitFactor === metrics.profitFactor],
      [
        "profitFactorState",
        report.profitFactorState === metrics.profitFactorState
      ],
      ["expectancy", report.expectancy === metrics.expectancy],
      ["avgR", report.avgR === metrics.avgR],
      ["medianR", report.medianR === metrics.medianR],
      ["avgGrossR", report.avgGrossR === metrics.avgGrossR],
      ["medianGrossR", report.medianGrossR === metrics.medianGrossR],
      ["avgWin", report.avgWin === metrics.avgWin],
      ["avgLoss", report.avgLoss === metrics.avgLoss],
      ["largestWin", report.largestWin === metrics.largestWin],
      ["largestLoss", report.largestLoss === metrics.largestLoss],
      [
        "maxRealizedDrawdown",
        report.maxRealizedDrawdown === metrics.maxDrawdown
      ],
      [
        "maxRealizedDrawdownPct",
        report.maxRealizedDrawdownPct === metrics.maxDrawdownPct
      ],
      [
        "realizedDrawdownPeakTime",
        report.realizedDrawdownPeakTime === metrics.maxDrawdownPeakTime
      ],
      [
        "realizedDrawdownTroughTime",
        report.realizedDrawdownTroughTime === metrics.maxDrawdownTroughTime
      ],
      [
        "maxMtmDrawdown",
        report.maxMtmDrawdown === metrics.maxDrawdownMarkToMarket
      ],
      [
        "maxMtmDrawdownPct",
        report.maxMtmDrawdownPct === metrics.maxDrawdownMarkToMarketPct
      ],
      ["equityNonPositive", report.equityNonPositive === metrics.equityNonPositive],
      [
        "maxConsecutiveWins",
        report.maxConsecutiveWins === metrics.maxConsecutiveWins
      ],
      [
        "maxConsecutiveLosses",
        report.maxConsecutiveLosses === metrics.maxConsecutiveLosses
      ],
      ["avgBarsHeld", report.avgBarsHeld === metrics.avgBarsHeld],
      ["maxBarsHeld", report.maxBarsHeld === metrics.maxBarsHeld],
      [
        "sameBarAmbiguityTrades",
        report.sameBarAmbiguityTrades === metrics.sameBarAmbiguityTrades
      ],
      [
        "gapThroughTrades",
        report.gapThroughTrades === metrics.gapThroughTrades
      ],
      ["openAtEndTrades", report.openAtEndTrades === metrics.openAtEndTrades],
      ["signalsEvaluated", report.signalsEvaluated === summary.signalsEvaluated],
      ["barsCount", report.barsCount === metadata.barsCount],
      ["firstBarTime", report.firstBarTime === metadata.firstBarTime],
      ["lastBarTime", report.lastBarTime === metadata.lastBarTime],
      ["timeframeMs", report.timeframeMs === metadata.timeframeMs],
      ["gridGaps", report.gridGaps === metadata.gridGaps]
    ];

    const mismatched = verbatim.filter(([, equal]) => !equal).map(([name]) => name);

    ok(
      mismatched.length === 0,
      `${label}/${segment}: все ${String(verbatim.length)} числовых полей скопированы дословно${
        mismatched.length > 0 ? ` (расхождения: ${mismatched.join(", ")})` : ""
      }`
    );

    ok(
      (["STOP_LOSS", "TAKE_PROFIT", "TIMEOUT", "END_OF_DATA", "SEGMENT_END"] as const).every(
        (reason) =>
          report.exitReasonCounts[reason] === metrics.exitReasonCounts[reason]
      ),
      `${label}/${segment}: счётчики причин выхода дословны (все 5 ключей)`
    );
    ok(
      report.timeoutExits === metrics.exitReasonCounts.TIMEOUT,
      `${label}/${segment}: timeoutExits — это TIMEOUT из P2-A (не отдельный пересчёт)`
    );
    ok(
      (["LONG", "SHORT", "NEUTRAL", "CANNOT_EVALUATE", "NO_SIGNAL"] as const).every(
        (kind) => report.decisionCounts[kind] === summary.decisionCounts[kind]
      ),
      `${label}/${segment}: счётчики решений дословны`
    );
    ok(
      report.cannotEvaluate === summary.decisionCounts.CANNOT_EVALUATE &&
        report.neutral === summary.decisionCounts.NEUTRAL &&
        report.noSignal === summary.decisionCounts.NO_SIGNAL,
      `${label}/${segment}: cannot-evaluate отделён от NEUTRAL и от «нет сигнала»`
    );
    ok(
      report.resultFingerprint === fingerprintResult(result),
      `${label}/${segment}: отпечаток сегмента равен P2-A fingerprintResult`
    );
    ok(
      Object.values(report.skippedByReason).reduce((a, b) => a + b, 0) ===
        result.skippedSignals.length,
      `${label}/${segment}: группировка skipped покрывает все записи P2-A`
    );
    ok(
      Object.values(report.rejectedByReason).reduce((a, b) => a + b, 0) ===
        result.rejectedSignals.length,
      `${label}/${segment}: группировка rejected покрывает все записи P2-A`
    );
    ok(
      result.skippedSignals.every(
        (skipped) =>
          report.skippedByReason[skipped.reason] >= 1
      ),
      `${label}/${segment}: каждый код причины skipped присутствует в группировке`
    );
    ok(
      result.rejectedSignals.every(
        (rejected) => report.rejectedByReason[rejected.reason] >= 1
      ),
      `${label}/${segment}: каждый код причины rejected присутствует в группировке`
    );
  }
}

/* Независимая сверка: P2-A прогон вне P2-C даёт тот же результат. */
const independentTrain = runBacktest({
  bars: BARS,
  signals: LIST,
  config: { timeoutBars: 3, warmupBars: 3 },
  segment: RECORD.split.train
});

ok(independentTrain.ok, "проекция: независимый прогон P2-A успешен");
ok(
  independentTrain.ok &&
    independentTrain.result.metadata.segment === "TRAIN" &&
    independentTrain.result.metadata.barsFingerprint ===
      segmentResult(RECORD, "timeout-3", "TRAIN").metadata.barsFingerprint,
  "проекция: независимый прогон — тот же сегмент и тот же отпечаток баров"
);
ok(
  independentTrain.ok &&
    fingerprintResult(independentTrain.result) ===
      segmentReport(VIEW, "timeout-3", "train").resultFingerprint,
  "проекция: отчёт P2-C совпадает с независимым прогоном P2-A того же сегмента"
);
ok(
  independentTrain.ok &&
    serializeResult(independentTrain.result) ===
      serializeResult(segmentResult(RECORD, "timeout-3", "TRAIN")),
  "проекция: сериализация результата внутри записи байт-в-байт равна независимой"
);
ok(
  fingerprintConfig(segmentResult(RECORD, "timeout-3", "TRAIN").config) ===
    RECORD.variants[1].configFingerprint,
  "проекция: configFingerprint варианта равен P2-A отпечатку конфига результата"
);

/* ------------------------------------------------------------------ */
/* 3. Сегмент без сделок                                               */
/* ------------------------------------------------------------------ */

const zeroTrade = mustRun(
  runExperiment(
    input({
      variants: [variant("train-only", { timeoutBars: 3, warmupBars: 3 }, TRAIN_ONLY_LIST)]
    })
  )
);
const zeroView = buildComparison(zeroTrade);
const zeroValidation = zeroView.rows[0].validation;
const zeroOos = zeroView.rows[0].oos;
const zeroTrain = zeroView.rows[0].train;

ok(zeroTrain !== null && zeroTrain.trades > 0, "ноль сделок: TRAIN имеет сделки (фикстура)");
ok(
  zeroValidation !== null && zeroValidation.trades === 0,
  "ноль сделок: VALIDATION без сделок"
);
ok(
  zeroValidation !== null &&
    zeroValidation.winRate === null &&
    zeroValidation.profitFactor === null &&
    zeroValidation.profitFactorState === "no-trades" &&
    zeroValidation.expectancy === null &&
    zeroValidation.avgR === null &&
    zeroValidation.medianR === null,
  "ноль сделок: отношения null, состояние PF = no-trades (не 0 и не 1)"
);
ok(
  zeroValidation !== null &&
    zeroValidation.maxRealizedDrawdown === 0 &&
    zeroValidation.maxMtmDrawdown === 0 &&
    zeroValidation.maxConsecutiveLosses === 0 &&
    zeroValidation.finalEquity === 10_000,
  "ноль сделок: просадки 0, капитал равен начальному"
);
ok(
  zeroValidation !== null &&
    zeroValidation.grossPnl === 0 &&
    zeroValidation.netPnl === 0 &&
    zeroValidation.fees === 0 &&
    zeroValidation.slippageCost === 0,
  "ноль сделок: деньги нулевые, комиссии не начислены"
);
ok(
  zeroValidation !== null &&
    zeroValidation.exitReasonCounts.STOP_LOSS === 0 &&
    zeroValidation.exitReasonCounts.SEGMENT_END === 0,
  "ноль сделок: счётчики выходов нулевые, но ключи присутствуют"
);
ok(
  zeroValidation !== null && Object.keys(zeroValidation.exitReasonCounts).length === 5,
  "ноль сделок: exitReasonCounts всегда содержит 5 ключей (P2-A контракт)"
);
ok(
  zeroValidation !== null && zeroValidation.noSignal > 0,
  "ноль сделок: причина — отсутствие сигналов, а не «стратегия ничего не смогла»"
);
ok(
  zeroOos !== null && zeroOos.trades === 0 && zeroOos.profitFactorState === "no-trades",
  "ноль сделок: OOS представлен так же честно"
);
ok(
  zeroTrade.counts.evaluated === 1 && zeroTrade.counts.rejected === 0,
  "ноль сделок: вариант БЕЗ сделок в сегменте остаётся оценённым (не отброшен)"
);
ok(
  zeroTrade.evidence.validationConfirmation[0].metrics?.profitFactor === null,
  "ноль сделок: в свидетельствах VALIDATION PF=null сохранён как null"
);

/* ------------------------------------------------------------------ */
/* 4. Состояние PF без убытков                                         */
/* ------------------------------------------------------------------ */

const noLossReport = segmentReport(VIEW, "timeout-3", "oos");
const noLossResult = segmentResult(RECORD, "timeout-3", "OOS");

ok(noLossReport.trades > 0, "нет убытков: в OOS есть сделки (фикстура)");
ok(
  noLossReport.losses === 0 && noLossResult.metrics.losses === 0,
  "нет убытков: убыточных сделок нет"
);
ok(
  noLossReport.profitFactor === null &&
    noLossReport.profitFactorState === "no-losses",
  "нет убытков: PF=null с состоянием no-losses (не Infinity и не «бесконечная прибыль»)"
);
ok(
  noLossReport.grossLossTotal === 0 && noLossReport.netLossTotal === 0,
  "нет убытков: суммы убытков нулевые"
);
ok(
  noLossReport.winRate !== null && noLossReport.winRate === 100,
  "нет убытков: winRate=100 (проценты P2-A; конечное число, в отличие от PF)"
);
ok(
  noLossReport.maxRealizedDrawdown === 0 && noLossReport.maxMtmDrawdown === 0,
  "нет убытков: просадки нулевые"
);
ok(
  !/:\s*-0(?:\.0+)?(?=[,}\]])/.test(canonicalJson(noLossReport)),
  "нет убытков: в канонической форме нет −0"
);
ok(
  !canonicalJson(noLossReport).includes("Infinity"),
  "нет убытков: в канонической форме нет Infinity"
);
ok(
  noLossReport.avgLoss === null && noLossReport.largestLoss === null,
  "нет убытков: показатели убытков null"
);

/* ------------------------------------------------------------------ */
/* 5. Детерминизм повтора                                              */
/* ------------------------------------------------------------------ */

const rerun = mustRun(
  runExperiment(
    input({
      selectionPolicy: {
        kind: "select-by-rank",
        stage: "TRAIN",
        criteria: ["netPnl"]
      }
    })
  )
);
const rerunView = buildComparison(rerun);

ok(
  canonicalExperiment(RECORD) === canonicalExperiment(rerun),
  "детерминизм: каноническая форма записи БАЙТ-В-БАЙТ идентична при повторе"
);
ok(
  fingerprintExperiment(RECORD) === fingerprintExperiment(rerun),
  "детерминизм: отпечаток записи идентичен при повторе"
);
ok(
  VIEW.canonicalReport === rerunView.canonicalReport,
  "детерминизм: канонический отчёт сравнения идентичен при повторе"
);
ok(
  VIEW.reportFingerprint === rerunView.reportFingerprint,
  "детерминизм: reportFingerprint идентичен при повторе"
);
ok(
  RECORD.resultFingerprint === rerun.resultFingerprint &&
    RECORD.inputFingerprint === rerun.inputFingerprint,
  "детерминизм: input/result отпечатки идентичны при повторе"
);
ok(
  formatExperimentReport(VIEW) === formatExperimentReport(rerunView),
  "детерминизм: текстовый вид идентичен при повторе"
);
ok(
  canonicalJson(VIEW.rows) === canonicalJson(rerunView.rows),
  "детерминизм: строки отчёта идентичны при повторе"
);
ok(
  RECORD.variants.map((item) => item.configurationId).join(",") ===
    rerun.variants.map((item) => item.configurationId).join(","),
  "детерминизм: идентичности конфигураций воспроизводятся"
);
ok(
  !/Date|now|random|uuid/i.test(canonicalExperiment(RECORD)),
  "детерминизм: в канонической форме нет следов времени/случайности"
);
ok(
  (() => {
    const outcome = runExperimentReport(input());

    return outcome.ok && outcome.record.resultFingerprint === RECORD.resultFingerprint;
  })(),
  "детерминизм: runExperimentReport даёт тот же отпечаток результата"
);
ok(
  canonicalJson({ scope: "experiment-comparison", record: RECORD }) ===
    VIEW.canonicalReport,
  "детерминизм: canonicalReport — это каноническая форма {scope, record}"
);
ok(
  VIEW.reportFingerprint.length === 64 &&
    /^[0-9a-f]{64}$/.test(VIEW.reportFingerprint),
  "детерминизм: reportFingerprint — sha256 hex"
);

/* ------------------------------------------------------------------ */
/* 6. Отпечатки реагируют на изменение входа                           */
/* ------------------------------------------------------------------ */

const changedConfig = mustRun(
  runExperiment(
    input({
      variants: [
        variant("timeout-1", { timeoutBars: 1, warmupBars: 3 }),
        variant("timeout-3", { timeoutBars: 5, warmupBars: 3 }),
        variant("timeout-4", { timeoutBars: 4, warmupBars: 3 })
      ]
    })
  )
);

ok(
  changedConfig.resultFingerprint !== RECORD.resultFingerprint,
  "отпечатки: изменение конфига меняет resultFingerprint"
);
ok(
  changedConfig.inputFingerprint !== RECORD.inputFingerprint,
  "отпечатки: изменение конфига меняет inputFingerprint (через идентичности)"
);
ok(
  buildComparison(changedConfig).reportFingerprint !== VIEW.reportFingerprint,
  "отпечатки: изменение конфига меняет reportFingerprint"
);
ok(
  changedConfig.variants[1].configurationId !== RECORD.variants[1].configurationId,
  "отпечатки: изменение конфига меняет configurationId"
);
ok(
  changedConfig.variants[0].configurationId === RECORD.variants[0].configurationId,
  "отпечатки: незадействованная конфигурация сохраняет идентичность"
);

const mutatedBars = zigzag(60);

mutatedBars[10] = { ...mutatedBars[10], close: mutatedBars[10].close + 0.5 };

const changedData = mustRun(runExperiment(input({ bars: mutatedBars })));

ok(
  changedData.subjectFingerprint !== RECORD.subjectFingerprint,
  "отпечатки: изменение данных меняет subjectFingerprint"
);
ok(
  changedData.inputFingerprint !== RECORD.inputFingerprint,
  "отпечатки: изменение данных меняет inputFingerprint"
);
ok(
  changedData.resultFingerprint !== RECORD.resultFingerprint,
  "отпечатки: изменение данных меняет resultFingerprint"
);
ok(
  changedData.variants.every(
    (item, index) => item.configurationId !== RECORD.variants[index].configurationId
  ),
  "отпечатки: изменение данных меняет ВСЕ идентичности конфигураций"
);
ok(
  buildComparison(changedData).reportFingerprint !== VIEW.reportFingerprint,
  "отпечатки: изменение данных меняет reportFingerprint"
);

const changedSubject = mustRun(
  runExperiment(
    input({
      subject: { ...SUBJECT, strategy: { slug: "suslik-smc", version: "1.5.0" } }
    })
  )
);

ok(
  changedSubject.subjectFingerprint !== RECORD.subjectFingerprint &&
    changedSubject.variants[0].configurationId !== RECORD.variants[0].configurationId,
  "отпечатки: версия стратегии входит в идентичность конфигурации"
);

const changedSplit = mustRun(
  runExperiment(input({ splitConfig: { trainFraction: 0.5, validationFraction: 0.25 } }))
);

ok(
  changedSplit.inputFingerprint !== RECORD.inputFingerprint,
  "отпечатки: изменение разбиения меняет inputFingerprint"
);
ok(
  changedSplit.resultFingerprint !== RECORD.resultFingerprint,
  "отпечатки: изменение разбиения меняет resultFingerprint (другие окна)"
);

const changedPolicy = mustRun(
  runExperiment(
    input({
      selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["netPnl"] }
    })
  )
);

ok(
  changedPolicy.inputFingerprint !== RECORD.inputFingerprint,
  "отпечатки: политика выбора входит в inputFingerprint"
);
ok(
  changedPolicy.resultFingerprint === RECORD.resultFingerprint,
  "отпечатки: политика выбора НЕ влияет на resultFingerprint (результаты те же)"
);

/* --- порядок объявления --- */

const swapped = mustRun(
  runExperiment(
    input({
      variants: [variants()[2], variants()[1], variants()[0]]
    })
  )
);

ok(
  swapped.variants.map((item) => item.label).join(",") ===
    "timeout-4,timeout-3,timeout-1",
  "порядок: при input-order строки следуют за порядком объявления"
);
ok(
  buildComparison(swapped).reportFingerprint !== VIEW.reportFingerprint,
  "порядок: при input-order перестановка объявления меняет отчёт (порядок значим)"
);
ok(
  swapped.resultFingerprint !== RECORD.resultFingerprint,
  "порядок: resultFingerprint учитывает порядок представления"
);
ok(
  swapped.variants.every((item) =>
    RECORD.variants.some(
      (other) => other.configurationId === item.configurationId
    )
  ),
  "порядок: множество идентичностей при перестановке не меняется"
);

const swappedById = mustRun(
  runExperiment(
    input({
      variants: [variants()[2], variants()[1], variants()[0]],
      orderPolicy: "configuration-id"
    })
  )
);
const byId = mustRun(runExperiment(input({ orderPolicy: "configuration-id" })));

ok(
  canonicalJson(swappedById.variants.map((item) => item.configurationId)) ===
    canonicalJson(byId.variants.map((item) => item.configurationId)),
  "порядок: при configuration-id перестановка объявления НЕ меняет порядок строк"
);
ok(
  swappedById.resultFingerprint === byId.resultFingerprint,
  "порядок: при configuration-id resultFingerprint не зависит от порядка объявления"
);
ok(
  swappedById.inputFingerprint === byId.inputFingerprint,
  "порядок: при configuration-id inputFingerprint не зависит от порядка объявления"
);
ok(
  canonicalJson(
    swappedById.variants.map((item) => ({
      configurationId: item.configurationId,
      label: item.label,
      status: item.status,
      segments: item.segments
    }))
  ) ===
    canonicalJson(
      byId.variants.map((item) => ({
        configurationId: item.configurationId,
        label: item.label,
        status: item.status,
        segments: item.segments
      }))
    ),
  "порядок: при configuration-id состав строк и результаты байт-в-байт те же"
);
ok(
  buildComparison(swappedById).canonicalReport !==
    buildComparison(byId).canonicalReport,
  "порядок: канонический отчёт отличается ТОЛЬКО записанным inputOrder (происхождение объявления)"
);
ok(
  canonicalJson(
    buildComparison(swappedById).canonicalReport.replace(/"inputOrder":\d+,?/g, "")
  ) ===
    canonicalJson(
      buildComparison(byId).canonicalReport.replace(/"inputOrder":\d+,?/g, "")
    ),
  "порядок: после исключения inputOrder канонические отчёты совпадают"
);
ok(
  swappedById.variants
    .map((item) => item.inputOrder)
    .sort((a, b) => a - b)
    .join(",") === "0,1,2",
  "порядок: inputOrder — это перестановка 0..N−1 (ничего не потеряно)"
);
ok(
  swappedById.variants.every((item) => {
    const declared = [variants()[2], variants()[1], variants()[0]];

    return declared[item.inputOrder].label === item.label;
  }),
  "порядок: inputOrder каждой строки указывает на её позицию в объявлении"
);

/* ------------------------------------------------------------------ */
/* 7. Изменён только OOS → отчёт меняется, выбор НЕ меняется           */
/* ------------------------------------------------------------------ */

const oosMutated = zigzag(60);

for (let i = 50; i < 60; i += 1) {
  oosMutated[i] = {
    ...oosMutated[i],
    open: oosMutated[i].open * 1.2,
    high: oosMutated[i].high * 1.2,
    low: oosMutated[i].low * 1.2,
    close: oosMutated[i].close * 1.2
  };
}

const oosChanged = mustRun(
  runExperiment(
    input({
      bars: oosMutated,
      selectionPolicy: {
        kind: "select-by-rank",
        stage: "TRAIN",
        criteria: ["netPnl"]
      }
    })
  )
);
const oosChangedView = buildComparison(oosChanged);

/**
 * Сравнение результатов сегмента БЕЗ metadata.barsFingerprint: отпечаток
 * баров законно меняется (изменён весь набор данных), но сделки, метрики
 * и кривая капитала сегмента обязаны остаться прежними.
 */
function segmentCore(result: BacktestResult | null | undefined) {
  return result === null || result === undefined
    ? null
    : {
        trades: result.trades,
        metrics: result.metrics,
        equityCurve: result.equityCurve,
        input: result.input,
        skippedSignals: result.skippedSignals,
        rejectedSignals: result.rejectedSignals,
        segment: result.metadata.segment,
        window: [
          result.metadata.segmentStartIndex,
          result.metadata.segmentEndIndexExclusive
        ]
      };
}

ok(
  canonicalJson(
    oosChanged.variants.map((item) => segmentCore(item.segments?.TRAIN.result))
  ) ===
    canonicalJson(
      RECORD.variants.map((item) => segmentCore(item.segments?.TRAIN.result))
    ),
  "OOS-изоляция: изменение баров в OOS НЕ меняет сделки/метрики TRAIN (байт-в-байт)"
);
ok(
  canonicalJson(
    oosChanged.variants.map((item) =>
      segmentCore(item.segments?.VALIDATION.result)
    )
  ) ===
    canonicalJson(
      RECORD.variants.map((item) =>
        segmentCore(item.segments?.VALIDATION.result)
      )
    ),
  "OOS-изоляция: изменение баров в OOS НЕ меняет сделки/метрики VALIDATION"
);
ok(
  oosChanged.variants.every(
    (item, index) =>
      item.segments?.TRAIN.result?.metadata.barsFingerprint !==
      RECORD.variants[index].segments?.TRAIN.result?.metadata.barsFingerprint
  ),
  "OOS-изоляция: отпечаток данных изменился — мутация видна в метаданных"
);
ok(
  canonicalJson(
    oosChanged.variants.map((item) => item.segments?.OOS.result?.metrics ?? null)
  ) !==
    canonicalJson(
      RECORD.variants.map((item) => item.segments?.OOS.result?.metrics ?? null)
    ),
  "OOS-изоляция: метрики OOS изменились (фикстура действительно трогает OOS)"
);
ok(
  canonicalJson(oosChanged.variants.map((item) => item.segments?.OOS.result)) !==
    canonicalJson(RECORD.variants.map((item) => item.segments?.OOS.result)),
  "OOS-изоляция: результаты OOS действительно изменились (фикстура рабочая)"
);
ok(
  oosChangedView.reportFingerprint !== VIEW.reportFingerprint,
  "OOS-изоляция: reportFingerprint меняется — OOS входит в отчёт"
);
ok(
  oosChanged.resultFingerprint !== RECORD.resultFingerprint,
  "OOS-изоляция: resultFingerprint меняется — OOS входит в результат"
);
ok(
  oosChanged.selection.selectedLabel === RECORD.selection.selectedLabel,
  "OOS-изоляция: ВЫБРАННАЯ конфигурация не изменилась"
);
ok(
  oosChanged.selection.ranking?.order.map((entry) => entry.label).join(",") ===
    RECORD.selection.ranking?.order.map((entry) => entry.label).join(","),
  "OOS-изоляция: порядок ранжирования (по меткам) не изменился"
);
ok(
  canonicalJson(oosChanged.selection.ranking?.order.map((entry) => entry.values)) ===
    canonicalJson(RECORD.selection.ranking?.order.map((entry) => entry.values)),
  "OOS-изоляция: значения критериев ранжирования не изменились (это TRAIN-числа)"
);
ok(
  oosChanged.selection.ranking?.stage === "TRAIN" &&
    oosChanged.selection.oosConsulted === false,
  "OOS-изоляция: ранжирование осталось на TRAIN и не читало OOS"
);
ok(
  oosChanged.oosIsolation.rankingIndependenceVerified === true,
  "OOS-изоляция: независимость ранжирования перепроверена"
);
ok(
  canonicalJson(
    oosChanged.evidence.trainSelection.map((entry) => entry.metrics)
  ) ===
    canonicalJson(RECORD.evidence.trainSelection.map((entry) => entry.metrics)),
  "OOS-изоляция: TRAIN-свидетельства (метрики) не изменились"
);
ok(
  canonicalJson(
    oosChanged.evidence.validationConfirmation.map((entry) => entry.metrics)
  ) ===
    canonicalJson(
      RECORD.evidence.validationConfirmation.map((entry) => entry.metrics)
    ),
  "OOS-изоляция: VALIDATION-свидетельства (метрики) не изменились"
);
ok(
  canonicalJson(oosChanged.evidence.oosFinal.map((entry) => entry.metrics)) !==
    canonicalJson(RECORD.evidence.oosFinal.map((entry) => entry.metrics)),
  "OOS-изоляция: OOS-свидетельства (метрики) изменились"
);

/* ------------------------------------------------------------------ */
/* 8. Семантика отчёта сравнения                                       */
/* ------------------------------------------------------------------ */

ok(VIEW.contractVersion === "p2c-1.1.0", "сравнение: версия контракта в отчёте");
ok(VIEW.layer === "suslik-experiment", "сравнение: имя слоя в отчёте");
ok(VIEW.orderPolicy === "input-order", "сравнение: политика порядка в отчёте");
ok(
  VIEW.counts.declared === 3 &&
    VIEW.counts.evaluated === 3 &&
    VIEW.counts.rejected === 0,
  "сравнение: счётчики в отчёте"
);
ok(
  VIEW.rows.every((row, index) => row.presentationOrder === index),
  "сравнение: presentationOrder строк плотный"
);
ok(
  VIEW.trainSelectionEvidence.length === 3 &&
    VIEW.validationConfirmationEvidence.length === 3 &&
    VIEW.oosFinalEvidence.length === 3,
  "сравнение: три блока свидетельств разделены и полны"
);
ok(
  VIEW.trainSelectionEvidence.every(
    (entry, index) =>
      entry.metrics?.trades === VIEW.rows[index].train?.trades
  ),
  "сравнение: TRAIN-блок соответствует TRAIN-колонке"
);
ok(
  VIEW.oosFinalEvidence.every(
    (entry, index) => entry.metrics?.netPnl === VIEW.rows[index].oos?.netPnl
  ),
  "сравнение: OOS-блок соответствует OOS-колонке"
);
ok(
  VIEW.oosIsolation.oosConsultedForSelection === false &&
    VIEW.oosIsolation.oosConsultedForRanking === false,
  "сравнение: флаги изоляции OOS в отчёте"
);
ok(
  VIEW.oosIsolation.mechanism ===
    "structural-evidence-type+policy-stage-whitelist+recomputed-ranking",
  "сравнение: механизм изоляции назван явно"
);
ok(
  VIEW.selection.rationale.length > 0,
  "сравнение: обоснование выбора присутствует"
);
ok(
  VIEW.rows.every((row) => row.rejectionReason === null) &&
    VIEW.rows.every((row) => row.rejectionErrors.length === 0),
  "сравнение: у оценённых вариантов нет причин отклонения"
);

const withRejectedView = buildComparison(
  mustRun(
    runExperiment(
      input({
        variants: [
          ...variants(),
          variant("bad-config", { timeoutBars: 0 }),
          {
            label: "no-source",
            params: { label: "no-source" },
            config: { timeoutBars: 2 },
            signals: () => null
          }
        ]
      })
    )
  )
);

ok(
  withRejectedView.rows.length === 5 &&
    withRejectedView.counts.declared === 5 &&
    withRejectedView.counts.rejected === 2,
  "сравнение: отклонённые конфигурации остаются строками отчёта"
);
ok(
  withRejectedView.rows
    .filter((row) => row.status === "rejected")
    .every(
      (row) =>
        row.rejectionReason !== null &&
        row.rejectionStage !== null &&
        row.rejectionErrors.length > 0 &&
        row.train === null &&
        row.oos === null
    ),
  "сравнение: у отклонённых есть причина, стадия и текст ошибки"
);
ok(
  withRejectedView.rows.some(
    (row) => row.rejectionReason === "missing-signal-source-id"
  ),
  "сравнение: провайдер без идентичности отклонён явно"
);

/* ------------------------------------------------------------------ */
/* 9. Текстовый вид                                                    */
/* ------------------------------------------------------------------ */

const text = formatExperimentReport(VIEW);

ok(text.includes("EXPERIMENT p2c-1.1.0"), "текст: заголовок с версией контракта");
ok(
  text.includes("suslik-smc@1.4.0") && text.includes("BTCUSDT"),
  "текст: идентичность стратегии и рынка"
);
ok(
  text.includes("TRAIN [0, 36)") &&
    text.includes("VALIDATION [36, 48)") &&
    text.includes("OOS [48, 60)"),
  "текст: границы сегментов"
);
ok(
  text.includes("warmupStart:") && text.includes("VALIDATION=33"),
  "текст: warmup-индексы (каузальный разогрев виден)"
);
ok(
  text.includes("orderPolicy: input-order"),
  "текст: политика порядка названа"
);
ok(
  text.includes("counts: declared=3 evaluated=3 rejected=0"),
  "текст: счётчики"
);
ok(
  text.includes("inputFingerprint:") &&
    text.includes("resultFingerprint:") &&
    text.includes("reportFingerprint:"),
  "текст: все три отпечатка"
);
ok(
  text.includes("oosConsultedForSelection=false") &&
    text.includes("oosConsultedForRanking=false"),
  "текст: флаги изоляции OOS"
);
ok(
  text.includes("← финальное свидетельство, в выборе НЕ участвует"),
  "текст: OOS явно помечен как не участвующий в выборе"
);
ok(
  text.includes("selection.rationale:"),
  "текст: обоснование выбора"
);
ok(
  ["timeout-1", "timeout-3", "timeout-4"].every((label) => text.includes(label)),
  "текст: все конфигурации перечислены"
);
ok(
  text.includes("PF=null(no-losses)"),
  "текст: состояние PF без убытков показано явно"
);
ok(
  text.includes("ranking (явный, stage=TRAIN") &&
    text.includes("OOS не читался"),
  "текст: ранжирование помечено как явное и без OOS"
);
ok(
  formatExperimentReport(withRejectedView).includes("ОТКЛОНЁН") &&
    formatExperimentReport(withRejectedView).includes("missing-signal-source-id"),
  "текст: отклонённые показаны с причиной"
);
ok(
  formatExperimentReport(zeroView).includes("PF=null(no-trades)"),
  "текст: сегмент без сделок показан с состоянием no-trades"
);
ok(
  formatExperimentReport(zeroView).includes("winRate=n/a"),
  "текст: winRate без сделок показан как n/a (не 0%)"
);
ok(
  text.split("\n").every((line) => !/\bNaN\b/.test(line)),
  "текст: нет NaN"
);
ok(
  !/\d{4}-\d{2}-\d{2}/.test(text),
  "текст: нет дат (детерминированный вывод)"
);

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
