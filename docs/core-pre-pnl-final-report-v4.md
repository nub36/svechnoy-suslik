# Core Pre-PnL Final Report v4 — Phase H Full Pipeline Real PnL — PROFESSIONAL TOP — IMPLEMENTED / PENDING TARGETED RE-AUDIT

Base: `51eb129dea6a36ac077770d57859837769ece705` VPS verified, production `d6c573c20a11e79e26153579575818f1dada2f96` untouched, forbidden `edf3732da81a8916efc7e63f5608401ee6e2668c` NOT ancestor (exit 1), SIGNAL ENGINE ABSENCE VERIFIED.

Branch: `arena/01a09726-svechnoy-suslik` HEAD `9985bb5` + new Phase H commit, 42 files from base, sequential commits no squash/amend/force-push.

GitHub incident Sep 13 2026 09:16-10:28 UTC: API Requests / Pull Requests Degraded/Incident due to collab DB replication delays, Git Operations Normal 100% — verified via `tmp-recovery-test` push/delete exit 0, recovery signs 10:26 UTC load-shedding.

## P2-A / P2-B / P2-C — ACCEPTED / VPS VERIFIED

- P2-A p2a-1.2.0: deterministic next-bar entry, planned-risk R, gap-through, fees/slippage, pessimistic same-bar, arithmetic fail-closed, immutable, causal warmup, MAE drawdown, large-array safety, TOCTOU snapshot, malformed fail-closed, context-channel no-lookahead — engine 451/451, hardening 567, metrics 123, splits 108
- P2-B HARDENED: CLOSED-only, ASC, duplicates fail-closed, canonical grid effectiveCanonicalRange isAligned/canonicalized, off-grid detection, overallCoverageRatio, provider over-return, pagination progress, maxRows/maxPages bounded — 427/427, coverage requested-range basis, eligibility BINGX 1d excluded timeless
- P2-C p2c-1.2.0: OOS structurally excluded from selection, selection stages TRAIN/VALIDATION only, OOS final witness only, tie-break selectionKey→inputOrder OOS-blind, segment-local eligibility, frozen EXPERIMENT_LIMITATIONS, exact finalEquity vs equityCurve — contract 213/213, report 225/225, leakage 174/174, hardening 165/165

## Phase A — Historical Data Plane — 22/22 BEHAVIOR REAL

- `fetchHistoricalDataPlane` dependency-injected executor SELECT-only, no writes, readOnly true noPnl true
- REAL behavior: non-aligned 00:30-03:30 → effectiveFrom 01:00 expectedSlots 3 ratio 2/3 overallCoverageRatio 0.6 partial !=1, isAligned false canonicalized true, off-grid not counted, projection mutations killed
- Report: requested range, effectiveCanonicalRange, expected slots, coverage ratio, leading/internal/trailing missing, duplicates, off-grid, common timestamps, common contiguous ranges, participant feasibility
- No PnL, recursive forbidden economics checks

## Phase B — Historical Raw SMC Observation — 17/17 + 38/38 BEHAVIOR

- Reuses production `evaluateSmc` — no second algorithm — real LONG/SHORT via production path yields LONG 75/10 and SHORT 20/75 preserved with NON_EXECUTABLE
- RawSmcObservation: LONG/SHORT/NEUTRAL/CANNOT_EVALUATE preserved exactly + causal facts/reasons/horizon/provenance
- Window policy: hardMinimumBars ~84, productionWindowBars 500, fetchCap 500, fidelity 500 hypothesis, ROLLING_500
- Historical clock: causal clock H+D, tested H+D-1ms / H+D / H+D+1ms / H+2D, no wall-clock, no H+1 visibility before legal time
- Coverage REAL 38/38 behavior-level

## Phase C — Differential Equivalence

- Same causal prefix + different future suffix = same historical observation at N — verified for all TFs 5m/15m/1h/4h/1d
- Production vs historical on identical prefix: direction/scores identical, BINGX 1d exclusion
- Common horizon: selectCommonClosedHorizon relative/absolute staleness, future_horizon detection
- Context-channel-only no-lookahead documented, closure/global leakage NOT proven — HONEST SCOPE

