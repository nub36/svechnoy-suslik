/**
 * P1-C — Smart Money: UI-only интеграция принятого P1-A/P1-B DTO
 * в существующий CandleChart.
 *
 * РОЛЬ МОДУЛЯ (presentation + request/state-механика, ничего больше):
 *  - чистая машина состояний SMC-запроса (toggle / смена symbol-timeframe /
 *    ответ / отмена / unmount) — race-safety БЕЗ React, детерминированно
 *    тестируется в scripts/test-smc-panel.ts;
 *  - commit-гейт (createSmcCommitter): применяет переход к ref-state и
 *    React-сеттерам, отменяет активный запрос и НЕ пишет React state из
 *    cleanup после unmount;
 *  - построитель URL GET /api/chart/smc (ТОЛЬКО symbol + timeframe);
 *  - view-model панели из ФАКТИЧЕСКИХ полей SmcChartProjection (P1-A);
 *  - презентационный React-компонент панели (без собственного state/fetch).
 *
 * UX: PROGRESSIVE DISCLOSURE. Default view компактный (вердикт, note,
 * подтверждение, оценено/участников, выбранная биржа, скоуп, горизонт);
 * «Почему» каждой биржи и «Технические детали» (полный statusReason с
 * relative/absolute lag, голоса, asOf, gate refusals, per-exchange
 * statusReason) — в native <details>, collapsed по умолчанию. Internal
 * reason.code, raw deterministic value (SMC1|…) и factIds в UI не
 * показываются, но сохраняются в view-model без изменений (P1-D).
 *
 * ЧЕГО ЗДЕСЬ НЕТ (границы P1-C):
 *  - второго DTO/контракта нет: все поля берутся из
 *    lib/chart/smc-contract.ts как есть, ничего не изобретается;
 *  - Strategy.enabled/status, admin API, PostgreSQL, Signal, worker'ы —
 *    не задействованы: toggle чисто UI-state (React local state);
 *  - отрисовки SMC-примитивов поверх свечей (swing/BOS/CHoCH/liquidity/
 *    sweep/FVG/OB/dealing range/premium-equilibrium-discount) нет — это P1-D;
 *  - реконструкции factIds нет: OB_FVG_CONFLUENCE остаётся [] ВСЕГДА,
 *    exact OB/FVG factIds проходят passthrough (понадобятся в P1-D);
 *  - exchange-параметра в запросе нет: свечи графика — выбранная биржа,
 *    а Smart Money DTO — asset-level мультибиржевая оценка; выбранная
 *    биржа лишь помечается в per-exchange списке и НЕ выдаётся за агрегат.
 *
 * СЕМАНТИКА СОСТОЯНИЙ (критично): off → loading → http-error | ready;
 * внутри ready verdict строго различает evaluated NEUTRAL и
 * cannot-evaluate (нет участников / unsafe alignment / недостаточно
 * данных). cannot-evaluate НИКОГДА не превращается в direction=NEUTRAL,
 * а отказ aggregation gate не показывается как успешный агрегат.
 *
 * ЧИСТОТА: без Prisma/DB/admin/Signal/fetch внутри view-model (fetch
 * делает CandleChart), без Date.now и localStorage; импорты — только
 * React-типы и type-only принятый DTO.
 */
import type { CSSProperties, ReactElement } from "react";
import type {
  SmcAggregateSummaryDto,
  SmcChartProjection,
  SmcExchangeSummaryDto,
  SmcMarketOverlayDto,
  SmcOverlayMarketStatus,
  SmcOverlayReasonDto,
} from "@/lib/chart/smc-contract";

/** Direction-домен из принятого DTO (собственных литералов нет). */
type SmcDirectionValue = NonNullable<SmcExchangeSummaryDto["direction"]>;

// ------------------------------------------------------------------
// 1. URL запроса: ТОЛЬКО symbol + timeframe (никакого exchange)
// ------------------------------------------------------------------

/** Существующий read-only P1-B endpoint (принят на baseline). */
export const SMC_API_PATH = "/api/chart/smc";

/**
 * URL SMC-запроса для ТЕКУЩИХ symbol/timeframe CandleChart.
 *
 * Оба параметра экранируются encodeURIComponent — тот же способ, что и
 * в существующем запросе /api/chart/candles. Exchange СОЗНАТЕЛЬНО не
 * передаётся: основной график показывает выбранную биржу, а Smart Money
 * DTO является asset-level мультибиржевой оценкой (агрегат + per-exchange
 * сводки), поэтому exchange-параметр смешал бы два разных понятия.
 */
export function buildSmcRequestUrl(symbol: string, timeframe: string): string {
  return (
    `${SMC_API_PATH}?symbol=${encodeURIComponent(symbol)}` +
    `&timeframe=${encodeURIComponent(timeframe)}`
  );
}

/** Запрос выдаётся только при непустых symbol и timeframe. */
export function isSmcRequestReady(symbol: string, timeframe: string): boolean {
  return symbol.trim() !== "" && timeframe.trim() !== "";
}

// ------------------------------------------------------------------
// 2. Состояние панели: off / loading / http-error / ready
// ------------------------------------------------------------------

export const SMC_PANEL_OFF = { status: "off" } as const;

