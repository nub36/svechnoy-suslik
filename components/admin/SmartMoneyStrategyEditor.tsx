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
  // optional, ignore
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
};

const ALLOWED_TFS = ["5m", "15m", "1h", "4h", "1d"] as const;

function NumberField({
  label,
  description,
  value,
  onChange,
  step = "1",
}: {
  label: string;
  description: string;
  value: number;
  onChange: (v: number) => void;
  step?: string;
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
  };
}

function validateLocal(
  config: SmartMoneyConfig,
  timeframes: string[],
  minExchanges: number
): string[] {
  const errors: string[] = [];

  // minimumSignalScore
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
  // weights
  const keys = Object.keys(DEFAULT_WEIGHTS) as (keyof SmcWeights)[];
  let sum = 0;
  for (const k of keys) {
    const v = config.weights[k];
    if (!Number.isInteger(v) || v < 0 || v > 100) errors.push(`weights.${k}: ожидается целое 0..100`);
    sum += v;
  }
  if (sum !== 100) errors.push(`weights: сумма весов должна быть ровно 100 (сейчас ${sum})`);
  // filters
  if (!Number.isFinite(config.filters.minimumQuoteVolume24h) || config.filters.minimumQuoteVolume24h < 0) {
    errors.push("filters.minimumQuoteVolume24h: ожидается число ≥0");
  }
  if (typeof config.filters.top500Only !== "boolean") {
    errors.push("filters.top500Only: ожидается boolean");
  }
  // timeframes
  if (!Array.isArray(timeframes) || timeframes.length === 0) {
    errors.push("timeframes: нужен непустой список таймфреймов");
  } else {
    const allowed = new Set<string>([...ALLOWED_TFS]);
    const bad = timeframes.filter((tf) => !allowed.has(tf));
    if (bad.length) errors.push(`timeframes: недопустимые значения: ${bad.join(", ")}`);
  }
  // minExchanges
  if (!Number.isInteger(minExchanges) || minExchanges < 1 || minExchanges > 5) {
    errors.push("minExchanges: ожидается целое 1..5");
  }
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

  // kept for potential nested updates; currently weights/filters use direct setConfig
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
    // Phase 3C staged: 1h is locked — cannot be removed (would produce [] invalid)
    if (tf === "1h") return;
    setTimeframes((cur) => (cur.includes(tf) ? cur.filter((x) => x !== tf) : [...cur, tf]));
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
    }
  }

  function resetAll() {
    if (!confirm("Сбросить ВСЕ параметры Smart Money к canonical defaults? Потребуется явное сохранение.")) return;
    setConfig({ ...DEFAULT_CONFIG, weights: { ...DEFAULT_WEIGHTS }, filters: { ...DEFAULT_CONFIG.filters } });
    setTimeframes(["1h"]);
    // minExchanges — Strategy-level параметр без автоматически выбранного SMC trading default;
    // не меняем его при Reset all, чтобы не превращать тестовое значение 2 в production decision.
    // enabled тоже оставляем как был.
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
      // update initial refs to new saved state
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

      {/* Общие */}
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
          <small>Phase 3C staged = 1h production-safe. 5m/15m/4h/1d будут доступны после Phase 3E проверки реальных данных.</small>
          <div className="timeframeSelector">
            {([...ALLOWED_TFS] as string[]).map((tf) => {
              const active = timeframes.includes(tf);
              const isLocked = tf === "1h";
              const isUnverified = tf !== "1h";
              return (
                <button
                  type="button"
                  key={tf}
                  className={active ? "tfActive" : ""}
                  disabled={isLocked || isUnverified}
                  onClick={() => {
                    if (isLocked || isUnverified) return;
                    toggleTimeframe(tf);
                  }}
                  title={
                    isLocked
                      ? "1h — проверен и зафиксирован до Phase 3E"
                      : `${tf} поддерживается SMC core, но временно заблокирован до проверки реальных candle data в Phase 3E.`
                  }
                >
                  {tf}
                  {isLocked ? " 🔒" : isUnverified ? " *" : ""}
                </button>
              );
            })}
          </div>
          <small style={{ color: "#92400e" }}>* 5m/15m/4h/1d — disabled до Phase 3E. Архитектура поддерживает, но closeTime-консистентность подтверждена только для 1h.</small>
          <small style={{ color: "#065f46", display: "block", marginTop: 4 }}>🔒 1h — проверен и зафиксирован до Phase 3E (не снимается, staged требует ровно ["1h"]).</small>
        </div>
      </section>

      {/* Market Structure */}
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

      {/* Volatility */}
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

      {/* Freshness */}
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

      {/* Dealing Range */}
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
      </section>

      {/* Scoring */}
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

      {/* Filters */}
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

      {/* Informational hardcoded */}
      <details className="editorSection" style={{ padding: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Продвинутые параметры — Phase 3D (только просмотр)</summary>
        <p className="muted" style={{ fontSize: 13, marginTop: 8 }}>
          Следующие параметры сейчас фиксированы в SMC core и не настраиваются в Phase 3C. Сейчас эти параметры доступны
          только для просмотра. Возможность настройки будет добавлена после отдельной проверки Phase 3D.
        </p>
        <div style={{ fontSize: 13, marginTop: 12 }}>
          <p>
            <b>Displacement (импульс):</b> определяет, насколько сильным должен быть импульс относительно ATR и где
            закрывается импульсная свеча. Текущие значения: bodyAtrMin 1.5, rangeAtrMin 2.0, bullCloseLocMin 0.60,
            bearCloseLocMax 0.40.
          </p>
          <p>
            <b>Fair Value Gap (FVG):</b> определяет минимальный размер ценового дисбаланса и правила его жизненного цикла.
            Текущие: minGapAtr 0.10, maxAgeCandles 0 (expiry выключен).
          </p>
          <p>
            <b>Liquidity (ликвидность):</b> определяет допуск для equal highs/lows, подтверждение liquidity pool и
            минимальную глубину sweep. Текущие: eqToleranceAtr 0.10, eqConfirmBars 2, sweepMinPenetrationAtr 0.05, maxAge 0.
          </p>
          <p>
            <b>Order Blocks (блоки ордеров):</b> определяет правила поиска исходной свечи/зоны, импульсного подтверждения,
            возраста и контекста sweep. Текущие: impulseMaxCandles 3, confirmMaxCandles 10, maxAge 750, sweepLookback 5.
          </p>
          <p>
            <b>Dealing Range:</b> кроме eqBand и swing-окон, остальные правила диапазона фиксированы в core.
          </p>
        </div>
      </details>

      <div className="editorSaveBar">
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          <button type="button" onClick={resetAll} style={{ fontSize: 13 }}>
            Сбросить все к defaults
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
