import AdminNav from "@/components/admin/AdminNav";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * «Рынки» — реальные Market из PostgreSQL: поиск/фильтр
 * по бирже и символу (через URL searchParams), пагинация,
 * свечная coverage по выбранным рынкам (агрегат только
 * по 50 id страницы — без тяжёлых выборок). Read-only,
 * ADMIN-only. Arena implementation — требуется VPS
 * runtime verification.
 */

const EXCHANGES = [
  "BINANCE",
  "BYBIT",
  "GATE",
  "KUCOIN",
  "BINGX"
];

const PAGE_SIZE = 50;

type MarketRow = {
  id: number;
  exchange: string;
  exchangeSymbol: string;
  base: string;
  quote: string;
  marketType: string;
  status: string;
  enabled: boolean;
  lastSyncAt: Date | null;
};

type CandleAgg = {
  marketId: number;
  timeframe: string;
  candles: number;
  lastClosed: Date | null;
};

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

export default async function AdminMarketsPage({
  searchParams
}: {
  searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  if (session.user.role !== "ADMIN") {
    redirect("/");
  }

  const query = await searchParams;

  const exchangeRaw =
    typeof query.exchange === "string"
      ? query.exchange.toUpperCase()
      : "";
  const exchange = EXCHANGES.includes(
    exchangeRaw
  )
    ? exchangeRaw
    : "";

  const qRaw =
    typeof query.q === "string"
      ? query.q.trim().toUpperCase().slice(0, 32)
      : "";
  const pageRaw = Number(query.page ?? "1");
  const page =
    Number.isInteger(pageRaw) &&
    pageRaw >= 1 &&
    pageRaw <= 1000
      ? pageRaw
      : 1;

  const where: {
    exchange?: string;
    exchangeSymbol?: { contains: string };
  } = {};

  if (exchange) {
    where.exchange = exchange;
  }

  if (qRaw) {
    where.exchangeSymbol = { contains: qRaw };
  }

  const [total, markets] = await Promise.all([
    prisma.market.count({ where }) as Promise<
      number
    >,
    (prisma.market.findMany({
      where,
      orderBy: [
        { exchange: "asc" },
        { exchangeSymbol: "asc" }
      ],
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      select: {
        id: true,
        exchange: true,
        exchangeSymbol: true,
        base: true,
        quote: true,
        marketType: true,
        status: true,
        enabled: true,
        lastSyncAt: true
      }
    })) as unknown as MarketRow[]
  ]);

  // coverage только для рынков текущей страницы
  const ids = markets.map((m) => m.id);

  const aggs =
    ids.length > 0
      ? ((await prisma.candle.groupBy({
          by: ["marketId", "timeframe"],
          where: {
            marketId: { in: ids },
            closed: true
          },
          _count: { _all: true },
          _max: { openTime: true }
        })) as unknown as {
          marketId: number;
          timeframe: string;
          _count: { _all: number };
          _max: { openTime: Date | null };
        }[])
      : [];

  const byMarket = new Map<
    number,
    string[]
  >();

  for (const agg of aggs) {
    const list = byMarket.get(agg.marketId) ?? [];
    const last = agg._max.openTime;

    list.push(
      `${agg.timeframe}×${agg._count._all}` +
        (last
          ? ` (закр. ${String(last.getUTCHours()).padStart(2, "0")}:${String(last.getUTCMinutes()).padStart(2, "0")})`
          : "")
    );

    byMarket.set(agg.marketId, list);
  }

  const totalPages = Math.max(
    1,
    Math.ceil(total / PAGE_SIZE)
  );

  const buildHref = (nextPage: number) => {
    const params = new URLSearchParams();

    if (exchange) {
      params.set("exchange", exchange);
    }

    if (qRaw) {
      params.set("q", qRaw);
    }

    if (nextPage > 1) {
      params.set("page", String(nextPage));
    }

    const qs = params.toString();

    return `/admin/markets${qs ? `?${qs}` : ""}`;
  };

  return (
    <main className="adminPage">
      <AdminNav active="markets" />

      <section className="adminDashboard">
        <div className="adminWelcome">
          <div>
            <div className="adminEyebrow">
              Диагностика
            </div>

            <h1>Рынки</h1>

            <p className="muted">
              Реальные Market из PostgreSQL:{" "}
              {total.toLocaleString("ru-RU")} по
              фильтру. Coverage свечей — агрегат только
              по рынкам текущей страницы. Read-only.
            </p>
          </div>
        </div>

        <form
          className="adminFilters"
          method="get"
        >
          <select
            name="exchange"
            defaultValue={exchange}
          >
            <option value="">
              Все биржи
            </option>

            {EXCHANGES.map((name) => (
              <option
                key={name}
                value={name}
              >
                {name}
              </option>
            ))}
          </select>

          <input
            type="text"
            name="q"
            defaultValue={qRaw}
            placeholder="Символ, напр. BTCUSDT"
          />

          <button
            type="submit"
            className="chip"
          >
            Применить
          </button>
        </form>

        <div className="tableBox">
          <table className="healthTable">
            <thead>
              <tr>
                <th>Биржа</th>
                <th>Символ</th>
                <th>Base/Quote</th>
                <th>Статус</th>
                <th>Свечи (по ТФ, закрытые)</th>
                <th>Синхронизация</th>
              </tr>
            </thead>

            <tbody>
              {markets.length === 0 && (
                <tr>
                  <td colSpan={6}>
                    Рынков по фильтру не найдено
                  </td>
                </tr>
              )}

              {markets.map((market) => (
                <tr key={market.id}>
                  <td>
                    {market.exchange}
                  </td>
                  <td>
                    {
                      market.exchangeSymbol
                    }
                  </td>
                  <td>
                    {market.base}/
                    {market.quote}
                  </td>
                  <td>
                    {market.enabled
                      ? market.status
                      : "Выключен"}
                  </td>
                  <td>
                    {(byMarket.get(
                      market.id
                    ) ?? []).join(", ") ||
                      "нет свечей"}
                  </td>
                  <td>
                    {fmtUtc(
                      market.lastSyncAt
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="adminPagination muted">
          Страница {page} из {totalPages}

          {page > 1 && (
            <a
              href={buildHref(page - 1)}
              className="chip"
            >
              ← Назад
            </a>
          )}

          {page < totalPages && (
            <a
              href={buildHref(page + 1)}
              className="chip"
            >
              Вперёд →
            </a>
          )}
        </div>
      </section>
    </main>
  );
}
