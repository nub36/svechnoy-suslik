# V2 Existing Inventory — Before Architecture Change

Date: 2026-09-14
Checkpoint: 5f0e8ee (public /signals large cards)
Branch: arena/01a09726-svechnoy-suslik

## 1. Strategy/Admin Configuration

- `lib/strategies/smart-money-v2.ts` — 746 lines, full V2 config model:
  - Modes: DISABLED/DRY_RUN/FORWARD_TEST/LIVE (LIVE blocked in validateV2Config)
  - Reference: symbol BTC, timeframe 15m, referenceExchange BINANCE default
  - SMC base: swingLeft/Right 20, internal 3, atrPeriod 14, freshBars 10/5/20/20, eqBand 0.02, 9 weights sum 100
  - Confirmations: 9 keys with honest categories:
    - INDEPENDENT (5): bos (20 required), orderBlock (20 required), fvg (15), liquiditySweep (15), rangePosition (15)
    - DERIVED (1): confluence (5 optional, bonus only if OB+FVG both met)
    - CONTEXT (1): internalStructure (10)
    - PLACEHOLDER disabled (2): choch (0, duplicate INTERNAL_TREND), displacement (0, no DISPLACEMENT reason yet)
  - Trend: enabled true, mode MARKET_STRUCTURE default, policy SCORE_BOOST default, emaFast 20 emaSlow 50 slope 5 htf 1h weight 15 counterTrendPenalty 10
  - ATR SL/TP reuse: period 14, stop 1.5, TP1 1.5, TP2 2.5, TP3 4
  - Validation prevents double counting choch+internalStructure, displacement enabled, PLACEHOLDER required, DERIVED required
  - `evaluateV2WithCandles(candles, config, now, htfCandles?)` — pure, dedup by v2Key, confluence only if OB+FVG, trend MARKET_STRUCTURE/EMA/HTF/COMBINED with SCORE_BOOST/TIERING/HARD_ALIGNMENT
  - DEFAULT_V2_CONFIG mode DISABLED, minScore 65

- `components/admin/SmartMoneyV2Editor.tsx` — 600 lines, UI for V2 config:
  - Mode selector DISABLED/DRY_RUN/FORWARD_TEST/LIVE (LIVE disabled in UI)
  - Symbol, timeframe, referenceExchange, minScore, minExchanges (compat), timeframes multi-select
  - Confirmations grid with category badges INDEPENDENT/DERIVED/CONTEXT/PLACEHOLDER, enabled/weight/required, descriptions
  - Trend context: enabled, mode OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED, policy SCORE_BOOST/TIERING/HARD_ALIGNMENT, EMA fast/slow/slope, HTF timeframe, weight, penalty
  - SMC structure + ATR + scoring weights Σ=100
  - Research button POST /api/admin/strategies/[id]/research

- `app/api/admin/strategies/[id]/route.ts` — handles smart-money-v2 via normalizeV2Config/validateV2Config

- `app/api/admin/strategies/[id]/research/route.ts` — synthetic research endpoint (placeholder) with models V1 baseline, V2-A/B/C/D SCORE_BOOST/TIERING/HARD_ALIGNMENT, stores in StrategyResearchResult

