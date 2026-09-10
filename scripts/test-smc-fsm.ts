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

/* ---------- FIX 1: reversal temporal eligibility ---------- */

/* Fixture eligibility (layer swing, left=1, right=2).
 * B-пивот = high 108, anchor i6, right-window подтверждает
 * его ТОЛЬКО на effClose(i8) = T0+9h — ПОСЛЕ CHOCH
 * (conf effClose(i7) = T0+8h), хотя anchor ДО CHOCH-свечи.
 * По старому eventTime-правилу такой pivot был бы отклонён и
 * reversal не подтвердился бы; по confirmedAt — подтверждается.
 * Хронометрика:
 *   i0:(100,103) i1:(103,105) i2:(105,100,h104,l97)
 *   i3:(100,102) i4:(102,103) i5:(103,95) i6:(104,104,h108,l102)
 *   i7:(104,106) i8:(106,105) i9:(105,110)
 * Пивоты: high 105 (anchor1, conf T0+4h), low 97 (anchor2,
 * conf T0+5h), low 95 (anchor5, conf T0+8h), high 108
 * (anchor6, conf T0+9h).
 * События: BOS_down(97)@i5, CHOCH_up(105)@i7, BOS_up(108)@i9. */
{
  const ELIG: StructureParams = {
    tf: "1h",
    layer: "swing",
    left: 1,
    right: 2
  };

  const input: SmcRawCandle[] = [
    mk(0, 100, 103),
    mk(1, 103, 105),
    mk(2, 103, 100, 104, 97),
    mk(3, 100, 102),
    mk(4, 102, 103),
    mk(5, 103, 95),
    mk(6, 104, 104, 108, 102),
    mk(7, 104, 106),
    mk(8, 106, 105),
    mk(9, 105, 110)
  ];

  const result = evaluateStructure(
    input,
    ELIG,
    new Date(T0 + 10 * HOUR)
  );

  ok(
    eventSummary(result).join(",") ===
      "BOS:down,CHOCH:up,BOS:up",
    "FIX1 B/D: pre-CHOCH anchor + post-CHOCH confirmedAt подтверждает reversal"
  );

  const choch = result.events[1];
  const reversal = result.events[2];
  const pivot108 = result.pivots.find(
    (pivot) => pivot.price === 108
  );

  ok(
    pivot108 !== undefined &&
      reversal.brokenPivotKey === pivot108.key,
    "FIX1 D: eligible target — pivot с confirmedAt СТРОГО после CHOCH"
  );
  ok(
    pivot108 !== undefined &&
      pivot108.eventTime.getTime() === T0 + 6 * HOUR &&
      choch.eventTime.getTime() === T0 + 7 * HOUR,
    "FIX1 B: eventTime пивота ДО CHOCH-якоря — eligibility определяется confirmedAt, не eventTime"
  );
  ok(
    pivot108 !== undefined &&
      pivot108.confirmedAt.getTime() === T0 + 9 * HOUR &&
      choch.confirmedAt.getTime() === T0 + 8 * HOUR &&
      pivot108.confirmedAt.getTime() >
        choch.confirmedAt.getTime(),
    "FIX1 D: pivot.confirmedAt > chochConfirmedAt (строго)"
  );

  /* FIX 1 A/C — геометрические инварианты (зафиксированы
   * комментариями и проверкой, fixture не придумываем):
   * A) eventTime ПОСЛЕ CHOCH-якоря при confirmedAt <= CHOCH
   *    невозможен: anchor > t ⟹ confirmedAt =
   *    effClose(anchor+right) >= effClose(t+1+right) >
   *    effClose(t) = chochConfirmedAt (right >= 1).
   * C) target с confirmedAt == chochConfirmedAt невозможен:
   *    same-kind пивоты на одной boundary не существуют
   *    (FIX 3), а cross-kind не является reversal-target'ом;
   *    пивот того же рода, подтверждённый на boundary CHOCH,
   *    регистрируется ДО перехода той же свечи и становится
   *    protected-уровнем сам (latest confirmed), вытесняя
   *    старый уровень — CHOCH по старому уровню на этой же
   *    boundary не возникает. Проверяем A рантайм-инвариантом;
   *    strict `>` в коде при этом обязателен. */
  let invariantA = true;

  for (const event of result.events) {
    if (event.type !== "CHOCH") {
      continue;
    }

    for (const pivot of result.pivots) {
      if (
        pivot.eventTime.getTime() >
          event.eventTime.getTime() &&
        pivot.confirmedAt.getTime() <=
          event.confirmedAt.getTime()
      ) {
        invariantA = false;
      }
    }
  }

  ok(
    invariantA,
    "FIX1 A: инвариант — eventTime после CHOCH-якоря ⟹ confirmedAt > CHOCH confirmedAt (геометрия right-window)"
  );
}

