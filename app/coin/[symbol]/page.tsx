import CandleChart from "@/components/chart/CandleChart";
import { newestClosedCandleTime } from "@/lib/data/freshness";
import { isInTopUniverse } from "@/lib/universe";

export const dynamic = "force-dynamic";

const TIMEFRAME_ORDER = ["5m", "15m", "1h", "4h", "1d"];
const TIMEFRAME_LABELS: Record<string, string> = {
  "5m": "5 минут",
  "15m": "15 минут",
  "1h": "1 час",
  "4h": "4 часа",
  "1d": "1 день",
};

function timeframeLabel(tf: string): string {
  return TIMEFRAME_LABELS[tf] ?? tf;
}

type ChartRow = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  timeframe: string;
  candleCount: number;
  lastCandleTime: Date | null;
};

function fmtTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

export default async function CoinPage({
  params,
  searchParams,
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { symbol: raw } = await params;
  const query = await searchParams;

  const symbol = decodeURIComponent(raw).trim().toUpperCase();

  if (!/^[A-Z0-9]{2,12}$/.test(symbol)) {
    return (
      <main className="shell">
        <section className="hero">
          <div>
            <h1>Неверный тикер</h1>
            <div className="muted">«{raw}» не похож на тикер актива.</div>
          </div>
        </section>
      </main>
    );
  }

  let info:
    | {
        name: string | null;
        rank: number | null;
        top500: boolean;
        rows: ChartRow[];
      }
    | null = null;

  let dbError = false;

  try {
    const { prisma } = await import("@/lib/prisma");
    const asset = await prisma.asset.findUnique({
      where: { symbol },
      select: { id: true, name: true, rank: true, top500: true },
    });
    if (asset) {
      const rows = await prisma.$queryRaw<ChartRow[]>`
        SELECT
          m.id AS "marketId",
          m.exchange AS "exchange",
          m."exchangeSymbol" AS "exchangeSymbol",
          c.timeframe AS "timeframe",
          COUNT(*)::int AS "candleCount",
          MAX(c."openTime") FILTER (WHERE c.closed = true) AS "lastCandleTime"
        FROM "Candle" c
        JOIN "Market" m ON m.id = c."marketId"
        WHERE m."assetId" = ${asset.id}
          AND m.enabled = true
          AND m.status = 'ACTIVE'
          AND m.quote = 'USDT'
          AND m."marketType" = 'SPOT'
        GROUP BY m.id, m.exchange, m."exchangeSymbol", c.timeframe
        ORDER BY m.exchange, c.timeframe
      `;
      info = { name: asset.name, rank: asset.rank, top500: asset.top500, rows };
    }
  } catch (error) {
    console.error(`[coin/${symbol}] Ошибка загрузки метаданных:`, error);
    dbError = true;
  }

  const exchanges = info && info.rows.length > 0 ? [...new Set(info.rows.map((r) => r.exchange))] : [];
  const timeframes =
    info && info.rows.length > 0
      ? TIMEFRAME_ORDER.filter((tf) => info.rows.some((r) => r.timeframe === tf))
      : [];

  const lastCandleTime =
    info && info.rows.length > 0 ? newestClosedCandleTime(info.rows.map((r) => r.lastCandleTime)) : null;

  // Determine default exchange: BINANCE if available, else first by priority
  let defaultExchange = "BINANCE";
  if (info) {
    if (exchanges.includes("BINANCE")) defaultExchange = "BINANCE";
    else if (exchanges.length > 0) {
      const priority = ["BINANCE", "BYBIT", "GATE", "KUCOIN", "BINGX"];
      const sorted = [...exchanges].sort((a, b) => {
        const ai = priority.indexOf(a);
        const bi = priority.indexOf(b);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
      defaultExchange = sorted[0];
    }
  }

  const requestedExchange = typeof query.exchange === "string" ? query.exchange.toUpperCase() : defaultExchange;
  const isFallback = requestedExchange !== defaultExchange && !exchanges.includes(requestedExchange);

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>
            {symbol}/USDT{info?.name ? ` · ${info.name}` : ""}
          </h1>
          <div className="muted">
            График по закрытым свечам из PostgreSQL. BINANCE default, fallback по приоритету. Live WS только на этой странице.
            Индикаторы: EMA, SMA, RSI, MACD, объём.
          </div>
        </div>
      </section>

      {info ? (
        <div className="cards">
          <div className="card">
            <div className="cardTitle">Суслик TOP-50</div>
            <div className="bigValue">{info.rank !== null ? `#${info.rank}` : "Вне рейтинга"}</div>
            <span className="muted">
              {isInTopUniverse(info.rank) ? "актив в основном universe (TOP-50) • BINANCE default" : "актив вне основного TOP-50"}
            </span>
          </div>

          <div className="card">
            <div className="cardTitle">Биржи с данными</div>
            <div className="bigValue">{exchanges.length > 0 ? exchanges.length : "—"}</div>
            <span className="muted">
              {exchanges.length > 0 ? exchanges.join(", ") : "Рынков со свечами нет"} {isFallback ? `• Fallback с ${requestedExchange} на ${defaultExchange}` : ""}
            </span>
          </div>

          <div className="card">
            <div className="cardTitle">Таймфреймы</div>
            <div className="bigValue" style={{ fontSize: "1rem" }}>
              {timeframes.length > 0 ? timeframes.map((tf) => tf.toUpperCase()).join(" · ") : "—"}
            </div>
            <span className="muted">
              {timeframes.length > 0 ? timeframes.map((tf) => timeframeLabel(tf)).join(", ") : "по активу пока нет свечей"}
            </span>
          </div>

          <div className="card">
            <div className="cardTitle">Последняя закрытая свеча</div>
            <div className="bigValue" style={{ fontSize: "1rem" }}>{lastCandleTime ? fmtTime(lastCandleTime) : "—"}</div>
            <span className="muted">по всем рынкам актива • Default {defaultExchange}</span>
          </div>
        </div>
      ) : (
        <div className="tableBox" style={{ marginBottom: 16 }}>
          <p className="muted" style={{ padding: "1rem" }}>
            {dbError ? "Нет данных: база временно недоступна." : `Нет данных: актива ${symbol} нет в базе. Прогоните rank-assets и OHLCV worker.`}
          </p>
        </div>
      )}

      <CandleChart
        initialSymbol={symbol}
        initialExchange={typeof query.exchange === "string" ? query.exchange : defaultExchange}
        initialTimeframe={typeof query.timeframe === "string" ? query.timeframe : "15m"}
      />
    </main>
  );
}
