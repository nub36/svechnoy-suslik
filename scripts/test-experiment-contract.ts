/**
 * P2-C — тесты контракта эксперимента: идентичность, порядок, выбор.
 *
 * Запуск: npx tsx scripts/test-experiment-contract.ts
 *
 * Проверяемые свойства (пункты политики lib/experiment/contract.ts):
 *  - идентичность конфигурации связывает субъект (стратегия/рынок/
 *    таймфрейм/диапазон данных), метку, параметры, конфиг P2-A и
 *    источник решений: любое изменение даёт ДРУГОЙ configurationId;
 *  - диапазон данных вычисляется из баров, а не заявляется;
 *  - provider-форма источника решений без signalSourceId отклоняется;
 *  - порядок представления детерминирован и не зависит от результата;
 *    результат-зависимые порядки запрещены;
 *  - выбор/ранжирование возможны только по TRAIN/VALIDATION, OOS
 *    запрещён на уровне типа и на уровне валидации;
 *  - направления критериев зафиксированы, null всегда последний,
 *    tie-break детерминирован;
 *  - блоки свидетельств разделены по сегментам;
 *  - все объявленные конфигурации присутствуют в отчёте (10 → 10),
 *    включая отклонённые, с причиной.
 */

import {
  type BacktestBar,
  type SignalDecision,
  type SignalDecisionList,
  entryDecision
} from "../lib/backtest/contract";
import { canonicalJson, fingerprintResult } from "../lib/backtest/serialize";
import { SPLIT_NAMES, chronologicalSplit } from "../lib/backtest/splits";
import {
  DEFAULT_SELECTION_POLICY,
  EXPERIMENT_CONTRACT_VERSION,
  EXPERIMENT_LAYER_NAME,
  METRICS_PROVENANCE,
  PRESENTATION_ORDER_POLICIES,
  RANKING_CRITERIA,
  RANKING_CRITERION_DIRECTION,
  SELECTION_STAGES,
  type EvidenceMetrics,
  type ExperimentInput,
  type ExperimentSubjectInput,
  type PresentationOrderPolicy,
  type RankingCriterion,
  type SelectionPolicy,
  type SelectionStage,
  type VariantDefinition
} from "../lib/experiment/contract";
import {
  configurationIdOf,
  describeDataRange,
  describeSignalSource,
  describeSubject,
  fingerprintExperimentInput,
  fingerprintParams,
  fingerprintSubject,
  resolveVariants,
  validateSubject
} from "../lib/experiment/identity";
import {
  buildComparison,
  buildEvidenceBlocks,
  canonicalExperiment,
  fingerprintExperiment,
  projectEvidence
} from "../lib/experiment/report";
import { runExperiment, runExperimentReport } from "../lib/experiment/run";
import {
  applyPresentationOrder,
  assertRankingIndependentOfOos,
  buildSelectionRecord,
  rankEvidence,
  validateOrderPolicy,
  validateSelectionPolicy
} from "../lib/experiment/selection";

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
/* Фикстуры (детерминированные, без Date.now и случайности)            */
/* ------------------------------------------------------------------ */

const H1 = 3_600_000;
const T0 = 1_700_000_000_000;

/** Пиловая серия P2-A: период 7, нулевой дрейф за период. */
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

/** Монотонный рост: нужен для состояний PF и серий. */
function rising(count: number): BacktestBar[] {
  const bars: BacktestBar[] = [];

  for (let i = 0; i < count; i += 1) {
    const open = 100 + i;
    const close = open + 1;

    bars.push({
      time: T0 + i * H1,
      open,
      high: close + 0.5,
      low: open - 0.5,
      close
    });
  }

  return bars;
}

/**
 * Список решений с уровнями, привязанными к цене сигнального бара:
 * SL/TP всегда по правильную сторону, а следующий бар (точка входа
 * next-bar-open) всегда строго внутри brackets.
 */
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
const RISING = rising(60);
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

function variant(
  label: string,
  config: VariantDefinition["config"],
  extra?: Partial<VariantDefinition>
): VariantDefinition {
  return { label, params: { label }, config, signals: LIST, ...extra };
}

function input(overrides?: Partial<ExperimentInput>): ExperimentInput {
  return {
    bars: BARS,
    subject: SUBJECT,
    variants: [
      variant("timeout-3", { timeoutBars: 3, warmupBars: 3 }),
      variant("timeout-6", { timeoutBars: 6, warmupBars: 3 }),
      variant("no-timeout", { timeoutBars: null, warmupBars: 3 })
    ],
    ...overrides
  };
}

function mustRun(value: ReturnType<typeof runExperiment>) {
  if (!value.ok) {
    console.error(`FAIL: эксперимент не выполнен (${value.stage})`, value.errors);
    process.exit(1);
  }

  return value.record;
}

const RECORD = mustRun(runExperiment(input()));
const VIEW = buildComparison(RECORD);

/* ------------------------------------------------------------------ */
/* 1. Константы и закрытые наборы контракта                            */
/* ------------------------------------------------------------------ */

ok(
  EXPERIMENT_CONTRACT_VERSION === "p2c-1.2.0",
  "контракт: версия P2-C фиксирована"
);
ok(
  EXPERIMENT_LAYER_NAME === "suslik-experiment",
  "контракт: имя слоя фиксировано"
);
ok(
  METRICS_PROVENANCE === "p2a-metrics-verbatim",
  "контракт: метрики помечены как дословная проекция P2-A"
);
ok(
  RECORD.contractVersion === EXPERIMENT_CONTRACT_VERSION &&
    RECORD.layer === EXPERIMENT_LAYER_NAME,
  "контракт: запись несёт версию и имя слоя"
);
ok(
  PRESENTATION_ORDER_POLICIES.join(",") === "input-order,configuration-id",
  "контракт: допустимы только два порядка представления"
);
ok(
  !PRESENTATION_ORDER_POLICIES.some((policy) =>
    /profit|win|best|pnl|return|rank/i.test(policy)
  ),
  "контракт: результат-зависимых порядков представления не существует"
);
ok(
  SELECTION_STAGES.join(",") === "TRAIN,VALIDATION",
  "контракт: стадии выбора — только TRAIN и VALIDATION (OOS исключён)"
);
ok(
  !(SELECTION_STAGES as readonly string[]).includes("OOS"),
  "контракт: OOS отсутствует в стадиях выбора"
);
ok(
  SPLIT_NAMES.join(",") === "TRAIN,VALIDATION,OOS",
  "контракт: сегменты P2-A переиспользованы без второго списка"
);
ok(
  RANKING_CRITERIA.length === 9,
  "контракт: набор критериев ранжирования закрыт (9)"
);
ok(
  RANKING_CRITERIA.every((criterion) =>
    Object.prototype.hasOwnProperty.call(
      RANKING_CRITERION_DIRECTION,
      criterion
    )
  ),
  "контракт: у каждого критерия зафиксировано направление"
);
ok(
  Object.keys(RANKING_CRITERION_DIRECTION).length === RANKING_CRITERIA.length,
  "контракт: направлений ровно столько, сколько критериев"
);
ok(
  ["trades", "netPnl", "winRate", "profitFactor", "expectancy", "avgR", "medianR"].every(
    (criterion) =>
      RANKING_CRITERION_DIRECTION[criterion as RankingCriterion] === "desc"
  ),
  "контракт: «чем больше, тем лучше» зафиксировано как desc"
);
ok(
  RANKING_CRITERION_DIRECTION.maxRealizedDrawdownPct === "asc" &&
    RANKING_CRITERION_DIRECTION.maxConsecutiveLosses === "asc",
  "контракт: просадка и серии убытков зафиксированы как asc"
);
ok(
  DEFAULT_SELECTION_POLICY.kind === "none",
  "контракт: по умолчанию ничего не выбирается (не оптимизатор)"
);
ok(
  RECORD.orderPolicy === "input-order",
  "контракт: порядок представления по умолчанию — порядок входа"
);
ok(
  RECORD.selection.policy.kind === "none" &&
    RECORD.selection.performed === false &&
    RECORD.selection.selectedConfigurationId === null,
  "контракт: без явной политики выбор не выполняется"
);

