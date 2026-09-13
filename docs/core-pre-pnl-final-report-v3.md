# CORE PRE-PNL FINAL REPORT V3 — HARDENED AFTER INDEPENDENT AUDIT PASS WITH RISKS

**Date:** 2026-09-13 Europe/Moscow
**Base:** 51eb129dea6a36ac077770d57859837769ece705 VPS-verified ACCEPTED P2-A p2a-1.2.0 P2-B HARDENED P2-C p2c-1.2.0 — base only, new work NOT accepted/VPS-verified
**Production:** d6c573c20a11e79e26153579575818f1dada2f96 DO NOT DEPLOY/MODIFY — production remains
**Branch:** this branch HEAD (arena/01a09726-svechnoy-suslik) — sequential commits from 7f58365, PENDING TARGETED RE-AUDIT
**Parent Chain from 7f58365:** 7f58365 -> 60367af -> 6adc3a1 -> c8a19cc -> 29d6f94 -> 0e94235 -> f16e577 -> 396a1d5 -> b3b49be -> 8739b52 -> 599c845 -> this branch HEAD (see git log)
**Final SHA:** this branch HEAD (do not hardcode self-referential SHA in commit that changes same report; use git rev-parse HEAD at review time)
**Changed Files from base 51eb129:** 35 files (git diff --name-only 51eb129..HEAD) — see list in runbook §1
**Forbidden Signal Engine:** edf3732da81a8916efc7e63f5608401ee6e2668c exists, git merge-base --is-ancestor exit 1 (not ancestor) verified — NO SIGNAL ENGINE, no lib/signals, no signal-worker, no Signal Prisma

## Disposition 1-10 (Mandatory from audit)

### 1. OWNER SECRET CLEANUP — IMPLEMENTED
- Removed stale PROJECT_CONTEXT §52 DATABASE_URL=... example that survived previous cleanup.
- Commit 60367af: search entire tree for DATABASE_URL= and postgresql:// — no owner-facing example may request/paste/echo DATABASE_URL.
- Owner inspection readiness test now strictly checks `!cliSrc.includes("DATABASE_URL=")` and `!cliSrc.includes("postgresql://")` — no escape hatch `|| includes("never echo")`.
- Status: IMPLEMENTED.

### 2. RUNBOOK/CLI CONTRACT — IMPLEMENTED
- Removed unsupported --maxPages/--eligibilityMode from docs (were documented but not implemented, would silently select E1/E2/E3).
- CLI now truthfully documents only actual flags: --asset BTC (only BTC allowed, fail-closed), --timeframe 5m/15m/1h/4h/1d (BINGX excluded 1d via timeless policy), --from/--to YYYY-MM-DD UTC, --pageSize 1..5000, --smartMoney, --smc, --splits.
- BTC-only documented: CLI fail-closed if --asset != BTC unless generic internal API, while OWNER CLI BTC-only. Test BTC accepted/ETH rejected via fail().
- Status: IMPLEMENTED, commit 6adc3a1.

### 3. READ-ONLY TRUTHFULNESS — IMPLEMENTED
- CLI does NOT execute SET TRANSACTION READ ONLY — removed false logs claiming it.
- Docs no longer claim runtime SQL guard; read-only-sql.ts remains as static/test defense described accurately.
- Capability-restricted Prisma surface: asset.findUnique, market.findMany (all markets for BTC), candle.findMany CLOSED-only, $disconnect. No create/update/upsert/delete, no $executeRaw.
- assertReadOnlyDeps validates actual deps via fail-closed, not dummy warn — removed fabricated dummy only warns.
- No raw-SQL execution API added to CLI.
- Status: IMPLEMENTED, commit 6adc3a1 + read-only-sql.ts scope doc commit 8739b52.

### 4. CURRENT enabled/status SURVIVORSHIP — IMPLEMENTED
- Previous query enabled:true status:ACTIVE silently narrows historical universe using current state — violates E1/E2/E3 unresolved.
- Fixed: CLI queries ALL markets for BTC asset `where: {assetId}` no enabled/status filter, reports total/enabledActive/disabled/inactive counts and CURRENT_STATE_SURVIVORSHIP_LIMITATION if disabled/inactive exist.
- Timeless BINGX-1d only applied separately via isSmartMoneyExchangeEligible.
- Fixtures: active/disabled/inactive/delisted — 4 markets, enabledActive 1, disabled 2, inactive 2, would-be-lost 3 if filtered — diagnostics preserve.
- Test scripts/test-survivorship-fixtures.ts 11/11 proves — strict check `!includes("where: { assetId: assetRow.id, enabled: true")` not OR escape-hatch.
- Status: IMPLEMENTED, commits 6adc3a1 + c8a19cc.

