/**
 * P2-C — интеграционные регрессии C0–C7 (P2AB HARDENING #2, P2-C INTEGRATION).
 *
 * Запуск: npx tsx scripts/test-experiment-hardening.ts
 *
 * Покрывает требования интеграции P2-C на финальной базе P2AB f00e47d:
 *  C0 — сверка эквити: ТОЧНОЕ совпадение finalEquity с последней точкой
 *       equityCurve + ограниченная сверка с initialEquity + totalNetPnl;
 *       значимая бухгалтерская ошибка отвергается (негативный контроль);
 *  C1/C2 — исчерпывающее отображение стадий отказа P2-A
 *       (adapter/signals/arithmetic не сводятся молча к provider) и
 *       сохранение ошибок P2-A;
 *  C3 — нефинитные свидетельства не попадают в ранжирование;
 *  C4 — глубокая неизменяемость публичных выходов;
 *  C5 — дословная проекция метрик, включая hardened-метрики;
 *  C6 — непустые и точные границы честности в записи/отчёте;
 *  C7 — изоляция отпечатков OOS: изменение только OOS меняет отпечатки,
 *       но не выбор/ранжирование по TRAIN/VALIDATION.
 *
 * Всё — синтетические фикстуры; доходность не считается и не заявляется.
 */

import {
  type BacktestBar,
  type BacktestResult,
  type SignalProvider,
  entryDecision,
  noTradeDecision
} from "../lib/backtest/contract";
import { canonicalJson, fingerprintResult } from "../lib/backtest/serialize";
import { SPLIT_NAMES, chronologicalSplit } from "../lib/backtest/splits";
import { validateBars } from "../lib/backtest/validate";
import {
  EXPERIMENT_CONTRACT_VERSION,
  EXPERIMENT_LIMITATIONS,
  METRICS_PROVENANCE,
  RANKING_CRITERIA,
  SELECTION_KEY_INPUTS,
  SELECTION_TIE_BREAK,
  type EvidenceEntry,
  type EvidenceMetrics,
  type ExperimentFailureStage,
  type ExperimentInput,
  type ExperimentRecord,
  type ExperimentSubjectInput,
  type SegmentReport,
  type SelectionPolicy,
  type VariantDefinition
} from "../lib/experiment/contract";
import { resolveVariants } from "../lib/experiment/identity";
import {
  buildComparison,
  fingerprintExperiment,
  fingerprintSegmentResults,
  formatExperimentReport,
  projectEvidence
} from "../lib/experiment/report";
import {
  BACKTEST_FAILURE_STAGE_MAP,
  experimentInvariantErrors,
  runExperiment,
  runExperimentReport,
  setExperimentInvariantProbe
} from "../lib/experiment/run";
import { buildSelectionRecord, rankEvidence } from "../lib/experiment/selection";
import {
  assertFiniteEvidenceMetrics,
  assertLimitationsPresent,
  assertOosIsolation,
  assertResultSelfConsistency,
  validateSubmittedSegmentResult,
  windowOf
} from "../lib/experiment/validate";

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

function mustRun(input: ExperimentInput): ExperimentRecord {
  const outcome = runExperiment(input);

  if (!outcome.ok) {
    throw new Error(
      `фикстура: прогон отвергнут (${outcome.stage}): ${outcome.errors.join("; ")}`
    );
  }

  return outcome.record;
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

const BARS = zigzag(120);

/** Список решений по индексам баров; `oosTrade=false` убирает OOS-сделку. */
type SyntheticDecision =
  | ReturnType<typeof entryDecision>
  | ReturnType<typeof noTradeDecision>;

function decisionList(oosTrade: boolean) {
  const list: (SyntheticDecision | null)[] = new Array(BARS.length).fill(null);

  for (const index of [10, 30]) {
    const close = BARS[index].close;

    list[index] = entryDecision(
      "LONG",
      close - 9,
      close + 7,
      `L${String(index)}`
    );
  }

  list[14] = noTradeDecision("NEUTRAL", "n14");
  list[80] = entryDecision(
    "SHORT",
    BARS[80].close + 9,
    BARS[80].close - 7,
    "S80"
  );
  list[84] = noTradeDecision("CANNOT_EVALUATE", "c84");

  if (oosTrade) {
    list[100] = entryDecision(
      "LONG",
      BARS[100].close - 9,
      BARS[100].close + 7,
      "L100"
    );
  }

  return list;
}

const SUBJECT: ExperimentSubjectInput = {
  strategy: { slug: "baseline", version: "0.0.0" },
  market: { asset: "BTCUSDT", exchange: null, timeframe: "1h", timeframeMs: H1 }
};

function variant(label: string, oosTrade: boolean): VariantDefinition {
  return {
    label,
    params: { variant: label },
    config: {},
    signals: decisionList(oosTrade)
  };
}

const INPUT_BASE: ExperimentInput = {
  bars: BARS,
  subject: SUBJECT,
  variants: [variant("alpha", true), variant("beta", false)],
  selectionPolicy: {
    kind: "select-by-rank",
    stage: "TRAIN",
    criteria: ["netPnl"]
  }
};

const OUTCOME = runExperimentReport(INPUT_BASE);

ok(OUTCOME.ok, "фикстура: эксперимент выполнен");
ok(
  OUTCOME.ok && OUTCOME.record.variants.length === 2,
  "фикстура: два варианта в записи"
);

if (!OUTCOME.ok) {
  console.log(`Itog: ${passed}/${total}`);
  process.exit(1);
}

const RECORD: ExperimentRecord = OUTCOME.record;
const VIEW = OUTCOME.view;
const ALPHA = RECORD.variants[0];

ok(
  RECORD.variants.every((item) => item.status === "evaluated"),
  "фикстура: оба варианта оценены"
);

type SegmentName = (typeof SPLIT_NAMES)[number];

function reportOf(variantIndex: number, segment: SegmentName): SegmentReport {
  const report =
    RECORD.variants[variantIndex].segments?.[segment].report ?? null;

  if (report === null) {
    throw new Error(
      `фикстура: нет отчёта ${segment} для варианта ${String(variantIndex)}`
    );
  }

  return report;
}

function resultOf(variantIndex: number, segment: SegmentName): BacktestResult {
  const result =
    RECORD.variants[variantIndex].segments?.[segment].result ?? null;

  if (result === null) {
    throw new Error(
      `фикстура: нет результата ${segment} для варианта ${String(variantIndex)}`
    );
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* C0 — сверка эквити                                                  */
/* ------------------------------------------------------------------ */

function tamperMetrics(
  result: BacktestResult,
  patch: Partial<BacktestResult["metrics"]>
): BacktestResult {
  return { ...result, metrics: { ...result.metrics, ...patch } };
}

const TRAIN_RESULT = resultOf(0, "TRAIN");

ok(
  assertResultSelfConsistency(TRAIN_RESULT).ok,
  "C0: подлинный hardened-результат внутренне согласован"
);
ok(
  TRAIN_RESULT.metrics.finalEquity ===
    TRAIN_RESULT.equityCurve[TRAIN_RESULT.equityCurve.length - 1].equity,
  "C0: finalEquity ТОЧНО равен последней точке equityCurve"
);

const equityTolerance =
  1e-9 * Math.max(1, Math.abs(TRAIN_RESULT.config.initialEquity));

ok(
  equityTolerance > 0 && equityTolerance <= 1e-5,
  `C0: допуск ограничен формулой (${String(equityTolerance)})`
);

ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, {
      totalNetPnl: TRAIN_RESULT.metrics.totalNetPnl + 1000
    })
  ).errors.some((error) => error.includes("finalEquity")),
  "C0: значимая бухгалтерская ошибка (+1000 к netPnl) отвергается"
);

ok(
  !assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, {
      finalEquity: TRAIN_RESULT.metrics.finalEquity + 0.01
    })
  ).ok,
  "C0: расхождение finalEquity с последней точкой equityCurve отвергается"
);

ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, {
      totalNetPnl: TRAIN_RESULT.metrics.totalNetPnl + 1e-7
    })
  ).ok,
  "C0: дрейф ниже допуска (1e-7 при 1e-5) принимается как накопление"
);

ok(
  !assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, {
      totalNetPnl: TRAIN_RESULT.metrics.totalNetPnl + 1e-3
    })
  ).ok,
  "C0: дрейф выше допуска (1e-3) отвергается — допуск не скрывает ошибку"
);

/* ------------------------------------------------------------------ */
/* C1/C2 — стадии отказа P2-A                                          */
/* ------------------------------------------------------------------ */

const STAGE_KEYS = Object.keys(BACKTEST_FAILURE_STAGE_MAP).sort();

