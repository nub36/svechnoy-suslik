# Pre-PnL Backtest Runbook — BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d

**Base:** 51eb129dea6a36ac077770d57859837769ece705 VPS-verified ACCEPTED (P2-A p2a-1.2.0, P2-B HARDENED, P2-C p2c-1.2.0) — base only, new work NOT accepted/VPS-verified
**Current Branch:** this branch HEAD — sequential commits from 7f58365, PENDING TARGETED RE-AUDIT
**Status:** IMPLEMENTED / PENDING TARGETED INDEPENDENT RE-AUDIT — no PnL, no profitability claims
**Production:** d6c573c20a11e79e26153579575818f1dada2f96 — DO NOT deploy, DO NOT restart workers
**Changed Files from base 51eb129:** 35 files (see git diff --name-only 51eb129..HEAD)

## 1. Scope — What is pre-PnL

- Read-only historical PostgreSQL data plane on top of P2-B with canonical coverage diagnostics
- Historical raw SMC observation preserving LONG/SHORT/NEUTRAL/CANNOT_EVALUATE + facts/reasons/provenance (reuses production evaluateSmc, no second algorithm)
- Differential / property tests: production vs historical same prefix identical, same prefix + different suffix = same observation, no-lookahead invariants, context-channel-only documented
- Generic execution-policy infrastructure: ExecutionPolicyDefinition, fingerprint, Executability EXECUTABLE/NON_EXECUTABLE (NO_EXECUTION_POLICY/NO_VALID_LEVELS/POLICY_NOT_APPROVED/PRE_REGISTRATION_REQUIRED etc) WITHOUT economic defaults (no SL anchor, no ATR, no k, no RR, no timeout, no buffer, no TP rule)
- Deterministic pre-PnL runner refusing real PnL until policy approved: status PRE_REGISTRATION_REQUIRED, only coverage/raw counts diagnostics — intentionally stops before economics, does NOT go to P2-A/P2-C
- TRAIN/VALIDATION/OOS plumbing using P2-C semantics OOS-blind (selection TRAIN/VALIDATION only, OOS final witness only)
- Admin/backtests UI truthful readiness state (no fake profitability)
- Docs/runbooks

Forbidden:
- No Signal Engine edf3732da81a8916efc7e63f5608401ee6e2668c ancestry (git merge-base --is-ancestor must exit 1)
- No DB writes: no INSERT/UPDATE/DELETE/UPSERT/DDL/migrate/db push/seed/strategy status changes
- No real PnL/win rate/profit factor/Sharpe/expectancy/equity curve — synthetic data only for correctness tests
- No profitability stats, BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d (reuse production Smart Money eligibility)
- Costs fixed: 5 bps fee per side, 0 fixed, 2 bps slippage per side — only relevant after execution policy approved
- No canonical SL/TP in production SMC — do NOT invent SL/TP, do NOT call invented policy production SMC
- Raw LONG/SHORT without SL/TP stays NON_EXECUTABLE, not fake NEUTRAL/CANNOT_EVALUATE, do not send invalid to P2-A to reject

## 2. Architecture