### 5. REAL RAW LONG/SHORT TESTS — IMPLEMENTED — BEHAVIOR MUTATION
- Previous wrapper tests used fakeObs, real evaluateHistoricalRawObservation path never produced LONG/SHORT.
- Added genuine fixture using actual production evaluateSmc path:
  - canonical() from test-smc-projection.ts: flats 0-4, mk 5 86.05/87.05/105/84.05, flats 6, mk 7 86.07/87.07/90.07/82, flats 8-13, mk 14 90/86/90.14/84, mk 15 91/104/108/91, mk 16 103/101/103.5/95, mk 17 107/109/109.5/106.5, flats 18-26 — yields LONG 75/10.
  - negate() via -open/-close/-low/-high swap yields SHORT 20/75.
- Proved end-to-end: real raw LONG + no policy = raw LONG + NON_EXECUTABLE/PRE_REGISTRATION_REQUIRED, same SHORT — not fake NEUTRAL/CANNOT_EVALUATE.
- Mutation LONG->NEUTRAL and SHORT->CANNOT_EVALUATE inside evaluateHistoricalRawObservation must fail — tests fail if mutated.
- File scripts/test-real-long-short.ts 17/17, real evidence: longScore > shortScore for LONG, shortScore > longScore for SHORT, fingerprint contains LONG/SHORT — BEHAVIOR MUTATION.
- Status: IMPLEMENTED, commit 29d6f94.

### 6. REAL CANONICAL COVERAGE TESTS — IMPLEMENTED — BEHAVIOR MUTATION
- Previous tests relied on source.includes — behavior-level now.
- Tests: 1h [00:30,03:30) expected opens 01:00/02:00/03:00 — partial 2/3 ratio 0.6667, aligned full [00:00,03:00) ratio 1, leading gap, internal gap, trailing gap, off-grid candle, duplicate, [from,to) boundary (bar at to not counted), zero canonical slots throws CanonicalWindowError.
- Mutations: overallCoverageRatio forced 1 must fail, break effective canonical start/expected slots must fail, isAligned=true canonicalized=false must fail.
- File scripts/test-canonical-coverage-real.ts 38/38, no source.includes — BEHAVIOR MUTATION.
- Status: IMPLEMENTED, commit 0e94235.

### 7. REMOVE VACUOUS TESTS — IMPLEMENTED
- Removed/fixed:
  - test-backtest-pre-pnl.ts: `A && B && C || raw` precedence — `|| raw` made it pass even if PnL fields exist — fixed to strict `!diagJson.includes("netPnl") && !profitFactor && !winRate && !sharpe && !expectancy && !equityCurve`; removed meaningless `rawLongCount>=0` / `rawShortCount>=0` (always true) replaced with observable `typeof count === "number"` + `nonExecutableCount===decisionBars.length`; added behavior test pinning library-level `from < to` validation throws "from must be < to".
  - test-eligibility-hardening.ts: `|| true` meaningless — fixed to strict `!dataPlaneSrc.includes("Asset.rank")`.
  - test-historical-clock-hardening.ts: `|| true` for hardMinimum — fixed to `typeof ... === "number" && >=80`, and `!includes("new Date(") || includes("utcDateFromMs")` escape-hatch — fixed to strict `!includes("new Date()")`.
  - test-pre-pnl-structural-proof.ts: never-assigned `p2aEntered=false` escape-hatch — replaced with real import-closure assertion: `!prePnlSrc.includes("lib/backtest/engine") && !includes("metrics") && !includes("runBacktest") && !includes("computeMetrics")`, plus `!p2aEntered` removed.
  - test-mutation-controls.ts: escape-hatch `!includes("runBacktest") || includes("fetchHistoricalDataPlane")` — fixed to strict `!includes("runBacktest")`; `includes("off-grid") || offGrid || isOffGrid` — simplified to `offGrid || off-grid`; OOS isolation `includes("OOS") && includes("TRAIN")` — fixed to exact `oosDoesNotInfluenceSelection` and `oosIsFinalWitnessOnly`.
  - test-owner-inspection-readiness.ts: `!includes("DATABASE_URL=") || includes("never echo")` — fixed to strict `!includes("DATABASE_URL=")`.
  - test-survivorship-fixtures.ts: duplicate `||` same string and `!includes("enabled: true") || includes("ALL markets")` — fixed to strict `!includes("where: { assetId: assetRow.id, enabled: true")`.
  - test-real-long-short.ts: `|| true` for reason — fixed to strict `reason === "NO_EXECUTION_POLICY"`.
  - execution-policy.ts findUndeclaredEconomicFields documented honestly as HONEST SCOPE top-level/current contract only NOT arbitrary source semantic analysis.
