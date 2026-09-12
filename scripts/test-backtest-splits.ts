/**
 * P2-A — тесты хронологического разбиения и детерминированного вывода
 * (lib/backtest/splits.ts, lib/backtest/serialize.ts).
 *
 * Запуск: npx tsx scripts/test-backtest-splits.ts
 *
 * Ключевые свойства:
 *  - разбиение только хронологическое, сегменты стыкуются без дыр и
 *    пересечений, OOS получает остаток (floor-арифметика детерминирована);
 *  - утечка невозможна: сигнал на последнем баре сегмента отбрасывается
 *    (segment-boundary), открытая позиция закрывается по SEGMENT_END,
 *    вход никогда не исполняется за границей сегмента;
 *  - ПРЕФИКСНОЕ свойство: сделки полного прогона, закрывшиеся до границы
 *    TRAIN, совпадают со сделками TRAIN-прогона ПОЭЛЕМЕНТНО (включая
 *    netPnl) — сегментация не меняет поведение внутри сегмента;
 *  - каждый сегмент стартует с initialEquity (состояние не переносится);
 *  - вывод каноничен и детерминирован: сортировка ключей, 10 знаков,
 *    −0 → 0, sha256-отпечатки (проверено на известных тестовых векторах).
 */

import {
  BACKTEST_SPLIT_DEFAULTS,
  type BacktestBar,
  type BacktestConfig,
  type BacktestTrade,
  type SignalProvider,
  entryDecision,
  noTradeDecision
} from "../lib/backtest/contract";
import { runBacktest } from "../lib/backtest/engine";
import {
  canonicalJson,
  canonicalNumber,
  fingerprintBars,
  fingerprintConfig,
  fingerprintOf,
  fingerprintResult,
  fingerprintRunInput,
  serializeResult,
  sha256Hex
} from "../lib/backtest/serialize";
import {
  SPLIT_NAMES,
  assertNoSegmentLeakage,
  chronologicalSplit,
  isChronological,
  runSegmentedBacktest,
  summarizeSegments
} from "../lib/backtest/splits";

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

function mk(i: number, o: number, h: number, l: number, c: number): BacktestBar {
  return { time: T0 + i * H1, open: o, high: h, low: l, close: c };
}

/** Детерминированная пила: период 7, сумма дрейфа за период = 0. */
function zigzag(count: number): BacktestBar[] {
  const bars: BacktestBar[] = [];
  let price = 100;

  for (let i = 0; i < count; i += 1) {
    const drift = ((i % 7) - 3) * 2;
    const open = price;
    const close = price + drift;

    bars.push(
      mk(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close)
    );
    price = close;
  }

  return bars;
}

/** Провайдер, читающий только три последних закрытых бара. */
const momentumProvider: SignalProvider = (context) => {
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
      low3 - risk * 0.1,
      context.bar.close + risk * 0.5,
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
      high3 + risk * 0.1,
      context.bar.close - risk * 0.5,
      "momentum-down"
    );
  }

  return noTradeDecision("NEUTRAL", "no-momentum");
};

const BARS = zigzag(60);
const CONFIG: BacktestConfig = { timeoutBars: 4, warmupBars: 3 };

function tradeKey(trade: BacktestTrade): string {
  return [
    trade.id,
    trade.signalIndex,
    trade.entryIndex,
    trade.exitIndex,
    trade.plannedEntryPrice,
    trade.plannedExitPrice,
    trade.exitReason,
    trade.netPnl
  ].join("|");
}

/* ------------------------------------------------------------------ */
/* 1. Арифметика разбиения                                             */
/* ------------------------------------------------------------------ */

ok(
  SPLIT_NAMES.join(",") === "TRAIN,VALIDATION,OOS",
  "split: порядок сегментов хронологический и фиксированный"
);
ok(
  BACKTEST_SPLIT_DEFAULTS.trainFraction === 0.6 &&
    BACKTEST_SPLIT_DEFAULTS.validationFraction === 0.2 &&
    BACKTEST_SPLIT_DEFAULTS.minBarsPerSegment === 10,
  "split: дефолты 60/20/20 и минимум 10 баров"
);