- `prisma/schema.prisma`:
  - Strategy: id, slug, version, enabled, status, mode (DISABLED/DRY_RUN/FORWARD_TEST/LIVE), config Json, timeframes, minExchanges
  - Signal: strategyId FK, symbol, timeframe, direction, score, entry nullable, SL/TP nullable, status, signalCandleTime DateTime?, referenceExchange, executionPolicy, signalSource enum LIVE_FORWARD/SEEDED/BACKTEST/LEGACY default LEGACY, atrAtSignal, metadata Json, confirmationCount/Total, participantCount etc, setupKey, triggerType, unique [strategyId,symbol,timeframe,signalCandleTime]
  - SignalOutcome: signalId unique, status WAITING_ENTRY/OPEN/TP1_HIT/TP2_HIT/TP3_HIT/STOPPED/EXPIRED/ENTRY_DATA_MISSING, entryTime/Price, SL/TP1/2/3, exitTime/Price, tp1HitAt/2/3, atrAtSignal, etc
  - StrategySignalState: strategyId,symbol,timeframe unique, lastEvaluatedCandleTime, aggregateState NEUTRAL/LONG/SHORT/CANNOT_EVALUATE/DATA_UNAVAILABLE/QUORUM_NOT_MET/FUTURE_HORIZON/ABSOLUTE_STALE, lastSignalCandleTime, lastSignalDirection, metadata
  - ExchangeConfig: publicEnabled/ohlcvEnabled/liveEnabled/isDefault/priority, BINANCE default priority 100
  - StrategyResearchResult: strategyId, model, timeframe, trainFrom/To, validFrom/To, oosFrom/To, metrics Json

- `scripts/seed-smart-money-v2.ts` — ensures 3 strategies: trend-suslik v1, smart-money-suslik v1, smart-money-v2 v2, mode DISABLED LIVE off, minExchanges 1 for V2

- Migration `20260916_top50_v2_exchange_config` — additive, Asset.archivedAt, Strategy.mode, ExchangeConfig, StrategyResearchResult, BINANCE default

## 2. V1 Smart Money Engine

- `lib/strategies/smart-money.ts` — 1035 lines:
  - validateSmartMoneyConfig, filters, SMC config mapping, mapSmcReasonsToStrategyReasons, evaluateSmartMoneyWithCandles (pure, ASC CLOSED only, cannot-evaluate on contract violation), loadSmartMoneyCandles (500 DESC→ASC), evaluateMarketsAtCommonHorizon (QUORUM/STRICT, participant selection independent score BEFORE scoring, filtered not participants)
  - Uses evaluateSmc from lib/smc/evaluate, 9 reasons, 500 fidelity

- `lib/strategies/common-horizon-quorum.ts` — selectQuorumClosedHorizon with minExchanges, fresh/stale, expectedLatestClosed

- `lib/signals/smart-money-candidate.ts` — builder with deepFreeze, reference priority BINANCE>BYBIT>GATE>KUCOIN>BINGX deterministic before scoring, execution SMC_ATR_V1 REFERENCE_CLOSE vs NEXT_BAR_OPEN prefer NEXT_BAR_OPEN, entry NULL WAITING_ENTRY when nextBar missing, SL/TP only after READY, ATR frozen

- `lib/signals/signal-engine.ts` — 965 lines:
  - runTrendSuslikEngine (legacy)
  - runSmartMoneyEngine with EDGE/RE-ARM V1: aggregate NEUTRAL/LONG/SHORT/QUORUM_NOT_MET/FUTURE_HORIZON/ABSOLUTE_STALE/CANNOT_EVALUATE/DATA_UNAVAILABLE, computeEdgeTransition, persistent StrategySignalState unique [strategyId,symbol,timeframe], idempotent same horizon NOOP, older REFUSE, unavailable PRESERVE (no re-arm), bootstrap SHORT→NO SIGNAL default unless --emit-on-bootstrap, provisional unavailable→evaluable same horizon re-evaluate fix 16:15 QUORUM_NOT_MET→SHORT, transactional Signal+Outcome+State in ONE prisma.$transaction, P2002 idempotent, AND guard flag+env
  - Main runSignalEngineForBtc handles trend-suslik and smart-money-suslik, BTC only, eligible markets via isSmartMoneyExchangeEligible (BINGX 1d excluded)

- `scripts/signal-worker.ts` — 173 lines, BTC ONLY, parses --symbol --timeframe --strategy trend-suslik/smart-money-suslik, --common-horizon-policy STRICT/QUORUM, --dry-run default, AND guard SMART_MONEY_WRITE_ENABLED + --enable-smart-money-write

