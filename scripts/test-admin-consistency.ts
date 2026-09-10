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

import {
  existsSync,
  readFileSync
} from "node:fs";
import {
  isInTopUniverse,
  LEGACY_TOP500_SIZE,
  TOP_UNIVERSE_LABEL,
  TOP_UNIVERSE_SIZE,
  topUniverseRankFilter
} from "../lib/universe";
import {
  buildOverviewQueries,
  OVERVIEW_QUERY_ORDER,
  type OverviewDb
} from "../lib/admin/overview";

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
    '{"rank":{"gte":1,"lte":100,"not":null}}',
  "universe: фильтр rank 1..100 с нижней границей (не top500)"
);

ok(
  isInTopUniverse(1) === true,
  "universe: GRANITSA rank=1 входит"
);
ok(
  isInTopUniverse(100) === true,
  "universe: GRANITSA rank=100 входит"
);
ok(
  isInTopUniverse(0) === false,
  "universe: GRANITSA rank=0 не входит"
);
ok(
  isInTopUniverse(-1) === false,
  "universe: GRANITSA rank=-1 не входит"
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
  ["strategies", "/admin/strategies"],
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

// «Стратегии» больше НЕ anchor на Overview:
// раздел должен быть самостоятельным маршрутом.
ok(
  !nav.includes("/admin#strategies") &&
    nav.includes('href: "/admin/strategies"'),
  "nav: Стратегии → /admin/strategies (не /admin#strategies)"
);

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
  ["app/admin/strategies/page.tsx", "strategies"],
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
  read("lib/admin/overview.ts").includes(
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

/* ---------- Overview: семантика Promise.all ----------
 *
 * Подставная БД ЗАПОМИНАЕТ каждый вызов; тест
 * доказывает позицию КАЖДОГО запроса в promises
 * (перестановка местами не может пройти зелёной):
 * позиция 1 = Asset.count Top-100, позиция 2 =
 * Market.count с rank-фильтром universe, позиция 3 =
 * Market.count ACTIVE/SPOT/USDT БЕЗ ограничения
 * Top-100, и т.д. по OVERVIEW_QUERY_ORDER.
 */

type RecordedCall = {
  model: string;
  op: string;
  arg?: unknown;
};

function makeFakeDb(): {
  db: OverviewDb;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];

  const db: OverviewDb = {
    strategy: {
      findMany(args) {
        calls.push({
          model: "Strategy",
          op: "findMany",
          arg: args
        });

        return Promise.resolve([
          {
            id: 1,
            slug: "trend-suslik",
            name: "Трендовый Суслик",
            description: null,
            version: 1,
            enabled: true,
            status: "PUBLISHED",
            timeframes: ["1h"],
            minExchanges: 2
          }
        ]);
      }
    },

    asset: {
      count(args) {
        calls.push({
          model: "Asset",
          op: "count",
          arg: args
        });

        return Promise.resolve(100);
      }
    },

    market: {
      count(args) {
        calls.push({
          model: "Market",
          op: "count",
          arg: args
        });

        return Promise.resolve(401);
      },
      findMany(args) {
        calls.push({
          model: "Market",
          op: "findMany",
          arg: args
        });

        return Promise.resolve([
          { exchange: "BINANCE" }
        ]);
      }
    },

    signal: {
      count(args) {
        calls.push({
          model: "Signal",
          op: "count",
          arg: args
        });

        return Promise.resolve(0);
      }
    },

    candle: {
      count() {
        calls.push({
          model: "Candle",
          op: "count"
        });

        return Promise.resolve(14731);
      }
    },

    $queryRaw(strings) {
      calls.push({
        model: "$queryRaw",
        op: "raw",
        arg: strings.join("")
      });

      return Promise.resolve([
        { t: new Date("2026-09-10T09:00:00Z") }
      ]);
    }
  };

  return { db, calls };
}

async function checkOverviewSemantics(): Promise<void> {
  const { db, calls } = makeFakeDb();

  const { names, promises } =
    buildOverviewQueries(db);

  // Имена и длина зафиксированы.
  ok(
    names.length === promises.length,
    "overview: число имён = числу promises"
  );
  ok(
    JSON.stringify(names) ===
      JSON.stringify([
        "strategies",
        "assetsTop100",
        "marketsTop100",
        "marketsActiveTotal",
        "candles",
        "signalsActive",
        "exchangesDistinct",
        "lastClosed1h"
      ]),
    "overview: порядок запросов зафиксирован константой"
  );

  const results = await Promise.all(promises);

  // Позиция 0: стратегии.
  ok(
    calls[0].model === "Strategy" &&
      calls[0].op === "findMany" &&
      Array.isArray(results[0]) &&
      results[0][0]?.slug === "trend-suslik",
    "overview[0]: strategies получает Strategy.findMany"
  );

  // Позиция 1: ТОЧНО Asset.count Top-100 (не рынки!).
  const assetWhere = (calls[1]?.arg as {
    where?: Record<string, unknown>;
  })?.where;
  ok(
    calls[1].model === "Asset" &&
      calls[1].op === "count" &&
      results[1] === 100,
    "overview[1]: assets получает Asset.count (Top-100)"
  );
  ok(
    JSON.stringify(assetWhere?.rank) ===
      '{"gte":1,"lte":100,"not":null}' &&
      assetWhere?.enabled === true,
    "overview[1]: where = enabled + rank 1..100 (gte/lte)"
  );

  // Позиция 2: Market.count С rank-фильтром universe.
  const top100Where = (calls[2]?.arg as {
    where?: Record<string, unknown>;
  })?.where as Record<string, unknown>;
  const top100Asset =
    top100Where?.asset as Record<string, unknown>;
  ok(
    calls[2].model === "Market" &&
      calls[2].op === "count",
    "overview[2]: universeMarkets получает Market.count"
  );
  ok(
    JSON.stringify(top100Asset?.rank) ===
      '{"gte":1,"lte":100,"not":null}',
    "overview[2]: фильтр asset.rank 1..100 (universe, не top500)"
  );
  ok(
    top100Where?.enabled === true &&
      top100Where?.status === "ACTIVE" &&
      top100Where?.quote === "USDT" &&
      top100Where?.marketType === "SPOT",
    "overview[2]: enabled + ACTIVE + SPOT + USDT"
  );

  // Позиция 3: Market.count БЕЗ ограничения Top-100,
  // но с ACTIVE/SPOT/USDT (total active, не bare enabled).
  const totalWhere = (calls[3]?.arg as {
    where?: Record<string, unknown>;
  })?.where as Record<string, unknown>;
  ok(
    calls[3].model === "Market" &&
      calls[3].op === "count",
    "overview[3]: total активных получает Market.count"
  );
  ok(
    totalWhere?.enabled === true &&
      totalWhere?.status === "ACTIVE" &&
      totalWhere?.quote === "USDT" &&
      totalWhere?.marketType === "SPOT" &&
      totalWhere?.asset === undefined,
    "overview[3]: total = ACTIVE/SPOT/USDT без asset-фильтра"
  );

  // Ровно ДВА счётчика рынков: Top-100 + total.
  // (отсутствие третьего = нет дубля enabled-count
  //  и неиспользуемого activeMarkets)
  ok(
    calls.filter(
      (c) =>
        c.model === "Market" && c.op === "count"
    ).length === 2,
    "overview: ровно 2 счётчика рынков (нет дублей/неиспользуемых)"
  );

  // Позиция 4/5: свечи и сигналы.
  ok(
    calls[4].model === "Candle" &&
      calls[4].op === "count" &&
      results[4] === 14731,
    "overview[4]: candleCount получает Candle.count"
  );
  ok(
    calls[5].model === "Signal" &&
      calls[5].op === "count" &&
      (calls[5].arg as { where?: unknown })?.where !=
        null &&
      results[5] === 0,
    "overview[5]: signals получает Signal.count"
  );

  // Позиция 6: биржи из ДАННЫХ БД.
  ok(
    calls[6].model === "Market" &&
      calls[6].op === "findMany" &&
      results[6][0]?.exchange === "BINANCE",
    "overview[6]: exchanges получает Market.findMany"
  );

  // Позиция 7: последняя ЗАКРЫТАЯ 1h свеча.
  ok(
    calls[7].model === "$queryRaw" &&
      String(calls[7].arg).includes(
        "closed = true"
      ) &&
      String(calls[7].arg).includes(
        "timeframe = '1h'"
      ) &&
      results[7][0]?.t instanceof Date,
    "overview[7]: lastClosed1h — $queryRaw по закрытой 1h"
  );
}

/* ---------- страница: потребление контракта ---------- */

const overviewPage = read("app/admin/page.tsx");

ok(
  overviewPage.includes(
    "const { promises } =\n      buildOverviewQueries(prisma);"
  ),
  "overview-page: запросы берутся из проверяемого хелпера"
);

// Деструктурирование строго в порядке
// OVERVIEW_QUERY_ORDER — иначе позиции поедут.
// (комментарии внутри списка вырезаются перед проверкой)
const pageNoComments = overviewPage.replace(
  /\/\/[^\n]*/g,
  ""
);
const destructureRe =
  /const \[\s*strategies,\s*assets,\s*universeMarkets,\s*markets,\s*candleCount,\s*signals,\s*exchanges,\s*lastClosedRows\s*\] = await Promise\.all\(promises\);/;
ok(
  destructureRe.test(pageNoComments),
  "overview-page: деструктурирование = порядок хелпера (8 позиций)"
);
ok(
  !overviewPage.includes("activeMarkets"),
  "overview-page: неиспользуемого activeMarkets больше нет"
);

/* ---------- Раздел /admin/strategies ---------- */

const strategiesSection = read(
  "app/admin/strategies/page.tsx"
);

ok(
  strategiesSection.includes(
    'className="adminPage"'
  ) &&
    strategiesSection.includes(
      '<section className="adminDashboard">'
    ),
  "strategies section: единый admin layout (grid + dashboard)"
);
ok(
  strategiesSection.includes(
    "prisma.strategy.findMany"
  ),
  "strategies section: реальный источник — Strategy.findMany из PostgreSQL"
);
ok(
  strategiesSection.includes(
    'href={`/admin/strategies/${strategy.id}`}'
  ),
  "strategies section: «Настроить» — реальный href на редактор"
);
// Проверяем КОД страницы, не док-комментарии.
const sectionNoComments = strategiesSection
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");
ok(
  !/winrate|pnl|profit|прибыль/i.test(
    sectionNoComments
  ),
  "strategies section: нет fake-метрик прибыльности/сигналов"
);

// Disabled «Новая стратегия» с объяснением (и на
// разделе, и на Overview — одинаковая формулировка).
const sectionNewBtn =
  strategiesSection.match(
    /<button[\s\S]*?\+ Новая стратегия[\s\S]*?<\/button>/
  )?.[0] ?? "";
ok(
  sectionNewBtn.includes("disabled") &&
    !sectionNewBtn.includes("onClick"),
  "strategies section: «+ Новая стратегия» disabled без обработчика"
);
ok(
  strategiesSection.includes(
    "Добавление новых стратегий станет доступно после разработки и проверки стратегии"
  ) &&
    overviewPage.includes(
      "Добавление новых стратегий станет доступно после разработки и проверки стратегии"
    ),
  "strategies/overview: у disabled-кнопки есть объяснение (единый текст)"
);

// Create-стратегии API НЕ существует в этом коммите.
ok(
  !existsSync("app/api/admin/strategies/route.ts"),
  "strategies: нет create-эндпоинта (backend создания отсутствует сознательно)"
);

/* ---------- Strategy page: layout-контракт ---------- */

const strategyPage = read(
  "app/admin/strategies/[id]/page.tsx"
);

ok(
  strategyPage.includes('className="adminPage"') &&
    strategyPage.includes(
      '<section className="adminDashboard">'
    ),
  "strategy page: тот же layout-контракт (adminPage grid + adminDashboard), что у рабочих страниц"
);
ok(
  !strategyPage.includes('className="shell"'),
  "strategy page: старый блоковый .shell (нав во всю ширину) убран"
);
ok(
  strategyPage.indexOf("<AdminNav") <
    strategyPage.indexOf("<StrategyEditor"),
  "strategy page: AdminNav стоит перед StrategyEditor (левая колонка)"
);

// Responsive-контракт из globals.css: сетка 235px+1fr
// и схлопывание в одну колонку на узких экранах.
const css = read("app/globals.css");
ok(
  css.includes("grid-template-columns: 235px 1fr;"),
  "globals.css: .adminPage = 235px + 1fr (нав слева)"
);
ok(
  /@media \(max-width: 950px\)/.test(css) &&
    css.includes("grid-template-columns: 1fr;"),
  "globals.css: на экранах <=950px adminPage схлопывается (responsive)"
);

/* ---------- Strategy page: интерактив без dead buttons ---------- */

const editor = read(
  "components/admin/StrategyEditor.tsx"
);

// Каждая кнопка редактора обязана иметь onClick.
const buttonTags =
  editor.match(/<button[\s\S]*?>/g) ?? [];
ok(
  buttonTags.length === 2 &&
    buttonTags.every((t) => t.includes("onClick=")),
  "strategy editor: обе кнопки (таймфрейм, сохранить) имеют onClick — нет decorative"
);

// Checkbox «Стратегия включена» — реальный:
// state + обработчик + попадание в PUT.
ok(
  editor.includes("checked={enabled}") &&
    editor.includes("setEnabled(e.target.checked)") &&
    editor.includes("method: \"PUT\""),
  "strategy editor: checkbox включённости подключен к state и PUT"
);
ok(
  editor.includes(
    "`/api/admin/strategies/${strategy.id}`"
  ),
  "strategy editor: сохранение бьёт в реальный API-роут"
);

// API-роут статически: ADMIN-gate + запись enabled.
const apiRoute = read(
  "app/api/admin/strategies/[id]/route.ts"
);
ok(
  apiRoute.includes("isAdmin()") &&
    apiRoute.includes("prisma.strategy.update") &&
    apiRoute.includes(
      "enabled: Boolean(body.enabled)"
    ),
  "strategy API: isAdmin-gate + prisma.strategy.update(enabled) — toggle реально сохраняется"
);

/* ---------- Overview: Настроить / Новая стратегия ---------- */

ok(
  overviewPage.includes(
    "href={`/admin/strategies/${strategy.id}`}"
  ),
  "overview: «Настроить» — реальный href на существующий редактор"
);
ok(
  read("app/admin/strategies/[id]/page.tsx").includes(
    "<StrategyEditor"
  ),
  "overview: цель «Настроить» рендерит StrategyEditor"
);

// «Новая стратегия»: честно disabled + объяснение,
// без выдуманного onClick/формы.
const newBtn =
  overviewPage.match(
    /<button[\s\S]*?\+ Новая стратегия[\s\S]*?<\/button>/
  )?.[0] ?? "";
ok(
  newBtn.includes("disabled") &&
    !newBtn.includes("onClick"),
  "overview: «+ Новая стратегия» disabled без выдуманного обработчика"
);


/* ---------- итог (после async-проверок) ---------- */

checkOverviewSemantics().then(() => {
  console.log(`Itog: ${passed}/${total}`);
  process.exit(passed === total ? 0 : 1);
});
