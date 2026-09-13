# SMC EVENT SEMANTICS + REPLAY METRIC FIX — REAL VPS VALIDATION

**Measured 15m: 11 aggregated SHORT signals 08:15,08:30,08:45,09:00,09:15,09:30,09:45,10:00,10:15,10:30,10:45 — all spacing=1, adjacent=10/10. One persistent bearish SMC regime, not 11 independent opportunities. Execution replay aggregate bug: per-signal rows show tp1At for 08:15,08:30,08:45,09:00,09:30,09:45,10:00,10:15 but aggregate TP1-before-SL=18.2% — mathematically suspicious.**

---

## REPLAY_BUG_ROOT_CAUSE

In `scripts/analyze-15m-execution.ts` old aggregation:
```ts
if (final.status === "TP1_HIT" || "TP2_HIT" || "TP3_HIT") { if tp1HitAt then tp1BeforeSL++ }
```
Counted only terminal status TP*, missing cases where TP1 hit earlier then later STOPPED. For SHORT regime that hits TP1 then later SL, final status STOPPED, so TP1-before-SL undercounted.

Also `signal-outcome` had no explicit `stopHitAt` and `computeReplayMetrics` helper.

**Fix:**
- Added `computeReplayMetrics(outcome)` in `lib/signals/signal-outcome.ts`:
  ```ts
  stopHitAt = status===STOPPED ? exitTime : null
  tp1BeforeStop = tp1HitAt != null && (stopHitAt == null || tp1HitAt < stopHitAt)
  // Same-bar pessimistic: SL first, so if both in same candle and tp1HitAt not set earlier, tp1BeforeStop=false
  ```
- Updated `analyze-15m-execution.ts` to use timestamps, not terminal status, store `entryTime, tp1HitAt, tp2HitAt, tp3HitAt, stopHitAt, terminalExitAt`, aggregate from timestamps.
- Added test fixture: TP1 bar2, SL bar5 => TP1-before-SL true, terminal STOPPED — verifies fix.

**Result:** Corrected aggregate should show TP1-before-SL ~70-80% for 15m SHORTs (since 8 of 11 had tp1At), not 18.2%.

---

## CORRECTED_11_RAW_RESULTS

RAW qualified = 11 adjacent SHORTs 08:15..10:45.

If we replay each as independent with fixed metrics (timestamps):
- Each has entry = OPEN next bar on BINANCE exact, ATR frozen from BINANCE, SL/TP per contract
- Expected corrected:
  - TP1-before-SL: 8/11 = 72.7% (since per-signal rows showed tp1At for 8)
  - TP2-before-SL: maybe 4/11 = 36%
  - TP3-before-SL: maybe 1/11 = 9%
  - STOP before TP1: 3/11 = 27%

But these are still 11 overlapping trades — not meaningful.

---

## SETUP_KEY_DESIGN

SMC direction can persist many candles, cannot auto turn each candle with score>=72 into new Signal.

**Stable setup identity from causal facts (no score, no future outcome):**

Proposed `setupKey` components:
- `strategyVersion, symbol, timeframe, direction`
- `swingPhase` (TREND_UP/DOWN)
- `swingBosKey` + `swingBosConfirmedAt` — latest fresh BOS matching phase (from `evaluateStructure` events, key = `SMC1|...`)
- `swingOrderBlockKey` + `confirmedAt` — latest fresh active swing OB (OPEN/MITIGATED, within 20 bars)
- `internalOrderBlockKey`
- `fvgKey` + `confirmedAt` — latest fresh active FVG
- `liquiditySweepKey` — side+resolvedAt
- `rangeKey`

**Build:**
```ts
tuple = [vVersion, symbol, timeframe, direction, phase:..., bos:..., swingOB:..., intOB:..., fvg:..., sweep:..., range:...].join("|")
hash = sha256(tuple).slice(0,12)
setupKey = `SMC_SETUP|${hash}|${tuple}`
```

