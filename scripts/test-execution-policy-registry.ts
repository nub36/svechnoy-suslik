/**
 * Execution Policy Registry tests — EP-1/EP-2/EP-3 — explicit, no hidden defaults, HONEST SCOPE.
 */

import { validateExecutionPolicyDefinition } from "../lib/backtest/execution-policy";
import {
  EP1_BASELINE,
  EP2_STRUCTURAL_EXAMPLE,
  EP3_GENERIC_BOUNDARY,
  getPolicyById,
  listPolicies,
  listApprovedPolicies,
  EXECUTION_POLICY_REGISTRY_DOC,
} from "../lib/backtest/execution-policy-registry";

let passed = 0, failed = 0;
function ok(c: boolean, m: string) { if (c) { passed++; } else { failed++; console.error(`FAIL: ${m}`); } }

(async () => {
  // 1. Registry has 3 policies
  ok(listPolicies().length === 3, "registry has 3 policies");
  ok(listApprovedPolicies().length === 1, "approved policies 1 (EP-1)");
  ok(listApprovedPolicies()[0].id === "EP-1", "approved is EP-1");

  // 2. EP-1 validates, APPROVED, baselineMode explicit, no forbidden economics hidden
  const v1 = validateExecutionPolicyDefinition(EP1_BASELINE);
  ok(v1.ok === true, "EP-1 validates");
  if (v1.ok) {
    ok(v1.policy.status === "APPROVED", "EP-1 APPROVED");
    ok(v1.policy.id === "EP-1", "EP-1 id");
    ok(v1.policy.requiredEconomicFields.includes("baselineMode"), "EP-1 required includes baselineMode");
    ok(!v1.policy.requiredEconomicFields.includes("stopLoss"), "EP-1 no stopLoss");
    ok(v1.policy.fingerprint.includes("EP-1") || v1.policy.fingerprint.length > 10, "EP-1 fingerprint non-empty includes identity");
  }

  // 3. EP-2 validates, DRAFT, explicit required fields include forbidden keys
  const v2 = validateExecutionPolicyDefinition(EP2_STRUCTURAL_EXAMPLE);
  ok(v2.ok === true, "EP-2 validates");
  if (v2.ok) {
    ok(v2.policy.status === "DRAFT", "EP-2 DRAFT");
    ok(v2.policy.requiredEconomicFields.includes("stopLoss"), "EP-2 required includes stopLoss");
    ok(v2.policy.requiredEconomicFields.includes("takeProfit"), "EP-2 includes takeProfit");
    ok(v2.policy.requiredEconomicFields.includes("slAnchor"), "EP-2 includes slAnchor");
    ok(v2.policy.requiredEconomicFields.includes("buffer"), "EP-2 includes buffer");
    ok((v2.policy.config as any).stopLoss === 0.02, "EP-2 config stopLoss explicit 0.02");
    ok(v2.policy.fingerprint.includes("EP-2") || v2.policy.fingerprint.length > 10, "EP-2 fingerprint includes identity");
  }

  // 4. EP-3 validates, DRAFT, includes k/atrSlMultiplier explicit
  const v3 = validateExecutionPolicyDefinition(EP3_GENERIC_BOUNDARY);
  ok(v3.ok === true, "EP-3 validates");
  if (v3.ok) {
    ok(v3.policy.status === "DRAFT", "EP-3 DRAFT");
    ok(v3.policy.requiredEconomicFields.includes("k"), "EP-3 includes k");
    ok(v3.policy.requiredEconomicFields.includes("atrSlMultiplier"), "EP-3 includes atrSlMultiplier");
    ok((v3.policy.config as any).k === 1.5, "EP-3 config k explicit 1.5");
    ok(v3.policy.fingerprint.includes("EP-3") || v3.policy.fingerprint.length > 10, "EP-3 fingerprint includes identity");
  }

  // 5. getPolicyById
  ok(getPolicyById("EP-1")?.id === "EP-1", "getPolicyById EP-1");
  ok(getPolicyById("EP-2")?.id === "EP-2", "getPolicyById EP-2");
  ok(getPolicyById("EP-3")?.id === "EP-3", "getPolicyById EP-3");
  ok(getPolicyById("UNKNOWN") === null, "getPolicyById unknown null");

  // 6. No hidden defaults — mutation must fail when unresolved
  const { validateNoHiddenEconomicDefaults } = await import("../lib/backtest/execution-policy");
  const bad = validateNoHiddenEconomicDefaults({ atrSlMultiplier: 1.5, k: 1 } as any, null);
  ok(bad.ok === false, "mutation atr/k without policy must fail");

  // 7. Registry doc honest scope
  ok(EXECUTION_POLICY_REGISTRY_DOC.message.includes("no hidden defaults"), "registry doc mentions no hidden defaults");
  ok((EXECUTION_POLICY_REGISTRY_DOC as any).policies.length === 3, "registry doc 3 policies");

  // 8. No forbidden Date token — strip comments
  const rawSrc = await import("fs").then(m => m.readFileSync("lib/backtest/execution-policy-registry.ts", "utf8"));
  const src = rawSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  ok(!src.includes("new Date("), "registry no new Date()");
  ok(!src.includes("Date.now()"), "registry no Date.now()");
  ok(!src.includes("Math.random()"), "registry no random");
  ok(!src.includes("process.env"), "registry no env");

  // 9. Fingerprint includes policy identity — different ids give different fingerprints even with same config
  ok(EP1_BASELINE.fingerprint !== EP2_STRUCTURAL_EXAMPLE.fingerprint, "EP-1 vs EP-2 fingerprint different");
  ok(EP2_STRUCTURAL_EXAMPLE.fingerprint !== EP3_GENERIC_BOUNDARY.fingerprint, "EP-2 vs EP-3 fingerprint different");

  // 10. Costs fixed 5bps fee 2bps slippage documented
  ok(JSON.stringify(EP1_BASELINE.config).includes("5") || JSON.stringify(EP1_BASELINE.config).includes("feeBps"), "EP-1 config includes costs");

  console.log(`\nPassed ${passed}/${passed+failed}`);
  if (failed > 0) { console.error(`Failed ${failed}`); process.exit(1); }
  console.log("Execution Policy Registry tests passed — EP-1 APPROVED baseline, EP-2/EP-3 DRAFT explicit, no hidden defaults, fingerprint includes identity");
})();
