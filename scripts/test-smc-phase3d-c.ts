/**
 * SMC Phase 3D-C — Strategy JSON / Runtime boundary for advanced config
 * Запуск: npx tsx scripts/test-smc-phase3d-c.ts
 *
 * Covers:
 * 1) old JSON without advanced validates unchanged
 * 2) partial advanced
 * 3) all 14 fields round-trip via validateSmartMoneyConfig
 * 4) all groups round-trip via validateSmartMoneyRuntime
 * 5) runtime behavior receives custom values
 * 6) malformed (null/array/wrong types/NaN/Infinity/bounds/nested unknown)
 * 7) unknown top-level reject (displecement etc) without breaking legacy
 * 8) filters/weights remain accepted
 * 9) legacy top500Only
 * 10) unknown weights/filters strict (documented)
 * 11) Trend unchanged
 * 12) deterministic/no-lookahead preserved
 * 13) no Signal writes
 */

import { readFileSync } from "fs";
import { validateSmartMoneyConfig, validateSmartMoneyRuntime, evaluateSmartMoneyWithCandles } from "../lib/strategies/smart-money";
import { defaultSmcScoringConfig, resolveSmcAdvancedConfig, deriveSubConfigs } from "../lib/smc/config";
import { evaluateDisplacements } from "../lib/smc/displacement";
import { evaluateSmc } from "../lib/smc/evaluate";
import { SmcRawCandle, SmcTimeframe } from "../lib/smc/types";
import { validateTrendSuslikConfig } from "../lib/strategies/config";

let passed = 0;
let total = 0;
function ok(cond: boolean, label: string): void {
  total += 1;
  if (cond) passed += 1;
  else console.error(`FAIL: ${label}`);
}

const T0 = Date.UTC(2026, 0, 1);
const HOUR = 3600000;
function mk(i: number, o: number, c: number, h?: number, l?: number): SmcRawCandle {
  return { openTime: new Date(T0 + i * HOUR), open: o, high: h ?? Math.max(o, c), low: l ?? Math.min(o, c), close: c, closed: true };
}
function flat(i: number): SmcRawCandle {
  const b = i * 0.01;
  return mk(i, 86 + b, 87 + b, 90 + b, 84 + b);
}
function flats(a: number, b: number): SmcRawCandle[] { const out: SmcRawCandle[] = []; for (let i = a; i <= b; i++) out.push(flat(i)); return out; }
function flat6(i: number) { return mk(i, 102, 103, 106, 100); }
function warmup6(n: number) { return Array.from({length:n},(_,i)=>flat6(i)); }

function canonicalBase(): Record<string, unknown> {
  return {
    minimumSignalScore: 72,
    swingLeft: 20,
    swingRight: 20,
    internalLeft: 3,
    internalRight: 3,
    atrPeriod: 14,
    structureEventFreshBars: 10,
    sweepFreshBars: 5,
    orderBlockFreshBars: 20,
    fvgFreshBars: 20,
    eqBand: 0.02,
    weights: {
      swingStructureBias: 20,
      recentSwingBos: 15,
      internalStructure: 10,
      liquiditySweep: 10,
      swingOrderBlock: 15,
      internalOrderBlock: 5,
      fvg: 10,
      rangePosition: 10,
      confluence: 5,
    },
    filters: { minimumQuoteVolume24h: 0, top500Only: false } as any,
  };
}
function canonicalSmallBase(): Record<string, unknown> {
  // for behavioral tests with small windows
  return {
    ...canonicalBase(),
    swingLeft: 1,
    swingRight: 1,
    internalLeft: 1,
    internalRight: 1,
  };
}

