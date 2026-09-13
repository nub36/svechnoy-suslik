/**
 * PM2 ecosystem for svechnoy-suslik
 *
 * BTC pilot: single-instance continuous OHLCV ingestion + Signal Engine for BTC 3001→3000
 * - scope: BTC only (exact Asset symbol BTC, enabled=true, market filters ACTIVE/USDT/SPOT)
 * - timeframes: 5m,15m,1h,4h,1d (Smart Money CLOSED-only 5/5 coverage, pilot verified)
 * - limit: 300 (candles per request)
 * - sequential: requestDelayMs 250 (concurrency=1, retry/backoff in worker)
 * - continuous: interval 120000ms (2m) — conservative ≤5m cadence for 5m CLOSED candles
 *   with ~10-20s pass runtime (25 tasks × delay+API) — ensures no missed closed candle
 *   default 60m is NOT production-safe for 5m (guard fails closed unless --once)
 * - single-instance: PostgreSQL advisory lock 727923 on dedicated pg.Client session
 *   (acquire & release on same physical connection, held for entire worker lifetime,
 *   auto-released on disconnect/crash, no Redis, no migration, no lock table)
 * - Signal Engine BTC: trend-suslik v1 PUBLISHED enabled 15m,1h,4h,1d minExchanges=2, ATR SL/TP, duplicate+cooldown protection, BINGX 1d excluded
 *
 * IMPORTANT:
 * - This file is version-controlled (required for audit), but does NOT auto-start on VPS.
 * - Do NOT run `pm2 start ecosystem.config.js` in Arena sandbox. VPS operator starts manually.
 * - Worker start ≠ enable Smart Money: Strategy id=2 remains DRAFT/enabled=false after worker start
 *   (current production after fix: id=1 trend-suslik PUBLISHED enabled=true timeframes 15m,1h,4h,1d minExchanges=2, id=2 smart-money PUBLISHED enabled=true, Signal 2 — see screenshot 13.09.2026 15:30).
 * - No secrets in this file: DATABASE_URL is NOT hardcoded here.
 *   Worker loads project .env via dotenv (direct dependency, package.json: dotenv ^16.6.1) similarly to
 *   existing tsx/Prisma scripts: `import "dotenv/config"` in scripts/ohlcv-worker.ts and lib/ohlcv/lock.ts
 *   loads cwd/.env (with PM2 cwd="/root/svechnoy-suslik") and fallback "/root/svechnoy-suslik/.env".
 *   PrismaClient and pg.Client both read process.env.DATABASE_URL after dotenv. No credentials printed.
 *   Do NOT rely on shell-exported DATABASE_URL before `pm2 start`; the launcher is unambiguous via cwd + dotenv.
 *   `--update-env` is ONLY for refreshing PM2's process env from shell on restart, NOT for loading .env secrets.
 * - cwd is absolute production path /root/svechnoy-suslik (not "./") to ensure dotenv finds .env
 *   and to avoid dependence on operator's shell pwd before `pm2 start`.
 * - Never hardcode DATABASE_URL or DB id; use --symbol=BTC exact symbol selection.
 *
 * Usage on VPS (production, project at /root/svechnoy-suslik):
 *   # OHLCV-only (does NOT start/override Next.js):
 *   pm2 start ecosystem.config.js --only svechnoy-suslik-ohlcv-btc
 *   pm2 status
 *   pm2 logs svechnoy-suslik-ohlcv-btc
 *   pm2 restart svechnoy-suslik-ohlcv-btc
 *   pm2 stop svechnoy-suslik-ohlcv-btc
 *   pm2 delete svechnoy-suslik-ohlcv-btc
 *   # Signal Engine BTC (creates real signals):
 *   pm2 start ecosystem.config.js --only svechnoy-suslik-signal-btc
 *   pm2 logs svechnoy-suslik-signal-btc
 *   # Full deployment (web + ohlcv + signal) — when intentionally starting all:
 *   pm2 start ecosystem.config.js
 *
 * Verification (read-only, no Signal writes):
 *   npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --plan
 *   # should show: Symbol: BTC, assets 1, markets ~5, tasks 25, interval 120000
 *   npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --once
 *   # single pass (fail-closed cadence guard bypassed only via --once, single-instance lock held on dedicated session)
 *
 * Signal verification:
 *   npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run
 *   npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run
 *   # should create Signal LONG/SHORT with ATR SL/TP, visible on /signals
 *
 * Rollback (if pilot misbehaves):
 *   pm2 stop svechnoy-suslik-ohlcv-btc
 *   pm2 delete svechnoy-suslik-ohlcv-btc
 *   pm2 stop svechnoy-suslik-signal-btc
 *   pm2 delete svechnoy-suslik-signal-btc
 *   pm2 status  # confirm only svechnoy-suslik (Next.js) remains
 *   # DB rollback not needed: worker is idempotent upsert (market+timeframe+openTime), no deletes
 *
 * Safety decisions in this file:
 * - interval 120000 = 2m (conservative, runtime-aware, within 5m bound)
 * - --symbol=BTC over --top=1 (explicit, no silent top=1=BTC assumption, no hardcode id)
 * - dedicated pg.Client advisory lock 727923 (same-session, held for worker lifetime, auto-released on crash)
 * - cwd "/root/svechnoy-suslik" + dotenv for unambiguous .env loading (not shell --update-env)
 * - Signal Engine interval 300000 = 5m (checks 1h timeframe, respects cooldown 1 candle)
 */