export type SmcPanelState =
  | { status: "off" }
  | { status: "loading"; symbol: string; timeframe: string }
  | {
      status: "http-error";
      symbol: string;
      timeframe: string;
      /** null — сетевая ошибка (HTTP-статуса нет). */
      httpStatus: number | null;
      message: string;
    }
  | {
      status: "ready";
      symbol: string;
      timeframe: string;
      projection: SmcChartProjection;
    };

/** Сообщение сетевой ошибки — тот же русский текст, что и у свечей. */
export const SMC_NETWORK_ERROR_MESSAGE = "Ошибка соединения с сервером";

/** Отмена запроса: та же проверка AbortError, что и в CandleChart. */
export function isSmcAbortError(error: unknown): boolean {
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }

  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

// ------------------------------------------------------------------
// 3. Разбор HTTP-ответа: сужение до принятого DTO, НЕ новый контракт
// ------------------------------------------------------------------

export type SmcBodyParse =
  | { ok: true; projection: SmcChartProjection }
  | { ok: false; message: string };

/**
 * Структурная проверка тела ответа: убеждаемся, что пришёл именно
 * принятый P1-A SmcChartProjection (assetSymbol/timeframe/overlays/
 * aggregate), чтобы повреждённый ответ не уронил график. Новых полей
 * здесь не появляется — это только type-narrowing.
 */
export function parseSmcBody(body: unknown): SmcBodyParse {
  if (body === null || typeof body !== "object") {
    return { ok: false, message: "Ответ Smart Money не является объектом" };
  }

  const candidate = body as Partial<SmcChartProjection>;

  if (
    typeof candidate.assetSymbol !== "string" ||
    typeof candidate.timeframe !== "string" ||
    !Array.isArray(candidate.overlays) ||
    typeof candidate.aggregate !== "object" ||
    candidate.aggregate === null
  ) {
    return {
      ok: false,
      message: "Ответ Smart Money не соответствует принятому DTO (P1-A)",
    };
  }

  const aggregate = candidate.aggregate as Partial<SmcAggregateSummaryDto>;

  if (
    typeof aggregate.status !== "string" ||
    !Array.isArray(aggregate.perExchange)
  ) {
    return {
      ok: false,
      message: "Ответ Smart Money не соответствует принятому DTO (aggregate)",
    };
  }

  return { ok: true, projection: body as SmcChartProjection };
}

/**
 * Русское сообщение HTTP-ошибки: серверный { error } (P1-B отдаёт
 * безопасное русское сообщение) + статус. Без stack/secrets.
 */
export function smcHttpErrorMessage(httpStatus: number, body: unknown): string {
  const serverMessage =
    typeof body === "object" &&
    body !== null &&
    typeof (body as { error?: unknown }).error === "string"
      ? (body as { error: string }).error.trim()
      : "";

  const base =
    serverMessage !== "" ? serverMessage : "Не удалось загрузить Smart Money";

  return `${base} (HTTP ${httpStatus})`;
}

// ------------------------------------------------------------------
// 4. Машина состояний запроса (чистая, race-safe)
// ------------------------------------------------------------------

export interface SmcControllerState {
  /** UI-toggle «Смарт Мани» (НЕ Strategy.enabled). */
  enabled: boolean;
  symbol: string;
  timeframe: string;
  /** Identity последнего ВЫДАННОГО запроса (0 — запросов не было). */
  activeRequestId: number;
  panel: SmcPanelState;
}

export type SmcEvent =
  | { type: "toggle"; enabled: boolean; symbol: string; timeframe: string }
  /** symbol/timeframe изменились; exchange сюда СОЗНАТЕЛЬНО не входит. */
  | { type: "params"; symbol: string; timeframe: string }
  | { type: "unmount" }
  | {
      type: "http-response";
      requestId: number;
      ok: boolean;
      httpStatus: number;
      body: unknown;
    }
  | { type: "network-error"; requestId: number; message: string }
  | { type: "aborted"; requestId: number };

export interface SmcTransition {
  state: SmcControllerState;
  /** Новый запрос, который вызывающий код обязан выполнить. */
  fetch: { requestId: number; url: string } | null;
  /** Предыдущий in-flight запрос обязан быть отменён (AbortController). */
  abortPrevious: boolean;
  changed: boolean;
}

export function createSmcControllerState(): SmcControllerState {
  return {
    enabled: false,
    symbol: "",
    timeframe: "",
    activeRequestId: 0,
    panel: SMC_PANEL_OFF,
  };
}

function unchanged(state: SmcControllerState): SmcTransition {
  return { state, fetch: null, abortPrevious: false, changed: false };
}

/**
 * Новый запрос: requestId строго растёт, панель уходит в loading,
 * предыдущий запрос помечается к отмене. Именно requestId отвечает за
 * игнорирование устаревших ответов (stale response не может overwrite
 * новый state), AbortController — за отмену самой сети.
 */
function startRequest(
  state: SmcControllerState,
  symbol: string,
  timeframe: string
): SmcTransition {
  const requestId = state.activeRequestId + 1;

  return {
    state: {
      enabled: true,
      symbol,
      timeframe,
      activeRequestId: requestId,
      panel: { status: "loading", symbol, timeframe },
    },
    fetch: { requestId, url: buildSmcRequestUrl(symbol, timeframe) },
    abortPrevious: true,
    changed: true,
  };
}

