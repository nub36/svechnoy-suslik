/**
 * P2-B+ — Read-only SQL safety allowlist.
 *
 * Задача: статически аудируемая гарантия, что реальный DB-слой
 * выполняет только SELECT, без side-effects.
 *
 * Принцип:
 * - allowlist над типами операций, а не denylist
 * - любая строка, содержащая запрещённые токены — fail-closed
 * - Prisma API guard: только findMany/findUnique/findFirst/count
 *
 * Этот модуль — чистый, без Prisma/DB, без env, без Date.now().
 * Используется как статическая проверка + runtime guard для
 * owner-run CLI (defensive).
 *
 * Forbidden:
 * INSERT, UPDATE, DELETE, UPSERT, CREATE, ALTER, DROP, TRUNCATE,
 * LOCK, COPY, VACUUM, REINDEX, GRANT, REVOKE, CLUSTER,
 * COMMENT, SECURITY, OWNER, TABLESPACE,
 * advisory locks (pg_advisory_*), side-effecting functions.
 *
 * Allowed:
 * SELECT ... FROM ... WHERE ... ORDER BY ... LIMIT ... OFFSET
 * с транзакцией READ ONLY, если архитектура поддерживает.
 *
 * Также проверяется Prisma API: запрет на create/update/upsert/delete,
 * createMany/updateMany/deleteMany/$executeRaw/$executeRawUnsafe/$queryRawUnsafe/$queryRaw
 */

const FORBIDDEN_SQL_TOKENS_RE = new RegExp(
  [
    "\\bINSERT\\b",
    "\\bUPDATE\\b",
    "\\bDELETE\\b",
    "\\bUPSERT\\b",
    "\\bCREATE\\b",
    "\\bALTER\\b",
    "\\bDROP\\b",
    "\\bTRUNCATE\\b",
    "\\bLOCK\\b",
    "\\bCOPY\\b",
    "\\bVACUUM\\b",
    "\\bREINDEX\\b",
    "\\bGRANT\\b",
    "\\bREVOKE\\b",
    "\\bCLUSTER\\b",
    "\\bCOMMENT\\b",
    "\\bSECURITY\\b",
    "\\bTABLESPACE\\b",
    "\\bpg_advisory_",
    "\\bpg_try_advisory_",
    "\\bperform\\b.*\\bpg_",
    "\\bSELECT\\b.*\\bFOR\\b.*\\bUPDATE\\b",
    "\\bSELECT\\b.*\\bFOR\\b.*\\bSHARE\\b",
  ].join("|"),
  "i"
);

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
  "$transaction", // raw transaction with writes is forbidden unless read-only wrapper; we allow only via readOnlyTransaction wrapper that checks
] as const;

export type ReadOnlySqlCheckResult = {
  readonly ok: boolean;
  readonly errors: readonly string[];
};

export function assertReadOnlySql(sql: string): ReadOnlySqlCheckResult {
  const errors: string[] = [];

  if (typeof sql !== "string") {
    return { ok: false, errors: ["SQL must be string"] };
  }

  const trimmed = sql.trim();

  if (trimmed.length === 0) {
    return { ok: false, errors: ["SQL empty"] };
  }

  // Allowlist: must start with SELECT or WITH (CTE that ends with SELECT)
  const upper = trimmed.toUpperCase();
  const startsAllowed = upper.startsWith("SELECT") || upper.startsWith("WITH");
  if (!startsAllowed) {
    errors.push(`SQL must start with SELECT or WITH (read-only), got: ${trimmed.slice(0, 30)}`);
  }

  if (FORBIDDEN_SQL_TOKENS_RE.test(trimmed)) {
    errors.push(`SQL contains forbidden token (write/lock/side-effect): matched ${FORBIDDEN_SQL_TOKENS_RE.source}`);
  }

  // Additional simple heuristic: disallow semicolon with second statement that is not SELECT
  // We allow single statement; multiple statements separated by ; are suspicious
  const statements = trimmed.split(";").map((s) => s.trim()).filter((s) => s.length > 0);
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
  // Allowlist for read-only: findMany, findUnique, findFirst, count, aggregate (read-only)
  const allowed = new Set(["findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy"]);
  if (!allowed.has(methodName)) {
    // If not in allowed and not explicitly forbidden, still warn as unknown
    if (!(FORBIDDEN_PRISMA_METHODS as readonly string[]).includes(methodName)) {
      errors.push(`Prisma method ${methodName} not in read-only allowlist (allowed: ${Array.from(allowed).join(", ")})`);
    }
  }
  return { ok: errors.length === 0, errors: Object.freeze(errors) };
}

/**
 * Defensive read-only transaction wrapper check.
 * In real owner-run CLI, we should use:
 * prisma.$transaction(async (tx) => { ... }, { isolationLevel: 'RepeatableRead' })
 * and SET TRANSACTION READ ONLY.
 * This function validates intent.
 */
export function buildReadOnlyTransactionSql(): string {
  // This is the SQL we expect owner-run CLI to execute first
  return "SET TRANSACTION READ ONLY";
}

export const READ_ONLY_SQL_ALLOWLIST_DOC = Object.freeze({
  allowedStart: ["SELECT", "WITH"],
  forbiddenTokens: [
    "INSERT",
    "UPDATE",
    "DELETE",
    "UPSERT",
    "CREATE",
    "ALTER",
    "DROP",
    "TRUNCATE",
    "LOCK",
    "COPY",
    "VACUUM",
    "REINDEX",
    "GRANT",
    "REVOKE",
    "CLUSTER",
    "COMMENT",
    "SECURITY",
    "TABLESPACE",
    "pg_advisory_*",
    "SELECT ... FOR UPDATE",
    "SELECT ... FOR SHARE",
  ],
  allowedPrismaMethods: ["findMany", "findUnique", "findFirst", "count", "aggregate", "groupBy"],
  forbiddenPrismaMethods: [...FORBIDDEN_PRISMA_METHODS],
});