ok(
  STAGE_KEYS.join(",") ===
    ["adapter", "arithmetic", "bars", "config", "provider", "signals"].join(","),
  `C1/C2: карта стадий P2-A исчерпывающа (${STAGE_KEYS.join(",")})`
);
ok(
  BACKTEST_FAILURE_STAGE_MAP.adapter.stage === "adapter" &&
    BACKTEST_FAILURE_STAGE_MAP.adapter.reason === "adapter-failure" &&
    BACKTEST_FAILURE_STAGE_MAP.signals.stage === "signals" &&
    BACKTEST_FAILURE_STAGE_MAP.signals.reason === "signals-failure" &&
    BACKTEST_FAILURE_STAGE_MAP.arithmetic.stage === "arithmetic" &&
    BACKTEST_FAILURE_STAGE_MAP.arithmetic.reason === "arithmetic-failure",
  "C1/C2: adapter/signals/arithmetic не сводятся к provider"
);
ok(
  BACKTEST_FAILURE_STAGE_MAP.provider.stage === "provider" &&
    BACKTEST_FAILURE_STAGE_MAP.provider.reason === "provider-failure",
  "C1/C2: provider сохраняет свою стадию"
);

interface RejectionFacts {
  readonly experimentStage: ExperimentFailureStage | null;
  readonly variantStatus: string | null;
  readonly stage: string | null;
  readonly reason: string | null;
  readonly errors: readonly string[];
  readonly segmentErrors: readonly string[];
}

function rejectionOf(input: ExperimentInput): RejectionFacts {
  const outcome = runExperiment(input);

  if (!outcome.ok) {
    return {
      experimentStage: outcome.stage,
      variantStatus: null,
      stage: null,
      reason: null,
      errors: outcome.errors,
      segmentErrors: []
    };
  }

  const rejected = outcome.record.variants.find(
    (item) => item.status === "rejected"
  );

  return {
    experimentStage: null,
    variantStatus: rejected === undefined ? null : rejected.status,
    stage: rejected?.rejection?.stage ?? null,
    reason: rejected?.rejection?.reason ?? null,
    errors: rejected?.rejection?.errors ?? [],
    segmentErrors: rejected?.segments?.TRAIN.errors ?? []
  };
}

/* --- конфиг: отдельная стадия invalid-config --- */

const badConfig = rejectionOf({
  ...INPUT_BASE,
  variants: [
    {
      label: "bad-config",
      params: { variant: "bad-config" },
      config: { quantity: -1 },
      signals: decisionList(true)
    }
  ]
});

ok(
  badConfig.variantStatus === "rejected" &&
    badConfig.stage === "config" &&
    badConfig.reason === "invalid-config",
  "C1/C2: недопустимый конфиг отвергается на стадии config/invalid-config"
);

/* --- бары: стадия bars, не provider --- */

const badBars = rejectionOf({
  ...INPUT_BASE,
  bars: [{ time: T0, open: 1, high: 0, low: 2, close: 1 }],
  variants: [variant("bars", true)]
});

ok(
  !badBars.experimentStage ? false : badBars.experimentStage === "bars",
  "C1/C2: непригодные бары отвергаются на стадии bars"
);

/* --- контейнер решений: отвергается ЯВНО, НЕ как provider --- */

const badSignals = rejectionOf({
  ...INPUT_BASE,
  variants: [
    {
      label: "bad-signals",
      params: { variant: "bad-signals" },
      config: {},
      signals: 42 as never
    }
  ]
});

ok(
  badSignals.variantStatus === "rejected" &&
    badSignals.stage === "variant" &&
    badSignals.reason === "invalid-variant",
  "C1/C2: несериализуемый контейнер решений отвергается как variant/invalid-variant"
);
ok(
  badSignals.errors.length > 0 &&
    badSignals.errors.every(
      (error) =>
        !error.includes("provider-failure") && !error.includes("provider")
    ),
  "C1/C2: отказ контейнера решений не выдаёт себя за provider (текст называет signals)"
);

/* --- adapter: НЕ provider (объект с adapterId не является провайдером) --- */

const badAdapter = rejectionOf({
  ...INPUT_BASE,
  variants: [
    {
      label: "bad-adapter",
      params: { variant: "bad-adapter" },
      config: {},
      signals: { adapterId: "smc-baseline", version: "1.0.0" } as never
    }
  ]
});

ok(
  badAdapter.variantStatus === "rejected" &&
    badAdapter.stage === "variant" &&
    badAdapter.reason === "invalid-variant",
  "C1/C2: adapter-объект отвергается как variant/invalid-variant, не adapter/provider"
);
ok(
  badAdapter.errors.every(
    (error) =>
      !error.includes("provider-failure") && !error.includes("provider")
  ),
  "C1/C2: adapter не выдаёт себя за provider"
);
ok(
  BACKTEST_FAILURE_STAGE_MAP.adapter.stage === "adapter" &&
    BACKTEST_FAILURE_STAGE_MAP.arithmetic.stage === "arithmetic",
  "C1/C2: таблица стадий не сводит adapter/arithmetic к provider даже при недостижимости через API"
);

/* --- arithmetic: ДОСТИЖИМАЯ стадия переполнения, НЕ provider --- */

const overflow = rejectionOf({
  ...INPUT_BASE,
  variants: [
    variant("alpha", true),
    {
      label: "overflow",
      params: { variant: "overflow" },
      config: { quantity: 1e308 },
      signals: decisionList(true)
    }
  ]
});

ok(
  overflow.variantStatus === "rejected" &&
    overflow.stage === "arithmetic" &&
    overflow.reason === "arithmetic-failure",
  "C1/C2: переполнение арифметики — arithmetic/arithmetic-failure, не provider"
);
ok(
  overflow.errors.some((error) => error.includes("Infinity")) &&
    overflow.segmentErrors.some((error) => error.includes("Infinity")),
  "C1/C2: ошибка арифметики P2-A перенесена дословно в запись"
);

/* --- provider: исключение провайдера с сохранением текста --- */

const boom: SignalProvider = () => {
  throw new Error("провайдер: тестовое исключение");
};

const providerFacts = rejectionOf({
  ...INPUT_BASE,
  variants: [
    {
      label: "provider-boom",
      params: { variant: "provider-boom" },
      config: {},
      signals: boom,
      signalSourceId: "boom-source"
    }
  ]
});

ok(
  providerFacts.variantStatus === "rejected" &&
    providerFacts.stage === "provider" &&
    providerFacts.reason === "provider-failure",
  "C1/C2: исключение провайдера — provider/provider-failure"
);
ok(
  providerFacts.errors.some((error) =>
    error.includes("провайдер: тестовое исключение")
  ) &&
    providerFacts.segmentErrors.some((error) =>
      error.includes("провайдер: тестовое исключение")
    ),
  "C1/C2: текст ошибки провайдера P2-A перенесён дословно"
);

/* ------------------------------------------------------------------ */
/* C3 — нефинитные свидетельства                                       */
/* ------------------------------------------------------------------ */

const BASE_METRICS: EvidenceMetrics = {
  trades: 3,
  grossPnl: 12,
  netPnl: 9,
  winRate: 0.5,
  profitFactor: 1.4,
  profitFactorState: "ok",
  expectancy: 3,
  avgR: 0.6,
  medianR: 0.5,
  avgRActualFill: 0.55,
  medianRActualFill: 0.5,
  maxRealizedDrawdown: 4,
  maxRealizedDrawdownPct: 0.4,
  maxMtmDrawdown: 5,
  maxAdverseExcursionDrawdown: 6,
  maxAdverseExcursionDrawdownPct: 0.6,
  maxConsecutiveLosses: 2
};

function evidenceEntry(
  configurationId: string,
  patch: Partial<EvidenceMetrics> = {}
): EvidenceEntry {
  return {
    configurationId,
    selectionKey: `selection-${configurationId}`,
    label: configurationId,
    inputOrder: 0,
    presentationOrder: 0,
    status: "evaluated",
    rejectionReason: null,
    metrics: { ...BASE_METRICS, ...patch }
  };
}

ok(
  assertFiniteEvidenceMetrics(BASE_METRICS).ok,
  "C3: конечные свидетельства проходят проверку"
);
ok(
  !assertFiniteEvidenceMetrics({ ...BASE_METRICS, netPnl: Number.NaN }).ok,
  "C3: NaN netPnl отвергается валидатором свидетельств"
);

const nanRanking = rankEvidence(
  "TRAIN",
  [evidenceEntry("nan", { netPnl: Number.NaN }), evidenceEntry("finite")],
  ["netPnl"]
);

ok(
  nanRanking.order.length === 1 && nanRanking.order[0].configurationId === "finite",
  "C3: NaN netPnl исключён, конечный вариант — rank 0"
);
ok(
  nanRanking.excludedFromRanking.length === 1 &&
    nanRanking.excludedFromRanking[0].reason === "non-finite-evidence",
  "C3: причина исключения — non-finite-evidence (явная и детерминированная)"
);

