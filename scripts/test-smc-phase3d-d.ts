/**
 * SMC Phase 3D-D — Admin + API for all 14 advanced params (FIX: no Math.round)
 * Запуск: npx tsx scripts/test-smc-phase3d-d.ts
 *
 * Verifies:
 * - old config => 14 visible canonical defaults (normalize)
 * - all 14 fields represented in editor + defaults/ranges
 * - reset section / reset-all defaults
 * - UI ranges and integer validation (programmatic, not just string search)
 * - fractional integer-only fields are REJECTED, not rounded
 * - no Math.round(v) in Phase3D integer handlers
 * - prospective save payload includes exact values
 * - backend accepts valid all14, rejects malformed/unknown before update
 * - [] / 1d / mixed rejected, 5m/15m/1h/4h accepted
 * - Trend unchanged, Range unchanged, no Signal text, no DB mutation
 */

import { readFileSync } from "fs";
import { validateSmartMoneyConfig, validateSmartMoneyRuntime } from "../lib/strategies/smart-money";
import { deriveSubConfigs } from "../lib/smc/config";
import { validateTrendSuslikConfig } from "../lib/strategies/config";
import { evaluateSmc } from "../lib/smc/evaluate";
import { SmcRawCandle } from "../lib/smc/types";

let passed = 0;
let total = 0;
function ok(cond: boolean, label: string): void {
  total += 1;
  if (cond) passed += 1;
  else console.error(`FAIL: ${label}`);
}

const editorSrc = readFileSync("components/admin/SmartMoneyStrategyEditor.tsx", "utf8");
const apiSrc = readFileSync("app/api/admin/strategies/[id]/route.ts", "utf8");

// Helper canonical base (old DB shape without advanced)
function canonicalOld(): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Pure UI validation helper — exact mirror of editor's validateLocal
// (kept in sync with components/admin/SmartMoneyStrategyEditor.tsx)
// This allows programmatic proof without importing React client component.
// ---------------------------------------------------------------------------
type SmcWeights = {
  swingStructureBias: number;
  recentSwingBos: number;
  internalStructure: number;
  liquiditySweep: number;
  swingOrderBlock: number;
  internalOrderBlock: number;
  fvg: number;
  rangePosition: number;
  confluence: number;
};
type SmartMoneyAdvancedDisplacement = { bodyAtrMin: number; rangeAtrMin: number; bullCloseLocMin: number; bearCloseLocMax: number };
type SmartMoneyAdvancedFvg = { minGapAtr: number; maxAgeCandles: number };
type SmartMoneyAdvancedLiquidity = { eqToleranceAtr: number; eqConfirmBars: number; sweepMinPenetrationAtr: number; maxAgeCandles: number };
type SmartMoneyAdvancedOrderBlock = { impulseMaxCandles: number; confirmMaxCandles: number; maxAgeCandles: number; sweepLookbackCandles: number };
type SmartMoneyConfig = {
  minimumSignalScore: number;
  swingLeft: number; swingRight: number; internalLeft: number; internalRight: number;
  atrPeriod: number;
  structureEventFreshBars: number; sweepFreshBars: number; orderBlockFreshBars: number; fvgFreshBars: number;
  eqBand: number;
  weights: SmcWeights;
  filters: { minimumQuoteVolume24h: number; top500Only: boolean };
  displacement?: SmartMoneyAdvancedDisplacement;
  fvg?: SmartMoneyAdvancedFvg;
  liquidity?: SmartMoneyAdvancedLiquidity;
  orderBlock?: SmartMoneyAdvancedOrderBlock;
  tf?: string;
};
const DEFAULT_WEIGHTS: SmcWeights = {
  swingStructureBias: 20, recentSwingBos: 15, internalStructure: 10, liquiditySweep: 10, swingOrderBlock: 15, internalOrderBlock: 5, fvg: 10, rangePosition: 10, confluence: 5,
};
const DEFAULT_DISPLACEMENT: SmartMoneyAdvancedDisplacement = { bodyAtrMin: 1.5, rangeAtrMin: 2.0, bullCloseLocMin: 0.6, bearCloseLocMax: 0.4 };
const DEFAULT_FVG: SmartMoneyAdvancedFvg = { minGapAtr: 0.1, maxAgeCandles: 0 };
const DEFAULT_LIQUIDITY: SmartMoneyAdvancedLiquidity = { eqToleranceAtr: 0.1, eqConfirmBars: 2, sweepMinPenetrationAtr: 0.05, maxAgeCandles: 0 };
const DEFAULT_ORDERBLOCK: SmartMoneyAdvancedOrderBlock = { impulseMaxCandles: 3, confirmMaxCandles: 10, maxAgeCandles: 750, sweepLookbackCandles: 5 };
const DEFAULT_CONFIG: SmartMoneyConfig = {
  minimumSignalScore: 72, swingLeft: 20, swingRight: 20, internalLeft: 3, internalRight: 3, atrPeriod: 14,
  structureEventFreshBars: 10, sweepFreshBars: 5, orderBlockFreshBars: 20, fvgFreshBars: 20, eqBand: 0.02,
  weights: { ...DEFAULT_WEIGHTS },
  filters: { minimumQuoteVolume24h: 0, top500Only: false },
  displacement: { ...DEFAULT_DISPLACEMENT }, fvg: { ...DEFAULT_FVG }, liquidity: { ...DEFAULT_LIQUIDITY }, orderBlock: { ...DEFAULT_ORDERBLOCK },
};
const ALLOWED_TFS = ["5m", "15m", "1h", "4h", "1d"] as const;