/* ------------------------------------------------------------------ */
/* 2. Диапазон данных и субъект                                        */
/* ------------------------------------------------------------------ */

const range = describeDataRange(BARS);

ok(range.barsCount === 60, "субъект: barsCount берётся из фактических баров");
ok(
  range.firstBarTime === BARS[0].time && range.lastBarTime === BARS[59].time,
  "субъект: границы диапазона — времена первого и последнего бара"
);
ok(
  /^[0-9a-f]{64}$/.test(range.barsFingerprint),
  "субъект: отпечаток баров — sha256 hex (P2-A fingerprintBars)"
);
ok(
  describeDataRange(zigzag(60)).barsFingerprint === range.barsFingerprint,
  "субъект: идентичные бары дают идентичный отпечаток"
);

const mutated = zigzag(60);

mutated[59] = { ...mutated[59], close: mutated[59].close + 0.01 };

ok(
  describeDataRange(mutated).barsFingerprint !== range.barsFingerprint,
  "субъект: изменение последнего бара меняет отпечаток данных"
);
ok(
  describeDataRange(zigzag(61)).barsFingerprint !== range.barsFingerprint,
  "субъект: изменение длины ряда меняет отпечаток данных"
);
ok(
  describeDataRange(BARS.slice(0, 59)).barsFingerprint !== range.barsFingerprint,
  "субъект: усечение диапазона меняет отпечаток данных"
);

const subject = describeSubject(SUBJECT, BARS);

ok(validateSubject(subject).length === 0, "субъект: валидная идентичность проходит");
ok(
  subject.strategy.slug === "suslik-smc" && subject.strategy.version === "1.4.0",
  "субъект: идентичность стратегии включает версию"
);
ok(
  subject.market.asset === "BTCUSDT" &&
    subject.market.exchange === "test-exchange" &&
    subject.market.timeframe === "1h" &&
    subject.market.timeframeMs === H1,
  "субъект: идентичность рынка включает биржу, таймфрейм и шаг сетки"
);
ok(
  validateSubject(
    describeSubject({ ...SUBJECT, strategy: { slug: "suslik-smc", version: "" } }, BARS)
  ).length > 0,
  "субъект: пустая версия стратегии отклоняется"
);
ok(
  validateSubject(
    describeSubject({ ...SUBJECT, market: { ...SUBJECT.market, asset: "  " } }, BARS)
  ).length > 0,
  "субъект: пустой актив отклоняется"
);
ok(
  validateSubject(
    describeSubject({ ...SUBJECT, market: { ...SUBJECT.market, timeframe: "" } }, BARS)
  ).length > 0,
  "субъект: пустой таймфрейм отклоняется"
);
ok(
  validateSubject(
    describeSubject(
      { ...SUBJECT, market: { ...SUBJECT.market, timeframeMs: 0 } },
      BARS
    )
  ).length > 0,
  "субъект: timeframeMs=0 отклоняется"
);
ok(
  validateSubject(
    describeSubject(
      { ...SUBJECT, market: { ...SUBJECT.market, timeframeMs: 1.5 } },
      BARS
    )
  ).length > 0,
  "субъект: нецелый timeframeMs отклоняется"
);
ok(
  validateSubject({ ...subject, dataRange: { ...range, barsFingerprint: "abc" } })
    .length > 0,
  "субъект: не-sha256 отпечаток баров отклоняется"
);
ok(
  validateSubject({
    ...subject,
    dataRange: { ...range, firstBarTime: 2, lastBarTime: 1 }
  }).length > 0,
  "субъект: lastBarTime < firstBarTime отклоняется"
);

const fingerprintA = fingerprintSubject(subject);
const fingerprintB = fingerprintSubject(
  describeSubject({ ...SUBJECT, strategy: { slug: "suslik-smc", version: "1.4.1" } }, BARS)
);
const fingerprintC = fingerprintSubject(
  describeSubject({ ...SUBJECT, market: { ...SUBJECT.market, asset: "ETHUSDT" } }, BARS)
);
const fingerprintD = fingerprintSubject(
  describeSubject({ ...SUBJECT, market: { ...SUBJECT.market, timeframeMs: 900_000 } }, BARS)
);
const fingerprintE = fingerprintSubject(describeSubject(SUBJECT, mutated));

ok(RECORD.subjectFingerprint === fingerprintA, "субъект: отпечаток в записи совпадает");
ok(fingerprintB !== fingerprintA, "субъект: другая версия стратегии → другой отпечаток");
ok(fingerprintC !== fingerprintA, "субъект: другой актив → другой отпечаток");
ok(fingerprintD !== fingerprintA, "субъект: другой таймфрейм → другой отпечаток");
ok(fingerprintE !== fingerprintA, "субъект: другие бары → другой отпечаток");

/* ------------------------------------------------------------------ */
/* 3. Идентичность конфигурации                                        */
/* ------------------------------------------------------------------ */

const resolutions = resolveVariants(input().variants, fingerprintA);

ok(resolutions.length === 3, "идентичность: все варианты разрешены");
ok(
  resolutions.every((resolution) => resolution.rejection === null),
  "идентичность: валидные варианты не отклоняются"
);
ok(
  new Set(resolutions.map((resolution) => resolution.resolved?.configurationId)).size === 3,
  "идентичность: три разных конфига → три разных configurationId"
);
ok(
  resolutions.every((resolution) =>
    /^[0-9a-f]{64}$/.test(String(resolution.resolved?.configurationId))
  ),
  "идентичность: configurationId — sha256 hex"
);
ok(
  RECORD.variants.map((item) => item.configurationId).join(",") ===
    resolutions.map((resolution) => String(resolution.resolved?.configurationId)).join(","),
  "идентичность: configurationId в записи совпадают с вычисленными"
);
ok(
  resolveVariants(input().variants, fingerprintA)[0].resolved?.configurationId ===
    resolutions[0].resolved?.configurationId,
  "идентичность: вычисление воспроизводимо"
);

const baseResolved = resolutions[0].resolved;

ok(baseResolved !== null, "идентичность: базовый вариант разрешён");

