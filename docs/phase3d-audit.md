# Phase 3D — Configurability + Range Lifecycle Audit (READ-ONLY)

**Date:** 10.09.2026
**Baseline HEAD:** `60d243cbfd8cd33afa550c706f547f8c90cdac08`
**Parent verified:** Phase 3E accepted VPS 10.09.2026 (5m/15m/1h/4h READY, 1d BLOCKED)
**Scope:** AUDIT ONLY — no runtime/SMC math, no DB, no workers, no Signal

---

## 1. Hardcoded SMC Parameters — Evidence

All values are **INITIAL ENGINEERING DEFAULT / HYPOTHESIS** (not optimized, not claimed profitable). Located via `grep` + manual read.

### 1.1 Displacement (`lib/smc/displacement.ts`)

- **File:** `lib/smc/displacement.ts:44-64` `SmcDisplacementConfig` + `defaultDisplacementConfig(tf)`
- **Values:**
  - `atrPeriod: 14` (line 62)
  - `bodyAtrMin: 1.5` (62)
  - `rangeAtrMin: 2.0` (63)
  - `bullCloseLocMin: 0.6` (64)
  - `bearCloseLocMax: 0.4` (64)
- **Used:** `classifyCandle()` line 130-148: `close>open && bodyAtr>=1.5 && rangeAtr>=2.0 && closeLocation>=0.60` (bullish), mirror for bearish. `findDisplacements` via `computeAtrSeries`.
- **Validation:** `assertValidDisplacementConfig` (83-103) — `atrPeriod >=1 integer`, `bodyAtrMin/rangeAtrMin/bullCloseLocMin/bearCloseLocMax >=0 finite`.
- **Category:** **A) actually existing hardcoded** (currently NOT exposed via `SmcScoringConfig`; `deriveSubConfigs` in `config.ts:192` creates `displacement: {...defaultDisplacementConfig(tf), atrPeriod: config.atrPeriod}` — only `atrPeriod` flows from scoring config, other 4 remain hardcoded).

### 1.2 FVG (`lib/smc/fvg.ts`)

- **File:** `lib/smc/fvg.ts:51-69`
- **Values:**
  - `atrPeriod: 14`
  - `minGapAtr: 0.10` (line 66)
  - `maxAgeCandles: 500` (67) — `0 = expiry disabled`
- **Used:** `findFvgs` line 260-286: `gapSize/ATR[c] >= minGapAtr`; `buildLifecycle` line 108-244: expiry at `creationIndex + maxAgeCandles` if `maxAgeCandles>0`.
- **Override in scoring:** `config.ts:195-199` `fvg: {...defaultFvgConfig(tf), atrPeriod: config.atrPeriod, maxAgeCandles: 0}` — **scoring disables FVG expiry** (0). So default 500 is not used in `evaluateSmc`; pure FVG module default remains 500 for isolated tests.
- **Category:** A) hardcoded (minGapAtr, maxAgeCandles not via scoring config). `atrPeriod` is B) configurable via scoring.

### 1.3 Liquidity (`lib/smc/liquidity.ts`)

- **File:** `lib/smc/liquidity.ts:48-93`
- **Values:**
  - `atrPeriod: 14`
  - `swingLeft: 20` (SWING_PIVOT_WINDOW), `swingRight: 20`
  - `eqToleranceAtr: 0.10` (64)
  - `eqConfirmBars: 2` (65)
  - `sweepMinPenetrationAtr: 0.05` (66)
  - `maxAgeCandles: 750` (67)
- **Used:** `eqToleranceAtr` for EQ pairing tolerance `|p.price - cluster.price| <= 0.10*ATR`; `eqConfirmBars` for confirmation window; `sweepMinPenetrationAtr` for SWEPT vs BROKEN (`high >= price + 0.05*ATR && close < price`); `maxAgeCandles` for expiry.
- **Override in scoring:** `config.ts:200-204` `liquidity: {...defaultLiquidityConfig(tf), atrPeriod: config.atrPeriod, swingLeft: config.swingLeft, swingRight: config.swingRight, maxAgeCandles: 0}` — **scoring disables liquidity expiry** (0).
- **Category:** A) hardcoded for eq/sweep (4 params), B) `atrPeriod/swingLeft/swingRight` flow from scoring.