function responsePanel(
  state: SmcControllerState,
  event: Extract<SmcEvent, { type: "http-response" }>
): SmcPanelState {
  if (!event.ok) {
    return {
      status: "http-error",
      symbol: state.symbol,
      timeframe: state.timeframe,
      httpStatus: event.httpStatus,
      message: smcHttpErrorMessage(event.httpStatus, event.body),
    };
  }

  const parsed = parseSmcBody(event.body);

  if (!parsed.ok) {
    return {
      status: "http-error",
      symbol: state.symbol,
      timeframe: state.timeframe,
      httpStatus: event.httpStatus,
      message: parsed.message,
    };
  }

  return {
    status: "ready",
    symbol: state.symbol,
    timeframe: state.timeframe,
    projection: parsed.projection,
  };
}

/**
 * Единственная точка перехода состояния SMC-панели.
 *
 * ГАРАНТИИ:
 *  - OFF: панель { status: "off" } (stale-результат не остаётся видимым)
 *    + отмена предыдущего запроса;
 *  - ответ принимается ТОЛЬКО если панель включена И requestId совпал с
 *    activeRequestId — иначе событие игнорируется целиком;
 *  - отменённый запрос ("aborted") не меняет НИЧЕГО;
 *  - смена symbol/timeframe при ON — новый requestId и новый запрос;
 *  - смена exchange запрос не создаёт (Smart Money — asset-level).
 */
export function reduceSmcState(
  state: SmcControllerState,
  event: SmcEvent
): SmcTransition {
  switch (event.type) {
    case "toggle": {
      if (!event.enabled) {
        if (!state.enabled && state.panel.status === "off") {
          return unchanged(state);
        }

        return {
          state: {
            ...state,
            enabled: false,
            symbol: event.symbol,
            timeframe: event.timeframe,
            panel: SMC_PANEL_OFF,
          },
          fetch: null,
          abortPrevious: state.enabled,
          changed: true,
        };
      }

      // Включение без готовых параметров: запрос не выдаём, панель
      // скрыта; fetch случится событием params, когда symbol разрешится.
      if (!isSmcRequestReady(event.symbol, event.timeframe)) {
        return {
          state: {
            ...state,
            enabled: true,
            symbol: event.symbol,
            timeframe: event.timeframe,
            panel: SMC_PANEL_OFF,
          },
          fetch: null,
          abortPrevious: false,
          changed: true,
        };
      }

      if (
        state.enabled &&
        state.symbol === event.symbol &&
        state.timeframe === event.timeframe &&
        state.panel.status !== "off"
      ) {
        return unchanged(state);
      }

      return startRequest(state, event.symbol, event.timeframe);
    }

    case "params": {
      // Выключено — параметры не трогают панель и не создают запрос.
      if (!state.enabled) {
        return unchanged(state);
      }

      if (state.symbol === event.symbol && state.timeframe === event.timeframe) {
        return unchanged(state);
      }

      if (!isSmcRequestReady(event.symbol, event.timeframe)) {
        return {
          state: {
            ...state,
            symbol: event.symbol,
            timeframe: event.timeframe,
            panel: SMC_PANEL_OFF,
          },
          fetch: null,
          abortPrevious: true,
          changed: true,
        };
      }

      return startRequest(state, event.symbol, event.timeframe);
    }

    case "unmount": {
      return {
        state: { ...state, enabled: false, panel: SMC_PANEL_OFF },
        fetch: null,
        abortPrevious: true,
        changed: true,
      };
    }

    case "aborted": {
      // Отменённый (abort / off / смена параметров) запрос игнорируется.
      return unchanged(state);
    }

    case "http-response":
    case "network-error": {
      // OFF или устаревший requestId → событие не имеет права менять
      // state: старый ответ не может перезаписать новый.
      if (!state.enabled) {
        return unchanged(state);
      }

      if (event.requestId !== state.activeRequestId) {
        return unchanged(state);
      }

      const panel: SmcPanelState =
        event.type === "network-error"
          ? {
              status: "http-error",
              symbol: state.symbol,
              timeframe: state.timeframe,
              httpStatus: null,
              message: event.message,
            }
          : responsePanel(state, event);

      return {
        state: { ...state, panel },
        fetch: null,
        abortPrevious: false,
        changed: true,
      };
    }
  }
}

// ------------------------------------------------------------------
// 4b. Commit-гейт: применение перехода к ref-state и React-сеттерам
// ------------------------------------------------------------------

/**
 * Точка подключения машины состояний к React (host передаётся
 * CandleChart'ом): два стабильных setState и отмена активного запроса.
 */
export interface SmcCommitHost {
  setEnabled(enabled: boolean): void;
  setPanel(panel: SmcPanelState): void;
  /** AbortController активного запроса — вызывается ВСЕГДА, даже после unmount. */
  abortActive(): void;
}

export interface SmcCommitter {
  /** Source of truth для следующего dispatch (переживает unmount). */
  getState(): SmcControllerState;
  commit(transition: SmcTransition): void;
  /** Cleanup: React-записи запрещены, abort и ref-state продолжают работать. */
  markUnmounted(): void;
  /** Remount (dev StrictMode double-invoke): React-записи снова разрешены. */
  markMounted(): void;
  isMounted(): boolean;
}

