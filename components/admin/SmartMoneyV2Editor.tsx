"use client";

import { useState, useMemo, useRef } from "react";
import {
  DEFAULT_V2_CONFIG,
  normalizeV2Config,
  validateV2Config,
  type SmartMoneyV2Config,
  type SmcConfirmationConfig,
  type TrendMode,
  type TrendPolicy,
  type StrategyMode,
} from "@/lib/strategies/smart-money-v2";

type Props = {
  strategy: {
    id: number;
    slug: string;
    name: string;
    description: string | null;
    version: number;
    enabled: boolean;
    status: string;
    mode: string;
    minExchanges: number;
    timeframes: string[];
    config: SmartMoneyV2Config;
  };
};

const ALLOWED_TFS = ["5m", "15m", "1h", "4h", "1d"] as const;
const ALLOWED_EXCHANGES = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"] as const;
const ALLOWED_MODES: StrategyMode[] = ["DISABLED", "DRY_RUN", "FORWARD_TEST", "LIVE"];
const TREND_MODES: TrendMode[] = ["OFF", "MARKET_STRUCTURE", "EMA", "HTF", "COMBINED"];
const TREND_POLICIES: TrendPolicy[] = ["SCORE_BOOST", "TIERING", "HARD_ALIGNMENT"];

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

function ConfirmationRow({
  code,
  label,
  description,
  config,
  onChange,
}: {
  code: string;
  label: string;
  description: string;
  config: SmcConfirmationConfig;
  onChange: (c: SmcConfirmationConfig) => void;
}) {
  const categoryColor: Record<string, string> = {
    INDEPENDENT: "#059669",
    DERIVED: "#d97706",
    CONTEXT: "#2563eb",
    PLACEHOLDER: "#6b7280",
  };
  const categoryLabel: Record<string, string> = {
    INDEPENDENT: "INDEPENDENT",
    DERIVED: "DERIVED (bonus)",
    CONTEXT: "CONTEXT",
    PLACEHOLDER: "PLACEHOLDER",
  };
  return (
    <div style={{ border: "1px solid #e5e7eb", borderRadius: 8, padding: 12, background: config.enabled ? "#fff" : "#f9fafb", opacity: config.category === "PLACEHOLDER" && !config.enabled ? 0.6 : 1 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <div>
          <b>{label}</b> <small style={{ color: "#6b7280" }}>{code}</small>
          <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, color: "#fff", background: categoryColor[config.category] || "#6b7280", padding: "2px 6px", borderRadius: 4 }}>{categoryLabel[config.category] || config.category}</span>
          <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>{description}</div>
          {config.description && <div style={{ fontSize: 11, color: "#374151", marginTop: 4, fontStyle: "italic" }}>{config.description}</div>}
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input type="checkbox" checked={config.enabled} onChange={(e) => onChange({ ...config, enabled: e.target.checked })} disabled={config.category === "PLACEHOLDER" && config.weight===0} />
          <span style={{ fontSize: 13 }}>{config.enabled ? "Вкл" : "Выкл"}</span>
        </label>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12 }}>Вес</span>
          <input
            type="number"
            min="0"
            max="100"
            step="1"
            value={config.weight}
            onChange={(e) => onChange({ ...config, weight: Number(e.target.value) || 0 })}
            disabled={!config.enabled}
          />
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12 }}>Требуемость</span>
          <select
            value={config.required ? "required" : "optional"}
            onChange={(e) => onChange({ ...config, required: e.target.value === "required" })}
            disabled={!config.enabled || config.category === "PLACEHOLDER" || config.category === "DERIVED"}
          >
            <option value="required">Обязательно (core)</option>
            <option value="optional">Опционально (weighted)</option>
          </select>
        </label>
        <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span style={{ fontSize: 12 }}>Категория</span>
          <select
            value={config.category}
            onChange={(e) => onChange({ ...config, category: e.target.value as any })}
            disabled={true}
          >
            <option value="INDEPENDENT">INDEPENDENT</option>
            <option value="DERIVED">DERIVED</option>
            <option value="CONTEXT">CONTEXT</option>
            <option value="PLACEHOLDER">PLACEHOLDER</option>
          </select>
        </label>
      </div>
    </div>
  );
}

