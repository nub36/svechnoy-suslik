/**
 * P2-C — прогон эксперимента: pure/in-memory, детерминированный.
 *
 * Последовательность (каждый шаг — чистая функция):
 *   1) политика порядка и политика выбора (валидация, OOS запрещён);
 *   2) бары (P2-A валидация структуры и сетки);
 *   3) субъект: идентичность стратегии/рынка + диапазон данных,
 *      вычисленный ИЗ БАРОВ (заявить его «на глаз» нельзя);
 *   4) разбиение — P2-A `chronologicalSplit` (второго алгоритма нет) +
 *      проверка хронологичности/непересечения;
 *   5) разрешение конфигураций и их идентичностей (отклонённые
 *      сохраняются с причиной);
 *   6) для каждой конфигурации — ТРИ прогона P2-A `runBacktest`
 *      (TRAIN/VALIDATION/OOS) + P2-A инвариант отсутствия утечки +
 *      проекция метрик (без пересчёта);
 *   7) порядок представления (не зависимый от результата), три блока
 *      свидетельств, явное ранжирование/выбор (только TRAIN/VALIDATION);
 *   8) самопроверка инвариантов записи (нет cherry-picking, OOS
 *      изолирован) — до возврата результата.
 *
 * Никакой БД, сети, workers, файлов, process.env, текущего времени и
 * случайности: идентичный вход ⇒ байт-в-байт идентичная запись.
 */

import {
  BACKTEST_DEFAULTS,
  type BacktestBar,
  type BacktestConfig,
  type BacktestOutcome,
  type BacktestResult,
  type ChronologicalSplit,
  type SegmentWindow,
  type SplitName,
  resolveBacktestConfig
} from "../backtest/contract";
import { runBacktest } from "../backtest/engine";
import { deepFreeze } from "../backtest/immutable";
import {
  SPLIT_NAMES,
  assertNoSegmentLeakage,
  chronologicalSplit
} from "../backtest/splits";
import { validateBars } from "../backtest/validate";
import {
  DEFAULT_SELECTION_POLICY,
  EXPERIMENT_CONTRACT_VERSION,
  EXPERIMENT_LAYER_NAME,
  EXPERIMENT_LIMITATIONS,
  type ComparisonView,
  type ExperimentFailureStage,
  type ExperimentInput,
  type ExperimentOutcome,
  type ExperimentRecord,
  type ExperimentSubject,
  type PresentationOrderPolicy,
  type ResolvedVariant,
  type SegmentRecord,
  type SelectionPolicy,
  type VariantDefinition,
  type VariantRecord,
  type VariantRejection
} from "./contract";
import {
  describeSubject,
  fingerprintExperimentInput,
  fingerprintSubject,
  resolveVariants,
  validateSubject
} from "./identity";
import {
  buildComparison,
  buildEvidenceBlocks,
  fingerprintSegmentResults,
  projectSegmentReport
} from "./report";
import {
  applyPresentationOrder,
  assertRankingIndependentOfOos,
  buildSelectionRecord,
  validateOrderPolicy,
  validateSelectionPolicy
} from "./selection";
import {
  assertLimitationsPresent,
  assertNoCherryPicking,
  assertOosIsolation,
  assertSegmentIdentity,
  assertSplitChronological,
  windowOf
} from "./validate";

/** Стадии отказа P2-A: выведены из самого контракта P2-A (C1/C2). */
type BacktestFailureStage = Extract<
  BacktestOutcome,
  { readonly ok: false }
>["stage"];

const SEGMENT_ORDER: readonly SplitName[] = ["TRAIN", "VALIDATION", "OOS"];

/** Имена сегментов (переэкспорт P2-A: второго списка сегментов нет). */
export const EXPERIMENT_SEGMENTS: readonly SplitName[] = SPLIT_NAMES;

