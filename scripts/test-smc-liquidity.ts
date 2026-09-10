/**
 * SMC Phase 2B — тесты liquidity layer
 * (запуск: npx tsx scripts/test-smc-liquidity.ts).
 *
 * Фикстуры: quiet-свечи со СТРОГО монотонными high/low
 * (base = i*0.01, TR ровно 6) — паразитных пивотов нет;
 * pivot-свечи с явными big-range high/low. Окна swing = 1/1
 * для верифицируемости — ТОТ ЖЕ findPivots Phase 1 (окно —
 * конфиг; default-конфиг использует SWING_PIVOT_WINDOW=20).
 * ATR доступен с индекса 14 → EQ-пивоты с индекса 16.
 *
 * Точный порог sweep: fixed-point H = L + 0.05*(13*v + (H−low))/14
 * (v = ATR предыдущей свечи, TR sweep-свечи = H − low), тесты
 * берут H*(1 ± 1e-12) — численно ТОЧНО на границе (|diff| <= 1e-9)
 * с детерминированным float-запасом.
 *
 * Frozen-price policy (документировано в liquidity.ts): цена
 * EQ-уровня фиксируется в момент создания (max/min creation
 * sources); позднейшие joins добавляют только provenance в
 * sourcePivotKeys и НЕ двигают actionable price/identity.
 */

import {
  defaultLiquidityConfig,
  evaluateLiquidity,
  SmcLiquidityConfig
} from "../lib/smc/liquidity";
import { computeAtrSeries } from "../lib/smc/volatility";
import {
  assertValidAsOf,
  horizonCandles,
  validateAndPrepare
} from "../lib/smc/validate";
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

/** Quiet-свеча: TR = 6 ровно, high/low строго растут с i
 * (паразитные pivot high/low невозможны). */
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

/** Pivot-high свеча: big range вверх, low продолжает
 * монотонный ряд (соседи-quiet ниже по high). */
function pivotHigh(i: number, h: number): SmcRawCandle {
  const b = i * 0.01;

  return mk(i, 88 + b, 87 + b, h, 84 + b);
}

/** Разделительная quiet-свеча с пониженным high (TR = 4). */
function dip(i: number): SmcRawCandle {
  const b = i * 0.01;

  return mk(i, 87 + b, 87 + b, 89 + b, 85 + b);
}

/** Точная инверсия (негатив) — зеркало fixture. */
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

const CFG: SmcLiquidityConfig = {
  ...defaultLiquidityConfig("1h" as SmcTimeframe),
  swingLeft: 1,
  swingRight: 1
};

/** ATR на индексе (по подготовленному массиву). */
function atrAt(raw: SmcRawCandle[], index: number): number {
  const series = computeAtrSeries(
    validateAndPrepare(raw, "1h"),
    14
  );
  const value = series[index];

  if (value === null || value === undefined) {
    throw new Error(`ATR[${index}] unavailable в фикстуре`);
  }

  return value;
}

/** Fixed-point extreme для exact-threshold тестов
 * (level — цена уровня, low — low свечи при BUY-side sweep). */
function exactThresholdHigh(
  vPrev: number,
  level: number,
  low: number
): number {
  return (
    (level + (0.05 * (13 * vPrev - low)) / 14) /
    (1 - 0.05 / 14)
  );
}

/** Fixture A: structural BUY_SIDE level 110 (pivot i5,
 * confirmed effClose(6) = T0+7h). */
function fixtureA(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    pivotHigh(5, 110),
    ...flats(6, 14)
  ];
}

/** Fixture B: EQH — p1 110 @i16, p2 110.4 @i20; confirm i22, i23;
 * createdAt = effClose(23) = T0+24h. */
function fixtureB(
  p2High = 110.4,
  confirmCandles?: SmcRawCandle[]
): SmcRawCandle[] {
  return [
    ...flats(0, 15),
    pivotHigh(16, 110),
    dip(17),
    ...flats(18, 19),
    pivotHigh(20, p2High),
    dip(21),
    ...(confirmCandles ?? [flat(22), flat(23)]),
    ...flats(24, 26)
  ];
}