/* ---------- FIX 2/3: same-confirmedAt + invalidation identity ---------- */

/* Пивоты high 20 (run i2..i3) и low 12 (run i2..i3)
 * подтверждены ОДНОЙ boundary effClose(4) = T0+5h:
 * cross-kind same-confirmedAt физически возможен и здесь
 * проверяется. Same-kind same-confirmedAt НЕВОЗМОЖЕН:
 * plateau одного kind — непересекающиеся run'ы ⟹ разные
 * end ⟹ разные end+right ⟹ разные effectiveCloseTime
 * (инвариант проверяется ниже); fixture не придумываем.
 * События: BOS_up(20)@i6, CHOCH_down(12)@i8,
 * CHOCH_INVALIDATED_up@i9 (reclaim).
 *   i0:(9,9,h10,l8) i1:(14,15,h15,l14) i2:(16,19,h20,l12)
 *   i3:(19,16,h20,l12) i4:(15,14,h15,l13) i5:(17,20,h25,l16)
 *   i6:(21,22,h26,l17) i7:(22,19,h23,l17) i8:(19,11,h19,l10)
 *   i9:(11,18,h19,l10) i10:(18,21,h24,l17) i11:(21,10,h21,l9) */
{
  const input: SmcRawCandle[] = [
    mk(0, 9, 9, 10, 8),
    mk(1, 14, 15, 15, 14),
    mk(2, 16, 19, 20, 12),
    mk(3, 19, 16, 20, 12),
    mk(4, 15, 14, 15, 13),
    mk(5, 17, 20, 25, 16),
    mk(6, 21, 22, 26, 17),
    mk(7, 22, 19, 23, 17),
    mk(8, 19, 11, 19, 10),
    mk(9, 11, 18, 19, 10),
    mk(10, 18, 21, 24, 17),
    mk(11, 21, 10, 21, 9)
  ];

  const asOfFull = new Date(T0 + 12 * HOUR);
  const run1 = evaluateStructure(input, SWING_LR1, asOfFull);
  const run2 = evaluateStructure(input, SWING_LR1, asOfFull);

  const pivotHigh20 = run1.pivots.find(
    (pivot) => pivot.kind === "high" && pivot.price === 20
  );
  const pivotLow12 = run1.pivots.find(
    (pivot) => pivot.kind === "low" && pivot.price === 12
  );

  ok(
    pivotHigh20 !== undefined &&
      pivotLow12 !== undefined &&
      pivotHigh20.confirmedAt.getTime() ===
        pivotLow12.confirmedAt.getTime() &&
      pivotHigh20.confirmedAt.getTime() === T0 + 5 * HOUR,
    "FIX3: cross-kind пивоты (high 20 / low 12) подтверждены одной boundary"
  );

  ok(
    JSON.stringify(run1) === JSON.stringify(run2),
    "FIX3: AVAILABLE selection детерминирован (повторный запуск байт-в-байт)"
  );

  ok(
    eventSummary(run1).join(",") ===
      "BOS:up,CHOCH:down,CHOCH_INVALIDATED:up",
    "FIX3: BOS_up(20) → CHOCH_down(12) → reclaim; consumed уровни не пере-выбираются (нет дубликатов BOS/CHOCH)"
  );

  /* Consumed не выбирается снова: close(i11)=10 НИЖЕ
   * consumed CHOCH-уровня 12 — если бы CONSUMED был
   * выбираемым, здесь возник бы второй CHOCH_down(12). */
  ok(
    run1.events.filter(
      (event) =>
        event.type === "CHOCH" &&
        event.brokenLevelPrice === 12
    ).length === 1 &&
      run1.events.filter(
        (event) =>
          event.type === "BOS" &&
          event.brokenLevelPrice === 20
      ).length === 1,
    "FIX3: close 10 < consumed 12 без нового CHOCH; close 21 > consumed 20 без нового BOS"
  );

  const consumed = run1.levels.filter(
    (level) => level.state === "CONSUMED"
  );

  ok(
    consumed.length === 2 &&
      consumed.every(
        (level) =>
          level.consumedByEventKey !== null &&
          level.consumedAt !== null
      ) &&
      new Set(consumed.map((level) => level.pivotKey)).size ===
        2,
    "FIX3: consumed уровни ровно 2 (high 20, low 12), каждый потреблён один раз"
  );

  /* FIX 2: CHOCH_INVALIDATED ссылается на ОРИГИНАЛЬНЫЙ
   * pivot low 12: тот же brokenPivotKey/brokenLevelPrice,
   * другие eventTime/confirmedAt (от reclaim-свечи i9),
   * deterministic key = original pivot key + reclaim openTime. */
  const chochDown = run1.events.find(
    (event) => event.type === "CHOCH"
  );
  const invalidated = run1.events.find(
    (event) => event.type === "CHOCH_INVALIDATED"
  );

  ok(
    chochDown !== undefined &&
      invalidated !== undefined &&
      invalidated.brokenPivotKey === chochDown.brokenPivotKey &&
      invalidated.brokenPivotKey === pivotLow12!.key &&
      invalidated.brokenLevelPrice ===
        chochDown.brokenLevelPrice &&
      invalidated.eventTime.getTime() !==
        chochDown.eventTime.getTime() &&
      invalidated.confirmedAt.getTime() !==
        chochDown.confirmedAt.getTime(),
    "FIX2: CHOCH и CHOCH_INVALIDATED — один brokenPivotKey/price (оригинальный pivot), разные eventTime/confirmedAt"
  );

  ok(
    invalidated !== undefined &&
      invalidated.key ===
        `SMC1|E|1h|swing|CHOCH_INVALIDATED|up|${pivotLow12!.key}|${T0 + 9 * HOUR}` &&
      invalidated.eventTime.getTime() === T0 + 9 * HOUR &&
      invalidated.confirmedAt.getTime() === T0 + 10 * HOUR,
    "FIX2: deterministic key на original pivot key + reclaim openTime, времена — от reclaim-свечи (без ghost pivot)"
  );

  /* Same-kind инвариант: confirmedAt строго возрастают внутри
   * kind (следствие непересекающихся run'ов) — на двух
   * fixture сразу. */
  let sameKindStrict = true;

  for (const run of [run1, ...[FIXTURE_A].map((fixture) => evaluateStructure(
    fixture.map(([o, c], i) => mk(i, o, c)),
    SWING_LR1,
    new Date(T0 + 16 * HOUR)
  ))]) {
    for (const kind of ["high", "low"] as const) {
      const confs = run.pivots
        .filter((pivot) => pivot.kind === kind)
        .map((pivot) => pivot.confirmedAt.getTime());

      for (let i = 1; i < confs.length; i++) {
        if (confs[i] <= confs[i - 1]) {
          sameKindStrict = false;
        }
      }
    }
  }

  ok(
    sameKindStrict,
    "FIX3: same-kind confirmedAt строго возрастают — exact same-confirmedAt физически невозможен (зафиксировано инвариантом)"
  );
}

