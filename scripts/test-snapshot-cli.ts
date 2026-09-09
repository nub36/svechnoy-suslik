/**
 * Тесты разбора CLI snapshot worker (lib/snapshots/cli.ts).
 *
 * Чистые тесты без БД: обе формы --timeframe/--timeframes,
 * белый список таймфреймов, границы top/history.
 *
 * Запуск: npx tsx scripts/test-snapshot-cli.ts
 */

import {
  buildSnapshotHelp,
  parseSnapshotArgs,
  resolveSnapshotInvocation
} from "../lib/snapshots/cli";

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

function throws(
  fn: () => unknown,
  needle: string,
  label: string
) {
  try {
    fn();
    ok(false, `${label} — ошибка НЕ брошена`);
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : String(error);

    ok(
      message.includes(needle),
      `${label} (сообщение: "${message}")`
    );
  }
}

/* ---------- значения по умолчанию ---------- */

const defaults = parseSnapshotArgs([]);

ok(defaults.top === 10, "defaults: top=10");
ok(
  JSON.stringify(defaults.timeframes) === '["1h"]',
  "defaults: timeframe=1h"
);
ok(
  defaults.historyLimit === 1000 ||
    (defaults.historyLimit >= 200 &&
      defaults.historyLimit <= 1000),
  "defaults: history в границах схемы"
);

/* ---------- одиночная форма (прежде существовавшая) ---------- */

const single = parseSnapshotArgs([
  "--top=25",
  "--timeframe=4h",
  "--history=500"
]);

ok(single.top === 25, "single: --top=25");
ok(
  JSON.stringify(single.timeframes) === '["4h"]',
  "single: --timeframe=4h"
);
ok(single.historyLimit === 500, "single: --history=500");

/* ---------- список таймфреймов ---------- */

const multi = parseSnapshotArgs([
  "--top=10",
  "--timeframes=5m,15m,1h,4h,1d",
  "--history=300"
]);

ok(
  JSON.stringify(multi.timeframes) ===
    '["5m","15m","1h","4h","1d"]',
  "multi: полный список 5m/15m/1h/4h/1d"
);

const multiDedupe = parseSnapshotArgs([
  "--timeframes=1h,1h,5m"
]);

ok(
  JSON.stringify(multiDedupe.timeframes) === '["1h","5m"]',
  "multi: дубликаты убираются"
);

throws(
  () => parseSnapshotArgs(["--timeframes=2h"]),
  "Недопустимый timeframe",
  "multi: несуществующий ТФ 2h отклонён"
);

throws(
  () => parseSnapshotArgs(["--timeframe=1x"]),
  "Недопустимый timeframe",
  "single: мусорный ТФ отклонён (раньше тоже, проверяем)"
);

throws(
  () => parseSnapshotArgs(["--top=0"]),
  "--top",
  "границы: top=0 отклонён"
);

throws(
  () => parseSnapshotArgs(["--top=501"]),
  "--top",
  "границы: top=501 отклонён (автопрогона Top-500 нет)"
);

throws(
  () => parseSnapshotArgs(["--history=100"]),
  "--history",
  "границы: history<200 отклонён"
);

throws(
  () => parseSnapshotArgs(["--history=1001"]),
  "--history",
  "границы: history>1000 отклонён"
);

throws(
  () => parseSnapshotArgs(["--top=abc"]),
  "--top",
  "границы: не-число отклонено"
);

/* ---------- --help/-h и неизвестные флаги (регрессия VPS-инцидента) ---------- */

// VPS-факт: `snapshot-worker --help` тоже молча запускал worker
// с defaults (остановлен Ctrl+C до прогона). Теперь help раньше всего.

ok(
  resolveSnapshotInvocation(["--help"]).kind === "help",
  "resolve(--help): режим help"
);
ok(
  resolveSnapshotInvocation(["-h"]).kind === "help",
  "resolve(-h): режим help"
);
ok(
  resolveSnapshotInvocation(["--help", "--top=3"]).kind === "help",
  "resolve: --help приоритетнее остальных аргументов"
);

const snapHelp = resolveSnapshotInvocation(["--help"]);

ok(
  snapHelp.kind === "help" && !("options" in snapHelp),
  "resolve(--help): опций run НЕТ"
);

for (const bad of ["--foobar", "--hist=5", "--timeframee=1h", "--tops=3", "serve"]) {
  const r = resolveSnapshotInvocation([bad]);

  ok(
    r.kind === "error",
    `resolve(${bad}): отклонён (не тихий defaults)`
  );
}

const snapUnknown = resolveSnapshotInvocation(["--foobar"]);

ok(
  snapUnknown.kind === "error" &&
    snapUnknown.message.includes("Неизвестный флаг"),
  "resolve(--foobar): понятное сообщение"
);

const snapRun = resolveSnapshotInvocation(["--top=3", "--timeframe=4h"]);

ok(snapRun.kind === "run", "resolve(--top=3 --timeframe=4h): режим run");
ok(
  snapRun.kind === "run" &&
    snapRun.options.top === 3 &&
    JSON.stringify(snapRun.options.timeframes) === '["4h"]',
  "resolve(--top=3 --timeframe=4h): опции корректны"
);

const snapHelpText = buildSnapshotHelp();

for (const needle of [
  "--top=",
  "по умолчанию 10",
  "--timeframes=",
  "--history=",
  "PostgreSQL",
  "npx tsx scripts/snapshot-worker.ts"
]) {
  ok(
    snapHelpText.includes(needle),
    `buildSnapshotHelp: содержит "${needle}"`
  );
}

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
