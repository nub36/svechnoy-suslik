/**
 * SMC Phase 3A — интеграционные тесты unified evaluator
 * (запуск: npx tsx scripts/test-smc-evaluate.ts).
 *
 * evaluateSmc = каноническая композиция РЕАЛЬНЫХ проверенных
 * подмодулей на одном horizon + scoring. Ожидания сняты
 * dbg-прогонами тех же фикстур (не «из головы»).
 */

import {
  defaultSmcScoringConfig,
  SmcScoringConfig
} from "../lib/smc/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import { SmcRawCandle } from "../lib/smc/types";

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

/** Свеча с явным openTime (таймгэп-тест). */
function mkAt(
  openMs: number,
  o: number,
  c: number,
  high?: number,
  low?: number
): SmcRawCandle {
  return {
    openTime: new Date(openMs),
    open: o,
    high: high ?? Math.max(o, c),
    low: low ?? Math.min(o, c),
    close: c,
    closed: true
  };
}

function flat(i: number): SmcRawCandle {
  const b = i * 0.01;

  return mk(i, 86 + b, 87 + b, 90 + b, 84 + b);
}

function flats(from: number, to: number): SmcRawCandle[] {
  const out: SmcRawCandle[] = [];

  for (let i = from; i <= to; i++) {
    out.push(flat(i));
  }

  return out;
}

function neg(candle: SmcRawCandle): SmcRawCandle {
  return mk(
    (candle.openTime.getTime() - T0) / HOUR,
    -candle.open,
    -candle.close,
    -candle.low,
    -candle.high
  );
}

const negate = (list: SmcRawCandle[]) => list.map(neg);

function cfg(
  overrides: Partial<SmcScoringConfig> = {}
): SmcScoringConfig {
  return {
    ...defaultSmcScoringConfig("1h"),
    swingLeft: 1,
    swingRight: 1,
    internalLeft: 1,
    internalRight: 1,
    ...overrides
  };
}

function ev(
  raw: SmcRawCandle[],
  asOfMs: number,
  config: SmcScoringConfig = cfg()
) {
  return evaluateSmc(raw, config, new Date(asOfMs));
}

/** Жизненный цикл range: bootstrap → CHOCH → reversal. */
function anchorFixture(): SmcRawCandle[] {
  const flatM = (i: number): SmcRawCandle => {
    const b = i * 0.01;

    return mk(i, 86 + b, 87 + b, 90 + b, 84 + b);
  };

  return [
    flatM(0),
    flatM(1),
    flatM(2),
    mk(3, 87, 85.5, 87.5, 80),
    flatM(4),
    mk(5, 87, 88, 95, 86.5),
    flatM(6),
    mk(7, 95.5, 97, 97.5, 94),
    mk(8, 96, 92, 96.5, 90),
    mk(9, 92.09, 93.09, 95.09, 91.09),
    mk(10, 93, 94, 100, 92),
    mk(11, 93.11, 94.11, 96.11, 92.11),
    mk(12, 94, 101, 101.5, 93.5),
    mk(13, 100.5, 99, 103, 98.5),
    mk(14, 99, 96, 100.14, 93),
    mk(15, 96.15, 97, 105, 95.15),
    mk(16, 96, 85, 96.5, 84),
    mk(17, 85, 80.5, 85.5, 79),
    mk(18, 80.2, 81.18, 82.18, 80.1),
    mk(19, 81, 77.5, 81.5, 76.5),
    flatM(20)
  ];
}

/** Canonical OB fixture (swing 1/1): OB up [84, 90.14],
 * BOS up @17, FVG, range up [84, 108]. */
function canonical(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 105, 84.05),
    flat(6),
    mk(7, 86.07, 87.07, 90.07, 82),
    ...flats(8, 13),
    mk(14, 90, 86, 90.14, 84),
    mk(15, 91, 104, 108, 91),
    mk(16, 103, 101, 103.5, 95),
    mk(17, 107, 109, 109.5, 106.5),
    ...flats(18, 26)
  ];
}

/** Sweep-фикстура: close через уровень → BROKEN (не SWEPT). */
function sweepBrokenFixture(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 90.05, 82), // pivot low 82@5
    ...flats(6, 13),
    mk(14, 84.14, 80, 85.34, 79),   // close 80 < 82 → BROKEN
    mk(15, 90.15, 84.15, 90.15, 84.15),
    mk(16, 91, 104, 108, 91),
    mk(17, 103, 101, 103.5, 95),
    mk(18, 107, 109, 109.5, 106.5),
    ...flats(19, 23)
  ];
}

