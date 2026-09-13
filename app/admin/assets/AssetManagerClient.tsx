"use client";

import { useState } from "react";

type AssetRow = {
  id: number;
  symbol: string;
  name: string | null;
  rank: number | null;
  enabled: boolean;
  markets: { exchange: string; exchangeSymbol: string }[];
};

export default function AssetManagerClient({ initialAssets }: { initialAssets: AssetRow[] }) {
  const [assets, setAssets] = useState<AssetRow[]>(initialAssets);
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [rank, setRank] = useState("");
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  async function addCoin() {
    if (!symbol.trim()) {
      setMessage("Symbol required");
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch("/api/admin/assets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: symbol.trim(),
          name: name.trim() || undefined,
          rank: rank ? Number(rank) : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Failed to add coin");
        return;
      }
      setMessage(`✓ Added ${data.asset.symbol} — markets: ${data.marketsDiscovered.map((m: any) => `${m.exchange}:${m.exchangeSymbol}${m.created ? "(new)" : ""}`).join(", ")}`);
      setSymbol("");
      setName("");
      setRank("");
      // Refresh list
      const listRes = await fetch("/api/admin/assets");
      if (listRes.ok) {
        const list = await listRes.json();
        // Need to fetch with markets — for simplicity reload page data via API that includes markets
        window.location.reload();
      }
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  async function archiveCoin(sym: string) {
    if (!confirm(`Архивировать ${sym}? OHLCV/Signals/Outcomes сохранятся, soft delete.`)) return;
    setLoading(true);
    setMessage("");
    try {
      const res = await fetch(`/api/admin/assets?symbol=${encodeURIComponent(sym)}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) {
        setMessage(data.error || "Failed to archive");
        return;
      }
      setMessage(`✓ Archived ${sym}`);
      setAssets((cur) => cur.filter((a) => a.symbol !== sym));
    } catch (e) {
      setMessage(`Error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <section className="editorSection">
        <h2>Добавить монету</h2>
        <p className="sectionDescription">Symbol (обязательно), Name, Rank optional. Discovery markets BINANCE first, затем BYBIT/GATE/KUCOIN/BINGX.</p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "end" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Symbol</span>
            <input type="text" placeholder="BTC" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Name (optional)</span>
            <input type="text" placeholder="Bitcoin" value={name} onChange={(e) => setName(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db" }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>Rank (optional)</span>
            <input type="number" placeholder="51" value={rank} onChange={(e) => setRank(e.target.value)} style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #d1d5db", width: 100 }} />
          </label>
          <button onClick={addCoin} disabled={loading} style={{ padding: "8px 16px", borderRadius: 6, background: "#059669", color: "#fff", border: "none" }}>
            {loading ? "Добавление..." : "Добавить монету"}
          </button>
        </div>
        {message && <div style={{ marginTop: 12, fontSize: 13, color: message.startsWith("✓") ? "#059669" : "#dc2626" }}>{message}</div>}
      </section>

      <section className="editorSection" style={{ marginTop: 16 }}>
        <h2>TOP-50 и вручную добавленные (активные, не архивные)</h2>
        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Rank</th>
                <th>Symbol</th>
                <th>Name</th>
                <th>Enabled</th>
                <th>Markets (BINANCE first)</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id}>
                  <td>{a.rank ?? "—"}</td>
                  <td>{a.symbol}</td>
                  <td>{a.name || "—"}</td>
                  <td>{a.enabled ? "✓" : "—"}</td>
                  <td>{a.markets.map((m) => `${m.exchange}:${m.exchangeSymbol}`).join(", ") || "нет рынков"}</td>
                  <td>
                    <button onClick={() => archiveCoin(a.symbol)} style={{ fontSize: 12, padding: "4px 8px", borderRadius: 4, background: "#fef2f2", border: "1px solid #fca5a5" }}>
                      Архивировать (soft)
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          Архивация — soft delete, OHLCV/Signals/Outcomes сохраняются, не каскад. TOP-50 формируется из rank 1..50, не хардкод.
        </p>
      </section>
    </div>
  );
}
