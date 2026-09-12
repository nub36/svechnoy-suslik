/**
 * P2-A HARDENING — регрессии на КАЖДОЕ замечание независимого аудита
 * коммита 096e13d2 (исходная P2-A). Файл дополняет, а не заменяет
 * test-backtest-engine / -metrics / -splits.
 *
 * Обязательные adversarial-кейсы (нумерация аудитора):
 *   1  — читер с замыканием на собственный массив: ПРЕДЕЛ
 *        контрфактической диагностики (ok=true) + честная маркировка
 *        отчёта + certifySignalAdapter как структурная альтернатива;
 *   2-3— LONG/SHORT: гэп открытия НА уровне и ЗА уровнем SL;
 *   4-5— LONG/SHORT: гэп открытия НА уровне и ЗА уровнем TP;
 *   6  — вход вблизи SL: знаменатель R не схлопывается (плановый риск);
 *   7  — null-бар;
 *   8  — undefined-бар;
 *   9  — разреженный массив (дыра);
 *   10 — арифметический overflow на конечных, но огромных входах;
 *   11 — вложенная мутация конфига/результата;
 *   12 — реалистичный провайдер, которому нужна история, в сегментном
 *        прогоне (warmupBars = 0);
 *   13 — некорректные бары в сегментном прогоне: стадия "bars", а не
 *        "provider";
 *   14 — visibleBars при warmup > 0;
 *   15 — >150k записей в метриках (Math.max(...arr) больше не
 *        используется);
 *   16 — провайдер не знает, в каком сегменте его прогоняют (слепой OOS).
 *
 * Плюс регрессии на остальные замечания: три базы drawdown (MTM
 * сохранён по имени и значению, добавлен adverse excursion), неизвестные
 * ключи конфига, снэшот решения на баре сигнала, label/facts,
 * open-proximity tie-break по «сырому» open, finalEquity = последняя
 * точка эквити, all-breakeven PF, отставка гэповых кодов отказов.
 *
 * ПОВТОРНЫЙ аудит f87d6f9 (вердикт PASS WITH RISKS) добавил два
 * замечания MEDIUM, закрытые секциями 14-16 этого файла:
 *   NEW-1 — TOCTOU решения: источник мог вернуть объект с геттерами или
 *           Proxy, и движок читал stopLoss/takeProfit/label/facts
 *           несколько раз (валидация → обрамление → снимок), поэтому
 *           «проверили 90 — исполнили −5» было возможно. Теперь решение
 *           читается РОВНО ОДИН РАЗ в неизменяемый снимок ДО валидации
 *           (секция 14: счётчики чтений по каждому полю, геттеры с
 *           подменой и с исключением на втором чтении, Proxy,
 *           детерминизм повтора, снимок адаптера);
 *   NEW-2 — fail-open контейнера `signals`: `{}`, 42, true, Map, Set,
 *           Date, null, undefined и array-like объект молча
 *           интерпретировались как «пустой список решений» и давали
 *           ok:true с нулём сделок. Теперь контейнер классифицируется
 *           строго: Array | функция | валидный SignalAdapter, иначе
 *           структурированный отказ stage "signals"/"adapter"
 *           (секция 15, включая сегментный прогон и диагностику).
 *   Секция 16 — побочные дешёвые hardening-пункты: защита deepFreeze и
 *           скана конечности от циклических ссылок, снятие среза
 *           глубины (NaN глубже 8 уровней больше не пропускается).
 *
 * Никакой финансовой интерпретации: тесты проверяют СЕМАНТИКУ движка, а
 * не прибыльность. Всё детерминировано (без Date.now/random/env/сети).
 */

import {
  BACKTEST_CONTRACT_VERSION,
  BACKTEST_DEFAULTS,
  RETIRED_REJECT_REASONS,
  captureSignalDecision,
  deepFreeze,
  describeValue,
  entryDecision,
  isSignalAdapter,
  noTradeDecision,
  resolveBacktestConfig,
  type BacktestBar,
  type BacktestConfig,
  type BacktestResult,
  type BacktestTrade,
  type Direction,
  type RejectReason,
  type SignalAdapter,
  type SignalContext,
  type SignalDecision,
  type SignalProvider,
  type SignalSource
} from "../lib/backtest/contract";
import { runBacktest } from "../lib/backtest/engine";
import {
  adverseExcursionEquity,
  computeBacktestMetrics,
  markToMarketEquity
} from "../lib/backtest/metrics";
import {
  certifySignalAdapter,
  diagnoseDecisionInvariance,
  poisonFutureBars,
  probeProvider
} from "../lib/backtest/no-lookahead";
import { fingerprintConfig, serializeResult } from "../lib/backtest/serialize";
import { chronologicalSplit, runSegmentedBacktest } from "../lib/backtest/splits";
import {
  captureSignalAdapter,
  classifySignalSource,
  findNonFiniteNumbers,
  validateBars,
  validateSignalAdapter
} from "../lib/backtest/validate";

/* ------------------------------------------------------------------ */
/* Harness                                                              */
/* ------------------------------------------------------------------ */

let passed = 0;
let total = 0;

function ok(condition: boolean, label: string): void {
  total += 1;

  if (condition) {
    passed += 1;
  } else {
    console.log(`FAIL: ${label}`);
  }
}

function near(
  actual: number | null | undefined,
  expected: number,
  label: string,
  eps = 1e-9
): void {
  total += 1;

  if (
    typeof actual === "number" &&
    Number.isFinite(actual) &&
    Math.abs(actual - expected) <= eps
  ) {
    passed += 1;
  } else {
    console.log(
      `FAIL: ${label} (ожидалось ${String(expected)}, получено ${String(actual)})`
    );
  }
}

function section(title: string): void {
  console.log(`\n--- ${title} ---`);
}

function attempt(fn: () => unknown): { threw: boolean; message: string } {
  try {
    fn();

    return { threw: false, message: "" };
  } catch (error) {
    return {
      threw: true,
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/* ------------------------------------------------------------------ */
/* Фикстуры                                                             */
/* ------------------------------------------------------------------ */

const H1 = 3_600_000;

function mk(i: number, open: number, high: number, low: number, close: number): BacktestBar {
  return { time: (i + 1) * H1, open, high, low, close, volume: 1000 };
}

/** Пила 96..104 с валидными OHLC-инвариантами (low ≤ min(o,c) ≤ max(o,c) ≤ high). */
function zigzag(n: number): BacktestBar[] {
  const out: BacktestBar[] = [];

  for (let i = 0; i < n; i += 1) {
    const open = 100 + ((i % 5) - 2) * 2;
    const close = open + (i % 2 === 0 ? 1 : -1);

    out.push({
      time: (i + 1) * H1,
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 1000
    });
  }

  return out;
}

const ZERO: BacktestConfig = {
  slippage: { kind: "bps", value: 0 },
  fees: { bps: 0, fixedPerSide: 0 }
};

const BARS_60 = zigzag(60);

function run(
  bars: readonly BacktestBar[],
  signals: Parameters<typeof runBacktest>[0]["signals"],
  config?: BacktestConfig,
  segment?: Parameters<typeof runBacktest>[0]["segment"]
) {
  return runBacktest({ bars, signals, config, segment });
}

function resultOf(outcome: ReturnType<typeof runBacktest>): BacktestResult | null {
  return outcome.ok ? outcome.result : null;
}

function tradeOf(outcome: ReturnType<typeof runBacktest>): BacktestTrade | undefined {
  return outcome.ok ? outcome.result.trades[0] : undefined;
}

/* ================================================================== */
/* 1. BLOCKER: no-lookahead — структурная гарантия vs контрфакт        */
/* ================================================================== */

section("1. BLOCKER 1: предел контрфактической диагностики (кейс 1)");

/* Читер держит будущие бары в замыкании на массив, который движку НЕ
 * передавался. poisonFutureBars создаёт НОВЫЙ массив, поэтому решения
 * читера не меняются и диагностика проходит зелёной. Это предел метода,
 * и он зафиксирован тестом вместо ложной сертификации. */
const ownCopy = BARS_60.map((bar) => ({ ...bar }));
const closureCheater: SignalProvider = (context) => {
  const future = ownCopy[context.index + 3];

  if (future === undefined) {
    return null;
  }

  return future.close > context.bar.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "cheat", ["cheat"])
    : entryDecision("SHORT", context.bar.high, context.bar.low - 1, "cheat", ["cheat"]);
};

const cheaterDiagnosis = diagnoseDecisionInvariance({
  bars: BARS_60,
  provider: closureCheater,
  config: ZERO,
  boundaryIndex: 40
});

ok(
  cheaterDiagnosis.ok === true,
  "кейс 1: читер с замыканием на собственный массив НЕ обнаруживается — ok=true (это предел метода, а не доказательство каузальности)"
);
ok(
  cheaterDiagnosis.guarantee === "counterfactual-diagnostic",
  "кейс 1: отчёт помечен как ДИАГНОСТИКА (garantia «сертификация» больше не выдаётся)"
);
ok(
  cheaterDiagnosis.limitations.length > 0,
  "кейс 1: ограничения публикуются вместе с отчётом даже при ok=true"
);
ok(
  cheaterDiagnosis.limitations.some((item) =>
    item.toLowerCase().includes("замыкани")
  ),
  "кейс 1: в ограничениях прямо названы замыкания"
);
ok(
  cheaterDiagnosis.limitations.some((item) => item.toLowerCase().includes("ok:true")),
  "кейс 1: в ограничениях сказано, что ok:true не означает отсутствие lookahead"
);
ok(
  cheaterDiagnosis.comparedDecisions === 40,
  "кейс 1: диагностика действительно сравнила 40 решений (не вырождена)"
);

/* Тот же читер, но через канал движка: структурный барьер его ловит. */
const channelCheater: SignalProvider = (context) => {
  const future = context.barAt(context.index + 1);

  return future.close > context.bar.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1)
    : null;
};

const channelRun = run(
  [mk(0, 100, 101, 99, 100), mk(1, 100, 102, 99, 101)],
  channelCheater,
  ZERO
);

ok(
  channelRun.ok === false && channelRun.stage === "provider",
  "структурный барьер: чтение будущего через barAt валит прогон (stage=provider)"
);
ok(
  channelRun.ok === false && channelRun.errors[0].includes("no-lookahead"),
  "структурный барьер: ошибка названа своим именем"
);
ok(
  run(BARS_60, closureCheater, ZERO).ok === true,
  "предел: читер мимо barAt успешно ПРОГОНЯЕТСЯ — барьер покрывает только канал движка"
);

/* Контрфакт ловит lookahead, который идёт ЧЕРЕЗ канал движка. */
const honestProvider: SignalProvider = (context) => {
  if (context.visibleBars < 4) {
    return null;
  }

  const prev = context.barAt(context.index - 1);

  return context.bar.close > prev.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "mom", ["mom"])
    : entryDecision("SHORT", context.bar.high, context.bar.low - 1, "mom", ["mom"]);
};

const honestDiagnosis = diagnoseDecisionInvariance({
  bars: BARS_60,
  provider: honestProvider,
  config: ZERO,
  boundaryIndex: 40
});

ok(
  honestDiagnosis.ok,
  `контрфакт: честный провайдер инвариантен к подмене будущего (${honestDiagnosis.errors.join("; ")})`
);

/* Держатель данных: единственный канал, через который контрфакт может
 * добраться до чужого источника будущего — и только если вызывающий код
 * передал rebind. */
const poisonSource: BacktestBar[] = BARS_60.map((bar) => ({ ...bar }));
const holder: { bars: readonly BacktestBar[] } = { bars: poisonSource };

const holderCheater: SignalProvider = (context) => {
  const future = holder.bars[context.index + 2];

  return future !== undefined && future.close > context.bar.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "hold", ["hold"])
    : null;
};

const withoutRebind = diagnoseDecisionInvariance({
  bars: poisonSource,
  provider: holderCheater,
  config: ZERO,
  boundaryIndex: 40
});

ok(
  withoutRebind.ok === true,
  "предел контрфакта: БЕЗ rebind читер с собственным держателем не обнаруживается (проверка вырождена)"
);
ok(
  withoutRebind.limitations.some((item) => item.includes("rebind")),
  "предел контрфакта: вырожденность без rebind названа в ограничениях"
);

const withRebind = diagnoseDecisionInvariance({
  bars: poisonSource,
  provider: holderCheater,
  config: ZERO,
  boundaryIndex: 40,
  rebind: (bars) => {
    holder.bars = bars;
  }
});

ok(
  withRebind.ok === false,
  `контрфакт: С rebind тот же читер ОБНАРУЖЕН (${withRebind.errors.join("; ").slice(0, 80)})`
);
ok(
  withRebind.errors.some((item) => item.includes("lookahead")),
  "контрфакт: ошибка названа lookahead-ом"
);
ok(
  holder.bars === poisonSource,
  "контрфакт: после диагностики держатель возвращён в исходное состояние (побочных эффектов нет)"
);

/* ---------- certifySignalAdapter: структурная альтернатива ---------- */

const smaAdapter: SignalAdapter = {
  adapterId: "hardening.sma3",
  version: "1.0.0",
  requiredLookbackBars: 3,
  decide: (context) => {
    if (context.visibleBars < 3) {
      return null;
    }

    const sma =
      (context.barAt(context.index - 2).close +
        context.barAt(context.index - 1).close +
        context.bar.close) /
      3;

    return context.bar.close > sma
      ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "sma3", ["sma3"])
      : null;
  }
};

const certification = certifySignalAdapter({
  bars: BARS_60,
  adapter: smaAdapter,
  config: ZERO,
  startIndex: 10,
  endIndexExclusive: 50
});

ok(certification.ok, `certify: адаптер сертифицирован (${certification.errors.join("; ")})`);
ok(
  certification.guarantee === "context-channel-only",
  "certify: гарантия сформулирована как «только канал контекста»"
);
ok(
  certification.limitations.length >= 4,
  "certify: ограничения опубликованы (замыкания/время/сеть не сертифицируемы)"
);
ok(
  certification.structuralProbe !== null && certification.structuralProbe.ok,
  "certify: структурная проба (гарантия A) чистая"
);
ok(
  certification.determinism !== null && certification.determinism.ok,
  "certify: два идентичных прогона дали идентичные решения"
);
ok(
  certification.lookbackReplay !== null &&
    certification.lookbackReplay.ok &&
    certification.lookbackReplay.declaredWarmupBars === 2 &&
    certification.lookbackReplay.extraWarmupBars === 27,
  "certify: заявленный lookback (3 бара → warmup 2) достаточен"
);
ok(
  certification.lookbackReplay !== null &&
    certification.lookbackReplay.historyClampedAtZero === false,
  "certify: проверка lookback не вырождена (история не упёрлась в ноль)"
);
ok(
  certification.invariance !== null &&
    certification.invariance.guarantee === "counterfactual-diagnostic",
  "certify: контрфакт внутри сертификации остаётся ДИАГНОСТИКОЙ"
);
ok(
  certification.adapterId === "hardening.sma3" &&
    certification.adapterVersion === "1.0.0" &&
    certification.requiredLookbackBars === 3,
  "certify: идентичность адаптера отражена в отчёте"
);

