import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type SignalRow = {
  id: number;
  symbol: string;
  exchange: string;
  exchangeSymbol: string;
  timeframe: string;
  direction: string;
  score: number;
  entry: number;
  stopLoss: number | null;
  takeProfit1: number | null;
  reason: string;
  strategyVersion: number;
  candleTime: Date;
  strategy: {
    name: string;
    slug: string;
  };
};

function fmtPrice(value: number): string {
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: 8
  }).format(value);
}

function fmtTime(value: Date): string {
  return value.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

async function loadSignals(): Promise<SignalRow[] | null> {
  try {
    return await prisma.signal.findMany({
      where: { status: "ACTIVE" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true,
        symbol: true,
        exchange: true,
        exchangeSymbol: true,
        timeframe: true,
        direction: true,
        score: true,
        entry: true,
        stopLoss: true,
        takeProfit1: true,
        reason: true,
        strategyVersion: true,
        candleTime: true,
        strategy: {
          select: { name: true, slug: true }
        }
      }
    });
  } catch {
    return null;
  }
}

export default async function Signals() {
  const signals = await loadSignals();

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

      <div className="muted" style={{ marginBottom: "1rem" }}>
        Сила — это степень совпадения условий стратегии (0–100),
        а не вероятность успешной сделки.
      </div>

      {signals === null ? (
        <div className="tableBox">
          <p className="muted" style={{ padding: "1rem" }}>
            Нет данных: база временно недоступна.
          </p>
        </div>
      ) : signals.length === 0 ? (
        <div className="tableBox">
          <p className="muted" style={{ padding: "1rem" }}>
            Нет данных. Signal Engine ещё не создал сигналов —
            прогоните worker: scripts/signal-worker.ts
            (сначала dry-run, затем --apply).
          </p>
        </div>
      ) : (
        <div className="tableBox">
          <table>
            <thead>
              <tr>
                <th>Инструмент</th>
                <th>Биржа</th>
                <th>Направление</th>
                <th>Стратегия</th>
                <th>Таймфрейм</th>
                <th>Сила</th>
                <th>Вход</th>
                <th>SL</th>
                <th>TP1</th>
                <th>Свеча</th>
              </tr>
            </thead>

            <tbody>
              {signals.map((s) => (
                <tr key={s.id}>
                  <td>
                    <b>{s.symbol}/USDT</b>
                  </td>
                  <td>{s.exchange}</td>
                  <td>
                    <span
                      className={`signal ${
                        s.direction === "LONG"
                          ? "long"
                          : s.direction === "SHORT"
                            ? "short"
                            : ""
                      }`}
                    >
                      {s.direction}
                    </span>
                  </td>
                  <td>
                    {s.strategy.name} v{s.strategyVersion}
                  </td>
                  <td>{s.timeframe}</td>
                  <td>{s.score}/100</td>
                  <td>{fmtPrice(s.entry)}</td>
                  <td>
                    {s.stopLoss !== null
                      ? fmtPrice(s.stopLoss)
                      : "—"}
                  </td>
                  <td>
                    {s.takeProfit1 !== null
                      ? fmtPrice(s.takeProfit1)
                      : "—"}
                  </td>
                  <td>{fmtTime(s.candleTime)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
