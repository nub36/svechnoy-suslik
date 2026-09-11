/**
 * P1-C — Smart Money панель графика: ЧИСТЫЙ view-model.
 *
 * Здесь ВСЯ логика отображения: запрос, identity/race-защита, разбор
 * ответа, русские подписи состояний. Компонент (`SmartMoneyPanel.tsx`)
 * только печатает то, что посчитано здесь, а `CandleChart` лишь дёргает
 * переходы состояний — поэтому поведение проверяемо детерминированно
 * без DOM-фреймворка (в проекте нет jest/vitest и добавлять его
 * ради P1-C нельзя).
 *
 * ГРАНИЦЫ:
 *  - единственный contract — принятый P1-A `SmcChartProjection`
 *    (`lib/chart/smc-contract.ts`); competing DTO/теневоe поле-и-перевод
 *    не заводятся, DTO не мутируется (только чтение);
 *  - WHY→factIds берётся У ЖЕ из контракта (`scoreReasonFactIds`) и
 *    прокидывается как есть: UI ничего не реконструирует и не подбирает
 *    «соседние» OB/FVG (это семантика P1-A, она неизменна);
 *  - aggregate (по активу, несколько бирж) и ряд выбранной биржи
 *    не смешиваются: панель показывает и то, и другое разными блоками;
 *  - numbers из DTO не пересчитываются: `confirmation` — строка DTO,
 *    количество бирж нигде не хардкодится (1d/BINGX уже решён в
 *    проекции через eligibility);
 *  - ни Prisma, ни admin API, ни Signal, ни Strategy.enabled: панель —
 *    только чтение GET /api/chart/smc; toggle — локальное состояние UI.
 *  - визуальные primitives (BOS/FVG/OB/liquidity/range поверх свечей) —
 *    P1-D; здесь их нет намеренно.
 */

import {
  SMC_FVG_KEY_PREFIX,
  SMC_OB_KEY_PREFIX,
  scoreReasonFactIds,
  type SmcAggregateSummaryDto,
  type SmcChartProjection,
  type SmcMarketOverlayDto,
  type SmcOverlayMarketStatus,
  type SmcOverlayReasonDto,
} from "./smc-contract";
import type { CommonHorizonStatus } from "../strategies/common-horizon";
import type {
  SmcEvaluationDirection,
  SmcAvailabilityCode,
} from "../smc/evaluate";

/* ------------------------------------------------------------------ */
/* Состояние запроса (race/abort — чисто и детерминированно)           */
/* ------------------------------------------------------------------ */

export type SmcPanelPhase = "off" | "loading" | "ok" | "error";

export type SmcRequestState = {
  phase: SmcPanelPhase;
  /** id активного запроса; отсталые ответы отбрасываются по нему */
  activeId: number;
  projection: SmcChartProjection | null;
  /** безопасное русское сообщение (без stack) */
  error: string | null;
  /** ключ последнего успешно загруженного окна (symbol+timeframe) */
  loadedKey: string | null;
  /** ключ запроса, который сейчас в полёте */
  pendingKey: string | null;
};

/** Начальное состояние: выключено, никаких запросов не было. */
export function initialSmcRequestState(): SmcRequestState {
  return {
    phase: "off",
    activeId: 0,
    projection: null,
    error: null,
    loadedKey: null,
    pendingKey: null,
  };
}

/** Показываем ли панель вообще (off — не показываем ничего). */
export function isSmcPanelVisible(phase: SmcPanelPhase): boolean {
  return phase !== "off";
}

/** Запрос нужен только при включённом toggle и полном окне. */
export function shouldFetchSmc(input: {
  enabled: boolean;
  symbol: string;
  timeframe: string;
}): boolean {
  return (
    input.enabled === true &&
    input.symbol.trim().length > 0 &&
    input.timeframe.trim().length > 0
  );
}

