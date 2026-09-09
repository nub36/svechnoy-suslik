import { redirect } from "next/navigation";
import { auth } from "@/auth";

export const dynamic = "force-dynamic";

const ROLE_LABELS: Record<string, string> = {
  USER: "Пользователь",
  PRO: "PRO",
  ADMIN: "Администратор"
};

/**
 * Минимальный профиль на реальных данных сессии.
 * Никакой выдуманной статистики: только аккаунт и роль.
 */
export default async function ProfilePage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const role = String(
    session.user.role ?? "USER"
  );

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Мой профиль</h1>
          <div className="muted">
            Данные вашего аккаунта
          </div>
        </div>
      </section>

      <div className="cards">
        <div className="card">
          <div className="cardTitle">Имя</div>

          <div className="bigValue" style={{ fontSize: "1.2rem" }}>
            {session.user.name || "Не указано"}
          </div>
        </div>

        <div className="card">
          <div className="cardTitle">Email</div>

          <div className="bigValue" style={{ fontSize: "1.2rem" }}>
            {session.user.email || "Не указан"}
          </div>
        </div>

        <div className="card">
          <div className="cardTitle">Роль</div>

          <div className="bigValue">
            {ROLE_LABELS[role] ?? role}
          </div>

          <span className="muted">
            {role === "ADMIN"
              ? "Полный доступ к админке"
              : role === "PRO"
                ? "Расширенный доступ"
                : "Базовый доступ"}
          </span>
        </div>
      </div>

      <div className="tableBox">
        <p className="muted" style={{ padding: "1rem" }}>
          Управление подписками и уведомлениями
          появится в будущих версиях.
        </p>
      </div>
    </main>
  );
}
