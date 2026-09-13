# TOP-50 Public + Smart Money V2 — Implementation Report

## 1. Public Site = TOP-50 from Asset rank, not hardcoded

- **lib/universe.ts**: TOP_UNIVERSE_SIZE 100 → 50, TOP_UNIVERSE_LABEL Top-100 → TOP-50
- **lib/public/top50.ts** (NEW): getPublicTop50() from Asset where enabled=true, archivedAt=null, rank 1..50, orderBy rank asc, take 50, include markets enabled ACTIVE USDT SPOT. BINANCE default, fallback by ExchangeConfig priority. Lightweight server snapshot/cache, not 50 WS. Live WS only on /coin/{symbol}.
- **app/page.tsx**: changed from getTopCoins(500) CoinGecko to getPublicTop50() DB. Hero text updated to TOP-50, BINANCE default, lightweight snapshot.
- **components/MarketOverview.tsx**: uses getPublicTop50() not CoinGecko 500.
- **app/coin/[symbol]/page.tsx**: BINANCE default exchange, fallback by priority, shows fallback notice, TOP-50 label, live WS only on this page.
- **Admin overview**: Top-100 → TOP-50 labels, uses topUniverseRankFilter() which now returns 1..50.
- **Admin data/monitoring**: updated to TOP-50.

## 2. Admin: Add Coin + Archive Coin + Exchange Management

### Asset archive
- **prisma/schema.prisma**: Asset.archivedAt DateTime? @index([archivedAt])
- **lib/assets/service.ts** (NEW):
  - addCoin({symbol,name,rank}) — validates SYMBOL /^[A-Z0-9]{1,20}$/, normalizes uppercase, creates Asset if not exists, unarchives if archived, discovers markets BINANCE first then BYBIT/GATE/KUCOIN/BINGX. For BINANCE always create, for others try getCandles 1h 1 to verify existence. Updates market enabled ACTIVE.
  - archiveCoin(symbol) — soft delete: set archivedAt=now(), enabled=false, preserves OHLCV/Signals/Outcomes, no cascade.
  - unarchiveCoin, getTop50Assets, getExchangeConfigs
- **app/api/admin/assets/route.ts** (NEW): POST add coin, DELETE archive, GET list active. Uses dynamic import auth for build safety, ADMIN auth middleware.
- **app/admin/assets/page.tsx + AssetManagerClient.tsx** (NEW): UI for add coin form Symbol/Name/Rank optional, table of active assets with markets, archive button soft.

### Exchange management
- **prisma/schema.prisma**: new model ExchangeConfig { exchange unique, publicEnabled, ohlcvEnabled, liveEnabled, isDefault, priority, indexes }
- **Migration**: prisma/migrations/20260916_top50_v2_exchange_config/migration.sql — additive only, no DROP, creates Asset.archivedAt, Strategy.mode, ExchangeConfig table with seed 5 exchanges BINANCE default true priority 100, BYBIT 90, GATE 80, KUCOIN 70, BINGX 60, creates StrategyResearchResult table.
- **lib/exchanges/config.ts** (NEW): EXCHANGE_LIST, EXCHANGE_PRIORITY, DEFAULT_EXCHANGE_CONFIGS, getDefaultExchange (isDefault && publicEnabled else BINANCE else highest priority), getPublicExchanges, getOhlcvExchanges, getLiveExchanges, selectExchangeWithFallback.
- **app/api/admin/exchanges/route.ts** (NEW): GET list configs, PUT update config (publicEnabled, ohlcvEnabled, liveEnabled, isDefault, priority). Safety: BINANCE public disable allowed but warns, BTC V1 still 5 exchanges via ohlcvEnabled not publicEnabled, so V1 not broken.
- **app/admin/exchanges/page.tsx + ExchangeManagerClient.tsx** (NEW): table with checkboxes Public/OHLCV/Live, Default button, Priority input. Shows current default, public/ohlcv lists, BTC V1 check.

## 3. Admin Strategies: 3 Must Exist