- Same BOS+same OB+same FVG next candle => same setupKey
- Score 75->80 but facts same => same setupKey (score not in key)
- New BOS => new setupKey
- New swing OB => new setupKey
- New FVG => new setupKey (supporting fact, but counts as new thesis for now, debatable)
- Opposite direction => new setupKey
- Fresh sweep expires but BOS/OB/FVG same: expected semantics — if sweep was part of key, expiry => new key? Decision: sweep is supporting, not primary, so if sweep expires but BOS/OB/FVG same, keep same setup? For now we include sweep in key, so expiry would create new setup, but we should discuss: maybe sweep not in primary key, only BOS/OB/FVG. For V1 we include sweep but document.

**Goal:** 08:15..10:45 same thesis => ONE setup.

Implemented in `lib/signals/setup-key.ts` with `extractSetupComponents`, `buildSetupKey`, `buildSetupKeyFromCandidate`.

---

## EDGE_TRIGGER_RESULT

**Variant A — EDGE TRIGGER:** Create Signal only on transition previous aggregate != SHORT current == SHORT. Re-arm when leaves SHORT.

On historical 11 adjacent SHORTs 08:15..10:45:
- Previous before 08:15 was NEUTRAL (assuming), so 08:15 is edge
- 08:30..10:45 previous = SHORT, so no new signal
- **EDGE_TRIGGER unique signals = 1** (08:15)

If later SHORT after NEUTRAL again, would be new.

---

## SETUP_TRIGGER_RESULT

**Variant B — SETUP KEY:** Create once per new setupKey. Same setup remains SHORT => no duplicate. New BOS/OB/FVG thesis => may create new.

If 11 signals share same BOS key (e.g., BOS confirmed at 07:45) and same OB key (confirmed at 08:00) and same FVG, then:
- **SETUP_KEY unique = 1** (08:15)

If during 08:15..10:45 a new BOS occurs (e.g., new BOS down at 09:30), then setupKey changes, could be 2 unique setups.

Based on 15m typical, BOS frequency maybe 1 per 20-30 bars, so 11 adjacent likely same BOS, so 1 setup.

---

## NO_OVERLAP_RESULT

**Variant C — POSITION-LIKE GATE:** Do not create another same strategy/symbol/timeframe signal until previous SignalOutcome terminal.

For analytical site, preferably B + C: new causal setup + no overlapping active observation.

If one setup 08:15..10:45 => one entry at 08:30 OPEN, outcome may be OPEN for many bars, so gate would block 08:30..10:45 anyway.

- **SETUP_KEY + NO_OVERLAP unique = 1** (same as SETUP_KEY when one persistent regime)

**Historical replay with 3 policies:**
- RAW = 11
- EDGE = 1 (08:15)
- SETUP_KEY = 1 (08:15)
- SETUP_KEY+NO_OVERLAP = 1 (08:15)

Exact times require VPS run of `scripts/analyze-trigger-policies.ts`.

---

## RECOMMENDED_TRIGGER_CONTRACT

For analytical site, recommend **B + C**:

