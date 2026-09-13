/**
 * Self-adversarial audit for read-only SQL layer — beyond happy paths.
 * Tests rejection of:
 * INSERT, UPDATE, DELETE, UPSERT, CREATE/ALTER/DROP/TRUNCATE,
 * $executeRaw, SELECT FOR UPDATE/SHARE, SELECT INTO, writable CTE WITH x AS (UPDATE ...),
 * multi-statement, comments hiding write keywords, mixed case, dollar-quoted, side-effecting funcs.
 */

import { assertReadOnlySql, assertReadOnlyPrismaMethod, READ_ONLY_SQL_ALLOWLIST_DOC } from "../lib/backtest/read-only-sql";

let passed = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++; else { failed++; console.error(`FAIL: ${msg}`); }
}

// Positive cases — should pass
ok(assertReadOnlySql("SELECT * FROM Candle WHERE closed=true").ok, "SELECT allowed");
ok(assertReadOnlySql("SELECT openTime, close FROM Candle ORDER BY openTime ASC LIMIT 100").ok, "SELECT with ORDER/LIMIT allowed");
ok(assertReadOnlySql("WITH c AS (SELECT * FROM Candle) SELECT * FROM c").ok, "WITH CTE SELECT allowed");
ok(assertReadOnlySql("SELECT COUNT(*) FROM Candle").ok, "SELECT COUNT allowed");
ok(assertReadOnlySql("select * from candle where closed=true").ok, "lowercase SELECT allowed");
ok(assertReadOnlySql("  SELECT * FROM Candle  ").ok, "trimmed SELECT allowed");

// Negative: INSERT
ok(!assertReadOnlySql("INSERT INTO Candle VALUES (1)").ok, "INSERT forbidden");
ok(!assertReadOnlySql("insert into Candle values (1)").ok, "insert lowercase forbidden");
ok(!assertReadOnlySql("  INSERT INTO Candle VALUES (1)").ok, "INSERT with leading spaces forbidden");

// UPDATE
ok(!assertReadOnlySql("UPDATE Candle SET close=1").ok, "UPDATE forbidden");
ok(!assertReadOnlySql("UpDaTe Candle SET close=1").ok, "mixed case UPDATE forbidden");

// DELETE
ok(!assertReadOnlySql("DELETE FROM Candle").ok, "DELETE forbidden");

// UPSERT / MERGE / REPLACE
ok(!assertReadOnlySql("UPSERT INTO Candle VALUES (1)").ok, "UPSERT forbidden");
ok(!assertReadOnlySql("MERGE INTO Candle USING ...").ok, "MERGE forbidden");
ok(!assertReadOnlySql("REPLACE INTO Candle VALUES (1)").ok, "REPLACE forbidden");

// CREATE/ALTER/DROP/TRUNCATE
ok(!assertReadOnlySql("CREATE TABLE foo (id int)").ok, "CREATE forbidden");
ok(!assertReadOnlySql("ALTER TABLE Candle ADD COLUMN foo int").ok, "ALTER forbidden");
ok(!assertReadOnlySql("DROP TABLE Candle").ok, "DROP forbidden");
ok(!assertReadOnlySql("TRUNCATE TABLE Candle").ok, "TRUNCATE forbidden");
ok(!assertReadOnlySql("REINDEX TABLE Candle").ok, "REINDEX forbidden");
ok(!assertReadOnlySql("VACUUM Candle").ok, "VACUUM forbidden");
ok(!assertReadOnlySql("ANALYZE Candle").ok, "ANALYZE forbidden");
ok(!assertReadOnlySql("CLUSTER Candle").ok, "CLUSTER forbidden");
ok(!assertReadOnlySql("COPY Candle TO '/tmp'").ok, "COPY forbidden");
ok(!assertReadOnlySql("LOAD 'foo'").ok, "LOAD forbidden");
ok(!assertReadOnlySql("GRANT SELECT ON Candle TO public").ok, "GRANT forbidden");
ok(!assertReadOnlySql("REVOKE SELECT ON Candle FROM public").ok, "REVOKE forbidden");
ok(!assertReadOnlySql("COMMENT ON TABLE Candle IS 'foo'").ok, "COMMENT forbidden");

