/**
 * P2-A — тесты метрик и точности вывода (lib/backtest/metrics.ts,
 * lib/backtest/serialize.ts).
 *
 * Запуск: npx tsx scripts/test-backtest-metrics.ts
 *
 * Все числа посчитаны ВРУЧНУЮ по фикстурам ниже (нулевые издержки,
 * quantity = 1), чтобы тест проверял политику, а не сам себя:
 *
 *   сделка A: LONG 100 → 110 (TP)      gross +10, R +2
 *   сделка B: LONG 111 → 106 (SL)      gross  −5, R −1
 *   сделка C: LONG 106 → 101 (SL)      gross  −5, R −1
 *   сделка D: LONG 101 → 101 (конец)   gross   0, R  0  (breakeven)
 *
 *   winRate = 1/4 = 25 %;  PF(net) = 10/10 = 1;  expectancy = 0;
 *   avgR = (2 − 1 − 1 + 0)/4 = 0;  medianR = (−1 + 0)/2 = −0.5;
 *   серии: 1 победа подряд, 2 поражения подряд (breakeven прерывает);
 *   реализованная эквити: 1000 → 1010 → 1005 → 1000 → 1000,
 *   maxDrawdown = 10, pct = 10/1010 × 100 = 0.9900990099…%.
 */

import {
  type BacktestBar,
  type BacktestConfig,
  type BacktestOutcome,
  type BacktestResult,
  entryDecision
} from "../lib/backtest/contract";
import { runBacktest } from "../lib/backtest/engine";
import {
  computeBacktestMetrics,
  drawdownStats,
  markToMarketEquity,
  realizedEquity
} from "../lib/backtest/metrics";
import {
  CANONICAL_PRECISION,
  canonicalJson,
  canonicalNumber,
  fingerprintResult,
  serializeResult
} from "../lib/backtest/serialize";

let passed = 0;
let total = 0;

function ok(condition: boolean, label: string): void {
  total += 1;

  if (condition) {
    passed += 1;
  } else {
    console.error(`FAIL: ${label}`);
  }
}

function near(
  actual: number | null | undefined,
  expected: number,
  label: string,
  eps = 1e-9
): void {
  ok(
    typeof actual === "number" && Math.abs(actual - expected) <= eps,
    `${label} (ожидалось ${String(expected)}, получено ${String(actual)})`
  );
}

/* ------------------------------------------------------------------ */
/* Фикстуры                                                            */
/* ------------------------------------------------------------------ */

const H1 = 3_600_000;
const T0 = 1_700_000_000_000;

function mk(i: number, o: number, h: number, l: number, c: number): BacktestBar {
  return { time: T0 + i * H1, open: o, high: h, low: l, close: c };
}

const ZERO: BacktestConfig = {
  quantity: 1,
  initialEquity: 1_000,
  slippage: { kind: "bps", value: 0 },
  fees: { bps: 0, fixedPerSide: 0 }
};

/** 4 сделки: победа, два поражения, breakeven. */
const METRICS_BARS: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 112, 100, 111),
  mk(3, 111, 112, 110, 111),
  mk(4, 111, 112, 105, 106),
  mk(5, 106, 107, 105, 106),
  mk(6, 106, 107, 100, 101),
  mk(7, 101, 102, 100, 101.5),
  mk(8, 101.5, 102, 100, 101)
];

const METRICS_SIGNALS = [
  entryDecision("LONG", 95, 110, "A"),
  // Сигнал при открытой позиции: обязан быть пропущен и НЕ попасть в метрики.
  entryDecision("LONG", 95, 110, "A-duplicate"),
  entryDecision("LONG", 106, 121, "B"),
  null,
  entryDecision("LONG", 101, 116, "C"),
  null,
  entryDecision("LONG", 96, 111, "D")
];

function resultOf(outcome: BacktestOutcome): BacktestResult | null {
  return outcome.ok ? outcome.result : null;
}

const metricsOutcome = runBacktest({
  bars: METRICS_BARS,
  signals: METRICS_SIGNALS,
  config: ZERO
});
const metricsResult = resultOf(metricsOutcome);
const metrics = metricsResult?.metrics;