const infinityRanking = rankEvidence(
  "TRAIN",
  [
    evidenceEntry("inf", { profitFactor: Number.POSITIVE_INFINITY }),
    evidenceEntry("finite")
  ],
  ["netPnl"]
);

ok(
  infinityRanking.order.length === 1 &&
    infinityRanking.order[0].configurationId === "finite",
  "C3: Infinity profitFactor исключён из ранжирования"
);

const negInfinityRanking = rankEvidence(
  "VALIDATION",
  [
    evidenceEntry("neg-inf", { maxRealizedDrawdownPct: Number.NEGATIVE_INFINITY }),
    evidenceEntry("finite")
  ],
  ["maxRealizedDrawdownPct"]
);

ok(
  negInfinityRanking.order.length === 1 &&
    negInfinityRanking.order[0].configurationId === "finite",
  "C3: -Infinity drawdown исключён из ранжирования"
);

const allNonFinite = rankEvidence(
  "TRAIN",
  [
    evidenceEntry("nan", { netPnl: Number.NaN }),
    evidenceEntry("inf", { profitFactor: Number.POSITIVE_INFINITY })
  ],
  ["netPnl"]
);

ok(
  allNonFinite.order.length === 0,
  "C3: все варианты нефинитны → ранжирование пусто"
);
ok(
  allNonFinite.excludedFromRanking.length === 2 &&
    allNonFinite.excludedFromRanking.every(
      (item) => item.reason === "non-finite-evidence"
    ),
  "C3: все нефинитные варианты исключены с явной причиной"
);

const selectionWithNonFinite = buildSelectionRecord(
  { kind: "select-by-rank", stage: "TRAIN", criteria: ["netPnl"] },
  {
    trainSelection: [
      evidenceEntry("nan", { netPnl: Number.NaN }),
      evidenceEntry("inf", { profitFactor: Number.POSITIVE_INFINITY })
    ],
    validationConfirmation: []
  }
);

ok(
  selectionWithNonFinite.performed === false &&
    selectionWithNonFinite.selectedConfigurationId === null,
  "C3: нефинитный вариант не может стать выбранным (fail-closed)"
);

/* ------------------------------------------------------------------ */
/* C4 — глубокая неизменяемость                                        */
/* ------------------------------------------------------------------ */

const evaluatedVariant = RECORD.variants[0];
const trainSegment = evaluatedVariant.segments?.TRAIN ?? null;
const trainReport = trainSegment?.report ?? null;
const trainEvidence = RECORD.evidence.trainSelection[0];
const ranking = RECORD.selection.ranking;

ok(
  Object.isFrozen(RECORD) &&
    Object.isFrozen(RECORD.variants) &&
    Object.isFrozen(RECORD.evidence) &&
    Object.isFrozen(RECORD.evidence.trainSelection) &&
    Object.isFrozen(trainEvidence) &&
    Object.isFrozen(trainEvidence.metrics) &&
    Object.isFrozen(trainSegment) &&
    Object.isFrozen(trainReport) &&
    Object.isFrozen(RECORD.selection) &&
    Object.isFrozen(ranking) &&
    Object.isFrozen(VIEW) &&
    Object.isFrozen(VIEW.rows) &&
    Object.isFrozen(VIEW.limitations),
  "C4: публичные выходы заморожены рекурсивно"
);

let mutationThrew = false;

try {
  (RECORD as unknown as { counts: { declared: number } }).counts.declared = 99;
} catch {
  mutationThrew = true;
}
try {
  (trainReport as unknown as { netPnl: number }).netPnl = 1e9;
} catch {
  mutationThrew = true;
}
try {
  (RECORD as unknown as { variants: unknown[] }).variants.push({});
} catch {
  mutationThrew = true;
}

const recordFingerprintBefore = fingerprintExperiment(RECORD);
const reportFingerprintBefore = VIEW.reportFingerprint;
const canonicalBefore = VIEW.canonicalReport;
const labelBefore = ALPHA.label;

ok(mutationThrew, "C4: попытки мутации бросили (strict mode)");
ok(
  RECORD.counts.declared === 2 &&
    evaluatedVariant.label === labelBefore &&
    (trainReport === null || trainReport.netPnl !== 1e9) &&
    (trainEvidence.metrics === null || trainEvidence.metrics.netPnl !== 1e9),
  "C4: значения публичных выходов не изменились"
);
ok(
  buildComparison(RECORD).reportFingerprint === reportFingerprintBefore &&
    fingerprintExperiment(RECORD) === recordFingerprintBefore &&
    buildComparison(RECORD).canonicalReport === canonicalBefore,
  "C4: отпечаток записи/отчёта и канонический отчёт после попыток мутации не изменились"
);

/* ------------------------------------------------------------------ */
/* C5 — дословная проекция hardened-метрик                             */
/* ------------------------------------------------------------------ */

const hardenedFields = [
  "maxAdverseExcursionDrawdown",
  "maxAdverseExcursionDrawdownPct",
  "avgRActualFill",
  "medianRActualFill"
] as const;

let verbatimOk = true;

for (let index = 0; index < RECORD.variants.length; index += 1) {
  for (const segment of SPLIT_NAMES) {
    const result = RECORD.variants[index].segments?.[segment].result ?? null;
    const report = RECORD.variants[index].segments?.[segment].report ?? null;

    if (result === null || report === null) {
      continue;
    }

    for (const field of hardenedFields) {
      if (result.metrics[field] !== report[field]) {
        verbatimOk = false;
      }
    }

    if (
      report.provenance !== METRICS_PROVENANCE ||
      report.trades !== result.metrics.trades ||
      report.netPnl !== result.metrics.totalNetPnl
    ) {
      verbatimOk = false;
    }
  }
}

ok(verbatimOk, "C5: hardened-метрики и базовые метрики спроецированы дословно");
ok(
  trainReport !== null &&
    projectEvidence(trainReport).maxAdverseExcursionDrawdown ===
      trainReport.maxAdverseExcursionDrawdown &&
    projectEvidence(trainReport).avgRActualFill === trainReport.avgRActualFill,
  "C5: EvidenceMetrics включают hardened-метрики без пересчёта"
);
ok(
  RANKING_CRITERIA.length === 9 &&
    !(RANKING_CRITERIA as readonly string[]).some(
      (criterion) =>
        criterion.includes("ActualFill") || criterion.includes("Adverse")
    ),
  "C5: диагностические метрики не стали критериями ранжирования"
);

/* ------------------------------------------------------------------ */
/* C6 — границы честности                                              */
/* ------------------------------------------------------------------ */

const limitationsText = EXPERIMENT_LIMITATIONS.join("\n");

ok(
  EXPERIMENT_LIMITATIONS.length > 0,
  `C6: список ограничений непуст (${String(EXPERIMENT_LIMITATIONS.length)})`
);
ok(
  limitationsText.includes("OOS структурно исключён"),
  "C6: OOS структурно исключён из выбора/ранжирования"
);
ok(
  limitationsText.includes("SignalContext не содержит метки сегмента"),
  "C6: SignalContext без метки сегмента"
);
ok(
  limitationsText.includes("НЕ доказательство") &&
    limitationsText.includes("замыкание"),
  "C6: явно сказано, что это не доказательство для произвольного JS"
);
ok(
  limitationsText.includes("assertDecisionInvariance") &&
    limitationsText.includes("контрфактическая"),
  "C6: assertDecisionInvariance — контрфактическая диагностика"
);
ok(
  limitationsText.includes("только по каналу контекста"),
  "C6: структурная гарантия ограничена каналом контекста"
);
ok(
  limitationsText.includes("не является заявлением о доходности"),
  "C6: отчёт не заявляет доходность"
);
ok(
  RECORD.limitations.length === EXPERIMENT_LIMITATIONS.length &&
    VIEW.limitations.length === EXPERIMENT_LIMITATIONS.length,
  "C6: ограничения опубликованы в записи и в отчёте"
);
ok(assertLimitationsPresent(RECORD).ok, "C6: инвариант непустых ограничений проходит на записи");

const canonicalLimitations = (
  JSON.parse(VIEW.canonicalReport) as {
    readonly record?: { readonly limitations?: readonly string[] };
  }
).record?.limitations ?? [];

ok(
  canonicalLimitations.length === EXPERIMENT_LIMITATIONS.length &&
    canonicalLimitations.every(
      (item, index) => item === EXPERIMENT_LIMITATIONS[index]
    ),
  "C6: ограничения входят в канонический отчёт (структурно, JSON)"
);
ok(
  formatExperimentReport(VIEW).includes(EXPERIMENT_LIMITATIONS[0]) &&
    formatExperimentReport(VIEW).includes(EXPERIMENT_LIMITATIONS[6]),
  "C6: ограничения входят в текстовый отчёт"
);

const strippedLimitations: ExperimentRecord = { ...RECORD, limitations: [] };