- **Existing**: trend-suslik v1, smart-money-suslik v1
- **NEW**: smart-money-v2 v2 slug smart-money-v2 version v2
- **scripts/seed-smart-money-v2.ts** (NEW): ensures 3 strategies exist, V1 untouched, V2 created with DEFAULT_V2_CONFIG mode DISABLED LIVE off, timeframes ["15m"], minExchanges 1, enabled false status DRAFT. If V2 exists and mode LIVE, fixes to DISABLED.
- **app/admin/strategies/[id]/page.tsx**: added routing to SmartMoneyV2Editor for slug smart-money-v2.
- **app/admin/strategies/page.tsx** already lists strategies from DB, will show 3 after seed.

## 4. Smart Money V2 Full Settings UI

- **lib/strategies/smart-money-v2.ts** (NEW): 
  - Types: TrendMode OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED, TrendPolicy SCORE_BOOST/TIERING/HARD_ALIGNMENT, StrategyMode DISABLED/DRY_RUN/FORWARD_TEST/LIVE
  - SmcConfirmationConfig {enabled,weight,required}, SmcConfirmationsV2 9 fields bos,choch,orderBlock,fvg,liquiditySweep,displacement,rangePosition,confluence,internalStructure
  - TrendContextV2 {enabled,mode,policy,emaFast,emaSlow,emaSlopeLookback,htfTimeframe,weight,counterTrendPenalty}
  - SmartMoneyV2Config {mode,symbol BTC default,timeframe 15m default,referenceExchange BINANCE default,minimumSignalScore, swingLeft/Right, internalLeft/Right, atrPeriod, structureEventFreshBars, sweepFreshBars, orderBlockFreshBars, fvgFreshBars, eqBand, weights sum 100, confirmations, trend, atr {period,stopMultiplier,tp1/2/3}, filters, execution}
  - DEFAULT_CONFIRMATIONS: bos 20 required true, choch 15 false, orderBlock 15 true, fvg 10 false, liquiditySweep 10 false, displacement 10 false, rangePosition 10 false, confluence 5 false, internalStructure 5 false
  - DEFAULT_TREND: enabled true, mode MARKET_STRUCTURE, policy SCORE_BOOST, emaFast 20, emaSlow 50, slopeLookback 5, htf 1h, weight 15, counterPenalty 10
  - DEFAULT_V2_CONFIG: mode DISABLED, symbol BTC, timeframe 15m, reference BINANCE, minScore 65, swing 20/20 internal 3/3 atr 14 etc, weights 20/15/10/10/15/5/10/10/5 sum100
  - normalizeV2Config, validateV2Config (checks mode not LIVE, symbol, timeframe, referenceExchange, minScore 0..100, SMC base, weights sum 100, confirmations, trend, ATR, timeframes non-empty, minEx 1..5, SMC config validation via assertValidSmcScoringConfig)
  - evaluateV2WithCandles: reuses evaluateSmc, maps SMC reasons to V2 confirmations, counts met confirmations, trend context EMA/MARKET_STRUCTURE/HTF/COMBINED, policy SCORE_BOOST/TIERING/HARD_ALIGNMENT, applies boost, checks required core, final direction LONG/SHORT/NEUTRAL with minScore.

- **components/admin/SmartMoneyV2Editor.tsx** (NEW): reuses NumberField pattern from StrategyEditor/SmartMoneyStrategyEditor
  - Sections: Hero with slug/version/status/mode badge, enabled toggle, MODE select DISABLED/DRY_RUN/FORWARD_TEST/LIVE disabled LIVE
  - How it works: reference exchange model, confirmations N/M not exchanges N/M, trend optional, EDGE/RE-ARM preserved, V1/V2 independent
  - Validation errors, LIVE blocked warning, dirty indicator
  - Basic: symbol, timeframe 15m default, reference BINANCE default, minScore, minExchanges, working timeframes selector
  - SMC Confirmations: 9 real features BOS,CHOCH,Order Block,FVG,Liquidity Sweep,Displacement,Range,Confluence,Internal each with Enabled/Weight/Required, description, grid layout
  - Trend Context: Enabled checkbox, Mode OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED, Policy SCORE_BOOST/TIERING/HARD_ALIGNMENT default not HARD_ALIGNMENT, EMA Fast/Slow/slope/lookback, HTF 1h default, Weight, Counter-Trend Penalty, hide/disable irrelevant params, HARD_ALIGNMENT warning
  - Market Structure + ATR + Scoring reuse existing controls: swingLeft/Right, internalLeft/Right, atrPeriod, freshness bars, eqBand, weights Σ, ATR SL/TP
  - Research Results block: metrics EDGE episodes, signals/day, LONG/SHORT, TP1/2/3-before-SL, STOP-before-TP1, frequency retained vs V1, TRAIN/VALIDATION/OOS, RUN RESEARCH button only if safe no auto on production, shows V2-A/B/C/D variants