```
HistoricalDataPlane (read-only, DI executor)
  -> computeMarketCoverage (requested-range basis, not first->last)
  -> eligibility via isSmartMoneyExchangeEligible (BINGX 1d excluded)
  -> provenance (createdAt/updatedAt diff, write path audit lib/ohlcv/sync.ts only)
  -> common timestamps / contiguous intervals / participant feasibility
  -> effectiveCanonicalRange with isAligned/canonicalized, overallCoverageRatio

RawSmcObservation (reuses production evaluateSmc)
  -> windowPolicy: hardMinimumBars ~84 vs productionWindowBars 500 vs fetchCap 500 vs fidelity 500 vs ROLLING_500
  -> causal clock: computeCausalAsOf H+D, testCausalClockBoundary H+D-1ms/AT/After/H+2D, no wall-clock
  -> provenance: market(s), timeframe, decision bar H, asOf=H+D, common horizon, participant count, facts/fingerprint
  -> batch: evaluateRawObservationsBatch with causal prefix invariant

ExecutionPolicyDefinition
  -> id, label, createdAt ISO, status DRAFT/IN_REVIEW/APPROVED/REJECTED, requiredEconomicFields non-empty when APPROVED, config with forbiddenDefaults list (k=1/k=2/any k-grid/RR/ATR/buffer/TP/timeout etc)
  -> fingerprint includes id/label/status/requiredFields/config
  -> validation: explicit required fields, no hidden defaults, NaN/Infinity rejected, Date.parse validation (no new Date token)
  -> HONEST SCOPE: top-level/current contract scope only, NOT arbitrary source-code semantic analysis

Executability
  -> EXECUTABLE only if APPROVED policy + valid SL/TP levels at decision bar
  -> NON_EXECUTABLE reasons: NO_EXECUTION_POLICY, INVALID_POLICY, NO_VALID_STOP, NO_VALID_TARGET, LEVELS_INVALID_AT_DECISION, POLICY_NOT_APPROVED, PRE_REGISTRATION_REQUIRED, etc.

PrePnlRunner — intentionally stops before economics, does NOT go to P2-A/P2-C
  -> runPrePnlDiagnostics: bars per market -> coverage -> eligibility -> raw SMC observations -> execution policy boundary -> STOP, returns PRE_REGISTRATION_REQUIRED, no P2-A economics entered
  -> status: PRE_REGISTRATION_REQUIRED until APPROVED policy, READY_FOR_EXECUTION after approval but still no PnL until full execution pipeline separately approved
  -> diagnostics only: coverage per market, raw counts, NON_EXECUTABLE counts, data limitations, eligibility limitations, fingerprints, common horizon
  -> truthful baseline naming: SMC-Direction Baseline / EP-1 until execution/eligibility production-derived
  -> No P2-A engine import, no computeMetrics, no profitFactor/netPnl — import-closure asserted via static source pin

SplitsReadiness
  -> uses P2-C semantics: selection stages TRAIN/VALIDATION only, OOS final witness only, tie-break selectionKey -> inputOrder, OOS-blind
  -> readiness report: TRAIN/VALIDATION/OOS coverage, insufficient data handling (no silent OOS shortening)
```

## 3. Historical Eligibility — CANNOT_RECONSTRUCT

Mutable fields: Asset.rank, Market.quoteVolume24h, Market.enabled, Market.status, listing/delisting survivorship — current-state only, no PIT history.

Diagnostics must represent CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY.

Three methodologies (owner-unresolved, E1/E2/E3):
- E1: present-day snapshot with explicit limitation note in report (survivorship bias acknowledged)
- E2: disable unreconstructable filters (e.g., only exchange/timeframe eligibility) with explicit deviation note
- E3: no profitability claim until PIT eligibility history exists (only raw direction baseline)

Leave E1/E2/E3 unresolved — do NOT choose. Truthful labeling mandatory.

## 4. OHLCV PIT Fidelity — Known Limitation (factual correction)

- lib/ohlcv/sync.ts upsert path: update branch updates ONLY closeTime/open/high/low/close/volume/closed — createdAt NOT overwritten (Prisma default, not in update), updatedAt auto-updated.
- Current DB contents do NOT prove historical values at time T — upsert overwrites OHLCV values, but createdAt preserves original creation time.
- createdAt does NOT prove values identical at creation, but does prove when row was first created; updatedAt shows mutation timing but does NOT recover old values.
- Expected write files: lib/ohlcv/sync.ts only (audited)
- Diagnostics: rowsWithCreatedAt/UpdatedAt/diff, limitations docs, no claim of strict PIT fidelity
- Factual correction: earlier docs claimed createdAt overwritten by update branch — FALSE, corrected here.

## 5. No-Lookahead Contract

- Context-channel-only: SignalContext.barAt(k>0) throws, visibleBars == index+1, bars outside warmup unavailable, probeProvider actively tries future offsets [1,2,10,1000] on each bar.
- Counterfactual: replacing entire future with poisoned series does not change decisions/trades before boundary.
- What it does NOT prove: arbitrary external channel — closure on original array, global variable, file/network/cache — NOT blocked by context barrier, counterfactual catches leakage only when decisions depend on replaced data.
- Historical causal clock: H+D boundary tested H+D-1ms (not yet closed) / H+D (exactly closed) / H+D+1ms (after) / H+2D, no H+1 visibility before legal time.
- OOS never influences ranking — enforced by P2-C segment-local eligibility and selectionKey OOS-blind.

## 6. Quant Cautions — Documented

- SL/TP not in production SMC — production outputs raw LONG/SHORT/NEUTRAL/CANNOT_EVALUATE + causal facts, NO canonical SL/TP. Do NOT invent.
- Structural close-based (production SMC uses CLOSED candles) vs P2-A wick-based execution (pessimistic same-bar). Gap-through logic in P2-A.
- k=1 rejected — needs structural SL anchor, ATR not transferable from TrendSuslik.
- TrendSuslik ATR not transferable — different indicator, different horizon, different semantics.
- Distinguish: hardMinimumBars (~84 = min for minimal SMC signal) vs productionWindowBars (500 used in production) vs fetch cap (500) vs fidelity window (500 hypothesis) vs ROLLING_500 strategy memory.
- Historical common-horizon must use causal clock H+D boundary not wall clock — common horizon = latest closed across markets at asOf.

