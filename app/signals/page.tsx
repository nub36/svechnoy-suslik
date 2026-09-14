import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

type SignalWithOutcome = {
  id: number;
  symbol: string;
  timeframe: string;
  direction: string;
  score: number;
  entry: number | null;
  stopLoss: number | null;
  takeProfit1: number | null;
  takeProfit2: number | null;
  takeProfit3: number | null;
  status: string;
  signalCandleTime: Date | null;
  referenceExchange: string | null;
  signalSource: string;
  triggerType: string | null;
  confirmationCount: number | null;
  confirmationTotal: number | null;
  participantCount: number | null;
  createdAt: Date;
  strategy: { id: number; name: string; slug: string; version: number };
  outcome: {
    status: string;
    entryPrice: number | null;
    entryTime: Date | null;
    stopLoss: number | null;
    takeProfit1: number | null;
    takeProfit2: number | null;
    takeProfit3: number | null;
    tp1HitAt: Date | null;
    tp2HitAt: Date | null;
    tp3HitAt: Date | null;
    exitPrice: number | null;
    exitTime: Date | null;
  } | null;
};

function tfLabel(tf: string): string {
  const map: Record<string, string> = {
    "5m": "5 минут",
    "15m": "15 минут",
    "1h": "1 час",
    "4h": "4 часа",
    "1d": "1 день",
  };
  return map[tf] ?? tf;
}

function strategyLabel(slug: string, name: string): string {
  const map: Record<string, string> = {
    "trend-suslik": "Trend",
    "smart-money-suslik": "Smart Money V1",
    "smart-money-v2": "Smart Money V2",
  };
  return map[slug] ?? name;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    WAITING_ENTRY: "ОЖИДАЕТСЯ ВХОД",
    OPEN: "В РАБОТЕ",
    TP1_HIT: "TP1 ДОСТИГНУТ",
    TP2_HIT: "TP2 ДОСТИГНУТ",
    TP3_HIT: "TP3 ДОСТИГНУТ",
    STOPPED: "СТОП",
    EXPIRED: "ЗАВЕРШЁН ПО ВРЕМЕНИ",
    ENTRY_DATA_MISSING: "НЕТ ДАННЫХ ДЛЯ ВХОДА",
    ACTIVE: "АКТИВЕН",
  };
  return map[status] ?? status;
}

function triggerLabel(t: string | null): string {
  if (!t) return "—";
  const map: Record<string, string> = {
    EDGE: "EDGE",
    REVERSAL: "REVERSAL",
    BOOTSTRAP: "BOOTSTRAP",
  };
  return map[t] ?? t;
}

function formatPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1000) return v.toLocaleString("ru-RU", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString("ru-RU", { maximumFractionDigits: 4 });
  return v.toLocaleString("ru-RU", { maximumFractionDigits: 6 });
}

function formatCandleTime(dt: Date | null): { local: string; utc: string } | null {
  if (!dt) return null;
  const d = new Date(dt);
  return {
    local: d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }),
    utc: d.toISOString().slice(0, 16).replace("T", " "),
  };
}

