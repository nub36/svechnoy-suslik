/**
 * SMC Phase 2A — тесты FVG: геометрия, ATR-фильтр, lifecycle,
 * expiry, identity, anti-lookahead
 * (запуск: npx tsx scripts/test-smc-fvg.ts).
 *
 * Fixture: плоский прогрев TR=6 → ATR=6 точно; gap 0.625 →
 * sizeAtr = 0.625/6 ≈ 0.1042 (>= 0.10 — принято); gap 0.55 →
 * 0.0917 (отклонён). Зона [103, 103.625], ce = 103.3125.
 * Зеркало — точная инверсия (негатив) значений.
 */

import {
  defaultFvgConfig,
  evaluateFvgs,
  SmcFvg,
  SmcFvgConfig
} from "../lib/smc/fvg";
import { SmcRawCandle, SmcTimeframe } from "../lib/smc/types";

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

function flat(i: number): SmcRawCandle {
  return mk(i, 102, 103, 106, 100);
}

function warmup(count: number): SmcRawCandle[] {
  return Array.from({ length: count }, (_, i) => flat(i));
}

/** a=15 (l97 h103), b=16 (impulse), c=17 с настраиваемым low. */
function fvgBase(
  cLow: number,
  cHigh: number = cLow + 6
): SmcRawCandle[] {
  return [
    ...warmup(15),
    mk(15, 101, 102, 103, 97),
    mk(16, 102, 104, 105, 99),
    mk(17, 104.5, 106, cHigh, cLow)
  ];
}

/** Точная инверсия (негатив): high/low меняются местами. */
function neg(candle: SmcRawCandle): SmcRawCandle {
  return mk(
    (candle.openTime.getTime() - T0) / HOUR,
    -candle.open,
    -candle.close,
    -candle.low,
    -candle.high
  );
}

const CFG: SmcFvgConfig = {
  ...defaultFvgConfig("1h" as SmcTimeframe)
};

const CONFIRMED_AT = T0 + 18 * HOUR; // effClose(17)
const KEY = `SMC1|FVG|1h|up|${T0 + 16 * HOUR}`;

/** Основной bullish fixture с lifecycle-свечами d1..d5. */
function mainFixture(): SmcRawCandle[] {
  return [
    ...fvgBase(103.625),
    mk(18, 105, 106, 106.5, 103.625), // low = top ровно
    mk(19, 105, 106, 106.5, 103.5),   // first touch
    mk(20, 105, 106, 106.5, 103.3125),// CE ровно (inclusive)
    mk(21, 105, 103.4, 105.5, 102.5), // full wick, close выше
    mk(22, 103.2, 102.9, 103.4, 102.4)// close < bottom
  ];
}

function single(
  raw: SmcRawCandle[],
  asOfMs: number,
  config: SmcFvgConfig = CFG
): SmcFvg | null {
  const list = evaluateFvgs(raw, config, new Date(asOfMs));

  return list.length === 1 ? list[0] : null;
}

/* ---------- 14. bullish raw geometry ---------- */

{
  const fvg = single(fvgBase(103.625), CONFIRMED_AT);

  ok(
    fvg !== null &&
      fvg.direction === "up" &&
      fvg.bottom === 103 &&
      fvg.top === 103.625 &&
      Math.abs(fvg.ce - 103.3125) <= 1e-9 &&
      fvg.gapSize === 0.625,
    "14: bullish FVG — зона [a.high, c.low], ce = (bottom+top)/2"
  );
  ok(
    fvg !== null &&
      fvg.eventTime.getTime() === T0 + 16 * HOUR &&
      fvg.confirmedAt.getTime() === CONFIRMED_AT,
    "14/21: eventTime = b.openTime, confirmedAt = effectiveCloseTime(c)"
  );
  closeTo(fvg!.sizeAtr, 0.625 / 6, "14: sizeAtr = gap/ATR[c]");
}

/* ---------- 15. bearish raw geometry ---------- */

{
  const fvg = single(
    fvgBase(103.625).map(neg),
    CONFIRMED_AT
  );

  ok(
    fvg !== null &&
      fvg.direction === "down" &&
      fvg.bottom === -103.625 &&
      fvg.top === -103 &&
      Math.abs(fvg.ce - -103.3125) <= 1e-9,
    "15: bearish FVG — зона [c.high, a.low] (зеркало)"
  );
}