const split100 = chronologicalSplit(100);

ok(split100.ok, "split: 100 баров делятся");
ok(
  split100.ok &&
    split100.split.train.startIndex === 0 &&
    split100.split.train.endIndexExclusive === 60,
  "split: TRAIN = [0, 60)"
);
ok(
  split100.ok &&
    split100.split.validation.startIndex === 60 &&
    split100.split.validation.endIndexExclusive === 80,
  "split: VALIDATION = [60, 80)"
);
ok(
  split100.ok &&
    split100.split.oos.startIndex === 80 &&
    split100.split.oos.endIndexExclusive === 100,
  "split: OOS = [80, 100)"
);
ok(
  split100.ok &&
    split100.split.train.name === "TRAIN" &&
    split100.split.validation.name === "VALIDATION" &&
    split100.split.oos.name === "OOS",
  "split: имена сегментов в окнах"
);

const split101 = chronologicalSplit(101);

ok(
  split101.ok &&
    split101.split.train.endIndexExclusive === 60 &&
    split101.split.validation.endIndexExclusive === 80 &&
    split101.split.oos.endIndexExclusive === 101,
  "split: 101 бар — остаток уходит в OOS (floor(60.6)=60, floor(20.2)=20, OOS=21)"
);

const split60 = chronologicalSplit(60, undefined, 3);

ok(
  split60.ok &&
    split60.split.train.endIndexExclusive === 36 &&
    split60.split.validation.endIndexExclusive === 48 &&
    split60.split.oos.endIndexExclusive === 60,
  "split: 60 баров → 36/12/12"
);
ok(
  split60.ok &&
    split60.split.warmupStart.TRAIN === 0 &&
    split60.split.warmupStart.VALIDATION === 33 &&
    split60.split.warmupStart.OOS === 45,
  "split: warmupStart = max(0, start − warmupBars)"
);

const split200 = chronologicalSplit(200, {
  trainFraction: 0.5,
  validationFraction: 0.25,
  minBarsPerSegment: 10
});

ok(
  split200.ok &&
    split200.split.train.endIndexExclusive === 100 &&
    split200.split.validation.endIndexExclusive === 150 &&
    split200.split.oos.endIndexExclusive === 200,
  "split: настраиваемые доли 50/25/25"
);

if (split100.ok) {
  const { train, validation, oos } = split100.split;

  ok(
    train.endIndexExclusive === validation.startIndex,
    "split: TRAIN и VALIDATION стыкуются без дыр и пересечений"
  );
  ok(
    validation.endIndexExclusive === oos.startIndex,
    "split: VALIDATION и OOS стыкуются без дыр и пересечений"
  );
  ok(oos.endIndexExclusive === 100, "split: покрытие до последнего бара");
  ok(train.startIndex === 0, "split: TRAIN начинается с нуля");
  ok(
    train.endIndexExclusive - train.startIndex +
      (validation.endIndexExclusive - validation.startIndex) +
      (oos.endIndexExclusive - oos.startIndex) ===
      100,
    "split: сумма длин сегментов = barsCount"
  );
}

/* ---------- ошибки разбиения ---------- */

const smallSplit = chronologicalSplit(20);