/** Reasons без payload-value (для сравнения с таймгэпами). */
function reasonSkeleton(evaluation: {
  reasons: { code: string; longPoints: number; shortPoints: number; maxPoints: number }[];
}): Array<{
  code: string;
  longPoints: number;
  shortPoints: number;
  maxPoints: number;
}> {
  return evaluation.reasons.map((reason) => ({
    code: reason.code,
    longPoints: reason.longPoints,
    shortPoints: reason.shortPoints,
    maxPoints: reason.maxPoints
  }));
}

/* ---------- 1/5. insufficient history ---------- */

{
  const r = ev(anchorFixture().slice(0, 7), T0 + 7 * HOUR);

  ok(
    r.availability.evaluable === false &&
      r.availability.hardFailures.length === 1 &&
      r.availability.hardFailures[0].code ===
        "INSUFFICIENT_HISTORY" &&
      r.direction === "CANNOT_EVALUATE" &&
      r.longScore === null &&
      r.shortScore === null &&
      r.reasons.length === 0,
    "1/5: недостаточно истории → CANNOT_EVALUATE, scores null, INSUFFICIENT_HISTORY (НЕ подделываются)"
  );
  ok(
    r.swingStructure === null &&
      r.displacements.length === 0 &&
      r.dealingRange === null,
    "1-доп: при INSUFFICIENT_HISTORY подмодули не вычисляются (structure null, коллекции пусты)"
  );
}

/* ---------- 2. ATR unavailable ---------- */

{
  const r = ev(anchorFixture(), T0 + 21 * HOUR, cfg({ atrPeriod: 30 }));

  ok(
    r.availability.evaluable === false &&
      r.availability.hardFailures.length === 1 &&
      r.availability.hardFailures[0].code === "ATR_UNAVAILABLE" &&
      r.longScore === null &&
      r.direction === "CANNOT_EVALUATE",
    "2: ATR недоступен на последней свече (period 30 > idx 20) → CANNOT_EVALUATE"
  );
  ok(
    r.swingStructure !== null &&
      r.swingStructure.phase === "TREND_DOWN",
    "2-доп: swing-структура при ATR-fail вычислена и отдана (диагностика)"
  );
}

/* ---------- 3/4. missing swing pivots ---------- */

{
  const decline: SmcRawCandle[] = [];

  for (let i = 0; i < 14; i++) {
    decline.push(mk(i, 100 - i, 99 - i, 100.5 - i, 98.5 - i));
  }

  const noHighs = ev(decline, T0 + 14 * HOUR);

  ok(
    noHighs.availability.evaluable === false &&
      noHighs.availability.hardFailures.some(
        (reason) => reason.code === "NO_SWING_HIGH"
      ) &&
      noHighs.direction === "CANNOT_EVALUATE",
    "3: строгая монотонная серия — нет swing-high → CANNOT_EVALUATE (NO_SWING_HIGH)"
  );

  const ascent: SmcRawCandle[] = [];

  for (let i = 0; i < 14; i++) {
    ascent.push(mk(i, 86 + i, 87 + i, 87.5 + i, 85.5 + i));
  }

  const noLows = ev(ascent, T0 + 14 * HOUR);

  ok(
    noLows.availability.evaluable === false &&
      noLows.availability.hardFailures.some(
        (reason) => reason.code === "NO_SWING_LOW"
      ),
    "4: строгий монотонный рост — нет swing-low → CANNOT_EVALUATE (NO_SWING_LOW); у монотонных серий window-1 экстремумов нет ни одного рода — оба кода честно фиксируются"
  );
}

/* ---------- 6. no active range — только soft ---------- */

{
  const r = ev(anchorFixture(), T0 + 17 * HOUR);

  ok(
    r.availability.evaluable === true &&
      r.availability.hardFailures.length === 0 &&
      r.availability.softUnavailable.some(
        (reason) =>
          reason.code === "NO_ACTIVE_DEALING_RANGE"
      ) === true &&
      r.direction !== "CANNOT_EVALUATE",
    "6: current range = null — ТОЛЬКО soft NO_ACTIVE_DEALING_RANGE, evaluation остаётся evaluable"
  );
  ok(
    r.longScore === 0 &&
      r.shortScore === 10 &&
      r.availability.softUnavailable.some(
        (reason) => reason.code === "STRUCTURE_TRANSITION"
      ),
    "6-доп: pending-фаза (0 swing bias) + свежий BUY_SIDE sweep → SHORT +10; диапазон не фейковый"
  );
}

