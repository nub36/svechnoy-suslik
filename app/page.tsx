import MarketOverview from "@/components/MarketOverview";
import MarketTable from "@/components/MarketTable";
import { getTopCoins } from "@/lib/market";

export default async function Home() {
  const coins = await getTopCoins(500);

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Рынок под микроскопом 🔬</h1>
          <div className="muted">
            500 крупнейших активов и алгоритмический анализ без AI
          </div>
        </div>
      </section>

      <MarketOverview />

      <section className="marketSection">
        <h2>Рынок</h2>
        <div className="muted">
          Стратегии следят за рынком. Суслик следит за стратегиями.
        </div>

        {coins.length === 0 ? (
          <div className="tableBox">
            <p className="muted" style={{ padding: "1rem" }}>
              Нет данных: источник рынка (CoinGecko)
              временно недоступен. Попробуйте обновить
              страницу позже.
            </p>
          </div>
        ) : (
          <MarketTable coins={coins} />
        )}
      </section>
    </main>
  );
}