/* ---------- METADATA EXTENSION: protectedAnchor (M1–M13) ---------- */

/** Фикстура-якоря (bootstrap → continuation → CHOCH → reversal):
 *   flat 0–2, L0 low 80@3 (conf close4), flat 4, H0 high 95@5
 *   (conf close6), flat 6, bootstrap BOS up @7 (close 97 > 95),
 *   L2 low 90@8 (conf close9), high 100@10 (conf close11),
 *   continuation BOS up @12 (101 > 100), high 103@13 (conf
 *   close14), low 93@14 (conf close15), high 105@15 (conf
 *   close16), CHOCH down @16 (85 < 93), low 79@17 (conf
 *   close18), reversal BOS down @19 (77.5 < 79), flat 20.
 * У каждой BOS-границы НЕСКОЛЬКО AVAILABLE-кандидатов
 * противоположного рода — anchor обязан соответствовать правилу
 * pickTarget (последний подтверждённый), а не lowest/oldest. */
function anchorFixture(): SmcRawCandle[] {
  const flatM = (i: number): SmcRawCandle => {
    const b = i * 0.01;

    return mk(i, 86 + b, 87 + b, 90 + b, 84 + b);
  };

  return [
    flatM(0),
    flatM(1),
    flatM(2),
    mk(3, 87, 85.5, 87.5, 80),       // low 80@3
    flatM(4),
    mk(5, 87, 88, 95, 86.5),         // high 95@5
    flatM(6),                        // low 84.06@6
    mk(7, 95.5, 97, 97.5, 94),       // bootstrap BOS up (97 > 95)
    mk(8, 96, 92, 96.5, 90),         // low 90@8
    mk(9, 92.09, 93.09, 95.09, 91.09),
    mk(10, 93, 94, 100, 92),         // high 100@10
    mk(11, 93.11, 94.11, 96.11, 92.11),
    mk(12, 94, 101, 101.5, 93.5),    // continuation BOS up (101 > 100)
    mk(13, 100.5, 99, 103, 98.5),    // high 103@13
    mk(14, 99, 96, 100.14, 93),      // low 93@14
    mk(15, 96.15, 97, 105, 95.15),   // high 105@15
    mk(16, 96, 85, 96.5, 84),        // CHOCH down (85 < 93)
    mk(17, 85, 80.5, 85.5, 79),      // low 79@17
    mk(18, 80.2, 81.18, 82.18, 80.1),
    mk(19, 81, 77.5, 81.5, 76.5),    // reversal BOS down (77.5 < 79)
    flatM(20)
  ];
}

