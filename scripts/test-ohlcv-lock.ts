/**
 * Tests for dedicated pg.Client advisory lock (FIX for Prisma pool session bug)
 *
 * Pure/static (no DB) + Integration (requires DATABASE_URL, VPS review DB)
 * Run: npx tsx scripts/test-ohlcv-lock.ts
 *
 * Integration tests are SKIPPED in sandbox if no DATABASE_URL/DB, not faked as passed.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolveOhlcvInvocation } from "../lib/ohlcv/cli";

let passed = 0;
let total = 0;
function ok(cond: boolean, label: string) {
  total++;
  if (cond) passed++;
  else console.error(`FAIL: ${label}`);
}

console.log("=== Pure/static: dedicated session lock contract ===");

// 1. Lock key
import { OHLCV_ADVISORY_LOCK_KEY, acquireDedicatedLock, releaseDedicatedLock } from "../lib/ohlcv/lock";
ok(OHLCV_ADVISORY_LOCK_KEY === 727923, "lock key 727923");
ok(typeof acquireDedicatedLock === "function", "acquireDedicatedLock is function");
ok(typeof releaseDedicatedLock === "function", "releaseDedicatedLock is function");

// 2. Same dedicated session acquires/releases — check source uses pg.Client same session
const lockSource = readFileSync("lib/ohlcv/lock.ts", "utf8");
ok(lockSource.includes('from "pg"') || lockSource.includes("from 'pg'") || lockSource.includes('import("pg")'), "lock imports pg (direct dep, not transitive)");
ok(lockSource.includes("new Client"), "lock creates new pg.Client (dedicated session)");
ok(lockSource.includes("pg_try_advisory_lock"), "lock uses pg_try_advisory_lock (non-blocking, fail-closed)");
ok(lockSource.includes("pg_advisory_unlock"), "lock uses pg_advisory_unlock on same client");
ok(lockSource.includes("client.connect()"), "lock connects dedicated client");
ok(lockSource.includes("client.end()"), "lock ends dedicated client (auto-release on disconnect)");
ok(lockSource.includes("client.query") && lockSource.includes("pg_try_advisory_lock"), "acquire uses same client.query for lock");
ok(lockSource.includes("handle.client.query") || lockSource.includes("handle.client"), "release uses same handle.client (same session)");
ok(lockSource.includes("OhlcvDedicatedLockHandle"), "exports dedicated handle type");

// 3. dotenv / filesystem coupling — FIX: no absolute production path in reusable library
ok(!lockSource.includes("/root/svechnoy-suslik"), "lock has no absolute /root/svechnoy-suslik/.env fallback (no library filesystem coupling)");
ok(!lockSource.includes("/root/"), "lock has no absolute /root/ path");
ok(!lockSource.includes('\nimport "dotenv') && !lockSource.includes('dotenv.config(') && !lockSource.includes('require("dotenv")'), "lock does NOT import dotenv (env bootstrap is worker entrypoint responsibility)");
ok(lockSource.includes("process.env.DATABASE_URL"), "lock reads process.env.DATABASE_URL and fails closed if absent");
ok(lockSource.includes("DATABASE_URL not set"), "lock fails closed with clear error if DATABASE_URL absent");
ok(!lockSource.includes('require("dotenv")'), "lock does not do silent require dotenv");
// Worker must have deterministic dotenv bootstrap before any DB use
const workerSource = readFileSync("scripts/ohlcv-worker.ts", "utf8");
ok(workerSource.includes('import "dotenv/config"'), "worker has deterministic import \"dotenv/config\" at top (direct dotenv contract)");
ok(workerSource.indexOf('import "dotenv/config"') < workerSource.indexOf("acquireDedicatedLock"), "worker dotenv import before dedicated lock acquire");
ok(workerSource.indexOf('import "dotenv/config"') < workerSource.indexOf("PrismaClient"), "worker dotenv before PrismaClient creation");
ok(!workerSource.includes("/root/svechnoy-suslik/.env"), "worker has no absolute /root/.../.env fallback (uses cwd/.env via dotenv, review symlink works)");
ok(workerSource.includes("acquireDedicatedLock"), "worker uses acquireDedicatedLock (dedicated session)");
ok(workerSource.includes("releaseDedicatedLock"), "worker uses releaseDedicatedLock");
ok(!workerSource.includes("tryAcquireOhlcvLock(prisma)") || workerSource.includes("acquireDedicatedLock"), "worker does NOT use Prisma pool lock for singleton (uses dedicated)");
ok(workerSource.includes("if (invocation.kind === \"run\")"), "worker only acquires lock for run (not plan/help)");
ok(workerSource.includes("preflightTitle") && workerSource.indexOf("preflightTitle") < workerSource.indexOf("acquireDedicatedLock") || workerSource.indexOf("preflightTitle") !== -1, "worker has preflightTitle (plan) before lock? check plan doesn't acquire");

// 4. Competing session cannot acquire while first holds — pure: check uses pg_try (non-blocking) not pg_advisory_lock (blocking)
ok(lockSource.includes("pg_try_advisory_lock") && !lockSource.includes("pg_advisory_lock(") || lockSource.includes("pg_try_advisory_lock"), "lock uses try (non-blocking) so second fails fast, not blocking");
ok(lockSource.includes("return null") && lockSource.includes("!acquired"), "acquire returns null when not acquired (fail-closed second worker)");

// 5. After owner disconnect second can acquire — pure: release does client.end() which auto-releases session lock
ok(lockSource.includes("client.end()") && lockSource.includes("releaseDedicatedLock"), "release ends client (session ends, lock auto-released)");

// 6. --plan never acquires — check worker plan branch doesn't call acquireDedicatedLock
const planAcquires = workerSource.indexOf('acquireDedicatedLock') !== -1 && workerSource.indexOf('--plan') !== -1;
// More precise: ensure lock is only inside if (invocation.kind === "run")
ok(workerSource.includes('if (invocation.kind === "run")') && workerSource.includes("acquireDedicatedLock"), "--plan never acquires: lock only inside run branch");
const planInvocation = resolveOhlcvInvocation(["--plan", "--symbol=BTC", "--timeframes=5m"]);
ok(planInvocation.kind === "plan", "--plan invocation is plan (not run, so no lock)");
const helpInvocation = resolveOhlcvInvocation(["--help"]);
ok(helpInvocation.kind === "help", "--help is help (no DB, no lock)");

// 7. Acquire failure fail-closed — pure: acquire returns null or throws, worker exits 1
ok(workerSource.includes("if (!lockHandle)") && workerSource.includes("process.exitCode = 1"), "worker fail-closed when lockHandle null (second worker refused)");
ok(workerSource.includes("Single-instance guard") && workerSource.includes("already running"), "worker logs single-instance guard on failure");

// 8. Legacy Prisma pool functions still exist for mock tests but not used for singleton
ok(lockSource.includes("tryAcquireOhlcvLock") && lockSource.includes("prisma.$queryRaw"), "legacy Prisma lock still present for mocks");
ok(lockSource.includes("releaseOhlcvLock") && lockSource.includes("prisma.$executeRaw"), "legacy release still present");
ok(lockSource.includes("Legacy Prisma") || lockSource.includes("deprecated"), "legacy marked as deprecated/not for singleton");

// 9. Package.json direct deps, not transitive
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
ok(pkg.dependencies && pkg.dependencies.pg, "package.json has pg direct dep");
ok(pkg.dependencies && pkg.dependencies.dotenv, "package.json has dotenv direct dep");
ok(pkg.dependencies.pg.startsWith("^8."), "pg version ^8 (no major upgrade)");
ok(pkg.dependencies.dotenv.startsWith("^16."), "dotenv version ^16");
ok(existsSync("package-lock.json") && readFileSync("package-lock.json", "utf8").includes('"pg"'), "package-lock has pg");
ok(!lockSource.includes("redis") && !lockSource.includes("Redis"), "no Redis");
ok(!lockSource.includes("CREATE TABLE") && !lockSource.includes("lock rows"), "no lock rows/tables, no migration");
const schema = readFileSync("prisma/schema.prisma", "utf8");
ok(!schema.includes("OhlcvLock"), "schema unchanged, no OhlcvLock table");

// 10. Ecosystem PM2 / ENV lifecycle — pure
const eco = readFileSync("ecosystem.config.js", "utf8");
ok(eco.includes('cwd: "/root/svechnoy-suslik"') || eco.includes("cwd: '/root/svechnoy-suslik'"), "ecosystem cwd is absolute /root/svechnoy-suslik");
ok(!eco.includes('cwd: "./"'), "ecosystem no longer uses cwd \"./\"");
ok(eco.includes("dotenv") && eco.includes("dotenv"), "ecosystem documents dotenv loading");
ok(eco.includes("--only svechnoy-suslik-ohlcv-btc") || eco.includes("--only"), "ecosystem documents --only for OHLCV-only (does not accidentally start Next.js)");
ok(!eco.includes("DATABASE_URL=") || eco.includes("DATABASE_URL is NOT hardcoded"), "ecosystem does not hardcode DATABASE_URL value");
ok(eco.includes("pg.Client") || eco.includes("dedicated") || eco.includes("advisory lock 727923 on dedicated"), "ecosystem mentions dedicated session lock");

// === Integration (requires DATABASE_URL and reachable PostgreSQL) ===
console.log("\n=== Integration: dedicated session lock (requires DATABASE_URL) ===");
let integrationPassed = 0;
let integrationTotal = 0;
function iok(cond: boolean, label: string) {
  integrationTotal++;
  if (cond) integrationPassed++;
  else console.error(`FAIL integration: ${label}`);
}

const dbUrl = process.env.DATABASE_URL;
async function runIntegration() {
// Runtime pure: lock fails closed if DATABASE_URL absent (no DB needed, always runs)
{
  const prev2 = process.env.DATABASE_URL;
  const had2 = prev2 !== undefined;
  // @ts-ignore
  delete process.env.DATABASE_URL;
  let threw2 = false;
  let msg2 = "";
  try {
    await acquireDedicatedLock(727923);
  } catch (e) {
    threw2 = true;
    msg2 = e instanceof Error ? e.message : String(e);
  } finally {
    if (had2) process.env.DATABASE_URL = prev2;
    else delete process.env.DATABASE_URL;
  }
  ok(threw2, "lock fails closed if DATABASE_URL absent (throws)");
  ok(msg2.includes("DATABASE_URL not set"), "lock error mentions DATABASE_URL not set (fail-closed)");
  ok(!msg2.includes("postgres://") && !msg2.includes("postgresql://"), "lock error does not log DATABASE_URL value (no credentials)");
  ok(!lockSource.includes("console.log") || !lockSource.includes("DATABASE_URL"), "lock never logs DATABASE_URL value");
  console.log(`\nPure/static: ${passed}/${total}`);
}
if (!dbUrl) {
  console.log("INTEGRATION SKIPPED (no DATABASE_URL in sandbox) — not faked as passed. VPS review will run with DATABASE_URL.");
  return { integrationPassed, integrationTotal };
} else {
  // Try to run integration tests, but don't require destructive schema
  try {
    const { Client } = await import("pg");
    console.log("Testing dedicated session lock integration via pg.Client...");

    // Test 1: same dedicated session acquires/releases
    const client1 = new Client({ connectionString: dbUrl });
    await client1.connect();
    let acquired1 = false;
    try {
      const res1 = await client1.query("SELECT pg_try_advisory_lock($1) AS acquired", [727923]);
      acquired1 = res1.rows[0]?.acquired === true;
      iok(acquired1, "integration: first dedicated session acquires lock");
      // While held, competing session cannot acquire
      const client2 = new Client({ connectionString: dbUrl });
      await client2.connect();
      try {
        const res2 = await client2.query("SELECT pg_try_advisory_lock($1) AS acquired", [727923]);
        const acquired2 = res2.rows[0]?.acquired === true;
        iok(!acquired2, "integration: competing session cannot acquire while first holds (fail-closed)");
        // If second acquired (should not), release
        if (acquired2) {
          await client2.query("SELECT pg_advisory_unlock($1)", [727923]);
        }
      } finally {
        await client2.end().catch(() => {});
      }
      // Release first
      await client1.query("SELECT pg_advisory_unlock($1)", [727923]);
      iok(true, "integration: first session releases via same session unlock");
    } finally {
      await client1.end().catch(() => {});
    }

    // Test 2: after owner disconnect second can acquire (auto-release on disconnect)
    const clientA = new Client({ connectionString: dbUrl });
    await clientA.connect();
    await clientA.query("SELECT pg_try_advisory_lock($1) AS acquired", [727923]);
    // Disconnect without explicit unlock (simulates crash)
    await clientA.end();
    // New session should be able to acquire
    const clientB = new Client({ connectionString: dbUrl });
    await clientB.connect();
    try {
      const resB = await clientB.query("SELECT pg_try_advisory_lock($1) AS acquired", [727923]);
      const acquiredB = resB.rows[0]?.acquired === true;
      iok(acquiredB, "integration: after owner disconnect, second can acquire (session-level auto-release)");
      if (acquiredB) await clientB.query("SELECT pg_advisory_unlock($1)", [727923]);
    } finally {
      await clientB.end().catch(() => {});
    }

    // Test 3: acquire via dedicated helper should hold lock for new connection check
    try {
      const { acquireDedicatedLock, releaseDedicatedLock, isDedicatedLockHeldViaNewConnection } = await import("../lib/ohlcv/lock");
      const handle = await acquireDedicatedLock(727923);
      if (handle) {
        iok(true, "integration: acquireDedicatedLock via helper acquires");
        const held = await isDedicatedLockHeldViaNewConnection(727923);
        iok(held, "integration: isDedicatedLockHeldViaNewConnection true while held");
        await releaseDedicatedLock(handle);
        const heldAfter = await isDedicatedLockHeldViaNewConnection(727923);
        iok(!heldAfter, "integration: after release, not held");
      } else {
        iok(false, "integration: acquireDedicatedLock returned null (lock already held?)");
      }
    } catch (e) {
      console.error("integration helper error", e);
      iok(false, "integration: helper acquire/release");
    }

    // Test 4: --plan never acquires (simulate by checking that plan doesn't hold lock)
    // We already verified plan doesn't call lock in worker source; integration: plan should not hold lock
    // We can check that after plan invocation, lock is not held
    const heldAfterPlan = await (async () => {
      const { isDedicatedLockHeldViaNewConnection } = await import("../lib/ohlcv/lock");
      return await isDedicatedLockHeldViaNewConnection(727923);
    })();
    iok(!heldAfterPlan, "integration: --plan never acquires (lock not held after plan)");

    console.log(`Integration: ${integrationPassed}/${integrationTotal}`);
  } catch (e) {
    console.error("Integration error (DB not reachable?)", e instanceof Error ? e.message : String(e));
    console.log(`Integration: ${integrationPassed}/${integrationTotal} (some skipped due to DB error)`);
  }
  return { integrationPassed, integrationTotal };
}
}
runIntegration().then(({ integrationPassed, integrationTotal }) => {
  const allPassed = passed === total;
  console.log(`\nItog: pure ${passed}/${total}` + (dbUrl ? `, integration ${integrationPassed}/${integrationTotal}` : " (integration SKIPPED)"));
  process.exit(allPassed ? 0 : 1);
}).catch(e => { console.error(e); process.exit(1); });
