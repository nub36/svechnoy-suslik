import Link from "next/link";

/**
 * Страница 404 всего сайта.
 *
 * Никаких выдуманных разделов и заглушек: только честное
 * сообщение и навигация в РЕАЛЬНЫЕ существующие разделы
 * (все ссылки ведут на существующие маршруты приложения).
 */
export default function NotFound() {
  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Страница не найдена</h1>
          <div className="muted">
            Такого адреса у Суслика нет: страница не
            построена или удалена. Пустых заглушек здесь
            не разворачиваем.
          </div>
        </div>
      </section>

      <div className="tableBox">
        <p className="muted" style={{ padding: "1rem" }}>
          Существующие разделы:{" "}
          <Link href="/">Рынок</Link> ·{" "}
          <Link href="/strategies">Стратегии</Link> ·{" "}
          <Link href="/signals">Сигналы</Link> ·{" "}
          <Link href="/login">Вход</Link>
        </p>
      </div>
    </main>
  );
}
