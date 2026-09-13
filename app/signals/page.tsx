import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function SignalsPage() {
  let signals: any[] = [];
  let error: string | null = null;

  try {
    signals = await prisma.signal.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        strategy: {
          select: { id: true, name: true, slug: true, version: true },
        },
      },
    });
  } catch (e: any) {
    error = e.message;
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Сигналы</h1>
          <div className="muted">Формализованные сигналы алгоритмических стратегий — BTC ONLY пилот, реальные данные PostgreSQL</div>
        </div>
      </section>

      <div className="muted" style={{ marginBottom: "1rem" }}>
        Сила — это степень совпадения условий стратегии (0–100), а не вероятность успешной сделки. 
        {signals.length > 0 ? ` Найдено ${signals.length} сигналов.` : " Пока нет сигналов — запустите Signal Engine."}
      </div>

      {error && (
        <div className="tableBox" style={{ padding: "1rem", color: "#b91c1c", background: "#fef2f2" }}>
          Ошибка загрузки сигналов: {error} — база временно недоступна
        </div>
      )}

      {!error && signals.length === 0 && (
        <div className="tableBox">
          <p className="muted" style={{ padding: "1rem" }}>
            Нет данных. Сигналов пока нет — стратегия дала NEUTRAL или Signal Engine ещё не запускался.
          </p>
          <p className="muted" style={{ padding: "0 1rem 1rem", fontSize: "12px" }}>
            На VPS: <code>npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run</code> — проверка, затем{" "}
            <code>--once --no-dry-run</code> — создание. Стратегия: trend-suslik v1 enabled PUBLISHED 15m,1h,4h,1d minExchanges=2, minScore=72.
            <br />
            Текущее состояние BTC 1h на скриншоте: NEUTRAL LONG 20 SHORT 20 на всех 5 биржах — нет подтверждения, поэтому сигнал не создаётся (правильное поведение).
            <br />
            Чтобы форсировать тестовый сигнал для демо: <code>npx tsx scripts/seed-test-signal.ts</code>
          </p>
        </div>
      )}

      {!error && signals.length > 0 && (
        <div className="tableBox">
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb", background: "#f9fafb" }}>
                <th style={{ padding: "8px" }}>ID</th>
                <th style={{ padding: "8px" }}>Время</th>
                <th style={{ padding: "8px" }}>Символ</th>
                <th style={{ padding: "8px" }}>ТФ</th>
                <th style={{ padding: "8px" }}>Напр.</th>
                <th style={{ padding: "8px" }}>Сила</th>
                <th style={{ padding: "8px" }}>Entry</th>
                <th style={{ padding: "8px" }}>SL</th>
                <th style={{ padding: "8px" }}>TP1/TP2/TP3</th>
                <th style={{ padding: "8px" }}>Стратегия</th>
                <th style={{ padding: "8px" }}>Статус</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "8px" }}>{s.id}</td>
                  <td style={{ padding: "8px", whiteSpace: "nowrap" }}>{new Date(s.createdAt).toLocaleString("ru-RU")}</td>
                  <td style={{ padding: "8px", fontWeight: 700 }}>{s.symbol}</td>
                  <td style={{ padding: "8px" }}>{s.timeframe}</td>
                  <td style={{ padding: "8px" }}>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: "12px",
                        fontWeight: 700,
                        background: s.direction === "LONG" ? "#dcfce7" : s.direction === "SHORT" ? "#fee2e2" : "#f3f4f6",
                        color: s.direction === "LONG" ? "#166534" : s.direction === "SHORT" ? "#991b1b" : "#374151",
                      }}
                    >
                      {s.direction}
                    </span>
                  </td>
                  <td style={{ padding: "8px" }}>{s.score}</td>
                  <td style={{ padding: "8px" }}>{s.entry?.toFixed(2)}</td>
                  <td style={{ padding: "8px" }}>{s.stopLoss?.toFixed(2) ?? "—"}</td>
                  <td style={{ padding: "8px", fontSize: "11px" }}>
                    {s.takeProfit1?.toFixed(2) ?? "—"} / {s.takeProfit2?.toFixed(2) ?? "—"} / {s.takeProfit3?.toFixed(2) ?? "—"}
                  </td>
                  <td style={{ padding: "8px" }}>
                    {s.strategy.slug} v{s.strategy.version}
                  </td>
                  <td style={{ padding: "8px" }}>{s.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: "1rem", fontSize: "12px", color: "#6b7280" }}>
        <div>BTC ONLY пилот: 5 бирж BINANCE/BYBIT/GATE/KUCOIN/BINGX, BINGX 1d excluded, costs 5bps fee 2bps slippage, ATR SL/TP.</div>
        <div>Движок: lib/signals/signal-engine.ts — Strategy Runtime + aggregation minExchanges, duplicate protection, cooldown.</div>
        <div>Команды VPS: npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run / --once --no-dry-run</div>
      </div>
    </main>
  );
}
