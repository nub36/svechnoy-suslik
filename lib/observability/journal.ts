/**
 * Журнал событий веб-приложения (раздел «Журнал» админки).
 *
 * Минимальное решение БЕЗ schema change: кольцевой буфер
 * последних MAX_JOURNAL_ENTRIES событий ТЕКУЩЕГО процесса
 * Next.js (заполняется перехватом console.* в
 * instrumentation.ts). После перезапуска процесса буфер
 * пуст — это честно документировано в UI.
 *
 * Почему не PM2-файлы: имена/ротация файлов PM2 зависят
 * от окружения, а чтение произвольных файлов из веба
 * запрещено политикой проекта. Почему не Prisma-модель:
 * требуется schema change — отдельное решение.
 *
 * Worker'ы (ohlcv/snapshot) — отдельные процессы, их
 * вывод в этот буфер НЕ попадает (честно указано в UI).
 *
 * Секреты: запись, в которой распознан секретный паттерн
 * (DATABASE_URL/AUTH_SECRET/password/token/cookie/
 * authorization/соединительные строки), целиком
 * скрывается — сообщение НЕ отображается.
 *
 * Чистые функции (addEntry, filterEntries) тестируются
 * в scripts/test-journal.ts.
 */

export const MAX_JOURNAL_ENTRIES = 500;

export type JournalLevel =
  | "INFO"
  | "WARN"
  | "ERROR";

export type JournalEntry = {
  seq: number;
  ts: Date;
  level: JournalLevel;
  source: string;
  message: string;
};

const SECRET_PATTERN =
  /database_url|auth_secret|password|secret|token|cookie|authorization|bearer|api[_-]?key|private[_-]?key|ssh[_-]|ssh-rsa|ssh-ed25519|postgres(ql)?:\/\/|mysql:\/\//i;

/** Маскирование записи: секреты не должны попадать в UI. */
export function isSensitiveMessage(
  message: string
): boolean {
  return SECRET_PATTERN.test(message);
}

/** Нормализация сообщения: одна строка, максимум 400 символов. */
export function normalizeMessage(
  message: string
): string {
  const single =
    message.replace(/\s+/g, " ").trim();

  return single.length > 400
    ? single.slice(0, 399) + "…"
    : single;
}

/**
 * Извлечение источника из нашего формата логов:
 * "[api/chart/markets] Ошибка …" → source "api/chart/markets".
 */
export function extractSource(
  message: string
): string {
  const match = /^\[([^\]]{1,40})\]/.exec(
    message
  );

  return match ? match[1] : "app";
}

/** Чистое добавление в кольцевой буфер (иммутабельно). */
export function addEntry(
  buffer: JournalEntry[],
  entry: Omit<JournalEntry, "seq"> & {
    seq?: number;
  }
): JournalEntry[] {
  const seq =
    buffer.length > 0
      ? buffer[buffer.length - 1].seq + 1
      : 1;

  const next = [
    ...buffer,
    {
      seq,
      ts: entry.ts,
      level: entry.level,
      source: entry.source,
      message: entry.message
    }
  ];

  return next.length > MAX_JOURNAL_ENTRIES
    ? next.slice(next.length - MAX_JOURNAL_ENTRIES)
    : next;
}

export type JournalFilter = {
  level?: string;
  source?: string;
  page?: number;
  pageSize?: number;
};

/** Фильтр + пагинация (новые сверху). */
export function filterEntries(
  buffer: readonly JournalEntry[],
  filter: JournalFilter
): {
  rows: JournalEntry[];
  total: number;
  page: number;
  totalPages: number;
  sources: string[];
} {
  const level =
    filter.level === "INFO" ||
    filter.level === "WARN" ||
    filter.level === "ERROR"
      ? filter.level
      : null;

  const source =
    typeof filter.source === "string" &&
    filter.source.trim() !== ""
      ? filter.source.trim().slice(0, 40)
      : null;

  const pageSize =
    filter.pageSize && filter.pageSize > 0
      ? Math.min(filter.pageSize, 100)
      : 50;

  const sources = [
    ...new Set(buffer.map((e) => e.source))
  ].sort();

  const filtered = buffer.filter(
    (e) =>
      (level === null || e.level === level) &&
      (source === null || e.source === source)
  );

  const total = filtered.length;
  const totalPages = Math.max(
    1,
    Math.ceil(total / pageSize)
  );
  const page =
    filter.page &&
    filter.page >= 1 &&
    filter.page <= totalPages
      ? filter.page
      : 1;

  const rows = filtered
    .slice()
    .reverse()
    .slice((page - 1) * pageSize, page * pageSize);

  return {
    rows,
    total,
    page,
    totalPages,
    sources
  };
}

/* ---------- процессный буфер (globalThis) ---------- */

type JournalStore = {
  buffer: JournalEntry[];
};

const globalForJournal =
  globalThis as unknown as {
    svechnoyJournal?: JournalStore;
  };

function store(): JournalStore {
  if (!globalForJournal.svechnoyJournal) {
    globalForJournal.svechnoyJournal = {
      buffer: []
    };
  }

  return globalForJournal.svechnoyJournal;
}

export function pushJournalEntry(
  level: JournalLevel,
  message: string
): void {
  const normalized =
    normalizeMessage(message);

  const safe = isSensitiveMessage(normalized)
    ? "[запись скрыта: распознан потенциальный секрет]"
    : normalized;

  const s = store();

  s.buffer = addEntry(s.buffer, {
    ts: new Date(),
    level,
    source: extractSource(safe),
    message: safe
  });
}

export function getJournalEntries(
  filter: JournalFilter
): ReturnType<typeof filterEntries> {
  return filterEntries(
    store().buffer,
    filter
  );
}
