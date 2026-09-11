"use client";

import { isSmcPanelVisible } from "@/lib/chart/smc-panel";
import type {
  SmcPanelPhase,
  SmcPanelView,
} from "@/lib/chart/smc-panel";

/**
 * P1-C — панель Smart Money под controls графика.
 *
 * ТОНКИЙ слой: вся интерпретация DTO — в чистом
 * `lib/chart/smc-panel.ts` (там же тесты). Компонент умеет только:
 *  - показать loading/ошибка/результат;
 *  - напечатать aggregate-сводку (по активу, несколько бирж);
 *  - напечатать per-exchange строки и их причины (WHY);
 * и НИЧЕГО не пересчитывает.
 *
 * Не рисует primitives поверх свечей (это P1-D) и не имеет
 * отношения к Strategy.enabled: toggle — локальное состояние UI.
 */

type Props = {
  phase: SmcPanelPhase;
  view: SmcPanelView | null;
  error: string | null;
  onRetry: () => void;
};

const VERDICT_CLASS: Record<string, string> = {
  long: "smcVerdict smcVerdict--long",
  short: "smcVerdict smcVerdict--short",
  neutral: "smcVerdict smcVerdict--neutral",
  unavailable: "smcVerdict smcVerdict--none",
};

export default function SmartMoneyPanel({
  phase,
  view,
  error,
  onRetry,
}: Props) {
  if (!isSmcPanelVisible(phase)) {
    return null;
  }

  if (phase === "loading") {
    return (
      <div className="smcPanel" role="status">
        <span className="smcTitle">Smart Money</span>
        <span className="muted">
          Считаем по закрытым свечам PostgreSQL…
        </span>
      </div>
    );
  }

  if (phase === "error" || view === null) {
    return (
      <div className="smcPanel smcPanel--error" role="status">
        <span className="smcTitle">Smart Money</span>
        <span>
          ⚠ {error ?? "Не удалось получить данные стратегии"}
        </span>
        <button
          type="button"
          className="chip"
          onClick={onRetry}
        >
          Повторить
        </button>
      </div>
    );
  }

  return (
    <div className="smcPanel">
      <div className="smcHead">
        <span className="smcTitle">
          {view.headline}
        </span>
        <span className={VERDICT_CLASS[view.verdict]}>
          {view.verdictLabel}
        </span>
        {view.confirmationLabel ? (
          <span className="smcChip">
            {view.confirmationLabel}
          </span>
        ) : null}
      </div>

      <div className="smcLine muted">
        {view.countsLabel}
      </div>
      <div className="smcLine muted">
        {view.horizonLabel} · {view.asOfLabel}
      </div>
      <div className="smcLine muted">
        {view.freshnessLabel}
      </div>

      {view.excludedLabel ? (
        <div className="smcLine smcLine--warn">
          {view.excludedLabel}
        </div>
      ) : null}

      {view.refusalLines.length > 0 ? (
        <ul className="smcList">
          {view.refusalLines.map((line, index) => (
            <li key={`refusal-${index}`}>
              {line}
            </li>
          ))}
        </ul>
      ) : null}

      {view.markets.length > 0 ? (
        <details className="smcMarkets">
          <summary>
            Биржи и причины ({view.markets.length})
          </summary>
          <div className="smcMarketsNote muted">
            {view.marketsNote}
          </div>
          {view.markets.map((market) => (
            <div
              className="smcMarket"
              key={`${market.exchange}-${market.market}`}
            >
              <div className="smcMarketHead">
                <span className="smcMarketName">
                  {market.title}
                </span>
                <span className="smcMarketStatus muted">
                  {market.statusLabel}
                </span>
                <span
                  className={VERDICT_CLASS[market.verdict]}
                >
                  {market.verdictLabel}
                </span>
              </div>
              {market.scoresText ||
              market.horizonText ||
              market.statusReason ||
              market.availabilityText ? (
                <div className="smcLine muted">
                  {[
                    market.scoresText,
                    market.horizonText,
                    market.availabilityText,
                    market.statusReason,
                  ]
                    .filter(
                      (part): part is string =>
                        part !== null && part !== ""
                    )
                    .join(" · ")}
                </div>
              ) : null}

              {market.reasons.length > 0 ? (
                <ul className="smcReasons">
                  {market.reasons.map(
                    (reason, reasonIndex) => (
                      <li
                        key={`${market.exchange}-${reason.code}-${reasonIndex}`}
                        className="smcReason"
                      >
                        <span className="smcReasonLabel">
                          {reason.label}
                        </span>
                        <span className="smcReasonPoints muted">
                          {reason.pointsText}
                        </span>
                        {reason.valueText ? (
                          <span className="smcReasonValue muted">
                            {reason.valueText}
                          </span>
                        ) : null}
                        {reason.hasFact ? (
                          <span className="smcReasonFact">
                            факт отмечен
                          </span>
                        ) : null}
                      </li>
                    )
                  )}
                </ul>
              ) : null}
            </div>
          ))}
        </details>
      ) : (
        <div className="smcLine muted">
          {view.marketsNote}
        </div>
      )}

      {view.technicalVisible ? (
        <div className="smcTechnical muted">
          {view.statusReason}
        </div>
      ) : null}
      <div className="smcDisclaimer muted">
        {view.disclaimer}
      </div>
    </div>
  );
}
