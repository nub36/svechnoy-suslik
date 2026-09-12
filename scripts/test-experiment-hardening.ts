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
  type EvidenceEntry,
  type EvidenceMetrics,
  type ExperimentFailureStage,
  type ExperimentInput,
  type ExperimentRecord,
  type ExperimentSubjectInput,
  type SegmentReport,
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
  runExperiment,
  runExperimentReport
} from "../lib/experiment/run";
import { buildSelectionRecord, rankEvidence } from "../lib/experiment/selection";
import {
  assertFiniteEvidenceMetrics,
  assertLimitationsPresent,
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
  STAGE_KEYS.join(",") === "adapter,arithmetic,bars,config,provider,signals",
  `C1/C2: карта стадий покрывает все стадии P2-A (${STAGE_KEYS.join(",")})`
);
ok(
  BACKTEST_FAILURE_STAGE_MAP.adapter.stage === "adapter" &&
    BACKTEST_FAILURE_STAGE_MAP.adapter.reason === "adapter-failure",
  "C1/C2: adapter → adapter/adapter-failure (не provider)"
);
ok(
  BACKTEST_FAILURE_STAGE_MAP.signals.stage === "signals" &&
    BACKTEST_FAILURE_STAGE_MAP.signals.reason === "signals-failure",
  "C1/C2: signals → signals/signals-failure (не provider)"
);
ok(
  BACKTEST_FAILURE_STAGE_MAP.arithmetic.stage === "arithmetic" &&
    BACKTEST_FAILURE_STAGE_MAP.arithmetic.reason === "arithmetic-failure",
  "C1/C2: arithmetic → arithmetic/arithmetic-failure (не provider)"
);
ok(
  STAGE_KEYS.filter(
    (stage) =>
      BACKTEST_FAILURE_STAGE_MAP[
        stage as keyof typeof BACKTEST_FAILURE_STAGE_MAP
      ].reason === "provider-failure"
  ).join(",") === "provider",
  "C1/C2: provider-failure назначается ТОЛЬКО стадии provider"
);

interface RejectionSummary {
  readonly experimentStage: ExperimentFailureStage | null;
  readonly variantStatus: string | null;
  readonly stage: string | null;
  readonly reason: string | null;
  readonly errors: readonly string[];
}

function rejectionOf(input: ExperimentInput): RejectionSummary {
  const outcome = runExperiment(input);

  if (!outcome.ok) {
    return {
      experimentStage: outcome.stage,
      variantStatus: null,
      stage: null,
      reason: null,
      errors: outcome.errors
    };
  }

  const first = outcome.record.variants[0];
  const rejection = first.rejection;

  return {
    experimentStage: null,
    variantStatus: first.status,
    stage: rejection === null ? null : rejection.stage,
    reason: rejection === null ? null : rejection.reason,
    errors: rejection === null ? [] : [...rejection.errors]
  };
}

/*
 * Мусорный контейнер решений НЕ доходит до P2-A: слой идентичности P2-C
 * отвергает его ЯВНО на уровне варианта (variant/invalid-variant) с
 * требованием контракта. Молчаливого сведения к provider-failure нет —
 * стадии adapter/signals/arithmetic закреплены в карте стадий выше.
 */
const badSignals = rejectionOf({
  ...INPUT_BASE,
  variants: [
    { label: "bad-signals", config: {}, signals: 42 as unknown as SignalProvider }
  ]
});

ok(
  badSignals.variantStatus === "rejected" &&
    badSignals.stage === "variant" &&
    badSignals.reason === "invalid-variant" &&
    badSignals.errors.some((item) => item.includes("signals")),
  `C1/C2: мусорный контейнер решений отвергается явно на уровне варианта (получено ${String(
    badSignals.stage
  )}/${String(badSignals.reason)})`
);
ok(
  badSignals.reason !== "provider-failure" && badSignals.stage !== "provider",
  "C1/C2: мусорный контейнер решений не сводится к provider-failure"
);

/*
 * Объект, похожий на P2-A адаптер, но несериализуемый (decide-число):
 * тот же явный отказ уровня варианта, а не provider-failure; сама стадия
 * `adapter` покрыта картой стадий (assert выше).
 */
const badAdapter = rejectionOf({
  ...INPUT_BASE,
  variants: [
    {
      label: "bad-adapter",
      config: {},
      signals: { decide: 5 } as unknown as SignalProvider
    }
  ]
});

ok(
  badAdapter.variantStatus === "rejected" &&
    badAdapter.stage === "variant" &&
    badAdapter.reason === "invalid-variant" &&
    String(badAdapter.reason) !== "provider-failure",
  `C1/C2: несериализуемый адаптер отвергается явно (получено ${String(
    badAdapter.stage
  )}/${String(badAdapter.reason)})`
);

/*
 * Ошибки P2-A переносятся без потерь: провайдер, бросающий исключение, и
 * арифметическое переполнение при конечном входе — реальные стадии P2-A;
 * тексты ошибок движка обязаны сохраниться в отказе P2-C дословно.
 */
const throwingProvider = rejectionOf({
  ...INPUT_BASE,
  variants: [
    {
      label: "throwing-provider",
      config: {},
      signalSourceId: "throwing-provider",
      signals: (() => {
        throw new Error("provider-boom");
      }) as unknown as SignalProvider
    }
  ]
});

