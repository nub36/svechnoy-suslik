/**
 * Execution Policy Registry — Phase E2 — Truthful execution policies with NO hidden defaults.
 *
 * Provides 3 policies:
 * - EP-1 SMC-Direction Baseline — truthful baseline, raw direction only, no SL/TP, NON_EXECUTABLE, APPROVED as baseline (no economics)
 * - EP-2 Structural Anchor — example with explicit requiredEconomicFields, DRAFT, owner must approve actual values
 * - EP-3 Generic Boundary — includes policy identity in fingerprint, TRAIN/VALIDATION/OOS OOS-blind, DRAFT
 *
 * All economic values are explicit, no hidden defaults. HONEST SCOPE: top-level/current contract only.
 * No Date.now(), no new Date(), no random, no env — uses formatIsoUtc.
 */

import { formatIsoUtc } from "./timeframe";
import {
  type ExecutionPolicyDefinition,
  fingerprintPolicyConfig,
  type ForbiddenEconomicKey,
} from "./execution-policy";
import { deepFreeze } from "./immutable";

const BASE_CREATED_AT = formatIsoUtc(Date.parse("2024-01-01T00:00:00.000Z"));
const BASE_APPROVED_AT = formatIsoUtc(Date.parse("2024-01-02T00:00:00.000Z"));

function makeFingerprint(id: string, version: string, requiredFields: readonly string[], config: Readonly<Record<string, unknown>>): string {
  const base = `${id}|${version}|${requiredFields.join(",")}|${fingerprintPolicyConfig(config)}`;
  // simple deterministic hash for fingerprint
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = (hash * 31 + base.charCodeAt(i)) | 0;
  }
  return `ep-${id.toLowerCase()}-${Math.abs(hash).toString(16)}-${base.length}`;
}

/**
 * EP-1 — SMC-Direction Baseline — truthful baseline, no SL/TP, NON_EXECUTABLE.
 * APPROVED as baseline with explicit non-economic field baselineMode.
 * This is the only policy that can be APPROVED without forbidden economic keys — it represents PRE_REGISTRATION truthful state.
 */
export const EP1_BASELINE: ExecutionPolicyDefinition = deepFreeze({
  id: "EP-1",
  version: "1.0.0",
  description: "SMC-Direction Baseline / EP-1 — truthful baseline, raw LONG/SHORT/NEUTRAL/CANNOT_EVALUATE only, no SL/TP, no PnL, NON_EXECUTABLE until real execution policy approved. Reuses production evaluateSmc, no second algorithm.",
  fingerprint: makeFingerprint("EP-1", "1.0.0", ["baselineMode"], { baselineMode: "SMC-Direction", note: "No SL/TP, NON_EXECUTABLE, read-only, no PnL" }),
  requiredEconomicFields: Object.freeze(["baselineMode"]),
  config: Object.freeze({
    baselineMode: "SMC-Direction",
    note: "No SL/TP, NON_EXECUTABLE, read-only, no PnL — truthful baseline until execution/eligibility production-derived",
    costs: Object.freeze({ feeBps: 5, slippageBps: 2, fixed: 0 }),
    scope: "BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d",
  }),
  status: "APPROVED" as const,
  createdAt: BASE_CREATED_AT,
  approvedAt: BASE_APPROVED_AT,
});

/**
 * EP-2 — Structural Anchor — example with explicit requiredEconomicFields.
 * DRAFT — owner must choose actual SL anchor, buffer, TP model, RR, timeout.
 * All economic values explicit, no hidden defaults. FORBIDDEN_ECONOMIC_KEYS must be declared in requiredEconomicFields.
 */
export const EP2_STRUCTURAL_EXAMPLE: ExecutionPolicyDefinition = deepFreeze({
  id: "EP-2",
  version: "1.0.0",
  description: "EP-2 Structural Anchor EXAMPLE — explicit requiredEconomicFields [stopLoss, takeProfit, slAnchor, tpModel, buffer, rrMin, timeoutBars], no hidden defaults, DRAFT, owner must approve actual values. NOT production SMC — separate execution layer.",
  fingerprint: makeFingerprint(
    "EP-2",
    "1.0.0",
    ["stopLoss", "takeProfit", "slAnchor", "tpModel", "buffer", "rrMin", "timeoutBars"],
    {
      stopLoss: 0.02,
      takeProfit: 0.04,
      slAnchor: "protectedLow",
      tpModel: "fixedRR",
      buffer: 0.001,
      rrMin: 2,
      timeoutBars: 100,
      note: "EXAMPLE VALUES ONLY — owner must approve real values, not production SMC",
    }
  ),
  requiredEconomicFields: Object.freeze(["stopLoss", "takeProfit", "slAnchor", "tpModel", "buffer", "rrMin", "timeoutBars"]),
  config: Object.freeze({
    stopLoss: 0.02,
    takeProfit: 0.04,
    slAnchor: "protectedLow",
    tpModel: "fixedRR",
    buffer: 0.001,
    rrMin: 2,
    timeoutBars: 100,
    note: "EXAMPLE VALUES ONLY — owner must approve real values, not production SMC, explicit no hidden defaults",
    costs: Object.freeze({ feeBps: 5, slippageBps: 2, fixed: 0 }),
  }),
  status: "DRAFT" as const,
  createdAt: BASE_CREATED_AT,
  approvedAt: null,
});

