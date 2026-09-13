/**
 * Client-safe approval utility — NO node:crypto, NO engine import.
 * Deterministic, no DB writes, uses formatIsoUtc.
 */

import { formatIsoUtc } from "./timeframe";
import { deepFreeze } from "./immutable";
import type { ExecutionPolicyDefinition } from "./execution-policy";

export function approvePolicy(policy: ExecutionPolicyDefinition): ExecutionPolicyDefinition {
  if (policy.status === "APPROVED") return policy;
  return deepFreeze({
    ...policy,
    status: "APPROVED" as const,
    approvedAt: formatIsoUtc(Date.parse("2024-01-03T00:00:00.000Z")),
  });
}
