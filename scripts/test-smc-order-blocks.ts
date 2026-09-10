/**
 * SMC Phase 2C — тесты Order Block core
 * (запуск: npx tsx scripts/test-smc-order-blocks.ts).
 *
 * Канонический bullish fixture (swing 1/1): quiet-свечи TR=6,
 * dip@7 (pivot low 82, bootstrap-контекст), candidate-кластер
 * [14] (90→84, зона [84,90]), bullish displacement @15
 * (o91→c104, h106.5, l90.5 — FVG c.low 90.5 > a.high 13-й 89.5),
 * bearish стоп @16, BOS up @17 (close 108 > pivot high 106.5,
 * conf effClose(17) = T0+19h). ATR-маржины displacement ≥1.7/2.1
 * (проверяются прогоном), а не точные равенства.
 * Зеркала — точная инверсия (негатив) значений.
 */

import {
  defaultOrderBlockConfig,
  evaluateOrderBlocks,
  SmcOrderBlock,
  SmcOrderBlockConfig
} from "../lib/smc/order-blocks";
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

/** Точная инверсия — зеркало fixture. */
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

function obCfg(
  layer: "internal" | "swing" = "swing",
  overrides: Partial<SmcOrderBlockConfig> = {}
): SmcOrderBlockConfig {
  const base = defaultOrderBlockConfig("1h", layer);

  return {
    ...base,
    swingLeft: 1,
    swingRight: 1,
    ...overrides
  };
}

function bullish(
  raw: SmcRawCandle[],
  asOfMs: number,
  config: SmcOrderBlockConfig = obCfg()
): SmcOrderBlock[] {
  return evaluateOrderBlocks(raw, config, new Date(asOfMs));
}

const bullishUp = (
  list: SmcOrderBlock[]
) => list.filter((ob) => ob.direction === "up");

/** Канонический fixture: FVG (13,14,15) с gap 0.87 (sizeAtr
 * ~0.109 > 0.10), displacement @15 (bodyAtr ~1.63, rangeAtr
 * ~2.14), BOS up @17 (close 109 > pivot high 108). */
function canonical(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 105, 84.05), // pivot high 105
    flat(6),
    mk(7, 86.07, 87.07, 90.07, 82),  // pivot low 82 (bootstrap)
    ...flats(8, 13),
    mk(14, 90, 86, 90.14, 84),       // candidate bearish, зона [84,90.14]
    mk(15, 91, 104, 108, 91),        // displacement bull + FVG c
    mk(16, 103, 101, 103.5, 95),     // bearish стоп (impulse=[15])
    mk(17, 107, 109, 109.5, 106.5),  // BOS up (close > 108)
    ...flats(18, 26)
  ];
}

/** Fixture C: BOS down @10 → CHOCH up @14 → reversal BOS up @17. */
function fixtureC(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 105, 84.05), // pivot high 105
    flat(6),
    mk(7, 86.07, 87.07, 90.07, 82),
    flat(8),
    mk(9, 86.09, 87.09, 90.09, 84.09), // просто quiet
    mk(10, 81, 74, 81, 73),            // BOS down (close 74 < 82)
    mk(11, 74, 70, 74.2, 69.5),        // candidate bearish #2
    mk(12, 70, 82, 84, 68),            // displacement bull, cluster [10,11]
    mk(13, 81.5, 78, 82, 77),          // bearish стоп (impulse=[12])
    mk(14, 79, 107, 107.5, 78.5),      // CHOCH up (close > 105)
    mk(15, 106.5, 105.5, 106.8, 105.2),
    mk(16, 105.6, 105.4, 106, 105.1),
    mk(17, 105.5, 108, 108.4, 105.2),  // reversal BOS up (> 107.5)
    mk(18, 107.8, 107.5, 108, 106.8),
    mk(19, 107.6, 107.4, 108, 107)
  ];
}

/** Два bullish импульса (A [14], B [19]) и два BOS up (@16, @19). */
function twoImpulses(): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 90.05, 84.05),
    flat(6),
    mk(7, 86.07, 87.07, 90.07, 82),   // pivot low 82 (bootstrap)
    ...flats(8, 12),
    mk(13, 90.13, 84.13, 90.13, 84.13), // candidate A
    mk(14, 87, 99, 101, 85.5),          // displacement A
    mk(15, 98, 96, 98.5, 95),           // стоп
    mk(16, 96.5, 103, 103.4, 96),       // BOS up #1 (> 101)
    mk(17, 102.5, 100, 102.8, 99.5),    // candidate B #1
    mk(18, 100, 95, 100.2, 88),         // candidate B #2 (зона в A)
    mk(19, 97, 110, 112, 96),           // displacement B + BOS #2
    mk(20, 111, 108, 111.5, 107),
    ...flats(21, 26)
  ];
}