/** Зеркало с явными H/L (точная инверсия: high ↔ −low). */
function negCandle(candle: SmcRawCandle): SmcRawCandle {
  return mk(
    (candle.openTime.getTime() - T0) / HOUR,
    -candle.open,
    -candle.close,
    -candle.low,
    -candle.high
  );
}

const anchorKey = (
  kind: "high" | "low",
  hour: number
): string =>
  `SMC1|P|1h|swing|${kind}|${T0 + hour * HOUR}`;

/* M1/M5/M7 + база: FIXTURE_ANCHOR, все четыре сценария. */
{
  const result = evaluateStructure(
    anchorFixture(),
    SWING_LR1,
    new Date(T0 + 21 * HOUR)
  );

  ok(
    eventSummary(result).join(",") ===
      "BOS:up,BOS:up,CHOCH:down,BOS:down",
    "M-база: [BOS up, BOS up, CHOCH down, BOS down] — все ветки FSM в одной фикстуре"
  );

  const bootstrap = result.events[0];
  const continuation = result.events[1];
  const choch = result.events[2];
  const reversal = result.events[3];

  /* M5: bootstrap BOS_UP, несколько opposite low кандидатов
   * (80@3 conf4, 84.06@6 conf7): anchor = ПОСЛЕДНИЙ
   * подтверждённый (84.06@6), НЕ lowest (80@3) и не первый. */
  ok(
    bootstrap.protectedAnchor !== null &&
      bootstrap.protectedAnchor.kind === "low" &&
      bootstrap.protectedAnchor.pivotKey ===
        anchorKey("low", 6) &&
      bootstrap.protectedAnchor.price === 84.06 &&
      bootstrap.protectedAnchor.confirmedAt.getTime() ===
        T0 + 8 * HOUR,
    "M5: bootstrap BOS_UP — anchor = low 84.06@6 (последний подтверждённый AVAILABLE), НЕ lowest low 80@3"
  );

  /* M1: continuation BOS_UP @12: кандидаты {80@3, 84.06@6,
   * 90@8} → anchor = 90@8 (последний подтверждённый; здесь
   * совпадает с highest, но выбирается по confirmedAt). */
  ok(
    continuation.protectedAnchor !== null &&
      continuation.protectedAnchor.kind === "low" &&
      continuation.protectedAnchor.pivotKey ===
        anchorKey("low", 8) &&
      continuation.protectedAnchor.price === 90 &&
      continuation.protectedAnchor.confirmedAt.getTime() ===
        T0 + 10 * HOUR &&
      continuation.protectedAnchor.confirmedAt.getTime() <
        continuation.confirmedAt.getTime(),
    "M1: continuation BOS_UP — anchor = ТОТ protectedLow, что выбрал FSM на boundary (90@8, из трёх кандидатов)"
  );

  /* M3: CHOCH_DOWN: anchor = сам пробитый protected low. */
  ok(
    choch.protectedAnchor !== null &&
      choch.protectedAnchor.pivotKey === choch.brokenPivotKey &&
      choch.protectedAnchor.price ===
        choch.brokenLevelPrice &&
      choch.protectedAnchor.price === 93 &&
      choch.protectedAnchor.kind === "low",
    "M3: CHOCH_DOWN — protectedAnchor = пробитый protected low (pivotKey === brokenPivotKey, price 93)"
  );

  /* M7: reversal-confirming BOS_DOWN @19: AVAILABLE highs на
   * boundary {97.5@7, 103@13, 105@15} (consumed 95@5/100@10
   * исключены) → anchor = 105@15 (последний подтверждённый). */
  ok(
    reversal.protectedAnchor !== null &&
      reversal.protectedAnchor.kind === "high" &&
      reversal.protectedAnchor.pivotKey ===
        anchorKey("high", 15) &&
      reversal.protectedAnchor.price === 105 &&
      reversal.protectedAnchor.confirmedAt.getTime() ===
        T0 + 17 * HOUR &&
      reversal.protectedAnchor.pivotKey !==
        anchorKey("high", 7) &&
      reversal.protectedAnchor.pivotKey !==
        anchorKey("high", 13),
    "M7: reversal BOS_DOWN — anchor = AVAILABLE high 105@15 этой boundary (не consumed, не older кандидаты)"
  );
}

