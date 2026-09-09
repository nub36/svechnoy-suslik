/**
 * Тесты URL-состояния графика (lib/chart/url-state.ts).
 *
 * Запуск: npx tsx scripts/test-url-state.ts
 */

import {
  buildChartSearch,
  parseChartUrlState
} from "../lib/chart/url-state";

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

const AVAILABLE = ["BINANCE", "BYBIT", "GATE"];

/* ---------- parseChartUrlState ---------- */

const good = parseChartUrlState(
  "BINANCE",
  "1h",
  AVAILABLE
);

ok(good.exchange === "BINANCE", "валиде exchange сохраняется");
ok(good.timeframe === "1h", "валидный timeframe сохраняется");

ok(
  parseChartUrlState("XXX", "1h", AVAILABLE).exchange === null,
  "неизвестная биржа (exchange=XXX) → null (fallback)"
);
ok(
  parseChartUrlState("BINANCE", "2h", AVAILABLE).timeframe === null,
  "невалидный timeframe=2h → null (fallback)"
);
ok(
  parseChartUrlState(null, null, AVAILABLE).exchange === null,
  "нет параметров → null"
);
ok(
  parseChartUrlState("", "", AVAILABLE).timeframe === null,
  "пустые параметры → null"
);
ok(
  parseChartUrlState("binance", "1h", AVAILABLE).exchange === null,
  "регистр биржи строгий"
);
ok(
  parseChartUrlState("BINANCE", "1H", AVAILABLE).timeframe === null,
  "регистр таймфрейма строгий (1H отклонён)"
);
ok(
  parseChartUrlState("A".repeat(40), "1h", AVAILABLE).exchange === null,
  "слишком длинная биржа → null"
);
ok(
  parseChartUrlState("BINANCE; DROP", "1h", AVAILABLE).exchange === null,
  "инъекция в параметре → null"
);
ok(
  parseChartUrlState("../etc", "1h", AVAILABLE).exchange === null,
  "путь в параметре → null"
);
ok(
  parseChartUrlState("BYBIT", "1d", AVAILABLE).exchange === "BYBIT",
  "все белые таймфреймы валидны (1d)"
);
ok(
  parseChartUrlState("GATE", "5m", AVAILABLE).timeframe === "5m",
  "5m валиден"
);

/* ---------- buildChartSearch ---------- */

ok(
  buildChartSearch("BINANCE", "1h") ===
    "?exchange=BINANCE&timeframe=1h",
  "строка запроса с обоими параметрами"
);
ok(
  buildChartSearch("BINANCE", "1h") ===
    "?exchange=BINANCE&timeframe=1h",
  "стабильный порядок параметров"
);
ok(
  buildChartSearch("BINANCE X", "1h") === "?timeframe=1h",
  "мусор в exchange не попадает в URL (валидный ТФ остаётся)"
);
ok(
  buildChartSearch("BINANCE", "7h") === "?exchange=BINANCE",
  "мусор в timeframe не попадает в URL (валидная биржа остаётся)"
);
ok(
  buildChartSearch("", "") === "",
  "пустые значения → пустая строка"
);

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
