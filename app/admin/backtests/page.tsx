import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * «Бэктесты» — честный пустой раздел: реального
 * backtest-движка в проекте пока НЕ существует.
 * Никаких фиктивных PnL/winrate/trades.
 * Signal Engine не используется.
 */

export default async function AdminBacktestsPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  return (
    <main className="adminPage">
      <AdminNav active="backtests" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Раздел без backend-функции
            </div>

            <h1>Бэктесты</h1>
          </div>
        </div>

        <div className="adminEmpty">
          Бэктест-движка в проекте пока нет, поэтому
          здесь нечего показывать: ни исторических
          прогонов, ни результатов.

          Раздел станет доступен, когда будет
          реализован безопасный бэктест на закрытых
          свечах PostgreSQL (без обращения к API бирж
          и без lookahead).
        </div>

        <p className="muted healthNote">
          Существующий production-ready Strategy Runtime
          умеет оценивать стратегии на актуальных данных
          (см. раздел «Индикаторы» и /admin/data), но
          историческое прогон-тестирование — отдельная
          будущая функция. Проценты/кривые доходности на
          этой странице показываться не будут, пока их
          реально не посчитает backend.
        </p>
      </section>
    </main>
  );
}
