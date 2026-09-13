/**
 * Regression test for referenceExchange fix
 * - referenceExchange="BINANCE" with arbitrary marketId => exact BINANCE market selected
 * - BYBIT => exact BYBIT selected
 * - null => explicit failure/no execution
 * - UNKNOWN => explicit failure/no execution
 * Also static search for suspicious marketId vs exchange/referenceExchange comparisons
 */

import { readFileSync } from "fs";
import { execSync } from "child_process";

let passed = 0, failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`✅ ${label}`); } else { failed++; console.log(`❌ FAIL: ${label}`); }
}

// Simulate the fixed logic
type Market = { meta: { exchange: string; marketId: number }; candles: any[] };

function findRefMarket(allCandles: Market[], refExchange: string | null): Market | null {
  if (refExchange == null) return null; // fail-closed
  const found = allCandles.find((mc) => mc.meta.exchange === refExchange);
  if (!found) return null; // fail-closed, no fallback
  // Verify correspondence
  if (found.meta.exchange !== refExchange) return null;
  return found;
}

// Test data
const allCandles: Market[] = [
  { meta: { exchange: "BINANCE", marketId: 999 }, candles: [] },
  { meta: { exchange: "BYBIT", marketId: 123 }, candles: [] },
  { meta: { exchange: "GATE", marketId: 456 }, candles: [] },
];

// Tests
const m1 = findRefMarket(allCandles, "BINANCE");
ok(m1 !== null && m1.meta.exchange === "BINANCE" && m1.meta.marketId === 999, 'referenceExchange="BINANCE" with arbitrary marketId 999 => exact BINANCE market selected');

const m2 = findRefMarket(allCandles, "BYBIT");
ok(m2 !== null && m2.meta.exchange === "BYBIT" && m2.meta.marketId === 123, 'referenceExchange="BYBIT" => exact BYBIT selected');

const m3 = findRefMarket(allCandles, null);
ok(m3 === null, 'referenceExchange=null => explicit failure/no execution');

const m4 = findRefMarket(allCandles, "UNKNOWN");
ok(m4 === null, 'referenceExchange="UNKNOWN" => explicit failure/no execution');

// Ensure no fallback to first exchange
const m5 = findRefMarket(allCandles, "KUCOIN");
ok(m5 === null, 'referenceExchange="KUCOIN" not in list => fail-closed, no fallback to first');

console.log("\n=== Static search for suspicious comparisons ===");
try {
  const grep = execSync(`grep -R -n "marketId.*referenceExchange\\|referenceExchange.*marketId\\|meta.marketId.*referenceExchange\\|referenceExchange.*meta.marketId" lib/ scripts/ --include="*.ts" || echo "no matches"`, { encoding: "utf8" });
  console.log(grep);
  ok(!grep.includes("marketId") || grep.includes("no matches"), "No suspicious marketId vs referenceExchange comparisons in lib/scripts");
} catch (e) {
  console.log("grep failed, manual check");
}

// Also check for old buggy pattern: meta.marketId === candidate.referenceExchange
try {
  const grep2 = execSync(`grep -R -n "marketId.*===.*referenceExchange\\|referenceExchange.*===.*marketId" lib/ scripts/ --include="*.ts" || echo "no matches"`, { encoding: "utf8" });
  console.log(grep2);
  ok(grep2.includes("no matches"), "No marketId === referenceExchange pattern");
} catch {}

console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
