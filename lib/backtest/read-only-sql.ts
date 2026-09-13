/**
 * P2-B+ — Read-only SQL safety allowlist — HARDENED — STATIC DEFENSE ONLY.
 *
 * SCOPE DOCUMENTATION (factual, per audit):
 * - This module is STATIC DEFENSIVE SQL INSPECTION ONLY — it is NOT PostgreSQL semantic proof,
 *   NOT DB enforcement, NOT runtime guard unless actually wired into CLI/transaction.
 * - CLI truthfully does NOT execute SET TRANSACTION READ ONLY — buildReadOnlyTransactionSql() returns string but is NOT executed;
 *   read-only guarantee comes from capability-restricted Prisma surface (findUnique/findMany/candle.findMany/$disconnect), not from DB transaction enforcement.
 * - No need to add raw SQL to CLI just to use scanner — scanner is for tests/static audit, not for runtime.
 *
 * Goal: statically auditable guarantee that real DB layer executes only SELECT, no side-effects.
 *
 * Principle: positive allowlist over fragile denylist where practical:
 * - Must start with SELECT or WITH (CTE that ends with SELECT) — allowlist
 * - Single statement only (no ; second statement) — fail-closed
 * - Any forbidden write/lock/side-effect token — fail-closed
 * - Prisma API guard: only findMany/findUnique/findFirst/count/aggregate/groupBy
 *
 * This module is pure, no Prisma/DB, no env, no Date.now(), no new Date().
 * Used as static check + test defense, described accurately — NOT claimed as runtime DB guard unless wired.
 *
 * Guarantee (static inspection):
 * - Rejects: INSERT, UPDATE, DELETE, MERGE, UPSERT, REPLACE, CREATE, ALTER, DROP, TRUNCATE,
 *   REINDEX, VACUUM, ANALYZE, CLUSTER, COPY, LOAD, LOCK, GRANT, REVOKE, SECURITY, COMMENT, OWNER, TABLESPACE,
 *   CALL, DO, PERFORM, EXECUTE, EXEC, LISTEN, NOTIFY, UNLISTEN, REFRESH,
 *   SELECT ... FOR UPDATE/SHARE/NO KEY UPDATE/KEY SHARE, SELECT ... INTO,
 *   writable CTE WITH x AS (UPDATE/INSERT/DELETE/MERGE...),
 *   multi-statement payloads ( ; ),
 *   side-effecting functions: pg_advisory_*, pg_try_advisory_*, pg_sleep, pg_notify, nextval/setval/currval/lastval,
 *   pg_cancel_backend, pg_terminate_backend, pg_reload_conf, etc. via pg_*() pattern,
 *   $executeRaw, $queryRawUnsafe, etc.
 * - Allows: SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT ... OFFSET, WITH ... SELECT
 *
 * Limitations (documented exactly):
 * - Syntactic guard, not full SQL parser, not PostgreSQL semantic proof, not DB enforcement.
 * - Dollar-quoted $$...$$ and single-quoted '...' containing forbidden keywords are still rejected (fail-closed) — intentional.
 * - Comments containing INSERT are also rejected if they contain forbidden tokens or cause allowlist miss (fail-closed).
 * - SELECT INTO is rejected because it creates table in Postgres.
 * - FOR UPDATE/SHARE detection uses robust regex with \\s+ and case-insensitive, handles newlines via [\\s\\S]*? where needed.
 * - Does NOT attempt to detect all possible side-effects (e.g., custom functions), but forbids known pg_* patterns.
 * - Multi-statement detection via split ; outside of empty — heuristic, fail-closed.
 * - Runtime enforcement only if actually wired — currently NOT wired in CLI, CLI relies on capability-restricted surface instead.
 *
 * Also checks Prisma API: forbids create/update/upsert/delete, createMany/updateMany/deleteMany/$executeRaw and $queryRaw variants.
 */

