import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import {
  Activity,
  BarChart3,
  BellRing,
  BookOpen,
  CandlestickChart,
  ChevronRight,
  Database,
  FlaskConical,
  Gauge,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Zap
} from "lucide-react";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const [
    strategies,
    assets,
    markets,
    candleCount,
    signals
  ] = await Promise.all([
    prisma.strategy.findMany({
      orderBy: [
        { slug: "asc" },
        { version: "desc" }
      ]
    }),

    // основной universe Top-100 (lib/universe.ts)
    prisma.asset.count({
      where: {
        enabled: true,
        rank: {
          lte: 100,
          not: null
        }
      }
    }),

    prisma.market.count({
      where: {
        enabled: true
      }
    }),

    prisma.candle.count(),

    prisma.signal.count({
      where: {
        status: "ACTIVE"
      }
    })
  ]);

  const published =
    strategies.filter(
      (s) =>
        s.status === "PUBLISHED" &&
        s.enabled
    ).length;

  return (
    <main className="adminPage">
      <aside className="adminNavigation">
        <div className="adminNavTitle">
          Администрирование
        </div>

        <Link
          href="/admin"
          className="adminNavActive"
        >
          <Gauge size={17} />
          Обзор
        </Link>

        <a href="#strategies">
          <SlidersHorizontal size={17} />
          Стратегии
        </a>

        <Link href="/admin">
          <CandlestickChart size={17} />
          Индикаторы
        </Link>

        <Link href="/admin/data">
          <Database size={17} />
          Источники данных
        </Link>

        <Link href="/admin">
          <BarChart3 size={17} />
          Рынки
        </Link>

        <Link href="/admin">
          <FlaskConical size={17} />
          Бэктесты
        </Link>

        <Link href="/signals">
          <Zap size={17} />
          Сигналы
        </Link>

        <Link href="/admin">
          <Activity size={17} />
          Мониторинг
        </Link>

        <Link href="/admin">
          <BellRing size={17} />
          Уведомления
        </Link>

        <Link href="/admin">
          <BookOpen size={17} />
          Журнал
        </Link>
      </aside>

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              <ShieldCheck size={15} />
              Панель администратора
            </div>

            <h1>
              Центр управления Сусликом
            </h1>

            <p>
              Стратегии, источники данных,
              сигналы и состояние движка.
            </p>
          </div>

          <div className="adminUserBadge">
            {session.user.email}
          </div>
        </div>

        <div className="adminStats">
          <div className="adminStatCard">
            <span>Top активов (Top-100)</span>
            <b>{assets}</b>
            <small>
              основной universe анализа
            </small>
          </div>

          <div className="adminStatCard">
            <span>Рынков</span>
            <b>{markets}</b>
            <small>
              на пяти биржах
            </small>
          </div>

          <div className="adminStatCard">
            <span>Свечей в БД</span>
            <b>
              {candleCount.toLocaleString(
                "ru-RU"
              )}
            </b>
            <small>
              сохранённая история OHLCV
            </small>
          </div>

          <div className="adminStatCard">
            <span>Активных сигналов</span>
            <b>{signals}</b>
            <small>
              сейчас отслеживаются
            </small>
          </div>
        </div>

        <section
          className="adminPanel"
          id="strategies"
        >
          <div className="adminPanelHead">
            <div>
              <h2>Стратегии</h2>

              <p>
                {published} активных
                опубликованных стратегий.
              </p>
            </div>

            <button
              className="adminPrimaryButton"
              disabled
              title="Добавим вместе с конструктором стратегий"
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

                      <p>
                        {
                          strategy.description
                        }
                      </p>

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
                      <Settings2 size={17} />
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

        <section className="adminPanel">
          <div className="adminPanelHead">
            <div>
              <h2>
                Движок анализа
              </h2>

              <p>
                Текущее состояние
                серверной части.
              </p>
            </div>
          </div>

          <div className="engineStatusGrid">
            <div>
              <span className="statusDot statusGreen" />
              <p>
                <b>PostgreSQL</b>
                <small>
                  База подключена
                </small>
              </p>
            </div>

            <div>
              <span className="statusDot statusGreen" />
              <p>
                <b>Биржи</b>
                <small>
                  Binance, Bybit, Gate,
                  KuCoin, BingX
                </small>
              </p>
            </div>

            <div>
              <span
                className={
                  candleCount > 0
                    ? "statusDot statusGreen"
                    : "statusDot statusYellow"
                }
              />

              <p>
                <b>OHLCV Worker</b>
                <small>
                  {candleCount > 0
                    ? "Свечи поступают"
                    : "Фоновую загрузку ещё запускаем"}
                </small>
              </p>
            </div>

            <div>
              <span
                className={
                  signals > 0
                    ? "statusDot statusGreen"
                    : "statusDot statusYellow"
                }
              />

              <p>
                <b>Signal Engine</b>
                <small>
                  {signals > 0
                    ? "Есть активные сигналы"
                    : "Постоянный сканер ещё не запущен"}
                </small>
              </p>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
