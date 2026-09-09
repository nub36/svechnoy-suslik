import CandleChart from "@/components/chart/CandleChart";
import { newestClosedCandleTime } from "@/lib/data/freshness";

export const dynamic = "force-dynamic";

/**
 * Страница монеты — ТОЛЬКО реальные данные из
 * PostgreSQL Asset/Market/Candle.
 *
 * Prisma Signal здесь НЕ используется: production
 * Signal Engine ещё не развёрнут (разделы §28, §25).
 *
 * Таймфреймы и последняя закрытая свеча берутся ОДНИМ
 * агрегированным SQL-запросом на стороне PostgreSQL
 * (GROUP BY по рынку и таймфрейму) — никаких загрузок
 * всех свечей актива в Node.js.
 */

const TIMEFRAME_ORDER = [
  "5m",
  "15m",
  "1h",
  "4h",
  "1d"
];

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

type ChartRow = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  timeframe: string;
  candleCount: number;
  /** Последняя ЗАКРЫТАЯ (SQL FILTER closed=true);
   * null — если по рынку/ТФ есть только открытая свеча. */
  lastCandleTime: Date | null;
};

function fmtTime(date: Date): string {
  return (
    date.toISOString().replace("T", " ").slice(0, 16) +
    " UTC"
  );
}

export default async function CoinPage({
  params,
  searchParams
}: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<
    Record<string, string | string[] | undefined>
  >;
}) {
  const { symbol: raw } = await params;
  const query = await searchParams;

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
        top500: boolean;
        rows: ChartRow[];
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
      select: {
        id: true,
        name: true,
        rank: true,
        top500: true
      }
    });

    if (asset) {
      // Вызов строго членом объекта: отрыв $queryRaw
      // в переменную теряет this и даёт TypeError
      // в runtime (см. scripts/test-chart-sql.ts).
      const rows = await prisma.$queryRaw<ChartRow[]>`
        SELECT
          m.id AS "marketId",
          m.exchange AS "exchange",
          m."exchangeSymbol" AS "exchangeSymbol",
          c.timeframe AS "timeframe",
          COUNT(*)::int AS "candleCount",
          MAX(c."openTime") FILTER (
            WHERE c.closed = true
          ) AS "lastCandleTime"
        FROM "Candle" c
        JOIN "Market" m ON m.id = c."marketId"
        WHERE m."assetId" = ${asset.id}
          AND m.enabled = true
          AND m.status = 'ACTIVE'
          AND m.quote = 'USDT'
          AND m."marketType" = 'SPOT'
        GROUP BY
          m.id, m.exchange,
          m."exchangeSymbol", c.timeframe
        ORDER BY m.exchange, c.timeframe
      `;

      info = {
        name: asset.name,
        rank: asset.rank,
        top500: asset.top500,
        rows
      };
    }
  } catch (error) {
    // Техническая причина — только в server-лог,
    // чтобы молчаливый empty state не скрывал баги БД.
    console.error(
      `[coin/${symbol}] Ошибка загрузки метаданных:`,
      error
    );

    dbError = true;
  }

  const exchanges =
    info && info.rows.length > 0
      ? [...new Set(info.rows.map((r) => r.exchange))]
      : [];

  const timeframes =
    info && info.rows.length > 0
      ? TIMEFRAME_ORDER.filter((tf) =>
          info.rows.some((r) => r.timeframe === tf)
        )
      : [];

  // ТОЛЬКО закрытые свечи: подпись карточки —
  // «Последняя закрытая свеча», открытая не участвует
  const lastCandleTime =
    info && info.rows.length > 0
      ? newestClosedCandleTime(
          info.rows.map((r) => r.lastCandleTime)
        )
      : null;

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
              Суслик Top-500
            </div>

            <div className="bigValue">
              {info.rank !== null
                ? `#${info.rank}`
                : "Вне рейтинга"}
            </div>

            <span className="muted">
              {info.top500
                ? "актив в расчётном Top-500"
                : "актив вне текущего Top-500"}
            </span>
          </div>

          <div className="card">
            <div className="cardTitle">
              Биржи с данными
            </div>

            <div className="bigValue">
              {exchanges.length > 0
                ? exchanges.length
                : "—"}
            </div>

            <span className="muted">
              {exchanges.length > 0
                ? exchanges.join(", ")
                : "Рынков со свечами нет"}
            </span>
          </div>

          <div className="card">
            <div className="cardTitle">
              Таймфреймы
            </div>

            <div className="bigValue" style={{ fontSize: "1rem" }}>
              {timeframes.length > 0
                ? timeframes
                    .map((tf) => tf.toUpperCase())
                    .join(" · ")
                : "—"}
            </div>

            <span className="muted">
              {timeframes.length > 0
                ? timeframes
                    .map((tf) => timeframeLabel(tf))
                    .join(", ")
                : "по активу пока нет свечей"}
            </span>
          </div>

          <div className="card">
            <div className="cardTitle">
              Последняя закрытая свеча
            </div>

            <div className="bigValue" style={{ fontSize: "1rem" }}>
              {lastCandleTime
                ? fmtTime(lastCandleTime)
                : "—"}
            </div>

            <span className="muted">
              по всем рынкам актива
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

      <CandleChart
        initialSymbol={symbol}
        initialExchange={
          typeof query.exchange === "string"
            ? query.exchange
            : undefined
        }
        initialTimeframe={
          typeof query.timeframe === "string"
            ? query.timeframe
            : undefined
        }
      />
    </main>
  );
}