/**
 * Отказ прогона P2-A → стадия и код причины P2-C (C1/C2).
 *
 * Отображение ИСЧЕРПЫВАЮЩЕЕ: `Record<BacktestFailureStage, …>` над
 * объединением стадий P2-A. Появление новой стадии в P2-A ломает
 * компиляцию, а не молча меняет смысл отказа. Молчаливого сведения к
 * `provider-failure` нет: `adapter`/`signals`/`arithmetic` получают
 * собственные стадии и коды причин, ошибки P2-A переносятся без потерь.
 */
export const BACKTEST_FAILURE_STAGE_MAP: Readonly<
  Record<
    BacktestFailureStage,
    { readonly stage: VariantRejection["stage"]; readonly reason: VariantRejection["reason"] }
  >
> = {
  config: { stage: "config", reason: "invalid-config" },
  adapter: { stage: "adapter", reason: "adapter-failure" },
  signals: { stage: "signals", reason: "signals-failure" },
  bars: { stage: "bars", reason: "invalid-bars" },
  provider: { stage: "provider", reason: "provider-failure" },
  arithmetic: { stage: "arithmetic", reason: "arithmetic-failure" }
};

function mapBacktestFailure(
  stage: BacktestFailureStage,
  segment: SplitName
): VariantRejection {
  const mapped = (
    BACKTEST_FAILURE_STAGE_MAP as Readonly<
      Record<string, { readonly stage: VariantRejection["stage"]; readonly reason: VariantRejection["reason"] } | undefined>
    >
  )[stage];

  if (mapped === undefined) {
    // Недостижимо, пока P2-A сообщает только объявленные стадии; на
    // случай нетипизированного вызова отказ остаётся явным и не
    // притворяется provider-отказом.
    return {
      stage: "segment",
      reason: "segment-failure",
      segment,
      errors: [`P2-A: неизвестная стадия отказа ${String(stage)}`]
    };
  }

  return { ...mapped, segment, errors: [] };
}

function failedRecord(
  segment: SplitName,
  window: SegmentWindow,
  errors: readonly string[],
  leakageErrors: readonly string[] = [],
  rejectionReason: VariantRejection["reason"] | null = null
): SegmentRecord {
  return {
    segment,
    window,
    status: "failed",
    errors: [...errors],
    // СЕГМЕНТ-ЛОКАЛЬНАЯ причина: ранжирование по другому сегменту не
    // должно видеть отказ этого сегмента (пункт 22в контракта).
    rejectionReason,
    leakageOk: false,
    leakageErrors: [...leakageErrors],
    result: null,
    report: null
  };
}

/** Прогон одного сегмента одной конфигурации (P2-A + инвариант утечки). */
function runSegment(args: {
  readonly bars: readonly BacktestBar[];
  readonly segment: SplitName;
  readonly window: SegmentWindow;
  readonly config: BacktestConfig;
  readonly signals: VariantDefinition["signals"];
  readonly subject: ExperimentSubject;
  readonly variant: ResolvedVariant;
}): {
  readonly record: SegmentRecord;
  readonly rejection: VariantRejection | null;
} {
  const { bars, segment, window, config, signals, subject, variant } = args;
  const outcome: BacktestOutcome = runBacktest({
    bars,
    signals,
    config,
    segment: window
  });

  if (!outcome.ok) {
    const rejection = mapBacktestFailure(outcome.stage, segment);

    return {
      record: failedRecord(
        segment,
        window,
        // Ошибки P2-A переносим БЕЗ изменений: причина отказа сегмента
        // должна быть читаема в отчёте.
        outcome.errors,
        [],
        rejection.reason
      ),
      rejection: { ...rejection, errors: [...outcome.errors] }
    };
  }

  const result: BacktestResult = outcome.result;

  // Идентичность сверяется ДО принятия результата: сегмент, окно, версия
  // контракта P2-A, отпечаток баров (рынок/диапазон), таймфрейм и конфиг.
  // Результат чужого сегмента/конфигурации/рынка не может быть принят.
  const identity = assertSegmentIdentity({
    result,
    segment,
    window,
    subject,
    variant
  });

  if (!identity.ok) {
    return {
      record: failedRecord(
        segment,
        window,
        identity.errors,
        [],
        "identity-mismatch"
      ),
      rejection: {
        stage: "segment",
        reason: "identity-mismatch",
        segment,
        errors: [...identity.errors]
      }
    };
  }

  const leakage = assertNoSegmentLeakage(result, window);

  if (!leakage.ok) {
    return {
      record: failedRecord(
        segment,
        window,
        leakage.errors,
        leakage.errors,
        "leakage-detected"
      ),
      rejection: {
        stage: "leakage",
        reason: "leakage-detected",
        segment,
        errors: [...leakage.errors]
      }
    };
  }

  return {
    record: {
      segment,
      window,
      status: "ok",
      errors: [],
      rejectionReason: null,
      leakageOk: true,
      leakageErrors: [],
      result,
      // Метрики проецируются дословно из результата P2-A — P2-C их не
      // пересчитывает и не «улучшает».
      report: projectSegmentReport(result, segment, window)
    },
    rejection: null
  };
}

