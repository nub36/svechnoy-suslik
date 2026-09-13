/**
 * PHASE: SMC EVENT SEMANTICS — Setup vs Candle
 * SMC direction can persist many candles, cannot turn each candle with score>=72 into new Signal.
 * Need trigger/re-arm contract and stable setup identity from causal facts.
 *
 * setupKey must be fully causal, no score or future outcome.
 * Possible keys: latest swing BOS key/confirmedAt, swing OB key, FVG key, liquidity sweep key, direction, structure phase.
 *
 * Goal: 08:15..10:45 same thesis => ONE setup, not 11.
 */

import type { SmartMoneySignalCandidate } from "./smart-money-candidate";
import { createHash } from "crypto";

export type SetupKeyComponents = {
  strategyVersion: number;
  symbol: string;
  timeframe: string;
  direction: "LONG" | "SHORT";
  swingPhase: string; // TREND_UP/DOWN etc
  swingBosKey: string | null; // latest fresh BOS key that matches phase
  swingBosConfirmedAt: string | null; // ISO
  swingOrderBlockKey: string | null;
  swingOrderBlockConfirmedAt: string | null;
  internalOrderBlockKey: string | null;
  fvgKey: string | null;
  fvgConfirmedAt: string | null;
  liquiditySweepKey: string | null; // we may not have key, use side+resolvedAt
  rangeKey: string | null; // dealing range key
};

export function extractSetupComponents(candidate: SmartMoneySignalCandidate, strategyVersion: number): SetupKeyComponents {
  const meta = candidate.metadata;
  // Find latest BOS that matches phase — from perExchange reasons we don't have BOS key directly,
  // but we can approximate from metadata: we have perExchange reasons, but for setup we need causal facts.
  // For now, we extract from metadata if available, otherwise from candidate fields.
  // Since candidate builder doesn't store BOS key explicitly, we will use what we have:
  // - swingPhase from metadata.direction? Actually aggregation direction, but we need swing phase
  // We have metadata.direction = LONG/SHORT/NEUTRAL, and conflict, but not phase.
  // For setup identity, we will use available keys from perExchange first evaluable that has reasons.
  // This is research design — we will refine after seeing real metadata A-I.

  // Attempt to find BOS, OB, FVG keys from perExchange reasons or metadata
  // For now, we use referenceExchange price context and confirmation as proxy, but we need more stable.

  // We have metadata.perExchange[0] reasons contain codes like SWING_TREND, RECENT_SWING_BOS, etc with value containing BOS dir or OB key
  const firstPer = meta.perExchange.find((p) => p.evaluable);
  const reasons = firstPer?.reasons || [];

  const bosReason = reasons.find((r) => r.code === "RECENT_SWING_BOS" || r.code === "BOS" || (r.label && r.label.includes("BOS")));
  const swingObReason = reasons.find((r) => r.code === "SWING_ORDER_BLOCK");
  const internalObReason = reasons.find((r) => r.code === "INTERNAL_ORDER_BLOCK");
  const fvgReason = reasons.find((r) => r.code === "FVG");
  const sweepReason = reasons.find((r) => r.code === "LIQUIDITY_SWEEP");
  const rangeReason = reasons.find((r) => r.code === "RANGE_POSITION");

  // The value fields contain keys or timestamps for some components
  // For swing BOS, value is like "BOS:down" — not unique enough, need key. For now use value + confirmedAt approximation.
  // For OB and FVG, value is the OB/FVG key itself (from scoring.ts push value = ob.key / fvg.key)
  // So we can use those keys.

  return {
    strategyVersion,
    symbol: candidate.symbol,
    timeframe: candidate.timeframe,
    direction: candidate.direction as "LONG" | "SHORT",
    swingPhase: meta.direction, // proxy, should be swing phase TREND_UP/DOWN
    swingBosKey: bosReason?.value || null, // ideally BOS event key, but we have BOS:dir
    swingBosConfirmedAt: meta.commonHorizon, // proxy: commonHorizon is when BOS confirmed? Actually BOS confirmedAt <= asOf, but we use commonHorizon as version
    swingOrderBlockKey: swingObReason?.value || null,
    swingOrderBlockConfirmedAt: swingObReason?.value ? meta.commonHorizon : null,
    internalOrderBlockKey: internalObReason?.value || null,
    fvgKey: fvgReason?.value || null,
    fvgConfirmedAt: fvgReason?.value ? meta.commonHorizon : null,
    liquiditySweepKey: sweepReason?.value || null,
    rangeKey: rangeReason?.value || null,
  };
}