/* ---------- 16. wick overlap → нет ---------- */

{
  ok(
    single(fvgBase(102.9, 108.9), CONFIRMED_AT) === null,
    "16: c.low перекрывает a.high → raw bullish FVG нет"
  );
}

/* ---------- 17. boundary equality → нет ---------- */

{
  ok(
    single(fvgBase(103.0, 109.0), CONFIRMED_AT) === null,
    "17: c.low === a.high (строгое >) → НЕ bullish FVG"
  );
}

/* ---------- 18/19. ATR filter accept/reject ---------- */

{
  ok(
    single(fvgBase(103.625), CONFIRMED_AT) !== null,
    "18: gap 0.625, sizeAtr 0.1042 >= 0.10 → принят"
  );
  ok(
    single(fvgBase(103.55, 109.55), CONFIRMED_AT) === null,
    "19: gap 0.55, sizeAtr 0.0917 < 0.10 → отклонён"
  );
}

/* ---------- 20. ATR unavailable → не принят ---------- */

{
  const early = [
    ...warmup(10),
    mk(10, 101, 102, 103, 97),
    mk(11, 102, 104, 105, 99),
    // Большой gap, но ATR[12] = null (i < period).
    mk(12, 104.5, 106, 112, 103.625)
  ];

  ok(
    single(early, T0 + 13 * HOUR) === null,
    "20: ATR[c] unavailable → кандидат not-evaluable, raw gap без фильтра не принимается"
  );
}

/* ---------- 22/23. asOf граница confirmedAt ---------- */

{
  ok(
    single(fvgBase(103.625), CONFIRMED_AT - 1) === null,
    "22: asOf = confirmedAt - 1ms → FVG отсутствует"
  );
  ok(
    single(fvgBase(103.625), CONFIRMED_AT) !== null,
    "23: asOf = confirmedAt → FVG присутствует"
  );
}

/* ---------- 24/25/26/27. creation candle, touch, fill, CE ---------- */

{
  const d1AsOf = T0 + 19 * HOUR;

  const before = single(mainFixture(), d1AsOf);

  ok(
    before !== null &&
      before.state === "OPEN" &&
      before.firstTouchedAt === null &&
      before.fillFraction === 0,
    "24: creation candle не митигирует себя; d1 с low === top при строгой политике не считается touch"
  );

  const touched = single(mainFixture(), T0 + 20 * HOUR);

  ok(
    touched !== null &&
      touched.state === "TOUCHED" &&
      touched.firstTouchedAt !== null &&
      touched.firstTouchedAt.getTime() === T0 + 20 * HOUR &&
      touched.firstTouchedAt.getTime() > CONFIRMED_AT,
    "25: bullish first touch — первая последующая свеча с low < top (строго)"
  );
  closeTo(
    touched!.fillFraction,
    0.125 / 0.625,
    "26: fillFraction = проникновение/gap (0.2 после первого touch)"
  );

  const ce = single(mainFixture(), T0 + 21 * HOUR);

  ok(
    ce !== null &&
      ce.state === "CE_MITIGATED" &&
      ce.ceTouchedAt !== null &&
      ce.ceTouchedAt.getTime() === T0 + 21 * HOUR,
    "27: CE touch — включительная граница low <= ce (d3 low = ce ровно)"
  );
  closeTo(ce!.fillFraction, 0.5, "27: fillFraction = 0.5 после CE");
}

/* ---------- 28. full wick fill БЕЗ close invalidation ---------- */

{
  const fvg = single(mainFixture(), T0 + 22 * HOUR);

  ok(
    fvg !== null &&
      fvg.fullFilledByExcursionAt !== null &&
      fvg.fullFilledByExcursionAt.getTime() ===
        T0 + 22 * HOUR &&
      fvg.invalidatedByCloseAt === null &&
      fvg.state === "FILLED_BY_EXCURSION",
    "28: wick ниже bottom + close обратно выше → fullFilledByExcursionAt установлен, invalidatedByCloseAt = null (РАЗНЫЕ события)"
  );
  ok(
    fvg !== null && fvg.fillFraction === 1,
    "28: fillFraction = 1 (clamp [0,1])"
  );
}

/* ---------- 29. bullish close invalidation ---------- */

