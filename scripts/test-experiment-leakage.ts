/**
 * P2-C — adversarial-тесты: хронология, идентичность, утечки, изоляция
 * OOS и отсутствие cherry-picking.
 *
 * Запуск: npx tsx scripts/test-experiment-leakage.ts
 *
 * Здесь проверяется то, что должно ЛОМАТЬСЯ при попытке подмены:
 *  - нехронологичное/пересекающееся/неполное разбиение;
 *  - результат чужого сегмента (в том числе TRAIN, выданный за OOS);
 *  - результат чужой конфигурации, чужого рынка, чужого таймфрейма;
 *  - результат, собранный не P2-A, и грубо подделанные метрики;
 *  - утечка за границу сегмента и две открытые позиции одновременно;
 *  - выбор/ранжирование с опорой на OOS (флаги, стадия, подмена порядка);
 *  - потеря конфигураций из отчёта (cherry-picking).
 *
 * Отдельно доказывается, что КАУЗАЛЬНЫЙ разогрев (чтение баров до
 * границы сегмента) утечкой НЕ является, а отравление будущих баров не
 * меняет результаты прошлых сегментов.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKTEST_CONTRACT_VERSION,
  type BacktestBar,
  type BacktestResult,
  type BacktestTrade,
  type ChronologicalSplit,
  type SignalProvider,
  noTradeDecision,
  entryDecision
} from "../lib/backtest/contract";
import { canonicalJson, fingerprintResult } from "../lib/backtest/serialize";
import { poisonFutureBars } from "../lib/backtest/no-lookahead";
import {
  SPLIT_NAMES,
  assertNoSegmentLeakage,
  chronologicalSplit
} from "../lib/backtest/splits";
import {
  type ExperimentInput,
  type ExperimentRecord,
  type ExperimentSubjectInput,
  type VariantDefinition
} from "../lib/experiment/contract";
import {
  describeSubject,
  fingerprintSubject,
  resolveVariants
} from "../lib/experiment/identity";
import { buildComparison } from "../lib/experiment/report";
import { runExperiment } from "../lib/experiment/run";
import {
  assertNoCherryPicking,
  assertOosIsolation,
  assertResultSelfConsistency,
  assertSegmentIdentity,
  assertSplitChronological,
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

function decisionList(
  bars: readonly BacktestBar[],
  step: number,
  from = 4
) {
  const list: (ReturnType<typeof entryDecision> | null)[] = new Array(
    bars.length
  ).fill(null);

  for (let i = from, n = 0; i + 1 < bars.length; i += step, n += 1) {
    const close = bars[i].close;

    list[i] =
      n % 2 === 0
        ? entryDecision("LONG", close - 9, close + 7, `L${String(i)}`)
        : entryDecision("SHORT", close + 9, close - 7, `S${String(i)}`);
  }

  return list;
}

/** Провайдер, читающий только ПРОШЛЫЕ закрытые бары (каузальный). */
const causalProvider: SignalProvider = (context) => {
  if (context.index < 3) {
    return null;
  }

  const prev1 = context.barAt(context.index - 1);
  const prev2 = context.barAt(context.index - 2);

  if (context.bar.close > prev1.close && prev1.close > prev2.close) {
    const low3 = Math.min(context.bar.low, prev1.low, prev2.low);
    const risk = context.bar.close - low3;

    if (risk <= 0) {
      return noTradeDecision("CANNOT_EVALUATE", "risk<=0");
    }

    return entryDecision(
      "LONG",
      low3 - risk * 0.5,
      context.bar.close + risk * 1.5,
      "momentum-up"
    );
  }

  if (context.bar.close < prev1.close && prev1.close < prev2.close) {
    const high3 = Math.max(context.bar.high, prev1.high, prev2.high);
    const risk = high3 - context.bar.close;

    if (risk <= 0) {
      return noTradeDecision("CANNOT_EVALUATE", "risk<=0");
    }

    return entryDecision(
      "SHORT",
      high3 + risk * 0.5,
      context.bar.close - risk * 1.5,
      "momentum-down"
    );
  }

  return noTradeDecision("NEUTRAL", "no-momentum");
};

const BARS = zigzag(60);
const LIST = decisionList(BARS, 4);

const SUBJECT: ExperimentSubjectInput = {
  strategy: { slug: "suslik-smc", version: "1.4.0" },
  market: {
    asset: "BTCUSDT",
    exchange: "test-exchange",
    timeframe: "1h",
    timeframeMs: H1
  }
};

const VARIANTS: VariantDefinition[] = [
  {
    label: "list-timeout-3",
    params: { label: "list-timeout-3" },
    config: { timeoutBars: 3, warmupBars: 3 },
    signals: LIST
  },
  {
    label: "provider-momentum",
    params: { label: "provider-momentum" },
    config: { timeoutBars: 4, warmupBars: 3 },
    signals: causalProvider,
    signalSourceId: "momentum-provider@1.4.0"
  },
  {
    label: "list-timeout-1",
    params: { label: "list-timeout-1" },
    config: { timeoutBars: 1, warmupBars: 3 },
    signals: LIST
  }
];

function input(overrides?: Partial<ExperimentInput>): ExperimentInput {
  return {
    bars: BARS,
    subject: SUBJECT,
    variants: VARIANTS,
    selectionPolicy: {
      kind: "select-by-rank",
      stage: "TRAIN",
      criteria: ["netPnl"]
    },
    ...overrides
  };
}

function mustRun(value: ReturnType<typeof runExperiment>): ExperimentRecord {
  if (!value.ok) {
    console.error(`FAIL: эксперимент не выполнен (${value.stage})`, value.errors);
    process.exit(1);
  }

  return value.record;
}

const RECORD = mustRun(runExperiment(input()));
const SUBJECT_RECORD = RECORD.subject;
const SUBJECT_FINGERPRINT = RECORD.subjectFingerprint;
const SPLIT = RECORD.split;

const VARIANT_A = RECORD.variants[0];
const VARIANT_B = RECORD.variants[1];

function resultOf(
  variantIndex: number,
  segment: "TRAIN" | "VALIDATION" | "OOS"
): BacktestResult {
  const result = RECORD.variants[variantIndex].segments?.[segment].result ?? null;

  if (result === null) {
    console.error(`FAIL: нет результата варианта ${String(variantIndex)}/${segment}`);
    process.exit(1);
  }

  return result;
}

/** Подделка результата: замена полей без изменения остальных. */
function tamperMetadata(
  result: BacktestResult,
  patch: Partial<BacktestResult["metadata"]>
): BacktestResult {
  return { ...result, metadata: { ...result.metadata, ...patch } };
}

function tamperMetrics(
  result: BacktestResult,
  patch: Partial<BacktestResult["metrics"]>
): BacktestResult {
  return { ...result, metrics: { ...result.metrics, ...patch } };
}

