const signals = [
  ["BTC/USDT", "LONG", "Тренд + RSI", "4H", "82"],
  ["SOL/USDT", "SHORT", "Пробой + объём", "1H", "76"],
  ["ETH/USDT", "LONG", "MACD Momentum", "4H", "71"]
];

export default function Signals() {
  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Сигналы</h1>
          <div className="muted">
            Формализованные сигналы алгоритмических стратегий
          </div>
        </div>
      </section>

      <div className="tableBox">
        <table>
          <thead>
            <tr>
              <th>Инструмент</th>
              <th>Направление</th>
              <th>Стратегия</th>
              <th>Таймфрейм</th>
              <th>Сила</th>
            </tr>
          </thead>

          <tbody>
            {signals.map((s) => (
              <tr key={s[0]}>
                <td><b>{s[0]}</b></td>
                <td>
                  <span className={`signal ${s[1] === "LONG" ? "long" : "short"}`}>
                    {s[1]}
                  </span>
                </td>
                <td>{s[2]}</td>
                <td>{s[3]}</td>
                <td>{s[4]}/100</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </main>
  );
}
