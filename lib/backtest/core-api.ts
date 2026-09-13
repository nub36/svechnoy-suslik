/**
 * CORE API contract for visual agent — read-only, typed, no DB writes, no Signal Engine, no PnL.
 *
 * Purpose: clean boundary for future UI integration (Agent 2) without coupling to DB or Signal Engine.
 * All functions are pure or DI-based read-only, no process.env, no Date.now(), no new Date().
 *
 * This module re-exports safe pre-PnL diagnostics and provides typed service interfaces
 * that UI can call via server actions / API routes that internally use read-only deps.
 */

import type { SmcTimeframe } from "../smc/types";
import type { HistoricalDataPlaneReport } from "./historical-data-plane";
import type { HistoricalEligibilityDiagnostics } from "./historical-eligibility";
import type { OhlcvProvenanceDiagnostics } from "./ohlcv-provenance";
import type { RawSmcObservation, HistoricalObservationBatch } from "./smc-observation";
import type { ExecutionPolicyDefinition, ExecutionPolicyResult } from "./execution-policy";
import type { SplitsReadinessReport } from "./splits-readiness";
import type { PrePnlDiagnostics } from "./pre-pnl-runner";
import { deepFreeze } from "./immutable";

// Read-only inspection result — what owner CLI produces, UI can display
export type OwnerInspectionResult = {
  readonly assetSymbol: string;
  readonly timeframe: SmcTimeframe;
  readonly requestedRange: { readonly from: string; readonly to: string };
  readonly dataPlane: HistoricalDataPlaneReport;
  readonly eligibility: HistoricalEligibilityDiagnostics;
  readonly provenance: OhlcvProvenanceDiagnostics | null;
  readonly splitsReadiness: SplitsReadinessReport | null;
  readonly prePnl: PrePnlDiagnostics | null;
  readonly rawObservations: readonly RawSmcObservation[] | null;
  readonly readOnly: true;
  readonly noPnl: true;
  readonly truthfulBaseline: string;
  readonly limitations: readonly string[];
};

// Service interface — UI should implement via server-side read-only transaction
export type CoreReadOnlyService = {
  readonly fetchDataPlane: (params: {
    assetSymbol: string;
    timeframe: SmcTimeframe;
    from: Date;
    to: Date;
    markets: readonly { id: number; exchange: string; exchangeSymbol: string; assetId: number; enabled: boolean; status: string }[];
    isSmartMoney: boolean;
  }) => Promise<HistoricalDataPlaneReport>;

  readonly fetchEligibilityDiagnostics: (methodology: null | "E1" | "E2" | "E3") => HistoricalEligibilityDiagnostics;

  readonly fetchProvenance: (candles: readonly { marketId: number; timeframe: string; openTime: Date; open: number; high: number; low: number; close: number; volume: number; closed: boolean; createdAt: Date; updatedAt: Date }[]) => OhlcvProvenanceDiagnostics;

  readonly runPrePnl: (params: {
    assetSymbol: string;
    timeframe: SmcTimeframe;
    from: Date;
    to: Date;
    markets: readonly any[];
    allCandlesPerMarket: ReadonlyMap<number, readonly any[]>;
    decisionBarsMs: readonly number[];
    executionPolicy: ExecutionPolicyDefinition | null;
  }) => Promise<PrePnlDiagnostics>;
};

// Typed API response for admin/backtests UI — truthful readiness
export type BacktestsReadinessApiResponse = {
  readonly p2a: { readonly version: string; readonly status: "ACCEPTED"; readonly vpsVerified: boolean };
  readonly p2b: { readonly status: "HARDENED_ACCEPTED"; readonly tests: string };
  readonly p2c: { readonly version: string; readonly status: "ACCEPTED"; readonly tests: string };
  readonly prePnl: {
    readonly status: "IMPLEMENTED_PENDING_REVIEW";
    readonly baseline: string;
    readonly executionPolicy: "PRE_REGISTRATION_REQUIRED";
    readonly eligibility: "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY";
    readonly bingx1dExcluded: true;
    readonly noPnl: true;
    readonly readOnly: true;
  };
  readonly ownerCli: {
    readonly command: string;
    readonly noSecrets: true;
    readonly readOnly: true;
    readonly noPnl: true;
  };
  readonly limitations: readonly string[];
};

export function buildBacktestsReadinessResponse(): BacktestsReadinessApiResponse {
  return deepFreeze({
    p2a: { version: "p2a-1.2.0", status: "ACCEPTED" as const, vpsVerified: true },
    p2b: { status: "HARDENED_ACCEPTED" as const, tests: "427/427" },
    p2c: { version: "p2c-1.2.0", status: "ACCEPTED" as const, tests: "contract 213/213 report 225/225 leakage 174/174 hardening 165/165" },
    prePnl: {
      status: "IMPLEMENTED_PENDING_REVIEW" as const,
      baseline: "SMC-Direction Baseline / EP-1",
      executionPolicy: "PRE_REGISTRATION_REQUIRED" as const,
      eligibility: "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY" as const,
      bingx1dExcluded: true as const,
      noPnl: true as const,
      readOnly: true as const,
    },
    ownerCli: {
      command: "npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits",
      noSecrets: true as const,
      readOnly: true as const,
      noPnl: true as const,
    },
    limitations: [
      "Historical eligibility CANNOT_RECONSTRUCT — E1/E2/E3 unresolved",
      "OHLCV PIT not guaranteed — sync.ts upsert path",
      "No profitability until execution policy APPROVED — PRE_REGISTRATION_REQUIRED",
      "BINGX 1d excluded via isSmartMoneyExchangeEligible",
      "BTC only, 5m/15m/1h/4h/1d, costs 5bps fee 2bps slippage each side",
      "No DB writes, no workers, no Signal Engine, no production deployment",
    ],
  });
}

// Re-export safe types for UI
export type {
  HistoricalDataPlaneReport,
  HistoricalEligibilityDiagnostics,
  OhlcvProvenanceDiagnostics,
  RawSmcObservation,
  HistoricalObservationBatch,
  ExecutionPolicyDefinition,
  ExecutionPolicyResult,
  SplitsReadinessReport,
  PrePnlDiagnostics,
  SmcTimeframe,
};

export const CORE_API_DOC = Object.freeze({
  purpose: "Read-only typed contracts for visual agent, no DB writes, no Signal Engine, no PnL",
  guarantees: [
    "No process.env, no Date.now(), no new Date() in core modules",
    "SELECT-only SQL allowlist, no $executeRaw",
    "Raw LONG/SHORT preserved vs executability separation",
    "PRE_REGISTRATION_REQUIRED before P2-A economics",
    "OOS does not influence selection",
    "No fake profitability",
  ],
  ownerCommand: "npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits",
  noSecrets: true,
  readOnly: true,
  noPnl: true,
});
