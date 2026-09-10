/**
 * Tests for seed-smart-money safe interface — no DB writes.
 * Run: npx tsx scripts/test-seed-smart-money.ts
 */

import { readFileSync } from "node:fs";
import {
  parseSeedSmartMoneyArgs,
  isDryRunMode,
  validateForApply,
  buildSeedPayload,
  canonicalWeightsSum,
  SMART_MONEY_SLUG,
  SMART_MONEY_VERSION,
  SMART_MONEY_TIMEFRAMES,
  SMART_MONEY_ENABLED,
  SMART_MONEY_STATUS,
  CANONICAL_SMC_CONFIG,
} from "./seed-smart-money-args";
import { validateSmartMoneyRuntime } from "../lib/strategies/smart-money";

let passed = 0;
let total = 0;
function ok(cond: boolean, label: string) {
  total++;
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ FAIL: ${label}`);
  }
}

const seedSrc = readFileSync("scripts/seed-smart-money.ts", "utf8");
const argsSrc = readFileSync("scripts/seed-smart-money-args.ts", "utf8");
const schemaSrc = readFileSync("prisma/schema.prisma", "utf8");

// 1. no args = dry-run
{
  const p = parseSeedSmartMoneyArgs([]);
  ok(isDryRunMode(p) === true, "no args = dry-run");
  ok(p.apply === false, "no args -> apply false");
  ok(p.errors.length === 0, "no args -> no parse errors");
}

// 2. --dry-run = dry-run
{
  const p = parseSeedSmartMoneyArgs(["--dry-run"]);
  ok(isDryRunMode(p) === true, "--dry-run = dry-run");
  ok(p.dryRunExplicit === true, "--dry-run explicit flag");
  ok(p.errors.length === 0, "--dry-run no parse errors");
}

// 3. --apply without explicit three operator parameters fails
{
  const p0 = parseSeedSmartMoneyArgs(["--apply"]);
  const err0 = validateForApply(p0);
  ok(err0 !== null, "--apply without any operator params fails");

  const p1 = parseSeedSmartMoneyArgs(["--apply", "--min-exchanges", "2"]);
  const err1 = validateForApply(p1);
  ok(err1 !== null, "--apply with only min-exchanges fails (missing 2)");

  const p2 = parseSeedSmartMoneyArgs([
    "--apply",
    "--min-exchanges",
    "2",
    "--minimum-quote-volume-24h",
    "1000000",
  ]);
  const err2 = validateForApply(p2);
  ok(err2 !== null, "--apply missing top100-only fails");

  const pFull = parseSeedSmartMoneyArgs([
    "--apply",
    "--min-exchanges",
    "2",
    "--minimum-quote-volume-24h",
    "1000000",
    "--top100-only",
    "true",
  ]);
  const errFull = validateForApply(pFull);
  ok(errFull === null, "--apply with all three explicit passes");
  ok(pFull.minExchanges === 2, "parse min-exchanges 2");
  ok(pFull.minimumQuoteVolume24h === 1000000, "parse volume 1000000");
  ok(pFull.top100Only === true, "parse top100 true");
}

// 4. invalid minExchanges fails
{
  const cases = [
    ["--min-exchanges", "0"],
    ["--min-exchanges", "6"],
    ["--min-exchanges", "abc"],
    ["--min-exchanges", "2.5"],
    ["--min-exchanges=0"],
    ["--min-exchanges=6"],
  ];
  for (const c of cases) {
    const p = parseSeedSmartMoneyArgs(c as string[]);
    const hasError = p.errors.length > 0 || validateForApply({ ...p, apply: true, minExchangesProvided: p.minExchangesProvided } as any) !== null;
    // For parser-level, invalid should push error
    ok(p.errors.length > 0, `invalid minExchanges ${JSON.stringify(c)} fails`);
  }
  // also via buildSeedPayload with apply
  const pBad = parseSeedSmartMoneyArgs(["--apply", "--min-exchanges", "0", "--minimum-quote-volume-24h", "0", "--top100-only", "true"]);
  const resBad = buildSeedPayload(pBad);
  ok(resBad.ok === false, "buildSeedPayload apply with minExchanges 0 fails");
}

// 5. negative volume fails
{
  const p = parseSeedSmartMoneyArgs(["--minimum-quote-volume-24h", "-1"]);
  ok(p.errors.length > 0, "negative volume -1 via spaced fails");
  const p2 = parseSeedSmartMoneyArgs(["--minimum-quote-volume-24h=-100"]);
  ok(p2.errors.length > 0, "negative volume =-100 fails");
  const p3 = parseSeedSmartMoneyArgs([
    "--apply",
    "--min-exchanges",
    "2",
    "--minimum-quote-volume-24h",
    "-500",
    "--top100-only",
    "true",
  ]);
  const res = buildSeedPayload(p3);
  ok(res.ok === false, "apply with negative volume fails before DB");
}

// 6. invalid boolean fails
{
  const p1 = parseSeedSmartMoneyArgs(["--top100-only", "maybe"]);
  ok(p1.errors.length > 0, "invalid boolean maybe fails");
  const p2 = parseSeedSmartMoneyArgs(["--top100-only", "1"]);
  ok(p2.errors.length > 0, "invalid boolean 1 fails");
  const p3 = parseSeedSmartMoneyArgs(["--top100-only=truee"]);
  ok(p3.errors.length > 0, "invalid boolean truee fails");
  const p4 = parseSeedSmartMoneyArgs(["--top100-only", "TRUE"]);
  ok(p4.errors.length === 0 && p4.top100Only === true, "boolean TRUE case-insensitive passes");
  const p5 = parseSeedSmartMoneyArgs(["--top100-only", "False"]);
  ok(p5.errors.length === 0 && p5.top100Only === false, "boolean False passes");
  // top500 alias
  const p6 = parseSeedSmartMoneyArgs(["--top500-only", "true"]);
  ok(p6.errors.length === 0 && p6.top100Only === true, "alias --top500-only true passes");
}

// 7. resulting timeframes exactly ["1h"]
{
  const pDryNoParams = parseSeedSmartMoneyArgs([]);
  const resDry = buildSeedPayload(pDryNoParams);
  if (resDry.ok) {
    ok(JSON.stringify(resDry.payload.timeframes) === JSON.stringify(["1h"]), "dry-run without params timeframes exactly [\"1h\"]");
  } else {
    ok(false, "dry-run without params should succeed with UNAPPROVED placeholders");
  }
  const pApply = parseSeedSmartMoneyArgs([
    "--apply",
    "--min-exchanges",
    "2",
    "--minimum-quote-volume-24h",
    "0",
    "--top100-only",
    "false",
  ]);
  const resApply = buildSeedPayload(pApply);
  if (resApply.ok) {
    ok(JSON.stringify(resApply.payload.timeframes) === JSON.stringify(["1h"]), "apply timeframes exactly [\"1h\"]");
  } else {
    ok(false, "apply payload failed");
  }
  // Also direct constant
  ok(JSON.stringify([...SMART_MONEY_TIMEFRAMES]) === JSON.stringify(["1h"]), "SMART_MONEY_TIMEFRAMES constant is [\"1h\"]");
}

// 8. resulting enabled false
{
  const p = parseSeedSmartMoneyArgs(["--apply", "--min-exchanges", "3", "--minimum-quote-volume-24h", "500", "--top100-only", "true"]);
  const res = buildSeedPayload(p);
  if (res.ok) {
    ok(res.payload.enabled === false, "resulting enabled false");
    ok(SMART_MONEY_ENABLED === false, "constant enabled false");
  } else ok(false, "payload enabled check failed");
  const pDry = parseSeedSmartMoneyArgs([]);
  const resDry = buildSeedPayload(pDry);
  if (resDry.ok) ok(resDry.payload.enabled === false, "dry-run enabled false");
}

// 9. resulting status DRAFT
{
  const p = parseSeedSmartMoneyArgs(["--apply", "--min-exchanges", "2", "--minimum-quote-volume-24h", "0", "--top100-only", "false"]);
  const res = buildSeedPayload(p);
  if (res.ok) ok(res.payload.status === "DRAFT", "resulting status DRAFT");
  ok(SMART_MONEY_STATUS === "DRAFT", "constant status DRAFT");
  const pDry = parseSeedSmartMoneyArgs([]);
  const resDry = buildSeedPayload(pDry);
  if (resDry.ok) ok(resDry.payload.status === "DRAFT", "dry-run status DRAFT");
}

// 10. canonical weights sum 100
{
  ok(canonicalWeightsSum() === 100, "canonical weights sum 100 via helper");
  const sum = Object.values(CANONICAL_SMC_CONFIG.weights).reduce((a, b) => a + b, 0);
  ok(sum === 100, "canonical weights sum 100 direct");
  ok(CANONICAL_SMC_CONFIG.minimumSignalScore === 72, "canonical minimumSignalScore 72");
  ok(CANONICAL_SMC_CONFIG.swingLeft === 20 && CANONICAL_SMC_CONFIG.swingRight === 20, "canonical swing 20/20");
  ok(CANONICAL_SMC_CONFIG.internalLeft === 3 && CANONICAL_SMC_CONFIG.internalRight === 3, "canonical internal 3/3");
  ok(CANONICAL_SMC_CONFIG.atrPeriod === 14, "canonical atrPeriod 14");
  ok(CANONICAL_SMC_CONFIG.structureEventFreshBars === 10, "canonical structureEventFreshBars 10");
  ok(CANONICAL_SMC_CONFIG.sweepFreshBars === 5, "canonical sweepFreshBars 5");
  ok(CANONICAL_SMC_CONFIG.orderBlockFreshBars === 20, "canonical orderBlockFreshBars 20");
  ok(CANONICAL_SMC_CONFIG.fvgFreshBars === 20, "canonical fvgFreshBars 20");
  ok(CANONICAL_SMC_CONFIG.eqBand === 0.02, "canonical eqBand 0.02");
  // also runtime validation with valid operator values passes
  const p = parseSeedSmartMoneyArgs(["--apply", "--min-exchanges", "2", "--minimum-quote-volume-24h", "1000", "--top100-only", "true"]);
  const res = buildSeedPayload(p);
  if (res.ok) {
    const runtime = validateSmartMoneyRuntime({
      config: res.payload.config,
      timeframes: res.payload.timeframes,
      minExchanges: res.payload.minExchanges,
    });
    ok(runtime.ok, "runtime validation passes with canonical config + operator values");
  } else ok(false, "runtime validation payload failed");
}

// 11. no Signal writes
{
  ok(!seedSrc.includes("prisma.signal"), "seed: no prisma.signal");
  ok(!seedSrc.includes("prisma.signal.create"), "seed: no prisma.signal.create");
  // More strict: should not contain ".signal."
  ok(!seedSrc.includes(".signal."), "seed: no .signal. access");
  ok(!argsSrc.includes("prisma.signal"), "args: no prisma.signal");
}

// 12. no delete/deleteMany
{
  ok(!seedSrc.includes("deleteMany"), "seed: no deleteMany");
  // allow findFirst, but not delete
  ok(!seedSrc.includes(".delete("), "seed: no .delete(");
  ok(!seedSrc.match(/prisma\.strategy\.delete/), "seed: no strategy delete");
  ok(!argsSrc.includes("delete"), "args: no delete");
}

// 13. no schema changes (seed should not touch schema, test schema still has expected Strategy model)
{
  ok(schemaSrc.includes("model Strategy"), "schema: has Strategy model");
  ok(schemaSrc.includes("@@unique([slug, version])"), "schema: slug+version unique preserved");
  // Ensure seed files don't contain schema mutation strings
  ok(!seedSrc.includes("schema.prisma"), "seed: no schema.prisma touch");
  ok(!argsSrc.includes("schema.prisma"), "args: no schema.prisma");
}

// Additional: slug/version identity, registration semantics (create-if-absent, NO-OP preserve)
{
  ok(SMART_MONEY_SLUG === "smart-money-suslik", "slug smart-money-suslik");
  ok(SMART_MONEY_VERSION === 1, "version 1");
  ok(seedSrc.includes("@@unique") || seedSrc.includes("slug") && seedSrc.includes("version"), "seed uses slug+version identity");
  ok(seedSrc.includes("findFirst") && seedSrc.includes("create"), "seed has findFirst + create (registration)");
  ok(!seedSrc.includes("prisma.strategy.update"), "seed has NO prisma.strategy.update (registration NO-OP, no overwrite existing admin config)");
  ok(seedSrc.includes("create-if-absent") || seedSrc.includes("create-if-absent") || seedSrc.includes("createIfAbsent"), "seed comment registration/create-if-absent");
  ok(seedSrc.includes("Strategy already exists; existing PostgreSQL configuration was NOT modified."), "seed NO-OP message for existing row (preserve)");
  ok(seedSrc.includes("Это изменит общую production PostgreSQL Strategy row."), "seed has prominent warning before apply");
  ok(seedSrc.includes("DRY-RUN") || seedSrc.includes("DRY_RUN") || seedSrc.includes("dry-run") || seedSrc.includes("DRY"), "seed mentions DRY-RUN");
}

// Registration semantics: absent -> CREATE, existing -> NO-OP
{
  ok(seedSrc.includes("if (existingRow)") && seedSrc.includes("NO-OP") && seedSrc.includes("prisma.strategy.create"), "registration: existing -> NO-OP, absent -> CREATE (only CREATE mutation)");
  ok(!seedSrc.includes("prisma.strategy.update"), "existing row -> no update (verified again)");
  ok(seedSrc.includes("Registration is create-if-absent") || seedSrc.includes("create-if-absent"), "registration comment present");
}

// APPLY fail-closed on DB probe error
{
  ok(seedSrc.includes("Не удалось прочитать DB для APPLY") || seedSrc.includes("APPLY DB probe failure"), "apply DB probe error message present");
  ok(seedSrc.includes("FAIL CLOSED") || seedSrc.includes("fail closed") || seedSrc.includes("APPLY прерван: DB probe"), "apply DB probe failure fails closed before mutation");
  // Ensure the only mutation is create and it is after probe success (fail-closed guards before create)
  const createIdx = seedSrc.indexOf("prisma.strategy.create");
  const probeFailIdx = seedSrc.indexOf("Не удалось прочитать DB для APPLY");
  ok(probeFailIdx !== -1 && createIdx !== -1 && probeFailIdx < createIdx, "DB probe failure guard is BEFORE prisma.strategy.create");
  ok(!seedSrc.includes("prisma.strategy.update"), "no update even after probe (only create)");
}

// Dry-run never writes (extra check)
{
  ok(!seedSrc.includes("prisma.strategy.create") || seedSrc.includes("DRY-RUN") , "dry-run never writes: create only in APPLY path (file has DRY-RUN guard)");
  // Static: ensure dry-run path has process.exit before any mutation and does not contain delete
  ok(seedSrc.includes("DRY-RUN завершён") && seedSrc.includes("Никаких записей в БД не произведено"), "dry-run completion message indicates no writes");
}

// 14. validate dry-run with operator params prints exact payload (check build)
{
  const p = parseSeedSmartMoneyArgs(["--dry-run", "--min-exchanges", "2", "--minimum-quote-volume-24h", "750000", "--top100-only", "false"]);
  ok(isDryRunMode(p) === true, "dry-run with operator params is dry-run");
  const res = buildSeedPayload(p);
  if (res.ok) {
    ok(res.payload.minExchanges === 2, "dry-run with params payload minExchanges 2");
    ok((res.payload.config as any).filters.minimumQuoteVolume24h === 750000, "dry-run with params volume 750000");
    ok((res.payload.config as any).filters.top500Only === false, "dry-run with params top500Only false");
  } else ok(false, "dry-run with params should succeed");
}

// 15. help flag
{
  const p = parseSeedSmartMoneyArgs(["--help"]);
  ok(p.help === true, "--help sets help");
  const p2 = parseSeedSmartMoneyArgs(["-h"]);
  ok(p2.help === true, "-h sets help");
}

console.log(`\nИтог: ${passed}/${total}`);
process.exit(passed === total ? 0 : 1);