/* ---------- 1. bullish candidate cluster ---------- */

{
  const obs = bullishUp(bullish(canonical(), T0 + 20 * HOUR));

  ok(
    obs.length === 1 &&
      obs[0].direction === "up" &&
      obs[0].bottom === 84 &&
      obs[0].top === 90.14 &&
      obs[0].eventTime.getTime() === T0 + 14 * HOUR,
    "1: bullish OB — кластер [14], zone = FULL wick range [84,90], eventTime = начало кластера"
  );
  ok(
    obs[0].impulseStartAt.getTime() === T0 + 15 * HOUR &&
      obs[0].impulseEndAt.getTime() === T0 + 16 * HOUR,
    "1: impulseStartAt = openTime displacement-свечи, impulseEndAt = effClose последней impulse-свечи"
  );
}

/* ---------- 2/8. bearish candidate cluster + BOS ---------- */

{
  const obs = bullish(
    negate(canonical()),
    T0 + 20 * HOUR
  ).filter((ob) => ob.direction === "down");

  ok(
    obs.length === 1 &&
      obs[0].bottom === -90.14 &&
      obs[0].top === -84 &&
      obs[0].eventTime.getTime() === T0 + 14 * HOUR,
    "2: bearish OB — зеркальный кластер, зона [-90.14,-84]"
  );
  ok(
    obs[0].confirmedAt.getTime() === T0 + 18 * HOUR,
    "8: bearish BOS down подтверждает bearish OB (conf T0+18h)"
  );
}

/* ---------- 3. нет opposite candle перед impulse ---------- */

{
  const raw = canonical();
  // candle 14 становится bullish quiet — кластера нет.
  raw[14] = flat(14);

  ok(
    bullish(raw, T0 + 20 * HOUR).length === 0,
    "3: свеча перед impulseStart не bearish → candidate отсутствует, OB нет"
  );
}

/* ---------- 4. нет displacement → нет OB ---------- */

{
  const raw = canonical();
  // candle 15: pivot high остаётся (h=106.5), но тело/размах
  // малы → primitive displacement отсутствует.
  raw[15] = mk(15, 105, 106.2, 106.5, 104.8);

  ok(
    bullish(raw, T0 + 20 * HOUR).length === 0,
    "4: displacement отсутствует → impulse не строится, OB нет (BOS при этом существует)"
  );
}

/* ---------- 5. displacement без structure event ---------- */

{
  const raw = canonical();
  // candle 17 не пробивает pivot high → BOS up нет.
  raw[17] = mk(17, 96.5, 97, 97.4, 95.5);

  ok(
    bullish(raw, T0 + 26 * HOUR).length === 0,
    "5: displacement impulse без structural event в окне → OB нет"
  );
}

/* ---------- 6. wrong-direction structure event ---------- */

{
  const obs = bullish(negate(canonical()), T0 + 20 * HOUR);

  ok(
    bullishUp(obs).length === 0,
    "6: в зеркале только BOS down — bullish OB не подтверждается чужим направлением"
  );
}

/* ---------- 7. bullish BOS подтверждает ---------- */

{
  const obs = bullishUp(bullish(canonical(), T0 + 20 * HOUR));

  ok(
    obs.length === 1 &&
      obs[0].confirmedAt.getTime() === T0 + 18 * HOUR &&
      obs[0].structureEventType === "BOS" &&
      obs[0].structureEventKey.startsWith(
        "SMC1|E|1h|swing|BOS|up|"
      ) &&
      obs[0].structureEventTime.getTime() === T0 + 17 * HOUR,
    "7: bullish OB подтверждён BOS up (structureEventKey = FSM event key, conf T0+19h)"
  );
}

/* ---------- 9/10. nearest matching, без переиспользования ---------- */