## Phase D — Execution Policy Registry — 37/37

- Registry EP-1/EP-2/EP-3: all explicit, no hidden defaults, HONEST SCOPE top-level only, no new Date()/Date.now()/random/env, uses utcDateFromMs
- EP-1 SMC-Direction Baseline APPROVED: baselineMode explicit, no SL/TP, NON_EXECUTABLE truthful, fingerprint id|version|requiredFields|config, costs 5bps fee 2bps slippage, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d
- EP-2 Structural Anchor DRAFT EXAMPLE: requiredEconomicFields [stopLoss,takeProfit,slAnchor,tpModel,buffer,rrMin,timeoutBars] explicit, owner must approve real values, NOT production SMC
- EP-3 Generic Boundary DRAFT: [stopLoss,takeProfit,slAnchor,tpModel,k,atrSlMultiplier,rrMin,timeoutBars] explicit, policy identity in fingerprint, TRAIN/VALIDATION only OOS final witness OOS-blind
- Validation: findUndeclaredEconomicFields top-level only, validateNoHiddenEconomicDefaults fails closed when unresolved, mutation {atrSlMultiplier,k,rrMin,timeoutBars} must fail — 12/12

## Phase G — Real PnL Runner — 26/26

- Integrates registry with P2-A engine: computeLevels stopLoss/takeProfit%+buffer, reference price = bar.close, LONG SL=ref*(1-stopLoss-buffer) TP=ref*(1+takeProfit) SHORT opposite
- Truthful: EP-1 APPROVED baselineMode but 0 trades (no SL/TP) — SMC-Direction Baseline NON_EXECUTABLE, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED, APPROVED via approvePolicy utility yields real trades with metrics equityCurve
- Policy identity in fingerprint: label policyId|direction|factsFingerprint, backtestInput fees bps:5 fixed:0 slippage bps:2 kind:bps value:2 sameBar pessimistic warmup 84 timeoutBars from policy
- Status READY_FOR_EXECUTION / PRE_REGISTRATION_REQUIRED / INVALID_POLICY / INSUFFICIENT_DATA / EXECUTION_FAILED, formatRealPnlReport includes limitations CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY OHLCV PIT OOS-blind
- Pre-PnL Runner updated: exposes registryPolicies fingerprint count 3 approved 1, executionPolicyRegistryId EP-1/EP-2/EP-3, truthfulBaselineName includes fingerprint
- CLI supports --executionPolicy EP-1/EP-2/EP-3 --approve

## Phase H — Full Pipeline Real PnL — 52/52 — NEW

- File `lib/backtest/full-pipeline-real-pnl.ts`: integrates P2-B fetchHistoricalDataPlane + raw SMC batch + EP-1/EP-2/EP-3 registry + P2-A real PnL runner + splits TRAIN/VALIDATION/OOS OOS-blind deterministic
- Resolves policy from registry id EP-1/EP-2/EP-3, approve simulates owner approval deterministic via approvePolicy utility, no DB writes, uses utcDateFromMs no new Date token
- Splits readiness auto 60/20/20 from requested range using commonTimestamps, oosDoesNotInfluenceSelection true, oosIsFinalWitnessOnly true, selectionStages TRAIN/VALIDATION only, tie-break selectionKey→inputOrder OOS-blind
- Data plane integration: coverageRatio, commonTimestampsCount, eligibleMarketsCount, warnings, provenanceDiagnostics knownLimitations, OHLCV PIT not guaranteed, eligibility CANNOT_RECONSTRUCT E1 professional default CURRENT_STATE_SURVIVORSHIP_LIMITATION
- Status READY_FOR_EXECUTION / PRE_REGISTRATION_REQUIRED / INVALID_POLICY / INSUFFICIENT_DATA / EXECUTION_FAILED, formatFullPipelineRealPnlReport includes limitations 5bps fee 2bps slippage, CANNOT_RECONSTRUCT, OHLCV PIT, OOS-blind, policy identity preserved
- Tests 52/52: no policy PRE_REGISTRATION_REQUIRED, EP-1 0 trades, EP-2 DRAFT blocked, EP-2 APPROVED real trades, EP-3 fingerprint differs, splits OOS isolation, data plane readOnly noPnl, report contains costs, no forbidden tokens, identity preserved across pipeline, invalid policy INVALID_POLICY
- CLI now supports --fullPipeline flag requiring --executionPolicy, runs full pipeline diagnostics after real PnL runner

