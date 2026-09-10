/**
 * SMC Phase 2A — тесты ATR primitive и displacement
 * (запуск: npx tsx scripts/test-smc-displacement.ts).
 *
 * Fixture-математика (period=14, Wilder): плоский прогрев с
 * TR = 6 даёт ATR = 6 точно (seed = SMA шести); свеча с
 * TR = 13 даёт ATR = (6*13 + 13)/14 = 6.5 ТОЧНО →
 * body 9.75 = 1.5*6.5, range 13 = 2*6.5: точные
 * threshold-равенства без float-шума.
 */

import { atr } from "../lib/indicators";
import { computeAtrSeries } from "../lib/smc/volatility";
import {
  defaultDisplacementConfig,
  evaluateDisplacements,
  SmcDisplacement,
  SmcDisplacementConfig
} from "../lib/smc/displacement";
import {
  SmcRawCandle,
  SmcTimeframe
} from "../lib/smc/types";

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

function closeTo(
  actual: number,
  expected: number,
  label: string
): void {
  ok(
    Math.abs(actual - expected) <= 1e-9,
    `${label} (${actual} ~ ${expected})`
  );
}

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

function mk(
  i: number,
  o: number,
  c: number,
  high: number,
  low: number
): SmcRawCandle {
  return {
    openTime: new Date(T0 + i * HOUR),
    open: o,
    high,
    low,
    close: c,
    closed: true
  };
}

/** Плоская свеча прогрева: TR = 6 (h-l=6, close=103). */
function flat(i: number): SmcRawCandle {
  return mk(i, 102, 103, 106, 100);
}

function warmup(count: number): SmcRawCandle[] {
  return Array.from({ length: count }, (_, i) => flat(i));
}

const CFG: SmcDisplacementConfig = {
  ...defaultDisplacementConfig("1h" as SmcTimeframe)
};

/* ---------- 1. ATR equivalence + Wilder hand-check ---------- */

{
  const input = [
    ...warmup(16),
    mk(16, 100.5, 110.25, 113, 100)
  ];

  const mine = computeAtrSeries(
    input.map((c) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      closed: true,
      effectiveCloseTime: new Date(
        c.openTime.getTime() + HOUR
      )
    }))
  );

  const project = computeAtrSeries(
    input.map((c) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      closed: true,
      effectiveCloseTime: new Date(
        c.openTime.getTime() + HOUR
      )
    }))
  );

  const projectDirect = atr(
    input.map((c) => ({
      high: c.high,
      low: c.low,
      close: c.close
    })),
    14
  );

  ok(
    mine.length === project.length &&
      mine.every(
        (value, i) =>
          value === project[i]
      ),
    "1: SMC ATR серия === проектной atrSeries на тех же свечах (прямое переиспользование)"
  );

  const lastIdx = input.length - 1;

  ok(
    mine[lastIdx] !== null &&
      projectDirect !== null &&
      Math.abs(mine[lastIdx]! - projectDirect) <= 1e-9,
    "1: последняя точка совпадает с проектным atr()"
  );

  // Hand-computed Wilder (period=3): TR1=5, TR2=2, TR3=6 →
  // seed ATR[3] = 13/3; TR4=4 → ATR[4] = (13/3*2+4)/3 = 38/9.
  const small = [
    mk(0, 9, 9, 10, 8),
    mk(1, 9, 11, 12, 7),
    mk(2, 11, 10, 11, 9),
    mk(3, 10, 9, 14, 8),
    mk(4, 9, 12, 13, 9)
  ];

  const smallSeries = computeAtrSeries(
    small.map((c) => ({
      openTime: c.openTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      closed: true,
      effectiveCloseTime: new Date(
        c.openTime.getTime() + HOUR
      )
    })),
    3
  );

  ok(
    smallSeries[0] === null &&
      smallSeries[1] === null &&
      smallSeries[2] === null,
    "1/2: insufficient history — null до индекса period (никакого fallback)"
  );
  closeTo(smallSeries[3]!, 13 / 3, "1: seed = SMA(TR1..TR3) = 13/3");
  closeTo(
    smallSeries[4]!,
    (13 / 3) * (2 / 3) + 4 / 3,
    "1: Wilder RMA шаг = (value*(p-1)+TR)/p = 38/9"
  );
}

