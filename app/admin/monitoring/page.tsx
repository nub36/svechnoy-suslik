import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import { candleFreshness } from "@/lib/data/freshness";

export const dynamic = "force-dynamic";

/**
 * «Мониторинг» — только реально измеримые состояния.
 *
 * - PostgreSQL: замер SELECT 1 с задержкой;
 * - счётчики PostgreSQL (universe/рынки/свечи/снапшоты);
 * - свежесть свечей по таймфреймам — ТОЛЬКО по закрытым;
 * - OHLCV worker: web НЕ имеет безопасного доступа к
 *   PM2/процессам, поэтому состояние процесса честно
 *   помечено как не отслеживаемое (показывается свежесть
 *   закрытых данных, а НЕ выдуманный «запущен»);
 * - Signal Engine: не развёрнут.
 *
 * Наличие старых свечей НЕ считается доказательством
 * запущенного worker. Read-only, ADMIN-only.
 */

function fmtUtc(date: Date | null): string {
  if (!date) {
    return "—";
  }

  return (
    date.toLocaleString("ru-RU", {
      timeZone: "UTC",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    }) + " UTC"
  );
}

type CandleTf = {
  timeframe: string;
  total: number;
  markets: number;
  lastClosed: Date | null;
  lastOpen: Date | null;
};

export default async function AdminMonitoringPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  // 1. Замер PostgreSQL (SELECT 1 + задержка).
  let dbLatencyMs: number | null = null;
  let dbError: string | null = null;

  try {
    const started = Date.now();

    await prisma.$queryRaw`SELECT 1`;

    dbLatencyMs = Date.now() - started;
  } catch (error) {
    dbError =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "нет ответа";
  }

  // 2. Счётчики и свежесть (только если БД отвечает).
  let counts: {
    universe: number;
    marketsActive: number;
    candles: number;
    snapshots: number;
  } | null = null;

  let candleTf: CandleTf[] = [];

  if (dbError === null) {
    const [universe, marketsActive, candles, snapshots, tfRows] =
      await Promise.all([
        prisma.asset.count({
          where: {
            enabled: true,
            rank: { lte: 100, not: null }
          }
        }),
        prisma.market.count({
          where: {
            enabled: true,
            status: "ACTIVE",
            quote: "USDT",
            marketType: "SPOT"
          }
        }),
        prisma.candle.count(),
        prisma.indicatorSnapshot.count(),
        (prisma.$queryRaw<CandleTf[]>`
          SELECT
            c.timeframe AS "timeframe",
            COUNT(*)::int AS "total",
            COUNT(DISTINCT c."marketId")::int AS "markets",
            MAX(c."openTime") FILTER (WHERE c.closed = true) AS "lastClosed",
            MAX(c."openTime") FILTER (WHERE c.closed = false) AS "lastOpen"
          FROM "Candle" c
          GROUP BY c.timeframe
          ORDER BY c.timeframe
        `) as unknown as CandleTf[]
      ]);

    counts = {
      universe,
      marketsActive,
      candles,
      snapshots
    };
    candleTf = tfRows;
  }

  return (
    <main className="adminPage">
      <AdminNav active="monitoring" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Диагностика
            </div>

            <h1>Мониторинг</h1>

            <p className="muted">
              Только реально измеримые состояния.
              Наличие исторических свечей НЕ считается
              доказательством работы worker'а прямо
              сейчас.
            </p>
          </div>
        </div>

        <div className="engineStatusGrid">
          <div>
            <span
              className={`statusDot ${
                dbError === null
                  ? "statusGreen"
                  : "statusRed"
              }`}
            />
            <p>
              <b>PostgreSQL</b>
              <small>
                {dbError === null
                  ? `Отвечает (SELECT 1, ${dbLatencyMs} мс)`
                  : `Нет ответа: ${dbError}`}
              </small>
            </p>
          </div>

          <div>
            <span
              className={`statusDot ${
                counts &&
                counts.candles > 0
                  ? "statusGreen"
                  : "statusYellow"
              }`}
            />
            <p>
              <b>Данные свечей</b>
              <small>
                {counts
                  ? `${counts.candles.toLocaleString("ru-RU")} свечей в БД`
                  : "нет данных"}
              </small>
            </p>
          </div>

          <div>
            <span className="statusDot statusYellow" />
            <p>
              <b>OHLCV Worker</b>
              <small>
                Состояние процесса не отслеживается
                (web не имеет безопасного доступа к
                PM2). Свежесть закрытых свечей — см.
                ниже.
              </small>
            </p>
          </div>

          <div>
            <span className="statusDot statusYellow" />
            <p>
              <b>Signal Engine</b>
              <small>
                Не развёрнут. Автоматическое включение
                не предусмотрено.
              </small>
            </p>
          </div>
        </div>

        {counts && (
          <>
            <h2 className="healthSectionTitle">
              Счётчики PostgreSQL
            </h2>

            <div className="healthGrid">
              <div className="healthCard">
                <div className="healthValue">
                  {counts.universe.toLocaleString("ru-RU")}
                </div>
                <div className="healthLabel">
                  Top-100 universe
                </div>
              </div>

              <div className="healthCard">
                <div className="healthValue">
                  {counts.marketsActive.toLocaleString("ru-RU")}
                </div>
                <div className="healthLabel">
                  активных SPOT USDT-рынков
                </div>
              </div>

              <div className="healthCard">
                <div className="healthValue">
                  {counts.candles.toLocaleString("ru-RU")}
                </div>
                <div className="healthLabel">
                  свечей
                </div>
              </div>

              <div className="healthCard">
                <div className="healthValue">
                  {counts.snapshots.toLocaleString("ru-RU")}
                </div>
                <div className="healthLabel">
                  снапшотов индикаторов
                </div>
              </div>
            </div>

            <h2 className="healthSectionTitle">
              Свежесть закрытых свечей
            </h2>

            <div className="tableBox">
              <table className="healthTable">
                <thead>
                  <tr>
                    <th>Таймфрейм</th>
                    <th>Свечей</th>
                    <th>Рынков</th>
                    <th>Последняя закрытая</th>
                    <th>Текущая открытая</th>
                    <th>Свежесть (по закрытой)</th>
                  </tr>
                </thead>

                <tbody>
                  {candleTf.length === 0 && (
                    <tr>
                      <td colSpan={6}>
                        Свечей в базе пока нет
                      </td>
                    </tr>
                  )}

                  {candleTf.map((row) => {
                    const freshness =
                      candleFreshness(
                        row.timeframe,
                        row.lastClosed,
                        new Date()
                      );

                    return (
                      <tr key={row.timeframe}>
                        <td>
                          {row.timeframe}
                        </td>
                        <td>
                          {row.total.toLocaleString("ru-RU")}
                        </td>
                        <td>{row.markets}</td>
                        <td>
                          {fmtUtc(row.lastClosed)}
                        </td>
                        <td>
                          {fmtUtc(row.lastOpen)}
                        </td>
                        <td>
                          <span
                            className={`freshBadge ${freshness.status}`}
                          >
                            {freshness.label}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <p className="muted healthNote">
          Проверки процессов (PM2 status) и API бирж из
          веба сознательно НЕ выполняются: это либо
          требует shell-доступа из HTTP (запрещено
          политикой безопасности), либо создаёт
          исходящий трафик к биржам из admin-страниц.
        </p>
      </section>
    </main>
  );
}
