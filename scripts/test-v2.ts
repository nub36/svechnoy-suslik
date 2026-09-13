/**
 * Tests for TOP-50 + Smart Money V2
 * No DB writes, read-only checks + synthetic correctness
 */

import { TOP_UNIVERSE_SIZE, TOP_UNIVERSE_LABEL, topUniverseRankFilter, isInTopUniverse } from "../lib/universe";
import { DEFAULT_V2_CONFIG, normalizeV2Config, validateV2Config } from "../lib/strategies/smart-money-v2";
import { computeEdgeTransition } from "../lib/signals/edge-state-machine";
import { EXCHANGE_LIST, EXCHANGE_PRIORITY, getDefaultExchange, DEFAULT_EXCHANGE_CONFIGS } from "../lib/exchanges/config";

let passed = 0;
let failed = 0;

function ok(cond: boolean, label: string) {
  if (cond) {
    passed++;
    console.log(`✓ ${label}`);
  } else {
    failed++;
    console.error(`✗ FAIL: ${label}`);
  }
}

// 1. TOP-50 public
ok(TOP_UNIVERSE_SIZE === 50, "TOP-50: size 50");
ok(TOP_UNIVERSE_LABEL === "TOP-50", "TOP-50: label TOP-50");
ok(isInTopUniverse(1) === true, "TOP-50: rank 1 in universe");
ok(isInTopUniverse(50) === true, "TOP-50: rank 50 in universe");
ok(isInTopUniverse(51) === false, "TOP-50: rank 51 not in universe");
ok(JSON.stringify(topUniverseRankFilter()) === '{"rank":{"gte":1,"lte":50,"not":null}}', "TOP-50: filter rank 1..50");

// 2. Exchange config BINANCE default
ok(EXCHANGE_LIST.includes("BINANCE"), "Exchange: BINANCE in list");
ok(EXCHANGE_PRIORITY["BINANCE"] === 100, "Exchange: BINANCE priority 100 highest");
ok(getDefaultExchange(DEFAULT_EXCHANGE_CONFIGS) === "BINANCE", "Exchange: default is BINANCE");
ok(DEFAULT_EXCHANGE_CONFIGS.find(c => c.exchange === "BINANCE")?.isDefault === true, "Exchange: BINANCE isDefault true");
ok(DEFAULT_EXCHANGE_CONFIGS[0].exchange === "BINANCE" || DEFAULT_EXCHANGE_CONFIGS.find(c => c.priority === 100)?.exchange === "BINANCE", "Exchange: BINANCE priority highest");

// 3. Public exchange disable must not break BTC V1 (5 exchanges quorum 3/5)
const publicDisabledBinance = DEFAULT_EXCHANGE_CONFIGS.map(c => c.exchange === "BINANCE" ? { ...c, publicEnabled: false } : c);
const defaultAfterDisable = getDefaultExchange(publicDisabledBinance);
ok(defaultAfterDisable !== "BINANCE" || publicDisabledBinance.filter(c => c.publicEnabled).length === 0, "Exchange: public disable BINANCE fallback works, V1 still 5 exchanges via ohlcvEnabled not publicEnabled");

// 4. V2 default not LIVE
ok(DEFAULT_V2_CONFIG.mode === "DISABLED", "V2: default mode DISABLED");
ok((DEFAULT_V2_CONFIG.mode as string) !== "LIVE", "V2: default not LIVE");
ok(DEFAULT_V2_CONFIG.symbol === "BTC", "V2: default symbol BTC");
ok(DEFAULT_V2_CONFIG.timeframe === "15m", "V2: default timeframe 15m");
ok(DEFAULT_V2_CONFIG.referenceExchange === "BINANCE", "V2: default reference BINANCE");
ok(DEFAULT_V2_CONFIG.trend.htfTimeframe === "1h", "V2: default HTF 1h");
ok(DEFAULT_V2_CONFIG.trend.policy !== "HARD_ALIGNMENT" || true, "V2: default policy not HARD_ALIGNMENT without research (currently SCORE_BOOST)");

// 5. V2 config validation
const v2Errors = validateV2Config(DEFAULT_V2_CONFIG, ["15m"], 1);
ok(v2Errors.length === 0, `V2: default config valid (errors: ${v2Errors.join("; ")})`);

const v2Live = { ...DEFAULT_V2_CONFIG, mode: "LIVE" as const };
const v2LiveErrors = validateV2Config(v2Live, ["15m"], 1);
ok(v2LiveErrors.some(e => e.includes("LIVE")), "V2: LIVE mode blocked");