/* M2/M4/M6/M8: зеркала — точная инверсия FIXTURE_ANCHOR. */
{
  const mirror = evaluateStructure(
    anchorFixture().map(negCandle),
    SWING_LR1,
    new Date(T0 + 21 * HOUR)
  );

  ok(
    eventSummary(mirror).join(",") ===
      "BOS:down,BOS:down,CHOCH:up,BOS:up",
    "M-зеркало: [BOS down, BOS down, CHOCH up, BOS up]"
  );

  const [bootstrap, continuation, choch, reversal] =
    mirror.events;

  ok(
    bootstrap.protectedAnchor !== null &&
      bootstrap.protectedAnchor.kind === "high" &&
      bootstrap.protectedAnchor.pivotKey ===
        anchorKey("high", 6) &&
      bootstrap.protectedAnchor.price === -84.06,
    "M6: bootstrap BOS_DOWN (зеркало) — anchor = high −84.06@6, НЕ highest −80@3"
  );
  ok(
    continuation.protectedAnchor !== null &&
      continuation.protectedAnchor.kind === "high" &&
      continuation.protectedAnchor.pivotKey ===
        anchorKey("high", 8) &&
      continuation.protectedAnchor.price === -90,
    "M2: continuation BOS_DOWN (зеркало) — anchor = protected high −90@8"
  );
  ok(
    choch.protectedAnchor !== null &&
      choch.protectedAnchor.kind === "high" &&
      choch.protectedAnchor.pivotKey === choch.brokenPivotKey &&
      choch.protectedAnchor.price === choch.brokenLevelPrice,
    "M4: CHOCH_UP (зеркало) — protectedAnchor = пробитый protected high (pivotKey === brokenPivotKey)"
  );
  ok(
    reversal.protectedAnchor !== null &&
      reversal.protectedAnchor.kind === "low" &&
      reversal.protectedAnchor.pivotKey ===
        anchorKey("low", 15) &&
      reversal.protectedAnchor.price === -105,
    "M8: reversal BOS_UP (зеркало) — anchor = AVAILABLE low −105@15 этой boundary"
  );
}

