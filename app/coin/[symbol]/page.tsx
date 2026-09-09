export default async function CoinPage({
  params
}: {
  params: Promise<{ symbol: string }>;
}) {
  const { symbol } = await params;

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>{symbol.toUpperCase()} / USDT</h1>
          <div className="muted">
            График, индикаторы и результаты стратегий
          </div>
        </div>
      </section>

      <div className="cards">
        <div className="card">
          <div className="cardTitle">Общий сигнал</div>
          <div className="bigValue positive">LONG</div>
        </div>

        <div className="card">
          <div className="cardTitle">Стратегии</div>
          <div className="bigValue">4 LONG / 1 SHORT</div>
        </div>

        <div className="card">
          <div className="cardTitle">Сила</div>
          <div className="bigValue">78 / 100</div>
        </div>

        <div className="card">
          <div className="cardTitle">Таймфрейм</div>
          <div className="bigValue">4H</div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16, minHeight: 430 }}>
        <h3>Свечной график</h3>
        <p className="muted">
          Здесь подключим интерактивный график с индикаторами,
          LONG/SHORT, Entry, TP и SL.
        </p>
      </div>
    </main>
  );
}