{
  const fvg = single(mainFixture(), T0 + 23 * HOUR);

  ok(
    fvg !== null &&
      fvg.invalidatedByCloseAt !== null &&
      fvg.invalidatedByCloseAt.getTime() === T0 + 23 * HOUR &&
      fvg.state === "INVALIDATED",
    "29: close < bottom (строго) → invalidatedByCloseAt, state INVALIDATED"
  );
}

/* ---------- 30. bearish lifecycle mirror ---------- */

{
  const bearishAsOf = (hour: number) =>
    single(mainFixture().map(neg), T0 + hour * HOUR);

  const touched = bearishAsOf(20);

  ok(
    touched !== null &&
      touched.direction === "down" &&
      touched.state === "TOUCHED" &&
      touched.firstTouchedAt !== null &&
      touched.firstTouchedAt.getTime() === T0 + 20 * HOUR,
    "30: bearish touch — первая свеча с high > bottom (строго), зеркало"
  );

  const ce = bearishAsOf(21);

  ok(
    ce !== null &&
      ce.ceTouchedAt !== null &&
      ce.ceTouchedAt.getTime() === T0 + 21 * HOUR,
    "30: bearish CE — включительная high >= ce"
  );

  const full = bearishAsOf(22);

  ok(
    full !== null &&
      full.fullFilledByExcursionAt !== null &&
      full.invalidatedByCloseAt === null &&
      full.state === "FILLED_BY_EXCURSION",
    "30: bearish full fill (high >= top) без close invalidation"
  );

  const invalidated = bearishAsOf(23);

  ok(
    invalidated !== null &&
      invalidated.invalidatedByCloseAt !== null &&
      invalidated.state === "INVALIDATED",
    "30: bearish close invalidation — close > top (строго)"
  );
}

/* ---------- 31. expiry по числу последующих CLOSED свеч ---------- */

{
  const aged = [
    ...fvgBase(103.625),
    mk(18, 105, 106, 106.5, 104),
    mk(19, 105, 105.5, 106, 104.2),
    mk(20, 105, 105.4, 106, 104.1)
  ];

  const cfg3: SmcFvgConfig = { ...CFG, maxAgeCandles: 3 };

  const before = single(aged, T0 + 20 * HOUR, cfg3);

  ok(
    before !== null &&
      before.state === "OPEN" &&
      before.expiredAt === null,
    "31: 2 последующие свечи < maxAge 3 → expiry ещё не наступил"
  );

  const expired = single(aged, T0 + 21 * HOUR, cfg3);

  ok(
    expired !== null &&
      expired.state === "EXPIRED" &&
      expired.expiredAt !== null &&
      expired.expiredAt.getTime() === T0 + 21 * HOUR,
    "31: 3 последующие CLOSED свечи = maxAge → EXPIRED, expiredAt = effClose 3-й свечи"
  );
  ok(
    expired !== null &&
      expired.key === KEY &&
      expired.eventTime.getTime() === T0 + 16 * HOUR &&
      expired.confirmedAt.getTime() === CONFIRMED_AT,
    "31: expiry не переписывает eventTime/confirmedAt/key"
  );

  // Приоритет: close-invalidation до границы сильнее expiry.
  const invalidated = [
    ...fvgBase(103.625),
    mk(18, 105, 106, 106.5, 104),
    mk(19, 105, 105.5, 106, 104.2),
    mk(20, 104, 102.9, 104.2, 102.4)
  ];

  const prio = single(invalidated, T0 + 21 * HOUR, cfg3);

  ok(
    prio !== null &&
      prio.state === "INVALIDATED" &&
      prio.expiredAt === null,
    "31: INVALIDATED имеет приоритет над EXPIRED (expiry не выставляется)"
  );
}

/* ---------- 32. identity stable through lifecycle ---------- */

{
  const at20 = single(mainFixture(), T0 + 20 * HOUR);
  const at22 = single(mainFixture(), T0 + 22 * HOUR);
  const at23 = single(mainFixture(), T0 + 23 * HOUR);

  ok(
    at20 !== null &&
      at22 !== null &&
      at23 !== null &&
      at20.key === at22.key &&
      at22.key === at23.key &&
      at20.key === KEY,
    "32: key стабилен через весь lifecycle (OPEN→TOUCHED→FILLED→INVALIDATED)"
  );
}

/* ---------- 33. future injection invariance ---------- */

