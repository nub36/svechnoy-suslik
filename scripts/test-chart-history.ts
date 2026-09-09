/**
 * Тесты подгрузки истории графика (lib/chart/history.ts):
 * валидация cursor-параметра before, серверный лимит,
 * слияние батчей без дублей.
 *
 * Запуск: npx tsx scripts/test-chart-history.ts
 */

import {
  candlesIntegrityOk,
  mergeOlder,
  nextStatusAfterListFailure,
  parseHistoryLimit,
  resolveSymbolFromList,
  validateCursor,
  type ChartStatus
} from "../lib/chart/history";

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

/* ---------- validateCursor ---------- */

ok(validateCursor(null).ok === false, "cursor: null отклонён");
ok(validateCursor(undefined).ok === false, "cursor: undefined отклонён");
ok(validateCursor("").ok === false, "cursor: пустая строка отклонена");
ok(validateCursor("  ").ok === false, "cursor: пробелы отклонены");
ok(
  validateCursor("abc").ok === false,
  "cursor: не-число отклонено"
);
ok(
  validateCursor("1.5").ok === false,
  "cursor: дробное отклонено"
);
ok(
  validateCursor("-100").ok === false,
  "cursor: отрицательное отклонено"
);
ok(validateCursor("0").ok === false, "cursor: ноль отклонён");
ok(
  validateCursor(String(Date.now() + 30 * 24 * 60 * 60 * 1000)).ok ===
    false,
  "cursor: далеко в будущем отклонён"
);

const good = validateCursor("1690000000000");

ok(good.ok === true, "cursor: валидное число принимается");
ok(
  good.ok && good.ms === 1690000000000,
  "cursor: значение передаётся как есть"
);

const goodNow = validateCursor(String(Date.now() - 1000));

ok(goodNow.ok === true, "cursor: свежий timestamp принимается");

/* ---------- parseHistoryLimit ---------- */

ok(parseHistoryLimit(null) === 300, "limit: нет параметра — 300");
ok(parseHistoryLimit("abc") === 300, "limit: мусор — 300 (не ошибка)");
ok(parseHistoryLimit("10") === 300, "limit: ниже минимума — 300");
ok(parseHistoryLimit("5000") === 300, "limit: выше максимума — 300");
ok(parseHistoryLimit("50") === 50, "limit: минимум 50 принимается");
ok(parseHistoryLimit("1000") === 1000, "limit: максимум 1000 принимается");
ok(parseHistoryLimit("600") === 600, "limit: обычное значение");
ok(
  parseHistoryLimit("10.5") === 300,
  "limit: дробное — 300"
);

/* ---------- mergeOlder ---------- */

type P = { time: number; value: number };

// обычный prepend
{
  const current: P[] = [
    { time: 100, value: 1 },
    { time: 200, value: 2 }
  ];
  const older: P[] = [
    { time: 10, value: 9 },
    { time: 50, value: 5 }
  ];

  const { merged, added } = mergeOlder(current, older);

  ok(added === 2, "merge: добавлены 2 старые свечи");
  ok(
    JSON.stringify(merged.map((p) => p.time)) === "[10,50,100,200]",
    "merge: порядок ASC сохранён"
  );
}

// пересечение по границе (дубли не попадают)
{
  const current: P[] = [
    { time: 100, value: 1 },
    { time: 200, value: 2 }
  ];
  const older: P[] = [
    { time: 50, value: 5 },
    { time: 100, value: 1 },
    { time: 150, value: 1.5 }
  ];

  const { merged, added } = mergeOlder(current, older);

  ok(added === 1, "merge: совпадающая граница и новее — отброшены");
  ok(
    JSON.stringify(merged.map((p) => p.time)) === "[50,100,200]",
    "merge: без дублей после границы"
  );
}

// дубли внутри самого батча истории
{
  const current: P[] = [{ time: 100, value: 1 }];
  const older: P[] = [
    { time: 10, value: 9 },
    { time: 10, value: 9 },
    { time: 10, value: 9 },
    { time: 20, value: 8 }
  ];

  const { merged, added } = mergeOlder(current, older);

  ok(added === 2, "merge: дубли внутри батча убраны");
  ok(
    JSON.stringify(merged.map((p) => p.time)) === "[10,20,100]",
    "merge: порядок после чистки внутренний"
  );
}