/**
 * LIFECYCLE-РЕШЕНИЕ (fix по ревью P1-C): unmount обязан
 *  1) отменить активный SMC-запрос — abort выполняется независимо от
 *     mounted-флага, поэтому in-flight запрос действительно отменён;
 *  2) не дать устаревшему async-ответу что-либо изменить — переход
 *     "unmount" переводит ref-state в enabled=false, а ответ
 *     принимается только при enabled && requestId === activeRequestId
 *     (двойной гард поверх abort);
 *  3) НЕ делать лишних React setState из cleanup — после
 *     markUnmounted() commit обновляет только ref-state и не вызывает
 *     сеттеры (setState размонтированному компоненту не нужен).
 *
 * Request/race-семантика reduceSmcState при этом не меняется вовсе:
 * гейт решает ТОЛЬКО «писать ли в React state».
 */
export function createSmcCommitter(
  initial: SmcControllerState,
  host: SmcCommitHost
): SmcCommitter {
  let state = initial;
  let mounted = true;

  return {
    getState: () => state,
    isMounted: () => mounted,
    markMounted: () => {
      mounted = true;
    },
    markUnmounted: () => {
      mounted = false;
    },
    commit(transition: SmcTransition): void {
      // Отмена запроса — всегда (в том числе после unmount).
      if (transition.abortPrevious) {
        host.abortActive();
      }

      if (!transition.changed) {
        return;
      }

      // Ref-state обновляется всегда: это гард для поздних ответов.
      state = transition.state;

      // После unmount React state не пишем.
      if (!mounted) {
        return;
      }

      host.setEnabled(state.enabled);
      host.setPanel(state.panel);
    },
  };
}

// ------------------------------------------------------------------
// 5. View-model: ТОЛЬКО фактические поля SmcChartProjection
// ------------------------------------------------------------------

export type SmcAggregateVerdict = "long" | "short" | "neutral" | "cannot-evaluate";

export type SmcVerdictTone = "positive" | "negative" | "muted" | "blocked";

export const SMC_VERDICT_LABELS: Record<SmcAggregateVerdict, string> = {
  long: "LONG",
  short: "SHORT",
  neutral: "NEUTRAL",
  "cannot-evaluate": "Нет оценки",
};

export const SMC_VERDICT_NOTES: Record<SmcAggregateVerdict, string> = {
  long: "Агрегированная мультибиржевая оценка дала направление LONG.",
  short: "Агрегированная мультибиржевая оценка дала направление SHORT.",
  neutral: "Оценка выполнена: направления нет (NEUTRAL). Это не «нет данных».",
  "cannot-evaluate": "Оценка НЕ выполнена — вывод сделать нельзя. Это не NEUTRAL.",
};

export const SMC_VERDICT_TONES: Record<SmcAggregateVerdict, SmcVerdictTone> = {
  long: "positive",
  short: "negative",
  neutral: "muted",
  "cannot-evaluate": "blocked",
};

/**
 * Verdict агрегата строго по фактическим полям DTO.
 *
 * cannot-evaluate возвращается, когда агрегата по сути нет:
 *  - unusable либо не-ok common horizon (нет участников, нет данных,
 *    рассинхрон, будущий горизонт);
 *  - evaluatedCount === 0;
 *  - gateAllowed === false (unsafe alignment / anchor / horizon: отказ
 *    агрегации НЕ показывается как успешный агрегат);
 *  - direction === null либо CANNOT_EVALUATE.
 * NEUTRAL возвращается ТОЛЬКО когда оценка реально выполнена.
 */
export function smcAggregateVerdict(
  aggregate: SmcAggregateSummaryDto
): SmcAggregateVerdict {
  if (!aggregate.usable || aggregate.status !== "ok") {
    return "cannot-evaluate";
  }

  if (aggregate.evaluatedCount === 0) {
    return "cannot-evaluate";
  }

  if (!aggregate.gateAllowed) {
    return "cannot-evaluate";
  }

  switch (aggregate.direction) {
    case "LONG":
      return "long";
    case "SHORT":
      return "short";
    case "NEUTRAL":
      return "neutral";
    default:
      // null / CANNOT_EVALUATE — честный отказ, НЕ нейтраль.
      return "cannot-evaluate";
  }
}

/** Русские label статусов общего горизонта (исчерпывающе по домену DTO). */
export const SMC_HORIZON_STATUS_LABELS: Record<
  SmcAggregateSummaryDto["status"],
  string
> = {
  ok: "общий закрытый горизонт есть",
  no_participants: "нет участников после exchange eligibility и фильтров",
  data_unavailable: "у участника нет canonical закрытой свечи",
  no_common_horizon: "у участников нет общего закрытого горизонта",
  relative_lag_stale: "рассинхрон бирж больше относительного лимита",
  absolute_stale: "общий горизонт старше ожидаемой закрытой свечи",
  future_horizon: "горизонт новее ожидаемой закрытой свечи",
};

export function smcHorizonStatusLabel(
  status: SmcAggregateSummaryDto["status"]
): string {
  return SMC_HORIZON_STATUS_LABELS[status];
}