function tamperTrades(
  result: BacktestResult,
  index: number,
  patch: Partial<BacktestTrade>
): BacktestResult {
  const trades = [...result.trades];

  trades[index] = { ...trades[index], ...patch };

  return { ...result, trades };
}

/* ------------------------------------------------------------------ */
/* 1. Хронологичность и непересечение разбиения                        */
/* ------------------------------------------------------------------ */

ok(
  assertSplitChronological(SPLIT, BARS.length).ok,
  "хронология: реальное P2-A разбиение проходит проверку"
);
ok(
  assertSplitChronological(SPLIT, BARS.length).errors.length === 0,
  "хронология: ошибок нет"
);
ok(
  SPLIT.train.endIndexExclusive === SPLIT.validation.startIndex &&
    SPLIT.validation.endIndexExclusive === SPLIT.oos.startIndex,
  "хронология: TRAIN → VALIDATION → OOS стыкуются вплотную"
);
ok(
  SPLIT.train.startIndex < SPLIT.train.endIndexExclusive &&
    SPLIT.validation.startIndex < SPLIT.validation.endIndexExclusive &&
    SPLIT.oos.startIndex < SPLIT.oos.endIndexExclusive,
  "хронология: каждый сегмент непустой"
);
ok(
  SPLIT.oos.endIndexExclusive === BARS.length,
  "хронология: OOS заканчивается на последнем баре (покрытие полное)"
);

function brokenSplit(patch: {
  train?: Partial<ChronologicalSplit["train"]>;
  validation?: Partial<ChronologicalSplit["validation"]>;
  oos?: Partial<ChronologicalSplit["oos"]>;
  warmupStart?: Partial<ChronologicalSplit["warmupStart"]>;
  barsCount?: number;
}): ChronologicalSplit {
  return {
    barsCount: patch.barsCount ?? SPLIT.barsCount,
    train: { ...SPLIT.train, ...patch.train },
    validation: { ...SPLIT.validation, ...patch.validation },
    oos: { ...SPLIT.oos, ...patch.oos },
    warmupStart: { ...SPLIT.warmupStart, ...patch.warmupStart }
  };
}

const overlapping = brokenSplit({ validation: { startIndex: 30 } });
const overlappingCheck = assertSplitChronological(overlapping, BARS.length);

ok(overlappingCheck.ok === false, "хронология: пересечение TRAIN/VALIDATION обнаружено");
ok(
  overlappingCheck.errors.some((error) => error.includes("перекрываются")),
  "хронология: ошибка пересечения названа явно"
);

const oosOverlap = brokenSplit({ oos: { startIndex: 45 } });

ok(
  assertSplitChronological(oosOverlap, BARS.length).ok === false,
  "хронология: пересечение VALIDATION/OOS обнаружено"
);
ok(
  assertSplitChronological(oosOverlap, BARS.length).errors.some((error) =>
    error.includes("перекрываются")
  ),
  "хронология: пересечение VALIDATION/OOS названо явно"
);

const gapped = brokenSplit({ validation: { startIndex: 38 } });

ok(
  assertSplitChronological(gapped, BARS.length).ok === false,
  "хронология: дыра между TRAIN и VALIDATION обнаружена"
);
ok(
  assertSplitChronological(gapped, BARS.length).errors.some((error) =>
    error.includes("дыра или пересечение")
  ),
  "хронология: причина — дыра или пересечение"
);

ok(
  assertSplitChronological(brokenSplit({ train: { startIndex: 2 } }), BARS.length)
    .ok === false,
  "хронология: TRAIN не с нуля обнаружен"
);
ok(
  assertSplitChronological(brokenSplit({ oos: { endIndexExclusive: 55 } }), BARS.length)
    .ok === false,
  "хронология: неполное покрытие (OOS.end < barsCount) обнаружено"
);
ok(
  assertSplitChronological(
    brokenSplit({ validation: { endIndexExclusive: 36 } }),
    BARS.length
  ).ok === false,
  "хронология: пустой VALIDATION обнаружен"
);
ok(
  assertSplitChronological(brokenSplit({ barsCount: 61 }), BARS.length).ok === false,
  "хронология: несовпадение barsCount обнаружено"
);
ok(
  assertSplitChronological(
    brokenSplit({ warmupStart: { VALIDATION: 40 } }),
    BARS.length
  ).ok === false,
  "хронология: warmup, смотрящий в будущее сегмента, обнаружен"
);
ok(
  assertSplitChronological(
    brokenSplit({ warmupStart: { TRAIN: -1 } }),
    BARS.length
  ).ok === false,
  "хронология: отрицательный warmupStart обнаружен"
);
ok(
  assertSplitChronological(
    brokenSplit({ train: { startIndex: -3 } }),
    BARS.length
  ).ok === false,
  "хронология: выход за границы набора баров обнаружен"
);
ok(
  assertSplitChronological(SPLIT, 59).ok === false,
  "хронология: разбиение сверяется с фактическим числом баров"
);

/* ------------------------------------------------------------------ */
/* 2. Каузальный warmup — НЕ утечка                                    */
/* ------------------------------------------------------------------ */

const validationResult = resultOf(0, "VALIDATION");

ok(
  validationResult.metadata.warmupStartIndex === 33 &&
    SPLIT.validation.startIndex === 36,
  "warmup: VALIDATION читает бары с 33 при начале сегмента 36"
);
ok(
  (validationResult.metadata.warmupStartIndex ?? 0) <
    SPLIT.validation.startIndex,
  "warmup: разогрев смотрит строго в прошлое"
);
ok(
  assertNoSegmentLeakage(validationResult, SPLIT.validation).ok,
  "warmup: P2-A инвариант утечки не считает каузальный разогрев нарушением"
);
ok(
  assertSegmentIdentity({
    result: validationResult,
    segment: "VALIDATION",
    window: SPLIT.validation,
    subject: SUBJECT_RECORD,
    variant: {
      inputOrder: 0,
      label: VARIANT_A.label,
      params: VARIANT_A.params,
      config: resultOf(0, "VALIDATION").config,
      configFingerprint: VARIANT_A.configFingerprint,
      paramsFingerprint: VARIANT_A.paramsFingerprint,
      signalSource: VARIANT_A.signalSource ?? { kind: "list", length: 0, fingerprint: "" },
      configurationId: VARIANT_A.configurationId,
      selectionKey: VARIANT_A.selectionKey
    }
  }).ok,
  "warmup: идентичность сегмента с разогревом подтверждается"
);
ok(
  SPLIT.warmupStart.OOS <= SPLIT.oos.startIndex &&
    resultOf(0, "OOS").metadata.warmupStartIndex === SPLIT.warmupStart.OOS,
  "warmup: warmupStart OOS совпадает с записью разбиения"
);

