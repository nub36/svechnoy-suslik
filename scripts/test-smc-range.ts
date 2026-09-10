/**
 * SMC Phase 2D — тесты External Dealing Range +
 * Premium/Discount/Equilibrium
 * (запуск: npx tsx scripts/test-smc-range.ts).
 *
 * Range строится ТОЛЬКО из evaluateStructure(swing) +
 * metadata contract (brokenPivotKey/protectedAnchor).
 *
 * Фикстура-якоря (из FSM metadata тестов, swing 1/1):
 * bootstrap BOS up @7 (anchor low 84.06@6 → R1 [84.06, 95],
 * conf T0+8h) → continuation BOS up @12 (anchor low 90@8 →
 * R2 [90,100], conf T0+13h) → CHOCH down @16 (conf T0+17h,
 * R2 closed) → reversal BOS down @19 (anchor high 105@15,
 * broken low 79 → R3 [79,105], conf T0+20h).
 * Price-фикстура: bootstrap [100, 200] conf T0+8h, далее
 * управляемые close последней свечи (позиции 0.47…1.01 —
 * целочисленная арифметика без float-дырок).
 */

import {
  buildDealingRangeFromBos,
  defaultRangeConfig,
  evaluateDealingRange,
  SmcRangeConfig,
  SmcRangeInvariantError
} from "../lib/smc/range";
import {
  SmcPivotKind,
  SmcRawCandle,
  SmcStructureAnchorSnapshot,
  SmcStructureEvent,
  SmcStructureEventType
} from "../lib/smc/types";
import { SmcInputError } from "../lib/smc/validate";

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
  label: string,
  eps = 1e-9
): void {
  ok(
    Math.abs(actual - expected) <= eps,
    `${label} (${actual} ~ ${expected})`
  );
}

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3_600_000;

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

function cfg(
  overrides: Partial<SmcRangeConfig> = {}
): SmcRangeConfig {
  return {
    ...defaultRangeConfig("1h"),
    swingLeft: 1,
    swingRight: 1,
    ...overrides
  };
}

function ev(
  raw: SmcRawCandle[],
  asOfMs: number,
  config: SmcRangeConfig = cfg()
) {
  return evaluateDealingRange(raw, config, new Date(asOfMs));
}

/** Точная инверсия свечи (зеркало фикстуры). */
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
): string => `SMC1|P|1h|swing|${kind}|${T0 + hour * HOUR}`;

const bosKey = (
  dir: "up" | "down",
  brokenHour: number,
  candleHour: number
): string =>
  `SMC1|E|1h|swing|BOS|${dir}|${anchorKey(
    dir === "up" ? "high" : "low",
    brokenHour
  )}|${T0 + candleHour * HOUR}`;

/** Жизненный цикл: bootstrap → continuation → CHOCH → reversal. */
function anchorFixture(): SmcRawCandle[] {
  const flatM = (i: number): SmcRawCandle => {
    const b = i * 0.01;

    return mk(i, 86 + b, 87 + b, 90 + b, 84 + b);
  };

  return [
    flatM(0),
    flatM(1),
    flatM(2),
    mk(3, 87, 85.5, 87.5, 80),     // low 80@3
    flatM(4),
    mk(5, 87, 88, 95, 86.5),       // high 95@5
    flatM(6),                      // low 84.06@6
    mk(7, 95.5, 97, 97.5, 94),     // bootstrap BOS up
    mk(8, 96, 92, 96.5, 90),       // low 90@8
    mk(9, 92.09, 93.09, 95.09, 91.09),
    mk(10, 93, 94, 100, 92),       // high 100@10
    mk(11, 93.11, 94.11, 96.11, 92.11),
    mk(12, 94, 101, 101.5, 93.5),  // continuation BOS up
    mk(13, 100.5, 99, 103, 98.5),  // high 103@13
    mk(14, 99, 96, 100.14, 93),    // low 93@14
    mk(15, 96.15, 97, 105, 95.15), // high 105@15
    mk(16, 96, 85, 96.5, 84),      // CHOCH down
    mk(17, 85, 80.5, 85.5, 79),    // low 79@17
    mk(18, 80.2, 81.18, 82.18, 80.1),
    mk(19, 81, 77.5, 81.5, 76.5),  // reversal BOS down
    flatM(20)
  ];
}