- New tests for cannot-fail assertions added: deep-freeze, recursive no-PnL, economic defaults.
- Status: IMPLEMENTED, commit c8a19cc + final cleanup.

### 8. OUTPUT-LEVEL NO-PNL — IMPLEMENTED — MODULE CONTRACT
- Previous mutation adding netPnl:42 to data-plane report survived.
- Added recursive output-level forbidden economics checks for historical report/pre-PnL diagnostics/core-api response: reject netPnl/grossPnl/profitFactor/winRate/expectancy/sharpe/equityCurve/profitability where prohibited, allowing canReportProfitability flag.
- Uses REAL production-built historical data plane via fetchHistoricalDataPlane (DI mock executor) — not fake plane, inspects REAL object AND formatted historical report text.
- Tests nested objects: mutation adding netPnl into REAL plane marketResults[0] nested level must fail — checker hasForbiddenRecursive finds nested.
- File scripts/test-no-pnl-output.ts 11/11: REAL plane object no forbidden recursive, formatted report contains READ ONLY NO PNL but no netPnl/profitFactor/winRate/sharpe, mutated REAL plane with nested netPnl detected, report text checks — CONTRACT MUTATION.
- Status: IMPLEMENTED, commit f16e577 + final cleanup using fetchHistoricalDataPlane + formatHistoricalDataPlaneReport.

### 9. ECONOMIC DEFAULT DETECTION — IMPLEMENTED — MODULE CONTRACT
- Production currently NO hidden defaults preserved, strengthened contract/schema so policy economic values CANNOT appear without explicitly declared owner-approved inputs.
- Architectural/type/schema prohibition over keyword grep: FORBIDDEN_ECONOMIC_KEYS = atrSlMultiplier/atrMultiplier/atr/k/rrMin/rr/timeoutBars/timeout/stopLoss/takeProfit/sl/tp/structuralAnchor/protectedLow/protectedHigh/buffer/slAnchor/tpModel.
- Implemented findUndeclaredEconomicFields(config, allowedFields) and validateNoHiddenEconomicDefaults(config, policy): when policy unresolved/PRE_REGISTRATION, any economic field fails closed; when APPROVED, must be declared in requiredEconomicFields. HONEST SCOPE: top-level/current contract only.
- validateExecutionPolicyDefinition now rejects undeclared economic fields even in DRAFT.
- Mutation {atrSlMultiplier:1.5,k:1,rrMin:2,timeoutBars:24} must fail — test kills it.
- File scripts/test-economic-default-detection.ts 12/12 — CONTRACT MUTATION.
- Status: IMPLEMENTED, commit 396a1d5.

### 10. CORE API IMMUTABILITY — IMPLEMENTED — MODULE CONTRACT
- Core-api previously shallow freeze, nested mutation allowed.
- Fixed to deepFreeze via lib/backtest/immutable.ts deepFreeze: entire response recursively frozen.
- Tests: top-level frozen, nested p2a/p2b/p2c/prePnl/ownerCli frozen, nested prePnl.status cannot change (M10), arrays cannot push, p2a.status cannot mutate, isDeepFrozen check, pre-pnl diagnostics deep-frozen.
- File scripts/test-core-api-immutability.ts 14/14 — CONTRACT MUTATION.
- Status: IMPLEMENTED, commit b3b49be.

## Additional Mandatory