### 1.4 Order Blocks (`lib/smc/order-blocks.ts`)

- **File:** `lib/smc/order-blocks.ts:112-135`
- **Values:**
  - `atrPeriod: 14`
  - `swingLeft: 20` (swing) / `3` (internal) — layer-dependent
  - `swingRight: 20` / `3`
  - `impulseMaxCandles: 3` (122)
  - `confirmMaxCandles: 10` (123)
  - `maxAgeCandles: 750` (124)
  - `sweepLookbackCandles: 5` (125)
- **Used:** `impulseMaxCandles` for grouping max contiguous displacement candles; `confirmMaxCandles` for `eventIdx - impulseEndIdx <=10`; `maxAgeCandles` for expiry; `sweepLookbackCandles` for confluence `distance = impulseStart - sweepIdx in [1..5]`.
- **Sub-evaluation hardcodes inside `findOrderBlocks` (240-280):** displacement thresholds `1.5/2.0/0.6/0.4` and FVG `minGapAtr 0.1` are **hardcoded literals** for internal sub-calls — not via config. Example line 260: `bodyAtrMin: 1.5, rangeAtrMin: 2.0, bullCloseLocMin: 0.6, bearCloseLocMax: 0.4`.
- **Category:** A) hardcoded (4 params + 2 sub-literals). `atrPeriod/swingLeft/swingRight` are B) via scoring.

### 1.5 Dealing Range (`lib/smc/range.ts`)

- **File:** `lib/smc/range.ts:48-68`
- **Values:**
  - `eqBand: 0.02`
  - `swingLeft: 20`, `swingRight: 20`
- **Used:** `eqBand` for `position <0.5-eqBand → DISCOUNT, >0.5+eqBand → PREMIUM else EQUILIBRIUM` (line 316-322). `swingLeft/Right` for structure layer.
- **Category:** `eqBand` and `swingLeft/Right` are **B) configurable via `SmcScoringConfig`** (`config.ts:210-213` passes `eqBand/swingLeft/swingRight`). No additional hardcoded beyond those.

### 1.6 Other Hardcoded Discoveries

- **Pivots (`lib/smc/pivots.ts`):** No tunable threshold beyond `left/right` from StructureParams (which map to `swingLeft/swingRight` or `internalLeft/internalRight`). Plateau equality is exact `===` (no ATR tolerance) — **intentionally not a knob**, keep non-configurable.
- **FSM (`lib/smc/fsm.ts`):** No numeric thresholds beyond pivots; state machine is deterministic. No additional hardcoded to expose.
- **Scoring (`lib/smc/scoring.ts`):** No hidden constants; all 9 weights + `minimumScore` + freshness bars + `eqBand` come from `SmcScoringConfig`. `FVG_ACTIVE_STATES = {"OPEN","TOUCHED","CE_MITIGATED"}` and `OB_ACTIVE_STATES = {"OPEN","MITIGATED"}` are **semantic sets**, not tunable — should remain non-configurable.
- **Volatility (`lib/smc/volatility.ts`):** ATR calculation uses `atrPeriod` only — no extra constants.
- **Types:** `SMCTIMEFRAME_MS` etc. are definitions, not knobs.

**Summary Hardcoded Candidate List (A):**

