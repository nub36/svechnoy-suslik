/**
 * P2-A — Backtest Engine foundation: КОНТРАКТ И ПОЛИТИКА.
 *
 * Чистый детерминированный слой: БЕЗ Prisma, БЕЗ PostgreSQL, БЕЗ сети,
 * БЕЗ workers, БЕЗ process.env, БЕЗ текущего времени, БЕЗ случайности.
 * Идентичные вход + идентичный конфиг ⇒ байт-в-байт идентичный результат
 * (см. serialize.ts: каноническая сериализация + sha256-отпечаток).
 *
 * P2-A — это ФУНДАМЕНТ: семантика исполнения, no-lookahead, издержки,
 * метрики, хронологический TRAIN/VALIDATION/OOS-контракт и детерминированный
 * вывод. Оптимизации параметров, walk-forward, Sharpe/Sortino, подключения
 * к БД здесь НЕТ (это P2-B/P2-C).
 *
 * ══════════════════════════════════════════════════════════════════
 * ПОЛИТИКА ИСПОЛНЕНИЯ (каждый пункт зафиксирован и покрыт тестами:
 * scripts/test-backtest-engine.ts, test-backtest-metrics.ts,
 * test-backtest-splits.ts)
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. ДАННЫЕ. Только ЗАКРЫТЫЕ свечи, строго возрастающие по time.
 *    Дубликаты и немонотонность — ОШИБКА ВАЛИДАЦИИ (вход не
 *    сортируется и не дедуплицируется молча). Пропуски в сетке
 *    допускаются и учитываются в метаданных (gridGaps, maxGapMs).
 *    Две НЕЗАВИСИМЫЕ строгие настройки (разная строгость намеренно):
 *      requireUniformGrid  — КАЖДАЯ дельта обязана равняться шагу
 *                            сетки, то есть любой пропуск = ошибка;
 *      expectedTimeframeMs — КАЖДАЯ дельта обязана быть целым кратным
 *                            заявленного шага и не меньше него: пропуск
 *                            (2 × 1h в часовом ряде) остаётся допустимым
 *                            и подсчитанным, а чужой таймфрейм или
 *                            некратная дельта = ошибка.
 *    Инварианты бара: все цены конечны и > 0, high ≥ max(open, close),
 *    low ≤ min(open, close), high ≥ low, time — целое > 0.
 *
 * 2. NO-LOOKAHEAD (структурный, а не по договорённости). Сигнал
 *    оценивается на ЗАКРЫТОМ баре N; провайдеру доступны только бары
 *    0..N через SignalContext.barAt(i), и обращение к i > N бросает
 *    исключение. Единственная ранняя точка входа — open бара N+1
 *    (entryPolicy "next-bar-open"). Будущие бары потребляются строго
 *    последовательно и только для сопровождения уже открытой позиции.
 *
 * 3. ОДНА ПОЗИЦИЯ ОДНОВРЕМЕННО. Перекрывающихся сделок нет,
 *    пирамидинга нет. Провайдер вызывается на КАЖДОМ баре (чтобы
 *    decisionCounts был полным), но LONG/SHORT-решение при открытой
 *    позиции пропускается и фиксируется в skippedSignals
 *    (reason "position-open").
 *
 * 4. ВХОД. plannedEntryPrice = open бара N+1. Фактическая цена входа
 *    = plannedEntryPrice, сдвинутая слиппеджем В НЕВЫГОДНУЮ сторону
 *    (LONG: вверх, SHORT: вниз).
 *
 *    Требование к уровням ОДНО: они должны СТРОГО обрамлять опорную
 *    цену — LONG: sl < ref < tp, SHORT: tp < ref < sl. Проверяется
 *    оно ДВАЖДЫ, с разными опорными ценами, и именно опора задаёт код
 *    отказа (это не дублирование, а разделение вины решения и рынка):
 *      a) на баре СИГНАЛА N, ref = close бара N. Нарушение означает,
 *         что решение внутренне противоречиво: rejectedSignals,
 *         reason "levels-on-wrong-side"; вход даже не планируется.
 *      b) на баре ВХОДА N+1, ref = open бара N+1. Решение было
 *         согласованным, но рынок гэпнул за уровень: вход ОТКЛОНЯЕТСЯ,
 *         reason "entry-levels-breached-at-open". Сделка, которая была
 *         бы мгновенно выбита гэпом, НЕ фабрикуются — иначе PnL
 *         рисовался бы из цены исполнения, которой не существовало.
 *      c) после сдвига слиппеджем ФАКТИЧЕСКАЯ цена входа обязана
 *         оставаться между уровнями (тот же предикат, ref = entryPrice).
 *         Иначе сделка открылась бы уже за собственным SL/TP: отказ
 *         "entry-fill-outside-levels". Достигается только экстремальным
 *         слиппеджем, но правило явное — «сначала уровень, потом сделка».
 *    Структурно невалидные уровни (не конечные, ≤ 0, sl = tp) —
 *    reason "invalid-levels" (тоже на баре сигнала).
 *    Сигнал на последнем баре набора/сегмента не имеет N+1 →
 *    skippedSignals "no-next-bar" / "segment-boundary".
 *
 * 5. СОПРОВОЖДЕНИЕ. Позиция, открытая на баре E, сопровождается
 *    начиная С ТОГО ЖЕ бара E (вход по open, поэтому rest-of-bar
 *    законно доступен). Порядок проверки внутри бара:
 *      a) гэп через уровень на open → исполнение ПО OPEN;
 *      b) оба уровня внутри бара → политика sameBarPolicy;
 *      c) SL; d) TP; e) timeout (по close); f) конец данных/сегмента
 *      (по close). Timeout проверяется ПОСЛЕ SL/TP, потому что
 *      внутриварное касание уровня хронологически раньше close.
 *
 * 6. SAME-BAR SL+TP (неопределённость порядка внутри бара).
 *    Порядок касаний внутри бара неизвестен, поэтому политика явная:
 *      "pessimistic"   — первым считается SL   (консервативно, ДЕФОЛТ);
 *      "optimistic"    — первым считается TP;
 *      "open-proximity"— первым считается уровень, ближайший к open
 *                        бара; при равенстве дистанций — SL.
 *    Факт неопределённости помечается в сделке (sameBarAmbiguity) и
 *    агрегируется в метриках (sameBarAmbiguityTrades).
 *
 * 7. ГЭП ЧЕРЕЗ УРОВЕНЬ. Если open бара за пределами уровня, цена
 *    исполнения — open (для SL хуже уровня, для TP лучше), а не
 *    уровень: сделка не может быть исполнена по цене, которой не
 *    существовало на момент входа в бар. Помечается gapThrough.
 *    Слиппедж применяется и к гэповому исполнению.
 *
 * 8. ИЗЪЯТИЕ ПО CLOSE. timeout и END_OF_DATA/SEGMENT_END исполняются
 *    по close бара (плановая цена), затем слиппедж в невыгодную
 *    сторону. Открытая на конец набора позиция ЗАКРЫВАЕТСЯ по close
 *    последнего бара, учитывается в метриках и помечается
 *    exitReason "END_OF_DATA" (openAtEndTrades в метриках).
 *
 * 9. TIMEOUT. timeoutBars = N ⇒ позиция закрывается по close N-го
 *    бара удержания, где бар входа считается первым (barsHeld на баре
 *    входа = 1). null ⇒ таймаута нет.
 *
 * 10. ИЗДЕРЖКИ. Слиппедж — bps от цены или абсолютная величина,
 *     всегда против сделки, на входе и на выходе. Комиссия —
 *     bps от НОТИОНАЛА (фактическая цена × quantity) ПЛЮС
 *     fixedPerSide, отдельно на каждую сторону. В netPnl слиппедж
 *     уже содержится в ценах исполнения (двойного счёта нет), а
 *     комиссия вычитается явно; slippageCost считается аналитически
 *     и публикуется для прозрачности.
 *
 * 11. PnL И R. LONG: gross = (exit − entry) × qty; SHORT: gross =
 *     (entry − exit) × qty; net = gross − fees. riskAmount =
 *     |entryPrice − stopLoss| × qty (фактическая цена входа, плановый
 *     уровень SL). grossR = gross / risk; rMultiple = net / risk
 *     (заголовный R — ЧИСТЫЙ, консервативно). plannedRewardRisk =
 *     |tp − entry| / |entry − sl|.
 *
 * 12. МЕТРИКИ — только из ИСПОЛНЕННЫХ сделок (никаких «целевых»
 *     winrate/PF). win ⇔ netPnl > 0, loss ⇔ netPnl < 0, иначе
 *     breakeven (нуль не считается ни победой, ни убытком). Все
 *     отношения/средние при нуле сделок = null (не 0 — это была бы
 *     ложь). Profit factor считается ПО ЧИСТОМУ PnL; при нуле чистых
 *     убытков PF = null с явным profitFactorState "no-losses"
 *     (Infinity в JSON не сериализуется и не используется).
 *
 * 13. DRAWDOWN. Основная база — РЕАЛИЗОВАННАЯ эквити-кривая
 *     (initialEquity + накопленный netPnl, точка на каждую закрытую
 *     сделку, хронологически); additionally считается более
 *     консервативная mark-to-market база (оценка открытой позиции по
 *     close каждого бара). Процентный drawdown = null, если пик ≤ 0.
 *     Маржинальной модели/ликвидации в P2-A НЕТ: эквити может уйти
 *     ниже нуля, это фиксируется флагом equityNonPositive.
 *     Размер позиции ФИКСИРОВАННЫЙ (quantity), компаундинга нет.
 *
 * 14. TRAIN/VALIDATION/OOS. Только хронологическое разбиение по
 *     индексам баров (без random, без shuffling). Утечка исключена
 *     конструкцией: вход никогда не пересекает границу сегмента
 *     (сигнал на последнем баре сегмента отбрасывается), открытая
 *     позиция на границе закрывается по close последнего бара
 *     сегмента (exitReason "SEGMENT_END"). Чтение истории ДО начала
 *     сегмента разрешено в пределах warmupBars (это прошлое, не
 *     будущее); чтение баров ПОСЛЕ текущего индекса запрещено всегда.
 *
 * 15. ОКРУГЛЕНИЕ. Внутри — IEEE-754 double без промежуточных
 *     округлений. В выводе все конечные числа нормализуются до 10
 *     знаков после запятой и −0 заменяется на 0 (serialize.ts):
 *     этого достаточно, чтобы погасить шум представления и сохранить
 *     экономически значимые различия. Ключи объектов при
 *     сериализации сортируются лексикографически на всех уровнях.
 *
 * 16. МЕТАДАННЫЕ детерминированы: версия контракта, отпечатки конфига
 *     и баров (sha256 канонической формы), характеристики окна,
 *     счётчики решений. Никаких Date.now(), randomUUID, hostname,
 *     pid, версий зависимостей и тому подобного.
 * ══════════════════════════════════════════════════════════════════
 */

