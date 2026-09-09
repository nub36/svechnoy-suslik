import { getTopCoins } from "@/lib/market";

/**
 * Сводка на главной: реальные данные.
 *
 - Капитализация Top-500 — ВНЕШНЯЯ метрика CoinGecko
   (кэш 60 c); это НЕ основной universe проекта
   (universe — Top-100, lib/universe.ts).
 - Свечи/снимки/сигналы/стратегии — счётчики PostgreSQL.
 *
 * Если база недоступна или данных нет — честно
 * показываем «Нет данных», никаких выдуманных цифр.
 */

function fmtCap(n: number): string {
  if (n >= 1e12) {
    return `$${(n / 1e12).toFixed(2)} трлн`;
  }

  if (n >= 1e9) {
    return `$${(n / 1e9).toFixed(1)} млрд`;
  }

  if (n <= 0) {
    return "—";
  }

  return `$${(n / 1e6).toFixed(0)} млн`;
}

export default async function MarketOverview() {
  const coins = await getTopCoins(500);

  const totalCap = coins.reduce(
    (sum, c) => sum + (c.market_cap ?? 0),
    0
  );

  let candleCount: number | null = null;
  let snapshotCount: number | null = null;
  let marketCount: number | null = null;
  let strategiesOnline: number | null = null;
  let strategiesTotal: number | null = null;

  try {
    // Ленивый импорт: недоступность базы
    // даёт «Нет данных», а не падение страницы.
    const { prisma } = await import(
      "@/lib/prisma"
    );

    const [candles, snapshots, markets, strategies] =
      await Promise.all([
        prisma.candle.count(),
        prisma.indicatorSnapshot.count(),
        prisma.market.count({
          where: {
            enabled: true,
            status: "ACTIVE"
          }
        }),
        prisma.strategy.findMany({
          select: {
            enabled: true,
            status: true
          }
        })
      ]);

    candleCount = candles;
    snapshotCount = snapshots;
    marketCount = markets;
    strategiesTotal = strategies.length;
    strategiesOnline = strategies.filter(
      (s: { enabled: boolean; status: string }) =>
        s.enabled && s.status === "PUBLISHED"
    ).length;
  } catch (error) {
    // база недоступна — карточки покажут «Нет данных»,
    // техническая причина остаётся в server-логе
    console.error(
      "[MarketOverview] Ошибка загрузки сводки:",
      error
    );
  }

  return (
    <div className="cards">
      <div className="card">
        <div className="cardTitle">
          Капитализация Top-500
        </div>

        <div className="bigValue">
          {coins.length > 0
            ? fmtCap(totalCap)
            : "Нет данных"}
        </div>

        <span className="muted">
          внешняя метрика CoinGecko (сумма по их
          Top-500), обновляется раз в минуту; не
          является universe проекта
        </span>
      </div>

      <div className="card">
        <div className="cardTitle">
          Свечи в базе
        </div>

        <div className="bigValue">
          {candleCount !== null
            ? candleCount.toLocaleString("ru-RU")
            : "Нет данных"}
        </div>

        <span className="muted">
          {snapshotCount !== null
            ? `снимков индикаторов: ${snapshotCount.toLocaleString("ru-RU")}`
            : "база временно недоступна"}
        </span>
      </div>

      <div className="card">
        <div className="cardTitle">
          Активные рынки
        </div>

        <div className="bigValue">
          {marketCount !== null
            ? marketCount.toLocaleString("ru-RU")
            : "Нет данных"}
        </div>

        <span className="muted">
          {marketCount === null
            ? "база временно недоступна"
            : "SPOT USDT-рынки пяти бирж"}
        </span>
      </div>

      <div className="card">
        <div className="cardTitle">
          Стратегии
        </div>

        <div className="bigValue">
          {strategiesOnline === null
            ? "Нет данных"
            : `${strategiesOnline} / ${strategiesTotal ?? 0}`}
        </div>

        <span className="muted">
          {strategiesOnline === null
            ? "база временно недоступна"
            : strategiesOnline > 0
              ? "включены и опубликованы"
              : "активных стратегий нет"}
        </span>
      </div>
    </div>
  );
}