/* Адаптер, которому нужно больше истории, чем он заявил. */
const understatedAdapter: SignalAdapter = {
  adapterId: "hardening.understated",
  version: "1.0.0",
  requiredLookbackBars: 2,
  decide: (context) => {
    // Заявлено 2 бара, реально используется 6: при нехватке истории
    // решение ДРУГОЕ (а не ошибка) — именно так выглядит заниженное
    // требование в сегментном прогоне.
    try {
      const deep = context.barAt(context.index - 5);

      return context.bar.close > deep.close
        ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "deep", ["deep"])
        : entryDecision("SHORT", context.bar.high, context.bar.low - 1, "deep", ["deep"]);
    } catch {
      return noTradeDecision("CANNOT_EVALUATE", "not-enough-history", [
        "not-enough-history"
      ]);
    }
  }
};

const understatedCert = certifySignalAdapter({
  bars: BARS_60,
  adapter: understatedAdapter,
  config: ZERO,
  startIndex: 20,
  endIndexExclusive: 55
});

ok(
  understatedCert.ok === false,
  "certify: заниженный requiredLookbackBars НЕ сертифицируется"
);
ok(
  understatedCert.lookbackReplay !== null &&
    understatedCert.lookbackReplay.ok === false &&
    understatedCert.lookbackReplay.errors.some((item) =>
      item.includes("requiredLookbackBars=2")
    ),
  "certify: причина названа — заявленной истории не хватает"
);

/* Адаптер с накопительным состоянием (не воспроизводим). */
let counter = 0;
const statefulAdapter: SignalAdapter = {
  adapterId: "hardening.stateful",
  version: "1.0.0",
  requiredLookbackBars: 1,
  decide: (context) => {
    counter += 1;

    return counter % 7 === 0
      ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "counter", ["counter"])
      : null;
  }
};

const statefulCert = certifySignalAdapter({
  bars: BARS_60,
  adapter: statefulAdapter,
  config: ZERO,
  startIndex: 10,
  endIndexExclusive: 50
});

ok(
  statefulCert.determinism !== null && statefulCert.determinism.ok === false,
  "certify: накапливаемое состояние замыкания ловится проверкой воспроизводимости"
);
ok(
  statefulCert.ok === false &&
    statefulCert.errors.some((item) => item.includes("воспроизводимость")),
  "certify: отказ объяснён воспроизводимостью"
);

/* Невалидные адаптеры. */
const invalidAdapters: { label: string; adapter: unknown }[] = [
  {
    label: "requiredLookbackBars = 0",
    adapter: { ...smaAdapter, requiredLookbackBars: 0 }
  },
  {
    label: "requiredLookbackBars = 2.5",
    adapter: { ...smaAdapter, requiredLookbackBars: 2.5 }
  },
  { label: "нет decide", adapter: { adapterId: "x", version: "1", requiredLookbackBars: 1 } },
  { label: "пустой adapterId", adapter: { ...smaAdapter, adapterId: "  " } },
  { label: "неизвестный ключ", adapter: { ...smaAdapter, lookback: 3 } }
];

for (const item of invalidAdapters) {
  const errors = validateSignalAdapter(item.adapter as SignalAdapter);

  ok(
    errors.length > 0,
    `adapter-валидация: ${item.label} отклонён (${errors.join("; ")})`
  );
}

ok(
  validateSignalAdapter(smaAdapter).length === 0,
  "adapter-валидация: корректный адаптер принят"
);
ok(isSignalAdapter(smaAdapter), "isSignalAdapter: адаптер распознан");
ok(!isSignalAdapter(honestProvider), "isSignalAdapter: функция-провайдер не адаптер");
ok(!isSignalAdapter([]), "isSignalAdapter: список решений не адаптер");

const badAdapterRun = run(BARS_60, {
  ...smaAdapter,
  requiredLookbackBars: 0
} as unknown as SignalAdapter);

ok(
  badAdapterRun.ok === false && badAdapterRun.stage === "adapter",
  "engine: невалидный адаптер → stage=adapter (не provider и не bars)"
);

const clampedCert = certifySignalAdapter({
  bars: BARS_60,
  adapter: smaAdapter,
  config: ZERO,
  startIndex: 2,
  endIndexExclusive: 40
});

ok(
  clampedCert.lookbackReplay !== null &&
    clampedCert.lookbackReplay.historyClampedAtZero === true,
  "certify: вырожденная проверка lookback обнаружена (история упёрлась в начало)"
);
ok(
  clampedCert.limitations.some((item) => item.includes("вырождена")),
  "certify: вырожденность опубликована как ограничение, а не как успех"
);

const badWindowCert = certifySignalAdapter({
  bars: BARS_60,
  adapter: smaAdapter,
  startIndex: 50,
  endIndexExclusive: 40
});

ok(
  badWindowCert.ok === false && badWindowCert.structuralProbe === null,
  "certify: некорректное окно → отказ без запуска прогонов"
);

/* ================================================================== */
/* 2. HIGH 1: гэп на входе — сделка ФИКСИРУЕТСЯ (кейсы 2-5)            */
/* ================================================================== */

section("2. HIGH 1: гэп на входе больше не отклоняет сделку (кейсы 2-5)");

interface GapCase {
  readonly label: string;
  readonly direction: Direction;
  readonly signalClose: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  readonly entryOpen: number;
  readonly expectedExitReason: "STOP_LOSS" | "TAKE_PROFIT";
}

const gapCases: readonly GapCase[] = [
  {
    label: "кейс 2a LONG гэп ЗА SL",
    direction: "LONG",
    signalClose: 100,
    stopLoss: 95,
    takeProfit: 110,
    entryOpen: 94,
    expectedExitReason: "STOP_LOSS"
  },
  {
    label: "кейс 2b LONG гэп НА SL",
    direction: "LONG",
    signalClose: 100,
    stopLoss: 95,
    takeProfit: 110,
    entryOpen: 95,
    expectedExitReason: "STOP_LOSS"
  },
  {
    label: "кейс 4a LONG гэп ЗА TP",
    direction: "LONG",
    signalClose: 100,
    stopLoss: 95,
    takeProfit: 110,
    entryOpen: 115,
    expectedExitReason: "TAKE_PROFIT"
  },
  {
    label: "кейс 4b LONG гэп НА TP",
    direction: "LONG",
    signalClose: 100,
    stopLoss: 95,
    takeProfit: 110,
    entryOpen: 110,
    expectedExitReason: "TAKE_PROFIT"
  },
  {
    label: "кейс 3a SHORT гэп ЗА SL",
    direction: "SHORT",
    signalClose: 100,
    stopLoss: 105,
    takeProfit: 90,
    entryOpen: 106,
    expectedExitReason: "STOP_LOSS"
  },
  {
    label: "кейс 3b SHORT гэп НА SL",
    direction: "SHORT",
    signalClose: 100,
    stopLoss: 105,
    takeProfit: 90,
    entryOpen: 105,
    expectedExitReason: "STOP_LOSS"
  },
  {
    label: "кейс 5a SHORT гэп ЗА TP",
    direction: "SHORT",
    signalClose: 100,
    stopLoss: 105,
    takeProfit: 90,
    entryOpen: 85,
    expectedExitReason: "TAKE_PROFIT"
  },
  {
    label: "кейс 5b SHORT гэп НА TP",
    direction: "SHORT",
    signalClose: 100,
    stopLoss: 105,
    takeProfit: 90,
    entryOpen: 90,
    expectedExitReason: "TAKE_PROFIT"
  }
];

for (const gap of gapCases) {
  const bars: BacktestBar[] = [
    mk(0, gap.signalClose, gap.signalClose + 1, gap.signalClose - 1, gap.signalClose),
    mk(1, gap.entryOpen, gap.entryOpen + 1, gap.entryOpen - 1, gap.entryOpen),
    mk(2, gap.entryOpen, gap.entryOpen + 1, gap.entryOpen - 1, gap.entryOpen)
  ];

  const outcome = run(
    bars,
    [entryDecision(gap.direction, gap.stopLoss, gap.takeProfit, "gap", ["gap"])],
    ZERO
  );
  const result = resultOf(outcome);
  const trade = tradeOf(outcome);

  ok(outcome.ok, `${gap.label}: прогон успешен (сделка не удалена)`);
  ok(
    result?.rejectedSignals.length === 0,
    `${gap.label}: отказов нет — коды entry-levels-breached-at-open / entry-fill-outside-levels в отставке`
  );
  ok(result?.metrics.trades === 1, `${gap.label}: сделка учтена в метриках`);
  ok(
    trade?.entryIndex === 1 && trade.entryPrice === gap.entryOpen,
    `${gap.label}: вход по open бара N+1 (${String(gap.entryOpen)})`
  );
  ok(
    trade?.exitIndex === 1 && trade.exitReason === gap.expectedExitReason,
    `${gap.label}: закрытие по тому же open, exitReason=${gap.expectedExitReason}`
  );
  ok(trade?.gapThrough === true, `${gap.label}: исполнение помечено gapThrough`);
  ok(trade?.barsHeld === 1, `${gap.label}: бар входа считается первым`);
  near(trade?.grossPnl, 0, `${gap.label}: валовый PnL = 0 (вход и выход по одной цене)`);
  near(trade?.netPnl, 0, `${gap.label}: при нулевых издержках net = 0 (breakeven)`);
  near(
    trade?.plannedEntryReference,
    gap.signalClose,
    `${gap.label}: опорная цена = close бара СИГНАЛА`
  );
  near(
    trade?.plannedRisk,
    Math.abs(gap.signalClose - gap.stopLoss),
    `${gap.label}: плановый риск = |ref − sl| × 1`
  );
  near(
    trade?.riskAmount,
    Math.abs(gap.entryOpen - gap.stopLoss),
    `${gap.label}: риск по фактическому входу — диагностика`
  );
  near(trade?.rMultiple, 0, `${gap.label}: R = 0 (знаменатель плановый, не схлопнулся)`);
  ok(
    Number.isFinite(trade?.grossRActualFill ?? Number.NaN),
    `${gap.label}: диагностика по фактическому входу конечна (Infinity нет)`
  );

  // Те же бары с издержками: честный убыток вместо «исчезнувшей» сделки.
  const costly = tradeOf(
    run(
      bars,
      [entryDecision(gap.direction, gap.stopLoss, gap.takeProfit, "gap", ["gap"])],
      {
        ...ZERO,
        slippage: { kind: "bps", value: 10 },
        fees: { bps: 5, fixedPerSide: 0.1 }
      }
    )
  );

  ok(
    costly !== undefined && costly.netPnl < 0,
    `${gap.label}: с издержками гэповый вход — УБЫТОК (а не удаление из выборки)`
  );
  ok(
    costly !== undefined && costly.feesTotal > 0,
    `${gap.label}: комиссия учтена по обеим сторонам`
  );
}

/* Метрики гэповой серии: убыточные исходы видны в выборке. */
const gapMixBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 94, 95, 93, 94),
  mk(2, 94, 95, 93, 94),
  mk(3, 88, 89, 87, 88)
];
const gapMix = resultOf(
  run(
    gapMixBars,
    [
      entryDecision("LONG", 95, 110, "gap", ["gap"]),
      null,
      // Уровни второго сигнала обрамляют close бара 2 (89 < 94 < 105),
      // а вход на баре 3 гэпает ниже SL 89.
      entryDecision("LONG", 89, 105, "gap", ["gap"])
    ],
    { ...ZERO, slippage: { kind: "bps", value: 10 }, fees: { bps: 5, fixedPerSide: 0.1 } }
  )
);

ok(
  gapMix !== null && gapMix.metrics.trades === 2,
  "gap-mix: оба гэповых входа зафиксированы (второй сигнал — после закрытия первого)"
);
ok(
  gapMix !== null && gapMix.metrics.losses === 2 && gapMix.metrics.winRate === 0,
  "gap-mix: убытки видны в winRate (прежде эти сделки исчезали и подкрашивали статистику)"
);
ok(
  gapMix !== null && gapMix.metrics.profitFactorState === "ok",
  "gap-mix: profit factor считается (чистые убытки есть)"
);
ok(
  RETIRED_REJECT_REASONS.length === 2 &&
    RETIRED_REJECT_REASONS.includes("entry-levels-breached-at-open") &&
    RETIRED_REJECT_REASONS.includes("entry-fill-outside-levels"),
  "отставка: оба гэповых кода перечислены в RETIRED_REJECT_REASONS"
);

const retiredInUnion: readonly RejectReason[] = RETIRED_REJECT_REASONS;

ok(
  retiredInUnion.length === 2,
  "отставка: коды сохранены в типе RejectReason (совместимость проекций), но больше не выдаются"
);
ok(
  gapMix !== null &&
    gapMix.rejectedSignals.every(
      (item) => !RETIRED_REJECT_REASONS.includes(item.reason)
    ),
  "отставка: в прогоне с гэпами отозванных кодов нет"
);

/* ================================================================== */
/* 3. HIGH 2: знаменатель R — плановый риск (кейс 6)                   */
/* ================================================================== */

section("3. HIGH 2: R считается от ПЛАНОВОГО риска (кейс 6)");

/* LONG: вход в 0.001 от SL, затем уход к TP. Старая формула
 * (риск от фактического входа) давала R ≈ 19999. */
const nearSlLong = run(
  [
    mk(0, 91, 92, 90, 91),
    mk(1, 90.001, 112, 90.0005, 111),
    mk(2, 111, 112, 110, 111)
  ],
  [entryDecision("LONG", 90, 110, "near-sl", ["near-sl"])],
  ZERO
);
const nearSlLongTrade = tradeOf(nearSlLong);

ok(nearSlLong.ok, "near-SL LONG: прогон успешен");
near(
  nearSlLongTrade?.plannedEntryReference,
  91,
  "near-SL LONG: опорная цена = close бара сигнала (91)"
);
near(nearSlLongTrade?.plannedRisk, 1, "near-SL LONG: плановый риск = |91 − 90| × 1 = 1");
near(
  nearSlLongTrade?.riskAmount,
  Math.abs(90.001 - 90),
  "near-SL LONG: риск по факту входа ≈ 0.001 (диагностика)"
);
near(
  nearSlLongTrade?.grossR,
  (110 - 90.001) / 1,
  "near-SL LONG: grossR ≈ 19.999 / плановый риск 1 — совпадает с плановым R/R ≈ 19"
);
near(
  nearSlLongTrade?.grossRActualFill,
  (110 - 90.001) / Math.abs(90.001 - 90),
  "near-SL LONG: старая формула дала бы ≈19999 — теперь это ТОЛЬКО диагностика"
);
ok(
  (nearSlLongTrade?.grossRActualFill ?? 0) > 19000,
  "near-SL LONG: диагностика по факту входа действительно взрывается (>19000) — вот почему знаменатель плановый"
);
near(
  nearSlLongTrade?.rMultiple,
  (110 - 90.001) / 1,
  "near-SL LONG: заголовный rMultiple — плановый (при нулевых издержках = grossR)"
);
ok(
  Math.abs(nearSlLongTrade?.grossR ?? Number.NaN) <=
    (nearSlLongTrade?.plannedRewardRisk ?? 0) + 1.001,
  "near-SL LONG: R ограничен плановым reward/risk (схлопывания знаменателя нет)"
);

/* SHORT: зеркальный кейс. */
const nearSlShort = run(
  [
    mk(0, 109, 110, 108, 109),
    mk(1, 109.999, 109.9995, 88, 89),
    mk(2, 89, 90, 88, 89)
  ],
  [entryDecision("SHORT", 110, 90, "near-sl", ["near-sl"])],
  ZERO
);
const nearSlShortTrade = tradeOf(nearSlShort);