/**
 * Build setupKey — fully causal, no score, no future outcome.
 * Versioned tuple hash: strategyVersion, symbol, timeframe, direction, swingBosKey, swingOBKey, fvgKey, etc.
 * Nullable components handled: if null, use "null" literal, but change in any component => new setup.
 * Score 75->80 with same facts => same setupKey (since score not included)
 */
export function buildSetupKey(components: SetupKeyComponents): string {
  // Stable tuple — order matters, versioned
  const tuple = [
    `v${components.strategyVersion}`,
    components.symbol,
    components.timeframe,
    components.direction,
    `phase:${components.swingPhase}`,
    `bos:${components.swingBosKey ?? "null"}|${components.swingBosConfirmedAt ?? "null"}`,
    `swingOB:${components.swingOrderBlockKey ?? "null"}`,
    `intOB:${components.internalOrderBlockKey ?? "null"}`,
    `fvg:${components.fvgKey ?? "null"}`,
    `sweep:${components.liquiditySweepKey ?? "null"}`,
    `range:${components.rangeKey ?? "null"}`,
  ].join("|");

  // Hash for compactness, but keep readable prefix for debugging
  const hash = createHash("sha256").update(tuple).digest("hex").slice(0, 12);
  return `SMC_SETUP|${hash}|${tuple}`;
}

/**
 * Convenience wrapper
 */
export function buildSetupKeyFromCandidate(candidate: SmartMoneySignalCandidate, strategyVersion: number): string {
  const comps = extractSetupComponents(candidate, strategyVersion);
  return buildSetupKey(comps);
}

/**
 * Trigger semantics comparison on historical evaluations
 */

export type TriggerPolicy = "RAW" | "EDGE" | "SETUP_KEY" | "SETUP_KEY_NO_OVERLAP";

export type HistoricalSignal = {
  signalCandleTime: Date;
  direction: "LONG" | "SHORT";
  setupKey: string;
  score: number;
  candidate: SmartMoneySignalCandidate;
};

export function applyEdgeTrigger(signals: HistoricalSignal[]): HistoricalSignal[] {
  const sorted = [...signals].sort((a, b) => a.signalCandleTime.getTime() - b.signalCandleTime.getTime());
  const result: HistoricalSignal[] = [];
  let prevDirection: string | null = null;
  for (const s of sorted) {
    if (prevDirection !== s.direction) {
      // Transition into SHORT or LONG
      result.push(s);
    }
    prevDirection = s.direction;
  }
  return result;
}

export function applySetupKeyTrigger(signals: HistoricalSignal[]): HistoricalSignal[] {
  const sorted = [...signals].sort((a, b) => a.signalCandleTime.getTime() - b.signalCandleTime.getTime());
  const seen = new Set<string>();
  const result: HistoricalSignal[] = [];
  for (const s of sorted) {
    if (!seen.has(s.setupKey)) {
      seen.add(s.setupKey);
      result.push(s);
    }
  }
  return result;
}

export function applySetupKeyNoOverlapTrigger(signals: HistoricalSignal[], outcomeBySetupKey: Map<string, { entryTime: Date | null; exitTime: Date | null }>): HistoricalSignal[] {
  // Position-like gate: do not create another same strategy/symbol/timeframe signal until previous outcome terminal
  const sorted = [...signals].sort((a, b) => a.signalCandleTime.getTime() - b.signalCandleTime.getTime());
  const result: HistoricalSignal[] = [];
  let lastExit: Date | null = null;
  const seenKeys = new Set<string>();

  for (const s of sorted) {
    if (seenKeys.has(s.setupKey)) continue; // already seen setup
    const outcome = outcomeBySetupKey.get(s.setupKey);
    // If previous signal still active (no exit or exit > current candle), skip
    if (lastExit && s.signalCandleTime.getTime() <= lastExit.getTime()) {
      continue;
    }
    seenKeys.add(s.setupKey);
    result.push(s);
    if (outcome?.exitTime) {
      lastExit = outcome.exitTime;
    } else if (outcome?.entryTime) {
      // If entry but no exit yet, estimate exit as entry + some bars? For gate we use entry as blocking until terminal
      // For simplicity, block until we have exit, or use signalCandleTime + tf*10 as proxy
      lastExit = new Date(s.signalCandleTime.getTime() + 10 * 15 * 60 * 1000); // placeholder
    }
  }
  return result;
}