/** Ключ окна запроса: смена symbol/timeframe => новый запрос. */
export function smcRequestKey(
  symbol: string,
  timeframe: string
): string {
  return `${symbol}·${timeframe}`;
}

/** Ровно принятыe параметры: symbol + timeframe. exchange НЕ передаётся. */
export function buildSmcRequestUrl(
  symbol: string,
  timeframe: string
): string {
  return `/api/chart/smc?symbol=${encodeURIComponent(
    symbol
  )}&timeframe=${encodeURIComponent(timeframe)}`;
}

/** Нужно ли перезагружать (вкл. окно, которого ещё нет в кэше состояния). */
export function needsSmcFetch(args: {
  enabled: boolean;
  symbol: string;
  timeframe: string;
  state: SmcRequestState;
}): boolean {
  if (!shouldFetchSmc(args)) {
    return false;
  }
  const key = smcRequestKey(args.symbol, args.timeframe);
  if (args.state.phase === "loading" && args.state.pendingKey === key) {
    return false;
  }
  return args.state.loadedKey !== key || args.state.projection === null;
}

export type SmcFetchOutcome =
  | { ok: true; projection: SmcChartProjection }
  | { ok: false; message: string };

/** Старт запроса: loading + новый активный id (старые ответы устареют). */
export function beginSmcRequest(
  state: SmcRequestState,
  requestId: number,
  key: string
): SmcRequestState {
  return {
    ...state,
    phase: "loading",
    activeId: requestId,
    error: null,
    pendingKey: key,
  };
}

/**
 * Применение ответа. ОТСТАЛОЙ ответ (id != activeId) игнорируется
 * полностью — старое окно не перетирает новое. Данные при этом
 * сохраняются, пока не придут новые (panel не «мигает» пустотой).
 */
export function applySmcResponse(
  state: SmcRequestState,
  requestId: number,
  outcome: SmcFetchOutcome,
  key: string
): SmcRequestState {
  // Ответ принимается ТОЛЬКО когда этот запрос ещё активен и находится в
  // полёте. Иначе: (1) отсталый ответ старого окна не перетирает новое;
  // (2) поздний ответ после выключения toggle ничего не пишет; (3) второй
  // resolve того же id (или id=-1 из off-состояния) не может ни испортить
  // показ, ни «воскресить» панель.
  if (state.phase !== "loading" || requestId !== state.activeId) {
    return state;
  }
  if (outcome.ok) {
    return {
      phase: "ok",
      activeId: requestId,
      projection: outcome.projection,
      error: null,
      loadedKey: key,
      pendingKey: null,
    };
  }
  return {
    phase: "error",
    activeId: requestId,
    projection: null,
    error: outcome.message,
    loadedKey: null,
    pendingKey: null,
  };
}

/**
 * Выключение toggle: панель гаснет немедленно, activeId уходит в -1,
 * поэтому любой поздний (уже отменённый/не отменённый) ответ будет
 * отброшен — stale-панели не остаётся.
 */
export function clearSmcOnDisable(state: SmcRequestState): SmcRequestState {
  void state;
  return {
    ...initialSmcRequestState(),
    // -1 не совпадёт ни с одним новым положительным id: любой поздний
    // ответ (в т.ч. не отменённый сетью) будет отброшен.
    activeId: -1,
  };
}

/** AbortError — штатная отмена, не ошибка пользователя. */
export function isSmcAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/**
 * Безопасное сообщение об ошибке HTTP: берём `error` из JSON-тела
 * (route отдаёт { error }), иначе — общий текст со статусом. Никакого
 * содержимого HTML/stack в UI.
 */
export function smcFailureMessage(
  rawBody: string,
  status: number
): string {
  const fallback = `Не удалось загрузить Smart Money (HTTP ${status})`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return fallback;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return fallback;
  }
  const error = (parsed as { error?: unknown }).error;
  if (typeof error !== "string" || error.trim().length === 0) {
    return fallback;
  }
  return error.length > 300 ? `${error.slice(0, 300)}…` : error;
}

