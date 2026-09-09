/**
 * Тесты freshness (lib/data/freshness.ts) — чистые,
 * с фиксированным now (никакой зависимости от часов).
 *
 * Запуск: npx tsx scripts/test-freshness.ts
 */

import {
  candleFreshness,
  DELAYED_WITHIN_INTERVALS,
  FRESH_WITHIN_INTERVALS,
  planCommandForTimeframe,
  splitClosedOpenFreshness,
  TIMEFRAME_MINUTES
} from "../lib/data/freshness";

let passed = 0;
let total = 0;

function ok(condition: boolean, label: string) {
  total += 1;

  if (condition) {
    passed += 1;
  } else {
    console.error(`FAIL: ${label}`);
  }
}

// фиксированный момент: 09.09.2026 12:00:00 UTC
const NOW = new Date("2026-09-09T12:00:00Z");

function minutesAgo(min: number): Date {
  return new Date(NOW.getTime() - min * 60000);
}

/* ---------- длительности таймфреймов ---------- */

ok(TIMEFRAME_MINUTES["5m"] === 5, "5m = 5 минут");
ok(TIMEFRAME_MINUTES["15m"] === 15, "15m = 15 минут");
ok(TIMEFRAME_MINUTES["1h"] === 60, "1h = 60 минут");
ok(TIMEFRAME_MINUTES["4h"] === 240, "4h = 240 минут");
ok(TIMEFRAME_MINUTES["1d"] === 1440, "1d = 1440 минут");

/* ---------- АКТУАЛЬНО ---------- */

// 1h: последняя закрытая свеча 30 минут назад (текущая формируется)
ok(
  candleFreshness("1h", minutesAgo(30), NOW).status === "fresh",
  "1h, age 30м: АКТУАЛЬНО (≤2 интервала)"
);
// граница: ровно 2 интервала
ok(
  candleFreshness("1h", minutesAgo(120), NOW).status === "fresh",
  "1h, age 120м (ровно 2D): АКТУАЛЬНО"
);
// 1d свеча 10 минут назад — НЕ устарела
ok(
  candleFreshness("1d", minutesAgo(10), NOW).status === "fresh",
  "1d, age 10м: АКТУАЛЬНО (не считать устаревшим через 10 минут)"
);
// 1d свеча 30 часов назад (1.25 интервала) — АКТУАЛЬНО
ok(
  candleFreshness("1d", minutesAgo(30 * 60), NOW).status === "fresh",
  "1d, age 30ч: АКТУАЛЬНО"
);
// 5m свеча 5 минут назад
ok(
  candleFreshness("5m", minutesAgo(5), NOW).status === "fresh",
  "5m, age 5м: АКТУАЛЬНО"
);
// свеча из будущего — не падает
ok(
  candleFreshness("1h", minutesAgo(-15), NOW).status === "fresh",
  "1h, age -15м (будущее): АКТУАЛЬНО"
);

/* ---------- ЗАДЕРЖКА ---------- */

ok(
  candleFreshness("5m", minutesAgo(25), NOW).status === "delayed",
  "5m, age 25м (>2D=10, ≤6D=30): ЗАДЕРЖКА"
);
ok(
  candleFreshness("1h", minutesAgo(300), NOW).status === "delayed",
  "1h, age 300м (5 интервалов): ЗАДЕРЖКА"
);
// граница: ровно 6 интервалов
ok(
  candleFreshness("1h", minutesAgo(360), NOW).status === "delayed",
  "1h, age 360м (ровно 6D): ЗАДЕРЖКА"
);

/* ---------- УСТАРЕЛО ---------- */

ok(
  candleFreshness("5m", minutesAgo(45), NOW).status === "stale",
  "5m, age 45м (>6D): УСТАРЕЛО"
);
ok(
  candleFreshness("1h", minutesAgo(361), NOW).status === "stale",
  "1h, age 361м (>6D): УСТАРЕЛО"
);
ok(
  candleFreshness("1d", minutesAgo(7 * 1440), NOW).status === "stale",
  "1d, age 7 суток: УСТАРЕЛО"
);

/* ---------- НЕТ ДАННЫХ ---------- */

ok(
  candleFreshness("1h", null, NOW).status === "missing",
  "1h, свечи нет: НЕТ ДАННЫХ"
);
ok(
  candleFreshness("1h", undefined, NOW).status === "missing",
  "1h, undefined: НЕТ ДАННЫХ"
);
ok(
  candleFreshness("2h", minutesAgo(10), NOW).status === "missing",
  "неизвестный ТФ 2h: НЕТ ДАННЫХ"
);
ok(
  candleFreshness("1h", "не дата", NOW).status === "missing",
  "1h, мусор вместо даты: НЕТ ДАННЫХ"
);

/* ---------- метки и возраст ---------- */

ok(
  candleFreshness("1h", minutesAgo(30), NOW).label === "АКТУАЛЬНО",
  "метка АКТУАЛЬНО на русском"
);
ok(
  candleFreshness("1h", minutesAgo(300), NOW).label === "ЗАДЕРЖКА",
  "метка ЗАДЕРЖКА на русском"
);
ok(
  candleFreshness("1h", minutesAgo(400), NOW).label === "УСТАРЕЛО",
  "метка УСТАРЕЛО на русском"
);
ok(
  candleFreshness("1h", null, NOW).label === "НЕТ ДАННЫХ",
  "метка НЕТ ДАННЫХ на русском"
);
ok(
  candleFreshness("1h", minutesAgo(90), NOW).ageMinutes === 90,
  "ageMinutes считается точно"
);
ok(
  candleFreshness("1h", null, NOW).ageMinutes === null,
  "ageMinutes null без данных"
);

