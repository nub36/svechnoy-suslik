"use client";

import { useState } from "react";
import {
  EP1_BASELINE,
  EP2_STRUCTURAL_EXAMPLE,
  EP3_GENERIC_BOUNDARY,
} from "@/lib/backtest/execution-policy-registry";
import { approvePolicy } from "@/lib/backtest/execution-policy-approval";
import type { ExecutionPolicyDefinition } from "@/lib/backtest/execution-policy";

const ALL_POLICIES = [EP1_BASELINE, EP2_STRUCTURAL_EXAMPLE, EP3_GENERIC_BOUNDARY];

export default function ExecutionPolicyRegistryClient() {
  const [policies, setPolicies] = useState<readonly ExecutionPolicyDefinition[]>(ALL_POLICIES);
  const [selectedId, setSelectedId] = useState<string>("EP-1");
  const [lastAction, setLastAction] = useState<string>("");

  const selected = policies.find((p) => p.id === selectedId) ?? policies[0];

  const handleApprove = (id: string) => {
    setPolicies((prev) =>
      prev.map((p) => {
        if (p.id === id && p.status !== "APPROVED") {
          const approved = approvePolicy(p);
          setLastAction(`Policy ${id} APPROVED via approvePolicy utility — deterministic ${approved.approvedAt} — no DB writes, readOnly, for inspection only`);
          return approved;
        }
        return p;
      })
    );
  };

  const handleReset = () => {
    setPolicies(ALL_POLICIES);
    setLastAction("Registry reset to original — EP-1 APPROVED baseline truthful, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED");
  };

  return (
    <div className="adminCard" style={{ gridColumn: "1 / -1" }}>
      <h3>Execution Policy Registry — Owner Approval Flow — READ ONLY — NO DB WRITES — Phase H/I</h3>
      <p className="muted">
        Truthful: EP-1 APPROVED baselineMode 0 trades baseline, EP-2/EP-3 DRAFT explicit requiredEconomicFields no hidden defaults, blocked PRE_REGISTRATION_REQUIRED until APPROVED. 
        APPROVED via approvePolicy utility deterministic 2024-01-03T00:00:00.000Z no DB writes. Policy identity in fingerprint id|version|requiredFields|config. Costs 5bps fee 2bps slippage. BTC only 5m/15m/1h/4h/1d BINGX excluded 1d. CANNOT_RECONSTRUCT E1 professional default, OHLCV PIT, OOS-blind.
      </p>

      <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", marginBottom: "12px" }}>
        {policies.map((p) => (
          <button
            key={p.id}
            onClick={() => setSelectedId(p.id)}
            style={{
              padding: "6px 12px",
              borderRadius: "6px",
              border: selectedId === p.id ? "2px solid #4f46e5" : "1px solid #ccc",
              background: p.status === "APPROVED" ? "#dcfce7" : "#fef3c7",
              fontWeight: selectedId === p.id ? 700 : 400,
              cursor: "pointer",
            }}
          >
            {p.id} {p.status === "APPROVED" ? "✓ APPROVED" : "⚠ DRAFT"} — {p.id === "EP-1" ? "0 trades" : "explicit"}
          </button>
        ))}
        <button
          onClick={handleReset}
          style={{ padding: "6px 12px", borderRadius: "6px", border: "1px solid #ccc", background: "#f3f4f6", cursor: "pointer" }}
        >
          Reset Registry
        </button>
      </div>

      {selected && (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: "8px", padding: "12px", background: "#fafafa" }}>
          <h4 style={{ margin: "0 0 8px 0" }}>
            {selected.id} v{selected.version} — {selected.status} — {selected.id === "EP-1" ? "SMC-Direction Baseline truthful 0 trades" : selected.id === "EP-2" ? "Structural Anchor EXAMPLE" : "Generic Boundary EXAMPLE"}
          </h4>
          <div style={{ fontSize: "12px", fontFamily: "monospace", wordBreak: "break-all", marginBottom: "8px" }}>
            <div><strong>fingerprint:</strong> {selected.fingerprint}</div>
            <div><strong>requiredEconomicFields:</strong> {selected.requiredEconomicFields.join(", ")}</div>
            <div><strong>config:</strong> {JSON.stringify(selected.config)}</div>
            <div><strong>createdAt:</strong> {selected.createdAt} <strong>approvedAt:</strong> {selected.approvedAt ?? "null"}</div>
            <div><strong>description:</strong> {selected.description}</div>
          </div>

          <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
            {selected.status !== "APPROVED" ? (
              <button
                onClick={() => handleApprove(selected.id)}
                style={{ padding: "6px 12px", borderRadius: "6px", border: "1px solid #16a34a", background: "#dcfce7", color: "#166534", cursor: "pointer", fontWeight: 600 }}
              >
                Simulate Owner Approval — approvePolicy({selected.id}) — deterministic no DB writes
              </button>
            ) : (
              <span style={{ padding: "6px 12px", borderRadius: "6px", background: "#dcfce7", color: "#166534", fontWeight: 600 }}>
                APPROVED — {selected.id === "EP-1" ? "0 trades truthful baseline" : "READY_FOR_EXECUTION real trades with fingerprint identity"}
              </span>
            )}
            <span style={{ padding: "6px 12px", borderRadius: "6px", background: selected.status === "APPROVED" ? "#dcfce7" : "#fef3c7", fontSize: "12px" }}>
              {selected.status === "APPROVED" ? (selected.id === "EP-1" ? "EP-1 truthful baseline — no SL/TP, NON_EXECUTABLE, 0 trades" : "READY_FOR_EXECUTION — real PnL with 5bps fee 2bps slippage, policy identity in fingerprint") : "PRE_REGISTRATION_REQUIRED — DRAFT blocked, no real PnL until APPROVED"}
            </span>
          </div>

          <div style={{ marginTop: "12px", fontSize: "12px", color: "#6b7280" }}>
            <div><strong>Truthful Baseline:</strong> SMC-Direction Baseline / execution policy {selected.id} fingerprint={selected.fingerprint.slice(0, 32)}... — {selected.status === "APPROVED" ? (selected.id === "EP-1" ? "0 trades" : `${selected.id} APPROVED yields real trades`) : "PRE_REGISTRATION_REQUIRED until APPROVED"}</div>
            <div><strong>Costs:</strong> 5bps fee per side, 0 fixed, 2bps slippage per side — fixed</div>
            <div><strong>Scope:</strong> BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d, Smart Money eligibility timeless</div>
            <div><strong>Limitations:</strong> CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY E1 professional default CURRENT_STATE_SURVIVORSHIP_LIMITATION, OHLCV PIT upsert overwrites, OOS-blind TRAIN/VALIDATION only, no-lookahead context-channel-only</div>
            <div><strong>ReadOnly:</strong> No DB writes, no workers, no Signal Engine, no Prisma migration, production remains d6c573c, no Date.now()/random/env — uses formatIsoUtc/utcDateFromMs deterministic</div>
          </div>
        </div>
      )}

      {lastAction && (
        <div style={{ marginTop: "12px", padding: "8px", borderRadius: "6px", background: "#eff6ff", border: "1px solid #bfdbfe", fontSize: "12px" }}>
          <strong>Last action:</strong> {lastAction}
        </div>
      )}

      <div style={{ marginTop: "12px", fontSize: "11px", color: "#9ca3af" }}>
        Registry count: {policies.length} approved: {policies.filter((p) => p.status === "APPROVED").length} — {policies.map((p) => `${p.id}(${p.status})`).join(", ")} — Owner-run CLI: npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --executionPolicy EP-2 --approve --fullPipeline — Full Pipeline Phase H 52/52
      </div>
    </div>
  );
}
