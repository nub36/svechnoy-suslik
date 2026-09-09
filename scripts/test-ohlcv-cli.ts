/**
 * Тесты разбора CLI OHLCV worker (lib/ohlcv/cli.ts).
 *
 * Чистые тесты без БД: проверяют белый список таймфреймов,
 * границы опций и итоговый разбор аргументов воркера —
 * ровно тот слой, где раньше мог пройти мусор
 * вида --timeframes=1x (невалидированный cast).
 *
 * Запуск: npx tsx scripts/test-ohlcv-cli.ts
 */

import {
  buildOhlcvHelp,
  formatTimeframeSummary,
  parseCliNumber,
  parseOhlcvArgs,
  parseTimeframeList,
  resolveOhlcvInvocation,
  wantsHelp
} from "../lib/ohlcv/cli";
import {
  buildConfirmCommand,
  evaluateRunScale,
  formatPlanReport,
  LARGE_RUN_TASK_THRESHOLD,
  preflightTitle
} from "../lib/ohlcv/plan";
import { readFileSync } from "node:fs";

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

function throws(fn: () => unknown, needle: string, label: string) {
  try {
    fn();
    ok(false, `${label} — ошибка НЕ брошена`);
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);

    ok(message.includes(needle), `${label} (сообщение: "${message}")`);
  }
}

/* ---------- parseTimeframeList ---------- */

const fallback = ["1h"] as const;

const tfDefault = parseTimeframeList(
  undefined,
  fallback as unknown as string[] as never
) as string[];

ok(
  JSON.stringify(tfDefault) === '["1h"]',
  "parseTimeframeList: без значения — фолбэк 1h"
);

ok(
  tfDefault !== (fallback as unknown as string[]),
  "parseTimeframeList: фолбэк копируется, а не отдаётся по ссылке"
);

ok(
  JSON.stringify(parseTimeframeList("", ["1h"] as never)) === '["1h"]',
  "parseTimeframeList: пустая строка — фолбэк"
);

ok(
  JSON.stringify(parseTimeframeList("5m,15m,1h,4h,1d", ["1h"] as never)) ===
    '["5m","15m","1h","4h","1d"]',
  "parseTimeframeList: полный набор 5m/15m/1h/4h/1d"
);

ok(
  JSON.stringify(parseTimeframeList(" 1h , 4h ,", ["1h"] as never)) ===
    '["1h","4h"]',
  "parseTimeframeList: пробелы и хвостовая запятая"
);

ok(
  JSON.stringify(parseTimeframeList("1h,1h,4h", ["1h"] as never)) ===
    '["1h","4h"]',
  "parseTimeframeList: дубликаты убираются, порядок сохранён"
);

ok(
  JSON.stringify(parseTimeframeList("4h,5m", ["1h"] as never)) ===
    '["4h","5m"]',
  "parseTimeframeList: порядок аргументов сохраняется"
);

throws(
  () => parseTimeframeList("1x", ["1h"] as never),
  '"1x"',
  "parseTimeframeList: мусорный таймфрейм отклонён с именем"
);

throws(
  () => parseTimeframeList("1H", ["1h"] as never),
  "Разрешены",
  "parseTimeframeList: регистр строгий (1H отклонён)"
);

/* ---------- parseCliNumber ---------- */

ok(parseCliNumber(undefined, 300, { name: "limit", min: 50, max: 1000 }) === 300,
  "parseCliNumber: нет значения — фолбэк");
ok(parseCliNumber("", 300, { name: "limit", min: 50, max: 1000 }) === 300,
  "parseCliNumber: пустая строка — фолбэк");
ok(parseCliNumber("42", 300, { name: "limit", min: 0, max: 1000 }) === 42,
  "parseCliNumber: обычное число");

throws(
  () => parseCliNumber("abc", 300, { name: "limit", min: 50, max: 1000 }),
  "--limit",
  "parseCliNumber: не-число отклонено с именем опции"
);

throws(
  () => parseCliNumber("10.5", 300, { name: "limit", min: 50, max: 1000 }),
  "целое",
  "parseCliNumber: дробное отклонено"
);

throws(
  () => parseCliNumber("0", 10, { name: "top", min: 1, max: 500 }),
  "от 1 до 500",
  "parseCliNumber: ниже минимума отклонено"
);

throws(
  () => parseCliNumber("501", 10, { name: "top", min: 1, max: 100 }),
  "от 1 до 100",
  "parseCliNumber: выше максимума universe отклонено"
);

/* ---------- parseOhlcvArgs ---------- */

const defaults = parseOhlcvArgs([], {});