{
  const raw = twoImpulses();
  const obs = bullish(raw, T0 + 24 * HOUR);

  ok(
    obs.length === 2,
    "9: один event — один impulse; два события → ровно два OB (без дублирования)"
  );

  const byConfirmed = [...obs].sort(
    (a, b) => a.confirmedAt.getTime() - b.confirmedAt.getTime()
  );

  ok(
    byConfirmed[0].structureEventTime.getTime() ===
      T0 + 16 * HOUR &&
      byConfirmed[0].top === 90.13 &&
      byConfirmed[0].bottom === 84.13,
    "9: BOS#1 (@16) взял БЛИЖАЙШИЙ impulse A (кластер [13], зона [84.13,90.13])"
  );
  ok(
    byConfirmed[1].structureEventTime.getTime() ===
      T0 + 19 * HOUR &&
      byConfirmed[1].top === 102.8 &&
      byConfirmed[1].bottom === 88,
    "10: BOS#2 (@19) НЕ переиспользовал impulse A — взял impulse B (кластер [17,18], зона [88,102.8])"
  );
}

/* ---------- 11. event вне confirmMax ---------- */

{
  const raw = canonical();
  // BOS уезжает на idx 27 (27 − 15 = 12 > 10); до этого
  // закрытия ниже 109.5 и выше 82 — событий нет.
  raw[17] = mk(17, 96.5, 97, 97.4, 95.5);
  raw[27] = mk(27, 109, 111, 111.5, 108.5);

  ok(
    bullish(raw, T0 + 30 * HOUR).length === 0,
    "11: confirmation на 12-й границе после impulseEnd (> confirmMax 10) → OB нет"
  );
}

/* ---------- 12/13. internal vs swing layer ---------- */

{
  const raw = canonical();
  raw[18] = mk(18, 107.8, 107.2, 108, 106.5);
  raw[19] = mk(19, 107.3, 107, 107.6, 106.4);
  raw[20] = mk(20, 106.9, 106.5, 107.2, 106);
  raw[21] = mk(21, 106.8, 110.5, 110.9, 106.3); // BOS up (3/3): > 109.5
  raw[22] = mk(22, 110, 109.5, 110.4, 108.6);

  const internal = bullish(
    raw,
    T0 + 23 * HOUR,
    obCfg("internal")
  );

  ok(
    internal.length === 1 &&
      internal[0].layer === "internal" &&
      internal[0].confirmedAt.getTime() === T0 + 18 * HOUR &&
      internal[0].structureEventTime.getTime() === T0 + 17 * HOUR,
    "12: internal layer — OB подтверждён internal-BOS (3/3 окна: pivot 105 + low 84, conf T0+18h)"
  );

  // Swing с DEFAULT окнами 20/20: на коротком fixture pivots
  // не подтверждаются → OB нет (слои не смешиваются).
  const swing = bullish(
    raw,
    T0 + 23 * HOUR,
    { ...defaultOrderBlockConfig("1h", "swing") }
  );

  ok(
    swing.length === 0,
    "13: swing layer (default окна 20) на том же fixture — OB нет"
  );
}

/* ---------- 14/15/16. conservative CHOCH ---------- */

{
  ok(
    bullish(fixtureC(), T0 + 17 * HOUR).length === 0,
    "14: CHOCH up подтверждён (T0+16h), но reversal не подтверждён — conservative policy: OB НЕТ"
  );

  const confirmed = bullish(fixtureC(), T0 + 20 * HOUR);

  ok(
    confirmed.length === 1 &&
      confirmed[0].direction === "up" &&
      confirmed[0].confirmedAt.getTime() === T0 + 18 * HOUR,
    "15: CHOCH + reversal-confirming BOS → OB подтверждён РОВНО в BOS.confirmedAt (T0+18h), не в CHOCH (T0+15h)"
  );
  // Candle 14 (79→107) сама является bullish displacement:
  // impulse [14], candidate cluster [13], зона [77,82];
  // impulse [12] остаётся unmatched (второго BOS в окне нет).
  ok(
    confirmed[0] !== undefined &&
      confirmed[0].bottom === 77 &&
      confirmed[0].top === 82 &&
      confirmed[0].eventTime.getTime() === T0 + 13 * HOUR,
    "15: candidate cluster [13] перед displacement-свечей 14, зона [77,82] (nearest impulse выиграл)"
  );

  // Failed CHOCH: reclaim ниже уровня 84 (close 74), BOS up
  // не происходит.
  const failed = fixtureC();
  failed[15] = mk(15, 83, 74, 83.5, 73.5);
  failed[16] = mk(16, 74, 72, 74.5, 71);
  failed[17] = mk(17, 72, 73, 73.5, 71.5);

  ok(
    bullish(failed, T0 + 22 * HOUR).length === 0,
    "16: failed CHOCH (reclaim вниз) без последующего BOS up → reversal OB не существует"
  );
}