/* ---------- входные форматы ---------- */

ok(
  candleFreshness("1h", minutesAgo(30).getTime(), NOW).status === "fresh",
  "вход: ms-число"
);
ok(
  candleFreshness("1h", minutesAgo(30).toISOString(), NOW).status ===
    "fresh",
  "вход: ISO-строка"
);

/* ---------- константы формулы и команда plan ---------- */

ok(FRESH_WITHIN_INTERVALS === 2, "порог АКТУАЛЬНО = 2 интервала");
ok(DELAYED_WITHIN_INTERVALS === 6, "порог ЗАДЕРЖКА = 6 интервалов");

ok(
  planCommandForTimeframe("5m") ===
    "npx tsx scripts/ohlcv-worker.ts --plan --top=10 --timeframes=5m --limit=300",
  "команда plan для отсутствующего ТФ"
);

/* ---------- разделение closed/open (регрессия VPS) ---------- */

// Факт VPS: последняя ЗАКРЫТАЯ 1h свеча = 16:00 UTC,
// текущая ОТКРЫТАЯ = 17:00 UTC; freshness обязан
// считаться от 16:00, open — только отдельной строкой.
{
  const now = new Date("2026-09-09T17:10:00Z");
  const closed16 = Date.parse("2026-09-09T16:00:00Z");
  const open17 = Date.parse("2026-09-09T17:00:00Z");

  const split = splitClosedOpenFreshness(
    "1h",
    [closed16],
    [open17],
    now
  );

  ok(split.lastClosedOpenTime === closed16,
    "split: freshness timestamp = 16:00 (закрытая)");
  ok(split.lastOpenCandleOpenTime === open17,
    "split: open 17:00 хранится отдельно");
  ok(split.freshness.ageMinutes === 70,
    "split: возраст считается от ЗАКРЫТОЙ (70 минут)");
  ok(split.freshness.status === "fresh",
    "split: закрытые данные актуальны (70м ≤ 2D)");
  // контрольный факт: если бы open влез в freshness,
  // возраст был бы 10 минут — «свежее», чем правда
  ok(split.freshness.ageMinutes !== 10,
    "split: открытая свеча НЕ омолаживает freshness");
}

// только closed (open отсутствует)
{
  const now = new Date("2026-09-09T17:10:00Z");
  const split = splitClosedOpenFreshness(
    "1h",
    [Date.parse("2026-09-09T16:00:00Z")],
    [],
    now
  );

  ok(split.lastClosedOpenTime === Date.parse("2026-09-09T16:00:00Z"),
    "split: только closed — freshness от неё");
  ok(split.lastOpenCandleOpenTime === null,
    "split: открытой свечи нет — честный null");
}

// закрытые + более новая открытая; несколько значений
{
  const now = new Date("2026-09-09T17:10:00Z");
  const split = splitClosedOpenFreshness(
    "1h",
    [
      Date.parse("2026-09-09T12:00:00Z"),
      Date.parse("2026-09-09T16:00:00Z")
    ],
    [
      Date.parse("2026-09-09T15:00:00Z"),
      Date.parse("2026-09-09T17:00:00Z")
    ],
    now
  );

  ok(split.lastClosedOpenTime === Date.parse("2026-09-09T16:00:00Z"),
    "split: максимум по ЗАКРЫТЫМ");
  ok(split.lastOpenCandleOpenTime === Date.parse("2026-09-09T17:00:00Z"),
    "split: максимум по открытым отдельно");
}

// закрытых нет вовсе, но открытая есть:
// freshness закрытых данных — честное НЕТ ДАННЫХ
{
  const now = new Date("2026-09-09T17:10:00Z");
  const split = splitClosedOpenFreshness(
    "1h",
    [],
    [Date.parse("2026-09-09T17:00:00Z")],
    now
  );

  ok(split.freshness.status === "missing",
    "split: закрытых нет — НЕТ ДАННЫХ, open не спасает");
  ok(split.lastOpenCandleOpenTime !== null,
    "split: открытая показывается отдельно");
}

// свечей нет вообще
{
  const split = splitClosedOpenFreshness("1h", [], []);

  ok(split.freshness.status === "missing",
    "split: нет свечей — НЕТ ДАННЫХ");
  ok(split.lastClosedOpenTime === null &&
    split.lastOpenCandleOpenTime === null,
    "split: оба timestamp null");
}

// мусор/null в списках переносится
{
  const split = splitClosedOpenFreshness(
    "1h",
    [null, "мусор", Date.parse("2026-09-09T16:00:00Z")],
    [undefined],
    new Date("2026-09-09T17:10:00Z")
  );

  ok(split.lastClosedOpenTime === Date.parse("2026-09-09T16:00:00Z"),
    "split: null/мусор игнорируются");
  ok(split.lastOpenCandleOpenTime === null,
    "split: пустой open-список");
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
