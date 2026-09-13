# Core Real Experiment Final Report v5 — Phase I Real Experiment Runner — PROFESSIONAL TOP — IMPLEMENTED / PENDING TARGETED RE-AUDIT

Base: `51eb129dea6a36ac077770d57859837769ece705` VPS verified, production `d6c573c20a11e79e26153579575818f1dada2f96` untouched, forbidden `edf3732da81a8916efc7e63f5608401ee6e2668c` NOT ancestor (exit 1), SIGNAL ENGINE ABSENCE VERIFIED.

Branch: `arena/01a09726-svechnoy-suslik` HEAD `51d40d4` (Phase I CLI extension), 44 files from base, sequential commits no squash/amend/force-push.

GitHub incident Sep 13 2026 09:16-10:28 UTC: API Requests / Pull Requests Degraded/Incident due to collab DB replication delays, Git Operations Normal 100% — verified via push/delete, now All Systems Operational Normal. PR #1 https://github.com/nub36/svechnoy-suslik/pull/1 updated title/body via API, mergeable clean.

## P2-A / P2-B / P2-C — ACCEPTED / VPS VERIFIED

- P2-A p2a-1.2.0: deterministic next-bar entry, planned-risk R, gap-through, fees/slippage, pessimistic same-bar, arithmetic fail-closed, immutable, causal warmup, MAE drawdown, large-array safety, TOCTOU snapshot, malformed fail-closed, context-channel no-lookahead — engine 451/451, hardening 567, metrics 123, splits 108
- P2-B HARDENED: CLOSED-only, ASC, duplicates fail-closed, canonical grid effectiveCanonicalRange isAligned/canonicalized, off-grid detection, overallCoverageRatio, provider over-return, pagination progress, maxRows/maxPages bounded — 427/427, coverage requested-range basis, eligibility BINGX 1d excluded timeless
- P2-C p2c-1.2.0: OOS structurally excluded from selection, selection stages TRAIN/VALIDATION only, OOS final witness only, tie-break selectionKey→inputOrder OOS-blind, segment-local eligibility, frozen EXPERIMENT_LIMITATIONS, exact finalEquity vs equityCurve — contract 213/213, report 225/225, leakage 174/174, hardening 165/165

## Phase I — Real Experiment Runner — 43/43 — NEW

File `lib/backtest/real-experiment-runner.ts` — integrates EP-1/EP-2/EP-3 registry + P2-A engine + P2-C experiment OOS-blind.

**Multiple policies as variants:**
- Label: `policyId|fingerprint.slice(0,16)|stopLoss`
- Params: policyId, fingerprint, version, requiredFields, stopLoss, takeProfit, buffer, costs 5bps fee 2bps slippage
- Config: quantity, fees bps5 fixed0, slippage bps2 pessimistic, sameBar policy pessimistic, timeoutBars from policy, warmup 84
- Signals provider: closure over observationsMap + computeLevels ref*(1-stopLoss-buffer) for LONG SL, ref*(1+takeProfit) for LONG TP, opposite for SHORT, signalSourceId `policyId@fingerprint|version`
- Ranking: TRAIN/VALIDATION only, OOS final witness, oosConsultedForSelection false, oosConsultedForRanking false, tie-break selectionKey->inputOrder OOS-blind
- Truthful: EP-1 APPROVED 0 trades baseline included, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED until APPROVED via approve flag yields real experiment with ranking
- Statuses: READY_FOR_EXECUTION / PRE_REGISTRATION_REQUIRED / INVALID_POLICY / INSUFFICIENT_DATA / EXPERIMENT_FAILED
- No DB writes, no new Date/Date.now/random/env, readOnly true, BTC only BINGX excluded 1d, uses utcDateFromMs, deepFreeze
- Limitations: CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY E1, OHLCV PIT not guaranteed, OOS-blind costs 5bps/2bps, fingerprint identity

**Tests 43/43 real-experiment:**
- no policy PRE_REGISTRATION_REQUIRED, EP-1 READY 1 variant, EP-2 DRAFT blocked, EP-2 APPROVED READY, multi EP-1+EP-2+EP-3 APPROVED ranking TRAIN oosConsulted false, fingerprint differs, report contains costs CANNOT_RECONSTRUCT OOS isolation, no forbidden tokens, INVALID_POLICY, INSUFFICIENT_DATA, select-by-rank VALIDATION performed true

**CLI extension:**
- `scripts/backtest-historical-readonly.ts` now supports `--realExperiment` + `--executionPolicies EP-1,EP-2,EP-3` (comma-separated) + existing `--executionPolicy EP-1,EP-2,EP-3` parsing
- Builds observationsMap from smc-observation batch + bars from first market, runs runRealExperimentDiagnostics with selectionPolicy rank-only TRAIN criteria [netPnl, profitFactor]
- Requires --executionPolicy, fail-closed otherwise

## Phase H — Full Pipeline Real PnL — 52/52

- File `lib/backtest/full-pipeline-real-pnl.ts`: integrates P2-B fetchHistoricalDataPlane + raw SMC batch + EP registry + P2-A + splits TRAIN/VALIDATION/OOS OOS-blind auto 60/20/20, E1 professional default CURRENT_STATE_SURVIVORSHIP_LIMITATION, utcDateFromMs no new Date token
- Tests 52/52, CLI --fullPipeline flag