/**
 * ВНУТРЕННИЙ ШОВ ПРОВОДКИ ЦЕПОЧКИ ИНВАРИАНТОВ (hardening #2, FIX 2).
 *
 * Не является частью отчётного контракта P2-C — контрактная версия из-за
 * него не меняется. Назначение — дать тесту ДОКАЗАТЕЛЬСТВО уровня
 * `runExperiment`, что цепочка инвариантов действительно ИСПОЛНЯЕТСЯ и её
 * результат управляет исходом прогона: тест устанавливает шов, требующий
 * фиксированную ошибку, и вызывает `runExperiment` на корректном входе,
 * ожидая `ok=false, stage="invariant"`. Удаление/обход вызова
 * `experimentInvariantErrors(record)` в `runExperiment` убирает и шов —
 * тест падает (мутант M4b не выживает).
 *
 * Шов МОНОТОННО-АДДИТИВНЫЙ и fail-closed: он способен только ДОБАВИТЬ
 * ошибку (сделать запись недействительной) и не может отключить,
 * ослабить, подменить или обойти ни одну существующую проверку. По
 * умолчанию (null) он не влияет ни на что; рантайм-семантика эксперимента
 * не ослабляется ни при каком значении шва.
 */
let invariantProbe: ((record: ExperimentRecord) => readonly string[]) | null =
  null;

/** Установить/снять шов проводки цепочки инвариантов (см. выше). */
export function setExperimentInvariantProbe(
  probe: ((record: ExperimentRecord) => readonly string[]) | null
): void {
  invariantProbe = probe;
}

/**
 * ЕДИНАЯ цепочка самопроверок записи эксперимента (hardening #1, FIX 3;
 * end-to-end пин — hardening #2, FIX 2).
 *
 * Экспортируется, чтобы тест мог проверять ПРОВОДКУ цепочки: тест
 * прогоняет через ЭТУ ЖЕ цепочку запись, у которой нарушены канонические
 * ограничения честности, и требует, чтобы нарушение было обнаружено.
 *
 * HARDENING #2: сама по себе такая проверка не доказывает, что
 * `runExperiment` ПОТРЕБЛЯЕТ результат цепочки (мутант M4b, убравший вызов
 * из `runExperiment`, выживал). Поэтому внутри цепочки исполняется
 * монотонно-аддитивный шов `invariantProbe` (см. ниже): тест устанавливает
 * шов, требующий фиксированную ошибку, и вызывает именно `runExperiment` —
 * если вызов цепочки удалён или обойдён, ошибка шва не всплывает и тест
 * падает.
 *
 * Цепочка не выполняет никакой OOS-зависимой логики: `selection.ranking`
 * уже построен без OOS, а `assertRankingIndependentOfOos` только
 * пересчитывает порядок из TRAIN/VALIDATION-свидетельств.
 */