function levels(
  raw: SmcRawCandle[],
  asOfMs: number,
  config: SmcLiquidityConfig = CFG
) {
  return evaluateLiquidity(raw, config, new Date(asOfMs));
}

const structural = (
  list: ReturnType<typeof levels>,
  side: string,
  price: number
) =>
  list.filter(
    (level) =>
      level.origin === "STRUCTURAL" &&
      level.side === side &&
      level.price === price
  );

const eq = (list: ReturnType<typeof levels>) =>
  list.filter((level) => level.origin === "EQH_EQL");

/* ---------- 1. structural BUY_SIDE ---------- */

{
  const list = levels(fixtureA(), T0 + 8 * HOUR);
  const buy = structural(list, "BUY_SIDE", 110);

  ok(
    buy.length === 1 &&
      buy[0].key ===
        `SMC1|LQ|1h|BUY_SIDE|STRUCTURAL|${T0 + 5 * HOUR}` &&
      buy[0].eventTime.getTime() === T0 + 5 * HOUR &&
      buy[0].createdAt.getTime() === T0 + 7 * HOUR &&
      buy[0].state === "OPEN" &&
      buy[0].sourcePivotKeys.length === 1,
    "1: structural BUY_SIDE от confirmed swing-high; eventTime = anchor, createdAt = confirmedAt"
  );
}

/* ---------- 2. structural SELL_SIDE (зеркало) ---------- */

{
  const list = levels(negate(fixtureA()), T0 + 8 * HOUR);
  const sell = structural(list, "SELL_SIDE", -110);

  ok(
    sell.length === 1 &&
      sell[0].createdAt.getTime() === T0 + 7 * HOUR &&
      sell[0].state === "OPEN",
    "2: structural SELL_SIDE от confirmed swing-low (зеркало)"
  );
}

/* ---------- 3. до pivot.confirmedAt уровня нет ---------- */

{
  const list = levels(fixtureA(), T0 + 7 * HOUR - 1);

  ok(
    structural(list, "BUY_SIDE", 110).length === 0,
    "3: asOf < pivot.confirmedAt → structural level отсутствует (исторический eventTime не даёт известности)"
  );
}

/* ---------- 4. plateau = один structural level ---------- */

{
  const raw = [
    ...flats(0, 4),
    pivotHigh(5, 110),
    pivotHigh(6, 110),
    ...flats(7, 18)
  ];

  const list = levels(raw, T0 + 19 * HOUR);

  ok(
    structural(list, "BUY_SIDE", 110).length === 1,
    "4: plateau из двух равных high → РОВНО один structural level"
  );
}

/* ---------- 5. EQH в пределах 0.10 ATR принят ---------- */

{
  const raw = fixtureB();
  const list = levels(raw, T0 + 25 * HOUR);
  const eqLevels = eq(list);
  const toleranceDistance = 0.1 * atrAt(raw, 21);

  ok(
    eqLevels.length === 1 &&
      eqLevels[0].side === "BUY_SIDE" &&
      eqLevels[0].price === 110.4 &&
      eqLevels[0].sourcePivotKeys.length === 2,
    "5: EQH принят (p1 110, p2 110.4), price = max creation highs"
  );
  ok(
    0.4 <= toleranceDistance,
    "5: numerical |p2−p1| = 0.4 <= eqToleranceAtr * ATR[p2 boundary]"
  );
}

/* ---------- 6. EQH вне tolerance отклонён ---------- */

{
  ok(
    eq(levels(fixtureB(110.9), T0 + 25 * HOUR)).length === 0,
    "6: |110.9−110| = 0.9 > 0.1*ATR → EQH не создан"
  );
}

/* ---------- 7. EQL зеркало ---------- */

{
  const list = levels(negate(fixtureB()), T0 + 25 * HOUR);
  const eqLevels = eq(list);

  ok(
    eqLevels.length === 1 &&
      eqLevels[0].side === "SELL_SIDE" &&
      eqLevels[0].price === -110.4,
    "7: EQL зеркало — price = min creation lows (−110.4)"
  );
}

/* ---------- 8. ATR unavailable → EQ candidate absent ---------- */