// CALL/DO/PERFORM/EXECUTE/LISTEN/NOTIFY
ok(!assertReadOnlySql("CALL my_proc()").ok, "CALL forbidden");
ok(!assertReadOnlySql("DO $$ BEGIN PERFORM 1; END $$").ok, "DO forbidden");
ok(!assertReadOnlySql("PERFORM pg_sleep(1)").ok, "PERFORM forbidden");
ok(!assertReadOnlySql("EXECUTE my_prepared").ok, "EXECUTE forbidden");
ok(!assertReadOnlySql("LISTEN my_channel").ok, "LISTEN forbidden");
ok(!assertReadOnlySql("NOTIFY my_channel, 'payload'").ok, "NOTIFY forbidden");
ok(!assertReadOnlySql("UNLISTEN *").ok, "UNLISTEN forbidden");
ok(!assertReadOnlySql("REFRESH MATERIALIZED VIEW my_view").ok, "REFRESH forbidden");

// SELECT INTO
ok(!assertReadOnlySql("SELECT * INTO new_table FROM Candle").ok, "SELECT INTO forbidden");
ok(!assertReadOnlySql("SELECT * INTO TEMPORARY TABLE tmp FROM Candle").ok, "SELECT INTO TEMP forbidden");
ok(!assertReadOnlySql("select * into new_table from Candle").ok, "lowercase SELECT INTO forbidden");

// FOR UPDATE/SHARE
ok(!assertReadOnlySql("SELECT * FROM Candle FOR UPDATE").ok, "FOR UPDATE forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle FOR SHARE").ok, "FOR SHARE forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle FOR NO KEY UPDATE").ok, "FOR NO KEY UPDATE forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle FOR KEY SHARE").ok, "FOR KEY SHARE forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle\nFOR UPDATE").ok, "FOR UPDATE with newline forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle FOR\nUPDATE").ok, "FOR newline UPDATE forbidden");

// Writable CTE
ok(!assertReadOnlySql("WITH x AS (UPDATE Candle SET close=1 RETURNING *) SELECT * FROM x").ok, "writable CTE UPDATE forbidden");
ok(!assertReadOnlySql("WITH x AS (INSERT INTO Candle VALUES (1) RETURNING *) SELECT * FROM x").ok, "writable CTE INSERT forbidden");
ok(!assertReadOnlySql("WITH x AS (DELETE FROM Candle RETURNING *) SELECT * FROM x").ok, "writable CTE DELETE forbidden");

// Multi-statement
ok(!assertReadOnlySql("SELECT * FROM Candle; DROP TABLE Candle").ok, "multi-statement DROP forbidden");
ok(!assertReadOnlySql("SELECT 1; SELECT 2").ok, "multi-statement two SELECTs forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle; INSERT INTO Candle VALUES (1)").ok, "multi-statement INSERT forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle; -- comment").ok, "multi-statement with comment forbidden? Actually single ; + comment? Should be 1? But we treat as 2 if second non-empty after trim? '-- comment' is non-empty, so forbidden — good");
ok(assertReadOnlySql("SELECT * FROM Candle;").ok, "single trailing semicolon allowed");

// Comments hiding write keywords — should still be rejected (fail-closed)
ok(!assertReadOnlySql("/* INSERT */ SELECT * FROM Candle").ok, "comment at start with INSERT fails allowlist (fail-closed)");
ok(!assertReadOnlySql("SELECT * FROM Candle /* UPDATE */").ok, "SELECT with comment containing UPDATE forbidden (fail-closed)");
ok(!assertReadOnlySql("SELECT * FROM Candle -- INSERT").ok, "SELECT with line comment containing INSERT forbidden");

// Mixed case
ok(!assertReadOnlySql("SeLeCt * FrOm Candle FoR UpDaTe").ok, "mixed case FOR UPDATE forbidden");
ok(!assertReadOnlySql("iNsErT iNtO Candle VALUES (1)").ok, "mixed case INSERT forbidden");