export function smcDirectionLabel(direction: SmcDirectionValue | null): string {
  switch (direction) {
    case "LONG":
      return "LONG";
    case "SHORT":
      return "SHORT";
    case "NEUTRAL":
      return "NEUTRAL";
    case "CANNOT_EVALUATE":
      return "нет оценки";
    default:
      return "—";
  }
}

export function smcMarketStatusLabel(status: SmcOverlayMarketStatus): string {
  switch (status) {
    case "evaluated":
      return "оценён";
    case "cannot-evaluate":
      return "не оценён";
    case "filtered":
      return "отфильтрован";
  }
}

/** Баллы — это баллы стратегии. Никаких «вероятностей» и процентов. */
export function formatSmcScore(score: number | null): string {
  return score === null ? "—" : String(score);
}

/** ms (домен DTO) → человекочитаемое UTC-время (convention страницы монеты). */
export function formatSmcUtcMs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function formatNullableUtcMs(ms: number | null): string | null {
  return ms === null ? null : formatSmcUtcMs(ms);
}

/**
 * WHY-строка: passthrough принятых P1-A полей reason.
 * factIds НЕ реконструируются и НЕ мутируются: что пришло из DTO
 * (exact OB/FVG ключ либо [] для OB_FVG_CONFLUENCE), то и передаётся
 * дальше (в P1-D — highlighting).
 */
export interface SmcWhyRow {
  code: string;
  label: string;
  longPoints: number;
  shortPoints: number;
  maxPoints: number;
  value: string | null;
  factIds: string[];
}

export function toSmcWhyRows(
  reasons: readonly SmcOverlayReasonDto[]
): SmcWhyRow[] {
  return reasons.map((reason) => ({
    code: reason.code,
    label: reason.label,
    longPoints: reason.longPoints,
    shortPoints: reason.shortPoints,
    maxPoints: reason.maxPoints,
    value: reason.value,
    factIds: [...reason.factIds],
  }));
}

export interface SmcExchangeRow {
  exchange: string;
  market: string;
  marketId: number;
  status: SmcOverlayMarketStatus;
  statusLabel: string;
  /** Причина cannot-evaluate/filtered из overlay (иначе null). */
  statusReason: string | null;
  direction: SmcDirectionValue | null;
  directionLabel: string;
  longScore: number | null;
  shortScore: number | null;
  horizonLabel: string | null;
  /** Эта биржа сейчас выбрана для свечей (НЕ является агрегатом). */
  isSelectedCandleExchange: boolean;
  why: SmcWhyRow[];
}

/**
 * Per-exchange строки: база — aggregate.perExchange (присутствует
 * всегда), обогащение reasons/statusReason — из overlay того же
 * marketId. При unusable горизонте overlays пусты ⇒ WHY пуст, а
 * статусы остаются честными.
 */
export function buildSmcExchangeRows(
  projection: SmcChartProjection,
  selectedExchange: string
): SmcExchangeRow[] {
  const overlays = new Map<number, SmcMarketOverlayDto>();

  for (const overlay of projection.overlays) {
    overlays.set(overlay.marketId, overlay);
  }

  return projection.aggregate.perExchange.map((summary) => {
    const overlay = overlays.get(summary.marketId) ?? null;

    return {
      exchange: summary.exchange,
      market: summary.market,
      marketId: summary.marketId,
      status: summary.status,
      statusLabel: smcMarketStatusLabel(summary.status),
      statusReason: overlay?.statusReason ?? null,
      direction: summary.direction,
      directionLabel: smcDirectionLabel(summary.direction),
      longScore: summary.longScore,
      shortScore: summary.shortScore,
      horizonLabel: formatNullableUtcMs(summary.horizonMs),
      isSelectedCandleExchange:
        selectedExchange !== "" && summary.exchange === selectedExchange,
      why: overlay === null ? [] : toSmcWhyRows(overlay.reasons),
    };
  });
}

export interface SmcAggregateView {
  status: SmcAggregateSummaryDto["status"];
  statusLabel: string;
  statusReason: string;
  usable: boolean;
  gateAllowed: boolean;
  gateRefusalReasons: string[];
  directionLabel: string;
  /** Строка подтверждения из DTO (голоса/участники) — никогда не хардкод. */
  confirmation: string | null;
  minExchanges: number;
  evaluatedCount: number;
  cannotEvaluateCount: number;
  participantCount: number;
  filteredCount: number;
  /** Имена бирж, отсечённых eligibility (например BINGX для 1d). */
  exchangeExcluded: string[];
  conflict: boolean;
  longVotes: number;
  shortVotes: number;
  neutralVotes: number;
  horizonLabel: string | null;
  engineAsOfLabel: string | null;
  lagLabel: string | null;
}