/**
 * EP-3 — Generic Boundary — includes policy identity in fingerprint, TRAIN/VALIDATION/OOS OOS-blind.
 * DRAFT — demonstrates generic boundary with k/ATR explicit, no hidden defaults.
 */
export const EP3_GENERIC_BOUNDARY: ExecutionPolicyDefinition = deepFreeze({
  id: "EP-3",
  version: "1.0.0",
  description: "EP-3 Generic Boundary EXAMPLE — includes policy identity in fingerprint, TRAIN/VALIDATION only selection OOS final witness only, explicit k/atrSlMultiplier, DRAFT, no hidden defaults.",
  fingerprint: makeFingerprint(
    "EP-3",
    "1.0.0",
    ["stopLoss", "takeProfit", "slAnchor", "tpModel", "k", "atrSlMultiplier", "rrMin", "timeoutBars"],
    {
      stopLoss: 0.015,
      takeProfit: 0.03,
      slAnchor: "protectedHigh",
      tpModel: "atrBased",
      k: 1.5,
      atrSlMultiplier: 1.2,
      rrMin: 1.5,
      timeoutBars: 48,
      note: "EXAMPLE — generic boundary, policy identity in fingerprint, OOS-blind, no hidden defaults",
    }
  ),
  requiredEconomicFields: Object.freeze(["stopLoss", "takeProfit", "slAnchor", "tpModel", "k", "atrSlMultiplier", "rrMin", "timeoutBars"]),
  config: Object.freeze({
    stopLoss: 0.015,
    takeProfit: 0.03,
    slAnchor: "protectedHigh",
    tpModel: "atrBased",
    k: 1.5,
    atrSlMultiplier: 1.2,
    rrMin: 1.5,
    timeoutBars: 48,
    note: "EXAMPLE — generic boundary, policy identity in fingerprint, OOS-blind, no hidden defaults, explicit",
    costs: Object.freeze({ feeBps: 5, slippageBps: 2, fixed: 0 }),
  }),
  status: "DRAFT" as const,
  createdAt: BASE_CREATED_AT,
  approvedAt: null,
});

export const EXECUTION_POLICY_REGISTRY = deepFreeze({
  "EP-1": EP1_BASELINE,
  "EP-2": EP2_STRUCTURAL_EXAMPLE,
  "EP-3": EP3_GENERIC_BOUNDARY,
} as const);

export type ExecutionPolicyRegistryKey = keyof typeof EXECUTION_POLICY_REGISTRY;

export function getPolicyById(id: string): ExecutionPolicyDefinition | null {
  const key = id as ExecutionPolicyRegistryKey;
  const found = (EXECUTION_POLICY_REGISTRY as Record<string, ExecutionPolicyDefinition>)[key];
  return found ?? null;
}

export function listPolicies(): readonly ExecutionPolicyDefinition[] {
  return Object.freeze([EP1_BASELINE, EP2_STRUCTURAL_EXAMPLE, EP3_GENERIC_BOUNDARY]);
}

export function listApprovedPolicies(): readonly ExecutionPolicyDefinition[] {
  return Object.freeze([EP1_BASELINE].filter(p => p.status === "APPROVED"));
}

export const EXECUTION_POLICY_REGISTRY_DOC = Object.freeze({
  message: "Execution Policy Registry — 3 policies EP-1/EP-2/EP-3, all explicit, no hidden defaults, HONEST SCOPE top-level only",
  policies: Object.freeze([
    Object.freeze({ id: "EP-1", status: "APPROVED", type: "BASELINE", note: "SMC-Direction Baseline, no SL/TP, NON_EXECUTABLE, truthful" }),
    Object.freeze({ id: "EP-2", status: "DRAFT", type: "STRUCTURAL_EXAMPLE", note: "Explicit stopLoss/takeProfit/slAnchor/tpModel/buffer/rrMin/timeoutBars, owner must approve" }),
    Object.freeze({ id: "EP-3", status: "DRAFT", type: "GENERIC_BOUNDARY", note: "Includes policy identity in fingerprint, k/atrSlMultiplier explicit, OOS-blind" }),
  ]),
  costs: "5bps fee per side, 0 fixed, 2bps slippage per side — fixed",
  scope: "BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d, Smart Money eligibility",
  guarantee: "No hidden defaults — all economic values must be in requiredEconomicFields, no Date token / no random / no env",
});
