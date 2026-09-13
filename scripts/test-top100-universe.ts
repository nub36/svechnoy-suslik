/**
 * Top-100 universe regression (задание владельца: рынок = Топ-100, не Top-500).
 *
 * Проверяет БЕЗ сети и БЕЗ БД:
 *  1) чистую нормализацию lib/market-universe.ts (cap 100, дедуп по
 *     символу, честный rank-порядок, отбраковка мусора, детерминизм);
 *  2) статические гарды: тексты главной страницы и getTopCoins переведены на
 *     TOP_UNIVERSE_SIZE, ранг в таблице — из данных, а не из индекса;
 *  3) НЕ тронуты несвязанные «500» (SMC rolling-параметры, буфер
 *     журнала, HTTP-коды) — их менять было запрещено.
 *
 * Запуск: npx tsx scripts/test-top100-universe.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildTopUniverseCoins,
  type MarketCoinRow
} from "../lib/market-universe";
import { LEGACY_TOP500_SIZE, TOP_UNIVERSE_SIZE } from "../lib/universe";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const read = (p: string): string =>
  readFileSync(resolve(root, p), "utf8");

let passed = 0;
let total = 0;
const failures: string[] = [];

function check(cond: boolean, label: string): void {
  total += 1;

  if (cond) {
    passed += 1;
  } else {
    failures.push(label);
    console.error(`FAIL: ${label}`);
  }
}

function row(over: Partial<MarketCoinRow> & { id: string; symbol: string }): Record<string, unknown> {
  return {
    name: over.symbol.toUpperCase(),
    current_price: 1,
    market_cap: 1e9,
    total_volume: 1e8,
    price_change_percentage_24h: 0.5,
    market_cap_rank: 1,
    ...over
  };
}

console.log("=== 1. buildTopUniverseCoins: чистая нормализация ===");

{
  /* Cap: из 150 рангов остаются первые 100. */
  const many = Array.from({ length: 150 }, (_, i) =>
    row({ id: `c${String(i + 1)}`, symbol: `s${String(i + 1)}`, market_cap_rank: i + 1 })
  );

  const capped = buildTopUniverseCoins(many, 100);

  check(capped.length === 100, "cap: из 150 строк ровно 100 в universe");
  check(
    capped.every((c, i) => c.market_cap_rank === i + 1),
    "cap: ранги 1..100 идут строго по порядку"
  );
}

{
  /* Детерминизм: перемешанный вход даёт тот же выход. */
  const src = Array.from({ length: 100 }, (_, i) => ({
    ...row({ id: `c${String(i + 1)}`, symbol: `s${String(i + 1)}`, market_cap_rank: i + 1 })
  }));

  const shuffled = [...src].sort(
    (a, b) =>
      ((a.market_cap_rank as number) * 37 % 101) - ((b.market_cap_rank as number) * 37 % 101)
  );

  check(
    JSON.stringify(buildTopUniverseCoins(shuffled, 100)) ===
      JSON.stringify(buildTopUniverseCoins(src, 100)),
    "порядок: выход не зависит от порядка строк в ответе API"
  );
}

{
  /* Дедуп по символу (регистронезависимый), побеждает меньший ранг. */
  const dup = [
    row({ id: "btc", symbol: "btc", market_cap_rank: 12 }),
    row({ id: "bitcoin", symbol: "BTC", market_cap_rank: 1 }),
    row({ id: "eth", symbol: "Eth", market_cap_rank: 2 })
  ];

  const out = buildTopUniverseCoins(dup, 100);

  check(out.length === 2, "dedupe: дубль символа схлопнут в одну строку");
  check(
    out[0].symbol === "BTC" && out[0].market_cap_rank === 1,
    "dedupe: при дубле сохраняется запись с меньшим (настоящим) рангом"
  );
  check(
    out.every((c) => c.symbol === c.symbol.toUpperCase()),
    "символы нормализованы к верхнему регистру"
  );
}

{
  /* Мусор и вне-universe. */
  const junk = [
    null,
    42,
    "btc",
    { id: "", symbol: "X", market_cap_rank: 5 },
    { id: "y", symbol: "", market_cap_rank: 5 },
    row({ id: "r0", symbol: "r0", market_cap_rank: 0 }),
    row({ id: "rn", symbol: "rn", market_cap_rank: Number.NaN }),
    row({ id: "r101", symbol: "r101", market_cap_rank: 101 }),
    row({ id: "ok", symbol: "ok", market_cap_rank: 100 })
  ];

  const out = buildTopUniverseCoins(junk, 100);

  check(out.length === 1 && out[0].symbol === "OK", "мусор/вне 1..100 отбраковывается, валидная 100-я остаётся");
  check(
    buildTopUniverseCoins(undefined, 100).length === 0 &&
      buildTopUniverseCoins({ notAnArray: true }, 100).length === 0,
    "нестрокументальный ответ API → пустой список (честное «Нет данных», без выдумки)"
  );
}

