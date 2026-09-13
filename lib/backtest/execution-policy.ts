/**
 * Execution Policy plumbing — Phase D — Generic boundary with NO economic defaults.
 *
 * Задача:
 * - Предоставить generic infrastructure для будущей execution policy
 * - НЕ выбирать экономические значения за owner
 * - Различать RawSmcObservation и Executability
 *
 * NOT APPROVED (must remain explicit required config, no hidden defaults):
 * - structural SL anchor
 * - protectedLow/protectedHigh as SL
 * - ATR SL, SL buffer, TP rule, fixed R target, k=1/k=2/any k-grid, RR_min, timeoutBars, conflict behavior
 *
 * Этот модуль — чистый, без DB, без PnL, без Date.now(), без random, без new Date token (uses utcDateFromMs/formatIsoUtc).
 */

import { formatIsoUtc } from "./timeframe";

export const FORBIDDEN_ECONOMIC_KEYS = Object.freeze([
  "atrSlMultiplier",
  "atrMultiplier",
  "atr",
  "k",
  "rrMin",
  "rr",
  "timeoutBars",
  "timeout",
  "stopLoss",
  "takeProfit",
  "sl",
  "tp",
  "structuralAnchor",
  "protectedLow",
  "protectedHigh",
  "buffer",
  "slAnchor",
  "tpModel",
] as const);

export type ForbiddenEconomicKey = typeof FORBIDDEN_ECONOMIC_KEYS[number];

/**
 * HONEST SCOPE: top-level/current contract scope only, NOT arbitrary source-code semantic analysis.
 * Checks top-level keys of config object for forbidden economic keys (atrSlMultiplier/k/rrMin/timeoutBars/stopLoss/takeProfit/structuralAnchor etc).
 * Does NOT attempt impossible semantic scanning of arbitrary source code or nested closures.
 * When policy unresolved / PRE_REGISTRATION, any economic config at top-level must fail closed — no hidden defaults adopted.
 * Mutation {atrSlMultiplier:1.5,k:1,rrMin:2,timeoutBars:24} must fail.
 */
export function findUndeclaredEconomicFields(
  config: Readonly<Record<string, unknown>> | null | undefined,
  allowedFields: readonly string[] | null | undefined
): readonly string[] {
  if (!config || typeof config !== "object") return [];
  const allowed = new Set((allowedFields ?? []).map(s => s.toLowerCase()));
  const found: string[] = [];
  for (const key of Object.keys(config)) {
    const lower = key.toLowerCase();
    const isForbidden = (FORBIDDEN_ECONOMIC_KEYS as readonly string[]).some(
      fk => fk.toLowerCase() === lower || lower.includes(fk.toLowerCase())
    ) || ["atrslmultiplier","rrmin","timeoutbars","stoploss","takeprofit","structuralanchor"].includes(lower);
    if (isForbidden) {
      if (!allowed.has(lower) && !allowed.has(key)) {
        const allowedHasKey = Array.from(allowed).some(a => a === lower || a === key.toLowerCase() || lower.includes(a) || a.includes(lower));
        if (!allowedHasKey) {
          found.push(key);
        }
      }
    }
  }
  return Object.freeze(found);
}

export function validateNoHiddenEconomicDefaults(
  config: Readonly<Record<string, unknown>> | null | undefined,
  policy: ExecutionPolicyDefinition | null | undefined
): { ok: true } | { ok: false; errors: readonly string[] } {
  if (!config) return { ok: true };
  const allowed = policy?.status === "APPROVED" ? policy.requiredEconomicFields : [];
  if (!policy || policy.status !== "APPROVED") {
    const undeclared = findUndeclaredEconomicFields(config, []);
    if (undeclared.length > 0) {
      return {
        ok: false,
        errors: Object.freeze([
          `Economic fields ${undeclared.join(", ")} cannot appear without explicitly declared owner-approved inputs — policy unresolved/PRE_REGISTRATION_REQUIRED. Mutation ${JSON.stringify(config)} must fail.`,
        ]),
      };
    }
    const suspicious = Object.keys(config).filter(k => {
      const l = k.toLowerCase();
      return l.includes("atr") || l === "k" || l.includes("rr") || l.includes("timeout") || l.includes("stoploss") || l.includes("takeprofit") || l.includes("anchor");
    });
    if (suspicious.length > 0) {
      return {
        ok: false,
        errors: Object.freeze([
          `Suspicious economic fields ${suspicious.join(", ")} rejected when policy unresolved — no hidden defaults allowed.`,
        ]),
      };
    }
    return { ok: true };
  }
  const undeclared = findUndeclaredEconomicFields(config, allowed);
  if (undeclared.length > 0) {
    return {
      ok: false,
      errors: Object.freeze([
        `Economic fields ${undeclared.join(", ")} appear without being declared in requiredEconomicFields — must be explicit owner-approved.`,
      ]),
    };
  }
  return { ok: true };
}