ok(nearSlShort.ok, "near-SL SHORT: прогон успешен");
near(nearSlShortTrade?.plannedRisk, 1, "near-SL SHORT: плановый риск = |109 − 110| × 1 = 1");
near(
  nearSlShortTrade?.riskAmount,
  Math.abs(109.999 - 110),
  "near-SL SHORT: риск по факту входа ≈ 0.001"
);
near(
  nearSlShortTrade?.grossR,
  (109.999 - 90) / 1,
  "near-SL SHORT: grossR ≈ 19.999 (плановый знаменатель)"
);
near(
  nearSlShortTrade?.grossRActualFill,
  (109.999 - 90) / Math.abs(109.999 - 110),
  "near-SL SHORT: ≈19999 — только диагностика"
);
ok(
  (nearSlShortTrade?.grossRActualFill ?? 0) > 19000,
  "near-SL SHORT: диагностика по факту входа взрывается и у SHORT"
);

/* Гэп вблизи SL (не за уровнем): плановый знаменатель не меняется. */
const nearSlGap = run(
  [mk(0, 100, 101, 99, 100), mk(1, 95.5, 96, 95.2, 95.6), mk(2, 95.6, 96, 95, 95.5)],
  [entryDecision("LONG", 95, 110, "near-gap", ["near-gap"])],
  ZERO
);
const nearSlGapTrade = tradeOf(nearSlGap);

ok(nearSlGap.ok, "near-SL гэп: прогон успешен (open=95.5 не за уровнем 95)");
near(nearSlGapTrade?.plannedRisk, 5, "near-SL гэп: плановый риск = |100 − 95| = 5");
near(nearSlGapTrade?.riskAmount, 0.5, "near-SL гэп: фактический риск = |95.5 − 95| = 0.5 — диагностика");
ok(
  Math.abs(nearSlGapTrade?.grossR ?? Number.NaN) < 100,
  "near-SL гэп: R не взорвался (плановый знаменатель)"
);
near(
  nearSlGapTrade?.rMultipleActualFill,
  (nearSlGapTrade?.netPnl ?? 0) / 0.5,
  "near-SL гэп: диагностика по фактическому входу может быть большой — и это видно отдельно"
);

/* Гэп вблизи TP. */
const nearTpGap = run(
  [mk(0, 100, 101, 99, 100), mk(1, 109.5, 110.4, 109, 110.2), mk(2, 110.2, 111, 109, 110)],
  [entryDecision("LONG", 95, 110, "near-tp", ["near-tp"])],
  ZERO
);

ok(nearTpGap.ok, "near-TP гэп: прогон успешен");
ok(
  tradeOf(nearTpGap)?.exitReason === "TAKE_PROFIT",
  "near-TP гэп: касание TP внутри бара → выход по уровню"
);
near(tradeOf(nearTpGap)?.plannedRisk, 5, "near-TP гэп: плановый риск = 5");
near(
  tradeOf(nearTpGap)?.grossR,
  (110 - 109.5) / 5,
  "near-TP гэп: grossR = (110 − 109.5) / 5 = 0.1 (вход почти у цели)"
);
near(
  tradeOf(nearTpGap)?.riskAmount,
  Math.abs(109.5 - 95),
  "near-TP гэп: риск по факту входа = 14.5 — диагностика"
);

/* Слиппедж и комиссия влияют на ЧИСЛИТЕЛЬ, знаменатель не трогают. */
const slipAndFees = tradeOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 100, 112, 99, 111), mk(2, 111, 112, 110, 111)],
    [entryDecision("LONG", 95, 110, "costs", ["costs"])],
    { slippage: { kind: "bps", value: 25 }, fees: { bps: 10, fixedPerSide: 0.5 } }
  )
);

near(slipAndFees?.plannedRisk, 5, "издержки: плановый риск НЕ зависит от слиппеджа/комиссии");
ok(
  slipAndFees !== undefined &&
    slipAndFees.rMultiple < (slipAndFees.grossR ?? 0),
  "издержки: чистый R меньше валового (комиссия в числителе)"
);
ok(
  slipAndFees !== undefined &&
    slipAndFees.rMultipleActualFill !== slipAndFees.rMultiple,
  "издержки: плановый и фактический R различаются — оба опубликованы"
);

/* Гэп СКВОЗЬ SL и сквозь TP: R конечен и объясним. */
const throughSl = tradeOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 80, 81, 79, 80), mk(2, 80, 81, 79, 80)],
    [entryDecision("LONG", 95, 110, "through-sl", ["through-sl"])],
    ZERO
  )
);

near(throughSl?.grossPnl, 0, "гэп сквозь SL: вход и выход по одному open → gross = 0");
near(throughSl?.rMultiple, 0, "гэп сквозь SL: R = 0, а не −4 (исполнения по 80 не было)");
near(throughSl?.plannedRisk, 5, "гэп сквозь SL: плановый риск = 5");

const throughTp = tradeOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 130, 131, 129, 130), mk(2, 130, 131, 129, 130)],
    [entryDecision("LONG", 95, 110, "through-tp", ["through-tp"])],
    ZERO
  )
);

near(throughTp?.grossPnl, 0, "гэп сквозь TP: gross = 0 (та же цена входа и выхода)");
ok(throughTp?.exitReason === "TAKE_PROFIT", "гэп сквозь TP: триггер — TAKE_PROFIT");
near(throughTp?.rMultiple, 0, "гэп сквозь TP: R = 0 (плановый знаменатель 5)");

/* Метрики: плановый R — заголовок, фактический — диагностика. */
const rMetrics = resultOf(
  run(
    [
      mk(0, 91, 92, 90, 91),
      mk(1, 90.001, 112, 90.0005, 111),
      mk(2, 111, 112, 110, 111)
    ],
    [entryDecision("LONG", 90, 110, "near-sl", ["near-sl"])],
    ZERO
  )
);

const expectedPlannedR = (110 - 90.001) / 1;
const expectedActualFillR = (110 - 90.001) / Math.abs(90.001 - 90);

near(rMetrics?.metrics.avgR, expectedPlannedR, "метрики: avgR — по ПЛАНОВОМУ знаменателю");
near(rMetrics?.metrics.medianR, expectedPlannedR, "метрики: medianR — по ПЛАНОВОМУ знаменателю");
near(
  rMetrics?.metrics.avgRActualFill,
  expectedActualFillR,
  "метрики: avgRActualFill — диагностика по фактическому входу"
);
near(
  rMetrics?.metrics.medianRActualFill,
  expectedActualFillR,
  "метрики: medianRActualFill — диагностика"
);
near(rMetrics?.metrics.avgGrossR, expectedPlannedR, "метрики: avgGrossR — плановый");
ok(
  rMetrics !== null &&
    (rMetrics.metrics.avgRActualFill ?? 0) > (rMetrics.metrics.avgR ?? 0) * 100,
  "метрики: заголовный avgR в ~1000 раз меньше диагностического — схлопывание знаменателя устранено"
);

/* ================================================================== */
/* 4. HIGH 3: validateBars на мусорном входе (кейсы 7-9)               */
/* ================================================================== */

section("4. HIGH 3: null/undefined/разреженные бары (кейсы 7-9)");

const goodBar = mk(0, 100, 101, 99, 100);
const goodBar2 = mk(1, 100, 101, 99, 100);
const resolvedZero = resolveBacktestConfig(ZERO);
const resolvedConfig = resolvedZero.ok ? resolvedZero.config : BACKTEST_DEFAULTS;

const nullBars = [goodBar, null as unknown as BacktestBar, goodBar2];
const undefinedBars = [goodBar, undefined as unknown as BacktestBar, goodBar2];
const sparseBars: BacktestBar[] = [];

sparseBars[0] = goodBar;
sparseBars[2] = goodBar2;

for (const item of [
  { label: "кейс 7 null-бар", bars: nullBars, needle: "не объект" },
  { label: "кейс 8 undefined-бар", bars: undefinedBars, needle: "не объект" },
  { label: "кейс 9 разреженный массив", bars: sparseBars, needle: "дыра разреженного массива" }
]) {
  const validate = attempt(() => validateBars(item.bars, resolvedConfig));
  const engine = attempt(() => run(item.bars, [], ZERO));
  const segmented = attempt(() =>
    runSegmentedBacktest({ bars: item.bars, signals: [], config: ZERO })
  );

  ok(!validate.threw, `${item.label}: validateBars НЕ бросает исключение`);
  ok(!engine.threw, `${item.label}: runBacktest НЕ бросает исключение`);
  ok(!segmented.threw, `${item.label}: runSegmentedBacktest НЕ бросает исключение`);

  const check = validateBars(item.bars, resolvedConfig);

  ok(check.ok === false, `${item.label}: вход отклонён структурированно`);
  ok(
    check.errors.some((error) => error.includes(item.needle)),
    `${item.label}: ошибка называет причину (${check.errors[0] ?? ""})`
  );
  ok(
    check.errors.some((error) => error.includes("bars[1]")),
    `${item.label}: ошибка указывает индекс проблемной записи`
  );

  const outcome = run(item.bars, [], ZERO);

  ok(
    outcome.ok === false && outcome.stage === "bars",
    `${item.label}: engine → stage=bars (без uncaught deref)`
  );

  const seg = runSegmentedBacktest({ bars: item.bars, signals: [], config: ZERO });

  ok(
    seg.ok === false && seg.stage === "split",
    `${item.label}: на 3 барах сегментный прогон отказывает раньше — stage=split (баров слишком мало), без исключений`
  );
}

/* Тот же мусор в массиве достаточной длины: стадия bars сохраняется. */
const longWithNull = zigzag(60).map((bar, index) =>
  index === 37 ? (null as unknown as BacktestBar) : bar
);
const longWithNullSegmented = runSegmentedBacktest({
  bars: longWithNull,
  signals: [],
  config: ZERO
});

ok(
  longWithNullSegmented.ok === false && longWithNullSegmented.stage === "bars",
  "кейс 13/7: null-бар в длинном массиве → сегментный прогон сохраняет stage=bars"
);

const holeSource = zigzag(60);
const longWithHole: BacktestBar[] = [];

for (let i = 0; i < holeSource.length; i += 1) {
  if (i !== 41) {
    longWithHole[i] = holeSource[i] as BacktestBar;
  }
}

const holeSegmented = runSegmentedBacktest({
  bars: longWithHole,
  signals: [],
  config: ZERO
});

ok(
  holeSegmented.ok === false && holeSegmented.stage === "bars",
  "кейс 9/13: дыра в длинном массиве → stage=bars (не split и не provider)"
);

/* Дыра в начале массива. */
const tailSparse: BacktestBar[] = [];

tailSparse[1] = goodBar2;

const tailCheck = validateBars(tailSparse, resolvedConfig);

ok(
  tailCheck.ok === false &&
    tailCheck.errors.some((error) => error.includes("дыра разреженного массива")),
  "разреженность: дыра ПЕРЕД первой записью тоже обнаружена"
);
ok(
  tailCheck.firstBarTime === null && tailCheck.lastBarTime === goodBar2.time,
  "разреженность: firstBarTime не разыменовывает дыру (null), lastBarTime — валидный бар"
);

const mixed = [
  goodBar,
  { ...goodBar2, high: 99 } as BacktestBar,
  null as unknown as BacktestBar
];
const mixedCheck = validateBars(mixed, resolvedConfig);

ok(
  mixedCheck.ok === false && mixedCheck.errors.length >= 2,
  `разреженность: ошибки НЕ сворачиваются после первой невалидной записи (${String(mixedCheck.errors.length)} шт.)`
);

/* ================================================================== */
/* 5. MEDIUM: числовая полнота (кейс 10)                               */
/* ================================================================== */

section("5. MEDIUM: overflow на конечных входах (кейс 10)");

const overflowBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 112, 99, 111),
  mk(2, 111, 112, 110, 111)
];

const overflowCases: { label: string; config: BacktestConfig }[] = [
  { label: "quantity = 1e308", config: { ...ZERO, quantity: 1e308 } },
  {
    label: "fees.bps = 1e308",
    config: { ...ZERO, fees: { bps: 1e308, fixedPerSide: 0 } }
  },
  {
    label: "fees.fixedPerSide = 1e308",
    config: { ...ZERO, fees: { bps: 0, fixedPerSide: 1e308 } }
  },
  {
    label: "slippage absolute 1e308 × quantity 1e10",
    config: {
      ...ZERO,
      quantity: 1e10,
      slippage: { kind: "absolute", value: 1e308 }
    }
  },
  {
    label: "quantity 1e200 при ценах 1e200",
    config: { ...ZERO, quantity: 1e200 }
  }
];

/* Уровни для огромных цен: должны обрамлять close, иначе сигнал
 * отклоняется ещё до арифметики и кейс становится вырожденным. */
const hugeDecision = entryDecision("LONG", 0.95e200, 1.1e200, "huge", ["huge"]);

for (const item of overflowCases) {
  const huge = item.label.includes("1e200");
  const bars = huge
    ? [
        mk(0, 1e200, 1.01e200, 0.99e200, 1e200),
        mk(1, 1e200, 1.12e200, 0.99e200, 1.11e200),
        mk(2, 1.11e200, 1.12e200, 1.1e200, 1.11e200)
      ]
    : overflowBars;
  const outcome = run(
    bars,
    [huge ? hugeDecision : entryDecision("LONG", 95, 110)],
    item.config
  );

  ok(
    outcome.ok === false && outcome.stage === "arithmetic",
    `overflow (${item.label}): stage=arithmetic, а не «красивый» ok:true`
  );
  ok(
    outcome.ok === false &&
      outcome.errors.length > 0 &&
      outcome.errors[0].includes("result."),
    `overflow (${item.label}): ошибка указывает путь до неконечного значения`
  );
}

/* Огромный initialEquity сам по себе НЕ переполняется: отказ обязан
 * быть по делу, а не «на всякий случай» (ложных срабатываний нет). */
const hugeEquity = run(overflowBars, [entryDecision("LONG", 95, 110)], {
  ...ZERO,
  initialEquity: 1e308
});

ok(
  hugeEquity.ok === true,
  "полнота: initialEquity = 1e308 без переполнения → ok:true (проверка не триггерится зря)"
);
ok(
  hugeEquity.ok &&
    findNonFiniteNumbers(hugeEquity.result, "result").length === 0 &&
    attempt(() => serializeResult(hugeEquity.result)).threw === false,
  "полнота: результат с огромной эквити конечен и сериализуем"
);

/* Огромные, но конечные ЦЕНЫ в барах. */
const hugePriceBars: BacktestBar[] = [
  mk(0, 1e300, 1.01e300, 0.99e300, 1e300),
  mk(1, 1e300, 1.12e300, 0.99e300, 1.11e300),
  mk(2, 1.11e300, 1.12e300, 1.1e300, 1.11e300)
];
const hugePrice = run(
  hugePriceBars,
  [entryDecision("LONG", 0.95e300, 1.1e300)],
  { ...ZERO, quantity: 1e10 }
);

ok(
  hugePrice.ok === false && hugePrice.stage === "arithmetic",
  "overflow: огромные цены × количество → stage=arithmetic"
);

/* Успешный результат обязан быть конечным ЦЕЛИКОМ и сериализуем. */
const healthy = run(overflowBars, [entryDecision("LONG", 95, 110)], ZERO);
const healthyResult = resultOf(healthy);

ok(healthy.ok, "полнота: базовый прогон успешен");
ok(
  healthyResult !== null && findNonFiniteNumbers(healthyResult, "result").length === 0,
  "полнота: в успешном результате нет ни одного NaN/Infinity"
);

const serialize = attempt(() =>
  healthyResult === null ? "" : serializeResult(healthyResult)
);

ok(!serialize.threw, "полнота: serializeResult не бросает на успешном результате");
ok(
  !serialize.threw &&
    !/NaN|Infinity/.exec(
      healthyResult === null ? "" : serializeResult(healthyResult)
    ),
  "полнота: в каноническом JSON нет NaN/Infinity"
);