/* M1/M3 на FIXTURE_A: continuation-якорь = будущий CHOCH-уровень,
 * equality-кейс temporal-инварианта (pivot подтверждён той же
 * свечой, что пробивает continuation high). */
{
  const result = evaluateStructure(
    FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    SWING_LR1,
    new Date(T0 + 16 * HOUR)
  );

  const continuation = result.events[1];
  const choch = result.events[2];

  ok(
    continuation.type === "BOS" &&
      continuation.protectedAnchor !== null &&
      continuation.protectedAnchor.kind === "low" &&
      continuation.protectedAnchor.pivotKey ===
        anchorKey("low", 11) &&
      continuation.protectedAnchor.price === 113 &&
      continuation.protectedAnchor.confirmedAt.getTime() ===
        continuation.confirmedAt.getTime(),
    "M1/FIXTURE_A: continuation BOS_UP @13 — anchor = low 113@11, подтверждён ТОЙ ЖЕ свечой (equality-кейс инварианта <=)"
  );
  ok(
    choch.type === "CHOCH" &&
      choch.protectedAnchor !== null &&
      choch.protectedAnchor.pivotKey === choch.brokenPivotKey &&
      choch.protectedAnchor.pivotKey ===
        continuation.protectedAnchor?.pivotKey,
    "M3/FIXTURE_A: CHOCH_DOWN ломает РОВНО anchor предыдущего continuation BOS ( связность leg ↔ protected )"
  );
}

/* M9: CHOCH_INVALIDATED → protectedAnchor === null. */
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

  const invalidated = result.events.find(
    (event) => event.type === "CHOCH_INVALIDATED"
  );

  ok(
    invalidated !== undefined &&
      invalidated.protectedAnchor === null &&
      result.events.every(
        (event) =>
          event.type !== "CHOCH_INVALIDATED" ||
          event.protectedAnchor === null
      ),
    "M9: CHOCH_INVALIDATED — protectedAnchor === null (не новый structural leg)"
  );

  const mirrorInvalidated = evaluateStructure(
    mirror(FIXTURE_A)
      .map(([o, c], i) => mk(i, o, c))
      .concat([mk(15, 200 - 112, 200 - 120)]),
    SWING_LR1,
    new Date(T0 + 17 * HOUR)
  );

  ok(
    mirrorInvalidated.events.every(
      (event) =>
        event.type !== "CHOCH_INVALIDATED" ||
        event.protectedAnchor === null
    ),
    "M9: зеркало reclaim — CHOCH_INVALIDATED без anchor"
  );
}

