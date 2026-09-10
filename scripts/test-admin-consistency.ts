/**
 * Тесты согласованности админки (VPS-ревью 3af152c):
 * - контракт lib/universe (Top-100 vs legacy Top-500);
 * - AdminNav содержит все разделы, включая
 *   «Уведомления» (/admin/notifications не orphan);
 * - все admin-страницы используют единый AdminNav;
 * - семантика Monitoring: закрытые/открытые свечи
 *   считаются РАЗДЕЛЬНО, свежесть — только по закрытым;
 * - семантика рынков: рынки Top-100 universe считаются
 *   через rank 1..100, НЕ через legacy-флаг Asset.top500;
 * - «Уведомления» остаются честным empty-state.
 *
 * Запуск: npx tsx scripts/test-admin-consistency.ts
 */

import { readFileSync } from "node:fs";
import {
  isInTopUniverse,
  LEGACY_TOP500_SIZE,
  TOP_UNIVERSE_LABEL,
  TOP_UNIVERSE_SIZE,
  topUniverseRankFilter
} from "../lib/universe";

let passed = 0;
let total = 0;

function ok(
  condition: boolean,
  label: string
) {
  total += 1;

  if (condition) {
    passed += 1;
  } else {
    console.error(`FAIL: ${label}`);
  }
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/* ---------- контракт lib/universe ---------- */

ok(TOP_UNIVERSE_SIZE === 100, "universe: размер 100");
ok(
  TOP_UNIVERSE_LABEL === "Top-100",
  "universe: метка Top-100"
);
ok(
  LEGACY_TOP500_SIZE === 500,
  "universe: legacy-максимум 500 (CLI-диагностика)"
);

const rankFilter = topUniverseRankFilter();

ok(
  JSON.stringify(rankFilter) ===
    '{"rank":{"lte":100,"not":null}}',
  "universe: фильтр rank 1..100 (не top500)"
);

ok(
  isInTopUniverse(100) === true,
  "universe: GRANITSA rank=100 входит"
);
ok(
  isInTopUniverse(101) === false,
  "universe: GRANITSA rank=101 не входит"
);
ok(
  isInTopUniverse(null) === false,
  "universe: rank=null не входит"
);
ok(
  isInTopUniverse(0) === false,
  "universe: rank=0 не входит"
);

/* ---------- AdminNav: полный список ---------- */

const nav = read(
  "components/admin/AdminNav.tsx"
);

const expectedItems: [string, string][] = [
  ["overview", "/admin"],
  ["strategies", "/admin#strategies"],
  ["indicators", "/admin/indicators"],
  ["data", "/admin/data"],
  ["markets", "/admin/markets"],
  ["backtests", "/admin/backtests"],
  ["signals", "/signals"],
  ["monitoring", "/admin/monitoring"],
  ["notifications", "/admin/notifications"],
  ["journal", "/admin/journal"]
];

for (const [key, href] of expectedItems) {
  ok(
    nav.includes(`key: "${key}"`) &&
      nav.includes(`href: "${href}"`),
    `nav: пункт ${key} → ${href} существует`
  );
}

// Порядок: Мониторинг → Уведомления → Журнал.
const iMonitoring = nav.indexOf('key: "monitoring"');
const iNotifications =
  nav.indexOf('key: "notifications"');
const iJournal = nav.indexOf('key: "journal"');

ok(
  iMonitoring !== -1 &&
    iMonitoring < iNotifications &&
    iNotifications < iJournal,
  "nav: Уведомления между Мониторингом и Журналом"
);

/* ---------- единый AdminNav на всех страницах ---------- */

const pages: [string, string][] = [
  ["app/admin/page.tsx", "overview"],
  ["app/admin/strategies/[id]/page.tsx", "strategies"],
  ["app/admin/indicators/page.tsx", "indicators"],
  ["app/admin/data/page.tsx", "data"],
  ["app/admin/markets/page.tsx", "markets"],
  ["app/admin/backtests/page.tsx", "backtests"],
  ["app/admin/monitoring/page.tsx", "monitoring"],
  [
    "app/admin/notifications/page.tsx",
    "notifications"
  ],
  ["app/admin/journal/page.tsx", "journal"]
];

for (const [path, key] of pages) {
  const src = read(path);

  ok(
    src.includes("AdminNav") &&
      src.includes(`active="${key}"`),
    `pages: ${path} использует AdminNav active="${key}"`
  );
}

/* ---------- Monitoring: closed/open раздельно ---------- */

const monitoring = read(
  "app/admin/monitoring/page.tsx"
);

ok(
  monitoring.includes(
    'COUNT(*) FILTER (\n            WHERE c.closed = true\n          )::int AS "closed"'
  ),
  "monitoring: SQL считает закрытые отдельно"
);
ok(
  monitoring.includes(
    'WHERE c.closed = false\n          )::int AS "open"'
  ),
  "monitoring: SQL считает открытые отдельно"
);
ok(
  monitoring.includes("<th>Закрытых</th>") &&
    monitoring.includes("<th>Открытых</th>"),
  "monitoring: таблица показывает закрытые и открытые колонками"
);
ok(
  monitoring.includes(
    "Свежесть (по закрытой)"
  ),
  "monitoring: свежесть помечена «по закрытой»"
);
ok(
  !monitoring.includes(
    'row.total.toLocaleString'
  ),
  "monitoring: в таблице нет колонки «всего вперемешку»"
);
ok(
  monitoring.includes(
    'prisma.$queryRaw<CandleTf[]>'
  ),
  "monitoring: $queryRaw — членный вызов (test-chart-sql правило)"
);
ok(
  monitoring.includes(
    "candleFreshness(\n                        row.timeframe,\n                        row.lastClosed"
  ),
  "monitoring: freshness считается от последней ЗАКРЫТОЙ"
);

/* ---------- Рынки: Top-100 через rank ---------- */

const overview = read("app/admin/page.tsx");

ok(
  overview.includes(
    "asset: topUniverseRankFilter()"
  ),
  "overview: рынки Top-100 считаются через rank-фильтр universe"
);
ok(
  monitoring.includes(
    "asset: topUniverseRankFilter()"
  ),
  "monitoring: рынки Top-100 считаются через rank-фильтр universe"
);
ok(
  !overview.includes("top500") &&
    !monitoring.includes("top500"),
  "overview/monitoring: legacy-флаг top500 в выборках рынков не используется"
);
ok(
  overview.includes("Рынков Top-100") &&
    overview.includes("всего активных в БД"),
  "overview: оба показателя видны (Top-100 и всего в БД)"
);
ok(
  monitoring.includes("рынков Top-100") &&
    monitoring.includes("всего активных SPOT USDT-рынков в БД"),
  "monitoring: оба показателя видны (Top-100 и всего в БД)"
);

/* ---------- Уведомления: честный empty-state ---------- */

const notifications = read(
  "app/admin/notifications/page.tsx"
);

ok(
  notifications.includes("не реализована"),
  "notifications: честно сказано, что backend не реализован"
);
ok(
  !notifications.includes(
    "telegramToken\|TELEGRAM\|webhook"
  ),
  "notifications: нет выдуманных каналов/токенов"
);

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
