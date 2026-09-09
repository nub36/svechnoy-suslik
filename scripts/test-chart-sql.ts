/**
 * Статическая проверка raw-SQL в UI/chart против prisma/schema.prisma.
 *
 * Ловит класс ошибок, который нельзя увидеть без реальной базы
 * (в песочнице PostgreSQL нет, и 503 от отсутствия БД маскирует баг):
 *
 *  1. Отрыв $queryRaw от клиента: `const q = prisma.$queryRaw`
 *     теряет this — в runtime Prisma 6 $queryRaw — прототипный
 *     метод, внутри обращается к this._createPrismaPromise,
 *     и detached-вызов даёт TypeError (реальный инцидент VPS:
 *     /api/chart/markets -> 503 при живой базе).
 *     Разрешён ТОЛЬКО вызов членом объекта:
 *     prisma.$queryRaw<T>`...` — tagged template с параметризацией.
 *  2. $queryRawUnsafe / $executeRawUnsafe — SQL-инъекции по построению.
 *  3. Ссылки на таблицы/колонки, которых нет в schema.prisma
 *     (регистр, quoting, переименования).
 *  4. Расхождение алиасов SQL (`AS "x"`) и полей TS-типа строки
 *     ChartRow — undefined в коде вместо значения.
 *
 * Запуск: npx tsx scripts/test-chart-sql.ts
 *         npx tsx scripts/test-chart-sql.ts --self-test
 *
 * Самодостаточен: не требует ни базы, ни generate клиента.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");

const TARGETS = [
  "app/api/chart/markets/route.ts",
  "app/coin/[symbol]/page.tsx",
  "app/admin/data/page.tsx",
  "lib/snapshots/plan.ts"
];

/* ---------- разбор schema.prisma ---------- */

type Schema = Map<string, Set<string>>;

function parseSchema(source: string): Schema {
  const schema: Schema = new Map();

  const modelRe = /model\s+(\w+)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;

  while ((m = modelRe.exec(source)) !== null) {
    const modelName = m[1];
    const fields = new Set<string>();

    for (const rawLine of m[2].split("\n")) {
      const line = rawLine.trim();

      if (
        line.length === 0 ||
        line.startsWith("//") ||
        line.startsWith("@@")
      ) {
        continue;
      }

      const name = line.split(/\s+/)[0];

      if (/^[A-Za-z_]\w*$/.test(name)) {
        fields.add(name);
      }
    }

    schema.set(modelName, fields);
  }

  return schema;
}

/* ---------- проверки одного файла ---------- */

type Problem = string;