ok(metricsOutcome.ok, "фикстура метрик: прогон успешен");
ok(metricsResult?.trades.length === 4, "фикстура метрик: 4 исполненные сделки");

/* ------------------------------------------------------------------ */
/* 1. Счётчики и доли                                                  */
/* ------------------------------------------------------------------ */

ok(metrics?.trades === 4, "metrics: trades = 4");
ok(metrics?.longTrades === 4 && metrics.shortTrades === 0, "metrics: направления");
ok(metrics?.wins === 1, "metrics: wins — только netPnl > 0");
ok(metrics?.losses === 2, "metrics: losses — только netPnl < 0");
ok(metrics?.breakeven === 1, "metrics: breakeven — netPnl = 0 (не win и не loss)");
ok(
  metrics !== undefined && metrics.wins + metrics.losses + metrics.breakeven === metrics.trades,
  "metrics: win + loss + breakeven = trades (полное разбиение)"
);
near(metrics?.winRate, 25, "metrics: winRate = 25 %");
ok(
  metricsResult?.input.decisionCounts.LONG === 5 &&
    metricsResult.input.decisionCounts.NO_SIGNAL === 4,
  "metrics: пропущенный сигнал учтён в decisionCounts (5 LONG, 4 NO_SIGNAL)"
);
ok(
  metricsResult?.skippedSignals.length === 1,
  "metrics: пропущенный сигнал виден в skippedSignals"
);
ok(
  metrics?.trades === 4,
  "metrics: пропущенный сигнал НЕ превратился в сделку (метрики только из исполненных)"
);

/* ------------------------------------------------------------------ */
/* 2. PnL, profit factor, R                                            */
/* ------------------------------------------------------------------ */

near(metrics?.totalGrossPnl, 0, "metrics: totalGrossPnl = 10 − 5 − 5 + 0");
near(metrics?.totalNetPnl, 0, "metrics: totalNetPnl = 0");
near(metrics?.netWinTotal, 10, "metrics: netWinTotal = 10");
near(metrics?.netLossTotal, 10, "metrics: netLossTotal = |−5 − 5| = 10");
near(metrics?.grossWinTotal, 10, "metrics: grossWinTotal = 10");
near(metrics?.grossLossTotal, 10, "metrics: grossLossTotal = 10");
near(metrics?.profitFactor, 1, "metrics: PF(net) = 10 / 10 = 1");
ok(metrics?.profitFactorState === "ok", "metrics: profitFactorState = ok");
near(metrics?.expectancy, 0, "metrics: expectancy = 0 / 4");
near(metrics?.avgR, 0, "metrics: avgR = (2 − 1 − 1 + 0) / 4");
near(metrics?.medianR, -0.5, "metrics: medianR = (−1 + 0) / 2 (чётное число — среднее двух центральных)");
near(metrics?.avgGrossR, 0, "metrics: avgGrossR при нулевых издержках = avgR");
near(metrics?.medianGrossR, -0.5, "metrics: medianGrossR = −0.5");
near(metrics?.avgWin, 10, "metrics: avgWin = 10 (одна победа)");
near(metrics?.avgLoss, -5, "metrics: avgLoss = −5");
near(metrics?.largestWin, 10, "metrics: largestWin");
near(metrics?.largestLoss, -5, "metrics: largestLoss");
near(metrics?.totalFees, 0, "metrics: totalFees при нулевой комиссии");
near(metrics?.totalSlippageCost, 0, "metrics: totalSlippageCost при нулевом слиппедже");
near(metrics?.finalEquity, 1_000, "metrics: finalEquity = 1000 + 0");

const rValues = metricsResult?.trades.map((trade) => trade.rMultiple) ?? [];

ok(
  rValues.length === 4 &&
    rValues[0] === 2 &&
    rValues[1] === -1 &&
    rValues[2] === -1 &&
    rValues[3] === 0,
  `metrics: R-кратности по сделкам [2, −1, −1, 0], получено [${rValues.join(", ")}]`
);

/* ------------------------------------------------------------------ */
/* 3. Серии, удержание, причины выхода                                 */
/* ------------------------------------------------------------------ */