{
  const full = mainFixture();

  for (const asOfHour of [20, 22]) {
    const onFull = evaluateFvgs(
      full,
      CFG,
      new Date(T0 + asOfHour * HOUR)
    );
    // Хвост массива заведомо длиннее горизонта: лишние
    // будущие свечи обязан отсечь canonical horizon.
    const onPrefix = evaluateFvgs(
      full.slice(0, asOfHour + 2),
      CFG,
      new Date(T0 + asOfHour * HOUR)
    );

    ok(
      JSON.stringify(onFull) === JSON.stringify(onPrefix),
      `33: future injection инвариантен при asOf +${asOfHour}h (serialized canonical output)`
    );
  }
}

/* ---------- 34. serialized no-rewrite at historical asOf ---------- */

{
  const at21 = single(mainFixture(), T0 + 21 * HOUR)!;
  const at23 = single(mainFixture(), T0 + 23 * HOUR)!;

  ok(
    at21.key === at23.key &&
      at21.bottom === at23.bottom &&
      at21.top === at23.top &&
      at21.ce === at23.ce &&
      at21.eventTime.getTime() === at23.eventTime.getTime() &&
      at21.confirmedAt.getTime() ===
        at23.confirmedAt.getTime() &&
      at21.firstTouchedAt?.getTime() ===
        at23.firstTouchedAt?.getTime() &&
      at21.ceTouchedAt?.getTime() ===
        at23.ceTouchedAt?.getTime() &&
      at21.fullFilledByExcursionAt === null &&
      at23.fullFilledByExcursionAt !== null,
    "34: исторический snapshot не переписывается — новые timestamps только добавляются"
  );
}

/* ---------- FIX: bearish fillFraction (зеркальный аккумулятор) ---------- */

/* Regression VPS review: bearish-аккумулятор должен
 * отслеживать MAX high после confirmation (не MIN), иначе
 * fillFraction считается от наименее проникшей свечи.
 * Fixture — точное зеркало bullish mainFixture(). */
{
  const bearishAt = (hour: number) =>
    single(mainFixture().map(neg), T0 + hour * HOUR)!;

  closeTo(
    bearishAt(20).fillFraction,
    0.2,
    "FIX: bearish first partial touch — fillFraction = 0.2"
  );
  closeTo(
    bearishAt(21).fillFraction,
    0.5,
    "FIX: bearish CE touch — fillFraction = 0.5"
  );
  closeTo(
    bearishAt(22).fillFraction,
    1,
    "FIX: bearish full excursion — fillFraction = 1"
  );

  // Несколько bearish post-confirmation свечей: 0.2 → 0.5 →
  // 0.3 (мельче): fillFraction остаётся MAX = 0.5.
  const seq = [
    ...fvgBase(103.625).map(neg),
    neg(mk(18, 105, 106, 106.5, 103.5)),    // 0.2
    neg(mk(19, 105, 106, 106.5, 103.3125)), // 0.5 (CE)
    neg(mk(20, 105, 106, 106.5, 103.4375))  // 0.3 (мельче)
  ];

  const retained = single(seq, T0 + 21 * HOUR)!;

  closeTo(
    retained.fillFraction,
    0.5,
    "FIX: fillFraction = MAX, не откатывается (0.2 → 0.5 → 0.3 → 0.5)"
  );
  ok(
    retained.state === "CE_MITIGATED" &&
      retained.fullFilledByExcursionAt === null &&
      retained.invalidatedByCloseAt === null,
    "FIX: ретеншн не порождает ложных full-fill/invalidation"
  );

  /* SYMMETRY: для геометрически зеркальных
   * bullish/bearish fixtures на одинаковом asOf
   * fillFraction совпадают с tolerance 1e-9. */
  let symmetric = true;

  for (const hour of [20, 21, 22, 23]) {
    const bull = single(mainFixture(), T0 + hour * HOUR)!;
    const bear = single(mainFixture().map(neg), T0 + hour * HOUR)!;

    if (
      Math.abs(bull.fillFraction - bear.fillFraction) >
      1e-9
    ) {
      symmetric = false;
    }
  }

  ok(
    symmetric,
    "FIX: symmetry — bullish.fillFraction === bearish.fillFraction на зеркальных fixtures (+20h/+21h/+22h/+23h)"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