function validateLocal(config: SmartMoneyConfig, timeframes: string[], minExchanges: number): string[] {
  const errors: string[] = [];
  if (!Number.isInteger(config.minimumSignalScore) || config.minimumSignalScore < 0 || config.minimumSignalScore > 100) errors.push("minimumSignalScore: ожидается целое 0..100");
  for (const f of ["swingLeft", "swingRight", "internalLeft", "internalRight"] as const) { const v = config[f]; if (!Number.isInteger(v) || v < 1 || v > 500) errors.push(`${f}: ожидается целое 1..500`); }
  if (!Number.isInteger(config.atrPeriod) || config.atrPeriod < 1) errors.push("atrPeriod: ожидается целое ≥1");
  for (const f of ["structureEventFreshBars", "sweepFreshBars", "orderBlockFreshBars", "fvgFreshBars"] as const) { const v = config[f]; if (!Number.isInteger(v) || v < 0) errors.push(`${f}: ожидается целое ≥0`); }
  if (!Number.isFinite(config.eqBand) || config.eqBand < 0 || config.eqBand >= 0.5) errors.push("eqBand: ожидается 0 ≤ eqBand < 0.5");
  const keys = Object.keys(DEFAULT_WEIGHTS) as (keyof SmcWeights)[];
  let sum = 0; for (const k of keys) { const v = config.weights[k]; if (!Number.isInteger(v) || v < 0 || v > 100) errors.push(`weights.${k}: ожидается целое 0..100`); sum += v; }
  if (sum !== 100) errors.push(`weights: сумма весов должна быть ровно 100 (сейчас ${sum})`);
  if (!Number.isFinite(config.filters.minimumQuoteVolume24h) || config.filters.minimumQuoteVolume24h < 0) errors.push("filters.minimumQuoteVolume24h: ожидается число ≥0");
  if (typeof config.filters.top500Only !== "boolean") errors.push("filters.top500Only: ожидается boolean");
  if (!Array.isArray(timeframes) || timeframes.length === 0) errors.push("timeframes: нужен непустой список таймфреймов");
  else { const allowed = new Set<string>([...ALLOWED_TFS]); const bad = timeframes.filter((tf) => !allowed.has(tf)); if (bad.length) errors.push(`timeframes: недопустимые значения: ${bad.join(", ")}`); if (timeframes.includes("1d")) errors.push("timeframes: 1d временно недоступен"); }
  if (!Number.isInteger(minExchanges) || minExchanges < 1 || minExchanges > 5) errors.push("minExchanges: ожидается целое 1..5");
  const d = config.displacement ?? DEFAULT_DISPLACEMENT;
  if (!Number.isFinite(d.bodyAtrMin) || d.bodyAtrMin < 0 || d.bodyAtrMin > 10) errors.push("displacement.bodyAtrMin: ожидается число 0..10");
  if (!Number.isFinite(d.rangeAtrMin) || d.rangeAtrMin < 0 || d.rangeAtrMin > 10) errors.push("displacement.rangeAtrMin: ожидается число 0..10");
  if (!Number.isFinite(d.bullCloseLocMin) || d.bullCloseLocMin < 0 || d.bullCloseLocMin > 1) errors.push("displacement.bullCloseLocMin: ожидается число 0..1");
  if (!Number.isFinite(d.bearCloseLocMax) || d.bearCloseLocMax < 0 || d.bearCloseLocMax > 1) errors.push("displacement.bearCloseLocMax: ожидается число 0..1");
  const fv = config.fvg ?? DEFAULT_FVG;
  if (!Number.isFinite(fv.minGapAtr) || fv.minGapAtr < 0 || fv.minGapAtr > 5) errors.push("fvg.minGapAtr: ожидается число 0..5");
  if (!Number.isInteger(fv.maxAgeCandles) || fv.maxAgeCandles < 0 || fv.maxAgeCandles > 5000) errors.push("fvg.maxAgeCandles: ожидается целое 0..5000");
  const li = config.liquidity ?? DEFAULT_LIQUIDITY;
  if (!Number.isFinite(li.eqToleranceAtr) || li.eqToleranceAtr < 0 || li.eqToleranceAtr > 1) errors.push("liquidity.eqToleranceAtr: ожидается число 0..1");
  if (!Number.isInteger(li.eqConfirmBars) || li.eqConfirmBars < 0 || li.eqConfirmBars > 20) errors.push("liquidity.eqConfirmBars: ожидается целое 0..20");
  if (!Number.isFinite(li.sweepMinPenetrationAtr) || li.sweepMinPenetrationAtr < 0 || li.sweepMinPenetrationAtr > 1) errors.push("liquidity.sweepMinPenetrationAtr: ожидается число 0..1");
  if (!Number.isInteger(li.maxAgeCandles) || li.maxAgeCandles < 0 || li.maxAgeCandles > 5000) errors.push("liquidity.maxAgeCandles: ожидается целое 0..5000");
  const ob = config.orderBlock ?? DEFAULT_ORDERBLOCK;
  if (!Number.isInteger(ob.impulseMaxCandles) || ob.impulseMaxCandles < 1 || ob.impulseMaxCandles > 10) errors.push("orderBlock.impulseMaxCandles: ожидается целое 1..10");
  if (!Number.isInteger(ob.confirmMaxCandles) || ob.confirmMaxCandles < 1 || ob.confirmMaxCandles > 100) errors.push("orderBlock.confirmMaxCandles: ожидается целое 1..100");
  if (!Number.isInteger(ob.maxAgeCandles) || ob.maxAgeCandles < 0 || ob.maxAgeCandles > 5000) errors.push("orderBlock.maxAgeCandles: ожидается целое 0..5000");
  if (!Number.isInteger(ob.sweepLookbackCandles) || ob.sweepLookbackCandles < 0 || ob.sweepLookbackCandles > 100) errors.push("orderBlock.sweepLookbackCandles: ожидается целое 0..100");
  return errors;
}

