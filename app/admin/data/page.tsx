import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import {
  ALLOWED_TIMEFRAMES
} from "@/lib/ohlcv/cli";
import {
  candleFreshness,
  planCommandForTimeframe
} from "@/lib/data/freshness";

export const dynamic = "force-dynamic";

/**
 * «Состояние данных» — диагностическая страница админки.
 *
 * ТОЛЬКО чтение: агрегаты PostgreSQL (COUNT / MIN / MAX /
 * GROUP BY) через эффективные запросы; Candle и
 * IndicatorSnapshot в Node.js НЕ загружаются.
 *
 * $queryRaw вызывается строго членом объекта
 * (prisma.$queryRaw<T>`...`), без Unsafe-вариантов —
 * проверяется scripts/test-chart-sql.ts.
 *
 * Доступ: только ADMIN (существующая Auth.js защита).
 * Никаких env/DATABASE_URL/stack trace не выводится.
 *
 * Arena implementation — требуется VPS runtime verification.
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

function fmtInt(value: number | null): string {
  if (value === null) {
    return "—";
  }

  return value.toLocaleString("ru-RU");
}

type ExchangeRow = {
  exchange: string;
  total: number;
  activeSpotUsdt: number;
};

type CandleTfRow = {
  timeframe: string;
  total: number;
  closed: number;
  open: number;
  markets: number;
  firstCandle: Date | null;
  lastCandle: Date | null;
};

type SnapshotTfRow = {
  timeframe: string;
  total: number;
  markets: number;
  lastCandleTime: Date | null;
};

async function loadHealthData() {
  const now = new Date();

  const [
    assetsTotal,
    assetsEnabled,
    assetsTop500,
    assetsRanked,
    rankedUpdatedAt,
    marketRows,
    candleRows,
    snapshotRows,
    top10DenominatorRow
  ] = await Promise.all([
    // Явные аннотации: файл остаётся типобезопасным
    // и на stub-клиенте песочницы.
    prisma.asset.count(),
    prisma.asset.count({
      where: { enabled: true }
    }),
    prisma.asset.count({
      where: { top500: true }
    }),
    prisma.asset.count({
      where: { rank: { not: null } }
    }),
    prisma.asset.aggregate({
      where: { rank: { not: null } },
      _max: { updatedAt: true }
    }) as Promise<{
      _max: { updatedAt: Date | null };
    }>,
    // Рынки по биржам (FILTER — всё в одном проходе);
    // переменные ниже аннотированы явно
    prisma.$queryRaw<ExchangeRow[]>`
      SELECT
        m.exchange AS "exchange",
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (
          WHERE m.enabled = true
            AND m.status = 'ACTIVE'
            AND m.quote = 'USDT'
            AND m."marketType" = 'SPOT'
        )::int AS "activeSpotUsdt"
      FROM "Market" m
      GROUP BY m.exchange
      ORDER BY m.exchange
    ` as unknown as ExchangeRow[],
    // Свечи по таймфреймам
    prisma.$queryRaw<CandleTfRow[]>`
      SELECT
        c.timeframe AS "timeframe",
        COUNT(*)::int AS "total",
        COUNT(*) FILTER (WHERE c.closed = true)::int AS "closed",
        COUNT(*) FILTER (WHERE c.closed = false)::int AS "open",
        COUNT(DISTINCT c."marketId")::int AS "markets",
        MIN(c."openTime") AS "firstCandle",
        MAX(c."openTime") AS "lastCandle"
      FROM "Candle" c
      GROUP BY c.timeframe
    ` as unknown as CandleTfRow[],
    // Снапшоты по таймфреймам
    prisma.$queryRaw<SnapshotTfRow[]>`
      SELECT
        s.timeframe AS "timeframe",
        COUNT(*)::int AS "total",
        COUNT(DISTINCT s."marketId")::int AS "markets",
        MAX(s."candleTime") AS "lastCandleTime"
      FROM "IndicatorSnapshot" s
      GROUP BY s.timeframe
    ` as unknown as SnapshotTfRow[],
    // Знаменатель coverage Top-10: активные SPOT USDT рынки топ-10 активов
    prisma.$queryRaw<{ markets: number }[]>`
      SELECT COUNT(*)::int AS "markets"
      FROM "Market" m
      JOIN "Asset" a ON a.id = m."assetId"
      WHERE a."rank" IS NOT NULL
        AND a."rank" <= ${10}
        AND a.enabled = true
        AND m.enabled = true
        AND m.status = 'ACTIVE'
        AND m.quote = 'USDT'
        AND m."marketType" = 'SPOT'
    ` as unknown as { markets: number }[]
  ]);

  // coverage Top-10: рынки топ-10 активов, у которых есть свечи
  const top10Numerator = (await prisma
    .$queryRaw<{ timeframe: string; markets: number }[]>`
      SELECT
        c.timeframe AS "timeframe",
        COUNT(DISTINCT c."marketId")::int AS "markets"
      FROM "Candle" c
      JOIN "Market" m ON m.id = c."marketId"
      JOIN "Asset" a ON a.id = m."assetId"
      WHERE a."rank" IS NOT NULL
        AND a."rank" <= ${10}
        AND a.enabled = true
        AND m.enabled = true
        AND m.status = 'ACTIVE'
        AND m.quote = 'USDT'
        AND m."marketType" = 'SPOT'
      GROUP BY c.timeframe
    `) as unknown as {
    timeframe: string;
    markets: number;
  }[];

  // Итог по свечам — сумма по таймфреймам (каждая свеча имеет ТФ)
  const candleTotals = candleRows.reduce(
    (acc, row) => ({
      total: acc.total + row.total,
      closed: acc.closed + row.closed,
      open: acc.open + row.open
    }),
    { total: 0, closed: 0, open: 0 }
  );

  const activeSpotUsdtTotal = marketRows.reduce(
    (sum, row) => sum + row.activeSpotUsdt,
    0
  );

  const candleByTf = new Map(
    candleRows.map((row) => [row.timeframe, row])
  );

  const top10ByTf = new Map(
    top10Numerator.map((row) => [
      row.timeframe,
      row.markets
    ])
  );

  const snapshotByTf = new Map(
    snapshotRows.map((row) => [row.timeframe, row])
  );

  const missingTimeframes = ALLOWED_TIMEFRAMES.filter(
    (tf) => !candleByTf.has(tf)
  );

  return {
    now,
    assets: {
      total: assetsTotal,
      enabled: assetsEnabled,
      top500: assetsTop500,
      ranked: assetsRanked,
      rankedUpdatedAt:
        rankedUpdatedAt._max.updatedAt ?? null
    },
    marketRows,
    activeSpotUsdtTotal,
    candleRows,
    candleTotals,
    snapshotRows,
    candleByTf,
    snapshotByTf,
    top10ByTf,
    top10Denominator:
      top10DenominatorRow[0]?.markets ?? 0,
    missingTimeframes
  };
}

export default async function AdminDataPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const data = await loadHealthData();

  return (
    <main className="adminPage">
      <aside className="adminNavigation">
        <div className="adminNavTitle">
          Администрирование
        </div>

        <Link href="/admin">
          ← Обзор
        </Link>

        <Link
          href="/admin/data"
          className="adminNavActive"
        >
          Состояние данных
        </Link>
      </aside>

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Диагностика
            </div>

            <h1>Состояние данных</h1>

            <p className="muted">
              Реальные агрегаты PostgreSQL (COUNT /
              MIN / MAX / GROUP BY). Свечи и снапшоты
              в Node не загружаются. Страница только
              читает базу и показывает команды —
              worker'ы отсюда НЕ запускаются.
            </p>
          </div>
        </div>

        {/* ---------- АКТИВЫ ---------- */}

        <h2 className="healthSectionTitle">
          Активы
        </h2>

        <div className="healthGrid">
          <div className="healthCard">
            <div className="healthValue">
              {fmtInt(data.assets.total)}
            </div>
            <div className="healthLabel">
              всего Asset
            </div>
          </div>

          <div className="healthCard">
            <div className="healthValue">
              {fmtInt(data.assets.enabled)}
            </div>
            <div className="healthLabel">
              включено (enabled)
            </div>
          </div>

          <div className="healthCard">
            <div className="healthValue">
              {fmtInt(data.assets.top500)}
            </div>
            <div className="healthLabel">
              Суслик Top-500
            </div>
          </div>

          <div className="healthCard">
            <div className="healthValue">
              {fmtInt(data.assets.ranked)}
            </div>
            <div className="healthLabel">
              с местом в рейтинге
            </div>
          </div>
        </div>

        <p className="muted healthNote">
          Рейтинг: заполнен у {fmtInt(data.assets.ranked)} из{" "}
          {fmtInt(data.assets.total)}; последнее обновление
          записи актива (updatedAt):{" "}
          {fmtUtc(data.assets.rankedUpdatedAt)}.
          Точное время прогона rank-assets не хранится
          в схеме — используется updatedAt.
        </p>

        {/* ---------- РЫНКИ ---------- */}

        <h2 className="healthSectionTitle">
          Рынки
        </h2>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Биржа</th>
                <th>Всего рынков</th>
                <th>Активные SPOT USDT</th>
              </tr>
            </thead>

            <tbody>
              {data.marketRows.map((row) => (
                <tr key={row.exchange}>
                  <td>{row.exchange}</td>
                  <td>{fmtInt(row.total)}</td>
                  <td>
                    {fmtInt(row.activeSpotUsdt)}
                  </td>
                </tr>
              ))}

              <tr className="healthTotalRow">
                <td>Итого</td>
                <td>
                  {fmtInt(
                    data.marketRows.reduce(
                      (s, r) => s + r.total,
                      0
                    )
                  )}
                </td>
                <td>
                  {fmtInt(
                    data.activeSpotUsdtTotal
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* ---------- CANDLE ---------- */}

        <h2 className="healthSectionTitle">
          Свечи (Candle)
        </h2>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Таймфрейм</th>
                <th>Всего</th>
                <th>Закрытых</th>
                <th>Открытых</th>
                <th>Рынков со свечами</th>
                <th>Первая свеча</th>
                <th>Последняя свеча</th>
                <th>Свежесть</th>
              </tr>
            </thead>

            <tbody>
              {data.candleRows.length === 0 && (
                <tr>
                  <td colSpan={8}>
                    Свечей в базе пока нет —
                    запустите OHLCV worker (см.
                    команды ниже)
                  </td>
                </tr>
              )}

              {data.candleRows.map((row) => {
                const freshness =
                  candleFreshness(
                    row.timeframe,
                    row.lastCandle,
                    data.now
                  );

                return (
                  <tr
                    key={row.timeframe}
                  >
                    <td>
                      {timeframeLabel(
                        row.timeframe
                      )}
                    </td>
                    <td>
                      {fmtInt(row.total)}
                    </td>
                    <td>
                      {fmtInt(row.closed)}
                    </td>
                    <td>
                      {fmtInt(row.open)}
                    </td>
                    <td>
                      {fmtInt(row.markets)}
                    </td>
                    <td>
                      {fmtUtc(
                        row.firstCandle
                      )}
                    </td>
                    <td>
                      {fmtUtc(
                        row.lastCandle
                      )}
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

              {data.candleRows.length > 0 && (
                <tr className="healthTotalRow">
                  <td>Итого</td>
                  <td>
                    {fmtInt(
                      data.candleTotals.total
                    )}
                  </td>
                  <td>
                    {fmtInt(
                      data.candleTotals.closed
                    )}
                  </td>
                  <td>
                    {fmtInt(
                      data.candleTotals.open
                    )}
                  </td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <p className="muted healthNote">
          Свежесть рассчитывается относительно длительности
          таймфрейма: АКТУАЛЬНО — последняя закрытая свеча не
          старше 2 интервалов, ЗАДЕРЖКА — не старше 6,
          иначе УСТАРЕЛО. 1-дневная свеча возрастом даже
          несколько часов считается актуальной.
        </p>

        {/* ---------- SNAPSHOT ---------- */}

        <h2 className="healthSectionTitle">
          Снапшоты индикаторов (IndicatorSnapshot)
        </h2>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Таймфрейм</th>
                <th>Всего</th>
                <th>Рынков со снапшотами</th>
                <th>
                  Последний candleTime
                </th>
              </tr>
            </thead>

            <tbody>
              {data.snapshotRows.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    Снапшотов пока нет — запустите
                    snapshot worker
                  </td>
                </tr>
              )}

              {data.snapshotRows.map((row) => (
                <tr
                  key={row.timeframe}
                >
                  <td>
                    {timeframeLabel(
                      row.timeframe
                    )}
                  </td>
                  <td>
                    {fmtInt(row.total)}
                  </td>
                  <td>
                    {fmtInt(row.markets)}
                  </td>
                  <td>
                    {fmtUtc(
                      row.lastCandleTime
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ---------- COVERAGE ---------- */}

        <h2 className="healthSectionTitle">
          Покрытие (coverage рынков)
        </h2>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Таймфрейм</th>
                <th>
                  Рынков со свечами / активных
                  SPOT USDT
                </th>
                <th>Покрытие рынков</th>
                <th>
                  Top-10 (рынки)
                </th>
              </tr>
            </thead>

            <tbody>
              {ALLOWED_TIMEFRAMES.map((tf) => {
                const row =
                  data.candleByTf.get(tf);
                const markets =
                  row?.markets ?? 0;
                const percent =
                  data.activeSpotUsdtTotal > 0
                    ? Math.round(
                        (markets /
                          data.activeSpotUsdtTotal) *
                          100
                      )
                    : 0;
                const top10 =
                  data.top10ByTf.get(tf) ?? 0;

                return (
                  <tr key={tf}>
                    <td>
                      {timeframeLabel(tf)}
                    </td>
                    <td>
                      {fmtInt(markets)} /{" "}
                      {fmtInt(
                        data.activeSpotUsdtTotal
                      )}
                    </td>
                    <td>{percent}%</td>
                    <td>
                      {fmtInt(top10)} /{" "}
                      {fmtInt(
                        data.top10Denominator
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="muted healthNote">
          Это coverage РЫНКОВ (доля активных SPOT USDT-рынков,
          по которым есть свечи), а не активов: один актив
          торгуется на нескольких биржах. Top-10 — то же
          отношение среди рынков десяти топ-активов.
        </p>

        {/* ---------- КОМАНДЫ ---------- */}

        <h2 className="healthSectionTitle">
          Рекомендуемые команды
        </h2>

        {data.missingTimeframes.length === 0 ? (
          <p className="muted healthNote">
            Все таймфреймы (5m, 15m, 1h, 4h, 1d) имеют
            свечи.
          </p>
        ) : (
          <div className="healthCommands">
            <p className="muted">
              Для следующих таймфреймов свечей нет:{" "}
              {data.missingTimeframes.join(", ")}. Сначала
              посмотрите план (PostgreSQL не изменяется, API
              бирж не вызываются):
            </p>

            {data.missingTimeframes.map((tf) => (
              <code
                key={tf}
                className="healthCommand"
              >
                {planCommandForTimeframe(tf)}
              </code>
            ))}

            <p className="muted">
              Команды НЕ выполняются автоматически —
              веб-запуск worker'ов из админки отключён
              сознательно (безопасность). Скопируйте и
              выполните на сервере вручную.
            </p>
          </div>
        )}
      </section>
    </main>
  );
}