/* ---------- 17/18. eventTime/confirmedAt semantics ---------- */

{
  const ob = bullishUp(bullish(canonical(), T0 + 20 * HOUR))[0];

  ok(
    ob.eventTime.getTime() === T0 + 14 * HOUR,
    "17: eventTime = openTime ПЕРВОЙ свечи candidate cluster (не displacement, не BOS)"
  );
  ok(
    ob.confirmedAt.getTime() === T0 + 18 * HOUR &&
      ob.confirmedAt.getTime() ===
        new Date(T0 + 17 * HOUR + HOUR).getTime(),
    "18: confirmedAt = BOS.confirmedAt = effectiveCloseTime confirmation candle"
  );
}

/* ---------- 19/20. asOf граница confirmedAt ---------- */

{
  ok(
    bullish(canonical(), T0 + 18 * HOUR - 1).length === 0,
    "19: asOf = confirmedAt − 1ms → OB отсутствует"
  );
  ok(
    bullishUp(bullish(canonical(), T0 + 18 * HOUR)).length === 1,
    "20: asOf = confirmedAt → OB присутствует"
  );
}

/* ---------- 21. pre-confirmation touch ---------- */

{
  const raw = canonical();
  raw[16] = mk(16, 103, 101, 103.5, 89); // wick в зону ДО confirmation

  const ob = bullishUp(bullish(raw, T0 + 18 * HOUR))[0];

  ok(
    ob !== undefined &&
      ob.preConfirmationTouches === 1 &&
      ob.firstTouchedAt === null &&
      ob.firstMitigatedAt === null &&
      ob.retests === 0,
    "21: pre-confirmation wick-in-zone → счётчик payload, НЕ mitigation (firstTouchedAt null на границе)"
  );
}

/* ---------- 22. pre-confirmation close через far boundary ---------- */

{
  ok(
    bullish(canonical(), T0 + 20 * HOUR).length === 1,
    "22/A: контроль — без far-close OB подтверждается"
  );

  // close-through на свече 16 (pre-conf окно), FSM-событие
  // BOS up @17 при этом существует (close 83 > 82, не down).
  const raw = canonical();
  raw[16] = mk(16, 103, 83, 103.5, 82.5);

  ok(
    bullishUp(bullish(raw, T0 + 20 * HOUR)).length === 0,
    "22/B: bullish candidate discard (close 16-й свечи 83 < bottom 84 до confirmation) — bullish OB не существует"
  );
}

/* ---------- lifecycle fixture ---------- */

function lifecycle(): SmcRawCandle[] {
  const raw = canonical();

  for (let k = 0; k < 9; k++) {
    raw.pop();
  }

  raw.push(
    mk(18, 107.5, 107, 107.9, 106.7),
    mk(19, 107, 106.6, 107.4, 89.14),  // touch #1 (0.1433)
    mk(20, 106.5, 106.3, 106.8, 84),   // full wick, close внутри
    mk(21, 106.2, 106, 106.5, 92),     // out
    mk(22, 105.9, 105.5, 106.2, 88.5), // re-entry → retests 2
    mk(23, 105.4, 105.2, 105.8, 93)
  );

  return raw;
}

/* ---------- 23/24/26. touch, retests, fraction ---------- */

{
  const at20 = bullishUp(bullish(lifecycle(), T0 + 20 * HOUR))[0];

  ok(
    at20 !== undefined &&
      at20.state === "MITIGATED" &&
      at20.retests === 1 &&
      at20.firstTouchedAt !== null &&
      at20.firstTouchedAt.getTime() === T0 + 20 * HOUR &&
      at20.firstMitigatedAt !== null &&
      at20.firstMitigatedAt.getTime() === T0 + 20 * HOUR,
    "23: первый post-confirmation touch → MITIGATED, retests=1, firstTouchedAt=firstMitigatedAt=effClose(19)"
  );
  closeTo(
    at20!.maxPenetrationFraction,
    (90.14 - 89.14) / 6.14,
    "26: partial penetration fraction = (top − minLow)/(top − bottom)"
  );

  const at21 = bullishUp(bullish(lifecycle(), T0 + 21 * HOUR))[0];

  ok(
    at21 !== undefined &&
      at21.retests === 1 &&
      Math.abs(at21.maxPenetrationFraction - 1) <= 1e-9,
    "24: consecutive inside candles (19,20) → retests остаётся 1; wick до far boundary → fraction 1"
  );
}