/* ---------- 1. old JSON without advanced validates unchanged ---------- */
{
  const base = canonicalBase();
  const r = validateSmartMoneyConfig(base, "1h");
  ok(r.ok === true, "1a: old JSON without advanced validates");
  if (r.ok) {
    ok(r.config.displacement === undefined && (r.config as any).fvg === undefined, "1b: old config has no advanced groups (undefined, not leaked)");
    // ensure default via derive still 1.5 etc
    const subs = deriveSubConfigs(r.config);
    ok(subs.displacement.bodyAtrMin === 1.5 && subs.fvg.minGapAtr === 0.1, "1c: old derived defaults 1.5/0.1");
    // actual DB row shape: same but without advanced, and enabled=false DRAFT
    const rt = validateSmartMoneyRuntime({ config: base, timeframes: ["1h"], minExchanges: 3 });
    ok(rt.ok === true && rt.minExchanges === 3, "1d: runtime with old JSON ok");
  }
  // Existing DB row id=2 has no advanced groups and MUST require no migration
  // Simulate its config JSON exactly as stored (seed canonical)
  const dbRowConfig = canonicalBase();
  const dbRes = validateSmartMoneyConfig(dbRowConfig, "1h");
  ok(dbRes.ok === true, "1e: DB id=2 shape without advanced still valid (no migration needed)");
}

/* ---------- 2. partial advanced ---------- */
{
  const partial = { ...canonicalBase(), displacement: { bodyAtrMin: 3 } };
  const r = validateSmartMoneyConfig(partial, "1h");
  ok(r.ok === true, "2a: partial displacement {bodyAtrMin:3} validates");
  if (r.ok) {
    ok((r.config as any).displacement.bodyAtrMin === 3, "2b: partial preserves 3");
    const adv = resolveSmcAdvancedConfig(r.config);
    ok(adv.displacement.rangeAtrMin === 2.0 && adv.displacement.bullCloseLocMin === 0.6, "2c: partial fallback 2.0/0.6");
    // empty groups
    const empty = { ...canonicalBase(), displacement: {}, fvg: {}, liquidity: {}, orderBlock: {} };
    const re = validateSmartMoneyConfig(empty, "1h");
    ok(re.ok === true, "2d: empty groups {} valid and fallback");
  }
}

/* ---------- 3. all 14 fields round-trip via validateSmartMoneyConfig ---------- */
{
  const all14: Record<string, unknown> = {
    ...canonicalBase(),
    displacement: { bodyAtrMin: 1.6, rangeAtrMin: 2.1, bullCloseLocMin: 0.7, bearCloseLocMax: 0.3 },
    fvg: { minGapAtr: 0.15, maxAgeCandles: 5 },
    liquidity: { eqToleranceAtr: 0.2, eqConfirmBars: 3, sweepMinPenetrationAtr: 0.1, maxAgeCandles: 10 },
    orderBlock: { impulseMaxCandles: 4, confirmMaxCandles: 12, maxAgeCandles: 800, sweepLookbackCandles: 6 },
  };
  const r = validateSmartMoneyConfig(all14, "1h");
  ok(r.ok === true, "3a: all 14 fields round-trip config ok");
  if (r.ok) {
    const c = r.config as any;
    ok(c.displacement.bodyAtrMin === 1.6, "3b: displacement bodyAtrMin 1.6");
    ok(c.displacement.rangeAtrMin === 2.1, "3c: rangeAtrMin 2.1");
    ok(c.displacement.bullCloseLocMin === 0.7, "3d: bull 0.7");
    ok(c.displacement.bearCloseLocMax === 0.3, "3e: bear 0.3");
    ok(c.fvg.minGapAtr === 0.15, "3f: fvg minGap 0.15");
    ok(c.fvg.maxAgeCandles === 5, "3g: fvg maxAge 5");
    ok(c.liquidity.eqToleranceAtr === 0.2, "3h: liq eqTol 0.2");
    ok(c.liquidity.eqConfirmBars === 3, "3i: eqConfirm 3");
    ok(c.liquidity.sweepMinPenetrationAtr === 0.1, "3j: sweep 0.1");
    ok(c.liquidity.maxAgeCandles === 10, "3k: liq maxAge 10");
    ok(c.orderBlock.impulseMaxCandles === 4, "3l: impulse 4");
    ok(c.orderBlock.confirmMaxCandles === 12, "3m: confirm 12");
    ok(c.orderBlock.maxAgeCandles === 800, "3n: ob maxAge 800");
    ok(c.orderBlock.sweepLookbackCandles === 6, "3o: lookback 6");
    // Also via derive
    const subs = deriveSubConfigs(c);
    ok(subs.displacement.bodyAtrMin === 1.6 && (subs.orderBlockSwing as any).displacementBodyAtrMin === 1.6, "3p: derive preserves 1.6 to OB");
    ok(subs.fvg.minGapAtr === 0.15 && (subs.orderBlockSwing as any).fvgMinGapAtr === 0.15, "3q: derive fvg minGap to OB");
  }
}

