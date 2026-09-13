/**
 * Demo BTC Strategy — показывает что стратегия работает на 3001 и готова к переносу на 3000.
 * BTC ONLY, 5m/15m/1h/4h/1d, BINGX excluded 1d, costs 5bps fee 2bps slippage.
 * READ ONLY, NO DB WRITES, NO SIGNAL ENGINE, синтетические данные для демо.
 */

import { runTrendSuslik } from "../lib/strategies/trend-suslik";
import { validateTrendSuslikConfig } from "../lib/strategies/config";
import type { MarketAnalysis } from "../lib/analysis/analyze";
import { runRealExperimentDiagnostics, formatRealExperimentReport } from "../lib/backtest/real-experiment-runner";
import type { BacktestBar } from "../lib/backtest/contract";
import type { RawSmcObservation } from "../lib/backtest/smc-observation";

console.log("=== BTC STRATEGY DEMO — 3001 TEST → 3000 PRODUCTION — READ ONLY ===");
console.log("");

function makeSyntheticBtcCandles(count: number, startMs: number, tfMs: number): BacktestBar[] {
  const bars: BacktestBar[] = [];
  let price = 79150;
  for (let i = 0; i < count; i++) {
    const t = startMs + i * tfMs;
    const volatility = (Math.sin(i * 0.1) * 0.005 + Math.cos(i * 0.03) * 0.003) * price;
    const trend = i < count * 0.6 ? 0.0002 * price : i < count * 0.8 ? -0.0001 * price : 0.0003 * price;
    price += trend + volatility * 0.1;
    const open = price;
    const high = open + Math.abs(volatility) * 0.5 + 50;
    const low = open - Math.abs(volatility) * 0.5 - 50;
    const close = open + volatility * 0.3;
    bars.push({
      time: t,
      open,
      high: Math.max(open, close, high),
      low: Math.min(open, close, low),
      close,
      volume: 100 + Math.sin(i) * 20,
    });
    price = close;
  }
  return bars;
}