/**
 * Минимальная проверка формы ответа на границе UI: сломанный/чужой
 * payload должен дать честную ошибку панели, а не падение графика.
 * Поля не переименовываются и не дополняются — это только guard.
 */
export function parseSmcProjection(
  value: unknown
): SmcChartProjection | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.assetSymbol !== "string") {
    return null;
  }
  if (!Array.isArray(candidate.overlays)) {
    return null;
  }
  if (
    typeof candidate.aggregate !== "object" ||
    candidate.aggregate === null
  ) {
    return null;
  }
  const aggregate = candidate.aggregate as Record<string, unknown>;
  if (
    typeof aggregate.usable !== "boolean" ||
    typeof aggregate.status !== "string"
  ) {
    return null;
  }
  return value as SmcChartProjection;
}

/* ------------------------------------------------------------------ */
/* Подписи состояний (выводятся из DTO, semantics не меняются)        */
/* ------------------------------------------------------------------ */

export type SmcVerdict = "long" | "short" | "neutral" | "unavailable";

export const VERDICT_LABELS: Record<SmcVerdict, string> = {
  long: "LONG",
  short: "SHORT",
  neutral: "Нейтрально",
  unavailable: "Вердикта нет",
};

/**
 * Человекочитаемые причины отказа согласовать горизонт — по существующему
 * CommonHorizonStatus. Полнота покрывается типом: новый статус слоя
 * заставит добавить сюда подпись, а не тихо получить «Нейтрально».
 */
export const AGGREGATE_STATUS_LABELS: Record<CommonHorizonStatus, string> = {
  ok: "Горизонт согласован",
  no_participants: "Нет подходящих рынков для стратегии",
  data_unavailable: "У части рынков нет закрытых свечей на горизонте",
  no_common_horizon: "Не удалось согласовать рынки по времени",
  relative_lag_stale: "Рынки отстают друг от друга — вердикт не выдаётся",
  absolute_stale: "Данные отстают от расписания — вердикт не выдаётся",
  future_horizon: "Горизонт ещё не закрыт — вердикт не выдаётся",
};

export const MARKET_STATUS_LABELS: Record<SmcOverlayMarketStatus, string> = {
  evaluated: "оценено",
  "cannot-evaluate": "не удалось оценить",
  filtered: "вне фильтров стратегии",
};

export const AVAILABILITY_LABELS: Partial<Record<SmcAvailabilityCode, string>> =
  {
    INSUFFICIENT_HISTORY: "недостаточно истории закрытых свечей",
    ATR_UNAVAILABLE: "ATR недоступен на последней свече",
    NO_SWING_HIGH: "нет подтверждённого swing-high",
    NO_SWING_LOW: "нет подтверждённого swing-low",
  };

function directionVerdict(
  direction: SmcEvaluationDirection | null
): SmcVerdict | null {
  switch (direction) {
    case "LONG":
      return "long";
    case "SHORT":
      return "short";
    case "NEUTRAL":
      return "neutral";
    case "CANNOT_EVALUATE":
    case null:
      return null;
  }
}

/**
 * Вердикт агрегата. КРИТИЧНО: NEUTRAL — это реальный оценённый результат,
 * «вердикта нет» — это cannot-evaluate/несогласованность/фильтры.
 * Первое никогда не выводится как второе и наоборот.
 */
export function aggregateVerdict(agg: SmcAggregateSummaryDto): {
  verdict: SmcVerdict;
  label: string;
} {
  const evaluated = directionVerdict(agg.direction);
  if (agg.usable && agg.gateAllowed && evaluated !== null) {
    return { verdict: evaluated, label: VERDICT_LABELS[evaluated] };
  }
  const reason =
    AGGREGATE_STATUS_LABELS[agg.status] ??
    "Вердикт недоступен";
  return { verdict: "unavailable", label: reason };
}