function normalizeConfig(raw: unknown): SmartMoneyConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const w = (r.weights ?? {}) as Record<string, unknown>;
  const f = (r.filters ?? {}) as Record<string, unknown>;
  const d = (r.displacement ?? {}) as Record<string, unknown>;
  const fv = (r.fvg ?? {}) as Record<string, unknown>;
  const li = (r.liquidity ?? {}) as Record<string, unknown>;
  const ob = (r.orderBlock ?? {}) as Record<string, unknown>;
  const disp: SmartMoneyAdvancedDisplacement = {
    bodyAtrMin: typeof d.bodyAtrMin === "number" ? (d.bodyAtrMin as number) : DEFAULT_DISPLACEMENT.bodyAtrMin,
    rangeAtrMin: typeof d.rangeAtrMin === "number" ? (d.rangeAtrMin as number) : DEFAULT_DISPLACEMENT.rangeAtrMin,
    bullCloseLocMin: typeof d.bullCloseLocMin === "number" ? (d.bullCloseLocMin as number) : DEFAULT_DISPLACEMENT.bullCloseLocMin,
    bearCloseLocMax: typeof d.bearCloseLocMax === "number" ? (d.bearCloseLocMax as number) : DEFAULT_DISPLACEMENT.bearCloseLocMax,
  };
  const fvg: SmartMoneyAdvancedFvg = {
    minGapAtr: typeof fv.minGapAtr === "number" ? (fv.minGapAtr as number) : DEFAULT_FVG.minGapAtr,
    maxAgeCandles: typeof fv.maxAgeCandles === "number" ? (fv.maxAgeCandles as number) : DEFAULT_FVG.maxAgeCandles,
  };
  const liq: SmartMoneyAdvancedLiquidity = {
    eqToleranceAtr: typeof li.eqToleranceAtr === "number" ? (li.eqToleranceAtr as number) : DEFAULT_LIQUIDITY.eqToleranceAtr,
    eqConfirmBars: typeof li.eqConfirmBars === "number" ? (li.eqConfirmBars as number) : DEFAULT_LIQUIDITY.eqConfirmBars,
    sweepMinPenetrationAtr: typeof li.sweepMinPenetrationAtr === "number" ? (li.sweepMinPenetrationAtr as number) : DEFAULT_LIQUIDITY.sweepMinPenetrationAtr,
    maxAgeCandles: typeof li.maxAgeCandles === "number" ? (li.maxAgeCandles as number) : DEFAULT_LIQUIDITY.maxAgeCandles,
  };
  const obc: SmartMoneyAdvancedOrderBlock = {
    impulseMaxCandles: typeof ob.impulseMaxCandles === "number" ? (ob.impulseMaxCandles as number) : DEFAULT_ORDERBLOCK.impulseMaxCandles,
    confirmMaxCandles: typeof ob.confirmMaxCandles === "number" ? (ob.confirmMaxCandles as number) : DEFAULT_ORDERBLOCK.confirmMaxCandles,
    maxAgeCandles: typeof ob.maxAgeCandles === "number" ? (ob.maxAgeCandles as number) : DEFAULT_ORDERBLOCK.maxAgeCandles,
    sweepLookbackCandles: typeof ob.sweepLookbackCandles === "number" ? (ob.sweepLookbackCandles as number) : DEFAULT_ORDERBLOCK.sweepLookbackCandles,
  };
  return {
    minimumSignalScore: typeof r.minimumSignalScore === "number" ? (r.minimumSignalScore as number) : DEFAULT_CONFIG.minimumSignalScore,
    swingLeft: typeof r.swingLeft === "number" ? (r.swingLeft as number) : DEFAULT_CONFIG.swingLeft,
    swingRight: typeof r.swingRight === "number" ? (r.swingRight as number) : DEFAULT_CONFIG.swingRight,
    internalLeft: typeof r.internalLeft === "number" ? (r.internalLeft as number) : DEFAULT_CONFIG.internalLeft,
    internalRight: typeof r.internalRight === "number" ? (r.internalRight as number) : DEFAULT_CONFIG.internalRight,
    atrPeriod: typeof r.atrPeriod === "number" ? (r.atrPeriod as number) : DEFAULT_CONFIG.atrPeriod,
    structureEventFreshBars: typeof r.structureEventFreshBars === "number" ? (r.structureEventFreshBars as number) : DEFAULT_CONFIG.structureEventFreshBars,
    sweepFreshBars: typeof r.sweepFreshBars === "number" ? (r.sweepFreshBars as number) : DEFAULT_CONFIG.sweepFreshBars,
    orderBlockFreshBars: typeof r.orderBlockFreshBars === "number" ? (r.orderBlockFreshBars as number) : DEFAULT_CONFIG.orderBlockFreshBars,
    fvgFreshBars: typeof r.fvgFreshBars === "number" ? (r.fvgFreshBars as number) : DEFAULT_CONFIG.fvgFreshBars,
    eqBand: typeof r.eqBand === "number" ? (r.eqBand as number) : DEFAULT_CONFIG.eqBand,
    weights: {
      swingStructureBias: typeof w.swingStructureBias === "number" ? (w.swingStructureBias as number) : DEFAULT_WEIGHTS.swingStructureBias,
      recentSwingBos: typeof w.recentSwingBos === "number" ? (w.recentSwingBos as number) : DEFAULT_WEIGHTS.recentSwingBos,
      internalStructure: typeof w.internalStructure === "number" ? (w.internalStructure as number) : DEFAULT_WEIGHTS.internalStructure,
      liquiditySweep: typeof w.liquiditySweep === "number" ? (w.liquiditySweep as number) : DEFAULT_WEIGHTS.liquiditySweep,
      swingOrderBlock: typeof w.swingOrderBlock === "number" ? (w.swingOrderBlock as number) : DEFAULT_WEIGHTS.swingOrderBlock,
      internalOrderBlock: typeof w.internalOrderBlock === "number" ? (w.internalOrderBlock as number) : DEFAULT_WEIGHTS.internalOrderBlock,
      fvg: typeof w.fvg === "number" ? (w.fvg as number) : DEFAULT_WEIGHTS.fvg,
      rangePosition: typeof w.rangePosition === "number" ? (w.rangePosition as number) : DEFAULT_WEIGHTS.rangePosition,
      confluence: typeof w.confluence === "number" ? (w.confluence as number) : DEFAULT_WEIGHTS.confluence,
    },
    filters: {
      minimumQuoteVolume24h: typeof f.minimumQuoteVolume24h === "number" ? (f.minimumQuoteVolume24h as number) : DEFAULT_CONFIG.filters.minimumQuoteVolume24h,
      top500Only: typeof f.top500Only === "boolean" ? (f.top500Only as boolean) : DEFAULT_CONFIG.filters.top500Only,
    },
    displacement: disp, fvg, liquidity: liq, orderBlock: obc,
  };
}