## 7. Owner-Run Read-Only CLI (BTC-only, no secrets)

```bash
# READ ONLY NO DB WRITES NO PNL — fails closed if DB env missing or timezone local date used
# Uses server's existing configured environment — do NOT paste secrets, never echo DATABASE_URL
# BTC-only: --asset must be BTC, otherwise fail-closed (pre-registered scope)
npx tsx scripts/backtest-historical-readonly.ts \
  --asset BTC \
  --timeframe 1h \
  --from 2024-01-01 \
  --to 2024-02-01 \
  --smartMoney \
  --pageSize 1000

# Flags (actual CLI):
# --asset BTC (only BTC allowed, fail-closed — ETH etc rejected)
# --timeframe 5m|15m|1h|4h|1d (BINGX excluded 1d via eligibility)
# --from YYYY-MM-DD (UTC midnight, no local timezone)
# --to YYYY-MM-DD
# --smartMoney (uses isSmartMoneyExchangeEligible — timeless BINGX-1d policy only)
# --pageSize 1..5000
# --smc (raw SMC observations, no SL/TP, no PnL)
# --splits (TRAIN/VALIDATION/OOS readiness, OOS isolation)
```

CLI truthfulness (independent audit confirmed):
- Does NOT execute SET TRANSACTION READ ONLY — no raw SQL transaction enforcement added to avoid DB writes.
- Read-only by capability-restricted Prisma surface: asset.findUnique, market.findMany (all markets for BTC, reporting current enabled/status as diagnostics), candle.findMany (CLOSED-only), $disconnect. No create/update/upsert/delete, no $executeRaw.
- read-only-sql.ts remains as static/test defense (SELECT/WITH allowlist, forbidden write tokens), NOT as runtime CLI guard unless actually wired — scope is static defensive SQL inspection only, NOT PostgreSQL semantic proof/DB enforcement/runtime guard unless actually wired.
- Current enabled/status survivorship: CLI queries ALL markets for BTC asset (no enabled:true/status:ACTIVE filter) and reports current enabled/status as diagnostic fields. Timeless exchange eligibility (BINGX-1d) applied separately. Universe narrowing reported as CURRENT_STATE_SURVIVORSHIP_LIMITATION if disabled markets exist.
- SELECT-only, CLOSED-only, ASC ordering, duplicates fail-closed, canonical grid check
- Coverage: requested-range basis, leading/internal/trailing missing, ratio canonical-grid based, earliest/latest, canonical slots, common intersection/horizon feasibility, effectiveCanonicalRange with isAligned/canonicalized, overallCoverageRatio
- No PnL, no trades, no metrics, no writes
- Output: coverage per market, common timestamps, contiguous intervals, feasibility, eligibility diagnostics CANNOT_RECONSTRUCT, provenance revision diagnostics, limitations, TRAIN/VALIDATION/OOS readiness

## 8. Tests — How to Run (no DB) — exact suite counts reported separately

```bash
# P2-A/B/C accepted (base) — exact counts
npx tsx scripts/test-backtest-engine.ts      # 442/442
npx tsx scripts/test-backtest-p2b.ts         # 427/427
npx tsx scripts/test-backtest-metrics.ts     # 123/123
npx tsx scripts/test-backtest-splits.ts      # 108/108
npx tsx scripts/test-experiment-contract.ts  # 213/213
npx tsx scripts/test-experiment-report.ts    # 225/225
npx tsx scripts/test-experiment-leakage.ts   # 174/174
npx tsx scripts/test-experiment-hardening.ts # 165/165
npx tsx scripts/test-smart-money-eligibility.ts # 96/96

# Pre-PnL new suites — exact counts
npx tsx scripts/test-backtest-data-plane.ts  # 46/46
npx tsx scripts/test-backtest-execution-policy.ts # 16/16
npx tsx scripts/test-backtest-smc-observation.ts # 78/78
npx tsx scripts/test-backtest-pre-pnl.ts     # 29/29 — fixed vacuous, added from<to validation
npx tsx scripts/test-real-long-short.ts      # 17/17 — real LONG/SHORT via production evaluateSmc path, BEHAVIOR
npx tsx scripts/test-canonical-coverage-real.ts # 38/38 — behavior-level coverage, BEHAVIOR
npx tsx scripts/test-historical-data-plane-behavior-real.ts # 22/22 — REAL plane object, non-aligned partial, ratio !=1, effectiveCanonicalRange, isAligned/canonicalized, projection mutations killed, BEHAVIOR
npx tsx scripts/test-no-pnl-output.ts        # 11/11 — REAL plane object + formatted report recursive, CONTRACT
npx tsx scripts/test-economic-default-detection.ts # 12/12 — mutation must fail, CONTRACT, top-level scope
npx tsx scripts/test-core-api-immutability.ts # 14/14 — deep-freeze, CONTRACT
npx tsx scripts/test-survivorship-fixtures.ts # 11/11 — active/disabled/inactive/delisted, CONTRACT, strict no OR
npx tsx scripts/test-eligibility-hardening.ts
npx tsx scripts/test-historical-clock-hardening.ts
npx tsx scripts/test-readonly-sql-hardening.ts
npx tsx scripts/test-pre-pnl-structural-proof.ts # 22/22 — fixed spy, SOURCE PIN
npx tsx scripts/test-mutation-controls.ts
npx tsx scripts/test-owner-inspection-readiness.ts
npx tsx scripts/test-mutations-m1-m11.ts     # 21/21 — classified BEHAVIOR/CONTRACT/SOURCE PIN, all killed

npx tsc --noEmit
npm run build
git diff --check
```