ok(!smallSplit.ok, "split: 20 баров при минимуме 10 — отказ");
ok(
  !smallSplit.ok &&
    smallSplit.errors.some((error) => error.includes("VALIDATION")),
  "split: отказ называет сегмент, которому не хватило баров"
);
ok(
  chronologicalSplit(100, { trainFraction: 0.7, validationFraction: 0.4 }).ok ===
    false,
  "split: trainFraction + validationFraction ≥ 1 отклонён (OOS обязан быть)"
);
ok(
  chronologicalSplit(100, { trainFraction: 1 }).ok === false,
  "split: trainFraction = 1 отклонён"
);
ok(
  chronologicalSplit(100, { trainFraction: 0 }).ok === false,
  "split: trainFraction = 0 отклонён"
);
ok(
  chronologicalSplit(100, { validationFraction: Number.NaN }).ok === false,
  "split: NaN-доля отклонена"
);
ok(
  chronologicalSplit(100, { minBarsPerSegment: 0 }).ok === false,
  "split: minBarsPerSegment < 1 отклонён"
);
ok(chronologicalSplit(100.5).ok === false, "split: дробный barsCount отклонён");
ok(chronologicalSplit(-1).ok === false, "split: отрицательный barsCount отклонён");
ok(
  chronologicalSplit(100, undefined, -1).ok === false,
  "split: отрицательный warmupBars отклонён"
);
ok(
  chronologicalSplit(100, { minBarsPerSegment: 60 }).ok === false,
  "split: завышенный минимум делает разбиение невозможным"
);
ok(
  chronologicalSplit(30, { minBarsPerSegment: 1 }).ok === true,
  "split: явный минимум 1 бар разрешает малые наборы"
);

/* ------------------------------------------------------------------ */
/* 2. Сегментный прогон                                                */
/* ------------------------------------------------------------------ */

const segmented = runSegmentedBacktest({
  bars: BARS,
  signals: momentumProvider,
  config: CONFIG
});

ok(segmented.ok, `split: сегментный прогон успешен (${JSON.stringify(segmented.ok ? "" : segmented.errors)})`);

const trainRun = segmented.ok ? segmented.value.train : null;
const validationRun = segmented.ok ? segmented.value.validation : null;
const oosRun = segmented.ok ? segmented.value.oos : null;
const train = trainRun?.outcome.ok ? trainRun.outcome.result : null;
const validation = validationRun?.outcome.ok ? validationRun.outcome.result : null;
const oos = oosRun?.outcome.ok ? oosRun.outcome.result : null;

ok(train !== null && validation !== null && oos !== null, "split: все три сегмента отработали");
ok(train?.metadata.segment === "TRAIN", "split: метаданные TRAIN");
ok(validation?.metadata.segment === "VALIDATION", "split: метаданные VALIDATION");
ok(oos?.metadata.segment === "OOS", "split: метаданные OOS");
ok(train?.input.signalsEvaluated === 36, "split: TRAIN оценил 36 баров");
ok(validation?.input.signalsEvaluated === 12, "split: VALIDATION оценил 12 баров");
ok(oos?.input.signalsEvaluated === 12, "split: OOS оценил 12 баров");
ok(train?.metadata.barsCount === 36, "split: barsCount TRAIN = 36");
ok(
  train?.metadata.warmupStartIndex === 0 &&
    validation?.metadata.warmupStartIndex === 33 &&
    oos?.metadata.warmupStartIndex === 45,
  "split: warmupStartIndex в метаданных каждого сегмента"
);

/* ---------- границы сегментов ---------- */

ok(
  train?.trades.every((trade) => trade.entryIndex < 36 && trade.exitIndex < 36),
  "boundary: ни одна сделка TRAIN не выходит за индекс 35"
);
ok(
  validation?.trades.every((trade) => trade.signalIndex >= 36 && trade.exitIndex < 48),
  "boundary: все сделки VALIDATION внутри [36, 48)"
);
ok(
  oos?.trades.every((trade) => trade.signalIndex >= 48 && trade.exitIndex < 60),
  "boundary: все сделки OOS внутри [48, 60)"
);
ok(
  train?.trades.every((trade) => trade.entryIndex === trade.signalIndex + 1),
  "boundary: вход всегда на следующем баре после сигнала (TRAIN)"
);
ok(
  validation?.trades.every((trade) => trade.entryIndex === trade.signalIndex + 1) &&
    oos?.trades.every((trade) => trade.entryIndex === trade.signalIndex + 1),
  "boundary: вход всегда на следующем баре после сигнала (VALIDATION, OOS)"
);