{
  /* Числовые поля проходят насквозь и чистятся от NaN. */
  const out = buildTopUniverseCoins(
    [
      {
        id: "a",
        symbol: "a",
        name: "Alpha",
        market_cap_rank: 3,
        current_price: Number.NaN,
        market_cap: 7,
        total_volume: Infinity,
        price_change_percentage_24h: 2.5,
        image: "https://img/a.png"
      }
    ],
    100
  );

  check(out.length === 1, "валидная строка с частичным мусором сохранена");
  check(out[0].current_price === 0 && out[0].total_volume === 0, "нечисловые цены заменены 0 (рендер без NaN)");
  check(out[0].market_cap === 7 && out[0].price_change_percentage_24h === 2.5, "валидные числа сохранены точно");
  check(out[0].image === "https://img/a.png", "image прокинут (иконки таблицы работают)");
}

{
  /* Жёсткий cap именно по строкам: 130 валидных рядов с коллизиями
     рангов (rank-фильтр сам по себе тут не спасает) → ровно 100,
     стабильный tie-break по символу. */
  const collisions = Array.from({ length: 130 }, (_, i) =>
    row({
      id: `k${String(i)}`,
      symbol: `k${String(i).padStart(3, "0")}`,
      market_cap_rank: (i % 100) + 1
    })
  );

  const hard = buildTopUniverseCoins(collisions, 100);

  check(hard.length === 100, "cap: при коллизиях рангов отсекается ровно limit строк (slice, не только фильтр rank)");
  check(
    hard.every((c) => c.market_cap_rank >= 1 && c.market_cap_rank <= 100),
    "cap: отсечка не выдаёт строк вне 1..limit"
  );
}

{
  /* Ничего не отсекается, если limit=500 (LEGACY-флаг rank-assets):
     cap = limit, не жёсткая 100. */
  const many = Array.from({ length: 600 }, (_, i) =>
    row({ id: `c${String(i)}`, symbol: `s${String(i)}`, market_cap_rank: i + 1 })
  );

  const big = buildTopUniverseCoins(many, LEGACY_TOP500_SIZE);

  check(big.length === 500, "legacy limit=500: cap работает как параметр, хардкода 100 внутри нет");
}

console.log("\n=== 2. Гарды исходников: главная страница/витрина переведены на Top-100 ===");

{
  check(TOP_UNIVERSE_SIZE === 100, "universe: единая константа = 100");

  const page = read("app/page.tsx");

  check(!page.includes("getTopCoins(500)"), "home: больше нет getTopCoins(500)");
  check(!page.includes("500 крупнейших"), "home: убрана фраза «500 крупнейших активов»");
  check(page.includes("100 крупнейших активов"), "home: hero честно обещает 100 активов");

  const market = read("lib/market.ts");

  check(market.includes("TOP_UNIVERSE_SIZE"), "lib/market: лимит по умолчанию из единой константы");
  check(market.includes("buildTopUniverseCoins(await res.json(), limit)"), "lib/market: ответ API нормализуется единым пайплайном");
  check(!/for \(let page = 1; page <= pages/.test(market), "lib/market: мёртвая многостраничная выкачка на 500 убрана");

  const overview = read("components/MarketOverview.tsx");

  check(overview.includes("Капитализация Top-100"), "сводка: карточка переименована в Top-100");
  check(!overview.includes("Top-500"), "сводка: упоминание Top-500 отсутствует");

  const table = read("components/MarketTable.tsx");

  check(table.includes("coin.market_cap_rank > 0"), "таблица: ранг берётся из данных источника");
  check(!table.includes("{i + 1}"), "таблица: № строки вместо ранга (i+1) устранён");
}

{
  /* Пункт 4 вселенной: навигация ≠ наличие данных, тиxой подмены BTC нет. */
  const history = read("lib/chart/history.ts");

  check(
    history.includes("тихая подмена") &&
      !/return list\[0\]\?\.symbol \?\? null;\n\}/.test(
        history.replace(/if \(preferred === null[\s\S]*?\n\}/, "")
      ),
    "history: resolveSymbolFromList больше не возвращает «первый» для явного символа"
  );

  const chart = read("components/chart/CandleChart.tsx");

  check(chart.includes("нет в списке"), "chart: неизвестный актив показан в селекторе явно");
}

console.log("\n=== 3. Защищённые «500» не тронуты ===");

{
  const smc = read("lib/smc/config.ts");

  check(smc.includes("1..500") && smc.includes("value > 500"), "SMC rolling-параметры: диапазон 1..500 на месте");
  check(read("app/admin/journal/page.tsx").includes("500 записей"), "журнал: буфер-лимит 500 не изменён");
  check(read("app/api/register/route.ts").includes("{ status: 500 }"), "HTTP 500 регистрации — не «универсальная» пятисотка");
  check(read("app/api/chart/candles/route.ts").includes("никогда не 500"), "candles API: контракт «никогда не 500» сохранён");
  check(read("components/admin/SmartMoneyStrategyEditor.tsx").includes("top500Only"), "наследованный флаг filters.top500Only не тронут (семантика документирована)")
}

console.log(`\nItog: ${String(passed)}/${String(total)}`);

if (failures.length > 0) {
  console.error("Проваленные проверки:");

  for (const f of failures) {
    console.error(` - ${f}`);
  }

  process.exitCode = 1;
}
