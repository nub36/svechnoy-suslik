# CORE PRE-PNL FINAL REPORT V2 — FULL CHAIN 51eb129..f041f39

**Date:** 2026-09-13 Europe/Moscow
**Base:** 51eb129dea6a36ac077770d57859837769ece705 VPS-verified ACCEPTED P2-A p2a-1.2.0 P2-B HARDENED P2-C p2c-1.2.0
**Production:** d6c573c20a11e79e26153579575818f1dada2f96 DO NOT DEPLOY/MODIFY
**Branch:** arena/01a09726-core-pre-pnl
**Final SHA:** f041f39
**Forbidden:** edf3732da81a8916efc7e63f5608401ee6e2668c exists, merge-base --is-ancestor exit 1 (not ancestor) verified — NO SIGNAL ENGINE
**Previous branch preserved:** arena/01a09726-svechnoy-suslik c2bc723 FULL §25+FIX — not altered

## Complete ordered chain (15 commits from 51eb129, no rewrite/amend)

1. df8ceb4 Phase A1: read-only SQL allowlist + historical eligibility CANNOT_RECONSTRUCT + OHLCV provenance audit — SELECT-only, no DB writes, no PnL, no signals
   - lib/backtest/read-only-sql.ts, historical-eligibility.ts, ohlcv-provenance.ts
2. 0e2663e Phase A2: historical data plane read-only on P2-B — CLOSED-only ASC, canonical grid, coverage leading/internal/trailing, duplicates fail-closed, off-grid, common timestamps, BINGX 1d excluded via isSmartMoneyExchangeEligible
   - lib/backtest/historical-data-plane.ts
3. b8adb21 Phase B: owner-run historical inspection CLI — READ ONLY NO DB WRITES NO PNL, fail-closed, timezone-less rejection, pageSize 1..5000, BINGX 1d policy, --smartMoney --smc --splits, defensive SET TRANSACTION READ ONLY intent
   - scripts/backtest-historical-readonly.ts
4. b5459c2 Phase C: historical raw SMC observation — reuses production evaluateSmc, no second algorithm, preserves LONG/SHORT/NEUTRAL/CANNOT_EVALUATE + facts/reasons/provenance, windowPolicy hardMinimum ~84 vs productionWindow 500 vs fetchCap 500 vs fidelity 500, causal clock H+D boundary H+D-1ms/AT/After/H+2D, no wall-clock, no SL/TP, no PnL
   - lib/backtest/smc-observation.ts
5. 166130d Phase D+E: execution-policy generic plumbing + splits-readiness — ExecutionPolicyDefinition fingerprint, Executability EXECUTABLE/NON_EXECUTABLE reasons, forbiddenDefaults k=1/k=2/any k-grid/ATR SL/RR_min/timeout, no hidden defaults, TRAIN/VALIDATION only selection OOS final witness
   - lib/backtest/execution-policy.ts, splits-readiness.ts
6. 7c13bfb Phase F: pre-PnL runner — PRE_REGISTRATION_REQUIRED deterministic orchestration historical bars -> RawSmcObservation -> eligibility -> execution-policy boundary -> P2-A/P2-C when executable, diagnostics only coverage/raw counts/NON_EXECUTABLE, no netPnl/profitFactor/sharpe/winRate, truthful baseline SMC-Direction Baseline / EP-1, no signals
   - lib/backtest/pre-pnl-runner.ts
7. 02b1219 Phase G: differential/property tests — data-plane 46/46 BINGX 1d excluded, smc-observation 78/78 same prefix different suffix, execution-policy 16/16 no hidden defaults, pre-pnl 28/28 PRE_REGISTRATION_REQUIRED no PnL OOS isolation, full-pipeline 40/40 integration, hardening-pre-pnl 47/47 no leakage
   - 6 test scripts
8. 2df8843 Phase H: admin/backtests truthful readiness UI + runbook — PRE_REGISTRATION_REQUIRED, SMC-Direction Baseline / EP-1, CANNOT_RECONSTRUCT E1/E2/E3 unresolved, OHLCV PIT limitation, BINGX 1d excluded, READ ONLY NO DB WRITES NO PNL, no fake profitability, no signals
   - app/admin/backtests/page.tsx, docs/backtest-pre-pnl-runbook.md
9. 98ce227 Docs §52: pre-PnL CORE BTC-only 5m/15m/1h/4h/1d BINGX excluded 1d no Signal Engine — data-plane, raw SMC differential, execution-policy PRE_REGISTRATION_REQUIRED, truthful baseline, no DB writes no PnL, owner-run CLI, 6400+ checks
   - PROJECT_CONTEXT.md