ok(
  !assertLimitationsPresent(strippedLimitations).ok,
  "C6: пустой список ограничений отвергается (negative control)"
);

const wrongLimitations: ExperimentRecord = {
  ...RECORD,
  limitations: ["OOS не участвует в выборе"]
};

ok(
  !assertLimitationsPresent(wrongLimitations).ok,
  "C6: усечённые формулировки ограничений отвергаются"
);

/* ------------------------------------------------------------------ */
/* C7 — изоляция отпечатков OOS                                        */
/* ------------------------------------------------------------------ */

const alphaTrain = canonicalJson(projectEvidence(reportOf(0, "TRAIN")));
const betaTrain = canonicalJson(projectEvidence(reportOf(1, "TRAIN")));
const alphaValidation = canonicalJson(projectEvidence(reportOf(0, "VALIDATION")));
const betaValidation = canonicalJson(projectEvidence(reportOf(1, "VALIDATION")));
const alphaOos = canonicalJson(projectEvidence(reportOf(0, "OOS")));
const betaOos = canonicalJson(projectEvidence(reportOf(1, "OOS")));

ok(
  alphaTrain === betaTrain && alphaValidation === betaValidation,
  "C7: TRAIN/VALIDATION свидетельства идентичны при разном только-OOS поведении"
);
ok(alphaOos !== betaOos, "C7: OOS-свидетельства различаются (изменение только OOS)");

/* Изменение ТОЛЬКО OOS-результата: отпечатки меняются, выбор — нет. */
const clone = structuredClone(RECORD) as ExperimentRecord;
const cloneOos = clone.variants[0].segments?.OOS ?? null;

if (cloneOos !== null && cloneOos.result !== null && cloneOos.report !== null) {
  const mutable = cloneOos as unknown as {
    result: BacktestResult;
    report: SegmentReport;
  };

  mutable.result = {
    ...cloneOos.result,
    metrics: {
      ...cloneOos.result.metrics,
      totalNetPnl: cloneOos.result.metrics.totalNetPnl + 123
    }
  };
  mutable.report = {
    ...cloneOos.report,
    netPnl: cloneOos.report.netPnl + 123
  };
}

ok(
  fingerprintSegmentResults(clone.variants) !== RECORD.resultFingerprint &&
    fingerprintExperiment(clone) !== fingerprintExperiment(RECORD),
  "C7: изменение только OOS-результата меняет resultFingerprint и отпечаток записи"
);
ok(
  buildComparison(clone).reportFingerprint !== VIEW.reportFingerprint,
  "C7: изменение только OOS-результата меняет отчётный отпечаток"
);
ok(
  canonicalJson(clone.selection) === canonicalJson(RECORD.selection) &&
    clone.selection.selectedConfigurationId ===
      RECORD.selection.selectedConfigurationId,
  "C7: выбор/ранжирование по TRAIN/VALIDATION не изменились от OOS-мутации"
);

/* Подмена сохранённого OOS-отчёта отвергается валидацией. */
const RESOLVED = resolveVariants(INPUT_BASE.variants, RECORD.subjectFingerprint)[0]
  .resolved;

const oosWindow = windowOf(RECORD.split, "OOS");
const genuineOosResult = resultOf(0, "OOS");
const genuineOosReport = reportOf(0, "OOS");

function submissionWithOosReport(report: SegmentReport) {
  return {
    configurationId: ALPHA.configurationId,
    subjectFingerprint: RECORD.subjectFingerprint,
    segment: "OOS" as const,
    window: oosWindow,
    result: genuineOosResult,
    report
  };
}

ok(
  RESOLVED !== null && RESOLVED.configurationId === ALPHA.configurationId,
  "C7: разрешённый вариант совпадает с записанной идентичностью"
);

if (RESOLVED !== null) {
  const expectedAssignment = {
    subject: RECORD.subject,
    subjectFingerprint: RECORD.subjectFingerprint,
    split: RECORD.split,
    variant: RESOLVED
  };

  ok(
    genuineOosReport.resultFingerprint === fingerprintResult(genuineOosResult),
    "C7: сохранённый resultFingerprint совпадает с fingerprintResult(result)"
  );
  ok(
    validateSubmittedSegmentResult(
      submissionWithOosReport(genuineOosReport),
      expectedAssignment
    ).ok,
    "C7: подлинный OOS-результат с подлинным отчётом принимается"
  );
  ok(
    !validateSubmittedSegmentResult(
      submissionWithOosReport({
        ...genuineOosReport,
        resultFingerprint: "deadbeef"
      }),
      expectedAssignment
    ).ok,
    "C7: подмена только сохранённого отпечатка OOS-отчёта отвергается"
  );

  /* R2 (hardening #1): SegmentReport — детерминированная проекция
     результата, поэтому подлинного отпечатка НЕДОСТАТОЧНО: отчёт
     сверяется поэлементно с пересчитанной проекцией. */
  ok(
    !validateSubmittedSegmentResult(
      submissionWithOosReport({
        ...genuineOosReport,
        netPnl: genuineOosReport.netPnl + 123
      }),
      expectedAssignment
    ).ok,
    "R2: отчёт с подменёнными метриками ПРИ ПОДЛИННОМ отпечатке отвергается"
  );
  ok(
    !validateSubmittedSegmentResult(
      submissionWithOosReport({
        ...genuineOosReport,
        provenance: "подделка" as never
      }),
      expectedAssignment
    ).ok,
    "R2: подмена provenance отвергается проекционной сверкой"
  );
  ok(
    !validateSubmittedSegmentResult(
      submissionWithOosReport({
        ...genuineOosReport,
        trades: genuineOosReport.trades + 1
      }),
      expectedAssignment
    ).ok,
    "R2: подмена trades отвергается проекционной сверкой"
  );
}

/* ------------------------------------------------------------------ */
/* FIX 1 (блокер аудита) — OOS-СЛЕПОЙ тай-брейк выбора                 */
/* ------------------------------------------------------------------ */

/**
 * Вариант, у которого TRAIN/VALIDATION-часть решений фиксирована (как в
 * `decisionList`), а меняется ТОЛЬКО OOS-часть (индексы >= 48).
 * Пары «alpha»/«beta» дают ТОЧНОЕ равенство критериев TRAIN при разных
 * метках (разные идентичности) — именно на такой паре аудит воспроизвёл
 * OOS-зависимого победителя.
 */
function oosVariant(label: string, mode: string): VariantDefinition {
  const list = decisionList(false);
  const setEntry = (
    index: number,
    side: "LONG" | "SHORT" | null,
    stopOffset: number,
    targetOffset: number,
    tag: string
  ): void => {
    list[index] =
      side === null
        ? noTradeDecision("NEUTRAL", tag)
        : entryDecision(
            side,
            BARS[index].close + stopOffset,
            BARS[index].close + targetOffset,
            tag
          );
  };

  switch (mode) {
    case "baseline":
      break;
    case "noOos":
      list[80] = null;
      list[84] = null;
      break;
    case "long9":
      setEntry(100, "LONG", -9, 7, "L100");
      break;
    case "long5":
      setEntry(100, "LONG", -5, 7, "L100");
      break;
    case "flip80":
      setEntry(80, "LONG", -9, 7, "L80");
      break;
    case "extra90":
      setEntry(90, null, 0, 0, "n90");
      break;
    default:
      throw new Error(`неизвестный OOS-режим ${mode}`);
  }

  return { label, params: { variant: label }, config: {}, signals: list };
}

const BASE_RANKING = RECORD.selection.ranking;
const BASE_WINNER = RECORD.selection.selectedLabel;
const BASE_SELECTION_KEY = RECORD.selection.selectedSelectionKey;
const BASE_ORDER = (BASE_RANKING?.order ?? [])
  .map((entry) => entry.label)
  .join(",");

ok(
  BASE_RANKING !== null &&
    BASE_RANKING.order.length === 2 &&
    BASE_RANKING.order[0].values.netPnl === BASE_RANKING.order[1].values.netPnl,
  "FIX 1: фикстура даёт ТОЧНОЕ равенство критериев (netPnl) у двух вариантов"
);
ok(
  RECORD.variants[0].configurationId !== RECORD.variants[1].configurationId &&
    RECORD.variants[0].selectionKey !== RECORD.variants[1].selectionKey,
  "FIX 1: у tie-вариантов разные полные идентичности И разные выборные ключи"
);
ok(
  RECORD.variants[0].selectionKey !== RECORD.variants[0].configurationId,
  "FIX 1: выборный ключ — отдельная сущность, не полная configurationId"
);
ok(
  BASE_RANKING !== null &&
    BASE_RANKING.tieBreak.key === "selection-key" &&
    BASE_RANKING.tieBreak.oosBlind === true &&
    BASE_RANKING.tieBreak.fallback === "input-order" &&
    BASE_RANKING.tieBreak.keyInputs.join(",") === SELECTION_KEY_INPUTS.join(","),
  "FIX 1: ранжирование объявляет OOS-слепой selectionKey как тай-брейк"
);
ok(
  SELECTION_KEY_INPUTS.join(",") ===
    [
      "subjectFingerprint",
      "label",
      "paramsFingerprint",
      "configFingerprint",
      "signalSource.kind",
      "signalSource.signalSourceId"
    ].join(",") &&
    SELECTION_TIE_BREAK.oosBlind === true &&
    SELECTION_TIE_BREAK.fallback === "input-order",
  "FIX 1: входы выборного ключа исчерпывающе объявлены (OOS-полей нет)"
);
ok(
  BASE_RANKING !== null &&
    BASE_RANKING.order[0].tieBreakApplied === false &&
    BASE_RANKING.order[1].tieBreakApplied === true &&
    BASE_RANKING.order[0].selectionKey < BASE_RANKING.order[1].selectionKey,
  "FIX 1: равные значения упорядочены по selectionKey (tie-break записан)"
);

