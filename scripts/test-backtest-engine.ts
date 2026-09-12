/**
 * P2-A — тесты движка бэктеста (lib/backtest/engine.ts и слои вокруг).
 *
 * Запуск: npx tsx scripts/test-backtest-engine.ts
 *
 * Покрывает: валидацию входа/конфига, базис цены входа, слиппедж и
 * комиссию, SL/TP, неоднозначность одного бара (3 политики), гэпы,
 * timeout, конец данных/границу сегмента, отсутствующий следующий бар,
 * отказы входа, одну позицию без пирамидинга, счётчики решений,
 * no-lookahead (структурный + контрфактический + активный «читер»),
 * изоляцию слоя (никаких Prisma/env/времени/случайности в исходниках)
 * и детерминизм.
 *
 * Все ожидаемые числа посчитаны вручную по зафиксированной политике
 * (contract.ts, пункты 1–16), а не сняты с фактического вывода.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  BACKTEST_CONTRACT_VERSION,
  BACKTEST_DEFAULTS,
  BACKTEST_ENGINE_NAME,
  type BacktestBar,
  type BacktestConfig,
  type BacktestOutcome,
  type BacktestResult,
  type SignalProvider,
  entryDecision,
  noTradeDecision
} from "../lib/backtest/contract";
import { runBacktest } from "../lib/backtest/engine";
import {
  assertDecisionInvariance,
  diagnoseDecisionInvariance,
  poisonFutureBars,
  probeProvider
} from "../lib/backtest/no-lookahead";

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

/** Нулевые издержки: удобно для ручной арифметики цен и PnL. */
const ZERO: BacktestConfig = {
  quantity: 1,
  initialEquity: 10_000,
  slippage: { kind: "bps", value: 0 },
  fees: { bps: 0, fixedPerSide: 0 }
};

function run(
  bars: readonly BacktestBar[],
  signals: Parameters<typeof runBacktest>[0]["signals"],
  config?: BacktestConfig,
  segment?: Parameters<typeof runBacktest>[0]["segment"]
): BacktestOutcome {
  return runBacktest({ bars, signals, config, segment });
}

function resultOf(outcome: BacktestOutcome): BacktestResult | null {
  return outcome.ok ? outcome.result : null;
}

function tradeOf(outcome: BacktestOutcome, index = 0) {
  const result = resultOf(outcome);

  return result === null ? undefined : result.trades[index];
}

/** Детерминированная пилообразная серия (период 7, сумма дрейфа = 0). */
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

/** Провайдер, читающий ТОЛЬКО прошлое (3 бара), — для проб no-lookahead. */
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

// close бара сигнала (99.5) специально НЕ равен open бара входа (100):
// иначе тест «цена входа берётся из open N+1» был бы невыполним.
const LONG_BARS: BacktestBar[] = [
  mk(0, 100, 101, 99, 99.5),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 112, 100, 111)
];
const LONG_SL_BARS: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 103, 94, 95)
];

/* ------------------------------------------------------------------ */
/* 1. Конфигурация                                                     */
/* ------------------------------------------------------------------ */

const badConfig = (config: BacktestConfig) => run(LONG_BARS, [], config);

ok(badConfig({ quantity: 0 }).ok === false, "config: quantity=0 отклонён");
ok(badConfig({ quantity: -1 }).ok === false, "config: quantity<0 отклонён");
ok(
  badConfig({ quantity: Number.NaN }).ok === false,
  "config: quantity=NaN отклонён"
);
ok(
  badConfig({ initialEquity: 0 }).ok === false,
  "config: initialEquity=0 отклонён"
);
ok(
  badConfig({ entryPolicy: "same-bar-close" as never }).ok === false,
  "config: entryPolicy кроме next-bar-open отклонён"
);
ok(
  badConfig({ sameBarPolicy: "random" as never }).ok === false,
  "config: неизвестный sameBarPolicy отклонён"
);
ok(
  badConfig({ timeoutBars: 0 }).ok === false,
  "config: timeoutBars=0 отклонён"
);
ok(
  badConfig({ timeoutBars: 1.5 }).ok === false,
  "config: дробный timeoutBars отклонён"
);
ok(
  badConfig({ timeoutBars: null }).ok === true,
  "config: timeoutBars=null разрешён (таймаута нет)"
);
ok(
  badConfig({ slippage: { kind: "bps", value: -1 } }).ok === false,
  "config: отрицательный слиппедж отклонён"
);
ok(
  badConfig({ slippage: { kind: "percent", value: 1 } as never }).ok === false,
  "config: неизвестный slippage.kind отклонён"
);
ok(
  badConfig({ fees: { bps: -1, fixedPerSide: 0 } }).ok === false,
  "config: отрицательная комиссия отклонена"
);
ok(
  badConfig({ fees: { bps: 0, fixedPerSide: -1 } }).ok === false,
  "config: отрицательная фиксированная комиссия отклонена"
);
ok(
  badConfig({ warmupBars: -1 }).ok === false,
  "config: отрицательный warmupBars отклонён"
);
ok(
  badConfig({ expectedTimeframeMs: 0 }).ok === false,
  "config: expectedTimeframeMs=0 отклонён"
);
ok(
  badConfig({ quantity: 0, fees: { bps: -1, fixedPerSide: 0 } }).ok === false,
  "config: ошибки накапливаются, а не останавливаются на первой"
);

const configStage = badConfig({ quantity: 0 });

ok(
  !configStage.ok && configStage.stage === "config",
  "config: отказ помечен stage=config"
);
ok(
  !configStage.ok && configStage.errors.length > 0,
  "config: отказ содержит тексты ошибок"
);

const defaultsRun = run(LONG_BARS, [entryDecision("LONG", 95, 110)]);
const defaultsConfig = resultOf(defaultsRun)?.config;

ok(
  defaultsConfig?.quantity === BACKTEST_DEFAULTS.quantity,
  "config: дефолт quantity применён"
);
ok(
  defaultsConfig?.entryPolicy === "next-bar-open",
  "config: единственная политика входа — next-bar-open"
);
ok(
  defaultsConfig?.sameBarPolicy === "pessimistic",
  "config: дефолт sameBarPolicy консервативный (pessimistic)"
);
ok(
  defaultsConfig?.slippage.value === 2 && defaultsConfig.slippage.kind === "bps",
  "config: нулевой слиппедж НЕ является дефолтом"
);
ok(
  defaultsConfig?.fees.bps === 5,
  "config: нулевая комиссия НЕ является дефолтом"
);
ok(
  defaultsConfig?.timeoutBars === null,
  "config: дефолт timeoutBars — без таймаута"
);

/* ------------------------------------------------------------------ */
/* 2. Валидация данных                                                 */
/* ------------------------------------------------------------------ */

ok(run([], []).ok === false, "bars: пустой набор отклонён");

const emptyOutcome = run([], []);

ok(
  !emptyOutcome.ok && emptyOutcome.stage === "bars",
  "bars: отказ помечен stage=bars"
);

const dup = run([mk(0, 100, 101, 99, 100), mk(0, 100, 101, 99, 100)], []);

ok(!dup.ok, "bars: дубликат time отклонён");
ok(
  !dup.ok && dup.errors.some((error) => error.includes("дубликат")),
  "bars: ошибка дубликата объясняет причину"
);

const nonMono = run([mk(1, 100, 101, 99, 100), mk(0, 100, 101, 99, 100)], []);

ok(!nonMono.ok, "bars: немонотонный time отклонён");
ok(
  !nonMono.ok && nonMono.errors.some((error) => error.includes("немонотон")),
  "bars: ошибка немонотонности объясняет причину"
);
ok(
  !nonMono.ok && !nonMono.errors.some((error) => error.includes("отсортирован")),
  "bars: вход не сортируется молча (ошибка, а не «починка»)"
);

ok(
  run([mk(0, 100, 99, 98, 99)], []).ok === false,
  "bars: high < max(open, close) отклонён"
);
ok(
  run([mk(0, 100, 101, 102, 103)], []).ok === false,
  "bars: low > min(open, close) отклонён"
);
ok(
  run([mk(0, 105, 106, 104, 105), { ...mk(1, 100, 90, 80, 85) }], []).ok ===
    false,
  "bars: high < low отклонён"
);
ok(
  run([{ time: T0, open: 0, high: 1, low: 0, close: 1 }], []).ok === false,
  "bars: цена 0 отклонена"
);
ok(
  run([{ time: T0, open: -5, high: 1, low: -5, close: 1 }], []).ok === false,
  "bars: отрицательная цена отклонена"
);
ok(
  run(
    [{ time: T0, open: Number.NaN, high: 1, low: 0.5, close: 1 }],
    []
  ).ok === false,
  "bars: NaN-цена отклонена"
);
ok(
  run(
    [{ time: T0, open: 1, high: Number.POSITIVE_INFINITY, low: 0.5, close: 1 }],
    []
  ).ok === false,
  "bars: Infinity-цена отклонена"
);
ok(
  run([{ time: T0 + 0.5, open: 1, high: 2, low: 0.5, close: 1 }], []).ok ===
    false,
  "bars: нецелый time отклонён"
);
ok(
  run([{ time: 0, open: 1, high: 2, low: 0.5, close: 1 }], []).ok === false,
  "bars: time=0 отклонён"
);
ok(
  run([{ time: T0, open: 1, high: 2, low: 0.5, close: 1, volume: -1 }], []).ok ===
    false,
  "bars: отрицательный volume отклонён"
);
ok(
  run([{ time: T0, open: 1, high: 2, low: 0.5, close: 1, volume: 5 }], []).ok ===
    true,
  "bars: корректный volume принимается"
);

/* ------------------------------------------------------------------ */
/* 3. Сетка времени и метаданные окна                                  */
/* ------------------------------------------------------------------ */

const gapped: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 101, 99, 100),
  { time: T0 + 3 * H1, open: 100, high: 101, low: 99, close: 100 },
  mk(4, 100, 101, 99, 100)
];

