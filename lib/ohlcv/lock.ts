import type { PrismaClient } from "@prisma/client";

// Load .env via dotenv if available — standard for tsx/Prisma scripts.
// Next.js loads .env automatically, but tsx scripts (like ohlcv-worker) need dotenv.
// dotenv is a direct dependency (package.json) so this is a production contract, not transitive.
// If dotenv is not installed, we silently skip (e.g., in CI where env is injected).
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const dotenv = require("dotenv");
  dotenv.config();
  // Also try explicit production path /root/svechnoy-suslik/.env if cwd is different and .env not found
  // This handles PM2 with cwd "./" started from different directory — we try absolute path as fallback.
  // We don't log DATABASE_URL or secrets.
  if (!process.env.DATABASE_URL) {
    try {
      dotenv.config({ path: "/root/svechnoy-suslik/.env" });
    } catch {}
  }
} catch {}

export const OHLCV_ADVISORY_LOCK_KEY = 727923; // arbitrary 32-bit key for OHLCV worker single-instance

// --- Dedicated pg.Client session-level lock (production singleton) ---
// Uses a dedicated PostgreSQL connection/client to hold the session-level advisory lock
// for the entire worker lifetime. Same session acquire & release, auto-release on disconnect/crash.

export type OhlcvDedicatedLockHandle = {
  client: import("pg").Client;
  key: number;
};

export async function acquireDedicatedLock(
  key: number = OHLCV_ADVISORY_LOCK_KEY
): Promise<OhlcvDedicatedLockHandle | null> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL not set — cannot acquire advisory lock. Ensure .env is present at /root/svechnoy-suslik/.env or cwd/.env and dotenv is loaded."
    );
  }
  // Dynamic import to keep module loadable even if pg not installed (pure tests)
  let Client: typeof import("pg").Client;
  try {
    const pg = await import("pg");
    Client = pg.Client;
  } catch (e) {
    throw new Error(
      "pg package not installed — cannot acquire advisory lock: " +
        (e instanceof Error ? e.message : String(e))
    );
  }
  const client = new Client({ connectionString });
  await client.connect();
  try {
    const res = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [key]);
    const acquired = res.rows[0]?.acquired === true;
    if (!acquired) {
      await client.end().catch(() => {});
      return null;
    }
    return { client, key };
  } catch (e) {
    await client.end().catch(() => {});
    throw e;
  }
}

export async function releaseDedicatedLock(handle: OhlcvDedicatedLockHandle | null): Promise<void> {
  if (!handle || !handle.client) return;
  try {
    // Must use same session to unlock — this is the same client that acquired
    await handle.client.query("SELECT pg_advisory_unlock($1)", [handle.key]);
  } catch {}
  try {
    await handle.client.end();
  } catch {}
}

// --- Legacy Prisma pool-based lock (deprecated for production singleton) ---
// Kept for backward compat / tests that mock Prisma, but NOT used for production singleton
// because Prisma pool may use different physical connections for acquire/release.

export async function tryAcquireOhlcvLock(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(${OHLCV_ADVISORY_LOCK_KEY}) as acquired
  `;
  return rows[0]?.acquired === true;
}

export async function releaseOhlcvLock(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`
    SELECT pg_advisory_unlock(${OHLCV_ADVISORY_LOCK_KEY})
  `;
}

// For tests: helper to check if dedicated lock is held via new connection
export async function isDedicatedLockHeldViaNewConnection(
  key: number = OHLCV_ADVISORY_LOCK_KEY
): Promise<boolean> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL not set");
  const { Client } = await import("pg");
  const client = new Client({ connectionString });
  await client.connect();
  try {
    // Try to acquire with try — if already held, this will return false, and we immediately release if we acquired
    const res = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [key]);
    const acquired = res.rows[0]?.acquired === true;
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
      await client.end();
      return false; // not held by someone else, we were able to acquire
    }
    await client.end();
    return true; // held by someone else
  } catch {
    await client.end().catch(() => {});
    throw new Error("failed to check lock");
  }
}