const lastTrainTrade = train?.trades[train.trades.length - 1];

ok(
  lastTrainTrade?.exitReason === "SEGMENT_END",
  "boundary: открытая на границе позиция закрыта по SEGMENT_END"
);
ok(
  lastTrainTrade?.exitIndex === 35,
  "boundary: SEGMENT_END исполнен на последнем баре сегмента"
);
ok(
  train?.metrics.openAtEndTrades === 1,
  "boundary: SEGMENT_END учтён в openAtEndTrades"
);
ok(
  train?.metrics.exitReasonCounts.SEGMENT_END === 1,
  "boundary: счётчик причин выхода SEGMENT_END"
);

const boundarySkip = validation?.skippedSignals.find(
  (item) => item.reason === "segment-boundary"
);

ok(
  boundarySkip?.index === 47,
  "boundary: сигнал на последнем баре VALIDATION отброшен (segment-boundary)"
);
ok(
  validation?.trades.every((trade) => trade.signalIndex !== 47),
  "boundary: отброшенный сигнал не стал сделкой через границу"
);
ok(
  oos?.trades[0]?.signalIndex === 48,
  "boundary: OOS начинает торговать со своего первого бара"
);

/* ---------- независимость состояния сегментов ---------- */

ok(
  validation?.equityCurve[0]?.equity === 10_000 &&
    oos?.equityCurve[0]?.equity === 10_000,
  "state: каждый сегмент стартует с initialEquity (состояние не переносится)"
);
ok(
  train !== null &&
    validation !== null &&
    validation.metrics.finalEquity !==
      train.metrics.finalEquity + validation.metrics.totalNetPnl,
  "state: эквити VALIDATION не продолжает эквити TRAIN"
);
ok(
  validation !== null &&
    validation.metrics.finalEquity ===
      10_000 + validation.metrics.totalNetPnl,
  "state: finalEquity сегмента = initialEquity + его собственный netPnl"
);
ok(
  train?.trades[0]?.id === 0 && validation?.trades[0]?.id === 0,
  "state: нумерация сделок в сегменте локальная и детерминированная"
);

/* ---------- префиксное свойство (сегментация не меняет поведение) ---- */

const fullRun = runBacktest({ bars: BARS, signals: momentumProvider, config: CONFIG });
const full = fullRun.ok ? fullRun.result : null;

ok(full !== null, "prefix: полный прогон успешен");

const fullPrefix = (full?.trades ?? []).filter((trade) => trade.exitIndex < 36);
const trainClosed = (train?.trades ?? []).filter(
  (trade) => trade.exitReason !== "SEGMENT_END"
);

ok(
  fullPrefix.length === trainClosed.length && fullPrefix.length > 0,
  `prefix: сравниваемые наборы непустые (${String(fullPrefix.length)} сделок)`
);
ok(
  JSON.stringify(fullPrefix.map(tradeKey)) ===
    JSON.stringify(trainClosed.map(tradeKey)),
  "prefix: сделки полного прогона до границы = сделки TRAIN поэлементно (включая netPnl)"
);

const fullSameSignal = (full?.trades ?? []).find(
  (trade) => trade.signalIndex === lastTrainTrade?.signalIndex
);

ok(
  fullSameSignal !== undefined &&
    lastTrainTrade !== undefined &&
    fullSameSignal.entryIndex === lastTrainTrade.entryIndex &&
    fullSameSignal.entryPrice === lastTrainTrade.entryPrice,
  "prefix: вход сделки на границе идентичен входу полного прогона"
);
ok(
  fullSameSignal !== undefined &&
    lastTrainTrade !== undefined &&
    fullSameSignal.exitIndex > lastTrainTrade.exitIndex,
  "prefix: полный прогон удерживает позицию дальше границы, TRAIN закрывает её на границе"
);
ok(
  (full?.trades.length ?? 0) ===
    (train?.trades.length ?? 0) +
      (validation?.trades.length ?? 0) +
      (oos?.trades.length ?? 0),
  "prefix: суммарное число сделок по сегментам совпадает с полным прогоном на этой фикстуре"
);

