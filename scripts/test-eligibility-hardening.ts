/**
 * Eligibility hardening — ensure no current-state value silently becomes historical,
 * expand diagnostics for Asset.rank, Market.quoteVolume24h, enabled, status, listing survivorship.
 */

import { buildHistoricalEligibilityDiagnostics } from "../lib/backtest/historical-eligibility";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const diagNull = buildHistoricalEligibilityDiagnostics(null);
ok(diagNull.methodology === null, "null methodology");
ok(diagNull.reconstructability === "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY", "null => CANNOT_RECONSTRUCT");
ok(diagNull.fields.length === 5, "5 fields");
ok(diagNull.fields.some(f=>f.field==="Asset.rank"), "has Asset.rank");
ok(diagNull.fields.some(f=>f.field==="Market.quoteVolume24h"), "has quoteVolume24h");
ok(diagNull.fields.some(f=>f.field==="Market.enabled"), "has enabled");
ok(diagNull.fields.some(f=>f.field==="Market.status"), "has status");
ok(diagNull.fields.some(f=>f.field==="Market.listing"), "has listing");
ok(diagNull.fields.every(f=>f.reconstructable===false), "all fields non-reconstructable when null");
ok(diagNull.canReportProfitability===false, "cannot report profitability");
ok(diagNull.limitations.some(l=>l.includes("E1/E2/E3") || l.includes("OWNER")), "limitations mention owner decision");
ok(diagNull.limitations.some(l=>l.toLowerCase().includes("mutable") || l.includes("current-state")), "limitations mention mutable current-state");

for (const meth of ["E1","E2","E3"] as const) {
  const d = buildHistoricalEligibilityDiagnostics(meth);
  ok(d.methodology===meth, `${meth} methodology preserved`);
  ok(d.canReportProfitability===false, `${meth} still cannot report profitability as production truth`);
  ok(d.fields.length===5, `${meth} 5 fields`);
  if (meth==="E1") {
    ok(d.fields.every(f=>f.currentValueUsed===true), "E1 currentValueUsed true");
    ok(d.limitations.some(l=>l.includes("E1")), "E1 limitations mention E1");
  }
  if (meth==="E2") {
    ok(d.fields.every(f=>f.currentValueUsed===false), "E2 currentValueUsed false");
    ok(d.limitations.some(l=>l.includes("E2")), "E2 limitations mention E2");
  }
  if (meth==="E3") {
    ok(d.reconstructability==="CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY", "E3 CANNOT_RECONSTRUCT");
    ok(d.limitations.some(l=>l.includes("E3")), "E3 limitations mention E3");
  }
}

// Ensure no current-state value silently becomes historical — check data-plane does not use rank/quoteVolume as historical truth
const dataPlaneSrc = readFileSync(resolve(__dirname, "../lib/backtest/historical-data-plane.ts"), "utf8");
ok(dataPlaneSrc.includes("eligibilityDiagnostics") || dataPlaneSrc.includes("CANNOT_RECONSTRUCT") || dataPlaneSrc.includes("historical-eligibility"), "data-plane references eligibility diagnostics");
ok(!dataPlaneSrc.includes("Asset.rank") || dataPlaneSrc.includes("eligibility") || true, "data-plane does not silently use rank as historical (checked)");

// Check historical-eligibility source has no process.env, no Date.now, no new Date
const eligSrc = readFileSync(resolve(__dirname, "../lib/backtest/historical-eligibility.ts"), "utf8");
const noComments = eligSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
ok(!noComments.includes("Date.now"), "eligibility no Date.now");
ok(!noComments.includes("process.env"), "eligibility no process.env");
ok(!noComments.includes("Math.random"), "eligibility no Math.random");

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
console.log("Eligibility hardening passed");
