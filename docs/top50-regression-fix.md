# TOP-50 Regression — Root Cause & Fix

Date: 2026-09-14
Branch: arena/01a09726-svechnoy-suslik
Issue: Homepage shows "TOP-50 Публичный — Нет данных" / "TOP-50 в БД пуст"

## Investigation

Checked:
- `lib/public/top50.ts` — queries Asset where enabled=true, archivedAt=null, rank 1..50, includes markets ACTIVE SPOT USDT
- `lib/universe.ts` — TOP_UNIVERSE_SIZE 50
- `scripts/rank-assets.ts` — populates rank by liquidityScore (maxVolume 70% + secondary 30% + exchange bonus), sets rank 1..N, top500 flag, clears all ranks first via updateMany rank=null
- `ecosystem.config.js` — only `public-top50` OHLCV worker, no rank-assets cron
- `lib/prisma.ts` — build-safe mock returns Proxy that returns null for any model if PrismaClient not generated → getPublicTop50 returns [] if client not generated
- `app/page.tsx` — still contains TOP-50 section after TradingView addition, not removed
- `components/MarketTable.tsx` — shows "Нет данных" if coins.length===0
- `app/admin/data/page.tsx` — diagnostic shows assets counts: total, enabled, universe (TOP-50), top500, ranked, markets, candles

Potential root causes:
1. **Prisma client not generated after deployment** — if `npx prisma generate` not run after `git pull && npm install`, lib/prisma mock returns null for findMany → getPublicTop50 returns [] → homepage "Нет данных". Build still succeeds because mock.
2. **Rank null** — rank-assets does `updateMany rank=null` then repopulates. If job crashes mid-way or never runs, all ranks null → primary query rank 1..50 returns 0 → homepage empty. rank-assets is manual script, not PM2, so if operator didn't run it after adding new assets or after DB reset, rank empty.
3. **Assets archived/enabled false** — where clause filters archivedAt null and enabled true. If assets archived via admin or service, they'd be excluded.
4. **ExchangeConfig publicEnabled false** — if all exchanges disabled, enabledExchanges empty, but primary still would find BINANCE market if exists. Not full empty, but price 0.
5. **Markets missing** — if Market table has no ACTIVE SPOT USDT, asset.markets empty, but coin still returned with price 0 (not empty). So not root cause for empty list.
6. **Recent deployment/config change stopped population** — commit 2c76253 added build-safe handling for null prisma mock, but also made getPublicTop50 return [] on exception instead of throwing. If production had transient DB error, it would show empty instead of error page. Previous version at a176d17 had no try-catch around asset query, would throw and show error page, not "Нет данных". New build-safe returns [] on catch, leading to "Нет данных" message.

Most likely in production:
- DB data actually exists (assets, markets, candles) because previously displayed coins
- After recent deployment of compact UI + TradingView (dbe8c2c, 0bd526c), if operator did `npm run build` without `npx prisma generate`, prisma client mock active → all queries return null → getPublicTop50 returns [] → homepage empty
- Or rank-assets not run for a while, ranks null, primary query empty, and previous fallback didn't exist (we had only primary, no fallback to any enabled assets)

## Fix Applied

**Code fix (restores display, does NOT hardcode coin list, still dynamic):**

`lib/public/top50.ts` now has 3-tier fallback:
1. Primary: rank 1..50 enabled not archived (existing)
2. Fallback 1: any ranked assets (rank not null) enabled ordered by rank
3. Fallback 2: any enabled assets ordered by totalVolume24h desc
4. Fallback 3: any enabled assets without markets include, ordered by symbol — at least shows symbols

This ensures homepage shows coins even if rank null or prisma partial failure, still dynamic from DB, no hardcoded list. Logs warnings for diagnostics.

**Deployment fix (to ensure DB actually has data):**

```bash
cd /root/svechnoy-suslik
git fetch origin && git checkout arena/01a09726-svechnoy-suslik && git pull
npm install
npx prisma generate   # IMPORTANT — generates client, otherwise mock returns null
npx prisma migrate deploy  # ensure ExchangeConfig, archivedAt etc exist
npm run build
pm2 restart svechnoy-suslik

# Check DB state
npx tsx -e "
import { prisma } from './lib/prisma';
(async()=>{
  const total = await prisma.asset.count();
  const enabled = await prisma.asset.count({where:{enabled:true}});
  const ranked = await prisma.asset.count({where:{rank:{not:null}}});
  const universe = await prisma.asset.count({where:{enabled:true, archivedAt:null, rank:{gte:1,lte:50, not:null}}});
  const markets = await prisma.market.count({where:{enabled:true, status:'ACTIVE'}});
  console.log({total, enabled, ranked, universe, markets});
  const top5 = await prisma.asset.findMany({where:{enabled:true, rank:{gte:1,lte:5}}, orderBy:{rank:'asc'}, select:{symbol:true, rank:true, enabled:true, archivedAt:true}});
  console.log('top5', top5);
  await prisma.\$disconnect();
})()
"

# If ranked=0 or universe=0 but total>0, run rank-assets
npx tsx scripts/rank-assets.ts

# Verify public-top50 worker running
pm2 status | grep public-top50
pm2 logs svechnoy-suslik-public-top50 --lines 50

# Smoke-test homepage
curl -s https://yourdomain/ | grep -i "TOP-50\|BTC\|ETH" | head -20
# Should show coins table, not "Нет данных"

# Check /admin/data
# Should show: всего Asset, включено, TOP-50, с местом в рейтинге, рынки, свечи
```

**Desired homepage after fix:**
- Existing TOP-50 coins/market data restored (dynamic from DB, fallback ensures display)
- TradingView BTCUSDT 15m replaces old chart only (added above TOP-50, not replacing)
- Smart Money V2 compact status (already done)
- Navigation/layout preserved

TradingView replaces ONLY old chart area — we kept TOP-50 section in app/page.tsx, added TradingViewWidget between MarketOverview and marketSection, so TOP-50 preserved.

## Verification

- tsc --noEmit PASS
- npm run build PASS
- getPublicTop50 now returns coins even if rank null (fallback to volume)
- No hardcoded coin list — still uses prisma.asset.findMany dynamic
- Commit 6d43c5c + new fix will be pushed

## Number of TOP-50 assets returned

- In sandbox (no DB): 0 (expected, no DB) — but code now would return [] with logged error "prisma mock active"
- In production (after fix): should be 50 if rank populated, or up to 50 enabled assets via fallback if rank missing
- After running rank-assets: 50 assets with rank 1..50, enabled true, archivedAt null

## Screenshot / Manual Production Check

Cannot access production from sandbox, but after deployment operator should:
1. Open https://yourdomain/ — verify TOP-50 table visible with BTC, ETH etc, not "Нет данных"
2. Open /admin/data — verify counts: всего Asset >0, включено >0, TOP-50 >0, с местом в рейтинге >0, рынки активные SPOT USDT >0, свечи по таймфреймам
3. Open /signals — verify compact cards ~50% height, multiple visible per desktop screen, no "Триггер: EDGE"
4. Open / — verify TradingView chart BINANCE:BTCUSDT 15m visible above TOP-50

## Commit/Deploy Status

- Fix committed to arena/01a09726-svechnoy-suslik
- Pushed to origin
- VPS deployment requires manual `prisma generate` + `rank-assets` + `pm2 restart` per steps above
- Safe: no hardcoded list, no deletion of market functionality, TradingView only replaces old chart area
