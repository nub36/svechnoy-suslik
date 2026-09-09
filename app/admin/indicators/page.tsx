import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import {
  candleFreshness
} from "@/lib/data/freshness";

export const dynamic = "force-dynamic";

/**
 * «Индикаторы» — реальные IndicatorSnapshot из PostgreSQL.
 *
 * Агрегаты по таймфреймам (COUNT / MAX / GROUP BY) +
 * 20 последних снапшотов с реальными значениями полей.
 * Никаких придуманных indicator values. Read-only,
 * ADMIN-only. Arena implementation — требуется VPS
 * runtime verification.
 */

const TIMEFRAME_LABELS: Record<string, string> = {
  "5m": "5 минут",
  "15m": "15 минут",
  "1h": "1 час",
  "4h": "4 часа",
  "1d": "1 день"
};

function timeframeLabel(tf: string): string {
  return TIMEFRAME_LABELS[tf] ?? tf;
}

function fmtUtc(date: Date | null): string {
  if (!date) {
    return "—";
  }

  return (
    date.toLocaleString("ru-RU", {
      timeZone: "UTC",
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    }) + " UTC"
  );
}

function fmtNum(
  value: number | null | undefined
): string {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: 6
  });
}

type TfRow = {
  timeframe: string;
  total: number;
  markets: number;
  lastCandleTime: Date | null;
  lastCalculatedAt: Date | null;
};

type RecentRow = {
  timeframe: string;
  candleTime: Date;
  calculatedAt: Date;
  price: number | null;
  rsi14: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  macd: number | null;
  market: {
    exchange: string;
    exchangeSymbol: string;
  } | null;
};

export default async function AdminIndicatorsPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const tfRows = (await prisma
    .$queryRaw<TfRow[]>`
      SELECT
        s.timeframe AS "timeframe",
        COUNT(*)::int AS "total",
        COUNT(DISTINCT s."marketId")::int AS "markets",
        MAX(s."candleTime") AS "lastCandleTime",
        MAX(s."calculatedAt") AS "lastCalculatedAt"
      FROM "IndicatorSnapshot" s
      GROUP BY s.timeframe
      ORDER BY s.timeframe
    `) as unknown as TfRow[];

  const recent = (await prisma
    .indicatorSnapshot.findMany({
      orderBy: { calculatedAt: "desc" },
      take: 20,
      select: {
        timeframe: true,
        candleTime: true,
        calculatedAt: true,
        price: true,
        rsi14: true,
        ema20: true,
        ema50: true,
        ema200: true,
        macd: true,
        market: {
          select: {
            exchange: true,
            exchangeSymbol: true
          }
        }
      }
    })) as unknown as RecentRow[];

  const total = tfRows.reduce(
    (sum, row) => sum + row.total,
    0
  );

  return (
    <main className="adminPage">
      <AdminNav active="indicators" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Диагностика
            </div>

            <h1>Индикаторы</h1>

            <p className="muted">
              Реальные IndicatorSnapshot из PostgreSQL:
              агрегаты по таймфреймам и последние
              снапшоты. Все значения — из базы, ничего
              не придумано. Свежесть считается по
              candleTime снапшота.
            </p>
          </div>
        </div>

        <h2 className="healthSectionTitle">
          Снапшоты по таймфреймам
          {total > 0
            ? ` — всего ${total.toLocaleString("ru-RU")}`
            : ""}
        </h2>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Таймфрейм</th>
                <th>Снапшотов</th>
                <th>Рынков</th>
                <th>Последний candleTime</th>
                <th>Актуальность</th>
                <th>Рассчитан в последний раз</th>
              </tr>
            </thead>

            <tbody>
              {tfRows.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    Снапшотов пока нет — запустите
                    snapshot worker (см. /admin/data)
                  </td>
                </tr>
              )}

              {tfRows.map((row) => {
                const freshness =
                  candleFreshness(
                    row.timeframe,
                    row.lastCandleTime,
                    new Date()
                  );

                return (
                  <tr key={row.timeframe}>
                    <td>
                      {timeframeLabel(
                        row.timeframe
                      )}
                    </td>
                    <td>
                      {fmtNum(row.total)}
                    </td>
                    <td>
                      {fmtNum(row.markets)}
                    </td>
                    <td>
                      {fmtUtc(
                        row.lastCandleTime
                      )}
                    </td>
                    <td>
                      <span
                        className={`freshBadge ${freshness.status}`}
                      >
                        {freshness.label}
                      </span>
                    </td>
                    <td>
                      {fmtUtc(
                        row.lastCalculatedAt
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <h2 className="healthSectionTitle">
          Последние снапшоты (20, реальные значения)
        </h2>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Рынок</th>
                <th>ТФ</th>
                <th>candleTime</th>
                <th>Price</th>
                <th>RSI14</th>
                <th>EMA20</th>
                <th>EMA50</th>
                <th>EMA200</th>
                <th>MACD</th>
              </tr>
            </thead>

            <tbody>
              {recent.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    Снапшотов пока нет
                  </td>
                </tr>
              )}

              {recent.map(
                (row, index) => (
                  <tr key={index}>
                    <td>
                      {row.market
                        ? `${row.market.exchange} · ${row.market.exchangeSymbol}`
                        : "—"}
                    </td>
                    <td>
                      {row.timeframe}
                    </td>
                    <td>
                      {fmtUtc(
                        row.candleTime
                      )}
                    </td>
                    <td>
                      {fmtNum(row.price)}
                    </td>
                    <td>
                      {fmtNum(row.rsi14)}
                    </td>
                    <td>
                      {fmtNum(row.ema20)}
                    </td>
                    <td>
                      {fmtNum(row.ema50)}
                    </td>
                    <td>
                      {fmtNum(row.ema200)}
                    </td>
                    <td>
                      {fmtNum(row.macd)}
                    </td>
                  </tr>
                )
              )}
            </tbody>
          </table>
        </div>

        <p className="muted healthNote">
          Поля снапшота, которых нет в конкретной записи
          (null), показываются как «—». Страница только
          читает базу; worker'ы из веба не запускаются.
        </p>
      </section>
    </main>
  );
}