ok(
  run(gapped, []).ok === true,
  "grid: пропуск в сетке допустим без requireUniformGrid"
);
ok(
  run(gapped, [], { requireUniformGrid: true }).ok === false,
  "grid: пропуск отклонён при requireUniformGrid"
);
ok(
  run(gapped, [], { expectedTimeframeMs: H1 }).ok === true,
  "grid: expectedTimeframeMs — пропуск кратен шагу (2 × H1), это не ошибка"
);
ok(
  resultOf(run(gapped, [], { expectedTimeframeMs: H1 }))?.metadata.gridGaps === 1,
  "grid: пропуск при expectedTimeframeMs подсчитан в gridGaps"
);
ok(
  run(gapped, [], { expectedTimeframeMs: 3 * H1 }).ok === false,
  "grid: дельта меньше expectedTimeframeMs — ошибка (чужой таймфрейм)"
);
ok(
  run(
    [mk(0, 100, 101, 99, 100), { time: T0 + H1 + 1, open: 100, high: 101, low: 99, close: 100 }],
    [],
    { expectedTimeframeMs: H1 }
  ).ok === false,
  "grid: дельта не кратна expectedTimeframeMs — ошибка"
);
ok(
  run(gapped, [], { expectedTimeframeMs: H1, requireUniformGrid: true }).ok === false,
  "grid: requireUniformGrid строже expectedTimeframeMs (пропуск = ошибка)"
);
ok(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 101, 99, 100)],
    [],
    { expectedTimeframeMs: H1, requireUniformGrid: true }
  ).ok === true,
  "grid: равномерная сетка проходит обе строгие проверки"
);

const metaOutcome = run(
  [mk(0, 100, 101, 99, 100), mk(1, 100, 101, 99, 100), gapped[2]],
  []
);
const meta = resultOf(metaOutcome)?.metadata;

ok(
  meta?.contractVersion === BACKTEST_CONTRACT_VERSION,
  "metadata: версия контракта присутствует"
);
ok(
  meta?.engine === BACKTEST_ENGINE_NAME,
  "metadata: имя движка — детерминированная константа"
);
ok(meta?.barsCount === 3, "metadata: barsCount по окну");
ok(meta?.firstBarTime === T0, "metadata: firstBarTime");
ok(meta?.lastBarTime === T0 + 3 * H1, "metadata: lastBarTime");
ok(meta?.timeframeMs === null, "metadata: timeframeMs=null при неравномерной сетке");
ok(meta?.gridGaps === 1, "metadata: gridGaps подсчитан");
ok(meta?.maxGapMs === 2 * H1, "metadata: maxGapMs подсчитан");
ok(meta?.segment === null, "metadata: segment=null для полного прогона");
ok(
  typeof meta?.configFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(meta.configFingerprint),
  "metadata: configFingerprint — sha256 hex"
);
ok(
  typeof meta?.barsFingerprint === "string" &&
    /^[0-9a-f]{64}$/.test(meta.barsFingerprint),
  "metadata: barsFingerprint — sha256 hex"
);
ok(
  meta !== undefined &&
    !JSON.stringify(meta).includes("T00:") &&
    !/"pid"/.test(JSON.stringify(meta)),
  "metadata: никакого wall-clock времени и pid"
);

const uniformMeta = resultOf(
  run([mk(0, 100, 101, 99, 100), mk(1, 100, 101, 99, 100)], [])
)?.metadata;

ok(
  uniformMeta?.timeframeMs === H1,
  "metadata: timeframeMs определён для равномерной сетки"
);
ok(uniformMeta?.gridGaps === 0, "metadata: gridGaps=0 без пропусков");

/* ------------------------------------------------------------------ */
/* 4. Вход: базис цены, next-bar-open                                  */
/* ------------------------------------------------------------------ */

const entryOutcome = run(LONG_BARS, [entryDecision("LONG", 95, 110)], ZERO);
const entryTrade = tradeOf(entryOutcome);

ok(entryTrade !== undefined, "entry: сделка создана");
ok(entryTrade?.signalIndex === 0, "entry: сигнал на баре N=0");
ok(entryTrade?.entryIndex === 1, "entry: вход на баре N+1 (не на баре сигнала)");
ok(
  entryTrade?.plannedEntryPrice === LONG_BARS[1].open,
  "entry: плановая цена входа = open бара N+1"
);
ok(
  entryTrade !== undefined &&
    entryTrade.plannedEntryPrice !== LONG_BARS[0].close &&
    LONG_BARS[0].close === 99.5,
  "entry: цена входа НЕ берётся из close бара сигнала (99.5 ≠ 100)"
);
ok(
  entryTrade?.entryTime === LONG_BARS[1].time,
  "entry: время входа = time бара N+1"
);
ok(
  entryTrade?.exitIndex === 2 && entryTrade.exitReason === "TAKE_PROFIT",
  "entry: TP исполнен на следующем баре"
);
ok(entryTrade?.barsHeld === 2, "entry: barsHeld считает бар входа первым");
near(entryTrade?.grossPnl, 10, "LONG TP: gross = (110 − 100) × 1");
near(
  entryTrade?.plannedEntryReference,
  99.5,
  "LONG TP: опорная цена решения = close бара СИГНАЛА (99.5), а не open входа"
);
near(
  entryTrade?.plannedRisk,
  4.5,
  "LONG TP: ПЛАНОВЫЙ риск = |99.5 − 95| × 1 — знаменатель R"
);
near(
  entryTrade?.riskAmount,
  5,
  "LONG TP: riskAmount — ДИАГНОСТИКА по фактическому входу |100 − 95| × 1"
);
near(entryTrade?.grossR, 10 / 4.5, "LONG TP: grossR = gross / плановый риск = 10 / 4.5");
near(
  entryTrade?.rMultiple,
  10 / 4.5,
  "LONG TP: при нулевой комиссии rMultiple = grossR"
);
near(
  entryTrade?.grossRActualFill,
  2,
  "LONG TP: диагностика по фактическому входу = 10 / 5 = 2"
);
near(
  entryTrade?.rMultipleActualFill,
  2,
  "LONG TP: диагностика по фактическому входу (net) = 2"
);
near(
  entryTrade?.plannedRewardRisk,
  10.5 / 4.5,
  "LONG TP: плановый R/R = |110 − 99.5| / |99.5 − 95| (от опорной цены сигнала)"
);
ok(
  entryTrade !== undefined && entryTrade.netPnl === entryTrade.grossPnl,
  "entry: при нулевой комиссии net = gross"
);
ok(
  entryTrade?.gapThrough === false && entryTrade.sameBarAmbiguity === false,
  "entry: обычный выход не помечен как гэп или неоднозначность"
);

/* ---------- слиппедж ---------- */

const slipLong = tradeOf(
  run(LONG_BARS, [entryDecision("LONG", 95, 110)], {
    ...ZERO,
    slippage: { kind: "bps", value: 10 }
  })
);

near(slipLong?.entryPrice, 100.1, "slippage LONG вход: цена сдвинута ВВЕРХ (против сделки)");
near(slipLong?.exitPrice, 109.89, "slippage LONG выход: цена сдвинута ВНИЗ (против сделки)");
near(slipLong?.grossPnl, 9.79, "slippage LONG: gross уменьшился на 0.21");
near(
  slipLong?.riskAmount,
  5.1,
  "slippage LONG: riskAmount (ДИАГНОСТИКА) считается от ФАКТИЧЕСКОЙ цены входа"
);
near(
  slipLong?.plannedRisk,
  4.5,
  "slippage LONG: ПЛАНОВЫЙ знаменатель R не зависит от слиппеджа"
);
near(slipLong?.slippageCost, 0.21, "slippage LONG: slippageCost = 0.1 + 0.11");
near(
  slipLong?.rMultiple,
  9.79 / 4.5,
  "slippage LONG: rMultiple = net / ПЛАНОВЫЙ риск (слиппедж бьёт по числителю)"
);
ok(
  slipLong !== undefined &&
    entryTrade !== undefined &&
    slipLong.rMultiple < entryTrade.rMultiple,
  "slippage LONG: R ухудшился относительно нулевых издержек"
);
near(
  slipLong?.grossRActualFill,
  9.79 / 5.1,
  "slippage LONG: диагностика по фактическому входу = 9.79 / 5.1"
);

const slipShortBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 102, 88, 89)
];
const slipShort = tradeOf(
  run(slipShortBars, [entryDecision("SHORT", 105, 90)], {
    ...ZERO,
    slippage: { kind: "bps", value: 10 }
  })
);

near(slipShort?.entryPrice, 99.9, "slippage SHORT вход: цена сдвинута ВНИЗ (против сделки)");
near(slipShort?.exitPrice, 90.09, "slippage SHORT выход: цена сдвинута ВВЕРХ (против сделки)");
near(slipShort?.grossPnl, 9.81, "slippage SHORT: gross = 99.9 − 90.09");
near(slipShort?.slippageCost, 0.19, "slippage SHORT: slippageCost = 0.1 + 0.09");

const slipAbsolute = tradeOf(
  run(LONG_BARS, [entryDecision("LONG", 95, 110)], {
    ...ZERO,
    slippage: { kind: "absolute", value: 0.5 }
  })
);

near(slipAbsolute?.entryPrice, 100.5, "slippage absolute: вход +0.5");
near(slipAbsolute?.exitPrice, 109.5, "slippage absolute: выход −0.5");
near(slipAbsolute?.slippageCost, 1, "slippage absolute: стоимость = 1.0");

const defaultCostsTrade = tradeOf(
  run(LONG_BARS, [entryDecision("LONG", 95, 110)])
);

near(defaultCostsTrade?.entryPrice, 100.02, "дефолт: вход со слиппеджем 2 bp");
near(defaultCostsTrade?.exitPrice, 109.978, "дефолт: выход со слиппеджем 2 bp");
near(defaultCostsTrade?.feeEntry, 0.05001, "дефолт: комиссия входа 5 bp от нотионала");
near(defaultCostsTrade?.feeExit, 0.054989, "дефолт: комиссия выхода 5 bp от нотионала");
near(
  defaultCostsTrade?.netPnl,
  (defaultCostsTrade?.grossPnl ?? 0) - (defaultCostsTrade?.feesTotal ?? 0),
  "дефолт: net = gross − fees (слиппедж уже в ценах, двойного счёта нет)"
);

/* ---------- комиссия ---------- */

const feeTrade = tradeOf(
  run(LONG_BARS, [entryDecision("LONG", 95, 110)], {
    quantity: 2,
    initialEquity: 10_000,
    slippage: { kind: "bps", value: 0 },
    fees: { bps: 10, fixedPerSide: 1 }
  })
);

near(feeTrade?.feeEntry, 1.2, "fees: вход 200 × 10 bp + 1 = 1.2");
near(feeTrade?.feeExit, 1.22, "fees: выход 220 × 10 bp + 1 = 1.22");
near(feeTrade?.feesTotal, 2.42, "fees: комиссия считается по КАЖДОЙ стороне");
near(feeTrade?.grossPnl, 20, "fees: gross = (110 − 100) × 2");
near(feeTrade?.netPnl, 17.58, "fees: net = 20 − 2.42");
near(
  feeTrade?.plannedRisk,
  9,
  "fees: ПЛАНОВЫЙ риск = |99.5 − 95| × 2 — знаменатель R"
);
near(
  feeTrade?.riskAmount,
  10,
  "fees: riskAmount — диагностика по фактическому входу |100 − 95| × 2"
);
near(feeTrade?.rMultiple, 17.58 / 9, "fees: rMultiple — ЧИСТЫЙ R (net / плановый риск)");
near(feeTrade?.grossR, 20 / 9, "fees: grossR — валовый R (gross / плановый риск)");
near(
  feeTrade?.rMultipleActualFill,
  1.758,
  "fees: rMultipleActualFill — диагностика (net / риск фактического входа)"
);