if (baseResolved !== null) {
  const idOf = (args: {
    label?: string;
    paramsFingerprint?: string;
    configFingerprint?: string;
    subjectFingerprint?: string;
    signalSource?: typeof baseResolved.signalSource;
  }) =>
    configurationIdOf({
      subjectFingerprint: args.subjectFingerprint ?? fingerprintA,
      label: args.label ?? baseResolved.label,
      paramsFingerprint: args.paramsFingerprint ?? baseResolved.paramsFingerprint,
      configFingerprint: args.configFingerprint ?? baseResolved.configFingerprint,
      signalSource: args.signalSource ?? baseResolved.signalSource
    });

  ok(idOf({}) === baseResolved.configurationId, "идентичность: пересчёт совпадает");
  ok(
    idOf({ label: "timeout-3-renamed" }) !== baseResolved.configurationId,
    "идентичность: метка входит в идентичность"
  );
  ok(
    idOf({ paramsFingerprint: fingerprintParams({ label: "other" }) }) !==
      baseResolved.configurationId,
    "идентичность: параметры входят в идентичность"
  );
  ok(
    idOf({ configFingerprint: baseResolved.configFingerprint.slice(0, 63) + "0" }) !==
      baseResolved.configurationId,
    "идентичность: конфиг P2-A входит в идентичность"
  );
  ok(
    idOf({ subjectFingerprint: fingerprintC }) !== baseResolved.configurationId,
    "идентичность: рынок входит в идентичность (кросс-рыночная подмена невозможна)"
  );
  ok(
    idOf({ subjectFingerprint: fingerprintD }) !== baseResolved.configurationId,
    "идентичность: таймфрейм входит в идентичность"
  );
  ok(
    idOf({ subjectFingerprint: fingerprintE }) !== baseResolved.configurationId,
    "идентичность: диапазон данных входит в идентичность"
  );
  ok(
    idOf({ subjectFingerprint: fingerprintB }) !== baseResolved.configurationId,
    "идентичность: версия стратегии входит в идентичность"
  );
  ok(
    idOf({
      signalSource: {
        kind: "list",
        length: LIST.length,
        fingerprint: fingerprintParams({ other: true })
      }
    }) !== baseResolved.configurationId,
    "идентичность: источник решений входит в идентичность"
  );
  ok(
    fingerprintParams({ a: 1, b: [1, 2] }) === fingerprintParams({ b: [1, 2], a: 1 }),
    "идентичность: отпечаток параметров не зависит от порядка ключей"
  );
  ok(
    fingerprintParams({ a: 1 }) !== fingerprintParams({ a: 2 }),
    "идентичность: отпечаток параметров чувствителен к значению"
  );
}

/* --- источник решений --- */

const listSource = describeSignalSource(LIST, undefined);

ok(listSource.ok === true, "источник: список решений разрешается без signalSourceId");
ok(
  listSource.ok &&
    listSource.descriptor.kind === "list" &&
    listSource.descriptor.length === LIST.length,
  "источник: для списка фиксируются длина и отпечаток"
);

const providerNoId = describeSignalSource(() => null, undefined);

ok(providerNoId.ok === false, "источник: провайдер без signalSourceId отклоняется");
ok(
  !providerNoId.ok &&
    providerNoId.errors.some((error) => error.includes("signalSourceId")),
  "источник: причина отказа провайдера названа явно"
);

const providerWithId = describeSignalSource(() => null, "smc-provider@1.4.0");

ok(providerWithId.ok === true, "источник: провайдер с signalSourceId разрешается");
ok(
  providerWithId.ok &&
    providerWithId.descriptor.kind === "provider" &&
    providerWithId.descriptor.signalSourceId === "smc-provider@1.4.0",
  "источник: идентичность провайдера сохраняется"
);
ok(
  describeSignalSource("not-a-source" as unknown as SignalDecisionList, undefined).ok ===
    false,
  "источник: не-список и не-функция отклоняются"
);
ok(
  canonicalJson(
    providerWithId.ok ? providerWithId.descriptor : null
  ).includes("smc-provider@1.4.0"),
  "источник: дескриптор сериализуем (в отличие от самой функции)"
);

/* ------------------------------------------------------------------ */
/* 4. Разрешение вариантов и отклонения                                */
/* ------------------------------------------------------------------ */

const mixed = resolveVariants(
  [
    variant("ok-1", { timeoutBars: 3 }),
    variant("bad-config", { timeoutBars: 0 }),
    variant("no-source-id", { timeoutBars: 3 }, { signals: () => null }),
    variant("with-source-id", { timeoutBars: 3 }, { signals: () => null, signalSourceId: "p@1" }),
    variant("ok-1", { timeoutBars: 3 }),
    null as unknown as VariantDefinition,
    variant("", { timeoutBars: 3 }),
    variant("bad-params", { timeoutBars: 3 }, {
      params: { fn: () => 1 } as unknown as Record<string, unknown>
    })
  ],
  fingerprintA
);

ok(mixed.length === 8, "разрешение: число записей равно числу объявленных вариантов");
ok(
  mixed.map((item) => item.inputOrder).join(",") === "0,1,2,3,4,5,6,7",
  "разрешение: порядок входа сохранён"
);
ok(
  mixed[0].rejection === null && mixed[3].rejection === null,
  "разрешение: валидные варианты разрешаются"
);
ok(
  mixed[1].resolved === null && mixed[1].rejection?.reason === "invalid-config",
  "разрешение: невалидный конфиг P2-A → invalid-config"
);
ok(
  mixed[1].rejection?.stage === "config" &&
    (mixed[1].rejection?.errors.length ?? 0) > 0,
  "разрешение: у отказа конфига есть стадия и текст ошибки P2-A"
);
ok(
  mixed[2].rejection?.reason === "missing-signal-source-id",
  "разрешение: провайдер без идентичности → missing-signal-source-id"
);
ok(
  mixed[4].rejection?.reason === "duplicate-configuration-id",
  "разрешение: повтор идентичной конфигурации → duplicate-configuration-id"
);
ok(
  mixed[4].rejection !== null && mixed[0].rejection === null,
  "разрешение: при дубликате оценивается ПЕРВЫЙ, а не последний"
);
ok(
  mixed[4].rejection?.errors.some((error) =>
    error.includes(String(mixed[0].resolved?.configurationId))
  ) === true,
  "разрешение: в причине дубликата назван конфликтующий configurationId"
);
ok(
  mixed[5].rejection?.reason === "invalid-variant",
  "разрешение: не-объект → invalid-variant"
);
ok(
  mixed[6].rejection?.reason === "invalid-variant",
  "разрешение: пустая метка → invalid-variant"
);
ok(
  mixed[7].rejection?.reason === "invalid-variant" &&
    mixed[7].rejection?.errors.some((error) => error.includes("params")) === true,
  "разрешение: несериализуемые параметры → invalid-variant с указанием params"
);
ok(
  mixed.every((item) => item.rejection !== null || item.resolved !== null),
  "разрешение: каждый вариант либо разрешён, либо отклонён с записью"
);
ok(
  mixed.filter((item) => item.rejection !== null).length === 6,
  "разрешение: отказ одного варианта не прерывает разрешение остальных (6 отклонены, 2 разрешены)"
);
ok(
  mixed.filter((item) => item.resolved !== null).length === 2,
  "разрешение: валидные варианты разрешены несмотря на отказы соседей"
);

/* ------------------------------------------------------------------ */
/* 5. Порядок представления                                            */
/* ------------------------------------------------------------------ */

ok(validateOrderPolicy("input-order").length === 0, "порядок: input-order допустим");
ok(
  validateOrderPolicy("configuration-id").length === 0,
  "порядок: configuration-id допустим"
);

for (const forbidden of [
  "by-profit-factor",
  "by-net-pnl",
  "best-first",
  "by-win-rate",
  "random",
  ""
]) {
  ok(
    validateOrderPolicy(forbidden).length > 0,
    `порядок: "${forbidden}" запрещён (не зависит от результата)`
  );
}

