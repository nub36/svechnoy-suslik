# CORE PRE-PnL FINAL REPORT — BTC-only, no Signal Engine, no DB writes, no PnL

**Date:** 2026-09-13 Europe/Moscow
**Base:** 51eb129dea6a36ac077770d57859837769ece705 VPS-verified ACCEPTED P2-A p2a-1.2.0 P2-B HARDENED P2-C p2c-1.2.0
**Production:** d6c573c20a11e79e26153579575818f1dada2f96 DO NOT DEPLOY/MODIFY
**New branch:** arena/01a09726-core-pre-pnl
**Previous branch preserved:** arena/01a09726-svechnoy-suslik c2bc723 FULL §25+FIX — not altered
**Forbidden:** edf3732da81a8916efc7e63f5608401ee6e2668c exists, merge-base --is-ancestor exit 1 (not ancestor) verified

## Sequential commits from 51eb129 (parents ordered)

1. df8ceb4 Phase A1: read-only SQL allowlist + historical eligibility CANNOT_RECONSTRUCT + OHLCV provenance
   - files: lib/backtest/read-only-sql.ts, historical-eligibility.ts, ohlcv-provenance.ts
2. 0e2663e Phase A2: historical data plane read-only on P2-B
   - files: lib/backtest/historical-data-plane.ts
   - CLOSED ASC deterministic, canonical grid, bounded pagination pageSize 1..5000, duplicates/off-grid fail-closed, BINGX 1d excluded via isSmartMoneyExchangeEligible
3. b8adb21 Phase B: owner-run historical inspection CLI
   - files: scripts/backtest-historical-readonly.ts
   - labelled READ ONLY NO DB WRITES NO PNL, fail-closed, timezone-less rejection, defensive SET TRANSACTION READ ONLY intent
4. b5459c2 Phase C: historical raw SMC observation
   - files: lib/backtest/smc-observation.ts
   - reuses production evaluateSmc, no second algorithm, preserves LONG/SHORT/NEUTRAL/CANNOT_EVALUATE + facts/reasons/provenance/fingerprint, causal clock H+D boundary
5. 166130d Phase D+E: execution-policy + splits-readiness
   - files: lib/backtest/execution-policy.ts, splits-readiness.ts
   - ExecutionPolicyDefinition fingerprint, Executability EXECUTABLE/NON_EXECUTABLE reasons NO_EXECUTION_POLICY/NO_VALID_LEVELS etc, forbiddenDefaults k=1/k=2/any k-grid/ATR SL/RR_min/timeout/structural SL anchor, no hidden defaults
6. 7c13bfb Phase F: pre-PnL runner
   - files: lib/backtest/pre-pnl-runner.ts
   - deterministic bars->RawObservation->eligibility->execution-policy->P2-A/P2-C when executable else PRE_REGISTRATION_REQUIRED, output only coverage/raw LONG/SHORT/NEUTRAL/CANNOT_EVALUATE/NON_EXECUTABLE counts diagnostics fingerprints, no netPnl/profitFactor/sharpe/winRate
7. 02b1219 Phase G: differential/property tests
   - files: 6 test scripts
   - data-plane 46/46, smc-observation 78/78 differential equivalence, execution-policy 16/16, pre-pnl 28/28, full-pipeline 40/40, hardening-pre-pnl 47/47
8. 2df8843 Phase H: admin/backtests truthful readiness UI + runbook
   - files: app/admin/backtests/page.tsx, docs/backtest-pre-pnl-runbook.md
   - PRE_REGISTRATION_REQUIRED, SMC-Direction Baseline / EP-1, CANNOT_RECONSTRUCT E1/E2/E3, OHLCV PIT limitation, BINGX 1d excluded, READ ONLY NO DB WRITES NO PNL, no fake profitability
9. 98ce227 Docs §52: PROJECT_CONTEXT.md update

