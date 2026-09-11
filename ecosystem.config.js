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
 * - single-instance: PostgreSQL advisory lock 727923 (fail-closed, no Redis, no migration)
 *
 * IMPORTANT:
 * - This file is version-controlled (required for audit), but does NOT auto-start on VPS.
 * - Do NOT run `pm2 start ecosystem.config.js` in Arena sandbox. VPS operator starts manually.
 * - Worker start ≠ enable Smart Money: Strategy id=2 remains DRAFT/enabled=false after worker start.
 * - No secrets in this file: DATABASE_URL and other env vars are inherited from host .env (pm2 --update-env).
 * - Never hardcode DATABASE_URL or DB id; use --symbol=BTC exact symbol selection.
 *
 * Usage on VPS (production):
 *   pm2 start ecosystem.config.js --only svechnoy-suslik-ohlcv-btc --update-env
 *   pm2 status
 *   pm2 logs svechnoy-suslik-ohlcv-btc
 *   pm2 restart svechnoy-suslik-ohlcv-btc --update-env
 *   pm2 stop svechnoy-suslik-ohlcv-btc
 *   pm2 delete svechnoy-suslik-ohlcv-btc
 *
 * Verification (read-only, no Signal writes):
 *   npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --plan
 *   # should show: Symbol: BTC, assets 1, markets ~5, tasks 25, interval 120000
 *   npx tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000 --once
 *   # single pass (fail-closed cadence guard bypassed only via --once)
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
 * - advisory lock 727923 prevents overlapping PM2 instances (fail-closed, PostgreSQL only)
 */
module.exports = {
  apps: [
    {
      name: "svechnoy-suslik",
      script: "npm",
      args: "start",
      cwd: "./",
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
      script: "npx",
      args: "tsx scripts/ohlcv-worker.ts --symbol=BTC --timeframes=5m,15m,1h,4h,1d --limit=300 --interval=120000",
      cwd: "./",
      interpreter: "none",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      watch: false,
      // PM2 will inherit env (DATABASE_URL, etc.) from host; do NOT hardcode secrets here
      env: {
        NODE_ENV: "production",
      },
      // Sequential delay is inside worker (250ms), no extra PM2 throttling needed
      // Restart delay is PM2's own backoff for crashes (not ingestion interval)
      restart_delay: 5000,
      max_memory_restart: "300M",
      // Log handling: PM2 default logs, worker logs are visible via pm2 logs
      // No secrets in logs: worker masks secrets via instrumentation
    },
  ],
};