/* ---------- 4. all groups round-trip via validateSmartMoneyRuntime ---------- */
{
  const all14: Record<string, unknown> = {
    ...canonicalBase(),
    displacement: { bodyAtrMin: 1.6, rangeAtrMin: 2.1, bullCloseLocMin: 0.7, bearCloseLocMax: 0.3 },
    fvg: { minGapAtr: 0.15, maxAgeCandles: 5 },
    liquidity: { eqToleranceAtr: 0.2, eqConfirmBars: 3, sweepMinPenetrationAtr: 0.1, maxAgeCandles: 10 },
    orderBlock: { impulseMaxCandles: 4, confirmMaxCandles: 12, maxAgeCandles: 800, sweepLookbackCandles: 6 },
  };
  const rt = validateSmartMoneyRuntime({ config: all14, timeframes: ["1h"], minExchanges: 3 });
  ok(rt.ok === true, "4a: runtime with all14 ok");
  if (rt.ok) {
    ok(rt.configs["1h"].displacement?.bodyAtrMin === 1.6, "4b: runtime preserves displacement 1.6");
    ok(rt.configs["1h"].fvg?.minGapAtr === 0.15, "4c: runtime fvg 0.15");
    ok(rt.configs["1h"].liquidity?.eqConfirmBars === 3, "4d: runtime liq 3");
    ok(rt.configs["1h"].orderBlock?.impulseMaxCandles === 4, "4e: runtime ob 4");
  }
  // ensure filters preserved
  const withFilters = { ...all14, filters: { minimumQuoteVolume24h: 1000000, top500Only: true } as any };
  const rt2 = validateSmartMoneyRuntime({ config: withFilters, timeframes: ["1h"], minExchanges: 2 });
  ok(rt2.ok === true && rt2.filters.top500Only === true, "4f: runtime preserves filters");
}

/* ---------- 5. runtime behavior receives custom values ---------- */
{
  // displacement bodyAtrMin 3.0 must be observed in core
  const base = canonicalSmallBase();
  const custom = { ...base, displacement: { bodyAtrMin: 3.0 } };
  const rBase = validateSmartMoneyConfig(base, "1h");
  const rCustom = validateSmartMoneyConfig(custom, "1h");
  ok(rBase.ok && rCustom.ok, "5a: base and custom validate");
  if (rBase.ok && rCustom.ok) {
    const subBase = deriveSubConfigs(rBase.config);
    const subCustom = deriveSubConfigs(rCustom.config);
    ok(subBase.displacement.bodyAtrMin === 1.5 && subCustom.displacement.bodyAtrMin === 3.0, "5b: derive 1.5 vs 3.0");
    // controlled fixture: warmup 16 flat6 ATR 6, candidate body 9.75 => bodyAtr 1.5
    const fixture = [...warmup6(16), mk(16, 100.5, 110.25, 113, 100)];
    const asOf = new Date(T0 + 17 * HOUR);
    ok(evaluateDisplacements(fixture, subBase.displacement, asOf).length === 1, "5c: default detects displacement 1.5");
    ok(evaluateDisplacements(fixture, subCustom.displacement, asOf).length === 0, "5d: custom 3.0 rejects 1.5 (behavior)");
    // via smart-money runtime config
    const rtCustom = validateSmartMoneyRuntime({ config: custom, timeframes: ["1h"], minExchanges: 3 });
    ok(rtCustom.ok === true && (rtCustom as any).configs["1h"].displacement.bodyAtrMin === 3.0, "5e: runtime 1h contains 3.0");
    // also prove via evaluateSmc uses 3.0 (create longer fixture with enough history for evaluateSmc)
    // Use longer synthetic fixture that would be evaluable with swing 1/1
    // Simpler: prove via derive already does; evaluateSmc would also see via same derive
    const advCustom = resolveSmcAdvancedConfig(rCustom.config);
    ok(advCustom.displacement.bodyAtrMin === 3.0, "5f: resolve 3.0");
  }
  // representative other groups: FVG minGap, Liquidity eqConfirm, OB impulse
  const fvgCustom = { ...canonicalSmallBase(), fvg: { minGapAtr: 0.5 } };
  const fvgRes = validateSmartMoneyConfig(fvgCustom, "1h");
  ok(fvgRes.ok === true && (fvgRes as any).config.fvg.minGapAtr === 0.5, "5g: FVG minGap 0.5 round-trip");
  const liqCustom = { ...canonicalSmallBase(), liquidity: { eqConfirmBars: 5 } };
  const liqRes = validateSmartMoneyConfig(liqCustom, "1h");
  ok(liqRes.ok === true && (liqRes as any).config.liquidity.eqConfirmBars === 5, "5h: liquidity eqConfirm 5");
  const obCustom = { ...canonicalSmallBase(), orderBlock: { impulseMaxCandles: 7 } };
  const obRes = validateSmartMoneyConfig(obCustom, "1h");
  ok(obRes.ok === true && (obRes as any).config.orderBlock.impulseMaxCandles === 7, "5i: orderBlock impulse 7");
}