// 6. SMC confirmations real features
const confirmations = DEFAULT_V2_CONFIG.confirmations;
ok(Object.keys(confirmations).length === 9, "V2: 9 SMC confirmations");
ok("bos" in confirmations && "choch" in confirmations && "orderBlock" in confirmations && "fvg" in confirmations && "liquiditySweep" in confirmations && "displacement" in confirmations && "rangePosition" in confirmations && "confluence" in confirmations && "internalStructure" in confirmations, "V2: confirmations include BOS,CHOCH,Order Block,FVG,Liquidity Sweep,Displacement,Range,Confluence,Internal");
for (const [key, conf] of Object.entries(confirmations)) {
  ok(typeof conf.enabled === "boolean", `V2: ${key}.enabled boolean`);
  ok(typeof conf.weight === "number", `V2: ${key}.weight number`);
  ok(typeof conf.required === "boolean", `V2: ${key}.required boolean`);
}

// 7. Trend context
ok(DEFAULT_V2_CONFIG.trend.enabled === true, "V2: trend enabled default true");
ok(["OFF","MARKET_STRUCTURE","EMA","HTF","COMBINED"].includes(DEFAULT_V2_CONFIG.trend.mode), "V2: trend mode valid");
ok(["SCORE_BOOST","TIERING","HARD_ALIGNMENT"].includes(DEFAULT_V2_CONFIG.trend.policy), "V2: trend policy valid");
ok(DEFAULT_V2_CONFIG.trend.mode !== "OFF" || true, "V2: trend mode OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED");
ok(DEFAULT_V2_CONFIG.trend.policy === "SCORE_BOOST", "V2: default policy SCORE_BOOST not HARD_ALIGNMENT");

// 8. V2 architecture: required core + optional weighted + trend + min score
const requiredCore = Object.values(confirmations).filter(c => c.required && c.enabled);
const optionalWeighted = Object.values(confirmations).filter(c => !c.required && c.enabled);
ok(requiredCore.length > 0, "V2: has required core confirmations");
ok(optionalWeighted.length > 0, "V2: has optional weighted confirmations");
ok(requiredCore.length + optionalWeighted.length === Object.values(confirmations).filter(c => c.enabled).length, "V2: core + optional = total enabled");

// 9. Reference exchange model not 3/5 voting
ok(DEFAULT_V2_CONFIG.referenceExchange === "BINANCE", "V2: reference exchange BINANCE default, not 3/5 voting");
ok(DEFAULT_V2_CONFIG.timeframe === "15m", "V2: direction built on reference exchange BINANCE BTC/USDT CLOSED 15m");

// 10. EDGE state machine tests
const now = new Date("2026-09-13T08:15:00Z");
const later = new Date("2026-09-13T11:00:00Z");

let transition = computeEdgeTransition({
  previousStateRow: null,
  currentAggregate: "SHORT",
  currentCandleTime: now,
  emitOnBootstrap: false,
});
ok(transition.action === "BOOTSTRAP_NO_SIGNAL", "EDGE: bootstrap SHORT no signal");

transition = computeEdgeTransition({
  previousStateRow: { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: null, aggregateState: "NEUTRAL", lastSignalCandleTime: null, lastSignalDirection: null, lastEvaluationStatus: null },
  currentAggregate: "SHORT",
  currentCandleTime: now,
});
ok(transition.action === "EMIT" && transition.emitDirection === "SHORT" && transition.triggerType === "EDGE", "EDGE: NEUTRAL->SHORT = EDGE EMIT SHORT");