ok(
  validateOrderPolicy("by-profit-factor")[0].includes("не должен зависеть от результата"),
  "порядок: причина запрета результат-зависимого порядка объяснена"
);

const inputOrderPolicy = mustRun(runExperiment(input({ orderPolicy: "input-order" })));
const idOrderPolicy = mustRun(
  runExperiment(input({ orderPolicy: "configuration-id" }))
);

ok(
  inputOrderPolicy.variants.map((item) => item.label).join(",") ===
    "timeout-3,timeout-6,no-timeout",
  "порядок: input-order сохраняет объявленную последовательность"
);
ok(
  inputOrderPolicy.variants.map((item) => item.inputOrder).join(",") === "0,1,2",
  "порядок: inputOrder сохранён для каждой строки"
);
ok(
  inputOrderPolicy.variants.map((item) => item.presentationOrder).join(",") === "0,1,2",
  "порядок: presentationOrder плотный и начинается с 0"
);

const nets = inputOrderPolicy.variants
  .map((item) => item.segments?.TRAIN.report?.netPnl ?? null)
  .filter((value): value is number => value !== null);
const bestLabel = expectedOrderBy(
  inputOrderPolicy.variants.map((item) => ({
    label: item.label,
    configurationId: item.configurationId,
    selectionKey: item.selectionKey,
    inputOrder: item.inputOrder,
    value: item.segments?.TRAIN.report?.netPnl ?? null
  }))
)[0];

ok(
  nets.length === 3,
  "порядок: у всех трёх конфигураций есть TRAIN-результат (фикстура рабочая)"
);
ok(
  inputOrderPolicy.variants[0].label !== bestLabel,
  "порядок: лучшая по TRAIN конфигурация НЕ оказывается первой автоматически"
);
ok(
  idOrderPolicy.variants
    .map((item) => item.configurationId)
    .every((id, index, all) => index === 0 || all[index - 1] < id),
  "порядок: configuration-id даёт лексикографически возрастающую последовательность"
);
ok(
  idOrderPolicy.variants.map((item) => item.presentationOrder).join(",") === "0,1,2",
  "порядок: presentationOrder пересчитывается под политику"
);
ok(
  new Set(idOrderPolicy.variants.map((item) => item.inputOrder)).size === 3,
  "порядок: inputOrder не теряется при перестановке"
);
ok(
  canonicalJson(
    idOrderPolicy.variants.map((item) => item.configurationId)
  ) ===
    canonicalJson(
      [...inputOrderPolicy.variants]
        .map((item) => item.configurationId)
        .sort()
    ),
  "порядок: configuration-id — это сортировка того же множества идентичностей"
);
ok(
  mustRun(runExperiment(input({ orderPolicy: "configuration-id" }))).variants
    .map((item) => item.configurationId)
    .join(",") === idOrderPolicy.variants.map((item) => item.configurationId).join(","),
  "порядок: configuration-id детерминирован при повторе"
);

const badOrder = runExperiment(
  input({ orderPolicy: "by-profit-factor" as unknown as PresentationOrderPolicy })
);

ok(badOrder.ok === false, "порядок: результат-зависимая политика отвергает эксперимент");
ok(
  !badOrder.ok && badOrder.stage === "policy",
  "порядок: отказ результат-зависимого порядка — на стадии policy"
);

const orderedById = applyPresentationOrder(inputOrderPolicy.variants, "configuration-id");
const orderedByInput = applyPresentationOrder(idOrderPolicy.variants, "input-order");

ok(
  orderedById.map((item) => item.configurationId).join(",") ===
    idOrderPolicy.variants.map((item) => item.configurationId).join(","),
  "порядок: applyPresentationOrder(configuration-id) совпадает с прогоном"
);
ok(
  orderedByInput.map((item) => item.label).join(",") === "timeout-3,timeout-6,no-timeout",
  "порядок: applyPresentationOrder(input-order) восстанавливает порядок входа"
);
ok(
  inputOrderPolicy.variants.map((item) => item.presentationOrder).join(",") === "0,1,2",
  "порядок: исходная запись не мутируется применением порядка"
);

/* ------------------------------------------------------------------ */
/* 6. Политика выбора: валидация                                       */
/* ------------------------------------------------------------------ */

ok(
  validateSelectionPolicy({ kind: "none" }).length === 0,
  "выбор: политика none допустима"
);
ok(
  validateSelectionPolicy({
    kind: "rank-only",
    stage: "TRAIN",
    criteria: ["netPnl"]
  }).length === 0,
  "выбор: rank-only по TRAIN допустим"
);
ok(
  validateSelectionPolicy({
    kind: "select-by-rank",
    stage: "VALIDATION",
    criteria: ["profitFactor", "maxRealizedDrawdownPct"]
  }).length === 0,
  "выбор: select-by-rank по VALIDATION допустим"
);

const oosPolicy = validateSelectionPolicy({
  kind: "select-by-rank",
  stage: "OOS" as unknown as SelectionStage,
  criteria: ["netPnl"]
});

ok(oosPolicy.length > 0, "выбор: stage=OOS отклоняется");
ok(
  oosPolicy.some((error) => error.includes("OOS")),
  "выбор: причина отказа stage=OOS названа явно"
);
ok(
  validateSelectionPolicy({
    kind: "rank-only",
    stage: "OOS" as unknown as SelectionStage,
    criteria: ["netPnl"]
  }).length > 0,
  "выбор: stage=OOS отклоняется и для rank-only"
);
ok(
  validateSelectionPolicy({
    kind: "select-by-rank",
    stage: "TEST" as unknown as SelectionStage,
    criteria: ["netPnl"]
  }).length > 0,
  "выбор: неизвестная стадия отклоняется"
);
ok(
  validateSelectionPolicy({
    kind: "select-by-rank",
    stage: "TRAIN",
    criteria: ["sharpe" as unknown as RankingCriterion]
  }).length > 0,
  "выбор: критерий вне закрытого набора отклоняется (Sharpe в P2-A нет)"
);
ok(
  validateSelectionPolicy({
    kind: "select-by-rank",
    stage: "TRAIN",
    criteria: ["netPnl", "netPnl"]
  }).length > 0,
  "выбор: дубликат критерия отклоняется"
);
ok(
  validateSelectionPolicy({
    kind: "select-by-rank",
    stage: "TRAIN",
    criteria: []
  }).length > 0,
  "выбор: пустой набор критериев отклоняется"
);
ok(
  validateSelectionPolicy({
    kind: "optimize" as unknown as SelectionPolicy["kind"],
    stage: "TRAIN",
    criteria: ["netPnl"]
  } as unknown as SelectionPolicy).length > 0,
  "выбор: неизвестный вид политики отклоняется (оптимизатора нет)"
);

const oosRun = runExperiment(
  input({
    selectionPolicy: {
      kind: "select-by-rank",
      stage: "OOS" as unknown as SelectionStage,
      criteria: ["netPnl"]
    }
  })
);

ok(oosRun.ok === false, "выбор: эксперимент с stage=OOS не выполняется");
ok(
  !oosRun.ok && oosRun.stage === "policy",
  "выбор: отказ OOS-политики происходит до любых расчётов"
);

/* ------------------------------------------------------------------ */
/* 7. Ранжирование                                                     */
/* ------------------------------------------------------------------ */