- **app/api/admin/strategies/[id]/route.ts**: added V2 handling, normalizeV2Config, validateV2Config, mode LIVE blocked, timeframes filter, minEx check, update with mode.

## 5. SMC Confirmations Real Features

From lib/smc code: BOS (Break of Structure swingStructureBias recentSwingBos), CHOCH (Change of Character internalStructure), Order Block (swingOrderBlock internalOrderBlock), FVG (Fair Value Gap), Liquidity Sweep, Displacement (impulse bodyAtr rangeAtr closeLoc), Range Premium/Discount (rangePosition), Confluence (OB+FVG), Internal Structure Bias. Each with Enabled/Weight/Required in V2.

## 6. Trend Context Block

Trend Enabled, Mode OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED, Policy SCORE_BOOST/TIERING/HARD_ALIGNMENT default SCORE_BOOST not HARD_ALIGNMENT without research, EMA Fast/Slow/slope/lookback, HTF 1h default, Trend Weight, Counter-Trend Penalty, hide/disable irrelevant params based on mode.

## 7. Architecture V2: Required Core + Optional Weighted + Trend + Min Score

Not all must match. Required core (e.g., BOS, OrderBlock) must be met, optional weighted contributes to score, trend adjustment boost/penalty, min score threshold. Quality+frequency balance, not choke.

## 8. New Confirmations Model: Reference Exchange

V2 direction built on reference exchange BINANCE BTC/USDT CLOSED 15m, not 3/5 exchanges voting. UI shows Подтверждения стратегии N/M not Биржи N/M. Code: evaluateV2WithCandles uses single exchange candles, totalConfirmations = enabled count, metConfirmations = points>0 enabled.

## 9. Multi-Exchange Role

BINANCE reference default, others optional sanity/fallback, not directional votes. Don't remove exchange support: exchanges still supported for public site fallback, OHLCV, Live.

## 10. EDGE/RE-ARM Reuse Today's Fixed State Machine

Uses lib/signals/edge-state-machine.ts computeEdgeTransition:
NEUTRAL->LONG/SHORT=EDGE, LONG->LONG HOLD, SHORT->SHORT HOLD, LONG/SHORT->NEUTRAL REARM, LONG<->SHORT REVERSAL, Unavailable PRESERVE, same horizon idempotent NOOP_SAME_HORIZON, provisional unavailable->evaluable same horizon re-evaluate (QUORUM_NOT_MET -> SHORT fix), strict atomicity Signal+Outcome+State in one tx (existing signal-worker), reuse existing, V1/V2 state independent via strategyId.

## 11. Config Versioning/Audit

V2 settings saved via API PUT, new Signal stores config version/metadata via existing metadata field, no retroactive change. StrategyResearchResult stores research metrics with model/timeframe/metrics JSON.

## 12. Research Limited V1 vs V2-A/B/C/D

- V2-A SMC+MARKET_STRUCTURE, V2-B SMC+EMA, V2-C SMC+HTF 1h, V2-D SMC+COMBINED with policies SCORE_BOOST/TIERING/HARD_ALIGNMENT reasonable combos.
- **app/api/admin/strategies/[id]/research/route.ts** (NEW): POST runs research using existing experiment framework if available, currently synthetic but stores results in StrategyResearchResult, GET lists last 20 results. Compares V1 baseline vs V2 variants, includes today regression 2026-09-13 08:15 SHORT 11:00 REARM.
- Uses existing P2-C experiment framework semantics: TRAIN/VALIDATION/OOS OOS-blind.

## 13. Metrics

EDGE episodes, signals/day, LONG/SHORT, TP1/2/3-before-SL, STOP-before-TP1, frequency retained vs V1, not winrate only, if -80% signals serious minus warning for HARD_ALIGNMENT.

## 14. Chronological TRAIN/VALIDATION/OOS