ok(defaults.top === 10, "parseOhlcvArgs: top по умолчанию 10 (не Top-500)");
ok(
  JSON.stringify(defaults.timeframes) === '["1h"]',
  "parseOhlcvArgs: таймфрейм по умолчанию 1h"
);
ok(defaults.limit === 300, "parseOhlcvArgs: limit по умолчанию 300");
ok(defaults.requestDelayMs === 250, "parseOhlcvArgs: delay по умолчанию 250");
ok(defaults.once === false, "parseOhlcvArgs: без --once цикл продолжается");
ok(defaults.intervalMs === 3600000, "parseOhlcvArgs: интервал по умолчанию 1 час");

const explicit = parseOhlcvArgs(
  ["--top=3", "--timeframes=5m,15m", "--limit=100", "--delay=0", "--once"],
  {}
);

ok(explicit.top === 3, "parseOhlcvArgs: --top=3");
ok(
  JSON.stringify(explicit.timeframes) === '["5m","15m"]',
  "parseOhlcvArgs: --timeframes=5m,15m"
);
ok(explicit.limit === 100, "parseOhlcvArgs: --limit=100");
ok(explicit.requestDelayMs === 0, "parseOhlcvArgs: --delay=0");
ok(explicit.once === true, "parseOhlcvArgs: --once");

const fromEnv = parseOhlcvArgs([], {
  OHLCV_TOP: "7",
  OHLCV_ONCE: "1",
  OHLCV_TIMEFRAMES: "4h",
  OHLCV_LIMIT: "200"
});

ok(fromEnv.top === 7, "parseOhlcvArgs: env OHLCV_TOP");
ok(fromEnv.once === true, "parseOhlcvArgs: env OHLCV_ONCE=1");
ok(
  JSON.stringify(fromEnv.timeframes) === '["4h"]',
  "parseOhlcvArgs: env OHLCV_TIMEFRAMES"
);
ok(fromEnv.limit === 200, "parseOhlcvArgs: env OHLCV_LIMIT");

const cliOverEnv = parseOhlcvArgs(["--timeframes=5m"], {
  OHLCV_TIMEFRAMES: "4h"
});

ok(
  JSON.stringify(cliOverEnv.timeframes) === '["5m"]',
  "parseOhlcvArgs: CLI приоритетнее env"
);

throws(
  () => parseOhlcvArgs(["--timeframes=1x"], {}),
  "Недопустимый timeframe",
  "parseOhlcvArgs: мусорный таймфрейм отклонён целиком"
);

throws(
  () => parseOhlcvArgs(["--top=501"], {}),
  "от 1 до 100",
  "parseOhlcvArgs: top>100 (вне universe) отклонён"
);
ok(
  parseOhlcvArgs(["--top=100"], {}).top === 100,
  "parseOhlcvArgs: граница universe top=100 разрешена"
);

throws(
  () => parseOhlcvArgs(["--limit=10"], {}),
  "--limit",
  "parseOhlcvArgs: limit ниже 50 отклонён"
);

/* ---------- formatTimeframeSummary ---------- */

ok(formatTimeframeSummary({}).length === 0,
  "formatTimeframeSummary: пусто — нет строк");

const lines = formatTimeframeSummary({
  "1h": {
    markets: 48,
    fetched: 300,
    written: 300,
    created: 280,
    updated: 20,
    skippedInvalid: 1,
    errors: 0
  },
  "5m": {
    markets: 48,
    fetched: 0,
    written: 0,
    created: 0,
    updated: 0,
    skippedInvalid: 0,
    errors: 2
  }
});

ok(lines.length === 2, "formatTimeframeSummary: строка на каждый ТФ");
ok(
  lines.some((l) => l.includes("1h") && l.includes("создано=280") && l.includes("обновлено=20")),
  "formatTimeframeSummary: создано/обновлено выводятся"
);
ok(
  lines.some((l) => l.includes("5m") && l.includes("ошибок=2")),
  "formatTimeframeSummary: ошибки по ТФ выводятся"
);

/* ---------- --help/-h и неизвестные флаги (регрессия VPS-инцидента) ---------- */

// VPS-факт: `ohlcv-worker --help` молча игнорировал --help и запускал
// реальный проход с defaults. Теперь help обязан выбираться РАНЬШЕ всего.

ok(wantsHelp(["--help"]) === true, "wantsHelp: --help");
ok(wantsHelp(["-h"]) === true, "wantsHelp: -h");
ok(wantsHelp(["--top=3"]) === false, "wantsHelp: обычный запуск — не help");
ok(wantsHelp([]) === false, "wantsHelp: пустой список — не help");

const helpCall = resolveOhlcvInvocation(["--help"]);

ok(helpCall.kind === "help", "resolve(--help): режим help");
ok(
  helpCall.kind === "help" && !("options" in helpCall),
  "resolve(--help): опций run НЕТ (worker не запустится)"
);

