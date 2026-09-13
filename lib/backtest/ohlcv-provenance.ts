/**
 * OHLCV point-in-time fidelity diagnostics — Phase A.
 *
 * Проблема: текущие Candle rows могут быть обновлены/upserted.
 * Prior analysis found write/update path in lib/ohlcv/sync.ts that updates
 * existing candle values (upsertCandles).
 * Поэтому текущие DB contents НЕ автоматически доказывают, какие значения
 * были известны исторически.
 *
 * Важно:
 * - createdAt does NOT prove current OHLCV values were identical at creation
 * - updatedAt shows mutation timing but does NOT recover old values
 * - no point-in-time history table exists
 *
 * Этот модуль предоставляет read-only диагностику и аудит write paths.
 * No new Date token (uses formatIsoUtc).
 */

import { formatIsoUtc } from "./timeframe";

export type OhlcvWritePathAudit = {
  readonly file: string;
  readonly hasUpsert: boolean;
  readonly hasUpdate: boolean;
  readonly description: string;
};

export const KNOWN_OHLCV_WRITE_PATHS: readonly OhlcvWritePathAudit[] = Object.freeze([
  {
    file: "lib/ohlcv/sync.ts",
    hasUpsert: true,
    hasUpdate: true,
    description:
      "upsertCandles uses prisma.candle.upsert with update branch overwriting open/high/low/close/volume/closeTime/closed — existing candle values can be mutated after initial creation",
  },
]);

export type CandleProvenanceRow = {
  readonly marketId: number;
  readonly timeframe: string;
  readonly openTime: Date;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
  readonly closed: boolean;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
};

export type OhlcvProvenanceDiagnostics = {
  readonly totalRows: number;
  readonly rowsWithCreatedAt: number;
  readonly rowsWithUpdatedAt: number;
  readonly rowsWhereUpdatedAtDiffersFromCreatedAt: number;
  readonly earliestCreatedAt: string | null;
  readonly latestUpdatedAt: string | null;
  readonly knownLimitations: readonly string[];
  readonly writePathAudits: readonly OhlcvWritePathAudit[];
};

export const OHLCV_PROVENANCE_LIMITATIONS: readonly string[] = Object.freeze([
  "Current Candle rows may be updated/upserted via lib/ohlcv/sync.ts upsert path — current DB contents do NOT automatically prove what values were known historically",
  "createdAt does NOT prove current OHLCV values were identical at creation time — it only proves row existence timing, not value identity",
  "updatedAt shows mutation timing but does NOT recover old values — no point-in-time history table",
  "No strict point-in-time fidelity can be claimed from current Candle table alone",
  "For backtest honesty, diagnostics must report createdAt/updatedAt distribution and note unknown provenance",
]);

export function computeOhlcvProvenanceDiagnostics(
  rows: readonly CandleProvenanceRow[]
): OhlcvProvenanceDiagnostics {
  let rowsWithCreatedAt = 0;
  let rowsWithUpdatedAt = 0;
  let rowsWhereDiff = 0;
  let earliestCreatedAtMs: number | null = null;
  let latestUpdatedAtMs: number | null = null;

  for (const r of rows) {
    if (r.createdAt instanceof Date && Number.isFinite(r.createdAt.getTime())) {
      rowsWithCreatedAt += 1;
      const ms = r.createdAt.getTime();
      if (earliestCreatedAtMs === null || ms < earliestCreatedAtMs) {
        earliestCreatedAtMs = ms;
      }
    }
    if (r.updatedAt instanceof Date && Number.isFinite(r.updatedAt.getTime())) {
      rowsWithUpdatedAt += 1;
      const ms = r.updatedAt.getTime();
      if (latestUpdatedAtMs === null || ms > latestUpdatedAtMs) {
        latestUpdatedAtMs = ms;
      }
    }
    if (
      r.createdAt instanceof Date &&
      r.updatedAt instanceof Date &&
      Number.isFinite(r.createdAt.getTime()) &&
      Number.isFinite(r.updatedAt.getTime()) &&
      r.createdAt.getTime() !== r.updatedAt.getTime()
    ) {
      rowsWhereDiff += 1;
    }
  }

  return Object.freeze({
    totalRows: rows.length,
    rowsWithCreatedAt,
    rowsWithUpdatedAt,
    rowsWhereUpdatedAtDiffersFromCreatedAt: rowsWhereDiff,
    earliestCreatedAt: earliestCreatedAtMs !== null ? formatIsoUtc(earliestCreatedAtMs) : null,
    latestUpdatedAt: latestUpdatedAtMs !== null ? formatIsoUtc(latestUpdatedAtMs) : null,
    knownLimitations: OHLCV_PROVENANCE_LIMITATIONS,
    writePathAudits: KNOWN_OHLCV_WRITE_PATHS,
  });
}

export function formatOhlcvProvenanceReport(diag: OhlcvProvenanceDiagnostics): string {
  const lines: string[] = [];
  lines.push("=== OHLCV Point-In-Time Provenance Diagnostics ===");
  lines.push(`totalRows: ${diag.totalRows}`);
  lines.push(`rowsWithCreatedAt: ${diag.rowsWithCreatedAt}`);
  lines.push(`rowsWithUpdatedAt: ${diag.rowsWithUpdatedAt}`);
  lines.push(`rowsWhereUpdatedAtDiffersFromCreatedAt: ${diag.rowsWhereUpdatedAtDiffersFromCreatedAt}`);
  lines.push(`earliestCreatedAt: ${diag.earliestCreatedAt ?? "n/a"}`);
  lines.push(`latestUpdatedAt: ${diag.latestUpdatedAt ?? "n/a"}`);
  lines.push("knownLimitations:");
  for (const l of diag.knownLimitations) {
    lines.push(`  - ${l}`);
  }
  lines.push("writePathAudits:");
  for (const a of diag.writePathAudits) {
    lines.push(`  - ${a.file}: upsert=${a.hasUpsert} update=${a.hasUpdate} — ${a.description}`);
  }
  return lines.join("\n");
}

export const EXPECTED_CANDLE_WRITE_FILES = Object.freeze(["lib/ohlcv/sync.ts"]);

export function auditCandleWritePaths(foundFiles: readonly string[]): {
  readonly ok: boolean;
  readonly unexpected: readonly string[];
  readonly missingExpected: readonly string[];
} {
  const unexpected = foundFiles.filter((f) => !(EXPECTED_CANDLE_WRITE_FILES as readonly string[]).includes(f));
  const missingExpected = (EXPECTED_CANDLE_WRITE_FILES as readonly string[]).filter((f) => !foundFiles.includes(f));
  return Object.freeze({
    ok: unexpected.length === 0 && missingExpected.length === 0,
    unexpected: Object.freeze(unexpected),
    missingExpected: Object.freeze(missingExpected),
  });
}