{
  const raw = [
    ...flats(0, 4),
    pivotHigh(5, 110),
    ...flats(6, 9),
    pivotHigh(10, 110.2),
    dip(11)
  ];

  const list = levels(raw, T0 + 12 * HOUR);

  ok(
    eq(list).length === 0 &&
      structural(list, "BUY_SIDE", 110).length === 1,
    "8: ATR на boundary p2 unavailable → EQ pair не создаётся (structural при этом существует)"
  );
}

/* ---------- 9. nearest pairing deterministic ---------- */

{
  const raw = [
    ...flats(0, 15),
    pivotHigh(16, 100),
    dip(17),
    ...flats(18, 20),
    pivotHigh(21, 105),
    dip(22),
    ...flats(23, 25),
    pivotHigh(26, 100.3),
    dip(27),
    flat(28),
    flat(29)
  ];

  const list = levels(raw, T0 + 30 * HOUR);
  const eqLevels = eq(list).filter(
    (level) => level.side === "BUY_SIDE"
  );
  const keyAt = (anchorHour: number) =>
    `SMC1|P|1h|swing|high|${T0 + anchorHour * HOUR}`;

  ok(
    eqLevels.length === 1 &&
      JSON.stringify(eqLevels[0].sourcePivotKeys) ===
        JSON.stringify([keyAt(16), keyAt(26)]) &&
      eqLevels[0].price === 100.3,
    "9: nearest-first pairing: p3 (100.3) паруется с p1 (100); p2 (105) отвергнут по tolerance и не в кластере"
  );
}

/* ---------- 10. кластер без дубликатов ---------- */

{
  const raw = [
    ...flats(0, 15),
    pivotHigh(16, 110),
    dip(17),
    flat(18),
    flat(19),
    flat(20),
    pivotHigh(21, 110.1),
    dip(22),
    flat(23),
    flat(24),
    flat(25),
    pivotHigh(26, 110.2),
    dip(27),
    flat(28),
    flat(29),
    flat(30),
    pivotHigh(31, 110.15),
    dip(32),
    flat(33),
    flat(34),
    flat(35),
    pivotHigh(36, 110.05),
    dip(37),
    flat(38)
  ];

  const list = levels(raw, T0 + 39 * HOUR);
  const eqLevels = eq(list).filter(
    (level) => level.side === "BUY_SIDE"
  );
  const keyAt = (anchorHour: number) =>
    `SMC1|P|1h|swing|high|${T0 + anchorHour * HOUR}`;

  ok(
    eqLevels.length === 1 &&
      eqLevels[0].price === 110.1 &&
      eqLevels[0].sourcePivotKeys.length === 5 &&
      eqLevels[0].sourcePivotKeys[0] === keyAt(16) &&
      eqLevels[0].sourcePivotKeys[4] === keyAt(36),
    "10: пять равных пивотов → ОДИН EQ-кластер, 5 sources; price = max creation sources (frozen), joins — provenance"
  );
}

/* ---------- 11. EQ price = max/min (numerical) ---------- */

{
  const bull = eq(levels(fixtureB(110.4), T0 + 25 * HOUR));
  const bear = eq(levels(negate(fixtureB()), T0 + 25 * HOUR));

  ok(
    bull[0] !== undefined &&
      bull[0].price === Math.max(110, 110.4) &&
      bear[0] !== undefined &&
      bear[0].price === Math.min(-110, -110.4),
    "11: EQH = max(source highs), EQL = min(source lows) — консервативная внешняя граница"
  );
}

/* ---------- 12/13. eqConfirmBars boundary ---------- */

{
  ok(
    eq(levels(fixtureB(), T0 + 23 * HOUR)).length === 0,
    "12: закрыта только первая confirmation свеча → EQ отсутствует"
  );

  const created = eq(levels(fixtureB(), T0 + 24 * HOUR));
  const createdAt = created[0]?.createdAt.getTime();

  ok(
    created.length === 1 && createdAt === T0 + 24 * HOUR,
    "13: exact boundary — вторая confirmation свеча закрыта → EQ появился, createdAt = effClose(2-й свечи)"
  );
  ok(
    createdAt !== undefined && createdAt > T0 + 22 * HOUR,
    "13: createdAt НЕ backdate к p2.confirmedAt (T0+22h)"
  );
}