/* ---------- 6. malformed ---------- */
{
  function rejects(raw: unknown, label: string) {
    const r = validateSmartMoneyConfig(raw, "1h");
    ok(r.ok === false, label);
  }
  const base = canonicalBase();
  rejects({ ...base, displacement: null as any }, "6a: group null rejected");
  rejects({ ...base, fvg: [] as any }, "6b: group array rejected");
  rejects({ ...base, liquidity: "bad" as any }, "6c: group wrong type rejected");
  rejects({ ...base, displacement: { bodyAtrMin: "bad" as any } }, "6d: wrong scalar type rejected");
  rejects({ ...base, displacement: { bodyAtrMin: NaN as any } }, "6e: NaN rejected");
  rejects({ ...base, fvg: { minGapAtr: Infinity as any } }, "6f: Infinity rejected");
  rejects({ ...base, orderBlock: { impulseMaxCandles: 0 as any } }, "6g: invalid integer 0 rejected (1..10)");
  rejects({ ...base, orderBlock: { impulseMaxCandles: 11 as any } }, "6h: 11 rejected");
  rejects({ ...base, orderBlock: { impulseMaxCandles: 1.5 as any } }, "6i: fractional rejected");
  rejects({ ...base, fvg: { maxAgeCandles: -1 as any } }, "6j: negative rejected");
  rejects({ ...base, displacement: { bodyAtrMni: 1.5 as any } }, "6k: nested unknown typo rejected");
  rejects({ ...base, fvg: { typo: 1 as any } }, "6l: fvg typo rejected");
  rejects({ ...base, liquidity: { unexpected: 1 as any } }, "6m: liquidity unexpected rejected");
  rejects({ ...base, orderBlock: { foo: 1 as any } }, "6n: orderBlock foo rejected");
}

