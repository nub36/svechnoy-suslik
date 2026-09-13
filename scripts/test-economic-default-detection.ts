/**
 * Economic default detection — mutation {atrSlMultiplier:1.5,k:1,rrMin:2,timeoutBars:24} must fail, no hidden defaults adopted.
 */

import { validateExecutionPolicyDefinition, validateNoHiddenEconomicDefaults, findUndeclaredEconomicFields } from "../lib/backtest/execution-policy";

let passed=0, failed=0;
function ok(c:boolean,m:string){ if(c)passed++; else{failed++; console.error(`FAIL: ${m}`);} }

// 1. Mutation with economic defaults when policy unresolved must fail
const mutation = { atrSlMultiplier: 1.5, k: 1, rrMin: 2, timeoutBars: 24 };
const resultNoPolicy = validateNoHiddenEconomicDefaults(mutation as any, null);
ok(resultNoPolicy.ok === false, "mutation {atrSlMultiplier,k,rrMin,timeoutBars} must fail when policy unresolved");
if (!resultNoPolicy.ok) {
  ok(resultNoPolicy.errors[0].includes("cannot appear") || resultNoPolicy.errors[0].includes("rejected") || resultNoPolicy.errors[0].includes("Economic"), "error mentions economic fields cannot appear");
}

// 2. Same mutation with APPROVED policy but not declared in requiredEconomicFields must fail
const fakeApprovedPolicy = {
  id: "EP-1",
  version: "1.0.0",
  description: "test",
  fingerprint: "fp",
  requiredEconomicFields: ["someOtherField"],
  config: mutation,
  status: "APPROVED" as const,
  createdAt: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
};
const resultApprovedUndeclared = validateNoHiddenEconomicDefaults(mutation as any, fakeApprovedPolicy as any);
ok(resultApprovedUndeclared.ok === false, "mutation with APPROVED policy but undeclared economic fields must fail");

// 3. When APPROVED and declared, should pass
const declaredPolicy = {
  id: "EP-1",
  version: "1.0.0",
  description: "test",
  fingerprint: "fp",
  requiredEconomicFields: ["atrSlMultiplier","k","rrMin","timeoutBars"],
  config: mutation,
  status: "APPROVED" as const,
  createdAt: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
};
const resultDeclared = validateNoHiddenEconomicDefaults(mutation as any, declaredPolicy as any);
ok(resultDeclared.ok === true, "mutation with APPROVED and declared fields should pass (explicit owner-approved)");

// 4. validateExecutionPolicyDefinition must reject undeclared economic fields
const rawPolicyUndeclared = {
  id: "EP-1",
  version: "1.0.0",
  description: "test",
  fingerprint: "fp",
  requiredEconomicFields: [], // empty, but config has economic fields
  config: { atrSlMultiplier: 1.5 },
  status: "DRAFT" as const,
  createdAt: new Date().toISOString(),
  approvedAt: null,
};
const valUndeclared = validateExecutionPolicyDefinition(rawPolicyUndeclared);
ok(valUndeclared.ok === false, "validateExecutionPolicyDefinition must reject config with undeclared economic fields");
if (!valUndeclared.ok) {
  ok(valUndeclared.errors.some(e=>e.includes("Economic fields") || e.includes("no hidden defaults")), "error mentions economic fields undeclared");
}

// 5. findUndeclaredEconomicFields detects all forbidden keys
const found = findUndeclaredEconomicFields(mutation as any, []);
ok(found.length === 4, `findUndeclaredEconomicFields finds 4 forbidden keys, got ${found.length}: ${found.join(",")}`);
ok(found.includes("atrSlMultiplier") && found.includes("k") && found.includes("rrMin") && found.includes("timeoutBars"), "finds all mutation keys");

// 6. Additional forbidden keys
const more = { stopLoss: 100, takeProfit: 200, structuralAnchor: "low", sl: 90, tp: 110 };
const foundMore = findUndeclaredEconomicFields(more as any, []);
ok(foundMore.length >= 3, `finds stopLoss/takeProfit/structuralAnchor, got ${foundMore.join(",")}`);
ok(validateNoHiddenEconomicDefaults(more as any, null).ok === false, "stopLoss/takeProfit/structuralAnchor must fail when unresolved");

// 7. Empty config should pass when no policy
ok(validateNoHiddenEconomicDefaults({} as any, null).ok === true, "empty config passes when no policy");
ok(validateNoHiddenEconomicDefaults(null, null).ok === true, "null config passes");

console.log(`\nPassed ${passed}/${passed+failed}`);
if (failed>0){ console.error(`Failed ${failed}`); process.exit(1); }
console.log("Economic default detection passed — no hidden defaults adopted, mutation killed");
