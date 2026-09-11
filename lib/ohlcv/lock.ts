import type { PrismaClient } from "@prisma/client";

// No dotenv/filesystem coupling here — reusable library.
// Environment bootstrap (dotenv/config) is responsibility of worker entrypoint
// (scripts/ohlcv-worker.ts does `import "dotenv/config"` before any DB use).
// This helper only reads process.env.DATABASE_URL and fails closed if absent,
// never logs the value.

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
      "DATABASE_URL not set — cannot acquire advisory lock. Ensure worker entrypoint loads .env via import \"dotenv/config\" and DATABASE_URL is set."
    );
  }
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
    const res = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [key]);
    const acquired = res.rows[0]?.acquired === true;
    if (acquired) {
      await client.query("SELECT pg_advisory_unlock($1)", [key]);
      await client.end();
      return false;
    }
    await client.end();
    return true;
  } catch {
    await client.end().catch(() => {});
    throw new Error("failed to check lock");
  }
}