/* ---------- 9/11/14/20/22/23/33. полный стек: LONG ---------- */

{
  const r = ev(canonical(), T0 + 18 * HOUR);
  const components = r.reasons.filter(
    (reason) => reason.code !== "DIRECTION_CONFLICT"
  );
  const sumLong = components.reduce(
    (sum, reason) => sum + reason.longPoints,
    0
  );

  ok(
    r.availability.evaluable === true &&
      r.availability.hardFailures.length === 0 &&
      r.availability.softUnavailable.length === 0,
    "full-stack @18h: evaluable, hard=[], soft=[] (все компоненты присутствуют)"
  );
  ok(
    r.longScore === 80 &&
      r.shortScore === 20 &&
      sumLong === r.longScore,
    "full-stack @18h: LONG=80 (20 фаза + 15 BOS + 10 internal + 15 swing OB + 5 internal OB + 10 FVG + 5 confluence), SHORT=20 (sweep+premium), reasons-sum инвариант"
  );
  ok(
    r.direction === "LONG" &&
      r.longScore! >= r.reasons.length * 0,
    "full-stack @18h: minimumScore 72 → LONG (80 >= 72 > 20)"
  );
  ok(
    r.swingOrderBlocks.length === 1 &&
      r.internalOrderBlocks.length === 1 &&
      r.swingOrderBlocks[0].state === "OPEN" &&
      r.dealingRange !== null &&
      r.dealingRange.current !== null,
    "full-stack @18h: OB swing+internal, range active — raw facts в output"
  );
}

/* ---------- 20-доп/21/24/29. MITIGATED OB, confluence исчезает ---------- */

{
  const r = ev(canonical(), T0 + 20 * HOUR);

  ok(
    r.longScore === 75 &&
      r.shortScore === 20 &&
      r.direction === "LONG",
    "@20h: LONG=75 — OB MITIGATED (ещё active, +15/+5), up-FVG INVALIDATED, свежий down-FVG забирает FVG в SHORT (+10), confluence 0, range DISCOUNT → LONG +10"
  );
  ok(
    r.swingOrderBlocks[0].state === "MITIGATED",
    "@20h: OB MITIGATED — active для scoring (state OPEN|MITIGATED)"
  );
}

/* ---------- 12/18. stale BOS / stale sweep / fresh OB ---------- */

{
  const extended = [
    ...canonical(),
    ...flats(27, 30)
  ];
  const r = ev(extended, T0 + 30 * HOUR);

  ok(
    r.reasons.find(
      (reason) => reason.code === "RECENT_SWING_BOS"
    )?.longPoints === 0 &&
      r.reasons.find((reason) => reason.code === "SWING_ORDER_BLOCK")
        ?.longPoints === 15 &&
      r.longScore === 60,
    "12/20: @30h — BOS stale (age 13 > 10 → 0), OB fresh (age 13 <= 20 → +15): freshness независима по компонентам"
  );
  ok(
    r.reasons.find((reason) => reason.code === "LIQUIDITY_SWEEP")
      ?.longPoints === 0 &&
      r.reasons.find((reason) => reason.code === "LIQUIDITY_SWEEP")
        ?.shortPoints === 0 &&
      r.availability.softUnavailable.some(
        (reason) => reason.code === "NO_RECENT_LIQUIDITY_SWEEP"
      ),
    "18: sweep stale (age 14 > 5) → 0 + soft NO_RECENT_LIQUIDITY_SWEEP"
  );

  const far = ev(
    [...canonical(), ...flats(27, 40)],
    T0 + 40 * HOUR
  );

  ok(
    far.reasons.find((reason) => reason.code === "SWING_ORDER_BLOCK")
      ?.longPoints === 0 &&
      far.reasons.find((reason) => reason.code === "FVG")
        ?.shortPoints === 10 &&
      far.reasons.find((reason) => reason.code === "RANGE_POSITION")
        ?.longPoints === 10,
    "20-доп: @40h — OB stale (age 22 > 20 → 0); FVG age ровно 20 = fresh (граница включительно); range context без freshness (+10)"
  );
}

/* ---------- 19. BROKEN liquidity ---------- */