/* ---------- 14. breakout в confirmation → discard ---------- */

{
  const raw = fixtureB(110.4, [
    mk(22, 110.22, 115, 116, 109),
    flat(23)
  ]);

  ok(
    eq(levels(raw, T0 + 27 * HOUR)).filter(
      (level) => level.side === "BUY_SIDE"
    ).length === 0,
    "14: close за уровень во время confirmation → BUY candidate discard, EQ никогда не существует"
  );
}

/* ---------- 15/18/19/20. sweep vs порог (BUY_SIDE) ---------- */

function sweepCandle(high: number): SmcRawCandle {
  const b = 15 * 0.01;

  return mk(15, 86 + b, 87 + b, high, 84 + b);
}

function sweepFixture(high: number): SmcRawCandle[] {
  return [...fixtureA(), sweepCandle(high)];
}

{
  const base = fixtureA();
  const v14 = atrAt(base, 14);
  const fp = exactThresholdHigh(v14, 110, 84.15);

  // 15: sweep с запасом.
  const swept = structural(
    levels(sweepFixture(fp + 0.5), T0 + 16 * HOUR),
    "BUY_SIDE",
    110
  )[0];
  const atr15 = atrAt(sweepFixture(fp + 0.5), 15);

  ok(
    swept !== undefined &&
      swept.state === "SWEPT" &&
      swept.resolvedAt !== null &&
      swept.resolvedAt.getTime() === T0 + 16 * HOUR &&
      swept.resolvedByCandleTime!.getTime() ===
        T0 + 15 * HOUR,
    "15: BUY_SIDE sweep — SWEPT, resolvedAt = effClose sweep-свечи, resolvedByCandleTime = её openTime"
  );
  closeTo(
    swept!.sweepPenetrationAtr!,
    (fp + 0.5 - 110) / atr15,
    "15: numerical penetrationATR = (high − price)/ATR[sweep]"
  );
  ok(
    swept!.sweepPenetrationAtr! >= 0.05,
    "15: penetration >= sweepMinPenetrationAtr"
  );

  // 18: ниже порога → OPEN.
  const below = structural(
    levels(sweepFixture(fp * (1 - 1e-12)), T0 + 16 * HOUR),
    "BUY_SIDE",
    110
  )[0];

  ok(
    below !== undefined &&
      below.state === "OPEN" &&
      below.resolvedAt === null,
    "18: проникновение ниже 0.05 ATR → OPEN"
  );
  ok(
    fp * (1 - 1e-12) <
      110 + 0.05 * atrAt(sweepFixture(fp * (1 - 1e-12)), 15),
    "18: numerical high < price + 0.05*ATR"
  );

  // 19: точный порог → sweep принят (inclusive >=).
  const exactHigh = fp * (1 + 1e-12);
  const exact = structural(
    levels(sweepFixture(exactHigh), T0 + 16 * HOUR),
    "BUY_SIDE",
    110
  )[0];
  const exactAtr = atrAt(sweepFixture(exactHigh), 15);

  ok(
    exact !== undefined && exact.state === "SWEPT",
    "19: exact threshold penetration → sweep accepted (>= inclusive)"
  );
  closeTo(
    exactHigh,
    110 + 0.05 * exactAtr,
    "19: numerical high == price + 0.05*ATR (граница)"
  );

  // 20: wick сквозь уровень + close ровно на уровне → НЕ sweep.
  const atLevel = structural(
    levels(
      [
        // close РОВНО на уровне 110; wick 110.5 проникает
        // за порог, но reclaim строгий (close < level).
        ...fixtureA(),
        mk(15, 110.5, 110, 110.5, 100)
      ],
      T0 + 16 * HOUR
    ),
    "BUY_SIDE",
    110
  )[0];

  ok(
    atLevel !== undefined &&
      atLevel.state === "OPEN" &&
      atLevel.resolvedAt === null,
    "20: wick через уровень + close ровно на уровне → не sweep (strict reclaim), OPEN"
  );
}

/* ---------- 16. SELL_SIDE sweep (зеркало) ---------- */

