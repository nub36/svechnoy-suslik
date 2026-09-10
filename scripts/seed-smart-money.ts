/**
 * Safe idempotent seed/registration for Smart Money Strategy.
 *
 * DEFAULT DRY-RUN — NO DB WRITE.
 * Write requires: --apply + three explicit operator params.
 *
 * Usage:
 *   npx tsx scripts/seed-smart-money.ts
 *   npx tsx scripts/seed-smart-money.ts --dry-run
 *   npx tsx scripts/seed-smart-money.ts --dry-run --min-exchanges 2 --minimum-quote-volume-24h 500000 --top100-only true
 *   npx tsx scripts/seed-smart-money.ts --apply --min-exchanges 2 --minimum-quote-volume-24h 500000 --top100-only true
 *
 * DO NOT execute apply without operator explicit values.
 * No Signal writes. No deletes. Only upsert slug+version.
 */

import { PrismaClient } from "@prisma/client";
import { validateSmartMoneyRuntime } from "../lib/strategies/smart-money";
import {
  parseSeedSmartMoneyArgs,
  isDryRunMode,
  validateForApply,
  buildSeedPayload,
  CANONICAL_SMC_CONFIG,
  SMART_MONEY_SLUG,
  SMART_MONEY_NAME,
  SMART_MONEY_VERSION,
  SMART_MONEY_TIMEFRAMES,
  SMART_MONEY_ENABLED,
  SMART_MONEY_STATUS,
  CANONICAL_DESCRIPTION,
  buildCanonicalConfig,
  canonicalWeightsSum,
} from "./seed-smart-money-args";

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseSeedSmartMoneyArgs(argv);

  if (parsed.help) {
    printHelp();
    process.exit(0);
  }

  const dryRun = isDryRunMode(parsed);
  const applyErrorEarly = parsed.apply ? validateForApply(parsed) : null;

  // Build payload for display (dry-run may have UNAPPROVED placeholders)
  const payloadRes = buildSeedPayload(parsed);

  // Header
  console.log("=== Smart Money seed — SAFE MODE ===");
  console.log(`Режим: ${dryRun ? "DRY-RUN (только чтение, без записи)" : "APPLY (запись в БД)"}`);
  console.log(`Slug: ${SMART_MONEY_SLUG}  Version: ${SMART_MONEY_VERSION}  Timeframes: ${JSON.stringify([...SMART_MONEY_TIMEFRAMES])}`);
  console.log(`Enabled: ${SMART_MONEY_ENABLED}  Status: ${SMART_MONEY_STATUS}  Canonical weights sum: ${canonicalWeightsSum()}`);
  console.log("");

  if (!payloadRes.ok) {
    console.error("✗ Параметры некорректны:");
    for (const e of payloadRes.errors) console.error(`  - ${e}`);
    if (!dryRun) {
      console.error("\nAPPLY прерван до записи в БД.");
    } else {
      console.error("\nDry-run: исправьте параметры и повторите.");
      console.error("Для dry-run с точным payload укажите те же три параметра что и для --apply.");
    }
    printHelpHint();
    process.exit(1);
  }

  if (applyErrorEarly) {
    // Should have been caught above, but safety
    console.error(`✗ ${applyErrorEarly}`);
    process.exit(1);
  }

  const payload = payloadRes.payload;
  const warnings = (payloadRes as { warnings: string[] }).warnings || [];

  if (warnings.length > 0) {
    console.log("⚠  Внимание: часть значений UNAPPROVED (требуют явного выбора оператора для --apply):");
    for (const w of warnings) console.log(`  - ${w}`);
    console.log("");
    console.log("Для --apply необходимо явно указать все три:");
    console.log("  --min-exchanges 1..5");
    console.log("  --minimum-quote-volume-24h >=0");
    console.log("  --top100-only true|false");
    console.log("");
  }

  // If values are fully numeric/boolean, validate via existing runtime validation (canonical + operator)
  let runtimeValid = false;
  if (
    typeof payload.minExchanges === "number" &&
    typeof (payload.config as any).filters.minimumQuoteVolume24h === "number" &&
    typeof (payload.config as any).filters.top500Only === "boolean"
  ) {
    const runtime = validateSmartMoneyRuntime({
      config: payload.config,
      timeframes: payload.timeframes,
      minExchanges: payload.minExchanges,
    });
    if (!runtime.ok) {
      console.error("✗ validateSmartMoneyRuntime не прошла:");
      for (const e of runtime.errors) console.error(`  - ${e}`);
      console.error("\nPayload, прошедшая проверку перед записью:");
      console.log(JSON.stringify(payload, null, 2));
      process.exit(1);
    }
    runtimeValid = true;
    console.log("✓ validateSmartMoneyRuntime с timeframes=[\"1h\"] — OK");
    console.log("");
  } else if (!dryRun) {
    // Apply must have numeric values; already validated, but safety
    console.error("✗ APPLY требует числовые operator-параметры (не UNAPPROVED)");
    process.exit(1);
  }

  console.log("Точный intended Strategy payload (JSON):");
  console.log(JSON.stringify(payload, null, 2));
  console.log("");

  // DB read-only probe to say CREATE vs UPDATE (only if DATABASE_URL present, else skip gracefully for self-test)
  let dbState: "CREATE" | "UPDATE" | "UNKNOWN" | "SKIP_NO_DB" = "UNKNOWN";
  let existing: unknown = null;
  let prisma: PrismaClient | null = null;

  const hasDbUrl = !!process.env.DATABASE_URL;

  if (!hasDbUrl) {
    dbState = "SKIP_NO_DB";
    console.log("ℹ  DATABASE_URL не задан — пропуск DB-проверки (dry-run без БД).");
    console.log("   При наличии БД dry-run показал бы: CREATE would happen или UPDATE would happen.");
    console.log("");
  } else {
    prisma = new PrismaClient();
    try {
      const row = await prisma.strategy.findFirst({
        where: { slug: SMART_MONEY_SLUG, version: SMART_MONEY_VERSION },
      });
      existing = row;
      if (!row) {
        dbState = "CREATE";
        console.log("DB состояние: CREATE would happen (строка отсутствует, будет создана новая).");
      } else {
        dbState = "UPDATE";
        console.log("DB состояние: UPDATE would happen (строка уже существует, будет идемпотентный upsert).");
        console.log("Существующая строка (сокращённо):");
        console.log(
          JSON.stringify(
            {
              id: (row as any).id,
              slug: (row as any).slug,
              version: (row as any).version,
              enabled: (row as any).enabled,
              status: (row as any).status,
              timeframes: (row as any).timeframes,
              minExchanges: (row as any).minExchanges,
              config: (row as any).config,
            },
            null,
            2
          )
        );
        // Check unexpected mismatches
        const mismatches: string[] = [];
        if ((row as any).slug !== SMART_MONEY_SLUG)
          mismatches.push(`slug mismatch: expected ${SMART_MONEY_SLUG} got ${(row as any).slug}`);
        if ((row as any).version !== SMART_MONEY_VERSION)
          mismatches.push(`version mismatch: expected ${SMART_MONEY_VERSION} got ${(row as any).version}`);
        // Report clearly if unexpected row has different enabled/status/timeframes
        if ((row as any).enabled !== false) {
          console.log(
            `⚠  Существующая строка has enabled=${(row as any).enabled} — seed оставит enabled=false (cannot enable).`
          );
        }
        if ((row as any).status !== "DRAFT") {
          console.log(
            `⚠  Существующая строка has status=${(row as any).status} — seed оставит status=DRAFT.`
          );
        }
        if (JSON.stringify((row as any).timeframes) !== JSON.stringify([...SMART_MONEY_TIMEFRAMES])) {
          console.log(
            `⚠  Существующая строка has timeframes=${JSON.stringify((row as any).timeframes)} — seed приведёт к ["1h"].`
          );
        }
        if (mismatches.length > 0) {
          console.log("⚠  Unexpected existing row (identity mismatch):");
          for (const m of mismatches) console.log(`  - ${m}`);
        }
      }
      console.log("");
    } catch (e) {
      // DB read error — dry-run should not fail hard, just report
      console.log(`ℹ  Не удалось прочитать DB для dry-run (ошибка: ${e instanceof Error ? e.message : String(e)})`);
      console.log("   Payload выше остаётся корректным; DB-действие неизвестно до наличия соединения.");
      dbState = "UNKNOWN";
      console.log("");
    } finally {
      if (dryRun) {
        // In dry-run we must NOT keep connection that implies write; just disconnect
        try {
          await prisma?.$disconnect();
        } catch {}
      }
    }
  }

  if (dryRun) {
    console.log("=== DRY-RUN завершён ===");
    console.log("Никаких записей в БД не произведено. Для реальной записи используйте:");
    console.log(
      "  npx tsx scripts/seed-smart-money.ts --apply --min-exchanges N --minimum-quote-volume-24h N --top100-only true|false"
    );
    if (warnings.length > 0) {
      console.log("\nСейчас payload содержит UNAPPROVED — укажите три параметра чтобы увидеть точный applied payload.");
    }
    // Ensure we disconnected and exit 0
    if (prisma && hasDbUrl) {
      try { await prisma.$disconnect(); } catch {}
    }
    process.exit(0);
  }

  // === APPLY PATH — at this point dryRun is false, so --apply present ===
  // Final guards before write
  const finalApplyError = validateForApply(parsed);
  if (finalApplyError) {
    console.error(`✗ APPLY guard: ${finalApplyError}`);
    process.exit(1);
  }
  if (!runtimeValid) {
    console.error("✗ APPLY guard: runtime validation not passed — прерывание до записи");
    process.exit(1);
  }
  if (typeof payload.minExchanges !== "number" || typeof (payload.config as any).filters.minimumQuoteVolume24h !== "number" || typeof (payload.config as any).filters.top500Only !== "boolean") {
    console.error("✗ APPLY guard: operator params must be concrete values, not UNAPPROVED");
    process.exit(1);
  }

  // Prominent warning before mutation
  console.log("");
  console.log("╔════════════════════════════════════════════════════════════════╗");
  console.log("║  ⚠  Это изменит общую production PostgreSQL Strategy row.     ║");
  console.log("║  Slug: smart-money-suslik v1  —  enabled=false  DRAFT  1h   ║");
  console.log("╚════════════════════════════════════════════════════════════════╝");
  console.log("");

  // Ensure prisma exists (hasDbUrl already checked, but we re-init if needed)
  if (!prisma) prisma = new PrismaClient();

  try {
    // Idempotent upsert by slug+version
    const existingRow = await prisma.strategy.findFirst({
      where: { slug: SMART_MONEY_SLUG, version: SMART_MONEY_VERSION },
    });

    if (existingRow) {
      const updated = await prisma.strategy.update({
        where: { id: (existingRow as any).id },
        data: {
          name: SMART_MONEY_NAME,
          description: CANONICAL_DESCRIPTION,
          enabled: SMART_MONEY_ENABLED, // must remain false
          status: SMART_MONEY_STATUS, // must remain DRAFT
          config: payload.config as any,
          timeframes: payload.timeframes as any,
          minExchanges: payload.minExchanges as any,
        },
      });
      console.log(`✓ Smart Money Strategy обновлена (id=${(updated as any).id}) — idempotent UPDATE`);
      console.log(JSON.stringify({ slug: (updated as any).slug, version: (updated as any).version, enabled: (updated as any).enabled, status: (updated as any).status, timeframes: (updated as any).timeframes, minExchanges: (updated as any).minExchanges }, null, 2));
    } else {
      const created = await prisma.strategy.create({
        data: {
          name: SMART_MONEY_NAME,
          slug: SMART_MONEY_SLUG,
          description: CANONICAL_DESCRIPTION,
          version: SMART_MONEY_VERSION,
          enabled: SMART_MONEY_ENABLED,
          status: SMART_MONEY_STATUS,
          config: payload.config as any,
          timeframes: payload.timeframes as any,
          minExchanges: payload.minExchanges as any,
        },
      });
      console.log(`✓ Smart Money Strategy создана (id=${(created as any).id}) — CREATE`);
      console.log(JSON.stringify({ slug: (created as any).slug, version: (created as any).version, enabled: (created as any).enabled, status: (created as any).status, timeframes: (created as any).timeframes, minExchanges: (created as any).minExchanges }, null, 2));
    }
    console.log("");
    console.log("✓ Seed APPLY завершён. enabled=false, status=DRAFT, timeframes=[\"1h\"], canonical config сохранён.");
  } catch (e) {
    console.error("✗ Ошибка записи в БД:", e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

function printHelp() {
  console.log(`
Smart Money seed — безопасная регистрация Strategy (Phase 3C).

Сухой прогон по умолчанию (БЕЗ записи):
  npx tsx scripts/seed-smart-money.ts
  npx tsx scripts/seed-smart-money.ts --dry-run
  npx tsx scripts/seed-smart-money.ts --dry-run --min-exchanges 2 --minimum-quote-volume-24h 500000 --top100-only true

Реальная запись (требует явных операторских параметров):
  npx tsx scripts/seed-smart-money.ts --apply --min-exchanges N --minimum-quote-volume-24h N --top100-only true|false

Операторские параметры (обязательны для --apply):
  --min-exchanges 1..5
  --minimum-quote-volume-24h >=0   (число, 0 = без фильтра)
  --top100-only true|false         (true = только Top-100 universe rank 1..100, ключ в JSON top500Only для совместимости)

Каноничные SMC defaults (не меняются):
  minimumSignalScore 72, swingLeft 20, swingRight 20, internalLeft 3, internalRight 3, atrPeriod 14,
  structureEventFreshBars 10, sweepFreshBars 5, orderBlockFreshBars 20, fvgFreshBars 20, eqBand 0.02,
  weights 20/15/10/10/15/5/10/10/5 (сумма 100)

Идентичность: slug=smart-money-suslik  version=1  enabled=false  status=DRAFT  timeframes=["1h"]
Валидация перед записью: validateSmartMoneyRuntime с ["1h"] и выбранным minExchanges.

Предупреждение перед записью: "Это изменит общую production PostgreSQL Strategy row."

Флаги:
  --apply                         выполнить запись (требует три операторских параметра)
  --dry-run                       явный dry-run (по умолчанию)
  --min-exchanges N
  --minimum-quote-volume-24h N
  --top100-only true|false        (алиас --top500-only)
  --help, -h
`);
}

function printHelpHint() {
  console.log("\nСправка: npx tsx scripts/seed-smart-money.ts --help");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