/* Отравление будущих баров не меняет прошлые сегменты. */
const poisonedFromTrainEnd = poisonFutureBars(BARS, SPLIT.train.endIndexExclusive);
const poisonedRecord = mustRun(runExperiment(input({ bars: poisonedFromTrainEnd })));

ok(
  poisonedFromTrainEnd.length === BARS.length &&
    poisonedFromTrainEnd[0].close === BARS[0].close &&
    poisonedFromTrainEnd[SPLIT.train.endIndexExclusive].close !==
      BARS[SPLIT.train.endIndexExclusive].close,
  "no-lookahead: отравлены только бары от границы TRAIN"
);
ok(
  canonicalJson(
    poisonedRecord.variants.map((item) => item.segments?.TRAIN.result?.trades ?? null)
  ) ===
    canonicalJson(
      RECORD.variants.map((item) => item.segments?.TRAIN.result?.trades ?? null)
    ),
  "no-lookahead: сделки TRAIN не изменились после отравления будущего"
);
ok(
  canonicalJson(
    poisonedRecord.variants.map((item) => item.segments?.TRAIN.result?.metrics ?? null)
  ) ===
    canonicalJson(
      RECORD.variants.map((item) => item.segments?.TRAIN.result?.metrics ?? null)
    ),
  "no-lookahead: метрики TRAIN не изменились после отравления будущего"
);
ok(
  canonicalJson(
    poisonedRecord.variants.map((item) => item.segments?.TRAIN.result?.equityCurve ?? null)
  ) ===
    canonicalJson(
      RECORD.variants.map((item) => item.segments?.TRAIN.result?.equityCurve ?? null)
    ),
  "no-lookahead: кривая капитала TRAIN не изменилась"
);
ok(
  canonicalJson(
    poisonedRecord.variants.map((item) => item.segments?.OOS.result?.metrics ?? null)
  ) !==
    canonicalJson(
      RECORD.variants.map((item) => item.segments?.OOS.result?.metrics ?? null)
    ),
  "no-lookahead: метрики OOS изменились — отравление действительно применено"
);
ok(
  poisonedRecord.variants[1].signalSource?.kind === "provider",
  "no-lookahead: провайдерная конфигурация участвует в проверке"
);
ok(
  canonicalJson(
    poisonedRecord.variants[1].segments?.TRAIN.result?.trades ?? null
  ) === canonicalJson(RECORD.variants[1].segments?.TRAIN.result?.trades ?? null),
  "no-lookahead: решения каузального провайдера в TRAIN не изменились"
);
ok(
  poisonedRecord.counts.evaluated === RECORD.counts.evaluated,
  "no-lookahead: отравление будущего не ломает прогон (все конфигурации оценены)"
);
ok(
  poisonedRecord.selection.selectedLabel !== null,
  "no-lookahead: выбор после отравления будущего выполнен"
);

/* ------------------------------------------------------------------ */
/* 3. Идентичность сегментного результата                              */
/* ------------------------------------------------------------------ */

const resolvedVariants = resolveVariants(VARIANTS, SUBJECT_FINGERPRINT);
const resolvedA = resolvedVariants[0].resolved;
const resolvedB = resolvedVariants[1].resolved;

ok(resolvedA !== null && resolvedB !== null, "идентичность: варианты разрешены");