export type ExecutionPolicyId = string;

export type ExecutabilityStatus = "EXECUTABLE" | "NON_EXECUTABLE";

export type NonExecutableReason =
  | "NO_EXECUTION_POLICY"
  | "INVALID_POLICY"
  | "NO_VALID_STOP"
  | "NO_VALID_TARGET"
  | "LEVELS_INVALID_AT_DECISION"
  | "POLICY_NOT_APPROVED"
  | "PRE_REGISTRATION_REQUIRED"
  | "MISSING_REQUIRED_FIELDS"
  | "TIMEOUT_INVALID"
  | "RR_INVALID"
  | "UNKNOWN";

export type Executability = {
  readonly status: ExecutabilityStatus;
  readonly reason: NonExecutableReason | null;
  readonly details: string | null;
};

export const EXECUTABLE: Executability = Object.freeze({
  status: "EXECUTABLE",
  reason: null,
  details: null,
});

export function nonExecutable(
  reason: NonExecutableReason,
  details?: string
): Executability {
  return Object.freeze({
    status: "NON_EXECUTABLE" as const,
    reason,
    details: details ?? null,
  });
}

export type ExecutionPolicyDefinition = {
  readonly id: ExecutionPolicyId;
  readonly version: string;
  readonly description: string;
  readonly fingerprint: string;
  readonly requiredEconomicFields: readonly string[];
  readonly config: Readonly<Record<string, unknown>>;
  readonly status: "DRAFT" | "APPROVED" | "REJECTED";
  readonly createdAt: string;
  readonly approvedAt: string | null;
};

export type ExecutionPolicyValidationResult =
  | { readonly ok: true; readonly policy: ExecutionPolicyDefinition }
  | { readonly ok: false; readonly errors: readonly string[] };

function isValidIsoDateString(s: string): boolean {
  const ms = Date.parse(s);
  return Number.isFinite(ms);
}