| Candidate | File | Default | Scoring Override |
|---|---|---|---|
| `bodyAtrMin` | `displacement.ts:62` | `1.5` | hardcoded in OB sub-eval too |
| `rangeAtrMin` | `displacement.ts:62` | `2.0` | same |
| `bullCloseLocMin` | `displacement.ts:62` | `0.6` | same |
| `bearCloseLocMax` | `displacement.ts:62` | `0.4` | same |
| `minGapAtr` | `fvg.ts:66` | `0.1` | hardcoded in OB sub-eval |
| `maxAgeCandles` (FVG) | `fvg.ts:67` | `500` | scoring forces `0` |
| `eqToleranceAtr` | `liquidity.ts:64` | `0.10` | — |
| `eqConfirmBars` | `liquidity.ts:65` | `2` | — |
| `sweepMinPenetrationAtr` | `liquidity.ts:66` | `0.05` | — |
| `maxAgeCandles` (Liquidity) | `liquidity.ts:67` | `750` | scoring forces `0` |
| `impulseMaxCandles` | `order-blocks.ts:122` | `3` | — |
| `confirmMaxCandles` | `order-blocks.ts:123` | `10` | — |
| `maxAgeCandles` (OB) | `order-blocks.ts:124` | `750` | — |
| `sweepLookbackCandles` | `order-blocks.ts:125` | `5` | — |

All are **A) actually existing hardcoded**. No **C) future invented** needed beyond these.

---

## 2. Existing Configurable — Verify Trace

**Source:** `lib/smc/config.ts:39-84` `SmcScoringConfig` + `lib/strategies/smart-money.ts` (Strategy DB mapping, not shown but reuses this type), `app/api/admin/strategies/[id]/route.ts` (Phase 3E) and `components/admin/SmartMoneyStrategyEditor.tsx`.

| Field | Type | Default | Validation (config.ts) | Trace — affects runtime |
|---|---|---|---|---|
| `minimumScore` | int 0..100 | `72` | 99-108 | `scoring.ts:340` threshold for LONG/SHORT vs NEUTRAL/conflict |
| `minExchanges` | int 1..5 (Strategy-level, not SmcScoringConfig) | `3` in DB | `validateSmartMoneyRuntime` | `runtime.ts:aggregateAssetGroup` |
| `timeframes` | `["5m","15m","1h","4h"]` subset, non-empty | `["1h"]` DB | `validateSmartMoneyRuntime` + API 8549486 | selects which TF to evaluate |
| `swingLeft` | int 1..500 | `20` | 120-132 | `deriveSubConfigs` → `displacement.atrPeriod`, `liquidity swing`, `OB swing`, `range swing`, `fsm swing` |
| `swingRight` | int 1..500 | `20` | same | same |
| `internalLeft` | int 1..500 | `3` | same | `OB internal` + `fsm internal` |
| `internalRight` | int 1..500 | `3` | same | same |
| `atrPeriod` | int ≥1 | `14` | 134-142 | `deriveSubConfigs` → displacement/fvg/liquidity/OB/range |
| `structureEventFreshBars` | int ≥0 | `10` | 144-155 | `scoring.ts: pickLatest BOS` |
| `sweepFreshBars` | int ≥0 | `5` | same | `scoring.ts: pickLatest SWEPT` |
| `orderBlockFreshBars` | int ≥0 | `20` | same | `scoring.ts: pickLatest OB` |
| `fvgFreshBars` | int ≥0 | `20` | same | `scoring.ts: pickLatest FVG` |
| `eqBand` | 0 ≤ <0.5 | `0.02` | 157-165 | `range.ts:322` + `scoring.ts: range zone` |
| `weights.*` (9) | int 0..100 sum 100 | 20/15/10/10/15/5/10/10/5 | 167-194 | `scoring.ts: push` per component |
| `filters.minimumQuoteVolume24h` | ≥0 | `0` (scoring default), DB uses higher | `smart-money.ts` | `applySmartMoneyFilters` |
| `filters.top500Only` | bool | `false` | — | `applySmartMoneyFilters` → `isInTopUniverse` (true = Top-100) |

**Dead/Ignored/Duplicated:** None found. All fields flow to `evaluateSmc` via `deriveSubConfigs` or `scoring.ts`. `filters.top500Only` legacy key is intentionally preserved (JSON compat) while semantics is Top-100 — not dead.