## 3. StrategySignalState / EDGE

- `lib/signals/edge-state-machine.ts` — 345 lines:
  - AggregateState NEUTRAL/LONG/SHORT/CANNOT_EVALUATE/DATA_UNAVAILABLE/QUORUM_NOT_MET/FUTURE_HORIZON/ABSOLUTE_STALE
  - TriggerType EDGE/REVERSAL/BOOTSTRAP
  - EdgeAction EMIT/REARM/HOLD/PRESERVE_UNAVAILABLE/BOOTSTRAP_NO_SIGNAL/NOOP_SAME_HORIZON/REFUSE_OLDER_HORIZON
  - computeEdgeTransition pure, same-horizon provisional/unavailable semantics fix, older refused, unavailable PRESERVE no re-arm, bootstrap no signal default, NEUTRAL→LONG/SHORT EDGE EMIT, HOLD same direction, REARM directional→NEUTRAL, REVERSAL LONG↔SHORT
  - buildEpisodesFromTransitions for historical replay

- Tests: `scripts/test-edge-state-machine.ts`, `test-edge-v1-full.ts`, `test-edge-production-bug.ts`, `analyze-edge-replay.ts` — Episode #1 start=2026-09-13T08:15:00Z dir=SHORT end=2026-09-13T11:00:00Z durationBars=11

## 4. Signal Persistence

- Signal model with unique [strategyId,symbol,timeframe,signalCandleTime] without direction, PG NULL distinct, legacy rows NULL not constrained
- SignalOutcome separate, signalId UNIQUE, status WAITING_ENTRY/OPEN/TP1_HIT/TP2_HIT/TP3_HIT/STOPPED/EXPIRED/ENTRY_DATA_MISSING
- Transactional creation in signal-engine, P2002 idempotent
- Signal id=4 audit: strategyId=2 smart-money-suslik v1 BTC 15m SHORT 2026-09-14T00:15:00Z score 80 trigger EDGE reference BINANCE LIVE_FORWARD WAITING_ENTRY entry NULL outcome WAITING_ENTRY — root cause lifecycle worker absent

## 5. Outcome Tracker

- `lib/signals/signal-outcome.ts` — 488 lines pure contract: WAITING_ENTRY/OPEN/TP1_HIT/TP2_HIT/TP3_HIT/STOPPED/EXPIRED/ENTRY_DATA_MISSING, buildInitialOutcome exact H+D check, evaluateOutcomeProgression pessimistic SL first + gap open handling, tp1HitAt/2/3 preserved even if later STOPPED
- `scripts/signal-outcome-worker.ts` — generic lifecycle tracker: advisory lock 727925 concurrency 1 batch 20 --once --dry-run --signal-id filter, Phase1 WAITING_ENTRY/ENTRY_DATA_MISSING→OPEN via exact NEXT_BAR_OPEN openTime=signalCandleTime+tfMs exact match only, entry=exactNext.open real PG, ATR frozen, reuse buildInitialOutcome, atomic promotion Signal+Outcome in one transaction, Phase2 OPEN/TP1_HIT/TP2_HIT progression via evaluateOutcomeProgression chronological CLOSED candles, same-bar SL-first, gap actual-open, milestones preserved, terminal immutable idempotent, LEGACY ignored, crash recovery DB-only
- PM2 `svechnoy-suslik-signal-outcome` --once cron */2 * * * *

## 6. Historical Replay/Research Tooling

