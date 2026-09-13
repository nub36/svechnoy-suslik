import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function SignalsPage() {
  let signals: any[] = [];
  let error: string | null = null;
  let strategyStates: any[] = [];

  try {
    signals = await prisma.signal.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        strategy: {
          select: { id: true, name: true, slug: true, version: true },
        },
        outcome: true,
      },
    });
  } catch (e: any) {
    error = e.message;
  }

  try {
    // StrategySignalState may not exist yet if migration not applied — fail-closed
    // @ts-ignore
    if (prisma.strategySignalState) {
      // @ts-ignore
      strategyStates = await prisma.strategySignalState.findMany({
        orderBy: { updatedAt: "desc" },
        take: 20,
      });
    }
  } catch (e: any) {
    // ignore — table may not exist yet
    strategyStates = [];
  }

  return (
    <main className="shell">
      <section className="hero">
        <div>
          <h1>Сигналы</h1>
          <div className="muted">Формализованные сигналы алгоритмических стратегий — BTC ONLY пилот, реальные данные PostgreSQL, EDGE/RE-ARM V1</div>
        </div>
      </section>

      <div className="muted" style={{ marginBottom: "1rem" }}>
        Сила — это степень совпадения условий стратегии (0–100), а не вероятность успешной сделки.
        {signals.length > 0 ? ` Найдено ${signals.length} сигналов. ` : " Пока нет сигналов — запустите Signal Engine. "}
        EDGE V1: один сигнал на EDGE/REVERSAL, SHORT-SHORT HOLD без дубликата, NEUTRAL-SHORT EDGE, SHORT-LONG REVERSAL, NEUTRAL реарм, unavailable не реармит, same horizon idempotent, PM2 restart сохраняет StrategySignalState.
      </div>

      {strategyStates.length > 0 && (
        <div className="tableBox" style={{ marginBottom: "1rem", padding: "1rem", fontSize: "12px" }}>
          <div style={{ fontWeight: 700, marginBottom: "0.5rem" }}>EDGE State (StrategySignalState) — persistent, survives PM2 restart:</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "11px" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e5e7eb", background: "#f9fafb" }}>
                <th style={{ padding: "4px" }}>Strategy</th>
                <th style={{ padding: "4px" }}>Symbol/TF</th>
                <th style={{ padding: "4px" }}>Aggregate</th>
                <th style={{ padding: "4px" }}>Last Evaluated</th>
                <th style={{ padding: "4px" }}>Last Signal</th>
                <th style={{ padding: "4px" }}>Direction</th>
              </tr>
            </thead>
            <tbody>
              {strategyStates.map((st: any) => (
                <tr key={st.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "4px" }}>{st.strategyId}</td>
                  <td style={{ padding: "4px" }}>{st.symbol} {st.timeframe}</td>
                  <td style={{ padding: "4px", fontWeight: 700, background: st.aggregateState === "SHORT" ? "#fee2e2" : st.aggregateState === "LONG" ? "#dcfce7" : "#f3f4f6" }}>{st.aggregateState}</td>
                  <td style={{ padding: "4px" }}>{st.lastEvaluatedCandleTime ? new Date(st.lastEvaluatedCandleTime).toISOString() : "—"}</td>
                  <td style={{ padding: "4px" }}>{st.lastSignalCandleTime ? new Date(st.lastSignalCandleTime).toISOString() : "—"}</td>
                  <td style={{ padding: "4px" }}>{st.lastSignalDirection ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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
            VPS: <code>npx tsx scripts/signal-worker.ts --strategy=smart-money-suslik --timeframe=15m --dry-run</code> — проверка EDGE, затем{" "}
            <code>SMART_MONEY_WRITE_ENABLED=true npx tsx scripts/signal-worker.ts --strategy=smart-money-suslik --timeframe=15m --once --no-dry-run --enable-smart-money-write</code> — создание. EDGE V1: один сигнал на EDGE, SHORT-SHORT HOLD, NEUTRAL-SHORT EDGE, SHORT-LONG REVERSAL, REARM NEUTRAL, unavailable не реармит, same horizon idempotent, bootstrap default no signal.
            <br />
            Для 1h trend: <code>npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --dry-run</code>
            <br />
            Исторический replay: <code>npx tsx scripts/analyze-edge-replay.ts</code> — должен дать Episode #1 start=2026-09-13T08:15:00.000Z dir=SHORT end=2026-09-13T11:00:00.000Z durationBars=11 trigger=EDGE
          </p>
        </div>
      )}

      {!error && signals.length > 0 && (
        <div className="tableBox" style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #e5e7eb", background: "#f9fafb" }}>
                <th style={{ padding: "6px" }}>ID</th>
                <th style={{ padding: "6px" }}>Created</th>
                <th style={{ padding: "6px" }}>Candle</th>
                <th style={{ padding: "6px" }}>Symbol/TF</th>
                <th style={{ padding: "6px" }}>Dir</th>
                <th style={{ padding: "6px" }}>Score</th>
                <th style={{ padding: "6px" }}>Conf</th>
                <th style={{ padding: "6px" }}>Trigger</th>
                <th style={{ padding: "6px" }}>RefEx</th>
                <th style={{ padding: "6px" }}>Entry/SL/TP</th>
                <th style={{ padding: "6px" }}>Strategy/Source</th>
                <th style={{ padding: "6px" }}>Status/Outcome</th>
                <th style={{ padding: "6px" }}>SetupKey</th>
              </tr>
            </thead>
            <tbody>
              {signals.map((s) => (
                <tr key={s.id} style={{ borderBottom: "1px solid #f3f4f6" }}>
                  <td style={{ padding: "6px" }}>{s.id}</td>
                  <td style={{ padding: "6px", whiteSpace: "nowrap" }}>{new Date(s.createdAt).toLocaleString("ru-RU")}</td>
                  <td style={{ padding: "6px", whiteSpace: "nowrap", fontSize: "11px" }}>{s.signalCandleTime ? new Date(s.signalCandleTime).toISOString().slice(0, 16) : "—"}</td>
                  <td style={{ padding: "6px", fontWeight: 700 }}>{s.symbol} {s.timeframe}</td>
                  <td style={{ padding: "6px" }}>
                    <span
                      style={{
                        padding: "2px 6px",
                        borderRadius: "10px",
                        fontWeight: 700,
                        background: s.direction === "LONG" ? "#dcfce7" : s.direction === "SHORT" ? "#fee2e2" : "#f3f4f6",
                        color: s.direction === "LONG" ? "#166534" : s.direction === "SHORT" ? "#991b1b" : "#374151",
                      }}
                    >
                      {s.direction}
                    </span>
                  </td>
                  <td style={{ padding: "6px" }}>{s.score}</td>
                  <td style={{ padding: "6px" }}>{s.confirmationCount != null && s.confirmationTotal != null ? `${s.confirmationCount}/${s.confirmationTotal}` : "—"} {s.participantCount ? `(${s.participantCount})` : ""}</td>
                  <td style={{ padding: "6px", fontWeight: 600, color: s.triggerType === "EDGE" ? "#166534" : s.triggerType === "REVERSAL" ? "#7c3aed" : s.triggerType === "BOOTSTRAP" ? "#d97706" : "#6b7280" }}>{s.triggerType ?? "—"}</td>
                  <td style={{ padding: "6px" }}>{s.referenceExchange ?? "—"} {s.referenceFallback ? "(fallback)" : ""}</td>
                  <td style={{ padding: "6px", fontSize: "10px" }}>
                    E:{s.entry?.toFixed(2) ?? "NULL"}<br />SL:{s.stopLoss?.toFixed(2) ?? "—"}<br />TP:{s.takeProfit1?.toFixed(2) ?? "—"}/{s.takeProfit2?.toFixed(2) ?? "—"}/{s.takeProfit3?.toFixed(2) ?? "—"}
                  </td>
                  <td style={{ padding: "6px", fontSize: "10px" }}>
                    {s.strategy.slug} v{s.strategy.version}<br />{s.signalSource}
                  </td>
                  <td style={{ padding: "6px", fontSize: "10px" }}>
                    {s.status}
                    {s.outcome ? (
                      <>
                        <br />Outcome:{s.outcome.status}
                        {s.outcome.entryPrice ? <><br />@ {s.outcome.entryPrice.toFixed(2)}</> : null}
                      </>
                    ) : null}
                  </td>
                  <td style={{ padding: "6px", fontSize: "9px", maxWidth: "120px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.setupKey ?? ""}>
                    {s.setupKey ? s.setupKey.slice(0, 16) + "..." : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: "1rem", fontSize: "11px", color: "#6b7280" }}>
        <div>BTC ONLY пилот: 5 бирж BINANCE/BYBIT/GATE/KUCOIN/BINGX, BINGX 1d excluded, costs 5bps fee 2bps slippage, ATR SL/TP, EDGE/RE-ARM V1 one signal per EDGE.</div>
        <div>Движок: lib/signals/signal-engine.ts — Strategy Runtime + quorum 3/5 + EDGE state machine + STRICT ATOMIC Signal+Outcome+State tx + P2002 idempotent + same horizon NOOP + older REFUSE + unavailable PRESERVE + bootstrap no signal default.</div>
        <div>Воркеры: svechnoy-suslik-ohlcv-btc (BTC 5m/15m/1h/4h/1d OHLCV) + svechnoy-suslik-signal-btc (1h trend) + svechnoy-suslik-signal-btc-15m-smart (15m smart-money EDGE) — см. ecosystem.config.js</div>
        <div>Команды VPS: npx tsx scripts/signal-worker.ts --strategy=smart-money-suslik --timeframe=15m --dry-run / --once --no-dry-run --enable-smart-money-write (env SMART_MONEY_WRITE_ENABLED=true)</div>
        <div>Historical replay: Episode #1 start=2026-09-13T08:15:00.000Z dir=SHORT end=2026-09-13T11:00:00.000Z durationBars=11 peakScore=80 confirmations=4/5 trigger=EDGE — доказывает ONE signal per persistent regime, not 11.</div>
      </div>
    </main>
  );
}