ok(metrics?.maxConsecutiveWins === 1, "metrics: серия побед = 1");
ok(metrics?.maxConsecutiveLosses === 2, "metrics: серия поражений = 2");
near(metrics?.avgBarsHeld, 2, "metrics: avgBarsHeld = 2");
ok(metrics?.maxBarsHeld === 2, "metrics: maxBarsHeld = 2");
ok(
  metrics?.exitReasonCounts.TAKE_PROFIT === 1 &&
    metrics.exitReasonCounts.STOP_LOSS === 2 &&
    metrics.exitReasonCounts.END_OF_DATA === 1 &&
    metrics.exitReasonCounts.TIMEOUT === 0 &&
    metrics.exitReasonCounts.SEGMENT_END === 0,
  "metrics: exitReasonCounts по всем пяти причинам"
);
ok(
  metrics !== undefined &&
    Object.values(metrics.exitReasonCounts).reduce((a, b) => a + b, 0) ===
      metrics.trades,
  "metrics: сумма exitReasonCounts = trades"
);
ok(metrics?.openAtEndTrades === 1, "metrics: openAtEndTrades = 1 (END_OF_DATA + SEGMENT_END)");
ok(metrics?.sameBarAmbiguityTrades === 0, "metrics: неоднозначных выходов нет");
ok(metrics?.gapThroughTrades === 0, "metrics: гэповых исполнений нет");
ok(metrics?.equityNonPositive === false, "metrics: эквити не уходила ≤ 0");

/* ------------------------------------------------------------------ */
/* 4. Кривые эквити и просадка                                         */
/* ------------------------------------------------------------------ */

const equity = metricsResult?.equityCurve ?? [];

ok(equity.length === 5, "equity: стартовая точка + 4 сделки");
ok(equity[0]?.tradeIndex === -1 && equity[0].equity === 1_000, "equity: старт");
near(equity[1]?.equity, 1_010, "equity: после сделки A");
near(equity[2]?.equity, 1_005, "equity: после сделки B");
near(equity[3]?.equity, 1_000, "equity: после сделки C");
near(equity[4]?.equity, 1_000, "equity: после сделки D");
ok(
  equity.every((point, index) => index === 0 || point.time >= equity[index - 1].time),
  "equity: точки хронологичны"
);
near(metrics?.maxDrawdown, 10, "drawdown: реализованная просадка = 1010 − 1000");
near(
  metrics?.maxDrawdownPct,
  (10 / 1_010) * 100,
  "drawdown: процент от пика 1010"
);
ok(
  metrics?.maxDrawdownPeakTime === T0 + 2 * H1,
  "drawdown: пик — на выходе сделки A"
);
ok(
  metrics?.maxDrawdownTroughTime === T0 + 6 * H1,
  "drawdown: впадина — на выходе сделки C (первая точка максимума)"
);
near(metrics?.maxDrawdownMarkToMarket, 10, "drawdown MTM: 1010 − 1000");

const mtm = metricsResult === null ? [] : markToMarketEquity({
  trades: metricsResult.trades,
  bars: METRICS_BARS,
  startIndex: 0,
  endIndexExclusive: METRICS_BARS.length,
  config: metricsResult.config
});

ok(mtm.length === 9, "MTM: точка на каждый бар окна");
near(mtm[0]?.equity, 1_000, "MTM: старт");
near(mtm[1]?.equity, 1_001, "MTM: открытая позиция A переоценена по close 101");
near(mtm[2]?.equity, 1_010, "MTM: после закрытия A");
near(mtm[7]?.equity, 1_000.5, "MTM: открытая позиция D переоценена по close 101.5");
near(mtm[8]?.equity, 1_000, "MTM: после закрытия D по close 101");

const realized = realizedEquity(metricsResult?.trades ?? [], T0, 1_000);

ok(realized.length === 5, "realizedEquity: 5 точек");
near(realized[3]?.equity, 1_000, "realizedEquity: накопление netPnl");

/* MTM консервативнее реализованной базы: просадка внутри сделки видна. */
const underwaterBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 101, 95, 96),
  mk(2, 96, 100, 94, 99)
];
const underwater = resultOf(
  runBacktest({
    bars: underwaterBars,
    signals: [entryDecision("LONG", 90, 130, "underwater")],
    config: ZERO
  })
);

