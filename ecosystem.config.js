/**
 * PM2 ecosystem for svechnoy-suslik
 *
 * BTC pilot: single-instance continuous OHLCV ingestion for Smart Money readiness
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
 *
 * IMPORTANT:
 * - This file is version-controlled (required for audit), but does NOT auto-start on VPS.
 * - Do NOT run `pm2 start ecosystem.config.js` in Arena sandbox. VPS operator starts manually.
 * - Worker start ≠ enable Smart Money: Strategy id=2 remains DRAFT/enabled=false after worker start
 *   (current production: id=2 slug=smart-money-suslik status=DRAFT enabled=false timeframes=["5m","15m","1h","4h","1d"] minExchanges=3 Signal 0 — see PROJECT_CONTEXT §41).
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
 *   # Full deployment (both apps) — only when intentionally starting web + worker:
 *   pm2 start ecosystem.config.js
 *
 * Verification (read-only, no Signal writes):
 *   npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --plan
 *   # should show: Symbol: BTC, assets 1, markets ~5, tasks 25, interval 120000
 *   npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --once
 *   # single pass (fail-closed cadence guard bypassed only via --once, single-instance lock held on dedicated session)
 *
 * Rollback (if pilot misbehaves):
 *   pm2 stop svechnoy-suslik-ohlcv-btc
 *   pm2 delete svechnoy-suslik-ohlcv-btc
 *   pm2 status  # confirm only svechnoy-suslik (Next.js) remains
 *   # DB rollback not needed: worker is idempotent upsert (market+timeframe+openTime), no deletes
 *
 * Safety decisions in this file:
 * - interval 120000 = 2m (conservative, runtime-aware, within 5m bound)
 * - --symbol=BTC over --top=1 (explicit, no silent top=1=BTC assumption, no hardcode id)
 * - dedicated pg.Client advisory lock 727923 (same-session, held for worker lifetime, auto-released on crash)
 * - cwd "/root/svechnoy-suslik" + dotenv for unambiguous .env loading (not shell --update-env)
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
  ],
};
