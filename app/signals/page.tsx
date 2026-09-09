export const dynamic = "force-dynamic";

/**
 * Раздел сигналов.
 *
 * Production Signal Engine ещё НЕ развёрнут: запись
 * сигналов в PostgreSQL не выполнялась (разделы §25
 * и §28 PROJECT_CONTEXT.md), поэтому страница честно
 * сообщает об этом и НЕ обращается к Prisma Signal.
 *
 * Никаких демонстрационных сигналов: покажем реальные
 * данные, как только Signal Engine будет перенесён
 * и запущен отдельным этапом.
 */
export default function Signals() {
  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Сигналы</h1>
          <div className="muted">
            Формализованные сигналы алгоритмических стратегий
          </div>
        </div>
      </section>

      <div className="muted" style={{ marginBottom: "1rem" }}>
        Сила — это степень совпадения условий стратегии (0–100),
        а не вероятность успешной сделки.
      </div>

      <div className="tableBox">
        <p className="muted" style={{ padding: "1rem" }}>
          Нет данных. Signal Engine ещё не развёрнут
          в production — сигналы пока не формируются.
        </p>

        <p className="muted" style={{ padding: "0 1rem 1rem" }}>
          Стратегии и мультибиржевое подтверждение уже
          работают — смотрите раздел{" "}
          <a href="/strategies">«Стратегии»</a>.
        </p>
      </div>
    </main>
  );
}