/* ---------- 25. exit then return ---------- */

{
  const ob = bullishUp(bullish(lifecycle(), T0 + 23 * HOUR))[0];

  ok(
    ob !== undefined &&
      ob.retests === 2 &&
      ob.state === "MITIGATED",
    "25: выход наружу (candle 21) и возврат (candle 22) → retests=2 (in/out state machine)"
  );
}

/* ---------- 27/28. wick full fill vs close invalidation ---------- */

{
  const at21 = bullishUp(bullish(lifecycle(), T0 + 21 * HOUR))[0];

  ok(
    at21 !== undefined &&
      at21.invalidatedAt === null &&
      at21.state === "MITIGATED",
    "27: wick до far boundary (low=bottom) + close внутри → НЕ invalidated (strict close rule)"
  );

  const raw = lifecycle();
  raw[23] = mk(23, 93, 83.5, 93.5, 83); // close 83.5 < bottom

  const invalidated = bullishUp(bullish(raw, T0 + 24 * HOUR))[0];

  ok(
    invalidated !== undefined &&
      invalidated.state === "INVALIDATED" &&
      invalidated.invalidatedAt !== null &&
      invalidated.invalidatedAt.getTime() === T0 + 24 * HOUR,
    "28: close < bottom (строго) → INVALIDATED ( invalidatedAt = effClose свечи)"
  );
}

/* ---------- 29. bearish lifecycle mirror ---------- */

{
  const bear = bullish(negate(lifecycle()), T0 + 23 * HOUR).filter(
    (ob) => ob.direction === "down"
  );
  const bull = bullishUp(bullish(lifecycle(), T0 + 23 * HOUR));

  ok(
    bear.length === 1 &&
      bull.length === 1 &&
      bear[0].state === bull[0].state &&
      bear[0].retests === bull[0].retests &&
      Math.abs(
        bear[0].maxPenetrationFraction -
          bull[0].maxPenetrationFraction
      ) <= 1e-9 &&
      bear[0].firstTouchedAt !== null &&
      bull[0].firstTouchedAt !== null &&
      bear[0].firstTouchedAt.getTime() ===
        bull[0].firstTouchedAt.getTime(),
    "29: bearish lifecycle — точное зеркало (state/retests/fraction/touch)"
  );
}

/* ---------- 30/31. FVG confluence ---------- */

{
  const ob = bullishUp(bullish(canonical(), T0 + 20 * HOUR))[0];

  ok(
    ob.hasFvgInImpulse === true,
    "30: FVG confluence true — confirmed bull FVG (c=15) в интервале cluster..impulse, conf <= structureConfirmed"
  );

  // Вариант: in-interval FVG убран (a.high 91.5 > c.low 91),
  // а FVG (15,16,17) лежит ВНЕ интервала → false.
  const raw = canonical();
  raw[13] = mk(13, 86.13, 87.13, 91.5, 84.13);
  raw[16] = mk(16, 105, 103, 105.5, 102);
  raw[17] = mk(17, 109.7, 110, 112, 109.5); // BOS + FVG c=17 вне интервала

  const ob2 = bullishUp(bullish(raw, T0 + 20 * HOUR))[0];

  ok(
    ob2 !== undefined && ob2.hasFvgInImpulse === false,
    "31: FVG, созданный ПОСЛЕ impulse (c=17 вне cluster..impulse), не считается — confluence false"
  );
}

/* ---------- 32/33/34. liquidity sweep confluence ---------- */

/** Sweep-фикстура: pivot low 82@5, sweep-свеча @14 (ATR[14]
 * доступен — seed), candidate @15, displacement @16,
 * BOS @18 (close 109 > pivot high 108@16). */
