/**
 * Hardening for pre-PnL — no hidden defaults, no PnL leakage, no DB writes, no Signal Engine.
 * No DB, no PnL, no Date.now(), no random, deterministic.
 */

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); }
}

import { readFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const backtestDir = resolve(__dirname, "../lib/backtest");

console.log("=== Hardening pre-PnL — no hidden defaults, no PnL leakage, no DB writes ===");

// 1. Check lib/backtest/*.ts has no forbidden tokens (same as engine isolation)
const files = readdirSync(backtestDir).filter((f) => f.endsWith(".ts"));
const FORBIDDEN = [
  "new Date",
  "Date.now",
  "Math.random",
  "process.env",
  "globalThis.process",
  "dynamic import",
  "require(",
  "eval(",
];

for (const file of files) {
  const src = readFileSync(resolve(backtestDir, file), "utf8");
  const noComments = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  for (const token of FORBIDDEN) {
    // Allow formatIsoUtc which uses Reflect.construct via utcDateFromMs, and Date.parse
    if (token === "new Date" && file === "timeframe.ts") {
      // timeframe.ts has utcDateFromMs which uses Reflect.construct Date — allowed, but check code not using new Date directly in new files
      // We already strip comments, so check if code contains new Date token
      // For timeframe.ts, it's allowed because it's base P2-B
      continue;
    }
    if (noComments.includes(token)) {
      // For new files, new Date is forbidden
      if (["execution-policy.ts", "ohlcv-provenance.ts", "pre-pnl-runner.ts", "splits-readiness.ts", "historical-data-plane.ts", "historical-eligibility.ts", "read-only-sql.ts", "smc-observation.ts"].includes(file)) {
        ok(false, `isolation: ${file} contains forbidden token ${token}`);
      }
    }
  }
}

// 2. Check execution-policy has no hidden defaults
import { EXECUTION_POLICY_NOT_APPROVED_DOC } from "../lib/backtest/execution-policy";
ok(Array.isArray(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults), "execution-policy forbiddenDefaults array");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("k=1"), "forbiddenDefaults includes k=1");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("k=2"), "forbiddenDefaults includes k=2");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("any k-grid"), "forbiddenDefaults includes any k-grid");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("ATR SL"), "forbiddenDefaults includes ATR SL");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("RR_min"), "forbiddenDefaults includes RR_min");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("timeoutBars"), "forbiddenDefaults includes timeoutBars");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("structural SL anchor"), "forbiddenDefaults includes structural SL anchor");

// 3. Check pre-pnl-runner has no PnL fields
const prePnlSrc = readFileSync(resolve(backtestDir, "pre-pnl-runner.ts"), "utf8");
const prePnlNoComments = prePnlSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
ok(!prePnlNoComments.includes("netPnl"), "pre-pnl-runner no netPnl in code");
ok(!prePnlNoComments.includes("profitFactor"), "pre-pnl-runner no profitFactor in code");
ok(!prePnlNoComments.includes("sharpe"), "pre-pnl-runner no sharpe in code (lowercase)");
ok(!prePnlNoComments.includes("winRate"), "pre-pnl-runner no winRate in code");
ok(prePnlSrc.includes("PRE_REGISTRATION_REQUIRED"), "pre-pnl-runner contains PRE_REGISTRATION_REQUIRED");
ok(prePnlSrc.includes("SMC-Direction Baseline"), "pre-pnl-runner contains truthful baseline");

// 4. Check historical-data-plane has no PnL
const planeSrc = readFileSync(resolve(backtestDir, "historical-data-plane.ts"), "utf8");
ok(planeSrc.includes("READ ONLY"), "historical-data-plane contains READ ONLY");
ok(planeSrc.includes("NO DB WRITES"), "historical-data-plane contains NO DB WRITES");
ok(planeSrc.includes("NO PNL"), "historical-data-plane contains NO PNL");

// 5. Check smc-observation reuses production evaluateSmc, no second algorithm
const smcObsSrc = readFileSync(resolve(backtestDir, "smc-observation.ts"), "utf8");
ok(smcObsSrc.includes("evaluateSmc"), "smc-observation uses evaluateSmc");
ok(smcObsSrc.includes("No SL/TP"), "smc-observation mentions No SL/TP");
ok(smcObsSrc.includes("RawSmcObservation"), "smc-observation defines RawSmcObservation");
ok(smcObsSrc.includes("hardMinimumBars"), "smc-observation mentions hardMinimumBars");
ok(smcObsSrc.includes("productionWindowBars"), "smc-observation mentions productionWindowBars");
ok(smcObsSrc.includes("computeCausalAsOf"), "smc-observation has causal clock");

