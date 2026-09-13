# PHASE 2B — Common Horizon Policy: STRICT vs QUORUM

## Existing STRICT contract (Phase 3E, lib/strategies/common-horizon.ts)

**Problem solved:** OHLCV worker ingests 5 exchanges sequentially (~15s per pass). DB's latest CLOSED per exchange depends on slot, not UTC grid. Without common horizon, concurrent read sees BINANCE at T while others at T+5m → MISALIGNED.

**STRICT algorithm:**

1. Exchange eligibility (BINGX 1d excluded)
2. Strategy filters (top500Only, volume) — filtered markets NOT participants, don't veto
3. For each participant, build Set of canonical CLOSED timestamps (closed=true, aligned to UTC grid)
4. Intersection over ALL participants → latest common timestamp H = max(intersection)
5. Freshness: relative lag = newestHorizon - H ≤ 3 bars, absolute lag = expectedLatestClosed - H ≤ 1 bar
6. Truncate each to H, evaluate at H, gate via alignment + anchor

**Participant set veto:** If any participant has no CLOSED data → DATA_UNAVAILABLE, entire asset unusable. If no intersection → NO_COMMON_HORIZON. If lag > bounds → RELATIVE_LAG_STALE or ABSOLUTE_STALE.

**Example:**
- 4 exchanges fresh at T=09:50, GATE lagging at T-1=09:45
- Intersection = T-1 (since GATE doesn't have T)
- H = 09:45, lagBars=1, status ok → signal delayed by 1 bar (causal-safe but delayed)
- If GATE lagging 4 bars (T-4), lagBars=4 > 3 → RELATIVE_LAG_STALE → NO SIGNAL, even though 4 exchanges have fresh T.

**Pros:** Fail-closed, no silent stale fallback, simple.
**Cons:** Availability suffers: one lagging exchange can delay or block entire asset, even when minExchanges=3 would be satisfied by fresh 4.

---

## Proposed QUORUM policy (lib/strategies/common-horizon-quorum.ts)

**Causal model:**

- `expectedLatestClosed = floor(now / D) * D - D` — deterministic from wall clock, same as STRICT's expected.
- For each market, determine latest canonical CLOSED and whether it has expected timestamp.
- Fresh = latest == expected AND hasExpected
- Stale = otherwise (lagging, missing expected, no data, future)
- Common horizon H = expectedLatestClosed (not intersection) when freshCount >= minExchanges
- Stale markets SKIPPED, not veto.
- Subset determined ONLY by availability/freshness BEFORE evaluateSmc, never by score/direction → no selection bias.

**Example same as above:**
- 4 fresh at T=09:50, GATE lagging at 09:45
- Fresh = 4 (BINANCE,BYBIT,KUCOIN,BINGX), Stale = 1 (GATE)
- freshCount=4 >= minExchanges=3 → status ok, H=T=09:50 (fresh, not delayed)
- GATE skipped, doesn't vote, doesn't rollback.

**If freshCount < minExchanges:**
- e.g., 2 fresh, 3 stale, minExchanges=3 → QUORUM_NOT_MET → NO SIGNAL
- Reason: INSUFFICIENT_EVALUATED_EXCHANGES

**Future handling:**
- If latest > expected (future CLOSED), market is stale, not fresh. If all are future → FUTURE_HORIZON.

**Absolute staleness:**
- If freshCount==0 and all stale with old data → DATA_UNAVAILABLE or QUORUM_NOT_MET.

**Pros:**
- Fresh signals (no delay) when quorum met
- Higher availability: one lagging exchange doesn't block
- No selection bias: exclusion only on objective availability, not score
- Matches intuition of minExchanges: we need 3 fresh exchanges at T, not all 5.

**Cons:**
- Slightly more complex: need to define expected T from now, not just intersection
- Need to ensure now is injected, not wall-clock inside pure layer (already done)
- Need to handle marketsWithoutData as stale, not fatal, when quorum met

---

## Comparison table

| Scenario | STRICT H | STRICT status | QUORUM H | QUORUM status | QUORUM fresh/stale |
|---|---|---|---|---|---|
| 5 fresh at T | T | ok | T | ok | 5/0 |
| 4 fresh T + 1 lag T-1, minEx=3 | T-1 | ok (delayed) | T | ok | 4/1 |
| 4 fresh T +1 lag T-4, minEx=3, relativeMax=3 | null | relative_lag_stale | T | ok | 4/1 (lagging skipped) |
| 2 fresh T +3 lag T-1, minEx=3 | T-1 | ok | null | quorum_not_met | 2/3 |
| All stale, no data | null | data_unavailable | null | data_unavailable | 0/5 |
| All future | null | future_horizon | null | future_horizon | 0/5 |

---

## Recommendation for production Smart Money

**Prefer QUORUM** for production Smart Money because:

- BTC has 5 exchanges, minExchanges=3. Requiring all 5 to be fresh is stricter than minExchanges semantics.
- Ingestion pass skew (15s) means at any moment one exchange may be 1 bar behind. STRICT delays signal by 1 bar, QUORUM gives fresh T with 4 votes.
- No selection bias: we don't pick subset by direction, only by freshness.
- Causal-safe: H = expectedLatestClosed from wall clock, not from data, so no lookahead. Fresh check is objective.
- Still fail-closed when quorum not met.

**Implementation in PHASE 2B:**

- `selectQuorumClosedHorizon()` implemented in `common-horizon-quorum.ts`
- `buildSmartMoneySignalCandidate()` supports both policies, default QUORUM
- `signal-worker --common-horizon-policy=STRICT|QUORUM` allows comparison
- Tests cover both policies

**Migration path:**

- Keep STRICT for existing trend-suslik (uses IndicatorSnapshot, not affected)
- For smart-money, use QUORUM as default, log both for monitoring during rollout
- If QUORUM shows unexpected behavior, can fallback to STRICT via flag without code change

---

## Tests

- `test-phase2b.ts` section 1 compares STRICT vs QUORUM on same data
- `test-common-horizon.ts` existing 227 tests still green for STRICT
- New quorum tests: freshCount, staleCount, quorum_not_met, future_horizon, data_unavailable