function sweepFixture(sweepCandle: SmcRawCandle): SmcRawCandle[] {
  return [
    ...flats(0, 4),
    mk(5, 86.05, 87.05, 90.05, 82), // pivot low 82@5
    ...flats(6, 13),
    sweepCandle,                    // 14: SELL_SIDE sweep 82
    mk(15, 90.15, 84.15, 90.15, 84.15), // candidate bearish
    mk(16, 91, 104, 108, 91),       // displacement bull
    mk(17, 103, 101, 103.5, 95),    // стоп (impulse=[16])
    mk(18, 107, 109, 109.5, 106.5), // BOS up (close > 108)
    ...flats(19, 23)
  ];
}

{
  // SELL_SIDE sweep уровня 82: low 81 <= 82 − 0.05*ATR, close 85 > 82.
  const swept = bullish(
    sweepFixture(mk(14, 84.14, 85.14, 85.34, 81)),
    T0 + 22 * HOUR
  );

  ok(
    swept.length === 1 &&
      swept[0].hasLiquiditySweepBeforeImpulse === true &&
      swept[0].confirmedAt.getTime() === T0 + 17 * HOUR,
    "32: sweep confluence true — SELL_SIDE SWEPT, resolvedAt T0+15h за 1h до impulseStart T0+16h (<= lookback 5)"
  );

  // Свеча пробивает уровень CLOSE вниз → BROKEN, не SWEPT.
  const broken = bullish(
    sweepFixture(mk(14, 84.14, 80, 85.34, 79)),
    T0 + 22 * HOUR
  );

  ok(
    broken.length === 1 &&
      broken[0].hasLiquiditySweepBeforeImpulse === false,
    "33: уровень BROKEN (close за уровнем), не SWEPT → confluence false (аннотация, не gate: OB существует)"
  );

  // Sweep задолго до impulse: atrPeriod=5 (ATR с idx 5),
  // sweep @5 → resolvedAt T0+6h, impulseStart T0+16h → 10h > 5.
  const farRaw: SmcRawCandle[] = [
    flat(0),
    flat(1),
    mk(2, 86.02, 87.02, 90.02, 82), // pivot low 82@2
    flat(3),
    flat(4),
    mk(5, 84.05, 85.05, 85.25, 81), // sweep @5 → resolved T0+6h
    ...flats(6, 13),
    mk(14, 90.14, 84.14, 90.14, 84.14),
    mk(15, 88, 106, 110, 86),       // displacement (atrPeriod 5)
    mk(16, 103, 101, 103.5, 95),
    mk(17, 108, 111, 111.5, 107.5), // BOS up (close > 110)
    ...flats(18, 23)
  ];

  const far = bullish(farRaw, T0 + 22 * HOUR, obCfg("swing", { atrPeriod: 5 }));

  ok(
    far.length === 1 &&
      far[0].hasLiquiditySweepBeforeImpulse === false,
    "34: sweep resolvedAt T0+6h, impulseStart T0+16h → 10h > lookback 5 → confluence false"
  );
}

/* ---------- 35. overlapping OB остаются раздельными ---------- */

{
  const obs = bullish(twoImpulses(), T0 + 24 * HOUR);
  const sorted = [...obs].sort(
    (a, b) => a.bottom - b.bottom
  );

  ok(
    sorted.length === 2 &&
      sorted[0].key !== sorted[1].key &&
      sorted[0].bottom === 84.13 &&
      sorted[1].bottom === 88 &&
      sorted[1].top > sorted[0].top,
    "35: зоны перекрываются (88 < 90.13), но OB остаются раздельными immutable events (без merge)"
  );
}

/* ---------- 36. deterministic IDs ---------- */

{
  const raw = canonical();
  const run1 = bullish(raw, T0 + 20 * HOUR);
  const run2 = bullish(raw, T0 + 20 * HOUR);
  const ob = run1[0];

  ok(
    JSON.stringify(run1) === JSON.stringify(run2),
    "36: повторный запуск — байт-в-байт"
  );
  ok(
    ob.key ===
      `SMC1|OB|1h|up|swing|${ob.structureEventKey}|${T0 + 14 * HOUR}`,
    "36: key = SMC1|OB|tf|dir|layer|structureEventKey|candidateStartOpenMs (без DB-id/random/price)"
  );
}

/* ---------- 37/38. expiry ---------- */

