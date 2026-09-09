import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import {
  getJournalEntries
} from "@/lib/observability/journal";

export const dynamic = "force-dynamic";

/**
 * «Журнал» — реальные события текущего процесса
 * веб-приложения (кольцевой буфер, instrumentation.ts).
 *
 * ADMIN-only. Без секретов (фильтрация в journal.ts),
 * без чтения произвольных файлов, без произвольных
 * путей от пользователя. Пагинация защищает память
 * (буфер ограничен 500 записями, страница ≤ 50).
 */

function fmtTs(date: Date): string {
  return (
    date.toLocaleString("ru-RU", {
      timeZone: "UTC",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }) + " UTC"
  );
}

export default async function AdminJournalPage({
  searchParams
}: {
  searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const query = await searchParams;

  const level =
    typeof query.level === "string"
      ? query.level.toUpperCase()
      : "";
  const source =
    typeof query.source === "string"
      ? query.source
      : "";
  const pageRaw = Number(query.page ?? "1");

  const result = getJournalEntries({
    level,
    source,
    page:
      Number.isInteger(pageRaw) &&
      pageRaw >= 1 &&
      pageRaw <= 100
        ? pageRaw
        : 1,
    pageSize: 50
  });

  const buildHref = (nextPage: number) => {
    const params = new URLSearchParams();

    if (level) {
      params.set("level", level);
    }

    if (source) {
      params.set("source", source);
    }

    if (nextPage > 1) {
      params.set("page", String(nextPage));
    }

    const qs = params.toString();

    return `/admin/journal${qs ? `?${qs}` : ""}`;
  };

  return (
    <main className="adminPage">
      <AdminNav active="journal" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Диагностика
            </div>

            <h1>Журнал</h1>

            <p className="muted">
              Реальные события текущего процесса
              веб-приложения: ошибки API/страниц,
              предупреждения, инициализация. Буфер —
              последние 500 событий; после перезапуска
              приложения журнал пуст. Worker'ы
              (OHLCV/Snapshot) — отдельные процессы, их
              события сюда не попадают. Секреты
              (строки подключения, токены, пароли)
              скрываются автоматически.
            </p>
          </div>
        </div>

        <form
          className="adminFilters"
          method="get"
        >
          <select
            name="level"
            defaultValue={level}
          >
            <option value="">
              Все уровни
            </option>
            <option value="ERROR">
              ERROR
            </option>
            <option value="WARN">WARN</option>
            <option value="INFO">INFO</option>
          </select>

          <select
            name="source"
            defaultValue={source}
          >
            <option value="">
              Все источники
            </option>

            {result.sources.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>

          <button
            type="submit"
            className="chip"
          >
            Применить
          </button>

          <span className="muted">
            записей по фильтру:{" "}
            {result.total}
          </span>
        </form>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Время (UTC)</th>
                <th>Уровень</th>
                <th>Источник</th>
                <th>Сообщение</th>
              </tr>
            </thead>

            <tbody>
              {result.rows.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    Событий по фильтру нет: либо буфер
                    пуст (процесс только что
                    перезапущен), либо фильтр слишком
                    строгий.
                  </td>
                </tr>
              )}

              {result.rows.map((entry) => (
                <tr key={entry.seq}>
                  <td>
                    {fmtTs(entry.ts)}
                  </td>
                  <td>
                    <span
                      className={`freshBadge ${
                        entry.level === "ERROR"
                          ? "stale"
                          : entry.level === "WARN"
                            ? "delayed"
                            : "fresh"
                      }`}
                    >
                      {entry.level}
                    </span>
                  </td>
                  <td>
                    {entry.source}
                  </td>
                  <td
                    style={{
                      maxWidth: 480,
                      overflowWrap: "anywhere"
                    }}
                  >
                    {entry.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="adminPagination muted">
          Страница {result.page} из{" "}
          {result.totalPages}

          {result.page > 1 && (
            <a
              href={buildHref(
                result.page - 1
              )}
              className="chip"
            >
              ← Назад
            </a>
          )}

          {result.page < result.totalPages && (
            <a
              href={buildHref(
                result.page + 1
              )}
              className="chip"
            >
              Вперёд →
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