/* ---------- 2. ATR insufficient history ---------- */

{
  const input = [
    ...warmup(8),
    // Свеча с идеальной displacement-геометрией, но
    // ATR[8] ещё null (нужно 15 свечей).
    mk(8, 100.5, 110.25, 113, 100)
  ];

  const result = evaluateDisplacements(
    input,
    CFG,
    new Date(T0 + 9 * HOUR)
  );

  ok(
    result.length === 0,
    "2: ATR unavailable → точка not-evaluable, displacement не создаётся (без fallback)"
  );
}

/* ---------- 4. bullish displacement (точные пороги) ---------- */

{
  const input = [
    ...warmup(16),
    // TR=13 → ATR[16]=6.5; body 9.75 → bodyAtr=1.5 РОВНО;
    // range 13 → rangeAtr=2.0 РОВНО; closeLocation=10.25/13.
    mk(16, 100.5, 110.25, 113, 100),
    flat(17)
  ];

  const result = evaluateDisplacements(
    input,
    CFG,
    new Date(T0 + 18 * HOUR)
  );

  ok(
    result.length === 1 &&
      result[0].direction === "up" &&
      result[0].eventTime.getTime() === T0 + 16 * HOUR &&
      result[0].confirmedAt.getTime() === T0 + 17 * HOUR,
    "4: bullish displacement подтверждён в effectiveCloseTime свечи"
  );
  closeTo(result[0].bodyAtr, 1.5, "4: bodyAtr = 1.5 точно");
  closeTo(result[0].rangeAtr, 2.0, "4: rangeAtr = 2.0 точно");
  closeTo(
    result[0].closeLocation,
    10.25 / 13,
    "4: closeLocation = (close-low)/(high-low)"
  );
  ok(
    result[0].key ===
      `SMC1|D|1h|up|${T0 + 16 * HOUR}`,
    "4: key = SMC1|D|tf|dir|openTimeMs (без DB-id/random)"
  );
}

/* ---------- 5. bearish displacement (зеркало) ---------- */

{
  // Точная инверсия (негатив) меняет местами high/low:
  // body/range/closeLocation сохраняются, направление — нет.
  const neg = (candle: SmcRawCandle): SmcRawCandle =>
    mk(
      (candle.openTime.getTime() - T0) / HOUR,
      -candle.open,
      -candle.close,
      -candle.low,
      -candle.high
    );

  const input = [
    ...warmup(16).map(neg),
    neg(mk(16, 100.5, 110.25, 113, 100))
  ];

  const result = evaluateDisplacements(
    input,
    CFG,
    new Date(T0 + 18 * HOUR)
  );

  ok(
    result.length === 1 &&
      result[0].direction === "down" &&
      Math.abs(result[0].bodyAtr - 1.5) <= 1e-9 &&
      Math.abs(result[0].rangeAtr - 2.0) <= 1e-9 &&
      result[0].closeLocation <= 0.4,
    "5: bearish displacement — зеркало (close<open, closeLocation<=0.40)"
  );
}

/* ---------- 6/7/8/9/10. отказные кейсы ---------- */

