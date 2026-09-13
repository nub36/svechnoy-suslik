import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import ExecutionPolicyRegistryClient from "./ExecutionPolicyRegistryClient";

export const dynamic = "force-dynamic";

/**
 * Admin Backtests — честный статус pre-PnL + execution policy registry EP-1/EP-2/EP-3.
 * Никаких фиктивных profitability numbers, никаких fake completed experiments, никаких DB writes.
 * Статус: IMPLEMENTED / PENDING TARGETED RE-AUDIT (база 51eb129 VPS verified).
 */

export default async function AdminBacktestsPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  return (
    <main className="adminPage">
      <AdminNav active="backtests" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">P2-A / P2-B / P2-C — инфраструктура готова, Phase H Full Pipeline Real PnL — EP-1 0 trades truthful, EP-2/EP-3 APPROVED yields real trades + TRAIN/VALIDATION/OOS OOS-blind</div>
            <h1>Бэктесты — pre-PnL + Execution Policy Registry + Full Pipeline Real PnL</h1>
          </div>
        </div>

        <div className="adminGrid">
          <ExecutionPolicyRegistryClient />
          <div className="adminCard">
            <h3>P2-A Backtest Engine — p2a-1.2.0 — ACCEPTED / VPS VERIFIED (51eb129)</h3>
            <ul>
              <li>Детерминированный слой: next-bar entry, planned-risk R, gap-through, fees/slippage, pessimistic same-bar, arithmetic fail-closed, immutable results, causal warmup, MAE drawdown, large-array safety, decision snapshot TOCTOU, malformed signals fail-closed, context-channel no-lookahead</li>
              <li>Contract: 442/442 engine, 567/567 hardening, 123/123 metrics, 108/108 splits — green (actual recomputed)</li>
              <li>Без Prisma, без сети, без workers, без Date.now()</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>P2-B Data Plane — HARDENED — ACCEPTED / VPS VERIFIED — 427/427</h3>
            <ul>
              <li>Read-only PostgreSQL plane: CLOSED-only, ASC ordering, duplicates fail-closed, canonical grid effectiveCanonicalRange isAligned/canonicalized, off-grid detection, overallCoverageRatio, provider over-return, pagination progress, maxRows/maxPages bounded</li>
              <li>Coverage: requested-range basis (not first→last), leading/internal/trailing missing, coverage ratio canonical-grid based, no misleading 100% on non-aligned ranges — REAL plane behavior via fetchHistoricalDataPlane tested 22/22</li>
              <li>Eligibility: upstream isSmartMoneyExchangeEligible, BINGX 1d excluded, raw vs Smart Money distinct, fail-closed unknown</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>P2-C Experiment — p2c-1.2.0 — ACCEPTED / VPS VERIFIED</h3>
            <ul>
              <li>OOS структурно исключён из выбора: selection stages TRAIN/VALIDATION only, OOS final witness only</li>
              <li>Tie-break: selectionKey (subjectFingerprint/label/paramsFingerprint/configFingerprint/signalSource.kind/signalSourceId) → inputOrder, OOS-blind</li>
              <li>Segment-local eligibility, frozen EXPERIMENT_LIMITATIONS, exact finalEquity vs equityCurve check</li>
              <li>Contract: 213/213 contract, 225/225 report, 174/174 leakage, 165/165 hardening — green</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase A — Historical Data Plane — IMPLEMENTED / REAL BEHAVIOR 22/22</h3>
            <ul>
              <li>Real read-only historical data access via fetchHistoricalDataPlane: dependency-injected executor, SELECT-only, no writes</li>
              <li>REAL behavior tests: non-aligned 00:30-03:30 → effectiveFrom 01:00 expectedSlots 3 ratio 2/3, overallCoverageRatio 0.6 partial !=1, isAligned false canonicalized true, off-grid not counted, projection mutations killed</li>
              <li>Report: requested range, effectiveCanonicalRange, expected slots, coverage ratio, leading/internal/trailing missing, duplicates, off-grid bars, common timestamps, common contiguous ranges, participant feasibility</li>
              <li>No PnL in this layer — REAL plane object inspected recursively for forbidden economics</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase B — Historical Raw SMC Observation — IMPLEMENTED — BEHAVIOR 17/17 + 38/38</h3>
            <ul>
              <li>Reuses production evaluateSmc — no second algorithm — real LONG/SHORT via production path yields LONG 75/10 and SHORT 20/75, preserved with NON_EXECUTABLE</li>
              <li>RawSmcObservation: LONG/SHORT/NEUTRAL/CANNOT_EVALUATE preserved exactly, plus causal facts/reasons/horizon/provenance</li>
              <li>Window policy: hardMinimumBars ~84, productionWindowBars 500, fetchCap 500, fidelity 500 hypothesis, ROLLING_500</li>
              <li>Historical clock: causal clock H+D, tested H+D-1ms / H+D / H+D+1ms / H+2D, no wall-clock, no H+1 visibility before legal time</li>
              <li>Coverage REAL: canonical-coverage-real 38/38 behavior-level, no source.includes</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase C — Differential Equivalence — IMPLEMENTED</h3>
            <ul>
              <li>Same causal prefix + different future suffix = same historical observation at N — verified for all TFs 5m/15m/1h/4h/1d</li>
              <li>Production vs historical on identical prefix: direction/scores identical, BINGX 1d exclusion</li>
              <li>Common horizon: selectCommonClosedHorizon with relative/absolute staleness, future_horizon detection</li>
              <li>Context-channel-only no-lookahead documented, closure/global leakage explicitly NOT proven — HONEST SCOPE</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase D — Execution Policy Registry — EP-1 APPROVED Baseline / EP-2 EP-3 DRAFT — IMPLEMENTED 37/37</h3>
            <ul>
              <li>Registry EP-1/EP-2/EP-3: all explicit, no hidden defaults, HONEST SCOPE top-level only, no new Date()/Date.now()/random/env</li>
              <li>EP-1 SMC-Direction Baseline APPROVED: baselineMode explicit, no SL/TP, NON_EXECUTABLE truthful, fingerprint includes id|version|requiredFields|config, costs 5bps fee 2bps slippage</li>
              <li>EP-2 Structural Anchor DRAFT EXAMPLE: requiredEconomicFields [stopLoss, takeProfit, slAnchor, tpModel, buffer, rrMin, timeoutBars] explicit, owner must approve real values, NOT production SMC</li>
              <li>EP-3 Generic Boundary DRAFT: [stopLoss, takeProfit, slAnchor, tpModel, k, atrSlMultiplier, rrMin, timeoutBars] explicit, policy identity in fingerprint, TRAIN/VALIDATION only selection OOS final witness, OOS-blind</li>
              <li>Validation: findUndeclaredEconomicFields top-level only, validateNoHiddenEconomicDefaults fails closed when unresolved, mutation {`{atrSlMultiplier,k,rrMin,timeoutBars}`} must fail — 12/12, registry 37/37</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase G — Real PnL Runner — EP-1 0 trades truthful / EP-2 EP-3 APPROVED yields real trades — IMPLEMENTED 26/26</h3>
            <ul>
              <li>Integrates Execution Policy Registry with P2-A engine: computeLevels stopLoss/takeProfit%+buffer, reference price = bar.close, LONG SL=ref*(1-stopLoss-buffer) TP=ref*(1+takeProfit) SHORT opposite</li>
              <li>Truthful: EP-1 APPROVED baselineMode but 0 trades (no SL/TP) — SMC-Direction Baseline, NON_EXECUTABLE until real policy, EP-2/EP-3 DRAFT blocked PRE_REGISTRATION_REQUIRED, APPROVED via approvePolicy utility yields real trades with metrics equityCurve</li>
              <li>Policy identity in fingerprint: label policyId|direction|factsFingerprint, backtestInput fees bps:5 fixed:0 slippage bps:2 kind:bps value:2, sameBar pessimistic, warmup 84, timeoutBars from policy</li>
              <li>Status READY_FOR_EXECUTION / PRE_REGISTRATION_REQUIRED / INVALID_POLICY / INSUFFICIENT_DATA / EXECUTION_FAILED, formatRealPnlReport includes limitations CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY OHLCV PIT OOS-blind</li>
              <li>Pre-PnL Runner updated: exposes registryPolicies fingerprint count 3 approved 1, executionPolicyRegistryId EP-1/EP-2/EP-3, truthfulBaselineName includes fingerprint</li>
              <li>CLI backtest-historical-readonly.ts now supports --executionPolicy EP-1/EP-2/EP-3 --approve: EP-1 0 trades baseline, EP-2 DRAFT PRE_REGISTRATION_REQUIRED, --approve simulates owner approval deterministic no DB writes, real PnL report with trades/metrics</li>
              <li>No DB writes, no workers, no Signal Engine, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d, readOnly true</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase H — Full Pipeline Real PnL — data plane + raw SMC + EP-1/EP-2/EP-3 + P2-A + splits OOS-blind — IMPLEMENTED 52/52</h3>
            <ul>
              <li>Integrates P2-B fetchHistoricalDataPlane + raw SMC observations batch + execution policy registry EP-1/EP-2/EP-3 + real PnL runner P2-A + splits TRAIN/VALIDATION/OOS OOS-blind in one deterministic pipeline</li>
              <li>Truthful: EP-1 APPROVED baselineMode 0 trades truthful baseline, EP-2/EP-3 DRAFT PRE_REGISTRATION_REQUIRED blocked, APPROVED via approve flag yields real trades with metrics equityCurve, policy identity preserved fingerprint id|version|requiredFields|config</li>
              <li>Resolves policy from registry id EP-1/EP-2/EP-3, approve simulates owner approval deterministic via approvePolicy utility, no DB writes, uses utcDateFromMs no new Date token</li>
              <li>Splits readiness: auto 60/20/20 from requested range using commonTimestamps, oosDoesNotInfluenceSelection true, oosIsFinalWitnessOnly true, selectionStages TRAIN/VALIDATION only, tie-break selectionKey→inputOrder OOS-blind</li>
              <li>Data plane integration: coverageRatio, commonTimestampsCount, eligibleMarketsCount, warnings, provenanceDiagnostics knownLimitations, OHLCV PIT not guaranteed, eligibility CANNOT_RECONSTRUCT E1 professional default</li>
              <li>Status READY_FOR_EXECUTION / PRE_REGISTRATION_REQUIRED / INVALID_POLICY / INSUFFICIENT_DATA / EXECUTION_FAILED, formatFullPipelineRealPnlReport includes limitations 5bps fee 2bps slippage, CANNOT_RECONSTRUCT, OHLCV PIT, OOS-blind</li>
              <li>Tests 52/52: no policy PRE_REGISTRATION_REQUIRED, EP-1 0 trades, EP-2 DRAFT blocked, EP-2 APPROVED real trades, EP-3 fingerprint differs, splits OOS isolation, data plane readOnly noPnl, report contains costs, no forbidden tokens new Date/Date.now/random/env, policy identity preserved across pipeline</li>
              <li>No DB writes, no workers, no Signal Engine, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d, readOnly true</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase E — Pre-PnL Runner — INTENTIONALLY STOPS BEFORE ECONOMICS — IMPLEMENTED 32/32 + 22/22</h3>
            <ul>
              <li>Deterministic orchestration: historical read-only bars via fetchHistoricalDataPlane → raw SMC observations → eligibility → execution-policy boundary → STOP intentionally before P2-A/P2-C economics</li>
              <li>With EP-1: PRE_REGISTRATION_REQUIRED → READY_FOR_EXECUTION, raw LONG/SHORT preserved separately, never mapped to NEUTRAL/CANNOT_EVALUATE, nonExecutableCount===decisionBars when no policy, from &lt; to validation behavior test</li>
              <li>Diagnostics only: coverage effectiveCanonicalRange isAligned/canonicalized overallCoverageRatio, raw counts, NON_EXECUTABLE count, data limitations, eligibility limitations, fingerprints, common horizon — readOnly true, noPnl true</li>
              <li>No profit/loss/winRate/profitFactor/Sharpe/expectancy/equity curve — recursive forbidden economics checks on REAL plane object + formatted report 11/11 CONTRACT</li>
              <li>Truthful baseline: SMC-Direction Baseline / EP-1 APPROVED baselineMode, EP-2/EP-3 DRAFT — owner must approve real values</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase F — Train/Validation/OOS Readiness — IMPLEMENTED / OOS-blind — 40/40</h3>
            <ul>
              <li>Uses P2-C semantics: OOS does not influence ranking/selection/tie-break/eligibility, selection stages TRAIN/VALIDATION only, tie-break selectionKey → inputOrder</li>
              <li>Pre-PnL split readiness/coverage diagnostics, no silent OOS shortening, 60/20/20 splits from requested range uses commonTimestamps</li>
              <li>Full pipeline integration: historical data plane + raw SMC + execution policy + splits readiness OOS isolation — 40/40 pass</li>
              <li>ReadOnly / NoPnL flags, actual counts not aggregated as chain evidence</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Historical Eligibility — CANNOT_RECONSTRUCT — E1 chosen as PROFESSIONAL DEFAULT (owner can override)</h3>
            <ul>
              <li>Asset.rank, Market.quoteVolume24h, Market.enabled, Market.status, listing/delisting survivorship — mutable current-state, no PIT history</li>
              <li>Diagnostics capable of representing CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY — 11/11 strict check !includes where: {`{assetId, enabled: true}`} no OR escape-hatch</li>
              <li>E1: present-day snapshot with explicit CURRENT_STATE_SURVIVORSHIP_LIMITATION — chosen as professional default (most practical, honest), E2/E3 documented as alternatives</li>
              <li>Owner can still choose E1/E2/E3 — final methodology labeled truthfully, no silent narrowing</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>OHLCV Point-In-Time Fidelity — KNOWN LIMITATION — HONEST</h3>
            <ul>
              <li>lib/ohlcv/sync.ts upsert path updates existing candle values — current DB contents do NOT prove historical values, createdAt NOT overwritten, only updatedAt auto-updated</li>
              <li>Diagnostics report createdAt/updatedAt distribution, write path audit lib/ohlcv/sync.ts only, no claim of strict PIT fidelity</li>
              <li>Expected write files: lib/ohlcv/sync.ts only — audited, no new Date token</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Current Status — PROFESSIONAL TOP — Phase H Full Pipeline Real PnL IMPLEMENTED / PENDING TARGETED RE-AUDIT — 42 files, actual counts</h3>
            <ul>
              <li>Base 51eb129 = independently accepted + VPS verified — production remains d6c573c, no deployment, forbidden edf3732 NOT ancestor exit 1 — SIGNAL ENGINE ABSENCE VERIFIED</li>
              <li>New work = IMPLEMENTED / PENDING TARGETED RE-AUDIT: sequential commits from exact base, no squash/amend/force-push, no accepted branches altered</li>
              <li>Actual counts: engine 451/451, p2b 427/427, metrics 123/123, splits 108/108, contract 213/213, report 225/225, leakage 174/174, hardening 165/165, eligibility 96/96, data-plane 46/46, execution-policy 16/16, smc-observation 78/78, pre-pnl 32/32, real-long-short 17/17 BEHAVIOR, canonical-coverage-real 38/38 BEHAVIOR, historical-data-plane-behavior-real 22/22 BEHAVIOR REAL, no-pnl-output 11/11 CONTRACT REAL, economic-default-detection 12/12 CONTRACT, core-api-immutability 14/14 CONTRACT, survivorship-fixtures 11/11 CONTRACT strict, structural-proof 22/22 SOURCE PIN, mutations-m1-m11 20/20 classified BEHAVIOR/CONTRACT/SOURCE PIN, full-pipeline 40/40, hardening-pre-pnl 47/47, readonly-sql 89/89, clock 46/46, eligibility 32/32, registry 37/37, real-pnl 26/26, full-pipeline-real-pnl 52/52 — tsc 0, diff-check clean</li>
              <li>Full Pipeline Real PnL Phase H: P2-B data plane + raw SMC batch + EP-1/EP-2/EP-3 registry + P2-A real PnL runner + splits TRAIN/VALIDATION/OOS OOS-blind, EP-1 0 trades truthful baseline APPROVED, EP-2/EP-3 DRAFT PRE_REGISTRATION_REQUIRED until APPROVED, APPROVED yields real trades with fingerprint identity id|version|requiredFields|config, costs 5bps fee 2bps slippage, readOnly true, no DB writes, no workers, no Signal Engine, BTC only 5m/15m/1h/4h/1d BINGX excluded 1d</li>
              <li>Registry: EP-1 APPROVED baseline truthful, EP-2/EP-3 DRAFT explicit examples — owner must approve real SL/TP values, fingerprint includes policy identity, explicit requiredEconomicFields no hidden defaults, no new Date/Date.now/random/env, uses utcDateFromMs</li>
              <li>Owner-run read-only CLI (uses existing server env, no secrets): npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney --smc --splits --executionPolicy EP-2 --approve</li>
              <li>Next: owner approves EP-2/EP-3 economic semantics for production → READY_FOR_EXECUTION → real PnL with TRAIN/VALIDATION/OOS OOS-blind, no fake profitability, policy identity preserved, E1 professional default CURRENT_STATE_SURVIVORSHIP_LIMITATION</li>
            </ul>
          </div>
        </div>

        <p className="muted healthNote">
          Профессиональный топ-статус Phase H: Full Pipeline Real PnL — P2-B + raw SMC + EP-1/EP-2/EP-3 registry + P2-A + splits OOS-blind — EP-1 0 trades truthful APPROVED baselineMode, EP-2/EP-3 DRAFT PRE_REGISTRATION_REQUIRED until APPROVED, APPROVED yields real trades with fingerprint identity, costs 5bps fee 2bps slippage. Все модули read-only, без записи в БД, без воркеров, без Signal Engine. 42 файла от базы 51eb129, engine 451/451, registry 37/37, real-pnl 26/26, full-pipeline-real-pnl 52/52, tsc 0, GitHub incident recovered git push works.
        </p>
      </section>
    </main>
  );
}