module.exports = {
  apps: [
    {
      name: "svechnoy-suslik",
      script: "npm",
      args: "start",
      cwd: "/root/svechnoy-suslik",
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: "500M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "svechnoy-suslik-ohlcv-btc",
      // BTC-only pilot: sequential OHLCV ingestion, continuous with 2m cadence
      // .env is loaded by worker via dotenv (see lib/ohlcv/lock.ts and scripts/ohlcv-worker.ts),
      // cwd ensures dotenv finds /root/svechnoy-suslik/.env
      // Lock 727923 — dedicated for BTC pilot
      script: "npx",
      args: "tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000",
      cwd: "/root/svechnoy-suslik",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 5000,
      max_memory_restart: "300M",
    },
    {
      name: "svechnoy-suslik-ohlcv-all",
      // DEPRECATED AGGRESSIVE — DISABLED for production stability (VPS 1.9GiB RAM, 512MiB SWAP, CPU 68%+100% host, ERR_CONNECTION_RESET /signals)
      // Previous args: --top=100 --limit=300 --delay=250 --concurrency=3 --interval=300000 — too heavy, caused Next.js stall
      // DO NOT auto-start. Use safe workers below.
      script: "npx",
      args: "tsx scripts/ohlcv-worker.ts --top=100 --timeframes=5m,15m,1h,4h,1d --limit=300 --delay=250 --concurrency=3 --interval=300000 --confirm-large-run",
      cwd: "/root/svechnoy-suslik",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 10000,
      max_memory_restart: "500M",
    },
    {
      name: "svechnoy-suslik-ohlcv-safe",
      // SAFE low-priority incremental background worker — PRODUCTION SAFE for VPS 1.9GiB RAM
      // FIXED: interval 600000 caused restart loop bug (validation 5m requires <=300000)
      // Now interval 300000 (5m) — max allowed for 5m timeframe, satisfies validateCadence
      // DEPRECATED for TOP-50 public — use svechnoy-suslik-public-top50 instead
      // Kept for reference but autorestart false — do NOT use Top100x5 heavy worker
      script: "npx",
      args: "tsx scripts/ohlcv-worker.ts --top=100 --timeframes=5m,15m,1h,4h,1d --batch-size=2 --delay=1000 --pause=10000 --incremental-limit=20 --backfill-limit=100 --concurrency=1 --interval=300000 --mode=safe --min-free-mem=200 --max-load=2.0 --confirm-large-run",
      cwd: "/root/svechnoy-suslik",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=256",
      },
      restart_delay: 10000,
      max_memory_restart: "250M",
    },
    {
      name: "svechnoy-suslik-ohlcv-backfill",
      // SLOW backfill worker — MANUAL ONLY, NOT auto-started after PM2 resurrect
      // For initial massive backfill in controlled slow background mode
      // batch 2 assets, delay 2000ms, pause 15000ms, backfillLimit 100, concurrency 1, interval 30m
      // Use: pm2 start ecosystem.config.js --only svechnoy-suslik-ohlcv-backfill -- --once (or without --once for continuous slow)
      // Then monitor: pm2 logs svechnoy-suslik-ohlcv-backfill
      // FIXED: interval 1800000 >300000 fails validation for 5m — use --once or exclude 5m for backfill
      script: "npx",
      args: "tsx scripts/ohlcv-worker.ts --top=100 --timeframes=5m,15m,1h,4h,1d --batch-size=2 --delay=2000 --pause=15000 --incremental-limit=20 --backfill-limit=100 --concurrency=1 --interval=300000 --mode=backfill --min-free-mem=200 --max-load=2.0 --confirm-large-run --once",
      cwd: "/root/svechnoy-suslik",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=256",
      },
      restart_delay: 15000,
      max_memory_restart: "250M",
    },
    {
      name: "svechnoy-suslik-public-top50",
      // LIGHTWEIGHT public TOP-50 ingestion worker — PRODUCTION SAFE
      // - Serves Top-50 + manually added coins BINANCE FIRST
      // - Concurrency=1 small rotating batches incremental backpressure slow backfill
      // - BTC separate OHLCV worker preserved (svechnoy-suslik-ohlcv-btc)
      // - Fixes critical bug: interval 300000 (5m) satisfies validation 5m requires <=300000, no restart loop
      // - No Top100x5 heavy worker, no broken ohlcv-safe restart loop
      // - Public site TOP-50 from Asset rank in DB, BINANCE default, fallback by priority, lightweight snapshot/cache not 50 WS, live WS only /coin/{symbol}
      script: "npx",
      args: "tsx scripts/public-top50-worker.ts --top=50 --timeframes=5m,15m,1h,4h,1d --batch-size=2 --delay=1000 --pause=10000 --incremental-limit=20 --backfill-limit=100 --concurrency=1 --interval=300000 --mode=safe --min-free-mem=200 --max-load=2.0 --confirm-large-run",
      cwd: "/root/svechnoy-suslik",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      env: {
        NODE_ENV: "production",
        NODE_OPTIONS: "--max-old-space-size=256",
      },
      restart_delay: 10000,
      max_memory_restart: "250M",
    },
    {
      name: "svechnoy-suslik-signal-btc",
      // BTC-only Signal Engine: creates real LONG/SHORT signals from Strategy Runtime (trend-suslik 1h)
      // Runs every 5m, checks trend-suslik PUBLISHED enabled, respects cooldown, BINGX 1d excluded, ATR SL/TP
      // .env loaded via dotenv in signal-worker via lib/prisma.ts
      // FIX: --once + restart_delay + cron_restart caused unnecessary restart races
      // Now: autorestart false, restart_delay 0, cron only — one reliable launch, idempotent NOOP prevents duplicates
      script: "npx",
      args: "tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --once --no-dry-run",
      cwd: "/root/svechnoy-suslik",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
      },
      restart_delay: 0,
      max_memory_restart: "300M",
      cron_restart: "2 * * * *", // 2 minutes after each hour close, ensures OHLCV 1h CLOSED ingested (1h candle closes at hour boundary, expected previous hour)
    },
    {
      name: "svechnoy-suslik-signal-btc-15m-smart",
      // BTC 15m Smart Money EDGE/RE-ARM V1 — LIVE production worker
      // One signal per EDGE, SHORT->SHORT HOLD, NEUTRAL->SHORT EDGE, SHORT->LONG REVERSAL, NEUTRAL REARM, unavailable PRESERVE, same horizon NOOP with provisional fix, bootstrap default no signal, PM2 restart preserves StrategySignalState
      // STRICT ATOMIC: Signal+Outcome+State in ONE tx, no catch inside, P2002 outside idempotent
      // Requires SMART_MONEY_WRITE_ENABLED=true env AND --enable-smart-money-write flag (AND guard)
      // FIX: --once + restart_delay 3m + cron */3 caused overlapping restart races
      // Now: autorestart false, restart_delay 0, cron at 2,17,32,47 — 2 minutes after each 15m close (00,15,30,45), ensures OHLCV CLOSED ingested (OHLCV worker 2m cadence)
      script: "npx",
      args: "tsx scripts/signal-worker.ts --strategy=smart-money-suslik --symbol=BTC --timeframe=15m --once --no-dry-run --enable-smart-money-write",
      cwd: "/root/svechnoy-suslik",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: false,
      watch: false,
      env: {
        NODE_ENV: "production",
        SMART_MONEY_WRITE_ENABLED: "true",
      },
      restart_delay: 0,
      max_memory_restart: "300M",
      cron_restart: "2,17,32,47 * * * *", // 2m after 15m close: 00->02, 15->17, 30->32, 45->47, reliable launch after CLOSED data
    },
  ],
};
