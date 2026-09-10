import Link from "next/link";
import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { topUniverseRankFilter } from "@/lib/universe";
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

  // Обёртка с честной деградацией: если БД недоступна,
  // страница показывает «Нет данных», а не падает.
  let data:
    | {
        strategies: {
          id: number;
          slug: string;
          name: string;
          description: string | null;
          version: number;
          enabled: boolean;
          status: string;
          timeframes: string[];
          minExchanges: number;
        }[];
        assets: number;
        universeMarkets: number;
        markets: number;
        candleCount: number;
        signals: number;
        dbLatencyMs: number | null;
        exchangesDistinct: number;
        lastClosed1h: Date | null;
      }
    | null = null;

  try {
    const started = Date.now();

    const [
      strategies,
      assets,
      universeMarkets,
      markets,
      candleCount,
      signals,
      activeMarkets,
      exchanges,
      lastClosedRows
    ] = await Promise.all([
      prisma.strategy.findMany({
        orderBy: [
          { slug: "asc" },
          { version: "desc" }
        ]
      }),

      // рынки ОСНОВНОГО Top-100 universe (rank 1..100)
      prisma.market.count({
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT",
          asset: topUniverseRankFilter()
        }
      }),

      // основной universe Top-100 (lib/universe.ts)
      prisma.asset.count({
        where: {
          enabled: true,
          ...topUniverseRankFilter()
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
      }),

      // точный смысл карточки «Рынков»
      prisma.market.count({
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        }
      }),

      // факт о ДАННЫХ в БД, не о доступности API бирж
      prisma.market.findMany({
        where: {
          enabled: true,
          status: "ACTIVE",
          quote: "USDT",
          marketType: "SPOT"
        },
        select: { exchange: true },
        distinct: ["exchange"]
      }),

      // последняя ЗАКРЫТАЯ 1h свеча для worker-статуса
      (prisma.$queryRaw<{ t: Date | null }[]>`
        SELECT MAX(c."openTime") FILTER (
          WHERE c.closed = true
        ) AS t
        FROM "Candle" c
        WHERE c.timeframe = '1h'
      `) as unknown as { t: Date | null }[]
    ]);

    data = {
      strategies,
      assets,
      universeMarkets,
      markets,
      candleCount,
      signals,
      dbLatencyMs: Date.now() - started,
      exchangesDistinct: exchanges.length,
      lastClosed1h: lastClosedRows[0]?.t ?? null
    };
  } catch (error) {
    console.error(
      "[admin] Ошибка загрузки сводки:",
      error
    );

    data = null;
  }

  const published =
    data?.strategies.filter(
      (s) =>
        s.status === "PUBLISHED" &&
        s.enabled
    ).length ?? 0;

  return (
    <main className="adminPage">
      <AdminNav active="overview" />

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
            <b>
              {data
                ? data.assets
                : "—"}
            </b>
            <small>
              основной universe анализа
            </small>
          </div>

          <div className="adminStatCard">
            <span>Рынков Top-100</span>
            <b>
              {data
                ? data.universeMarkets.toLocaleString(
                    "ru-RU"
                  )
                : "—"}
            </b>
            <small>
              активные SPOT USDT-рынки активов
              Top-100; всего активных в БД:{" "}
              {data
                ? data.markets.toLocaleString(
                    "ru-RU"
                  )
                : "—"}
            </small>
          </div>

          <div className="adminStatCard">
            <span>Свечей в БД</span>
            <b>
              {data
                ? data.candleCount.toLocaleString(
                    "ru-RU"
                  )
                : "—"}
            </b>
            <small>
              сохранённая история OHLCV
            </small>
          </div>

          <div className="adminStatCard">
            <span>Активных сигналов</span>
            <b>
              {data ? data.signals : "—"}
            </b>
            <small>
              {data && data.signals === 0
                ? "Signal Engine не развёрнут"
                : "по активным стратегиям"}
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
            {!data || data.strategies.length === 0 ? (
              <div className="adminEmpty">
                Стратегии пока не созданы.
              </div>
            ) : (
              data?.strategies.map(
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
              <span
                className={`statusDot ${
                  data ? "statusGreen" : "statusRed"
                }`}
              />
              <p>
                <b>PostgreSQL</b>
                <small>
                  {data && data.dbLatencyMs !== null
                    ? `Отвечает (SELECT 1, ${data.dbLatencyMs} мс)`
                    : "Нет ответа — см. Мониторинг"}
                </small>
              </p>
            </div>

            <div>
              <span
                className={`statusDot ${
                  data &&
                  data.exchangesDistinct > 0
                    ? "statusGreen"
                    : "statusYellow"
                }`}
              />
              <p>
                <b>Биржи (данные в БД)</b>
                <small>
                  {data
                    ? `${data.exchangesDistinct} бирж с активными SPOT USDT-рынками (это не статус API бирж)`
                    : "нет данных"}
                </small>
              </p>
            </div>

            <div>
              <span className="statusDot statusYellow" />

              <p>
                <b>OHLCV Worker</b>
                <small>
                  Состояние процесса не
                  отслеживается (web не имеет
                  безопасного доступа к PM2).
                  Последняя закрытая 1h-свеча:{" "}
                  {data?.lastClosed1h
                    ? data.lastClosed1h.toLocaleString(
                        "ru-RU",
                        {
                          timeZone: "UTC",
                          day: "2-digit",
                          month: "2-digit",
                          hour: "2-digit",
                          minute: "2-digit"
                        }
                      ) + " UTC"
                    : "—"}
                </small>
              </p>
            </div>

            <div>
              <span className="statusDot statusYellow" />

              <p>
                <b>Signal Engine</b>
                <small>
                  Не развёрнут. Записей Signal в
                  базе: {data ? data.signals : "—"}
                </small>
              </p>
            </div>
          </div>

          <p className="muted healthNote">
            Подробные измеримые состояния — на странице
            «Мониторинг»: замер PostgreSQL, свежесть
            закрытых свечей по таймфреймам, счётчики.
          </p>
        </section>
      </section>
    </main>
  );
}