/* ---------- издержки никогда не улучшают результат ---------- */

const cleanNet = tradeOf(run(LONG_BARS, [entryDecision("LONG", 95, 110)], ZERO))?.netPnl;
const dirtyNet = tradeOf(
  run(LONG_BARS, [entryDecision("LONG", 95, 110)], {
    slippage: { kind: "bps", value: 5 },
    fees: { bps: 7, fixedPerSide: 0.1 }
  })
)?.netPnl;

ok(
  cleanNet !== undefined && dirtyNet !== undefined && dirtyNet < cleanNet,
  "costs: издержки всегда ухудшают net (слиппедж против сделки)"
);

/* ------------------------------------------------------------------ */
/* 5. Исходы LONG/SHORT                                                */
/* ------------------------------------------------------------------ */

const longSl = tradeOf(
  run(LONG_SL_BARS, [entryDecision("LONG", 95, 110)], ZERO)
);

ok(longSl?.exitReason === "STOP_LOSS", "LONG SL: причина выхода");
near(longSl?.exitPrice, 95, "LONG SL: исполнение по уровню");
near(longSl?.grossPnl, -5, "LONG SL: gross = −5");
near(longSl?.rMultiple, -1, "LONG SL: R = −1 (риск ровно один)");

const shortTp = tradeOf(
  run(slipShortBars, [entryDecision("SHORT", 105, 90)], ZERO)
);

ok(shortTp?.exitReason === "TAKE_PROFIT", "SHORT TP: причина выхода");
near(shortTp?.exitPrice, 90, "SHORT TP: исполнение по уровню");
near(shortTp?.grossPnl, 10, "SHORT TP: gross = (100 − 90) × 1");
near(shortTp?.riskAmount, 5, "SHORT TP: risk = |100 − 105| × 1");
near(shortTp?.rMultiple, 2, "SHORT TP: R = +2");

const shortSlBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 106, 100, 105)
];
const shortSl = tradeOf(
  run(shortSlBars, [entryDecision("SHORT", 105, 90)], ZERO)
);

ok(shortSl?.exitReason === "STOP_LOSS", "SHORT SL: причина выхода");
near(shortSl?.grossPnl, -5, "SHORT SL: gross = (100 − 105) × 1");
near(shortSl?.rMultiple, -1, "SHORT SL: R = −1");

const shortResult = resultOf(
  run(slipShortBars, [entryDecision("SHORT", 105, 90)], ZERO)
);

ok(
  shortResult?.metrics.longTrades === 0 && shortResult.metrics.shortTrades === 1,
  "metrics: направление сделки учтено"
);

/* ------------------------------------------------------------------ */
/* 6. SL и TP в одном баре: явная политика                             */
/* ------------------------------------------------------------------ */

const AMBIGUOUS_BARS: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 112, 94, 100),
  mk(2, 100, 101, 99, 100)
];
const AMBIGUOUS_SIGNAL = [entryDecision("LONG", 95, 110)];

const pessimistic = tradeOf(
  run(AMBIGUOUS_BARS, AMBIGUOUS_SIGNAL, { ...ZERO, sameBarPolicy: "pessimistic" })
);
const optimistic = tradeOf(
  run(AMBIGUOUS_BARS, AMBIGUOUS_SIGNAL, { ...ZERO, sameBarPolicy: "optimistic" })
);
const proximity = tradeOf(
  run(AMBIGUOUS_BARS, AMBIGUOUS_SIGNAL, { ...ZERO, sameBarPolicy: "open-proximity" })
);

ok(
  pessimistic?.exitReason === "STOP_LOSS" && pessimistic.exitPrice === 95,
  "same-bar pessimistic: первым считается SL"
);
ok(
  optimistic?.exitReason === "TAKE_PROFIT" && optimistic.exitPrice === 110,
  "same-bar optimistic: первым считается TP"
);
ok(
  proximity?.exitReason === "STOP_LOSS",
  "same-bar open-proximity: SL ближе к open (5 против 10) — выбран SL"
);
ok(
  pessimistic?.sameBarAmbiguity === true &&
    optimistic?.sameBarAmbiguity === true &&
    proximity?.sameBarAmbiguity === true,
  "same-bar: неоднозначность помечена в сделке при любой политике"
);
ok(
  resultOf(run(AMBIGUOUS_BARS, AMBIGUOUS_SIGNAL, ZERO))?.metrics
    .sameBarAmbiguityTrades === 1,
  "same-bar: неоднозначность агрегирована в метриках"
);

const proximityTpBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 104, 90, 100),
  mk(2, 100, 101, 99, 100)
];
const proximityTp = tradeOf(
  run(proximityTpBars, [entryDecision("LONG", 95, 103)], {
    ...ZERO,
    sameBarPolicy: "open-proximity"
  })
);

ok(
  proximityTp?.exitReason === "TAKE_PROFIT",
  "same-bar open-proximity: TP ближе к open (3 против 5) — выбран TP"
);
near(proximityTp?.grossPnl, 3, "same-bar open-proximity: gross = 3");

const tieBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 105, 95, 100),
  mk(2, 100, 101, 99, 100)
];
const tie = tradeOf(
  run(tieBars, [entryDecision("LONG", 95, 105)], {
    ...ZERO,
    sameBarPolicy: "open-proximity"
  })
);

ok(
  tie?.exitReason === "STOP_LOSS",
  "same-bar open-proximity: при равенстве дистанций — SL (пессимистичный tie-break)"
);

const defaultPolicy = tradeOf(run(AMBIGUOUS_BARS, AMBIGUOUS_SIGNAL, ZERO));

ok(
  defaultPolicy?.exitReason === "STOP_LOSS",
  "same-bar: дефолтная политика — pessimistic"
);

/* ------------------------------------------------------------------ */
/* 7. Гэп через уровень                                                */
/* ------------------------------------------------------------------ */

const gapSlBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 93, 94, 92, 93)
];
const gapSl = tradeOf(run(gapSlBars, [entryDecision("LONG", 95, 110)], ZERO));

ok(gapSl?.exitReason === "STOP_LOSS", "gap SL: причина выхода");
near(gapSl?.plannedExitPrice, 93, "gap SL: исполнение ПО OPEN (93), а не по уровню 95");
ok(gapSl?.gapThrough === true, "gap SL: сделка помечена gapThrough");
near(gapSl?.grossPnl, -7, "gap SL: убыток хуже уровня (−7 вместо −5)");
near(gapSl?.rMultiple, -1.4, "gap SL: R = −1.4 — гэп не «прячется» в −1");

const gapTpBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 112, 115, 111, 114)
];
const gapTp = tradeOf(run(gapTpBars, [entryDecision("LONG", 95, 110)], ZERO));

ok(gapTp?.exitReason === "TAKE_PROFIT", "gap TP: причина выхода");
near(gapTp?.plannedExitPrice, 112, "gap TP: исполнение ПО OPEN (112), а не по уровню 110");
ok(gapTp?.gapThrough === true, "gap TP: сделка помечена gapThrough");
near(gapTp?.grossPnl, 12, "gap TP: прибыль лучше уровня (+12)");
near(gapTp?.rMultiple, 2.4, "gap TP: R = 2.4");

const gapShortSl = tradeOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 108, 109, 107, 108)],
    [entryDecision("SHORT", 105, 90)],
    ZERO
  )
);

ok(
  gapShortSl?.exitReason === "STOP_LOSS" && gapShortSl.gapThrough === true,
  "gap SHORT SL: open выше SL — исполнение по open"
);
near(gapShortSl?.plannedExitPrice, 108, "gap SHORT SL: цена = 108 (хуже уровня 105)");

const gapPriority = tradeOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 93, 111, 92, 93)],
    [entryDecision("LONG", 95, 110)],
    { ...ZERO, sameBarPolicy: "optimistic" }
  )
);

ok(
  gapPriority?.gapThrough === true &&
    gapPriority.exitReason === "STOP_LOSS" &&
    gapPriority.plannedExitPrice === 93,
  "gap приоритет: гэп на open важнее внутриварных касаний (даже при optimistic)"
);

/* ------------------------------------------------------------------ */
/* 8. Timeout                                                          */
/* ------------------------------------------------------------------ */

const timeoutBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 102, 100, 101),
  mk(3, 101, 102, 100, 100.5),
  mk(4, 100, 101, 99, 100)
];
const timeout = tradeOf(
  run(timeoutBars, [entryDecision("LONG", 95, 110)], { ...ZERO, timeoutBars: 3 })
);

ok(timeout?.exitReason === "TIMEOUT", "timeout: выход по таймауту");
ok(timeout?.exitIndex === 3, "timeout: выход на 3-м баре удержания (вход = 1-й)");
ok(timeout?.barsHeld === 3, "timeout: barsHeld = 3");
near(timeout?.plannedExitPrice, 100.5, "timeout: исполнение по CLOSE бара");
near(timeout?.netPnl, 0.5, "timeout: PnL по close (0.5)");

const timeoutAfterLevel = tradeOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 102, 94, 95)],
    [entryDecision("LONG", 95, 110)],
    { ...ZERO, timeoutBars: 2 }
  )
);

ok(
  timeoutAfterLevel?.exitReason === "STOP_LOSS",
  "timeout приоритет: внутриварное касание SL раньше close — побеждает SL"
);

const timeoutOnEntryBar = tradeOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 102, 100, 101)],
    [entryDecision("LONG", 95, 110)],
    { ...ZERO, timeoutBars: 1 }
  )
);

ok(
  timeoutOnEntryBar?.exitReason === "TIMEOUT" && timeoutOnEntryBar.exitIndex === 1,
  "timeout=1: позиция закрывается по close БАРА ВХОДА"
);
near(timeoutOnEntryBar?.plannedExitPrice, 101, "timeout=1: цена = close бара входа");

const noTimeout = tradeOf(
  run(timeoutBars, [entryDecision("LONG", 95, 110)], ZERO)
);

ok(
  noTimeout?.exitReason === "END_OF_DATA",
  "timeout=null: таймаута нет, позиция доживает до конца данных"
);