ok(underwater?.metrics.trades === 1, "MTM vs realized: сделка одна");
near(underwater?.metrics.totalNetPnl, -1, "MTM vs realized: реализованный убыток −1");
near(underwater?.metrics.maxDrawdown, 1, "MTM vs realized: реализованная просадка 1");
near(
  underwater?.metrics.maxDrawdownMarkToMarket,
  4,
  "MTM vs realized: mark-to-market просадка 4 (close 96 при входе 100) — консервативнее"
);
ok(
  underwater !== null &&
    underwater.metrics.maxDrawdownMarkToMarket >= underwater.metrics.maxDrawdown,
  "MTM vs realized: MTM-просадка не меньше реализованной"
);
ok(
  underwater?.metrics.exitReasonCounts.END_OF_DATA === 1,
  "MTM vs realized: позиция закрыта по концу данных"
);

/* ------------------------------------------------------------------ */
/* 5. Граничные состояния метрик                                       */
/* ------------------------------------------------------------------ */

const noTrades = resultOf(
  runBacktest({
    bars: [mk(0, 100, 101, 99, 100), mk(1, 100, 101, 99, 100)],
    signals: [],
    config: ZERO
  })
);

ok(noTrades?.metrics.trades === 0, "zero: сделок нет");
ok(
  noTrades?.metrics.winRate === null &&
    noTrades.metrics.expectancy === null &&
    noTrades.metrics.avgR === null &&
    noTrades.metrics.medianR === null &&
    noTrades.metrics.avgGrossR === null &&
    noTrades.metrics.medianGrossR === null &&
    noTrades.metrics.avgWin === null &&
    noTrades.metrics.avgLoss === null &&
    noTrades.metrics.largestWin === null &&
    noTrades.metrics.largestLoss === null &&
    noTrades.metrics.avgBarsHeld === null,
  "zero: все средние/медианы/отношения = null (не 0 — 0/0 не равен 0)"
);
ok(
  noTrades?.metrics.profitFactor === null &&
    noTrades.metrics.profitFactorState === "no-trades",
  "zero: PF = null, состояние no-trades (Infinity не используется)"
);
ok(noTrades?.metrics.maxBarsHeld === 0, "zero: maxBarsHeld = 0");
ok(noTrades?.metrics.maxConsecutiveLosses === 0, "zero: серии = 0");
near(noTrades?.metrics.finalEquity, 1_000, "zero: finalEquity = initialEquity");
near(noTrades?.metrics.maxDrawdown, 0, "zero: просадки нет");

const onlyWins = resultOf(
  runBacktest({
    bars: [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 112, 100, 111)],
    signals: [entryDecision("LONG", 95, 110, "win")],
    config: ZERO
  })
);

ok(
  onlyWins?.metrics.profitFactor === null &&
    onlyWins.metrics.profitFactorState === "no-losses",
  "PF: нулевой знаменатель → null + состояние no-losses (не Infinity)"
);
near(onlyWins?.metrics.netLossTotal, 0, "PF: чистых убытков нет");
ok(onlyWins?.metrics.winRate === 100, "PF: winRate = 100 %");
ok(
  JSON.stringify(onlyWins?.metrics ?? {}).includes("Infinity") === false,
  "PF: Infinity не попадает в сериализуемые метрики"
);

// close последнего бара равен open бара входа → netPnl ровно 0.
const onlyBreakeven = resultOf(
  runBacktest({
    bars: [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 100)],
    signals: [entryDecision("LONG", 95, 110, "flat")],
    config: ZERO
  })
);

ok(
  onlyBreakeven?.metrics.trades === 1 && onlyBreakeven.metrics.breakeven === 1,
  "breakeven: сделка с нулевым netPnl учтена"
);
ok(
  onlyBreakeven?.metrics.profitFactor === null &&
    onlyBreakeven.metrics.profitFactorState === "no-losses",
  "breakeven: PF не определён (ни прибылей, ни убытков)"
);
ok(onlyBreakeven?.metrics.winRate === 0, "breakeven: winRate = 0 (нуль — не победа)");

/* Эквити уходит ≤ 0: процент просадки не определён, флаг взведён. */
const ruined = resultOf(
  runBacktest({
    bars: [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 103, 89, 90)],
    signals: [entryDecision("LONG", 90, 130, "ruin")],
    // quantity = 200: убыток (90 − 100) × 200 = −2000 уводит эквити 1000 в −1000.
    config: { ...ZERO, quantity: 200 }
  })
);