/* Неконечные уровни решения нормализуются в null, причина — в detail. */
const nanLevels = resultOf(
  run(overflowBars, [entryDecision("LONG", Number.NaN, 110)], ZERO)
);

ok(
  nanLevels !== null && nanLevels.rejectedSignals[0]?.stopLoss === null,
  "полнота: NaN-уровень в записи отказа нормализован в null"
);
ok(
  nanLevels !== null &&
    (nanLevels.rejectedSignals[0]?.detail ?? "").includes("NaN"),
  "полнота: фактическое значение NaN сохранено в detail"
);
ok(
  nanLevels !== null &&
    findNonFiniteNumbers(nanLevels, "result").length === 0,
  "полнота: результат с отказом всё равно конечен целиком"
);
ok(
  attempt(() => (nanLevels === null ? "" : serializeResult(nanLevels))).threw === false,
  "полнота: serializeResult не бросает на результате с NaN-отказом"
);

/* ================================================================== */
/* 6. MEDIUM: глубокая неизменяемость (кейс 11)                        */
/* ================================================================== */

section("6. MEDIUM: глубокая неизменяемость конфига и результата (кейс 11)");

const mutableConfig: BacktestConfig = {
  quantity: 2,
  initialEquity: 10_000,
  slippage: { kind: "bps", value: 5 },
  fees: { bps: 5, fixedPerSide: 0.2 }
};
const immutableOutcome = run(
  overflowBars,
  [entryDecision("LONG", 95, 110, "imm", ["imm"])],
  mutableConfig
);
const immutableResult = resultOf(immutableOutcome);

ok(immutableOutcome.ok, "immutability: базовый прогон успешен");
ok(
  immutableResult !== null && Object.isFrozen(immutableResult),
  "immutability: результат заморожен"
);
ok(
  immutableResult !== null && Object.isFrozen(immutableResult.config.slippage),
  "immutability: ВЛОЖЕННЫЙ config.slippage заморожен"
);
ok(
  immutableResult !== null && Object.isFrozen(immutableResult.config.fees),
  "immutability: вложенный config.fees заморожен"
);
ok(
  immutableResult !== null && Object.isFrozen(immutableResult.metrics),
  "immutability: metrics заморожены"
);
ok(
  immutableResult !== null &&
    Object.isFrozen(immutableResult.metrics.exitReasonCounts),
  "immutability: вложенный metrics.exitReasonCounts заморожен"
);
ok(
  immutableResult !== null && Object.isFrozen(immutableResult.metadata),
  "immutability: metadata заморожены"
);
ok(
  immutableResult !== null &&
    immutableResult.trades.length > 0 &&
    Object.isFrozen(immutableResult.trades[0]) &&
    Object.isFrozen(immutableResult.trades[0].facts),
  "immutability: сделка и её facts заморожены"
);
ok(
  immutableResult !== null && Object.isFrozen(immutableResult.equityCurve[0]),
  "immutability: точка эквити заморожена"
);
ok(
  immutableResult !== null && Object.isFrozen(immutableResult.input.decisionCounts),
  "immutability: счётчики решений заморожены"
);

const fingerprintBefore =
  immutableResult === null ? "" : fingerprintConfig(immutableResult.config);

const mutations: { label: string; fn: () => void }[] = [
  {
    label: "config.slippage.value",
    fn: () => {
      if (immutableResult !== null) {
        (immutableResult.config.slippage as { value: number }).value = 999;
      }
    }
  },
  {
    label: "config.fees.bps",
    fn: () => {
      if (immutableResult !== null) {
        (immutableResult.config.fees as { bps: number }).bps = 999;
      }
    }
  },
  {
    label: "metrics.maxDrawdown",
    fn: () => {
      if (immutableResult !== null) {
        (immutableResult.metrics as { maxDrawdown: number }).maxDrawdown = -1;
      }
    }
  },
  {
    label: "metrics.exitReasonCounts.STOP_LOSS",
    fn: () => {
      if (immutableResult !== null) {
        (immutableResult.metrics.exitReasonCounts as { STOP_LOSS: number }).STOP_LOSS = 99;
      }
    }
  },
  {
    label: "trades[0].netPnl",
    fn: () => {
      if (immutableResult !== null) {
        (immutableResult.trades[0] as { netPnl: number }).netPnl = 1e9;
      }
    }
  },
  {
    label: "metadata.configFingerprint",
    fn: () => {
      if (immutableResult !== null) {
        (immutableResult.metadata as { configFingerprint: string }).configFingerprint =
          "подменён";
      }
    }
  }
];

for (const mutation of mutations) {
  const result = attempt(mutation.fn);

  ok(
    result.threw,
    `immutability: мутация ${mutation.label} невозможна (strict mode бросает TypeError)`
  );
}

ok(
  immutableResult !== null &&
    fingerprintConfig(immutableResult.config) === fingerprintBefore &&
    immutableResult.metadata.configFingerprint === fingerprintBefore,
  "immutability: отпечаток конфига НЕ расходится с metadata после попыток мутации"
);
ok(
  immutableResult !== null && immutableResult.config.slippage.value === 5,
  "immutability: значение slippage не изменилось"
);

/* Мутация ВХОДНОГО объекта конфига после запуска не меняет результат. */
(mutableConfig.slippage as { value: number }).value = 500;

ok(
  immutableResult !== null && immutableResult.config.slippage.value === 5,
  "immutability: поздняя мутация входного конфига не влияет на уже полученный результат"
);

/* deepFreeze — публичная утилита контракта. */
const frozen = deepFreeze<{ a: { b: number[] } }>({ a: { b: [1, 2] } });

ok(
  Object.isFrozen(frozen) && Object.isFrozen(frozen.a) && Object.isFrozen(frozen.a.b),
  "deepFreeze: замораживает вложенные объекты и массивы"
);
ok(
  BACKTEST_DEFAULTS !== null &&
    Object.isFrozen(BACKTEST_DEFAULTS) &&
    Object.isFrozen(BACKTEST_DEFAULTS.slippage) &&
    Object.isFrozen(BACKTEST_DEFAULTS.fees),
  "deepFreeze: BACKTEST_DEFAULTS заморожены глубоко"
);
ok(
  attempt(() => {
    (BACKTEST_DEFAULTS.slippage as { value: number }).value = 1;
  }).threw,
  "deepFreeze: дефолты нельзя подменить"
);

/* ================================================================== */
/* 7. MEDIUM: warmup сегментов для адаптера (кейс 12)                  */
/* ================================================================== */

section("7. MEDIUM: заявленная история адаптера в сегментном прогоне (кейс 12)");

const splitWithLookback = chronologicalSplit(60, undefined, 2);

ok(
  splitWithLookback.ok &&
    splitWithLookback.split.warmupStart.VALIDATION ===
      splitWithLookback.split.validation.startIndex - 2 &&
    splitWithLookback.split.warmupStart.OOS ===
      splitWithLookback.split.oos.startIndex - 2,
  "warmup: chronologicalSplit поднимает warmupStart на заявленную историю"
);

const segAdapterRun = runSegmentedBacktest({
  bars: BARS_60,
  signals: smaAdapter,
  config: ZERO
});

ok(segAdapterRun.ok, `warmup: сегментный прогон адаптера успешен (${segAdapterRun.ok ? "" : JSON.stringify(segAdapterRun)})`);

if (segAdapterRun.ok) {
  const segments = [
    segAdapterRun.value.train,
    segAdapterRun.value.validation,
    segAdapterRun.value.oos
  ];

  for (const segment of segments) {
    const outcome = segment.outcome;

    ok(outcome.ok, `warmup: сегмент ${segment.segment} отработал`);
    ok(
      outcome.ok &&
        outcome.result.metadata.historyStartIndex ===
          Math.max(0, segment.window.startIndex - 2),
      `warmup: ${segment.segment} — история поднята на requiredLookbackBars − 1 = 2 бара (warmupBars = 0)`
    );
    ok(
      segment.warmupStartIndex === Math.max(0, segment.window.startIndex - 2),
      `warmup: ${segment.segment} — split.warmupStart согласован с движком`
    );
  }

  ok(
    segAdapterRun.value.train.window.endIndexExclusive ===
      segAdapterRun.value.validation.window.startIndex &&
      segAdapterRun.value.validation.window.endIndexExclusive ===
        segAdapterRun.value.oos.window.startIndex,
    "warmup: сегменты стыкуются вплотную — искусственных разрывов нет"
  );

  /* Решения в сегментах совпадают с решениями полного прогона: разгон
   * даёт адаптеру ту же каузальную историю, что и полный прогон. */
  const fullProbe = probeProvider({
    bars: BARS_60,
    provider: smaAdapter,
    config: ZERO
  });

  for (const segment of [
    segAdapterRun.value.validation,
    segAdapterRun.value.oos
  ]) {
    const segmentProbe = probeProvider({
      bars: BARS_60,
      provider: smaAdapter,
      config: ZERO,
      segment: {
        name: segment.window.name,
        startIndex: segment.window.startIndex,
        endIndexExclusive: segment.window.endIndexExclusive
      }
    });

    const expected = fullProbe.decisions.filter(
      (item) =>
        item.index >= segment.window.startIndex &&
        item.index < segment.window.endIndexExclusive
    );

    ok(
      segmentProbe.decisions.length === expected.length &&
        segmentProbe.decisions.every(
          (item, position) =>
            item.index === expected[position].index &&
            item.kind === expected[position].kind &&
            item.stopLoss === expected[position].stopLoss &&
            item.takeProfit === expected[position].takeProfit
        ),
      `warmup: решения ${segment.window.name} идентичны полному прогону (история достаточна, утечки нет)`
    );
    ok(
      segmentProbe.ok,
      `warmup: структурная проба ${segment.window.name} чистая (${segmentProbe.errors.join("; ")})`
    );
  }
}

/* «Голый» провайдер без заявленной истории в сегменте падает честно. */
const bareProvider: SignalProvider = (context) => {
  const prev = context.barAt(context.index - 1);

  return prev.close < context.bar.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "bare", ["bare"])
    : null;
};

const bareSegmented = runSegmentedBacktest({
  bars: BARS_60,
  signals: bareProvider,
  config: ZERO
});

ok(
  bareSegmented.ok === false && bareSegmented.stage === "provider",
  "warmup: провайдер без declared lookback падает в сегменте структурированно (stage=provider)"
);
ok(
  bareSegmented.ok === false &&
    bareSegmented.errors.some((error) => error.includes("segment-window")),
  "warmup: причина — выход за warmup-окно, а не «магический» отказ"
);

/* Тот же провайдер с явным warmupBars=1: в VALIDATION/OOS история
 * появляется, но на ПЕРВОМ баре всей серии предыдущего бара нет
 * физически — отказ остаётся, и он точечный. */
const bareWithWarmup = runSegmentedBacktest({
  bars: BARS_60,
  signals: bareProvider,
  config: { ...ZERO, warmupBars: 1 }
});

ok(
  bareWithWarmup.ok === false && bareWithWarmup.stage === "provider",
  "warmup: warmupBars=1 снимает проблему в VAL/OOS, но на баре 0 истории нет физически"
);
ok(
  bareWithWarmup.ok === false &&
    bareWithWarmup.errors.length === 1 &&
    bareWithWarmup.errors[0].startsWith("TRAIN") &&
    bareWithWarmup.errors[0].includes("баре 0"),
  `warmup: единственный отказ — TRAIN, бар 0 (${bareWithWarmup.ok ? "" : bareWithWarmup.errors[0].slice(0, 90)})`
);

/* Корректный паттерн для «голого» провайдера: проверять видимость. */
const guardedProvider: SignalProvider = (context) => {
  if (context.visibleBars < 2) {
    return null;
  }

  const prev = context.barAt(context.index - 1);

  return prev.close < context.bar.close
    ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "guarded", ["guarded"])
    : null;
};

const guardedSegmented = runSegmentedBacktest({
  bars: BARS_60,
  signals: guardedProvider,
  config: { ...ZERO, warmupBars: 1 }
});

ok(
  guardedSegmented.ok,
  `warmup: провайдер, проверяющий visibleBars, проходит сегментный прогон (${guardedSegmented.ok ? "" : JSON.stringify(guardedSegmented).slice(0, 120)})`
);

/* Адаптер с requiredLookbackBars = 1 эквивалентен «голому» провайдеру. */
const lookbackOne: SignalAdapter = {
  adapterId: "hardening.lookback1",
  version: "1.0.0",
  requiredLookbackBars: 1,
  decide: (context) =>
    context.bar.close > context.bar.open
      ? entryDecision("LONG", context.bar.low, context.bar.high + 1, "lb1", ["lb1"])
      : null
};

const lookbackOneSegmented = runSegmentedBacktest({
  bars: BARS_60,
  signals: lookbackOne,
  config: ZERO
});

ok(
  lookbackOneSegmented.ok,
  "warmup: requiredLookbackBars=1 не требует дополнительной истории"
);
if (lookbackOneSegmented.ok) {
  ok(
    lookbackOneSegmented.value.validation.warmupStartIndex ===
      lookbackOneSegmented.value.validation.window.startIndex,
    "warmup: при requiredLookbackBars=1 warmup не поднимается (0 баров)"
  );
}

/* ================================================================== */
/* 8. MEDIUM: стадии отказов сегментного прогона (кейс 13)             */
/* ================================================================== */

section("8. MEDIUM: сохранение внутренних стадий (кейс 13)");

const malformedBars: BacktestBar[] = zigzag(60).map((bar, index) =>
  index === 37 ? ({ ...bar, high: bar.low - 1 } as BacktestBar) : bar
);

const malformedSegmented = runSegmentedBacktest({
  bars: malformedBars,
  signals: smaAdapter,
  config: ZERO
});

ok(
  malformedSegmented.ok === false && malformedSegmented.stage === "bars",
  `кейс 13: некорректные бары → stage=bars, а не provider (${malformedSegmented.ok ? "ok" : malformedSegmented.stage})`
);
ok(
  malformedSegmented.ok === false &&
    malformedSegmented.errors.every((error) => error.includes("[stage=bars]")),
  "кейс 13: стадия видна и в тексте каждой ошибки"
);

/* Разные сегменты — разные стадии: сообщается стадия ПЕРВОГО упавшего. */
const oosOnlyFailure: SignalProvider = (context) => {
  if (context.index >= 48) {
    throw new Error("adapter exploded in OOS");
  }

  return null;
};

const mixedStages = runSegmentedBacktest({
  bars: BARS_60,
  signals: oosOnlyFailure,
  config: ZERO
});

ok(
  mixedStages.ok === false && mixedStages.stage === "provider",
  "кейс 13: отказ только в OOS → stage=provider (стадия сохранена)"
);
ok(
  mixedStages.ok === false &&
    mixedStages.errors.every((error) => error.startsWith("OOS")),
  "кейс 13: ошибка указывает именно упавший сегмент"
);

/* Невалидный адаптер в сегментном прогоне. */
const badAdapterSegmented = runSegmentedBacktest({
  bars: BARS_60,
  signals: { ...smaAdapter, requiredLookbackBars: -3 } as unknown as SignalAdapter,
  config: ZERO
});

ok(
  badAdapterSegmented.ok === false && badAdapterSegmented.stage === "adapter",
  "кейс 13: невалидный адаптер → stage=adapter (до разбиения на сегменты)"
);