const OOS_MODES = ["noOos", "long9", "long5", "flip80", "extra90"] as const;

const baselineRepeat = mustRun({
  ...INPUT_BASE,
  variants: [variant("alpha", true), oosVariant("beta", "baseline")]
});

ok(
  fingerprintExperiment(baselineRepeat) === fingerprintExperiment(RECORD) &&
    fingerprintSegmentResults(baselineRepeat.variants) ===
      RECORD.resultFingerprint &&
    canonicalJson(baselineRepeat.selection) === canonicalJson(RECORD.selection),
  "FIX 1 (baseline): повторный прогон детерминирован (отпечатки и выбор совпадают)"
);

for (const mode of OOS_MODES) {
  const mutated = mustRun({
    ...INPUT_BASE,
    variants: [variant("alpha", true), oosVariant("beta", mode)]
  });
  const mutatedOrder = (mutated.selection.ranking?.order ?? [])
    .map((entry) => entry.label)
    .join(",");

  ok(
    mutated.selection.selectedLabel === BASE_WINNER &&
      mutated.selection.selectedSelectionKey === BASE_SELECTION_KEY &&
      mutated.selection.rationale === RECORD.selection.rationale &&
      mutatedOrder === BASE_ORDER,
    `FIX 1 (${mode}): OOS-решения варианта не меняют порядок/победителя/обоснование`
  );
  ok(
    mutated.variants[1].selectionKey === RECORD.variants[1].selectionKey,
    `FIX 1 (${mode}): выборный ключ OOS-слеп (не изменился)`
  );
  ok(
    mutated.variants[1].configurationId !== RECORD.variants[1].configurationId,
    `FIX 1 (${mode}): полная configurationId отражает изменение OOS-входа (происхождение)`
  );
  ok(
    fingerprintExperiment(mutated) !== fingerprintExperiment(RECORD) &&
      fingerprintSegmentResults(mutated.variants) !== RECORD.resultFingerprint,
    `FIX 1 (${mode}): отпечатки записи/результатов МЕНЯЮТСЯ (OOS-часть происхождения)`
  );
}

function cloneRecord(): ExperimentRecord {
  return structuredClone(RECORD) as ExperimentRecord;
}

/* (а) OOS-результат/метрики внутри записи. */
const oosResultMutated = cloneRecord();
{
  const segment = oosResultMutated.variants[0].segments?.OOS ?? null;

  if (segment !== null && segment.result !== null && segment.report !== null) {
    (segment as unknown as { result: BacktestResult }).result = {
      ...segment.result,
      metrics: {
        ...segment.result.metrics,
        totalNetPnl: segment.result.metrics.totalNetPnl + 123
      }
    };
    (segment as unknown as { report: SegmentReport }).report = {
      ...segment.report,
      netPnl: segment.report.netPnl + 123
    };
  }
}

ok(
  canonicalJson(oosResultMutated.selection) === canonicalJson(RECORD.selection) &&
    canonicalJson(oosResultMutated.evidence.trainSelection) ===
      canonicalJson(RECORD.evidence.trainSelection) &&
    fingerprintSegmentResults(oosResultMutated.variants) !==
      RECORD.resultFingerprint,
  "FIX 1: OOS-результат меняет отпечаток, но не выбор и не TRAIN-свидетельства"
);

/* (б) только отпечаток OOS-отчёта. */
const oosReportFpMutated = cloneRecord();
{
  const segment = oosReportFpMutated.variants[1].segments?.OOS ?? null;

  if (segment !== null && segment.report !== null) {
    (segment as unknown as { report: SegmentReport }).report = {
      ...segment.report,
      resultFingerprint: "oos-only-tamper"
    };
  }
}

ok(
  canonicalJson(oosReportFpMutated.selection) === canonicalJson(RECORD.selection),
  "FIX 1: отпечаток OOS-отчёта не влияет на выбор"
);

/* (в) статус/ошибки OOS-сегмента. */
const oosStatusMutated = cloneRecord();
{
  const segment = oosStatusMutated.variants[0].segments?.OOS ?? null;

  if (segment !== null) {
    const mutable = segment as unknown as {
      status: string;
      errors: string[];
      rejectionReason: string | null;
      result: BacktestResult | null;
      report: SegmentReport | null;
    };

    mutable.status = "failed";
    mutable.errors = ["oos-only-tamper"];
    mutable.rejectionReason = "segment-failure";
    mutable.result = null;
    mutable.report = null;
  }
}

ok(
  canonicalJson(oosStatusMutated.selection) === canonicalJson(RECORD.selection) &&
    canonicalJson(oosStatusMutated.evidence.trainSelection) ===
      canonicalJson(RECORD.evidence.trainSelection),
  "FIX 1: отказ OOS-сегмента не исключает вариант из TRAIN-ранжирования"
);

/* (г) сводный статус варианта: отказ ТОЛЬКО OOS (вторая утечка аудита). */
const summaryRejected = cloneRecord();
{
  const variantRecord = summaryRejected.variants[0] as unknown as {
    status: string;
    rejection: unknown;
  };

  variantRecord.status = "rejected";
  variantRecord.rejection = {
    stage: "segment",
    reason: "segment-failure",
    segment: "OOS",
    errors: ["oos-only-tamper"]
  };
}

ok(
  canonicalJson(summaryRejected.evidence.trainSelection) ===
    canonicalJson(RECORD.evidence.trainSelection) &&
    canonicalJson(summaryRejected.selection) === canonicalJson(RECORD.selection),
  "FIX 1: сводный статус (отказ только OOS) не подменяет участие TRAIN-сегмента"
);

/* (д) перестановка порядка объявления. */
const permuted = mustRun({
  ...INPUT_BASE,
  variants: [variant("beta", false), variant("alpha", true)]
});

ok(
  permuted.selection.selectedLabel === BASE_WINNER &&
    permuted.selection.selectedSelectionKey === BASE_SELECTION_KEY &&
    (permuted.selection.ranking?.order ?? [])
      .map((entry) => entry.label)
      .join(",") === BASE_ORDER,
  "FIX 1: перестановка объявления не меняет порядок/победителя (OOS-слепой контракт)"
);

/* (е2) Публичный путь второй утечки: вариант, у которого отказывает
   ТОЛЬКО OOS-сегмент (провайдер бросает исключение лишь на барах OOS),
   обязан остаться участником TRAIN-ранжирования — сводный статус
   варианта не подменяет статус сегмента. */

const oosStartTime = T0 + RECORD.split.oos.startIndex * H1;
const oosOnlyFailure: SignalProvider = (context) => {
  if (context.bar.time >= oosStartTime) {
    throw new Error("OOS-only: тестовый отказ сегмента");
  }

  return null;
};

const mixed = mustRun({
  ...INPUT_BASE,
  variants: [
    variant("alpha", true),
    {
      label: "oos-fails",
      params: { variant: "oos-fails" },
      config: {},
      signals: oosOnlyFailure,
      signalSourceId: "oos-only-fail"
    }
  ],
  selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["trades"] }
});

const oosFailingVariant = mixed.variants.find(
  (item) => item.label === "oos-fails"
);

ok(
  mixed.counts.evaluated === 1 && mixed.counts.rejected === 1,
  "FIX 1: вариант с отказом только OOS имеет сводный статус rejected"
);
ok(
  oosFailingVariant !== undefined &&
    oosFailingVariant.status === "rejected" &&
    oosFailingVariant.rejection?.segment === "OOS",
  "FIX 1: причина отказа варианта локализована в OOS-сегменте"
);
ok(
  oosFailingVariant !== undefined &&
    oosFailingVariant.segments?.TRAIN.status === "ok" &&
    oosFailingVariant.segments?.OOS.status === "failed",
  "FIX 1: TRAIN-сегмент оценён, OOS-сегмент отказал"
);
ok(
  mixed.evidence.trainSelection.some(
    (entry) => entry.label === "oos-fails" && entry.status === "evaluated"
  ),
  "FIX 1: TRAIN-свидетельство OOS-падающего варианта — evaluated (не подменено сводным статусом)"
);
ok(
  (mixed.selection.ranking?.order ?? []).some(
    (entry) => entry.label === "oos-fails"
  ),
  "FIX 1: OOS-падающий вариант остаётся в TRAIN-ранжировании (вторая утечка закрыта)"
);