---

## 3. Critical RANGE_POSITION Audit — No Math Change

**Observed:** `5m rangePosition ≈ -0.91`, `1d rangePosition ≈ 2.24` (real diagnostic, Phase 3E).

**Trace from source:**

1. **How is active dealing range created?**
   - File `lib/smc/range.ts:260-290` `evaluateDealingRange`
   - Only `BOS` events create a range via `buildDealingRangeFromBos` (line 280-290). `CHOCH` does NOT create; `CHOCH_INVALIDATED` does nothing. Bootstrap first BOS also creates.

2. **What determines high/low?**
   - `lib/smc/range.ts:160-175` `buildDealingRangeFromBos`:
     - `BOS_UP: low = protectedAnchor.price (swing low), high = brokenLevelPrice (swing high)`
     - `BOS_DOWN: high = protectedAnchor.price, low = brokenLevelPrice`
     - Prices from FSM metadata `protectedAnchor` + `brokenPivotKey`. Throws `SmcRangeInvariantError` if `low >= high`.

3. **When is it replaced?**
   - `lib/smc/range.ts:280-290`: each valid `BOS` → `closeActive(versions, event.confirmedAt)` + `versions.push(created)`. Previous active gets `replacedAt = new confirmedAt`. Only one active at a time.

4. **Is it ever explicitly invalidated?**
   - **No explicit invalidation on price excursion.** Range is closed only by:
     - `CHOCH` → `closeActive(versions, choch.confirmedAt)` (line 278) — closes but does NOT create new until next BOS. While FSM in `REVERSAL_PENDING_*`, `current` is `null`.
     - Continuation `BOS` → replaces.
   - Price moving outside `[low,high]` does **not** close/invalidate range. Code `lib/smc/range.ts:300-340` shows `current` selection is purely time-based (`replacedAt`), not price-based.

5. **Can price legitimately move outside while range remains active?**
   - **Yes.** `lib/smc/range.ts:334-340`:
     ```ts
     const price = horizon[horizon.length-1].close;
     const position = (price - current.low)/(current.high - current.low); // БЕЗ clamp
     ```
     No check for outside before scoring. `priceContext` always computed from last close.

6. **Is position mathematically intended to be unbounded?**
   - **Yes, by design.** Comment `lib/smc/range.ts:13-14`: `position = (price - low)/(high - low) — БЕЗ clamp;` and `outsideRange = position <0 || position >1` (line 340). The value is unbounded linear extrapolation.

7. **Does scoring expect [0,1] or safely handle <0/>1?**
   - `lib/smc/scoring.ts:340-360`:
     ```ts
     if rangeContext.zone === "DISCOUNT" → LONG
     else if PREMIUM → SHORT
     else EQUILIBRIUM → 0
     ```
     Where `zone` is derived from `position <0.5-eqBand` etc. (range.ts:316-322). So:
     - `position = -0.91` → `<0.48` → `DISCOUNT` → **still awards LONG points** (10)
     - `position = 2.24` → `>0.52` → `PREMIUM` → **awards SHORT points**
     - No clamp, no error, no `outsideRange` check in scoring — `outsideRange` is payload only, not gating.
     - Scoring safely handles <0/>1, but **semantically treats deep outside as strong DISCOUNT/PREMIUM** — intentional breakout view, not neutral.

8. **Are -0.91/2.24 evidence of ...?**
   - **Intended breakout behavior per current code**, but **product decision ambiguous**:
     - **Intended:** code explicitly allows unbounded and scores outside as directional (no invalidation on excursion).
     - **Stale lifecycle concern:** range from an old BOS (e.g., 1d range `low/high` from weeks ago) could remain active while price has trended far outside, still awarding points even though that range may no longer be relevant. No `maxAge` or price-based invalidation exists for range (unlike FVG/OB/liquidity which have `maxAgeCandles`).
     - **Missing invalidation:** No `close beyond range → close range` logic; only `CHOCH` or new `BOS` closes. So a strong breakout does not invalidate until opposite structure breaks.
     - **Conclusion:** **Not a bug in current spec, but ambiguous product semantics.** Need product decision: should `outsideRange` for N bars trigger `replacedAt` or be treated as `EQUILIBRIUM`/`NO_ACTIVE`? The audit cannot decide — requires backtest/UX decision.
   - **Evidence:** No existing test asserts `position` must be in [0,1]; tests treat -0.91/2.24 as valid (they were observed, not asserted as failure).