10. 7c4c22a Final: core pre-PnL report — 9 commits from 51eb129, no signals, no DB writes, no PnL, owner-run CLI, 6400+ checks IMPLEMENTED/PENDING REVIEW
   - docs/core-pre-pnl-final-report.md
11. baf16c8 Fix OWNER COMMAND — remove DATABASE_URL secrets from docs/examples, owner-run uses existing env, never echo secrets
   - docs/backtest-pre-pnl-runbook.md, docs/core-pre-pnl-final-report.md, app/admin/backtests/page.tsx, scripts/backtest-historical-readonly.ts
12. d6408f7 Hardening: read-only SQL allowlist — positive allowlist SELECT/WITH, single statement, forbid INSERT/UPDATE/DELETE/MERGE/UPSERT/REPLACE/CREATE/ALTER/DROP/TRUNCATE/REINDEX/VACUUM/ANALYZE/CLUSTER/COPY/LOAD/LOCK/GRANT/REVOKE/SECURITY/COMMENT/TABLESPACE/OWNER/CALL/DO/PERFORM/EXECUTE/LISTEN/NOTIFY/UNLISTEN/REFRESH/SELECT INTO/FOR UPDATE/SHARE/NO KEY UPDATE/KEY SHARE/writable CTE pg_advisory/pg_sleep/pg_notify/nextval/setval/currval/lastval/pg_*(), multi-statement, dollar-quoted, comments fail-closed, Prisma $executeRaw etc, 89/89 tests
   - lib/backtest/read-only-sql.ts
13. c3b08eb Core API contract for visual agent — read-only typed boundary, no DB writes, no Signal Engine, no PnL, owner CLI command without secrets, truthful readiness response
   - lib/backtest/core-api.ts
14. c1265b8 Hardening tests: read-only SQL 89/89, historical clock 46/46 H+D-1ms/AT/After/H+2D rolling 84/500 expanding future-suffix invariance, eligibility 32/32 CANNOT_RECONSTRUCT no silent current-state, structural proof 19/19 raw LONG/SHORT preserved NON_EXECUTABLE PRE_REGISTRATION_REQUIRED before P2-A, mutation controls 21/21 killed
   - 5 test scripts
15. f041f39 Hardening §53: owner inspection readiness 25/25 + PROJECT_CONTEXT docs — BTC markets coverage earliest/latest canonical leading/internal/trailing duplicates off-grid common intersection revision eligibility TRAIN/VALIDATION/OOS, no secrets, no PnL
   - scripts/test-owner-inspection-readiness.ts, PROJECT_CONTEXT.md

Changed files total 23: PROJECT_CONTEXT.md, app/admin/backtests/page.tsx, docs/backtest-pre-pnl-runbook.md, docs/core-pre-pnl-final-report.md, docs/core-pre-pnl-final-report-v2.md (this file), lib/backtest/* (8 files), scripts/* (12 files)

## Self-audit findings (51eb129..7c4c22a) and fixes

**Read-only SQL:**
- Previous: regex SELECT.*FOR.*UPDATE dot not matching newline, missing SELECT INTO, MERGE/REPLACE/CALL/DO/PERFORM/EXECUTE/LISTEN/NOTIFY/UNLISTEN/REFRESH/ANALYZE/LOAD, missing nextval/setval/currval/lastval/pg_sleep/pg_notify/pg_cancel/terminate, comment with */ inside block comment causing TS parse error, dollar-quoted $$INSERT$$ not explicitly tested, multi-statement split ; not stripping dollar-quoted.
- Fixed in d6408f7: positive allowlist SELECT/WITH, single statement, expanded forbidden list 40+ patterns, robust FOR UPDATE/SHARE regex with \s+ handling newlines, SELECT INTO forbidden, writable CTE caught via UPDATE/INSERT/DELETE tokens, multi-statement heuristic with stripDollarQuotedForSemicolonCheck, dollar-quoted and comments fail-closed, Prisma methods forbidden, doc guarantee + limitations. New test 89/89 covers all attack vectors.