/* ------------------------------------------------------------------ */
/* 9. Конец данных, граница сегмента, отсутствующий следующий бар      */
/* ------------------------------------------------------------------ */

const endOfData = resultOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101), mk(2, 101, 102, 100, 101)],
    [entryDecision("LONG", 95, 110)],
    ZERO
  )
);
const eodTrade = endOfData?.trades[0];

ok(eodTrade?.exitReason === "END_OF_DATA", "end-of-data: причина выхода");
near(eodTrade?.plannedExitPrice, 101, "end-of-data: исполнение по close последнего бара");
ok(eodTrade?.gapThrough === false, "end-of-data: не помечен как гэп");
ok(
  endOfData?.metrics.trades === 1 && endOfData.metrics.openAtEndTrades === 1,
  "end-of-data: сделка УЧТЕНА в метриках и помечена openAtEndTrades"
);
ok(
  endOfData?.metrics.exitReasonCounts.END_OF_DATA === 1,
  "end-of-data: счётчик причин выхода"
);

const noNextBar = resultOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
    [null, entryDecision("LONG", 95, 110)],
    ZERO
  )
);

ok(noNextBar?.metrics.trades === 0, "no-next-bar: сделки нет");
ok(
  noNextBar?.skippedSignals.length === 1 &&
    noNextBar.skippedSignals[0].reason === "no-next-bar",
  "no-next-bar: сигнал на последнем баре отброшен с явной причиной"
);
ok(
  noNextBar?.skippedSignals[0].index === 1,
  "no-next-bar: отброшен именно последний бар"
);
ok(
  noNextBar?.input.decisionCounts.LONG === 1,
  "no-next-bar: решение всё равно посчитано в decisionCounts"
);

const segmentBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 102, 100, 101),
  mk(3, 101, 102, 100, 101)
];
const segmentRun = resultOf(
  run(
    segmentBars,
    [entryDecision("LONG", 95, 110)],
    { ...ZERO, slippage: { kind: "bps", value: 2 } },
    { name: "TRAIN", startIndex: 0, endIndexExclusive: 3 }
  )
);
const segmentTrade = segmentRun?.trades[0];

ok(segmentTrade?.exitReason === "SEGMENT_END", "segment: открытая позиция закрыта по SEGMENT_END");
ok(segmentTrade?.exitIndex === 2, "segment: выход на последнем баре сегмента");
ok(
  segmentRun?.input.signalsEvaluated === 3,
  "segment: провайдер вызван только на барах сегмента"
);
ok(segmentRun?.metadata.segment === "TRAIN", "segment: имя сегмента в метаданных");
ok(
  segmentRun?.metadata.barsCount === 3,
  "segment: barsCount — по окну сегмента, а не по всему набору"
);
ok(
  segmentRun?.metadata.segmentStartIndex === 0 &&
    segmentRun.metadata.segmentEndIndexExclusive === 3,
  "segment: границы окна в метаданных"
);

const boundarySkip = resultOf(
  run(
    segmentBars.slice(0, 3),
    [null, null, entryDecision("LONG", 95, 110)],
    ZERO,
    { name: "OOS", startIndex: 0, endIndexExclusive: 3 }
  )
);

ok(
  boundarySkip?.skippedSignals[0]?.reason === "segment-boundary",
  "segment: сигнал на последнем баре сегмента отброшен как segment-boundary"
);
ok(
  boundarySkip?.metrics.trades === 0,
  "segment: вход НЕ переносится через границу сегмента"
);

const badSegment = run(segmentBars, [], ZERO, {
  name: "TRAIN",
  startIndex: 3,
  endIndexExclusive: 2
});

ok(!badSegment.ok, "segment: startIndex ≥ endIndexExclusive отклонён");
ok(
  run(segmentBars, [], ZERO, { name: "TRAIN", startIndex: 0, endIndexExclusive: 99 })
    .ok === false,
  "segment: граница за пределами набора отклонена"
);

/* ------------------------------------------------------------------ */
/* 10. Отказы входа                                                    */
/* ------------------------------------------------------------------ */

const wrongSide = resultOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
    [entryDecision("LONG", 105, 110)],
    ZERO
  )
);

ok(
  wrongSide?.rejectedSignals[0]?.reason === "levels-on-wrong-side",
  "reject: SL выше close для LONG — levels-on-wrong-side"
);
ok(
  wrongSide?.rejectedSignals[0]?.entryIndex === null,
  "reject: при отказе на баре сигнала вход не планируется"
);
ok(
  wrongSide?.metrics.trades === 0,
  "reject: сделка не создана"
);
ok(
  typeof wrongSide?.rejectedSignals[0]?.detail === "string" &&
    (wrongSide?.rejectedSignals[0]?.detail.length ?? 0) > 0,
  "reject: отказ объяснён текстом"
);

/* Аудит (HIGH 1): гэп на входе больше НЕ отклоняет сделку. Позиция
 * открывается по open бара N+1 и тут же закрывается по тому же open
 * общим гэповым правилом (пункт 7 политики): валовый PnL = 0, чистый —
 * минус издержки. Класс убыточных исходов остаётся в выборке, поэтому
 * winRate/PF/drawdown/expectancy больше не подкрашиваются. Коды отказов
 * entry-levels-breached-at-open и entry-fill-outside-levels отправлены
 * в отставку (в типе RejectReason сохранены, счётчики всегда 0). */
const breachedBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 94, 95, 93, 94),
  mk(2, 94, 95, 93, 94)
];
const breachedOutcome = run(breachedBars, [entryDecision("LONG", 95, 110)], ZERO);
const breached = resultOf(breachedOutcome);
const breachedTrade = tradeOf(breachedOutcome);

ok(
  breached?.rejectedSignals.length === 0,
  "gap-entry: отказов нет — гэп на входе больше не удаляет сделку"
);
ok(
  breached?.metrics.trades === 1,
  "gap-entry: сделка учтена в метриках (выборка не подчищена)"
);
ok(
  breachedTrade?.entryIndex === 1 && breachedTrade.entryPrice === 94,
  "gap-entry: вход по open бара N+1 (94)"
);
ok(
  breachedTrade?.exitIndex === 1 && breachedTrade.exitReason === "STOP_LOSS",
  "gap-entry: закрытие по тому же open, exitReason = STOP_LOSS"
);
ok(
  breachedTrade?.gapThrough === true,
  "gap-entry: исполнение помечено gapThrough"
);
ok(
  breachedTrade?.barsHeld === 1,
  "gap-entry: бар входа считается первым (barsHeld = 1)"
);
near(breachedTrade?.grossPnl, 0, "gap-entry: валовый PnL = 0 (вход и выход по одной цене)");
near(breachedTrade?.netPnl, 0, "gap-entry: при нулевых издержках net = 0");
ok(
  breached?.metrics.breakeven === 1 && breached?.metrics.losses === 0,
  "gap-entry: нулевой net — breakeven (не win и не loss)"
);
near(
  breachedTrade?.plannedEntryReference,
  100,
  "gap-entry: опорная цена = close бара сигнала"
);
near(breachedTrade?.plannedRisk, 5, "gap-entry: плановый риск |100 − 95| × 1 = 5");
near(breachedTrade?.riskAmount, 1, "gap-entry: фактический риск |94 − 95| × 1 = 1 (диагностика)");
near(breachedTrade?.rMultiple, 0, "gap-entry: R = 0 — знаменатель не схлопнулся");

const breachedCostly = tradeOf(
  run(breachedBars, [entryDecision("LONG", 95, 110)], {
    ...ZERO,
    slippage: { kind: "bps", value: 10 },
    fees: { bps: 5, fixedPerSide: 0.1 }
  })
);

near(
  breachedCostly?.grossPnl,
  -0.188,
  "gap-entry с издержками: вход 94.094, выход 93.906 → gross = −0.188"
);
ok(
  breachedCostly !== undefined && breachedCostly.netPnl < breachedCostly.grossPnl,
  "gap-entry с издержками: комиссия ухудшает net"
);
ok(
  breachedCostly !== undefined && breachedCostly.netPnl < 0,
  "gap-entry с издержками: честный убыток вместо «исчезнувшей» сделки"
);

const invalidLevels = resultOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
    [entryDecision("LONG", 100, 100)],
    ZERO
  )
);

ok(
  invalidLevels?.rejectedSignals[0]?.reason === "invalid-levels",
  "reject: sl = tp — invalid-levels"
);
ok(
  resultOf(
    run(
      [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
      [entryDecision("LONG", Number.NaN, 110)],
      ZERO
    )
  )?.rejectedSignals[0]?.reason === "invalid-levels",
  "reject: NaN-уровень — invalid-levels"
);
ok(
  resultOf(
    run(
      [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
      [entryDecision("SHORT", 95, 110)],
      ZERO
    )
  )?.rejectedSignals[0]?.reason === "levels-on-wrong-side",
  "reject: для SHORT требуется tp < close < sl — иначе отказ"
);

// Уровни согласованы с close бара сигнала (99 < 99.5 < 100.2), но
// слиппедж 100 bp поднимает ФАКТИЧЕСКУЮ цену входа до 101 — за TP.
// Аудит (HIGH 1): такая сделка больше не удаляется из выборки. open
// бара (100) не выходит за уровни, поэтому мгновенного закрытия нет;
// бар входа касается и SL, и TP → при пессимистичной политике выход по
// SL. Итог — честный убыток −2.99 вместо «отсутствующей» сделки.
const fillOutsideOutcome = run(
  LONG_BARS,
  [entryDecision("LONG", 99, 100.2)],
  { ...ZERO, slippage: { kind: "bps", value: 100 } }
);
const fillOutside = resultOf(fillOutsideOutcome);
const fillOutsideTrade = tradeOf(fillOutsideOutcome);

ok(
  fillOutside?.rejectedSignals.length === 0,
  "fill-outside-levels: отказ отправлен в отставку — сделка зафиксирована"
);
ok(
  fillOutside?.metrics.trades === 1,
  "fill-outside-levels: сделка учтена в метриках"
);
near(fillOutsideTrade?.entryPrice, 101, "fill-outside-levels: вход 100 + 100 bp = 101");
ok(
  fillOutsideTrade?.exitReason === "STOP_LOSS" &&
    fillOutsideTrade?.sameBarAmbiguity === true,
  "fill-outside-levels: бар входа касается обоих уровней → пессимистичный SL (а не «удаление» сделки)"
);
near(
  fillOutsideTrade?.grossPnl,
  99 * 0.99 - 101,
  "fill-outside-levels: gross = 99 × 0.99 − 101 = −2.99 (слиппедж на входе и на выходе)"
);
ok(
  fillOutsideTrade !== undefined && fillOutsideTrade.netPnl < 0,
  "fill-outside-levels: вход за собственным TP — УБЫТОК, а не отсутствие сделки"
);
near(
  fillOutsideTrade?.plannedRewardRisk,
  0.7 / 0.5,
  "fill-outside-levels: плановый R/R = |100.2 − 99.5| / |99.5 − 99| = 1.4"
);
ok(
  fillOutside?.metrics.losses === 1 && fillOutside?.metrics.winRate === 0,
  "fill-outside-levels: метрики видят убыток (winRate = 0)"
);

/* ------------------------------------------------------------------ */
/* 11. Одна позиция, счётчики решений                                  */
/* ------------------------------------------------------------------ */

const singlePositionBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 102, 100, 101),
  mk(3, 101, 102, 100, 101),
  mk(4, 101, 112, 100, 111)
];
const singlePosition = resultOf(
  run(
    singlePositionBars,
    [
      entryDecision("LONG", 95, 110),
      entryDecision("LONG", 95, 110),
      null,
      entryDecision("SHORT", 105, 90)
    ],
    ZERO
  )
);

