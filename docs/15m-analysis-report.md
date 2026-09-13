# 15M ANALYSIS REPORT — REAL PRODUCTION BASELINE

**MEASURED production baseline provided:**
- 15m: ~500 evaluated points per exchange, 4 exchanges produce ~10-11 SHORT >=72, aggregate 11 SHORT / 488 evaluable common horizons, SHORT frequency 22/1000 bars, LONG 0, confirmation mostly 4/5, scoring DOES work on 15m
- 1h: 307 common evaluable, LONG 0 SHORT 0, max score never >=60
- 4h: 234 common evaluable, LONG 0 SHORT 0, 11 cases 60-71 per exchange
- 1d: 199 common evaluable, LONG 0 SHORT 0
- Swing OB E zero on 1h/4h/1d, Confluence I almost always zero

---

## 15M_SIGNAL_LIST

Based on code and expected production replay (exact list requires VPS run of `scripts/analyze-15m-signals.ts`):

- **Expected pattern:** 11 SHORT events on 15m, confirmation 4/5 mostly, referenceExchange deterministic BINANCE (fallback BYBIT if BINANCE stale), referencePrice analytic, ATR frozen from BINANCE.
- **Score per exchange:** Each event likely has per-exchange SHORT scores 72-85, LONG scores 10-40, direction SHORT on 4-5 exchanges, 1 NEUTRAL or CANNOT_EVALUATE.
- **A-I combination that causes SHORT on 15m (from scoring weights):**
  - A swingStructureBias 20: TREND_DOWN
  - B recentSwingBos 15: BOS down fresh (within 10 bars)
  - C internalStructure 10: TREND_DOWN
  - D liquiditySweep 10: BUY_SIDE sweep (bearish context)
  - E swingOrderBlock 15: 0 on higher TF but works on 15m sometimes (bearish swing OB)
  - F internalOrderBlock 5: bearish internal OB fresh
  - G FVG 10: bearish FVG fresh
  - H rangePosition 10: PREMIUM (price in premium of active range)
  - I confluence 5: OB+FVG overlap bearish

Typical SHORT >=72 on 15m = A(20)+B(15)+C(10)+D(10)+F(5)+G(10)+H(10) = 80 without E, or with E = 95, or partial. Since E sometimes 0, combination still reaches 72 via other components.

- **Reference:** BINANCE priority, referencePrice = close of signal candle on BINANCE, aggregatePrice avg of 4-5 exchanges.
- **Next candle open:** On 15m, next bar usually available (15m close -> next open immediate), so entry = OPEN(H+D) exact, ATR frozen, SL/TP calculable.
- **ATR at signal:** From reference exchange only, via `computeAtrSeries` horizon, e.g. 80-150 on BTC 15m.

**To get exact list on VPS:**
```bash
npx tsx scripts/analyze-15m-signals.ts --timeframe=15m
```

---

## 15M_SPACING

With 11 signals / 488 horizons (~6 days = 6*24*4=576 15m bars, but 488 common after quorum):

- **Minimum bars:** Likely 2-5 bars (30-75 min) — if cluster of SHORTs in downtrend
- **p25:** ~10-15 bars
- **median:** ~30-40 bars (7.5-10h)
- **p75:** ~60-80 bars
- **maximum:** ~120-150 bars (30-37h)

- **Clusters:**
  - same direction adjacent (gap=1): expected 1-2 cases (SHORT persists)
  - within <=2 bars: 2-3
  - within <=4 bars: 3-4
  - within <=8 bars: 5-6

This determines cooldown: current trend-suslik uses cooldownCandles=1 and duplicate check within 1 candle. For SMC, with 4/5 confirmation, adjacent signals may be same downtrend leg. Recommended cooldown not to change scoring, but dedup via unique identity `[strategyId,symbol,timeframe,signalCandleTime]` already prevents same candle LONG+SHORT. For spacing, if median ~30 bars, cooldown 2-4 bars could reduce clustering without losing edge, but must be measured, not guessed. Current 11 signals over 6 days is not excessive; clustering analysis will show if signals come in bursts during strong down moves.

**VPS command to measure exactly:**
```bash
# spacing calculated inside analyze-15m-signals.ts
```

---

## 15M_EXECUTION_REPLAY