export default function SmartMoneyV2Editor({ strategy }: Props) {
  const initialConfigRef = useRef<SmartMoneyV2Config>(normalizeV2Config(strategy.config));
  const initialTimeframesRef = useRef<string[]>([...strategy.timeframes]);
  const initialMinExchangesRef = useRef<number>(strategy.minExchanges);
  const initialEnabledRef = useRef<boolean>(strategy.enabled);
  const initialModeRef = useRef<string>(strategy.mode);

  const [config, setConfig] = useState<SmartMoneyV2Config>(() => normalizeV2Config(strategy.config));
  const [enabled, setEnabled] = useState<boolean>(strategy.enabled);
  const [mode, setMode] = useState<StrategyMode>(() => {
    const m = strategy.mode as StrategyMode;
    return ALLOWED_MODES.includes(m) ? m : "DISABLED";
  });
  const [minExchanges, setMinExchanges] = useState<number>(strategy.minExchanges);
  const [timeframes, setTimeframes] = useState<string[]>(() => [...strategy.timeframes]);
  const [message, setMessage] = useState<string>("");
  const [saving, setSaving] = useState<boolean>(false);
  const [researchResult, setResearchResult] = useState<string>("");

  const errors = useMemo(() => validateV2Config(config, timeframes, minExchanges), [config, timeframes, minExchanges]);
  const weightSum = useMemo(() => Object.values(config.weights).reduce((s, v) => s + v, 0), [config.weights]);

  const isDirty = useMemo(() => {
    const sameConfig = JSON.stringify(config) === JSON.stringify(initialConfigRef.current);
    const sameTF = JSON.stringify([...timeframes].sort()) === JSON.stringify([...initialTimeframesRef.current].sort());
    const sameMin = minExchanges === initialMinExchangesRef.current;
    const sameEnabled = enabled === initialEnabledRef.current;
    const sameMode = mode === initialModeRef.current;
    return !(sameConfig && sameTF && sameMin && sameEnabled && sameMode);
  }, [config, timeframes, minExchanges, enabled, mode]);

  const canSave = isDirty && errors.length === 0 && !saving && (mode as string) !== "LIVE";

  function toggleTimeframe(tf: string) {
    setTimeframes((cur) => {
      if (cur.includes(tf)) {
        if (cur.length === 1) return cur;
        return cur.filter((x) => x !== tf);
      }
      return [...cur, tf];
    });
  }

  async function save() {
    if (!canSave) return;
    if ((mode as string) === "LIVE") {
      setMessage("LIVE режим пока запрещён — используйте DISABLED/DRY_RUN/FORWARD_TEST, LIVE после валидации");
      return;
    }
    setSaving(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/strategies/${strategy.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          mode,
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
      setMessage("✓ Настройки V2 сохранены в PostgreSQL");
      initialConfigRef.current = JSON.parse(JSON.stringify(config));
      initialMinExchangesRef.current = minExchanges;
      initialTimeframesRef.current = [...timeframes];
      initialEnabledRef.current = enabled;
      initialModeRef.current = mode;
    } catch {
      setMessage("Ошибка соединения с сервером");
    } finally {
      setSaving(false);
    }
  }

  async function runResearch() {
    setResearchResult("Запуск исследования... (использует существующий experiment framework)");
    try {
      const res = await fetch(`/api/admin/strategies/${strategy.id}/research`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (!res.ok) {
        setResearchResult(`Ошибка исследования: ${data.error || "unknown"}`);
        return;
      }
      setResearchResult(JSON.stringify(data, null, 2));
    } catch (e) {
      setResearchResult(`Ошибка: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const confirmationDescriptions: Record<string, { label: string; desc: string }> = {
    bos: { label: "Break of Structure (BOS)", desc: "Пробой swing-структуры — основное направленное событие" },
    choch: { label: "Change of Character (CHOCH)", desc: "Смена характера внутренней структуры" },
    orderBlock: { label: "Order Block", desc: "Блок ордеров swing + internal — зона интереса" },
    fvg: { label: "Fair Value Gap (FVG)", desc: "Ценовой дисбаланс — имбаланс между свечами" },
    liquiditySweep: { label: "Liquidity Sweep", desc: "Снятие ликвидности за структурным экстремумом" },
    displacement: { label: "Displacement", desc: "Импульсное движение с телом и размахом" },
    rangePosition: { label: "Premium/Discount Range", desc: "Положение цены в dealing range" },
    confluence: { label: "Confluence OB+FVG", desc: "Совпадение блока ордеров и FVG" },
    internalStructure: { label: "Internal Structure Bias", desc: "Внутренняя структура как тренд-фильтр" },
  };

  return (
    <div className="strategyEditor">
      <section className="editorHero">
        <div>
          <div className="editorBadges">
            <span>{strategy.slug}</span>
            <span>Версия {strategy.version}</span>
            <span>{strategy.status}</span>
            <span style={{ background: (mode as string) === "LIVE" ? "#dc2626" : mode === "DISABLED" ? "#6b7280" : "#059669", color: "#fff" }}>{mode}</span>
          </div>
          <h1>{strategy.name} — Smart Money V2</h1>
          {strategy.description && <p>{strategy.description}</p>}
          <p className="muted" style={{ marginTop: 8, fontSize: 13 }}>
            V2 • Референс {config.referenceExchange} • {config.symbol} • TF {config.timeframe} • Порог {config.minimumSignalScore} • Веса Σ={weightSum} • Подтверждения {Object.values(config.confirmations).filter(c => c.enabled).length} активных / {Object.keys(config.confirmations).length} всего (INDEPENDENT {Object.values(config.confirmations).filter(c => c.enabled && (c as any).category==="INDEPENDENT").length}, DERIVED {Object.values(config.confirmations).filter(c => c.enabled && (c as any).category==="DERIVED").length}, CONTEXT {Object.values(config.confirmations).filter(c => c.enabled && (c as any).category==="CONTEXT").length}, PLACEHOLDER {Object.values(config.confirmations).filter(c => (c as any).category==="PLACEHOLDER").length} disabled)
          </p>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label className="switchLabel">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            <span>{enabled ? "Стратегия включена" : "Стратегия выключена"}</span>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Режим (MODE)</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as StrategyMode)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db" }}>
              {ALLOWED_MODES.map((m) => (
                <option key={m} value={m} disabled={(m as string) === "LIVE"}>
                  {m} {(m as string) === "LIVE" ? "(запрещён в этой задаче)" : ""}
                </option>
              ))}
            </select>
            <small style={{ color: "#6b7280" }}>LIVE gated — DRY_RUN/FORWARD_TEST OK</small>
          </label>
        </div>
      </section>

      <section className="editorSection" style={{ background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
        <h2>Как работает Smart Money V2</h2>
        <p style={{ fontSize: 13, lineHeight: "1.5" }}>
          V2 строится на <b>референсной бирже</b> {config.referenceExchange} (по умолчанию BINANCE) — направление LONG/SHORT определяется только по закрытым свечам референса, а не голосованием 3/5 бирж.
          Подтверждения стратегии: <b>N/M</b> (сколько SMC-подтверждений из активных совпало), а не Биржи N/M.
          Тренд-контекст — опциональный фильтр/буст, не жёсткий блок без исследования.
          EDGE/RE-ARM state-machine из V1 сохранена: NEUTRAL→LONG/SHORT=EDGE, LONG→LONG HOLD, SHORT→SHORT HOLD, LONG/SHORT→NEUTRAL REARM, LONG↔SHORT REVERSAL, Unavailable PRESERVE.
          V1/V2 состояния независимы по strategyId.
        </p>
        <ul style={{ fontSize: 13, margin: "8px 0 0 18px", lineHeight: "1.5" }}>
          <li><b>BOS</b> — Break of Structure — пробой swing high/low</li>
          <li><b>CHOCH</b> — Change of Character — смена внутренней структуры</li>
          <li><b>Order Block</b> — блок ордеров swing/internal</li>
          <li><b>FVG</b> — Fair Value Gap — ценовой имбаланс</li>
          <li><b>Liquidity Sweep</b> — снятие ликвидности</li>
          <li><b>Displacement</b> — импульс с body/range/close location</li>
          <li><b>Range</b> — Premium/Discount position</li>
          <li><b>Confluence</b> — OB+FVG совпадение</li>
          <li><b>Internal</b> — внутренняя структура bias</li>
        </ul>
      </section>

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

      {(mode as string) === "LIVE" && (
        <div className="adminPanel" style={{ background: "#fef2f2", border: "1px solid #ef4444", padding: 12, borderRadius: 8, marginBottom: 16 }}>
          <b>⚠ LIVE режим пока запрещён</b> — DRY_RUN/FORWARD_TEST OK, LIVE после валидации
        </div>
      )}

      {isDirty && <div style={{ fontSize: 13, color: "#92400e", marginBottom: 12 }}>• Есть несохранённые изменения</div>}

      <section className="editorSection">
        <h2>Базовые настройки V2</h2>
        <div className="fieldGrid">
          <label className="settingField">
            <span>
              <b>Символ (symbol)</b>
              <small>BTC по умолчанию</small>
            </span>
            <input type="text" value={config.symbol} onChange={(e) => setConfig({ ...config, symbol: e.target.value.toUpperCase() })} />
          </label>
          <label className="settingField">
            <span>
              <b>Таймфрейм исполнения (timeframe)</b>
              <small>15m по умолчанию — CLOSED свечи референса</small>
            </span>
            <select value={config.timeframe} onChange={(e) => setConfig({ ...config, timeframe: e.target.value as any })}>
              {ALLOWED_TFS.map((tf) => (
                <option key={tf} value={tf}>{tf}</option>
              ))}
            </select>
          </label>
          <label className="settingField">
            <span>
              <b>Референсная биржа</b>
              <small>BINANCE по умолчанию — направление только по ней</small>
            </span>
            <select value={config.referenceExchange} onChange={(e) => setConfig({ ...config, referenceExchange: e.target.value })}>
              {ALLOWED_EXCHANGES.map((ex) => (
                <option key={ex} value={ex}>{ex} {ex === "BINANCE" ? "(default)" : ""}</option>
              ))}
            </select>
          </label>
          <NumberField
            label="Минимальный скор (minimumSignalScore)"
            description="0..100 — порог для LONG/SHORT, не занижать без исследования"
            value={config.minimumSignalScore}
            onChange={(v) => setConfig({ ...config, minimumSignalScore: v })}
          />
          <NumberField
            label="Подтверждение бирж (minExchanges) — для V1 совместимости"
            description="V2 использует референс, но поле сохраняется для совместимости. 1 по умолчанию для V2."
            value={minExchanges}
            onChange={setMinExchanges}
          />
        </div>
        <div className="settingBlock" style={{ marginTop: 12 }}>
          <b>Рабочие таймфреймы (для сигналов и бэктестов)</b>
          <small>V2 основной TF {config.timeframe}, но может оценивать и другие</small>
          <div className="timeframeSelector">
            {([...ALLOWED_TFS] as string[]).map((tf) => {
              const active = timeframes.includes(tf);
              return (
                <button key={tf} type="button" className={active ? "tfActive" : ""} onClick={() => toggleTimeframe(tf)}>
                  {tf}
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <section className="editorSection" style={{ background: "#eff6ff", border: "1px solid #93c5fd" }}>
        <h2>SMC Подтверждения — реальные фичи из кода (не фейк)</h2>
        <p className="sectionDescription">
          Каждое подтверждение — реальный детектор из lib/smc: BOS, CHOCH, Order Block, FVG, Liquidity Sweep, Displacement, Range, Confluence, Internal.
          Enabled — включено ли, Weight — вес в scoring, Required — обязательно ли для сигнала (core) или опционально (weighted).
          Архитектура V2: required core + optional weighted + trend adjustment + min score — не все должны совпасть, баланс качество/частота.
          UI показывает <b>Подтверждения стратегии N/M</b>, а не Биржи N/M.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: 12 }}>
          {Object.entries(config.confirmations).map(([key, conf]) => {
            const info = confirmationDescriptions[key];
            return (
              <ConfirmationRow
                key={key}
                code={key}
                label={info?.label || key}
                description={info?.desc || ""}
                config={conf}
                onChange={(c) => setConfig({ ...config, confirmations: { ...config.confirmations, [key]: c } as any })}
              />
            );
          })}
        </div>
      </section>

      <section className="editorSection" style={{ background: "#fffbeb", border: "1px solid #fcd34d" }}>
        <h2>Trend Context — тренд-фильтр / буст</h2>
        <p className="sectionDescription">
          Тренд-контекст не должен душить сигналы. Режимы: OFF выкл, MARKET_STRUCTURE по swing bias, EMA по EMA fast/slow, HTF по старшему ТФ, COMBINED комбинация.
          Политики: SCORE_BOOST — буст по тренду, TIERING — тиринг, HARD_ALIGNMENT — жёсткое требование выравнивания (default не HARD_ALIGNMENT без исследования).
        </p>
        <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <input type="checkbox" checked={config.trend.enabled} onChange={(e) => setConfig({ ...config, trend: { ...config.trend, enabled: e.target.checked } })} />
            <span>Trend Enabled</span>
          </label>
        </div>

        <div className="fieldGrid">
          <label className="settingField">
            <span>
              <b>Trend Mode</b>
              <small>OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED</small>
            </span>
            <select
              value={config.trend.mode}
              onChange={(e) => setConfig({ ...config, trend: { ...config.trend, mode: e.target.value as TrendMode } })}
              disabled={!config.trend.enabled}
            >
              {TREND_MODES.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
          </label>
          <label className="settingField">
            <span>
              <b>Trend Policy</b>
              <small>SCORE_BOOST/TIERING/HARD_ALIGNMENT — default не HARD_ALIGNMENT</small>
            </span>
            <select
              value={config.trend.policy}
              onChange={(e) => setConfig({ ...config, trend: { ...config.trend, policy: e.target.value as TrendPolicy } })}
              disabled={!config.trend.enabled}
            >
              {TREND_POLICIES.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </label>
          {(config.trend.mode === "EMA" || config.trend.mode === "COMBINED") && (
            <>
              <NumberField
                label="EMA Fast"
                description="Быстрая EMA период"
                value={config.trend.emaFast}
                onChange={(v) => setConfig({ ...config, trend: { ...config.trend, emaFast: v } })}
              />
              <NumberField
                label="EMA Slow"
                description="Медленная EMA период, должна быть > Fast"
                value={config.trend.emaSlow}
                onChange={(v) => setConfig({ ...config, trend: { ...config.trend, emaSlow: v } })}
              />
              <NumberField
                label="EMA Slope Lookback"
                description="Сколько баров смотреть наклон"
                value={config.trend.emaSlopeLookback}
                onChange={(v) => setConfig({ ...config, trend: { ...config.trend, emaSlopeLookback: v } })}
              />
            </>
          )}
          {(config.trend.mode === "HTF" || config.trend.mode === "COMBINED") && (
            <label className="settingField">
              <span>
                <b>HTF Timeframe</b>
                <small>Старший ТФ — 1h по умолчанию</small>
              </span>
              <select
                value={config.trend.htfTimeframe}
                onChange={(e) => setConfig({ ...config, trend: { ...config.trend, htfTimeframe: e.target.value as any } })}
                disabled={!config.trend.enabled}
              >
                {ALLOWED_TFS.map((tf) => (
                  <option key={tf} value={tf}>{tf} {tf === "1h" ? "(default)" : ""}</option>
                ))}
              </select>
            </label>
          )}
          <NumberField
            label="Trend Weight"
            description="Буст при совпадении с трендом"
            value={config.trend.weight}
            onChange={(v) => setConfig({ ...config, trend: { ...config.trend, weight: v } })}
          />
          <NumberField
            label="Counter-Trend Penalty"
            description="Штраф при контртренде"
            value={config.trend.counterTrendPenalty}
            onChange={(v) => setConfig({ ...config, trend: { ...config.trend, counterTrendPenalty: v } })}
          />
        </div>

        {config.trend.enabled && config.trend.mode !== "OFF" && config.trend.policy === "HARD_ALIGNMENT" && (
          <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", padding: 8, borderRadius: 6, marginTop: 12 }}>
            <small><b>⚠ HARD_ALIGNMENT без исследования</b> — может сильно душить сигналы. По ТЗ default не HARD_ALIGNMENT без исследования.</small>
          </div>
        )}
      </section>

      <section className="editorSection">
        <h2>Market Structure + ATR + Scoring (reuse existing controls)</h2>
        <div className="fieldGrid">
          <NumberField label="Swing Left" description="Левое окно swing пивота 1..500" value={config.swingLeft} onChange={(v) => setConfig({ ...config, swingLeft: v })} />
          <NumberField label="Swing Right" description="Правое окно swing пивота" value={config.swingRight} onChange={(v) => setConfig({ ...config, swingRight: v })} />
          <NumberField label="Internal Left" description="Левое окно internal" value={config.internalLeft} onChange={(v) => setConfig({ ...config, internalLeft: v })} />
          <NumberField label="Internal Right" description="Правое окно internal" value={config.internalRight} onChange={(v) => setConfig({ ...config, internalRight: v })} />
          <NumberField label="ATR Period" description="Период ATR" value={config.atrPeriod} onChange={(v) => setConfig({ ...config, atrPeriod: v })} />
          <NumberField label="Structure Event Fresh Bars" description="Свежесть BOS/CHOCH" value={config.structureEventFreshBars} onChange={(v) => setConfig({ ...config, structureEventFreshBars: v })} />
          <NumberField label="Sweep Fresh Bars" description="Свежесть sweep" value={config.sweepFreshBars} onChange={(v) => setConfig({ ...config, sweepFreshBars: v })} />
          <NumberField label="Order Block Fresh Bars" description="Свежесть OB" value={config.orderBlockFreshBars} onChange={(v) => setConfig({ ...config, orderBlockFreshBars: v })} />
          <NumberField label="FVG Fresh Bars" description="Свежесть FVG" value={config.fvgFreshBars} onChange={(v) => setConfig({ ...config, fvgFreshBars: v })} />
          <NumberField label="Eq Band" description="Полоса равновесия 0..0.5" value={config.eqBand} step="0.01" onChange={(v) => setConfig({ ...config, eqBand: v })} />
        </div>
        <div style={{ marginTop: 12 }}>
          <b>Scoring Weights Σ={weightSum} {weightSum === 100 ? "✓" : "— must be 100"}</b>
          <div className="fieldGrid" style={{ marginTop: 8 }}>
            {Object.entries(config.weights).map(([k, v]) => (
              <NumberField key={k} label={k} description={`Вес ${k} 0..100`} value={v as number} onChange={(nv) => setConfig({ ...config, weights: { ...config.weights, [k]: nv } as any })} />
            ))}
          </div>
        </div>
        <div style={{ marginTop: 12 }}>
          <b>ATR SL/TP</b>
          <div className="fieldGrid" style={{ marginTop: 8 }}>
            <NumberField label="ATR Period (SL/TP)" description="ATR для SL/TP" value={config.atr.period} onChange={(v) => setConfig({ ...config, atr: { ...config.atr, period: v } })} />
            <NumberField label="SL Multiplier" description="Стоп в ATR" value={config.atr.stopMultiplier} step="0.1" onChange={(v) => setConfig({ ...config, atr: { ...config.atr, stopMultiplier: v } })} />
            <NumberField label="TP1 Multiplier" description="TP1 в ATR" value={config.atr.takeProfit1Multiplier} step="0.1" onChange={(v) => setConfig({ ...config, atr: { ...config.atr, takeProfit1Multiplier: v } })} />
            <NumberField label="TP2 Multiplier" description="TP2 в ATR" value={config.atr.takeProfit2Multiplier} step="0.1" onChange={(v) => setConfig({ ...config, atr: { ...config.atr, takeProfit2Multiplier: v } })} />
            <NumberField label="TP3 Multiplier" description="TP3 в ATR" value={config.atr.takeProfit3Multiplier} step="0.1" onChange={(v) => setConfig({ ...config, atr: { ...config.atr, takeProfit3Multiplier: v } })} />
          </div>
        </div>
      </section>

      <section className="editorSection" style={{ background: "#f5f3ff", border: "1px solid #c4b5fd" }}>
        <h2>Research Results — сравнение V1 vs V2-A/B/C/D</h2>
        <p className="sectionDescription">
          Метрики: EDGE эпизоды, signals/day, LONG/SHORT, TP1/2/3-before-SL, STOP-before-TP1, frequency retained vs V1.
          Хронологический TRAIN/VALIDATION/OOS через существующий experiment framework, OOS не для тюнинга.
          Регрессия сегодня 2026-09-13 08:15 SHORT 11:00 REARM — сравнение V1/V2, не оптимизировать под неё.
          Если -80% сигналов — серьёзный минус.
        </p>
        <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
          <button type="button" onClick={runResearch} style={{ padding: "8px 16px", borderRadius: 6, background: "#7c3aed", color: "#fff", border: "none" }}>
            RUN RESEARCH (только если безопасно, no auto на production)
          </button>
        </div>
        {researchResult && (
          <pre style={{ background: "#1f2937", color: "#e5e7eb", padding: 12, borderRadius: 8, overflow: "auto", maxHeight: 400, fontSize: 12 }}>{researchResult}</pre>
        )}
        <div style={{ marginTop: 12, fontSize: 13, color: "#6b7280" }}>
          V2-A: SMC+MARKET_STRUCTURE, V2-B: SMC+EMA, V2-C: SMC+HTF 1h, V2-D: SMC+COMBINED с политиками SCORE_BOOST/TIERING/HARD_ALIGNMENT — reasonable combos
        </div>
      </section>

      <div className="editorSaveBar">
        <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
          {message && <span>{message}</span>}
        </div>
        <button onClick={save} disabled={!canSave} title={!isDirty ? "Нет изменений" : errors.length ? errors[0] : (mode as string) === "LIVE" ? "LIVE запрещён" : ""}>
          {saving ? "Сохранение..." : "Сохранить V2 настройки"}
        </button>
      </div>
    </div>
  );
}