ok(singlePosition?.metrics.trades === 1, "position: сделка ровно одна (пирамидинга нет)");
ok(
  singlePosition?.skippedSignals.length === 2 &&
    singlePosition.skippedSignals.every((item) => item.reason === "position-open"),
  "position: сигналы при открытой позиции пропущены с причиной position-open"
);
ok(
  singlePosition?.input.signalsEvaluated === 5,
  "position: провайдер вызван на КАЖДОМ баре окна"
);
ok(
  singlePosition?.input.decisionCounts.LONG === 2 &&
    singlePosition.input.decisionCounts.SHORT === 1 &&
    singlePosition.input.decisionCounts.NO_SIGNAL === 2,
  "position: decisionCounts полны и раздельны"
);
ok(
  singlePosition !== null &&
    Object.values(singlePosition.input.decisionCounts).reduce(
      (accumulator, value) => accumulator + value,
      0
    ) === singlePosition.input.signalsEvaluated,
  "position: сумма decisionCounts = числу вызовов провайдера"
);

const kinds = resultOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 101, 99, 100), mk(2, 100, 101, 99, 100), mk(3, 100, 101, 99, 100)],
    [
      noTradeDecision("NEUTRAL", "flat"),
      noTradeDecision("CANNOT_EVALUATE", "not-enough-data"),
      null,
      noTradeDecision("NEUTRAL", "flat")
    ],
    ZERO
  )
);

ok(
  kinds?.input.decisionCounts.NEUTRAL === 2,
  "kinds: NEUTRAL посчитан"
);
ok(
  kinds?.input.decisionCounts.CANNOT_EVALUATE === 1,
  "kinds: CANNOT_EVALUATE посчитан ОТДЕЛЬНО (cannot-evaluate ≠ NEUTRAL)"
);
ok(
  kinds?.input.decisionCounts.NO_SIGNAL === 1,
  "kinds: отсутствие решения — NO_SIGNAL"
);
ok(kinds?.metrics.trades === 0, "kinds: ни одно из них не даёт сделку");
ok(
  kinds?.metrics.winRate === null && kinds.metrics.profitFactor === null,
  "kinds: при нуле сделок отношения = null"
);

const reentryBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 112, 99, 111),
  mk(2, 111, 122, 110, 121),
  mk(3, 121, 132, 120, 131)
];
const reentry = resultOf(
  run(
    reentryBars,
    [entryDecision("LONG", 95, 110), entryDecision("LONG", 105, 130)],
    ZERO
  )
);

ok(
  reentry?.metrics.trades === 2,
  "re-entry: сигнал на баре закрытия предыдущей сделки разрешён"
);
ok(
  reentry !== null &&
    reentry.trades[1].signalIndex === reentry.trades[0].exitIndex &&
    reentry.trades[1].entryIndex === reentry.trades[0].exitIndex + 1,
  "re-entry: вход всё равно только на следующем баре"
);
ok(
  reentry?.trades[1].id === 1,
  "re-entry: id сделок возрастают детерминированно"
);

const badKind = run(
  [mk(0, 100, 101, 99, 100)],
  (() => ({ kind: "MAYBE" })) as unknown as SignalProvider
);

ok(
  !badKind.ok && badKind.stage === "provider",
  "provider: неизвестный kind решения — структурированная ошибка"
);

const cheatingProvider: SignalProvider = (context) => {
  const next = context.barAt(context.index + 1);

  return next.close > context.bar.close
    ? entryDecision("LONG", context.bar.low, next.high + 1)
    : null;
};
const cheater = run(
  [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
  cheatingProvider,
  ZERO
);

ok(!cheater.ok, "no-lookahead: читающий будущее провайдер не может отработать");
ok(
  !cheater.ok && cheater.stage === "provider",
  "no-lookahead: ошибка помечена stage=provider"
);
ok(
  !cheater.ok && cheater.errors[0].includes("no-lookahead"),
  "no-lookahead: ошибка названа своим именем"
);
ok(
  !cheater.ok && cheater.errors[0].includes("barAt(1)"),
  "no-lookahead: в ошибке виден запрошенный будущий индекс"
);

/* ------------------------------------------------------------------ */
/* 12. No-lookahead: структурная проба и контрфакт                     */
/* ------------------------------------------------------------------ */

const bars60 = zigzag(60);
const momentumConfig: BacktestConfig = { timeoutBars: 4, warmupBars: 3 };

const probe = probeProvider({
  bars: bars60,
  provider: momentumProvider,
  config: momentumConfig
});

ok(probe.ok, `no-lookahead: структурная проба чистая (${probe.errors.join("; ")})`);
ok(probe.barsProbed === 60, "no-lookahead: провайдер вызван на всех 60 барах");
ok(
  probe.guardFailures.length === 0,
  "no-lookahead: все попытки чтения будущего (index+1, +2, +10, +1000) заблокированы"
);
ok(
  probe.errors.length === 0,
  "no-lookahead: visibleBars = index − firstVisibleIndex + 1 на каждом баре"
);
ok(
  probe.decisions.every(
    (item) => item.visibleBars === item.index - item.firstVisibleIndex + 1
  ),
  "no-lookahead: видимая история = числу баров, достижимых через barAt"
);
ok(
  probe.decisions.every((item, index) => item.index === index),
  "no-lookahead: бары обрабатываются хронологически, без пропусков"
);
ok(probe.outcome.ok, "no-lookahead: базовый прогон успешен");

const segmentProbe = probeProvider({
  bars: bars60,
  provider: momentumProvider,
  config: momentumConfig,
  segment: { name: "VALIDATION", startIndex: 36, endIndexExclusive: 48 }
});

ok(segmentProbe.ok, "no-lookahead: проба сегмента чистая");
ok(
  segmentProbe.barsProbed === 12,
  "no-lookahead: в сегменте оценены только его 12 баров"
);
ok(
  segmentProbe.windowFailures.length === 0,
  "no-lookahead: чтение до warmup-окна сегмента заблокировано"
);

const invariance = assertDecisionInvariance({
  bars: bars60,
  provider: momentumProvider,
  config: momentumConfig,
  boundaryIndex: 40
});

ok(
  invariance.ok,
  `no-lookahead контрфакт: замена всего будущего не меняет решения (${invariance.errors.join("; ")})`
);
ok(
  invariance.comparedDecisions === 40,
  "no-lookahead контрфакт: сравнены все 40 решений до границы"
);
ok(
  invariance.comparedTrades > 0,
  `no-lookahead контрфакт: сравнены сделки (${String(invariance.comparedTrades)} шт.) — тест не вырожденный`
);

const poisoned = poisonFutureBars(bars60, 40);

ok(
  poisoned.slice(0, 40).every((bar, index) => bar.close === bars60[index].close),
  "poison: прошлое не изменено"
);
ok(
  poisoned[45].close === bars60[45].close * 3.5,
  "poison: будущее изменено радикально"
);
ok(
  poisoned.every(
    (bar, index) => index === 0 || bar.time > poisoned[index - 1].time
  ),
  "poison: «отравленная» серия остаётся валидной (монотонный time)"
);
ok(
  poisoned.every(
    (bar) =>
      bar.high >= Math.max(bar.open, bar.close) &&
      bar.low <= Math.min(bar.open, bar.close)
  ),
  "poison: OHLC-инварианты сохранены"
);

const invarianceBadBoundary = assertDecisionInvariance({
  bars: bars60,
  provider: momentumProvider,
  boundaryIndex: 0
});

ok(
  !invarianceBadBoundary.ok,
  "no-lookahead контрфакт: вырожденная граница отклонена"
);

const cheaterInvariance = assertDecisionInvariance({
  bars: bars60,
  provider: cheatingProvider,
  boundaryIndex: 40
});

ok(
  !cheaterInvariance.ok,
  "no-lookahead контрфакт: читающий будущее провайдер НЕ проходит проверку"
);

/* Провайдер, заглядывающий в будущее в обход barAt: замыкание на массив,
 * который движку НЕ передавался. Это ДОКАЗАННЫЙ ПРЕДЕЛ контрфактической
 * диагностики (аудит, BLOCKER 1): poisonFutureBars подменяет только
 * массив, переданный движку, а замыкание держит исходный — решения не
 * меняются, и проверка проходит ЗЕЛЁНОЙ. Поэтому диагностика больше не
 * выдаётся за сертификацию no-lookahead: она публикует guarantee =
 * "counterfactual-diagnostic" и непустой список ограничений. */
const closureCheater: SignalProvider = (context) => {
  const future = bars60[context.index + 2];

  if (future === undefined) {
    return null;
  }

  return future.close > context.bar.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "cheat")
    : entryDecision("SHORT", context.bar.high, context.bar.low - 1, "cheat");
};
const closureInvariance = diagnoseDecisionInvariance({
  bars: bars60,
  provider: closureCheater,
  config: ZERO,
  boundaryIndex: 40
});

ok(
  closureInvariance.ok,
  "предел контрфакта: читер с замыканием на собственный массив НЕ обнаруживается (ok=true — это НЕ доказательство отсутствия lookahead)"
);
ok(
  closureInvariance.guarantee === "counterfactual-diagnostic",
  "предел контрфакта: отчёт честно помечен как ДИАГНОСТИКА, а не сертификация"
);
ok(
  closureInvariance.limitations.length > 0,
  "предел контрфакта: ограничения публикуются вместе с отчётом (даже при ok=true)"
);
ok(
  closureInvariance.limitations.some((item) =>
    item.toLowerCase().includes("замыкани")
  ),
  "предел контрфакта: в ограничениях прямо названы замыкания"
);
ok(
  assertDecisionInvariance === diagnoseDecisionInvariance,
  "предел контрфакта: старое имя сохранено как обёртка над диагностикой"
);