/** Failed CHOCH: reclaim вверх вместо reversal. */
function reclaimFixture(): SmcRawCandle[] {
  const raw = anchorFixture();

  raw[17] = mk(17, 85, 95, 96, 84); // reclaim (95 > 93)
  raw[18] = mk(18, 86.18, 87.18, 90.18, 84.18);
  raw[19] = mk(19, 86.19, 87.19, 90.19, 84.19);

  return raw;
}

/** FIXTURE_A из FSM-тестов: bootstrap [101,112] → continuation
 * [113,121] → CHOCH down (conf T0+15h). */
function fixtureA(): SmcRawCandle[] {
  const pairs: [number, number][] = [
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

  return pairs.map(([o, c], i) => mk(i, o, c));
}

/** Price-фикстура: bootstrap BOS up @7 → range [100, 200].
 * Последняя свеча добавляется вызывающим кодом с нужным close. */
function priceBase(): SmcRawCandle[] {
  const flatP = (i: number): SmcRawCandle => {
    const b = i * 0.01;

    return mk(i, 120 + b, 121 + b, 124 + b, 117 + b);
  };

  return [
    flatP(0),
    flatP(1),
    flatP(2),
    mk(3, 121, 118, 124, 100),  // pivot low 100@3
    flatP(4),
    mk(5, 121, 125, 200, 118),  // pivot high 200@5
    flatP(6),
    mk(7, 201, 205, 206, 110)   // bootstrap BOS up (low 110: FL(6) не локальный минимум)
  ];
}

/** Управляемая последняя свеча с точным close. */
function withClose(
  close: number,
  base: SmcRawCandle[] = priceBase()
): SmcRawCandle[] {
  const open = 121.08;

  return [
    ...base,
    mk(
      base.length,
      open,
      close,
      Math.max(open, close) + 0.5,
      Math.min(open, close) - 0.5
    )
  ];
}

/* ---------- 1–2. bootstrap BOS создаёт range ---------- */

{
  const r = ev(anchorFixture(), T0 + 9 * HOUR);

  ok(
    r.history.length === 1 &&
      r.current !== null &&
      r.current.direction === "up" &&
      r.current.low === 84.06 &&
      r.current.high === 95,
    "1: bootstrap BOS_UP создаёт range из protectedAnchor [84.06, 95], direction up"
  );
  ok(
    r.current !== null &&
      r.current.anchorStartPivotKey === anchorKey("low", 6) &&
      r.current.anchorEndPivotKey === anchorKey("high", 5),
    "5/6: anchorStartPivotKey = protectedAnchor.pivotKey (low 84.06@6), anchorEndPivotKey = brokenPivotKey (high 95@5)"
  );
  ok(
    r.current !== null &&
      r.current.confirmedAt.getTime() === T0 + 8 * HOUR &&
      r.current.eventTime.getTime() === T0 + 7 * HOUR &&
      r.current.replacedAt === null,
    "8/9: confirmedAt = BOS.confirmedAt (T0+8h), eventTime = BOS.eventTime (T0+7h), replacedAt null"
  );
  closeTo(
    r.current!.equilibrium,
    (84.06 + 95) / 2,
    "25: equilibrium = точная середина (low+high)/2"
  );

  const mirror = ev(
    anchorFixture().map(negCandle),
    T0 + 9 * HOUR
  );

  ok(
    mirror.history.length === 1 &&
      mirror.current !== null &&
      mirror.current.direction === "down" &&
      mirror.current.low === -95 &&
      mirror.current.high === -84.06 &&
      mirror.current.anchorStartPivotKey ===
        anchorKey("high", 6) &&
      mirror.current.anchorEndPivotKey ===
        anchorKey("low", 5),
    "2: bootstrap BOS_DOWN (зеркало) — range [-95, -84.06], anchors зеркальны"
  );
}

/* ---------- 3–4/7/12. continuation создаёт новую version ---------- */

{
  const r = ev(anchorFixture(), T0 + 16 * HOUR);

  ok(
    r.history.length === 2 &&
      r.history[0].low === 84.06 &&
      r.history[1].low === 90 &&
      r.history[1].high === 100 &&
      r.history[1].direction === "up",
    "3: continuation BOS_UP создаёт НОВУЮ version R2 [90, 100]"
  );
  ok(
    r.history[0].replacedAt !== null &&
      r.history[0].replacedAt.getTime() === T0 + 13 * HOUR,
    "12: предыдущая version закрыта ровно в confirmedAt новой (R1.replacedAt = T0+13h)"
  );
  ok(
    r.current !== null &&
      r.current.key === r.history[1].key &&
      r.history[1].anchorStartPivotKey ===
        anchorKey("low", 8) &&
      r.history[1].anchorEndPivotKey ===
        anchorKey("high", 10),
    "5/6: R2 anchors — protectedAnchor low 90@8 → broken high 100@10 (метаданные FSM, не эвристика)"
  );

  const mirror = ev(
    anchorFixture().map(negCandle),
    T0 + 16 * HOUR
  );

  ok(
    mirror.history.length === 2 &&
      mirror.history[1].direction === "down" &&
      mirror.history[1].low === -100 &&
      mirror.history[1].high === -90,
    "4: continuation BOS_DOWN (зеркало) — R2 [-100, -90], direction down"
  );
}

/* ---------- 10/11. asOf-граница confirmedAt ---------- */

{
  ok(
    ev(anchorFixture(), T0 + 8 * HOUR - 1).history.length === 0,
    "10: asOf = confirmedAt − 1ms → range отсутствует"
  );
  ok(
    ev(anchorFixture(), T0 + 8 * HOUR).history.length === 1,
    "11: asOf = confirmedAt → range присутствует"
  );
}

/* ---------- 13. нет overlapping active versions ---------- */

{
  let maxActive = 0;
  let sequence = "";

  for (let h = 8; h <= 21; h++) {
    const r = ev(anchorFixture(), T0 + h * HOUR);
    const active = r.history.filter(
      (range) =>
        range.replacedAt === null ||
        T0 + h * HOUR < range.replacedAt.getTime()
    );

    maxActive = Math.max(maxActive, active.length);

    if (
      (r.current === null) !== (active.length === 0) ||
      (r.current !== null &&
        r.current.key !== active[active.length - 1].key)
    ) {
      sequence += "!";
    }

    sequence +=
      r.current === null
        ? "-"
        : r.current.direction === "up"
          ? "U"
          : "D";
  }

  ok(
    maxActive <= 1 && sequence === "UUUUUUUUU---DD",
    `13: ровно 0/1 active version в каждый момент (серия ${sequence})`
  );
}

/* ---------- 14–16. CHOCH / pending ---------- */

{
  const r17 = ev(anchorFixture(), T0 + 17 * HOUR);

  ok(
    r17.history.length === 2 &&
      r17.history[1].replacedAt !== null &&
      r17.history[1].replacedAt.getTime() === T0 + 17 * HOUR &&
      r17.current === null,
    "14: CHOCH закрывает active range (R2.replacedAt = CHOCH.confirmedAt T0+17h), current null"
  );

  const r16 = ev(anchorFixture(), T0 + 16 * HOUR);

  ok(
    r16.history.length === 2 &&
      r16.history[1].replacedAt === null &&
      r16.current !== null &&
      r16.current.key === r16.history[1].key,
    "15: asOf до CHOCH НЕ видит future replacedAt (R2.replacedAt null при asOf T0+16h)"
  );

  ok(
    ev(anchorFixture(), T0 + 19 * HOUR).current === null,
    "16: пока FSM pending (после CHOCH до reversal) — current range null, Premium/Discount unavailable"
  );
}

/* ---------- 17. failed CHOCH: no resurrection ---------- */

{
  const r = ev(reclaimFixture(), T0 + 20 * HOUR);

  ok(
    r.history.length === 2 &&
      r.history[1].replacedAt !== null &&
      r.history[1].replacedAt.getTime() === T0 + 17 * HOUR &&
      r.current === null,
    "17: CHOCH → CHOCH_INVALIDATED — старая range НЕ воскрешается (replacedAt не откатывается), current null до следующего valid BOS"
  );
}

/* ---------- 18. confirmed reversal → opposite range ---------- */

{
  const r = ev(anchorFixture(), T0 + 21 * HOUR);

  ok(
    r.history.length === 3 &&
      r.current !== null &&
      r.current.direction === "down" &&
      r.current.low === 79 &&
      r.current.high === 105 &&
      r.current.confirmedAt.getTime() === T0 + 20 * HOUR &&
      r.current.replacedAt === null,
    "18: reversal-confirming BOS создаёт противоположную range общим алгоритмом — R3 down [79, 105], conf T0+20h"
  );
  ok(
    r.current !== null &&
      r.current.anchorStartPivotKey ===
        anchorKey("high", 15) &&
      r.current.anchorEndPivotKey === anchorKey("low", 17),
    "18: R3 anchors — protectedAnchor high 105@15 → broken low 79@17 (metadata FSM)"
  );
  closeTo(
    r.current!.equilibrium,
    92,
    "18: R3 equilibrium = (79 + 105)/2 = 92"
  );
}

/* ---------- 19–21. defensive policy через pure helper ---------- */

function mkEvent(
  dir: "up" | "down",
  anchor: SmcStructureAnchorSnapshot | null,
  brokenKey: string,
  brokenPrice: number,
  confOffsetMs = 0
): SmcStructureEvent {
  return {
    key: `SMC1|E|1h|swing|BOS|${dir}|${brokenKey}|${T0 + 7 * HOUR}`,
    layer: "swing",
    type: "BOS" as SmcStructureEventType,
    dir,
    brokenPivotKey: brokenKey,
    brokenLevelPrice: brokenPrice,
    eventTime: new Date(T0 + 7 * HOUR),
    confirmedAt: new Date(T0 + 8 * HOUR + confOffsetMs),
    protectedAnchor: anchor
  };
}

const kindMap = new Map<string, SmcPivotKind>([
  [anchorKey("high", 5), "high"],
  [anchorKey("low", 6), "low"]
]);

function throwsInvariant(
  fn: () => void,
  label: string
): void {
  try {
    fn();
    ok(false, label);
  } catch (error) {
    ok(
      error instanceof SmcRangeInvariantError,
      label
    );
  }
}

{
  const nullRange = buildDealingRangeFromBos(
    mkEvent("up", null, anchorKey("high", 5), 95),
    "1h",
    kindMap
  );

  ok(
    nullRange === null,
    "19: protectedAnchor === null → BOS не создаёт range (skip-invalid, легитимное рыночное условие FSM)"
  );

  throwsInvariant(
    () =>
      buildDealingRangeFromBos(
        mkEvent(
          "up",
          {
            pivotKey: anchorKey("high", 6),
            kind: "high",
            price: 84.06,
            eventTime: new Date(T0 + 6 * HOUR),
            confirmedAt: new Date(T0 + 7 * HOUR)
          },
          anchorKey("high", 5),
          95
        ),
        "1h",
        kindMap
      ),
    "20: BOS_UP с anchor.kind high — типизированный SmcRangeInvariantError (metadata inconsistent, другой anchor не подбирается)"
  );

  throwsInvariant(
    () =>
      buildDealingRangeFromBos(
        mkEvent(
          "up",
          {
            pivotKey: anchorKey("low", 6),
            kind: "low",
            price: 100,
            eventTime: new Date(T0 + 6 * HOUR),
            confirmedAt: new Date(T0 + 7 * HOUR)
          },
          anchorKey("high", 5),
          95
        ),
        "1h",
        kindMap
      ),
    "21: low >= high (anchor 100 > broken 95) — SmcRangeInvariantError"
  );

  throwsInvariant(
    () =>
      buildDealingRangeFromBos(
        mkEvent(
          "up",
          {
            pivotKey: anchorKey("low", 6),
            kind: "low",
            price: 84.06,
            eventTime: new Date(T0 + 6 * HOUR),
            confirmedAt: new Date(T0 + 7 * HOUR)
          },
          anchorKey("high", 99),
          95
        ),
        "1h",
        new Map()
      ),
    "20-доп: broken pivot отсутствует в pivots — SmcRangeInvariantError"
  );

  throwsInvariant(
    () =>
      buildDealingRangeFromBos(
        mkEvent(
          "up",
          {
            pivotKey: anchorKey("low", 20),
            kind: "low",
            price: 84.06,
            eventTime: new Date(T0 + 20 * HOUR),
            confirmedAt: new Date(T0 + 21 * HOUR)
          },
          anchorKey("high", 5),
          95,
          -3_600_000
        ),
        "1h",
        kindMap
      ),
    "temporal: anchor.confirmedAt > event.confirmedAt — SmcRangeInvariantError"
  );

  const valid = buildDealingRangeFromBos(
    mkEvent(
      "up",
      {
        pivotKey: anchorKey("low", 6),
        kind: "low",
        price: 84.06,
        eventTime: new Date(T0 + 6 * HOUR),
        confirmedAt: new Date(T0 + 7 * HOUR)
      },
      anchorKey("high", 5),
      95
    ),
    "1h",
    kindMap
  );

  ok(
    valid !== null &&
      valid.key ===
        `SMC1|RANGE|1h|up|SMC1|E|1h|swing|BOS|up|${anchorKey("high", 5)}|${T0 + 7 * HOUR}`,
    "22: deterministic key SMC1|RANGE|tf|direction|confirmingBosEventKey (без DB-id/random/price)"
  );
}

/* ---------- 22-доп. key через публичный API ---------- */

{
  const r = ev(anchorFixture(), T0 + 9 * HOUR);
  const run2 = ev(anchorFixture(), T0 + 9 * HOUR);

  ok(
    r.current !== null &&
      r.current.key ===
        `SMC1|RANGE|1h|up|${bosKey("up", 5, 7)}` &&
      JSON.stringify(r) === JSON.stringify(run2),
    "22: key через публичный API совпадает с контрактом; повторная оценка байт-в-байт"
  );
}

/* ---------- 23/24. history chronological + current selection ---------- */

{
  const r = ev(anchorFixture(), T0 + 21 * HOUR);
  const confs = r.history.map((range) =>
    range.confirmedAt.getTime()
  );

  ok(
    confs.length === 3 &&
      confs[0] === T0 + 8 * HOUR &&
      confs[1] === T0 + 13 * HOUR &&
      confs[2] === T0 + 20 * HOUR,
    "23: history хронологична по confirmedAt [T0+8h, T0+13h, T0+20h]"
  );

  let consistent = true;

  for (let h = 7; h <= 21; h++) {
    const rr = ev(anchorFixture(), T0 + h * HOUR);
    const visible = rr.history.filter(
      (range) =>
        range.replacedAt === null ||
        T0 + h * HOUR < range.replacedAt.getTime()
    );
    const last =
      visible.length === 0
        ? null
        : visible[visible.length - 1];

    if (
      (rr.current === null) !== (last === null) ||
      (rr.current !== null &&
        last !== null &&
        rr.current.key !== last.key)
    ) {
      consistent = false;
    }
  }

  // Явные sampled-моменты переключения.
  const at = (h: number) => ev(anchorFixture(), T0 + h * HOUR);
  const sampled =
    at(12).current?.key === r.history[0].key &&
    at(13).current?.key === r.history[1].key &&
    at(16).current?.key === r.history[1].key &&
    at(17).current === null &&
    at(19).current === null &&
    at(20).current?.key === r.history[2].key &&
    at(21).current?.key === r.history[2].key;

  ok(
    consistent && sampled,
    "24: current = последняя version с confirmedAt <= asOf И (replacedAt null ИЛИ asOf < replacedAt): R1 до 13h, R2 13–16h, null 17–19h, R3 с 20h"
  );
}

/* ---------- 25–31/34/35. price context, зоны ---------- */

{
  // База: range [100, 200], eq 150; целочисленные позиции.
  const cases: [number, number, string, boolean, string][] = [
    [147, 0.47, "DISCOUNT", false, "30: pos 0.47 < 0.48 → DISCOUNT"],
    [148, 0.48, "EQUILIBRIUM", false, "28: pos ровно 0.48 → EQUILIBRIUM (граница включительно)"],
    [150, 0.5, "EQUILIBRIUM", false, "25: pos 0.5 → EQUILIBRIUM, equilibrium = (100+200)/2 = 150"],
    [152, 0.52, "EQUILIBRIUM", false, "29: pos ровно 0.52 → EQUILIBRIUM"],
    [153, 0.53, "PREMIUM", false, "31: pos 0.53 > 0.52 → PREMIUM"],
    [200, 1, "PREMIUM", false, "35: price ровно high → pos 1, outsideRange = false"],
    [100, 0, "DISCOUNT", false, "34: price ровно low → pos 0, outsideRange = false"],
    [201, 1.01, "PREMIUM", true, "33: price выше high → pos 1.01, outsideRange = true (без clamp)"]
  ];

  for (const [close, position, zone, outside, label] of cases) {
    const r = ev(withClose(close), T0 + 9 * HOUR);

    ok(
      r.current !== null &&
        r.priceContext !== null &&
        r.priceContext.price === close &&
        Math.abs(r.priceContext.position - position) <= 1e-9 &&
        r.priceContext.zone === zone &&
        r.priceContext.outsideRange === outside &&
        r.priceContext.eqBand === 0.02,
      label
    );
  }

  closeTo(
    ev(withClose(150), T0 + 9 * HOUR).current!.equilibrium,
    150,
    "25: equilibrium exact midpoint [100,200] → 150"
  );
}

/* ---------- 32. price ниже low — через DOWN range ---------- */

{
  // В up-range цена ниже protectedLow структурно закрыла бы
  // range CHOCH (FSM — источник истины); поэтому ниже-low кейс
  // проверяется на зеркальной down-range: структурно ничего не
  // происходит, позиция честно < 0.
  const downBase = priceBase().map(negCandle); // range [-200, -100]

  const below = ev(withClose(-201, downBase), T0 + 9 * HOUR);

  ok(
    below.current !== null &&
      below.priceContext !== null &&
      Math.abs(below.priceContext.position - -0.01) <= 1e-9 &&
      below.priceContext.zone === "DISCOUNT" &&
      below.priceContext.outsideRange === true,
    "32: price ниже low → position −0.01 (без clamp), outsideRange = true"
  );

  const atLow = ev(withClose(-200, downBase), T0 + 9 * HOUR);

  ok(
    atLow.priceContext !== null &&
      atLow.priceContext.position === 0 &&
      atLow.priceContext.outsideRange === false,
    "34-доп: down range, price ровно low → pos 0, outsideRange false"
  );
}

/* ---------- 36. direction не переворачивает геометрию ---------- */

{
  const up = ev(withClose(190), T0 + 9 * HOUR);
  const down = ev(
    withClose(-110, priceBase().map(negCandle)),
    T0 + 9 * HOUR
  );

  ok(
    up.priceContext !== null &&
      down.priceContext !== null &&
      Math.abs(up.priceContext.position - 0.9) <= 1e-9 &&
      Math.abs(down.priceContext.position - 0.9) <= 1e-9 &&
      up.priceContext.zone === "PREMIUM" &&
      down.priceContext.zone === "PREMIUM",
    "36: одинаковая позиция 0.9 → PREMIUM и в up, и в down range (low side = discount, high side = premium, геометрия не флипается)"
  );
}

/* ---------- eqBand границы ---------- */

{
  const zero = ev(
    withClose(148),
    T0 + 9 * HOUR,
    cfg({ eqBand: 0 })
  );
  const wide = ev(
    withClose(148),
    T0 + 9 * HOUR,
    cfg({ eqBand: 0.4 })
  );
  const zeroHigh = ev(
    withClose(152),
    T0 + 9 * HOUR,
    cfg({ eqBand: 0 })
  );

  ok(
    zero.priceContext !== null &&
      zero.priceContext.zone === "DISCOUNT" &&
      wide.priceContext !== null &&
      wide.priceContext.zone === "EQUILIBRIUM" &&
      zeroHigh.priceContext !== null &&
      zeroHigh.priceContext.zone === "PREMIUM",
    "eqBand: 0 → [0.5,0.5] (0.48 DISCOUNT, 0.52 PREMIUM), 0.4 → EQUILIBRIUM; полоса покрывает пространство без дырок"
  );
}

/* ---------- 39. malformed eqBand rejected ---------- */

{
  const bad: number[] = [
    Number.NaN,
    -0.01,
    0.5,
    0.7,
    Number.POSITIVE_INFINITY
  ];

  let allRejected = true;

  for (const eqBand of bad) {
    try {
      evaluateDealingRange(
        priceBase(),
        cfg({ eqBand }),
        new Date(T0 + 9 * HOUR)
      );
      allRejected = false;
    } catch (error) {
      if (!(error instanceof SmcInputError)) {
        allRejected = false;
      }
    }
  }

  ok(
    allRejected,
    "39: eqBand NaN/-0.01/0.5/0.7/Inf → SmcInputError (требование: конечное 0 <= eqBand < 0.5)"
  );

  let edgeAccepted = true;

  try {
    evaluateDealingRange(
      priceBase(),
      cfg({ eqBand: 0 }),
      new Date(T0 + 9 * HOUR)
    );
    evaluateDealingRange(
      priceBase(),
      cfg({ eqBand: 0.49 }),
      new Date(T0 + 9 * HOUR)
    );
  } catch {
    edgeAccepted = false;
  }

  ok(
    edgeAccepted,
    "39: граничные валидные eqBand 0 и 0.49 принимаются"
  );
}

/* ---------- 37. future injection invariant ---------- */

{
  const full = anchorFixture();
  let identical = true;

  for (const asOfHour of [9, 16, 18, 21]) {
    const onFull = ev(full, T0 + asOfHour * HOUR);
    const onPrefix = ev(
      full.slice(0, asOfHour + 1),
      T0 + asOfHour * HOUR
    );

    if (
      JSON.stringify(onFull) !== JSON.stringify(onPrefix)
    ) {
      identical = false;
    }
  }

  ok(
    identical,
    "37: future injection — evaluate(full, T) ≡ evaluate(prefix, T) serialized (history/current/replacedAt/priceContext)"
  );
}

/* ---------- 38. serialized historical no-rewrite ---------- */

{
  const full = anchorFixture();
  const early = ev(full, T0 + 9 * HOUR).history[0];
  const late = ev(full, T0 + 21 * HOUR).history[0];

  ok(
    early.key === late.key &&
      early.direction === late.direction &&
      early.anchorStartPivotKey ===
        late.anchorStartPivotKey &&
      early.anchorEndPivotKey === late.anchorEndPivotKey &&
      early.low === late.low &&
      early.high === late.high &&
      early.eventTime.getTime() === late.eventTime.getTime() &&
      early.confirmedAt.getTime() ===
        late.confirmedAt.getTime() &&
      Math.abs(early.equilibrium - late.equilibrium) <= 1e-12 &&
      early.replacedAt === null,
    "38: историческая version не переписывается — immutable поля идентичны; replacedAt появляется только когда событие видно (asOf)"
  );

  const mid = ev(full, T0 + 16 * HOUR);

  ok(
    mid.history[0].replacedAt !== null &&
      mid.history[0].replacedAt.getTime() === T0 + 13 * HOUR &&
      mid.history[1].replacedAt === null,
    "38/15: replacedAt виден только после собственного confirmedAt (R1: null@9h → T0+13h@16h; R2: null@16h)"
  );
}

/* ---------- 40. mirror symmetry ---------- */

{
  const direct = ev(anchorFixture(), T0 + 21 * HOUR);
  const mirror = ev(
    anchorFixture().map(negCandle),
    T0 + 21 * HOUR
  );

  let symmetric =
    direct.history.length === mirror.history.length &&
    direct.current !== null &&
    mirror.current !== null;

  if (symmetric) {
    for (let i = 0; i < direct.history.length; i++) {
      const a = direct.history[i];
      const b = mirror.history[i];

      if (
        a.direction !==
          (b.direction === "up" ? "down" : "up") ||
        Math.abs(a.low + b.high) > 1e-9 ||
        Math.abs(a.high + b.low) > 1e-9 ||
        Math.abs(a.equilibrium + b.equilibrium) > 1e-9 ||
        a.eventTime.getTime() !== b.eventTime.getTime() ||
        a.confirmedAt.getTime() !== b.confirmedAt.getTime() ||
        (a.replacedAt === null) !== (b.replacedAt === null)
      ) {
        symmetric = false;
        break;
      }
    }

    const zoneA = direct.priceContext!.zone;
    const zoneB = mirror.priceContext!.zone;
    const zoneMirrored =
      zoneA === zoneB
        ? zoneA === "EQUILIBRIUM"
        : (zoneA === "DISCOUNT") === (zoneB === "PREMIUM");

    if (
      Math.abs(
        direct.priceContext!.price +
          mirror.priceContext!.price
      ) > 1e-9 ||
      Math.abs(
        direct.priceContext!.position +
          mirror.priceContext!.position -
          1
      ) > 1e-9 ||
      !zoneMirrored
    ) {
      symmetric = false;
    }
  }

  ok(
    symmetric,
    "40: mirror symmetry — direction зеркален, low/high/equilibrium инвертированы, времена равны, replacedAt nullity совпадает, position/zone равны"
  );
}

/* ---------- robustness: ранний asOf / priceContext null ---------- */

{
  const early = ev(anchorFixture(), T0 + 5 * HOUR);

  ok(
    early.history.length === 0 &&
      early.current === null &&
      early.priceContext === null,
    "robustness: до первого BOS — history [], current null, priceContext null"
  );

  const pending = ev(anchorFixture(), T0 + 18 * HOUR);

  ok(
    pending.current === null &&
      pending.priceContext === null &&
      pending.history.length === 2,
    "robustness: current null → priceContext null (Premium/Discount только для ACTIVE range)"
  );

  const second = ev(fixtureA(), T0 + 16 * HOUR);

  ok(
    second.history.length === 2 &&
      second.history[0].low === 101 &&
      second.history[0].high === 112 &&
      second.history[1].low === 113 &&
      second.history[1].high === 121 &&
      second.history[1].replacedAt !== null &&
      second.history[1].replacedAt.getTime() ===
        T0 + 15 * HOUR &&
      second.current === null,
    "robustness: вторая фикстура — bootstrap [101,112], continuation [113,121] (anchor low 113 подтверждён той же свечой), CHOCH закрывает в T0+15h"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