/* Неизвестный ключ конфига. */
const unknownKeySegmented = runSegmentedBacktest({
  bars: BARS_60,
  signals: [],
  config: { ...ZERO, timeoutBar: 5 } as unknown as BacktestConfig
});

ok(
  unknownKeySegmented.ok === false && unknownKeySegmented.stage === "config",
  "кейс 13: неизвестный ключ конфига → stage=config"
);

/* Стадии одиночного прогона — полный набор. */
const stageMatrix: { label: string; stage: string; outcome: ReturnType<typeof runBacktest> }[] =
  [
    {
      label: "config",
      stage: "config",
      outcome: run(BARS_60, [], { ...ZERO, warmupBarz: 3 } as unknown as BacktestConfig)
    },
    {
      label: "adapter",
      stage: "adapter",
      outcome: run(BARS_60, {
        ...smaAdapter,
        requiredLookbackBars: 1.5
      } as unknown as SignalAdapter)
    },
    {
      label: "bars",
      stage: "bars",
      outcome: run([mk(0, 100, 99, 101, 100)], [], ZERO)
    },
    {
      label: "provider",
      stage: "provider",
      outcome: run(BARS_60, () => {
        throw new Error("provider exploded");
      })
    },
    {
      label: "arithmetic",
      stage: "arithmetic",
      outcome: run(overflowBars, [entryDecision("LONG", 95, 110)], {
        ...ZERO,
        quantity: 1e308
      })
    }
  ];

for (const item of stageMatrix) {
  ok(
    item.outcome.ok === false && item.outcome.stage === item.stage,
    `стадии: ${item.label} → stage="${item.stage}"`
  );
}

ok(
  BACKTEST_CONTRACT_VERSION === "p2a-1.2.0",
  `версия контракта поднята до p2a-1.2.0 (${BACKTEST_CONTRACT_VERSION})`
);

/* ================================================================== */
/* 9. MEDIUM: visibleBars (кейс 14)                                    */
/* ================================================================== */

section("9. MEDIUM: visibleBars = index − firstVisibleIndex + 1 (кейс 14)");

const warmupProbe = probeProvider({
  bars: BARS_60,
  provider: honestProvider,
  config: { ...ZERO, warmupBars: 5 },
  segment: { name: "VALIDATION", startIndex: 20, endIndexExclusive: 35 }
});

ok(warmupProbe.ok, `кейс 14: проба с warmup=5 чистая (${warmupProbe.errors.join("; ")})`);
ok(
  warmupProbe.decisions.every(
    (item) => item.visibleBars === item.index - item.firstVisibleIndex + 1
  ),
  "кейс 14: visibleBars равен числу баров, достижимых через barAt"
);
ok(
  warmupProbe.decisions[0]?.firstVisibleIndex === 15 &&
    warmupProbe.decisions[0]?.visibleBars === 6,
  "кейс 14: при warmup=5 и startIndex=20 видно 6 баров (15..20), а не 21"
);
ok(
  warmupProbe.decisions.every((item) => item.visibleBars !== item.index + 1),
  "кейс 14: старая формула index+1 больше не выдаётся (она завышала историю)"
);
ok(
  warmupProbe.windowFailures.length === 0,
  "кейс 14: чтение до warmup-окна заблокировано на всех барах"
);
ok(
  warmupProbe.guardFailures.length === 0,
  "кейс 14: чтение будущего заблокировано на всех барах"
);

const warmupResult = resultOf(
  run(BARS_60, honestProvider, { ...ZERO, warmupBars: 5 }, {
    name: "VALIDATION",
    startIndex: 20,
    endIndexExclusive: 35
  })
);

ok(
  warmupResult?.metadata.historyStartIndex === 15,
  "кейс 14: historyStartIndex публикуется в метаданных"
);
ok(
  warmupResult?.metadata.warmupStartIndex === 15,
  "кейс 14: warmupStartIndex внутри сегмента сохранён без изменения смысла"
);

const noWarmup = resultOf(
  run(BARS_60, [], ZERO, { name: "OOS", startIndex: 30, endIndexExclusive: 40 })
);

ok(
  noWarmup?.metadata.historyStartIndex === 30,
  "кейс 14: при warmup=0 история начинается ровно с границы окна"
);

const fullRunMeta = resultOf(run(BARS_60, [], { ...ZERO, warmupBars: 4 }));

ok(
  fullRunMeta?.metadata.historyStartIndex === 0 &&
    fullRunMeta?.metadata.warmupStartIndex === null,
  "кейс 14: полный прогон — historyStartIndex=0, warmupStartIndex остаётся null (совместимость)"
);

/* ================================================================== */
/* 10. MEDIUM: >150k записей в метриках (кейс 15)                      */
/* ================================================================== */

section("10. MEDIUM: 160k сделок без Math.max(...arr) (кейс 15)");

const LARGE_COUNT = 160_000;

function tradeFixture(index: number, netPnl: number): BacktestTrade {
  const time = (index + 1) * H1;
  const direction: Direction = index % 2 === 0 ? "LONG" : "SHORT";
  const entry = 100;
  const exit = direction === "LONG" ? entry + netPnl : entry - netPnl;

  return {
    id: index,
    direction,
    signalIndex: index,
    signalTime: time,
    entryIndex: index,
    entryTime: time,
    plannedEntryPrice: entry,
    entryPrice: entry,
    exitIndex: index,
    exitTime: time,
    plannedExitPrice: exit,
    exitPrice: exit,
    exitReason: "TIMEOUT",
    gapThrough: false,
    sameBarAmbiguity: false,
    barsHeld: index % 7,
    quantity: 1,
    stopLoss: 95,
    takeProfit: 110,
    plannedEntryReference: entry,
    plannedRisk: 5,
    riskAmount: 5,
    plannedRewardRisk: 3,
    grossPnl: netPnl,
    feeEntry: 0,
    feeExit: 0,
    feesTotal: 0,
    slippageCost: 0,
    netPnl,
    grossR: netPnl / 5,
    rMultiple: netPnl / 5,
    grossRActualFill: netPnl / 5,
    rMultipleActualFill: netPnl / 5,
    label: "fixture",
    facts: ["fixture"]
  };
}

const largeTrades: BacktestTrade[] = [];
const largeBars: BacktestBar[] = [];

for (let i = 0; i < LARGE_COUNT; i += 1) {
  largeTrades.push(tradeFixture(i, i % 3 === 0 ? -1 : i));
  largeBars.push(mk(i, 100, 101, 99, 100));
}

const spreadProbe = attempt(() =>
  Math.max(...largeTrades.map((trade) => trade.netPnl))
);

ok(
  spreadProbe.threw,
  `кейс 15: контроль — Math.max(...${String(LARGE_COUNT)}) действительно падает (${spreadProbe.message.slice(0, 40)}), поэтому замена на цикл доказательна`
);

const largeMetricsAttempt = attempt(() =>
  computeBacktestMetrics({
    trades: largeTrades,
    bars: largeBars,
    startIndex: 0,
    endIndexExclusive: LARGE_COUNT,
    config: resolvedConfig
  })
);

ok(
  !largeMetricsAttempt.threw,
  `кейс 15: метрики на ${String(LARGE_COUNT)} сделках НЕ бросают RangeError`
);

if (!largeMetricsAttempt.threw) {
  const largeMetrics = computeBacktestMetrics({
    trades: largeTrades,
    bars: largeBars,
    startIndex: 0,
    endIndexExclusive: LARGE_COUNT,
    config: resolvedConfig
  });

  const expectedLargestWin = largeTrades.reduce(
    (best, trade) => (trade.netPnl > best ? trade.netPnl : best),
    -Number.MAX_VALUE
  );

  ok(largeMetrics.trades === LARGE_COUNT, "кейс 15: число сделок учтено");
  near(largeMetrics.largestWin, expectedLargestWin, "кейс 15: largestWin найден циклом");
  near(largeMetrics.largestLoss, -1, "кейс 15: largestLoss найден циклом");
  ok(largeMetrics.maxBarsHeld === 6, "кейс 15: maxBarsHeld найден циклом");
  ok(
    Number.isFinite(largeMetrics.medianR ?? Number.NaN) &&
      Number.isFinite(largeMetrics.avgR ?? Number.NaN),
    "кейс 15: медиана/среднее конечны на большом объёме"
  );
  ok(
    findNonFiniteNumbers(largeMetrics, "metrics").length === 0,
    "кейс 15: в метриках нет неконечных значений"
  );
}

/* Прогон движка на большом объёме (интеграция, а не только метрики). */
const engineScale = 20_000;
const scaleBars = zigzag(engineScale);
const scaleOutcome = run(scaleBars, smaAdapter, { ...ZERO, timeoutBars: 3 });

ok(
  scaleOutcome.ok,
  `масштаб: прогон ${String(engineScale)} баров успешен (${scaleOutcome.ok ? String(scaleOutcome.result.trades.length) + " сделок" : JSON.stringify(scaleOutcome)})`
);
ok(
  scaleOutcome.ok &&
    findNonFiniteNumbers(scaleOutcome.result, "result").length === 0,
  "масштаб: глубокий скан результата на большом прогоне конечен"
);
ok(
  scaleOutcome.ok &&
    attempt(() => serializeResult(scaleOutcome.result)).threw === false,
  "масштаб: сериализация большого результата не бросает"
);

/* ================================================================== */
/* 11. OOS-контекст: провайдер не знает сегмент (кейс 16)              */
/* ================================================================== */

section("11. Кейс 16: слепой OOS — метки сегмента в контексте нет");

const seenContexts: SignalContext[] = [];
const observerProvider: SignalProvider = (context) => {
  seenContexts.push(context);

  return null;
};

run(BARS_60, observerProvider, ZERO, {
  name: "OOS",
  startIndex: 30,
  endIndexExclusive: 40
});

ok(seenContexts.length === 10, "слепой OOS: контекст выдан на каждом баре окна");
ok(
  seenContexts.every((context) => !("segment" in context)),
  "слепой OOS: поля segment в SignalContext НЕТ (метка TRAIN/VAL/OOS не передаётся)"
);
ok(
  seenContexts.every(
    (context) =>
      Object.keys(context)
        .slice()
        .sort()
        .join(",") ===
      [
        "bar",
        "barAt",
        "firstVisibleIndex",
        "index",
        "position",
        "visibleBars"
      ]
        .sort()
        .join(",")
  ),
  "слепой OOS: набор полей контекста зафиксирован (регрессия на возврат метки)"
);
ok(
  seenContexts.every((context) => Object.isFrozen(context)),
  "слепой OOS: контекст заморожен"
);

/* Состояние движка сбрасывается на границе сегмента, а состояние
 * замыкания провайдера — НЕТ (документируется тестом). */
const stateLog: string[] = [];
let closureCalls = 0;

const statefulObserver: SignalProvider = (context) => {
  closureCalls += 1;
  stateLog.push(`${context.index}:${String(closureCalls)}`);

  return null;
};

const statefulSegmented = runSegmentedBacktest({
  bars: BARS_60,
  signals: statefulObserver,
  config: ZERO
});

ok(statefulSegmented.ok, "состояние: сегментный прогон выполнен");
ok(
  closureCalls === 60,
  `состояние: провайдер вызван на всех 60 барах (факт: ${String(closureCalls)})`
);

if (statefulSegmented.ok) {
  const oosWindow = statefulSegmented.value.oos.window;
  const firstOosCall = stateLog.find((item) =>
    item.startsWith(`${String(oosWindow.startIndex)}:`)
  );
  const counterAtOos = firstOosCall === undefined ? 0 : Number(firstOosCall.split(":")[1]);

  ok(
    counterAtOos > 1,
    `состояние: счётчик замыкания НЕ сбрасывается на границе OOS (первый вызов OOS — №${String(counterAtOos)}): сброс состояния провайдера — обязанность автора стратегии`
  );
  ok(
    statefulSegmented.value.oos.outcome.ok &&
      statefulSegmented.value.oos.outcome.result.metrics.trades === 0 &&
      statefulSegmented.value.oos.outcome.result.metrics.finalEquity ===
        BACKTEST_DEFAULTS.initialEquity,
    "состояние: движок сбрасывает сделки и эквити на границе сегмента"
  );
}

/* ================================================================== */
/* 12. MEDIUM: три базы drawdown (MTM сохранён + добавлен MAE)         */
/* ================================================================== */

section("12. MTM сохранён по имени/значению + консервативный adverse excursion");

/* LONG: close стоит на месте, но внутри бара цена уходит к 90. */
const maeLongBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 101, 99, 100),
  mk(2, 100, 101, 90, 100),
  mk(3, 100, 101, 90, 100),
  mk(4, 100, 112, 99, 111)
];
const maeLong = resultOf(
  run(maeLongBars, [entryDecision("LONG", 85, 110, "mae", ["mae"])], ZERO)
);

ok(maeLong !== null && maeLong.metrics.trades === 1, "MAE LONG: сделка одна");
near(
  maeLong?.metrics.maxDrawdown,
  0,
  "MAE LONG: реализованная просадка 0 (сделка закрыта в плюс)"
);
near(
  maeLong?.metrics.maxDrawdownMarkToMarket,
  0,
  "MAE LONG: close-to-close MTM = 0 — имя и значение СОХРАНЕНЫ, но база не консервативна"
);
near(
  maeLong?.metrics.maxAdverseExcursionDrawdown,
  10,
  "MAE LONG: консервативная база видит внутрибарный уход к 90 (−10)"
);
near(
  maeLong?.metrics.maxAdverseExcursionDrawdownPct,
  0.1,
  "MAE LONG: процент от пика 10000 = 0.1%",
  1e-9
);
ok(
  maeLong !== null &&
    maeLong.metrics.maxAdverseExcursionDrawdown >=
      maeLong.metrics.maxDrawdownMarkToMarket,
  "MAE LONG: adverse excursion ≥ close-to-close MTM (по построению)"
);
ok(
  maeLong !== null &&
    maeLong.metrics.maxAdverseExcursionDrawdown >= maeLong.metrics.maxDrawdown,
  "MAE LONG: adverse excursion ≥ реализованной просадки"
);
ok(
  adverseExcursionEquity({
    trades: maeLong?.trades ?? [],
    bars: maeLongBars,
    startIndex: 0,
    endIndexExclusive: maeLongBars.length,
    config: resolvedConfig
  }).some((point) => point.equity === 9990),
  "MAE LONG: кривая adverse excursion содержит точку 9990"
);
ok(
  markToMarketEquity({
    trades: maeLong?.trades ?? [],
    bars: maeLongBars,
    startIndex: 0,
    endIndexExclusive: maeLongBars.length,
    config: resolvedConfig
  }).every((point) => point.equity >= 10_000),
  "MAE LONG: close-to-close кривая не опускается ниже старта (слепая зона задокументирована)"
);

/* SHORT: зеркальный кейс — неблагоприятный экстремум это high. */
const maeShortBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 101, 99, 100),
  mk(2, 100, 108, 99, 100),
  mk(3, 100, 101, 88, 89)
];
const maeShort = resultOf(
  run(maeShortBars, [entryDecision("SHORT", 115, 90, "mae", ["mae"])], ZERO)
);

near(
  maeShort?.metrics.maxDrawdownMarkToMarket,
  0,
  "MAE SHORT: close-to-close MTM = 0"
);
near(
  maeShort?.metrics.maxAdverseExcursionDrawdown,
  8,
  "MAE SHORT: неблагоприятный экстремум SHORT — high (108) → просадка 8"
);

/* equityNonPositive учитывает все три базы. */
ok(
  maeLong?.metrics.equityNonPositive === false,
  "MAE: equityNonPositive=false, когда все три базы положительны"
);

const bustBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  mk(1, 100, 101, 1, 2),
  mk(2, 2, 3, 1, 2)
];
const bust = resultOf(
  run(bustBars, [entryDecision("LONG", 95, 110, "bust", ["bust"])], {
    ...ZERO,
    initialEquity: 4,
    quantity: 1
  })
);

ok(
  bust !== null && bust.metrics.equityNonPositive === true,
  "MAE: уход эквити ≤ 0 виден во флаге (маржинальной модели нет)"
);

/* ================================================================== */
/* 13. LOW: остальные замечания аудита                                 */
/* ================================================================== */

section("13. LOW: неизвестные ключи, снэшот решения, tie-break, finalEquity, PF");

/* ---------- неизвестные ключи конфига (fail closed) ---------- */

const unknownTop = resolveBacktestConfig({
  ...ZERO,
  timeoutBar: 5
} as unknown as BacktestConfig);

ok(
  !unknownTop.ok &&
    unknownTop.errors.some((error) => error.includes('неизвестный ключ "timeoutBar"')),
  "конфиг: опечатка timeoutBar отклонена (fail closed), а не принята за «таймаута нет»"
);

const unknownNested = resolveBacktestConfig({
  ...ZERO,
  slippage: { kind: "bps", value: 1, bps: 2 }
} as unknown as BacktestConfig);

ok(
  !unknownNested.ok &&
    unknownNested.errors.some((error) => error.includes("config.slippage")),
  "конфиг: неизвестный ключ ВНУТРИ slippage отклонён"
);

const unknownFees = resolveBacktestConfig({
  ...ZERO,
  fees: { bps: 1, fixed: 2 }
} as unknown as BacktestConfig);

ok(
  !unknownFees.ok &&
    unknownFees.errors.some((error) => error.includes("config.fees")),
  "конфиг: неизвестный ключ ВНУТРИ fees отклонён"
);

ok(
  resolveBacktestConfig(ZERO).ok,
  "конфиг: валидный конфиг по-прежнему принимается"
);

const unknownKeyRun = run(BARS_60, [], {
  ...ZERO,
  warmupBarz: 3
} as unknown as BacktestConfig);

ok(
  unknownKeyRun.ok === false && unknownKeyRun.stage === "config",
  "конфиг: engine отклоняет неизвестный ключ на стадии config"
);

/* ---------- снэшот решения на баре сигнала ---------- */

const mutatingDecisions: SignalDecision[] = [];
const mutatingProvider: SignalProvider = (context) => {
  // Мутируем ПРЕДЫДУЩЕЕ решение после того, как оно возвращено движку.
  for (const previous of mutatingDecisions) {
    const target = previous as unknown as {
      stopLoss?: number;
      takeProfit?: number;
      label?: string;
      facts?: string[];
    };

    target.stopLoss = 1;
    target.takeProfit = 999;
    target.label = "подменено";

    if (Array.isArray(target.facts)) {
      target.facts.push("подменённый факт");
    }
  }

  if (context.index !== 0) {
    return null;
  }

  const decision = entryDecision("LONG", 95, 110, "оригинал", ["оригинал"]);

  mutatingDecisions.push(decision as SignalDecision);

  return decision;
};

const snapshotOutcome = run(
  overflowBars,
  mutatingProvider,
  ZERO
);
const snapshotTrade = tradeOf(snapshotOutcome);

ok(snapshotOutcome.ok, "снэшот: прогон успешен");
near(snapshotTrade?.stopLoss, 95, "снэшот: SL сделки — оригинальный (мутация объекта решения не прошла)");
near(snapshotTrade?.takeProfit, 110, "снэшот: TP сделки — оригинальный");
ok(snapshotTrade?.label === "оригинал", "снэшот: label сделки — оригинальный");
ok(
  snapshotTrade?.facts.length === 1 && snapshotTrade.facts[0] === "оригинал",
  "снэшот: facts скопированы (push в исходный массив не прошёл)"
);
near(
  snapshotTrade?.plannedEntryReference,
  100,
  "снэшот: опорная цена зафиксирована на баре сигнала"
);

/* ---------- label/facts проверяются в момент принятия ---------- */

const badLabelRun = run(BARS_60, [
  { kind: "LONG", stopLoss: 95, takeProfit: 110, label: 42, facts: [] } as unknown as SignalDecision
]);

ok(
  badLabelRun.ok === false &&
    badLabelRun.stage === "provider" &&
    badLabelRun.errors.some((error) => error.includes("label")),
  "решение: label не-строка → структурированная ошибка провайдера"
);

const badFactsRun = run(BARS_60, [
  { kind: "LONG", stopLoss: 95, takeProfit: 110, label: "x", facts: "не массив" } as unknown as SignalDecision
]);

ok(
  badFactsRun.ok === false &&
    badFactsRun.errors.some((error) => error.includes("facts")),
  "решение: facts не-массив → структурированная ошибка"
);

const badFactItemRun = run(BARS_60, [
  { kind: "LONG", stopLoss: 95, takeProfit: 110, label: "x", facts: ["ok", 7] } as unknown as SignalDecision
]);

ok(
  badFactItemRun.ok === false &&
    badFactItemRun.errors.some((error) => error.includes("только строки")),
  "решение: не-строка внутри facts → структурированная ошибка"
);

const noLabelRun = resultOf(
  run(
    overflowBars,
    [
      {
        kind: "LONG",
        stopLoss: 95,
        takeProfit: 110
      } as unknown as SignalDecision
    ],
    ZERO
  )
);

ok(
  noLabelRun !== null &&
    noLabelRun.trades[0]?.label === "" &&
    noLabelRun.trades[0]?.facts.length === 0,
  "решение: отсутствие label/facts допустимо и нормализуется в \"\" / []"
);

/* ---------- open-proximity: tie-break по «сырому» open, ничья → SL ---------- */

const tieBars: BacktestBar[] = [
  mk(0, 100, 101, 99, 100),
  // open = 100, SL = 98, TP = 102 → дистанции равны (2 и 2); оба уровня
  // касаются внутри бара (low 97, high 103).
  mk(1, 100, 103, 97, 100),
  mk(2, 100, 101, 99, 100)
];

const tieRun = resultOf(
  run(tieBars, [entryDecision("LONG", 98, 102, "tie", ["tie"])], {
    ...ZERO,
    sameBarPolicy: "open-proximity"
  })
);

ok(
  tieRun?.trades[0]?.exitReason === "STOP_LOSS",
  "tie-break: при равенстве дистанций выбирается SL (пессимистично)"
);
ok(
  tieRun?.trades[0]?.sameBarAmbiguity === true,
  "tie-break: неоднозначность одного бара помечена"
);

/* Со слиппеджем фактический вход уезжает к TP, но tie-break обязан
 * считаться от «сырого» open бара. */
const tieSlipped = resultOf(
  run(tieBars, [entryDecision("LONG", 98, 102, "tie", ["tie"])], {
    ...ZERO,
    sameBarPolicy: "open-proximity",
    slippage: { kind: "absolute", value: 1.5 }
  })
);

ok(
  tieSlipped?.trades[0]?.exitReason === "STOP_LOSS",
  "tie-break: базис — СЫРОЙ bar.open, а не цена со слиппеджем (иначе выбрало бы TP)"
);
near(
  tieSlipped?.trades[0]?.entryPrice,
  101.5,
  "tie-break: фактический вход со слиппеджем 101.5 (на выбор это не влияет)"
);

/* ---------- maxDrawdownPct = 0 при нулевой просадке ---------- */

ok(
  maeLong?.metrics.maxDrawdownPct === 0,
  "drawdown: при нулевой просадке и положительной эквити процент = 0 (не null)"
);
ok(
  maeLong?.metrics.maxDrawdownMarkToMarketPct === 0 &&
    maeLong?.metrics.maxAdverseExcursionDrawdownPct !== null,
  "drawdown: проценты всех трёх баз определены при положительной эквити"
);

/* ---------- all-breakeven: PF = null, состояние "no-losses" ---------- */

const breakevenOnly = resultOf(
  run(
    [mk(0, 100, 101, 99, 100), mk(1, 94, 95, 93, 94), mk(2, 94, 95, 93, 94)],
    [entryDecision("LONG", 95, 110, "be", ["be"])],
    ZERO
  )
);

ok(
  breakevenOnly?.metrics.breakeven === 1 &&
    breakevenOnly?.metrics.wins === 0 &&
    breakevenOnly?.metrics.losses === 0,
  "all-breakeven: сделка классифицирована как breakeven"
);
ok(
  breakevenOnly?.metrics.profitFactor === null &&
    breakevenOnly?.metrics.profitFactorState === "no-losses",
  "all-breakeven: PF = null с состоянием \"no-losses\" (не Infinity и не «прибыль»)"
);
ok(
  breakevenOnly?.metrics.winRate === 0,
  "all-breakeven: winRate = 0 (breakeven не считается победой)"
);
near(breakevenOnly?.metrics.expectancy, 0, "all-breakeven: expectancy = 0");

/* ---------- finalEquity согласована с кривой эквити ---------- */

const equityRun = resultOf(
  run(
    zigzag(40),
    honestProvider,
    { ...ZERO, timeoutBars: 2, initialEquity: 12_345.67 }
  )
);

ok(equityRun !== null && equityRun.trades.length > 3, "эквити: прогон с несколькими сделками");
ok(
  equityRun !== null &&
    equityRun.metrics.finalEquity ===
      equityRun.equityCurve[equityRun.equityCurve.length - 1].equity,
  "эквити: finalEquity РАВЕН последней точке кривой (самосогласованность отчёта)"
);
ok(
  equityRun !== null &&
    Math.abs(
      equityRun.metrics.finalEquity -
        (equityRun.config.initialEquity + equityRun.metrics.totalNetPnl)
    ) < 1e-9,
  "эквити: finalEquity = initialEquity + totalNetPnl с точностью до порядка сложения"
);
ok(
  equityRun !== null &&
    equityRun.equityCurve[0].tradeIndex === -1 &&
    equityRun.equityCurve[0].equity === equityRun.config.initialEquity,
  "эквити: первая точка — старт с initialEquity"
);

/* ---------- poisonFutureBars: прошлое не меняется ---------- */

const poison = poisonFutureBars(BARS_60, 40, 2);

ok(
  poison.slice(0, 40).every((bar, index) => bar.close === BARS_60[index].close),
  "poison: прошлое не изменено"
);
ok(
  poison[45].close === BARS_60[45].close * 2,
  "poison: будущее изменено"
);
ok(
  poison.every(
    (bar) => bar.high >= Math.max(bar.open, bar.close) && bar.low <= Math.min(bar.open, bar.close)
  ),
  "poison: OHLC-инварианты сохранены (подмена валидна)"
);

/* ================================================================== */
/* 14. NEW-1 (MEDIUM): TOCTOU — решение читается РОВНО ОДИН РАЗ         */
/* ================================================================== */

section("14. NEW-1: TOCTOU — одиночное чтение решения в неизменяемый снимок");

/**
 * Решение с геттерами и счётчиком чтений.
 *
 * `sequence` — значения по номеру чтения: первое чтение получает
 * sequence[0], второе — sequence[1] (последнее значение «залипает»).
 * `throwFrom` — номер чтения (1-based), начиная с которого геттер бросает
 * исключение: если движок перечитывает поле, прогон падает, а не «молча
 * исполняет» другое значение.
 */
function countingDecision(
  spec: {
    readonly kind?: readonly unknown[];
    readonly stopLoss?: readonly unknown[];
    readonly takeProfit?: readonly unknown[];
    readonly label?: readonly unknown[];
    readonly facts?: readonly unknown[];
    readonly throwFrom?: Partial<Record<string, number>>;
  },
  counts: Record<string, number>
): SignalDecision {
  const target: Record<string, unknown> = {};

  const define = (
    key: string,
    sequence: readonly unknown[] | undefined,
    fallback: unknown
  ): void => {
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get(): unknown {
        counts[key] = (counts[key] ?? 0) + 1;

        const from = spec.throwFrom === undefined ? undefined : spec.throwFrom[key];

        if (from !== undefined && counts[key] >= from) {
          throw new Error(`повторное чтение поля "${key}" — TOCTOU`);
        }

        if (sequence === undefined || sequence.length === 0) {
          return fallback;
        }

        return sequence[Math.min(counts[key] - 1, sequence.length - 1)];
      }
    });
  };

  define("kind", spec.kind, "LONG");
  define("stopLoss", spec.stopLoss, 90);
  define("takeProfit", spec.takeProfit, 110);
  define("label", spec.label, "hostile");
  define("facts", spec.facts, Object.freeze(["hostile"]));

  return target as unknown as SignalDecision;
}

/** Список решений: все null, кроме одного индекса. */
function onlyAt(
  index: number,
  decision: unknown,
  length = 60
): (SignalDecision | null)[] {
  const list: (SignalDecision | null)[] = new Array(length).fill(null);

  list[index] = decision as SignalDecision;

  return list;
}

/* ---------- 14.1 сценарий аудитора: stopLoss 90 → −5 ---------- */

const countsSl: Record<string, number> = {};
const slRun = run(
  BARS_60,
  onlyAt(10, countingDecision({ stopLoss: [90, -5] }, countsSl)),
  ZERO
);
const slTrade = tradeOf(slRun);

ok(
  slRun.ok === true,
  `TOCTOU stopLoss: прогон успешен (${slRun.ok ? "ok" : slRun.errors.join("; ")})`
);
ok(
  slTrade !== undefined && slTrade.stopLoss === 90,
  `TOCTOU stopLoss: исполнен ПРОВЕРЕННЫЙ уровень 90, а не −5 (получено ${String(
    slTrade === undefined ? "нет сделки" : slTrade.stopLoss
  )})`
);
ok(
  slTrade !== undefined && slTrade.stopLoss !== -5,
  "TOCTOU stopLoss: подменённое значение −5 нигде не исполнено"
);
ok(
  countsSl.stopLoss === 1,
  `TOCTOU stopLoss: поле прочитано РОВНО один раз (прочтений ${String(countsSl.stopLoss)})`
);
near(
  slTrade === undefined ? null : slTrade.plannedRisk,
  slTrade === undefined
    ? 0
    : Math.abs(slTrade.plannedEntryReference - 90) * slTrade.quantity,
  "TOCTOU stopLoss: плановый риск считается от исполненного уровня 90"
);

/* ---------- 14.2 takeProfit меняется при повторном чтении ---------- */

const countsTp: Record<string, number> = {};
const tpRun = run(
  BARS_60,
  onlyAt(10, countingDecision({ takeProfit: [110, 5] }, countsTp)),
  ZERO
);
const tpTrade = tradeOf(tpRun);

ok(
  tpTrade !== undefined && tpTrade.takeProfit === 110,
  `TOCTOU takeProfit: исполнено первое (проверенное) значение 110 (получено ${String(
    tpTrade === undefined ? "нет сделки" : tpTrade.takeProfit
  )})`
);
ok(
  countsTp.takeProfit === 1,
  `TOCTOU takeProfit: поле прочитано один раз (прочтений ${String(countsTp.takeProfit)})`
);

/* ---------- 14.3 label меняется при повторном чтении ---------- */

const countsLabel: Record<string, number> = {};
const labelRun = run(
  BARS_60,
  onlyAt(10, countingDecision({ label: ["первая", "вторая"] }, countsLabel)),
  ZERO
);
const labelTrade = tradeOf(labelRun);