function checkFile(
  path: string,
  text: string,
  schema: Schema
): Problem[] {
  const problems: Problem[] = [];

  // 1. Отрыв $queryRaw в переменную — потеря this.
  const detachRe = /=\s*prisma\.\$queryRaw\b(?!\s*<)/g;
  let dm: RegExpExecArray | null;

  while ((dm = detachRe.exec(text)) !== null) {
    problems.push(
      `${path}: ОТРЫВ $queryRaw от клиента (позиция ${dm.index}): ` +
        "присваивание prisma.$queryRaw переменной теряет this — " +
        "в runtime это TypeError внутри _createPrismaPromise " +
        "(маскируется catch и выглядит как «БД недоступна»). " +
        "Используйте прямой вызов prisma.$queryRaw<T>`...`"
    );
  }

  // 2. Unsafe-варианты без параметризации.
  if (/queryRawUnsafe|executeRawUnsafe/.test(text)) {
    problems.push(
      `${path}: используется $queryRawUnsafe/$executeRawUnsafe — ` +
        "запрещено правилом параметризации; только tagged template " +
        "prisma.$queryRaw<T>`...`"
    );
  }

  // 3. Вызов $queryRaw должен быть членом объекта, tagged template.
  const memberCalls = [
    ...text.matchAll(
      /prisma\.\$queryRaw(?:<[^(>]*>)?`((?:[^`\\])*)`/g
    )
  ];

  if (
    memberCalls.length === 0 &&
    /prisma\.\$queryRaw/.test(text)
  ) {
    problems.push(
      `${path}: prisma.$queryRaw найден, но не в форме ` +
        "tagged-template вызова prisma.$queryRaw<T>`...`"
    );
  }

  // 4. Валидация ВСЕХ SQL-шаблонов файла (в любой форме):
  //    таблицы, алиасы, колонки — против schema.prisma.
  const aliasesInFile = new Set<string>();
  const sqlTemplates = [
    ...text.matchAll(/`((?:[^`\\])*)`/g)
  ].filter((t) => /\b(FROM|JOIN)\s+"/.test(t[1]));

  for (const tpl of sqlTemplates) {
    const sql: string = tpl[1];

    const tableRe =
      /\b(?:FROM|JOIN)\s+"(\w+)"\s+(?:AS\s+)?(\w+)/g;
    const aliasToModel = new Map<string, string>();
    let tm: RegExpExecArray | null;

    while ((tm = tableRe.exec(sql)) !== null) {
      const table = tm[1];
      const alias = tm[2];

      if (!schema.has(table)) {
        problems.push(
          `${path}: SQL использует таблицу "${table}", ` +
            "которой нет в prisma/schema.prisma " +
            `(есть: ${[...schema.keys()].sort().join(", ")})`
        );

        continue;
      }

      aliasToModel.set(alias, table);
    }

    if (aliasToModel.size === 0) {
      problems.push(
        `${path}: в SQL-шаблоне не найдено ни одной таблицы ` +
          'вида FROM/JOIN "Model" alias'
      );
    }

    // Ссылки на колонки: alias."field" или alias.field
    const colRe = /(\w+)\.(")?(\w+)(")?/g;
    let cm: RegExpExecArray | null;

    while ((cm = colRe.exec(sql)) !== null) {
      const alias = cm[1];
      const field = cm[3];

      const model = aliasToModel.get(alias);

      if (!model) {
        continue;
      }

      const fields = schema.get(model)!;

      if (!fields.has(field)) {
        problems.push(
          `${path}: SQL использует ${alias}.${field} ` +
            `(таблица "${model}"), но поля "${field}" ` +
            `в модели ${model} нет`
        );
      }
    }

    for (const am of sql.matchAll(/AS\s+"(\w+)"/g)) {
      aliasesInFile.add(am[1]);
    }
  }

  if (
    sqlTemplates.length === 0 &&
    (memberCalls.length > 0 ||
      /prisma\.\$queryRaw/.test(text))
  ) {
    problems.push(
      `${path}: есть $queryRaw, но SQL-шаблон не извлечён ` +
        "(нет FROM/JOIN \"Model\")"
    );
  }

  // 5. Поля TS-типа ChartRow должны быть среди алиасов SQL.
  const rowType = /type\s+ChartRow\s*=\s*\{([^}]*)\}/.exec(
    text
  );

  if (rowType && sqlTemplates.length > 0) {
    const keyRe = /^\s{2}(\w+)\s*:/gm;
    let km: RegExpExecArray | null;

    while ((km = keyRe.exec(rowType[1])) !== null) {
      const key = km[1];

      if (!aliasesInFile.has(key)) {
        problems.push(
          `${path}: поле ChartRow.${key} не найдено среди ` +
            `алиасов SQL (AS "..."): ` +
            `${[...aliasesInFile].sort().join(", ") || "нет"}`
        );
      }
    }
  }

  return problems;
}

/* ---------- self-test чекера на фикстурах ---------- */

const SCHEMA_FIXTURE = `
model Market {
  id             Int
  exchange       String
  exchangeSymbol String
  assetId        Int
}

model Candle {
  id        BigInt
  marketId  Int
  timeframe String
  openTime  DateTime
}
`;

function selfTest(): boolean {
  const schema = parseSchema(SCHEMA_FIXTURE);
  let ok = true;

  // Плохой файл: отрыв $queryRaw + несуществующая колонка.
  const bad = [
    "type ChartRow = {",
    "  marketId: number;",
    "  candleCount: number;",
    "}",
    "async function f() {",
    "  const queryRaw =",
    "    prisma.$queryRaw as unknown as (",
    "      q: TemplateStringsArray,",
    "      ...v: unknown[]",
    "    ) => Promise<ChartRow[]>;",
    "  const rows = await queryRaw`",
    "    SELECT m.id AS \"marketId\",",
    "      COUNT(*)::int AS \"candleCount\"",
    "    FROM \"Candle\" c JOIN \"Market\" m ON m.id = c.\"marketId\"",
    "    WHERE m.\"assetIdX\" = ${id}",
    "  `;",
    "}"
  ].join("\n");

  const badProblems = checkFile("FIXTURE_BAD", bad, schema);

  const hasDetach = badProblems.some((p) =>
    p.includes("ОТРЫВ $queryRaw")
  );
  const hasForm = badProblems.some((p) =>
    p.includes("tagged-template")
  );
  const hasColumn = badProblems.some((p) =>
    p.includes("assetIdX")
  );

  if (!hasDetach) {
    console.error(
      "self-test: чекер НЕ поймал отрыв $queryRaw"
    );
    ok = false;
  }

  if (!hasForm) {
    console.error(
      "self-test: чекер НЕ поймал не-членную форму вызова"
    );
    ok = false;
  }

  if (!hasColumn) {
    console.error(
      "self-test: чекер НЕ поймал несуществующую колонку"
    );
    ok = false;
  }

  // Хороший файл: членный вызов, валидные ссылки.
  const good = [
    "type ChartRow = {",
    "  marketId: number;",
    "  candleCount: number;",
    "}",
    "async function f() {",
    "  const rows = await prisma.$queryRaw<ChartRow[]>`",
    "    SELECT m.id AS \"marketId\",",
    "      COUNT(*)::int AS \"candleCount\"",
    "    FROM \"Candle\" c JOIN \"Market\" m ON m.id = c.\"marketId\"",
    "    WHERE m.\"assetId\" = ${id}",
    "  `;",
    "}"
  ].join("\n");

  const goodProblems = checkFile("FIXTURE_GOOD", good, schema);

  if (goodProblems.length !== 0) {
    console.error(
      "self-test: чекер дал ложные срабатывания на валидном коде:",
      goodProblems
    );
    ok = false;
  }

  return ok;
}

/* ---------- main ---------- */

function main(): number {
  if (process.argv.includes("--self-test")) {
    const ok = selfTest();

    console.log(
      ok
        ? "Itog: self-test chart-sql proshel (чекер ловит отрыв $queryRaw, неверную форму вызова и несуществующие колонки)"
        : "Itog: self-test chart-sql UPALED"
    );

    return ok ? 0 : 1;
  }

  const schemaPath = join(ROOT, "prisma", "schema.prisma");

  if (!existsSync(schemaPath)) {
    console.error(`schema.prisma не найдена: ${schemaPath}`);

    return 1;
  }

  const schema = parseSchema(
    readFileSync(schemaPath, "utf8")
  );

  const allProblems: Problem[] = [];

  for (const rel of TARGETS) {
    const path = join(ROOT, rel);

    if (!existsSync(path)) {
      allProblems.push(`${rel}: файл не найден`);

      continue;
    }

    allProblems.push(
      ...checkFile(rel, readFileSync(path, "utf8"), schema)
    );
  }

  // Специальное правило (регрессия VPS a8da7db): в coin page
  // карточка «Последняя закрытая свеча» обязана считаться
  // ТОЛЬКО по закрытым свечам — без голого MAX(openTime).
  const coinPageText = (() => {
    const p = join(ROOT, "app/coin/[symbol]/page.tsx");

    return existsSync(p)
      ? readFileSync(p, "utf8")
      : "";
  })();

  if (coinPageText.length > 0) {
    const filteredRe =
      /MAX\(c\."openTime"\)\s+FILTER\s*\(\s*WHERE\s+c\.closed\s*=\s*true\s*\)\s+AS\s+"lastCandleTime"/;

    if (!filteredRe.test(coinPageText)) {
      allProblems.push(
        "app/coin/[symbol]/page.tsx: lastCandleTime обязан быть " +
          'MAX(c."openTime") FILTER (WHERE c.closed = true) — ' +
          "открытая свеча не может называться закрытой"
      );
    }

    const bareMaxRe =
      /MAX\(c\."openTime"\)\s+AS\s+"lastCandleTime"/;

    if (bareMaxRe.test(coinPageText)) {
      allProblems.push(
        'app/coin/[symbol]/page.tsx: голый MAX(c."openTime") ' +
          'AS "lastCandleTime" запрещён (включает открытые свечи)'
      );
    }
  }

  if (allProblems.length > 0) {
    console.error(
      `chart-sql: найдено проблем: ${allProblems.length}`
    );

    for (const p of allProblems) {
      console.error(`  - ${p}`);
    }

    console.error(
      "Itog: chart-sql UPALED — исправьте перечисленное"
    );

    return 1;
  }

  console.log(
    `Itog: chart-sql proshel — ${TARGETS.length} файлов: ` +
      "вызов $queryRaw корректен, SQL совпадает со schema.prisma"
  );

  return 0;
}

process.exit(main());