if (resolvedA !== null && resolvedB !== null) {
  const expected = {
    subject: SUBJECT_RECORD,
    subjectFingerprint: SUBJECT_FINGERPRINT,
    split: SPLIT,
    variant: resolvedA
  };
  const genuine = {
    configurationId: resolvedA.configurationId,
    subjectFingerprint: SUBJECT_FINGERPRINT,
    segment: "TRAIN" as const,
    window: windowOf(SPLIT, "TRAIN"),
    result: resultOf(0, "TRAIN")
  };

  ok(
    validateSubmittedSegmentResult(genuine, expected).ok,
    "принятие: подлинный результат принимается без ошибок"
  );
  ok(
    validateSubmittedSegmentResult(genuine, expected).errors.length === 0,
    "принятие: у подлинного результата нет замечаний"
  );

  /* --- подмена сегмента: TRAIN выдаётся за OOS --- */

  const swappedOos = validateSubmittedSegmentResult(
    { ...genuine, segment: "OOS", window: windowOf(SPLIT, "OOS") },
    { ...expected, variant: resolvedA }
  );

  ok(swappedOos.ok === false, "подмена: TRAIN-результат, выданный за OOS, отвергнут");
  ok(
    swappedOos.errors.some(
      (error) => error.includes("metadata.segment=TRAIN") && error.includes("OOS")
    ),
    "подмена: ошибка называет фактический и ожидаемый сегменты"
  );
  ok(
    swappedOos.errors.some((error) => error.includes("чужого сегмента")),
    "подмена: причина сформулирована как результат чужого сегмента"
  );
  ok(
    validateSubmittedSegmentResult(
      {
        ...genuine,
        segment: "VALIDATION",
        window: windowOf(SPLIT, "VALIDATION"),
        result: resultOf(0, "OOS")
      },
      expected
    ).ok === false,
    "подмена: OOS-результат, выданный за VALIDATION, отвергнут"
  );
  ok(
    validateSubmittedSegmentResult(
      {
        ...genuine,
        segment: "TRAIN",
        window: windowOf(SPLIT, "TRAIN"),
        result: resultOf(0, "VALIDATION")
      },
      expected
    ).ok === false,
    "подмена: VALIDATION-результат, выданный за TRAIN, отвергнут"
  );

  /* --- подмена конфигурации --- */

  const swappedConfig = validateSubmittedSegmentResult(genuine, {
    ...expected,
    variant: resolvedB
  });

  ok(swappedConfig.ok === false, "подмена: результат чужой конфигурации отвергнут");
  ok(
    swappedConfig.errors.some((error) => error.includes("configurationId")),
    "подмена: названо несовпадение configurationId"
  );
  ok(
    swappedConfig.errors.some((error) =>
      error.includes("отпечаток конфига P2-A не совпадает")
    ),
    "подмена: названо несовпадение отпечатка конфига P2-A"
  );
  ok(
    validateSubmittedSegmentResult(
      { ...genuine, configurationId: resolvedB.configurationId },
      expected
    ).errors.some((error) => error.includes("приписан чужой конфигурации")),
    "подмена: результат, приписанный чужой конфигурации, обнаружен"
  );

  /* --- подмена рынка / данных / таймфрейма --- */

  const otherBars = zigzag(60).map((bar, index) =>
    index === 5 ? { ...bar, close: bar.close + 1 } : bar
  );
  const otherSubject = describeSubject(
    { ...SUBJECT, market: { ...SUBJECT.market, asset: "ETHUSDT" } },
    otherBars
  );
  const otherRun = mustRun(
    runExperiment(input({ bars: otherBars, subject: { ...SUBJECT, market: { ...SUBJECT.market, asset: "ETHUSDT" } } }))
  );
  const foreignResult = otherRun.variants[0].segments?.TRAIN.result ?? null;

  ok(foreignResult !== null, "подмена: результат на других данных получен");

  if (foreignResult !== null) {
    const foreign = validateSubmittedSegmentResult(
      { ...genuine, result: foreignResult },
      expected
    );

    ok(foreign.ok === false, "подмена: результат другого рынка/данных отвергнут");
    ok(
      foreign.errors.some((error) => error.includes("barsFingerprint")),
      "подмена: названо несовпадение отпечатка баров"
    );
  }

  const timeframeSwap = validateSubmittedSegmentResult(
    {
      ...genuine,
      result: tamperMetadata(resultOf(0, "TRAIN"), { timeframeMs: 900_000 })
    },
    expected
  );

  ok(timeframeSwap.ok === false, "подмена: другой таймфрейм в метаданных отвергнут");
  ok(
    timeframeSwap.errors.some((error) => error.includes("timeframeMs")),
    "подмена: названо несовпадение таймфрейма"
  );
  ok(
    validateSubmittedSegmentResult(
      {
        ...genuine,
        result: tamperMetadata(resultOf(0, "TRAIN"), { timeframeMs: null })
      },
      expected
    ).errors.some((error) => error.includes("неравномерна")),
    "подмена: заявленный таймфрейм при неравномерной сетке отвергнут"
  );

  const subjectSwap = validateSubmittedSegmentResult(
    {
      ...genuine,
      subjectFingerprint: fingerprintSubject(otherSubject)
    },
    expected
  );

  ok(subjectSwap.ok === false, "подмена: другой субъект отвергнут");
  ok(
    subjectSwap.errors.some((error) => error.includes("subjectFingerprint")),
    "подмена: названо несовпадение отпечатка субъекта"
  );

  /* --- подмена окна и версии контракта --- */

  ok(
    validateSubmittedSegmentResult(
      { ...genuine, window: { name: "TRAIN", startIndex: 0, endIndexExclusive: 30 } },
      expected
    ).ok === false,
    "подмена: окно, не совпадающее с разбиением, отвергнуто"
  );
  ok(
    validateSubmittedSegmentResult(
      {
        ...genuine,
        result: tamperMetadata(resultOf(0, "TRAIN"), {
          segmentStartIndex: 1,
          segmentEndIndexExclusive: 37
        })
      },
      expected
    ).ok === false,
    "подмена: границы сегмента в метаданных сверяются с окном"
  );
  ok(
    validateSubmittedSegmentResult(
      {
        ...genuine,
        result: tamperMetadata(resultOf(0, "TRAIN"), {
          contractVersion: "p2a-0.0.1-fake"
        })
      },
      expected
    ).errors.some((error) => error.includes("contractVersion")),
    "подмена: результат не текущей версии P2-A отвергнут"
  );
  ok(
    BACKTEST_CONTRACT_VERSION === resultOf(0, "TRAIN").metadata.contractVersion,
    "подмена: подлинный результат несёт текущую версию контракта P2-A"
  );
  ok(
    validateSubmittedSegmentResult(
      {
        ...genuine,
        result: tamperMetadata(resultOf(0, "TRAIN"), {
          firstBarTime: T0 - 10 * H1
        })
      },
      expected
    ).errors.some((error) => error.includes("раньше начала")),
    "подмена: бары раньше заявленного диапазона отвергнуты"
  );
  ok(
    validateSubmittedSegmentResult(
      {
        ...genuine,
        result: tamperMetadata(resultOf(0, "TRAIN"), {
          lastBarTime: T0 + 1000 * H1
        })
      },
      expected
    ).errors.some((error) => error.includes("позже конца")),
    "подмена: бары позже заявленного диапазона отвергнуты"
  );
  ok(
    validateSubmittedSegmentResult(
      { ...genuine, segment: "FINAL" as never, window: windowOf(SPLIT, "TRAIN") },
      expected
    ).ok === false,
    "подмена: неизвестное имя сегмента отвергнуто"
  );
}

/* ------------------------------------------------------------------ */
/* 4. Внутренняя согласованность и подделка метрик                     */
/* ------------------------------------------------------------------ */

ok(
  assertResultSelfConsistency(resultOf(0, "TRAIN")).ok,
  "согласованность: подлинный результат внутренне согласован"
);
ok(
  RECORD.variants.every((item) =>
    SPLIT_NAMES.every((segment) => {
      const result = item.segments?.[segment].result ?? null;

      return result === null || assertResultSelfConsistency(result).ok;
    })
  ),
  "согласованность: все результаты всех сегментов согласованы"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(resultOf(0, "TRAIN"), { trades: 999 })
  ).ok === false,
  "согласованность: завышенное число сделок обнаружено"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(resultOf(0, "TRAIN"), {
      totalNetPnl: resultOf(0, "TRAIN").metrics.totalNetPnl + 1000
    })
  ).errors.some((error) => error.includes("finalEquity")),
  "согласованность: подделка netPnl ломает равенство finalEquity"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(resultOf(0, "TRAIN"), {
      exitReasonCounts: {
        STOP_LOSS: 0,
        TAKE_PROFIT: 0,
        TIMEOUT: 0,
        END_OF_DATA: 0,
        SEGMENT_END: 0
      }
    })
  ).ok === false,
  "согласованность: обнулённые причины выхода обнаружены"
);
ok(
  assertResultSelfConsistency(
    tamperMetrics(resultOf(0, "TRAIN"), { wins: 0, losses: 0, breakeven: 0 })
  ).ok === false,
  "согласованность: обнулённые wins/losses/breakeven обнаружены"
);
ok(
  assertResultSelfConsistency({
    ...resultOf(0, "TRAIN"),
    equityCurve: resultOf(0, "TRAIN").equityCurve.slice(0, 1)
  }).ok === false,
  "согласованность: усечённая кривая капитала обнаружена"
);
ok(
  assertResultSelfConsistency({
    ...resultOf(0, "TRAIN"),
    input: {
      ...resultOf(0, "TRAIN").input,
      decisionCounts: {
        LONG: 0,
        SHORT: 0,
        NEUTRAL: 0,
        CANNOT_EVALUATE: 0,
        NO_SIGNAL: 0
      }
    }
  }).ok === false,
  "согласованность: обнулённые счётчики решений обнаружены"
);

const overlappingTrades = tamperTrades(resultOf(0, "TRAIN"), 1, {
  signalIndex: resultOf(0, "TRAIN").trades[0].signalIndex,
  entryIndex: resultOf(0, "TRAIN").trades[0].signalIndex + 1
});