{
  const r = ev(sweepBrokenFixture(), T0 + 22 * HOUR, cfg({ atrPeriod: 5 }));
  const sweep = r.reasons.find(
    (reason) => reason.code === "LIQUIDITY_SWEEP"
  );

  ok(
    sweep !== undefined &&
      sweep.longPoints === 0 &&
      sweep.shortPoints === 0 &&
      r.availability.softUnavailable.some(
        (reason) => reason.code === "NO_RECENT_LIQUIDITY_SWEEP"
      ),
    "19: BROKEN (close за уровнем) не даёт sweep points (BROKEN ≠ SWEPT)"
  );
}

/* ---------- 42. mirror symmetry (интеграция) ---------- */

{
  const direct = ev(canonical(), T0 + 20 * HOUR);
  const mirror = ev(negate(canonical()), T0 + 20 * HOUR);

  ok(
    direct.longScore === mirror.shortScore &&
      direct.shortScore === mirror.longScore &&
      direct.longScore === 75 &&
      direct.direction === "LONG" &&
      mirror.direction === "SHORT",
    "42: зеркало canonical — 75/20 ↔ 20/75, LONG ↔ SHORT"
  );

  const directSkeleton = reasonSkeleton(direct);
  const mirrorSkeleton = reasonSkeleton(mirror);
  let mirrored = directSkeleton.length === mirrorSkeleton.length;

  if (mirrored) {
    for (let i = 0; i < directSkeleton.length; i++) {
      if (
        directSkeleton[i].code !== mirrorSkeleton[i].code ||
        directSkeleton[i].longPoints !==
          mirrorSkeleton[i].shortPoints ||
        directSkeleton[i].shortPoints !==
          mirrorSkeleton[i].longPoints
      ) {
        mirrored = false;
      }
    }
  }

  ok(
    mirrored,
    "42: reasons зеркальны попарно по компонентам"
  );
}

/* ---------- 34/35/36. direction resolution ---------- */

{
  ok(
    ev(
      negate(canonical()),
      T0 + 18 * HOUR,
      cfg({ minimumScore: 75 })
    ).direction === "SHORT",
    "34: mirror @18h, threshold 75 → SHORT (short 80 >= 75 > long 20)"
  );
  ok(
    ev(canonical(), T0 + 18 * HOUR, cfg({ minimumScore: 90 }))
      .direction === "NEUTRAL",
    "35: threshold 90 (обе стороны ниже) → NEUTRAL"
  );
  ok(
    ev(canonical(), T0 + 18 * HOUR, cfg({ minimumScore: 10 }))
      .direction === "NEUTRAL" &&
      ev(canonical(), T0 + 18 * HOUR, cfg({ minimumScore: 10 }))
        .reasons.some(
          (reason) => reason.code === "DIRECTION_CONFLICT"
        ),
    "36: threshold 10 (обе стороны выше) → NEUTRAL + DIRECTION_CONFLICT"
  );
}

/* ---------- 38. future injection ---------- */

{
  const full = [...canonical(), ...flats(27, 40)];
  let identical = true;

  for (const asOfHour of [18, 20, 30, 40]) {
    const onFull = ev(full, T0 + asOfHour * HOUR);
    const onPrefix = ev(
      full.slice(0, asOfHour + 1),
      T0 + asOfHour * HOUR
    );

    if (JSON.stringify(onFull) !== JSON.stringify(onPrefix)) {
      identical = false;
    }
  }

  ok(
    identical,
    "38: future injection — evaluateSmc(full, T) ≡ evaluateSmc(prefix, T) serialized (facts+scores+reasons+availability) на 4 границах"
  );

  const anchorFull = anchorFixture();
  let anchorIdentical = true;

  for (const asOfHour of [9, 12, 17, 21]) {
    const onFull = ev(anchorFull, T0 + asOfHour * HOUR);
    const onPrefix = ev(
      anchorFull.slice(0, asOfHour + 1),
      T0 + asOfHour * HOUR
    );

    if (
      JSON.stringify(onFull) !== JSON.stringify(onPrefix)
    ) {
      anchorIdentical = false;
    }
  }

  ok(
    anchorIdentical,
    "38-доп: future injection на anchorFixture (CHOCH/reversal границы)"
  );
}

/* ---------- 39. historical no-rewrite ---------- */

