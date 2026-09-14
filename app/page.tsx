import MarketOverview from "@/components/MarketOverview";
import MarketTable from "@/components/MarketTable";
import TradingViewWidget from "@/components/TradingViewWidget";
import { getPublicTop50 } from "@/lib/public/top50";

export default async function Home() {
  const coins = await getPublicTop50();

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Рынок под микроскопом 🔬</h1>
          <div className="muted">
            TOP-50 из Asset rank в DB • BINANCE default, fallback по приоритету • Лёгкий snapshot, live WS только на /coin/{`{symbol}`}
          </div>
        </div>
      </section>

      <MarketOverview />

      <TradingViewWidget symbol="BINANCE:BTCUSDT" interval="15" theme="dark" />

      <section className="marketSection">
        <h2>TOP-50 Публичный</h2>
        <div className="muted">
          Формируется из Asset rank 1..50 в PostgreSQL, не хардкод. BINANCE default exchange, fallback по ExchangeConfig priority. Лёгкий серверный snapshot/cache, не 50 WS соединений.
        </div>

        {coins.length === 0 ? (
          <div className="tableBox">
            <p className="muted" style={{ padding: "1rem" }}>
              Нет данных: TOP-50 в БД пуст или источник временно недоступен. Попробуйте позже или проверьте /admin/data
            </p>
          </div>
        ) : (
          <MarketTable coins={coins as any} />
        )}
      </section>
    </main>
  );
}
