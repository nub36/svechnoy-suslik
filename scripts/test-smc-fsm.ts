/**
 * SMC Phase 1 — тесты structure FSM
 * (запуск: npx tsx scripts/test-smc-fsm.ts).
 *
 * Фикстуры используют layer "swing" с МАЛЫМИ окнами
 * (left=right=1) для верифицируемости: окна — конфиг
 * алгоритма, layer влияет на identity/веса, не на код
 * (одна реализация FSM, см. test-smc-pivots №8).
 *
 * Хронометрика фикстуры A (индексы свечей, o/c):
 *   0:(100,104) 1:(104,108) 2:(108,112) 3:(112,106)
 *   4:(106,101) 5:(101,105) 6:(105,110) 7:(110,115)
 *   8:(115,118) 9:(118,121) 10:(121,116) 11:(116,113)
 *   12:(113,119) 13:(119,122) 14:(122,112)
 * Пивоты (L=R=1): high 112 (anchor 2, conf effClose(4)),
 * low 101 (anchor 4, conf effClose(6)),
 * high 121 (anchor 9, conf effClose(11)),
 * low 113 (anchor 11, conf effClose(13)).
 * Ожидаемые события: BOS_up(112)@7, BOS_up(121)@13,
 * CHOCH_down(113)@14 → REVERSAL_PENDING_DOWN.
 */