const ranked = mustRun(
  runExperiment(
    input({
      selectionPolicy: {
        kind: "rank-only",
        stage: "TRAIN",
        criteria: ["netPnl", "profitFactor"]
      }
    })
  )
);
const ranking = ranked.selection.ranking;

ok(ranking !== null, "ранжирование: rank-only создаёт запись ранжирования");
ok(
  ranked.selection.performed === false &&
    ranked.selection.selectedConfigurationId === null,
  "ранжирование: rank-only НЕ выбирает конфигурацию"
);
ok(
  ranking !== null && ranking.oosConsulted === false,
  "ранжирование: oosConsulted константно false"
);
ok(
  ranking !== null && ranking.stage === "TRAIN",
  "ранжирование: стадия зафиксирована"
);
ok(
  ranking !== null && ranking.criteria.join(",") === "netPnl,profitFactor",
  "ранжирование: критерии сохранены в заявленном порядке"
);

/**
 * Независимая формулировка ожидаемого порядка: значение по убыванию,
 * null — всегда последний, при равенстве — лексикографика OOS-СЛЕПОГО
 * selectionKey, при коллизии ключа — порядок объявления (inputOrder).
 * Полная configurationId (включает OOS-часть объявленного входа) и
 * presentationOrder тай-брейком не являются. Тест задаёт правило сам,
 * а не копирует реализацию.
 */
function tieBreakLessThen(
  a: { selectionKey: string; inputOrder: number },
  b: { selectionKey: string; inputOrder: number }
): number {
  if (a.selectionKey !== b.selectionKey) {
    return a.selectionKey < b.selectionKey ? -1 : 1;
  }

  return a.inputOrder - b.inputOrder;
}

function expectedOrderBy(
  variants: readonly {
    label: string;
    configurationId: string;
    selectionKey: string;
    inputOrder: number;
    value: number | null;
  }[]
): string[] {
  return [...variants]
    .sort((a, b) => {
      if (a.value === null && b.value === null) {
        return tieBreakLessThen(a, b);
      }

      if (a.value === null) {
        return 1;
      }

      if (b.value === null) {
        return -1;
      }

      if (a.value !== b.value) {
        return b.value - a.value;
      }

      return tieBreakLessThen(a, b);
    })
    .map((item) => item.label);
}

const expectedOrder = expectedOrderBy(
  ranked.variants.map((item) => ({
    label: item.label,
    configurationId: item.configurationId,
    selectionKey: item.selectionKey,
    inputOrder: item.inputOrder,
    value: item.segments?.TRAIN.report?.netPnl ?? null
  }))
);

ok(
  ranking !== null &&
    ranking.order.map((entry) => entry.label).join(",") === expectedOrder.join(","),
  "ранжирование: порядок по netPnl убывающий (направление зафиксировано)"
);
ok(
  ranking !== null &&
    ranking.order.every(
      (entry, index) => entry.rank === index
    ),
  "ранжирование: rank — плотная последовательность с 0"
);
ok(
  ranking !== null &&
    ranking.order.every(
      (entry) => entry.values.netPnl !== undefined
    ),
  "ранжирование: значения запрошенных критериев сохранены"
);
ok(
  ranking !== null &&
    ranking.order.every((entry) => entry.values.medianR === undefined),
  "ранжирование: незапрошенные критерии не добавляются"
);
ok(
  ranking !== null && ranking.excludedFromRanking.length === 0,
  "ранжирование: при всех оценённых вариантах исключений нет"
);

const byPfOnly = mustRun(
  runExperiment(
    input({
      selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["profitFactor"] }
    })
  )
);
const pfOrder = (byPfOnly.selection.ranking?.order ?? [])
  .map((entry) => entry.values.profitFactor ?? null);

ok(
  pfOrder.every(
    (value, index) => index === 0 || (pfOrder[index - 1] ?? -1) >= (value ?? -1)
  ),
  "ранжирование: порядок по profitFactor убывающий"
);

const byDrawdown = mustRun(
  runExperiment(
    input({
      selectionPolicy: {
        kind: "rank-only",
        stage: "TRAIN",
        criteria: ["maxRealizedDrawdownPct"]
      }
    })
  )
);
const ddOrder = (byDrawdown.selection.ranking?.order ?? []).map(
  (entry) => entry.values.maxRealizedDrawdownPct ?? null
);

ok(
  ddOrder.every(
    (value, index) => index === 0 || (ddOrder[index - 1] ?? Infinity) <= (value ?? Infinity)
  ),
  "ранжирование: порядок по просадке ВОЗРАСТАЮЩИЙ (меньше просадка — лучше)"
);

const selected = mustRun(
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

ok(
  selected.selection.performed === true,
  "выбор: select-by-rank выполняет выбор"
);
ok(
  selected.selection.selectedConfigurationId ===
    selected.selection.ranking?.order[0].configurationId,
  "выбор: выбрана конфигурация из вершины ЯВНОГО ранжирования"
);
ok(
  selected.selection.selectedLabel === expectedOrder[0],
  "выбор: выбрана лучшая по TRAIN конфигурация"
);
ok(
  selected.selection.rationale.includes("TRAIN") &&
    selected.selection.rationale.includes("OOS не читался"),
  "выбор: обоснование называет стадию и факт невмешательства OOS"
);

const validationSelected = mustRun(
  runExperiment(
    input({
      selectionPolicy: {
        kind: "select-by-rank",
        stage: "VALIDATION",
        criteria: ["netPnl"]
      }
    })
  )
);
const validationBest = expectedOrderBy(
  validationSelected.variants.map((item) => ({
    label: item.label,
    configurationId: item.configurationId,
    selectionKey: item.selectionKey,
    inputOrder: item.inputOrder,
    value: item.segments?.VALIDATION.report?.netPnl ?? null
  }))
)[0];

ok(
  validationSelected.selection.selectedLabel === validationBest,
  "выбор: stage=VALIDATION ранжирует по VALIDATION-свидетельствам"
);
ok(
  validationSelected.selection.ranking?.stage === "VALIDATION",
  "выбор: стадия ранжирования записана"
);

/* --- null всегда последний, tie-break детерминирован --- */

const zeroTradeList = decisionList(BARS, 4, 4, 36);
const nullRanking = mustRun(
  runExperiment(
    input({
      variants: [
        variant("only-train", { timeoutBars: 3, warmupBars: 3 }, { signals: zeroTradeList }),
        variant("all-segments", { timeoutBars: 3, warmupBars: 3 })
      ],
      selectionPolicy: {
        kind: "rank-only",
        stage: "VALIDATION",
        criteria: ["profitFactor"]
      }
    })
  )
);
const nullOrder = nullRanking.selection.ranking?.order ?? [];
const nullPf = nullOrder.map((entry) => entry.values.profitFactor ?? null);

ok(nullOrder.length === 2, "ранжирование: оба варианта участвуют");
ok(
  nullPf[0] !== null && nullPf[1] === null,
  "ранжирование: PF=null (нет сделок) оказывается ПОСЛЕДНИМ — отсутствие свидетельства не побеждает"
);
ok(
  nullOrder[1].label === "only-train",
  "ранжирование: вариант без сделок в VALIDATION оказался последним"
);

/**
 * Tie-фикстура: ДВЕ РАЗНЫЕ идентичности (метки отличаются) при ОДИНАКОВОМ
 * конфиге и одинаковом источнике решений ⇒ все метрики совпадают ⇒
 * порядок определяет только tie-break по configurationId.
 */
const tieRunA = mustRun(
  runExperiment(
    input({
      variants: [
        variant("tie-a", { timeoutBars: 3, warmupBars: 3 }),
        variant("tie-b", { timeoutBars: 3, warmupBars: 3 })
      ],
      selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["trades"] }
    })
  )
);

