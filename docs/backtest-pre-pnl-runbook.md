# Pre-PnL Backtest Runbook — BTC only, 5m/15m/1h/4h/1d, BINGX excluded 1d

**Base:** 51eb129dea6a36ac077770d57859837769ece705 VPS-verified ACCEPTED (P2-A p2a-1.2.0, P2-B HARDENED, P2-C p2c-1.2.0)
**Status:** IMPLEMENTED / PENDING INDEPENDENT ADVERSARIAL REVIEW — no PnL, no profitability claims
**Production:** d6c573c20a11e79e26153579575818f1dada2f96 — DO NOT deploy, DO NOT restart workers

## 1. Scope — What is pre-PnL

- Read-only historical PostgreSQL data plane on top of P2-B with canonical coverage diagnostics
- Historical raw SMC observation preserving LONG/SHORT/NEUTRAL/CANNOT_EVALUATE + facts/reasons/provenance (reuses production evaluateSmc, no second algorithm)
- Differential / property tests: production vs historical same prefix identical, same prefix + different suffix = same observation, no-lookahead invariants, context-channel-only documented
- Generic execution-policy infrastructure: ExecutionPolicyDefinition, fingerprint, Executability EXECUTABLE/NON_EXECUTABLE (NO_EXECUTION_POLICY/NO_VALID_LEVELS/POLICY_NOT_APPROVED/PRE_REGISTRATION_REQUIRED etc) WITHOUT economic defaults (no SL anchor, no ATR, no k, no RR, no timeout, no buffer, no TP rule)
- Deterministic pre-PnL runner refusing real PnL until policy approved: status PRE_REGISTRATION_REQUIRED, only coverage/raw counts diagnostics
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

RawSmcObservation (reuses production evaluateSmc)
  -> windowPolicy: hardMinimumBars ~84 vs productionWindowBars 500 vs fetchCap 500 vs fidelity 500 vs ROLLING_500
  -> causal clock: computeCausalAsOf H+D, testCausalClockBoundary H+D-1ms/AT/After/H+2D, no wall-clock
  -> provenance: market(s), timeframe, decision bar H, asOf=H+D, common horizon, participant count, facts/fingerprint
  -> batch: evaluateRawObservationsBatch with causal prefix invariant

ExecutionPolicyDefinition
  -> id, label, createdAt ISO, status DRAFT/IN_REVIEW/APPROVED/REJECTED, requiredEconomicFields non-empty when APPROVED, config with forbiddenDefaults list (k=1/k=2/any k-grid/RR/ATR/buffer/TP/timeout etc)
  -> fingerprint includes id/label/status/requiredFields/config
  -> validation: explicit required fields, no hidden defaults, NaN/Infinity rejected, Date.parse validation (no new Date token)

Executability
  -> EXECUTABLE only if APPROVED policy + valid SL/TP levels at decision bar
  -> NON_EXECUTABLE reasons: NO_EXECUTION_POLICY, INVALID_POLICY, NO_VALID_STOP, NO_VALID_TARGET, LEVELS_INVALID_AT_DECISION, POLICY_NOT_APPROVED, PRE_REGISTRATION_REQUIRED, etc.

PrePnlRunner
  -> runPrePnlDiagnostics: bars per market -> coverage -> eligibility -> raw SMC observations -> execution policy boundary -> P2-A skipped (no real trades until READY_FOR_EXECUTION)
  -> status: PRE_REGISTRATION_REQUIRED until APPROVED policy, READY_FOR_EXECUTION after (still no PnL until full execution pipeline approved)
  -> diagnostics only: coverage per market, raw counts, NON_EXECUTABLE counts, data limitations, eligibility limitations, fingerprints, common horizon
  -> truthful baseline naming: SMC-Direction Baseline / EP-1 until execution/eligibility production-derived

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

## 4. OHLCV PIT Fidelity — Known Limitation

- lib/ohlcv/sync.ts upsert path: updates existing candles (open/high/low/close/volume/closeTime/closed/createdAt/updatedAt) — current DB contents do NOT prove historical values at time T.
- createdAt does NOT prove values identical at creation, updatedAt shows mutation timing but does NOT recover old values.
- Expected write files: lib/ohlcv/sync.ts only (audited)
- Diagnostics: rowsWithCreatedAt/UpdatedAt/diff, limitations docs, no claim of strict PIT fidelity

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

## 7. Owner-Run Read-Only CLI

```bash
# READ ONLY NO DB WRITES NO PNL — fails closed if DATABASE_URL missing or timezone local date used
DATABASE_URL=postgresql://... npx tsx scripts/backtest-historical-readonly.ts \
  --asset BTC \
  --timeframe 1h \
  --from 2024-01-01 \
  --to 2024-02-01 \
  --smartMoney \
  --pageSize 1000 \
  --maxPages 100

# Flags:
# --asset BTC (only BTC allowed, fail-closed)
# --timeframe 5m|15m|1h|4h|1d (BINGX excluded 1d via eligibility)
# --from YYYY-MM-DD (UTC midnight, no local timezone)
# --to YYYY-MM-DD
# --smartMoney (uses isSmartMoneyExchangeEligible)
# --pageSize 1..5000
# --maxPages 1..1000
# --eligibilityMode E1|E2|E3 (diagnostics only, does not choose)
```