/* Структурная гарантия (A) при этом ДЕРЖИТСЯ: тот же читер не может
 * прочитать будущее через контекст движка — barAt(index+1) бросает. */
const closureProbe = probeProvider({
  bars: bars60,
  provider: closureCheater,
  config: ZERO
});

ok(
  closureProbe.ok && closureProbe.guardFailures.length === 0,
  "структурный барьер: канал движка будущее не отдаёт даже читеру"
);
ok(
  closureProbe.guarantee === "structural-context-barrier" &&
    closureProbe.limitations.length > 0,
  "структурный барьер: гарантия и её пределы опубликованы"
);
ok(
  run(bars60, closureCheater, ZERO).ok === true,
  "предел контрфакта: читер через замыкание УСПЕШНО прогоняется — барьер barAt покрывает только канал движка"
);

/* ------------------------------------------------------------------ */
/* 13. Изоляция слоя и детерминизм                                     */
/* ------------------------------------------------------------------ */

const backtestDir = join(process.cwd(), "lib", "backtest");
const sourceFiles = readdirSync(backtestDir).filter((name) =>
  name.endsWith(".ts")
);

ok(
  sourceFiles.length >= 7,
  `isolation: слой на месте (${String(sourceFiles.length)} файлов)`
);

const FORBIDDEN_TOKENS = [
  "process.env",
  "process.",
  "Date.now",
  "new Date",
  "Math.random",
  "randomUUID",
  "randomBytes",
  "performance.now",
  "fetch(",
  "@prisma",
  "require(",
  "setTimeout",
  "setInterval"
];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

function skipQuoted(source: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    if (ch === "\n") {
      return i;
    }
    i += 1;
  }
  return i;
}

function skipInterpolation(source: string, start: number): number {
  let depth = 0;
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\"" || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
    i += 1;
  }
  return i;
}

function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      return i + 1;
    }
    if (ch === "$" && source[i + 1] === "{") {
      i = skipInterpolation(source, i + 1);
      continue;
    }
    i += 1;
  }
  return i;
}

function templateInterpolations(source: string, start: number): string {
  let out = "";
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "`") {
      break;
    }
    if (ch === "$" && source[i + 1] === "{") {
      const end = skipInterpolation(source, i + 1);
      out += `${stripCode(source.slice(i + 2, end - 1))} `;
      i = end;
      continue;
    }
    i += 1;
  }
  return out;
}

function stripCode(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      out += " ";
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (ch === "/" && source[i + 1] === "/") {
      const end = source.indexOf("\n", i);
      out += " ";
      i = end === -1 ? source.length : end;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      i = skipQuoted(source, i, ch);
      out += '""';
      continue;
    }
    if (ch === "`") {
      out += `""${templateInterpolations(source, i)}`;
      i = skipTemplate(source, i);
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/* ---------- HARDENED LEXICAL SCANNER (P2AB HARDENING #1) ---------- */

function isIdentifierChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}
function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}
function skipWhitespace(source: string, i: number): number {
  while (i < source.length && /\s/.test(source[i])) i++;
  return i;
}

function tryParseStringLiteral(
  source: string,
  pos: number
): { quote: string; content: string; end: number } | null {
  if (pos >= source.length) return null;
  const quote = source[pos];
  if (quote !== '"' && quote !== "'" && quote !== "`") return null;
  if (quote === "`") {
    // template literal: collect static parts, skip ${...}
    let i = pos + 1;
    let content = "";
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        // keep escaped char as is in content? For specifier detection we want raw content without escapes
        if (i + 1 < source.length) {
          content += source[i + 1];
          i += 2;
          continue;
        }
      }
      if (ch === "`") {
        return { quote, content, end: i + 1 };
      }
      if (ch === "$" && source[i + 1] === "{") {
        // skip interpolation
        let depth = 1;
        let j = i + 2;
        while (j < source.length && depth > 0) {
          const c = source[j];
          if (c === '"' || c === "'") {
            j = skipQuoted(source, j, c);
            continue;
          }
          if (c === "`") {
            j = skipTemplate(source, j);
            continue;
          }
          if (c === "{") depth++;
          else if (c === "}") depth--;
          j++;
        }
        i = j;
        continue;
      }
      content += ch;
      i++;
    }
    return null;
  } else {
    let i = pos + 1;
    let content = "";
    while (i < source.length) {
      const ch = source[i];
      if (ch === "\\") {
        if (i + 1 < source.length) {
          content += source[i + 1];
          i += 2;
          continue;
        }
      }
      if (ch === quote) {
        return { quote, content, end: i + 1 };
      }
      if (ch === "\n") {
        return null;
      }
      content += ch;
      i++;
    }
    return null;
  }
}

function findFromClauseOutsideString(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (ch === ";") {
      return -1;
    }
    if (
      source.startsWith("from", i) &&
      !isIdentifierChar(source[i - 1] ?? "") &&
      !isIdentifierChar(source[i + 4] ?? "")
    ) {
      return i;
    }
    i++;
  }
  return -1;
}

function extractSpecifiersHardened(source: string): string[] {
  const specifiers: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    // import
    if (
      source.startsWith("import", i) &&
      !isIdentifierChar(source[i - 1] ?? "") &&
      !isIdentifierChar(source[i + 6] ?? "")
    ) {
      let j = i + 6;
      j = skipWhitespace(source, j);
      if (source[j] === "(") {
        // dynamic import("x") / import('x') / import(`x`)
        j++;
        j = skipWhitespace(source, j);
        const str = tryParseStringLiteral(source, j);
        if (str) {
          specifiers.push(str.content);
          i = str.end;
          continue;
        }
      } else if (
        source[j] === '"' ||
        source[j] === "'" ||
        source[j] === "`"
      ) {
        const str = tryParseStringLiteral(source, j);
        if (str) {
          specifiers.push(str.content);
          i = str.end;
          continue;
        }
      } else {
        const fromPos = findFromClauseOutsideString(source, j);
        if (fromPos !== -1) {
          let k = fromPos + 4;
          k = skipWhitespace(source, k);
          const str = tryParseStringLiteral(source, k);
          if (str) {
            specifiers.push(str.content);
            i = str.end;
            continue;
          }
        }
      }
    }
    // export ... from
    if (
      source.startsWith("export", i) &&
      !isIdentifierChar(source[i - 1] ?? "") &&
      !isIdentifierChar(source[i + 6] ?? "")
    ) {
      const fromPos = findFromClauseOutsideString(source, i + 6);
      if (fromPos !== -1) {
        let k = fromPos + 4;
        k = skipWhitespace(source, k);
        const str = tryParseStringLiteral(source, k);
        if (str) {
          specifiers.push(str.content);
          i = str.end;
          continue;
        }
      }
    }
    // require("x") / require('x')
    if (
      source.startsWith("require", i) &&
      !isIdentifierChar(source[i - 1] ?? "") &&
      !isIdentifierChar(source[i + 7] ?? "")
    ) {
      let j = i + 7;
      j = skipWhitespace(source, j);
      if (source[j] === "(") {
        j++;
        j = skipWhitespace(source, j);
        const str = tryParseStringLiteral(source, j);
        if (str) {
          specifiers.push(str.content);
          i = str.end;
          continue;
        }
      }
    }
    i++;
  }
  return specifiers;
}

function parseIdentifier(
  source: string,
  pos: number
): { name: string; end: number } | null {
  if (pos >= source.length) return null;
  const ch = source[pos];
  if (!isIdentifierStart(ch)) return null;
  let i = pos + 1;
  while (i < source.length && isIdentifierChar(source[i])) i++;
  return { name: source.slice(pos, i), end: i };
}

function parseChain(
  source: string,
  start: number
): { chain: string[]; end: number } | null {
  const first = parseIdentifier(source, start);
  if (!first) return null;
  const chain: string[] = [first.name];
  let i = first.end;
  while (true) {
    i = skipWhitespace(source, i);
    if (i >= source.length) break;
    const ch = source[i];
    // `.` — обычный доступ к свойству; `?.` — optional chaining.
    // `?.` в JS — единый токен (`?` и `.` без пробела между ними), но после
    // него пробелы допустимы: `process ?. env`. Поддерживаем только эти
    // обычные формы; это по-прежнему лексический сканер, а не анализ семантики.
    const optional = ch === "?" && source[i + 1] === ".";
    if (ch === "." || optional) {
      i += optional ? 2 : 1;
      i = skipWhitespace(source, i);
    } else if (ch !== "[") {
      break;
    }
    if (source[i] === "[") {
      // `process["env"]` и `process?.["env"]`; `. [` — не валидный JS, цепочку не удлиняем
      if (ch === "." && !optional) break;
      i++;
      i = skipWhitespace(source, i);
      const str = tryParseStringLiteral(source, i);
      if (!str) {
        // not a string bracket like [0] or [var] — stop chain
        break;
      }
      chain.push(str.content);
      i = str.end;
      i = skipWhitespace(source, i);
      if (source[i] !== "]") break;
      i++;
      continue;
    }
    const ident = parseIdentifier(source, i);
    if (!ident) break;
    chain.push(ident.name);
    i = ident.end;
  }
  return { chain, end: i };
}

function hasProcessEnvViolation(source: string): {
  violated: boolean;
  chains: string[][];
} {
  const chains: string[][] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'") {
      i = skipQuoted(source, i, ch);
      continue;
    }
    if (ch === "`") {
      i = skipTemplate(source, i);
      continue;
    }
    if (
      (source.startsWith("process", i) &&
        !isIdentifierChar(source[i - 1] ?? "") &&
        !isIdentifierChar(source[i + 7] ?? "")) ||
      (source.startsWith("globalThis", i) &&
        !isIdentifierChar(source[i - 1] ?? "") &&
        !isIdentifierChar(source[i + 10] ?? ""))
    ) {
      const parsed = parseChain(source, i);
      if (parsed) {
        const c = parsed.chain;
        // check adjacent process -> env
        for (let idx = 0; idx < c.length - 1; idx++) {
          if (c[idx] === "process" && c[idx + 1] === "env") {
            if (c[0] === "process" || c[0] === "globalThis") {
              chains.push(c);
              break;
            }
          }
        }
        i = parsed.end;
        continue;
      }
    }
    i++;
  }
  return { violated: chains.length > 0, chains };
}

/* ---------- claim boundary of the lexical scanner (P2AB HARDENING #2) ---------- */