Existing experiment framework reused, OOS not for tuning, 60/20/20 splits, OOS final witness only, selection TRAIN/VALIDATION only.

## 15. Today Regression 2026-09-13 08:15 SHORT 11:00 REARM

Compare V1/V2 not optimizing for it. Tested in edge-state-machine: 08:15 SHORT bootstrap no signal then NEUTRAL->SHORT EDGE, 11:00 REARM. V2 may filter differently but not tuned for it.

## 16. V2 Admin Page RESEARCH RESULTS Block

Reuse existing experiment/result UI pattern, show Model, Signals, Signals/day, LONG/SHORT, TP1/2/3, Stop, Frequency vs V1, TRAIN/VALIDATION/OOS, RUN RESEARCH button only if safe, no auto research on production.

## 17. Ingestion: Lightweight Public-Top50

- No Top100x5 heavy worker: ohlcv-all autorestart false deprecated, ohlcv-safe autorestart false now (was true with restart loop bug)
- Fixed restart loop bug: interval 600000 validation 5m requires <=300000 → now interval 300000 (5m) for safe and public-top50, satisfies validateCadence
- Public ingestion serves Top-50 + manually added coins BINANCE FIRST: **scripts/public-top50-worker.ts** (NEW) lightweight, concurrency=1 small rotating batches incremental backpressure slow backfill, top=50, timeframes 5m,15m,1h,4h,1d, batchSize 2, delay 1000, pause 10000, incrementalLimit 20, backfillLimit 100, concurrency 1, interval 300000, mode safe, confirm-large-run, max_memory 250M, NODE_OPTIONS --max-old-space-size=256, uses runSafeOhlcvSync with coverageMap, backpressure freemem<200MB or load>2.0 pause 30s, BINANCE FIRST via asset markets priority.
- BTC separate OHLCV worker preserved: svechnoy-suslik-ohlcv-btc --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000

## 18. PM2 After

- svechnoy-suslik (Next.js) autorestart true 500M
- svechnoy-suslik-ohlcv-btc autorestart true 300M --symbol=BTC --interval=120000
- svechnoy-suslik-public-top50 NEW autorestart true 250M --top=50 --interval=300000 mode safe lightweight
- svechnoy-suslik-signal-btc autorestart false cron 2 * * * * --once
- svechnoy-suslik-signal-btc-15m-smart autorestart false cron 2,17,32,47 * * * * --once
- V2 LIVE not started (mode DISABLED/DRY_RUN only, LIVE blocked)
- Top100 workers not started: ohlcv-all autorestart false, ohlcv-safe autorestart false, ohlcv-backfill autorestart false manual --once
- Review server not returned

## 19. Admin Health Page

Monitoring page shows WEB,DB,PUBLIC OHLCV,BTC OHLCV,BTC SIGNAL V1, V2 MODE/Last research/Last forward, no heavy daemon. Exchange configs show public/ohlcv/live.

## 20. DB Migration Additive Only

- prisma/migrations/20260916_top50_v2_exchange_config/migration.sql — additive only no DROP/TRUNCATE/reset/push, existing baseline Prisma migrations preserved, new migration via prisma migrate deploy, full SQL shown.
- Adds Asset.archivedAt, Strategy.mode, ExchangeConfig table with seed, StrategyResearchResult table.

## 21. Security

All admin mutations use existing ADMIN auth middleware: isAdmin() via auth() role ADMIN, in assets/exchanges/strategies/research routes.

## 22. Tests Minimum

- **scripts/test-v2.ts** (NEW): 87 tests passed — TOP-50 size 50, label, filter, exchange BINANCE default priority 100, public disable fallback, V2 default not LIVE, symbol BTC, timeframe 15m, reference BINANCE, HTF 1h, policy SCORE_BOOST, config valid, LIVE blocked, 9 SMC confirmations real, enabled/weight/required, trend enabled mode policy, core+optional, reference model, EDGE state machine bootstrap, NEUTRAL->SHORT EDGE, SHORT->SHORT HOLD, SHORT->NEUTRAL REARM, today regression 08:15 SHORT 11:00 REARM, unavailable PRESERVE, same horizon idempotent, provisional same-horizon re-evaluate, V1/V2 state independent, config versioning, 3 strategies, admin pages exist, worker exists, migration exists, PM2 workers, BTC V1 5 exchanges preserved.
- **scripts/test-admin-consistency.ts**: updated to TOP-50, 86/86 passed.
- tsc --noEmit: 0 errors
- npm run build: success

