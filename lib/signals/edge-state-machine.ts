/**
 * EDGE STATE MACHINE V1 — SMC EVENT SEMANTICS
 *
 * Define aggregate state: NEUTRAL, LONG, SHORT, CANNOT_EVALUATE / DATA_UNAVAILABLE
 * Signal creation:
 *   NEUTRAL -> LONG = EMIT LONG
 *   NEUTRAL -> SHORT = EMIT SHORT
 *   LONG -> LONG = NO EMIT
 *   SHORT -> SHORT = NO EMIT
 *   LONG -> NEUTRAL = RE-ARM
 *   SHORT -> NEUTRAL = RE-ARM
 *   LONG -> SHORT = EMIT SHORT reversal
 *   SHORT -> LONG = EMIT LONG reversal
 * Critical: CANNOT_EVALUATE/DATA_UNAVAILABLE must NOT re-arm.
 * Example SHORT -> DATA_UNAVAILABLE -> SHORT must NOT emit second SHORT.
 *
 * Persistent state: StrategySignalState survives PM2 restart
 * Idempotent: same horizon twice no-op, older horizon refused
 * Data failure: distinguish NEUTRAL from unavailable (quorum_not_met, DATA_UNAVAILABLE, CANNOT_EVALUATE, future/off-grid, system failure) — preserve last directional/re-arm state
 * Bootstrap: if no state row and current SHORT, BOOTSTRAP SHORT NO SIGNAL default, only after SHORT->NEUTRAL->SHORT or reversal. Optional --emit-on-bootstrap default false.
 */

export type AggregateState = "NEUTRAL" | "LONG" | "SHORT" | "CANNOT_EVALUATE" | "DATA_UNAVAILABLE" | "QUORUM_NOT_MET" | "FUTURE_HORIZON" | "ABSOLUTE_STALE";

export type TriggerType = "EDGE" | "REVERSAL" | "BOOTSTRAP" | null;

export type EdgeAction = "EMIT" | "REARM" | "HOLD" | "PRESERVE_UNAVAILABLE" | "BOOTSTRAP_NO_SIGNAL" | "NOOP_SAME_HORIZON" | "REFUSE_OLDER_HORIZON";

export type EdgeTransition = {
  previousState: AggregateState | null; // null = no state row yet (bootstrap)
  currentAggregate: AggregateState;
  currentCandleTime: Date;
  action: EdgeAction;
  shouldEmit: boolean;
  emitDirection: "LONG" | "SHORT" | null;
  triggerType: TriggerType;
  reason: string;
};

export type StrategySignalStateRow = {
  strategyId: number;
  symbol: string;
  timeframe: string;
  lastEvaluatedCandleTime: Date | null;
  aggregateState: string; // stored as string, should be AggregateState
  lastSignalCandleTime: Date | null;
  lastSignalDirection: string | null;
  lastEvaluationStatus: string | null;
};

function isDirectional(state: AggregateState): boolean {
  return state === "LONG" || state === "SHORT";
}

function isNeutral(state: AggregateState): boolean {
  return state === "NEUTRAL";
}

function isUnavailable(state: AggregateState): boolean {
  return (
    state === "CANNOT_EVALUATE" ||
    state === "DATA_UNAVAILABLE" ||
    state === "QUORUM_NOT_MET" ||
    state === "FUTURE_HORIZON" ||
    state === "ABSOLUTE_STALE"
  );
}

function normalizeAggregate(input: string): AggregateState {
  const upper = input.toUpperCase();
  if (upper === "LONG" || upper === "SHORT" || upper === "NEUTRAL") return upper as AggregateState;
  if (upper.includes("CANNOT") || upper === "CANNOT_EVALUATE") return "CANNOT_EVALUATE";
  if (upper.includes("DATA_UNAVAILABLE") || upper === "DATA_UNAVAILABLE") return "DATA_UNAVAILABLE";
  if (upper.includes("QUORUM") || upper === "QUORUM_NOT_MET") return "QUORUM_NOT_MET";
  if (upper.includes("FUTURE") || upper === "FUTURE_HORIZON") return "FUTURE_HORIZON";
  if (upper.includes("STALE") || upper === "ABSOLUTE_STALE") return "ABSOLUTE_STALE";
  // Default to DATA_UNAVAILABLE for unknown
  return "DATA_UNAVAILABLE";
}

/**
 * Core edge state machine — pure function, no DB
 */
