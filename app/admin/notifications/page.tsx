import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * «Уведомления» — честный пустой раздел: реального
 * notification backend (Telegram/email/… ) в проекте
 * пока НЕ существует. Никаких изображений
 * «подключённых» каналов.
 */

export default async function AdminNotificationsPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  return (
    <main className="adminPage">
      <AdminNav active="notifications" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Раздел без backend-функции
            </div>

            <h1>Уведомления</h1>
          </div>
        </div>

        <div className="adminEmpty">
          Доставка уведомлений (Telegram, email и т.п.)
          в проекте не реализована: ни каналов не
          подключено, ни событий не отправляется.

          Здесь будут только реально отправленные
          уведомления, когда такой backend появится.
        </div>

        <p className="muted healthNote">
          Не подключено — значит не подключено: этот
          раздел принципиально не показывает
          декоративные статусы мессенджеров/почты.
        </p>
      </section>
    </main>
  );
}