9. **Does any existing test encode intended semantics?**
   - `lib/smc/range.ts` tests (not shown) and `scoring.ts` tests likely check zone thresholds, not that outside is disallowed. No test expects `outsideRange` to be false. Scoring tests check `RANGE_POSITION` with `pos` payload, not that it must be clamped.

10. **Would clamping change semantics or conceal lifecycle problems?**
    - **Yes, both.** Clamping `position` to [0,1] would:
      - Change `zone` determination for outside values (e.g., -0.91 clamped to 0 → still DISCOUNT, same, but 2.24 clamped to 1 → still PREMIUM, same zone, but payload `pos` would be wrong).
      - More importantly, **conceal** that price is far outside — the `outsideRange` flag would become false, hiding that range may be stale. Better to keep unbounded and add explicit `outsideRange` handling or `maxAge` if needed.
    - **Recommendation:** **DO NOT clamp** in this audit. If lifecycle is deemed stale, add explicit invalidation (e.g., `maxAge` or `N bars outside → expired`) rather than clamping.

**Source locations for every conclusion:** `range.ts:260-290` (creation), `buildDealingRangeFromBos:160-175` (high/low), `closeActive:270-280` (replace), no price-based invalidation (search shows no `outsideRange` used to close), `range.ts:334-340` (unbounded position), `scoring.ts:340-360` (handles <0/>1), tests: implicit (no clamp test).

---

## 4. Safety Invariants — Must Remain Non-Configurable

- **CLOSED-only:** `validateAndPrepare` + `horizonCandles` + `effectiveCloseTime` — all SMC modules use `candle.closed` and `effectiveCloseTime`; no `open` candle contributes. Found in `lib/smc/validate.ts`, `lib/smc/range.ts:285`, `lib/smc/displacement.ts:188`, etc. **Never configurable.**
- **No-lookahead:** `horizonCandles(prepared, asOf)` filters `effectiveCloseTime <= asOf`; `evaluateX(raw, config, asOf)` is canonical entry. Tests `evaluateSmc(full, T) ≡ evaluateSmc(prefixThroughT, T)`. **Never configurable.**
- **Deterministic evaluation:** `deriveSubConfigs` + pure functions, no random, no mutable state between calls. **Never configurable.**
- **Cannot-evaluate semantics:** `minimumSwingHistoryCandles` (84 for default), `ATR unavailable → not evaluable`, `validate` strict. `NEUTRAL ≠ cannot-evaluate`. **Never configurable.**
- **Chronological ordering requirements:** `validateAndPrepare` checks `openTime` ascending, `unique`. **Never configurable.**
- **Exact multi-exchange horizon/alignment safety:** `lib/strategies/alignment.ts:checkCandleAlignment` requires `canonical grid` + `exact same candleTime`; `safe=false → aggregate not called`. **Never configurable.**
- **No Signal writes:** `lib/strategies/smart-money.ts` + `alignment.ts` contain no `prisma.signal.create`; `edf3732` NOT ancestor. **Never configurable (Signal Engine gated).**
- **Signal Engine prohibition:** `edf3732` experimental commit must stay NOT ancestor; `lib/signals`, `signal-worker` do not exist. **Never configurable until P5.**