{
  // Зеркало: v14 идентичен (TR инвариантны к инверсии),
  // low sweep-свечи = −(fp_buy + 0.5).
  const v14 = atrAt(negate(fixtureA()), 14);
  const fp = exactThresholdHigh(v14, 110, 84.15);
  const raw = [
    ...negate(fixtureA()),
    mk(15, -86.15, -87.15, -84.15, -(fp + 0.5))
  ];
  const swept = structural(
    levels(raw, T0 + 16 * HOUR),
    "SELL_SIDE",
    -110
  )[0];

  ok(
    swept !== undefined &&
      swept.state === "SWEPT" &&
      swept.resolvedAt!.getTime() === T0 + 16 * HOUR &&
      swept.sweepPenetrationAtr! >= 0.05,
    "16: SELL_SIDE sweep — low <= price − 0.05*ATR, close вернулся выше (зеркало)"
  );
}

/* ---------- 17. ATR unavailable → нет sweep ---------- */

{
  const raw = [
    flat(0),
    pivotHigh(1, 110),
    dip(2),
    mk(3, 86.03, 87.03, 110.5, 84.03)
  ];

  const level = structural(
    levels(raw, T0 + 4 * HOUR),
    "BUY_SIDE",
    110
  )[0];

  ok(
    level !== undefined &&
      level.state === "OPEN" &&
      level.resolvedAt === null,
    "17: ATR на sweep-свече unavailable → свеча не может подтвердить sweep, уровень OPEN"
  );
}

/* ---------- 21/22/23/24. breakout vs sweep ---------- */

function breakCandle(): SmcRawCandle {
  const b = 15 * 0.01;

  return mk(15, 110.5 + b, 111 + b, 111.2 + b, 109 + b);
}

function breakFixture(): SmcRawCandle[] {
  return [...fixtureA(), breakCandle()];
}

{
  const broken = structural(
    levels(breakFixture(), T0 + 16 * HOUR),
    "BUY_SIDE",
    110
  )[0];

  ok(
    broken !== undefined &&
      broken.state === "BROKEN" &&
      broken.resolvedAt!.getTime() === T0 + 16 * HOUR,
    "21: close > level → BROKEN (buy-side)"
  );
  ok(
    broken!.sweepPenetrationAtr === null,
    "24: BROKEN при том же wick-проникновении — close-priority, НЕ SWEPT (одно событие на свечу)"
  );

  const brokenSell = structural(
    levels(negate(breakFixture()), T0 + 16 * HOUR),
    "SELL_SIDE",
    -110
  )[0];

  ok(
    brokenSell !== undefined &&
      brokenSell.state === "BROKEN",
    "22: close < level → BROKEN (sell-side, зеркало)"
  );

  const atClose = structural(
    levels(
      [...fixtureA(), mk(15, 109.5, 110, 110, 108)],
      T0 + 16 * HOUR
    ),
    "BUY_SIDE",
    110
  )[0];

  ok(
    atClose !== undefined && atClose.state === "OPEN",
    "23: close РОВНО на уровне → не broken (строгое сравнение)"
  );

  const all = [
    ...levels(breakFixture(), T0 + 16 * HOUR),
    ...levels(sweepFixture(fpForSweep() + 0.5), T0 + 16 * HOUR)
  ];

  ok(
    all.every(
      (level) =>
        (level.state === "SWEPT") ===
        (level.sweepPenetrationAtr !== null)
    ),
    "24: инвариант — SWEPT и BROKEN не сосуществуют (однократная резолюция)"
  );
}

function fpForSweep(): number {
  return exactThresholdHigh(atrAt(fixtureA(), 14), 110, 84.15);
}

/* ---------- 25. resolved остаётся resolved ---------- */

{
  const early = levels(sweepFixture(fpForSweep() + 0.5), T0 + 16 * HOUR);
  const late = levels(
    [...sweepFixture(fpForSweep() + 0.5), ...flats(16, 20)],
    T0 + 21 * HOUR
  );
  const earlyLevel = structural(early, "BUY_SIDE", 110)[0];
  const lateLevel = structural(late, "BUY_SIDE", 110)[0];

  ok(
    earlyLevel!.state === "SWEPT" &&
      lateLevel!.state === "SWEPT" &&
      earlyLevel!.resolvedAt!.getTime() ===
        lateLevel!.resolvedAt!.getTime(),
    "25: разрешённый уровень не возвращается в OPEN, resolvedAt стабилен"
  );
}