ok(
  tieRunA.variants.length === 2 &&
    tieRunA.variants[0].configurationId !== tieRunA.variants[1].configurationId,
  "tie-break: разные метки при одинаковом конфиге — разные идентичности"
);
ok(
  tieRunA.variants[0].configFingerprint === tieRunA.variants[1].configFingerprint,
  "tie-break: конфиг P2-A у tie-вариантов идентичен"
);

const tieRanking = tieRunA.selection.ranking;
const tieValues = (tieRanking?.order ?? []).map((entry) => entry.values.trades ?? null);

ok(
  tieRanking !== null && tieValues[0] === tieValues[1],
  "tie-break: фикстура действительно даёт равные значения критерия"
);
ok(
  tieRanking !== null && tieRanking.order[1].tieBreakApplied === true,
  "tie-break: факт применения tie-break записан"
);
ok(
  tieRanking !== null && tieRanking.order[0].tieBreakApplied === false,
  "tie-break: первая позиция tie-break не применяет"
);
ok(
  tieRanking !== null &&
    tieRanking.order[0].selectionKey < tieRanking.order[1].selectionKey,
  "tie-break: равные значения упорядочены по OOS-слепому selectionKey"
);
ok(
  tieRanking !== null &&
    tieRanking.order[0].selectionKey !==
      tieRanking.order[0].configurationId &&
    tieRanking.tieBreak.key === "selection-key" &&
    tieRanking.tieBreak.oosBlind === true &&
    tieRanking.tieBreak.fallback === "input-order",
  "tie-break: контракт тай-брейка объявлен машиночитаемо (selection-key, OOS-слепой)"
);
ok(
  mustRun(
    runExperiment(
      input({
        variants: [
          variant("tie-b", { timeoutBars: 3, warmupBars: 3 }),
          variant("tie-a", { timeoutBars: 3, warmupBars: 3 })
        ],
        selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["trades"] }
      })
    )
  ).selection.ranking?.order.map((entry) => entry.selectionKey).join(",") ===
    (tieRanking?.order.map((entry) => entry.selectionKey).join(",") ?? ""),
  "tie-break: порядок не зависит от порядка объявления при равенстве"
);

/* --- отклонённые исключаются из ранжирования, но остаются в отчёте --- */

const withRejected = mustRun(
  runExperiment(
    input({
      variants: [
        variant("ok", { timeoutBars: 3, warmupBars: 3 }),
        variant("bad-config", { timeoutBars: 0 }),
        variant("no-source-id", { timeoutBars: 4 }, { signals: () => null })
      ],
      selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["netPnl"] }
    })
  )
);

ok(
  withRejected.counts.declared === 3 &&
    withRejected.counts.evaluated === 1 &&
    withRejected.counts.rejected === 2,
  "ранжирование: счётчики разделяют оценённые и отклонённые"
);
ok(
  withRejected.selection.ranking?.order.length === 1,
  "ранжирование: в порядке только оценённые варианты"
);
ok(
  withRejected.selection.ranking?.excludedFromRanking.length === 2,
  "ранжирование: отклонённые перечислены в исключениях"
);
ok(
  (withRejected.selection.ranking?.excludedFromRanking ?? [])
    .map((item) => item.reason)
    .sort()
    .join(",") === "invalid-config,missing-signal-source-id",
  "ранжирование: причины исключения сохранены"
);
ok(
  withRejected.variants.length === 3,
  "ранжирование: отклонённые НЕ удалены из отчёта"
);

/* --- независимость ранжирования от OOS --- */

const independence = assertRankingIndependentOfOos(
  tieRanking ?? rankEvidence("TRAIN", [], ["trades"]),
  {
    trainSelection: tieRunA.evidence.trainSelection,
    validationConfirmation: tieRunA.evidence.validationConfirmation
  }
);

ok(independence.ok === true, "OOS-изоляция: записанный порядок воспроизводится из TRAIN");
ok(independence.errors.length === 0, "OOS-изоляция: ошибок воспроизведения нет");

const tampered = {
  ...(tieRanking ?? rankEvidence("TRAIN", [], ["trades"])),
  order: [
    ...(tieRanking?.order ?? []).slice().reverse()
  ]
};
const tamperedCheck = assertRankingIndependentOfOos(tampered, {
  trainSelection: tieRunA.evidence.trainSelection,
  validationConfirmation: tieRunA.evidence.validationConfirmation
});

ok(
  tamperedCheck.ok === false,
  "OOS-изоляция: подменённый порядок НЕ воспроизводится из TRAIN-свидетельств"
);
ok(
  tamperedCheck.errors.some((error) =>
    error.toLowerCase().includes("не воспроизводится")
  ),
  "OOS-изоляция: причина отказа названа явно"
);
ok(
  assertRankingIndependentOfOos(
    { ...(tieRanking ?? rankEvidence("TRAIN", [], ["trades"])), oosConsulted: true as false },
    {
      trainSelection: tieRunA.evidence.trainSelection,
      validationConfirmation: tieRunA.evidence.validationConfirmation
    }
  ).ok === false,
  "OOS-изоляция: oosConsulted=true отклоняется"
);
ok(
  assertRankingIndependentOfOos(
    {
      ...(tieRanking ?? rankEvidence("TRAIN", [], ["trades"])),
      stage: "OOS" as unknown as SelectionStage
    },
    {
      trainSelection: tieRunA.evidence.trainSelection,
      validationConfirmation: tieRunA.evidence.validationConfirmation
    }
  ).ok === false,
  "OOS-изоляция: ranking.stage=OOS отклоняется"
);

const emptyRanking = rankEvidence("TRAIN", [], ["netPnl"]);

ok(
  emptyRanking.order.length === 0 && emptyRanking.oosConsulted === false,
  "ранжирование: пустой блок свидетельств даёт пустой порядок"
);

const manualRanking = rankEvidence(
  "VALIDATION",
  buildEvidenceBlocks(withRejected.variants).validationConfirmation,
  ["trades", "maxConsecutiveLosses"]
);

ok(
  manualRanking.order.length === 1 &&
    manualRanking.excludedFromRanking.length === 2,
  "ранжирование: rankEvidence воспроизводит состав участников"
);

/* ------------------------------------------------------------------ */
/* 8. Разделённость блоков свидетельств                                */
/* ------------------------------------------------------------------ */

const blocks = buildEvidenceBlocks(RECORD.variants);

