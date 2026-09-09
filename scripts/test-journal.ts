/**
 * Тесты журнала (lib/observability/journal.ts):
 * кольцевой буфер, маскирование секретов, источник,
 * фильтры и пагинация — чистые функции, без процесса.
 *
 * Запуск: npx tsx scripts/test-journal.ts
 */

import {
  addEntry,
  extractSource,
  filterEntries,
  isSensitiveMessage,
  MAX_JOURNAL_ENTRIES,
  normalizeMessage,
  type JournalEntry
} from "../lib/observability/journal";

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

function entry(
  seq: number,
  level: JournalEntry["level"],
  source: string,
  message: string
): JournalEntry {
  return {
    seq,
    ts: new Date(2026, 8, 9, 12, 0, seq),
    level,
    source,
    message
  };
}

/* ---------- normalizeMessage / extractSource ---------- */

ok(
  normalizeMessage("  a\n\n  b   c ") === "a b c",
  "normalize: переносы/пробелы схлопываются"
);
ok(
  normalizeMessage("x".repeat(500)).length === 400,
  "normalize: длина ограничена 400"
);
ok(
  normalizeMessage("x".repeat(500)).endsWith("…"),
  "normalize: длинное сообщение с многоточием"
);

ok(
  extractSource("[api/chart/markets] Ошибка") ===
    "api/chart/markets",
  "source: тег извлекается"
);
ok(extractSource("just text") === "app", "source: без тега — app");

/* ---------- секреты ---------- */

ok(
  isSensitiveMessage(
    "connection failed: postgresql://user:pw@host/db"
  ) === true,
  "secrets: соединительная строка распознана"
);
ok(
  isSensitiveMessage("AUTH_SECRET=abc") === true,
  "secrets: AUTH_SECRET распознан"
);
ok(
  isSensitiveMessage("Bearer token abc") === true,
  "secrets: token распознан"
);
ok(
  isSensitiveMessage(
    "Ошибка запроса рынков: TypeError"
  ) === false,
  "secrets: обычная ошибка не маскируется"
);

/* ---------- кольцевой буфер ---------- */

let buffer: JournalEntry[] = [];

buffer = addEntry(buffer, {
  ts: new Date(),
  level: "INFO",
  source: "app",
  message: "первая"
});

ok(
  buffer.length === 1 && buffer[0].seq === 1,
  "buffer: первое добавление seq=1"
);

for (let i = 0; i < MAX_JOURNAL_ENTRIES + 50; i++) {
  buffer = addEntry(buffer, {
    ts: new Date(),
    level: "WARN",
    source: "test",
    message: `msg ${i}`
  });
}

ok(
  buffer.length === MAX_JOURNAL_ENTRIES,
  "buffer: размер ограничен MAX_JOURNAL_ENTRIES"
);
ok(
  buffer[0].message === "msg 50",
  "buffer: старые записи вытеснены"
);
ok(
  buffer[buffer.length - 1].seq ===
    buffer[buffer.length - 2].seq + 1,
  "buffer: последовательность seq монотонна"
);

/* ---------- фильтры и пагинация ---------- */

const demo: JournalEntry[] = [
  entry(1, "ERROR", "api/chart/candles", "e1"),
  entry(2, "WARN", "api/search", "w1"),
  entry(3, "INFO", "app", "i1"),
  entry(4, "ERROR", "api/chart/candles", "e2")
];

const all = filterEntries(demo, {});

ok(all.total === 4, "filter: без фильтра — все");
ok(
  all.rows[0].seq === 4,
  "filter: новые сверху"
);
ok(
  all.sources.join(",") ===
    "api/chart/candles,api/search,app",
  "filter: список источников отсортирован"
);

ok(
  filterEntries(demo, { level: "ERROR" }).total === 2,
  "filter: по уровню ERROR"
);
ok(
  filterEntries(demo, { level: "МУСОР" }).total === 4,
  "filter: мусорный уровень игнорируется (все)"
);
ok(
  filterEntries(demo, { source: "api/search" }).total === 1,
  "filter: по источнику"
);

const paged = filterEntries(demo, {
  page: 2,
  pageSize: 2
});

ok(paged.total === 4 && paged.rows.length === 2,
  "pagination: вторая страница содержит 2 записи");
ok(paged.rows[0].seq === 2, "pagination: порядок stable");
ok(
  paged.totalPages === 2,
  "pagination: totalPages = 2"
);
ok(
  filterEntries(demo, { page: 99, pageSize: 2 }).page === 1,
  "pagination: страница вне диапазона → 1"
);

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