function SignalCard({ s }: { s: SignalWithOutcome }) {
  const isLegacy = s.signalSource === "LEGACY";
  const isLive = s.signalSource === "LIVE_FORWARD";
  const dir = s.direction === "LONG" || s.direction === "SHORT" ? s.direction : "LONG";
  const outcome = s.outcome;
  const effectiveStatus = outcome?.status ?? (s.entry == null && s.signalSource === "LIVE_FORWARD" ? "WAITING_ENTRY" : s.status);

  // Effective prices: prefer outcome if present, else signal
  const entry = outcome?.entryPrice ?? s.entry;
  const sl = outcome?.stopLoss ?? s.stopLoss;
  const tp1 = outcome?.takeProfit1 ?? s.takeProfit1;
  const tp2 = outcome?.takeProfit2 ?? s.takeProfit2;
  const tp3 = outcome?.takeProfit3 ?? s.takeProfit3;

  const isWaitingEntry = effectiveStatus === "WAITING_ENTRY" || (entry == null && isLive);

  const candle = formatCandleTime(s.signalCandleTime);

  // Milestones
  const tp1Hit = !!outcome?.tp1HitAt;
  const tp2Hit = !!outcome?.tp2HitAt;
  const tp3Hit = !!outcome?.tp3HitAt;
  const stopped = effectiveStatus === "STOPPED";
  const tp3Done = effectiveStatus === "TP3_HIT";

  // Waiting text per timeframe
  const waitingDetail = (() => {
    if (s.timeframe === "5m") return "Вход: открытие следующей 5-минутной свечи";
    if (s.timeframe === "15m") return "Вход: открытие следующей 15-минутной свечи";
    if (s.timeframe === "1h") return "Вход: открытие следующего часа";
    if (s.timeframe === "4h") return "Вход: открытие следующей 4-часовой свечи";
    if (s.timeframe === "1d") return "Вход: открытие следующего дня";
    return "Вход будет зафиксирован по NEXT BAR OPEN";
  })();

  return (
    <div className="signalCard" data-dir={dir} data-legacy={isLegacy ? "true" : "false"}>
      <div className="signalCardHeader">
        <div className="signalCardSymbol">
          <b>{s.symbol}/USDT</b>
          <span className="signalDirBadge" data-dir={dir}>
            {dir}
          </span>
          {isLegacy && <span className="signalLegacyBadge">LEGACY SIGNAL</span>}
          {isLive && !isLegacy && (
            <span className="signalLegacyBadge" style={{ background: "#dcfce7", color: "#166534", borderColor: "#86efac" }}>
              LIVE
            </span>
          )}
        </div>
        <div className="signalMetaRow">
          <span className="signalMetaPill">
            <b>{tfLabel(s.timeframe)}</b> {s.timeframe}
          </span>
          <span className="signalMetaPill">
            Стратегия: <b>{strategyLabel(s.strategy.slug, s.strategy.name)}</b>
          </span>
          <span className="signalMetaPill">
            Триггер: <b>{triggerLabel(s.triggerType)}</b>
          </span>
        </div>
      </div>

      <div className="signalStatusRow">
        <span className="signalStatusBadge" data-status={effectiveStatus}>
          {statusLabel(effectiveStatus)}
        </span>
        {outcome?.exitPrice != null && (
          <span className="signalMetaPill">
            Выход: <b>{formatPrice(outcome.exitPrice)}</b>
          </span>
        )}
      </div>

      {isWaitingEntry ? (
        <div className="signalWaitingBox">
          <b>ОЖИДАЕТСЯ ВХОД</b>
          <span>{waitingDetail}</span>
          <span>После подтверждения outcome tracker значения появятся автоматически.</span>
        </div>
      ) : (
        <div className="signalPrices">
          <div className="signalPriceBlock" data-type="ENTRY">
            <span className="signalPriceLabel">ВХОД</span>
            <span className="signalPriceValue" data-empty={entry == null ? "true" : "false"}>
              {formatPrice(entry)}
            </span>
          </div>
          <div className="signalPriceBlock" data-type="SL">
            <span className="signalPriceLabel">STOP LOSS</span>
            <span className="signalPriceValue" data-empty={sl == null ? "true" : "false"}>
              {formatPrice(sl)}
            </span>
          </div>
          <div className="signalPriceBlock" data-type="TP">
            <span className="signalPriceLabel">TP1</span>
            <span className="signalPriceValue" data-empty={tp1 == null ? "true" : "false"}>
              {formatPrice(tp1)}
            </span>
          </div>
          <div className="signalPriceBlock" data-type="TP">
            <span className="signalPriceLabel">TP2</span>
            <span className="signalPriceValue" data-empty={tp2 == null ? "true" : "false"}>
              {formatPrice(tp2)}
            </span>
          </div>
          <div className="signalPriceBlock" data-type="TP">
            <span className="signalPriceLabel">TP3</span>
            <span className="signalPriceValue" data-empty={tp3 == null ? "true" : "false"}>
              {formatPrice(tp3)}
            </span>
          </div>
        </div>
      )}

      <div className="signalMetrics">
        <div className="signalMetricBox">
          <span className="signalMetricLabel">СИЛА</span>
          <span className="signalMetricValue">{Math.round(s.score)} / 100</span>
          <span className="signalMetricSub">Оценка совпадения условий стратегии</span>
        </div>
        <div className="signalMetricBox">
          <span className="signalMetricLabel">ПОДТВЕРЖДЕНИЯ</span>
          <span className="signalMetricValue">
            {s.confirmationCount != null && s.confirmationTotal != null ? `${s.confirmationCount} / ${s.confirmationTotal}` : s.participantCount ? `${s.participantCount}` : "—"}
          </span>
          <span className="signalMetricSub">Подтверждения стратегии</span>
        </div>
      </div>

      <div className="signalRef">
        {s.referenceExchange && (
          <span>
            Биржа: <b>{s.referenceExchange}</b>
          </span>
        )}
        {candle && (
          <span>
            Время сигнала: <b>{candle.local}</b> <span style={{ opacity: 0.7 }}>({candle.utc} UTC)</span>
          </span>
        )}
      </div>

      {(tp1Hit || tp2Hit || tp3Hit || stopped || tp3Done || effectiveStatus === "TP1_HIT" || effectiveStatus === "TP2_HIT") && (
        <div className="signalOutcomeMilestones">
          <span className="milestone" data-hit={tp1Hit ? "true" : "false"}>
            {tp1Hit ? "✓" : "○"} TP1
          </span>
          <span className="milestone" data-hit={tp2Hit ? "true" : "false"}>
            {tp2Hit ? "✓" : "○"} TP2
          </span>
          <span className="milestone" data-hit={tp3Hit ? "true" : "false"}>
            {tp3Hit ? "✓" : "○"} TP3
          </span>
          {stopped && (
            <span className="milestone" data-type="STOP" data-hit="true">
              ✕ СТОП
            </span>
          )}
          {effectiveStatus === "EXPIRED" && (
            <span className="milestone" data-hit="false">
              ◷ Завершён по времени
            </span>
          )}
        </div>
      )}
    </div>
  );
}

