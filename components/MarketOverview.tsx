export default function MarketOverview() {
  return (
    <div className="cards">
      <div className="card">
        <div className="cardTitle">Капитализация рынка</div>
        <div className="bigValue">$2.71 трлн</div>
        <span className="positive">+1.28%</span>
      </div>

      <div className="card">
        <div className="cardTitle">Активные сигналы</div>
        <div className="bigValue">38</div>
        <span className="positive">24 LONG</span>
        <span className="muted"> · </span>
        <span className="negative">14 SHORT</span>
      </div>

      <div className="card">
        <div className="cardTitle">Средний RSI рынка</div>
        <div className="bigValue">53.4</div>
        <span className="muted">Нейтральный рынок</span>
      </div>

      <div className="card">
        <div className="cardTitle">Стратегии онлайн</div>
        <div className="bigValue">7 / 7</div>
        <span className="positive">Движок работает</span>
      </div>
    </div>
  );
}