/** Версия контракта: меняется при любом изменении семантики. */
export const BACKTEST_CONTRACT_VERSION = "p2a-1.0.0";

/** Имя движка в метаданных (детерминированная константа). */
export const BACKTEST_ENGINE_NAME = "suslik-backtest";

/* ------------------------------------------------------------------ */
/* Данные                                                              */
/* ------------------------------------------------------------------ */

/** Закрытая OHLCV-свеча. time — openTime в миллисекундах UTC. */
export interface BacktestBar {
  readonly time: number;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  /** На исполнение не влияет; участвует только в отпечатке входа. */
  readonly volume?: number;
}

/* ------------------------------------------------------------------ */
/* Решения стратегии                                                   */
/* ------------------------------------------------------------------ */

export type Direction = "LONG" | "SHORT";

/**
 * NEUTRAL и CANNOT_EVALUATE — РАЗНЫЕ вещи (инвариант проекта:
 * «cannot-evaluate ≠ NEUTRAL»). Обе не дают сделку, но считаются
 * раздельно, чтобы «стратегия не смогла оценить» не маскировалось под
 * «стратегия решила стоять».
 */
export type NoTradeKind = "NEUTRAL" | "CANNOT_EVALUATE";

export type SignalDecisionKind = Direction | NoTradeKind;