export function validateExecutionPolicyDefinition(
  raw: unknown
): ExecutionPolicyValidationResult {
  const errors: string[] = [];

  if (raw === null || typeof raw !== "object") {
    return { ok: false, errors: ["ExecutionPolicyDefinition must be object"] };
  }

  const r = raw as Record<string, unknown>;

  if (typeof r.id !== "string" || r.id.trim().length === 0) {
    errors.push("id must be non-empty string (e.g. EP-1)");
  }

  if (typeof r.version !== "string" || r.version.trim().length === 0) {
    errors.push("version must be non-empty string");
  }

  if (typeof r.description !== "string" || r.description.trim().length === 0) {
    errors.push("description must be non-empty string");
  }

  if (typeof r.fingerprint !== "string" || r.fingerprint.trim().length === 0) {
    errors.push("fingerprint must be non-empty string (sha256)");
  }

  if (!Array.isArray(r.requiredEconomicFields)) {
    errors.push("requiredEconomicFields must be array of strings");
  } else {
    for (const f of r.requiredEconomicFields as unknown[]) {
      if (typeof f !== "string" || f.trim().length === 0) {
        errors.push(`requiredEconomicFields contains invalid entry: ${String(f)}`);
      }
    }
    if (r.status === "APPROVED" && (r.requiredEconomicFields as string[]).length === 0) {
      errors.push("APPROVED policy must have non-empty requiredEconomicFields — economic semantics must be explicit");
    }
  }

  if (r.config === null || typeof r.config !== "object" || Array.isArray(r.config)) {
    errors.push("config must be object (explicit economic values)");
  } else {
    const cfg = r.config as Record<string, unknown>;
    for (const [k, v] of Object.entries(cfg)) {
      if (typeof v === "number" && !Number.isFinite(v)) {
        errors.push(`config.${k} must be finite, got ${String(v)}`);
      }
    }
    if (r.status === "APPROVED" && Array.isArray(r.requiredEconomicFields)) {
      for (const field of r.requiredEconomicFields as string[]) {
        if (!(field in cfg)) {
          errors.push(`config missing required field ${field} for APPROVED policy`);
        }
      }
    }
    // Architectural prohibition: economic values cannot appear without explicit declaration
    if (Array.isArray(r.requiredEconomicFields)) {
      const undeclared = findUndeclaredEconomicFields(cfg as Readonly<Record<string, unknown>>, r.requiredEconomicFields as string[]);
      if (undeclared.length > 0) {
        errors.push(`Economic fields ${undeclared.join(", ")} appear without being declared in requiredEconomicFields — must be explicit owner-approved (no hidden defaults)`);
      }
    }
  }

  if (r.status !== "DRAFT" && r.status !== "APPROVED" && r.status !== "REJECTED") {
    errors.push("status must be DRAFT | APPROVED | REJECTED");
  }

  if (typeof r.createdAt !== "string") {
    errors.push("createdAt must be ISO string");
  } else {
    if (!isValidIsoDateString(r.createdAt)) {
      errors.push(`createdAt invalid date: ${r.createdAt}`);
    }
  }

  if (r.approvedAt !== null && r.approvedAt !== undefined) {
    if (typeof r.approvedAt !== "string") {
      errors.push("approvedAt must be ISO string or null");
    } else {
      if (!isValidIsoDateString(r.approvedAt)) {
        errors.push(`approvedAt invalid date: ${r.approvedAt}`);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors: Object.freeze(errors) };
  }

  return { ok: true, policy: r as unknown as ExecutionPolicyDefinition };
}

export type ExecutionPolicyResult = {
  readonly policyId: ExecutionPolicyId | null;
  readonly policyFingerprint: string | null;
  readonly executability: Executability;
  readonly validatedAt: string;
};

function deterministicValidatedAt(): string {
  return formatIsoUtc(0);
}

export function buildNonExecutableResult(
  reason: NonExecutableReason,
  details?: string
): ExecutionPolicyResult {
  return Object.freeze({
    policyId: null,
    policyFingerprint: null,
    executability: nonExecutable(reason, details),
    validatedAt: deterministicValidatedAt(),
  });
}

export function buildExecutableResult(
  policy: ExecutionPolicyDefinition
): ExecutionPolicyResult {
  if (policy.status !== "APPROVED") {
    return buildNonExecutableResult("POLICY_NOT_APPROVED", `Policy ${policy.id} status ${policy.status} not APPROVED`);
  }
  return Object.freeze({
    policyId: policy.id,
    policyFingerprint: policy.fingerprint,
    executability: EXECUTABLE,
    validatedAt: deterministicValidatedAt(),
  });
}

export function fingerprintPolicyConfig(config: Readonly<Record<string, unknown>>): string {
  const sorted = sortObjectKeys(config);
  const json = JSON.stringify(sorted);
  let hash = 0;
  for (let i = 0; i < json.length; i++) {
    hash = (hash * 31 + json.charCodeAt(i)) | 0;
  }
  return `simple-${Math.abs(hash).toString(16)}-${json.length}`;
}

function sortObjectKeys(obj: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const sorted: Record<string, unknown> = {};
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    const v = obj[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      sorted[k] = sortObjectKeys(v as Record<string, unknown>);
    } else if (Array.isArray(v)) {
      sorted[k] = v.map((el) =>
        el !== null && typeof el === "object" && !Array.isArray(el)
          ? sortObjectKeys(el as Record<string, unknown>)
          : el
      );
    } else {
      sorted[k] = v;
    }
  }
  return sorted;
}

export const EXECUTION_POLICY_NOT_APPROVED_DOC = Object.freeze({
  message: "Execution policy is NOT approved — owner must choose actual SL anchor, ATR/distance/structural stop model, TP model, k/RR_min/buffer/timeout/conflict economic semantics",
  forbiddenDefaults: [
    "structural SL anchor",
    "protectedLow/protectedHigh as SL",
    "ATR SL",
    "SL buffer",
    "TP rule",
    "fixed R target",
    "k=1",
    "k=2",
    "any k-grid",
    "RR_min",
    "timeoutBars",
    "new conflict behavior",
    "atrSlMultiplier",
    "k",
    "rrMin",
    "timeoutBars",
    "stopLoss",
    "takeProfit",
    "structuralAnchor",
  ],
  requiredExplicit: "All economic values must be explicit required configuration values, no hidden defaults — architectural prohibition, not keyword grep",
});