// Dollar-quoted
ok(!assertReadOnlySql("SELECT $$INSERT$$").ok, "dollar-quoted INSERT forbidden");
ok(!assertReadOnlySql("SELECT $tag$UPDATE$tag$").ok, "dollar-tagged UPDATE forbidden");
ok(!assertReadOnlySql("SELECT * FROM Candle WHERE x = $$DELETE$$").ok, "dollar-quoted DELETE in WHERE forbidden");

// Side-effecting functions
ok(!assertReadOnlySql("SELECT pg_advisory_lock(1)").ok, "pg_advisory_lock forbidden");
ok(!assertReadOnlySql("SELECT pg_try_advisory_lock(1)").ok, "pg_try_advisory_lock forbidden");
ok(!assertReadOnlySql("SELECT pg_sleep(1)").ok, "pg_sleep forbidden");
ok(!assertReadOnlySql("SELECT pg_notify('chan','payload')").ok, "pg_notify forbidden");
ok(!assertReadOnlySql("SELECT pg_cancel_backend(123)").ok, "pg_cancel_backend forbidden");
ok(!assertReadOnlySql("SELECT pg_terminate_backend(123)").ok, "pg_terminate_backend forbidden");
ok(!assertReadOnlySql("SELECT nextval('seq')").ok, "nextval forbidden");
ok(!assertReadOnlySql("SELECT setval('seq',1)").ok, "setval forbidden");
ok(!assertReadOnlySql("SELECT currval('seq')").ok, "currval forbidden");
ok(!assertReadOnlySql("SELECT lastval()").ok, "lastval forbidden");
ok(!assertReadOnlySql("SELECT pg_reload_conf()").ok, "pg_reload_conf forbidden");
ok(!assertReadOnlySql("SELECT pg_custom_func()").ok, "generic pg_*() forbidden");

// Prisma methods
ok(assertReadOnlyPrismaMethod("findMany").ok, "Prisma findMany allowed");
ok(assertReadOnlyPrismaMethod("findUnique").ok, "Prisma findUnique allowed");
ok(assertReadOnlyPrismaMethod("count").ok, "Prisma count allowed");
ok(!assertReadOnlyPrismaMethod("create").ok, "Prisma create forbidden");
ok(!assertReadOnlyPrismaMethod("update").ok, "Prisma update forbidden");
ok(!assertReadOnlyPrismaMethod("upsert").ok, "Prisma upsert forbidden");
ok(!assertReadOnlyPrismaMethod("delete").ok, "Prisma delete forbidden");
ok(!assertReadOnlyPrismaMethod("$executeRaw").ok, "Prisma $executeRaw forbidden");
ok(!assertReadOnlyPrismaMethod("$executeRawUnsafe").ok, "Prisma $executeRawUnsafe forbidden");
ok(!assertReadOnlyPrismaMethod("$queryRawUnsafe").ok, "Prisma $queryRawUnsafe forbidden");
ok(!assertReadOnlyPrismaMethod("$queryRaw").ok, "Prisma $queryRaw forbidden");
ok(!assertReadOnlyPrismaMethod("$transaction").ok, "Prisma $transaction forbidden (use readOnly wrapper)");

// Doc guarantee
ok(READ_ONLY_SQL_ALLOWLIST_DOC.forbiddenTokens.includes("SELECT INTO"), "doc mentions SELECT INTO");
ok(READ_ONLY_SQL_ALLOWLIST_DOC.forbiddenTokens.includes("SELECT ... FOR UPDATE"), "doc mentions FOR UPDATE");
ok(READ_ONLY_SQL_ALLOWLIST_DOC.forbiddenTokens.includes("pg_advisory_*"), "doc mentions advisory");
ok(READ_ONLY_SQL_ALLOWLIST_DOC.allowedPrismaMethods.includes("findMany"), "doc allowed findMany");

console.log(`\nPassed ${passed}/${passed + failed}`);
if (failed > 0) {
  console.error(`Failed ${failed}`);
  process.exit(1);
}
console.log("All read-only SQL hardening checks passed — allowlist + denylist robust");