ok(
  resolveOhlcvInvocation(["-h"]).kind === "help",
  "resolve(-h): режим help"
);
ok(
  resolveOhlcvInvocation(["--help", "--top=3"]).kind === "help",
  "resolve: --help приоритетнее остальных аргументов"
);

// unknown/опечатанные флаги — ошибка, а не тихий запуск с defaults
const unknown = resolveOhlcvInvocation(["--foobar"]);

ok(unknown.kind === "error", "resolve(--foobar): режим error");
ok(
  unknown.kind === "error" && unknown.message.includes("Неизвестный флаг"),
  "resolve(--foobar): понятное сообщение"
);
ok(
  unknown.kind === "error" && unknown.message.includes("--help"),
  "resolve(--foobar): подсказка про --help"
);

for (const typo of ["--onc", "--onc=1", "--to=5", "--timeframess=1h", "--lim=100"]) {
  const r = resolveOhlcvInvocation([typo]);

  ok(
    r.kind === "error",
    `resolve(${typo}): опечатка отклонена (не тихий defaults)`
  );
}

ok(
  resolveOhlcvInvocation(["serve"]).kind === "error",
  "resolve: позиционный аргумент отклонён"
);

throws(
  () => parseOhlcvArgs(["--foobar"], {}),
  "Неизвестный флаг",
  "parseOhlcvArgs: неизвестный флаг бросает ошибку"
);

// обычный запуск по-прежнему разбирается как run
const runCall = resolveOhlcvInvocation(["--top=3", "--once"]);

ok(runCall.kind === "run", "resolve(--top=3 --once): режим run");
ok(
  runCall.kind === "run" &&
    runCall.options.top === 3 &&
    runCall.options.once === true,
  "resolve(--top=3 --once): опции корректны"
);

// справка содержит параметры, defaults и примеры
const helpText = buildOhlcvHelp();

for (const needle of [
  "--top=",
  "по умолчанию 10",
  "5m,15m,1h,4h,1d",
  "по умолчанию 1h",
  "--limit=",
  "--delay=",
  "--once",
  "--help, -h",
  "npx tsx scripts/ohlcv-worker.ts"
]) {
  ok(
    helpText.includes(needle),
    `buildOhlcvHelp: содержит "${needle}"`
  );
}

/* ---------- --plan и предохранитель большого запуска ---------- */

// --plan обязан давать plan-режим (НЕ run): план не вызывает
// run/sync-код и не пишет в БД — это гарантируется тем, что
// воркер импортирует sync только при kind === "run".
const planCall = resolveOhlcvInvocation(["--plan"]);

ok(planCall.kind === "plan", "resolve(--plan): режим plan");
ok(
  planCall.kind === "plan" && planCall.options.top === 10,
  "resolve(--plan): defaults доступны для показа"
);

const planWithArgs = resolveOhlcvInvocation([
  "--plan",
  "--top=3",
  "--timeframes=5m,15m",
  "--limit=100"
]);

ok(planWithArgs.kind === "plan", "resolve(--plan --top=3 ...): план");
ok(
  planWithArgs.kind === "plan" &&
    planWithArgs.options.top === 3 &&
    JSON.stringify(planWithArgs.options.timeframes) === '["5m","15m"]' &&
    planWithArgs.options.limit === 100,
  "resolve(--plan ...): опции для показа разобраны"
);

ok(
  resolveOhlcvInvocation(["--help", "--plan"]).kind === "help",
  "resolve: --help приоритетнее --plan"
);

ok(
  resolveOhlcvInvocation(["--plan", "--foobar"]).kind === "error",
  "resolve(--plan --foobar): неизвестный флаг остаётся ошибкой"
);

const confirmCall = resolveOhlcvInvocation(["--confirm-large-run"]);

ok(
  confirmCall.kind === "run" &&
    confirmCall.options.confirmLargeRun === true,
  "resolve(--confirm-large-run): флаг разбирается"
);

const noConfirmCall =
  resolveOhlcvInvocation(["--top=3"]);

ok(
  noConfirmCall.kind === "run" &&
    noConfirmCall.options.confirmLargeRun === false,
  "resolve: без флага confirm=false"
);

// предохранитель
ok(LARGE_RUN_TASK_THRESHOLD === 500, "порог большого запуска = 500 задач");

ok(
  evaluateRunScale(240, false).allowed === true,
  "guard: Top-10 × 5 ТФ (240 задач) разрешён без confirm"
);
ok(
  evaluateRunScale(499, false).allowed === true,
  "guard: ниже порога — разрешено"
);
ok(
  evaluateRunScale(500, false).allowed === true,
  "guard: ровно граница (500) — разрешено"
);
ok(
  evaluateRunScale(501, false).allowed === false,
  "guard: выше порога — отказ"
);
ok(
  evaluateRunScale(2357, false).allowed === false,
  "guard: Top-500 × 1 ТФ (~2357) — отказ"
);
ok(
  evaluateRunScale(2357, true).allowed === true,
  "guard: выше порога + confirm — разрешено"
);