/* ---------- отсутствие утечек (инвариант) ---------- */

for (const run of [trainRun, validationRun, oosRun]) {
  if (run !== null && run.outcome.ok) {
    const leakage = assertNoSegmentLeakage(run.outcome.result, run.window);

    ok(
      leakage.ok,
      `leakage: ${run.segment} без утечек (${leakage.errors.join("; ")})`
    );
  }
}

if (train !== null && trainRun !== null) {
  // Отрицательный контроль: суженное окно обязано обнаружить «утечку».
  const wrongWindow = assertNoSegmentLeakage(train, {
    startIndex: 0,
    endIndexExclusive: 30
  });

  ok(
    !wrongWindow.ok,
    "leakage: проверка реально ловит выход за окно (отрицательный контроль)"
  );
  ok(
    wrongWindow.errors.some((error) => error.includes("вне окна")),
    "leakage: ошибка объясняет, что именно вышло за окно"
  );
}

ok(train !== null && isChronological(train.trades), "leakage: сделки TRAIN хронологичны");
ok(
  train !== null && !isChronological([...train.trades].reverse()),
  "leakage: перевёрнутый порядок распознаётся как нехронологический"
);
ok(
  train !== null &&
    validation !== null &&
    train.trades[train.trades.length - 1].exitTime <
      validation.trades[0].entryTime,
  "leakage: сегменты не перекрываются во времени"
);

/* ---------- warmup ---------- */

let warmupReadable = false;
let warmupGuardHeld = false;

runBacktest({
  bars: BARS,
  signals: (context) => {
    try {
      context.barAt(33);
      warmupReadable = true;
    } catch {
      warmupReadable = false;
    }

    try {
      context.barAt(32);
    } catch {
      warmupGuardHeld = true;
    }

    return null;
  },
  config: CONFIG,
  segment: { name: "VALIDATION", startIndex: 36, endIndexExclusive: 48 }
});

ok(warmupReadable, "warmup: чтение 3 баров до начала сегмента разрешено (это прошлое)");
ok(warmupGuardHeld, "warmup: чтение дальше warmup-окна заблокировано");

let warmupBlockedWithoutConfig = false;

runBacktest({
  bars: BARS,
  signals: (context) => {
    try {
      context.barAt(35);
    } catch {
      warmupBlockedWithoutConfig = true;
    }

    return null;
  },
  config: { warmupBars: 0 },
  segment: { name: "VALIDATION", startIndex: 36, endIndexExclusive: 48 }
});

ok(
  warmupBlockedWithoutConfig,
  "warmup: при warmupBars=0 чтение предыдущего сегмента заблокировано"
);

/* ---------- ошибки сегментного прогона ---------- */

const badConfigSegmented = runSegmentedBacktest({
  bars: BARS,
  signals: momentumProvider,
  config: { quantity: 0 }
});

ok(
  !badConfigSegmented.ok && badConfigSegmented.stage === "config",
  "segmented: ошибка конфига проброшена как stage=config"
);

const smallSegmented = runSegmentedBacktest({
  bars: zigzag(20),
  signals: momentumProvider,
  config: CONFIG
});

ok(
  !smallSegmented.ok && smallSegmented.stage === "split",
  "segmented: невозможное разбиение — stage=split"
);

const cheatingProvider: SignalProvider = (context) => {
  const next = context.barAt(context.index + 1);

  return next.close > context.bar.close
    ? entryDecision("LONG", context.bar.low, next.high + 1, "cheat")
    : null;
};
const cheaterSegmented = runSegmentedBacktest({
  bars: BARS,
  signals: cheatingProvider,
  config: CONFIG
});