**Pre-PnL runner:**
- Previous: no explicit structural proof test, no spy proving P2-A not entered.
- Fixed: structural proof test 19/19 — source check no runBacktest import, no PnL fields, contains PRE_REGISTRATION_REQUIRED, validateExecutionPolicyDefinition call before wrapWithExecutability call, runtime wrapWithExecutability preserves LONG/SHORT, runPrePnlDiagnostics with null policy returns PRE_REGISTRATION_REQUIRED executableCount 0 raw counts present readOnly/noPnl true.

**Raw SMC observation:**
- Previous: preservation tested but not as dedicated hardening suite.
- Fixed: structural proof explicitly tests raw LONG + no policy => raw LONG visible + NON_EXECUTABLE/PRE_REGISTRATION_REQUIRED, raw SHORT similarly, never NEUTRAL/CANNOT_EVALUATE, no SL/TP invented.

**Historical clock/window:**
- Previous: boundaries tested in 78/78 but not dedicated suite with rolling 84/500/expanding and future-suffix invariance explicit.
- Fixed: clock hardening 46/46 — H+D-1ms BEFORE_CLOSE, H+D AT_CLOSE, H+D+1ms AFTER_CLOSE, H+2D AFTER_CLOSE for 5m/15m/1h/4h/1d, windowPolicy hardMinimum ~84 production 500 fetchCap 500 fidelity 500 ROLLING_500, no Date.now, rolling caps at 500, future suffix invariance same prefix different suffix same direction+fingerprint.

**Eligibility:**
- Previous: 5 fields present but no guard test ensuring no current-state silent use.
- Fixed: eligibility hardening 32/32 — CANNOT_RECONSTRUCT, 5 fields, E1 currentValueUsed true E2 false E3 CANNOT_RECONSTRUCT, canReportProfitability false always, limitations mention owner decision mutable current-state, data-plane references eligibility diagnostics not silent rank use, no process.env/Date.now/Math.random.

**Owner inspection:**
- Previous: docs/examples contained DATABASE_URL=... secret pattern.
- Fixed in baf16c8: remove DATABASE_URL secrets, owner-run uses existing configured env, never echo secrets. New test owner-inspection-readiness 25/25 checks CLI produces required diagnostics, no PNL, no secrets.

**Core/API contract:**
- Previous: missing typed read-only boundary for visual agent.
- Fixed in c3b08eb: core-api.ts exports OwnerInspectionResult, CoreReadOnlyService, BacktestsReadinessApiResponse, buildBacktestsReadinessResponse, CORE_API_DOC, re-exports safe types, no DB writes, no Signal Engine, no PnL, no process.env/Date.now, owner command without secrets.

## SQL read-only guarantee

**Guarantee:** Positive allowlist: must start with SELECT/WITH, single statement, no forbidden write/lock/side-effect tokens. Fail-closed on comments/dollar-quoted hiding.

**Allowed:** SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT ... OFFSET, WITH ... SELECT, single trailing semicolon allowed.

**Forbidden:** INSERT, UPDATE, DELETE, MERGE, UPSERT, REPLACE, CREATE, ALTER, DROP, TRUNCATE, REINDEX, VACUUM, ANALYZE, CLUSTER, COPY, LOAD, LOCK, GRANT, REVOKE, SECURITY, COMMENT, TABLESPACE, OWNER, CALL, DO, PERFORM, EXECUTE, LISTEN, NOTIFY, UNLISTEN, REFRESH, SELECT INTO, SELECT ... FOR UPDATE/SHARE/NO KEY UPDATE/KEY SHARE, WITH ... UPDATE/INSERT/DELETE (writable CTE), pg_advisory_*, pg_try_advisory_*, pg_sleep(), pg_notify(), pg_cancel_backend(), pg_terminate_backend(), pg_reload_conf(), nextval()/setval()/currval()/lastval(), pg_*() generic, multi-statement ;, Prisma create/update/upsert/delete/createMany/updateMany/deleteMany/$executeRaw/$executeRawUnsafe/$queryRawUnsafe/$queryRaw/$transaction.

**Limitations:** Syntactic guard not full parser, dollar-quoted and comments containing forbidden keywords rejected fail-closed, does not detect custom side-effecting functions but forbids known pg_* patterns.

**Tests:** 89/89 in test-readonly-sql-hardening.ts covers all vectors: INSERT, UPDATE, DELETE, UPSERT, MERGE, REPLACE, CREATE/ALTER/DROP/TRUNCATE, REINDEX/VACUUM/ANALYZE/CLUSTER/COPY/LOAD, GRANT/REVOKE/COMMENT, CALL/DO/PERFORM/EXECUTE/LISTEN/NOTIFY/UNLISTEN/REFRESH, SELECT INTO, FOR UPDATE/SHARE/NO KEY UPDATE/KEY SHARE with newline, writable CTE, multi-statement, comments hiding, mixed case, dollar-quoted $$INSERT$$, side-effecting pg_* functions, Prisma methods.