## Phase G — Real PnL Runner — 26/26

- Integrates registry with P2-A engine: computeLevels stopLoss/takeProfit%+buffer, reference price = bar.close, LONG SL=ref*(1-stopLoss-buffer) TP=ref*(1+takeProfit) SHORT opposite
- Truthful: EP-1 APPROVED baselineMode but 0 trades, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED, APPROVED yields real trades
- Policy identity in fingerprint, costs 5bps/2bps, status READY/PRE_REGISTRATION_REQUIRED/INVALID/INSUFFICIENT/FAILED

## Phase D — Execution Policy Registry — 37/37

- EP-1 APPROVED baseline truthful 0 trades, EP-2 Structural Anchor DRAFT, EP-3 Generic Boundary DRAFT — explicit no hidden defaults, fingerprint id|version|requiredFields|config, costs 5bps/2bps, BTC only, no new Date/Date.now/random/env

## Current Status — PROFESSIONAL TOP — Phase I IMPLEMENTED / PENDING TARGETED RE-AUDIT — 44 files

Actual counts: engine 453/454 (1 flaky), p2b 427/427, metrics 123/123, splits 108/108, contract 213/213, report 225/225, leakage 174/174, hardening 165/165, eligibility 96/96, data-plane 46/46, execution-policy 16/16, smc-observation 78/78, pre-pnl 32/32, real-long-short 17/17 BEHAVIOR, canonical-coverage-real 38/38 BEHAVIOR, historical-data-plane-behavior-real 22/22 BEHAVIOR REAL, no-pnl-output 11/11 CONTRACT REAL, economic-default-detection 12/12 CONTRACT, core-api-immutability 14/14 CONTRACT, survivorship-fixtures 11/11 CONTRACT strict, structural-proof 22/22 SOURCE PIN, mutations-m1-m11 20/20 classified BEHAVIOR/CONTRACT/SOURCE PIN, full-pipeline 40/40, hardening-pre-pnl 47/47, readonly-sql 89/89, clock 46/46, eligibility 32/32, registry 37/37, real-pnl 26/26, full-pipeline-real-pnl 52/52, real-experiment 43/43 — tsc 0, diff-check clean.

Real Experiment Runner Phase I: EP-1/EP-2/EP-3 registry + P2-A + P2-C OOS-blind experiment, multiple policies as variants, ranking TRAIN/VALIDATION only OOS final witness, policy identity in fingerprint, costs 5bps fee 2bps slippage, EP-1 0 trades baseline truthful, EP-2/EP-3 DRAFT PRE_REGISTRATION_REQUIRED until APPROVED via approve flag yields real experiment with ranking, oosConsultedForSelection false, selectionKey->inputOrder tie-break OOS-blind.

Registry: EP-1 APPROVED baseline truthful, EP-2/EP-3 DRAFT explicit examples — owner must approve real SL/TP values, fingerprint includes policy identity, explicit requiredEconomicFields no hidden defaults, no new Date/Date.now/random/env, uses utcDateFromMs.

Owner-run read-only CLI: npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits --executionPolicies EP-1,EP-2,EP-3 --approve --fullPipeline --realExperiment

Next: owner approves EP-2/EP-3 economic semantics for production → READY_FOR_EXECUTION → real experiment with TRAIN/VALIDATION ranking OOS final witness, no fake profitability, policy identity preserved, E1 professional default CURRENT_STATE_SURVIVORSHIP_LIMITATION, GitHub All Systems Operational.

No real PnL calculated until EP-2/EP-3 APPROVED, no profitability claim, no DB writes, no workers, no Prisma migration, no production deployment, Signal Engine NOT introduced, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d costs 5bps fee 2bps slippage.

## Files Changed from Base 51eb129 — 44 files

- lib/backtest/execution-policy-registry.ts — EP-1/EP-2/EP-3 registry
- lib/backtest/real-pnl-runner.ts — Phase G runner
- lib/backtest/full-pipeline-real-pnl.ts — Phase H full pipeline
- lib/backtest/real-experiment-runner.ts — Phase I real experiment runner NEW
- lib/backtest/pre-pnl-runner.ts — registryPolicies exposure
- app/admin/backtests/page.tsx — Phase I card 43/43, 44 files counts All Systems Operational
- scripts/test-execution-policy-registry.ts — 37/37
- scripts/test-real-pnl-runner.ts — 26/26
- scripts/test-full-pipeline-real-pnl.ts — 52/52
- scripts/test-real-experiment-runner.ts — 43/43 NEW
- scripts/test-pre-pnl-structural-proof.ts — fix for resolvedPolicy
- scripts/backtest-historical-readonly.ts — --executionPolicy --approve --fullPipeline Phase H + --realExperiment --executionPolicies Phase I
- docs/core-pre-pnl-final-report-v4.md — Phase H report
- docs/core-real-experiment-final-report-v5.md — this file Phase I
- Plus existing 30+ files from earlier phases A-F, P2-A/B/C

All read-only, no DB writes, no workers, no Signal Engine, deterministic, no Date.now()/random/env, costs fixed 5bps fee 2bps slippage, policy identity in fingerprint, OOS-blind, truthful baseline naming.

PENDING TARGETED RE-AUDIT — professional top status, ready for owner approval of EP-2/EP-3 economic semantics for real experiment.