ok(
  labelTrade !== undefined && labelTrade.label === "первая",
  `TOCTOU label: в сделке первое значение (${String(
    labelTrade === undefined ? "нет сделки" : labelTrade.label
  )})`
);
ok(
  countsLabel.label === 1,
  `TOCTOU label: поле прочитано один раз (прочтений ${String(countsLabel.label)})`
);

/* ---------- 14.4 facts меняется при повторном чтении ---------- */

const sharedFacts: string[] = ["первый"];
const countsFacts: Record<string, number> = {};
const factsRun = run(
  BARS_60,
  onlyAt(
    10,
    countingDecision({ facts: [sharedFacts, ["второй"]] }, countsFacts)
  ),
  ZERO
);
const factsTrade = tradeOf(factsRun);

ok(
  factsTrade !== undefined && factsTrade.facts.join("|") === "первый",
  `TOCTOU facts: в сделке копия первого массива (${String(
    factsTrade === undefined ? "нет сделки" : factsTrade.facts.join("|")
  )})`
);
ok(
  countsFacts.facts === 1,
  `TOCTOU facts: поле прочитано один раз (прочтений ${String(countsFacts.facts)})`
);
ok(
  factsTrade !== undefined && (factsTrade.facts as unknown) !== (sharedFacts as unknown),
  "TOCTOU facts: движок хранит КОПИЮ, а не ссылку на чужой массив"
);
ok(
  factsTrade !== undefined && Object.isFrozen(factsTrade.facts),
  "TOCTOU facts: копия заморожена"
);

const mutateFacts = attempt(() => {
  sharedFacts.push("поздняя мутация");
});

ok(
  !mutateFacts.threw &&
    factsTrade !== undefined &&
    factsTrade.facts.join("|") === "первый",
  "TOCTOU facts: мутация исходного массива ПОСЛЕ прогона не меняет сделку"
);

/* ---------- 14.5 все поля: по одному чтению, повтор бросает ---------- */

const countsThrow: Record<string, number> = {};
const throwRun = run(
  BARS_60,
  onlyAt(
    10,
    countingDecision(
      { throwFrom: { kind: 2, stopLoss: 2, takeProfit: 2, label: 2, facts: 2 } },
      countsThrow
    )
  ),
  ZERO
);

ok(
  throwRun.ok === true,
  `TOCTOU: геттеры бросают на ВТОРОМ чтении — прогон всё равно успешен, значит повторных чтений нет (${
    throwRun.ok ? "ok" : throwRun.errors.join("; ")
  })`
);
ok(
  ["kind", "stopLoss", "takeProfit", "label", "facts"].every(
    (key) => countsThrow[key] === 1
  ),
  `TOCTOU: каждое из пяти полей прочитано ровно один раз (${JSON.stringify(countsThrow)})`
);

/* ---------- 14.6 Proxy-backed решение ---------- */

const proxyReads: Record<string, number> = {};
let proxyFlip = false;

const proxyDecision = new Proxy(
  {
    kind: "LONG",
    stopLoss: 90,
    takeProfit: 110,
    label: "proxy",
    facts: ["proxy"]
  },
  {
    get(target, prop, receiver): unknown {
      if (typeof prop !== "string") {
        return Reflect.get(target, prop, receiver);
      }

      proxyReads[prop] = (proxyReads[prop] ?? 0) + 1;

      if (prop === "stopLoss") {
        proxyFlip = !proxyFlip;

        return proxyFlip ? 90 : -5;
      }

      if (prop === "takeProfit") {
        return proxyReads[prop] === 1 ? 110 : 5;
      }

      return Reflect.get(target, prop, receiver);
    }
  }
) as unknown as SignalDecision;

const proxyRun = run(BARS_60, onlyAt(10, proxyDecision), ZERO);
const proxyTrade = tradeOf(proxyRun);

ok(
  proxyTrade !== undefined &&
    proxyTrade.stopLoss === 90 &&
    proxyTrade.takeProfit === 110,
  `TOCTOU Proxy: исполнены первые прочитанные уровни (sl=${String(
    proxyTrade === undefined ? "-" : proxyTrade.stopLoss
  )}, tp=${String(proxyTrade === undefined ? "-" : proxyTrade.takeProfit)})`
);
ok(
  ["kind", "stopLoss", "takeProfit", "label", "facts"].every(
    (key) => proxyReads[key] === 1
  ),
  `TOCTOU Proxy: ловушка get вызвана по одному разу на поле (${JSON.stringify(proxyReads)})`
);

/* ---------- 14.7 детерминизм: одинаковые геттеры → одинаковый результат ---------- */

function identicalHostileRun(): ReturnType<typeof runBacktest> {
  const counts: Record<string, number> = {};

  return run(
    BARS_60,
    onlyAt(
      10,
      countingDecision(
        { stopLoss: [90, -5], takeProfit: [110, 5], label: ["a", "b"], facts: [["x"], ["y"]] },
        counts
      )
    ),
    ZERO
  );
}

const firstHostile = identicalHostileRun();
const secondHostile = identicalHostileRun();

ok(
  firstHostile.ok === true && secondHostile.ok === true,
  "TOCTOU детерминизм: оба прогона с одинаковым поведением геттеров успешны"
);
ok(
  firstHostile.ok &&
    secondHostile.ok &&
    serializeResult(firstHostile.result) === serializeResult(secondHostile.result),
  "TOCTOU детерминизм: идентичное поведение геттеров даёт идентичный результат"
);

/* ---------- 14.8 первое чтение невалидно → отказ, а не «второй шанс» ---------- */

const countsBadFirst: Record<string, number> = {};
const badFirstRun = run(
  BARS_60,
  onlyAt(10, countingDecision({ stopLoss: [-5, 90] }, countsBadFirst)),
  ZERO
);
const badFirstResult = resultOf(badFirstRun);
const badFirstReject =
  badFirstResult === null ? undefined : badFirstResult.rejectedSignals[0];

ok(
  badFirstRun.ok === true &&
    badFirstResult !== null &&
    badFirstResult.trades.length === 0,
  "TOCTOU: невалидное ПЕРВОЕ значение уровня даёт отказ сигнала, а не сделку"
);
ok(
  badFirstReject !== undefined && badFirstReject.reason === "invalid-levels",
  `TOCTOU: причина отказа — invalid-levels (${String(
    badFirstReject === undefined ? "нет записи" : badFirstReject.reason
  )})`
);
ok(
  badFirstReject !== undefined && badFirstReject.detail.includes("-5"),
  "TOCTOU: в причине видно именно прочитанное значение −5"
);
ok(
  badFirstReject !== undefined && badFirstReject.stopLoss === -5,
  `TOCTOU: в записи отказа видно ПРОЧИТАННОЕ значение −5, а не 90 из второго чтения (${String(
    badFirstReject === undefined ? "нет записи" : badFirstReject.stopLoss
  )})`
);
ok(
  countsBadFirst.stopLoss === 1,
  `TOCTOU: после отказа поле НЕ перечитывается (прочтений ${String(countsBadFirst.stopLoss)})`
);

/* ---------- 14.8b геттер, который БРОСАЕТ, — отказ провайдера, не исключение ---------- */

const throwingDecision = {
  get kind(): string {
    return "LONG";
  },
  get stopLoss(): number {
    throw new Error("hostile getter stopLoss");
  },
  takeProfit: 110,
  label: "x",
  facts: ["x"]
} as unknown as SignalDecision;

const throwingAttempt = attempt(() => run(BARS_60, onlyAt(10, throwingDecision), ZERO));

ok(
  !throwingAttempt.threw,
  `TOCTOU: бросающий геттер не роняет движок (${throwingAttempt.message})`
);

const throwingRun = run(BARS_60, onlyAt(10, throwingDecision), ZERO);

ok(
  throwingRun.ok === false && throwingRun.stage === "provider",
  `TOCTOU: бросающий геттер → структурированный отказ stage="provider" (получено ${
    throwingRun.ok ? "ok:true" : throwingRun.stage
  })`
);
ok(
  throwingRun.ok === false &&
    throwingRun.errors.some((error) => error.includes("hostile getter stopLoss")),
  "TOCTOU: причина исключения источника видна в ошибках"
);

/* ---------- 14.9 no-trade решение тоже читается один раз ---------- */

const countsNoTrade: Record<string, number> = {};
const noTradeRun = run(
  BARS_60,
  onlyAt(
    10,
    countingDecision(
      { kind: ["CANNOT_EVALUATE"], stopLoss: [90, -5] },
      countsNoTrade
    )
  ),
  ZERO
);
const noTradeResult = resultOf(noTradeRun);

ok(
  noTradeResult !== null && noTradeResult.input.decisionCounts.CANNOT_EVALUATE === 1,
  "TOCTOU: CANNOT_EVALUATE учтён отдельно от NEUTRAL"
);
ok(
  countsNoTrade.kind === 1 &&
    countsNoTrade.stopLoss === 1 &&
    countsNoTrade.takeProfit === 1 &&
    countsNoTrade.label === 1 &&
    countsNoTrade.facts === 1,
  `TOCTOU: no-trade решение тоже читается по одному разу на поле (${JSON.stringify(countsNoTrade)})`
);

/* ---------- 14.10 снимок адаптера: decide/requiredLookbackBars ---------- */

const adapterCounts: Record<string, number> = {};
let decideFlip = false;

const firstDecide: SignalProvider = (context) =>
  entryDecision("LONG", context.bar.low, context.bar.high + 1, "первый decide", [
    "первый"
  ]);
const secondDecide: SignalProvider = (context) =>
  entryDecision("LONG", context.bar.low, context.bar.high + 1, "второй decide", [
    "второй"
  ]);

const hostileAdapter = {
  get adapterId(): string {
    adapterCounts.adapterId = (adapterCounts.adapterId ?? 0) + 1;

    return adapterCounts.adapterId === 1 ? "hostile-adapter" : "подменённый";
  },
  get version(): string {
    adapterCounts.version = (adapterCounts.version ?? 0) + 1;

    return adapterCounts.version === 1 ? "1.0.0" : "9.9.9";
  },
  get requiredLookbackBars(): number {
    adapterCounts.requiredLookbackBars =
      (adapterCounts.requiredLookbackBars ?? 0) + 1;

    return adapterCounts.requiredLookbackBars === 1 ? 1 : 25;
  },
  get decide(): SignalProvider {
    adapterCounts.decide = (adapterCounts.decide ?? 0) + 1;
    decideFlip = !decideFlip;

    return decideFlip ? firstDecide : secondDecide;
  }
} as unknown as SignalAdapter;

// Сегментное окно: warmupStartIndex виден в метаданных только при
// segment !== null, а значит проверка «warmup по ПЕРВОМУ чтению
// requiredLookbackBars» становится наблюдаемой (rlb=1 → warmup 0 баров,
// rlb=25 → warmup 24 бара и warmupStartIndex уехал бы в 0).
const hostileAdapterRun = run(BARS_60, hostileAdapter, ZERO, {
  name: "VALIDATION",
  startIndex: 20,
  endIndexExclusive: 40
});
const hostileAdapterResult = resultOf(hostileAdapterRun);
const hostileAdapterTrade = tradeOf(hostileAdapterRun);

ok(
  hostileAdapterRun.ok === true,
  `TOCTOU адаптер: прогон успешен (${
    hostileAdapterRun.ok ? "ok" : hostileAdapterRun.errors.join("; ")
  })`
);
ok(
  hostileAdapterResult !== null &&
    hostileAdapterResult.metadata.adapterId === "hostile-adapter" &&
    hostileAdapterResult.metadata.adapterVersion === "1.0.0",
  "TOCTOU адаптер: в метаданных ПЕРВЫЕ прочитанные идентичность и версия"
);
ok(
  hostileAdapterResult !== null &&
    hostileAdapterResult.metadata.requiredLookbackBars === 1 &&
    hostileAdapterResult.metadata.warmupStartIndex === 20,
  `TOCTOU адаптер: warmup посчитан по ПЕРВОМУ requiredLookbackBars=1, а не по 25 (warmupStartIndex=${String(
    hostileAdapterResult === null ? "-" : hostileAdapterResult.metadata.warmupStartIndex
  )})`
);
ok(
  hostileAdapterTrade !== undefined &&
    hostileAdapterTrade.label === "первый decide",
  `TOCTOU адаптер: исполнена ПЕРВАЯ прочитанная decide (${String(
    hostileAdapterTrade === undefined ? "нет сделки" : hostileAdapterTrade.label
  )})`
);
ok(
  ["adapterId", "version", "requiredLookbackBars", "decide"].every(
    (key) => adapterCounts[key] === 1
  ),
  `TOCTOU адаптер: каждое поле прочитано один раз (${JSON.stringify(adapterCounts)})`
);

/* ---------- 14.11 юнит: captureSignalDecision ---------- */

const notObjects: readonly [string, unknown][] = [
  ["null", null],
  ["undefined", undefined],
  ["число", 42],
  ["строка", "LONG"],
  ["массив", []],
  ["функция", (): number => 1],
  ["Map", new Map()],
  ["Date", new Date(0)]
];

for (const [label, value] of notObjects) {
  const capture = captureSignalDecision(value);

  ok(
    capture.ok === false && capture.errors.length > 0,
    `снимок решения: ${label} — не объект решения → отказ (${
      capture.ok ? "ok" : capture.errors.join("; ")
    })`
  );
}

const badKindCapture = captureSignalDecision({
  kind: "BUY",
  stopLoss: 90,
  takeProfit: 110,
  label: "x",
  facts: []
});

ok(
  badKindCapture.ok === false &&
    badKindCapture.errors.some((error) => error.includes("неизвестный kind")),
  "снимок решения: неизвестный kind отклонён"
);

const badLabelCapture = captureSignalDecision({
  kind: "LONG",
  stopLoss: 90,
  takeProfit: 110,
  label: 7,
  facts: []
});

ok(
  badLabelCapture.ok === false &&
    badLabelCapture.errors.some((error) => error.includes("label")),
  "снимок решения: label не-строка отклонён"
);

const badFactsCapture = captureSignalDecision({
  kind: "LONG",
  stopLoss: 90,
  takeProfit: 110,
  label: "x",
  facts: "не массив"
});

ok(
  badFactsCapture.ok === false &&
    badFactsCapture.errors.some((error) => error.includes("массивом строк")),
  "снимок решения: facts не-массив отклонён"
);

const badFactItemCapture = captureSignalDecision({
  kind: "LONG",
  stopLoss: 90,
  takeProfit: 110,
  label: "x",
  facts: ["ok", 7]
});

ok(
  badFactItemCapture.ok === false &&
    badFactItemCapture.errors.some((error) => error.includes("только строки")),
  "снимок решения: не-строка внутри facts отклонена"
);

const goodCapture = captureSignalDecision({
  kind: "SHORT",
  stopLoss: 105,
  takeProfit: 95,
  label: "setup",
  facts: ["ob", "fvg"],
  side: "buy",
  note: "лишнее поле"
});

ok(goodCapture.ok === true, "снимок решения: валидное решение принято");
ok(
  goodCapture.ok &&
    goodCapture.decision.kind === "SHORT" &&
    goodCapture.decision.stopLoss === 105 &&
    goodCapture.decision.takeProfit === 95 &&
    goodCapture.decision.label === "setup" &&
    goodCapture.decision.facts.join("|") === "ob|fvg",
  "снимок решения: значения скопированы точно"
);
ok(
  goodCapture.ok &&
    goodCapture.decision.extraKeys.join("|") === "side|note",
  "снимок решения: неиспользуемые собственные поля перечислены в extraKeys"
);
ok(
  goodCapture.ok &&
    Object.isFrozen(goodCapture.decision) &&
    Object.isFrozen(goodCapture.decision.facts),
  "снимок решения: снимок и facts заморожены"
);