ok(
  blocks.trainSelection.length === RECORD.variants.length &&
    blocks.validationConfirmation.length === RECORD.variants.length &&
    blocks.oosFinal.length === RECORD.variants.length,
  "свидетельства: каждый блок содержит ВСЕ варианты"
);
ok(
  blocks.trainSelection.every((entry, index) => {
    const report = RECORD.variants[index].segments?.TRAIN.report ?? null;

    return (
      entry.metrics?.trades === (report === null ? undefined : report.trades) &&
      entry.configurationId === RECORD.variants[index].configurationId
    );
  }),
  "свидетельства: блок TRAIN соответствует TRAIN-отчётам"
);
ok(
  blocks.oosFinal.every((entry, index) => {
    const report = RECORD.variants[index].segments?.OOS.report ?? null;

    return entry.metrics?.netPnl === (report === null ? undefined : report.netPnl);
  }),
  "свидетельства: блок OOS соответствует OOS-отчётам"
);
ok(
  blocks.trainSelection.some((entry) => entry.metrics?.trades === 8) &&
    blocks.oosFinal.some((entry) => entry.metrics?.trades === 3),
  "свидетельства: блоки действительно содержат разные сегменты (фикстура)"
);
ok(
  canonicalJson(blocks.trainSelection) !== canonicalJson(blocks.oosFinal),
  "свидетельства: TRAIN и OOS — разные данные (не копия)"
);
ok(
  RECORD.evidence.trainSelection.length === 3 &&
    RECORD.evidence.oosFinal.length === 3,
  "свидетельства: запись эксперимента несёт все три блока"
);

const trainReport = VIEW.rows[0].train;

ok(trainReport !== null, "проекция: TRAIN-отчёт существует");
ok(
  trainReport !== null && trainReport.provenance === METRICS_PROVENANCE,
  "проекция: каждый сегментный отчёт помечен provenance"
);

const evidenceKeys =
  trainReport === null ? [] : Object.keys(projectEvidence(trainReport)).sort();

ok(
  evidenceKeys.join(",") ===
    [
      "avgR",
      "avgRActualFill",
      "expectancy",
      "grossPnl",
      "maxAdverseExcursionDrawdown",
      "maxAdverseExcursionDrawdownPct",
      "maxConsecutiveLosses",
      "maxMtmDrawdown",
      "maxRealizedDrawdown",
      "maxRealizedDrawdownPct",
      "medianR",
      "medianRActualFill",
      "netPnl",
      "profitFactor",
      "profitFactorState",
      "trades",
      "winRate"
    ].join(","),
  "свидетельства: набор полей EvidenceMetrics закрыт и известен"
);
ok(
  RANKING_CRITERIA.every((criterion) =>
    evidenceKeys.includes(criterion)
  ),
  "свидетельства: каждый критерий ранжирования — поле EvidenceMetrics"
);
ok(
  !evidenceKeys.includes("sharpe") && !evidenceKeys.includes("sortino"),
  "свидетельства: Sharpe/Sortino не добавлены (в P2-A их нет — пересчёт запрещён)"
);

/* ------------------------------------------------------------------ */
/* 9. Нет cherry-picking: 10 объявлено → 10 в отчёте                   */
/* ------------------------------------------------------------------ */

const tenVariants: VariantDefinition[] = [
  variant("cfg-01", { timeoutBars: 1, warmupBars: 3 }),
  variant("cfg-02", { timeoutBars: 2, warmupBars: 3 }),
  variant("cfg-03", { timeoutBars: 3, warmupBars: 3 }),
  variant("cfg-04", { timeoutBars: 4, warmupBars: 3 }),
  variant("cfg-05", { timeoutBars: 5, warmupBars: 3 }),
  variant("cfg-06", { timeoutBars: 6, warmupBars: 2 }),
  variant("cfg-07", { timeoutBars: 7, warmupBars: 0 }),
  variant("cfg-08-bad", { timeoutBars: -1 }),
  variant("cfg-09", { timeoutBars: 3, warmupBars: 3 }, { signals: () => null }),
  variant("cfg-03", { timeoutBars: 3, warmupBars: 3 })
];
const ten = mustRun(
  runExperiment(
    input({
      variants: tenVariants,
      selectionPolicy: {
        kind: "select-by-rank",
        stage: "TRAIN",
        criteria: ["netPnl"]
      }
    })
  )
);
const tenView = buildComparison(ten);

ok(tenVariants.length === 10, "cherry-picking: фикстура объявляет 10 конфигураций");
ok(ten.counts.declared === 10, "cherry-picking: counts.declared = 10");
ok(ten.variants.length === 10, "cherry-picking: 10 объявлено → 10 записей вариантов");
ok(tenView.rows.length === 10, "cherry-picking: 10 объявлено → 10 строк отчёта");
ok(
  ten.counts.evaluated + ten.counts.rejected === 10,
  "cherry-picking: evaluated + rejected = declared"
);
ok(ten.counts.evaluated === 7, "cherry-picking: 7 конфигураций оценено");
ok(ten.counts.rejected === 3, "cherry-picking: 3 конфигурации отклонены");
ok(
  ten.evidence.trainSelection.length === 10 &&
    ten.evidence.validationConfirmation.length === 10 &&
    ten.evidence.oosFinal.length === 10,
  "cherry-picking: все три блока свидетельств содержат 10 записей"
);
ok(
  tenView.rows.filter((row) => row.status === "rejected").length === 3,
  "cherry-picking: отклонённые видны в строках отчёта"
);
ok(
  tenView.rows
    .filter((row) => row.status === "rejected")
    .every((row) => row.rejectionReason !== null && row.rejectionErrors.length > 0),
  "cherry-picking: у каждого отклонённого есть причина и текст ошибки"
);
ok(
  tenView.rows
    .filter((row) => row.status === "rejected")
    .map((row) => row.rejectionReason)
    .sort()
    .join(",") === "duplicate-configuration-id,invalid-config,missing-signal-source-id",
  "cherry-picking: причины отклонения различимы"
);
ok(
  tenView.rows
    .filter((row) => row.status === "rejected")
    .every((row) => row.train === null && row.validation === null && row.oos === null),
  "cherry-picking: у отклонённых нет результатов (они не выдуманы)"
);
ok(
  tenView.rows.map((row) => row.label).join(",") ===
    tenVariants.map((item) => item.label).join(","),
  "cherry-picking: строки идут в порядке объявления (проигравшие не удалены и не переставлены)"
);
ok(
  ten.selection.ranking?.order.length === 7 &&
    ten.selection.ranking?.excludedFromRanking.length === 3,
  "cherry-picking: ранжирование видит 7 оценённых и называет 3 исключённых"
);
ok(
  ten.selection.ranking?.order.every((entry) =>
    ten.variants.some(
      (item) => item.configurationId === entry.configurationId && item.status === "evaluated"
    )
  ) === true,
  "cherry-picking: в ранжировании нет «конфигураций из ниоткуда»"
);

const worstTrain = [...tenView.rows]
  .filter((row) => row.train !== null)
  .sort(
    (a, b) => (a.train?.netPnl ?? 0) - (b.train?.netPnl ?? 0)
  )[0];

ok(
  tenView.rows.some((row) => row.configurationId === worstTrain.configurationId),
  "cherry-picking: худшая по TRAIN конфигурация присутствует в отчёте"
);
ok(
  ten.selection.selectedConfigurationId !== worstTrain.configurationId,
  "cherry-picking: выбран не худший (выбор по netPnl) — sanity-проверка фикстуры"
);

/* ------------------------------------------------------------------ */
/* 10. Отказ эксперимента на уровне данных/субъекта/разбиения          */
/* ------------------------------------------------------------------ */