ok(
  assertResultSelfConsistency(overlappingTrades).ok === false,
  "согласованность: две одновременно открытые позиции обнаружены"
);
ok(
  assertNoSegmentLeakage(overlappingTrades, SPLIT.train).ok === false,
  "утечка: перекрытие позиций ловится P2-A инвариантом"
);
ok(
  assertNoSegmentLeakage(overlappingTrades, SPLIT.train).errors.some((error) =>
    error.includes("перекрытие позиций")
  ),
  "утечка: причина перекрытия названа явно"
);

/* ------------------------------------------------------------------ */
/* 5. Утечка за границы сегмента                                       */
/* ------------------------------------------------------------------ */

const exitBeyond = tamperTrades(resultOf(0, "TRAIN"), 0, {
  exitIndex: SPLIT.train.endIndexExclusive + 2,
  exitTime: BARS[Math.min(BARS.length - 1, SPLIT.train.endIndexExclusive + 2)].time
});

ok(
  assertNoSegmentLeakage(exitBeyond, SPLIT.train).ok === false,
  "утечка: выход за границей сегмента обнаружен"
);
ok(
  assertNoSegmentLeakage(exitBeyond, SPLIT.train).errors.some((error) =>
    error.includes("вне окна")
  ),
  "утечка: ошибка указывает на выход за окно"
);

const signalOutside = tamperTrades(resultOf(0, "VALIDATION"), 0, {
  signalIndex: SPLIT.train.startIndex + 1,
  entryIndex: SPLIT.train.startIndex + 2
});

ok(
  assertNoSegmentLeakage(signalOutside, SPLIT.validation).ok === false,
  "утечка: сигнал из чужого сегмента обнаружен"
);

const entryAtPreviousExit = tamperTrades(resultOf(0, "TRAIN"), 1, {
  entryIndex: resultOf(0, "TRAIN").trades[0].exitIndex
});

ok(
  assertNoSegmentLeakage(entryAtPreviousExit, SPLIT.train).ok === false,
  "утечка: вход на баре выхода предыдущей сделки обнаружен"
);

const legalReentry = resultOf(0, "TRAIN");

ok(
  assertNoSegmentLeakage(legalReentry, SPLIT.train).ok,
  "утечка: легальный перезаход на следующем баре НЕ считается нарушением"
);
ok(
  RECORD.variants.every((item) =>
    SPLIT_NAMES.every((segment) => item.segments?.[segment].leakageOk === true)
  ),
  "утечка: все сегменты всех конфигураций прошли инвариант P2-A"
);
ok(
  RECORD.variants.every((item) =>
    SPLIT_NAMES.every(
      (segment) => (item.segments?.[segment].leakageErrors.length ?? 0) === 0
    )
  ),
  "утечка: списки ошибок утечки пусты"
);

/* --- отравление сигнала вне сегмента: skipped/rejected индексы --- */

const outsideIndex = SPLIT.oos.startIndex + 1;
const skippedOutside: BacktestResult = {
  ...resultOf(0, "TRAIN"),
  skippedSignals: [
    ...resultOf(0, "TRAIN").skippedSignals,
    {
      index: outsideIndex,
      time: BARS[outsideIndex].time,
      kind: "LONG",
      reason: "position-open"
    }
  ]
};

ok(
  assertNoSegmentLeakage(skippedOutside, SPLIT.train).ok === false,
  "утечка: запись о пропуске за пределами сегмента обнаружена"
);

/* ------------------------------------------------------------------ */
/* 6. Изоляция OOS в записи эксперимента                              */
/* ------------------------------------------------------------------ */

ok(assertOosIsolation(RECORD).ok, "OOS-изоляция: подлинная запись проходит проверку");
ok(
  assertOosIsolation(RECORD).errors.length === 0,
  "OOS-изоляция: ошибок нет"
);
ok(
  RECORD.oosIsolation.oosConsultedForSelection === false &&
    RECORD.oosIsolation.oosConsultedForRanking === false,
  "OOS-изоляция: флаги в записи константно false"
);
ok(
  RECORD.selection.ranking !== null && RECORD.selection.ranking.stage === "TRAIN",
  "OOS-изоляция: ранжирование выполнено на TRAIN"
);
ok(
  RECORD.oosIsolation.rankingIndependenceVerified === true,
  "OOS-изоляция: независимость ранжирования перепроверена при прогоне"
);
ok(
  RECORD.selection.ranking !== null &&
    RECORD.selection.ranking.order.every(
      (entry) =>
        RECORD.evidence.trainSelection.some(
          (evidence) =>
            evidence.configurationId === entry.configurationId &&
            evidence.metrics?.netPnl === entry.values.netPnl
        )
    ),
  "OOS-изоляция: значения ранжирования взяты из TRAIN-свидетельств"
);
ok(
  RECORD.selection.ranking !== null &&
    RECORD.selection.ranking.order.every(
      (entry) =>
        RECORD.evidence.oosFinal.every(
          (evidence) =>
            evidence.configurationId !== entry.configurationId ||
            evidence.metrics === null ||
            evidence.metrics.netPnl !== entry.values.netPnl ||
            entry.values.netPnl ===
              RECORD.evidence.trainSelection.find(
                (item) => item.configurationId === entry.configurationId
              )?.metrics?.netPnl
        )
    ),
  "OOS-изоляция: значения ранжирования — не OOS-числа"
);

const ranking = RECORD.selection.ranking;

