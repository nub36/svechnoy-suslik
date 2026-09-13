"use client";

import { useState } from "react";

type ConfigRow = {
  exchange: string;
  publicEnabled: boolean;
  ohlcvEnabled: boolean;
  liveEnabled: boolean;
  isDefault: boolean;
  priority: number;
};

export default function ExchangeManagerClient({ initialConfigs }: { initialConfigs: ConfigRow[] }) {
  const [configs, setConfigs] = useState<ConfigRow[]>(initialConfigs);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState<string | null>(null);

  async function updateConfig(exchange: string, patch: Partial<ConfigRow>) {
    setLoading(exchange);
    setMessage("");
    try {
      const res = await fetch("/api/admin/exchanges", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ exchange, ...patch }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Failed to update");
        return;
      }
      setConfigs((cur) => {
        let next = cur.map((c) => (c.exchange === exchange ? { ...c, ...data } : c));
        // If isDefault set, clear others
        if (patch.isDefault) {
          next = next.map((c) => (c.exchange === exchange ? c : { ...c, isDefault: false }));
        }
        return next;
      });
      setMessage(`✓ Updated ${exchange}: ${Object.keys(patch).join(", ")}`);
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div>
      <section className="editorSection">
        <h2>Конфигурация бирж</h2>
        <p className="sectionDescription">
          BINANCE Default true. Public disable не ломает BTC V1 (5 exchanges quorum 3/5). V1 работает как baseline production.
          V2 исследует новую strategy-confirmation model. Не смешивать эти настройки.
        </p>
        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Биржа</th>
                <th>Public Enabled</th>
                <th>OHLCV Enabled</th>
                <th>Live Enabled</th>
                <th>Default</th>
                <th>Priority</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {configs.map((c) => (
                <tr key={c.exchange}>
                  <td>
                    <b>{c.exchange}</b> {c.isDefault ? "(Default)" : ""}
                  </td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={c.publicEnabled}
                        onChange={(e) => updateConfig(c.exchange, { publicEnabled: e.target.checked })}
                        disabled={loading === c.exchange}
                      />
                      {c.publicEnabled ? "✓" : "—"}
                    </label>
                  </td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={c.ohlcvEnabled}
                        onChange={(e) => updateConfig(c.exchange, { ohlcvEnabled: e.target.checked })}
                        disabled={loading === c.exchange}
                      />
                      {c.ohlcvEnabled ? "✓" : "—"}
                    </label>
                  </td>
                  <td>
                    <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      <input
                        type="checkbox"
                        checked={c.liveEnabled}
                        onChange={(e) => updateConfig(c.exchange, { liveEnabled: e.target.checked })}
                        disabled={loading === c.exchange}
                      />
                      {c.liveEnabled ? "✓" : "—"}
                    </label>
                  </td>
                  <td>
                    <button
                      onClick={() => updateConfig(c.exchange, { isDefault: true })}
                      disabled={c.isDefault || loading === c.exchange}
                      style={{
                        padding: "4px 8px",
                        borderRadius: 4,
                        background: c.isDefault ? "#dcfce7" : "#fff",
                        border: "1px solid #d1d5db",
                        fontSize: 12,
                      }}
                    >
                      {c.isDefault ? "Default ✓" : "Set Default"}
                    </button>
                  </td>
                  <td>
                    <input
                      type="number"
                      value={c.priority}
                      onChange={(e) => updateConfig(c.exchange, { priority: Number(e.target.value) })}
                      style={{ width: 60, padding: "4px 6px", borderRadius: 4, border: "1px solid #d1d5db" }}
                      disabled={loading === c.exchange}
                    />
                  </td>
                  <td>{loading === c.exchange ? "Сохранение..." : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {message && <div style={{ marginTop: 12, fontSize: 13, color: message.startsWith("✓") ? "#059669" : "#dc2626" }}>{message}</div>}
        <div style={{ marginTop: 12, fontSize: 12, color: "#6b7280" }}>
          <p>BINANCE Default true priority 100, BYBIT 90, GATE 80, KUCOIN 70, BINGX 60. Public disable — fallback по priority на публичном сайте, не ломает BTC V1.</p>
          <p>BTC V1 пока использует: 5 exchanges quorum 3/5 — ОСТАВИТЬ. V1 baseline production. V2 — новая strategy-confirmation model.</p>
        </div>
      </section>

      <section className="editorSection" style={{ marginTop: 16, background: "#f0fdf4", border: "1px solid #bbf7d0" }}>
        <h2>Проверка BTC V1</h2>
        <p style={{ fontSize: 13 }}>
          BTC V1: 5 exchanges quorum 3/5. Public выключение биржи не должно ломать V1. V1 использует Market.enabled, не ExchangeConfig.publicEnabled.
          OHLCV Enabled — для OHLCV worker, Live Enabled — для live WS.
        </p>
        <div style={{ background: "#fff", border: "1px solid #e5e7eb", padding: 12, borderRadius: 8, marginTop: 8 }}>
          <small>
            Текущий дефолт: {configs.find((c) => c.isDefault)?.exchange || "BINANCE"} • Public enabled: {configs.filter((c) => c.publicEnabled).map((c) => c.exchange).join(", ")} • OHLCV enabled:{" "}
            {configs.filter((c) => c.ohlcvEnabled).map((c) => c.exchange).join(", ")}
          </small>
        </div>
      </section>
    </div>
  );
}