CLI:
- Defensive SET TRANSACTION READ ONLY intent documented (PostgreSQL read-only transaction)
- SELECT-only, CLOSED-only, ASC ordering, duplicates fail-closed, canonical grid check
- Coverage: requested-range basis, leading/internal/trailing missing, ratio canonical-grid based
- No PnL, no trades, no metrics, no writes
- Output: JSON report with coverage per market, common timestamps, contiguous intervals, feasibility, eligibility diagnostics, provenance, limitations

## 8. Tests — How to Run (no DB)

```bash
npx tsx scripts/test-backtest-engine.ts      # 439/439 (includes isolation for new files)
npx tsx scripts/test-backtest-p2b.ts         # 427/427
npx tsx scripts/test-backtest-metrics.ts     # 123/123
npx tsx scripts/test-backtest-splits.ts      # 108/108
npx tsx scripts/test-experiment-contract.ts  # 213/213
npx tsx scripts/test-experiment-report.ts    # 225/225
npx tsx scripts/test-experiment-leakage.ts   # 174/174
npx tsx scripts/test-experiment-hardening.ts # 165/165
npx tsx scripts/test-smart-money-eligibility.ts # 96/96
npx tsx scripts/test-backtest-data-plane.ts  # 46/46 (Phase A)
npx tsx scripts/test-backtest-execution-policy.ts # 16/16 (Phase D)
npx tsx scripts/test-backtest-smc-observation.ts # 78/78 (Phase C)
npx tsx scripts/test-backtest-pre-pnl.ts     # 28/28 (Phase E/F)
npx tsc --noEmit
npm run build
```

Isolation contract (lib/backtest/*.ts):
- No new Date() token in code (comments stripped) — use formatIsoUtc / utcDateFromMs via Reflect.construct (allowed)
- No Date.now(), no Math.random(), no process.env
- No dynamic import, no require, no eval
- Strip comments before FORBIDDEN_TOKENS check

## 9. Admin UI — Truthful Readiness

/app/admin/backtests shows:
- P2-A p2a-1.2.0 ACCEPTED / VPS VERIFIED, P2-B HARDENED ACCEPTED, P2-C p2c-1.2.0 ACCEPTED
- Phase A historical data plane READ ONLY NO DB WRITES NO PNL
- Phase B raw SMC observation reuses production evaluateSmc, window policy distinction, causal clock H+D
- Phase C differential equivalence same prefix different suffix same observation, context-channel-only no-lookahead
- Phase D execution policy generic NO defaults, EXECUTABLE vs NON_EXECUTABLE
- Phase E pre-PnL runner PRE_REGISTRATION_REQUIRED, diagnostics only, truthful baseline SMC-Direction Baseline / EP-1
- Phase F TRAIN/VALIDATION/OOS readiness OOS isolation
- Historical eligibility CANNOT_RECONSTRUCT E1/E2/E3 unresolved
- OHLCV PIT fidelity limitation
- No fake profitability numbers, no fake completed experiments

## 10. Self-Adversarial Mutations — Required

Before final push, run mutation controls (outside tree, revert after):
- Return fail-open in classifySignalSource -> must fail 37+ checks
- Re-read decision field from original object instead of snapshot -> must fail TOCTOU checks
- Restore depth slice >8 in findNonFiniteNumbers -> must fail NaN depth 15 check
- Return full configurationId in tie-break instead of selectionKey -> must fail OOS-dependence checks (selectionKey OOS-blind)
- Remove experimentInvariantErrors call from runExperiment -> must fail M4b pin 163/165
- Remove segment-local eligibility check (use variant.status) -> must fail 144/146
- Remove FORBIDDEN_TOKENS check (allow new Date) -> must fail isolation 439/439

All mutations must be killed, then restored to green.

## 11. Final Delivery Checklist

- [ ] Branch from exact 51eb129, no accepted branches altered, no squash/amend/force-push
- [ ] lib/backtest/*.ts no new Date, no Date.now, no Math.random, no process.env, no dynamic import
- [ ] All P2-A/B/C contracts green (engine 439/439, p2b 427/427, metrics 123/123, splits 108/108, contract 213/213, report 225/225, leakage 174/174, hardening 165/165, eligibility 96/96)
- [ ] New phase tests green (data-plane 46/46, smc-observation 78/78, execution-policy 16/16, pre-pnl 28/28)
- [ ] tsc --noEmit 0 errors, build 0 errors, git diff --check clean
- [ ] No DB writes: grep -R INSERT/UPDATE/DELETE/UPSERT/CREATE/ALTER/DROP/TRUNCATE/LOCK/COPY/VACUUM in lib/backtest must be only in allowlist comments
- [ ] No PnL fields: grep -R profitFactor/sharpe/winRate/expectancy/netPnl in lib/backtest/pre-pnl-runner must be absent
- [ ] No Signal Engine ancestry: git merge-base --is-ancestor edf3732 HEAD must exit 1
- [ ] Admin UI truthful, no fake profitability
- [ ] Owner-run CLI read-only, no DB writes, fail-closed
- [ ] Docs: this runbook + PROJECT_CONTEXT.md update + CHANGELOG.md update
- [ ] Push branch arena/01a09726-svechnoy-suslik, full commit chain report, self-adversarial mutations report, audit for leakage