/* ------------------------------------------------------------------ */
/* FIX 2 — канонические ограничения неизменяемы и сверяются точно      */
/* ------------------------------------------------------------------ */

const canonicalLimitationsSnapshot = [...EXPERIMENT_LIMITATIONS];

ok(
  Object.isFrozen(EXPERIMENT_LIMITATIONS),
  "FIX 2: канонический список ограничений заморожен"
);

let freezeThrew = 0;

try {
  (EXPERIMENT_LIMITATIONS as unknown as string[]).push("внедрённая формулировка");
} catch {
  freezeThrew += 1;
}
try {
  (EXPERIMENT_LIMITATIONS as unknown as string[]).splice(0, 1);
} catch {
  freezeThrew += 1;
}
try {
  (EXPERIMENT_LIMITATIONS as unknown as string[])[0] = "переписанная формулировка";
} catch {
  freezeThrew += 1;
}
try {
  (EXPERIMENT_LIMITATIONS as unknown as { length: number }).length = 0;
} catch {
  freezeThrew += 1;
}

ok(
  freezeThrew === 4,
  `FIX 2: push/splice/присваивание по индексу/усечение length отвергнуты (${String(freezeThrew)}/4)`
);
ok(
  EXPERIMENT_LIMITATIONS.length === canonicalLimitationsSnapshot.length &&
    EXPERIMENT_LIMITATIONS.every(
      (item, index) => item === canonicalLimitationsSnapshot[index]
    ),
  "FIX 2: канонический список не изменился после попыток мутации"
);

const afterFreezeAttempts = runExperimentReport(INPUT_BASE);

ok(
  afterFreezeAttempts.ok &&
    afterFreezeAttempts.record.limitations.length ===
      canonicalLimitationsSnapshot.length &&
    afterFreezeAttempts.record.limitations.every(
      (item, index) => item === canonicalLimitationsSnapshot[index]
    ),
  "FIX 2: будущие записи получают неизменённые канонические ограничения"
);

ok(
  assertLimitationsPresent({
    ...RECORD,
    limitations: canonicalLimitationsSnapshot.slice(0, 6)
  }).ok === false,
  "FIX 2: усечённый список ограничений отвергается"
);
ok(
  assertLimitationsPresent({ ...RECORD, limitations: [] }).ok === false,
  "FIX 2: пустой список отвергается"
);

const rewrittenLimitations = [...canonicalLimitationsSnapshot];
rewrittenLimitations[3] = "ослабленная формулировка";

ok(
  assertLimitationsPresent({ ...RECORD, limitations: rewrittenLimitations })
    .ok === false,
  "FIX 2: переписанная формулировка отвергается"
);
ok(
  assertLimitationsPresent({
    ...RECORD,
    limitations: [...canonicalLimitationsSnapshot, "лишняя формулировка"]
  }).ok === false,
  "FIX 2: дополненный список отвергается"
);

const reorderedLimitations = [...canonicalLimitationsSnapshot];
[reorderedLimitations[0], reorderedLimitations[1]] = [
  reorderedLimitations[1],
  reorderedLimitations[0]
];

ok(
  assertLimitationsPresent({
    ...RECORD,
    limitations: reorderedLimitations
  }).ok === false,
  "FIX 2: переупорядоченный список отвергается"
);
ok(
  assertLimitationsPresent({
    ...RECORD,
    limitations: [...canonicalLimitationsSnapshot]
  }).ok === true,
  "FIX 2: точная каноническая копия принимается (positive control)"
);

/* ------------------------------------------------------------------ */
/* FIX 3 — пин ПРОВОДКИ: цепочка инвариантов runExperiment              */
/* ------------------------------------------------------------------ */

const emptyLimitationsRecord: ExperimentRecord = { ...RECORD, limitations: [] };

ok(
  experimentInvariantErrors(emptyLimitationsRecord).some((error) =>
    error.includes("limitations")
  ),
  "FIX 3: цепочка инвариантов runExperiment отвергает запись с ПУСТЫМИ ограничениями"
);
ok(
  experimentInvariantErrors({
    ...RECORD,
    limitations: canonicalLimitationsSnapshot.slice(0, 3)
  }).some((error) => error.includes("limitations")),
  "FIX 3: цепочка инвариантов отвергает запись с УСЕЧЁННЫМИ ограничениями"
);
ok(
  experimentInvariantErrors(RECORD).length === 0,
  "FIX 3: на подлинной записи цепочка инвариантов чиста (positive control)"
);

/* ------------------------------------------------------------------ */
/* FIX 4 — точное равенство последней точки equityCurve                */
/* ------------------------------------------------------------------ */

const baseEquityValue = TRAIN_RESULT.metrics.finalEquity;
const oneE12Equity = baseEquityValue + 1e-12;

ok(
  oneE12Equity !== baseEquityValue,
  "FIX 4: сдвиг 1e-12 представим в double на этой величине"
);
ok(
  Math.abs(oneE12Equity - baseEquityValue) < equityTolerance,
  "FIX 4: 1e-12 НИЖЕ допуска сверки — расхождение всё равно должно быть отвергнуто"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { finalEquity: oneE12Equity })
  ).ok === false,
  "FIX 4: расхождение 1e-12 с последней точкой equityCurve отвергается"
);

const fractionEquity =
  baseEquityValue + equityTolerance / 1000;

ok(
  fractionEquity !== baseEquityValue &&
    Math.abs(fractionEquity - baseEquityValue) < equityTolerance,
  "FIX 4: доля допуска (1/1000) представима и ниже допуска сверки"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { finalEquity: fractionEquity })
  ).ok === false,
  "FIX 4: доля допуска (1/1000) отвергается ТОЧНОЙ сверкой последней точки"
);

const curvePointTampered: BacktestResult = {
  ...TRAIN_RESULT,
  equityCurve: TRAIN_RESULT.equityCurve.map((point, index) =>
    index === TRAIN_RESULT.equityCurve.length - 1
      ? { ...point, equity: point.equity + 1e-12 }
      : point
  )
};

ok(
  curvePointTampered.equityCurve[curvePointTampered.equityCurve.length - 1]
    .equity !==
    TRAIN_RESULT.equityCurve[TRAIN_RESULT.equityCurve.length - 1].equity,
  "FIX 4: фикстура сдвигает ИМЕННО последнюю точку equityCurve"
);
ok(
  assertResultSelfConsistency(curvePointTampered).ok === false,
  "FIX 4: сдвиг только точки equityCurve на 1e-12 отвергается (симметрично)"
);

/* ------------------------------------------------------------------ */
/* FIX 5 — нефинитные входы бухгалтерии: явный fail-closed             */
/* ------------------------------------------------------------------ */

function withInitialEquity(
  result: BacktestResult,
  initialEquity: number
): BacktestResult {
  return {
    ...result,
    config: { ...result.config, initialEquity }
  };
}

ok(
  assertResultSelfConsistency(
    withInitialEquity(TRAIN_RESULT, Number.NaN)
  ).ok === false,
  "FIX 5: initialEquity=NaN отвергается"
);
ok(
  assertResultSelfConsistency(
    withInitialEquity(TRAIN_RESULT, Number.POSITIVE_INFINITY)
  ).ok === false,
  "FIX 5: initialEquity=+Infinity отвергается (допуск не становится бесконечным)"
);
ok(
  assertResultSelfConsistency(
    withInitialEquity(TRAIN_RESULT, Number.NEGATIVE_INFINITY)
  ).ok === false,
  "FIX 5: initialEquity=-Infinity отвергается"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { finalEquity: Number.NaN })
  ).ok === false,
  "FIX 5: finalEquity=NaN отвергается"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { finalEquity: Number.POSITIVE_INFINITY })
  ).ok === false,
  "FIX 5: finalEquity=+Infinity отвергается"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { finalEquity: Number.NEGATIVE_INFINITY })
  ).ok === false,
  "FIX 5: finalEquity=-Infinity отвергается"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { totalNetPnl: Number.NaN })
  ).ok === false,
  "FIX 5: totalNetPnl=NaN отвергается"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { totalNetPnl: Number.POSITIVE_INFINITY })
  ).ok === false,
  "FIX 5: totalNetPnl=+Infinity отвергается"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(TRAIN_RESULT, { totalNetPnl: Number.NEGATIVE_INFINITY })
  ).ok === false,
  "FIX 5: totalNetPnl=-Infinity отвергается"
);

