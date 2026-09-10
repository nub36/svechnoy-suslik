/**
 * SMC Phase 1 — тесты pivots и canonical input
 * (запуск: npx tsx scripts/test-smc-pivots.ts).
 *
 * Покрывают: обычные пивоты, plateau-политику с ИСПРАВЛЕННОЙ
 * off-by-one семантикой (right-контекст — ровно right
 * закрытых свечей ПОСЛЕ конца plateau), internal vs swing
 * (один алгоритм, разные окна), валидацию входа.
 */

import { findPivots } from "../lib/smc/pivots";
import {
  horizonCandles,
  SmcInputError,
  validateAndPrepare
} from "../lib/smc/validate";
import {
  internalStructureParams,
  SmcRawCandle,
  StructureParams,
  swingStructureParams
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

function throws(
  fn: () => unknown,
  needle: string,
  label: string
): void {
  try {
    fn();

    ok(false, `${label}: не выбросил исключение`);
  } catch (error) {
    ok(
      error instanceof Error &&
        error.message.includes(needle),
      label
    );
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

function series(values: [number, number][]): SmcRawCandle[] {
  return values.map(([o, c], i) => mk(i, o, c));
}

const LR2: StructureParams = {
  tf: "1h",
  layer: "internal",
  left: 2,
  right: 2
};

/* ---------- 1. ordinary pivot high ---------- */

/* highs: 100,106,110,109,104 — одиночная вершина (gap down
 * на i3 держит high соседа строго ниже). */
{
  const candles = validateAndPrepare(
    series([
      [98, 100],
      [100, 106],
      [106, 110],
      [109, 104],
      [104, 102]
    ]),
    "1h"
  );

  const pivots = findPivots(candles, LR2, "high");

  ok(
    pivots.length === 1 &&
      pivots[0].price === 110 &&
      pivots[0].eventTime.getTime() === T0 + 2 * HOUR,
    "pivot high: один обычный пивот, anchor = свеча вершины"
  );
  ok(
    pivots[0].confirmedAt.getTime() === T0 + 5 * HOUR,
    "pivot high: confirmedAt = effectiveCloseTime(end+right)"
  );
}

/* ---------- 2. ordinary pivot low ---------- */

/* lows: 104,106,100,101,105 — одиночная впадина (gap up на
 * i3 держит low соседа строго выше). */
{
  const candles = validateAndPrepare(
    series([
      [104, 110],
      [110, 106],
      [106, 100],
      [101, 105],
      [105, 107]
    ]),
    "1h"
  );

  const pivots = findPivots(candles, LR2, "low");

  ok(
    pivots.length === 1 &&
      pivots[0].price === 100 &&
      pivots[0].eventTime.getTime() === T0 + 2 * HOUR &&
      pivots[0].confirmedAt.getTime() === T0 + 5 * HOUR,
    "pivot low: зеркальная семантика обычного пивота"
  );
}

/* ---------- 3. plateau high length 2 ---------- */

/* highs: 105,105,110,110,104,103 */
{
  const candles = validateAndPrepare(
    series([
      [100, 105],
      [105, 105],
      [105, 110],
      [110, 104],
      [104, 103],
      [103, 103]
    ]),
    "1h"
  );

  const pivots = findPivots(candles, LR2, "high");

  ok(
    pivots.length === 1 &&
      pivots[0].price === 110 &&
      pivots[0].eventTime.getTime() === T0 + 2 * HOUR,
    "plateau high (2 свечи): РОВНО ОДИН пивот, anchor = ПЕРВАЯ свеча plateau"
  );
  ok(
    pivots[0].confirmedAt.getTime() === T0 + 6 * HOUR,
    "plateau high (2): confirmedAt = effectiveCloseTime(end+2)"
  );
}

/* ---------- 4. plateau high length 3 ---------- */

/* highs: 105,105,110,110,110,104,103 */
{
  const candles = validateAndPrepare(
    series([
      [100, 105],
      [105, 105],
      [105, 110],
      [110, 110],
      [110, 104],
      [104, 103],
      [103, 103]
    ]),
    "1h"
  );

  const pivots = findPivots(candles, LR2, "high");

  ok(
    pivots.length === 1 &&
      pivots[0].eventTime.getTime() === T0 + 2 * HOUR &&
      pivots[0].confirmedAt.getTime() === T0 + 7 * HOUR,
    "plateau high (3 свечи): один пивот, середина plateau не отдельный пивот"
  );
}

/* ---------- 5. plateau low ---------- */

/* lows: 105,101,100,100,106,107 */
{
  const candles = validateAndPrepare(
    series([
      [110, 105],
      [105, 101],
      [101, 100],
      [100, 106],
      [106, 107],
      [107, 108]
    ]),
    "1h"
  );

  const pivots = findPivots(candles, LR2, "low");

  ok(
    pivots.length === 1 &&
      pivots[0].price === 100 &&
      pivots[0].eventTime.getTime() === T0 + 2 * HOUR &&
      pivots[0].confirmedAt.getTime() === T0 + 6 * HOUR,
    "plateau low: зеркально, anchor = первая свеча plateau"
  );
}

/* ---------- 6. plateau pending + исправление off-by-one ---------- */

{
  // 100,110,110,105: после конца plateau только ОДНА правая
  // закрытая свеча → при right=2 подтверждения НЕТ.
  const pending2 = validateAndPrepare(
    series([
      [95, 100],
      [100, 110],
      [110, 110],
      [110, 105]
    ]),
    "1h"
  );

  ok(
    findPivots(pending2, LR2, "high").length === 0,
    "plateau pending: 110,110,105 при right=2 → не подтверждён"
  );

  // 100,110,110,110,105: снова только одна правая свеча
  // (исправление off-by-one из review V2).
  const pending3 = validateAndPrepare(
    series([
      [95, 100],
      [100, 110],
      [110, 110],
      [110, 110],
      [110, 105]
    ]),
    "1h"
  );

  ok(
    findPivots(pending3, LR2, "high").length === 0,
    "plateau pending: 110,110,110,105 при right=2 → не подтверждён"
  );

  // Контроль из review: 100,110,110,110,105,104 при
  // достаточном left-контексте → подтверждён.
  const confirmed = validateAndPrepare(
    series([
      [90, 95],
      [95, 100],
      [100, 110],
      [110, 110],
      [110, 110],
      [110, 105],
      [105, 104],
      [104, 103]
    ]),
    "1h"
  );

  const pivots = findPivots(confirmed, LR2, "high");

  ok(
    pivots.length === 1 &&
      pivots[0].price === 110 &&
      pivots[0].eventTime.getTime() === T0 + 2 * HOUR &&
      pivots[0].confirmedAt.getTime() === T0 + 8 * HOUR,
    "plateau confirmed: ровно right закрытых свечей после конца plateau"
  );
}

/* ---------- 8. internal vs swing: один алгоритм ---------- */

{
  // highs: 101,102,102,102.4,102.4,101,101.2,101 —
  // окно internal = 3: правый контекст idx5..7.
  const small = validateAndPrepare(
    series([
      [100, 101],
      [101, 102],
      [102, 101.5],
      [101.5, 102.4],
      [102.4, 101],
      [101, 101.2],
      [101.2, 101],
      [101, 100.8]
    ]),
    "1h"
  );

  const internal = findPivots(
    small,
    internalStructureParams("1h"),
    "high"
  );
  const swing = findPivots(
    small,
    swingStructureParams("1h"),
    "high"
  );

  ok(
    internal.length === 1 && internal[0].price === 102.4,
    "internal window: локальный пивот найден"
  );
  ok(
    swing.length === 0,
    "swing window (20): на короткой серии пивотов нет — тот же алгоритм, другое окно"
  );

  // Длинный треугольник: оба окна находят ОДНУ вершину,
  // подтверждение swing ровно на ширину окна позже.
  const values: number[] = [];

  for (let i = 0; i <= 22; i++) {
    values.push(100 + i);
  }

  for (let i = 23; i <= 44; i++) {
    values.push(100 + 44 - i);
  }

  const big = validateAndPrepare(
    values.map((v, i) => mk(i, v, v + 0.5)),
    "1h"
  );

  const internalBig = findPivots(
    big,
    internalStructureParams("1h"),
    "high"
  );
  const swingBig = findPivots(
    big,
    swingStructureParams("1h"),
    "high"
  );

  ok(
    internalBig.length === 1 &&
      swingBig.length === 1 &&
      internalBig[0].eventTime.getTime() ===
        swingBig[0].eventTime.getTime(),
    "internal/swing: один алгоритм, одна вершина, один anchor"
  );
  ok(
    internalBig[0].confirmedAt.getTime() ===
      T0 + 26 * HOUR &&
      swingBig[0].confirmedAt.getTime() === T0 + 43 * HOUR,
    "internal/swing: подтверждения различаются ровно на разницу окон"
  );
}

/* ---------- horizon: effectiveCloseTime <= asOf ---------- */

{
  const candles = validateAndPrepare(
    series([
      [98, 100],
      [100, 106],
      [106, 110],
      [109, 104],
      [104, 102]
    ]),
    "1h"
  );

  const boundary = T0 + 5 * HOUR;

  ok(
    horizonCandles(candles, new Date(boundary)).length === 5,
    "horizon: asOf = effectiveCloseTime → свеча участвует (<=)"
  );
  ok(
    horizonCandles(candles, new Date(boundary - 1)).length ===
      4,
    "horizon: asOf = effectiveCloseTime - 1ms → свеча исключена"
  );
}

/* ---------- 19–23. canonical input validation ---------- */

{
  const good = series([
    [100, 105],
    [105, 110]
  ]);

  throws(
    () => validateAndPrepare([good[0], good[0]], "1h"),
    "дубликат",
    "20: дубликат openTime отклонён"
  );

  throws(
    () => validateAndPrepare([good[1], good[0]], "1h"),
    "по возрастанию",
    "19: несортированный вход отклонён (не сортируется молча)"
  );

  throws(
    () =>
      validateAndPrepare(
        [{ ...good[0], closed: false }],
        "1h"
      ),
    "не закрыта",
    "21: non-closed свеча отклонена"
  );

  throws(
    () =>
      validateAndPrepare([{ ...good[0], high: 5 }], "1h"),
    "несогласованный OHLC",
    "22: malformed OHLC отклонён"
  );

  throws(
    () => validateAndPrepare(good, "2h" as never),
    "белого списка",
    "V3: неизвестный timeframe отклонён"
  );

  const prepared = validateAndPrepare(good, "1h");

  throws(
    () => horizonCandles(prepared, new Date("nonsense")),
    "невалидная дата",
    "23: невалидный asOf отклонён"
  );

  throws(
    () =>
      horizonCandles(
        prepared,
        "2026-01-01" as unknown as Date
      ),
    "ожидается Date",
    "23: asOf не-Date отклонён"
  );

  throws(
    () =>
      validateAndPrepare(
        [
          {
            ...good[0],
            open: Number.POSITIVE_INFINITY
          }
        ],
        "1h"
      ),
    "конечное число",
    "V5: non-finite значение отклонено"
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
