const strategies = [
  ["Трендовый Суслик", "EMA + ADX + RSI", "Ищет продолжение устойчивого тренда."],
  ["Пробой Норы", "Уровни + объём + ATR", "Ищет подтверждённый выход цены из диапазона."],
  ["RSI Разворот", "RSI + трендовый фильтр", "Ищет перепроданность и перекупленность."],
  ["MACD Импульс", "MACD + объём", "Следит за изменением рыночного импульса."],
  ["Полосатый Суслик", "Bollinger Bands", "Работает с отклонениями цены от диапазона."],
  ["EMA Cross", "EMA 50 / EMA 200", "Классическое подтверждение направления тренда."],
  ["Мультитаймфрейм", "15m + 1H + 4H", "Проверяет несколько периодов."]
];

export default function Strategies() {
  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Стратегии</h1>
          <div className="muted">
            Независимые алгоритмы анализа рынка
          </div>
        </div>
      </section>

      {strategies.map((s, i) => (
        <div className="strategy" key={s[0]}>
          <div className="strategyHead">
            <div>
              <b>{s[0]}</b>
              <div className="muted">{s[1]}</div>
            </div>

            <span className="signal long">АКТИВНА</span>
          </div>

          <p>{s[2]}</p>
          <small className="muted">Версия 1.{i} · LONG + SHORT</small>
        </div>
      ))}
    </main>
  );
}
