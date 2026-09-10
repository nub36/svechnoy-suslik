import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect, notFound } from "next/navigation";
import StrategyEditor from "@/components/admin/StrategyEditor";
import SmartMoneyStrategyEditor from "@/components/admin/SmartMoneyStrategyEditor";
import AdminNav from "@/components/admin/AdminNav";

export default async function Page({
  params
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const { id } = await params;

  const strategy =
    await prisma.strategy.findUnique({
      where: {
        id: Number(id)
      }
    });

  if (!strategy) {
    notFound();
  }

  return (
    // Тот же layout-контракт, что у /admin, /admin/data,
    // /admin/monitoring и /admin/markets: .adminPage —
    // grid 235px + 1fr (AdminNav — левая колонка,
    // контент справа; на экранах <=950px сетка
    // схлопывается в одну колонку средствами globals.css).
    <main className="adminPage">
      <AdminNav active="strategies" />

      <section className="adminDashboard">
        {strategy.slug === "smart-money-suslik" ? (
          <SmartMoneyStrategyEditor
            strategy={{
              id: strategy.id,
              slug: strategy.slug,
              name: strategy.name,
              description: strategy.description,
              version: strategy.version,
              enabled: strategy.enabled,
              status: strategy.status,
              minExchanges: strategy.minExchanges,
              timeframes: strategy.timeframes,
              config: strategy.config as any,
            }}
          />
        ) : strategy.slug === "trend-suslik" ? (
          <StrategyEditor
            strategy={{
              id: strategy.id,
              name: strategy.name,
              description: strategy.description,
              version: strategy.version,
              enabled: strategy.enabled,
              status: strategy.status,
              minExchanges: strategy.minExchanges,
              timeframes: strategy.timeframes,
              config: strategy.config as any,
            }}
          />
        ) : (
          <div className="adminPanel">
            <h2>Неподдерживаемая стратегия</h2>
            <p>
              Стратегия с <code>slug=&quot;{strategy.slug}&quot;</code>{" "}
              не поддерживается текущим Admin UI.
            </p>
            <p className="muted">
              Версия {strategy.version}, статус {strategy.status}. Требуется
              обновление редактора для этого типа стратегии.
            </p>
            <pre
              style={{
                marginTop: 12,
                padding: 12,
                background: "#f9fafb",
                borderRadius: 8,
                overflow: "auto",
                fontSize: 12,
              }}
            >
              {JSON.stringify(
                {
                  slug: strategy.slug,
                  version: strategy.version,
                  enabled: strategy.enabled,
                  status: strategy.status,
                  timeframes: strategy.timeframes,
                  minExchanges: strategy.minExchanges,
                  config: strategy.config,
                },
                null,
                2
              )}
            </pre>
          </div>
        )}
      </section>
    </main>
  );
}