// 6. Check read-only-sql allowlist
import { assertReadOnlySql, assertReadOnlyPrismaMethod } from "../lib/backtest/read-only-sql";
ok(assertReadOnlySql("SELECT * FROM Candle WHERE closed=true").ok, "read-only-sql SELECT allowed");
ok(!assertReadOnlySql("INSERT INTO Candle VALUES (1)").ok, "read-only-sql INSERT forbidden");
ok(!assertReadOnlySql("UPDATE Candle SET close=1").ok, "read-only-sql UPDATE forbidden");
ok(!assertReadOnlySql("DELETE FROM Candle").ok, "read-only-sql DELETE forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle FOR UPDATE").ok, "read-only-sql FOR UPDATE forbidden");
ok(!assertReadOnlySql("SELECT pg_advisory_lock(1)").ok, "read-only-sql pg_advisory_lock forbidden");
ok(!assertReadOnlySql("SELECT 1; DROP TABLE Candle").ok, "read-only-sql multi-statement forbidden");

// 7. Check splits-readiness OOS isolation flags
import { evaluateSplitsReadiness } from "../lib/backtest/splits-readiness";
const now = Date.parse("2024-01-01T00:00:00Z");
const H1 = 3600_000;
const splits = evaluateSplitsReadiness({
  assetSymbol: "BTC",
  timeframe: "1h",
  splits: [
    { name: "TRAIN", from: new Date(now), to: new Date(now + 20 * H1) },
    { name: "VALIDATION", from: new Date(now + 20 * H1), to: new Date(now + 30 * H1) },
    { name: "OOS", from: new Date(now + 30 * H1), to: new Date(now + 50 * H1) },
  ],
  availableTimestamps: Array.from({ length: 50 }, (_, i) => now + i * H1),
});
ok(splits.oosIsolation.oosDoesNotInfluenceSelection === true, "splits oosDoesNotInfluenceSelection true");
ok(splits.oosIsolation.oosIsFinalWitnessOnly === true, "splits oosIsFinalWitnessOnly true");
ok(splits.oosIsolation.selectionStages.length === 2, "splits selectionStages 2");
ok(splits.readOnly === true, "splits readOnly true");
ok(splits.noPnl === true, "splits noPnl true");

// 8. Check historical-eligibility CANNOT_RECONSTRUCT
import { buildHistoricalEligibilityDiagnostics } from "../lib/backtest/historical-eligibility";
const elig = buildHistoricalEligibilityDiagnostics(null);
ok(elig.reconstructability === "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY", "eligibility CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY");
ok(elig.fields.length === 5, "eligibility 5 fields");
ok(elig.limitations.some((l) => l.includes("CANNOT_RECONSTRUCT") || l.includes("rank") || l.includes("quoteVolume")), "eligibility limitations mention mutable fields");
ok(elig.methodology === null, "eligibility methodology null when unresolved");

// 9. Check ohlcv-provenance audit
import { computeOhlcvProvenanceDiagnostics } from "../lib/backtest/ohlcv-provenance";
const prov = computeOhlcvProvenanceDiagnostics([
  { marketId: 1, timeframe: "1h", openTime: new Date(now), open: 100, high: 110, low: 90, close: 105, volume: 1000, closed: true, createdAt: new Date(now), updatedAt: new Date(now + 1000) } as any,
]);
ok(prov.totalRows === 1, "provenance totalRows 1");
ok(prov.knownLimitations.length > 0, "provenance knownLimitations non-empty");
ok(prov.writePathAudits.some((a) => a.file.includes("lib/ohlcv/sync.ts")), "provenance writePathAudits mentions sync.ts");

// 10. Check admin UI truthful readiness (static file read)
const adminPath = resolve(__dirname, "../app/admin/backtests/page.tsx");
const adminSrc = readFileSync(adminPath, "utf8");
ok(adminSrc.includes("PRE_REGISTRATION_REQUIRED"), "admin UI contains PRE_REGISTRATION_REQUIRED");
ok(adminSrc.includes("SMC-Direction Baseline"), "admin UI truthful baseline");
ok(adminSrc.includes("CANNOT_RECONSTRUCT"), "admin UI CANNOT_RECONSTRUCT");
ok(adminSrc.includes("BINGX") && adminSrc.includes("1d"), "admin UI BINGX 1d exclusion");
ok(adminSrc.includes("READ ONLY") || adminSrc.includes("read-only") || adminSrc.includes("Без Prisma"), "admin UI mentions read-only / no Prisma");

console.log(`\nPassed ${passed}/${passed + failed}`);
if (failed > 0) {
  console.error(`Failed ${failed}`);
  process.exit(1);
}
console.log("All hardening pre-PnL checks passed");