const refusal = evaluateRunScale(1200, false);

ok(
  refusal.message?.includes("--confirm-large-run") === true,
  "guard: отказ называет команду подтверждения"
);
ok(
  refusal.message?.includes("1200") === true,
  "guard: отказ называет число задач"
);

const confirmNote = evaluateRunScale(1200, true);

ok(
  confirmNote.message?.includes("--confirm-large-run") === true,
  "guard: при confirm выводится пометка"
);

// отчёт плана (чистая функция)
const planLines = formatPlanReport(
  {
    top: 10,
    timeframes: ["5m", "15m", "1h", "4h", "1d"] as never,
    limit: 300,
    requestDelayMs: 250
  },
  {
    assets: 10,
    markets: 48,
    tasks: 240,
    maxCandles: 72000,
    apiRequests: 240,
    byExchange: { BINANCE: 10, BYBIT: 10, GATE: 10, KUCOIN: 9, BINGX: 9 }
  }
);

// семантика заголовка: «Режим PLAN» — ТОЛЬКО при явном --plan
ok(
  preflightTitle(true).includes("Режим PLAN") &&
    preflightTitle(true).includes("PostgreSQL не изменяется") &&
    preflightTitle(true).includes("API бирж не вызываются"),
  "preflight title(--plan): Режим PLAN + read-only обещания"
);
ok(
  preflightTitle(false).startsWith(
    "Предварительная оценка запуска"
  ),
  "preflight title(run): «Предварительная оценка запуска»"
);
ok(
  !preflightTitle(false).includes("Режим PLAN"),
  "preflight title(run): НЕ называет себя PLAN-режимом"
);
ok(
  !planLines.some((l) => l.includes("Режим PLAN")),
  "plan report: заголовок отделён от тела отчёта"
);
ok(
  planLines.some((l) => l.includes("Top-N: 10")),
  "plan report: тело отчёта сохранено"
);
ok(
  planLines.some((l) => l.includes("240")),
  "plan report: число задач"
);
ok(
  planLines.some((l) => l.includes("≈240")),
  "plan report: оценка API-запросов"
);
ok(
  planLines.some((l) => l.includes("BINANCE")),
  "plan report: разбивка по биржам"
);

const emptyPlan = formatPlanReport(
  {
    top: 10,
    timeframes: ["1h"] as never,
    limit: 300,
    requestDelayMs: 250
  },
  {
    assets: 0,
    markets: 0,
    tasks: 0,
    maxCandles: 0,
    apiRequests: 0,
    byExchange: {}
  }
);

ok(
  emptyPlan.some((l) => l.includes("рынков не найдено")),
  "plan report: пустая база — без падения"
);

// команда повтора
const cmd = buildConfirmCommand({
  top: 50,
  timeframes: ["1h"] as never,
  limit: 300,
  requestDelayMs: 250,
  once: true
});

ok(
  cmd.includes("--confirm-large-run") && cmd.includes("--top=50") &&
    cmd.includes("--once"),
  "confirm command: содержит флаг подтверждения и исходные опции"
);

/* ---------- структурные гарантии воркера (без его запуска) ---------- */

// Регрессия UX/безопасности: при блокировке большим
// запуском worker НЕ должен успеть ни импортировать
// sync/биржи, ни начать запись. Проверяем порядок в
// исходнике: предохранитель стоит РАНЬШЕ динамического
// импорта lib/ohlcv/sync, заголовок — через preflightTitle.
const workerSource = readFileSync(
  "scripts/ohlcv-worker.ts",
  "utf8"
);

const guardIdx = workerSource.indexOf(
  "evaluateRunScale("
);
const syncImportIdx = workerSource.indexOf(
  '"../lib/ohlcv/sync"'
);
const titleIdx = workerSource.indexOf(
  "preflightTitle("
);

ok(
  guardIdx >= 0,
  "worker source: предохранитель присутствует"
);
ok(
  syncImportIdx >= 0,
  "worker source: sync импортируется динамически"
);
ok(
  guardIdx < syncImportIdx,
  "worker source: guard ДО импорта sync/бирж (exit=1 раньше API)"
);
ok(
  titleIdx >= 0,
  "worker source: заголовок через preflightTitle"
);
ok(
  !workerSource.includes('console.log("Режим PLAN'),
  "worker source: PLAN-баннер только через preflightTitle"
);

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