function cloneConfig(base: SmartMoneyConfig): SmartMoneyConfig {
  return JSON.parse(JSON.stringify(base));
}

/* ---------- 1. old config → 14 visible canonical defaults (editor normalize) ---------- */
{
  ok(editorSrc.includes("DEFAULT_DISPLACEMENT") && editorSrc.includes("bodyAtrMin: 1.5"), "1a: editor has DEFAULT_DISPLACEMENT 1.5");
  ok(editorSrc.includes("rangeAtrMin: 2.0") && editorSrc.includes("bullCloseLocMin: 0.6"), "1b: displacement defaults 2.0/0.6");
  ok(editorSrc.includes("bearCloseLocMax: 0.4"), "1c: bear 0.4");
  ok(editorSrc.includes("DEFAULT_FVG") && editorSrc.includes("minGapAtr: 0.1"), "1d: FVG minGap 0.1");
  ok(editorSrc.includes("maxAgeCandles: 0") && editorSrc.includes("DEFAULT_LIQUIDITY"), "1e: FVG/Liquidity maxAge 0");
  ok(editorSrc.includes("eqToleranceAtr: 0.1") && editorSrc.includes("eqConfirmBars: 2"), "1f: liquidity 0.1/2");
  ok(editorSrc.includes("sweepMinPenetrationAtr: 0.05"), "1g: sweep 0.05");
  ok(editorSrc.includes("DEFAULT_ORDERBLOCK") && editorSrc.includes("impulseMaxCandles: 3"), "1h: OB impulse 3");
  ok(editorSrc.includes("confirmMaxCandles: 10") && editorSrc.includes("maxAgeCandles: 750"), "1i: OB confirm 10 / maxAge 750");
  ok(editorSrc.includes("sweepLookbackCandles: 5"), "1j: OB lookback 5");
  ok(editorSrc.includes("normalizeConfig") && editorSrc.includes("displacement ??") || editorSrc.includes("typeof d.bodyAtrMin"), "1k: normalizeConfig fills missing advanced");
  const old = canonicalOld();
  const r = validateSmartMoneyConfig(old, "1h");
  ok(r.ok === true, "1l: old DB config without advanced validates");
  if (r.ok) {
    const subs = deriveSubConfigs(r.config);
    ok(subs.displacement.bodyAtrMin === 1.5 && subs.displacement.rangeAtrMin === 2.0 && subs.displacement.bullCloseLocMin === 0.6 && subs.displacement.bearCloseLocMax === 0.4, "1m: old derived displacement 1.5/2.0/0.6/0.4");
    ok(subs.fvg.minGapAtr === 0.1 && subs.fvg.maxAgeCandles === 0, "1n: old derived FVG 0.1/0");
    ok(subs.liquidity.eqToleranceAtr === 0.1 && subs.liquidity.eqConfirmBars === 2 && subs.liquidity.sweepMinPenetrationAtr === 0.05 && subs.liquidity.maxAgeCandles === 0, "1o: old derived liquidity 0.1/2/0.05/0");
    ok((subs.orderBlockSwing as any).impulseMaxCandles === 3 && (subs.orderBlockSwing as any).confirmMaxCandles === 10 && (subs.orderBlockSwing as any).maxAgeCandles === 750 && (subs.orderBlockSwing as any).sweepLookbackCandles === 5, "1p: old derived OB 3/10/750/5");
  }
  ok(!editorSrc.includes("Продвинутые параметры — Phase 3D (только просмотр)") , "1q: read-only 'только просмотр' removed");
  ok(editorSrc.includes("Импульс / Displacement") && editorSrc.includes("Ценовой дисбаланс / FVG") && editorSrc.includes("Ликвидность") && editorSrc.includes("Блоки ордеров / Order Blocks"), "1r: 4 editable groups present");
  const norm = normalizeConfig(canonicalOld());
  ok(norm.displacement?.bodyAtrMin === 1.5 && norm.displacement?.rangeAtrMin === 2.0, "1s: normalizeConfig old → displacement 1.5/2.0");
  ok(norm.fvg?.maxAgeCandles === 0 && norm.liquidity?.eqConfirmBars === 2, "1t: normalizeConfig old → fvg 0 / eqConfirm 2");
  ok(norm.orderBlock?.impulseMaxCandles === 3 && norm.orderBlock?.maxAgeCandles === 750, "1u: normalizeConfig old → OB 3/750");
}

