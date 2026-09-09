export const dynamic = "force-dynamic";

/**
 * Публичный список стратегий — ТОЛЬКО реальные данные
 * из PostgreSQL (enabled + PUBLISHED видны как активные).
 *
 * Выдуманный список из 7 стратегий удалён:
 * в базе пока существует только «Трендовый Суслик»,
 * и честно показывается только он.
 */

type StrategyRow = {
  id: number;
  name: string;
  slug: string;
  description: string;
  version: number;
  enabled: boolean;
  status: string;
  timeframes: string[];
  minExchanges: number;
};

export default async function Strategies() {
  let strategies: StrategyRow[] | null = null;

  try {
    // Ленивый импорт: недоступность базы
    // даёт честное «Нет данных», а не падение страницы.
    const { prisma: db } = await import(
      "@/lib/prisma"
    );

    strategies = await db.strategy.findMany({
      where: { status: "PUBLISHED" },
      orderBy: [
        { slug: "asc" },
        { version: "desc" }
      ],
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        version: true,
        enabled: true,
        status: true,
        timeframes: true,
        minExchanges: true
      }
    });
  } catch (error) {
    // База недоступна — показываем честный экран ниже,
    // причину пишем в server-лог.
    console.error(
      "[strategies] Ошибка загрузки стратегий:",
      error
    );

    strategies = null;
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Стратегии</h1>
          <div className="muted">
            Независимые алгоритмы анализа рынка
          </div>
        </div>
      </section>

      {strategies === null ? (
        <div className="tableBox">
          <p className="muted" style={{ padding: "1rem" }}>
            Нет данных: база временно недоступна.
          </p>
        </div>
      ) : strategies.length === 0 ? (
        <div className="tableBox">
          <p className="muted" style={{ padding: "1rem" }}>
            Опубликованных стратегий пока нет.
            Создайте их в админке или запустите
            scripts/seed-strategies.ts на сервере.
          </p>
        </div>
      ) : (
        strategies.map((s) => (
          <div className="strategy" key={s.id}>
            <div className="strategyHead">
              <div>
                <b>{s.name}</b>

                <div className="muted">
                  Версия {s.version} ·{" "}
                  {s.timeframes
                    .map((tf) => tf.toUpperCase())
                    .join(" + ")}
                </div>
              </div>

              <span
                className={`signal ${
                  s.enabled ? "long" : "neutral"
                }`}
              >
                {s.enabled ? "АКТИВНА" : "ВЫКЛЮЧЕНА"}
              </span>
            </div>

            <p>{s.description}</p>

            <small className="muted">
              Подтверждение минимум{" "}
              {s.minExchanges}{" "}
              {s.minExchanges === 1
                ? "биржей"
                : "биржами"}{" "}
              · расчёт по закрытым свечам PostgreSQL
            </small>
          </div>
        ))
      )}
    </main>
  );
}