/* ---------- 26. structural и EQ с близкими ценами раздельны ---------- */

{
  const list = levels(fixtureB(), T0 + 25 * HOUR);
  const structural110 = structural(list, "BUY_SIDE", 110);
  const eqLevels = eq(list);

  ok(
    structural110.length === 1 &&
      eqLevels.length === 1 &&
      structural110[0].key !== eqLevels[0].key &&
      structural110[0].origin !== eqLevels[0].origin &&
      Math.abs(structural110[0].price - eqLevels[0].price) < 1,
    "26: structural (110) и EQH (110.4) — разные уровни с разными keys/lifecycle, без merge"
  );
}

/* ---------- 27/28/29/30. expiry ---------- */

{
  const cfg3: SmcLiquidityConfig = { ...CFG, maxAgeCandles: 3 };

  const base = [
    ...flats(0, 4),
    pivotHigh(5, 110),
    ...flats(6, 12)
  ];

  const before = structural(
    levels(base, T0 + 9 * HOUR, cfg3),
    "BUY_SIDE",
    110
  )[0];

  ok(
    before!.state === "OPEN" && before!.resolvedAt === null,
    "27: N−1 = 2 последующие свечи при maxAge 3 → OPEN"
  );

  const expired = structural(
    levels(base, T0 + 10 * HOUR, cfg3),
    "BUY_SIDE",
    110
  )[0];

  ok(
    expired!.state === "EXPIRED" &&
      expired!.resolvedAt!.getTime() === T0 + 10 * HOUR,
    "28: N = 3 последующие CLOSED свечи → EXPIRED, resolvedAt = effClose 3-й свечи (numerical)"
  );

  // Sweep-свеча на индексе 14 (ATR доступен), уровень создан
  // на idx 13, expiry при maxAge 3 был бы на idx 16.
  const b14 = 14 * 0.01;
  const sweepRaw = [
    ...flats(0, 11),
    pivotHigh(12, 110),
    flat(13),
    mk(14, 86 + b14, 87 + b14, 115, 84 + b14),
    ...flats(15, 20)
  ];
  const sweptFirst = structural(
    levels(sweepRaw, T0 + 21 * HOUR, cfg3),
    "BUY_SIDE",
    110
  )[0];

  ok(
    sweptFirst!.state === "SWEPT" &&
      sweptFirst!.resolvedAt!.getTime() === T0 + 15 * HOUR,
    "29: sweep до expiry выигрывает (SWEPT при T0+15h, не EXPIRED)"
  );

  const b7 = 7 * 0.01;
  const breakRaw = [
    ...flats(0, 4),
    pivotHigh(5, 110),
    flat(6),
    mk(7, 110.5 + b7, 111 + b7, 111.2 + b7, 109 + b7),
    ...flats(8, 12)
  ];
  const brokenFirst = structural(
    levels(breakRaw, T0 + 12 * HOUR, cfg3),
    "BUY_SIDE",
    110
  )[0];

  ok(
    brokenFirst!.state === "BROKEN" &&
      brokenFirst!.resolvedAt!.getTime() === T0 + 8 * HOUR,
    "30: break до expiry выигрывает"
  );
}

/* ---------- 31. deterministic keys ---------- */

{
  const raw = fixtureB();
  const run1 = levels(raw, T0 + 25 * HOUR);
  const run2 = levels(raw, T0 + 25 * HOUR);
  const eqLevel = eq(run1)[0];

  ok(
    JSON.stringify(run1) === JSON.stringify(run2),
    "31: повторный запуск — байт-в-байт"
  );
  ok(
    eqLevel !== undefined &&
      eqLevel.key ===
        `SMC1|LQ|1h|BUY_SIDE|EQH_EQL|${T0 + 20 * HOUR}`,
    "31: EQ key = SMC1|LQ|tf|side|EQH_EQL|creationTriggerAnchor (без DB-id/random)"
  );
  ok(
    new Set(run1.map((level) => level.key)).size ===
      run1.length,
    "31: все ключи уникальны"
  );
}