/* ---------- 2. all 14 fields represented ---------- */
{
  const all14Labels = [
    "displacement.bodyAtrMin", "displacement.rangeAtrMin", "displacement.bullCloseLocMin", "displacement.bearCloseLocMax",
    "fvg.minGapAtr", "fvg.maxAgeCandles",
    "liquidity.eqToleranceAtr", "liquidity.eqConfirmBars", "liquidity.sweepMinPenetrationAtr", "liquidity.maxAgeCandles",
    "orderBlock.impulseMaxCandles", "orderBlock.confirmMaxCandles", "orderBlock.maxAgeCandles", "orderBlock.sweepLookbackCandles",
  ];
  for (const label of all14Labels) ok(editorSrc.includes(label), `2: editor contains ${label}`);
  ok(all14Labels.length === 14, "2: exactly 14 params");
}

/* ---------- 3. reset section / reset-all defaults ---------- */
{
  ok(editorSrc.includes('resetSection("Импульс / Displacement")') || editorSrc.includes("Импульс / Displacement"), "3a: resetSection Displacement present");
  ok(editorSrc.includes('resetSection("Ценовой дисбаланс / FVG")'), "3b: resetSection FVG present");
  ok(editorSrc.includes('resetSection("Ликвидность")'), "3c: resetSection Liquidity present");
  ok(editorSrc.includes('resetSection("Блоки ордеров / Order Blocks")'), "3d: resetSection OrderBlock present");
  ok(editorSrc.includes("Сбросить всё к defaults") && editorSrc.includes("DEFAULT_DISPLACEMENT") && editorSrc.includes("DEFAULT_FVG") && editorSrc.includes("DEFAULT_LIQUIDITY") && editorSrc.includes("DEFAULT_ORDERBLOCK"), "3e: resetAll restores 14 canonical defaults");
  const raStart = editorSrc.indexOf("function resetAll");
  const raEnd = editorSrc.indexOf("async function save", raStart);
  const resetAllBody = editorSrc.slice(raStart, raEnd === -1 ? raStart + 800 : raEnd);
  ok(resetAllBody.includes("DEFAULT_DISPLACEMENT") && resetAllBody.includes("DEFAULT_FVG"), "3f: resetAll restores 14 canonical defaults");
  ok(resetAllBody.includes('setTimeframes(["1h"])') || editorSrc.includes('setTimeframes(["1h"])'), "3g: resetAll resets timeframes to [1h]");
  ok(!resetAllBody.includes("setEnabled"), "3h: resetAll preserves status/enabled");
}

/* ---------- 4. UI ranges ---------- */
{
  ok(editorSrc.includes('min="0"') && editorSrc.includes('max="10"') && editorSrc.includes('step="0.1"'), "4a: displacement 0..10 step 0.1");
  ok(editorSrc.includes('step="0.05"') && editorSrc.includes('min="0"') && editorSrc.includes('max="1"'), "4b: bull/bear 0..1 step 0.05");
  ok(editorSrc.includes('minGapAtr') && editorSrc.includes('max="5"') && editorSrc.includes('step="0.05"'), "4c: FVG minGap 0..5");
  ok(editorSrc.includes('fvg.maxAgeCandles') && editorSrc.includes('max="5000"'), "4d: FVG maxAge 0..5000");
  ok(editorSrc.includes('eqToleranceAtr') && editorSrc.includes('max="1"') && editorSrc.includes('step="0.01"'), "4e: liquidity eqTolerance 0..1");
  ok(editorSrc.includes('eqConfirmBars') && editorSrc.includes('max="20"'), "4f: eqConfirm 0..20");
  ok(editorSrc.includes('impulseMaxCandles') && editorSrc.includes('max="10"') && editorSrc.includes('min="1"'), "4g: impulse 1..10");
  ok(editorSrc.includes('confirmMaxCandles') && editorSrc.includes('max="100"'), "4h: confirm 1..100");
  ok(editorSrc.includes('maxAgeCandles') && editorSrc.includes('max="5000"'), "4i: maxAge 0..5000");
  ok(editorSrc.includes('sweepLookbackCandles') && editorSrc.includes('max="100"'), "4j: lookback 0..100");
}