import {
  evaluateStructure,
  SmcAmbiguousBreakError
} from "../lib/smc/fsm";
import {
  SmcRawCandle,
  SmcStructureResult,
  StructureParams
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

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

const SWING_LR1: StructureParams = {
  tf: "1h",
  layer: "swing",
  left: 1,
  right: 1
};

function mk(
  i: number,
  o: number,
  c: number,
  high?: number,
  low?: number
): SmcRawCandle {
  return {
    openTime: new Date(T0 + i * HOUR),
    open: o,
    high: high ?? Math.max(o, c),
    low: low ?? Math.min(o, c),
    close: c,
    closed: true
  };
}

const FIXTURE_A: [number, number][] = [
  [100, 104],
  [104, 108],
  [108, 112],
  [112, 106],
  [106, 101],
  [101, 105],
  [105, 110],
  [110, 115],
  [115, 118],
  [118, 121],
  [121, 116],
  [116, 113],
  [113, 119],
  [119, 122],
  [122, 112]
];

function mirror(
  values: [number, number][]
): [number, number][] {
  return values.map(([o, c]) => [200 - o, 200 - c]);
}

function eventSummary(result: SmcStructureResult): string[] {
  return result.events.map(
    (event) => `${event.type}:${event.dir}`
  );
}

/* ---------- базовая динамика фикстуры A ---------- */

{
  const result = evaluateStructure(
    FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    SWING_LR1,
    new Date(T0 + 16 * HOUR)
  );

  ok(
    eventSummary(result).join(",") ===
      "BOS:up,BOS:up,CHOCH:down",
    "fixture A: BOS_up → BOS_up (continuation) → CHOCH_down"
  );
  ok(
    result.phase === "REVERSAL_PENDING_DOWN",
    "fixture A: один counter-trend break НЕ меняет тренд сразу (PENDING)"
  );
  ok(
    result.pivots.length === 4,
    "fixture A: 4 подтверждённых пивота (2 high, 2 low)"
  );

  const bosLevels = result.levels.filter(
    (level) =>
      level.kind === "high" &&
      level.state === "CONSUMED"
  );

  ok(
    bosLevels.length === 2 &&
      bosLevels.every(
        (level) =>
          level.consumedByEventKey !== null &&
          level.consumedAt !== null
      ),
    "fixture A: пробитые уровни CONSUMED с ссылкой на событие"
  );
}

/* ---------- 10. duplicate BOS prevention ---------- */

{
  const result = evaluateStructure(
    FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    SWING_LR1,
    new Date(T0 + 13 * HOUR)
  );

  // closes 8..12 (118,121,116,113,119) — пять закрытий выше
  // 112, но уровень уже CONSUMED и новых targets нет
  // (horizon до effClose(12): BOS(121) на свече 13 ещё
  // вне окна).
  const bosUps = result.events.filter(
    (event) => event.type === "BOS" && event.dir === "up"
  );

  ok(
    bosUps.length === 1 &&
      bosUps[0].brokenLevelPrice === 112,
    "10: пять closes выше уровня дают ровно один BOS (duplicate prevention)"
  );
}

/* ---------- 11. continuation BOS только по новому target ---------- */

{
  const result = evaluateStructure(
    FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    SWING_LR1,
    new Date(T0 + 16 * HOUR)
  );

  const bosUps = result.events.filter(
    (event) => event.type === "BOS" && event.dir === "up"
  );

  const high121 = result.pivots.find(
    (pivot) => pivot.price === 121
  );

  ok(
    bosUps.length === 2 &&
      bosUps[1].eventTime.getTime() === T0 + 13 * HOUR,
    "11: второй BOS только после подтверждения нового swing-high"
  );
  ok(
    high121 !== undefined &&
      bosUps[1].brokenPivotKey === high121.key,
    "11: continuation BOS ссылается на НОВЫЙ уровень (121), не на consumed"
  );
}

/* ---------- 12. bearish failed CHoCH (reclaim) ---------- */

{
  const candles = [
    ...FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    mk(15, 112, 120)
  ];

  const result = evaluateStructure(
    candles,
    SWING_LR1,
    new Date(T0 + 17 * HOUR)
  );

  ok(
    eventSummary(result).join(",") ===
      "BOS:up,BOS:up,CHOCH:down,CHOCH_INVALIDATED:up",
    "12: failed CHoCH — reclaim выше уровня CHOCH"
  );
  ok(
    result.phase === "TREND_UP",
    "12: reclaim возвращает TREND_UP"
  );
}

/* ---------- 14. bearish confirmed reversal ---------- */

{
  const candles = [
    ...FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    mk(15, 112, 96),
    mk(16, 96, 94),
    mk(17, 94, 97),
    mk(18, 97, 101),
    mk(19, 101, 92)
  ];

  const result = evaluateStructure(
    candles,
    SWING_LR1,
    new Date(T0 + 20 * HOUR)
  );

  ok(
    eventSummary(result).join(",") ===
      "BOS:up,BOS:up,CHOCH:down,BOS:down",
    "14: confirmed reversal — CHOCH, затем новый downside break"
  );
  ok(
    result.phase === "TREND_DOWN",
    "14: после нового LL-break тренд подтверждён вниз"
  );

  const choch = result.events[2];
  const reversalBos = result.events[3];

  ok(
    reversalBos.brokenPivotKey !== choch.brokenPivotKey,
    "14/16: reversal подтверждён НОВЫМ уровнем, не CHOCH-уровнем"
  );
}

/* ---------- 13/15. зеркальные bullish-сценарии ---------- */

{
  const failed = evaluateStructure(
    mirror(FIXTURE_A)
      .map(([o, c], i) => mk(i, o, c))
      .concat([mk(15, 200 - 112, 200 - 120)]),
    SWING_LR1,
    new Date(T0 + 17 * HOUR)
  );

  ok(
    eventSummary(failed).join(",") ===
      "BOS:down,BOS:down,CHOCH:up,CHOCH_INVALIDATED:down",
    "13: bullish failed CHoCH (зеркало) — reclaim вниз"
  );
  ok(
    failed.phase === "TREND_DOWN",
    "13: зеркало возвращает TREND_DOWN"
  );

  const confirmed = evaluateStructure(
    mirror(FIXTURE_A)
      .map(([o, c], i) => mk(i, o, c))
      .concat([
        mk(15, 200 - 112, 200 - 96),
        mk(16, 200 - 96, 200 - 94),
        mk(17, 200 - 94, 200 - 97),
        mk(18, 200 - 97, 200 - 101),
        mk(19, 200 - 101, 200 - 92)
      ]),
    SWING_LR1,
    new Date(T0 + 20 * HOUR)
  );

  ok(
    eventSummary(confirmed).join(",") ===
      "BOS:down,BOS:down,CHOCH:up,BOS:up",
    "15: bullish confirmed reversal (зеркало)"
  );
  ok(
    confirmed.phase === "TREND_UP",
    "15: зеркало подтверждает TREND_UP"
  );
}

/* ---------- 16. CHOCH-уровень не подтверждает дважды ---------- */

{
  // После reclaim (fixture B + один close ниже 113): уровень
  // 113 CONSUMED, protectedLow стал более глубокий (101) →
  // close 110 НЕ создаёт второго CHOCH по 113.
  const candles = [
    ...FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    mk(15, 112, 120),
    mk(16, 120, 110)
  ];

  const result = evaluateStructure(
    candles,
    SWING_LR1,
    new Date(T0 + 18 * HOUR)
  );

  const chochCount = result.events.filter(
    (event) => event.type === "CHOCH"
  ).length;

  const choch113 = result.events.filter(
    (event) =>
      event.type === "CHOCH" &&
      event.brokenLevelPrice === 113
  ).length;

  ok(
    chochCount === 1 && choch113 === 1,
    "16: CONSUMED CHOCH-уровень не стреляет повторно"
  );

  const consumed113 = result.levels.find(
    (level) => level.price === 113 && level.kind === "low"
  );

  ok(
    consumed113 !== undefined &&
      consumed113.state === "CONSUMED" &&
      result.levels.filter(
        (level) =>
          level.price === 113 &&
          level.state === "CONSUMED"
      ).length === 1,
    "16: уровень 113 потреблён ровно один раз"
  );
}

/* ---------- 17. wick-only penetration ---------- */

{
  // i12: wick 124 выше уровня 121, close 120 — ниже → BOS
  // запрещён; следующий close-break 123 → BOS появляется.
  const candles = [
    ...FIXTURE_A.slice(0, 12).map(([o, c], i) =>
      mk(i, o, c)
    ),
    mk(12, 119, 120, 124, 118),
    mk(13, 120, 123),
    mk(14, 123, 126)
  ];

  const afterWick = evaluateStructure(
    candles,
    SWING_LR1,
    new Date(T0 + 13 * HOUR)
  );

  ok(
    afterWick.events.length === 1 &&
      afterWick.events[0].type === "BOS" &&
      afterWick.events[0].brokenLevelPrice === 112,
    "17: wick-only проникновение не создаёт BOS/CHOCH"
  );

  const afterClose = evaluateStructure(
    candles,
    SWING_LR1,
    new Date(T0 + 15 * HOUR)
  );

  // wick-свеча сама образовала новый pivot high 124; свеча
  // 13 (close 123) его НЕ ломает, свеча 14 (close 126) —
  // ломает: BOS по активному уровню.
  ok(
    afterClose.events.length === 2 &&
      afterClose.events[1].brokenLevelPrice === 124,
    "17: контроль — close-break активного уровня создаёт BOS"
  );
}

/* ---------- ambiguous wide candle: close решает ---------- */

{
  // i14: wick 125 выше последних high, low 108 ниже protected
  // low 113, close 112 — ровно одно close-событие (CHOCH по
  // 113; wick-only проникновение вверх BOS не создаёт).
  // Свеча 14 стоит СРАЗУ после подтверждения пивота 113
  // (conf effClose(13)): её low не входит в правый контекст
  // пивота и не рушит его.
  const candles = [
    ...FIXTURE_A.slice(0, 14).map(([o, c], i) =>
      mk(i, o, c)
    ),
    mk(14, 122, 112, 125, 108)
  ];

  const result = evaluateStructure(
    candles,
    SWING_LR1,
    new Date(T0 + 15 * HOUR)
  );

  ok(
    eventSummary(result).join(",") ===
      "BOS:up,BOS:up,CHOCH:down",
    "ambiguity: широкая свеча разрешается close-правилом однозначно"
  );

  const guardClass = new SmcAmbiguousBreakError("probe");

  ok(
    guardClass.name === "SmcAmbiguousBreakError",
    "ambiguity: defensive guard существует (invalid state → typed error)"
  );
}

/* ---------- bootstrap UNDEFINED ---------- */

{
  // Только high-пивот подтверждён; close 112 выше 110 НЕ
  // объявляет тренд: нет подтверждённого swing-low контекста.
  const noLow = [
    mk(0, 98, 100),
    mk(1, 100, 106),
    mk(2, 106, 110),
    mk(3, 109, 104),
    mk(4, 104, 102),
    mk(5, 102, 112)
  ];

  const result = evaluateStructure(
    noLow,
    SWING_LR1,
    new Date(T0 + 7 * HOUR)
  );

  ok(
    result.phase === "UNDEFINED" &&
      result.events.length === 0,
    "bootstrap: без подтверждённого swing-low тренд не объявляется"
  );

  // Минимальная последовательность: high-пивот + low-пивот +
  // первый строгий close за уровнем → initial BOS.
  const bootstrapped = [
    mk(0, 98, 100),
    mk(1, 100, 106),
    mk(2, 106, 110),
    mk(3, 109, 104),
    mk(4, 104, 102),
    mk(5, 102, 98),
    mk(6, 98, 99),
    mk(7, 99, 104),
    mk(8, 104, 111)
  ];

  const result2 = evaluateStructure(
    bootstrapped,
    SWING_LR1,
    new Date(T0 + 9 * HOUR)
  );

  ok(
    result2.phase === "TREND_UP" &&
      result2.events.length === 1 &&
      result2.events[0].type === "BOS" &&
      result2.events[0].brokenLevelPrice === 110,
    "bootstrap: high pivot + low pivot + первый close-break → TREND_UP"
  );
}

/* ---------- 18. deterministic IDs ---------- */

{
  const input = FIXTURE_A.map(([o, c], i) =>
    mk(i, o, c)
  );

  const run1 = evaluateStructure(
    input,
    SWING_LR1,
    new Date(T0 + 16 * HOUR)
  );
  const run2 = evaluateStructure(
    input,
    SWING_LR1,
    new Date(T0 + 16 * HOUR)
  );

  ok(
    JSON.stringify(run1) === JSON.stringify(run2),
    "18: повторное evaluation даёт байт-в-байт идентичный результат"
  );
  ok(
    run1.events.every(
      (event) =>
        event.key.startsWith(
          `SMC1|E|1h|swing|${event.type}|${event.dir}|`
        ) && event.key.includes(String(event.eventTime.getTime()))
    ),
    "18: event key — детерминированный semantic key (tf/layer/type/dir/уровень/время)"
  );
  ok(
    new Set(run1.events.map((event) => event.key)).size ===
      run1.events.length &&
      new Set(run1.pivots.map((p) => p.key)).size ===
        run1.pivots.length,
    "18: все ключи уникальны без UUID/DB-id/random"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