/* M10: temporal invariant на всех событиях всех фикстур. */
{
  const suites: SmcRawCandle[][] = [
    FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    [
      ...FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
      mk(15, 112, 120)
    ],
    [
      ...FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
      mk(15, 112, 96),
      mk(16, 96, 94),
      mk(17, 94, 97),
      mk(18, 97, 101),
      mk(19, 101, 92)
    ],
    anchorFixture(),
    anchorFixture().map(negCandle)
  ];

  let allHold = true;

  for (const suite of suites) {
    const result = evaluateStructure(
      suite,
      SWING_LR1,
      new Date(T0 + 24 * HOUR)
    );

    for (const event of result.events) {
      if (
        event.protectedAnchor !== null &&
        event.protectedAnchor.confirmedAt.getTime() >
          event.confirmedAt.getTime()
      ) {
        allHold = false;
      }
    }
  }

  ok(
    allHold,
    "M10: temporal invariant — anchor.confirmedAt <= event.confirmedAt для всех событий всех фикстур"
  );
}

/* M11: future injection — события + anchors на prefix идентичны
 * полной серии (serialized). */
{
  const full = anchorFixture();
  const asOf = new Date(T0 + 17 * HOUR); // close CHOCH-свечи
  const onFull = evaluateStructure(full, SWING_LR1, asOf);
  const onPrefix = evaluateStructure(
    full.slice(0, 17),
    SWING_LR1,
    asOf
  );

  ok(
    JSON.stringify(onFull.events) ===
      JSON.stringify(onPrefix.events),
    "M11: future injection — events + protectedAnchor идентичны на prefix (asOf = CHOCH conf)"
  );

  const asOfReversal = new Date(T0 + 20 * HOUR);
  const fullRev = evaluateStructure(full, SWING_LR1, asOfReversal);
  const prefixRev = evaluateStructure(
    full.slice(0, 20),
    SWING_LR1,
    asOfReversal
  );

  ok(
    JSON.stringify(fullRev.events) ===
      JSON.stringify(prefixRev.events),
    "M11: future injection — до reversal-свечи включительно metadata не меняется от будущих свечей"
  );
}

/* M12: детерминированная сериализация metadata. */
{
  const run1 = evaluateStructure(
    anchorFixture(),
    SWING_LR1,
    new Date(T0 + 21 * HOUR)
  );
  const run2 = evaluateStructure(
    anchorFixture(),
    SWING_LR1,
    new Date(T0 + 21 * HOUR)
  );

  ok(
    JSON.stringify(run1) === JSON.stringify(run2),
    "M12: два запуска — байт-в-байт идентичный serialized output (включая anchors)"
  );
}

/* M13: mirror symmetry — поля anchors попарно зеркальны. */
{
  const direct = evaluateStructure(
    anchorFixture(),
    SWING_LR1,
    new Date(T0 + 21 * HOUR)
  );
  const mirror = evaluateStructure(
    anchorFixture().map(negCandle),
    SWING_LR1,
    new Date(T0 + 21 * HOUR)
  );

  let symmetric =
    direct.events.length === mirror.events.length;

  if (symmetric) {
    for (let i = 0; i < direct.events.length; i++) {
      const a = direct.events[i].protectedAnchor;
      const b = mirror.events[i].protectedAnchor;

      if ((a === null) !== (b === null)) {
        symmetric = false;
        break;
      }

      if (a !== null && b !== null) {
        const kindFlipped =
          (a.kind === "high") === (b.kind === "low");
        const priceMirrored =
          Math.abs(a.price + b.price) <= 1e-9;
        const timesEqual =
          a.eventTime.getTime() === b.eventTime.getTime() &&
          a.confirmedAt.getTime() === b.confirmedAt.getTime();

        if (!kindFlipped || !priceMirrored || !timesEqual) {
          symmetric = false;
          break;
        }
      }
    }
  }

  ok(
    symmetric,
    "M13: mirror symmetry — anchor.kind зеркален, price точно инвертирована, времена равны, nullity совпадает"
  );
}

/* ---------- CRITICAL REGRESSION: projection WITHOUT
 * protectedAnchor идентична прежнему контракту ---------- */

