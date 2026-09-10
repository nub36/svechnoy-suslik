import AdminNav from "@/components/admin/AdminNav";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import {
  ChevronRight,
  Settings2
} from "lucide-react";

export const dynamic = "force-dynamic";

/**
 * Самостоятельный раздел «Стратегии» админки.
 *
 * Показывает РЕАЛЬНЫЕ записи Strategy из PostgreSQL:
 * имя/версия/статус/включённость/таймфреймы/порог
 * подтверждающих бирж. Никакой прибыльности, PnL,
 * winrate или счётчиков сигналов здесь нет и быть
 * не должно — раздел про конфигурацию стратегий.
 * Создание новых стратегий через UI пока не
 * реализовано: кнопка честно disabled с объяснением.
 */

type StrategyRow = {
  id: number;
  slug: string;
  name: string;
  description: string | null;
  version: number;
  enabled: boolean;
  status: string;
  timeframes: string[];
  minExchanges: number;
};

export default async function AdminStrategiesPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  // Реальный источник: записи Strategy в PostgreSQL.
  const strategies =
    (await prisma.strategy.findMany({
      orderBy: [
        { slug: "asc" },
        { version: "desc" }
      ],
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        version: true,
        enabled: true,
        status: true,
        timeframes: true,
        minExchanges: true
      }
    })) as unknown as StrategyRow[];

  const published = strategies.filter(
    (s) =>
      s.status === "PUBLISHED" &&
      s.enabled
  ).length;

  return (
    <main className="adminPage">
      <AdminNav active="strategies" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Конфигурация
            </div>

            <h1>Стратегии</h1>

            <p className="muted">
              Реальные записи Strategy из
              PostgreSQL: статус, таймфреймы,
              порог подтверждающих бирж.
              Настройка — внутри карточки.
            </p>
          </div>
        </div>

        <section className="adminPanel">
          <div className="adminPanelHead">
            <div>
              <h2>
                Стратегии в базе
              </h2>

              <p>
                {published} активных
                опубликованных стратегий.
              </p>
            </div>

            <button
              className="adminPrimaryButton"
              disabled
              title="Добавление новых стратегий станет доступно после разработки и проверки стратегии"
            >
              + Новая стратегия
            </button>
          </div>

          <div className="strategyAdminList">
            {strategies.length === 0 ? (
              <div className="adminEmpty">
                Стратегии пока не созданы.
              </div>
            ) : (
              strategies.map(
                (strategy) => (
                  <div
                    className="strategyAdminCard"
                    key={strategy.id}
                  >
                    <div className="strategyAdminIcon">
                      🐿️
                    </div>

                    <div className="strategyAdminMain">
                      <div className="strategyAdminTitle">
                        <h3>
                          {strategy.name}
                        </h3>

                        <span>
                          v{strategy.version}
                        </span>

                        <span
                          className={
                            strategy.enabled
                              ? "adminStatusOn"
                              : "adminStatusOff"
                          }
                        >
                          {strategy.enabled
                            ? "Включена"
                            : "Выключена"}
                        </span>
                      </div>

                      {strategy.description && (
                        <p>
                          {
                            strategy.description
                          }
                        </p>
                      )}

                      <div className="strategyMeta">
                        <span>
                          Таймфреймы:{" "}
                          {strategy.timeframes.join(
                            ", "
                          )}
                        </span>

                        <span>
                          Подтверждение:{" "}
                          {
                            strategy.minExchanges
                          }
                          /5 бирж
                        </span>

                        <span>
                          Статус:{" "}
                          {strategy.status ===
                          "PUBLISHED"
                            ? "Опубликована"
                            : strategy.status}
                        </span>
                      </div>
                    </div>

                    <Link
                      href={`/admin/strategies/${strategy.id}`}
                      className="strategyConfigure"
                    >
                      <Settings2
                        size={17}
                      />
                      Настроить
                      <ChevronRight
                        size={16}
                      />
                    </Link>
                  </div>
                )
              )
            )}
          </div>
        </section>
      </section>
    </main>
  );
}
