/**
 * Тесты валидации параметров chart API
 * (lib/chart/params.ts + cursor из lib/chart/history.ts).
 *
 * Негативные сценарии из VPS-ревью: symbol пустой/длинный,
 * неизвестная биржа, timeframe=2h, limit=0/999999,
 * before=abc/отрицательный — все дают осмысленную ошибку
 * (роут вернёт 400/404, никогда не 500).
 *
 * Запуск: npx tsx scripts/test-chart-params.ts
 */

import {
  parseExchangeParam,
  parseLimitParam,
  parseSymbolParam,
  parseTimeframeParam
} from "../lib/chart/params";
import { validateCursor } from "../lib/chart/history";

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

function isErr(
  result: { ok: boolean; message?: string },
  needle: string,
  label: string
) {
  ok(
    result.ok === false &&
      result.message?.includes(needle) === true,
    `${label} (сообщение: ${result.message ?? "нет"})`
  );
}

/* ---------- symbol ---------- */

isErr(
  parseSymbolParam(null),
  "Нужен параметр symbol",
  "symbol пустой (null)"
);
isErr(
  parseSymbolParam(""),
  "Нужен параметр symbol",
  "symbol пустой (пустая строка)"
);
isErr(
  parseSymbolParam("   "),
  "Нужен параметр symbol",
  "symbol пустой (пробелы)"
);
isErr(
  parseSymbolParam("B".repeat(40)),
  "слишком длинный",
  "symbol длиннее 16"
);
isErr(
  parseSymbolParam("BTC;DROP"),
  "латинских букв",
  "symbol с инъекцией отклонён"
);
ok(
  parseSymbolParam("btc").ok === true,
  "symbol в нижнем регистре нормализуется"
);
const upper = parseSymbolParam("btc");

ok(
  upper.ok && upper.value === "BTC",
  "symbol нормализуется в верхний регистр"
);
ok(
  parseSymbolParam("BTC").ok === true,
  "обычный symbol проходит"
);

/* ---------- exchange ---------- */

isErr(
  parseExchangeParam("XXX"),
  "Неизвестная биржа",
  "неизвестная биржа XXX"
);
isErr(
  parseExchangeParam(""),
  "Нужен параметр exchange",
  "exchange пустой"
);
const normalized = parseExchangeParam("binance");

ok(
  normalized.ok && normalized.value === "BINANCE",
  "регистр биржи нормализуется"
);
for (const name of [
  "BINANCE",
  "BYBIT",
  "GATE",
  "KUCOIN",
  "BINGX"
]) {
  ok(
    parseExchangeParam(name).ok === true,
    `биржа ${name} известна`
  );
}

/* ---------- timeframe ---------- */

isErr(
  parseTimeframeParam("2h"),
  "Неверный timeframe",
  "timeframe=2h отклонён"
);
isErr(
  parseTimeframeParam(null),
  "Нужен параметр timeframe",
  "timeframe отсутствует"
);
isErr(
  parseTimeframeParam("1H"),
  "Неверный timeframe",
  "timeframe=1H (регистр) отклонён"
);
for (const tf of ["5m", "15m", "1h", "4h", "1d"]) {
  ok(
    parseTimeframeParam(tf).ok === true,
    `timeframe ${tf} валиден`
  );
}

/* ---------- limit ---------- */

const limitDefault = parseLimitParam(null);

ok(
  limitDefault.ok && limitDefault.value === 300,
  "limit отсутствует → 300 (дефолт)"
);
isErr(
  parseLimitParam("0"),
  "от 50 до 1000",
  "limit=0 → осмысленная ошибка"
);
isErr(
  parseLimitParam("999999"),
  "от 50 до 1000",
  "limit=999999 → осмысленная ошибка"
);
isErr(
  parseLimitParam("abc"),
  "целым числом",
  "limit=abc → осмысленная ошибка"
);
isErr(
  parseLimitParam("10.5"),
  "целым числом",
  "limit=10.5 → осмысленная ошибка"
);
const limit300 = parseLimitParam("300");
const limit50 = parseLimitParam("50");
const limit1000 = parseLimitParam("1000");

ok(limit300.ok && limit300.value === 300,
  "limit=300 проходит"
);
ok(limit50.ok && limit50.value === 50,
  "limit=50 (минимум) проходит"
);
ok(limit1000.ok && limit1000.value === 1000,
  "limit=1000 (максимум) проходит"
);

/* ---------- cursor (before) ---------- */

isErr(
  validateCursor("abc"),
  "целым неотрицательным числом",
  "before=abc отклонён"
);
isErr(
  validateCursor("-100"),
  "целым неотрицательным числом",
  "before=-100 отклонён"
);
isErr(
  validateCursor("0"),
  "больше 0",
  "before=0 отклонён"
);
isErr(
  validateCursor(null),
  "Нужен параметр before",
  "before отсутствует отклонён"
);
ok(
  validateCursor("1690000000000").ok === true,
  "валидный before проходит"
);

/* ---------- итог ---------- */

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
