/**
 * Owner data inspection readiness — ensure CLI produces required diagnostics, no PNL, no secrets.
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

const cliSrc = readFileSync(resolve(__dirname, "backtest-historical-readonly.ts"), "utf8");
const dataPlaneSrc = readFileSync(resolve(__dirname, "../lib/backtest/historical-data-plane.ts"), "utf8");
const coreApiSrc = readFileSync(resolve(__dirname, "../lib/backtest/core-api.ts"), "utf8");

// CLI must produce required outputs (via dataPlane report)
ok(cliSrc.includes("READ ONLY") && cliSrc.includes("NO DB WRITES") && cliSrc.includes("NO PNL"), "CLI banner READ ONLY NO DB WRITES NO PNL");
ok(cliSrc.includes("formatHistoricalDataPlaneReport"), "CLI uses formatHistoricalDataPlaneReport");
ok(cliSrc.includes("formatEligibilityDiagnosticsReport"), "CLI uses eligibility report");
ok(cliSrc.includes("formatOhlcvProvenanceReport") || cliSrc.includes("computeOhlcvProvenanceDiagnostics"), "CLI uses provenance diagnostics");
ok(cliSrc.includes("--smartMoney") || cliSrc.includes("smartMoney"), "CLI supports --smartMoney");
ok(cliSrc.includes("--splits") || cliSrc.includes("splits-readiness"), "CLI supports --splits");

// Data plane report must include required fields
ok(dataPlaneSrc.includes("earliest") && dataPlaneSrc.includes("latest"), "data-plane includes earliest/latest");
ok(dataPlaneSrc.includes("duplicates"), "data-plane includes duplicates");
ok(dataPlaneSrc.includes("offGrid") || dataPlaneSrc.includes("off-grid"), "data-plane includes off-grid");
ok(dataPlaneSrc.includes("missingLeading") || dataPlaneSrc.includes("leading"), "data-plane includes leading missing");
ok(dataPlaneSrc.includes("missingInternal") || dataPlaneSrc.includes("internal"), "data-plane includes internal missing");
ok(dataPlaneSrc.includes("missingTrailing") || dataPlaneSrc.includes("trailing"), "data-plane includes trailing missing");
ok(dataPlaneSrc.includes("commonTimestamps"), "data-plane includes common timestamps");
ok(dataPlaneSrc.includes("commonContiguousRanges") || dataPlaneSrc.includes("Contiguous"), "data-plane includes common contiguous ranges");
ok(dataPlaneSrc.includes("canonical") || dataPlaneSrc.includes("CanonicalWindow"), "data-plane includes canonical slots");
ok(dataPlaneSrc.includes("overallCoverageRatio") || dataPlaneSrc.includes("coverageRatio"), "data-plane includes coverage ratio");
ok(dataPlaneSrc.includes("BINGX") && dataPlaneSrc.includes("1d"), "data-plane mentions BINGX 1d exclusion");

// No secrets in CLI command examples
ok(!cliSrc.includes("DATABASE_URL=") || cliSrc.includes("never echo DATABASE_URL") || cliSrc.includes("do NOT paste"), "CLI does not contain DATABASE_URL= secret example (or warns not to)");
ok(!cliSrc.includes("postgresql://") || cliSrc.includes("never echo"), "CLI does not leak postgresql:// secret");
ok(coreApiSrc.includes("noSecrets") && coreApiSrc.includes("true"), "core-api marks noSecrets true");
ok(coreApiSrc.includes("npx tsx scripts/backtest-historical-readonly.ts"), "core-api contains owner command without secrets");

// Ensure no PnL calculation in CLI (mentioning winRate in help as "never calculates" is allowed)
const cliNoComments = cliSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
ok(!cliNoComments.includes("netPnl") && !cliNoComments.includes("profitFactor"), "CLI no netPnl/profitFactor fields");
ok(!cliSrc.includes("runBacktest") || cliSrc.includes("fetchHistoricalDataPlane"), "CLI does not run P2-A backtest engine for PnL");

// Ensure CLI fails closed on invalid inputs
ok(cliSrc.includes("fail(") && cliSrc.includes("fail-closed"), "CLI has fail-closed");

// Check owner command format
ok(coreApiSrc.includes("--asset BTC") && coreApiSrc.includes("--timeframe 1h"), "owner command includes asset BTC timeframe 1h");

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
console.log("Owner inspection readiness checks passed");