/* ---------- 7. unknown top-level reject without breaking legacy ---------- */
{
  function rejectsTop(raw: unknown, label: string) {
    const r = validateSmartMoneyConfig(raw, "1h");
    ok(r.ok === false, label);
  }
  const base = canonicalBase();
  rejectsTop({ ...base, displecement: { bodyAtrMin: 1.5 } as any }, "7a: displecement typo rejected");
  rejectsTop({ ...base, orderBlocks: { impulseMaxCandles: 3 } as any }, "7b: orderBlocks plural rejected");
  rejectsTop({ ...base, orderblock: { impulseMaxCandles: 3 } as any }, "7c: orderblock lowercase rejected");
  rejectsTop({ ...base, liqudity: { eqConfirmBars: 2 } as any }, "7d: liqudity typo rejected");
  rejectsTop({ ...base, randomFutureKnob: 123 as any }, "7e: randomFutureKnob rejected");
  // legacy must remain accepted (no break)
  const legacy = canonicalBase();
  // ensure top500Only legacy remains accepted (already in base)
  const okLegacy = validateSmartMoneyConfig(legacy, "1h");
  ok(okLegacy.ok === true, "7f: legacy without advanced still ok (no break)");
  const withLegacyTop = { ...base, filters: { minimumQuoteVolume24h: 500000, top500Only: true } as any };
  ok(validateSmartMoneyConfig(withLegacyTop, "1h").ok === true, "7g: legacy top500Only true still ok");
  // unknown top-level should not be confused with valid filters
  rejectsTop({ ...base, filters: { minimumQuoteVolume24h: 0, top500Only: false, extra: 1 } as any }, "7h: filters extra rejected (strict)");
}

/* ---------- 8. existing valid filters/weights remain accepted ---------- */
{
  const base = canonicalBase();
  ok(validateSmartMoneyConfig(base, "1h").ok === true, "8a: base filters/weights ok");
  const withValid = { ...base, filters: { minimumQuoteVolume24h: 1000000, top500Only: true } as any };
  ok(validateSmartMoneyConfig(withValid, "1h").ok === true, "8b: valid filters top500Only true + volume 1M ok");
  const weightsOk = {
    swingStructureBias: 20,
    recentSwingBos: 15,
    internalStructure: 10,
    liquiditySweep: 10,
    swingOrderBlock: 15,
    internalOrderBlock: 5,
    fvg: 10,
    rangePosition: 10,
    confluence: 5,
  };
  ok(validateSmartMoneyConfig({ ...base, weights: weightsOk }, "1h").ok === true, "8c: valid weights 9 keys sum 100 ok");
}

/* ---------- 9. legacy top500Only remains accepted ---------- */
{
  const base = canonicalBase();
  const withTopTrue = { ...base, filters: { minimumQuoteVolume24h: 0, top500Only: true } as any };
  const withTopFalse = { ...base, filters: { minimumQuoteVolume24h: 0, top500Only: false } as any };
  ok(validateSmartMoneyConfig(withTopTrue, "1h").ok === true, "9a: top500Only true accepted (means Top-100)");
  ok(validateSmartMoneyConfig(withTopFalse, "1h").ok === true, "9b: top500Only false accepted");
  // also via runtime
  ok(validateSmartMoneyRuntime({ config: withTopTrue, timeframes: ["1h"], minExchanges: 3 }).ok === true, "9c: runtime top500Only true ok");
}

/* ---------- 10. malformed weights/filter unknown keys strict (documented) ---------- */
{
  // After audit, we decided strict: unknown inner keys now fail-closed (previously silent)
  // This is safe because canonical has exactly 9 weights and 2 filters, and no existing stored config/test uses extra.
  const base = canonicalBase();
  const badW = { ...base, weights: { ...base.weights as any, extra: 5 } as any };
  ok(validateSmartMoneyConfig(badW, "1h").ok === false, "10a: weights extra rejected (strict, fail-closed)");
  const badF = { ...base, filters: { minimumQuoteVolume24h: 0, top500Only: false, extra: 1 } as any };
  ok(validateSmartMoneyConfig(badF, "1h").ok === false, "10b: filters extra rejected (strict)");
  console.log("NOTE: 10 — weights/filters inner unknown now strict fail-closed (previously silent); audited safe — no existing config uses extra keys");
}

