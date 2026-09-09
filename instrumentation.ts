/**
 * Next.js instrumentation — единая точка инициализации
 * серверной части (вызывается один раз при старте
 * процесса; Node.js runtime).
 *
 * Перехватывает console.error/warn/log в кольцевой буфер
 * журнала админки (lib/observability/journal.ts) и
 * регистрирует обработчики необработанных ошибок.
 * Оригинальный вывод консоли НЕ подавляется.
 *
 * Секреты в журнал не попадают (фильтрация в journal.ts).
 *
 * Что сознательно НЕ логируется (аудит-требование):
 * request headers, cookies, тела запросов, query-
 * параметры, значения сессионных токенов и любые
 * значения переменных окружения. Перехватывается
 * ТОЛЬКО текст строк консоли и Error.name/Error.message
 * у исключений; process.env здесь не читается и никуда
 * не выводится.
 */

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") {
    return;
  }

  const { pushJournalEntry } =
    await import(
      "./lib/observability/journal"
    );

  const originalError =
    console.error.bind(console);
  const originalWarn =
    console.warn.bind(console);
  const originalLog =
    console.log.bind(console);

  console.error = (...args: unknown[]) => {
    const message = args
      .map((a) =>
        a instanceof Error
          ? `${a.name}: ${a.message}`
          : typeof a === "string"
            ? a
            : ""
      )
      .filter(Boolean)
      .join(" ");

    if (message) {
      pushJournalEntry("ERROR", message);
    }

    originalError(...args);
  };

  console.warn = (...args: unknown[]) => {
    const message = args
      .filter((a) => typeof a === "string")
      .join(" ");

    if (message) {
      pushJournalEntry("WARN", message);
    }

    originalWarn(...args);
  };

  console.log = (...args: unknown[]) => {
    const message = args
      .filter((a) => typeof a === "string")
      .join(" ");

    if (
      message.startsWith("[") &&
      message.length > 2
    ) {
      pushJournalEntry("INFO", message);
    }

    originalLog(...args);
  };

  process.on(
    "unhandledRejection",
    (reason) => {
      pushJournalEntry(
        "ERROR",
        `unhandledRejection: ${
          reason instanceof Error
            ? `${reason.name}: ${reason.message}`
            : String(reason).slice(0, 200)
        }`
      );
    }
  );

  process.on(
    "uncaughtException",
    (error) => {
      pushJournalEntry(
        "ERROR",
        `uncaughtException: ${error.name}: ${error.message}`
      );
    }
  );

  pushJournalEntry(
    "INFO",
    "[journal] Журнал событий инициализирован"
  );
}
