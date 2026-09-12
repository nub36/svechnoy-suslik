import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Admin Backtests — честный статус pre-PnL инфраструктуры.
 *
 * До реального PnL approval:
 * - P2 infrastructure status
 * - historical data readiness
 * - coverage
 * - raw observation readiness
 * - execution-policy state
 * - eligibility limitation state
 * - PRE_REGISTRATION_REQUIRED
 * - TRAIN/VALIDATION/OOS readiness
 *
 * Никаких фиктивных profitability numbers, никаких fake completed experiments, никаких DB writes.
 * Статус: IMPLEMENTED / PENDING INDEPENDENT ADVERSARIAL REVIEW (база 51eb129 VPS verified).
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
            <div className="adminEyebrow">P2-A / P2-B / P2-C — инфраструктура готова, PnL — PRE_REGISTRATION_REQUIRED</div>
            <h1>Бэктесты — pre-PnL статус</h1>
          </div>
        </div>

        <div className="adminGrid">
          <div className="adminCard">
            <h3>P2-A Backtest Engine — p2a-1.2.0 — ACCEPTED / VPS VERIFIED (51eb129)</h3>
            <ul>
              <li>Детерминированный слой: next-bar entry, planned-risk R, gap-through, fees/slippage, pessimistic same-bar, arithmetic fail-closed, immutable results, causal warmup, MAE drawdown, large-array safety, decision snapshot TOCTOU, malformed signals fail-closed, context-channel no-lookahead</li>
              <li>Contract: 415/415 engine, 567/567 hardening, 123/123 metrics, 108/108 splits — green</li>
              <li>Без Prisma, без сети, без workers, без Date.now()</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>P2-B Data Plane — HARDENED — ACCEPTED / VPS VERIFIED</h3>
            <ul>
              <li>Read-only PostgreSQL plane: CLOSED-only, ASC ordering, duplicates fail-closed, canonical grid, off-grid detection, provider over-return, pagination progress, maxRows/maxPages bounded</li>
              <li>Coverage: requested-range basis (not first→last), leading/internal/trailing missing, coverage ratio canonical-grid based, no misleading 100% on non-aligned ranges</li>
              <li>Eligibility: upstream isSmartMoneyExchangeEligible, BINGX 1d excluded, raw vs Smart Money distinct, fail-closed unknown</li>
              <li>Contract: 427/427 — green, plus new P2-B+ extensions</li>
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
            <h3>Phase A — Historical Data Plane — IMPLEMENTED / PENDING REVIEW</h3>
            <ul>
              <li>Real read-only historical data access on top of P2-B: dependency-injected executor, SELECT-only, no secret handling, no writes, no migrations, no workers</li>
              <li>Fetch: market identity, exchange, asset, timeframe, CLOSED candles, openTime, OHLCV, createdAt/updatedAt</li>
              <li>Report: requested range, effective canonical range, expected slots, available slots, coverage ratio, leading/internal/trailing missing, duplicates, off-grid bars, earliest/latest, common timestamps, common contiguous ranges, participant feasibility, createdAt/updatedAt diagnostics, eligibility limitations</li>
              <li>No PnL in this layer</li>
              <li>Owner-run CLI: scripts/backtest-historical-readonly.ts — READ ONLY NO DB WRITES NO PNL, defensive SET TRANSACTION READ ONLY intent, fail-closed</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase B — Historical Raw SMC Observation — IMPLEMENTED / PENDING REVIEW</h3>
            <ul>
              <li>Reuses production evaluateSmc — no second algorithm</li>
              <li>RawSmcObservation: LONG/SHORT/NEUTRAL/CANNOT_EVALUATE preserved exactly, plus causal facts/reasons/horizon/provenance</li>
              <li>Provenance: market(s), timeframe, decision bar H, asOf=H+D, common horizon, participant count, reasons, facts/fingerprint, window policy</li>
              <li>Window policy distinction: hardMinimumBars ~84, productionWindowBars 500, fetchCap 500, historicalFidelityWindow 500 hypothesis, strategyMemory ROLLING_500, fullAvailability diagnostics</li>
              <li>Historical clock: explicit causal clock H+D, tested H+D-1ms / H+D / H+D+1ms / H+2D, no wall-clock leakage, no H+1 visibility before legal time</li>
              <li>No SL/TP, no PnL</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase C — Differential Equivalence — IMPLEMENTED / PENDING REVIEW</h3>
            <ul>
              <li>Same causal prefix + different future suffix = same historical observation at N — verified for all TFs</li>
              <li>Production vs historical on identical prefix: direction/scores identical for 5m/15m/1h/4h/1d</li>
              <li>BINGX 1d exclusion, gaps/duplicates/off-grid/unequal history/relative lag/absolute lag/insufficient history/rolling-window boundary/future candle appended</li>
              <li>Common horizon: selectCommonClosedHorizon with relative/absolute staleness, future_horizon detection</li>
              <li>Context-channel-only no-lookahead documented, closure/global leakage explicitly NOT proven</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase D — Execution Policy Plumbing — IMPLEMENTED / PENDING REVIEW</h3>
            <ul>
              <li>Generic boundary with NO economic defaults: ExecutionPolicyDefinition, ExecutionPolicyId, fingerprint, validation, Executability</li>
              <li>EXECUTABLE vs NON_EXECUTABLE: NO_EXECUTION_POLICY, INVALID_POLICY, NO_VALID_STOP, NO_VALID_TARGET, LEVELS_INVALID_AT_DECISION, POLICY_NOT_APPROVED, PRE_REGISTRATION_REQUIRED, etc.</li>
              <li>NOT APPROVED: structural SL anchor, protectedLow/High as SL, ATR SL, SL buffer, TP rule, fixed R, k=1/k=2/k-grid, RR_min, timeoutBars, conflict behavior — must remain explicit required config, no hidden defaults</li>
              <li>Policy identity included in result/report fingerprints once execution enabled</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase E — Pre-PnL Runner — PRE_REGISTRATION_REQUIRED — IMPLEMENTED</h3>
            <ul>
              <li>Deterministic orchestration: historical read-only bars → raw SMC observations → eligibility policy → execution-policy boundary → P2-A → P2-C</li>
              <li>Until approved execution policy: REFUSE real trade/PnL execution, returns PRE_REGISTRATION_REQUIRED</li>
              <li>Diagnostics only: coverage, raw LONG/SHORT/NEUTRAL/CANNOT_EVALUATE counts, NON_EXECUTABLE count, data limitations, eligibility limitations, fingerprints, common horizon diagnostics</li>
              <li>No profit/loss/winRate/profitFactor/Sharpe/expectancy/equity curve</li>
              <li>Truthful baseline naming: SMC-Direction Baseline / execution policy EP-1 (EP-1 economic semantics OWNER-UNRESOLVED)</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Phase F — Train/Validation/OOS Readiness — IMPLEMENTED / PENDING REVIEW</h3>
            <ul>
              <li>Uses P2-C semantics: OOS does not influence ranking/selection/tie-break/eligibility, selection stages TRAIN/VALIDATION only</li>
              <li>Pre-PnL split readiness/coverage diagnostics, no split dates chosen based on strategy results</li>
              <li>If insufficient data: reports insufficient OOS/data coverage, does not silently shorten OOS</li>
              <li>ReadOnly / NoPnL flags</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Historical Eligibility — CANNOT_RECONSTRUCT — OWNER DECISION PENDING</h3>
            <ul>
              <li>Asset.rank, Market.quoteVolume24h, Market.enabled, Market.status, listing/delisting survivorship — mutable current-state, no point-in-time history</li>
              <li>Diagnostics capable of representing CANNOT_RECONSTRUCT_HISTORICAL_ELIGIBILITY</li>
              <li>E1: present-day snapshot with explicit limitation, E2: disable unreconstructable filters with explicit deviation, E3: no profitability until PIT eligibility history exists</li>
              <li>Owner has NOT chosen E1/E2/E3 — final methodology unresolved, must be labeled truthfully</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>OHLCV Point-In-Time Fidelity — KNOWN LIMITATION</h3>
            <ul>
              <li>lib/ohlcv/sync.ts upsert path updates existing candle values — current DB contents do NOT prove historical values</li>
              <li>createdAt does NOT prove values identical at creation, updatedAt shows mutation timing but does NOT recover old values</li>
              <li>Diagnostics report createdAt/updatedAt distribution, write path audit, no claim of strict PIT fidelity</li>
              <li>Expected write files: lib/ohlcv/sync.ts only — audited</li>
            </ul>
          </div>

          <div className="adminCard">
            <h3>Current Status — IMPLEMENTED / PENDING INDEPENDENT ADVERSARIAL REVIEW</h3>
            <ul>
              <li>Base 51eb129 = independently accepted + VPS verified — production remains d6c573c, no deployment</li>
              <li>New work = IMPLEMENTED / PENDING REVIEW — even though own tests pass</li>
              <li>No real PnL calculated, no profitability claim, no real DB access in sandbox, no DB writes, no workers, no Prisma migration, no production deployment, Signal Engine NOT introduced</li>
              <li>Owner-run read-only CLI: DATABASE_URL=... npx tsx scripts/backtest-historical-readonly.ts --asset BTC --timeframe 1h --from 2024-01-01 --to 2024-02-01 --smartMoney</li>
            </ul>
          </div>
        </div>

        <p className="muted healthNote">
          Этот раздел — честный pre-PnL статус. До одобрения execution policy (SL anchor, TP model, k/RR_min/buffer/timeout) и выбора E1/E2/E3 реальная прибыльность не считается. Все новые модули — read-only, без записи в БД, без воркеров, без Signal Engine.
        </p>
      </section>
    </main>
  );
}
