# V2 Deploy — Compact /signals + TradingView + FORWARD_TEST pipeline

Branch: arena/01a09726-svechnoy-suslik
Commits: 03976f4 (V2 engine + research), dbe8c2c (compact UI + TradingView), 0bd526c (PM2 V2 workers, FORWARD_TEST allowed)

## What is deployed (safe)

- Compact /signals UI ~50% less desktop height, no SetupKey, no EDGE State, no Trigger EDGE badge public, WAITING_ENTRY compact, LONG/SHORT accent kept, mobile readable
- Homepage TradingView widget BINANCE:BTCUSDT 15m default, responsive, integrated, Pine indicator not faked — maintained separately for TradingView.com
- Smart Money V2 admin configurable (DISABLED/DRY_RUN/FORWARD_TEST, LIVE gated)
- V2 backend FORWARD_TEST pipeline: reference market BINANCE BTC/USDT CLOSED 15m only, own StrategySignalState, own Signal, Outcome tracker generic
- V1 and V2 independent: same direction keep both, conflict keep both, V2-only show V2

## VPS Deployment Steps (production at /root/svechnoy-suslik)

```bash
cd /root/svechnoy-suslik
git fetch origin
git checkout arena/01a09726-svechnoy-suslik
git pull origin arena/01a09726-svechnoy-suslik

# deps
npm install
npx prisma generate
npm run build

# web
pm2 restart svechnoy-suslik
pm2 logs svechnoy-suslik --lines 50

# ensure V2 strategy exists
npx tsx scripts/seed-smart-money-v2.ts
# or check via psql: SELECT id,slug,version,enabled,status,mode,timeframes FROM \"Strategy\" WHERE slug='smart-money-v2';

# set V2 mode to DRY_RUN or FORWARD_TEST via admin UI /admin/strategies/[id] or SQL:
# UPDATE \"Strategy\" SET mode='FORWARD_TEST', enabled=true, status='PUBLISHED' WHERE slug='smart-money-v2';

# test V2 dry-run (no DB writes)
npx tsx scripts/signal-worker.ts --strategy=smart-money-v2 --timeframe=15m --dry-run

# test V2 FORWARD_TEST write (requires AND guard)
SMART_MONEY_V2_WRITE_ENABLED=true npx tsx scripts/signal-worker.ts --strategy=smart-money-v2 --symbol=BTC --timeframe=15m --no-dry-run --enable-smart-money-write

# outcome tracker (should already be running via PM2 cron)
pm2 logs svechnoy-suslik-signal-outcome --lines 100
npx tsx scripts/signal-outcome-worker.ts --once --dry-run

# V2 PM2 workers (autorestart false, cron)
pm2 start ecosystem.config.js --only svechnoy-suslik-signal-btc-15m-v2-dry
pm2 start ecosystem.config.js --only svechnoy-suslik-signal-btc-15m-v2
pm2 status
pm2 logs svechnoy-suslik-signal-btc-15m-v2 --lines 100

# smoke-test deployed pages
curl -s https://yourdomain/signals | head -100
# check: no "Триггер: EDGE", compact cards, BTC/USDT LONG/SHORT, LIVE badge, entry/SL/TP1/2/3, score, confirmations, exchange, time, milestones

curl -s https://yourdomain/ | grep -i tradingview -i
# check homepage contains TradingView widget BINANCE:BTCUSDT 15m
```

## PM2 Ecosystem Changes

- Added `svechnoy-suslik-signal-btc-15m-v2` — V2 FORWARD_TEST live writer, cron 2,17,32,47 * * * *, env SMART_MONEY_WRITE_ENABLED=true SMART_MONEY_V2_WRITE_ENABLED=true, autorestart false
- Added `svechnoy-suslik-signal-btc-15m-v2-dry` — V2 dry-run checker
- Existing `svechnoy-suslik-signal-btc-15m-smart` remains for V1
- `svechnoy-suslik-signal-outcome` generic supports V2 (WAITING_ENTRY H+D exact NEXT_BAR_OPEN)

## Safety

- V2 LIVE blocked in `lib/strategies/smart-money-v2.ts` validateV2Config and `lib/signals/v2-signal-engine.ts` — returns error if mode LIVE
- Admin UI disables LIVE option, shows gated message
- Worker AND guard requires BOTH --enable-smart-money-write flag AND env true
- No real PnL, no auto LIVE enable merely because UI deployed
- Compact UI keeps all useful trading info: BTC/USDT, LONG/SHORT, LIVE/FORWARD status, strategy, timeframe, entry/waiting, SL, TP1/2/3, score, confirmations, exchange, signal time, outcome milestones

## Smoke Test Checklist (real website)

- /signals: multiple cards visible on one desktop screen (~50% height reduction), no horizontal scroll, LONG green accent, SHORT red, status colors preserved, SCORE and CONFIRMATIONS boxes substantially shorter, WAITING_ENTRY compact one line with ◷ icon, no SetupKey, no EDGE State, no "Триггер: EDGE"
- / : TradingView chart BINANCE:BTCUSDT 15m visible, responsive, dark theme, no fake Pine indicator support
- /admin/strategies/[id] for smart-money-v2: mode selector DISABLED/DRY_RUN/FORWARD_TEST (LIVE disabled), confirmations grid with categories, trend modes OFF/MARKET_STRUCTURE/EMA/HTF/COMBINED, policies SCORE_BOOST/TIERING/HARD_ALIGNMENT, research button
- DB: Strategy smart-money-v2 exists, mode FORWARD_TEST, StrategySignalState for BTC 15m, Signal with WAITING_ENTRY then OPEN after outcome worker, outcome milestones preserved

## Rollback

```bash
pm2 stop svechnoy-suslik-signal-btc-15m-v2
pm2 delete svechnoy-suslik-signal-btc-15m-v2
pm2 stop svechnoy-suslik-signal-btc-15m-v2-dry
pm2 delete svechnoy-suslik-signal-btc-15m-v2-dry
git checkout main
npm run build
pm2 restart svechnoy-suslik
```

## Notes

- TradingView widget uses https://s.tradingview.com/tv.js — no API key, client-side
- If custom Pine cannot embed, we do NOT fake support — per task, chart on homepage, backend V2 status/signals remain website data, smart-money-v2.pine maintained separately for TradingView.com
- V2 research replay tool `scripts/v2-research-replay.ts` works with DB max history on VPS and synthetic fallback in sandbox — for real validation run on VPS with --max-candles 50000