export interface EntryDecision {
  readonly kind: Direction;
  /** Абсолютная цена стоп-лосса (триггер, не «уровень желания»). */
  readonly stopLoss: number;
  /** Абсолютная цена тейк-профита. */
  readonly takeProfit: number;
  /** Короткая метка сетапа (прозрачность, не семантика). */
  readonly label: string;
  /** factIds/причины — только для объяснимости вывода. */
  readonly facts: readonly string[];
}

export interface NoTradeDecision {
  readonly kind: NoTradeKind;
  readonly label: string;
  readonly facts: readonly string[];
}

export type SignalDecision = EntryDecision | NoTradeDecision;

/** «Сигнала нет» — для списковой формы источника решений. */
export const NO_SIGNAL: null = null;

export type SignalDecisionList = readonly (SignalDecision | null)[];

/**
 * Типовая защита: LONG/SHORT-решение (у NoTradeDecision kind — объединение
 * двух литералов, поэтому сужение по kind «в лоб» не срабатывает).
 */
export function isEntryDecision(
  decision: SignalDecision
): decision is EntryDecision {
  return decision.kind === "LONG" || decision.kind === "SHORT";
}

/** Обратная защита: решение без сделки. */
export function isNoTradeDecision(
  decision: SignalDecision
): decision is NoTradeDecision {
  return !isEntryDecision(decision);
}