ok(
  runExperiment(input({ bars: [] })).ok === false,
  "отказ: пустой набор баров отвергается"
);
ok(
  (() => {
    const outcome = runExperiment(input({ bars: [] }));

    return !outcome.ok && outcome.stage === "bars";
  })(),
  "отказ: пустые бары — стадия bars"
);
ok(
  (() => {
    const broken = zigzag(60).map((bar, index) =>
      index === 30 ? { ...bar, high: bar.low - 1 } : bar
    );
    const outcome = runExperiment(input({ bars: broken }));

    return !outcome.ok && outcome.stage === "bars";
  })(),
  "отказ: структурно некорректный бар отвергается P2-A валидацией"
);
ok(
  (() => {
    const outcome = runExperiment(input({ variants: [] }));

    return !outcome.ok && outcome.stage === "variants";
  })(),
  "отказ: эксперимент без конфигураций отвергается"
);
ok(
  (() => {
    const outcome = runExperiment(
      input({ subject: { ...SUBJECT, strategy: { slug: "", version: "" } } })
    );

    return !outcome.ok && outcome.stage === "subject";
  })(),
  "отказ: невалидная идентичность субъекта отвергается"
);
ok(
  (() => {
    const outcome = runExperiment(
      input({ bars: zigzag(20), splitConfig: { minBarsPerSegment: 10 } })
    );

    return !outcome.ok && outcome.stage === "split";
  })(),
  "отказ: слишком короткий ряд для разбиения отвергается (P2-A split)"
);
ok(
  (() => {
    const outcome = runExperiment(
      input({
        splitConfig: {
          trainFraction: 0.5,
          validationFraction: 0.6
        }
      })
    );

    return !outcome.ok && outcome.stage === "split";
  })(),
  "отказ: доли разбиения не суммируются в 1 → стадия split"
);
ok(
  (() => {
    const outcome = runExperiment(
      input({ orderPolicy: "by-win-rate" as unknown as PresentationOrderPolicy })
    );

    return !outcome.ok && outcome.stage === "policy";
  })(),
  "отказ: результат-зависимый порядок → стадия policy"
);

/* ------------------------------------------------------------------ */
/* 11. Разбиение переиспользовано из P2-A (второго алгоритма нет)      */
/* ------------------------------------------------------------------ */

const p2aSplit = chronologicalSplit(BARS.length, undefined, 3);

ok(p2aSplit.ok, "разбиение: P2-A chronologicalSplit применим к фикстуре");
ok(
  p2aSplit.ok &&
    RECORD.split.train.startIndex === p2aSplit.split.train.startIndex &&
    RECORD.split.train.endIndexExclusive === p2aSplit.split.train.endIndexExclusive &&
    RECORD.split.validation.startIndex === p2aSplit.split.validation.startIndex &&
    RECORD.split.validation.endIndexExclusive ===
      p2aSplit.split.validation.endIndexExclusive &&
    RECORD.split.oos.startIndex === p2aSplit.split.oos.startIndex &&
    RECORD.split.oos.endIndexExclusive === p2aSplit.split.oos.endIndexExclusive,
  "разбиение: окна сегментов совпадают с P2-A ПОИНДЕКСНО"
);
ok(
  p2aSplit.ok &&
    canonicalJson(RECORD.split) === canonicalJson(p2aSplit.split),
  "разбиение: запись разбиения байт-в-байт равна P2-A (warmupBars=3)"
);
ok(
  RECORD.split.train.endIndexExclusive === RECORD.split.validation.startIndex &&
    RECORD.split.validation.endIndexExclusive === RECORD.split.oos.startIndex &&
    RECORD.split.oos.endIndexExclusive === BARS.length,
  "разбиение: сегменты стыкуются без дыр и пересечений"
);
ok(
  RECORD.split.warmupStart.VALIDATION <= RECORD.split.validation.startIndex &&
    RECORD.split.warmupStart.OOS <= RECORD.split.oos.startIndex,
  "разбиение: warmup смотрит только в прошлое (каузальный разогрев)"
);
ok(
  mustRun(
    runExperiment(input({ splitConfig: { trainFraction: 0.5, validationFraction: 0.25 } }))
  ).split.train.endIndexExclusive === 30,
  "разбиение: пользовательские доли применяются через P2-A (0.5/0.25/0.25 → 30/15/15)"
);

/* ------------------------------------------------------------------ */
/* 12. Отпечатки входа и записи                                        */
/* ------------------------------------------------------------------ */

const inputFingerprint = fingerprintExperimentInput({
  subject: RECORD.subject,
  subjectFingerprint: RECORD.subjectFingerprint,
  split: RECORD.split,
  orderPolicy: RECORD.orderPolicy,
  selectionPolicy: RECORD.selection.policy,
  configurationIds: RECORD.variants.map((item) => item.configurationId)
});

ok(
  inputFingerprint === RECORD.inputFingerprint,
  "отпечатки: inputFingerprint пересчитывается из записи"
);
ok(
  /^[0-9a-f]{64}$/.test(RECORD.inputFingerprint) &&
    /^[0-9a-f]{64}$/.test(RECORD.resultFingerprint),
  "отпечатки: input/result — sha256 hex"
);
ok(
  fingerprintExperiment(RECORD) === fingerprintExperiment(RECORD),
  "отпечатки: отпечаток записи детерминирован"
);
ok(
  canonicalExperiment(RECORD) === canonicalExperiment(RECORD),
  "отпечатки: каноническая запись байт-в-байт воспроизводима"
);
ok(
  VIEW.reportFingerprint === VIEW.reportFingerprint &&
    /^[0-9a-f]{64}$/.test(VIEW.reportFingerprint),
  "отпечатки: reportFingerprint — sha256 hex"
);
ok(
  RECORD.variants.every((item) =>
    item.segments === null ||
    (["TRAIN", "VALIDATION", "OOS"] as const).every((segment) => {
      const result = item.segments?.[segment].result;

      return (
        result !== null &&
        result !== undefined &&
        item.segments?.[segment].report?.resultFingerprint ===
          fingerprintResult(result)
      );
    })
  ),
  "отпечатки: resultFingerprint каждого сегмента равен P2-A fingerprintResult"
);
ok(
  runExperimentReport(input()).ok === true,
  "прогон: runExperimentReport возвращает запись и отчёт"
);
ok(
  (() => {
    const outcome = runExperimentReport(input());

    return (
      outcome.ok &&
      outcome.view.reportFingerprint === VIEW.reportFingerprint &&
      canonicalJson(outcome.view.rows.map((row) => row.configurationId)) ===
        canonicalJson(VIEW.rows.map((row) => row.configurationId))
    );
  })(),
  "прогон: повторный прогон даёт тот же отпечаток отчёта"
);
ok(
  buildSelectionRecord(DEFAULT_SELECTION_POLICY, {
    trainSelection: RECORD.evidence.trainSelection,
    validationConfirmation: RECORD.evidence.validationConfirmation
  }).ranking === null,
  "выбор: политика none не создаёт ранжирования"
);
ok(
  applyPresentationOrder(RECORD.variants, "input-order").every(
    (item, index) => item.presentationOrder === index
  ),
  "порядок: presentationOrder пересчитывается плотной последовательностью"
);

const evidenceMetricsSample: EvidenceMetrics | null =
  VIEW.trainSelectionEvidence[0].metrics;

ok(
  evidenceMetricsSample !== null &&
    typeof evidenceMetricsSample.trades === "number" &&
    typeof evidenceMetricsSample.maxConsecutiveLosses === "number",
  "свидетельства: метрики TRAIN присутствуют в отчёте сравнения"
);
ok(
  VIEW.oosFinalEvidence.every((entry) => entry.metrics !== undefined),
  "свидетельства: OOS-блок присутствует в отчёте как финальное свидетельство"
);

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
