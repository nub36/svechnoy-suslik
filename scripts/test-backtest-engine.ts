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
near(entryTrade?.riskAmount, 5, "LONG TP: risk = |100 − 95| × 1");
near(entryTrade?.grossR, 2, "LONG TP: grossR = 10 / 5");
near(entryTrade?.rMultiple, 2, "LONG TP: при нулевой комиссии rMultiple = grossR");
near(entryTrade?.plannedRewardRisk, 2, "LONG TP: плановый R/R = |110 − 100| / |100 − 95| = 2");
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
near(slipLong?.riskAmount, 5.1, "slippage LONG: risk считается от ФАКТИЧЕСКОЙ цены входа");
near(slipLong?.slippageCost, 0.21, "slippage LONG: slippageCost = 0.1 + 0.11");
ok(
  slipLong !== undefined && slipLong.rMultiple < 2,
  "slippage LONG: R ухудшился относительно нулевых издержек"
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
near(feeTrade?.riskAmount, 10, "fees: risk = |100 − 95| × 2");
near(feeTrade?.rMultiple, 1.758, "fees: rMultiple — ЧИСТЫЙ R (net / risk)");
near(feeTrade?.grossR, 2, "fees: grossR — валовый R (gross / risk)");

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

const breached = resultOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 94, 95, 93, 94), mk(2, 94, 95, 93, 94)],
    [entryDecision("LONG", 95, 110)],
    ZERO
  )
);

ok(
  breached?.rejectedSignals[0]?.reason === "entry-levels-breached-at-open",
  "reject: гэп open за уровень — entry-levels-breached-at-open"
);
ok(
  breached?.rejectedSignals[0]?.entryIndex === 1,
  "reject: зафиксирован бар входа, на котором вынесен отказ"
);
ok(
  breached?.rejectedSignals[0]?.referencePrice === 94,
  "reject: опорная цена — open бара входа"
);
ok(
  breached?.metrics.trades === 0,
  "reject: мгновенно выбитая гэпом сделка НЕ фабрикуются"
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
// слиппедж 100 bp поднимает цену входа до 101 — за TP.
const fillOutside = resultOf(
  run(
    LONG_BARS,
    [entryDecision("LONG", 99, 100.2)],
    { ...ZERO, slippage: { kind: "bps", value: 100 } }
  )
);

ok(
  fillOutside?.rejectedSignals[0]?.reason === "entry-fill-outside-levels",
  "reject: экстремальный слиппедж вынес цену входа за уровни"
);
ok(
  fillOutside?.metrics.trades === 0,
  "reject: сделка за собственным TP не открывается"
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
ok(probe.errors.length === 0, "no-lookahead: visibleBars = index + 1 на каждом баре");
ok(
  probe.decisions.every((item) => item.visibleBars === item.index + 1),
  "no-lookahead: видимая история растёт строго на один бар"
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

/* Провайдер, заглядывающий в будущее в обход barAt (замыкание на массив),
 * обязан быть пойман контрфактической проверкой: его решения зависят от
 * будущих баров, поэтому «отравление» будущего их изменит. */
const closureCheater: SignalProvider = (context) => {
  const future = bars60[context.index + 2];

  if (future === undefined) {
    return null;
  }

  return future.close > context.bar.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "cheat")
    : entryDecision("SHORT", context.bar.high, context.bar.low - 1, "cheat");
};
const closureInvariance = assertDecisionInvariance({
  bars: bars60,
  provider: closureCheater,
  config: ZERO,
  boundaryIndex: 40
});

ok(
  !closureInvariance.ok,
  "no-lookahead контрфакт: читер через замыкание на массив ОБНАРУЖЕН"
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
  // Комментарии убираются, чтобы документация («никаких Date.now()»)
  // не давала ложных срабатываний; строковых литералов с «//» в слое нет.
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ");
}

const allSpecifiers: string[] = [];

for (const name of sourceFiles) {
  const source = stripComments(readFileSync(join(backtestDir, name), "utf8"));
  const hits = FORBIDDEN_TOKENS.filter((token) => source.includes(token));

  ok(
    hits.length === 0,
    `isolation: ${name} не использует env/время/случайность/сеть/Prisma (${hits.join(", ")})`
  );

  const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
    (match) => match[1]
  );

  allSpecifiers.push(...specifiers);

  ok(
    // contract.ts импортов не имеет вовсе — это допустимо.
    specifiers.every(
        (specifier) =>
          specifier.startsWith("./") ||
          (specifier === "node:crypto" && name === "serialize.ts")
      ),
    `isolation: ${name} импортирует только слой backtest (${specifiers.join(", ")})`
  );
}

const externalSpecifiers = [
  ...new Set(allSpecifiers.filter((item) => !item.startsWith("./")))
];

ok(
  externalSpecifiers.length === 1 && externalSpecifiers[0] === "node:crypto",
  `isolation: единственная внешняя зависимость слоя — node:crypto (${externalSpecifiers.join(", ")})`
);
ok(
  !allSpecifiers.some((item) => item.startsWith("@prisma") || item.includes("prisma")),
  "isolation: Prisma в слое не импортируется"
);
ok(
  /createHash/.test(readFileSync(join(backtestDir, "serialize.ts"), "utf8")),
  "isolation: node:crypto используется только для детерминированного sha256"
);

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