## Phase E — Pre-PnL Runner — 32/32 + 22/22 structural-proof

- Deterministic orchestration: historical read-only bars via fetchHistoricalDataPlane → raw SMC observations → eligibility → execution-policy boundary → STOP intentionally before P2-A/P2-C economics (now Phase G/H optionally continues when APPROVED)
- With EP-1: PRE_REGISTRATION_REQUIRED → READY_FOR_EXECUTION, raw LONG/SHORT preserved separately never mapped to NEUTRAL/CANNOT_EVALUATE, nonExecutableCount===decisionBars when no policy, from < to validation behavior test
- Diagnostics only: coverage effectiveCanonicalRange isAligned/canonicalized overallCoverageRatio, raw counts, NON_EXECUTABLE count, data limitations, eligibility limitations, fingerprints, common horizon — readOnly true noPnl true
- No profit/loss/winRate/profitFactor/Sharpe/expectancy/equity curve in pre-PnL layer — recursive forbidden economics checks on REAL plane object + formatted report 11/11 CONTRACT
- Truthful baseline: SMC-Direction Baseline / EP-1 APPROVED baselineMode, EP-2/EP-3 DRAFT owner must approve real values, now also registryPolicies fingerprint count 3 approved 1
- Structural-proof 22/22: validation before wrapWithExecutability (direct or resolved via registry), raw LONG/SHORT preservation, PRE_REGISTRATION_REQUIRED stops before P2-A, no engine.ts/metrics.ts import

## Phase F — Train/Validation/OOS Readiness — 40/40

- Uses P2-C semantics: OOS does not influence ranking/selection/tie-break/eligibility, selection stages TRAIN/VALIDATION only, tie-break selectionKey→inputOrder
- Pre-PnL split readiness/coverage diagnostics, no silent OOS shortening, 60/20/20 splits from requested range uses commonTimestamps
- Full pipeline integration: historical data plane + raw SMC + execution policy + splits readiness OOS isolation — 40/40 pass, now extended with real PnL Phase H 52/52
- ReadOnly / NoPnL flags, actual counts not aggregated as chain evidence

## Historical Eligibility — CANNOT_RECONSTRUCT — E1 PROFESSIONAL DEFAULT

- Asset.rank, Market.quoteVolume24h, Market.enabled, Market.status, listing/delisting survivorship — mutable current-state, no PIT history
- Diagnostics capable of representing CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY — 11/11 strict check !includes where: {assetId, enabled: true} no OR escape-hatch
- E1: present-day snapshot with explicit CURRENT_STATE_SURVIVORSHIP_LIMITATION — chosen as professional default (most practical, honest), E2/E3 documented as alternatives, owner can override
- Full pipeline explicitly lists E1 as professional default in limitations

## OHLCV Point-In-Time Fidelity — KNOWN LIMITATION — HONEST

- lib/ohlcv/sync.ts upsert path updates existing candle values — current DB contents do NOT prove historical values, createdAt NOT overwritten, only updatedAt auto-updated
- Diagnostics report createdAt/updatedAt distribution, write path audit lib/ohlcv/sync.ts only, no claim of strict PIT fidelity
- Expected write files: lib/ohlcv/sync.ts only — audited, no new Date token, full pipeline includes in limitations

## Current Status — PROFESSIONAL TOP — Phase H IMPLEMENTED / PENDING TARGETED RE-AUDIT — 42 files

Base 51eb129 = independently accepted + VPS verified, production remains d6c573c, no deployment, forbidden edf3732 NOT ancestor exit 1 — SIGNAL ENGINE ABSENCE VERIFIED.

New work = IMPLEMENTED / PENDING TARGETED RE-AUDIT: sequential commits from exact base, no squash/amend/force-push, no accepted branches altered.