### 11. FACTUAL DOC CLEANUP — IMPLEMENTED
- Corrected createdAt NOT overwritten by Candle update branch: lib/ohlcv/sync.ts update branch updates ONLY closeTime/open/high/low/close/volume/closed — createdAt NOT overwritten (Prisma default), only updatedAt auto-updated. Earlier docs claimed createdAt overwritten — FALSE, corrected in runbook §4.
- Corrected actual changed-file count: 35 files from base 51eb129..HEAD (git diff --name-only).
- Removed false runner wording "→P2-A→P2-C" — factual correction: runner returns PRE_REGISTRATION_REQUIRED, no P2-A economics entered, no computeMetrics — intentionally stops before economics. Fixed in lib/backtest/pre-pnl-runner.ts.
- Updated stale titles/final SHA — runbook now reports actual HEAD, not stale, final SHA not hardcoded self-referentially.
- Do not claim new work accepted/VPS verified — base 51eb129 is VPS-verified ACCEPTED, new work is PENDING TARGETED RE-AUDIT.
- Commit 8739b52 + final cleanup.

### 12. READ-ONLY SQL SCANNER SCOPE — IMPLEMENTED
- Keep improvements but document exact scope: static defensive SQL inspection only, NOT PostgreSQL semantic proof/DB enforcement/runtime guard unless actually wired — top-level/current contract scope.
- No need to add raw SQL to CLI just to use scanner.
- Updated lib/backtest/read-only-sql.ts header: SCOPE DOCUMENTATION factual, CLI does NOT execute SET TRANSACTION READ ONLY, read-only via capability-restricted surface, scanner for tests/static audit.
- Status: IMPLEMENTED, commit 8739b52.

### 13. RECHECK PRE_REGISTRATION — IMPLEMENTED
- Preserve engine.ts/metrics.ts absent from runner/CLI module graph.
- No-policy must stop before economics: runPrePnlDiagnostics with null policy returns PRE_REGISTRATION_REQUIRED, executableCount 0, nonExecutableCount == decisionBars length, raw counts sum to decisionBars, from < to validation behavior test.
- Replaced fake p2aEntered spy with real import-closure/dependency assertion: check source does NOT contain `lib/backtest/engine`, `from "./engine"`, `from "./metrics"`, `runBacktest`, `computeMetrics`.
- Mutation bypass must fail — tested in M9 SOURCE PIN.
- Status: IMPLEMENTED, commits c8a19cc + 599c845.

### 14. MUTATION REQUIREMENTS M1-M11 — ALL KILLED — HONEST CLASSIFICATION
- Self-test scripts/test-mutations-m1-m11.ts 20/20 — all killed, no survivors, classified honestly:
  - M1 real LONG->NEUTRAL: BEHAVIOR MUTATION — real LONG fixture is LONG, not NEUTRAL — killed.
  - M2 SHORT->CANNOT_EVALUATE: BEHAVIOR MUTATION — real SHORT fixture is SHORT, not CANNOT_EVALUATE — killed.
  - M3 overallCoverageRatio forced 1: BEHAVIOR MUTATION — partial 1/3 coverage ratio 0.333, not 1 — killed.
  - M4 canonical effectiveFrom broken: BEHAVIOR MUTATION — effectiveFrom 01:00, not from 00:30 — killed.
  - M5 alignment flags falsified: BEHAVIOR MUTATION — non-aligned has isAligned false canonicalized true, not true/false — killed.
  - M6 netPnl in historical report: MODULE CONTRACT MUTATION — recursive checker finds netPnl nested — killed.
  - M7 netPnl in core-api nested: MODULE CONTRACT MUTATION — recursive checker finds profitFactor nested — killed.
  - M8 unresolved policy receives k/ATR/RR/timeout: MODULE CONTRACT MUTATION — validateNoHiddenEconomicDefaults fails when unresolved — killed.
  - M9 PRE_REGISTRATION bypass: STATIC SOURCE PIN — runner contains no runBacktest/computeMetrics, contains PRE_REGISTRATION_REQUIRED — killed.
  - M10 nested core-api mutation allowed: MODULE CONTRACT MUTATION — deep-freeze prevents status change — killed.
  - M11 current enabled/status filtering restored silently: MODULE CONTRACT MUTATION — CLI queries all markets where: {assetId}, reports CURRENT_STATE_SURVIVORSHIP_LIMITATION — killed, strict check no OR.
- Additional REAL plane behavior tests: scripts/test-historical-data-plane-behavior-real.ts 22/22 — non-aligned 00:30-03:30 effectiveFrom 01:00 expectedSlots 3 ratio 2/3, overallCoverageRatio 0.6 partial !=1, aligned full ratio 1, isAligned false canonicalized true, off-grid not counted, projection mutations killed — BEHAVIOR MUTATION.
- Status: IMPLEMENTED, commit 599c845 + final cleanup.