export default async function SignalsPage() {
  let signals: SignalWithOutcome[] = [];
  let error: string | null = null;

  try {
    const rows = await prisma.signal.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      include: {
        strategy: { select: { id: true, name: true, slug: true, version: true } },
        outcome: true,
      },
    });
    signals = rows as any;
  } catch (e: any) {
    error = e.message;
  }

  const liveSignals = signals.filter((s) => s.signalSource === "LIVE_FORWARD");
  const legacySignals = signals.filter((s) => s.signalSource !== "LIVE_FORWARD");

  // Sort: new top already, but ensure LIVE first visually
  // liveSignals already desc, legacy desc

  return (
    <main className="shell">
      <div className="signalsPage">
        <div className="signalsHero">
          <h1>Торговые сигналы</h1>
          <p>Торговые сигналы алгоритмических стратегий</p>
          <p style={{ marginTop: "6px", fontSize: "13px", opacity: 0.9 }}>Сигналы носят информационный характер.</p>
        </div>

        {error && (
          <div className="tableBox" style={{ padding: "1rem", color: "#b91c1c", background: "#fef2f2", marginTop: "16px" }}>
            Ошибка загрузки сигналов: {error}
          </div>
        )}

        {!error && signals.length === 0 && (
          <div className="signalsEmpty">
            <b>Активных сигналов пока нет.</b>
            <span>Стратегии продолжают анализировать рынок.</span>
          </div>
        )}

        {!error && signals.length > 0 && (
          <>
            <div className="signalsList">
              {liveSignals.map((s) => (
                <SignalCard key={s.id} s={s} />
              ))}
            </div>

            {legacySignals.length > 0 && (
              <>
                <div className="signalsSectionTitle">История / Legacy</div>
                <div className="signalsList">
                  {legacySignals.map((s) => (
                    <SignalCard key={s.id} s={s} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </main>
  );
}