- `scripts/analyze-edge-replay.ts` — historical EDGE replay for 15m, loads CLOSED candles per market, quorum 3/5, builds candidate, runs edge machine, outputs episodes Episode #1 start=2026-09-13T08:15:00Z SHORT end 11:00 durationBars 11
- `lib/backtest/` — 20 files: adapter, contract, core-api, costs (5bps fee 2bps slippage), coverage, data-plan, data-source (read-only capability-restricted), eligibility, engine, execution-policy-approval, execution-policy-registry EP-1/EP-2/EP-3, execution-policy, full-pipeline-real-pnl, gaps, historical-data-plane (P2-B hardened pagination), historical-eligibility, immutable, intervals, metrics (no real PnL/winRate/profitFactor/Sharpe/expectancy per task, synthetic correctness only), no-lookahead, ohlcv-provenance, pre-pnl-runner, read-only-sql, real-experiment-runner (multiple policies variants ranking TRAIN/VALID only OOS final witness OOS-blind), real-pnl-runner, serialize, smc-observation, splits-readiness (TRAIN/VALIDATION/OOS OOS isolation no silent shortening), splits, timeframe, validate
- `scripts/backtest-historical-readonly.ts` — owner-run READ-ONLY inspection CLI BTC ONLY, NO DB WRITES, capability-restricted Prisma, fetch all markets reporting enabled/status diagnostics, BINGX 1d excluded timeless, P2-B pagination, coverage/common timestamps/contiguous ranges/participant feasibility, optional --smc raw SMC observations, --splits TRAIN/VALID/OOS, --executionPolicy EP-1/EP-2/EP-3 with --approve, --fullPipeline, --realExperiment
- `scripts/test-backtest-*` — 10 files, hardening, pre-pnl, splits, data-plane, engine, metrics, p2b, etc
- `lib/experiment/` — contract, identity, report, run, selection, validate
- `scripts/test-experiment-*` — contract, hardening, leakage, report, real-experiment-runner

## 7. Public /signals UI

- Before 5f0e8ee: technical table with ID, Created, Candle, Symbol/TF, Dir, Score, Conf, Trigger, RefEx, Entry/SL/TP, Strategy/Source, Status/Outcome, SetupKey, EDGE State table, long technical text PM2/historical replay/P2002/atomicity/quorum
- After 5f0e8ee: large cards, no SetupKey public, no EDGE State public, header BTC/USDT LONG/SHORT badge, timeframe human, strategy name, trigger, central prices ВХОД/STOP/TP1/TP2/TP3 separate blocks LONG TP green SL red, WAITING_ENTRY shows ОЖИДАЕТСЯ ВХОД + timeframe detail + NEXT BAR OPEN, status Russian mapping, SCORE + CONFIRMATIONS with Подтверждения стратегии, reference Биржа + Время сигнала local/UTC candle time, milestones ✓ TP1 ✓ TP2 ○ TP3 preserved even if later STOP, LONG green accent border-left, SHORT red, desktop normal width, mobile responsive no horizontal scroll, LEGACY below with LEGACY SIGNAL badge, sorting new top LIVE more visible, supports trend-suslik/smart-money-suslik/smart-money-v2, empty state, no fake prices, reuse existing styles, build ok

## 8. Gaps / What V2 Still Needs

- signal-worker.ts only allows trend-suslik/smart-money-suslik, not smart-money-v2
- signal-engine.ts has no runSmartMoneyV2Engine path
- No historical replay tool that compares V1 vs V2-A/B/C/D with trend policies SCORE_BOOST/TIERING/HARD_ALIGNMENT on BINANCE BTC/USDT 15m CLOSED with TRAIN/VALID/OOS and metrics EDGE episodes, signals/day, LONG/SHORT, TP1/2/3-before-SL, STOP-before-TP1, frequency retained
- No explicit regression replay for 2026-09-13 08:15 SHORT → 11:00 REARM for V2
- Research endpoint is synthetic placeholder, not real backtest
- V2 mode still DISABLED (correct for this checkpoint), no DRY_RUN/FORWARD_TEST path tested
- Need V2 research replay script that works both with DB (VPS max history) and synthetic fallback (sandbox)
- Need to ensure strategy isolation: V1/V2 independent StrategySignalState via strategyId, Signal records both saved even if conflicting, UI CONFLICT classification but persistence not discard
- Need to select recommended V2 configuration with rationale based on frequency retention and quality