/* ---------- 32. future injection invariance ---------- */

{
  const full = [...fixtureB(), ...flats(27, 30)];

  for (const asOfHour of [23, 24, 27]) {
    const onFull = levels(full, T0 + asOfHour * HOUR);
    const onPrefix = levels(
      full.slice(0, asOfHour + 1),
      T0 + asOfHour * HOUR
    );

    ok(
      JSON.stringify(onFull) === JSON.stringify(onPrefix),
      `32: future injection инвариантен при asOf +${asOfHour}h (serialized canonical output)`
    );
  }
}

/* ---------- 33. serialized no-rewrite ---------- */

{
  const full = [...fixtureB(), ...flats(27, 30)];
  const snapshot = (asOfHour: number) =>
    levels(full, T0 + asOfHour * HOUR);

  const p1Early = structural(snapshot(22), "BUY_SIDE", 110)[0];
  const p1Late = structural(snapshot(26), "BUY_SIDE", 110)[0];

  ok(
    p1Early!.key === p1Late!.key &&
      p1Early!.createdAt.getTime() ===
        p1Late!.createdAt.getTime() &&
      p1Early!.eventTime.getTime() ===
        p1Late!.eventTime.getTime() &&
      p1Early!.state === p1Late!.state &&
      p1Early!.price === p1Late!.price,
    "33: структурный уровень исторически не переписывается (identity/createdAt/state стабильны)"
  );

  const eqEarly = eq(snapshot(24))[0];
  const eqLate = eq(snapshot(26))[0];

  ok(
    JSON.stringify(eqEarly) === JSON.stringify(eqLate),
    "33: EQ level (price/key/createdAt/sources) байт-в-байт стабилен между снапшотами"
  );
}

/* ---------- 34. mirror symmetry ---------- */

{
  const bull = levels(sweepFixture(fpForSweep() + 0.5), T0 + 16 * HOUR);
  const bear = levels(
    negate(sweepFixture(fpForSweep() + 0.5)),
    T0 + 16 * HOUR
  );
  const bullSwept = bull.find(
    (level) => level.state === "SWEPT"
  );
  const bearSwept = bear.find(
    (level) => level.state === "SWEPT"
  );

  ok(
    bullSwept !== undefined &&
      bearSwept !== undefined &&
      bullSwept.side === "BUY_SIDE" &&
      bearSwept.side === "SELL_SIDE" &&
      bullSwept.resolvedAt!.getTime() ===
        bearSwept.resolvedAt!.getTime() &&
      bullSwept.price === -bearSwept.price &&
      Math.abs(
        bullSwept.sweepPenetrationAtr! -
          bearSwept.sweepPenetrationAtr!
      ) <= 1e-9,
    "34: зеркальные fixture — symmetric state/resolvedAt/penetration"
  );
}

/* ---------- performance smoke (~500 candles) ---------- */

{
  const raw: SmcRawCandle[] = [];

  for (let i = 0; i < 500; i++) {
    const b = i * 0.01;
    const phase = i % 6;

    if (phase === 0) {
      raw.push(pivotHigh(i, 110 + b + (i % 13) * 0.02));
    } else if (phase === 3) {
      raw.push(mk(i, 87 + b, 88 + b, 90 + b, 60 + b - (i % 11) * 0.02));
    } else {
      raw.push(flat(i));
    }
  }

  const started = Date.now();
  const list = levels(raw, T0 + 501 * HOUR);
  const elapsed = Date.now() - started;
  const unique = new Set(list.map((level) => level.key)).size;

  ok(
    unique === list.length && list.length > 0 && elapsed < 5000,
    `perf: 500 свечей → ${list.length} уровней за ${elapsed}ms, ключи уникальны`
  );
}

/* ---------- canonical horizon guard ---------- */

{
  const raw = fixtureA();
  const prepared = validateAndPrepare(raw, "1h");

  assertValidAsOf(new Date(T0 + 8 * HOUR));
  ok(
    horizonCandles(prepared, new Date(T0 + 7 * HOUR)).length === 7,
    "horizon: liquidity работает на canonical Phase 1 horizon (свечи <= asOf)"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