{
  const high112 = anchorKey("high", 2);
  const high121 = anchorKey("high", 9);
  const low101 = anchorKey("low", 4);
  const low113 = anchorKey("low", 11);

  const result = evaluateStructure(
    FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
    SWING_LR1,
    new Date(T0 + 16 * HOUR)
  );

  /* Projection строго из ДО-расширений полей. */
  const projection = result.events.map((event) => ({
    key: event.key,
    layer: event.layer,
    type: event.type,
    dir: event.dir,
    brokenPivotKey: event.brokenPivotKey,
    brokenLevelPrice: event.brokenLevelPrice,
    eventTime: event.eventTime.getTime(),
    confirmedAt: event.confirmedAt.getTime()
  }));

  const expected = [
    {
      key: `SMC1|E|1h|swing|BOS|up|${high112}|${T0 + 7 * HOUR}`,
      layer: "swing",
      type: "BOS",
      dir: "up",
      brokenPivotKey: high112,
      brokenLevelPrice: 112,
      eventTime: T0 + 7 * HOUR,
      confirmedAt: T0 + 8 * HOUR
    },
    {
      key: `SMC1|E|1h|swing|BOS|up|${high121}|${T0 + 13 * HOUR}`,
      layer: "swing",
      type: "BOS",
      dir: "up",
      brokenPivotKey: high121,
      brokenLevelPrice: 121,
      eventTime: T0 + 13 * HOUR,
      confirmedAt: T0 + 14 * HOUR
    },
    {
      key: `SMC1|E|1h|swing|CHOCH|down|${low113}|${T0 + 14 * HOUR}`,
      layer: "swing",
      type: "CHOCH",
      dir: "down",
      brokenPivotKey: low113,
      brokenLevelPrice: 113,
      eventTime: T0 + 14 * HOUR,
      confirmedAt: T0 + 15 * HOUR
    }
  ];

  ok(
    JSON.stringify(projection) === JSON.stringify(expected),
    "REG: event projection (key/layer/type/dir/broken*/eventTime/confirmedAt) — байт-в-байт прежний контракт"
  );

  /* Phase + AVAILABLE/CONSUMED lifecycle — прежние. */
  const lifecycleOk =
    result.phase === "REVERSAL_PENDING_DOWN" &&
    result.pivots.length === 4 &&
    result.levels.filter((level) => level.state === "CONSUMED")
      .length === 3 &&
    result.levels.find((level) => level.pivotKey === high112)
      ?.consumedByEventKey === result.events[0].key &&
    result.levels.find((level) => level.pivotKey === high121)
      ?.consumedByEventKey === result.events[1].key &&
    result.levels.find((level) => level.pivotKey === low113)
      ?.consumedByEventKey === result.events[2].key &&
    result.levels.find((level) => level.pivotKey === low101)
      ?.state === "AVAILABLE";

  ok(
    lifecycleOk,
    "REG: phase + AVAILABLE/CONSUMED lifecycle (consumedByEventKey) — без изменений"
  );

  /* Reversal-extension fixture: projection 4 событий. */
  const ext = evaluateStructure(
    [
      ...FIXTURE_A.map(([o, c], i) => mk(i, o, c)),
      mk(15, 112, 96),
      mk(16, 96, 94),
      mk(17, 94, 97),
      mk(18, 97, 101),
      mk(19, 101, 92)
    ],
    SWING_LR1,
    new Date(T0 + 20 * HOUR)
  );

  const extSummary = ext.events.map(
    (event) =>
      `${event.type}:${event.dir}@${
        (event.eventTime.getTime() - T0) / HOUR
      }h:${event.brokenLevelPrice}`
  );

  ok(
    extSummary.join(",") ===
      "BOS:up@7h:112,BOS:up@13h:121,CHOCH:down@14h:113,BOS:down@19h:94" &&
      ext.phase === "TREND_DOWN" &&
      ext.events[3].protectedAnchor !== null,
    "REG: reversal-extension projection прежний (BOS down @19 broken 94), anchor как metadata не влияет на события"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