/* ------------------------------------------------------------------ */
/* Контекст сигнала (барьер no-lookahead)                              */
/* ------------------------------------------------------------------ */

/** Срез открытой позиции, доступный стратегии при оценке сигнала. */
export interface OpenPositionView {
  readonly direction: Direction;
  readonly entryIndex: number;
  readonly entryTime: number;
  readonly entryPrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  /** Сколько баров удерживается позиция (бар входа = 1). */
  readonly barsHeld: number;
}

export interface SignalContext {
  /** Индекс ТЕКУЩЕГО ЗАКРЫТОГО бара, на котором оценивается сигнал. */
  readonly index: number;
  /** Сколько баров законно видно провайдеру: index + 1 (+ warmup). */
  readonly visibleBars: number;
  /** Первый индекс, доступный провайдеру (учитывает warmup-окно). */
  readonly firstVisibleIndex: number;
  /** Текущий закрытый бар. */
  readonly bar: BacktestBar;
  /**
   * Доступ к истории. Бросает исключение при i > index (будущее) и
   * при i < firstVisibleIndex (данные до warmup-окна сегмента).
   */
  readonly barAt: (i: number) => BacktestBar;
  /** Открытая позиция или null (флэт). */
  readonly position: OpenPositionView | null;
  /** Имя сегмента, если прогон сегментный (TRAIN/VALIDATION/OOS). */
  readonly segment: SplitName | null;
}

export type SignalProvider = (context: SignalContext) => SignalDecision | null;

/* ------------------------------------------------------------------ */
/* Конфигурация                                                        */
/* ------------------------------------------------------------------ */

export type EntryPolicy = "next-bar-open";

export type SameBarPolicy =
  | "pessimistic"
  | "optimistic"
  | "open-proximity";

export interface SlippageModel {
  /** bps — доли цены (1 bp = 0.01%), absolute — единицы цены. */
  readonly kind: "bps" | "absolute";
  /** Неотрицательная величина; направление всегда против сделки. */
  readonly value: number;
}

export interface FeeModel {
  /** Доля от нотионала (цена × quantity) на КАЖДУЮ сторону, bp. */
  readonly bps: number;
  /** Фиксированная комиссия на КАЖДУЮ сторону, в валюте счёта. */
  readonly fixedPerSide: number;
}

export type SplitName = "TRAIN" | "VALIDATION" | "OOS";

export interface BacktestConfig {
  /** Фиксированный размер позиции в базовом активе (без компаундинга). */
  readonly quantity?: number;
  /** База для эквити-кривой и drawdown. */
  readonly initialEquity?: number;
  readonly entryPolicy?: EntryPolicy;
  readonly sameBarPolicy?: SameBarPolicy;
  /** Число баров удержания (бар входа = 1); null — без таймаута. */
  readonly timeoutBars?: number | null;
  readonly slippage?: SlippageModel;
  readonly fees?: FeeModel;
  /** Строгая равномерность сетки time (иначе пропуски разрешены). */
  readonly requireUniformGrid?: boolean;
  /** Ожидаемый шаг сетки в мс (проверяется, если задан). */
  readonly expectedTimeframeMs?: number | null;
  /** Сколько баров ДО начала сегмента можно читать (warmup). */
  readonly warmupBars?: number;
}