if (ranking !== null) {
  const flagTampered: ExperimentRecord = {
    ...RECORD,
    oosIsolation: { ...RECORD.oosIsolation, oosConsultedForSelection: true as false }
  };

  ok(
    assertOosIsolation(flagTampered).ok === false,
    "OOS-изоляция: флаг oosConsultedForSelection=true обнаружен"
  );

  const rankingFlagTampered: ExperimentRecord = {
    ...RECORD,
    oosIsolation: { ...RECORD.oosIsolation, oosConsultedForRanking: true as false }
  };

  ok(
    assertOosIsolation(rankingFlagTampered).ok === false,
    "OOS-изоляция: флаг oosConsultedForRanking=true обнаружен"
  );

  const selectionFlagTampered: ExperimentRecord = {
    ...RECORD,
    selection: { ...RECORD.selection, oosConsulted: true as false }
  };

  ok(
    assertOosIsolation(selectionFlagTampered).ok === false,
    "OOS-изоляция: selection.oosConsulted=true обнаружен"
  );

  const stageTampered: ExperimentRecord = {
    ...RECORD,
    selection: {
      ...RECORD.selection,
      ranking: { ...ranking, stage: "OOS" as never }
    }
  };

  ok(
    assertOosIsolation(stageTampered).ok === false,
    "OOS-изоляция: ranking.stage=OOS обнаружен"
  );

  const orderTampered: ExperimentRecord = {
    ...RECORD,
    selection: {
      ...RECORD.selection,
      ranking: { ...ranking, order: [...ranking.order].reverse() }
    }
  };
  const orderCheck = assertOosIsolation(orderTampered);

  ok(
    orderCheck.ok === false,
    "OOS-изоляция: подменённый порядок ранжирования обнаружен"
  );
  ok(
    orderCheck.errors.some((error) =>
      error.toLowerCase().includes("не воспроизводится")
    ),
    "OOS-изоляция: причина — порядок не воспроизводится из TRAIN"
  );

  const valuesTampered: ExperimentRecord = {
    ...RECORD,
    selection: {
      ...RECORD.selection,
      ranking: {
        ...ranking,
        order: ranking.order.map((entry, index) =>
          index === 0
            ? {
                ...entry,
                values: { ...entry.values, netPnl: (entry.values.netPnl ?? 0) + 100 }
              }
            : entry
        )
      }
    }
  };

  ok(
    assertOosIsolation(valuesTampered).ok === false,
    "OOS-изоляция: подделанные значения критерия обнаружены"
  );

  const excludedTampered: ExperimentRecord = {
    ...RECORD,
    selection: {
      ...RECORD.selection,
      ranking: { ...ranking, excludedFromRanking: [] }
    }
  };

  ok(
    assertOosIsolation(excludedTampered).ok === false ||
      ranking.excludedFromRanking.length === 0,
    "OOS-изоляция: подмена списка исключений обнаружена (или исключений не было)"
  );

  const oosEvidenceLeak: ExperimentRecord = {
    ...RECORD,
    evidence: {
      ...RECORD.evidence,
      trainSelection: RECORD.evidence.oosFinal
    }
  };

  ok(
    assertOosIsolation(oosEvidenceLeak).ok === false,
    "OOS-изоляция: подстановка OOS-свидетельств вместо TRAIN обнаружена"
  );
}

const noRankingFlag: ExperimentRecord = {
  ...RECORD,
  selection: { ...RECORD.selection, ranking: null },
  oosIsolation: { ...RECORD.oosIsolation, rankingIndependenceVerified: true }
};

ok(
  assertOosIsolation(noRankingFlag).ok === false,
  "OOS-изоляция: rankingIndependenceVerified без ранжирования обнаружен"
);

const ghostSelection: ExperimentRecord = {
  ...RECORD,
  selection: {
    ...RECORD.selection,
    selectedConfigurationId: "ghost-configuration-id"
  }
};

ok(
  assertOosIsolation(ghostSelection).ok === false,
  "OOS-изоляция: выбор несуществующей конфигурации обнаружен"
);

const oosPolicyRecord: ExperimentRecord = {
  ...RECORD,
  selection: {
    ...RECORD.selection,
    policy: {
      kind: "select-by-rank",
      stage: "OOS" as never,
      criteria: ["netPnl"]
    }
  }
};

ok(
  assertOosIsolation(oosPolicyRecord).ok === false,
  "OOS-изоляция: политика со stage=OOS обнаружена в записи"
);

/* ------------------------------------------------------------------ */
/* 7. Отсутствие cherry-picking                                        */
/* ------------------------------------------------------------------ */

const declaredIds = RECORD.variants.map((item) => item.configurationId);

ok(
  assertNoCherryPicking(RECORD, declaredIds).ok,
  "cherry-picking: подлинная запись проходит проверку"
);
ok(
  assertNoCherryPicking(RECORD, declaredIds).errors.length === 0,
  "cherry-picking: ошибок нет"
);
ok(
  RECORD.counts.declared === 3 &&
    RECORD.counts.evaluated === 3 &&
    RECORD.counts.rejected === 0,
  "cherry-picking: счётчики сходятся (3 = 3 + 0)"
);

const dropped: ExperimentRecord = {
  ...RECORD,
  variants: RECORD.variants.slice(0, 2),
  counts: { ...RECORD.counts, declared: 2, evaluated: 2 }
};

ok(
  assertNoCherryPicking(dropped, declaredIds).ok === false,
  "cherry-picking: удалённая из отчёта конфигурация обнаружена"
);
ok(
  assertNoCherryPicking(dropped, declaredIds).errors.some((error) =>
    error.includes("отсутствует в отчёте")
  ),
  "cherry-picking: ошибка называет потерю конфигурации"
);

const bestOnly: ExperimentRecord = {
  ...RECORD,
  variants: [
    RECORD.variants.reduce((best, item) =>
      (item.segments?.TRAIN.report?.netPnl ?? Number.NEGATIVE_INFINITY) >
      (best.segments?.TRAIN.report?.netPnl ?? Number.NEGATIVE_INFINITY)
        ? item
        : best
    )
  ],
  counts: { declared: 1, evaluated: 1, rejected: 0 },
  evidence: {
    trainSelection: RECORD.evidence.trainSelection.slice(0, 1),
    validationConfirmation: RECORD.evidence.validationConfirmation.slice(0, 1),
    oosFinal: RECORD.evidence.oosFinal.slice(0, 1)
  }
};

ok(
  assertNoCherryPicking(bestOnly, declaredIds).ok === false,
  "cherry-picking: отчёт «только лучший» отвергнут"
);
ok(
  buildComparison(bestOnly).rows.length === 1,
  "cherry-picking: отчёт «только лучший» действительно теряет конфигурации (демонстрация)"
);

const countsLie: ExperimentRecord = {
  ...RECORD,
  counts: { declared: 5, evaluated: 3, rejected: 0 }
};

ok(
  assertNoCherryPicking(countsLie, declaredIds).ok === false,
  "cherry-picking: завышенный counts.declared обнаружен"
);
ok(
  assertNoCherryPicking(
    { ...RECORD, counts: { declared: 3, evaluated: 2, rejected: 0 } },
    declaredIds
  ).ok === false,
  "cherry-picking: declared ≠ evaluated + rejected обнаружено"
);

const evidenceTrimmed: ExperimentRecord = {
  ...RECORD,
  evidence: {
    ...RECORD.evidence,
    oosFinal: RECORD.evidence.oosFinal.slice(0, 1)
  }
};

ok(
  assertNoCherryPicking(evidenceTrimmed, declaredIds).ok === false,
  "cherry-picking: усечённый блок свидетельств обнаружен"
);
ok(
  assertNoCherryPicking(evidenceTrimmed, declaredIds).errors.some((error) =>
    error.includes("evidence.oosFinal")
  ),
  "cherry-picking: ошибка называет усечённый блок"
);

const rejectedWithoutReason: ExperimentRecord = {
  ...RECORD,
  variants: RECORD.variants.map((item, index) =>
    index === 0 ? { ...item, status: "rejected" as const, rejection: null } : item
  )
};

ok(
  assertNoCherryPicking(rejectedWithoutReason, declaredIds).ok === false,
  "cherry-picking: статус rejected без причины обнаружен"
);