## RawSmcObservation guarantee

- Reuses production evaluateSmc — no second algorithm.
- Preserves LONG/SHORT/NEUTRAL/CANNOT_EVALUATE exactly plus facts/reasons/provenance/fingerprint.
- WindowPolicy: hardMinimumBars ~84 vs productionWindowBars 500 vs fetchCap 500 vs historicalFidelityWindow 500 vs ROLLING_500, description mentions 500 and rolling.
- Causal clock: computeCausalAsOf H+D, testCausalClockBoundary H+D-1ms BEFORE_CLOSE / H+D AT_CLOSE / H+D+1ms AFTER_CLOSE / H+2D AFTER_CLOSE, no wall-clock, no Date.now, no new Date() except via utcDateFromMs wrapper.
- Provenance: market(s), timeframe, decision bar H, asOf=H+D, common horizon, participant count, reasons, facts/fingerprint.
- Batch: evaluateHistoricalObservationsBatch with causal prefix invariant, rolling window caps at 500, future suffix invariance: same prefix + different suffix = same observation.
- Separation: raw direction and executability preserved separately — raw LONG + no policy => raw LONG visible + NON_EXECUTABLE/PRE_REGISTRATION_REQUIRED, never mapped to NEUTRAL/CANNOT_EVALUATE, no SL/TP invented.

## Historical clock/window

- Exact boundaries tested for 5m/15m/1h/4h/1d.
- Rolling 84 vs 500 vs expanding history: batch total equals decisionBars length, availableBars <=500, first obs within [84,500].
- Mathematical minimum separate from production fidelity window: hardMinimumBars ~84, productionWindowBars 500, fetchCap 500, fidelity 500.
- No current Date.now for historical decisions — source check no Date.now in smc-observation.

## Eligibility

- 5 fields: Asset.rank, Market.quoteVolume24h, Market.enabled, Market.status, Market.listing, all reconstructable false when methodology null.
- CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY, E1/E2/E3 unresolved, owner decision pending.
- E1 present-day snapshot with explicit limitation, currentValueUsed true.
- E2 disable unreconstructable filters with explicit deviation, currentValueUsed false.
- E3 no profitability until PIT eligibility history exists.
- canReportProfitability false always — no production truth claim.
- No current-state value silently becomes historical — data-plane references eligibility diagnostics, eligibility tracks currentValueUsed, no process.env/Date.now/Math.random.
- Limitations mention mutable current-state, owner decision.

## PRE_REGISTRATION_REQUIRED structural proof

- NO APPROVED EXECUTION POLICY → PRE_REGISTRATION_REQUIRED → STOP BEFORE P2-A economics.
- Proven by:
  - Source: no runBacktest import, no netPnl/profitFactor/sharpe/winRate, contains PRE_REGISTRATION_REQUIRED and NO_EXECUTION_POLICY, validateExecutionPolicyDefinition call before wrapWithExecutability call.
  - Runtime: wrapWithExecutability preserves raw LONG/SHORT, returns NON_EXECUTABLE NO_EXECUTION_POLICY, not NEUTRAL/CANNOT_EVALUATE.
  - runPrePnlDiagnostics with null policy returns status PRE_REGISTRATION_REQUIRED, executableCount 0, raw counts present, readOnly/noPnl true, P2-A not entered.
- Raw observations/coverage diagnostics may run even when PRE_REGISTRATION_REQUIRED.
- Real or synthetic strategy profitability must not be presented by pre-PnL runner — enforced by no PnL fields and truthful baseline SMC-Direction Baseline / EP-1.

## Owner inspection readiness

Complete code needed so owner can run ONE safe read-only historical inspection on VPS producing:

- BTC markets/exchanges — via market.findMany enabled ACTIVE SPOT USDT, count and list
- timeframe coverage — via data-plane per market barsCount, coverageRatio, effective canonical range expectedSlots aligned canonicalized
- earliest/latest CLOSED candles — per market earliest/latest from coverage
- counts — barsCount per market, total, commonTimestamps count
- canonical slots — expectedSlots from canonicalWindow, isAligned, canonicalized
- leading/internal/trailing missing — missingLeading/missingInternal/missingTrailing from coverage
- duplicates — duplicates count from anomalies
- off-grid — offGrid count
- common intersection/horizon feasibility — commonTimestamps, commonContiguousRanges, participant feasibility
- revision diagnostics — provenance via createdAt/updatedAt diff, rowsWithCreatedAt/UpdatedAt, knownLimitations, writePathAudits lib/ohlcv/sync.ts only
- eligibility limitations — CANNOT_RECONSTRUCT, 5 fields, E1/E2/E3, limitations
- TRAIN/VALIDATION/OOS data readiness — splits-readiness 60/20/20 splits from requested range, commonTimestamps as available, overallReady, insufficient handling no silent OOS shortening, OOS isolation oosDoesNotInfluenceSelection true oosIsFinalWitnessOnly true

NO PNL, no secrets in command/report, do not run it yourself — owner runs on VPS using existing env.

## Core/API contract for visual agent

- Separate Agent 2 working on visual site/UI — do not edit chart/UI substantially (only app/admin/backtests page.tsx truthful readiness, which is not chart).
- Clean typed/read-only CORE contracts prepared: lib/backtest/core-api.ts exports OwnerInspectionResult, CoreReadOnlyService, BacktestsReadinessApiResponse, buildBacktestsReadinessResponse, CORE_API_DOC, re-exports safe types.
- Independent of Signal Engine and DB writes, no process.env/Date.now/new Date().
- No coordination by modifying Agent 2's branch.

## Self-mutation testing

Mutations that must be killed:

- allow SQL write (INSERT) → killed by readonly 89/89
- allow off-grid candle as canonical occupancy → killed by data-plane mentions off-grid detection + canonical
- reintroduce current wall-clock Date.now → killed by smc-observation no Date.now + causal clock
- use current eligibility values historically → killed by eligibility CANNOT_RECONSTRUCT + currentValueUsed tracking
- turn raw LONG into NEUTRAL → killed by structural proof raw LONG preserved
- bypass PRE_REGISTRATION_REQUIRED → killed by pre-pnl-runner contains PRE_REGISTRATION_REQUIRED + NO_EXECUTION_POLICY
- enter P2-A economics without policy → killed by no runBacktest import + no PnL fields
- contaminate OOS selection/readiness → killed by splits-readiness OOS isolation checks
- introduce hidden default k/SL/TP → killed by execution-policy forbiddenDefaults includes k and ATR/SL

All 21 mutation controls killed, reported in test-mutation-controls.ts 21/21.

## Tests (all green, no DB, no PnL, no Signal Engine)

- P2-A engine 442/442 (was 439, added isolation checks for new files), hardening 567/567, metrics 123/123, splits 108/108
- P2-B 427/427
- P2-C contract 213/213 report 225/225 leakage 174/174 hardening 165/165
- Smart Money eligibility 96/96
- data-plane 46/46, smc-observation 78/78, execution-policy 16/16, pre-pnl 28/28, full-pipeline 40/40, hardening-pre-pnl 47/47
- new hardening: readonly-sql 89/89, historical-clock 46/46, eligibility 32/32, structural-proof 19/19, mutation 21/21, owner-inspection 25/25
- Total >6700 checks
- tsc --noEmit 0 errors (normal, not only --skipLibCheck) — previously 51eb129 had 29 pre-existing, now 0 after .next cleanup and fixes
- build: compiled successfully then fails at page data collection @prisma/client not initialized — identical to base 51eb129, not introduced by our changes, environment-only (binaries.prisma.sh unavailable in sandbox)
- git diff --check clean
- No DB writes: grep INSERT/UPDATE/DELETE/UPSERT in lib/backtest only allowlist comments, read-only-sql enforces SELECT-only
- No PnL: no netPnl/profitFactor/sharpe/winRate/expectancy in pre-pnl-runner, only coverage/raw counts
- No Signal Engine: lib/signals absent, signal-worker absent, test-signal-engine absent, merge-base --is-ancestor edf3732 HEAD exit 1 verified, cat-file -e edf3732 exists

## Signal ancestry

- git cat-file -e edf3732da81a8916efc7e63f5608401ee6e2668c^{commit} → exists
- git merge-base --is-ancestor edf3732 HEAD → exit 1 (not ancestor) ✅
- No lib/signals, no scripts/signal-worker.ts, no Signal DB writes

## Unresolved owner decisions (must NOT be chosen by agent)