const infiniteLastPoint: BacktestResult = {
  ...TRAIN_RESULT,
  metrics: { ...TRAIN_RESULT.metrics, finalEquity: Number.POSITIVE_INFINITY },
  equityCurve: TRAIN_RESULT.equityCurve.map((point, index) =>
    index === TRAIN_RESULT.equityCurve.length - 1
      ? { ...point, equity: Number.POSITIVE_INFINITY }
      : point
  )
};

ok(
  infiniteLastPoint.metrics.finalEquity ===
    infiniteLastPoint.equityCurve[infiniteLastPoint.equityCurve.length - 1]
      .equity,
  "FIX 5: фикстура согласована (Infinity === Infinity) — без FIX 5 прошла бы"
);
ok(
  assertResultSelfConsistency(infiniteLastPoint).ok === false,
  "FIX 5: нефинитная последняя точка equityCurve отвергается даже при согласованном finalEquity"
);

const nanLastPoint: BacktestResult = {
  ...TRAIN_RESULT,
  equityCurve: TRAIN_RESULT.equityCurve.map((point, index) =>
    index === TRAIN_RESULT.equityCurve.length - 1
      ? { ...point, equity: Number.NaN }
      : point
  )
};

ok(
  assertResultSelfConsistency(nanLastPoint).ok === false,
  "FIX 5: NaN в последней точке equityCurve отвергается"
);
ok(
  assertResultSelfConsistency(TRAIN_RESULT).ok === true,
  "FIX 5: подлинный результат по-прежнему принимается (positive control)"
);

/* ------------------------------------------------------------------ */
/* HARDENING #2, FIX 1 — сегмент-локальная допустимость выбора          */
/*                                                                     */
/* Вариант-победитель `segment-b` оценён на TRAIN и VALIDATION, но     */
/* отказывает ТОЛЬКО на OOS. Сводный статус варианта остаётся          */
/* `rejected` (происхождение), однако выбор по TRAIN/VALIDATION обязан */
/* остаться действительным и НЕ зависеть от OOS.                        */
/* ------------------------------------------------------------------ */

const OOS_WINDOW_START = T0 + RECORD.split.oos.startIndex * H1;

/** Провайдер: решения в TRAIN/VALIDATION; на OOS — отказ или успех. */
function segmentLocalVariant(args: {
  readonly label: string;
  readonly trainIndexes: readonly number[];
  readonly validationIndexes: readonly number[];
  readonly oosFailure: string | null;
}): VariantDefinition {
  const provider: SignalProvider = (context) => {
    if (context.bar.time >= OOS_WINDOW_START) {
      if (args.oosFailure !== null) {
        throw new Error(args.oosFailure);
      }

      return entryDecision(
        "LONG",
        context.bar.close - 9,
        context.bar.close + 7,
        "OOS"
      );
    }

    if (args.trainIndexes.includes(context.index)) {
      return entryDecision(
        "LONG",
        context.bar.close - 9,
        context.bar.close + 7,
        `T${String(context.index)}`
      );
    }

    if (args.validationIndexes.includes(context.index)) {
      return entryDecision(
        "LONG",
        context.bar.close - 9,
        context.bar.close + 7,
        `V${String(context.index)}`
      );
    }

    return null;
  };

  return {
    label: args.label,
    params: { variant: args.label },
    config: {},
    signals: provider,
    signalSourceId: `src-${args.label}`
  };
}

const SEGMENT_WINNER = segmentLocalVariant({
  label: "segment-b",
  trainIndexes: [10, 30],
  validationIndexes: [80, 84],
  oosFailure: "H2: OOS-отказ"
});
const SEGMENT_WINNER_OOS_OK = segmentLocalVariant({
  label: "segment-b",
  trainIndexes: [10, 30],
  validationIndexes: [80, 84],
  oosFailure: null
});
const SEGMENT_RUNNER_UP = segmentLocalVariant({
  label: "segment-a",
  trainIndexes: [12],
  validationIndexes: [78],
  oosFailure: null
});

function segmentPolicy(stage: "TRAIN" | "VALIDATION"): SelectionPolicy {
  return { kind: "select-by-rank", stage, criteria: ["trades"] };
}

interface SelectionSnapshot {
  readonly winner: string | null;
  readonly selectedKey: string | null;
  readonly selectedId: string | null;
  readonly order: string;
  readonly rationale: string;
  readonly trainEvidence: string;
  readonly validationEvidence: string;
}

function selectionSnapshot(record: ExperimentRecord): SelectionSnapshot {
  return {
    winner: record.selection.selectedLabel,
    selectedKey: record.selection.selectedSelectionKey,
    selectedId: record.selection.selectedConfigurationId,
    order: (record.selection.ranking?.order ?? [])
      .map((entry) => `${entry.label}:${entry.selectionKey}`)
      .join(" > "),
    rationale: record.selection.rationale,
    trainEvidence: canonicalJson(record.evidence.trainSelection),
    validationEvidence: canonicalJson(
      record.evidence.validationConfirmation
    )
  };
}

const oosFailTrainOutcome = runExperiment({
  bars: BARS,
  subject: SUBJECT,
  variants: [SEGMENT_RUNNER_UP, SEGMENT_WINNER],
  selectionPolicy: segmentPolicy("TRAIN")
});
const oosOkTrainOutcome = runExperiment({
  bars: BARS,
  subject: SUBJECT,
  variants: [SEGMENT_RUNNER_UP, SEGMENT_WINNER_OOS_OK],
  selectionPolicy: segmentPolicy("TRAIN")
});
const oosFailValidationOutcome = runExperiment({
  bars: BARS,
  subject: SUBJECT,
  variants: [SEGMENT_RUNNER_UP, SEGMENT_WINNER],
  selectionPolicy: segmentPolicy("VALIDATION")
});
const oosOkValidationOutcome = runExperiment({
  bars: BARS,
  subject: SUBJECT,
  variants: [SEGMENT_RUNNER_UP, SEGMENT_WINNER_OOS_OK],
  selectionPolicy: segmentPolicy("VALIDATION")
});

ok(
  oosFailTrainOutcome.ok,
  "FIX 1 (H2): select-by-rank TRAIN с OOS-отказом победителя — запись действительна (не stage=invariant)"
);
ok(
  oosFailValidationOutcome.ok,
  "FIX 1 (H2): select-by-rank VALIDATION с OOS-отказом победителя — запись действительна (не stage=invariant)"
);
ok(
  oosOkTrainOutcome.ok && oosOkValidationOutcome.ok,
  "FIX 1 (H2): положительный контроль — эквивалентный вариант без OOS-отказа валиден"
);

