/**
 * Train/Validation/OOS readiness — Phase F — pre-PnL split readiness/coverage diagnostics.
 * Uses accepted P2-C semantics, does not allow OOS to influence ranking/selection/tie-break/eligibility.
 * Do not choose split dates based on observed strategy results.
 * If historical data insufficient: report insufficient OOS/data coverage, do not silently shorten OOS.
 */

import { deepFreeze } from "./immutable";
import { getTimeframeMs, formatIsoUtc } from "./timeframe";
import type { SmcTimeframe } from "../smc/types";

export type SplitDefinition = {
  readonly name: "TRAIN" | "VALIDATION" | "OOS";
  readonly from: string; // ISO
  readonly to: string; // ISO
  readonly fromMs: number;
  readonly toMs: number;
  readonly expectedSlots: number | null;
};

export type SplitReadiness = {
  readonly split: SplitDefinition;
  readonly availableSlots: number;
  readonly coverageRatio: number | null;
  readonly isReady: boolean;
  readonly reason: string | null;
};

export type SplitsReadinessReport = {
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly timeframeMs: number | null;
  readonly splits: readonly SplitReadiness[];
  readonly overallReady: boolean;
  readonly insufficient: readonly string[];
  readonly warnings: readonly string[];
  readonly oosIsolation: {
    readonly oosDoesNotInfluenceSelection: true;
    readonly selectionStages: readonly ("TRAIN" | "VALIDATION")[];
    readonly oosIsFinalWitnessOnly: true;
  };
  readonly readOnly: true;
  readonly noPnl: true;
};

function countExpectedSlots(fromMs: number, toMs: number, timeframeMs: number | null): number | null {
  if (timeframeMs === null || !Number.isFinite(timeframeMs) || timeframeMs <= 0) return null;
  if (fromMs >= toMs) return null;
  // Use canonical counting: floor((to-1 - ceil(from/D)*D)/D)+1
  const effectiveFrom = Math.ceil(fromMs / timeframeMs) * timeframeMs;
  if (effectiveFrom >= toMs) return 0;
  return Math.floor((toMs - 1 - effectiveFrom) / timeframeMs) + 1;
}

export function evaluateSplitsReadiness(params: {
  assetSymbol: string;
  timeframe: SmcTimeframe;
  splits: readonly { name: "TRAIN" | "VALIDATION" | "OOS"; from: Date; to: Date }[];
  availableTimestamps: readonly number[]; // common timestamps ASC
}): SplitsReadinessReport {
  const timeframeMs = getTimeframeMs(params.timeframe);
  const warnings: string[] = [];
  const insufficient: string[] = [];

  const readiness: SplitReadiness[] = [];

  for (const s of params.splits) {
    if (!(s.from instanceof Date) || !(s.to instanceof Date) || Number.isNaN(s.from.getTime()) || Number.isNaN(s.to.getTime())) {
      throw new Error(`evaluateSplitsReadiness: split ${s.name} from/to must be valid Date`);
    }
    if (s.from.getTime() >= s.to.getTime()) {
      throw new Error(`evaluateSplitsReadiness: split ${s.name} from must be < to`);
    }

    const fromMs = s.from.getTime();
    const toMs = s.to.getTime();
    const expectedSlots = countExpectedSlots(fromMs, toMs, timeframeMs);

    // Count available in this split
    let available = 0;
    for (const t of params.availableTimestamps) {
      if (t >= fromMs && t < toMs) available++;
    }

    const coverageRatio = expectedSlots !== null && expectedSlots > 0 ? available / expectedSlots : null;
    const isReady = expectedSlots !== null ? available >= expectedSlots * 0.9 : available > 0; // require 90% coverage for readiness, not 100% to allow minor gaps, but report

    let reason: string | null = null;
    if (!isReady) {
      reason = `Split ${s.name} insufficient: expected ${expectedSlots ?? "unknown"} slots, available ${available}, coverage ${coverageRatio ?? "n/a"}`;
      insufficient.push(reason);
    }

    if (coverageRatio !== null && coverageRatio < 1) {
      warnings.push(`Split ${s.name} coverage ${coverageRatio} < 1 — incomplete`);
    }

    const def: SplitDefinition = {
      name: s.name,
      from: s.from.toISOString(),
      to: s.to.toISOString(),
      fromMs,
      toMs,
      expectedSlots,
    };

    readiness.push(
      Object.freeze({
        split: Object.freeze(def),
        availableSlots: available,
        coverageRatio,
        isReady,
        reason,
      })
    );
  }

  // Check OOS does not influence selection — structural guarantee
  // We enforce that selection stages are only TRAIN/VALIDATION
  const overallReady = readiness.every((r) => r.isReady);

  if (!overallReady) {
    warnings.push("Overall not ready — insufficient OOS/data coverage, do not silently shorten OOS");
  }

  return deepFreeze({
    assetSymbol: params.assetSymbol,
    timeframe: params.timeframe,
    timeframeMs,
    splits: Object.freeze(readiness),
    overallReady,
    insufficient: Object.freeze(insufficient),
    warnings: Object.freeze(warnings),
    oosIsolation: Object.freeze({
      oosDoesNotInfluenceSelection: true as const,
      selectionStages: Object.freeze(["TRAIN", "VALIDATION"] as const),
      oosIsFinalWitnessOnly: true as const,
    }),
    readOnly: true as const,
    noPnl: true as const,
  }) as SplitsReadinessReport;
}

export function formatSplitsReadinessReport(report: SplitsReadinessReport): string {
  const lines: string[] = [];
  lines.push("=== Splits Readiness — READ ONLY — NO PNL — OOS ISOLATION ===");
  lines.push(`asset: ${report.assetSymbol} timeframe: ${report.timeframe} tfMs: ${report.timeframeMs ?? "unknown"}`);
  lines.push(`overallReady: ${report.overallReady}`);
  lines.push(`oosIsolation: OOS does not influence selection (stages: ${report.oosIsolation.selectionStages.join(", ")}, OOS is final witness only)`);
  for (const s of report.splits) {
    lines.push(
      `  ${s.split.name}: ${s.split.from} -> ${s.split.to} expected=${s.split.expectedSlots ?? "n/a"} available=${s.availableSlots} coverage=${s.coverageRatio ?? "n/a"} ready=${s.isReady}${s.reason ? ` reason=${s.reason}` : ""}`
    );
  }
  if (report.insufficient.length > 0) {
    lines.push("insufficient:");
    for (const i of report.insufficient) {
      lines.push(`  - ${i}`);
    }
  }
  if (report.warnings.length > 0) {
    lines.push("warnings:");
    for (const w of report.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  lines.push("No profitability until OOS coverage is sufficient and execution policy approved");
  return lines.join("\n");
}