const FORBIDDEN_SQL_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bINSERT\b/i, label: "INSERT" },
  { re: /\bUPDATE\b/i, label: "UPDATE" },
  { re: /\bDELETE\b/i, label: "DELETE" },
  { re: /\bMERGE\b/i, label: "MERGE" },
  { re: /\bUPSERT\b/i, label: "UPSERT" },
  { re: /\bREPLACE\b/i, label: "REPLACE" },
  { re: /\bCREATE\b/i, label: "CREATE" },
  { re: /\bALTER\b/i, label: "ALTER" },
  { re: /\bDROP\b/i, label: "DROP" },
  { re: /\bTRUNCATE\b/i, label: "TRUNCATE" },
  { re: /\bREINDEX\b/i, label: "REINDEX" },
  { re: /\bVACUUM\b/i, label: "VACUUM" },
  { re: /\bANALYZE\b/i, label: "ANALYZE" },
  { re: /\bCLUSTER\b/i, label: "CLUSTER" },
  { re: /\bCOPY\b/i, label: "COPY" },
  { re: /\bLOAD\b/i, label: "LOAD" },
  { re: /\bLOCK\b/i, label: "LOCK" },
  { re: /\bGRANT\b/i, label: "GRANT" },
  { re: /\bREVOKE\b/i, label: "REVOKE" },
  { re: /\bSECURITY\b/i, label: "SECURITY" },
  { re: /\bCOMMENT\b/i, label: "COMMENT" },
  { re: /\bTABLESPACE\b/i, label: "TABLESPACE" },
  { re: /\bOWNER\b/i, label: "OWNER" },
  { re: /\bCALL\b/i, label: "CALL" },
  { re: /\bDO\b/i, label: "\\bDO\\b (PL/pgSQL)" },
  { re: /\bPERFORM\b/i, label: "PERFORM" },
  { re: /\bEXECUTE\b/i, label: "EXECUTE" },
  { re: /\bLISTEN\b/i, label: "LISTEN" },
  { re: /\bNOTIFY\b/i, label: "NOTIFY" },
  { re: /\bUNLISTEN\b/i, label: "UNLISTEN" },
  { re: /\bREFRESH\b/i, label: "REFRESH MATERIALIZED" },
  // SELECT INTO creates table in Postgres — forbid
  { re: /\bSELECT\b[\s\S]*?\bINTO\b/i, label: "SELECT INTO" },
  // SELECT FOR UPDATE/SHARE/NO KEY UPDATE/KEY SHARE — robust, handles newlines
  { re: /\bFOR\b\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE)\b/i, label: "FOR UPDATE/SHARE" },
  { re: /\bFOR\b\s+KEY\s+SHARE\b/i, label: "FOR KEY SHARE" },
  // Side-effecting pg_ functions
  { re: /\bpg_advisory_/i, label: "pg_advisory_*" },
  { re: /\bpg_try_advisory_/i, label: "pg_try_advisory_*" },
  { re: /\bpg_sleep\s*\(/i, label: "pg_sleep()" },
  { re: /\bpg_notify\s*\(/i, label: "pg_notify()" },
  { re: /\bpg_cancel_backend\s*\(/i, label: "pg_cancel_backend()" },
  { re: /\bpg_terminate_backend\s*\(/i, label: "pg_terminate_backend()" },
  { re: /\bpg_reload_conf\s*\(/i, label: "pg_reload_conf()" },
  { re: /\bnextval\s*\(/i, label: "nextval()" },
  { re: /\bsetval\s*\(/i, label: "setval()" },
  { re: /\bcurrval\s*\(/i, label: "currval()" },
  { re: /\blastval\s*\(/i, label: "lastval()" },
  // Generic pg_ function call — catch-all for side-effecting pg_*
  { re: /\bpg_\w+\s*\(/i, label: "pg_*() side-effecting" },
];

const FORBIDDEN_PRISMA_METHODS = [
  "create",
  "createMany",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
  "$executeRaw",
  "$executeRawUnsafe",
  "$queryRawUnsafe",
  "$queryRaw",
  "$transaction",
] as const;

export type ReadOnlySqlCheckResult = {
  readonly ok: boolean;
  readonly errors: readonly string[];
};

function stripDollarQuotedForSemicolonCheck(sql: string): string {
  return sql.replace(/\$[A-Za-z_]*\$[\s\S]*?\$[A-Za-z_]*\$/g, (m) => " ".repeat(m.length));
}

export function assertReadOnlySql(sql: string): ReadOnlySqlCheckResult {
  const errors: string[] = [];

  if (typeof sql !== "string") {
    return { ok: false, errors: ["SQL must be string"] };
  }

  const trimmed = sql.trim();

  if (trimmed.length === 0) {
    return { ok: false, errors: ["SQL empty"] };
  }

  const upper = trimmed.toUpperCase();
  const startsAllowed = upper.startsWith("SELECT") || upper.startsWith("WITH");
  if (!startsAllowed) {
    errors.push(`SQL must start with SELECT or WITH (read-only), got: ${trimmed.slice(0, 40)}`);
  }

  for (const { re, label } of FORBIDDEN_SQL_PATTERNS) {
    if (re.test(trimmed)) {
      errors.push(`SQL contains forbidden token ${label}: matched ${re.source}`);
    }
  }

  const withoutDollar = stripDollarQuotedForSemicolonCheck(trimmed);
  const statements = withoutDollar
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (statements.length > 1) {
    errors.push(`Multiple SQL statements not allowed in read-only context (found ${statements.length})`);
  }

  return { ok: errors.length === 0, errors: Object.freeze(errors) };
}

export function assertReadOnlyPrismaMethod(methodName: string): ReadOnlySqlCheckResult {
  const errors: string[] = [];
  if ((FORBIDDEN_PRISMA_METHODS as readonly string[]).includes(methodName)) {
    errors.push(`Prisma method ${methodName} is forbidden in read-only data plane`);
  }
  const allowed = new Set(["findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy"]);
  if (!allowed.has(methodName)) {
    if (!(FORBIDDEN_PRISMA_METHODS as readonly string[]).includes(methodName)) {
      errors.push(`Prisma method ${methodName} not in read-only allowlist (allowed: ${Array.from(allowed).join(", ")})`);
    }
  }
  return { ok: errors.length === 0, errors: Object.freeze(errors) };
}

/**
 * Defensive read-only transaction wrapper check — returns SQL string but NOT executed in CLI.
 * CLI relies on capability-restricted Prisma surface, not on SET TRANSACTION READ ONLY.
 */
export function buildReadOnlyTransactionSql(): string {
  return "SET TRANSACTION READ ONLY";
}

export const READ_ONLY_SQL_ALLOWLIST_DOC = Object.freeze({
  scope: "STATIC DEFENSIVE SQL INSPECTION ONLY — NOT PostgreSQL semantic proof, NOT DB enforcement, NOT runtime guard unless actually wired. CLI does NOT execute SET TRANSACTION READ ONLY; read-only via capability-restricted surface.",
  guarantee:
    "Positive allowlist: must start with SELECT/WITH, single statement, no forbidden write/lock/side-effect tokens. Fail-closed on comments/dollar-quoted hiding.",
  allowedStart: ["SELECT", "WITH"],
  forbiddenTokens: [
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "UPSERT",
    "REPLACE",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "REINDEX",
    "VACUUM",
    "ANALYZE",
    "CLUSTER",
    "COPY",
    "LOAD",
    "LOCK",
    "GRANT",
    "REVOKE",
    "SECURITY",
    "COMMENT",
    "TABLESPACE",
    "OWNER",
    "CALL",
    "DO",
    "PERFORM",
    "EXECUTE",
    "LISTEN",
    "NOTIFY",
    "UNLISTEN",
    "REFRESH",
    "SELECT INTO",
    "SELECT ... FOR UPDATE",
    "SELECT ... FOR SHARE",
    "SELECT ... FOR NO KEY UPDATE",
    "SELECT ... FOR KEY SHARE",
    "WITH ... UPDATE/INSERT/DELETE (writable CTE)",
    "pg_advisory_*",
    "pg_try_advisory_*",
    "pg_sleep()",
    "pg_notify()",
    "pg_cancel_backend()",
    "pg_terminate_backend()",
    "nextval()/setval()/currval()/lastval()",
    "pg_*() generic",
    "multi-statement ;",
  ],
  allowedPrismaMethods: ["findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy"],
  forbiddenPrismaMethods: [...FORBIDDEN_PRISMA_METHODS],
  limitations:
    "Syntactic guard, not full parser, not PostgreSQL semantic proof, not DB enforcement. Dollar-quoted and comments containing forbidden keywords are rejected fail-closed. Does not detect custom side-effecting functions, but forbids known pg_* patterns. Runtime enforcement only if actually wired — currently NOT wired in CLI.",
});