Isolation contract (lib/backtest/*.ts):
- No new Date() token in code (comments stripped) — use formatIsoUtc / utcDateFromMs via Reflect.construct (allowed)
- No Date.now(), no Math.random(), no process.env
- No dynamic import, no require, no eval
- Strip comments before FORBIDDEN_TOKENS check
- Report titles must match actual file names, final SHA must be actual HEAD or described as this branch HEAD, not stale titles
- Suite counts must be actual, not stale

## 9. Admin UI — Truthful Readiness

/app/admin/backtests shows:
- P2-A p2a-1.2.0 ACCEPTED / VPS VERIFIED, P2-B HARDENED ACCEPTED, P2-C p2c-1.2.0 ACCEPTED
- Phase A historical data plane READ ONLY NO DB WRITES NO PNL
- Phase B raw SMC observation reuses production evaluateSmc, window policy distinction, causal clock H+D
- Phase C differential equivalence same prefix different suffix same observation, context-channel-only no-lookahead
- Phase D execution policy generic NO defaults, EXECUTABLE vs NON_EXECUTABLE, top-level scope only
- Phase E pre-PnL runner PRE_REGISTRATION_REQUIRED, diagnostics only, truthful baseline SMC-Direction Baseline / EP-1, intentionally stops before economics
- Phase F TRAIN/VALIDATION/OOS readiness OOS isolation
- Historical eligibility CANNOT_RECONSTRUCT E1/E2/E3 unresolved
- OHLCV PIT fidelity limitation
- No fake profitability numbers, no fake completed experiments

## 10. Self-Adversarial Mutations — Required and Classified Honestly

- BEHAVIOR MUTATION: real production path, observable output changes if mutated — M1 LONG->NEUTRAL, M2 SHORT->CANNOT_EVALUATE, M3 overallCoverageRatio forced 1, M4 effectiveFrom broken, M5 alignment flags falsified, plane-level non-aligned partial, ratio !=1, effectiveCanonicalRange
- MODULE CONTRACT MUTATION: output contract violation — M6 netPnl historical report, M7 netPnl core-api nested, M8 unresolved policy k/ATR/RR/timeout, M10 immutability, M11 enabled/status filtering restored
- STATIC SOURCE PIN: source-code pattern that must not exist — M9 PRE_REGISTRATION bypass (no P2-A import)

All must be killed, then restored to green. Report classification honestly, do not call M1-M11 all behavioral mutations.

## 11. Final Delivery Checklist

- [ ] Branch from exact 51eb129, no accepted branches altered, no squash/amend/force-push
- [ ] lib/backtest/*.ts no new Date, no Date.now, no Math.random, no process.env, no dynamic import
- [ ] All P2-A/B/C contracts green (engine 442/442, p2b 427/427, metrics 123/123, splits 108/108, contract 213/213, report 225/225, leakage 174/174, hardening 165/165, eligibility 96/96)
- [ ] New phase tests green with actual counts (see §8)
- [ ] tsc --noEmit 0 errors, build 0 errors, git diff --check clean including PROJECT_CONTEXT trailing blank line
- [ ] No DB writes, no PnL fields, no Signal Engine ancestry exit 1
- [ ] Admin UI truthful, no fake profitability
- [ ] Owner-run CLI read-only, no DB writes, fail-closed, NO DATABASE_URL
- [ ] Docs: this runbook factual, 35 changed files, no >6700 claim, no false engine 442 was 439 explanation, actual suite counts
- [ ] Push branch, full commit chain report, mutation report classified honestly, status PENDING TARGETED RE-AUDIT