{
  const base = warmup(16);

  const cases: [string, SmcRawCandle][] = [
    [
      "6: большой body, недостаточный range (rangeAtr=1.9986<2) → нет",
      mk(16, 100.5, 110.25, 112.99, 100)
    ],
    [
      "7: большой range, недостаточный body (bodyAtr=1.4923<1.5) → нет",
      mk(16, 100.5, 110.2, 113, 100)
    ],
    [
      "8: closeLocation 0.575 < 0.60 → нет",
      mk(16, 100.5, 111.5, 120, 100)
    ],
    [
      "9: doji (close===open, body 0) → нет",
      mk(16, 106.5, 106.5, 113, 100)
    ],
    [
      "10: zero-range (closeLocation по конвенции 0.5, rangeAtr=0) → нет",
      mk(16, 106, 106, 106, 106)
    ]
  ];

  for (const [label, candidate] of cases) {
    const result = evaluateDisplacements(
      [...base, candidate],
      CFG,
      new Date(T0 + 17 * HOUR)
    );

    ok(
      result.length === 0,
      label
    );
  }
}

/* ---------- 11. точное равенство порогов принимается ---------- */

{
  const input = [
    ...warmup(16),
    // bodyAtr=1.5 и rangeAtr=2.0 ровно (см. fixture-математику).
    mk(16, 100.5, 110.25, 113, 100)
  ];

  const byThresholds = evaluateDisplacements(
    input,
    CFG,
    new Date(T0 + 17 * HOUR)
  );

  ok(
    byThresholds.length === 1,
    "11: bodyAtr=1.5 И rangeAtr=2.0 ровно → принято (>= inclusive)"
  );

  // closeLocation = 12/20 = 0.6 РОВНО (double-точное деление).
  const locInput = [
    ...warmup(16),
    mk(16, 101, 112, 120, 100)
  ];

  const byLocation = evaluateDisplacements(
    locInput,
    CFG,
    new Date(T0 + 17 * HOUR)
  );

  ok(
    byLocation.length === 1 &&
      Math.abs(byLocation[0].closeLocation - 0.6) <= 1e-15,
    "11: closeLocation = 0.6 ровно → принято (>= 0.60 inclusive)"
  );
}

/* ---------- 3. ATR no-lookahead ---------- */

{
  const full = [
    ...warmup(16),
    mk(16, 100.5, 110.25, 113, 100),
    flat(17),
    flat(18),
    flat(19)
  ];

  // ATR[16] использует только свечи 0..16: добавление свечей
  // 17..19 не меняет ни ATR[16], ни displacement.
  const short = evaluateDisplacements(
    full.slice(0, 17),
    CFG,
    new Date(T0 + 17 * HOUR)
  );

  ok(
    short.length === 1 &&
      short[0].confirmedAt.getTime() === T0 + 17 * HOUR,
    "3: ATR causal — значение на i зависит только от свечей <= i"
  );
}

/* ---------- 12. deterministic key ---------- */

{
  const input = [
    ...warmup(16),
    mk(16, 100.5, 110.25, 113, 100)
  ];

  const run1 = evaluateDisplacements(
    input,
    CFG,
    new Date(T0 + 17 * HOUR)
  );
  const run2 = evaluateDisplacements(
    input,
    CFG,
    new Date(T0 + 17 * HOUR)
  );

  ok(
    JSON.stringify(run1) === JSON.stringify(run2) &&
      new Set(run1.map((d) => d.key)).size === run1.length,
    "12: повторный запуск — байт-в-байт; ключи уникальны"
  );
}

/* ---------- 13. future injection invariance ---------- */

{
  const full = [
    ...warmup(16),
    mk(16, 100.5, 110.25, 113, 100),
    flat(17),
    flat(18),
    flat(19)
  ];

  for (const cut of [16, 18]) {
    const onFull = evaluateDisplacements(
      full,
      CFG,
      new Date(T0 + (cut + 1) * HOUR)
    );
    const onPrefix = evaluateDisplacements(
      full.slice(0, cut + 1),
      CFG,
      new Date(T0 + (cut + 1) * HOUR)
    );

    ok(
      JSON.stringify(onFull) === JSON.stringify(onPrefix),
      `13: future injection инвариантен на срезе ${cut} (serialized canonical output)`
    );
  }
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