{
  const full = [...canonical(), ...flats(27, 40)];
  const earlyOnFull = ev(full, T0 + 18 * HOUR);
  const earlyOnPrefix = ev(
    full.slice(0, 19),
    T0 + 18 * HOUR
  );
  const late = ev(full, T0 + 40 * HOUR);

  ok(
    JSON.stringify(earlyOnFull) ===
      JSON.stringify(earlyOnPrefix) &&
      earlyOnFull.longScore === 80 &&
      late.longScore === 40,
    "39: historical score no-rewrite — оценка @18h идентична на full и prefix; более поздняя — другая (40), но раннюю не переписывает"
  );
}

/* ---------- 40. timestamp gap freshness (интеграция) ---------- */

{
  const gapHours = 500;

  const gapped = canonical().map((candle) => {
    const index =
      (candle.openTime.getTime() - T0) / HOUR;

    if (index >= 18) {
      return mkAt(
        T0 + (index + gapHours) * HOUR,
        candle.open,
        candle.close,
        candle.high,
        candle.low
      );
    }

    return candle;
  });
  const regular = ev(canonical(), T0 + 20 * HOUR);
  const gappedEval = ev(
    gapped,
    T0 + (20 + gapHours) * HOUR
  );

  ok(
    gappedEval.longScore === regular.longScore &&
      gappedEval.shortScore === regular.shortScore &&
      gappedEval.direction === regular.direction &&
      JSON.stringify(reasonSkeleton(gappedEval)) ===
        JSON.stringify(reasonSkeleton(regular)),
    "40: таймгэп 500h между свечами 17/18 — scores/direction/reasons идентичны (freshness = CLOSED-индексы, НЕ wall-clock)"
  );
}

/* ---------- 41. детерминированная сериализация ---------- */

{
  const run1 = ev(canonical(), T0 + 18 * HOUR);
  const run2 = ev(canonical(), T0 + 18 * HOUR);

  ok(
    JSON.stringify(run1) === JSON.stringify(run2),
    "41: два запуска evaluateSmc — байт-в-байт"
  );
}

/* ---------- 31/32. reasons-sum инвариант по сетке asOf ---------- */

{
  const full = [...canonical(), ...flats(27, 40)];
  let allHold = true;

  // С h=15: ATR14 доступен (индекс 14) — все точки evaluable
  // (раньше честный CANNOT_EVALUATE с пустыми reasons).
  for (let h = 15; h <= 40; h++) {
    const r = ev(full, T0 + h * HOUR);
    const components = r.reasons.filter(
      (reason) => reason.code !== "DIRECTION_CONFLICT"
    );

    if (
      components.length !== 9 ||
      components.reduce(
        (sum, reason) => sum + reason.longPoints,
        0
      ) !== r.longScore ||
      components.reduce(
        (sum, reason) => sum + reason.shortPoints,
        0
      ) !== r.shortScore ||
      (r.longScore !== null &&
        (r.longScore < 0 || r.longScore > 100)) ||
      (r.shortScore !== null &&
        (r.shortScore < 0 || r.shortScore > 100))
    ) {
      allHold = false;
    }
  }

  ok(
    allHold,
    "31/32: инвариант суммы reasons и bounded 0..100 на сетке asOf 15..40h"
  );
  ok(
    ev(full, T0 + 14 * HOUR).direction === "CANNOT_EVALUATE" &&
      ev(full, T0 + 14 * HOUR).reasons.length === 0 &&
      ev(full, T0 + 15 * HOUR).availability.evaluable === true,
    "31/32-доп: граница ATR14 — asOf 14h CANNOT_EVALUATE (пустые reasons), 15h evaluable"
  );
}

/* ---------- единый atrPeriod/окна сквозь sub-configs ---------- */

{
  const r = ev(canonical(), T0 + 18 * HOUR);

  ok(
    r.displacements.every(
      (disp) => disp.key.startsWith("SMC1|D|1h|")
    ) &&
      r.fvgs.every((fvg) => fvg.tf === "1h") &&
      r.liquidity.every((level) => level.tf === "1h") &&
      r.internalOrderBlocks.every((ob) => ob.layer === "internal") &&
      r.swingOrderBlocks.every((ob) => ob.layer === "swing") &&
      r.dealingRange !== null &&
      r.dealingRange.history.every((range) => range.tf === "1h"),
    "config: sub-configs композиционно из одного scoring-config (tf/atrPeriod/окна едины, слои OB не смешиваются)"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
