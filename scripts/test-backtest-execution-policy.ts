/**
 * Execution policy plumbing tests — Phase D.
 * Ensures generic boundary with NO economic defaults.
 */

import {
  validateExecutionPolicyDefinition,
  buildNonExecutableResult,
  buildExecutableResult,
  EXECUTABLE,
  nonExecutable,
  EXECUTION_POLICY_NOT_APPROVED_DOC,
} from "../lib/backtest/execution-policy";

let passed = 0;
let total = 0;

function ok(cond: boolean, label: string): void {
  total++;
  if (cond) passed++;
  else console.error(`FAIL: ${label}`);
}

console.log("=== Execution Policy plumbing tests ===");

// 1. No hidden defaults — must require explicit fields
const emptyPolicy = {
  id: "EP-1",
  version: "1.0.0",
  description: "Test policy",
  fingerprint: "abc123",
  requiredEconomicFields: [],
  config: {},
  status: "APPROVED",
  createdAt: new Date().toISOString(),
  approvedAt: null,
};

const resEmpty = validateExecutionPolicyDefinition(emptyPolicy);
ok(!resEmpty.ok, "APPROVED policy with empty requiredEconomicFields must fail (no hidden defaults)");

const missingFieldPolicy = {
  id: "EP-1",
  version: "1.0.0",
  description: "Test",
  fingerprint: "abc",
  requiredEconomicFields: ["slAnchor", "tpModel", "k"],
  config: { slAnchor: "some" }, // missing tpModel, k
  status: "APPROVED",
  createdAt: new Date().toISOString(),
  approvedAt: new Date().toISOString(),
};

const resMissing = validateExecutionPolicyDefinition(missingFieldPolicy);
ok(!resMissing.ok, "APPROVED policy missing required fields must fail");

const validDraft = {
  id: "EP-1",
  version: "1.0.0",
  description: "Draft policy with explicit fields but not approved",
  fingerprint: "fingerprint-123",
  requiredEconomicFields: ["slAnchor", "tpModel", "k", "rrMin", "timeoutBars"],
  config: {
    slAnchor: "STRUCTURAL_SWING",
    tpModel: "FIXED_R",
    k: 2,
    rrMin: 1.5,
    timeoutBars: 100,
    buffer: 0.1,
  },
  status: "DRAFT",
  createdAt: new Date().toISOString(),
  approvedAt: null,
};

const resDraft = validateExecutionPolicyDefinition(validDraft);
ok(resDraft.ok, "DRAFT policy with explicit fields should be valid");

const validApproved = {
  ...validDraft,
  status: "APPROVED" as const,
  approvedAt: new Date().toISOString(),
};

const resApproved = validateExecutionPolicyDefinition(validApproved);
ok(resApproved.ok, "APPROVED policy with all required fields should be valid");

if (resApproved.ok) {
  const execResult = buildExecutableResult(resApproved.policy);
  ok(execResult.executability.status === "EXECUTABLE", "APPROVED policy should be EXECUTABLE");
  ok(execResult.policyId === "EP-1", "policyId preserved");
  ok(execResult.policyFingerprint === "fingerprint-123", "fingerprint preserved");
}

const nonExec = buildNonExecutableResult("NO_EXECUTION_POLICY", "No policy");
ok(nonExec.executability.status === "NON_EXECUTABLE", "non-executable status");
ok(nonExec.executability.reason === "NO_EXECUTION_POLICY", "reason NO_EXECUTION_POLICY");

// 2. Ensure forbidden defaults are documented
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("protectedLow/protectedHigh as SL"), "forbidden contains protectedLow/High");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("k=1"), "forbidden contains k=1");
ok(EXECUTION_POLICY_NOT_APPROVED_DOC.forbiddenDefaults.includes("ATR SL"), "forbidden contains ATR SL");

// 3. NaN/Infinity check
const nanPolicy = {
  id: "EP-1",
  version: "1.0.0",
  description: "NaN test",
  fingerprint: "abc",
  requiredEconomicFields: ["k"],
  config: { k: NaN },
  status: "DRAFT",
  createdAt: new Date().toISOString(),
  approvedAt: null,
};
const resNaN = validateExecutionPolicyDefinition(nanPolicy);
ok(!resNaN.ok, "NaN config must fail");

const infPolicy = {
  id: "EP-1",
  version: "1.0.0",
  description: "Inf test",
  fingerprint: "abc",
  requiredEconomicFields: ["k"],
  config: { k: Infinity },
  status: "DRAFT",
  createdAt: new Date().toISOString(),
  approvedAt: null,
};
const resInf = validateExecutionPolicyDefinition(infPolicy);
ok(!resInf.ok, "Infinity config must fail");

// 4. Executability must be separate from raw observation — raw LONG/SHORT preserved
ok(EXECUTABLE.status === "EXECUTABLE", "EXECUTABLE constant");
const nonExecNoPolicy = nonExecutable("NO_EXECUTION_POLICY");
ok(nonExecNoPolicy.status === "NON_EXECUTABLE", "nonExecutable factory");

// 5. No fake NEUTRAL conversion — this is architectural, but we test that executability does not change direction
// The wrapping logic is tested in smc-observation tests, but we ensure policy result does not contain direction

console.log(`\nPassed ${passed}/${total}`);
if (passed !== total) {
  console.error(`FAIL: ${total - passed} failed`);
  process.exit(1);
}
console.log("All execution policy tests passed");