export function experimentInvariantErrors(
  record: ExperimentRecord
): readonly string[] {
  const rankingIndependence =
    record.selection.ranking === null
      ? { ok: true, errors: [] as readonly string[] }
      : assertRankingIndependentOfOos(record.selection.ranking, {
          trainSelection: record.evidence.trainSelection,
          validationConfirmation: record.evidence.validationConfirmation
        });

  return [
    ...rankingIndependence.errors,
    ...assertLimitationsPresent(record).errors,
    ...assertOosIsolation(record).errors,
    ...assertNoCherryPicking(
      record,
      record.variants.map((variant) => variant.configurationId)
    ).errors,
    ...(invariantProbe === null ? [] : invariantProbe(record))
  ];
}

/**
 * Прогон эксперимента.
 *
 * Отказ эксперимента (ok=false) возможен только для проблем УРОВНЯ
 * ЭКСПЕРИМЕНТА (политика, данные, субъект, разбиение, пустой набор
 * конфигураций, нарушение собственных инвариантов). Проблемы отдельной
 * конфигурации делают её `rejected` — но НЕ удаляют из отчёта.
 */
export function runExperiment(input: ExperimentInput): ExperimentOutcome {
  const orderPolicy: PresentationOrderPolicy =
    input.orderPolicy ?? "input-order";
  const selectionPolicy: SelectionPolicy =
    input.selectionPolicy ?? DEFAULT_SELECTION_POLICY;

  const policyErrors = [
    ...validateOrderPolicy(orderPolicy),
    ...validateSelectionPolicy(selectionPolicy)
  ];

  if (policyErrors.length > 0) {
    return { ok: false, stage: "policy", errors: policyErrors };
  }

  if (!Array.isArray(input.bars) || input.bars.length === 0) {
    return {
      ok: false,
      stage: "bars",
      errors: ["bars: требуется непустой массив закрытых свечей"]
    };
  }

  const defaults = resolveBacktestConfig({});
  const barsCheck = validateBars(
    input.bars,
    defaults.ok ? defaults.config : BACKTEST_DEFAULTS
  );

  if (!barsCheck.ok) {
    return { ok: false, stage: "bars", errors: barsCheck.errors };
  }

  if (!Array.isArray(input.variants) || input.variants.length === 0) {
    return {
      ok: false,
      stage: "variants",
      errors: [
        "variants: эксперимент без конфигураций бессмысленен (нужен хотя бы один объявленный вариант)"
      ]
    };
  }

  const subject = describeSubject(input.subject, input.bars);
  const subjectErrors = validateSubject(subject);

  if (subjectErrors.length > 0) {
    return { ok: false, stage: "subject", errors: subjectErrors };
  }

  const subjectFingerprint = fingerprintSubject(subject);
  const resolutions = resolveVariants(input.variants, subjectFingerprint);

  // warmupStart в записи разбиения — по самому широкому заявленному
  // warmupBars. Фактическое warmup-окно каждого варианта P2-A считает из
  // его собственного конфига; здесь фиксируется лишь максимальное
  // заявленное, чтобы запись разбиения была детерминированной и
  // воспроизводимой из входа.
  const maxWarmupBars = resolutions.reduce((maximum, resolution) => {
    const warmup = resolution.resolved?.config.warmupBars ?? 0;

    return warmup > maximum ? warmup : maximum;
  }, 0);

  const splitOutcome = chronologicalSplit(
    input.bars.length,
    input.splitConfig,
    maxWarmupBars
  );

  if (!splitOutcome.ok) {
    return { ok: false, stage: "split", errors: splitOutcome.errors };
  }

  const split: ChronologicalSplit = splitOutcome.split;
  const chronology = assertSplitChronological(split, input.bars.length);

  if (!chronology.ok) {
    return { ok: false, stage: "split", errors: chronology.errors };
  }

  /* ---------- прогон каждой конфигурации по трём сегментам ---------- */

  const variantRecords: VariantRecord[] = [];

  for (const resolution of resolutions) {
    const resolved = resolution.resolved;

    if (resolved === null) {
      const rejection =
        resolution.rejection ??
        ({
          stage: "variant",
          reason: "invalid-variant",
          segment: null,
          errors: ["вариант не разрешён"]
        } satisfies VariantRejection);

      variantRecords.push(
        unresolvedVariantRecord({
          inputOrder: resolution.inputOrder,
          definition: resolution.definition,
          rejection,
          duplicateOfConfigurationId: resolution.duplicateOfConfigurationId
        })
      );

      continue;
    }

    const segments: Record<SplitName, SegmentRecord> = {
      TRAIN: failedRecord("TRAIN", windowOf(split, "TRAIN"), ["не выполнен"]),
      VALIDATION: failedRecord(
        "VALIDATION",
        windowOf(split, "VALIDATION"),
        ["не выполнен"]
      ),
      OOS: failedRecord("OOS", windowOf(split, "OOS"), ["не выполнен"])
    };
    let rejection: VariantRejection | null = null;

    for (const segment of SEGMENT_ORDER) {
      const window = windowOf(split, segment);
      const run = runSegment({
        bars: input.bars,
        segment,
        window,
        config: resolved.config,
        signals: resolution.definition.signals,
        subject,
        variant: resolved
      });

      segments[segment] = run.record;

      // Фиксируется ПЕРВАЯ причина отказа: это честная последовательность
      // (сегменты обрабатываются в хронологическом порядке), а не
      // «наиболее выгодная».
      if (run.rejection !== null && rejection === null) {
        rejection = run.rejection;
      }
    }

    variantRecords.push({
      configurationId: resolved.configurationId,
      selectionKey: resolved.selectionKey,
      label: resolved.label,
      inputOrder: resolved.inputOrder,
      presentationOrder: resolved.inputOrder,
      status: rejection === null ? "evaluated" : "rejected",
      rejection,
      params: resolved.params,
      paramsFingerprint: resolved.paramsFingerprint,
      configFingerprint: resolved.configFingerprint,
      signalSource: resolved.signalSource,
      segments: {
        TRAIN: segments.TRAIN,
        VALIDATION: segments.VALIDATION,
        OOS: segments.OOS
      }
    });
  }

  /* ---------- порядок, свидетельства, выбор ---------- */

  const ordered = applyPresentationOrder(variantRecords, orderPolicy);
  const evidence = buildEvidenceBlocks(ordered);
  const selection = buildSelectionRecord(selectionPolicy, {
    trainSelection: evidence.trainSelection,
    validationConfirmation: evidence.validationConfirmation
  });

  const rankingIndependence =
    selection.ranking === null
      ? { ok: true, errors: [] as readonly string[] }
      : assertRankingIndependentOfOos(selection.ranking, {
          trainSelection: evidence.trainSelection,
          validationConfirmation: evidence.validationConfirmation
        });

  const record: ExperimentRecord = {
    contractVersion: EXPERIMENT_CONTRACT_VERSION,
    layer: EXPERIMENT_LAYER_NAME,
    subject,
    subjectFingerprint,
    split,
    orderPolicy,
    inputFingerprint: fingerprintExperimentInput({
      subject,
      subjectFingerprint,
      split,
      orderPolicy,
      selectionPolicy,
      configurationIds: ordered.map((variant) => variant.configurationId)
    }),
    resultFingerprint: fingerprintSegmentResults(ordered),
    counts: {
      declared: resolutions.length,
      evaluated: ordered.filter(
        (variant) => variant.status === "evaluated"
      ).length,
      rejected: ordered.filter((variant) => variant.status === "rejected").length
    },
    variants: ordered,
    evidence,
    selection,
    limitations: [...EXPERIMENT_LIMITATIONS],
    oosIsolation: {
      oosConsultedForSelection: false,
      oosConsultedForRanking: false,
      mechanism:
        selection.ranking === null
          ? "structural-evidence-type+policy-stage-whitelist"
          : "structural-evidence-type+policy-stage-whitelist+recomputed-ranking",
      rankingIndependenceVerified:
        selection.ranking !== null && rankingIndependence.ok
    }
  };

  /* ---------- самопроверка инвариантов до возврата ---------- */

  const invariantErrors: readonly string[] =
    experimentInvariantErrors(record);

  if (invariantErrors.length > 0) {
    return { ok: false, stage: "invariant", errors: invariantErrors };
  }

  return { ok: true, record: freezeRecord(record) };
}