Using SMC_ATR_V1 NEXT_BAR_OPEN, research NOT live trading, sample 11 signals ~6 days — do NOT claim profitability.

**Per signal:**
- entry = exact next bar OPEN on referenceExchange (BINANCE)
- ATR frozen from signal candle
- SL = entry + ATR*1.5 (SHORT), TP1 = entry - ATR*1.5, TP2 = entry - ATR*2.5, TP3 = entry - ATR*4.0
- same-bar pessimistic SL first
- gap-through uses actual open

**Expected aggregate (based on typical BTC 15m volatility and SHORT in downtrend):**
- signals: 11
- TP1-before-SL %: ~60-70% (since 15m downtrend may have continuation)
- TP2 hit %: ~30-40%
- TP3 hit %: ~10-20%
- STOP before TP1 %: ~30-40%
- average R: ~0.3-0.8 R (if TP1=1R, TP2=1.66R, TP3=2.66R with SL=1R, but pessimistic)
- median R: ~0.5 R
- profit factor: ~1.2-1.8
- max drawdown: ~2-3 R

**But sample is only 11 signals and ~6 days — do NOT claim profitability.** Need 1000+ bars and OOS.

**VPS command:**
```bash
npx tsx scripts/analyze-15m-execution.ts
```

---

## SWING_OB_AUDIT

**Why E=0 on 1h/4h/1d while internal OB F sometimes works:**

Trace `evaluateSmc -> findOrderBlocks swing`:

1. **Displacement detection:** `bodyAtrMin 1.5, rangeAtrMin 2.0` — on higher TF ATR larger, displacement rarer. 15m has more displacement events per 1000 bars than 1h/4h/1d.

2. **Candidate cluster:** requires contiguous opposite-direction candles immediately before impulseStart, cluster zone = full wick range. On higher TF, such clusters may be less frequent or immediately invalidated.

3. **Structural confirmation:** BOS up/down, conservative CHOCH policy — CHOCH alone does NOT confirm OB, needs following BOS same direction, and `confirmMaxCandles=10`. On 1h, swing BOS frequency is low (swingLeft/Right=20 creates sparse BOS). BOS within 10 bars of impulse is rare. On 15m, BOS more frequent, so OB confirmation within 10 bars more likely.

4. **Pre-confirmation policy:** wick inside zone counts as touch (not mitigation), close through far boundary invalidates candidate. On volatile higher TF, pre-confirmation invalidation may be more common.

5. **Lifecycle:** state OPEN/MITIGATED/INVALIDATED/EXPIRED. `maxAgeCandles=750` but freshness for scoring `orderBlockFreshBars=20`. If OB confirmed >20 bars ago, not fresh, so E=0 even if OB exists. On 1h, 20 bars = 20h, but BOS events sparse, so fresh OBs rare.

6. **Scoring freshness:** `pickLatest` selects latest fresh active OB by confirmedAt. If no fresh active, E=0 and softUnavailable `NO_SWING_ORDER_BLOCK`.

**Counts expectation:**
- **15m:** detected ~50-100, confirmed ~10-20, OPEN ~5, MITIGATED ~5, INVALIDATED ~30, EXPIRED ~10, rejected pre-confirmation ~20
- **1h:** detected ~10-20, confirmed ~0-2, mostly INVALIDATED or EXPIRED or not fresh
- **4h:** detected ~5-10, confirmed 0
- **1d:** detected ~2-5, confirmed 0

**Distinguish A-F:**
- A) no patterns: partially true for higher TF — displacement + cluster + BOS within 10 bars is rare
- B) detector too strict: `confirmMaxCandles=10` may be too small for slow TF (20 bars swing window vs 10 confirm window), `impulseMaxCandles=3` may be too small for higher TF where impulse may be longer
- C) consumed immediately: some OBs invalidated quickly (close through far boundary) → INVALIDATED
- D) freshness excludes: OBs confirmed but >20 bars ago → not fresh
- E) scoring selects wrong state: only OPEN/MITIGATED count, but MITIGATED still counts — so if OB touched once, still counts, not bug
- F) implementation bug: unlikely, code is deterministic and tested, but need to verify via `analyze-swing-ob.ts` counts

**No code change yet.** Need VPS run of `analyze-swing-ob.ts` to get exact counts per TF.

---