const evaluatedWithoutSegments: ExperimentRecord = {
  ...RECORD,
  variants: RECORD.variants.map((item, index) =>
    index === 0 ? { ...item, segments: null } : item
  )
};

ok(
  assertNoCherryPicking(evaluatedWithoutSegments, declaredIds).ok === false,
  "cherry-picking: статус evaluated без сегментных результатов обнаружен"
);

const brokenOrder: ExperimentRecord = {
  ...RECORD,
  variants: RECORD.variants.map((item, index) => ({
    ...item,
    presentationOrder: index === 0 ? 5 : index
  }))
};

ok(
  assertNoCherryPicking(brokenOrder, declaredIds).ok === false,
  "cherry-picking: непоследовательный presentationOrder обнаружен"
);
ok(
  assertNoCherryPicking(
    {
      ...RECORD,
      variants: RECORD.variants.map((item) => ({ ...item, presentationOrder: 0 }))
    },
    declaredIds
  ).ok === false,
  "cherry-picking: неуникальный presentationOrder обнаружен"
);

/* --- отклонённые конфигурации остаются в отчёте --- */

const withRejectedRecord = mustRun(
  runExperiment(
    input({
      variants: [
        VARIANTS[0],
        { label: "bad-config", params: {}, config: { timeoutBars: 0 }, signals: LIST },
        { label: "no-source", params: {}, config: { timeoutBars: 2 }, signals: () => null },
        VARIANTS[1],
        VARIANTS[0]
      ]
    })
  )
);
const withRejectedView = buildComparison(withRejectedRecord);

ok(
  withRejectedRecord.counts.declared === 5 &&
    withRejectedRecord.counts.evaluated === 2 &&
    withRejectedRecord.counts.rejected === 3,
  "cherry-picking: 5 объявлено → 2 оценено + 3 отклонено"
);
ok(
  withRejectedRecord.variants.length === 5 && withRejectedView.rows.length === 5,
  "cherry-picking: 5 объявлено → 5 записей и 5 строк отчёта"
);
ok(
  withRejectedRecord.evidence.trainSelection.length === 5 &&
    withRejectedRecord.evidence.validationConfirmation.length === 5 &&
    withRejectedRecord.evidence.oosFinal.length === 5,
  "cherry-picking: свидетельства содержат все 5 конфигураций"
);
ok(
  withRejectedView.rows
    .filter((row) => row.status === "rejected")
    .map((row) => row.rejectionReason)
    .sort()
    .join(",") === "duplicate-configuration-id,invalid-config,missing-signal-source-id",
  "cherry-picking: причины отклонения различимы и сохранены"
);
ok(
  assertNoCherryPicking(
    withRejectedRecord,
    withRejectedRecord.variants.map((item) => item.configurationId)
  ).ok,
  "cherry-picking: запись с отклонёнными проходит проверку инварианта"
);
ok(
  assertOosIsolation(withRejectedRecord).ok,
  "cherry-picking: запись с отклонёнными проходит проверку изоляции OOS"
);
ok(
  withRejectedRecord.selection.ranking?.order.length === 2,
  "cherry-picking: в ранжировании только оценённые конфигурации"
);

/* ------------------------------------------------------------------ */
/* 8. Кросс-таймфреймовая подмена ловится САМИМ прогоном               */
/* ------------------------------------------------------------------ */

/**
 * Заявлен таймфрейм 15m, а бары часовые: P2-A вычисляет timeframeMs по
 * фактической сетке, и сверка идентичности внутри прогона обязана
 * отклонить КАЖДУЮ конфигурацию (результат чужого таймфрейма не
 * принимается). Отклонённые конфигурации остаются в отчёте.
 */
const timeframeLie = mustRun(
  runExperiment(
    input({
      subject: {
        ...SUBJECT,
        market: { ...SUBJECT.market, timeframe: "15m", timeframeMs: 900_000 }
      }
    })
  )
);
const timeframeLieView = buildComparison(timeframeLie);

ok(
  timeframeLie.counts.evaluated === 0 &&
    timeframeLie.counts.rejected === 3 &&
    timeframeLie.counts.declared === 3,
  "кросс-таймфрейм: ни одна конфигурация не принята, все три отклонены"
);
ok(
  timeframeLie.variants.every(
    (item) => item.rejection?.reason === "identity-mismatch"
  ),
  "кросс-таймфрейм: причина отклонения — identity-mismatch"
);
ok(
  timeframeLie.variants.every((item) => item.rejection?.segment === "TRAIN"),
  "кросс-таймфрейм: отказ зафиксирован на первом (TRAIN) сегменте"
);
ok(
  timeframeLie.variants.every((item) =>
    (item.rejection?.errors ?? []).some((error) => error.includes("timeframeMs"))
  ),
  "кросс-таймфрейм: текст ошибки называет timeframeMs"
);
ok(
  timeframeLieView.rows.length === 3 &&
    timeframeLieView.rows.every(
      (row) => row.status === "rejected" && row.train === null && row.oos === null
    ),
  "кросс-таймфрейм: отклонённые видны в отчёте, результатов у них нет"
);
ok(
  assertNoCherryPicking(
    timeframeLie,
    timeframeLie.variants.map((item) => item.configurationId)
  ).ok,
  "кросс-таймфрейм: инвариант отсутствия cherry-picking соблюдён"
);
ok(
  assertOosIsolation(timeframeLie).ok,
  "кросс-таймфрейм: изоляция OOS соблюдена (выбор не выполнен)"
);
ok(
  timeframeLie.selection.performed === false &&
    timeframeLie.selection.selectedConfigurationId === null,
  "кросс-таймфрейм: выбирать не из чего — выбор не выполнен"
);
ok(
  timeframeLie.variants.every(
    (item) => item.configurationId !== RECORD.variants[0].configurationId
  ),
  "кросс-таймфрейм: идентичности конфигураций отличаются (таймфрейм входит в них)"
);