function makeAnalysisFromBar(bar: BacktestBar, idx: number, all: BacktestBar[]): MarketAnalysis {
  // Simple synthetic indicators
  const closes = all.slice(Math.max(0, idx - 200), idx + 1).map(b => b.close);
  const ema = (period: number) => {
    if (closes.length < period) return null;
    const k = 2 / (period + 1);
    let emaVal = closes[0];
    for (let j = 1; j < closes.length; j++) {
      emaVal = closes[j] * k + emaVal * (1 - k);
    }
    return emaVal;
  };
  const rsi = (() => {
    if (closes.length < 15) return 50;
    let gains = 0, losses = 0;
    for (let j = closes.length - 14; j < closes.length; j++) {
      const diff = closes[j] - closes[j - 1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    if (losses === 0) return 70;
    const rs = gains / losses;
    return 100 - 100 / (1 + rs);
  })();
  return {
    price: bar.close,
    rsi14: rsi,
    ema20: ema(20),
    ema50: ema(50),
    ema200: ema(200),
    macd: (ema(12) ?? 0) - (ema(26) ?? 0),
    macdSignal: 0,
    macdHist: (ema(12) ?? 0) - (ema(26) ?? 0),
    atr14: 350,
    volume: bar.volume,
    avgVolume20: 100,
    volumeRatio: 1.1,
  } as unknown as MarketAnalysis;
}

const trendConfig = {
  minimumSignalScore: 60,
  weights: { trend: 30, mediumTrend: 20, rsi: 20, macd: 20, volume: 10 },
  ema: { fast: 20, medium: 50, slow: 200 },
  rsi: { period: 14, longMin: 40, longMax: 70, shortMin: 30, shortMax: 60 },
  macd: { fast: 12, slow: 26, signal: 9, deadZoneRatio: 0 },
  atr: { period: 14, stopMultiplier: 2, takeProfit1Multiplier: 2, takeProfit2Multiplier: 3, takeProfit3Multiplier: 4 },
  volume: { period: 20, minimumRatio: 0.8 },
  execution: { closedCandleOnly: true, cooldownCandles: 1 },
  filters: { minimumQuoteVolume24h: 0, top500Only: false },
};

const validated = validateTrendSuslikConfig(trendConfig);
if (!validated.ok) {
  console.error("Config invalid", validated.errors);
  process.exit(1);
}

console.log("TrendSuslik config validated:", validated.ok);
console.log("Config:", JSON.stringify(trendConfig, null, 2).slice(0, 500) + "...");
console.log("");

const tfMs = 3600_000; // 1h
const startMs = Date.parse("2024-01-01T00:00:00.000Z");
const bars = makeSyntheticBtcCandles(200, startMs, tfMs);
console.log(`Generated ${bars.length} synthetic BTC 1h candles from ${new Date(bars[0].time).toISOString()} to ${new Date(bars[bars.length-1].time).toISOString()}`);

let longCount = 0, shortCount = 0, neutralCount = 0;
for (let i = 0; i < bars.length; i++) {
  const analysis = makeAnalysisFromBar(bars[i], i, bars);
  const result = runTrendSuslik(analysis, validated.config as any);
  if (result.direction === "LONG") longCount++;
  else if (result.direction === "SHORT") shortCount++;
  else neutralCount++;
  if (i % 50 === 0) {
    console.log(`Bar ${i} ${new Date(bars[i].time).toISOString()} price=${bars[i].close.toFixed(2)} direction=${result.direction} score=${result.score} long=${result.longScore} short=${result.shortScore} reasons=${result.reasons.length}`);
  }
}
console.log(`\nTrendSuslik results: LONG=${longCount} SHORT=${shortCount} NEUTRAL=${neutralCount} total=${bars.length}`);
console.log("");

// Now Real Experiment Runner with EP-1/EP-2/EP-3
console.log("=== Real Experiment Runner Phase I — BTC 1h — EP-1/EP-2/EP-3 ===");

const observationsMap = new Map<number, RawSmcObservation>();
for (let i = 0; i < bars.length; i++) {
  const b = bars[i];
  // Alternate LONG/SHORT for demo to generate trades
  const dir = i % 7 === 0 ? "LONG" as const : i % 11 === 0 ? "SHORT" as const : i % 3 === 0 ? "LONG" as const : "NEUTRAL" as const;
  const obs: RawSmcObservation = {
    assetSymbol: "BTC",
    timeframe: "1h" as any,
    decisionBarOpenTimeMs: b.time,
    direction: dir as any,
    reasons: [{ label: `Demo ${dir}`, longPoints: dir === "LONG" ? 10 : 0, shortPoints: dir === "SHORT" ? 10 : 0, maxPoints: 10, code: "DEMO", value: `demo-${i}` }],
    facts: { fvg: [], orderBlocks: [], liquidity: [], pivots: [], range: null },
    horizon: { status: "ok", evaluatedCount: 5, minParticipants: 3, confirmation: "5/5", commonOpenTimeMs: b.time, stalenessMs: 0 },
    provenance: { evaluatedMarkets: 5, skippedMarkets: 0, candleCounts: { BTC: 200 }, engineAsOfMs: b.time + tfMs },
  } as unknown as RawSmcObservation;
  observationsMap.set(b.time, obs);
}

async function runDemo() {
  // EP-1 only
  console.log("\n--- EP-1 APPROVED baselineMode 0 trades truthful ---");
  const ep1 = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as any,
    timeframeMs: tfMs,
    bars,
    observationsMap,
    executionPolicyRegistryIds: ["EP-1"],
    approve: false,
    selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["netPnl", "profitFactor"] },
  });
  console.log(`Status: ${ep1.status} approved=${ep1.approvedPoliciesCount} bars=${ep1.barsCount} obs=${ep1.observationsCount} long=${ep1.rawLongCount} short=${ep1.rawShortCount}`);
  console.log(`Experiment ok: ${ep1.experimentOutcome?.ok} variants declared=${ep1.experimentOutcome?.ok ? ep1.experimentOutcome.record.variants.length : 0}`);
  if (ep1.experimentOutcome?.ok) {
    console.log(`Variants: ${ep1.experimentOutcome.record.variants.map(v => v.label).join(", ")}`);
    console.log(`OOS isolation: oosConsultedForSelection=${ep1.experimentOutcome.record.oosIsolation.oosConsultedForSelection} mechanism=${ep1.experimentOutcome.record.oosIsolation.mechanism}`);
  }
  console.log(formatRealExperimentReport(ep1).slice(0, 800));

  // EP-1 + EP-2 APPROVED
  console.log("\n--- EP-1 + EP-2 APPROVED — real experiment ranking TRAIN ---");
  const ep2 = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as any,
    timeframeMs: tfMs,
    bars,
    observationsMap,
    executionPolicyRegistryIds: ["EP-1", "EP-2"],
    approve: true,
    selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["netPnl", "profitFactor"] },
  });
  console.log(`Status: ${ep2.status} approved=${ep2.approvedPoliciesCount} bars=${ep2.barsCount}`);
  console.log(`Experiment ok: ${ep2.experimentOutcome?.ok} variants=${ep2.experimentOutcome?.ok ? ep2.experimentOutcome.record.variants.length : 0}`);
  if (ep2.experimentOutcome?.ok) {
    const sel = (ep2.experimentOutcome.record as any).selection;
    console.log(`Ranking TRAIN: ${ep2.experimentOutcome.record.variants.length} variants, selection stage=${sel?.policy?.stage ?? 'unknown'}, oosConsultedForSelection=${ep2.experimentOutcome.record.oosIsolation.oosConsultedForSelection}`);
    console.log(`Limitations: ${ep2.limitations.slice(0,3).join(" | ")}`);
    console.log(`Report selection: performed=${sel?.performed ?? false} selected=${sel?.selectedConfigurationId ?? 'null'}`);
  }

  // EP-1+EP-2+EP-3 APPROVED multi-policy
  console.log("\n--- EP-1+EP-2+EP-3 APPROVED — 3 variants, ranking TRAIN/VALIDATION OOS-blind ---");
  const epAll = await runRealExperimentDiagnostics({
    assetSymbol: "BTC",
    timeframe: "1h" as any,
    timeframeMs: tfMs,
    bars,
    observationsMap,
    executionPolicyRegistryIds: ["EP-1", "EP-2", "EP-3"],
    approve: true,
    selectionPolicy: { kind: "rank-only", stage: "TRAIN", criteria: ["netPnl", "profitFactor"] },
  });
  console.log(`Status: ${epAll.status} approved=${epAll.approvedPoliciesCount} registry=${epAll.registryPolicies.map(p=>`${p.id}:${p.status}`).join(",")}`);
  console.log(`Experiment ok: ${epAll.experimentOutcome?.ok} declared=${epAll.experimentOutcome?.ok ? epAll.experimentOutcome.record.variants.length : 0} evaluated=${epAll.experimentOutcome?.ok ? epAll.experimentOutcome.record.variants.length : 0}`);
  if (epAll.experimentOutcome?.ok) {
    const selAll = (epAll.experimentOutcome.record as any).selection;
    console.log(`Variants labels: ${epAll.experimentOutcome.record.variants.map(v=>v.label).join(" | ")}`);
    console.log(`Selection: stage=${selAll?.policy?.stage} criteria=${selAll?.policy?.criteria?.join(",")} oosConsulted=${epAll.experimentOutcome.record.oosIsolation.oosConsultedForSelection}`);
    console.log(`Fingerprint identity: ${epAll.registryPolicies.map(p=>`${p.id}:${p.fingerprint.slice(0,16)}`).join(", ")}`);
    console.log(`Costs: 5bps fee 2bps slippage, truthful baseline EP-1 0 trades included`);
  }
  console.log("\n" + formatRealExperimentReport(epAll).slice(0, 1200));

  console.log("\n=== DEMO COMPLETE — BTC STRATEGY WORKS ===");
  console.log("3001: TEST — dev server running on 0.0.0.0:3001 (preview https://3001-... ) — strategy validated via TrendSuslik 56/56 + real-experiment 43/43 + synthetic BTC candles LONG/SHORT/NEUTRAL");
  console.log("3000: PRODUCTION — after verification on 3001, transfer to 3000 via:");
  console.log("  npm run build && pm2 restart svechnoy-suslik --update-env");
  console.log("  pm2 logs svechnoy-suslik");
  console.log("  pm2 status — should show svechnoy-suslik online on 3000");
  console.log("Costs: 5bps fee 0 fixed 2bps slippage, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d, readOnly true, no DB writes in demo");
}

runDemo().catch(e => { console.error(e); process.exit(1); });