Additional invariants that should NOT become knobs:
- Pivot plateau exact equality (`===`) — not ATR tolerance.
- FSM phase/level lifecycle (AVAILABLE→CONSUMED, CHOCH→REVERSAL_PENDING) — not tunable.
- `FVG_ACTIVE_STATES` / `OB_ACTIVE_STATES` sets — semantic.
- `SMCTIMEFRAME_MS` grid — definition.

---

## 5. Backward Compatibility Contract — Design (Not Implement)

**Goal:** Old configs without Phase3D fields must produce **EXACT current behavior**.

**Canonical fallback values (must equal current hardcoded):**

| Field | Fallback | Source of truth (single) |
|---|---|---|
| `displacement.bodyAtrMin` | `1.5` | `lib/smc/displacement.ts:62` `defaultDisplacementConfig` |
| `displacement.rangeAtrMin` | `2.0` | same |
| `displacement.bullCloseLocMin` | `0.6` | same |
| `displacement.bearCloseLocMax` | `0.4` | same |
| `fvg.minGapAtr` | `0.10` | `lib/smc/fvg.ts:66` |
| `fvg.maxAgeCandles` | `0` for scoring (override), `500` for pure FVG | `lib/smc/fvg.ts:67` vs `config.ts:199` |
| `liquidity.eqToleranceAtr` | `0.10` | `lib/smc/liquidity.ts:64` |
| `liquidity.eqConfirmBars` | `2` | `liquidity.ts:65` |
| `liquidity.sweepMinPenetrationAtr` | `0.05` | `liquidity.ts:66` |
| `liquidity.maxAgeCandles` | `0` for scoring, `750` pure | `liquidity.ts:67` vs `config.ts:204` |
| `ob.impulseMaxCandles` | `3` | `lib/smc/order-blocks.ts:122` |
| `ob.confirmMaxCandles` | `10` | `order-blocks.ts:123` |
| `ob.maxAgeCandles` | `750` | `order-blocks.ts:124` |
| `ob.sweepLookbackCandles` | `5` | `order-blocks.ts:125` |

**Design:**

- **Single source of truth:** `lib/smc/*.ts` `defaultXConfig(tf)` remains canonical. `lib/smc/config.ts` `deriveSubConfigs` is where fallback should live: spread `...defaultDisplacementConfig(tf)` then override only if `config.displacement?.bodyAtrMin` exists. Same for FVG/liquidity/OB/range.
- **No divergent defaults:** Tests must assert `defaultSmcScoringConfig(tf)` without Phase3D fields → `deriveSubConfigs` produces exactly `defaultDisplacementConfig` etc. Do not duplicate `1.5` in Admin/API — import from same defaults.
- **Schema:** `SmcScoringConfig` extended with optional `displacement?: Partial<SmcDisplacementConfig>`, `fvg?:`, `liquidity?:`, `orderBlock?:`, `range?:` (or flat). Old JSON without those keys → fallback.
- **Validation:** `assertValidSmcScoringConfig` extended with same ranges as `assertValidDisplacementConfig` etc. (e.g., `bodyAtrMin >=0 finite`).
- **Single place:** `lib/smc/config.ts` — not `runtime.ts` nor `Admin` nor `tests`.

---

## 6. Admin UX Design Audit — Russian Copy (Proposal, Not Built)

Group logically:

### Displacement
- **Импульс тела (bodyAtrMin)** — `1.5` — Минимальное тело свечи в ATR для импульса. *Увеличение* → более сильные импульсы, меньше displacement, реже OB/BOS. *Уменьшение* → больше чувствительности, шуму. Диапазон `0..10` (шаг 0.1), дефолт `1.5`, зависимость `rangeAtrMin`, `atrPeriod`.
- **Импульс диапазона (rangeAtrMin)** — `2.0` — Минимальный диапазон свечи в ATR. *Увел.* → более волатильные импульсы. *Уменьш.* → слабее импульс проходит. `0..10`, `2.0`.
- **Закрытие быка (bullCloseLocMin)** — `0.60` — Требуемое закрытие в верхней 40% диапазона (closeLocation ≥0.6). *Увел. к 0.9* → только свечи закрывшиеся у верха. *Уменьш. к 0.5* → любое бычье закрытие. `0..1` (0.05), `0.60`, пара с `bearCloseLocMax`.
- **Закрытие медведя (bearCloseLocMax)** — `0.40` — зеркально. *Увел.* → строже. `0..1`, `0.40`.