export function computeEdgeTransition(opts: {
  previousStateRow: StrategySignalStateRow | null;
  currentAggregate: AggregateState | string;
  currentCandleTime: Date;
  emitOnBootstrap?: boolean; // default false
}): EdgeTransition {
  const { previousStateRow, currentCandleTime, emitOnBootstrap = false } = opts;
  const currentAggregate = normalizeAggregate(opts.currentAggregate as string);

  const previousState = previousStateRow ? (normalizeAggregate(previousStateRow.aggregateState) as AggregateState) : null;
  const lastEvaluated = previousStateRow?.lastEvaluatedCandleTime || null;
  const previousLastEvalStatusRaw = previousStateRow?.lastEvaluationStatus || null;
  const previousLastEvalStatus: AggregateState | null = previousLastEvalStatusRaw ? normalizeAggregate(previousLastEvalStatusRaw) : null;

  // Same-horizon handling with provisional/unavailable semantics — FIX for production bug 16:15 QUORUM_NOT_MET -> SHORT
  // If lastEvaluated == currentCandleTime:
  //   - If previous evaluation was provisional/unavailable (QUORUM_NOT_MET, DATA_UNAVAILABLE, CANNOT_EVALUATE, FUTURE_HORIZON, ABSOLUTE_STALE)
  //     and current is evaluable (NEUTRAL/LONG/SHORT), MUST re-evaluate (do NOT NOOP)
  //   - Otherwise same horizon is already finalized/evaluable or repeated unavailable => NOOP
  if (lastEvaluated && currentCandleTime.getTime() === lastEvaluated.getTime()) {
    const prevWasUnavailable = previousLastEvalStatus ? isUnavailable(previousLastEvalStatus) : false;
    const currIsUnavailable = isUnavailable(currentAggregate);

    if (prevWasUnavailable && !currIsUnavailable) {
      // Allow re-evaluation: provisional 16:15 QUORUM_NOT_MET -> evaluable 16:15 SHORT must be processed
      // Do NOT return NOOP, continue to normal transition logic
    } else {
      // Cases:
      // - evaluable -> evaluable same horizon => already finalized, NOOP
      // - unavailable -> unavailable same horizon => already attempted provisional, NOOP to avoid churn (preserves previous preserved aggregate)
      // - evaluable -> unavailable same horizon => finalized should not be overwritten by provisional, NOOP (preserves finalized)
      return {
        previousState,
        currentAggregate,
        currentCandleTime,
        action: "NOOP_SAME_HORIZON",
        shouldEmit: false,
        emitDirection: null,
        triggerType: null,
        reason: `Idempotent no-op: lastEvaluated ${lastEvaluated.toISOString()} == current ${currentCandleTime.toISOString()} prevEvalStatus=${previousLastEvalStatus ?? "null"} curr=${currentAggregate} (prevWasUnavailable=${prevWasUnavailable})`,
      };
    }
  }

  // Older horizon refused — provisional does NOT advance finality beyond its horizon? But lastEvaluated is max attempted horizon, so older still refused
  if (lastEvaluated && currentCandleTime.getTime() < lastEvaluated.getTime()) {
    return {
      previousState,
      currentAggregate,
      currentCandleTime,
      action: "REFUSE_OLDER_HORIZON",
      shouldEmit: false,
      emitDirection: null,
      triggerType: null,
      reason: `Refuse regression: current ${currentCandleTime.toISOString()} < lastEvaluated ${lastEvaluated.toISOString()}`,
    };
  }

  // Data failure semantics: unavailable must preserve last directional/re-arm state, not convert to NEUTRAL
  if (isUnavailable(currentAggregate)) {
    return {
      previousState,
      currentAggregate,
      currentCandleTime,
      action: "PRESERVE_UNAVAILABLE",
      shouldEmit: false,
      emitDirection: null,
      triggerType: null,
      reason: `Unavailable ${currentAggregate} preserves last state ${previousState ?? "null"} — no re-arm, no emit`,
    };
  }

  // Bootstrap semantics
  if (previousState === null) {
    if (isDirectional(currentAggregate)) {
      if (emitOnBootstrap) {
        return {
          previousState: null,
          currentAggregate,
          currentCandleTime,
          action: "EMIT",
          shouldEmit: true,
          emitDirection: currentAggregate as "LONG" | "SHORT",
          triggerType: "BOOTSTRAP",
          reason: `Bootstrap with emit-on-bootstrap: no previous state + current ${currentAggregate} => EMIT ${currentAggregate} (BOOTSTRAP)`,
        };
      } else {
        return {
          previousState: null,
          currentAggregate,
          currentCandleTime,
          action: "BOOTSTRAP_NO_SIGNAL",
          shouldEmit: false,
          emitDirection: null,
          triggerType: null,
          reason: `Bootstrap without signal: no state + current ${currentAggregate} => BOOTSTRAP ${currentAggregate} NO SIGNAL (wait for NEUTRAL->${currentAggregate} or reversal)`,
        };
      }
    } else {
      // NEUTRAL bootstrap
      return {
        previousState: null,
        currentAggregate,
        currentCandleTime,
        action: "BOOTSTRAP_NO_SIGNAL",
        shouldEmit: false,
        emitDirection: null,
        triggerType: null,
        reason: `Bootstrap NEUTRAL: no state + current NEUTRAL => state only, no signal`,
      };
    }
  }

  // Normal transitions from existing state
  // NEUTRAL -> LONG/SHORT = EMIT
  if (isNeutral(previousState!) && isDirectional(currentAggregate)) {
    return {
      previousState,
      currentAggregate,
      currentCandleTime,
      action: "EMIT",
      shouldEmit: true,
      emitDirection: currentAggregate as "LONG" | "SHORT",
      triggerType: "EDGE",
      reason: `EDGE: ${previousState} -> ${currentAggregate} => EMIT ${currentAggregate}`,
    };
  }

  // LONG->LONG, SHORT->SHORT = HOLD
  if (previousState === currentAggregate && isDirectional(currentAggregate)) {
    return {
      previousState,
      currentAggregate,
      currentCandleTime,
      action: "HOLD",
      shouldEmit: false,
      emitDirection: null,
      triggerType: null,
      reason: `HOLD: ${previousState} -> ${currentAggregate} same direction => NO EMIT`,
    };
  }

  // LONG->NEUTRAL, SHORT->NEUTRAL = RE-ARM
  if (isDirectional(previousState!) && isNeutral(currentAggregate)) {
    return {
      previousState,
      currentAggregate,
      currentCandleTime,
      action: "REARM",
      shouldEmit: false,
      emitDirection: null,
      triggerType: null,
      reason: `RE-ARM: ${previousState} -> NEUTRAL => RE-ARM, next ${previousState} will emit`,
    };
  }

  // LONG->SHORT, SHORT->LONG = REVERSAL EMIT
  if (isDirectional(previousState!) && isDirectional(currentAggregate) && previousState !== currentAggregate) {
    return {
      previousState,
      currentAggregate,
      currentCandleTime,
      action: "EMIT",
      shouldEmit: true,
      emitDirection: currentAggregate as "LONG" | "SHORT",
      triggerType: "REVERSAL",
      reason: `REVERSAL: ${previousState} -> ${currentAggregate} => EMIT ${currentAggregate} reversal`,
    };
  }

  // NEUTRAL->NEUTRAL = HOLD (stay neutral)
  if (isNeutral(previousState!) && isNeutral(currentAggregate)) {
    return {
      previousState,
      currentAggregate,
      currentCandleTime,
      action: "HOLD",
      shouldEmit: false,
      emitDirection: null,
      triggerType: null,
      reason: `HOLD NEUTRAL: ${previousState} -> ${currentAggregate}`,
    };
  }

  // Fallback — should not happen, but preserve
  return {
    previousState,
    currentAggregate,
    currentCandleTime,
    action: "HOLD",
    shouldEmit: false,
    emitDirection: null,
    triggerType: null,
    reason: `Fallback HOLD: ${previousState} -> ${currentAggregate}`,
  };
}

