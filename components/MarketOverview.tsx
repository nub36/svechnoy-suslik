import { getPublicTop50 } from "@/lib/public/top50";

/**
 * Сводка на главной: реальные данные.
 *
 - TOP-50 — из Asset rank в DB (lib/universe.ts TOP_UNIVERSE_SIZE 50)
 - Свечи/снимки/сигналы/стратегии — счётчики PostgreSQL.
 *
 * Если база недоступна или данных нет — честно
 * показываем «Нет данных», никаких выдуманных цифр.
 */

export default async function MarketOverview() {
  const coins = await getPublicTop50();

  let candleCount: number | null = null;
  let snapshotCount: number | null = null;
  let marketCount: number | null = null;
  let strategiesOnline: number | null = null;
  let strategiesTotal: number | null = null;

  try {
    const { prisma } = await import("@/lib/prisma");
    let candles = 0;
    let snapshots = 0;
    let markets = 0;
    let strategies: { enabled: boolean; status: string }[] = [];
    try {
      candles = await prisma.candle.count();
    } catch {}
    try {
      snapshots = await prisma.indicatorSnapshot.count();
    } catch {}
    try {
      markets = await prisma.market.count({ where: { enabled: true, status: "ACTIVE" } });
    } catch {}
    try {
      const raw = await (prisma as any).strategy?.findMany?.({ select: { enabled: true, status: true } });
      if (Array.isArray(raw)) strategies = raw as any;
    } catch {}
    // Build-safe: guard against Proxy mock returning null
    if (typeof candles === "number") candleCount = candles;
    if (typeof snapshots === "number") snapshotCount = snapshots;
    if (typeof markets === "number") marketCount = markets;
    if (Array.isArray(strategies)) {
      strategiesTotal = strategies.length;
      strategiesOnline = strategies.filter(
        (s: { enabled: boolean; status: string }) => s.enabled && s.status === "PUBLISHED"
      ).length;
    }
  } catch (error) {
    console.error("[MarketOverview] Ошибка загрузки сводки:", error);
  }

  return (
    <div className="cards">
      <div className="card">
        <div className="cardTitle">TOP-50 Публичный</div>
        <div className="bigValue">{coins.length > 0 ? `${coins.length} активов` : "Нет данных"}</div>
        <span className="muted">из Asset rank 1..50 в DB, BINANCE default, snapshot/cache</span>
      </div>

      <div className="card">
        <div className="cardTitle">Свечи в базе</div>
        <div className="bigValue">{candleCount !== null ? candleCount.toLocaleString("ru-RU") : "Нет данных"}</div>
        <span className="muted">
          {snapshotCount !== null ? `снимков индикаторов: ${snapshotCount.toLocaleString("ru-RU")}` : "база временно недоступна"}
        </span>
      </div>

      <div className="card">
        <div className="cardTitle">Активные рынки</div>
        <div className="bigValue">{marketCount !== null ? marketCount.toLocaleString("ru-RU") : "Нет данных"}</div>
        <span className="muted">{marketCount === null ? "база временно недоступна" : "SPOT USDT-рынки пяти бирж"}</span>
      </div>

      <div className="card">
        <div className="cardTitle">Стратегии</div>
        <div className="bigValue">{strategiesOnline === null ? "Нет данных" : `${strategiesOnline} / ${strategiesTotal ?? 0}`}</div>
        <span className="muted">
          {strategiesOnline === null ? "база временно недоступна" : strategiesOnline > 0 ? "включены и опубликованы" : "активных стратегий нет"}
        </span>
      </div>
    </div>
  );
}
