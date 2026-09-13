"use client";

/**
 * Граница ошибок уровня страницы (app router): вместо голого
 * «Application error: a client-side exception» — честное
 * русское состояние с единственно возможным безопасным
 * действием (повторный рендер). Никаких «починим за вас»:
 * причина остаётся в server-логе, повтор ничего не пишет.
 */
export default function SiteError({
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Страница не отобразилась</h1>
          <div className="muted">
            Ошибка отображения. Все разделы Суслика
            только читают данные — повторная загрузка
            ничего не меняет на сервере.
          </div>
        </div>
      </section>

      <div className="tableBox">
        <div
          style={{
            padding: "1rem",
            display: "flex",
            gap: "10px",
            alignItems: "center",
            flexWrap: "wrap"
          }}
        >
          <button
            type="button"
            className="chip"
            onClick={() => reset()}
          >
            Повторить
          </button>

          <span className="muted">
            Не помогает — обновите страницу (F5); если и
            это не помогло, причина уже записана в лог
            сервера.
          </span>
        </div>
      </div>
    </main>
  );
}