const snapshotMutation = goodCapture.ok
  ? attempt(() => {
      (goodCapture.decision as unknown as { label: string }).label = "подмена";
    })
  : { threw: false, message: "" };

ok(
  goodCapture.ok && Object.isFrozen(goodCapture.decision),
  "снимок решения: снимок заморожен"
);
ok(
  goodCapture.ok &&
    (snapshotMutation.threw || goodCapture.decision.label === "setup"),
  "снимок решения: попытка мутировать снимок не меняет значение (frozen; в strict mode — TypeError)"
);

const defaultsCapture = captureSignalDecision({ kind: "NEUTRAL" });

ok(
  defaultsCapture.ok &&
    defaultsCapture.decision.label === "" &&
    defaultsCapture.decision.facts.length === 0,
  "снимок решения: label/facts по умолчанию — пустая строка и пустой замороженный массив"
);

/* ---------- 14.12 юнит: describeValue не вызывает чужой toString ---------- */

ok(describeValue(null) === "null", "describeValue: null");
ok(describeValue(undefined) === "undefined", "describeValue: undefined");
ok(describeValue(42) === "число 42", "describeValue: число");
ok(describeValue(true) === "булево true", "describeValue: boolean");
ok(describeValue("abc") === 'строка "abc"', "describeValue: строка");
ok(describeValue(new Map()) === "[object Map]", "describeValue: Map");
ok(describeValue(new Set()) === "[object Set]", "describeValue: Set");
ok(describeValue(new Date(0)) === "[object Date]", "describeValue: Date");
ok(describeValue([]) === "[object Array]", "describeValue: массив");
ok(describeValue((): number => 1) === "функция", "describeValue: функция");

const hostileToString = attempt(() =>
  describeValue({
    toString(): string {
      throw new Error("hostile toString");
    }
  })
);

ok(
  !hostileToString.threw,
  "describeValue: чужой toString не вызывается (hostile-значение не роняет отказ)"
);

/* ================================================================== */
/* 15. NEW-2 (MEDIUM): контейнер `signals` — строгая классификация      */
/* ================================================================== */

section("15. NEW-2: недопустимый контейнер signals больше не fail-open");

const validListDecision = entryDecision("LONG", 90, 110, "список", ["список"]);

const badContainers: readonly {
  readonly label: string;
  readonly value: unknown;
  readonly stage: "signals" | "adapter";
}[] = [
  { label: "пустой объект {}", value: {}, stage: "signals" },
  { label: "число 42", value: 42, stage: "signals" },
  { label: "true", value: true, stage: "signals" },
  { label: "false", value: false, stage: "signals" },
  { label: "строка", value: "LONG", stage: "signals" },
  { label: "new Map()", value: new Map(), stage: "signals" },
  { label: "new Set()", value: new Set(), stage: "signals" },
  { label: "new Date(0)", value: new Date(0), stage: "signals" },
  { label: "null", value: null, stage: "signals" },
  { label: "undefined", value: undefined, stage: "signals" },
  {
    label: "Map с решениями",
    value: new Map<number, SignalDecision>([[10, validListDecision]]),
    stage: "signals"
  },
  {
    label: "array-like {0: decision, length: 1}",
    value: { 0: validListDecision, length: 1 },
    stage: "signals"
  },
  {
    label: "объект с length без числовых ключей",
    value: { length: 3 },
    stage: "signals"
  },
  {
    label: "класс-экземпляр без decide",
    value: new (class Strategy {
      decideLater(): number {
        return 1;
      }
    })(),
    stage: "signals"
  },
  {
    label: "адаптер БЕЗ decide",
    value: { adapterId: "a", version: "1.0.0", requiredLookbackBars: 1 },
    stage: "adapter"
  },
  {
    label: "адаптер с опечаткой Decide",
    value: {
      adapterId: "a",
      version: "1.0.0",
      requiredLookbackBars: 1,
      Decide: (): null => null
    },
    stage: "adapter"
  },
  {
    label: "адаптер с decide не-функция",
    value: {
      adapterId: "a",
      version: "1.0.0",
      requiredLookbackBars: 1,
      decide: 42
    },
    stage: "adapter"
  },
  {
    label: "адаптер с мусорным requiredLookbackBars",
    value: {
      adapterId: "a",
      version: "1.0.0",
      requiredLookbackBars: 0,
      decide: (): null => null
    },
    stage: "adapter"
  },
  {
    label: "адаптер без идентичности",
    value: {
      adapterId: "",
      version: "1.0.0",
      requiredLookbackBars: 1,
      decide: (): null => null
    },
    stage: "adapter"
  }
];

for (const item of badContainers) {
  const outcome = run(BARS_60, item.value as SignalSource, ZERO);
  const classified = classifySignalSource(item.value);

  ok(
    outcome.ok === false,
    `контейнер ${item.label}: НЕ ok:true с нулём сделок (структурированный отказ)`
  );
  ok(
    outcome.ok === false && outcome.stage === item.stage,
    `контейнер ${item.label}: stage="${item.stage}" (получено ${
      outcome.ok ? "ok:true" : outcome.stage
    })`
  );
  ok(
    outcome.ok === false && outcome.errors.length > 0,
    `контейнер ${item.label}: ошибки непустые`
  );
  ok(
    classified.ok === false && classified.stage === item.stage,
    `контейнер ${item.label}: classifySignalSource согласован с движком`
  );
}

const arrayLikeRun = run(
  BARS_60,
  { 0: validListDecision, length: 1 } as unknown as SignalSource,
  ZERO
);

ok(
  arrayLikeRun.ok === false &&
    arrayLikeRun.errors.some((error) => error.includes("ПОХОЖИЙ на массив")),
  "контейнер array-like: в отказе явно сказано, что объект, похожий на массив, массивом не считается"
);

const mapRun = run(BARS_60, new Map() as unknown as SignalSource, ZERO);

ok(
  mapRun.ok === false &&
    mapRun.errors.some((error) => error.includes("Map/Set")),
  "контейнер Map: в отказе есть подсказка про Map/Set"
);

const typoRun = run(
  BARS_60,
  {
    adapterId: "a",
    version: "1.0.0",
    requiredLookbackBars: 1,
    Decide: (): null => null
  } as unknown as SignalSource,
  ZERO
);

ok(
  typoRun.ok === false &&
    typoRun.stage === "adapter" &&
    typoRun.errors.some((error) => error.includes("Decide")) &&
    typoRun.errors.some((error) => error.includes("decide")),
  "контейнер Decide (опечатка): отказ stage=adapter с указанием на регистр ключа"
);

/* ---------- допустимые формы по-прежнему работают ---------- */

const emptyListRun = run(BARS_60, [], ZERO);
const emptyListResult = resultOf(emptyListRun);

ok(
  emptyListRun.ok === true &&
    emptyListResult !== null &&
    emptyListResult.trades.length === 0 &&
    emptyListResult.metadata.signalSourceKind === "list",
  "валидный контейнер: пустой Array → ok:true, 0 сделок, kind=list"
);

const functionRun = run(BARS_60, (): null => null, ZERO);
const functionResult = resultOf(functionRun);

ok(
  functionRun.ok === true &&
    functionResult !== null &&
    functionResult.metadata.signalSourceKind === "provider",
  "валидный контейнер: функция-провайдер → ok:true, kind=provider"
);

const listRun = run(BARS_60, onlyAt(10, validListDecision), ZERO);

ok(
  listRun.ok === true && resultOf(listRun)?.trades.length === 1,
  "валидный контейнер: Array с решением → сделка есть"
);

const goodAdapter: SignalAdapter = {
  adapterId: "good-adapter",
  version: "2.0.0",
  requiredLookbackBars: 1,
  decide: (): null => null
};
const adapterRun = run(BARS_60, goodAdapter, ZERO);
const adapterResult = resultOf(adapterRun);

ok(
  adapterRun.ok === true &&
    adapterResult !== null &&
    adapterResult.metadata.signalSourceKind === "adapter" &&
    adapterResult.metadata.adapterId === "good-adapter",
  "валидный контейнер: SignalAdapter → ok:true, kind=adapter"
);
ok(
  isSignalAdapter(goodAdapter),
  "валидный контейнер: isSignalAdapter по-прежнему распознаёт адаптер"
);
ok(
  validateSignalAdapter(goodAdapter).length === 0,
  "валидный контейнер: validateSignalAdapter не сообщает ошибок"
);

/* ---------- сегментный прогон и диагностика: то же правило ---------- */

const segmentedBad = runSegmentedBacktest({
  bars: BARS_60,
  signals: {} as SignalSource,
  config: ZERO
});

ok(
  segmentedBad.ok === false && segmentedBad.stage === "signals",
  `сегментный прогон: {} → stage="signals" (получено ${
    segmentedBad.ok ? "ok:true" : segmentedBad.stage
  })`
);

const segmentedTypo = runSegmentedBacktest({
  bars: BARS_60,
  signals: {
    adapterId: "a",
    version: "1.0.0",
    requiredLookbackBars: 1,
    Decide: (): null => null
  } as unknown as SignalSource,
  config: ZERO
});

ok(
  segmentedTypo.ok === false && segmentedTypo.stage === "adapter",
  `сегментный прогон: опечатка Decide → stage="adapter" (получено ${
    segmentedTypo.ok ? "ok:true" : segmentedTypo.stage
  })`
);

const segmentedArrayLike = runSegmentedBacktest({
  bars: BARS_60,
  signals: { 0: validListDecision, length: 1 } as unknown as SignalSource,
  config: ZERO
});

ok(
  segmentedArrayLike.ok === false && segmentedArrayLike.stage === "signals",
  "сегментный прогон: array-like → stage=\"signals\" (не три сегмента с нулём сделок)"
);

const segmentedGood = runSegmentedBacktest({
  bars: BARS_60,
  signals: [],
  config: ZERO
});

ok(
  segmentedGood.ok === true,
  `сегментный прогон: валидный пустой Array → ok (${
    segmentedGood.ok ? "ok" : segmentedGood.errors.join("; ")
  })`
);

const probeBad = probeProvider({
  bars: BARS_60,
  provider: {} as SignalSource,
  config: ZERO
});

ok(
  probeBad.ok === false &&
    probeBad.outcome.ok === false &&
    probeBad.outcome.stage === "signals" &&
    probeBad.errors.some((error) => error.includes("недопустимый контейнер")),
  "диагностика probeProvider: недопустимый контейнер → ok:false и stage=signals"
);

const probeGood = probeProvider({
  bars: BARS_60,
  provider: honestProvider,
  config: ZERO
});

ok(probeGood.ok, `диагностика probeProvider: валидный провайдер по-прежнему зелёный (${probeGood.errors.join("; ")})`);

/* ---------- юнит: снимок адаптера ---------- */

const adapterSnapshotCounts: Record<string, number> = {};
const snapshotSource = {
  get adapterId(): string {
    adapterSnapshotCounts.adapterId = (adapterSnapshotCounts.adapterId ?? 0) + 1;

    return adapterSnapshotCounts.adapterId === 1 ? "snapshot" : "подмена";
  },
  version: "3.0.0",
  requiredLookbackBars: 2,
  decide: (): null => null
};

const adapterSnapshot = captureSignalAdapter(snapshotSource);

ok(adapterSnapshot.ok === true, "снимок адаптера: валидный адаптер принят");
ok(
  adapterSnapshot.ok &&
    adapterSnapshot.adapter.adapterId === "snapshot" &&
    adapterSnapshotCounts.adapterId === 1,
  "снимок адаптера: adapterId прочитан один раз и сохранён первым значением"
);
ok(
  adapterSnapshot.ok && Object.isFrozen(adapterSnapshot.adapter),
  "снимок адаптера: снимок заморожен"
);
ok(
  validateSignalAdapter(snapshotSource as unknown as SignalAdapter).length === 0,
  "снимок адаптера: validateSignalAdapter совместим со снимком"
);
ok(
  captureSignalAdapter({ adapterId: "a" }).ok === false,
  "снимок адаптера: неполный адаптер отклонён"
);

/* ================================================================== */
/* 16. Дешёвый hardening: циклы в deepFreeze и в скане конечности       */
/* ================================================================== */

section("16. deepFreeze/скан конечности: циклы и снятый срез глубины");

const cyclic: Record<string, unknown> = { value: 1 };

cyclic.self = cyclic;

const cyclicFreeze = attempt(() => {
  deepFreeze(cyclic);
});

ok(!cyclicFreeze.threw, `deepFreeze: самоцикл не роняет (${cyclicFreeze.message})`);
ok(Object.isFrozen(cyclic), "deepFreeze: самоцикл заморожен");

const nodeA: Record<string, unknown> = { name: "a" };
const nodeB: Record<string, unknown> = { name: "b", a: nodeA };

nodeA.b = nodeB;

const mutualFreeze = attempt(() => {
  deepFreeze(nodeA);
});

ok(
  !mutualFreeze.threw && Object.isFrozen(nodeA) && Object.isFrozen(nodeB),
  "deepFreeze: взаимный цикл a↔b заморожен без RangeError"
);

const cyclicArray: unknown[] = [1];

cyclicArray.push(cyclicArray);

const cyclicArrayFreeze = attempt(() => {
  deepFreeze(cyclicArray);
});

ok(
  !cyclicArrayFreeze.threw && Object.isFrozen(cyclicArray),
  "deepFreeze: циклический массив заморожен"
);

/* ---------- скан конечности: глубина больше не срезается ---------- */

let deepNode: Record<string, unknown> = { leaf: Number.NaN };

for (let level = 0; level < 14; level += 1) {
  deepNode = { [`level${String(level)}`]: deepNode };
}

const deepFound = findNonFiniteNumbers(deepNode, "deep");

ok(
  deepFound.length === 1 && deepFound[0].startsWith("deep.level13"),
  `скан конечности: NaN на глубине 15 найден (прежний срез depth>8 его пропускал): ${deepFound.join("; ")}`
);
ok(
  deepFound[0].endsWith(".leaf = NaN"),
  "скан конечности: путь до значения сохранён целиком"
);

/* ---------- скан конечности: циклическая структура ---------- */

const cyclicNumbers: Record<string, unknown> = { a: 1 };

cyclicNumbers.self = cyclicNumbers;
cyclicNumbers.bad = Number.POSITIVE_INFINITY;

const cyclicFound = findNonFiniteNumbers(cyclicNumbers, "res");

ok(
  cyclicFound.length === 1 && cyclicFound[0] === "res.bad = Infinity",
  `скан конечности: цикл не зацикливает обход и не маскирует Infinity (${cyclicFound.join("; ")})`
);

/* ---------- скан конечности: limit ограничивает СООБЩЕНИЯ ---------- */

const manyNaN: Record<string, number> = {};

for (let index = 0; index < 25; index += 1) {
  manyNaN[`n${String(index)}`] = Number.NaN;
}

ok(
  findNonFiniteNumbers(manyNaN, "r", 20).length === 20,
  "скан конечности: limit=20 ограничивает число сообщений"
);
ok(
  findNonFiniteNumbers(manyNaN, "r", 100).length === 25,
  "скан конечности: limit=100 находит все 25 значений"
);
ok(
  findNonFiniteNumbers({ a: 1, b: "x", c: null }, "r").length === 0,
  "скан конечности: конечная структура — ноль находок"
);

/* ---------- итог ---------- */

console.log(`\nItog: ${String(passed)}/${String(total)}`);

process.exit(passed === total ? 0 : 1);