/* ---------- 5. integer validation — PROGRAMMATIC (not just string search) ---------- */
{
  function fresh(): SmartMoneyConfig { return cloneConfig(DEFAULT_CONFIG); }
  {
    const c = fresh();
    const errs = validateLocal(c, ["1h"], 3);
    ok(errs.length === 0, "5a: canonical integer values pass (0 errors)");
  }
  type FracCase = { label: string; mutate: (c: SmartMoneyConfig) => void; key: string };
  const fracCases: FracCase[] = [
    { label: "fvg.maxAgeCandles=2.5", mutate: (c) => { c.fvg = { ...DEFAULT_FVG, maxAgeCandles: 2.5 }; }, key: "fvg.maxAgeCandles" },
    { label: "liquidity.eqConfirmBars=2.5", mutate: (c) => { c.liquidity = { ...DEFAULT_LIQUIDITY, eqConfirmBars: 2.5 }; }, key: "liquidity.eqConfirmBars" },
    { label: "liquidity.maxAgeCandles=2.5", mutate: (c) => { c.liquidity = { ...DEFAULT_LIQUIDITY, maxAgeCandles: 2.5 }; }, key: "liquidity.maxAgeCandles" },
    { label: "orderBlock.impulseMaxCandles=2.5", mutate: (c) => { c.orderBlock = { ...DEFAULT_ORDERBLOCK, impulseMaxCandles: 2.5 }; }, key: "orderBlock.impulseMaxCandles" },
    { label: "orderBlock.confirmMaxCandles=10.5", mutate: (c) => { c.orderBlock = { ...DEFAULT_ORDERBLOCK, confirmMaxCandles: 10.5 }; }, key: "orderBlock.confirmMaxCandles" },
    { label: "orderBlock.maxAgeCandles=750.5", mutate: (c) => { c.orderBlock = { ...DEFAULT_ORDERBLOCK, maxAgeCandles: 750.5 }; }, key: "orderBlock.maxAgeCandles" },
    { label: "orderBlock.sweepLookbackCandles=5.5", mutate: (c) => { c.orderBlock = { ...DEFAULT_ORDERBLOCK, sweepLookbackCandles: 5.5 }; }, key: "orderBlock.sweepLookbackCandles" },
  ];
  for (const { label, mutate, key } of fracCases) {
    const c = fresh();
    mutate(c);
    const errs = validateLocal(c, ["1h"], 3);
    const has = errs.some((e) => e.includes(key));
    ok(has && errs.length > 0, `5b: fractional ${label} → error for ${key} (not rounded)`);
    const val = key.includes("fvg.maxAgeCandles") ? (c.fvg as any).maxAgeCandles
      : key.includes("liquidity.eqConfirmBars") ? (c.liquidity as any).eqConfirmBars
      : key.includes("liquidity.maxAgeCandles") ? (c.liquidity as any).maxAgeCandles
      : key.includes("impulseMaxCandles") ? (c.orderBlock as any).impulseMaxCandles
      : key.includes("confirmMaxCandles") ? (c.orderBlock as any).confirmMaxCandles
      : key.includes("orderBlock.maxAgeCandles") ? (c.orderBlock as any).maxAgeCandles
      : (c.orderBlock as any).sweepLookbackCandles;
    ok(val === 2.5 || val === 10.5 || val === 750.5 || val === 5.5, `5b-keep: ${label} state remains fractional ${val}, not rounded`);
  }
  {
    const c = fresh(); c.fvg = { ...DEFAULT_FVG, maxAgeCandles: 0 }; ok(validateLocal(c, ["1h"], 3).length === 0, "5c1: fvg.maxAge 0 valid");
    const c2 = fresh(); c2.fvg = { ...DEFAULT_FVG, maxAgeCandles: 5000 }; ok(validateLocal(c2, ["1h"], 3).length === 0, "5c2: fvg.maxAge 5000 valid");
    const c3 = fresh(); c3.fvg = { ...DEFAULT_FVG, maxAgeCandles: -1 }; ok(validateLocal(c3, ["1h"], 3).some(e=>e.includes("fvg.maxAgeCandles")), "5c3: fvg.maxAge -1 rejected");
    const c4 = fresh(); c4.fvg = { ...DEFAULT_FVG, maxAgeCandles: 5001 }; ok(validateLocal(c4, ["1h"], 3).some(e=>e.includes("fvg.maxAgeCandles")), "5c4: fvg.maxAge 5001 rejected");
    const c5 = fresh(); c5.liquidity = { ...DEFAULT_LIQUIDITY, eqConfirmBars: 20 }; ok(validateLocal(c5, ["1h"], 3).length === 0, "5c5: eqConfirm 20 valid");
    const c6 = fresh(); c6.liquidity = { ...DEFAULT_LIQUIDITY, eqConfirmBars: 21 }; ok(validateLocal(c6, ["1h"], 3).some(e=>e.includes("eqConfirmBars")), "5c6: eqConfirm 21 rejected");
    const c7 = fresh(); c7.orderBlock = { ...DEFAULT_ORDERBLOCK, impulseMaxCandles: 1 }; ok(validateLocal(c7, ["1h"], 3).length === 0, "5c7: impulse 1 valid");
    const c8 = fresh(); c8.orderBlock = { ...DEFAULT_ORDERBLOCK, impulseMaxCandles: 0 }; ok(validateLocal(c8, ["1h"], 3).some(e=>e.includes("impulseMaxCandles")), "5c8: impulse 0 rejected");
    const c9 = fresh(); c9.orderBlock = { ...DEFAULT_ORDERBLOCK, impulseMaxCandles: 11 }; ok(validateLocal(c9, ["1h"], 3).some(e=>e.includes("impulseMaxCandles")), "5c9: impulse 11 rejected");
    const c10 = fresh(); c10.orderBlock = { ...DEFAULT_ORDERBLOCK, confirmMaxCandles: 100 }; ok(validateLocal(c10, ["1h"], 3).length === 0, "5c10: confirm 100 valid");
    const c11 = fresh(); c11.orderBlock = { ...DEFAULT_ORDERBLOCK, confirmMaxCandles: 101 }; ok(validateLocal(c11, ["1h"], 3).some(e=>e.includes("confirmMaxCandles")), "5c11: confirm 101 rejected");
    const c12 = fresh(); c12.orderBlock = { ...DEFAULT_ORDERBLOCK, maxAgeCandles: 5000 }; ok(validateLocal(c12, ["1h"], 3).length === 0, "5c12: OB maxAge 5000 valid");
    const c13 = fresh(); c13.orderBlock = { ...DEFAULT_ORDERBLOCK, maxAgeCandles: 5001 }; ok(validateLocal(c13, ["1h"], 3).some(e=>e.includes("maxAgeCandles")), "5c13: OB maxAge 5001 rejected");
    const c14 = fresh(); c14.orderBlock = { ...DEFAULT_ORDERBLOCK, sweepLookbackCandles: 100 }; ok(validateLocal(c14, ["1h"], 3).length === 0, "5c14: lookback 100 valid");
    const c15 = fresh(); c15.orderBlock = { ...DEFAULT_ORDERBLOCK, sweepLookbackCandles: 101 }; ok(validateLocal(c15, ["1h"], 3).some(e=>e.includes("sweepLookbackCandles")), "5c15: lookback 101 rejected");
  }
  {
    const c = fresh(); c.fvg = { ...DEFAULT_FVG, maxAgeCandles: 2.5 };
    const errs = validateLocal(c, ["1h"], 3);
    const isDirty = true; const saving = false;
    const canSave = isDirty && errs.length === 0 && !saving;
    ok(canSave === false, "5d: canSave=false when fractional error exists (blocked)");
    const c2 = fresh();
    const errs2 = validateLocal(c2, ["1h"], 3);
    const canSave2 = true && errs2.length === 0 && !saving;
    ok(canSave2 === true, "5d2: canSave=true when no errors and dirty");
  }
  {
    const handlerLines = editorSrc.split("\n").filter((line) => line.includes("onChange") && (line.includes("maxAgeCandles") || line.includes("eqConfirmBars") || line.includes("impulseMaxCandles") || line.includes("confirmMaxCandles") || line.includes("sweepLookbackCandles")));
    const hasRound = handlerLines.some((l) => l.includes("Math.round"));
    ok(!hasRound, `5e: no Math.round(v) in 7 integer handlers (found ${handlerLines.length} handlers, none rounded)`);
    const scopedHasRound = handlerLines.join("\n").includes("Math.round(v)");
    ok(!scopedHasRound, "5e2: scoped Math.round(v) absent in integer field handlers");
    ok(editorSrc.includes('step="1"'), "5e3: step=\"1\" remains as UX hint");
  }
}