// батч без ничего нового (все свечи уже есть/новее)
{
  const current: P[] = [{ time: 100, value: 1 }];
  const older: P[] = [
    { time: 100, value: 1 },
    { time: 300, value: 3 }
  ];

  const { merged, added } = mergeOlder(current, older);

  ok(added === 0, "merge: нечего добавлять — added=0");
  ok(merged === current, "merge: текущее окно не копируется зря");
}

// пустые входы
{
  const empty: P[] = [];
  const r1 = mergeOlder(empty, [{ time: 1, value: 1 }]);

  ok(r1.added === 1 && r1.merged.length === 1,
    "merge: пустое текущее окно — батч становится окном");

  const r2 = mergeOlder([{ time: 1, value: 1 }], empty);

  ok(r2.added === 0 && r2.merged.length === 1,
    "merge: пустой батч — окно без изменений");
}

// большая последовательность: 3 батча по 300 без дублей
// (каждый батч ASC, как отдаёт API; каждый следующий — старее)
{
  let window: P[] = [];

  for (let batch = 0; batch < 3; batch++) {
    const older: P[] = [];
    const base = (3 - batch) * 1000 - 299;

    for (let i = 0; i < 300; i++) {
      older.push({
        time: base + i,
        value: i
      });
    }

    const result = mergeOlder(window, older);

    window = result.merged;

    ok(result.added === 300, `merge: батч ${batch + 1} — 300 новых`);
  }

  ok(window.length === 900, "merge: всего 900 уникальных свечей");

  let sorted = true;

  for (let i = 1; i < window.length; i++) {
    if (window[i].time <= window[i - 1].time) {
      sorted = false;
      break;
    }
  }

  ok(sorted, "merge: строгий ASC на всей последовательности");
}

/* ---------- состояние графика (регрессия VPS: «Нет активов» + пустой canvas) ---------- */

// resolveSymbolFromList: выбранный символ не сбрасывается пустым списком
ok(
  resolveSymbolFromList("BTC", [
    { symbol: "BTC" },
    { symbol: "ETH" }
  ]) === "BTC",
  "symbol: предпочтительный есть в списке — остаётся"
);
ok(
  resolveSymbolFromList("BTC", [
    { symbol: "ETH" },
    { symbol: "SOL" }
  ]) === "ETH",
  "symbol: предпочтительного нет в списке — первый из списка"
);
ok(
  resolveSymbolFromList("BTC", []) === null,
  "symbol: пустой список — null (НЕ сброс выбранного)"
);
ok(
  resolveSymbolFromList(null, [{ symbol: "ZEC" }]) === "ZEC",
  "symbol: без предпочтительного — первый"
);
ok(
  resolveSymbolFromList(undefined, []) === null,
  "symbol: ничего ниоткуда — null"
);

// «липкость» статуса: list-failure не убивает рабочий график
const sticky: ChartStatus[] = [
  "loading",
  "loading-data",
  "empty",
  "error",
  "ok"
];

ok(
  nextStatusAfterListFailure("ok") === "ok",
  "status: ok «липкий» — список не роняет график (гонка VPS)"
);
for (const s of sticky.filter((x) => x !== "ok")) {
  ok(
    nextStatusAfterListFailure(s) === "error",
    `status: ${s} + ошибка списка → error`
  );
}

// целостность: count > 0 при пустом массиве — запрещено
ok(
  candlesIntegrityOk(306, [{ time: 1 }]) === true,
  "integrity: count>0 и свечи есть — ОК"
);
ok(
  candlesIntegrityOk(306, []) === false,
  "integrity: count>0 при пустом массиве — НАРУШЕНО (не применять)"
);
ok(
  candlesIntegrityOk(0, []) === true,
  "integrity: честный пустой ответ — ОК"
);
ok(
  candlesIntegrityOk(null, []) === true,
  "integrity: count нет — решение по массиву"
);
ok(
  candlesIntegrityOk(undefined, [{ time: 1 }]) === true,
  "integrity: count нет, свечи есть — ОК"
);

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