export function buildSmcAggregateView(
  aggregate: SmcAggregateSummaryDto
): SmcAggregateView {
  return {
    status: aggregate.status,
    statusLabel: smcHorizonStatusLabel(aggregate.status),
    statusReason: aggregate.statusReason,
    usable: aggregate.usable,
    gateAllowed: aggregate.gateAllowed,
    gateRefusalReasons: [...aggregate.gateRefusalReasons],
    directionLabel: smcDirectionLabel(aggregate.direction),
    confirmation: aggregate.confirmation,
    minExchanges: aggregate.minExchanges,
    evaluatedCount: aggregate.evaluatedCount,
    cannotEvaluateCount: aggregate.cannotEvaluateCount,
    participantCount: aggregate.participantCount,
    filteredCount: aggregate.filteredCount,
    exchangeExcluded: [...aggregate.exchangeExcluded],
    conflict: aggregate.conflict,
    longVotes: aggregate.longVotes,
    shortVotes: aggregate.shortVotes,
    neutralVotes: aggregate.neutralVotes,
    horizonLabel: formatNullableUtcMs(aggregate.horizonMs),
    engineAsOfLabel: formatNullableUtcMs(aggregate.engineAsOfMs),
    lagLabel:
      aggregate.lagBars === null || aggregate.lagMs === null
        ? null
        : `${aggregate.lagBars} бар · ${aggregate.lagMs} мс`,
  };
}

export interface SmcPanelViewModel {
  assetSymbol: string;
  timeframe: string;
  generatedAtLabel: string;
  verdict: SmcAggregateVerdict;
  verdictLabel: string;
  verdictNote: string;
  verdictTone: SmcVerdictTone;
  aggregate: SmcAggregateView;
  exchanges: SmcExchangeRow[];
  /** Биржа, чьи свечи сейчас на графике (для явного противопоставления). */
  selectedExchange: string;
  candlesScopeLabel: string;
  smcScopeLabel: string;
  /** Выбранная биржа свечей отсечена eligibility из агрегации. */
  selectedExchangeExcluded: boolean;
  selectedExchangeExcludedNote: string | null;
  hasWhy: boolean;
  /**
   * Краткая БЕЗОПАСНАЯ причина отказа — только для cannot-evaluate,
   * чтобы его нельзя было спутать с NEUTRAL в компактном view.
   * Строится из фактических полей DTO (status/evaluatedCount/
   * gateAllowed/direction), без новых trading-объяснений; полная
   * диагностика (statusReason, gateRefusalReasons, lag, asOf) остаётся
   * в модели и показывается в collapsed «Технические детали».
   */
  refusalSummary: string | null;
}

/**
 * Краткая причина cannot-evaluate для default view. Приоритет — по
 * фактическому полю DTO, которое привело к отказу:
 *  1. unusable/не-ok общий горизонт → русский label статуса;
 *  2. ни одна биржа не оценена → короткая честная формулировка;
 *  3. отказ aggregation gate → отсылка к техническим деталям;
 *  4. direction null/CANNOT_EVALUATE → направление не определено.
 */
export function buildSmcRefusalSummary(
  aggregate: SmcAggregateSummaryDto,
  verdict: SmcAggregateVerdict
): string | null {
  if (verdict !== "cannot-evaluate") {
    return null;
  }

  if (!aggregate.usable || aggregate.status !== "ok") {
    return smcHorizonStatusLabel(aggregate.status);
  }

  if (aggregate.evaluatedCount === 0) {
    return "ни одна биржа не дала оценку на общем горизонте";
  }

  if (!aggregate.gateAllowed) {
    return "агрегация отклонена gate — причина в технических деталях";
  }

  return "агрегированное направление не определено";
}

/**
 * View-model панели из ФАКТИЧЕСКОГО DTO. Ничего не додумывается: каждое
 * поле — прямое значение SmcChartProjection либо его русский label
 * (статус/направление), без новой semantics.
 */
export function buildSmcPanelViewModel(
  projection: SmcChartProjection,
  selectedExchange: string
): SmcPanelViewModel {
  const aggregate = projection.aggregate;
  const verdict = smcAggregateVerdict(aggregate);
  const exchanges = buildSmcExchangeRows(projection, selectedExchange);
  const excluded =
    selectedExchange !== "" &&
    aggregate.exchangeExcluded.includes(selectedExchange);

  return {
    assetSymbol: projection.assetSymbol,
    timeframe: projection.timeframe,
    generatedAtLabel: formatSmcUtcMs(projection.generatedAtMs),
    verdict,
    verdictLabel: SMC_VERDICT_LABELS[verdict],
    verdictNote: SMC_VERDICT_NOTES[verdict],
    verdictTone: SMC_VERDICT_TONES[verdict],
    aggregate: buildSmcAggregateView(aggregate),
    exchanges,
    selectedExchange,
    candlesScopeLabel:
      selectedExchange !== ""
        ? `Свечи на графике — одна биржа: ${selectedExchange}`
        : "Свечи на графике — биржа не выбрана",
    smcScopeLabel:
      `Smart Money — агрегированная оценка актива по всем ` +
      `биржам-участникам; участников: ${aggregate.participantCount}`,
    selectedExchangeExcluded: excluded,
    selectedExchangeExcludedNote: excluded
      ? `Выбранная биржа ${selectedExchange} исключена из Smart Money ` +
        `агрегации правилами eligibility; свечи этой биржи при этом ` +
        `показываются на графике.`
      : null,
    hasWhy: exchanges.some((row) => row.why.length > 0),
    refusalSummary: buildSmcRefusalSummary(aggregate, verdict),
  };
}