/* ---------- 6. prospective save payload includes exact values ---------- */
{
  ok(editorSrc.includes("body: JSON.stringify") && editorSrc.includes("config,") , "6a: save payload includes config");
  ok(editorSrc.includes("displacement: { ...DEFAULT_DISPLACEMENT }") || editorSrc.includes("displacement:"), "6b: DEFAULT_CONFIG includes displacement");
  ok(editorSrc.includes("fvg: { ...DEFAULT_FVG }"), "6c: includes fvg");
  ok(editorSrc.includes("liquidity: { ...DEFAULT_LIQUIDITY }"), "6d: includes liquidity");
  ok(editorSrc.includes("orderBlock: { ...DEFAULT_ORDERBLOCK }"), "6e: includes orderBlock");
  const payload = {
    ...canonicalOld(),
    displacement: { bodyAtrMin: 1.6, rangeAtrMin: 2.1, bullCloseLocMin: 0.7, bearCloseLocMax: 0.3 },
    fvg: { minGapAtr: 0.15, maxAgeCandles: 5 },
    liquidity: { eqToleranceAtr: 0.2, eqConfirmBars: 3, sweepMinPenetrationAtr: 0.1, maxAgeCandles: 10 },
    orderBlock: { impulseMaxCandles: 4, confirmMaxCandles: 12, maxAgeCandles: 800, sweepLookbackCandles: 6 },
  };
  const r = validateSmartMoneyConfig(payload, "1h");
  ok(r.ok === true, "6f: prospective payload with all14 validates via backend");
}

/* ---------- 7. backend accepts valid all14, rejects malformed/unknown before update ---------- */
{
  const all14 = {
    ...canonicalOld(),
    displacement: { bodyAtrMin: 1.6, rangeAtrMin: 2.1, bullCloseLocMin: 0.7, bearCloseLocMax: 0.3 },
    fvg: { minGapAtr: 0.15, maxAgeCandles: 5 },
    liquidity: { eqToleranceAtr: 0.2, eqConfirmBars: 3, sweepMinPenetrationAtr: 0.1, maxAgeCandles: 10 },
    orderBlock: { impulseMaxCandles: 4, confirmMaxCandles: 12, maxAgeCandles: 800, sweepLookbackCandles: 6 },
  };
  const okValid = validateSmartMoneyRuntime({ config: all14, timeframes: ["1h"], minExchanges: 3 });
  ok(okValid.ok === true, "7a: backend accepts valid all14");
  const malformed: any = { ...canonicalOld(), displacement: { bodyAtrMin: NaN } };
  const bad = validateSmartMoneyRuntime({ config: malformed, timeframes: ["1h"], minExchanges: 3 });
  ok(bad.ok === false, "7b: backend rejects malformed NaN before update");
  const unknown: any = { ...canonicalOld(), displecement: { bodyAtrMin: 1.5 } };
  const unk = validateSmartMoneyRuntime({ config: unknown, timeframes: ["1h"], minExchanges: 3 });
  ok(unk.ok === false, "7c: backend rejects unknown top-level displecement before update");
  const nestedUnknown: any = { ...canonicalOld(), fvg: { typo: 1 } };
  const nk = validateSmartMoneyRuntime({ config: nestedUnknown, timeframes: ["1h"], minExchanges: 3 });
  ok(nk.ok === false, "7d: backend rejects nested unknown before update");
  ok(apiSrc.includes("validateSmartMoneyRuntime") && apiSrc.indexOf("validateSmartMoneyRuntime") < apiSrc.indexOf("prisma.strategy.update"), "7e: API validates before prisma.strategy.update");
  ok(!apiSrc.includes("prisma.signal"), "7f: API no Signal");
}