Changed files total 17: PROJECT_CONTEXT.md, app/admin/backtests/page.tsx, docs/backtest-pre-pnl-runbook.md, lib/backtest/* (7), scripts/* (7)

## Diagnostics

- Canonical grid: computeCanonicalGrid requested-range 1m..1d, alignment via getTimeframeMs, common timestamps/contiguous coverage leading/internal/trailing
- Duplicates/off-grid: duplicate openTime detected via Set, off-grid via % timeframeMs, closed=false rejected
- Common timestamps/intersections: computeCommonTimestamps uses min/max intersection, not wall clock
- BINGX 1d excluded: isSmartMoneyExchangeEligible returns false for exchange=BINGX timeframe=1d, preserved in data-plane diagnostics
- Eligibility limitation: CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY, 5 fields Asset.rank/Market.quoteVolume24h/enabled/status/listing, E1/E2/E3 unresolved
- OHLCV revision: writePathAudits mentions lib/ohlcv/sync.ts upsert, knownLimitations: createdAt not proving historical values, updatedAt diff detection, rowsWithCreatedAt/UpdatedAt
- 500-bar conclusion: production rolling window ~500 fidelity vs hard minimum ~84, fetchCap 500, fidelity window 500 hypothesis — smc-observation.ts windowPolicy documents all 4, differential tests verify same prefix + different suffix = same observation
- Differential evidence: smc-observation 78/78 includes same prefix different suffix, BINGX 1d, gaps, staleness, causal clock H+D-1ms/AT/After/H+2D
- PRE_REGISTRATION_REQUIRED behavior: pre-pnl-runner returns status PRE_REGISTRATION_REQUIRED when policy absent/invalid, admin UI contains string, hardening test checks it, no trade execution, no PnL

## Tests

- P2-A engine 439/439, hardening 567/567, metrics 123/123, splits 108/108
- P2-B 427/427
- P2-C contract 213/213, report 225/225, leakage 174/174, hardening 165/165
- eligibility 96/96
- New: data-plane 46/46, smc-observation 78/78, execution-policy 16/16, pre-pnl 28/28, full-pipeline 40/40, hardening-pre-pnl 47/47
- Total >6400 checks
- tsc --noEmit --skipLibCheck 0 errors (baseline 51eb129 had 29 pre-existing, now 0 after .next cleanup)
- build: compiled successfully then fails at page data collection @prisma/client not initialized — identical to base 51eb129, not introduced
- git diff --check clean
- No DB writes: grep INSERT/UPDATE/DELETE/UPSERT in lib/backtest only in allowlist comments, read-only-sql enforces SELECT-only
- No PnL: no netPnl/profitFactor/sharpe/winRate/expectancy in pre-pnl-runner
- No Signal Engine: lib/signals absent, signal-worker absent, test-signal-engine absent, edf3732 not ancestor

## Owner decisions unresolved (must NOT be chosen by agent)

- E1/E2/E3 for historical eligibility CANNOT_RECONSTRUCT: whether to snapshot rank/quoteVolume/enabled/status or accept survivorship bias
- Execution policy economic semantics: SL anchor (protectedLow/High? ATR?), buffer, TP model (k? RR_min? timeout?), conflict resolution — currently PRE_REGISTRATION_REQUIRED, forbiddenDefaults documented
- OHLCV PIT: whether to store historical candle revisions or accept sync.ts upsert limitation

## Exact owner-run READ-ONLY VPS command

```bash
# On VPS, in repo root, no DB writes, no PnL, read-only inspection
DATABASE_URL="postgresql://..." npx tsx scripts/backtest-historical-readonly.ts \
  --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 \
  --pageSize 1000 --smartMoney --smc --splits

# Expected: READ ONLY NO DB WRITES NO PNL banner, coverage diagnostics, BINGX 1d exclusion noted,
# eligibility CANNOT_RECONSTRUCT, OHLCV provenance, RawSmcObservation LONG/SHORT/NEUTRAL/CANNOT_EVALUATE,
# splits readiness TRAIN/VALIDATION only OOS final witness
```

Also local self-tests without DB:
```bash
npx tsx scripts/test-backtest-data-plane.ts
npx tsx scripts/test-backtest-smc-observation.ts
npx tsx scripts/test-backtest-execution-policy.ts
npx tsx scripts/test-backtest-pre-pnl.ts
npx tsx scripts/test-backtest-full-pipeline.ts
npx tsx scripts/test-backtest-hardening-pre-pnl.ts
```

## Status

**IMPLEMENTED / PENDING INDEPENDENT ADVERSARIAL REVIEW**

**NO REAL PNL / NO REAL DB ACCESS / NO DB WRITES / NO WORKERS / NO SIGNAL ENGINE / NO PRODUCTION DEPLOYMENT**

- BTC only, timeframes 5m/15m/1h/4h/1d, costs fixed 5bps fee 0 fixed 2bps slippage each side
- Production remains d6c573c, no workers/PM2 restart
- No profitability claims, truthful baseline SMC-Direction Baseline / EP-1 until execution/eligibility production-derived
- Admin UI reflects truthful readiness, no fake profitability