{
  // OB confirmed T0+18h; последующие: 18 (1-я), 19 (2-я), 20 (3-я).
  const at20 = bullishUp(
    bullish(lifecycle(), T0 + 20 * HOUR, obCfg("swing", { maxAgeCandles: 3 }))
  )[0];

  ok(
    at20 !== undefined &&
      at20.state === "MITIGATED" &&
      at20.expiredAt === null,
    "37: N−1 = 2 последующие свечи при maxAge 3 → ещё не EXPIRED"
  );

  const at21 = bullishUp(
    bullish(lifecycle(), T0 + 21 * HOUR, obCfg("swing", { maxAgeCandles: 3 }))
  )[0];

  ok(
    at21 !== undefined &&
      at21.state === "EXPIRED" &&
      at21.expiredAt !== null &&
      at21.expiredAt.getTime() === T0 + 21 * HOUR,
    "37: N = 3 последующие CLOSED свечи → EXPIRED, expiredAt = effClose 3-й свечи (T0+21h)"
  );

  const raw = lifecycle();
  raw[23] = mk(23, 93, 83.5, 93.5, 83); // invalidation на 6-й subsequent

  const inv = bullishUp(
    bullish(raw, T0 + 24 * HOUR, obCfg("swing", { maxAgeCandles: 10 }))
  )[0];

  ok(
    inv !== undefined &&
      inv.state === "INVALIDATED" &&
      inv.expiredAt === null &&
      inv.invalidatedAt !== null &&
      inv.invalidatedAt.getTime() === T0 + 24 * HOUR,
    "38: INVALIDATED до expiry (maxAge 10) — приоритет invalidation, expiredAt не выставляется"
  );
}

/* ---------- 39. future injection invariance ---------- */

{
  const full = lifecycle();

  for (const asOfHour of [18, 20, 23]) {
    const onFull = bullish(full, T0 + asOfHour * HOUR);
    const onPrefix = bullish(
      full.slice(0, asOfHour + 1),
      T0 + asOfHour * HOUR
    );

    ok(
      JSON.stringify(onFull) === JSON.stringify(onPrefix),
      `39: future injection инвариантен при asOf +${asOfHour}h (serialized canonical output)`
    );
  }
}

/* ---------- 40. serialized historical no-rewrite ---------- */

{
  const full = lifecycle();
  const early = bullishUp(bullish(full, T0 + 20 * HOUR))[0];
  const late = bullishUp(bullish(full, T0 + 23 * HOUR))[0];

  ok(
    early.key === late.key &&
      early.bottom === late.bottom &&
      early.top === late.top &&
      early.eventTime.getTime() === late.eventTime.getTime() &&
      early.impulseStartAt.getTime() ===
        late.impulseStartAt.getTime() &&
      early.impulseEndAt.getTime() ===
        late.impulseEndAt.getTime() &&
      early.structureEventKey === late.structureEventKey &&
      early.confirmedAt.getTime() === late.confirmedAt.getTime() &&
      early.firstTouchedAt?.getTime() ===
        late.firstTouchedAt?.getTime() &&
      early.retests <= late.retests,
    "40: исторический snapshot не переписывается — identity/history стабильны, lifecycle только дополняется"
  );
}

/* ---------- performance smoke (~500 candles) ---------- */

{
  const raw: SmcRawCandle[] = [];

  for (let i = 0; i < 500; i++) {
    const b = i * 0.01;
    const phase = i % 8;

    if (phase === 0) {
      raw.push(mk(i, 90 + b, 84 + b, 90 + b, 84 + b));
    } else if (phase === 1) {
      raw.push(mk(i, 91 + b, 104 + b, 106.5 + b, 90.5 + b));
    } else if (phase === 2) {
      raw.push(mk(i, 103 + b, 101 + b, 103.5 + b, 95 + b));
    } else if (phase === 3) {
      raw.push(mk(i, 101.5 + b, 108 + b, 108.4 + b, 101 + b));
    } else if (phase === 5) {
      raw.push(mk(i, 107 + b, 106.6 + b, 107.4 + b, 100 + b));
    } else {
      raw.push(flat(i));
    }
  }

  const started = Date.now();
  const obs = bullish(raw, T0 + 501 * HOUR);
  const elapsed = Date.now() - started;

  ok(
    new Set(obs.map((ob) => ob.key)).size === obs.length &&
      elapsed < 5000,
    `perf: 500 свечей → ${obs.length} OB за ${elapsed}ms, ключи уникальны`
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