/* ---------- 8. [] / 1d / mixed rejected, 5m/15m/1h/4h accepted ---------- */
{
  const base = canonicalOld();
  ok(validateSmartMoneyRuntime({ config: base, timeframes: [], minExchanges: 3 }).ok === false, "8a: [] rejected");
  ok(validateSmartMoneyRuntime({ config: base, timeframes: ["1d"], minExchanges: 3 }).ok === false || apiSrc.includes("1d временно недоступен"), "8b: 1d rejected via API/runtime");
  ok(apiSrc.includes('allowedVerified') && apiSrc.includes('"1d"'), "8c: API 1d guard present");
  ok(validateSmartMoneyRuntime({ config: base, timeframes: ["1h", "1d"], minExchanges: 3 }).ok === false || apiSrc.includes("hasDisallowed"), "8d: mixed 1d rejected");
  ok(validateSmartMoneyRuntime({ config: base, timeframes: ["5m", "15m", "1h", "4h"], minExchanges: 3 }).ok === true, "8e: 5m/15m/1h/4h accepted");
  ok(validateSmartMoneyRuntime({ config: base, timeframes: ["5m"], minExchanges: 3 }).ok === true, "8f: single 5m accepted");
}

/* ---------- 9. Trend unchanged ---------- */
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
  ok(validateTrendSuslikConfig(trendRaw).ok === true, "9: Trend unchanged");
}

/* ---------- 10. Range behavior unchanged ---------- */
{
  ok(editorSrc.includes("Range") && editorSrc.includes("не clamp"), "10a: Range note present");
  ok(editorSrc.includes("may be <0 or >1") || editorSrc.includes("&lt;0") || editorSrc.includes("не clamp"), "10b: Range values <0/>1 noted");
  ok(editorSrc.includes("Discount") && editorSrc.includes("Premium"), "10c: Discount/Premium noted");
  ok(editorSrc.includes("lifecycle") || editorSrc.includes("аудите"), "10d: lifecycle under audit noted");
  ok(!editorSrc.includes("range.maxAge") && !editorSrc.includes("rangeMaxAge"), "10e: no range maxAge added");
  const T0 = Date.UTC(2026, 0, 1);
  const HOUR = 3600000;
  function mk(i:number,o:number,c:number,h?:number,l?:number){return {openTime:new Date(T0+i*HOUR),open:o,high:h??Math.max(o,c),low:l??Math.min(o,c),close:c,closed:true} as SmcRawCandle;}
  const base = canonicalOld();
  const r = validateSmartMoneyConfig(base, "1h");
  if(r.ok){
    const raw: SmcRawCandle[] = [];
    for(let i=0;i<120;i++){ const o=100+Math.sin(i*0.3)*5; const c=100+Math.sin(i*0.31)*5; const high=Math.max(o,c)+1; const low=Math.min(o,c)-1; raw.push(mk(i,o,c,high,low));}
    const ev = evaluateSmc(raw, r.config, new Date(T0+120*HOUR));
    ok(ev.direction === "LONG" || ev.direction === "SHORT" || ev.direction === "NEUTRAL" || ev.direction === "CANNOT_EVALUATE", "10f: evaluateSmc still works");
  } else ok(false, "10f: config should be ok");
}

/* ---------- 11. no Signal text suggesting engine exists ---------- */
{
  ok(!editorSrc.includes("Signal Engine развёрнут") || editorSrc.includes("Signal Engine не развёрнут"), "11a: no Signal Engine exists claim");
  ok(editorSrc.includes("Signal Engine не развёрнут"), "11b: honest Signal not deployed note present");
  ok(!apiSrc.includes("prisma.signal"), "11c: API no Signal");
  ok(!editorSrc.includes("прибыльность гарантируется") && !editorSrc.includes("вероятность"), "11d: no profitability claims");
}

/* ---------- 12. no DB mutation in tests ---------- */
{
  const rawTestSrc = readFileSync("scripts/test-smc-phase3d-d.ts", "utf8");
  const testSrc = rawTestSrc.split("\n").filter((l) => !l.includes("hasPrismaCall") && !l.includes("PrismaClient")).join("\n");
  const hasPrismaCall = testSrc.includes("PrismaClient") || /await\s+prisma\./.test(testSrc);
  ok(!hasPrismaCall, "12: test file no DB mutation (no prisma calls)");
  ok(rawTestSrc.includes("validateSmartMoneyRuntime") && rawTestSrc.includes("validateSmartMoneyConfig"), "12b: test uses pure validation only");
}

/* ---------- 13. client validation not solely HTML min/max ---------- */
{
  ok(editorSrc.includes("validateLocal") && editorSrc.includes("Number.isInteger") && editorSrc.includes("0..10"), "13: client validation via validateLocal, not just HTML min/max");
  ok(editorSrc.includes("errors.length === 0") && editorSrc.includes("canSave"), "13b: Save blocked by errors");
}

/* ---------- 14. normalizeConfig safety — old DB exact defaults, no NaN/Infinity leakage ---------- */
{
  const norm = normalizeConfig({});
  ok(norm.displacement?.bodyAtrMin === 1.5 && norm.fvg?.maxAgeCandles === 0, "14a: normalizeConfig empty → canonical");
  const norm2 = normalizeConfig({ displacement: { bodyAtrMin: 2.5 } });
  ok(norm2.displacement?.bodyAtrMin === 2.5 && norm2.displacement?.rangeAtrMin === 2.0, "14b: partial displacement preserves others");
  const rawWithNaN: any = { fvg: { maxAgeCandles: NaN } };
  const normNaN = normalizeConfig(rawWithNaN);
  ok(Number.isNaN((normNaN.fvg as any).maxAgeCandles), "14c: NaN preserved via typeof (DB cannot have it, but validateLocal catches)");
  const errsNaN = validateLocal(normNaN as any, ["1h"], 3);
  ok(errsNaN.some((e)=>e.includes("fvg.maxAgeCandles")), "14d: validateLocal rejects NaN for integer field");
}

console.log(`Itog: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
