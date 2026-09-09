import CandleChart from "@/components/chart/CandleChart";

export const dynamic = "force-dynamic";

function fmtTime(date: Date): string {
  return (
    date.toISOString().replace("T", " ").slice(0, 16) +
    " UTC"
  );
}

export default async function CoinPage({
  params
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol: raw } = await params;

  const symbol = decodeURIComponent(raw)
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
    return (
      <main className="shell">
        <section className="hero">
          <div>
            <h1>Неверный тикер</h1>
            <div className="muted">
              «{raw}» не похож на тикер актива.
            </div>
          </div>
        </section>
      </main>
    );
  }

  let info:
    | {
        name: string | null;
        rank: number | null;
        exchanges: string[];
        timeframes: string[];
        lastCandleTime: Date | null;
        signalCount: number;
      }
    | null = null;

  let dbError = false;

  try {
    // Ленивый импорт: недоступность клиента Prisma
    // даёт честное «Нет данных», а не падение страницы.
    const { prisma } = await import(
      "@/lib/prisma"
    );

    const asset = await prisma.asset.findUnique({
      where: { symbol },
      select: { name: true, rank: true }
    });

    if (asset) {
      const markets: { exchange: string }[] =
        await prisma.market.findMany({
          where: {
            assetId: asset.id,
            enabled: true,
            status: "ACTIVE",
            quote: "USDT",
            marketType: "SPOT",
            candles: { some: {} }
          },
          select: {
            exchange: true
          },
          orderBy: { exchange: "asc" }
        });

      const grouped: { timeframe: string; _max: { openTime: Date | null } }[] =
        await prisma.candle.groupBy({
          by: ["timeframe"],
          where: {
            market: { assetId: asset.id }
          },
          _max: { openTime: true }
        });

      const signalCount =
        await prisma.signal.count({
          where: {
            symbol,
            status: "ACTIVE"
          }
        });

      const lastTimes = grouped
        .map(
          (g: { _max: { openTime: Date | null } }) =>
            g._max.openTime
        )
        .filter(
          (t): t is Date => t !== null
        );

      info = {
        name: asset.name,
        rank: asset.rank,
        exchanges: markets.map(
          (m) => m.exchange
        ),
        timeframes: grouped
          .map(
            (g: { timeframe: string }) =>
              g.timeframe
          )
          .sort(),
        lastCandleTime:
          lastTimes.length > 0
            ? lastTimes.reduce((a: Date, b: Date) =>
                a.getTime() > b.getTime()
                  ? a
                  : b
              )
            : null,
        signalCount
      };
    }
  } catch {
    dbError = true;
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>
            {symbol}
            /USDT
            {info?.name ? ` · ${info.name}` : ""}
          </h1>

          <div className="muted">
            График по закрытым свечам из PostgreSQL.
            Индикаторы: EMA, SMA, RSI, MACD, объём.
          </div>
        </div>
      </section>

      {info ? (
        <div className="cards">
          <div className="card">
            <div className="cardTitle">
              Биржи с данными
            </div>

            <div className="bigValue">
              {info.exchanges.length > 0
                ? info.exchanges.length
                : "—"}
            </div>

            <span className="muted">
              {info.exchanges.length > 0
                ? info.exchanges.join(", ")
                : "Рынков со свечами нет"}
            </span>
          </div>

          <div className="card">
            <div className="cardTitle">
              Таймфреймы
            </div>

            <div className="bigValue">
              {info.timeframes.length > 0
                ? info.timeframes
                    .map((tf) =>
                      tf.toUpperCase()
                    )
                    .join(" · ")
                : "—"}
            </div>
          </div>

          <div className="card">
            <div className="cardTitle">
              Последняя закрытая свеча
            </div>

            <div className="bigValue" style={{ fontSize: "1rem" }}>
              {info.lastCandleTime
                ? fmtTime(
                    info.lastCandleTime
                  )
                : "—"}
            </div>
          </div>

          <div className="card">
            <div className="cardTitle">
              Активные сигналы
            </div>

            <div className="bigValue">
              {info.signalCount > 0
                ? info.signalCount
                : "Нет"}
            </div>

            <span className="muted">
              {info.signalCount > 0
                ? "По всем стратегиям"
                : "Signal Engine ещё не запускался в продакшн"}
            </span>
          </div>
        </div>
      ) : (
        <div className="tableBox" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ padding: "1rem" }}>
            {dbError
              ? "Нет данных: база временно недоступна."
              : `Нет данных: актива ${symbol} нет в базе. Прогоните rank-assets и OHLCV worker.`}
          </p>
        </div>
      )}

      <CandleChart initialSymbol={symbol} />
    </main>
  );
}