ok(
  ruined !== null && ruined.metrics.finalEquity <= 0,
  `ruin: эквити ушла ≤ 0 (${String(ruined?.metrics.finalEquity)})`
);
ok(ruined?.metrics.equityNonPositive === true, "ruin: equityNonPositive взведён");
ok(
  ruined !== null && Number.isFinite(ruined.metrics.maxDrawdown),
  "ruin: просадка конечна (маржинальной модели нет, но и NaN нет)"
);
near(ruined?.metrics.finalEquity, -1_000, "ruin: finalEquity = 1000 − 2000");
near(ruined?.metrics.maxDrawdown, 2_000, "ruin: реализованная просадка 2000");
near(ruined?.metrics.maxDrawdownPct, 200, "ruin: процент может превышать 100 (счёта больше нет)");
ok(
  ruined !== null &&
    ruined.metrics.maxDrawdownMarkToMarket >= ruined.metrics.maxDrawdown,
  "ruin: MTM-просадка не меньше реализованной"
);

const negativePeak = drawdownStats([
  { time: 1, equity: -5 },
  { time: 2, equity: -10 }
]);

ok(negativePeak.equityNonPositive === true, "drawdownStats: пик ≤ 0 → флаг");
ok(
  negativePeak.maxDrawdownPct === null,
  "drawdownStats: процент при пике ≤ 0 = null (деление на неположительный пик бессмысленно)"
);
near(negativePeak.maxDrawdown, 5, "drawdownStats: абсолютная просадка считается");

const emptyStats = drawdownStats([]);

ok(
  emptyStats.maxDrawdown === 0 && emptyStats.maxDrawdownPct === null,
  "drawdownStats: пустая кривая — 0 и null"
);

const plainStats = drawdownStats([
  { time: 1, equity: 100 },
  { time: 2, equity: 50 },
  { time: 3, equity: 75 }
]);

near(plainStats.maxDrawdown, 50, "drawdownStats: 100 → 50");
near(plainStats.maxDrawdownPct, 50, "drawdownStats: 50 %");
ok(plainStats.peakTime === 1 && plainStats.troughTime === 2, "drawdownStats: времена пика и впадины");

/* ------------------------------------------------------------------ */
/* 6. Метрики как чистая функция (пересчёт по сделкам)                 */
/* ------------------------------------------------------------------ */

if (metricsResult !== null) {
  const recomputed = computeBacktestMetrics({
    trades: metricsResult.trades,
    bars: METRICS_BARS,
    startIndex: 0,
    endIndexExclusive: METRICS_BARS.length,
    config: metricsResult.config
  });

  ok(
    JSON.stringify(recomputed) === JSON.stringify(metricsResult.metrics),
    "purity: пересчёт метрик по тем же сделкам даёт тот же результат"
  );
}

/* ------------------------------------------------------------------ */
/* 7. Точность, округление, каноническая сериализация                  */
/* ------------------------------------------------------------------ */

ok(CANONICAL_PRECISION === 10, "precision: зафиксировано 10 знаков");
ok(Object.is(canonicalNumber(-0), 0), "precision: −0 нормализован в 0");
ok(canonicalNumber(0.1 + 0.2) === 0.3, "precision: шум IEEE-754 погашен (0.1 + 0.2 = 0.3)");
ok(canonicalNumber(1 / 3) === 0.3333333333, "precision: 1/3 → 10 знаков");
ok(canonicalNumber(1e-11) === 0, "precision: величина меньше разрядности → 0");
ok(canonicalNumber(123456789.123456789) === 123456789.12345679, "precision: большое число");

let infinityThrown = false;
let nanThrown = false;

try {
  canonicalNumber(Number.POSITIVE_INFINITY);
} catch {
  infinityThrown = true;
}

try {
  canonicalNumber(Number.NaN);
} catch {
  nanThrown = true;
}

ok(infinityThrown, "precision: Infinity — исключение, а не тихий null");
ok(nanThrown, "precision: NaN — исключение, а не тихий null");