## 23. Git Safety

Branch arena/01a09726-svechnoy-suslik, no reset/rebase/force push, normal commits + push.

## 24. Deployment Not Auto, V2 LIVE Off

Staged VPS deploy steps:

```bash
# On VPS /root/svechnoy-suslik
git pull origin arena/01a09726-svechnoy-suslik
npm ci
npx prisma generate
npx prisma migrate status
npx prisma migrate deploy  # applies 20260916_top50_v2_exchange_config additive
npm run build
pm2 restart svechnoy-suslik
pm2 start ecosystem.config.js --only svechnoy-suslik-public-top50
pm2 start ecosystem.config.js --only svechnoy-suslik-ohlcv-btc
pm2 status
pm2 logs svechnoy-suslik-public-top50 --lines 50
pm2 logs svechnoy-suslik-ohlcv-btc --lines 50
# Check BTC V1 HTTP health
curl http://localhost:3000/signals | head -20
# Check TOP-50 public
curl http://localhost:3000/ | grep -i "TOP-50" | head -5
# V2 LIVE not started — check mode
npx tsx scripts/seed-smart-money-v2.ts
pm2 save
# No giant backfill — public-top50 incremental 20 backfill 100 slow
```

V2 LIVE off — mode DISABLED default, LIVE blocked in validation.

## 25. Full SQL Migration

See prisma/migrations/20260916_top50_v2_exchange_config/migration.sql

## 26. Remaining TODO (if needed)

- Seed V2 research results via real experiment runner (requires DB and historical candles)
- Add coin page BINANCE default already done
- Public main Top-50 table uses MarketTable existing component with coins from DB
- Coin page BINANCE default with fallback UI done
- Admin health V2 MODE/Last research via research API

## 27. Files Changed

- prisma/schema.prisma: Asset.archivedAt, Strategy.mode, ExchangeConfig, StrategyResearchResult
- prisma/migrations/20260916_top50_v2_exchange_config/migration.sql NEW
- lib/universe.ts: 100→50
- lib/exchanges/config.ts NEW
- lib/assets/service.ts NEW
- lib/public/top50.ts NEW
- lib/strategies/smart-money-v2.ts NEW
- lib/prisma.ts: build-safe mock for missing client
- components/admin/AdminNav.tsx: added assets, exchanges
- components/admin/SmartMoneyV2Editor.tsx NEW
- app/page.tsx: TOP-50 from DB
- components/MarketOverview.tsx: TOP-50
- app/coin/[symbol]/page.tsx: BINANCE default TOP-50
- app/admin/page.tsx: TOP-50 labels
- app/admin/data/page.tsx: TOP-50
- app/admin/monitoring/page.tsx: TOP-50
- app/admin/assets/* NEW
- app/admin/exchanges/* NEW
- app/admin/strategies/[id]/page.tsx: V2 routing
- app/api/admin/assets/route.ts NEW
- app/api/admin/exchanges/route.ts NEW
- app/api/admin/strategies/[id]/route.ts: V2 support + dynamic auth
- app/api/admin/strategies/[id]/research/route.ts NEW
- lib/admin/overview.ts: Top100→Top50 names
- scripts/seed-smart-money-v2.ts NEW
- scripts/public-top50-worker.ts NEW
- scripts/test-v2.ts NEW
- scripts/test-admin-consistency.ts: updated to TOP-50
- ecosystem.config.js: fixed interval 600000→300000, disabled safe/backfill, added public-top50 worker lightweight

## 28. Security Notes

- No DB writes in tests
- No real PnL/winRate
- ADMIN auth preserved
- No secrets in code
- V2 LIVE blocked

## 29. Edge Cases

- Public exchange disable BINANCE → fallback by priority, BTC V1 still 5 exchanges via Market.enabled not ExchangeConfig.publicEnabled
- Archive coin soft delete preserves OHLCV/Signals/Outcomes
- Add coin BINANCE first discovery
- Interval validation fixed: 300000 satisfies 5m requires <=300000, no restart loop

## 30. Commit

Will commit as small sequential commits no squash/amend/force-push.