// ------------------------------------------------------------------
// 6. Презентационный компонент: progressive disclosure
// ------------------------------------------------------------------
//
// UX-FIX P1-C: default view компактный — вердикт, краткая русская
// note, подтверждение и оценено/участников (только из DTO), выбранная
// биржа свечей, скоуп «Smart Money = мультибиржевая агрегированная
// оценка» и одна строка общего горизонта.
//
// Всё остальное — под native <details> (collapsed по умолчанию, без
// новой зависимости):
//  - «Почему» каждой биржи: русский label reason + баллы LONG/SHORT.
//    Internal reason.code, raw deterministic value (SMC1|…) и factIds
//    пользователю НЕ показываются — они сохранены в view-model без
//    изменений для диагностики и будущего P1-D;
//  - «Технические детали»: полный statusReason (включая технический
//    relative/absolute lag), голоса, asOf движка, отставание,
//    отфильтрованные рынки, gate refusal details и per-exchange
//    statusReason.
//
// При cannot-evaluate краткая безопасная причина отказа (refusalSummary)
// показывается В DEFAULT VIEW — спутать с NEUTRAL нельзя.

const PANEL_STYLE: CSSProperties = {
  marginTop: 12,
  padding: 12,
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--panel2)",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  fontSize: 13,
};

const HEADER_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 8,
  alignItems: "baseline",
  justifyContent: "space-between",
};

const LINE_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  alignItems: "baseline",
  fontSize: 13,
};

const STACK_STYLE: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  flexDirection: "column",
  fontSize: 12,
};

const TITLE_STYLE: CSSProperties = {
  color: "var(--muted)",
  fontSize: 11,
};

/** Компактная карточка одной биржи: одна строка + collapsed «Почему». */
const EXCHANGE_STYLE: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "6px 10px",
  background: "var(--panel)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const DETAILS_STYLE: CSSProperties = {
  border: "1px solid var(--line)",
  borderRadius: 10,
  padding: "6px 10px",
  background: "var(--panel)",
};

const SUMMARY_STYLE: CSSProperties = {
  cursor: "pointer",
  color: "var(--muted)",
  fontSize: 12,
};

const WHY_LIST_STYLE: CSSProperties = {
  margin: "6px 0 0",
  paddingLeft: 18,
  display: "flex",
  flexDirection: "column",
  gap: 2,
  fontSize: 12,
};

/** Цвет предупреждения (тот же, что у .freshBadge.delayed в globals.css). */
const BLOCKED_COLOR = "#e8b34b";

function verdictColor(tone: SmcVerdictTone): string {
  switch (tone) {
    case "positive":
      return "var(--green)";
    case "negative":
      return "var(--red)";
    case "blocked":
      return BLOCKED_COLOR;
    default:
      return "var(--muted)";
  }
}

/**
 * WHY одной биржи в user-виде: только русский label и баллы.
 * code/value/factIds намеренно НЕ рендерятся (в модели они есть).
 * reason.code используется лишь как React key — в разметку не попадает.
 */