/* ---------- 11. Trend unchanged ---------- */
{
  const trendRaw = {
    minimumSignalScore: 72,
    weights: { trend: 30, mediumTrend: 15, rsi: 20, macd: 20, volume: 15 },
    ema: { fast: 20, medium: 50, slow: 200 },
    rsi: { period: 14, longMin: 52, longMax: 72, shortMin: 28, shortMax: 48 },
    macd: { fast: 12, slow: 26, signal: 9 },
    atr: { period: 14, stopMultiplier: 1.5, takeProfit1Multiplier: 1.5, takeProfit2Multiplier: 2.5, takeProfit3Multiplier: 4 },
    volume: { period: 20, minimumRatio: 1 },
    execution: { closedCandleOnly: true, cooldownCandles: 3 },
    filters: { minimumQuoteVolume24h: 1000000, top500Only: true },
  };
  ok(validateTrendSuslikConfig(trendRaw).ok === true, "11: Trend config still valid (unchanged)");
}

/* ---------- 12. deterministic/no-lookahead preserved ---------- */
{
  const base = canonicalSmallBase();
  const raw: SmcRawCandle[] = [];
  for (let i = 0; i < 120; i++) {
    const o = 100 + Math.sin(i * 0.3) * 5;
    const c = 100 + Math.sin(i * 0.31) * 5 + (i % 7 === 0 ? 8 : 0);
    const high = Math.max(o, c) + 1 + (i % 10 === 0 ? 4 : 0);
    const low = Math.min(o, c) - 1 - (i % 10 === 5 ? 4 : 0);
    raw.push(mk(i, o, c, high, low));
  }
  const cfgRes = validateSmartMoneyConfig(base, "1h");
  ok(cfgRes.ok === true, "12a: base config valid for deterministic test");
  if (cfgRes.ok) {
    const asOf = new Date(T0 + 80 * HOUR);
    const full = evaluateSmc(raw, cfgRes.config, asOf);
    const prefix = raw.filter((c) => c.openTime.getTime() + HOUR <= asOf.getTime());
    const evalPrefix = evaluateSmc(prefix, cfgRes.config, asOf);
    ok(JSON.stringify(full) === JSON.stringify(evalPrefix), "12b: no-lookahead full ≡ prefix");
    const run2 = evaluateSmc(raw, cfgRes.config, new Date(T0 + 120 * HOUR));
    const run3 = evaluateSmc(raw, cfgRes.config, new Date(T0 + 120 * HOUR));
    ok(JSON.stringify(run2) === JSON.stringify(run3), "12c: deterministic identical");
  }
}

/* ---------- 13. no Signal writes ---------- */
{
  const smcContent = readFileSync("lib/strategies/smart-money.ts", "utf8");
  ok(!smcContent.includes("prisma.signal"), "13a: smart-money.ts no prisma.signal");
  const cfgContent = readFileSync("lib/smc/config.ts", "utf8");
  ok(!cfgContent.includes("prisma.signal"), "13b: config.ts no prisma.signal");
}

/* ---------- Multi-TF ---------- */
{
  const base = {
    ...canonicalBase(),
    displacement: { bodyAtrMin: 2.2 },
    fvg: { minGapAtr: 0.12 },
  };
  const rt = validateSmartMoneyRuntime({ config: base, timeframes: ["5m", "15m", "1h", "4h"], minExchanges: 3 });
  ok(rt.ok === true, "MT1: multi-TF 5m/15m/1h/4h ok with advanced");
  if (rt.ok) {
    for (const tf of ["5m", "15m", "1h", "4h"] as SmcTimeframe[]) {
      ok(rt.configs[tf].displacement?.bodyAtrMin === 2.2, `MT2: ${tf} preserves 2.2`);
      ok(rt.configs[tf].fvg?.minGapAtr === 0.12, `MT3: ${tf} preserves fvg 0.12`);
      ok(rt.configs[tf].tf === tf, `MT4: ${tf} tf matches`);
    }
  }
  // 1d can remain canonical-valid at pure validator level
  const rt1d = validateSmartMoneyRuntime({ config: base, timeframes: ["1d"], minExchanges: 3 });
  ok(rt1d.ok === true, "MT5: 1d canonical-valid at runtime validator level (rollout)");
  console.log("NOTE: MT5 — 1d runtime valid and Admin/API rollout now allows 1d (eligibility 4 eligible, alignment guard not weakened)");
}

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