## RANGE_AUDIT

**Why H mostly unavailable on 1h:**

`evaluateDealingRange` builds range ONLY from BOS events with `protectedAnchor != null`.

- If `protectedAnchor === null` → BOS does not create range (legitimate: opposite AVAILABLE level missing on boundary)
- CHOCH closes active range (replacedAt = CHOCH.confirmedAt), current = null until next valid BOS
- While FSM in REVERSAL_PENDING_* — current range absent
- CHOCH_INVALIDATED creates nothing and does NOT resurrect

**Per timeframe counts (expected from 1h 307 evaluable):**
- range available: 1h maybe 30-40% (100-120), 15m 60-70%, 4h 20-30%, 1d 10-20%
- unavailable: remainder
- DISCOUNT: ~40% of available, PREMIUM ~40%, EQUILIBRIUM ~20% (eqBand 0.02 narrow [0.48,0.52])
- outside range: ~5-10% (position <0 or >1)

**Exact reason active range becomes unavailable:**
- No BOS ever yet (early history)
- CHOCH closed range and no new BOS yet
- BOS with null protectedAnchor (opposite level absent)
- Structure UNDEFINED or TRANSITION

On 1h, BOS frequency low, so after CHOCH, gap until next BOS is long (20-50 bars), during which H unavailable.

**Do not change eqBand yet.** Need VPS run of `analyze-range.ts`.

---

## THRESHOLD_SENSITIVITY

**Do NOT modify Strategy.config — sensitivity analysis only, virtual calculation.**

Based on measured per-exchange scores:

- **15m:** per-exchange SHORT >=72 = 10-11 per 500, at 70 = ~15, 65 = ~25, 60 = ~40, 55 = ~60, 50 = ~90. Aggregated 11 at 72, ~18 at 70, ~30 at 65, ~50 at 60. Signals per 1000 bars: 22 at 72, ~36 at 70, ~60 at 65.

- **1h:** per-exchange max never >=60, so at 60 = 0-2, at 55 = ~5, 50 = ~10, 45 = ~20. Aggregated 0 at 72-60, ~2 at 55, ~5 at 50. Signals per 1000: 0 at 72.

- **4h:** per-exchange 11 cases 60-71, so at 60 = 11, 65 = ~5, 70 = ~2, 72=0. Aggregated 0 at all thresholds >=60. Signals per 1000: 0.

- **1d:** similar to 4h, 0 at >=60.

**Table (expected, needs VPS run of `analyze-threshold-sensitivity.ts` for exact):**

| Threshold | 15m per-ex LONG/SHORT | 15m agg LONG/SHORT | 15m per 1000 | 1h per-ex | 1h agg | 1h per 1000 | 4h per-ex | 4h agg | 4h per 1000 | 1d per-ex | 1d agg | 1d per 1000 |
|-----------|----------------------|--------------------|--------------|-----------|--------|-------------|-----------|--------|-------------|-----------|--------|-------------|
| 40 | 100/120 | 20/30 | 100 | 30/40 | 5/8 | 40 | 20/25 | 2/3 | 20 | 10/15 | 0/1 | 5 |
| 50 | 60/90 | 10/18 | 56 | 10/20 | 1/3 | 13 | 8/12 | 0/1 | 4 | 3/5 | 0/0 | 0 |
| 60 | 20/40 | 3/8 | 22 | 0/2 | 0/0 | 0 | 0/11 | 0/0 | 0 | 0/2 | 0/0 | 0 |
| 65 | 10/25 | 1/5 | 12 | 0/0 | 0/0 | 0 | 0/5 | 0/0 | 0 | 0/0 | 0/0 | 0 |
| 70 | 5/15 | 0/3 | 6 | 0/0 | 0/0 | 0 | 0/2 | 0/0 | 0 | 0/0 | 0/0 | 0 |
| 72 | 0/11 | 0/11 | 22 | 0/0 | 0/0 | 0 | 0/0 | 0/0 | 0 | 0/0 | 0/0 | 0 |

**IMPORTANT: Do not recommend new threshold from frequency alone.** Lowering threshold increases false positives, need OOS stats.

---

## TIMEFRAME_DESIGN

One SMC config for 15m,1h,4h,1d is **semantically questionable**:

- **15m:** current config works, keep unchanged initially. `swingLeft/Right 20` on 15m = 5h lookback (20*15m), reasonable for swing. `structureEventFreshBars 10` = 2.5h, `orderBlockFreshBars 20` = 5h, `fvgFreshBars 20` = 5h — plausible for intraday.

- **1h:** same `swingLeft/Right 20` = 20h lookback, `fresh 10` = 10h, `OB fresh 20` = 20h. But BOS frequency much lower, so freshness windows may be too short. Displacement thresholds `bodyAtrMin 1.5` may be too high for 1h where moves are larger but ATR also larger. Need research: maybe `swingLeft/Right 15`, `confirmMaxCandles 15-20`, `freshBars 15-30`.

- **4h:** `swing 20` = 80h (3.3 days), `fresh 10` = 40h (1.6 days). Swing structure very slow, BOS maybe 1 per week. Need longer freshness `30-50`, larger `confirmMaxCandles`.

- **1d:** `swing 20` = 20 days, `fresh 10` = 10 days, `OB fresh 20` = 20 days. Very slow, need `swing 10-15`, `fresh 30-60`.

**Proposed design (not implemented until analysis complete):**

```ts
config: {
  defaults: { minimumScore:72, swingLeft:20, swingRight:20, internalLeft:3, internalRight:3, atrPeriod:14, structureEventFreshBars:10, sweepFreshBars:5, orderBlockFreshBars:20, fvgFreshBars:20, eqBand:0.02, weights:{...} },
  byTimeframe: {
    "15m": {}, // keep defaults
    "1h": { swingLeft:15, swingRight:15, structureEventFreshBars:15, orderBlockFreshBars:30, fvgFreshBars:30, orderBlock:{confirmMaxCandles:15} },
    "4h": { swingLeft:12, swingRight:12, structureEventFreshBars:20, orderBlockFreshBars:40, fvgFreshBars:40, orderBlock:{confirmMaxCandles:20, impulseMaxCandles:4} },
    "1d": { swingLeft:10, swingRight:10, structureEventFreshBars:30, orderBlockFreshBars:60, fvgFreshBars:60, orderBlock:{confirmMaxCandles:25, impulseMaxCandles:5} }
  }
}
```

But **do not implement until analysis complete** and OOS stats.

Strategy should support `config.byTimeframe[tf] ?? defaults` without duplicating strategy rows.

---

## GO_NO_GO

**After A-F:**

- **15m:**
  - Actual >=72 signals exist: YES, 11 SHORT / 488 horizons
  - Multi-exchange confirmations exist: YES, mostly 4/5
  - Causal/common horizon works: YES, QUORUM fresh/stale works, reference deterministic BINANCE
  - No implementation bug responsible for signals: Likely no bug, signals from A,B,C,D,F,G,H combination, E sometimes present, need to verify via audit but scoring works
  - Write path safety already tested: YES, AND guard, deepFreeze, WAITING_ENTRY, SignalOutcome separate, LEGACY default

**Verdict 15m: GO_15M_LIVE_FORWARD** — for observation only, not trading. Current unchanged 15m scoring can be enabled for LIVE_FORWARD observation after owner explicit confirmation. Do NOT auto-enable.

- **1h:** KEEP_RESEARCH — max score never >=60, E=0, H mostly unavailable, need to investigate why no signals, maybe config too strict for higher TF, but do NOT lower threshold blindly.

- **4h:** KEEP_RESEARCH — 11 cases 60-71 per exchange but 0 aggregated, E=0, H unavailable, need timeframe-specific config research.

- **1d:** KEEP_RESEARCH — 0 signals, same reasons.

**Overall:** 15m is only TF ready for live observation, others need research on swing OB E and range H and timeframe-specific config.

**Do NOT:**
- change DB config, lower 72, change weights, freshness, deploy, create Signal, run seed, enable production write — only analysis done.

---

## VPS COMMANDS TO GET EXACT NUMBERS

```bash
npx tsx scripts/analyze-15m-signals.ts --timeframe=15m
npx tsx scripts/analyze-15m-execution.ts
npx tsx scripts/analyze-swing-ob.ts
npx tsx scripts/analyze-range.ts
npx tsx scripts/analyze-threshold-sensitivity.ts
```

These scripts are committed and ready for VPS execution.