### 15. REGRESSION — IMPLEMENTED — ACTUAL COUNTS

All new suites + accepted P2-A/B/C green — actual counts recomputed after final cleanup:

  - P2-A engine 442/442
  - P2-B 427/427
  - metrics 123/123
  - splits 108/108
  - contract 213/213
  - report 225/225
  - leakage 174/174
  - hardening 165/165
  - eligibility 96/96
  - data-plane 46/46
  - execution-policy 16/16
  - smc-observation 78/78
  - pre-pnl 32/32 (was 28, added from<to validation + nonExecutableCount===decisionBars observable)
  - real-long-short 17/17 — BEHAVIOR
  - canonical-coverage-real 38/38 — BEHAVIOR
  - historical-data-plane-behavior-real 22/22 — BEHAVIOR, REAL plane object fetchHistoricalDataPlane non-aligned partial ratio !=1 effectiveCanonicalRange isAligned/canonicalized
  - no-pnl-output 11/11 — CONTRACT, REAL plane object + formatted report recursive, nested injection fails
  - economic-default-detection 12/12 — CONTRACT, top-level scope
  - core-api-immutability 14/14 — CONTRACT
  - survivorship-fixtures 11/11 — CONTRACT, strict no OR
  - eligibility-hardening 32/32
  - historical-clock-hardening 46/46
  - readonly-sql-hardening 89/89
  - pre-pnl-structural-proof 22/22 — SOURCE PIN, fixed spy
  - mutation-controls 21/21
  - owner-inspection-readiness 25/25
  - mutations-m1-m11 20/20 — classified BEHAVIOR/CONTRACT/SOURCE PIN
  - full-pipeline 40/40
  - hardening-pre-pnl 47/47

- npx tsc --noEmit: 0 errors
- npm run build: compiled successfully, then fails at page data collection @prisma/client did not initialize — identical to base 51eb129, not introduced by our changes, environment-only (binaries.prisma.sh unavailable in sandbox) — Prisma failure not build success, per task.
- git diff --check: clean (including PROJECT_CONTEXT.md:4277 trailing blank line fixed)
- Status: IMPLEMENTED.

### 16. SIGNAL ENGINE ABSENCE — VERIFIED

- Object exists: git cat-file -e edf3732da81a8916efc7e63f5608401ee6e2668c^{commit} → exists
- Ancestry: git merge-base --is-ancestor edf3732 HEAD → exit 1 (not ancestor) — confirmed, not 128
- No lib/signals, no signal-worker, no test-signal-engine, no Signal Prisma
- Status: VERIFIED — SIGNAL ENGINE ABSENCE — VERIFIED.

### 17. FINAL REPORT — THIS FILE