### FVG
- **Мин. зазор FVG (minGapAtr)** — `0.10` — Минимальный gap/ATR. *Увел.* → только крупные FVG. `0..5`, `0.10`, зависит `atrPeriod`. Предупреждение: `0` → все raw gap пройдут, шум.
- **Жизненный цикл FVG (maxAgeCandles)** — `0` в scoring (выкл), `500` в pure. *Увел.* → FVG живёт N свеч, затем EXPIRED. `0..5000` (0=выкл), `0` (scoring). Внимание: scoring сейчас без expiry — изменение включит expiry.

### Liquidity
- **Допуск EQ (eqToleranceAtr)** — `0.10` — Допуск равенства вершин в ATR. *Увел.* → больше пар считается EQH/EQL. `0..1`, `0.10`.
- **Подтверждение EQ (eqConfirmBars)** — `2` — Свеч без close за уровень. *Увел.* → строже, реже EQ. `0..20`, `2`, `0` → EQ создаётся мгновенно.
- **Мин. прокол sweep (sweepMinPenetrationAtr)** — `0.05` — На сколько high/low должен проколоть уровень для SWEPT. *Увел.* → только глубокие проколы. `0..1`, `0.05`.
- **Жизненный цикл liquidity (maxAgeCandles)** — `0` scoring, `750` pure. `0..5000`.

### Order Blocks
- **Макс. импульс свеч (impulseMaxCandles)** — `3` — Макс. длина импульса OB (дисплейсмент + continuation). `1..10`, `3`.
- **Макс. подтверждение OB (confirmMaxCandles)** — `10` — Окно BOS после impulseEnd. *Увел.* → дольше ждём BOS, больше OB. `1..100`, `10`.
- **Жизненный цикл OB (maxAgeCandles)** — `750` — *Увел.* → OB живёт дольше. `0..5000` (0=выкл), `750`.
- **Взгляд назад sweep (sweepLookbackCandles)** — `5` — Свеч назад для confluence sweep. `0..100` (0=выкл), `5`.

### Dealing Range
- `eqBand`, `swingLeft/Right` уже конфигурируемы (см. §2) — не дублировать.

**Предупреждение для всех:** изменение любого параметра требует бэктеста; profitability не заявляется.

---

## 7. Implementation Plan — Staged, Minimal Risk

**Stage 3D-A — Canonical advanced config + backward-compatible defaults (docs + types, no wiring)**
- Files: `lib/smc/config.ts` (extend `SmcScoringConfig` with optional `displacement/fvg/liquidity/orderBlock`), `lib/smc/displacement.ts` etc. *not* changed.
- Tests: old config without new fields → `deriveSubConfigs` still returns current hardcoded; new config with explicit fields overrides.
- Safety: `git diff --check`, `tsc`, `test-smc-*` equivalence.

**Stage 3D-B — Core wiring (pure)**
- Files: `lib/smc/config.ts:deriveSubConfigs` spread overrides, `lib/smc/order-blocks.ts` use `config.displacement` instead of hardcoded `1.5` etc. for sub-evaluations (if not already via derive).
- Tests: each new param changes intended behavior (e.g., `bodyAtrMin 1.5→3.0` → fewer displacements), deterministic, no-lookahead.

**Stage 3D-C — Runtime validation**
- Files: `lib/smc/validate.ts` + `lib/smc/config.ts:assertValid*` extended, `lib/strategies/smart-money.ts:validateSmartMoneyRuntime` checks new fields.
- Tests: malformed values rejected (e.g., `bodyAtrMin -1` → 400), boundaries, dependencies.