/** Прямые проверки assertSegmentIdentity по каждой ветке. */
if (resolvedA !== null && resolvedB !== null) {
  const identityArgs = {
    result: resultOf(0, "TRAIN"),
    segment: "TRAIN" as const,
    window: windowOf(SPLIT, "TRAIN"),
    subject: SUBJECT_RECORD,
    variant: resolvedA
  };

  ok(
    assertSegmentIdentity(identityArgs).ok,
    "идентичность сегмента: подлинный результат проходит"
  );
  ok(
    assertSegmentIdentity({ ...identityArgs, segment: "OOS" }).errors.some(
      (error) => error.includes("чужого сегмента")
    ),
    "идентичность сегмента: чужой сегмент обнаружен"
  );
  ok(
    assertSegmentIdentity({
      ...identityArgs,
      window: { name: "TRAIN", startIndex: 0, endIndexExclusive: 30 }
    }).errors.some((error) => error.includes("segmentEndIndexExclusive")),
    "идентичность сегмента: несовпадение окна обнаружено"
  );
  ok(
    assertSegmentIdentity({
      ...identityArgs,
      result: tamperMetadata(resultOf(0, "TRAIN"), { barsCount: 99 })
    }).errors.some((error) => error.includes("barsCount")),
    "идентичность сегмента: несовпадение числа баров сегмента обнаружено"
  );
  ok(
    assertSegmentIdentity({
      ...identityArgs,
      subject: describeSubject(
        { ...SUBJECT, market: { ...SUBJECT.market, asset: "ETHUSDT" } },
        zigzag(60).map((bar) => ({ ...bar, close: bar.close + 0.5 }))
      )
    }).errors.some((error) => error.includes("barsFingerprint")),
    "идентичность сегмента: чужой набор баров обнаружен"
  );
  ok(
    assertSegmentIdentity({
      ...identityArgs,
      variant: resolvedB
    }).errors.some((error) => error.includes("отпечаток конфига")),
    "идентичность сегмента: чужой конфиг конфигурации обнаружен"
  );
  ok(
    assertSegmentIdentity({
      ...identityArgs,
      result: tamperMetadata(resultOf(0, "TRAIN"), {
        contractVersion: "fake-1.0.0"
      })
    }).errors.some((error) => error.includes("не текущим P2-A")),
    "идентичность сегмента: чужая версия контракта обнаружена"
  );
}

/* ------------------------------------------------------------------ */
/* 9. Сквозные проверки уровня эксперимента                           */
/* ------------------------------------------------------------------ */

ok(
  RECORD.variants.every((item) =>
    item.segments !== null &&
    SPLIT_NAMES.every(
      (segment) =>
        item.segments?.[segment].window.startIndex ===
          windowOf(SPLIT, segment).startIndex &&
        item.segments?.[segment].window.endIndexExclusive ===
          windowOf(SPLIT, segment).endIndexExclusive
    )
  ),
  "сквозное: окна всех прогонов равны окнам разбиения"
);
ok(
  RECORD.variants.every((item) =>
    item.segments !== null &&
    SPLIT_NAMES.every(
      (segment) =>
        item.segments?.[segment].result?.metadata.segment === segment
    )
  ),
  "сквозное: каждый сохранённый результат помечен своим сегментом"
);
ok(
  RECORD.variants.every((item) =>
    item.segments !== null &&
    SPLIT_NAMES.every(
      (segment) =>
        item.segments?.[segment].report?.resultFingerprint ===
        fingerprintResult(item.segments?.[segment].result as BacktestResult)
    )
  ),
  "сквозное: отпечатки сегментных отчётов совпадают с P2-A"
);
ok(
  RECORD.variants.every((item, index) => {
    const other = RECORD.variants.find(
      (candidate, candidateIndex) =>
        candidateIndex !== index &&
        candidate.configurationId === item.configurationId
    );

    return other === undefined;
  }),
  "сквозное: идентичности конфигураций уникальны (нет склейки результатов)"
);
ok(
  RECORD.variants.every((item) =>
    item.segments === null ||
    SPLIT_NAMES.every(
      (segment) =>
        item.segments?.[segment].result?.metadata.configFingerprint ===
        item.configFingerprint
    )
  ),
  "сквозное: конфиг каждого результата совпадает с конфигом конфигурации"
);
ok(
  RECORD.variants.every((item) =>
    item.segments === null ||
    SPLIT_NAMES.every(
      (segment) =>
        item.segments?.[segment].result?.metadata.barsFingerprint ===
        RECORD.subject.dataRange.barsFingerprint
    )
  ),
  "сквозное: все результаты получены на одних и тех же барах"
);
ok(
  chronologicalSplit(BARS.length, undefined, 3).ok === true &&
    assertSplitChronological(
      (chronologicalSplit(BARS.length, undefined, 3) as { ok: true; split: ChronologicalSplit })
        .split,
      BARS.length
    ).ok,
  "сквозное: P2-A разбиение проходит валидатор хронологии P2-C"
);

/* ------------------------------------------------------------------ */
/* 10. Скан изоляции слоя: никаких БД/сети/времени/случайности         */
/* ------------------------------------------------------------------ */

const experimentDir = join(process.cwd(), "lib", "experiment");
const layerFiles = readdirSync(experimentDir)
  .filter((name) => name.endsWith(".ts"))
  .sort();

/**
 * Комментарии убираются, чтобы документация политики («никаких
 * Date.now(), Prisma и process.env») не давала ложных срабатываний;
 * подход тот же, что в P2-A (`scripts/test-backtest-engine.ts`).
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

const FORBIDDEN_TOKENS = [
  "process.",
  "Date.now",
  "new Date",
  "Math.random",
  "randomUUID",
  "randomBytes",
  "performance.now",
  "fetch(",
  "XMLHttpRequest",
  "axios",
  "@prisma",
  "prisma",
  "require(",
  "setTimeout",
  "setInterval",
  "node:fs",
  "node:net",
  "node:http",
  "node:child_process",
  "worker_threads",
  "localStorage",
  "next/server"
] as const;

const ALLOWED_IMPORTS = new Set([
  "../backtest/contract",
  "../backtest/costs",
  "../backtest/engine",
  "../backtest/immutable",
  "../backtest/metrics",
  "../backtest/no-lookahead",
  "../backtest/serialize",
  "../backtest/splits",
  "../backtest/validate",
  "./contract",
  "./identity",
  "./report",
  "./run",
  "./selection",
  "./validate"
]);

ok(
  layerFiles.length === 6,
  `скан: слой P2-C на месте (${String(layerFiles.length)} файлов: ${layerFiles.join(", ")})`
);

for (const name of layerFiles) {
  const source = stripComments(
    readFileSync(join(experimentDir, name), "utf8")
  );
  const hits = FORBIDDEN_TOKENS.filter((token) => source.includes(token));
  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
    (match) => match[1]
  );
  const unexpected = specifiers.filter((item) => !ALLOWED_IMPORTS.has(item));

  ok(source.length > 500, `скан: ${name} прочитан`);
  ok(
    hits.length === 0,
    `скан: ${name} не использует env/время/случайность/сеть/БД (${hits.join(", ") || "чисто"})`
  );
  ok(
    unexpected.length === 0,
    `скан: ${name} импортирует только P2-A и модули слоя (${unexpected.join(", ") || "чисто"})`
  );
  ok(
    !/postgres|mysql|sqlite|mongoose|drizzle|knex/i.test(source),
    `скан: ${name} не обращается к СУБД/ORM`
  );
  ok(
    !/\bwriteFile\b|\breadFile\b|createWriteStream|appendFile/i.test(source),
    `скан: ${name} не пишет и не читает файлы (никакой персистенции вне памяти)`
  );
}

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