function WhyList({ rows }: { rows: SmcWhyRow[] }): ReactElement {
  return (
    <ul style={WHY_LIST_STYLE}>
      {rows.map((reason, index) => (
        <li key={`${reason.code}:${index}`}>
          <span>{reason.label}</span>
          <span className="muted">
            {" "}
            · баллы LONG {reason.longPoints}, SHORT {reason.shortPoints}{" "}
            (максимум {reason.maxPoints})
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Панель Smart Money: read-only сводка принятого P1-A DTO.
 * Состояние (off/loading/http-error/ready) приходит из CandleChart —
 * компонент не делает запросов и не хранит собственного state.
 */
export function SmartMoneyPanel({
  panel,
  viewModel,
  timeframeLabelOf,
}: {
  panel: SmcPanelState;
  viewModel: SmcPanelViewModel | null;
  timeframeLabelOf: (timeframe: string) => string;
}): ReactElement | null {
  if (panel.status === "off") {
    return null;
  }

  return (
    <div style={PANEL_STYLE}>
      <div style={HEADER_STYLE}>
        <strong>Смарт Мани</strong>

        <span className="muted" style={{ fontSize: 12 }}>
          агрегированная мультибиржевая оценка · только чтение
        </span>
      </div>

      {panel.status === "loading" && (
        <div className="muted">
          Загрузка Smart Money… {panel.symbol} ·{" "}
          {timeframeLabelOf(panel.timeframe)}
        </div>
      )}

      {panel.status === "http-error" && (
        <div>
          <p style={{ margin: 0, color: "var(--red)" }}>⚠ {panel.message}</p>

          <p className="muted" style={{ margin: "4px 0 0" }}>
            График свечей продолжает работать: ошибка Smart Money изолирована и
            не влияет на загрузку свечей.
          </p>
        </div>
      )}

      {panel.status === "ready" && viewModel !== null && (
        <>
          {/* ---------- компактный default view ---------- */}
          <div style={LINE_STYLE}>
            <strong>
              {viewModel.assetSymbol} ·{" "}
              {timeframeLabelOf(viewModel.timeframe)}
            </strong>
          </div>

          <div style={LINE_STYLE}>
            <span
              className="freshBadge"
              style={{
                color: verdictColor(viewModel.verdictTone),
                fontSize: 13,
              }}
            >
              {viewModel.verdictLabel}
            </span>

            <span className="muted">{viewModel.verdictNote}</span>
          </div>

          {viewModel.refusalSummary !== null && (
            <div style={{ color: BLOCKED_COLOR }}>
              Причина: {viewModel.refusalSummary}
            </div>
          )}

          <div style={LINE_STYLE} className="muted">
            {viewModel.aggregate.gateAllowed && (
              <span>
                Подтверждение{" "}
                {viewModel.aggregate.confirmation ?? "—"} · порог
                minExchanges {viewModel.aggregate.minExchanges}
              </span>
            )}

            <span>
              Оценено {viewModel.aggregate.evaluatedCount} / участников{" "}
              {viewModel.aggregate.participantCount}
            </span>

            {viewModel.aggregate.exchangeExcluded.length > 0 && (
              <span>
                Исключены eligibility:{" "}
                {viewModel.aggregate.exchangeExcluded.join(", ")}
              </span>
            )}

            {viewModel.aggregate.horizonLabel !== null && (
              <span>Общий горизонт: {viewModel.aggregate.horizonLabel}</span>
            )}
          </div>

          <div style={STACK_STYLE}>
            <span className="muted">{viewModel.candlesScopeLabel}</span>

            <span className="muted">{viewModel.smcScopeLabel}</span>

            <span className="muted">
              Результат выбранной биржи НЕ является агрегатом — агрегат выше,
              биржи перечислены отдельно.
            </span>

            {viewModel.selectedExchangeExcludedNote !== null && (
              <span style={{ color: BLOCKED_COLOR }}>
                {viewModel.selectedExchangeExcludedNote}
              </span>
            )}
          </div>

          {/* ---------- компактный список бирж ---------- */}
          <div style={TITLE_STYLE}>
            Результаты по биржам ({viewModel.exchanges.length}) · баллы
            стратегии
          </div>

          {viewModel.exchanges.length === 0 ? (
            <div className="muted">
              Участников для оценки нет — агрегат не построен.
            </div>
          ) : (
            viewModel.exchanges.map((row) => (
              <div
                key={`${row.exchange}:${row.marketId}`}
                style={EXCHANGE_STYLE}
              >
                <div style={LINE_STYLE}>
                  <strong>{row.exchange}</strong>

                  <span>
                    ·{" "}
                    {row.status === "evaluated"
                      ? row.directionLabel
                      : row.statusLabel}
                  </span>

                  <span className="muted">
                    · LONG {formatSmcScore(row.longScore)} · SHORT{" "}
                    {formatSmcScore(row.shortScore)}
                  </span>

                  {row.isSelectedCandleExchange && (
                    <span className="freshBadge missing">
                      биржа свечей на графике
                    </span>
                  )}
                </div>

                {row.why.length > 0 && (
                  <details>
                    <summary style={SUMMARY_STYLE}>Почему</summary>

                    <WhyList rows={row.why} />
                  </details>
                )}
              </div>
            ))
          )}

          {!viewModel.hasWhy && (
            <div className="muted">
              Почему: причин нет — ни одна биржа не дала оцениваемых фактов на
              этом горизонте.
            </div>
          )}

          {/* ---------- полная диагностика: collapsed ---------- */}
          <details style={DETAILS_STYLE}>
            <summary style={SUMMARY_STYLE}>Технические детали</summary>

            <div style={STACK_STYLE}>
              <span className="muted">
                Рассчитано: {viewModel.generatedAtLabel}
              </span>

              <span className="muted">
                Статус агрегации: {viewModel.aggregate.statusLabel} (
                {viewModel.aggregate.status})
              </span>

              <span className="muted">
                Причина статуса: {viewModel.aggregate.statusReason}
              </span>

              {viewModel.aggregate.gateAllowed ? (
                <span className="muted">
                  Голоса бирж: LONG {viewModel.aggregate.longVotes} · SHORT{" "}
                  {viewModel.aggregate.shortVotes} · NEUTRAL{" "}
                  {viewModel.aggregate.neutralVotes}
                  {viewModel.aggregate.conflict
                    ? " · конфликт направлений"
                    : ""}
                </span>
              ) : (
                <span style={{ color: BLOCKED_COLOR }}>
                  Агрегация запрещена gate:{" "}
                  {viewModel.aggregate.gateRefusalReasons.length > 0
                    ? viewModel.aggregate.gateRefusalReasons.join("; ")
                    : "причина не передана"}
                </span>
              )}

              <span className="muted">
                asOf движка (H + таймфрейм):{" "}
                {viewModel.aggregate.engineAsOfLabel ?? "—"}
              </span>

              <span className="muted">
                Отставание горизонта: {viewModel.aggregate.lagLabel ?? "—"}
              </span>

              <span className="muted">
                Отфильтровано стратегией: {viewModel.aggregate.filteredCount}
              </span>

              {viewModel.exchanges
                .filter((row) => row.statusReason !== null)
                .map((row) => (
                  <span
                    key={`${row.exchange}:${row.marketId}:reason`}
                    className="muted"
                  >
                    {row.exchange}: {row.statusReason}
                  </span>
                ))}
            </div>
          </details>
        </>
      )}
    </div>
  );
}
