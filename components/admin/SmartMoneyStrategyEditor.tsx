"use client";

import { useState, useMemo, useRef } from "react";

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

type SmartMoneyAdvancedDisplacement = {
  bodyAtrMin: number;
  rangeAtrMin: number;
  bullCloseLocMin: number;
  bearCloseLocMax: number;
};
type SmartMoneyAdvancedFvg = {
  minGapAtr: number;
  maxAgeCandles: number;
};
type SmartMoneyAdvancedLiquidity = {
  eqToleranceAtr: number;
  eqConfirmBars: number;
  sweepMinPenetrationAtr: number;
  maxAgeCandles: number;
};
type SmartMoneyAdvancedOrderBlock = {
  impulseMaxCandles: number;
  confirmMaxCandles: number;
  maxAgeCandles: number;
  sweepLookbackCandles: number;
};

type SmartMoneyConfig = {
  minimumSignalScore: number;
  swingLeft: number;
  swingRight: number;
  internalLeft: number;
  internalRight: number;
  atrPeriod: number;
  structureEventFreshBars: number;
  sweepFreshBars: number;
  orderBlockFreshBars: number;
  fvgFreshBars: number;
  eqBand: number;
  weights: SmcWeights;
  filters: {
    minimumQuoteVolume24h: number;
    top500Only: boolean;
  };
  displacement?: SmartMoneyAdvancedDisplacement;
  fvg?: SmartMoneyAdvancedFvg;
  liquidity?: SmartMoneyAdvancedLiquidity;
  orderBlock?: SmartMoneyAdvancedOrderBlock;
  tf?: string;
};

type Props = {
  strategy: {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    version: number;
    enabled: boolean;
    status: string;
    minExchanges: number;
    timeframes: string[];
    config: SmartMoneyConfig;
  };
};

const DEFAULT_WEIGHTS: SmcWeights = {
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

const DEFAULT_DISPLACEMENT: SmartMoneyAdvancedDisplacement = {
  bodyAtrMin: 1.5,
  rangeAtrMin: 2.0,
  bullCloseLocMin: 0.6,
  bearCloseLocMax: 0.4,
};
const DEFAULT_FVG: SmartMoneyAdvancedFvg = {
  minGapAtr: 0.1,
  maxAgeCandles: 0,
};
const DEFAULT_LIQUIDITY: SmartMoneyAdvancedLiquidity = {
  eqToleranceAtr: 0.1,
  eqConfirmBars: 2,
  sweepMinPenetrationAtr: 0.05,
  maxAgeCandles: 0,
};
const DEFAULT_ORDERBLOCK: SmartMoneyAdvancedOrderBlock = {
  impulseMaxCandles: 3,
  confirmMaxCandles: 10,
  maxAgeCandles: 750,
  sweepLookbackCandles: 5,
};

const DEFAULT_CONFIG: SmartMoneyConfig = {
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
  weights: { ...DEFAULT_WEIGHTS },
  filters: {
    minimumQuoteVolume24h: 0,
    top500Only: false,
  },
  displacement: { ...DEFAULT_DISPLACEMENT },
  fvg: { ...DEFAULT_FVG },
  liquidity: { ...DEFAULT_LIQUIDITY },
  orderBlock: { ...DEFAULT_ORDERBLOCK },
};

const ALLOWED_TFS = ["5m", "15m", "1h", "4h", "1d"] as const;

function NumberField({
  label,
  description,
  value,
  onChange,
  step = "1",
  min,
  max,
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
  min?: string;
  max?: string;
}) {
  return (
    <label className="settingField">
      <span>
        <b>{label}</b>
        <small>{description}</small>
      </span>
      <input
        type="number"
        step={step}
        min={min}
        max={max}
        value={Number.isFinite(value) ? value : 0}
        onChange={(e) => {
          const v = e.target.value === "" ? 0 : Number(e.target.value);
          onChange(v);
        }}
      />
    </label>
  );
}

function normalizeConfig(raw: unknown): SmartMoneyConfig {
  const r = (raw ?? {}) as Record<string, unknown>;
  const w = (r.weights ?? {}) as Record<string, unknown>;
  const f = (r.filters ?? {}) as Record<string, unknown>;
  const d = (r.displacement ?? {}) as Record<string, unknown>;
  const fv = (r.fvg ?? {}) as Record<string, unknown>;
  const li = (r.liquidity ?? {}) as Record<string, unknown>;
  const ob = (r.orderBlock ?? {}) as Record<string, unknown>;
  // For old DB without advanced groups, fill canonical scoring fallbacks (not blank/NaN)
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
    minimumSignalScore:
      typeof r.minimumSignalScore === "number"
        ? (r.minimumSignalScore as number)
        : DEFAULT_CONFIG.minimumSignalScore,
    swingLeft:
      typeof r.swingLeft === "number" ? (r.swingLeft as number) : DEFAULT_CONFIG.swingLeft,
    swingRight:
      typeof r.swingRight === "number" ? (r.swingRight as number) : DEFAULT_CONFIG.swingRight,
    internalLeft:
      typeof r.internalLeft === "number" ? (r.internalLeft as number) : DEFAULT_CONFIG.internalLeft,
    internalRight:
      typeof r.internalRight === "number" ? (r.internalRight as number) : DEFAULT_CONFIG.internalRight,
    atrPeriod:
      typeof r.atrPeriod === "number" ? (r.atrPeriod as number) : DEFAULT_CONFIG.atrPeriod,
    structureEventFreshBars:
      typeof r.structureEventFreshBars === "number"
        ? (r.structureEventFreshBars as number)
        : DEFAULT_CONFIG.structureEventFreshBars,
    sweepFreshBars:
      typeof r.sweepFreshBars === "number"
        ? (r.sweepFreshBars as number)
        : DEFAULT_CONFIG.sweepFreshBars,
    orderBlockFreshBars:
      typeof r.orderBlockFreshBars === "number"
        ? (r.orderBlockFreshBars as number)
        : DEFAULT_CONFIG.orderBlockFreshBars,
    fvgFreshBars:
      typeof r.fvgFreshBars === "number"
        ? (r.fvgFreshBars as number)
        : DEFAULT_CONFIG.fvgFreshBars,
    eqBand: typeof r.eqBand === "number" ? (r.eqBand as number) : DEFAULT_CONFIG.eqBand,
    weights: {
      swingStructureBias:
        typeof w.swingStructureBias === "number"
          ? (w.swingStructureBias as number)
          : DEFAULT_WEIGHTS.swingStructureBias,
      recentSwingBos:
        typeof w.recentSwingBos === "number"
          ? (w.recentSwingBos as number)
          : DEFAULT_WEIGHTS.recentSwingBos,
      internalStructure:
        typeof w.internalStructure === "number"
          ? (w.internalStructure as number)
          : DEFAULT_WEIGHTS.internalStructure,
      liquiditySweep:
        typeof w.liquiditySweep === "number"
          ? (w.liquiditySweep as number)
          : DEFAULT_WEIGHTS.liquiditySweep,
      swingOrderBlock:
        typeof w.swingOrderBlock === "number"
          ? (w.swingOrderBlock as number)
          : DEFAULT_WEIGHTS.swingOrderBlock,
      internalOrderBlock:
        typeof w.internalOrderBlock === "number"
          ? (w.internalOrderBlock as number)
          : DEFAULT_WEIGHTS.internalOrderBlock,
      fvg: typeof w.fvg === "number" ? (w.fvg as number) : DEFAULT_WEIGHTS.fvg,
      rangePosition:
        typeof w.rangePosition === "number"
          ? (w.rangePosition as number)
          : DEFAULT_WEIGHTS.rangePosition,
      confluence:
        typeof w.confluence === "number" ? (w.confluence as number) : DEFAULT_WEIGHTS.confluence,
    },
    filters: {
      minimumQuoteVolume24h:
        typeof f.minimumQuoteVolume24h === "number"
          ? (f.minimumQuoteVolume24h as number)
          : DEFAULT_CONFIG.filters.minimumQuoteVolume24h,
      top500Only:
        typeof f.top500Only === "boolean"
          ? (f.top500Only as boolean)
          : DEFAULT_CONFIG.filters.top500Only,
    },
    displacement: disp,
    fvg,
    liquidity: liq,
    orderBlock: obc,
  };
}