/**
 * Ограничения области действия этой проверки.
 *
 * Эти тесты — консервативный ЛЕКСИЧЕСКИЙ регрессионный барьер по исходному
 * тексту lib/backtest/*. Это НЕ полное доказательство безопасности JS/TS,
 * НЕ песочница и НЕ доказательство отсутствия lookahead. Сканер не должен
 * использоваться как утверждение «любой доступ к process/env исключён».
 */
const SCANNER_LIMITATIONS: string[] = [
  "Lexical guard only: the scanner reads source text; it does not type-check, resolve symbols, follow aliases or evaluate the module graph.",
  "Not a complete JS/TS security proof: passing these tests does NOT mean \"all process/env access is prevented\" and does not prove absence of env access.",
  "Not a no-lookahead proof and not a sandbox: runtime behaviour is not confined by this scanner.",
  "Does not promise detection of arbitrary aliasing, e.g. `const p = process; p.env`.",
  "Does not promise detection of reflection, e.g. `Reflect.get(process, \"env\")`.",
  "Does not promise detection of computed keys assembled at runtime, e.g. `process[\"e\" + \"nv\"]`.",
  "Does not promise detection of escaped/computed property tricks (e.g. `process[\"\\u0065nv\"]`) unless explicitly tested below.",
  "Does not promise detection of arbitrary TypeScript expression rewriting, casts or parenthesized aliases, e.g. `(process as any).env`.",
  "Does not promise detection of dynamic imports hidden inside complex template interpolation when that interpolation is not parsed.",
  "Does not promise detection of semantic code generation or eval-style indirection.",
  "Fail-closed false positives are possible and accepted: conservative token/substring checks (e.g. `process.` inside any property path, `new Date` anywhere in the layer) may flag code that does not actually read env or wall-clock time.",
  "Coverage is limited to the fixtures listed in this file; ordinary syntax without a fixture is not guaranteed to be covered."
];

const SCANNER_LIMITATIONS_TEXT = SCANNER_LIMITATIONS.join("\n").toLowerCase();

ok(
  SCANNER_LIMITATIONS.length >= 10,
  `claim boundary: scanner limitations list is non-empty (${SCANNER_LIMITATIONS.length} items)`
);
ok(
  SCANNER_LIMITATIONS_TEXT.includes("lexical"),
  "claim boundary: limitations state that the guard is lexical"
);
ok(
  SCANNER_LIMITATIONS_TEXT.includes("not a complete js/ts security proof") &&
    SCANNER_LIMITATIONS_TEXT.includes("does not mean"),
  "claim boundary: limitations state that this is not a complete security proof"
);
ok(
  SCANNER_LIMITATIONS_TEXT.includes("not a no-lookahead proof") &&
    SCANNER_LIMITATIONS_TEXT.includes("not a sandbox"),
  "claim boundary: limitations reject no-lookahead-proof / sandbox claims"
);
for (const required of [
  "aliasing",
  "reflection",
  "computed keys assembled at runtime",
  "escaped/computed property tricks",
  "casts or parenthesized aliases",
  "template interpolation",
  "eval-style indirection"
]) {
  ok(
    SCANNER_LIMITATIONS_TEXT.includes(required),
    `claim boundary: limitations explicitly document "${required}"`
  );
}

function extractSpecifiersWeak(source: string): string[] {
  // intentionally weak: double quotes only, static from only
  return [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
}
function hasProcessEnvViolationWeak(source: string): boolean {
  // weak: only dot form process.env, no bracket, no globalThis bracket
  const code = stripCode(source);
  return code.includes("process.env") || code.includes("globalThis.process.env");
}

/* ---------- P2AB policy ---------- */

const allSpecifiers: string[] = [];

const P2A_CORE_FILES = new Set([
  "contract.ts",
  "engine.ts",
  "validate.ts",
  "splits.ts",
  "metrics.ts",
  "costs.ts",
  "serialize.ts",
  "no-lookahead.ts"
]);
const P2B_DATA_PLANE_IMPORTS = ["../strategies/", "../smc/"];
const P2A_CORE_EXTERNAL: string[] = [];

for (const name of sourceFiles) {
  const raw = readFileSync(join(backtestDir, name), "utf8");
  const source = stripComments(raw);
  const code = stripCode(raw);
  const hits = FORBIDDEN_TOKENS.filter((token) => code.includes(token));

  ok(
    hits.length === 0,
    `isolation: ${name} не использует env/время/случайность/сеть/Prisma (${hits.join(", ")})`
  );

  // hardened process.env bracket detection
  const procEnv = hasProcessEnvViolation(source);
  ok(
    !procEnv.violated,
    `isolation: ${name} не использует process.env / bracket / globalThis.process.env (${procEnv.chains.map((c) => c.join(".")).join(", ")})`
  );

  const specifiers = extractSpecifiersHardened(source);

  allSpecifiers.push(...specifiers);

  if (P2A_CORE_FILES.has(name)) {
    P2A_CORE_EXTERNAL.push(...specifiers.filter((s) => !s.startsWith("./")));

    ok(
      specifiers.every(
        (specifier) =>
          specifier.startsWith("./") ||
          (specifier === "node:crypto" && name === "serialize.ts")
      ),
      `isolation: [P2-A core] ${name} импортирует только слой backtest (${specifiers.join(", ")})`
    );
    // disallow ../ for P2-A core
    const hasDotDot = specifiers.some((s) => s.startsWith("../"));
    ok(
      !hasDotDot,
      `isolation: [P2-A core] ${name} не импортирует ../ (запрещено для ядра) (${specifiers.filter((s) => s.startsWith("../")).join(", ")})`
    );
  } else {
    ok(
      specifiers.every(
        (specifier) =>
          specifier.startsWith("./") ||
          specifier === "node:crypto" ||
          P2B_DATA_PLANE_IMPORTS.some((prefix) => specifier.startsWith(prefix))
      ),
      `isolation: [P2-B data plane] ${name} импортирует только backtest + smc/strategies (${specifiers.join(", ")})`
    );
  }
}

const externalSpecifiers = [
  ...new Set(allSpecifiers.filter((item) => !item.startsWith("./") && !item.startsWith("../")))
];

const p2aCoreExternalUnique = [...new Set(P2A_CORE_EXTERNAL)];

ok(
  p2aCoreExternalUnique.length === 1 && p2aCoreExternalUnique[0] === "node:crypto",
  `isolation: единственная внешняя зависимость P2-A ядра — node:crypto (${p2aCoreExternalUnique.join(", ")})`
);
ok(
  externalSpecifiers.every((item) => item === "node:crypto"),
  `isolation: внешние зависимости слоя — только node:crypto (${externalSpecifiers.join(", ")})`
);
ok(
  !allSpecifiers.some((item) => item.startsWith("@prisma") || item.includes("prisma")),
  "isolation: Prisma в слое не импортируется"
);
ok(
  /createHash/.test(readFileSync(join(backtestDir, "serialize.ts"), "utf8")),
  "isolation: node:crypto используется только для детерминированного sha256"
);

/* ---------- adversarial self-tests (HARDENING #1) ---------- */

const adversarialFixtures = [
  {
    label: 'import x from "@prisma/client" double',
    code: 'import x from "@prisma/client";',
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["@prisma"]
  },
  {
    label: "import x from '@prisma/client' single",
    code: "import x from '@prisma/client';",
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["@prisma"]
  },
  {
    label: 'export {x} from "@prisma/client" double',
    code: 'export {x} from "@prisma/client";',
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["@prisma"]
  },
  {
    label: "export {x} from '@prisma/client' single",
    code: "export {x} from '@prisma/client';",
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["@prisma"]
  },
  {
    label: 'await import("child_process") double',
    code: 'await import("child_process");',
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["child_process"]
  },
  {
    label: "await import('child_process') single",
    code: "await import('child_process');",
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["child_process"]
  },
  {
    label: 'require("@prisma/client") double',
    code: 'const x = require("@prisma/client");',
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["@prisma"]
  },
  {
    label: "require('@prisma/client') single",
    code: "const x = require('@prisma/client');",
    shouldRejectSpecifiers: true,
    forbiddenSubstrings: ["@prisma"]
  },
  {
    label: "process.env dot",
    code: "const v = process.env.NODE_ENV;",
    shouldRejectProcessEnv: true
  },
  {
    label: 'process["env"] bracket double',
    code: 'const v = process["env"];',
    shouldRejectProcessEnv: true
  },
  {
    label: "process['env'] bracket single",
    code: "const v = process['env'];",
    shouldRejectProcessEnv: true
  },
  {
    label: "globalThis.process.env",
    code: "const v = globalThis.process.env;",
    shouldRejectProcessEnv: true
  },
  {
    label: 'globalThis["process"]["env"] bracket double',
    code: 'const v = globalThis["process"]["env"];',
    shouldRejectProcessEnv: true
  },
  {
    label: "process?.env optional chain dot",
    code: "const v = process?.env;",
    shouldRejectProcessEnv: true
  },
  {
    label: "process?.['env'] optional chain bracket single",
    code: "const v = process?.['env'];",
    shouldRejectProcessEnv: true
  },
  {
    label: "process?.[\"env\"] optional chain bracket double",
    code: 'const v = process?.["env"];',
    shouldRejectProcessEnv: true
  },
  {
    label: "process ?. env optional chain with whitespace",
    code: "const v = process ?. env;",
    shouldRejectProcessEnv: true
  },
  {
    label: "globalThis?.process?.env optional chain",
    code: "const v = globalThis?.process?.env;",
    shouldRejectProcessEnv: true
  },
  {
    label: "globalThis?.['process']?.['env'] optional chain brackets single",
    code: "const v = globalThis?.['process']?.['env'];",
    shouldRejectProcessEnv: true
  },
  {
    label: "globalThis?.process[\"env\"] optional chain mixed",
    code: 'const v = globalThis?.process["env"];',
    shouldRejectProcessEnv: true
  },
  {
    label: "globalThis[\"process\"]?.env optional chain mixed",
    code: 'const v = globalThis["process"]?.env;',
    shouldRejectProcessEnv: true
  },
  {
    label: "disallowed ../ dependency from P2-A core",
    code: 'import x from "../strategies/foo";',
    shouldRejectCoreDotDot: true
  }
];

for (const fix of adversarialFixtures) {
  const src = stripComments(fix.code);
  const specs = extractSpecifiersHardened(src);
  const proc = hasProcessEnvViolation(src);
  if (fix.shouldRejectSpecifiers) {
    const hasForbidden = specs.some((s) =>
      (fix.forbiddenSubstrings ?? []).some((sub) => s.includes(sub))
    );
    ok(
      hasForbidden,
      `adversarial: hardened scanner rejects ${fix.label} via specifiers [${specs.join(", ")}]`
    );
  }
  if (fix.shouldRejectProcessEnv) {
    ok(
      proc.violated,
      `adversarial: hardened scanner rejects ${fix.label} via process.env chain [${proc.chains.map((c) => c.join(".")).join(", ")}]`
    );
  }
  if (fix.shouldRejectCoreDotDot) {
    const hasDotDot = specs.some((s) => s.startsWith("../"));
    ok(
      hasDotDot,
      `adversarial: hardened scanner detects ../ in ${fix.label} [${specs.join(", ")}]`
    );
  }
}

// negative controls: comments and string literals mentioning tokens must NOT fail
const negativeFixtures = [
  {
    label: "comment mentioning process.env",
    code: "// process.env should be forbidden but in comment\nconst a = 1;"
  },
  {
    label: "string literal mentioning @prisma/client",
    code: 'const s = "import x from \\"@prisma/client\\"";'
  },
  {
    label: "string literal mentioning process.env",
    code: 'const s = "process.env";'
  },
  {
    label: "string literal mentioning process[\"env\"]",
    code: 'const s = "process[\\"env\\"]";'
  },
  {
    label: "comment mentioning import('child_process')",
    code: "// await import('child_process') is bad\nconst a = 1;"
  },
  {
    label: "string literal mentioning from '@prisma/client'",
    code: "const s = 'from \"@prisma/client\"';"
  },
  {
    label: "comment mentioning process?.env and process?.['env']",
    code: "// process?.env / process?.['env'] are forbidden here\nconst a = 1;"
  },
  {
    label: "comment mentioning globalThis?.process?.env",
    code: "// globalThis?.process?.env is also forbidden\nconst a = 1;"
  },
  {
    label: 'string literal mentioning process?.["env"]',
    code: "const s = 'process?.[\"env\"]';"
  },
  {
    label: "string literal mentioning globalThis?.process?.env",
    code: 'const s = "globalThis?.process?.env";'
  }
];

for (const fix of negativeFixtures) {
  const src = stripComments(fix.code);
  const code = stripCode(fix.code);
  const specs = extractSpecifiersHardened(src);
  const proc = hasProcessEnvViolation(src);
  const forbiddenHits = FORBIDDEN_TOKENS.filter((t) => code.includes(t));
  ok(
    forbiddenHits.length === 0,
    `negative control: ${fix.label} does not trigger FORBIDDEN_TOKENS [${forbiddenHits.join(", ")}]`
  );
  ok(
    !proc.violated,
    `negative control: ${fix.label} does not trigger process.env detection`
  );
  const hasPrismaSpecifier = specs.some((s) => s.includes("prisma") || s.includes("child_process"));
  ok(
    !hasPrismaSpecifier,
    `negative control: ${fix.label} does not trigger specifier detection [${specs.join(", ")}]`
  );
}

/* ---------- mutation control: weaken scanner back to double-quote-only, no dynamic import, no bracket env ---------- */

let mutationFailures = 0;
for (const fix of adversarialFixtures) {
  const src = stripComments(fix.code);
  const weakSpecs = extractSpecifiersWeak(src);
  const weakProc = hasProcessEnvViolationWeak(src);
  let weakDetects = false;
  if (fix.shouldRejectSpecifiers) {
    weakDetects = weakSpecs.some((s) =>
      (fix.forbiddenSubstrings ?? []).some((sub) => s.includes(sub))
    );
    // dynamic import and require and single-quote cases are not covered by weak scanner
    // so we expect weak to MISS those
    if (!weakDetects) mutationFailures++;
  }
  if (fix.shouldRejectProcessEnv) {
    // weak only detects dot forms, not bracket
    const isBracket =
      fix.label.includes('["env"]') || fix.label.includes("['env']") || fix.label.includes('["process"]');
    if (isBracket) {
      if (!weakProc) mutationFailures++;
    }
  }
  if (fix.shouldRejectCoreDotDot) {
    // weak scanner uses from double-quote only, but our ../ fixture uses double quotes, so it would detect;
    // however we intentionally weaken to double-quote only, so this one would still be detected, not counted
  }
}

// specific checks for mutation control demonstration
const singleQuoteFixture = "import x from '@prisma/client';";
const weakSingle = extractSpecifiersWeak(stripComments(singleQuoteFixture));
ok(
  weakSingle.length === 0,
  `mutation control: weak scanner (double-quote only) MISSES single-quote import, got [${weakSingle.join(", ")}]`
);

const dynamicFixture = "await import('child_process');";
const weakDynamic = extractSpecifiersWeak(stripComments(dynamicFixture));
ok(
  weakDynamic.length === 0,
  `mutation control: weak scanner (no dynamic import) MISSES dynamic import('child_process'), got [${weakDynamic.join(", ")}]`
);

const bracketEnvFixture = 'const v = process["env"];';
const weakBracket = hasProcessEnvViolationWeak(bracketEnvFixture);
ok(
  !weakBracket,
  `mutation control: weak scanner (no bracket) MISSES process["env"]`
);

const bracketGlobalFixture = 'const v = globalThis["process"]["env"];';
const weakBracketGlobal = hasProcessEnvViolationWeak(bracketGlobalFixture);
ok(
  !weakBracketGlobal,
  `mutation control: weak scanner (no bracket) MISSES globalThis["process"]["env"]`
);

ok(
  mutationFailures >= 6,
  `mutation control: weakened scanner fails to detect at least 6 adversarial cases (missed ${mutationFailures})`
);

// Отдельный контроль для optional chaining (P2AB HARDENING #2): у «слабого»
// сканера нет поддержки `?.` вообще, поэтому каждый optional-chain фикстур
// обязан им НЕ детектироваться — иначе фикстуры не нагружают новую ветку кода.
const optionalChainFixtures = adversarialFixtures.filter((fix) =>
  fix.label.includes("optional chain")
);

ok(
  optionalChainFixtures.length >= 8,
  `mutation control: ${optionalChainFixtures.length} optional-chain adversarial fixtures are present (expected >= 8)`
);

for (const fix of optionalChainFixtures) {
  const weakProc = hasProcessEnvViolationWeak(fix.code);
  ok(
    !weakProc,
    `mutation control: weak scanner (no optional-chain support) MISSES ${fix.label}`
  );
}


/* ---------- детерминизм и неизменяемость ---------- */

const runA = run(bars60, momentumProvider, momentumConfig);
const runB = run(zigzag(60), momentumProvider, momentumConfig);

ok(runA.ok && runB.ok, "determinism: оба прогона успешны");
ok(
  runA.ok &&
    runB.ok &&
    JSON.stringify(runA.result) === JSON.stringify(runB.result),
  "determinism: идентичный вход → идентичный результат (JSON совпадает)"
);
ok(
  runA.ok &&
    runB.ok &&
    runA.result.metadata.barsFingerprint === runB.result.metadata.barsFingerprint,
  "determinism: отпечаток баров воспроизводим"
);
ok(
  runA.ok &&
    runB.ok &&
    runA.result.metadata.configFingerprint === runB.result.metadata.configFingerprint,
  "determinism: отпечаток конфига воспроизводим"
);

const mutableBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 102, 99, 101),
  mk(2, 101, 112, 100, 111)
];
const beforeMutation = run(mutableBars, [entryDecision("LONG", 95, 110)], ZERO);
const beforeTrades = JSON.stringify(resultOf(beforeMutation)?.trades);