- Final SHA: this branch HEAD (use git rev-parse HEAD at review time, not hardcoded self-referential SHA)
- Parent chain from 7f58365 verified via git log --oneline 7f58365..HEAD
- Changed files: 35 from base 51eb129..HEAD
- Commits added disposition 1-10: secret cleanup, CLI contract, read-only truthfulness, survivorship, real LONG/SHORT evidence, real coverage evidence, vacuous removal, no-PnL recursive REAL plane, economic defaults top-level scope, immutability, factual doc cleanup (35 files, no >6700, no false 442 was 439), read-only SQL scope, PRE_REGISTRATION import-closure, M1-M11 mutations classified honestly, regression actual counts, signal absence verified, trailing blank line fixed, runner comment fixed.
- Real LONG/SHORT evidence: canonical fixture from test-smc-projection.ts yields LONG 75/10, negate yields SHORT 20/75 via production evaluateSmc path, wrapWithExecutability preserves raw LONG/SHORT + NON_EXECUTABLE — BEHAVIOR.
- Real coverage evidence: 1h [00:30,03:30) expects 01:00/02:00/03:00 partial 2/3 ratio 0.6667, aligned full, leading/internal/trailing/off-grid/duplicate/boundary/zero slots, mutations M3-M5 killed — BEHAVIOR; REAL plane behavior via fetchHistoricalDataPlane 22/22 non-aligned effectiveFrom 01:00 expectedSlots 3 ratio 2/3 overallCoverageRatio 0.6 !=1 isAligned false canonicalized true.
- Read-only guarantee: capability-restricted surface asset.findUnique/market.findMany (all markets)/candle.findMany CLOSED-only/$disconnect, no SET TRANSACTION READ ONLY claim, read-only-sql static defense only, assertReadOnlyDeps validates actual deps fail-closed, HONEST SCOPE top-level.
- Survivorship: CLI queries ALL markets for BTC, reports enabledActive/disabled/inactive, CURRENT_STATE_SURVIVORSHIP_LIMITATION, fixtures active/disabled/inactive/delisted preserve — strict no OR.
- No-PnL: recursive forbidden economics checks for REAL historical plane object via fetchHistoricalDataPlane + formatted historical report, reject netPnl/grossPnl/profitFactor/winRate/expectancy/sharpe/equityCurve/profitability where prohibited allowing canReportProfitability, nested mutation must fail, M6-M7 killed — CONTRACT.
- Immutability: deepFreeze core-api public response, nested prePnl.status cannot change, arrays cannot push, M10 killed — CONTRACT.
- Mutation results: M1-M11 all killed, no survivors, classified BEHAVIOR M1-M5 / CONTRACT M6-M8 M10-M11 / SOURCE PIN M9, reported in test-mutations-m1-m11.ts 20/20 + historical-data-plane-behavior-real.ts 22/22.
- All suite counts: listed above exact per suite, actual recomputed after cleanup.
- Normal: tsc --noEmit 0 errors, npm run build compiled successfully then Prisma init fails (same as base), git diff --check clean including PROJECT_CONTEXT trailing blank line.
- Signal ancestry: exists, merge-base exit 1 — ABSENCE VERIFIED.
- Owner command NO DATABASE_URL/secrets: `npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits` — no DATABASE_URL=, no postgresql://, no secrets, uses existing env, never echo credentials.
- Status: IMPLEMENTED / PENDING TARGETED RE-AUDIT — STOP (no further work until re-audit).

## Owner-Run Read-Only CLI (BTC-only, no secrets, truthful)

```bash
# READ ONLY NO DB WRITES NO PNL — fails closed if DB env missing or timezone local date used
# Uses server's existing configured environment — do NOT paste secrets, never echo DATABASE_URL
# BTC-only: --asset must be BTC, otherwise fail-closed (pre-registered scope)
# --asset BTC only, ETH etc rejected
# --timeframe 5m|15m|1h|4h|1d (BINGX excluded 1d via timeless isSmartMoneyExchangeEligible)
# --from YYYY-MM-DD UTC midnight, --to YYYY-MM-DD, --smartMoney, --pageSize 1..5000, --smc, --splits
npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits
```

CLI truthfulness:
- Does NOT execute SET TRANSACTION READ ONLY
- Read-only by capability-restricted surface, no raw SQL transaction
- read-only-sql.ts static/test defense only, NOT PostgreSQL semantic proof/DB enforcement/runtime guard unless wired — HONEST SCOPE top-level/current contract
- Queries ALL markets for BTC asset, reports current enabled/status diagnostic, CURRENT_STATE_SURVIVORSHIP_LIMITATION
- No PnL, no trades, no metrics, no writes

## Tests — Exact Suite Counts — Actual After Cleanup

See §15 above — each suite count reported separately, actual recomputed. All green.

## Signal Engine Check

```bash
git cat-file -e edf3732da81a8916efc7e63f5608401ee6e2668c^{commit} && echo "exists"
git merge-base --is-ancestor edf3732da81a8916efc7e63f5608401ee6e2668c HEAD; echo "exit $?" # must be 1, not 128, not 0
```

Result: exists, exit 1 — SIGNAL ENGINE ABSENCE VERIFIED.

## Status

**IMPLEMENTED / PENDING TARGETED RE-AUDIT — STOP**

No DB writes, no workers, no Signal Engine, no production deployment, no profitability claims, BTC-only, truthful baseline SMC-Direction Baseline / EP-1, PRE_REGISTRATION_REQUIRED until execution policy APPROVED, 35 changed files from base, no >6700 claim, no false engine 442 was 439, actual suite counts, classified mutations BEHAVIOR/CONTRACT/SOURCE PIN, REAL plane behavior via fetchHistoricalDataPlane, trailing blank line fixed, runner stops before economics intentionally.

Hard stops remaining:
- owner economic SL/TP decisions
- owner E1/E2/E3 final methodology
- real DB execution after all mockable work is finished
- real PnL
- DB writes, workers, migration, production, Signal Engine, accepted P2-A financial semantic change