/** Конфиг с полностью разрешёнными (не optional) полями. */
export interface ResolvedBacktestConfig {
  readonly quantity: number;
  readonly initialEquity: number;
  readonly entryPolicy: EntryPolicy;
  readonly sameBarPolicy: SameBarPolicy;
  readonly timeoutBars: number | null;
  readonly slippage: SlippageModel;
  readonly fees: FeeModel;
  readonly requireUniformGrid: boolean;
  readonly expectedTimeframeMs: number | null;
  readonly warmupBars: number;
}

/**
 * Дефолты P2-A. Консервативны и явны: нулевые издержки — это НЕ
 * дефолт (дорожная карта требует commission/slippage), поэтому
 * комиссия и слиппедж по умолчанию ненулевые и документированные.
 */
export const BACKTEST_DEFAULTS: ResolvedBacktestConfig = {
  quantity: 1,
  initialEquity: 10_000,
  entryPolicy: "next-bar-open",
  sameBarPolicy: "pessimistic",
  timeoutBars: null,
  slippage: { kind: "bps", value: 2 },
  fees: { bps: 5, fixedPerSide: 0 },
  requireUniformGrid: false,
  expectedTimeframeMs: null,
  warmupBars: 0
};

/* ------------------------------------------------------------------ */
/* Причины исходов (детерминированные коды, без свободных строк)       */
/* ------------------------------------------------------------------ */

export type ExitReason =
  | "STOP_LOSS"
  | "TAKE_PROFIT"
  | "TIMEOUT"
  | "END_OF_DATA"
  | "SEGMENT_END";

export const EXIT_REASONS: readonly ExitReason[] = [
  "STOP_LOSS",
  "TAKE_PROFIT",
  "TIMEOUT",
  "END_OF_DATA",
  "SEGMENT_END"
];

/** Входоспособное решение не стало сделкой. */
export type SkipReason =
  | "position-open"
  | "no-next-bar"
  | "segment-boundary";

/** Решение отклонено как несогласованное (уровни/пробой на open). */
export type RejectReason =
  | "invalid-levels"
  | "levels-on-wrong-side"
  | "entry-levels-breached-at-open"
  | "entry-fill-outside-levels";

/* ------------------------------------------------------------------ */
/* Сделки и наблюдение                                                 */
/* ------------------------------------------------------------------ */

export interface BacktestTrade {
  /** Порядковый номер сделки в прогоне (детерминированный, с 0). */
  readonly id: number;
  readonly direction: Direction;
  /** Бар N, на котором оценён сигнал. */
  readonly signalIndex: number;
  readonly signalTime: number;
  /** Бар N+1, на котором произошёл вход. */
  readonly entryIndex: number;
  readonly entryTime: number;
  /** Open бара входа — база до слиппеджа. */
  readonly plannedEntryPrice: number;
  /** Фактическая цена входа (со слиппеджем). */
  readonly entryPrice: number;
  readonly exitIndex: number;
  readonly exitTime: number;
  /** Триггерная/плановая цена выхода (уровень или close). */
  readonly plannedExitPrice: number;
  /** Фактическая цена выхода (со слиппеджем). */
  readonly exitPrice: number;
  readonly exitReason: ExitReason;
  /** Исполнение по open из-за гэпа через уровень. */
  readonly gapThrough: boolean;
  /** SL и TP оказались внутри одного бара (порядок неизвестен). */
  readonly sameBarAmbiguity: boolean;
  /** Сколько баров удерживалась позиция (бар входа = 1). */
  readonly barsHeld: number;
  readonly quantity: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  /** |entryPrice − stopLoss| × quantity — знаменатель R. */
  readonly riskAmount: number;
  /** Задуманное reward/risk: |tp − entry| / |entry − sl|. */
  readonly plannedRewardRisk: number;
  readonly grossPnl: number;
  readonly feeEntry: number;
  readonly feeExit: number;
  readonly feesTotal: number;
  /** Аналитическая стоимость слиппеджа (в валюте счёта). */
  readonly slippageCost: number;
  readonly netPnl: number;
  readonly grossR: number;
  readonly rMultiple: number;
  readonly label: string;
  readonly facts: readonly string[];
}