ok(
  !cheaterSegmented.ok,
  "segmented: читающий будущее провайдер не проходит сегментный прогон"
);

const noSignalsSegmented = runSegmentedBacktest({
  bars: BARS,
  signals: [],
  config: CONFIG
});

ok(
  noSignalsSegmented.ok,
  "segmented: ноль сигналов — валидный исход, а не ошибка"
);
ok(
  noSignalsSegmented.ok &&
    summarizeSegments(noSignalsSegmented.value).every(
      (item) => item.trades === 0 && item.winRate === null
    ),
  "segmented: сводка при нуле сделок — нули и null"
);

/* ---------- сводка ---------- */

if (segmented.ok) {
  const summary = summarizeSegments(segmented.value);

  ok(summary.length === 3, "summary: три сегмента");
  ok(
    summary.map((item) => item.segment).join(",") === "TRAIN,VALIDATION,OOS",
    "summary: порядок сегментов в сводке хронологический"
  );
  ok(
    summary[0].barsCount === 36 && summary[1].barsCount === 12 && summary[2].barsCount === 12,
    "summary: barsCount по сегментам"
  );
  ok(
    summary[0].trades === train?.metrics.trades &&
      summary[1].trades === validation?.metrics.trades &&
      summary[2].trades === oos?.metrics.trades,
    "summary: число сделок совпадает с метриками сегментов"
  );
  ok(
    summary.every((item) => Number.isFinite(item.totalNetPnl)),
    "summary: все числа конечны (Infinity/NaN в сводку не попадают)"
  );
}

/* ------------------------------------------------------------------ */
/* 3. Детерминизм вывода и отпечатки                                   */
/* ------------------------------------------------------------------ */

const segmentedAgain = runSegmentedBacktest({
  bars: zigzag(60),
  signals: momentumProvider,
  config: { timeoutBars: 4, warmupBars: 3 }
});

ok(segmentedAgain.ok, "determinism: повторный сегментный прогон успешен");
ok(
  segmented.ok &&
    segmentedAgain.ok &&
    canonicalJson(segmented.value) === canonicalJson(segmentedAgain.value),
  "determinism: канонический вывод сегментного прогона байт-в-байт идентичен"
);
ok(
  full !== null &&
    segmented.ok &&
    segmentedAgain.ok &&
    fingerprintOf(segmented.value) === fingerprintOf(segmentedAgain.value),
  "determinism: отпечаток сегментного прогона воспроизводим"
);

const fullAgain = runBacktest({ bars: zigzag(60), signals: momentumProvider, config: CONFIG });

ok(
  full !== null &&
    fullAgain.ok &&
    serializeResult(full) === serializeResult(fullAgain.result),
  "determinism: serializeResult идентичен для идентичного входа"
);
ok(
  full !== null &&
    fullAgain.ok &&
    fingerprintResult(full) === fingerprintResult(fullAgain.result),
  "determinism: fingerprintResult идентичен"
);

/* ---------- sha256: известные векторы ---------- */

ok(
  sha256Hex("") ===
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  "sha256: вектор пустой строки"
);
ok(
  sha256Hex("abc") ===
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  "sha256: вектор «abc»"
);
ok(
  sha256Hex("abc") === sha256Hex("abc"),
  "sha256: хеш стабилен (никакой соли/времени)"
);

/* ---------- каноничность ---------- */

ok(
  canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}',
  "canonical: ключи сортируются"
);
ok(
  canonicalJson({ oos: { b: 1, a: 2 }, train: 1 }) ===
    '{"oos":{"a":2,"b":1},"train":1}',
  "canonical: сортировка внутри вложенных объектов"
);
ok(canonicalNumber(-0) === 0 && Object.is(canonicalNumber(-0), -0) === false, "canonical: −0 → 0");
ok(canonicalNumber(0.1 + 0.2) === 0.3, "canonical: 0.1 + 0.2 → 0.3");
ok(
  canonicalJson({ train: [60, 0.30000000000000004, -0] }) ===
    '{"train":[60,0.3,0]}',
  "canonical: числа в массивах нормализуются"
);