// Мутация входа ПОСЛЕ прогона не имеет права менять уже полученный результат.
(mutableBars[2] as { close: number }).close = 1;
mutableBars.push(mk(3, 1, 2, 0.5, 1));

ok(
  resultOf(beforeMutation) !== null &&
    JSON.stringify(resultOf(beforeMutation)?.trades) === beforeTrades,
  "isolation: мутация массива вызывающего после прогона не меняет результат"
);

let barMutationBlocked = false;
let historyMutationBlocked = false;

run(
  [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
  (context) => {
    try {
      (context.bar as { close: number }).close = 999;
    } catch {
      barMutationBlocked = true;
    }

    try {
      (context.barAt(0) as { open: number }).open = 1;
    } catch {
      historyMutationBlocked = true;
    }

    return null;
  },
  ZERO
);

ok(
  barMutationBlocked,
  "isolation: бар, выданный провайдеру, заморожен — подменить close нельзя"
);
ok(
  historyMutationBlocked,
  "isolation: бар из истории заморожен — подменить open нельзя"
);

const frozenResult = resultOf(runA);

ok(
  frozenResult !== null && Object.isFrozen(frozenResult),
  "isolation: результат заморожен"
);
ok(
  frozenResult !== null && Object.isFrozen(frozenResult.trades),
  "isolation: массив сделок заморожен"
);
ok(
  frozenResult !== null &&
    frozenResult.trades.length > 0 &&
    Object.isFrozen(frozenResult.trades[0]),
  "isolation: сделка заморожена"
);
ok(
  frozenResult !== null && Object.isFrozen(frozenResult.metrics),
  "isolation: метрики заморожены"
);

/* ---------- equity curve ---------- */

const equityRun = resultOf(
  run(LONG_BARS, [entryDecision("LONG", 95, 110)], ZERO)
);

ok(
  equityRun?.equityCurve.length === 2,
  "equity: стартовая точка + точка на каждую сделку"
);
ok(
  equityRun?.equityCurve[0].tradeIndex === -1 &&
    equityRun.equityCurve[0].equity === 10_000,
  "equity: старт с initialEquity и tradeIndex=−1"
);
near(equityRun?.equityCurve[1].equity, 10_010, "equity: накопленный netPnl");

/* ---------- нуль сделок ---------- */

const emptyRun = resultOf(
  run([mk(0, 100, 101, 99, 100), mk(1, 100, 101, 99, 100)], [], ZERO)
);

ok(emptyRun !== null, "zero trades: прогон успешен (пустой результат — не ошибка)");
ok(emptyRun?.metrics.trades === 0, "zero trades: сделок нет");
ok(
  emptyRun?.metrics.winRate === null &&
    emptyRun.metrics.expectancy === null &&
    emptyRun.metrics.avgR === null &&
    emptyRun.metrics.medianR === null,
  "zero trades: все отношения null (не 0)"
);
ok(
  emptyRun?.metrics.profitFactor === null &&
    emptyRun.metrics.profitFactorState === "no-trades",
  "zero trades: PF = null с явным состоянием no-trades"
);
ok(
  emptyRun?.metrics.finalEquity === 10_000 &&
    emptyRun.metrics.maxDrawdown === 0,
  "zero trades: эквити не изменилась, просадки нет"
);
ok(emptyRun?.equityCurve.length === 1, "zero trades: кривая эквити — одна точка");

/* ------------------------------------------------------------------ */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