export interface SkippedSignal {
  readonly index: number;
  readonly time: number;
  readonly kind: Direction;
  readonly reason: SkipReason;
}

export interface RejectedSignal {
  readonly index: number;
  readonly time: number;
  readonly kind: Direction;
  readonly reason: RejectReason;
  /**
   * Цена, с которой сверялись уровни: close бара сигнала (решение
   * внутренне противоречиво) либо open бара входа (рынок гэпнул).
   */
  readonly referencePrice: number;
  readonly stopLoss: number;
  readonly takeProfit: number;
  /**
   * Бар входа, на котором отказ был вынесен (для отказов на баре сигнала
   * — null: вход не планировался).
   */
  readonly entryIndex: number | null;
  readonly entryTime: number | null;
  /** Человекочитаемое объяснение (детерминированное, без свободного текста). */
  readonly detail: string;
}

export interface EquityPoint {
  /** Индекс сделки (−1 для стартовой точки). */
  readonly tradeIndex: number;
  readonly time: number;
  readonly equity: number;
}

/* ------------------------------------------------------------------ */
/* Метрики                                                             */
/* ------------------------------------------------------------------ */

export interface BacktestMetrics {
  readonly trades: number;
  readonly longTrades: number;
  readonly shortTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  /** wins / trades; null при trades = 0. */
  readonly winRate: number | null;
  readonly totalGrossPnl: number;
  readonly totalNetPnl: number;
  readonly totalFees: number;
  readonly totalSlippageCost: number;
  /** Сумма положительных и модуль суммы отрицательных ЧИСТЫХ PnL. */
  readonly netWinTotal: number;
  readonly netLossTotal: number;
  /** Сумма положительных и модуль суммы отрицательных ВАЛОВЫХ PnL. */
  readonly grossWinTotal: number;
  readonly grossLossTotal: number;
  /** netWinTotal / netLossTotal; null при netLossTotal = 0. */
  readonly profitFactor: number | null;
  readonly profitFactorState: "ok" | "no-losses" | "no-trades";
  /** Средний ЧИСТЫЙ PnL на сделку, валюта счёта; null при 0 сделок. */
  readonly expectancy: number | null;
  /** Средний ЧИСТЫЙ R на сделку (= R-expectancy); null при 0 сделок. */
  readonly avgR: number | null;
  /** Медиана ЧИСТОГО R; при чётном числе — среднее двух центральных. */
  readonly medianR: number | null;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
  readonly largestWin: number | null;
  readonly largestLoss: number | null;
  readonly avgGrossR: number | null;
  readonly medianGrossR: number | null;
  readonly maxConsecutiveWins: number;
  readonly maxConsecutiveLosses: number;
  readonly avgBarsHeld: number | null;
  readonly maxBarsHeld: number;
  readonly exitReasonCounts: Readonly<Record<ExitReason, number>>;
  readonly sameBarAmbiguityTrades: number;
  readonly gapThroughTrades: number;
  /** Сделки, закрытые по концу данных/сегмента, а не уровнем. */
  readonly openAtEndTrades: number;
  readonly finalEquity: number;
  /** Реализованная база (по закрытым сделкам). */
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number | null;
  readonly maxDrawdownPeakTime: number | null;
  readonly maxDrawdownTroughTime: number | null;
  /** Консервативная база (оценка открытой позиции по close бара). */
  readonly maxDrawdownMarkToMarket: number;
  readonly maxDrawdownMarkToMarketPct: number | null;
  /** Эквити уходило ≤ 0 (маржинальной модели в P2-A нет). */
  readonly equityNonPositive: boolean;
}

/* ------------------------------------------------------------------ */
/* Метаданные и результат                                              */
/* ------------------------------------------------------------------ */

export interface BacktestMetadata {
  readonly contractVersion: string;
  readonly engine: string;
  /** sha256 канонической формы конфига. */
  readonly configFingerprint: string;
  /** sha256 канонической формы входных баров. */
  readonly barsFingerprint: string;
  readonly barsCount: number;
  readonly firstBarTime: number | null;
  readonly lastBarTime: number | null;
  /** Шаг сетки, если он равномерный; иначе null. */
  readonly timeframeMs: number | null;
  readonly gridGaps: number;
  readonly maxGapMs: number | null;
  readonly segment: SplitName | null;
  readonly segmentStartIndex: number | null;
  readonly segmentEndIndexExclusive: number | null;
  readonly warmupStartIndex: number | null;
}