if (
  oosFailTrainOutcome.ok &&
  oosOkTrainOutcome.ok &&
  oosFailValidationOutcome.ok &&
  oosOkValidationOutcome.ok
) {
  const failTrainRecord = oosFailTrainOutcome.record;
  const okTrainRecord = oosOkTrainOutcome.record;
  const failValidationRecord = oosFailValidationOutcome.record;
  const okValidationRecord = oosOkValidationOutcome.record;

  const failWinner = failTrainRecord.variants.find(
    (item) => item.label === "segment-b"
  );
  const failTrainRow = buildComparison(failTrainRecord).rows.find(
    (row) => row.label === "segment-b"
  );
  const failTrainText = formatExperimentReport(buildComparison(failTrainRecord));

  ok(
    failTrainRecord.selection.selectedLabel === "segment-b" &&
      failTrainRecord.selection.selectedConfigurationId ===
        failWinner?.configurationId &&
      failTrainRecord.selection.selectedSelectionKey ===
        failWinner?.selectionKey,
    "FIX 1 (H2): победитель TRAIN — OOS-падающий вариант, выбранный по своему TRAIN-сегменту"
  );
  ok(
    canonicalJson(selectionSnapshot(failTrainRecord)) ===
      canonicalJson(selectionSnapshot(okTrainRecord)),
    "FIX 1 (H2): победитель/порядок/входы тай-брейка/rationale/свидетельства не изменились от OOS-отказа"
  );
  ok(
    canonicalJson(selectionSnapshot(failValidationRecord)) ===
      canonicalJson(selectionSnapshot(okValidationRecord)),
    "FIX 1 (H2): то же для политики VALIDATION"
  );
  ok(
    failTrainRecord.selection.rationale === okTrainRecord.selection.rationale &&
      failValidationRecord.selection.rationale ===
        okValidationRecord.selection.rationale,
    "FIX 1 (H2): rationale выбора не зависит от OOS-отказа"
  );
  ok(
    canonicalJson(failTrainRecord.counts) ===
      canonicalJson({ declared: 2, evaluated: 1, rejected: 1 }),
    "FIX 1 (H2): сводные счётчики честно отражают OOS-отказ (1 оценён, 1 отклонён)"
  );
  ok(
    failWinner !== undefined &&
      failWinner.status === "rejected" &&
      failWinner.rejection?.segment === "OOS" &&
      failWinner.rejection.errors.length > 0,
    "FIX 1 (H2): сводный статус победителя остаётся rejected с причиной в OOS-сегменте (происхождение)"
  );
  ok(
    failWinner?.segments?.TRAIN.status === "ok" &&
      failWinner?.segments?.VALIDATION.status === "ok" &&
      failWinner?.segments?.OOS.status === "failed" &&
      failWinner?.segments?.OOS.result === null &&
      failWinner?.segments?.OOS.report === null,
    "FIX 1 (H2): сегмент-локальные статусы видны в записи (TRAIN/VALIDATION ok, OOS failed)"
  );
  ok(
    failWinner?.segments?.OOS.errors.some((error) =>
      error.includes("H2: OOS-отказ")
    ) === true,
    "FIX 1 (H2): текст ошибки OOS-сегмента сохранён в записи"
  );
  ok(
    failTrainRow !== undefined &&
      failTrainRow.status === "rejected" &&
      failTrainRow.oos === null &&
      failTrainRow.train !== null &&
      failTrainRow.validation !== null,
    "FIX 1 (H2): отчёт сравнения показывает OOS-отказ, не теряя TRAIN/VALIDATION"
  );
  ok(
    failTrainText.includes("H2: OOS-отказ") &&
      failTrainText.includes("segment-b"),
    "FIX 1 (H2): форматированный отчёт сохраняет видимость OOS-отказа"
  );
  ok(
    assertOosIsolation(failTrainRecord).ok &&
      experimentInvariantErrors(failTrainRecord).length === 0,
    "FIX 1 (H2): запись с OOS-отказом победителя проходит цепочку инвариантов"
  );

  /* смена ТОЛЬКО причины/текста OOS-отказа */
  const otherReasonVariant = segmentLocalVariant({
    label: "segment-b",
    trainIndexes: [10, 30],
    validationIndexes: [80, 84],
    oosFailure: "H2: OOS-отказ (изменённый текст)"
  });
  const otherReasonOutcome = runExperiment({
    bars: BARS,
    subject: SUBJECT,
    variants: [SEGMENT_RUNNER_UP, otherReasonVariant],
    selectionPolicy: segmentPolicy("TRAIN")
  });

  ok(
    otherReasonOutcome.ok &&
      canonicalJson(selectionSnapshot(otherReasonOutcome.record)) ===
        canonicalJson(selectionSnapshot(failTrainRecord)),
    "FIX 1 (H2): смена ТОЛЬКО причины OOS-отказа не меняет выбор/порядок/rationale/свидетельства"
  );
  ok(
    otherReasonOutcome.ok &&
      canonicalJson(otherReasonOutcome.record.variants[1].segments?.OOS.errors) !==
        canonicalJson(failTrainRecord.variants[1].segments?.OOS.errors),
    "FIX 1 (H2): негативный контроль — смена текста OOS-отказа действительно применена"
  );

  /* перестановка объявления */
  const permutedOutcome = runExperiment({
    bars: BARS,
    subject: SUBJECT,
    variants: [SEGMENT_WINNER, SEGMENT_RUNNER_UP],
    selectionPolicy: segmentPolicy("TRAIN")
  });

  ok(
    permutedOutcome.ok &&
      permutedOutcome.record.selection.selectedLabel === "segment-b" &&
      (permutedOutcome.record.selection.ranking?.order ?? [])
        .map((entry) => entry.label)
        .join(">") === "segment-b>segment-a" &&
      permutedOutcome.record.selection.rationale ===
        failTrainRecord.selection.rationale,
    "FIX 1 (H2): перестановка объявления не меняет победителя/порядок/rationale"
  );
}

/* Точное равенство критериев: победитель определяется ВЫБОРНЫМ КЛЮЧОМ
   (tie-x лексикографически раньше tie-a), а не сводным статусом. */

const TIE_WINNER = segmentLocalVariant({
  label: "tie-x",
  trainIndexes: [10],
  validationIndexes: [80],
  oosFailure: "H2: OOS-отказ (точное равенство)"
});
const TIE_WINNER_OOS_OK = segmentLocalVariant({
  label: "tie-x",
  trainIndexes: [10],
  validationIndexes: [80],
  oosFailure: null
});
const TIE_RUNNER = segmentLocalVariant({
  label: "tie-a",
  trainIndexes: [10],
  validationIndexes: [80],
  oosFailure: null
});

const tieFailOutcome = runExperiment({
  bars: BARS,
  subject: SUBJECT,
  variants: [TIE_RUNNER, TIE_WINNER],
  selectionPolicy: segmentPolicy("TRAIN")
});
const tieOkOutcome = runExperiment({
  bars: BARS,
  subject: SUBJECT,
  variants: [TIE_RUNNER, TIE_WINNER_OOS_OK],
  selectionPolicy: segmentPolicy("TRAIN")
});

ok(
  tieFailOutcome.ok &&
    tieOkOutcome.ok &&
    tieFailOutcome.record.selection.selectedLabel === "tie-x" &&
    tieFailOutcome.record.selection.ranking?.order[0]?.label === "tie-x" &&
    tieFailOutcome.record.selection.ranking?.order[1]?.tieBreakApplied === true,
  "FIX 1 (H2): при ТОЧНОМ равенстве критериев победитель определён выборным ключом и не зависит от OOS-отказа"
);
ok(
  tieFailOutcome.ok &&
    tieOkOutcome.ok &&
    canonicalJson(selectionSnapshot(tieFailOutcome.record)) ===
      canonicalJson(selectionSnapshot(tieOkOutcome.record)),
  "FIX 1 (H2): точное равенство — снапшот выбора совпадает с OOS-успешным эквивалентом"
);

/* ------------------------------------------------------------------ */
/* HARDENING #2, FIX 2 — end-to-end пин проводки цепочки инвариантов    */
/* ------------------------------------------------------------------ */

const WIRING_PROBE_MARKER =
  "hardening #2: шов проводки цепочки инвариантов (end-to-end)";

/** Шов исполняется ВНУТРИ цепочки: если runExperiment её не потребляет — маркер не всплывёт. */
const wiredOutcome = (() => {
  setExperimentInvariantProbe(() => [WIRING_PROBE_MARKER]);

  try {
    return runExperiment(INPUT_BASE);
  } finally {
    setExperimentInvariantProbe(null);
  }
})();

ok(
  !wiredOutcome.ok &&
    wiredOutcome.stage === "invariant" &&
    wiredOutcome.errors.includes(WIRING_PROBE_MARKER),
  "FIX 2 (H2): runExperiment ПОТРЕБЛЯЕТ цепочку инвариантов — шов на её выходе меняет исход (end-to-end)"
);

const additiveOutcome = (() => {
  setExperimentInvariantProbe(() => []);

  try {
    return runExperiment(INPUT_BASE);
  } finally {
    setExperimentInvariantProbe(null);
  }
})();

ok(
  additiveOutcome.ok,
  "FIX 2 (H2): аддитивный шов с пустым результатом не отвергает подлинную запись"
);

const additiveAddsNotReplaces = (() => {
  setExperimentInvariantProbe(() => [WIRING_PROBE_MARKER]);

  try {
    return (
      experimentInvariantErrors(emptyLimitationsRecord).includes(
        WIRING_PROBE_MARKER
      ) &&
      experimentInvariantErrors(emptyLimitationsRecord).some((error) =>
        error.includes("limitations")
      )
    );
  } finally {
    setExperimentInvariantProbe(null);
  }
})();

ok(
  additiveAddsNotReplaces,
  "FIX 2 (H2): шов ДОБАВЛЯЕТ ошибку, но не заменяет/не отключает существующие проверки"
);

ok(
  experimentInvariantErrors(RECORD).length === 0 && runExperiment(INPUT_BASE).ok,
  "FIX 2 (H2): после снятия шва поведение восстановлено (positive control)"
);

/* ------------------------------------------------------------------ */
/* Контракт интеграции                                                 */
/* ------------------------------------------------------------------ */

ok(
  EXPERIMENT_CONTRACT_VERSION === "p2c-1.2.0",
  "контракт: версия p2c-1.2.0 (OOS-слепой выборный ключ + hardening #1)"
);
ok(
  validateBars(BARS, resultOf(0, "TRAIN").config).ok,
  "контракт: синтетические бары пригодны для P2-A"
);
ok(
  chronologicalSplit(BARS.length).ok,
  "контракт: P2-A разбиение выполнимо на фикстуре"
);
ok(
  SPLIT_NAMES.length === 3 && RECORD.evidence.oosFinal.length === 2,
  "контракт: три сегмента и отдельный блок OOS-свидетельств"
);

/* ------------------------------------------------------------------ */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
