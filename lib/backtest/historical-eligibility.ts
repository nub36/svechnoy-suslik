/**
 * Historical eligibility diagnostics — P2-B+ / Phase A.
 *
 * Проблема: историческая production eligibility НЕ полностью реконструируема.
 * Потенциально mutable поля:
 * - Asset.rank
 * - Market.quoteVolume24h
 * - Market.enabled
 * - Market.status
 * - listing/delisting survivorship
 *
 * Этот модуль НЕ выбирает E1/E2/E3 за owner, а предоставляет механизмы
 * для явного представления и отчётности.
 *
 * E1: present-day universe snapshot with explicit limitation
 * E2: disable historically unreconstructable filters with explicit deviation
 * E3: no profitability until point-in-time eligibility history exists
 *
 * Также способен представлять CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY.
 */

export type EligibilityMethodology = "E1" | "E2" | "E3";

export type EligibilityReconstructability =
  | "RECONSTRUCTABLE" // все фильтры реконструируемы point-in-time
  | "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY" // часть фильтров не реконструируема
  | "PARTIALLY_RECONSTRUCTABLE"; // часть реконструируема, часть нет, с деталями

export type EligibilityFieldProvenance = {
  readonly field: "Asset.rank" | "Market.quoteVolume24h" | "Market.enabled" | "Market.status" | "Market.listing";
  readonly reconstructable: boolean;
  readonly reason: string;
  readonly currentValueUsed?: boolean;
};

export type HistoricalEligibilityDiagnostics = {
  readonly methodology: EligibilityMethodology | null; // null = not chosen yet
  readonly reconstructability: EligibilityReconstructability;
  readonly fields: readonly EligibilityFieldProvenance[];
  readonly limitations: readonly string[];
  readonly canReportProfitability: boolean;
  readonly chosenDeviationDescription: string | null;
};

const DEFAULT_FIELDS: readonly EligibilityFieldProvenance[] = Object.freeze([
  {
    field: "Asset.rank",
    reconstructable: false,
    reason: "rank is current-state, mutable, no point-in-time history table",
  },
  {
    field: "Market.quoteVolume24h",
    reconstructable: false,
    reason: "quoteVolume24h is current-state 24h window, not historical at decision time",
  },
  {
    field: "Market.enabled",
    reconstructable: false,
    reason: "enabled flag is mutable current-state, no historical log",
  },
  {
    field: "Market.status",
    reconstructable: false,
    reason: "status is mutable current-state, listing/delisting survivorship unknown",
  },
  {
    field: "Market.listing",
    reconstructable: false,
    reason: "listing/delisting history not available as point-in-time, survivorship bias risk",
  },
]);

export const ELIGIBILITY_LIMITATIONS_E1: readonly string[] = Object.freeze([
  "E1: present-day universe snapshot with explicit limitation — uses today's Asset.rank/Market.enabled/status/quoteVolume24h as approximation for historical eligibility, does NOT claim historical truth",
  "Historical profitability under E1 is NOT production SMC profitability — it's SMC-Direction Baseline with present-day universe filter",
]);

export const ELIGIBILITY_LIMITATIONS_E2: readonly string[] = Object.freeze([
  "E2: disable historically unreconstructable filters with explicit deviation — filters based on rank/quoteVolume/enabled/status are disabled for historical evaluation, deviation from production is explicit",
  "Historical profitability under E2 is SMC-Direction Baseline with no universe filter (all BTC markets)",
]);

export const ELIGIBILITY_LIMITATIONS_E3: readonly string[] = Object.freeze([
  "E3: no profitability until point-in-time eligibility history exists — historical eligibility cannot be reconstructed, therefore no profitability claim is made until PIT eligibility log exists",
]);

export function buildHistoricalEligibilityDiagnostics(
  methodology: EligibilityMethodology | null
): HistoricalEligibilityDiagnostics {
  if (methodology === null) {
    return Object.freeze({
      methodology: null,
      reconstructability: "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY" as const,
      fields: DEFAULT_FIELDS,
      limitations: Object.freeze([
        "OWNER decision pending: E1/E2/E3 not chosen",
        "Historical eligibility cannot be reconstructed from current DB state alone",
        "Current Asset.rank/Market.quoteVolume24h/Market.enabled/Market.status are mutable current-state fields",
        "Do NOT substitute today's values into historical decisions and call them historical truth",
      ]),
      canReportProfitability: false,
      chosenDeviationDescription: null,
    });
  }

  if (methodology === "E1") {
    return Object.freeze({
      methodology: "E1" as const,
      reconstructability: "PARTIALLY_RECONSTRUCTABLE" as const,
      fields: Object.freeze(
        DEFAULT_FIELDS.map((f) => ({
          ...f,
          currentValueUsed: true,
        }))
      ),
      limitations: ELIGIBILITY_LIMITATIONS_E1,
      canReportProfitability: false, // still not production truth, but can report with explicit limitation
      chosenDeviationDescription:
        "Uses present-day snapshot; historical truth not claimed; must be labeled as SMC-Direction Baseline with present-day universe",
    });
  }

  if (methodology === "E2") {
    return Object.freeze({
      methodology: "E2" as const,
      reconstructability: "PARTIALLY_RECONSTRUCTABLE" as const,
      fields: Object.freeze(
        DEFAULT_FIELDS.map((f) => ({
          ...f,
          currentValueUsed: false,
        }))
      ),
      limitations: ELIGIBILITY_LIMITATIONS_E2,
      canReportProfitability: false,
      chosenDeviationDescription:
        "Disables historically unreconstructable filters; deviation from production eligibility is explicit; BTC-only baseline",
    });
  }

  // E3
  return Object.freeze({
    methodology: "E3" as const,
    reconstructability: "CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY" as const,
    fields: DEFAULT_FIELDS,
    limitations: ELIGIBILITY_LIMITATIONS_E3,
    canReportProfitability: false,
    chosenDeviationDescription:
      "No profitability reported until point-in-time eligibility history exists; only pre-PnL diagnostics allowed",
  });
}

export function formatEligibilityDiagnosticsReport(diag: HistoricalEligibilityDiagnostics): string {
  const lines: string[] = [];
  lines.push("=== Historical Eligibility Diagnostics ===");
  lines.push(`methodology: ${diag.methodology ?? "UNRESOLVED (null)"}`);
  lines.push(`reconstructability: ${diag.reconstructability}`);
  lines.push(`canReportProfitability: ${diag.canReportProfitability}`);
  if (diag.chosenDeviationDescription) {
    lines.push(`deviation: ${diag.chosenDeviationDescription}`);
  }
  lines.push("fields:");
  for (const f of diag.fields) {
    lines.push(
      `  - ${f.field}: reconstructable=${f.reconstructable} currentUsed=${f.currentValueUsed ?? "n/a"} reason=${f.reason}`
    );
  }
  lines.push("limitations:");
  for (const lim of diag.limitations) {
    lines.push(`  - ${lim}`);
  }
  return lines.join("\n");
}