export type DecisionCounts = Readonly<
  Record<SignalDecisionKind | "NO_SIGNAL", number>
>;

export interface BacktestInputSummary {
  readonly barsCount: number;
  readonly signalsEvaluated: number;
  readonly decisionCounts: DecisionCounts;
}

export interface BacktestResult {
  readonly metadata: BacktestMetadata;
  readonly config: ResolvedBacktestConfig;
  readonly input: BacktestInputSummary;
  readonly trades: readonly BacktestTrade[];
  readonly skippedSignals: readonly SkippedSignal[];
  readonly rejectedSignals: readonly RejectedSignal[];
  readonly equityCurve: readonly EquityPoint[];
  readonly metrics: BacktestMetrics;
}

/** Результат прогона: либо успех, либо структурированная ошибка. */
export type BacktestOutcome =
  | { readonly ok: true; readonly result: BacktestResult }
  | {
      readonly ok: false;
      readonly stage: "config" | "bars" | "provider";
      readonly errors: readonly string[];
    };

export interface BacktestInput {
  readonly bars: readonly BacktestBar[];
  /** Провайдер решений ИЛИ заранее вычисленный список по индексам. */
  readonly signals: SignalProvider | SignalDecisionList;
  readonly config?: BacktestConfig;
  /** Сегментный прогон (границы включаются в метаданные и политику). */
  readonly segment?: SegmentWindow;
}

/** Окно сегмента: [startIndex, endIndexExclusive) по индексам баров. */
export interface SegmentWindow {
  readonly name: SplitName;
  readonly startIndex: number;
  readonly endIndexExclusive: number;
}

/* ------------------------------------------------------------------ */
/* Разбиение TRAIN / VALIDATION / OOS                                  */
/* ------------------------------------------------------------------ */

export interface ChronologicalSplitConfig {
  /** Доля TRAIN (0..1, исключительно). */
  readonly trainFraction: number;
  /** Доля VALIDATION (0..1); OOS — остаток. */
  readonly validationFraction: number;
  /** Минимум баров в каждом сегменте (защита от вырожденных долей). */
  readonly minBarsPerSegment: number;
}

export const BACKTEST_SPLIT_DEFAULTS: ChronologicalSplitConfig = {
  trainFraction: 0.6,
  validationFraction: 0.2,
  minBarsPerSegment: 10
};

export interface ChronologicalSplit {
  readonly barsCount: number;
  readonly train: SegmentWindow;
  readonly validation: SegmentWindow;
  readonly oos: SegmentWindow;
  /** warmup-индекс для каждого сегмента (с учётом warmupBars). */
  readonly warmupStart: Readonly<Record<SplitName, number>>;
}

export interface SegmentRun {
  readonly segment: SplitName;
  readonly window: SegmentWindow;
  readonly warmupStartIndex: number;
  readonly outcome: BacktestOutcome;
}

export interface SegmentedBacktest {
  readonly split: ChronologicalSplit;
  readonly train: SegmentRun;
  readonly validation: SegmentRun;
  readonly oos: SegmentRun;
}

/* ------------------------------------------------------------------ */
/* Разрешение конфига                                                  */
/* ------------------------------------------------------------------ */

