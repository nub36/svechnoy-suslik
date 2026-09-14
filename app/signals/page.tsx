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
    "5m": "5м",
    "15m": "15м",
    "1h": "1ч",
    "4h": "4ч",
    "1d": "1д",
  };
  return map[tf] ?? tf;
}

function strategyLabel(slug: string, name: string): string {
  const map: Record<string, string> = {
    "trend-suslik": "Trend",
    "smart-money-suslik": "SM V1",
    "smart-money-v2": "SM V2",
  };
  return map[slug] ?? name;
}

function statusLabel(status: string): string {
  const map: Record<string, string> = {
    WAITING_ENTRY: "ОЖИДАЕТСЯ ВХОД",
    OPEN: "В РАБОТЕ",
    TP1_HIT: "TP1",
    TP2_HIT: "TP2",
    TP3_HIT: "TP3",
    STOPPED: "СТОП",
    EXPIRED: "ЗАВЕРШЁН",
    ENTRY_DATA_MISSING: "НЕТ ДАННЫХ",
    ACTIVE: "АКТИВЕН",
  };
  return map[status] ?? status;
}

function formatPrice(v: number | null | undefined): string {
  if (v == null) return "—";
  if (v >= 1000) return v.toLocaleString("ru-RU", { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  if (v >= 1) return v.toLocaleString("ru-RU", { maximumFractionDigits: 3 });
  return v.toLocaleString("ru-RU", { maximumFractionDigits: 5 });
}

function formatCandleTime(dt: Date | null): string | null {
  if (!dt) return null;
  const d = new Date(dt);
  return d.toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function SignalCard({ s }: { s: SignalWithOutcome }) {
  const isLegacy = s.signalSource === "LEGACY";
  const isLive = s.signalSource === "LIVE_FORWARD";
  const dir = s.direction === "LONG" || s.direction === "SHORT" ? s.direction : "LONG";
  const outcome = s.outcome;
  const effectiveStatus = outcome?.status ?? (s.entry == null && s.signalSource === "LIVE_FORWARD" ? "WAITING_ENTRY" : s.status);

  const entry = outcome?.entryPrice ?? s.entry;
  const sl = outcome?.stopLoss ?? s.stopLoss;
  const tp1 = outcome?.takeProfit1 ?? s.takeProfit1;
  const tp2 = outcome?.takeProfit2 ?? s.takeProfit2;
  const tp3 = outcome?.takeProfit3 ?? s.takeProfit3;

  const isWaitingEntry = effectiveStatus === "WAITING_ENTRY" || (entry == null && isLive);
  const candle = formatCandleTime(s.signalCandleTime);

  const tp1Hit = !!outcome?.tp1HitAt;
  const tp2Hit = !!outcome?.tp2HitAt;
  const tp3Hit = !!outcome?.tp3HitAt;
  const stopped = effectiveStatus === "STOPPED";

  return (
    <div className="signalCard" data-dir={dir} data-legacy={isLegacy ? "true" : "false"}>
      {/* Compact header: symbol/direction + meta + status in one row */}
      <div className="signalCardHeader">
        <div className="signalCardSymbol">
          <b>{s.symbol}/USDT</b>
          <span className="signalDirBadge" data-dir={dir}>
            {dir}
          </span>
          <span className="signalTf">{tfLabel(s.timeframe)}</span>
          <span className="signalStrat">{strategyLabel(s.strategy.slug, s.strategy.name)}</span>
          {isLegacy && <span className="signalLegacyBadge">LEGACY</span>}
          {isLive && !isLegacy && (
            <span className="signalLegacyBadge live">LIVE</span>
          )}
        </div>
        <div className="signalCardRight">
          <span className="signalStatusBadge" data-status={effectiveStatus}>
            {statusLabel(effectiveStatus)}
          </span>
        </div>
      </div>

      {/* Prices row — compact */}
      {isWaitingEntry ? (
        <div className="signalWaitingCompact">
          <span className="waitingIcon">◷</span>
          <b>ОЖИДАЕТСЯ ВХОД</b>
          <span className="waitingSep">·</span>
          <span>{s.timeframe} NEXT BAR OPEN</span>
          {s.referenceExchange && (
            <>
              <span className="waitingSep">·</span>
              <span>{s.referenceExchange}</span>
            </>
          )}
          {candle && (
            <>
              <span className="waitingSep">·</span>
              <span>{candle}</span>
            </>
          )}
        </div>
      ) : (
        <div className="signalPrices">
          <div className="signalPriceBlock" data-type="ENTRY">
            <span className="signalPriceLabel">ВХОД</span>
            <span className="signalPriceValue">{formatPrice(entry)}</span>
          </div>
          <div className="signalPriceBlock" data-type="SL">
            <span className="signalPriceLabel">SL</span>
            <span className="signalPriceValue">{formatPrice(sl)}</span>
          </div>
          <div className="signalPriceBlock" data-type="TP">
            <span className="signalPriceLabel">TP1</span>
            <span className="signalPriceValue">{formatPrice(tp1)}</span>
          </div>
          <div className="signalPriceBlock" data-type="TP">
            <span className="signalPriceLabel">TP2</span>
            <span className="signalPriceValue">{formatPrice(tp2)}</span>
          </div>
          <div className="signalPriceBlock" data-type="TP">
            <span className="signalPriceLabel">TP3</span>
            <span className="signalPriceValue">{formatPrice(tp3)}</span>
          </div>
        </div>
      )}

      {/* Bottom compact row: score, confirmations, exchange, time, milestones */}
      <div className="signalBottomRow">
        <div className="signalBottomLeft">
          <span className="signalMiniMetric">
            <span className="miniLabel">СИЛА</span>
            <b>{Math.round(s.score)}</b>
          </span>
          <span className="signalMiniMetric">
            <span className="miniLabel">ПОДТВ</span>
            <b>{s.confirmationCount != null && s.confirmationTotal != null ? `${s.confirmationCount}/${s.confirmationTotal}` : s.participantCount ? `${s.participantCount}` : "—"}</b>
          </span>
          {s.referenceExchange && !isWaitingEntry && (
            <span className="signalMiniMeta">{s.referenceExchange}</span>
          )}
          {candle && !isWaitingEntry && (
            <span className="signalMiniMeta">{candle}</span>
          )}
        </div>
        <div className="signalBottomRight">
          {(tp1Hit || tp2Hit || tp3Hit || stopped || effectiveStatus === "TP1_HIT" || effectiveStatus === "TP2_HIT" || effectiveStatus === "TP3_HIT") && (
            <div className="signalOutcomeMilestones">
              <span className="milestone" data-hit={tp1Hit ? "true" : "false"}>
                {tp1Hit ? "✓TP1" : "○TP1"}
              </span>
              <span className="milestone" data-hit={tp2Hit ? "true" : "false"}>
                {tp2Hit ? "✓TP2" : "○TP2"}
              </span>
              <span className="milestone" data-hit={tp3Hit ? "true" : "false"}>
                {tp3Hit ? "✓TP3" : "○TP3"}
              </span>
              {stopped && (
                <span className="milestone stop" data-hit="true">
                  ✕СТОП
                </span>
              )}
            </div>
          )}
          {outcome?.exitPrice != null && (
            <span className="signalMiniMeta">Выход {formatPrice(outcome.exitPrice)}</span>
          )}
        </div>
      </div>
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

  return (
    <main className="shell">
      <div className="signalsPage">
        <div className="signalsHero">
          <h1>Сигналы</h1>
          <p>BTC/USDT · информационный характер · {liveSignals.length} LIVE · {signals.length} всего</p>
        </div>

        {error && (
          <div className="tableBox" style={{ padding: "1rem", color: "#b91c1c", background: "#fef2f2", marginTop: "12px" }}>
            Ошибка загрузки: {error}
          </div>
        )}

        {!error && signals.length === 0 && (
          <div className="signalsEmpty">
            <b>Сигналов пока нет.</b>
            <span>Стратегии анализируют рынок.</span>
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
                <div className="signalsSectionTitle">История / Legacy · {legacySignals.length}</div>
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