ok(
  throwingProvider.variantStatus === "rejected" &&
    throwingProvider.stage === "provider" &&
    throwingProvider.reason === "provider-failure",
  "C1/C2: исключение провайдера → provider/provider-failure"
);
ok(
  throwingProvider.errors.some((item) => item.includes("provider-boom")),
  "C1/C2: текст ошибки P2-A (исключение провайдера) сохранён без потерь"
);

const arithmeticFailure = rejectionOf({
  ...INPUT_BASE,
  variants: [
    {
      label: "arithmetic-overflow",
      config: { quantity: 1e308 },
      signals: decisionList(true)
    }
  ]
});

ok(
  arithmeticFailure.stage === "arithmetic" &&
    arithmeticFailure.reason === "arithmetic-failure" &&
    String(arithmeticFailure.reason) !== "provider-failure",
  `C1/C2: переполнение при конечном входе → arithmetic/arithmetic-failure (получено ${String(
    arithmeticFailure.stage
  )}/${String(arithmeticFailure.reason)})`
);
ok(
  arithmeticFailure.errors.some((item) =>
    item.includes("арифметика потеряла конечность")
  ),
  "C1/C2: текст ошибки P2-A (арифметика) сохранён без потерь"
);

const badConfig = rejectionOf({
  ...INPUT_BASE,
  variants: [
    { label: "bad-config", config: { initialEquity: -5 }, signals: decisionList(true) }
  ]
});

ok(
  badConfig.stage === "config" && badConfig.reason === "invalid-config",
  `C1/C2: невалидный конфиг → config/invalid-config (получено ${String(
    badConfig.stage
  )}/${String(badConfig.reason)})`
);

const badBars = rejectionOf({
  ...INPUT_BASE,
  bars: BARS.map((bar) => ({ ...bar, high: bar.low - 1 }))
});

ok(
  badBars.experimentStage === "bars",
  "C1/C2: непригодные бары → experiment-level bars (стадия P2-A не потеряна)"
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
    Object.isFrozen(evaluatedVariant) &&
    Object.isFrozen(trainSegment) &&
    Object.isFrozen(trainReport) &&
    Object.isFrozen(trainEvidence) &&
    Object.isFrozen(trainEvidence.metrics) &&
    Object.isFrozen(RECORD.evidence) &&
    Object.isFrozen(RECORD.evidence.trainSelection),
  "C4: запись, варианты, сегменты, отчёт и свидетельства заморожены"
);
ok(
  ranking !== null &&
    Object.isFrozen(ranking) &&
    Object.isFrozen(ranking.order) &&
    (ranking.order.length === 0 || Object.isFrozen(ranking.order[0])) &&
    Object.isFrozen(ranking.excludedFromRanking),
  "C4: RankingRecord заморожен (включая order и excludedFromRanking)"
);
ok(
  Object.isFrozen(VIEW) &&
    Object.isFrozen(VIEW.rows) &&
    Object.isFrozen(VIEW.rows[0]) &&
    Object.isFrozen(VIEW.rows[0].train) &&
    Object.isFrozen(VIEW.limitations),
  "C4: ComparisonView/ComparisonRow заморожены"
);
ok(
  trainReport !== null && Object.isFrozen(trainReport.exitReasonCounts),
  "C4: вложенные структуры SegmentReport заморожены"
);

const fingerprintBefore = VIEW.reportFingerprint;
const canonicalBefore = VIEW.canonicalReport;
const labelBefore = evaluatedVariant.label;
let mutationThrew = false;

try {
  (evaluatedVariant as { label: string }).label = "HACKED";
} catch {
  mutationThrew = true;
}

try {
  if (trainReport !== null) {
    (trainReport as unknown as { netPnl: number }).netPnl = 1e9;
  }
} catch {
  mutationThrew = true;
}

try {
  if (trainEvidence.metrics !== null) {
    (trainEvidence.metrics as unknown as { netPnl: number }).netPnl = 1e9;
  }
} catch {
  mutationThrew = true;
}

ok(mutationThrew, "C4: попытка мутации замороженных выходов отвергнута (strict mode)");
ok(
  evaluatedVariant.label === labelBefore &&
    (trainReport === null || trainReport.netPnl !== 1e9) &&
    (trainEvidence.metrics === null || trainEvidence.metrics.netPnl !== 1e9),
  "C4: значения публичных выходов не изменились"
);
ok(
  buildComparison(RECORD).reportFingerprint === fingerprintBefore &&
    buildComparison(RECORD).canonicalReport === canonicalBefore,
  "C4: отпечаток и канонический отчёт после попыток мутации не изменились"
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
ok(
  assertLimitationsPresent(RECORD).ok,
  "C6: инвариант непустых ограничений проходит на записи"
);
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
}

/* ------------------------------------------------------------------ */
/* Контракт интеграции                                                 */
/* ------------------------------------------------------------------ */

ok(
  EXPERIMENT_CONTRACT_VERSION === "p2c-1.1.0",
  "контракт: версия p2c-1.1.0 (bump после изменения семантики)"
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