export type ConfigCheck =
  | { readonly ok: true; readonly config: ResolvedBacktestConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Разрешение конфига: частичный конфиг дополняется дефолтами, любое
 * несогласованное значение — явная ошибка (никаких тихих подмен).
 */
export function resolveBacktestConfig(
  config?: BacktestConfig
): ConfigCheck {
  const errors: string[] = [];
  const source: BacktestConfig = config ?? {};

  const quantity = source.quantity ?? BACKTEST_DEFAULTS.quantity;

  if (!isFiniteNumber(quantity) || quantity <= 0) {
    errors.push("quantity должен быть конечным числом > 0");
  }

  const initialEquity =
    source.initialEquity ?? BACKTEST_DEFAULTS.initialEquity;

  if (!isFiniteNumber(initialEquity) || initialEquity <= 0) {
    errors.push("initialEquity должен быть конечным числом > 0");
  }

  const entryPolicy = source.entryPolicy ?? BACKTEST_DEFAULTS.entryPolicy;

  if (entryPolicy !== "next-bar-open") {
    errors.push(
      'entryPolicy в P2-A поддерживает только "next-bar-open" (no-lookahead)'
    );
  }

  const sameBarPolicy =
    source.sameBarPolicy ?? BACKTEST_DEFAULTS.sameBarPolicy;

  if (
    sameBarPolicy !== "pessimistic" &&
    sameBarPolicy !== "optimistic" &&
    sameBarPolicy !== "open-proximity"
  ) {
    errors.push(
      'sameBarPolicy: "pessimistic" | "optimistic" | "open-proximity"'
    );
  }

  const timeoutBars =
    source.timeoutBars === undefined
      ? BACKTEST_DEFAULTS.timeoutBars
      : source.timeoutBars;

  if (timeoutBars !== null) {
    if (
      !isFiniteNumber(timeoutBars) ||
      timeoutBars < 1 ||
      !Number.isInteger(timeoutBars)
    ) {
      errors.push("timeoutBars: целое ≥ 1 или null");
    }
  }

  const slippage = source.slippage ?? BACKTEST_DEFAULTS.slippage;

  if (slippage.kind !== "bps" && slippage.kind !== "absolute") {
    errors.push('slippage.kind: "bps" | "absolute"');
  }

  if (!isFiniteNumber(slippage.value) || slippage.value < 0) {
    errors.push("slippage.value: конечное число ≥ 0");
  }

  if (slippage.kind === "bps" && slippage.value > 1000) {
    errors.push("slippage.value в bps нереалистично велико (> 1000 bp)");
  }

  const fees = source.fees ?? BACKTEST_DEFAULTS.fees;

  if (!isFiniteNumber(fees.bps) || fees.bps < 0) {
    errors.push("fees.bps: конечное число ≥ 0");
  }

  if (!isFiniteNumber(fees.fixedPerSide) || fees.fixedPerSide < 0) {
    errors.push("fees.fixedPerSide: конечное число ≥ 0");
  }

  const expectedTimeframeMs =
    source.expectedTimeframeMs === undefined
      ? BACKTEST_DEFAULTS.expectedTimeframeMs
      : source.expectedTimeframeMs;

  if (
    expectedTimeframeMs !== null &&
    (!isFiniteNumber(expectedTimeframeMs) || expectedTimeframeMs <= 0)
  ) {
    errors.push("expectedTimeframeMs: число > 0 или null");
  }

  const warmupBars = source.warmupBars ?? BACKTEST_DEFAULTS.warmupBars;

  if (!Number.isInteger(warmupBars) || warmupBars < 0) {
    errors.push("warmupBars: целое ≥ 0");
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    config: {
      quantity,
      initialEquity,
      entryPolicy,
      sameBarPolicy,
      timeoutBars,
      slippage: { kind: slippage.kind, value: slippage.value },
      fees: { bps: fees.bps, fixedPerSide: fees.fixedPerSide },
      requireUniformGrid:
        source.requireUniformGrid ?? BACKTEST_DEFAULTS.requireUniformGrid,
      expectedTimeframeMs,
      warmupBars
    }
  };
}

/**
 * Помощник для тестов и будущих адаптеров: список решений по индексам
 * баров превращается в провайдер. Список НЕ расширяется и не
 * интерполируется: выход за его границы = «сигнала нет».
 */
export function signalProviderFromList(
  decisions: SignalDecisionList
): SignalProvider {
  return (context) => {
    const decision = decisions[context.index];

    return decision === undefined ? null : decision;
  };
}

/** Нормализация решения без полей label/facts (для тестов и адаптеров). */
export function entryDecision(
  kind: Direction,
  stopLoss: number,
  takeProfit: number,
  label = "",
  facts: readonly string[] = []
): EntryDecision {
  return { kind, stopLoss, takeProfit, label, facts };
}

/** NEUTRAL / CANNOT_EVALUATE без сделки. */
export function noTradeDecision(
  kind: NoTradeKind,
  label = "",
  facts: readonly string[] = []
): NoTradeDecision {
  return { kind, label, facts };
}

export { isFiniteNumber };