ok(
  canonicalJson({ b: 1, a: 2 }) === '{"a":2,"b":1}',
  "canonical: ключи сортируются лексикографически"
);
ok(
  canonicalJson({ z: { y: 1, x: { b: 2, a: 1 } }, a: [3, { d: 4, c: 3 }] }) ===
    '{"a":[3,{"c":3,"d":4}],"z":{"x":{"a":1,"b":2},"y":1}}',
  "canonical: сортировка на всех уровнях вложенности, включая массивы"
);
ok(
  canonicalJson({ a: 1, b: undefined }) === '{"a":1}',
  "canonical: undefined-поля отбрасываются"
);
ok(
  canonicalJson({ a: -0, b: [ -0 ] }) === '{"a":0,"b":[0]}',
  "canonical: −0 в JSON — это 0"
);

let dateThrown = false;
let fnThrown = false;

try {
  canonicalJson({ at: new Date(0) });
} catch {
  dateThrown = true;
}

try {
  canonicalJson({ fn: () => 1 });
} catch {
  fnThrown = true;
}

ok(dateThrown, "canonical: Date запрещён (метаданные не зависят от времени)");
ok(fnThrown, "canonical: функции не сериализуются (провайдер не попадает в вывод)");

/* ---------- точность реального результата с издержками ---------- */

const dirtyRun = resultOf(
  runBacktest({
    bars: [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 112, 100, 111)],
    signals: [entryDecision("LONG", 95, 110, "costs")],
    config: { quantity: 1, initialEquity: 10_000 }
  })
);
const dirtySerialized = dirtyRun === null ? "" : serializeResult(dirtyRun);

ok(dirtyRun !== null, "serialize: прогон с издержками успешен");
ok(
  dirtyRun !== null && Number.isFinite(dirtyRun.trades[0].netPnl),
  "serialize: netPnl — конечное число"
);
ok(
  dirtyRun !== null &&
    dirtyRun.trades[0].grossPnl !== 9.958 &&
    dirtyRun.trades[0].grossPnl.toFixed(10).startsWith("9.9580000000"),
  "serialize: внутри — сырой IEEE-754 (9.957999999999998), без промежуточных округлений"
);
ok(
  !dirtySerialized.includes("Infinity") && !dirtySerialized.includes("NaN"),
  "serialize: в каноническом выводе нет Infinity/NaN"
);
ok(
  !/:\s*-0(?:\.0+)?(?=[,}\]])/.test(dirtySerialized),
  "serialize: в выводе нет −0 (ни «-0», ни «-0.000…»)"
);
const grossInJson = (dirtySerialized.match(/"grossPnl":[-0-9.e]+/) ?? ["?"])[0];

ok(
  grossInJson === '"grossPnl":9.958',
  `serialize: шум представления нормализован до 10 знаков (${grossInJson})`
);
ok(
  dirtyRun !== null && fingerprintResult(dirtyRun) === fingerprintResult(dirtyRun),
  "serialize: отпечаток результата стабилен"
);
ok(
  dirtyRun !== null && /^[0-9a-f]{64}$/.test(fingerprintResult(dirtyRun)),
  "serialize: отпечаток результата — sha256 hex"
);

const rerun = resultOf(
  runBacktest({
    bars: [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 112, 100, 111)],
    signals: [entryDecision("LONG", 95, 110, "costs")],
    config: { quantity: 1, initialEquity: 10_000 }
  })
);

ok(
  rerun !== null && dirtyRun !== null && serializeResult(rerun) === serializeResult(dirtyRun),
  "determinism: повторный прогон байт-в-байт идентичен"
);
ok(
  rerun !== null && dirtyRun !== null && fingerprintResult(rerun) === fingerprintResult(dirtyRun),
  "determinism: отпечатки совпадают"
);

const changedPrice = resultOf(
  runBacktest({
    bars: [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 112.01, 100, 111)],
    signals: [entryDecision("LONG", 95, 110, "costs")],
    config: { quantity: 1, initialEquity: 10_000 }
  })
);

ok(
  changedPrice !== null &&
    dirtyRun !== null &&
    fingerprintResult(changedPrice) !== fingerprintResult(dirtyRun),
  "determinism: изменение одной цены меняет отпечаток результата"
);

/* ------------------------------------------------------------------ */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