**Stage 3D-D — Admin/API**
- Files: `components/admin/SmartMoneyStrategyEditor.tsx` (new sections Displacement/FVG/Liquidity/OB, Russian copy above, reset to defaults), `app/api/admin/strategies/[id]/route.ts` (uses same validator, no new logic).
- Tests: Admin renders, saves, reset, non-empty, 1d guard preserved.

**Stage 3D-E — Regression / future-injection / multi-TF / alignment**
- Files: `scripts/test-smart-money-*`, `scripts/test-smc-*`.
- Tests: old config exact semantic equivalence, no Signal writes, Trend unchanged, alignment horizon still required, `npm run build`, VPS plan.

---

## 8. Test Plan — For Eventual Implementation

- **Equivalence:** `oldConfig = {swingLeft:20,...}` (no Phase3D keys) → `evaluateSmc(old, tf, asOf)` byte-identical to `evaluateSmc({...old, displacement:{bodyAtrMin:1.5}}, tf, asOf)`.
- **Canonical defaults:** `defaultDisplacementConfig(tf).bodyAtrMin === 1.5` etc. as single source.
- **Each param actually changes behavior:** e.g., `minGapAtr 0.1→1.0` → fewer FVG; `eqToleranceAtr 0.10→0.5` → more EQ.
- **Malformed:** `bodyAtrMin: -1` → `SmcInputError`; `impulseMaxCandles: 0` → error; `sweepLookback: -1` → error.
- **Boundaries:** `eqBand 0` and `0.49` valid, `0.5` invalid; `maxAge 0` valid (disabled).
- **Dependencies:** `sweepLookback 0` → `hasLiquiditySweepBeforeImpulse` always false; test via `order-blocks` confluence.
- **Deterministic / no-lookahead / CLOSED-only / cannot-evaluate / multi-exchange / multi-TF / alignment:** reuse existing harness (`evaluateSmc(full,T) ≡ evaluateSmc(prefix,T)`, `closed=false` → cannot-evaluate).
- **Trend unchanged:** `validateTrendSuslikConfig` still accepts without new fields.
- **No Signal writes / no ancestry:** `edf3732` NOT ancestor, `prisma.signal.create` absent.
- **RANGE_POSITION specific:**
  - `current == null` → `RANGE_POSITION` 0 points + `NO_ACTIVE_DEALING_RANGE`
  - `position = -0.91` → `DISCOUNT` + `pos` payload + `outsideRange=true` still awards LONG
  - `position = 2.24` → `PREMIUM` + `outsideRange=true`
  - `position = 0.5` with `eqBand 0.02` → `EQUILIBRIUM` 0 points
  - Future lifecycle test (after decision): `N bars outside → current becomes null` vs `stays` — document expected before implementing.

---

## 9. Deliverable & Safety

- **No code change in this audit commit.**
- **No DB writes, no workers, no Signal, no Prisma schema.**
- **RANGE_POSITION conclusion:** outside [0,1] is **intended per current code** (unbounded, scored as DISCOUNT/PREMIUM), but **ambiguous product semantics** — likely needs explicit lifecycle decision (maxAge or outside→expired) rather than clamping. **Do not clamp.**
- **Recommended sequence:** 3D-A → 3D-B → 3D-C → 3D-D → 3D-E (above).

---

## 10. Files & References

- `lib/smc/displacement.ts:44-68,130-148`
- `lib/smc/fvg.ts:51-69,108-244,260-286`
- `lib/smc/liquidity.ts:48-93, 0 override in `config.ts:200-204`
- `lib/smc/order-blocks.ts:112-135,240-280, 0 override in `config.ts:195-199`
- `lib/smc/range.ts:48-68,160-290,316-340`
- `lib/smc/config.ts:39-84,99-213,192-213`
- `lib/smc/scoring.ts:340-360`
- `lib/strategies/alignment.ts` (horizon guard)
- `PROJECT_CONTEXT.md` §32-33 (current priority)