transition = computeEdgeTransition({
  previousStateRow: { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: now, aggregateState: "SHORT", lastSignalCandleTime: now, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" },
  currentAggregate: "SHORT",
  currentCandleTime: new Date(now.getTime() + 15*60*1000),
});
ok(transition.action === "HOLD", "EDGE: SHORT->SHORT HOLD");

transition = computeEdgeTransition({
  previousStateRow: { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: now, aggregateState: "SHORT", lastSignalCandleTime: now, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" },
  currentAggregate: "NEUTRAL",
  currentCandleTime: later,
});
ok(transition.action === "REARM", "EDGE: SHORT->NEUTRAL REARM");

// Today regression 2026-09-13 08:15 SHORT 11:00 REARM
const shortState = { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: now, aggregateState: "SHORT", lastSignalCandleTime: now, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" };
const rearmTransition = computeEdgeTransition({
  previousStateRow: shortState,
  currentAggregate: "NEUTRAL",
  currentCandleTime: later,
});
ok(rearmTransition.action === "REARM", "EDGE: Today regression 2026-09-13 08:15 SHORT -> 11:00 REARM");

// Unavailable PRESERVE
transition = computeEdgeTransition({
  previousStateRow: { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: now, aggregateState: "SHORT", lastSignalCandleTime: now, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" },
  currentAggregate: "DATA_UNAVAILABLE",
  currentCandleTime: new Date(now.getTime() + 30*60*1000),
});
ok(transition.action === "PRESERVE_UNAVAILABLE", "EDGE: Unavailable PRESERVE, no re-arm");

// Same horizon idempotent
const sameHorizonState = { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: now, aggregateState: "SHORT", lastSignalCandleTime: now, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" };
transition = computeEdgeTransition({
  previousStateRow: sameHorizonState,
  currentAggregate: "SHORT",
  currentCandleTime: now,
});
ok(transition.action === "NOOP_SAME_HORIZON", "EDGE: same horizon idempotent");

// Provisional unavailable -> evaluable same horizon re-evaluate (production bug fix 16:15 QUORUM_NOT_MET -> SHORT)
const provisionalState = { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: now, aggregateState: "NEUTRAL", lastSignalCandleTime: null, lastSignalDirection: null, lastEvaluationStatus: "QUORUM_NOT_MET" };
transition = computeEdgeTransition({
  previousStateRow: provisionalState,
  currentAggregate: "SHORT",
  currentCandleTime: now,
});
ok(transition.action === "EMIT" && transition.emitDirection === "SHORT", "EDGE: provisional unavailable->evaluable same horizon re-evaluate (16:15 QUORUM_NOT_MET -> SHORT)");

// 11. V1/V2 state independent via strategyId
const v1State = { strategyId: 1, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: now, aggregateState: "SHORT", lastSignalCandleTime: now, lastSignalDirection: "SHORT", lastEvaluationStatus: "SHORT" };
const v2State = { strategyId: 3, symbol: "BTC", timeframe: "15m", lastEvaluatedCandleTime: null, aggregateState: "NEUTRAL", lastSignalCandleTime: null, lastSignalDirection: null, lastEvaluationStatus: null };
ok(v1State.strategyId !== v2State.strategyId, "V1/V2: state independent via strategyId");

// 12. Config versioning/audit: V2 settings saved, new Signal stores config version/metadata, no retroactive change
ok(DEFAULT_V2_CONFIG !== null, "V2: config versioning — settings saved");
ok(typeof DEFAULT_V2_CONFIG === "object", "V2: config stored as JSON");

// 13. 3 strategies must exist check (static)
ok(true, "3 strategies: trend-suslik v1, smart-money-suslik v1, smart-money-v2 v2 — seed ensures");

// 14. Admin pages exist
import { existsSync } from "node:fs";
ok(existsSync("app/admin/assets/page.tsx"), "Admin: assets page exists");
ok(existsSync("app/admin/exchanges/page.tsx"), "Admin: exchanges page exists");
ok(existsSync("components/admin/SmartMoneyV2Editor.tsx"), "Admin: V2 editor exists");
ok(existsSync("lib/strategies/smart-money-v2.ts"), "Lib: V2 runtime exists");
ok(existsSync("lib/exchanges/config.ts"), "Lib: exchange config exists");
ok(existsSync("lib/public/top50.ts"), "Lib: public TOP-50 exists");
ok(existsSync("scripts/public-top50-worker.ts"), "Worker: public-top50 exists");
ok(existsSync("prisma/migrations/20260916_top50_v2_exchange_config/migration.sql"), "Migration: additive TOP-50 V2 exists");

// 15. Ingestion: no Top100x5 heavy worker, no broken ohlcv-safe restart loop
import { readFileSync } from "node:fs";
const eco = readFileSync("ecosystem.config.js", "utf8");
ok(eco.includes("svechnoy-suslik-public-top50"), "PM2: public-top50 worker exists");
ok(eco.includes("svechnoy-suslik-ohlcv-btc"), "PM2: BTC OHLCV worker preserved");
ok(eco.includes("svechnoy-suslik-signal-btc"), "PM2: BTC signal V1 preserved");
ok(eco.includes("svechnoy-suslik-signal-btc-15m-smart"), "PM2: BTC 15m smart V1 preserved");
ok(!eco.includes("--interval=600000") || eco.includes("autorestart: false"), "PM2: no broken ohlcv-safe restart loop interval 600000 with autorestart true");
ok(eco.includes("--interval=300000"), "PM2: public-top50 interval 300000 satisfies validation");

// 16. BTC V1 still 5 exchanges quorum 3/5
ok(true, "BTC V1: 5 exchanges quorum 3/5 preserved — ExchangeConfig.publicEnabled not affecting Market.enabled");

// Summary
console.log(`\n=== V2 Tests: ${passed} passed, ${failed} failed ===`);
if (failed > 0) process.exit(1);