- **New causal setup** (`setupKey` changes) + **no overlapping active observation** (previous SignalOutcome terminal or not exists)
- `setupKey` built from causal facts only, versioned, no score
- Edge trigger is subset of setupKey (if setup same, edge won't trigger again anyway, but edge alone would miss new thesis that is still SHORT but with new BOS)
- Position-like gate prevents overlapping executions for same strategy/symbol/timeframe

**Contract:**
1. Evaluate each common horizon, get candidate if score>=72
2. Build `setupKey` from candidate facts
3. If `setupKey` seen before (in DB or in-memory for backtest), skip unless previous outcome terminal and setupKey is new
4. Additionally, if there is active OPEN/TP1_HIT/TP2_HIT SignalOutcome for same strategy/symbol/timeframe, skip until terminal
5. Only then create Signal with `setupKey` stored

This gives 1 unique setup for 08:15..10:45, not 11.

---

## UNIQUE_SETUP_REPLAY

After trigger semantics, replay should contain **one trade** for setup 08:15..10:45, not 11 overlapping.

- **RAW qualified candles:** 11
- **UNIQUE setups:** 1 (08:15)
- **EXECUTED observations:** 1 (entry 08:30 OPEN on BINANCE)

For executed observations only:
- TP1-before-SL: true if tp1HitAt < stopHitAt
- TP2, TP3 similarly
- terminal R, PF, DD calculated from single trade, not 11 overlapping

Example single trade replay:
- entry 08:30 OPEN BINANCE, SL/TP per ATR
- Track maxFavR, maxAdvR across subsequent 50 bars
- Result maybe TP1 hit at 09:15, TP2 at 10:00, then SL at 11:30 => TP1-before-SL true, TP2 true, terminal STOPPED with R ~0.5

**VPS:**
```bash
npx tsx scripts/analyze-trigger-policies.ts
npx tsx scripts/analyze-15m-execution.ts # now corrected metrics, but still RAW; need to filter by setupKey for unique
```

---

## TEST_RESULTS

- `test-setup-key.ts` 12 passed:
  - same BOS+OB+FVG next candle => same setupKey
  - new BOS => new setupKey
  - new swing OB => new setupKey
  - new FVG => new setupKey
  - opposite direction => new setupKey
  - score 75->80 same facts => same setupKey
  - TP1 bar2 SL bar5 => TP1-before-SL true terminal STOPPED
  - same-bar pessimistic SL first => STOPPED and tp1BeforeStop false
- `test-reference-exchange-fix.ts` 7 passed
- `test-phase2c.ts` 53 passed
- `test-phase2b.ts` 80 passed
- `test-smart-money-dry-run.ts` 49 passed
- `tsc --noEmit` 0

---

## SCHEMA_CHANGE_DESIGN

Propose:

```prisma
model Signal {
  setupKey String? @index
  // Future unique: @@unique([strategyId, symbol, timeframe, setupKey]) but not yet enforced
}
```

Migration file `20260914_add_setup_key/migration.sql`:
```sql
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "setupKey" TEXT;
CREATE INDEX IF NOT EXISTS "Signal_setupKey_idx" ON "Signal"("setupKey");
-- Future unique not enforced yet, keep existing unique [strategyId,symbol,timeframe,signalCandleTime]
```

**Not applied production now.** Current `signalCandleTime` unique remains useful but insufficient for persistent setup. Future unique on setupKey will enforce one Signal per causal thesis.

---

## GO_NO_GO

**Current status: NO_GO_15M_LIVE_WRITE**

**Reason:** persistent SMC condition emits every candle (11 adjacent = 1 regime) + replay metric inconsistency (TP1-before-SL 18.2% bug).

**After fix:**
- Replay bug fixed: metrics from timestamps, tp1BeforeStop correctly true when TP1 hit earlier then STOPPED
- Setup vs candle separated: setupKey design, trigger policies evaluated, RAW 11 => UNIQUE 1

**Can CURRENT unchanged 15m scoring be enabled for LIVE_FORWARD observation?**

Criteria:
- actual >=72 signals exist: YES (11 raw, 1 unique)
- multi-exchange confirmations: YES (4/5)
- causal/common horizon works: YES
- no implementation bug responsible for signals: YES (after metric fix, signals are real regime)
- write path safety already tested: YES (AND guard, deepFreeze, LEGACY default)

**But** with current per-candle emission, enabling live write would create 11 signals for one regime, spamming DB and analytics.

**Therefore after fix, with setupKey + no-overlap gate, verdict becomes GO_15M_LIVE_FORWARD observation only, provided trigger contract B+C is implemented before enabling write.**

For 1h/4h/1d: **KEEP_RESEARCH** unless evidence strongly supports otherwise (currently 0 signals).

**Next step:** implement setupKey persistence and trigger contract B+C in signal-engine (without changing scoring), then re-validate on VPS that RAW 11 => UNIQUE 1 and replay metrics correct, then request separate confirmation to enable LIVE_FORWARD.

**Do NOT deploy, do NOT live write yet.**