function validateLocal(
  config: SmartMoneyConfig,
  timeframes: string[],
  minExchanges: number
): string[] {
  const errors: string[] = [];

  if (!Number.isInteger(config.minimumSignalScore) || config.minimumSignalScore < 0 || config.minimumSignalScore > 100) {
    errors.push("minimumSignalScore: ожидается целое 0..100");
  }
  for (const f of ["swingLeft", "swingRight", "internalLeft", "internalRight"] as const) {
    const v = config[f];
    if (!Number.isInteger(v) || v < 1 || v > 500) errors.push(`${f}: ожидается целое 1..500`);
  }
  if (!Number.isInteger(config.atrPeriod) || config.atrPeriod < 1) {
    errors.push("atrPeriod: ожидается целое ≥1");
  }
  for (const f of ["structureEventFreshBars", "sweepFreshBars", "orderBlockFreshBars", "fvgFreshBars"] as const) {
    const v = config[f];
    if (!Number.isInteger(v) || v < 0) errors.push(`${f}: ожидается целое ≥0`);
  }
  if (!Number.isFinite(config.eqBand) || config.eqBand < 0 || config.eqBand >= 0.5) {
    errors.push("eqBand: ожидается 0 ≤ eqBand < 0.5");
  }
  const keys = Object.keys(DEFAULT_WEIGHTS) as (keyof SmcWeights)[];
  let sum = 0;
  for (const k of keys) {
    const v = config.weights[k];
    if (!Number.isInteger(v) || v < 0 || v > 100) errors.push(`weights.${k}: ожидается целое 0..100`);
    sum += v;
  }
  if (sum !== 100) errors.push(`weights: сумма весов должна быть ровно 100 (сейчас ${sum})`);
  if (!Number.isFinite(config.filters.minimumQuoteVolume24h) || config.filters.minimumQuoteVolume24h < 0) {
    errors.push("filters.minimumQuoteVolume24h: ожидается число ≥0");
  }
  if (typeof config.filters.top500Only !== "boolean") {
    errors.push("filters.top500Only: ожидается boolean");
  }
  if (!Array.isArray(timeframes) || timeframes.length === 0) {
    errors.push("timeframes: нужен непустой список таймфреймов");
  } else {
    const allowed = new Set<string>([...ALLOWED_TFS]);
    const bad = timeframes.filter((tf) => !allowed.has(tf));
    if (bad.length) errors.push(`timeframes: недопустимые значения: ${bad.join(", ")}`);
    if (timeframes.includes("1d")) errors.push("timeframes: 1d временно недоступен (BINGX 16:00 UTC vs 00:00 UTC)");
  }
  if (!Number.isInteger(minExchanges) || minExchanges < 1 || minExchanges > 5) {
    errors.push("minExchanges: ожидается целое 1..5");
  }

  // ---- Phase 3D advanced UI ranges (client-side, backend remains authoritative) ----
  const d = config.displacement ?? DEFAULT_DISPLACEMENT;
  if (!Number.isFinite(d.bodyAtrMin) || d.bodyAtrMin < 0 || d.bodyAtrMin > 10) errors.push("displacement.bodyAtrMin: ожидается число 0..10 (UI), core допускает ≥0");
  if (!Number.isFinite(d.rangeAtrMin) || d.rangeAtrMin < 0 || d.rangeAtrMin > 10) errors.push("displacement.rangeAtrMin: ожидается число 0..10");
  if (!Number.isFinite(d.bullCloseLocMin) || d.bullCloseLocMin < 0 || d.bullCloseLocMin > 1) errors.push("displacement.bullCloseLocMin: ожидается число 0..1");
  if (!Number.isFinite(d.bearCloseLocMax) || d.bearCloseLocMax < 0 || d.bearCloseLocMax > 1) errors.push("displacement.bearCloseLocMax: ожидается число 0..1");

  const fv = config.fvg ?? DEFAULT_FVG;
  if (!Number.isFinite(fv.minGapAtr) || fv.minGapAtr < 0 || fv.minGapAtr > 5) errors.push("fvg.minGapAtr: ожидается число 0..5");
  if (!Number.isInteger(fv.maxAgeCandles) || fv.maxAgeCandles < 0 || fv.maxAgeCandles > 5000) errors.push("fvg.maxAgeCandles: ожидается целое 0..5000 (0=выключено)");

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

export default function SmartMoneyStrategyEditor({ strategy }: Props) {
  const initialConfigRef = useRef<SmartMoneyConfig>(normalizeConfig(strategy.config));
  const initialTimeframesRef = useRef<string[]>([...strategy.timeframes]);
  const initialMinExchangesRef = useRef<number>(strategy.minExchanges);
  const initialEnabledRef = useRef<boolean>(strategy.enabled);

  const [config, setConfig] = useState<SmartMoneyConfig>(() => normalizeConfig(strategy.config));
  const [enabled, setEnabled] = useState<boolean>(strategy.enabled);
  const [minExchanges, setMinExchanges] = useState<number>(strategy.minExchanges);
  const [timeframes, setTimeframes] = useState<string[]>(() => [...strategy.timeframes]);
  const [message, setMessage] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);

  const errors = useMemo(() => validateLocal(config, timeframes, minExchanges), [config, timeframes, minExchanges]);
  const weightSum = useMemo(() => Object.values(config.weights).reduce((s, v) => s + v, 0), [config.weights]);

  const isDirty = useMemo(() => {
    const sameConfig = JSON.stringify(config) === JSON.stringify(initialConfigRef.current);
    const sameTF = JSON.stringify([...timeframes].sort()) === JSON.stringify([...initialTimeframesRef.current].sort());
    const sameMin = minExchanges === initialMinExchangesRef.current;
    const sameEnabled = enabled === initialEnabledRef.current;
    return !(sameConfig && sameTF && sameMin && sameEnabled);
  }, [config, timeframes, minExchanges, enabled]);

  const canSave = isDirty && errors.length === 0 && !saving;

  function _updateSection<K extends keyof SmartMoneyConfig>(section: K, values: Partial<SmartMoneyConfig[K]>) {
    setConfig((cur) => ({
      ...cur,
      [section]: {
        ...(cur[section] as unknown as object),
        ...values,
      },
    }));
  }
  void _updateSection;

  function toggleTimeframe(tf: string) {
    if (tf === "1d") return;
    setTimeframes((cur) => {
      if (cur.includes(tf)) {
        if (cur.length === 1) return cur;
        return cur.filter((x) => x !== tf);
      }
      return [...cur, tf];
    });
  }

  function resetSection(section: string) {
    if (!confirm(`Сбросить секцию «${section}» к значениям по умолчанию?`)) return;
    if (section === "Порог") {
      setConfig((c) => ({ ...c, minimumSignalScore: DEFAULT_CONFIG.minimumSignalScore }));
    } else if (section === "Market Structure" || section === "Структура рынка (Market Structure)") {
      setConfig((c) => ({
        ...c,
        swingLeft: DEFAULT_CONFIG.swingLeft,
        swingRight: DEFAULT_CONFIG.swingRight,
        internalLeft: DEFAULT_CONFIG.internalLeft,
        internalRight: DEFAULT_CONFIG.internalRight,
      }));
    } else if (section === "Волатильность") {
      setConfig((c) => ({ ...c, atrPeriod: DEFAULT_CONFIG.atrPeriod }));
    } else if (section === "Freshness") {
      setConfig((c) => ({
        ...c,
        structureEventFreshBars: DEFAULT_CONFIG.structureEventFreshBars,
        sweepFreshBars: DEFAULT_CONFIG.sweepFreshBars,
        orderBlockFreshBars: DEFAULT_CONFIG.orderBlockFreshBars,
        fvgFreshBars: DEFAULT_CONFIG.fvgFreshBars,
      }));
    } else if (section === "Dealing Range" || section === "Ценовой диапазон: Premium / Discount (Dealing Range)") {
      setConfig((c) => ({ ...c, eqBand: DEFAULT_CONFIG.eqBand }));
    } else if (section === "Scoring" || section === "Оценка сигнала — веса факторов (Scoring)") {
      setConfig((c) => ({ ...c, weights: { ...DEFAULT_WEIGHTS } }));
    } else if (section === "Filters") {
      setConfig((c) => ({ ...c, filters: { ...DEFAULT_CONFIG.filters } }));
    } else if (section === "Импульс / Displacement") {
      setConfig((c) => ({ ...c, displacement: { ...DEFAULT_DISPLACEMENT } }));
    } else if (section === "Ценовой дисбаланс / FVG") {
      setConfig((c) => ({ ...c, fvg: { ...DEFAULT_FVG } }));
    } else if (section === "Ликвидность") {
      setConfig((c) => ({ ...c, liquidity: { ...DEFAULT_LIQUIDITY } }));
    } else if (section === "Блоки ордеров / Order Blocks") {
      setConfig((c) => ({ ...c, orderBlock: { ...DEFAULT_ORDERBLOCK } }));
    }
  }

  function resetAll() {
    if (!confirm("Сбросить ВСЕ параметры Smart Money к canonical defaults? Потребуется явное сохранение.")) return;
    setConfig({ ...DEFAULT_CONFIG, weights: { ...DEFAULT_WEIGHTS }, filters: { ...DEFAULT_CONFIG.filters }, displacement: { ...DEFAULT_DISPLACEMENT }, fvg: { ...DEFAULT_FVG }, liquidity: { ...DEFAULT_LIQUIDITY }, orderBlock: { ...DEFAULT_ORDERBLOCK } });
    setTimeframes(["1h"]);
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/strategies/${strategy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          minExchanges,
          timeframes,
          config,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Не удалось сохранить настройки");
        return;
      }
      setMessage("✓ Настройки сохранены в PostgreSQL");
      initialConfigRef.current = JSON.parse(JSON.stringify(config));
      initialMinExchangesRef.current = minExchanges;
      initialTimeframesRef.current = [...timeframes];
      initialEnabledRef.current = enabled;
    } catch {
      setMessage("Ошибка соединения с сервером");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="strategyEditor">
      <section className="editorHero">
        <div>
          <div className="editorBadges">
            <span>{strategy.slug}</span>
            <span>Версия {strategy.version}</span>
            <span>{strategy.status === "PUBLISHED" ? "Опубликована" : strategy.status}</span>
          </div>
          <h1>{strategy.name}</h1>
          {strategy.description && <p>{strategy.description}</p>}
          <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            SMC стратегия • TF: {timeframes.join(", ") || "—"} • Порог {config.minimumSignalScore} • Веса Σ={weightSum}
          </p>
        </div>
        <label className="switchLabel">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span>{enabled ? "Стратегия включена" : "Стратегия выключена"}</span>
        </label>
      </section>

      <section className="editorSection" style={{ background: "#f0f9ff", border: "1px solid #bae6fd" }}>
        <h2>Как работает Smart Money Strategy</h2>
        <p style={{ fontSize: 13, lineHeight: "1.5" }}>
          Цепочка оценки: <b>CLOSED свечи</b> → структура рынка (Market Structure) → пробой структуры (BOS) / снятие
          ликвидности (Liquidity Sweep) / блоки ордеров (Order Blocks) / ценовой дисбаланс (Fair Value Gap / FVG) /
          ценовой диапазон (Premium / Discount) → отдельные баллы{" "}
          <b>LONG</b> и <b>SHORT</b> → порог <code>minimumSignalScore</code> → подтверждение на нескольких биржах (
          <code>minExchanges</code>) → итог <b>LONG</b> / <b>SHORT</b> / <b>NEUTRAL</b> / <b>cannot-evaluate</b>.
        </p>
        <ul style={{ fontSize: 13, margin: "8px 0 0 18px", lineHeight: "1.5" }}>
          <li>Используются <b>только полностью закрытые (CLOSED) свечи</b>; текущая формирующаяся свеча не участвует.</li>
          <li>
            Будущие свечи не используются — <b>no lookahead</b>: оценка на момент <code>asOf</code> видит только свечи с{" "}
            <code>effectiveCloseTime ≤ asOf</code>.
          </li>
          <li>
            <b>LONG / SHORT</b> — результат правил и scoring (0..100 баллов), <b>не прогноз с гарантией</b>.
          </li>
          <li>
            <b>NEUTRAL</b> означает, что условия направления недостаточно подтверждены или конфликтуют (например, LONG и SHORT
            одновременно набрали ≥ порога). Это <b>не</b> означает, что цена «не изменится».
          </li>
          <li>
            <b>cannot-evaluate</b> означает, что данных недостаточно (например, при canonical default swingLeft/swingRight=20 требуется минимум 84 CLOSED свечи; при изменении swing-окон требуемая история меняется) либо
            корректная оценка сейчас невозможна — рынок пропускается.
          </li>
          <li>
            <b>Signal Engine не развёрнут.</b> Прибыльность не гарантируется и должна проверяться отдельным
            backtest / out-of-sample.
          </li>
        </ul>
      </section>

      <div className="adminPanel" style={{ background: "#fffbeb", border: "1px solid #fcd34d", padding: 12, borderRadius: 8, marginBottom: 16 }}>
        <b>Предупреждение:</b> Изменение параметров влияет на будущие runtime-расчёты Smart Money. Signal Engine не развёрнут. Прибыльность не заявляется.
      </div>

      {errors.length > 0 && (
        <div className="adminPanel" style={{ background: "#fef2f2", border: "1px solid #fca5a5", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <b>Ошибки валидации (сохранение заблокировано):</b>
          <ul style={{ margin: "8px 0 0 18px" }}>
            {errors.map((e) => (
              <li key={e} style={{ fontSize: 13 }}>{e}</li>
            ))}
          </ul>
        </div>
      )}

      {isDirty && <div style={{ fontSize: 13, color: "#92400e", marginBottom: 12 }}>• Есть несохранённые изменения</div>}

      <section className="editorSection">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Общие</h2>
          <button type="button" onClick={() => resetSection("Порог")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          Итоговые баллы LONG/SHORT находятся в диапазоне <b>0..100</b>. Порог определяет, какой score достаточен для
          направления. Более высокий порог = более строгий отбор, более низкий = больше потенциальных срабатываний. Высокий
          score <b>не</b> означает гарантированную прибыль.
        </p>
        <NumberField
          label="Минимальная сила сигнала (minimumSignalScore)"
          description="Порог 0..100. LONG если longScore≥порога, SHORT если shortScore≥порога, оба набрали ≥порога → конфликт и NEUTRAL. Изменение меняет чувствительность, но не гарантирует качество."
          value={config.minimumSignalScore}
          onChange={(v) => setConfig({ ...config, minimumSignalScore: v })}
        />
        <NumberField
          label="Подтверждение бирж (minExchanges)"
          description="Сколько независимых рынков/бирж (1..5) должны подтвердить одно направление. Большее значение = более строгий межбиржевой консенсус. Параметр не является гарантией качества."
          value={minExchanges}
          onChange={setMinExchanges}
        />
        <div className="settingBlock">
          <b>Рабочие таймфреймы</b>
          <small>
            Проверено Phase 3E на реальных BTC данных (5 бирж, CLOSED свечи):{" "}
            <b>5m, 15m, 1h, 4h — проверено</b>; 1d временно недоступен. Timeframe runtime/alignment verified on BTC across 5
            exchanges; availability for each asset still depends on stored CLOSED history.
          </small>
          <div className="timeframeSelector">
            {([...ALLOWED_TFS] as string[]).map((tf) => {
              const active = timeframes.includes(tf);
              const isVerified = ["5m", "15m", "1h", "4h"].includes(tf);
              const isDisabled = tf === "1d";
              return (
                <button
                  type="button"
                  key={tf}
                  className={active ? "tfActive" : ""}
                  disabled={isDisabled}
                  onClick={() => {
                    if (isDisabled) return;
                    toggleTimeframe(tf);
                  }}
                  title={
                    isDisabled
                      ? "1d временно недоступен: на реальных данных BTC обнаружено несовпадение дневной границы BingX (16:00 UTC) с четырьмя другими биржами (00:00 UTC). Multi-exchange aggregation запрещена до отдельного решения."
                      : `${tf} — проверено Phase 3E`
                  }
                >
                  {tf}
                  {isVerified ? " ✓" : ""}
                  {isDisabled ? " ⏸" : ""}
                </button>
              );
            })}
          </div>
          <small style={{ color: "#065f46" }}>✓ 5m/15m/1h/4h — проверено Phase 3E</small>
          <small style={{ color: "#92400e", display: "block", marginTop: 4 }}>
            ⏸ 1d временно недоступен: на реальных данных BTC обнаружено несовпадение дневной границы BingX (16:00 UTC) с
            четырьмя другими биржами (00:00 UTC). Multi-exchange aggregation запрещена до отдельного решения.
          </small>
          <small style={{ color: "#6b7280", display: "block", marginTop: 4 }}>
            Timeframe runtime/alignment verified on BTC across 5 exchanges; availability for each asset still depends on
            stored CLOSED history.
          </small>
        </div>
      </section>

      <section className="editorSection">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Структура рынка (Market Structure)</h2>
          <button type="button" onClick={() => resetSection("Market Structure")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          <b>Swing high / swing low</b> — подтверждённые локальные вершины/минимумы более крупной структуры;{" "}
          <b>internal structure</b> — более чувствительная внутренняя структура. <b>Left/Right</b> задают число соседних
          CLOSED свечей, необходимое для подтверждения экстремума. Большие окна → меньше структурных точек, обычно они более
          крупные/редкие; маленькие окна → больше чувствительности и рыночного шума. Пивот не становится известным раньше
          правых confirmation-свечей — <b>no lookahead</b>.
        </p>
        <div className="fieldGrid">
          <NumberField
            label="Swing слева (swingLeft)"
            description="Левое окно swing-пивота (1..500). Влияет на FSM-swing, liquidity, OB-swing, dealing range."
            value={config.swingLeft}
            onChange={(v) => setConfig({ ...config, swingLeft: v })}
          />
          <NumberField
            label="Swing справа (swingRight)"
            description="Правое окно swing-пивота (1..500). Пара с swingLeft — история 4*(max+1) свечей."
            value={config.swingRight}
            onChange={(v) => setConfig({ ...config, swingRight: v })}
          />
          <NumberField
            label="Internal слева (internalLeft)"
            description="Левое окно internal-пивота (1..500). Мелкая структура внутри swing."
            value={config.internalLeft}
            onChange={(v) => setConfig({ ...config, internalLeft: v })}
          />
          <NumberField
            label="Internal справа (internalRight)"
            description="Правое окно internal-пивота (1..500)."
            value={config.internalRight}
            onChange={(v) => setConfig({ ...config, internalRight: v })}
          />
        </div>
      </section>

      <section className="editorSection">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Волатильность (ATR)</h2>
          <button type="button" onClick={() => resetSection("Волатильность")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          <b>ATR</b> измеряет типичный диапазон движения цены и используется для нормализации условий между разными
          активами/волатильностями. <b>atrPeriod</b> — количество CLOSED свечей расчётного периода. Меньше период → быстрее
          реакция, больше чувствительности/шума; больше период → более сглаженная оценка, медленнее адаптация. Ни один вариант не
          заявляется как «лучший».
        </p>
        <NumberField
          label="Период ATR (atrPeriod)"
          description="Единый период ATR для displacement/FVG/liquidity/OB (≥1). При недоступном ATR на последней свече факт не оценивается."
          value={config.atrPeriod}
          onChange={(v) => setConfig({ ...config, atrPeriod: v })}
        />
      </section>

      <section className="editorSection">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Свежесть событий (в свечах)</h2>
          <button type="button" onClick={() => resetSection("Freshness")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          SMC-событие не должно бесконечно влиять на текущий score. Все значения измеряются <b>в CLOSED свечах</b>, а не в
          wall-clock времени. Больше значение = событие влияет дольше; меньше = требуется более свежее событие. Не путать
          freshness в scoring с жизненным циклом (lifecycle/expiry) в core.
        </p>
        <div className="fieldGrid">
          <NumberField
            label="Свежесть BOS (structureEventFreshBars)"
            description="Сколько закрытых свечей недавний пробой структуры (BOS) остаётся релевантным (≥0)."
            value={config.structureEventFreshBars}
            onChange={(v) => setConfig({ ...config, structureEventFreshBars: v })}
          />
          <NumberField
            label="Свежесть снятия ликвидности (sweepFreshBars)"
            description="Сколько закрытых свечей остаётся релевантным подтверждённое снятие ликвидности (Liquidity Sweep) (≥0)."
            value={config.sweepFreshBars}
            onChange={(v) => setConfig({ ...config, sweepFreshBars: v })}
          />
          <NumberField
            label="Свежесть Swing OB (orderBlockFreshBars)"
            description="Как долго активный блок ордеров swing-структуры (Order Block) может участвовать в scoring (≥0)."
            value={config.orderBlockFreshBars}
            onChange={(v) => setConfig({ ...config, orderBlockFreshBars: v })}
          />
          <NumberField
            label="Свежесть FVG (fvgFreshBars)"
            description="Как долго актуальный ценовой дисбаланс (Fair Value Gap / FVG) может участвовать в scoring (≥0)."
            value={config.fvgFreshBars}
            onChange={(v) => setConfig({ ...config, fvgFreshBars: v })}
          />
        </div>
      </section>

      <section className="editorSection">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Ценовой диапазон: Premium / Discount (Dealing Range)</h2>
          <button type="button" onClick={() => resetSection("Dealing Range")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          Определяется положение текущей цены внутри активного dealing range. Нижняя часть —{" "}
          <b>Discount</b>, верхняя — <b>Premium</b>, область около середины — <b>Equilibrium</b>.{" "}
          <code>eqBand</code> задаёт ширину нейтральной полосы вокруг середины; больший <code>eqBand</code> = более
          широкая Equilibrium-зона. Это только один из 9 факторов — <b>не</b> означает «Discount = покупать» и «Premium =
          продавать».
        </p>
        <NumberField
          label="Полоса равновесия (eqBand)"
          description="Полуширина EQUILIBRIUM (0 ≤ eqBand <0.5). При 0.02: <0.48 discount, >0.52 premium, иначе equilibrium."
          value={config.eqBand}
          step="0.01"
          onChange={(v) => setConfig({ ...config, eqBand: v })}
        />
        <div style={{ background: "#fffbeb", border: "1px solid #fcd34d", padding: 10, borderRadius: 6, marginTop: 12 }}>
          <small>
            <b>Примечание о Range:</b> позиция цены намеренно <b>не clamp</b> — может быть &lt;0 или &gt;1. Текущее scoring всё ещё
            начисляет баллы: ниже диапазона — как Discount (LONG), выше — как Premium (SHORT). Желаемый lifecycle после выхода цены за
            диапазон (maxAge / “N баров вне → expired” vs оставить breakout) пока на аудите и не решён — не заявляется как оптимизированный.
          </small>
        </div>
      </section>

      {/* Phase 3D advanced groups */}
      <section className="editorSection" style={{ border: "1px solid #93c5fd", background: "#eff6ff" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Импульс / Displacement</h2>
          <button type="button" onClick={() => resetSection("Импульс / Displacement")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          Определяет, насколько сильным должен быть импульс, чтобы считаться <b>displacement</b>. После 3D-B пороги
          <b> едины</b> для top-level оценки и для внутреннего детектирования в блоках ордеров (OB). Изменение влияет и на прямой
          вес displacement, и на формирование OB (через общий примитив).
        </p>
        <div className="fieldGrid">
          <NumberField
            label="Тело импульса — минимум ATR (displacement.bodyAtrMin) — default 1.5"
            description="Что контролирует: минимальное тело свечи в единицах ATR. Увеличение → строже: только более вытянутые тела проходят; уменьшение → мягче. Допустимо 0..10, шаг 0.1. Зависит от atrPeriod. Влияет на OB как общий примитив."
            value={config.displacement?.bodyAtrMin ?? DEFAULT_DISPLACEMENT.bodyAtrMin}
            step="0.1"
            min="0"
            max="10"
            onChange={(v) => setConfig((c) => ({ ...c, displacement: { ...(c.displacement ?? DEFAULT_DISPLACEMENT), bodyAtrMin: v } }))}
          />
          <NumberField
            label="Размах — минимум ATR (displacement.rangeAtrMin) — default 2.0"
            description="Что контролирует: полный размах high-low в ATR. Увеличение → требуется более широкий размах; уменьшение → допускаются более узкие свечи. 0..10, шаг 0.1. Совместно с bodyAtrMin и closeLocation."
            value={config.displacement?.rangeAtrMin ?? DEFAULT_DISPLACEMENT.rangeAtrMin}
            step="0.1"
            min="0"
            max="10"
            onChange={(v) => setConfig((c) => ({ ...c, displacement: { ...(c.displacement ?? DEFAULT_DISPLACEMENT), rangeAtrMin: v } }))}
          />
          <NumberField
            label="Бычье закрытие — минимум позиции (displacement.bullCloseLocMin) — default 0.60"
            description="Что контролирует: где внутри размаха должна закрыться бычья импульсная свеча. Увеличение → требуется закрытие ближе к максимуму; уменьшение → мягче. 0..1, шаг 0.05."
            value={config.displacement?.bullCloseLocMin ?? DEFAULT_DISPLACEMENT.bullCloseLocMin}
            step="0.05"
            min="0"
            max="1"
            onChange={(v) => setConfig((c) => ({ ...c, displacement: { ...(c.displacement ?? DEFAULT_DISPLACEMENT), bullCloseLocMin: v } }))}
          />
          <NumberField
            label="Медвежье закрытие — максимум позиции (displacement.bearCloseLocMax) — default 0.40"
            description="Что контролирует: где внутри размаха должна закрыться медвежья импульсная свеча. Уменьшение → строже (ближе к минимуму); увеличение → мягче. 0..1, шаг 0.05. Предупреждение: слишком широкое окно размывает направленный смысл."
            value={config.displacement?.bearCloseLocMax ?? DEFAULT_DISPLACEMENT.bearCloseLocMax}
            step="0.05"
            min="0"
            max="1"
            onChange={(v) => setConfig((c) => ({ ...c, displacement: { ...(c.displacement ?? DEFAULT_DISPLACEMENT), bearCloseLocMax: v } }))}
          />
        </div>
      </section>

      <section className="editorSection" style={{ border: "1px solid #86efac", background: "#f0fdf4" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Ценовой дисбаланс / FVG</h2>
          <button type="button" onClick={() => resetSection("Ценовой дисбаланс / FVG")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          Определяет геометрию имбаланса и его жизненный цикл. <b>minGapAtr</b> — общий примитив для top-level FVG и для OB
          (после 3D-B). <b>maxAgeCandles</b> влияет только на top-level FVG scoring/доступность, <b>не</b> влияет на OB
          <code>hasFvgInImpulse</code> (OB проверяет интервал подтверждения, а не later state).
        </p>
        <div className="fieldGrid">
          <NumberField
            label="Минимальный разрыв — ATR (fvg.minGapAtr) — default 0.10"
            description="Что контролирует: минимальный размер ценового разрыва. Увеличение → только более широкие FVG проходят; уменьшение → больше мелких FVG. 0..5, шаг 0.05. Общий для top-level и OB."
            value={config.fvg?.minGapAtr ?? DEFAULT_FVG.minGapAtr}
            step="0.05"
            min="0"
            max="5"
            onChange={(v) => setConfig((c) => ({ ...c, fvg: { ...(c.fvg ?? DEFAULT_FVG), minGapAtr: v } }))}
          />
          <NumberField
            label="Время жизни FVG — свечей (fvg.maxAgeCandles) — default 0"
            description="Что контролирует: через сколько закрытых свечей после подтверждения FVG становится EXPIRED и перестаёт участвовать в scoring. 0 = expiry выключен (текущий scoring default). Увеличение → FVG живёт дольше; уменьшение → быстрее истекает. 0..5000, целое. Не влияет на OB confluence."
            value={config.fvg?.maxAgeCandles ?? DEFAULT_FVG.maxAgeCandles}
            step="1"
            min="0"
            max="5000"
            onChange={(v) => setConfig((c) => ({ ...c, fvg: { ...(c.fvg ?? DEFAULT_FVG), maxAgeCandles: Math.round(v) } }))}
          />
        </div>
      </section>

      <section className="editorSection" style={{ border: "1px solid #fca5a5", background: "#fef2f2" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Ликвидность</h2>
          <button type="button" onClick={() => resetSection("Ликвидность")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          Определяет формирование уровней ликвидности, их ровность, подтверждение и жизненный цикл. Изменение влияет на количество
          уровней и частоту sweep/break.
        </p>
        <div className="fieldGrid">
          <NumberField
            label="Допуск ровности — ATR (liquidity.eqToleranceAtr) — default 0.10"
            description="Что контролирует: насколько близко два экстремума должны быть, чтобы считаться equal highs/lows. Увеличение → допускаются более неровные уровни (больше EQ-групп); уменьшение → только почти идеально ровные. 0..1, шаг 0.01."
            value={config.liquidity?.eqToleranceAtr ?? DEFAULT_LIQUIDITY.eqToleranceAtr}
            step="0.01"
            min="0"
            max="1"
            onChange={(v) => setConfig((c) => ({ ...c, liquidity: { ...(c.liquidity ?? DEFAULT_LIQUIDITY), eqToleranceAtr: v } }))}
          />
          <NumberField
            label="Подтверждение ровности — баров (liquidity.eqConfirmBars) — default 2"
            description="Что контролирует: сколько закрытых свечей подряд должны подтвердить ровность после второго экстремума. Увеличение → строже, дольше ждать; уменьшение → быстрее формируется. 0..20, целое. 0 = подтверждение не требуется."
            value={config.liquidity?.eqConfirmBars ?? DEFAULT_LIQUIDITY.eqConfirmBars}
            step="1"
            min="0"
            max="20"
            onChange={(v) => setConfig((c) => ({ ...c, liquidity: { ...(c.liquidity ?? DEFAULT_LIQUIDITY), eqConfirmBars: Math.round(v) } }))}
          />
          <NumberField
            label="Глубина съёма — минимум ATR (liquidity.sweepMinPenetrationAtr) — default 0.05"
            description="Что контролирует: насколько глубоко свеча должна проникнуть за уровень, чтобы считалось sweep. Увеличение → требуется более глубокий прокол; уменьшение → достаточно небольшого прокола. 0..1, шаг 0.01."
            value={config.liquidity?.sweepMinPenetrationAtr ?? DEFAULT_LIQUIDITY.sweepMinPenetrationAtr}
            step="0.01"
            min="0"
            max="1"
            onChange={(v) => setConfig((c) => ({ ...c, liquidity: { ...(c.liquidity ?? DEFAULT_LIQUIDITY), sweepMinPenetrationAtr: v } }))}
          />
          <NumberField
            label="Время жизни уровня — свечей (liquidity.maxAgeCandles) — default 0"
            description="Что контролирует: через сколько закрытых свечей уровень становится EXPIRED, если не снят/не пробит. 0 = expiry выключен (текущий scoring default, модуль default 750 остаётся для изолированных тестов). Увеличение → уровни живут дольше. 0..5000, целое."
            value={config.liquidity?.maxAgeCandles ?? DEFAULT_LIQUIDITY.maxAgeCandles}
            step="1"
            min="0"
            max="5000"
            onChange={(v) => setConfig((c) => ({ ...c, liquidity: { ...(c.liquidity ?? DEFAULT_LIQUIDITY), maxAgeCandles: Math.round(v) } }))}
          />
        </div>
      </section>

      <section className="editorSection" style={{ border: "1px solid #fde68a", background: "#fffbeb" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Блоки ордеров / Order Blocks</h2>
          <button type="button" onClick={() => resetSection("Блоки ордеров / Order Blocks")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          Определяет формирование импульса, ожидание структурного подтверждения и жизненный цикл зоны. Зависит от displacement/FVG
          примитивов (единые пороги) и от swing-окон.
        </p>
        <div className="fieldGrid">
          <NumberField
            label="Максимум свечей импульса (orderBlock.impulseMaxCandles) — default 3"
            description="Что контролирует: сколько свечей подряд одного направления может входить в impulse grouping (начиная с displacement). Увеличение → допускаются более длинные импульсы; уменьшение → только короткие. 1..10, целое. Зависит от displacement."
            value={config.orderBlock?.impulseMaxCandles ?? DEFAULT_ORDERBLOCK.impulseMaxCandles}
            step="1"
            min="1"
            max="10"
            onChange={(v) => setConfig((c) => ({ ...c, orderBlock: { ...(c.orderBlock ?? DEFAULT_ORDERBLOCK), impulseMaxCandles: Math.round(v) } }))}
          />
          <NumberField
            label="Максимум ожидания подтверждения — свечей (orderBlock.confirmMaxCandles) — default 10"
            description="Что контролирует: сколько закрытых свечей после конца импульса может ждать BOS/CHOCH подтверждения. Увеличение → дольше ждать; уменьшение → строже по времени. 1..100, целое."
            value={config.orderBlock?.confirmMaxCandles ?? DEFAULT_ORDERBLOCK.confirmMaxCandles}
            step="1"
            min="1"
            max="100"
            onChange={(v) => setConfig((c) => ({ ...c, orderBlock: { ...(c.orderBlock ?? DEFAULT_ORDERBLOCK), confirmMaxCandles: Math.round(v) } }))}
          />
          <NumberField
            label="Время жизни зоны — свечей (orderBlock.maxAgeCandles) — default 750"
            description="Что контролирует: через сколько закрытых свечей после подтверждения зона становится EXPIRED. 0 = expiry выключен. Увеличение → зоны живут дольше; уменьшение → быстрее истекают. 0..5000, целое."
            value={config.orderBlock?.maxAgeCandles ?? DEFAULT_ORDERBLOCK.maxAgeCandles}
            step="1"
            min="0"
            max="5000"
            onChange={(v) => setConfig((c) => ({ ...c, orderBlock: { ...(c.orderBlock ?? DEFAULT_ORDERBLOCK), maxAgeCandles: Math.round(v) } }))}
          />
          <NumberField
            label="Контекст sweep — lookback свечей (orderBlock.sweepLookbackCandles) — default 5"
            description="Что контролирует: сколько предыдущих закрытых свечей искать SWEPT ликвидность перед началом импульса для конfluence. 0 = конfluence выключен. Увеличение → учитывается более давний sweep; уменьшение → только недавний. 0..100, целое."
            value={config.orderBlock?.sweepLookbackCandles ?? DEFAULT_ORDERBLOCK.sweepLookbackCandles}
            step="1"
            min="0"
            max="100"
            onChange={(v) => setConfig((c) => ({ ...c, orderBlock: { ...(c.orderBlock ?? DEFAULT_ORDERBLOCK), sweepLookbackCandles: Math.round(v) } }))}
          />
        </div>
      </section>

      <section className="editorSection">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Оценка сигнала — веса факторов (Scoring)</h2>
          <button type="button" onClick={() => resetSection("Scoring")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          LONG и SHORT получают отдельные баллы. 9 факторов дают вклад согласно весам; сумма весов обязана быть{" "}
          <b>ровно 100</b>. Вес <code>0</code> убирает вклад фактора в итоговый score, но <b>не</b> обязательно отключает
          вычисление соответствующей структуры в core. Больший вес = фактор сильнее влияет на итог; изменение весов не
          означает автоматического улучшения стратегии.
        </p>
        <div className="fieldGrid">
          {(
            [
              ["swingStructureBias", "Основное направление swing-структуры (SWING_TREND)"],
              ["recentSwingBos", "Недавний пробой структуры — BOS (RECENT_SWING_BOS)"],
              ["internalStructure", "Внутренняя структура (INTERNAL_TREND)"],
              ["liquiditySweep", "Снятие ликвидности (LIQUIDITY_SWEEP)"],
              ["swingOrderBlock", "Swing блок ордеров (SWING_ORDER_BLOCK)"],
              ["internalOrderBlock", "Internal блок ордеров (INTERNAL_ORDER_BLOCK)"],
              ["fvg", "Ценовой дисбаланс — FVG (FVG)"],
              ["rangePosition", "Положение в Premium/Discount (RANGE_POSITION)"],
              ["confluence", "Совпадение блока ордеров + FVG (OB_FVG_CONFLUENCE)"],
            ] as const
          ).map(([key, title]) => {
            const descriptions: Record<string, string> = {
              swingStructureBias: "Показывает направление более крупной подтверждённой структуры рынка.",
              recentSwingBos: "BOS — подтверждённый пробой ранее сформированного структурного уровня.",
              internalStructure: "Направление более мелкой и чувствительной структуры рынка.",
              liquiditySweep: "Фиксирует подтверждённое снятие ликвидности за структурным максимумом/минимумом.",
              swingOrderBlock: "Блок ордеров (Order Block), относящийся к более крупной swing-структуре.",
              internalOrderBlock: "Блок ордеров внутренней, более чувствительной структуры.",
              fvg: "Ценовой дисбаланс между свечами (Fair Value Gap), определяемый формальными правилами SMC core.",
              rangePosition: "Учитывает, где находится текущая цена внутри активного dealing range.",
              confluence: "Дополнительный фактор, когда выбранные блок ордеров и FVG одного направления пересекаются.",
            };
            return (
              <NumberField
                key={key}
                label={title}
                description={descriptions[key as string] + " Вес 0..100."}
                value={config.weights[key as keyof SmcWeights]}
                onChange={(v) =>
                  setConfig((c) => ({
                    ...c,
                    weights: { ...c.weights, [key]: v },
                  }))
                }
              />
            );
          })}
        </div>
        <div className="scoreTotal" style={{ color: weightSum === 100 ? "inherit" : "#dc2626" }}>
          Сумма весов: <b>{weightSum}</b> {weightSum !== 100 ? "— должна быть 100" : "✓"}
        </div>
      </section>

      <section className="editorSection">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2>Фильтры рынков</h2>
          <button type="button" onClick={() => resetSection("Filters")} style={{ fontSize: 12 }}>
            Сбросить секцию
          </button>
        </div>
        <p className="sectionDescription">
          Фильтры определяют, какие рынки вообще допускаются до оценки. Они <b>не</b> добавляют баллы LONG/SHORT.
        </p>
        <NumberField
          label="Мин. объём рынка 24ч — quote volume (minimumQuoteVolume24h)"
          description="Минимальный 24h quote volume в USDT. Рынок ниже порога исключается; 0 = фильтр объёма отключён."
          value={config.filters.minimumQuoteVolume24h}
          onChange={(v) => setConfig((c) => ({ ...c, filters: { ...c.filters, minimumQuoteVolume24h: v } }))}
        />
        <label className="checkSetting">
          <input
            type="checkbox"
            checked={config.filters.top500Only}
            onChange={(e) => setConfig((c) => ({ ...c, filters: { ...c.filters, top500Only: e.target.checked } }))}
          />
          <span>
            <b>Только Top-100 (основной universe)</b>
            <small>
              Ограничивает сканер основным ranked universe (rank 1..100). Имя поля в JSON — <code>top500Only</code> сохранено для обратной совместимости.
            </small>
          </span>
        </label>
      </section>

      <div className="editorSaveBar">
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button type="button" onClick={resetAll} style={{ fontSize: 13 }}>
            Сбросить всё к defaults
          </button>
          {message && <span>{message}</span>}
        </div>
        <button onClick={save} disabled={!canSave} title={!isDirty ? "Нет изменений" : errors.length ? errors[0] : ""}>
          {saving ? "Сохранение..." : "Сохранить настройки"}
        </button>
      </div>
    </div>
  );
}