/**
 * For historical edge replay: build episodes
 */
export type Episode = {
  episode: number;
  startCandle: Date;
  direction: "LONG" | "SHORT";
  endRearmCandle: Date | null; // when NEUTRAL re-arms, or next reversal
  durationBars: number | null;
  peakScore: number | null;
  confirmationMin: string | null;
  confirmationMax: string | null;
  triggerType: TriggerType;
};

export function buildEpisodesFromTransitions(transitions: Array<{ candleTime: Date; aggregate: AggregateState; score: number | null; confirmation: string | null; action: EdgeAction; emitDirection: "LONG" | "SHORT" | null }>): Episode[] {
  const episodes: Episode[] = [];
  let currentEpisode: Episode | null = null;
  let episodeIdx = 0;

  for (const t of transitions) {
    if (t.action === "EMIT" && t.emitDirection) {
      // Close previous episode if exists
      if (currentEpisode) {
        currentEpisode.endRearmCandle = t.candleTime; // reversal closes previous
        // duration will be computed later
        episodes.push(currentEpisode);
      }
      episodeIdx++;
      currentEpisode = {
        episode: episodeIdx,
        startCandle: t.candleTime,
        direction: t.emitDirection,
        endRearmCandle: null,
        durationBars: null,
        peakScore: t.score,
        confirmationMin: t.confirmation,
        confirmationMax: t.confirmation,
        triggerType: t.candleTime ? ("EDGE" as any) : null,
      };
    } else if (t.action === "REARM" && currentEpisode) {
      currentEpisode.endRearmCandle = t.candleTime;
      // compute duration
      if (currentEpisode.startCandle && t.candleTime) {
        const tfMs = 15 * 60 * 1000; // assume 15m for now, should be param
        currentEpisode.durationBars = Math.round((t.candleTime.getTime() - currentEpisode.startCandle.getTime()) / tfMs);
      }
      episodes.push(currentEpisode);
      currentEpisode = null;
    } else if (currentEpisode) {
      // Update peak score and confirmation
      if (t.score != null && (currentEpisode.peakScore == null || t.score > currentEpisode.peakScore)) {
        currentEpisode.peakScore = t.score;
      }
      // confirmation min/max tracking simplified
    }
  }

  if (currentEpisode) {
    episodes.push(currentEpisode);
  }

  return episodes;
}