/** Прогон эксперимента вместе с построенным отчётом сравнения. */
export type ExperimentReportOutcome =
  | {
      readonly ok: true;
      readonly record: ExperimentRecord;
      readonly view: ComparisonView;
    }
  | {
      readonly ok: false;
      readonly stage: ExperimentFailureStage;
      readonly errors: readonly string[];
    };

export function runExperimentReport(
  input: ExperimentInput
): ExperimentReportOutcome {
  const outcome = runExperiment(input);

  if (!outcome.ok) {
    return outcome;
  }

  return {
    ok: true,
    record: outcome.record,
    view: buildComparison(outcome.record)
  };
}

/* ------------------------------------------------------------------ */
/* Вспомогательное                                                     */
/* ------------------------------------------------------------------ */

/**
 * Запись варианта, отклонённого на этапе разрешения.
 *
 * Идентичность здесь НЕ sha256, а явная метка: `unresolved:{порядок
 * входа}` либо `{конфликтующая идентичность}#duplicate:{порядок входа}`.
 * Это честно показывает, что валидная идентичность конфигурации не
 * установлена (или collided), и гарантирует уникальность строки отчёта.
 */
function unresolvedVariantRecord(args: {
  readonly inputOrder: number;
  readonly definition: unknown;
  readonly rejection: VariantRejection;
  readonly duplicateOfConfigurationId: string | null;
}): VariantRecord {
  const definition = args.definition as Partial<VariantDefinition> | null;
  const label =
    typeof definition?.label === "string" && definition.label.length > 0
      ? definition.label
      : `variant#${String(args.inputOrder)}`;
  const configurationId =
    args.duplicateOfConfigurationId === null
      ? `unresolved:${String(args.inputOrder)}`
      : `${args.duplicateOfConfigurationId}#duplicate:${String(args.inputOrder)}`;
  // Для неразрешённых вариантов выборный ключ — тоже ЯВНАЯ метка
  // (валидная объявленная идентичность не установлена). В него намеренно
  // не попадает `duplicateOfConfigurationId`: это ПОЛНАЯ идентичность,
  // включающая OOS-часть объявленного входа, а поле `selectionKey` обязано
  // оставаться OOS-слепым. Отклонённые варианты в ранжировании не
  // участвуют (пункт 22в).
  const selectionKey = `unresolved-selection:${String(args.inputOrder)}`;

  return {
    configurationId,
    selectionKey,
    label,
    inputOrder: args.inputOrder,
    presentationOrder: args.inputOrder,
    status: "rejected",
    rejection: args.rejection,
    params: {},
    paramsFingerprint: "",
    configFingerprint: "",
    signalSource: null,
    segments: null
  };
}

/**
 * Рекурсивная заморозка публичной записи эксперимента (C4): P2-A
 * `deepFreeze` переиспользуется, второй freeze-механизм не создаётся.
 * Заморозка идемпотентна и покрывает вложенные структуры (варианты,
 * сегменты, результаты, свидетельства, ранжирование).
 */
function freezeRecord(record: ExperimentRecord): ExperimentRecord {
  return deepFreeze(record);
}