const configOrderA = fingerprintConfig({
  quantity: 1,
  initialEquity: 10_000,
  entryPolicy: "next-bar-open",
  sameBarPolicy: "pessimistic",
  timeoutBars: 4,
  slippage: { kind: "bps", value: 2 },
  fees: { bps: 5, fixedPerSide: 0 },
  requireUniformGrid: false,
  expectedTimeframeMs: null,
  warmupBars: 3
});
const configOrderB = fingerprintConfig({
  warmupBars: 3,
  expectedTimeframeMs: null,
  requireUniformGrid: false,
  fees: { fixedPerSide: 0, bps: 5 },
  slippage: { value: 2, kind: "bps" },
  timeoutBars: 4,
  sameBarPolicy: "pessimistic",
  entryPolicy: "next-bar-open",
  initialEquity: 10_000,
  quantity: 1
});

ok(
  configOrderA === configOrderB,
  "fingerprint: порядок полей конфига не влияет на отпечаток"
);
ok(
  full !== null && configOrderA === full.metadata.configFingerprint,
  "fingerprint: отпечаток конфига совпадает с метаданными прогона"
);
ok(
  full !== null &&
    fingerprintConfig({ ...full.config, quantity: 2 }) !==
      full.metadata.configFingerprint,
  "fingerprint: изменение quantity меняет отпечаток конфига"
);
ok(
  fingerprintBars(BARS) === fingerprintBars(zigzag(60)),
  "fingerprint: логически идентичные бары дают одинаковый отпечаток"
);
ok(
  fingerprintBars(BARS) !== fingerprintBars(BARS.slice(0, 59)),
  "fingerprint: удаление одного бара меняет отпечаток"
);
ok(
  fingerprintBars(BARS) !==
    fingerprintBars(
      BARS.map((bar, index) => (index === 30 ? { ...bar, close: bar.close + 0.01 } : bar))
    ),
  "fingerprint: изменение одной цены меняет отпечаток"
);
ok(
  full !== null && fingerprintBars(BARS) === full.metadata.barsFingerprint,
  "fingerprint: отпечаток баров совпадает с метаданными прогона"
);

const runInputA = fingerprintRunInput({
  bars: BARS,
  config: full?.config ?? ({} as never),
  segment: null
});
const runInputB = fingerprintRunInput({
  bars: zigzag(60),
  config: full?.config ?? ({} as never),
  segment: null
});
const runInputC = fingerprintRunInput({
  bars: BARS,
  config: full?.config ?? ({} as never),
  segment: { name: "TRAIN", startIndex: 0, endIndexExclusive: 36 }
});

ok(runInputA === runInputB, "fingerprint: одинаковый вход прогона → одинаковый ключ");
ok(runInputA !== runInputC, "fingerprint: окно сегмента входит в ключ прогона");

/* ---------- сериализация сегментного прогона ---------- */

if (segmented.ok) {
  const serialized = canonicalJson(segmented.value);

  ok(
    !serialized.includes("Infinity") && !serialized.includes("NaN"),
    "serialize: в выводе сегментного прогона нет Infinity/NaN"
  );
  ok(
  !/:\s*-0(?:\.0+)?(?=[,}\]])/.test(serialized),
  "serialize: в выводе нет −0 (ни «-0», ни «-0.000…»)"
);
  ok(
    serialized.includes('"contractVersion"'),
    "serialize: версия контракта присутствует в выводе каждого сегмента"
  );
  ok(
    serialized.length > 1_000,
    `serialize: вывод непустой (${String(serialized.length)} символов)`
  );
  ok(
    canonicalJson(JSON.parse(serialized)) === serialized,
    "serialize: каноническая форма идемпотентна (повторная сериализация не меняет байты)"
  );
}

/* ------------------------------------------------------------------ */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