/** Вердикт одной биржи (per-exchange), той же шкалой. */
export function marketVerdict(row: {
  status: SmcOverlayMarketStatus;
  direction: SmcEvaluationDirection | null;
}): { verdict: SmcVerdict; label: string } {
  if (row.status === "evaluated") {
    const evaluated = directionVerdict(row.direction);
    if (evaluated !== null) {
      return { verdict: evaluated, label: VERDICT_LABELS[evaluated] };
    }
  }
  if (row.status === "filtered") {
    return { verdict: "unavailable", label: "вне фильтров стратегии" };
  }
  return { verdict: "unavailable", label: "не удалось оценить" };
}

/** Часы UTC из ms без чтения текущих часов; null — на «—». */
export function formatUtcClock(ms: number | null): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms)) {
    return null;
  }
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const pad = (value: number): string =>
    value < 10 ? `0${value}` : String(value);
  return (
    `${pad(date.getUTCDate())}.${pad(date.getUTCMonth() + 1)}.` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:` +
    `${pad(date.getUTCMinutes())} UTC`
  );
}

/** Внутренние SMC-идентичности не показываем текстом (P1-D их использует). */
export function isInternalSmcKey(value: string): boolean {
  return (
    value.startsWith(SMC_OB_KEY_PREFIX) || value.startsWith(SMC_FVG_KEY_PREFIX)
  );
}

export type SmcReasonView = {
  code: SmcOverlayReasonDto["code"];
  label: string;
  pointsText: string;
  /** человекочитаемый payload DTO; для внутренних ключей — null */
  valueText: string | null;
  /** прокидывается КАК ЕСТЬ (exact mapping P1-A), для P1-D */
  factIds: readonly string[];
  hasFact: boolean;
};

/**
 * Одна строка WHY. Points/label/value берутся из DTO дословно;
 * factIds — существующий exact-маппинг контракта (без реконструкции).
 */
export function reasonView(reason: SmcOverlayReasonDto): SmcReasonView {
  const fromContract = scoreReasonFactIds({
    code: reason.code,
    value: reason.value,
    longPoints: reason.longPoints,
    shortPoints: reason.shortPoints,
  });
  const exact =
    reason.factIds.length > 0 ? [...reason.factIds] : fromContract;
  return {
    code: reason.code,
    label: reason.label,
    pointsText: `LONG ${reason.longPoints} · SHORT ${reason.shortPoints} · макс ${reason.maxPoints}`,
    valueText:
      reason.value === null || isInternalSmcKey(reason.value)
        ? null
        : reason.value,
    factIds: exact,
    hasFact: exact.length > 0,
  };
}

export type SmcMarketRowView = {
  title: string;
  exchange: string;
  market: string;
  statusLabel: string;
  verdict: SmcVerdict;
  verdictLabel: string;
  scoresText: string | null;
  horizonText: string | null;
  statusReason: string | null;
  availabilityText: string | null;
  reasons: SmcReasonView[];
};

function availabilityText(row: SmcMarketOverlayDto): string | null {
  const hard = row.availability?.hardFailures ?? [];
  if (hard.length === 0) {
    return null;
  }
  return hard
    .map((failure) => AVAILABILITY_LABELS[failure.code] ?? failure.label)
    .join(" · ");
}

function marketRow(row: SmcMarketOverlayDto): SmcMarketRowView {
  const verdict = marketVerdict({
    status: row.status,
    direction: row.direction,
  });
  return {
    title: `${row.exchange} · ${row.market}`,
    exchange: row.exchange,
    market: row.market,
    statusLabel: MARKET_STATUS_LABELS[row.status],
    verdict: verdict.verdict,
    verdictLabel: verdict.label,
    scoresText:
      row.status === "evaluated" &&
      row.longScore !== null &&
      row.shortScore !== null
        ? `баллы: LONG ${row.longScore} · SHORT ${row.shortScore}`
        : null,
    horizonText:
      row.horizonMs === null
        ? null
        : `горизонт: ${formatUtcClock(row.horizonMs) ?? "—"}`,
    statusReason: row.statusReason,
    availabilityText: availabilityText(row),
    reasons: row.reasons.map(reasonView),
  };
}

export type SmcPanelView = {
  headline: string;
  verdict: SmcVerdict;
  verdictLabel: string;
  confirmationLabel: string | null;
  countsLabel: string;
  horizonLabel: string;
  asOfLabel: string;
  freshnessLabel: string;
  excludedLabel: string | null;
  refusalLines: string[];
  statusReason: string;
  /** Техническая строка selection нужна при отказах; при успешном
   * согласованном горизонте она только шумит в UI. */
  technicalVisible: boolean;
  markets: SmcMarketRowView[];
  marketsNote: string;
  disclaimer: string;
};

export const SMC_DISCLAIMER =
  "Сила — это степень совпадения условий стратегии (0–100), а не вероятность успешной сделки.";

/**
 * Единственная точка превращения DTO в представление. Пустые/отказные
 * состояния дают читаемый текст, а не падение и не «Нейтрально».
 */
export function buildSmcPanelView(
  projection: SmcChartProjection
): SmcPanelView {
  const agg = projection.aggregate;
  const verdict = aggregateVerdict(agg);

  const confirmationLabel =
    agg.confirmation === null
      ? null
      : `Подтверждения: ${agg.confirmation} (минимум ${agg.minExchanges})`;

  const countsLabel =
    `Оценено: ${agg.evaluatedCount} · без оценки: ${agg.cannotEvaluateCount}` +
    ` · вне фильтров: ${agg.filteredCount} · участников горизонта: ${agg.participantCount}`;

  const horizonLabel =
    agg.horizonMs === null
      ? "Общий закрытый горизонт не выбран"
      : `Общий горизонт рынков: ${formatUtcClock(agg.horizonMs) ?? "—"}`;

  const asOfLabel =
    agg.engineAsOfMs === null
      ? "Точка доступности данных не определена"
      : `Данные приняты на момент: ${formatUtcClock(agg.engineAsOfMs) ?? "—"}`;

  const lag =
    agg.lagBars === null ? null : `отставание ${agg.lagBars} бар(а)`;
  const absoluteLag =
    agg.absoluteLagBars === null
      ? null
      : `от расписания ${agg.absoluteLagBars} бар(а) (допуск ${agg.absoluteMaxLagBars})`;
  const expected = `ожидаемый последний закрытый бар: ${
    formatUtcClock(agg.expectedLatestClosedMs) ?? "—"
  }`;
  const freshnessLabel = [expected, lag, absoluteLag]
    .filter((part): part is string => part !== null)
    .join(" · ");

  const excludedLabel =
    agg.exchangeExcluded.length > 0
      ? `Исключены из агрегации политикой бирж: ${agg.exchangeExcluded.join(", ")}`
      : null;

  const markets = projection.overlays.map(marketRow);

  return {
    headline: `Smart Money · ${projection.assetSymbol} · ${projection.timeframe}`,
    verdict: verdict.verdict,
    verdictLabel: verdict.label,
    confirmationLabel,
    countsLabel,
    horizonLabel,
    asOfLabel,
    freshnessLabel,
    excludedLabel,
    refusalLines: [...agg.gateRefusalReasons],
    statusReason: agg.statusReason,
    technicalVisible:
      !agg.usable ||
      !agg.gateAllowed ||
      agg.direction === null ||
      agg.direction === "CANNOT_EVALUATE" ||
      agg.gateRefusalReasons.length > 0,
    markets,
    marketsNote:
      markets.length === 0
        ? "Оверлеи по биржам недоступны на этом горизонте."
        : `Оверлеи и причины — по каждой бирже отдельно; общего набора фактов на несколько бирж не существует.`,
    disclaimer: SMC_DISCLAIMER,
  };
}
