/**
 * SMC Phase 1 — anti-lookahead тесты
 * (запуск: npx tsx scripts/test-smc-lookahead.ts).
 *
 * Каноническое свойство: evaluateStructure(past + future,
 * asOf = T) === evaluateStructure(past, asOf = T) для
 * одинакового префикса ≤ T. Сравнение — serialized canonical
 * output (JSON), не частичные проверки.
 */

import { evaluateStructure } from "../lib/smc/fsm";
import { SmcRawCandle, StructureParams } from "../lib/smc/types";

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

const PIVOT_LR2: StructureParams = {
  tf: "1h",
  layer: "internal",
  left: 2,
  right: 2
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

function asOf(i: number): Date {
  // effectiveCloseTime свечи i = T0 + (i+1)h.
  return new Date(T0 + (i + 1) * HOUR);
}

/* ---------- 7. pivot boundary: asOf vs confirmedAt ---------- */

{
  const input = [
    mk(0, 98, 100),
    mk(1, 100, 106),
    mk(2, 106, 110),
    mk(3, 109, 104),
    mk(4, 104, 102)
  ];

  // confirmedAt пивота 110 = effectiveCloseTime(4) = T0+5h.
  const at = evaluateStructure(
    input,
    PIVOT_LR2,
    asOf(4)
  );
  const before = evaluateStructure(
    input,
    PIVOT_LR2,
    new Date(asOf(4).getTime() - 1)
  );

  ok(
    at.pivots.length === 1 && at.pivots[0].price === 110,
    "7: asOf = confirmedAt → пивот присутствует"
  );
  ok(
    before.pivots.length === 0 &&
      before.phase === "UNDEFINED",
    "7: asOf = confirmedAt - 1ms → пивот отсутствует"
  );
}

/* ---------- event boundary (BOS) ---------- */

{
  const input = FIXTURE_A.map(([o, c], i) =>
    mk(i, o, c)
  );

  // BOS_up(112) подтверждается close'ом свечи 7:
  // confirmedAt = effectiveCloseTime(7) = T0+8h.
  const at = evaluateStructure(input, SWING_LR1, asOf(7));
  const before = evaluateStructure(
    input,
    SWING_LR1,
    new Date(asOf(7).getTime() - 1)
  );

  ok(
    at.events.length === 1 &&
      at.events[0].type === "BOS" &&
      at.phase === "TREND_UP",
    "7b: asOf = confirmedAt события → BOS присутствует, тренд виден"
  );
  ok(
    before.events.length === 0 &&
      before.phase === "UNDEFINED",
    "7b: asOf = confirmedAt - 1ms → события нет, UNDEFINED"
  );
}

/* ---------- 9. future injection invariance ---------- */

{
  const full = FIXTURE_A.map(([o, c], i) =>
    mk(i, o, c)
  );

  for (const cutIndex of [3, 6, 10, 13]) {
    const onFull = evaluateStructure(
      full,
      SWING_LR1,
      asOf(cutIndex)
    );
    const onPrefix = evaluateStructure(
      full.slice(0, cutIndex + 1),
      SWING_LR1,
      asOf(cutIndex)
    );

    ok(
      JSON.stringify(onFull) ===
        JSON.stringify(onPrefix),
      `9: future injection инвариантен на срезе ${cutIndex} (serialized canonical output)`
    );
  }

  // Срез с будущими свечами внутри массива (не хвостом):
  // candle 12 (важный low-пивот) исключена, candle 14
  // (будущая) присутствует — горизонт вырезает по closeTime.
  const withHole = full.filter(
    (_, i) => i !== 12
  );

  ok(
    JSON.stringify(
      evaluateStructure(withHole, SWING_LR1, asOf(11))
    ) ===
      JSON.stringify(
        evaluateStructure(
          full.slice(0, 12),
          SWING_LR1,
          asOf(11)
        )
      ),
    "9b: будущие свечи вне префикса не влияют на результат даже в 'дырявом' массиве"
  );
}

/* ---------- K. score-level no-rewrite (structure state) ---------- */

{
  // Полное состояние структуры на T не меняется от
  // дописывания будущих свечей — включая фазу, уровни и
  // их consumed-статусы (это фундамент будущего score).
  const full = FIXTURE_A.map(([o, c], i) =>
    mk(i, o, c)
  ).concat([
    mk(15, 112, 96),
    mk(16, 96, 94),
    mk(17, 94, 97),
    mk(18, 97, 101),
    mk(19, 101, 92)
  ]);

  const onFull = evaluateStructure(
    full,
    SWING_LR1,
    asOf(14)
  );
  const onPrefix = evaluateStructure(
    full.slice(0, 15),
    SWING_LR1,
    asOf(14)
  );

  ok(
    JSON.stringify(onFull) ===
      JSON.stringify(onPrefix),
    "K: состояние (фаза/события/уровни) на T не переписывается будущими свечами"
  );
  ok(
    onFull.phase === "REVERSAL_PENDING_DOWN" &&
      onFull.pivots.length === 4,
    "K: на T=close(14) структура ровно та, что была известна на T"
  );
}

/* ---------- asOf до всех закрытий ---------- */

{
  const full = FIXTURE_A.map(([o, c], i) =>
    mk(i, o, c)
  );

  const empty = evaluateStructure(
    full,
    SWING_LR1,
    new Date(T0)
  );

  ok(
    empty.phase === "UNDEFINED" &&
      empty.pivots.length === 0 &&
      empty.events.length === 0 &&
      empty.levels.length === 0,
    "asOf до первого закрытия → пустой валидный результат"
  );
  ok(
    JSON.stringify(
      evaluateStructure(full, SWING_LR1, new Date(T0))
    ) ===
      JSON.stringify(
        evaluateStructure(
          [],
          SWING_LR1,
          new Date(T0)
        )
      ),
    "asOf до всех закрытий: полный массив ≡ пустой массив"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