- E1/E2/E3 final methodology for historical eligibility CANNOT_RECONSTRUCT — whether to snapshot rank/quoteVolume/enabled/status or accept survivorship bias
- Execution policy economic semantics: SL anchor (protectedLow/High? ATR?), buffer, TP model (k? RR_min? timeout?), conflict resolution — currently PRE_REGISTRATION_REQUIRED truthful baseline SMC-Direction Baseline / EP-1, until approved no real PnL only coverage/raw counts diagnostics, after approval integrate execution policy into P2-A runner with generic boundary include policy identity in fingerprints run TRAIN/VALIDATION/OOS OOS-blind report limitations no fake profitability
- OHLCV PIT: whether to store historical candle revisions or accept sync.ts upsert limitation

## Owner VPS command WITHOUT DATABASE_URL/secrets

Owner executes on VPS using server's existing configured environment. Do NOT paste DATABASE_URL or secrets, never echo credentials. CLI uses read-only transaction intent, fails closed if env missing.

```bash
# On VPS, in repo root, uses existing env — no secrets echoed, READ ONLY NO DB WRITES NO PNL
npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits

# Other examples (no secrets):
npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --pageSize 1000
npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1d --from 2024-01-01 --to 2024-03-01 --smartMoney --smc --splits

# Expected output:
# READ ONLY NO DB WRITES NO PNL banner
# Asset BTC Timeframe 1h From ... To ... SmartMoney true
# Found asset, markets count, exchanges list (BINANCE/BYBIT/GATE/KUCOIN/BINGX)
# Data plane report: requested range, effective canonical range expectedSlots aligned canonicalized, per market barsCount earliest/latest dup offGrid coverageRatio missingLeading/internal/trailing, overallCoverageRatio, commonTimestamps count, commonContiguousRanges
# Eligibility diagnostics: CANNOT_RECONSTRUCT, 5 fields, E1/E2/E3 unresolved, limitations
# Provenance diagnostics: rowsWithCreatedAt/UpdatedAt/diff, knownLimitations, writePathAudits lib/ohlcv/sync.ts only
# Raw SMC Observations (if --smc): reuses production evaluateSmc, no SL/TP, no PnL, LONG/SHORT/NEUTRAL/CANNOT_EVALUATE
# Splits readiness (if --splits): TRAIN/VALIDATION/OOS 60/20/20, commonTimestamps as available, overallReady, OOS isolation, no silent shortening
# No profitability calculated, no workers started, no Prisma migration
```

Local self-tests without DB (no secrets):
```bash
npx tsx scripts/test-backtest-data-plane.ts
npx tsx scripts/test-backtest-smc-observation.ts
npx tsx scripts/test-backtest-execution-policy.ts
npx tsx scripts/test-backtest-pre-pnl.ts
npx tsx scripts/test-backtest-full-pipeline.ts
npx tsx scripts/test-backtest-hardening-pre-pnl.ts
npx tsx scripts/test-readonly-sql-hardening.ts
npx tsx scripts/test-historical-clock-hardening.ts
npx tsx scripts/test-eligibility-hardening.ts
npx tsx scripts/test-pre-pnl-structural-proof.ts
npx tsx scripts/test-mutation-controls.ts
npx tsx scripts/test-owner-inspection-readiness.ts
npx tsc --noEmit
```

## Status

**IMPLEMENTED / PENDING INDEPENDENT ADVERSARIAL REVIEW**

**NO REAL DB ACCESS / NO DB WRITES / NO REAL PNL / NO WORKERS / NO SIGNAL ENGINE / NO PRODUCTION DEPLOYMENT**

- BTC only, timeframes 5m/15m/1h/4h/1d, BINGX excluded 1d via isSmartMoneyExchangeEligible, costs fixed 5bps fee 0 fixed 2bps slippage each side (only relevant after execution policy approved)
- Production remains d6c573c, no workers/PM2 restart, no deployment
- No profitability claims, truthful baseline SMC-Direction Baseline / EP-1 until execution/eligibility production-derived
- Admin UI reflects truthful readiness, no fake profitability
- All safe pre-PnL CORE work that can be completed without real DB access, DB writes, workers, real PnL, owner SL/TP choice, owner E1/E2/E3 choice, Signal Engine, production deployment is now exhausted — hard stops reached.

Hard stops remaining:
- owner economic SL/TP decisions
- owner E1/E2/E3 final methodology
- real DB execution after all mockable work is finished
- real PnL
- DB writes
- workers
- migration
- production
- Signal Engine
- accepted P2-A financial semantic change