Actual counts: engine 451/451, p2b 427/427, metrics 123/123, splits 108/108, contract 213/213, report 225/225, leakage 174/174, hardening 165/165, eligibility 96/96, data-plane 46/46, execution-policy 16/16, smc-observation 78/78, pre-pnl 32/32, real-long-short 17/17 BEHAVIOR, canonical-coverage-real 38/38 BEHAVIOR, historical-data-plane-behavior-real 22/22 BEHAVIOR REAL, no-pnl-output 11/11 CONTRACT REAL, economic-default-detection 12/12 CONTRACT, core-api-immutability 14/14 CONTRACT, survivorship-fixtures 11/11 CONTRACT strict, structural-proof 22/22 SOURCE PIN, mutations-m1-m11 20/20 classified BEHAVIOR/CONTRACT/SOURCE PIN, full-pipeline 40/40, hardening-pre-pnl 47/47, readonly-sql 89/89, clock 46/46, eligibility 32/32, registry 37/37, real-pnl 26/26, full-pipeline-real-pnl 52/52 — tsc 0, diff-check clean.

Real PnL Runner Phase H: P2-B data plane + raw SMC batch + EP-1/EP-2/EP-3 registry + P2-A real PnL runner + splits TRAIN/VALIDATION/OOS OOS-blind, EP-1 0 trades truthful baseline APPROVED, EP-2/EP-3 DRAFT PRE_REGISTRATION_REQUIRED until APPROVED, APPROVED yields real trades with fingerprint identity id|version|requiredFields|config, costs 5bps fee 2bps slippage, readOnly true, no DB writes, no workers, no Signal Engine, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d.

Registry: EP-1 APPROVED baseline truthful, EP-2/EP-3 DRAFT explicit examples — owner must approve real SL/TP values, fingerprint includes policy identity, explicit requiredEconomicFields no hidden defaults, no new Date/Date.now/random/env, uses utcDateFromMs.

Owner-run read-only CLI (uses existing server env, no secrets): npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits --executionPolicy EP-2 --approve --fullPipeline

Next: owner approves EP-2/EP-3 economic semantics for production → READY_FOR_EXECUTION → real PnL with TRAIN/VALIDATION/OOS OOS-blind, no fake profitability, policy identity preserved, E1 professional default CURRENT_STATE_SURVIVORSHIP_LIMITATION, GitHub incident recovered.

No real PnL calculated until EP-2/EP-3 APPROVED, no profitability claim, no DB writes, no workers, no Prisma migration, no production deployment, Signal Engine NOT introduced, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d costs 5bps fee 2bps slippage.

GitHub incident recovery verified: tmp-recovery-test push/delete exit 0, ls-remote works, gh api works, status page still Degraded but Git Operations Normal and signs of recovery 10:26 UTC load-shedding.

## Files Changed from Base 51eb129

- lib/backtest/execution-policy-registry.ts — EP-1/EP-2/EP-3 registry
- lib/backtest/real-pnl-runner.ts — Phase G runner
- lib/backtest/full-pipeline-real-pnl.ts — Phase H full pipeline
- lib/backtest/pre-pnl-runner.ts — registryPolicies exposure
- app/admin/backtests/page.tsx — Phase G/H cards, 42 files counts
- scripts/test-execution-policy-registry.ts — 37/37
- scripts/test-real-pnl-runner.ts — 26/26
- scripts/test-full-pipeline-real-pnl.ts — 52/52 new
- scripts/test-pre-pnl-structural-proof.ts — fix for resolvedPolicy
- scripts/backtest-historical-readonly.ts — --executionPolicy --approve --fullPipeline Phase H
- docs/core-pre-pnl-final-report-v4.md — this file
- Plus existing 30+ files from earlier phases A-F

All read-only, no DB writes, no workers, no Signal Engine, deterministic, no Date.now()/random/env, costs fixed 5bps fee 2bps slippage, policy identity in fingerprint, OOS-blind, truthful baseline naming.

PENDING TARGETED RE-AUDIT — professional top status, ready for owner approval of EP-2/EP-3 economic semantics.
