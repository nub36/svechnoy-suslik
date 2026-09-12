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
 *    цену — LONG: sl < ref < tp, SHORT: tp < ref < sl. Проверяется оно
 *    на баре СИГНАЛА N при ref = close бара N: нарушение означает, что
 *    решение внутренне противоречиво → rejectedSignals, reason
 *    "levels-on-wrong-side", вход не планируется. Структурно невалидные
 *    уровни (не конечные, ≤ 0, sl = tp, label не строка, facts не
 *    массив строк) → reason "invalid-levels".
 *    Сигнал на последнем баре набора/сегмента не имеет N+1 →
 *    skippedSignals "no-next-bar" / "segment-boundary".
 *
 *    4a. ГЭП НА ВХОДЕ (исправлено аудитом: раньше такие случаи
 *    ОТКЛОНЯЛИСЬ, что удаляло из выборки класс убыточных сделок и
 *    смещало winRate/PF/drawdown/expectancy в выгодную сторону).
 *    Теперь вход исполняется ВСЕГДА по open бара N+1, а дальнейшая
 *    судьба позиции определяется ОБЩИМ гэповым правилом пункта 7:
 *      - LONG и open ≤ sl (или open ≥ tp) → позиция открывается по
 *        open и закрывается ПО ТОМУ ЖЕ open (гэп через уровень);
 *      - SHORT симметрично: open ≥ sl или open ≤ tp.
 *    Валовый PnL такой сделки ≈ 0 (вход и выход — один open), а чистый
 *    отрицателен на величину издержек: две стороны слиппеджа плюс две
 *    комиссии. Это честный результат исполнения, а не «удалённый»
 *    невыгодный кейс. exitReason при этом отражает ТРИГГЕР
 *    (STOP_LOSS/TAKE_PROFIT), а знак PnL — экономику; сделка
 *    помечается gapThrough и учитывается в gapThroughTrades.
 *    Коды отказов "entry-levels-breached-at-open" и
 *    "entry-fill-outside-levels" СОХРАНЕНЫ в объединении RejectReason
 *    (форма отчётов `rejectedByReason` стабильна — 4 ключа), но
 *    движком больше НЕ производятся: их счётчики всегда нулевые.
 *    Экстремальный слиппедж, выносящий фактическую цену входа за
 *    уровни, обрабатывается так же: вход по факту, выход по open.
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
 *    Слиппедж применяется и к гэповому исполнению. Правило действует
 *    и НА БАРЕ ВХОДА (пункт 4a): это единственная непротиворечивая
 *    трактовка, при которой вход и выход исполняются по одной и той же
 *    реально существовавшей цене.
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
 * 11. PnL И R (исправлено аудитом: знаменатель R больше НЕ может
 *     схлопнуться). LONG: gross = (exit − entry) × qty; SHORT: gross =
 *     (entry − exit) × qty; net = gross − fees.
 *     ПЕРВИЧНЫЙ знаменатель R — ПЛАНОВЫЙ риск, известный на момент
 *     сигнала: plannedEntryReference = close бара СИГНАЛА N (опорная
 *     цена, относительно которой проверялись уровни),
 *     plannedRisk = |plannedEntryReference − stopLoss| × qty.
 *     grossR = gross / plannedRisk; rMultiple = net / plannedRisk
 *     (заголовный R — ЧИСТЫЙ, консервативно). plannedRewardRisk =
 *     |tp − ref| / |ref − sl|.
 *     Фактическое исполнение (слиппедж, гэп) влияет на ЧИСЛИТЕЛЬ, а не
 *     на знаменатель: иначе вход почти в собственный стоп давал бы
 *     risk ≈ 0 и R в тысячи крат (аудит: open = 90.001 при sl = 90 →
 *     R ≈ 19999).
 *     ДИАГНОСТИКА (не первичная метрика): riskAmount =
 *     |entryPrice − stopLoss| × qty, grossRActualFill,
 *     rMultipleActualFill — те же величины по фактической цене входа.
 *     При plannedRisk = 0 (уровни структурно прошли проверку, так что
 *     это возможно только для вырожденных данных) R-величины = 0.
 *
 * 12. МЕТРИКИ — только из ИСПОЛНЕННЫХ сделок (никаких «целевых»
 *     winrate/PF). win ⇔ netPnl > 0, loss ⇔ netPnl < 0, иначе
 *     breakeven (нуль не считается ни победой, ни убытком). Все
 *     отношения/средние при нуле сделок = null (не 0 — это была бы
 *     ложь). Profit factor считается ПО ЧИСТОМУ PnL; при нуле чистых
 *     убытков PF = null с явным profitFactorState "no-losses"
 *     (Infinity в JSON не сериализуется и не используется).
 *
 * 13. DRAWDOWN — ТРИ базы, каждая со своим именем и смыслом (аудит
 *     указал, что «mark-to-market» по close не является консервативной
 *     оценкой: позиция может весь срок висеть в тик над стопом при
 *     неизменном close, и такая просадка была бы 0).
 *      a) РЕАЛИЗОВАННАЯ (основная, maxDrawdown / maxDrawdownPct):
 *         initialEquity + накопленный netPnl, точка на каждую закрытую
 *         сделку, хронологически.
 *      b) CLOSE-TO-CLOSE нереализованная (maxDrawdownMarkToMarket /
 *         …Pct): открытая позиция переоценивается по CLOSE каждого
 *         бара. Имя поля сохранено для совместимости, но смысл —
 *         именно close-to-close, и консервативной эта база НЕ является.
 *         Будущая комиссия выхода не резервируется.
 *      c) ADVERSE EXCURSION (MAE, наиболее консервативная:
 *         maxAdverseExcursionDrawdown / …Pct): открытая позиция
 *         переоценивается по НАИХУДШЕЙ цене бара — LONG по low, SHORT
 *         по high. Показывает, какой была бы просадка при отметке в
 *         самой неблагоприятной точке каждого бара.
 *     Процентный drawdown = null, если пик ≤ 0. equityNonPositive
 *     взводится, если ЛЮБАЯ из трёх баз уходила ≤ 0. Маржинальной
 *     модели/ликвидации в P2-A НЕТ. Размер позиции ФИКСИРОВАННЫЙ
 *     (quantity), компаундинга нет.
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
 *
 * 17. ЧИСЛОВАЯ ПОЛНОТА. Успешный результат (ok = true) НЕ МОЖЕТ
 *     содержать ни одного неконечного числа: после вычислений
 *     результат сканируется целиком (сделки, метрики, кривая эквити,
 *     метаданные), и любое NaN/±Infinity даёт структурированный отказ
 *     stage = "arithmetic" с путём до значения. Конечные, но огромные
 *     входы (quantity ~ 1e308, большие фиксированные комиссии)
 *     переполняют IEEE-754 при умножении — вместо «красивого» результата
 *     с maxDrawdown = 0 и profitFactorState = "no-losses" возвращается
 *     отказ. serializeResult поэтому не может упасть на успешном
 *     результате. Исключений нет и для «эха» отклонённых сигналов:
 *     неконечные уровни решения нормализуются в null при записи отказа
 *     (rejectedSignals[].stopLoss / takeProfit: number | null), а
 *     фактическое значение приводится в detail. Иначе serializeResult
 *     бросал бы исключение на успешном прогоне с отказом
 *     "invalid-levels" при NaN-уровне.
 *
 * 18. НЕИЗМЕНЯЕМОСТЬ. Разрешённый конфиг и результат заморожены
 *     ГЛУБОКО (включая config.slippage, config.fees, metrics,
 *     метаданные, элементы массивов): мутация вложенного объекта
 *     больше не может разодрать fingerprintConfig(result.config) и
 *     metadata.configFingerprint.
 *
 * 19. ИСТОЧНИК РЕШЕНИЙ. Три формы: функция-провайдер, список решений
 *     по индексам, либо SignalAdapter — { adapterId, version,
 *     requiredLookbackBars, decide }. Адаптер ОБЯЗАН объявить, сколько
 *     баров истории до текущего ему нужно: сегментный прогон
 *     разрешает warmup как max(config.warmupBars,
 *     adapter.requiredLookbackBars − 1) баров ПЕРЕД окном, поэтому
 *     реалистичный провайдер,
 *     читающий предыдущие бары, не падает на VALIDATION/OOS при
 *     warmupBars = 0. Каузальная история ДО начала сегмента — это
 *     прошлое, а НЕ утечка; искусственных разрывов между сегментами
 *     нет и не появляется. Невалидный адаптер → stage = "adapter".
 *     Метка сегмента (TRAIN/VALIDATION/OOS) провайдеру НЕ передаётся:
 *     торговая логика не должна знать, на каком этапе оценки её
 *     прогоняют (иначе «слепой» OOS фиктивен). Состояние движка
 *     (позиция, сделки, эквити) сбрасывается на границе сегмента, а
 *     ПРОИЗВОЛЬНОЕ замыкание провайдера движком не сбрасывается — это
 *     обязанность автора стратегии (см. пункт 20).
 *
 * 20. NO-LOOKAHEAD: ДВЕ РАЗНЫЕ гарантии, их нельзя смешивать.
 *     A. СТРУКТУРНАЯ (доказуема кодом): данные, доступные через
 *        SignalContext (bar, barAt, position), не содержат будущего —
 *        barAt(i) при i > index бросает исключение, при
 *        i < firstVisibleIndex — тоже; visibleBars равен фактически
 *        доступному числу баров (index − firstVisibleIndex + 1).
 *     B. ВНЕШНЕЕ СОСТОЯНИЕ (недоказуемо в JS): провайдер-функция может
 *        держать будущие бары в замыкании, глобале или заранее
 *        вычисленном массиве. Отозвать уже выданные данные язык не
 *        позволяет, поэтому НИ ОДИН тест не может сертифицировать
 *        произвольный колбэк. `assertDecisionInvariance` — это
 *        КОНТРФАКТИЧЕСКАЯ ДИАГНОСТИКА: она ловит lookahead только если
 *        будущее приходит провайдеру через массив, переданный движку.
 *        Для P2-B единственный допустимый контракт — адаптер,
 *        получающий рыночные данные ИСКЛЮЧИТЕЛЬНО через каузальный
 *        контекст движка (тогда диагностика имеет смысл), плюс
 *        ревью/сертификация источника данных адаптера.
 *
 * 21. КОНФИГ БЕЗ НЕИЗВЕСТНЫХ КЛЮЧЕЙ. Любой ключ объекта config, не
 *     входящий в BacktestConfig, — ошибка валидации (fail closed):
 *     опечатка «timeoutBar» не должна молча означать «таймаута нет».
 *
 * 22. РЕШЕНИЯ ПРОВЕРЯЮТСЯ И СНЭПШОТЯТСЯ НА БАРЕ СИГНАЛА. kind,
 *     stopLoss, takeProfit, label (строка, если задан) и facts (массив
 *     строк, если задан) проверяются при принятии решения; скаляры и
 *     список фактов КОПИРУЮТСЯ в отложенный вход, поэтому последующая
 *     мутация объекта решения вызывающим кодом не может изменить уже
 *     запланированную сделку.
 *
 * 23. ОДИНОЧНОЕ ЧТЕНИЕ РЕШЕНИЯ (анти-TOCTOU). Возвращённое источником
 *     решений значение читается в plain-снимок ДО любой семантической
 *     проверки, и КАЖДОЕ поле читается РОВНО ОДИН РАЗ
 *     (`captureSignalDecision`): kind, stopLoss, takeProfit, label,
 *     facts (массив копируется поэлементно один раз и замораживается).
 *     Проверяется СНИМОК, и вся дальнейшая логика (отбраковка уровней,
 *     обрамление опорной цены, отложенный вход, запись сделки)
 *     потребляет ТОЛЬКО его. Поэтому геттер или Proxy, возвращающий
 *     другое значение при повторном обращении, не может подменить
 *     исполненные уровни после проверки: вариант «проверили 90,
 *     исполнили −5» исключён конструкцией. Число чтений поля покрыто
 *     тестом (по одному на поле). Прочие собственные поля решения
 *     движком не используются и перечисляются в `extraKeys` снимка.
 *
 * 24. КОНТЕЙНЕР `signals` КЛАССИФИЦИРУЕТСЯ СТРОГО (fail closed).
 *     Допустимы РОВНО три формы: (A) настоящий Array решений,
 *     (B) функция-провайдер, (C) валидный SignalAdapter. Всё остальное
 *     (`{}`, число, boolean, Map, Set, Date, null, undefined,
 *     array-like объект `{0: decision, length: 1}`, «адаптер» без
 *     `decide` или с опечаткой `Decide`) — структурированный отказ:
 *     stage `"signals"` для недопустимого контейнера и stage `"adapter"`
 *     для объекта, похожего на адаптер, но невалидного. Объект,
 *     похожий на массив, массивом НЕ считается. Молчаливое
 *     превращение мусора в «стратегия не дала ни одного сигнала»
 *     (ok:true, 0 сделок) запрещено.
 * ══════════════════════════════════════════════════════════════════
 */

/**
 * Версия контракта: меняется при любом изменении семантики.
 *
 * p2a-1.2.0 — hardening #2 по итогам повторного независимого аудита
 * `f87d6f9` (PASS WITH RISKS): решение источника сигналов читается
 * РОВНО ОДИН РАЗ в неизменяемый plain-снимок до валидации
 * (анти-TOCTOU, пункт 23), контейнер `signals` классифицируется строго
 * и больше не проваливается в «пустой список» (пункт 24, новая стадия
 * отказа `"signals"`), `deepFreeze` и скан конечности защищены от
 * циклических ссылок. Семантика исполнения ВАЛИДНЫХ прогонов не
 * изменилась; отпечатки меняются из-за версии контракта.
 *
 * p2a-1.1.0 — hardening по итогам независимого adversarial-аудита
 * `096e13d`: гэповый вход БОЛЬШЕ НЕ отклоняется (исполнение по open
 * бара входа booking'ом, а не удалением выборки), знаменатель R —
 * ПЛАНОВЫЙ риск, добавлены MAE-просадка и диагностика R по факту
 * исполнения, из результата исключены любые неконечные числа, конфиг и
 * результат заморожены глубоко, источник решений может объявить
 * `requiredLookbackBars`, из SignalContext убрана метка сегмента,
 * `visibleBars` считается от `firstVisibleIndex`, неизвестные ключи
 * конфига отклоняются.
 */
export const BACKTEST_CONTRACT_VERSION = "p2a-1.2.0";

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

/**
 * Детерминированное короткое описание значения для текстов ошибок.
 *
 * Намеренно НЕ вызывает пользовательский `toString`/`Symbol.toPrimitive`
 * объекта: hostile-значение не должно ни бросать исключение, ни
 * подставлять произвольный текст. Для объектов используется
 * `Object.prototype.toString` («[object Map]», «[object Date]», …).
 */
export function describeValue(value: unknown): string {
  if (value === null) {
    return "null";
  }

  const kind = typeof value;

  if (kind === "undefined") {
    return "undefined";
  }

  if (kind === "string") {
    const text = value as string;

    return `строка "${text.length > 40 ? `${text.slice(0, 40)}…` : text}"`;
  }

  if (kind === "number") {
    return `число ${String(value as number)}`;
  }

  if (kind === "boolean") {
    return `булево ${String(value as boolean)}`;
  }

  if (kind === "bigint") {
    return `bigint ${String(value as bigint)}`;
  }

  if (kind === "function") {
    return "функция";
  }

  if (kind === "symbol") {
    return "symbol";
  }

  return Object.prototype.toString.call(value);
}

/** Поля решения, которые движок читает и использует. */
export const DECISION_FIELDS: readonly string[] = Object.freeze([
  "kind",
  "stopLoss",
  "takeProfit",
  "label",
  "facts"
]);

/**
 * Plain-снимок решения источника сигналов (пункт 23 политики).
 *
 * Значения скопированы из возвращённого объекта РОВНО ПО ОДНОМУ ЧТЕНИЮ
 * на поле, поэтому повторные вызовы геттеров/ловушек Proxy не могут
 * изменить уже принятое решение. `stopLoss`/`takeProfit` хранятся КАК
 * ПРОЧИТАНЫ (unknown): их семантическую проверку выполняет
 * `validateEntryDecisionShape`, и она тоже работает только со снимком.
 */
export interface CapturedDecision {
  readonly kind: SignalDecisionKind;
  readonly stopLoss: unknown;
  readonly takeProfit: unknown;
  readonly label: string;
  readonly facts: readonly string[];
  /** Собственные поля решения, которые движок НЕ использует. */
  readonly extraKeys: readonly string[];
}

export type DecisionCapture =
  | { readonly ok: true; readonly decision: CapturedDecision }
  | { readonly ok: false; readonly errors: readonly string[] };

/**
 * Читает решение источника сигналов в неизменяемый снимок.
 *
 * Порядок обязателен: СНАЧАЛА одиночное чтение всех полей и
 * структурные проверки (kind — один из четырёх литералов, label —
 * строка, если задан, facts — настоящий массив строк, если задан),
 * ЗАТЕМ (вне этой функции) семантическая проверка уровней по снимку.
 * Исходный объект после вызова больше не читается никем в движке.
 */
export function captureSignalDecision(raw: unknown): DecisionCapture {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      errors: [
        `решение должно быть объектом (получено ${describeValue(raw)})`
      ]
    };
  }

  const source = raw as Record<string, unknown>;
  const errors: string[] = [];

  /* ---- одиночные чтения (TOCTOU-барьер) ---- */

  const kindRaw = source.kind;
  const stopLossRaw = source.stopLoss;
  const takeProfitRaw = source.takeProfit;
  const labelRaw = source.label;
  const factsRaw = source.facts;
  // Перечисление ключей геттеры не вызывает, но даёт список «чужих»
  // полей для диагностики.
  const ownKeys = Object.keys(source);

  if (
    kindRaw !== "LONG" &&
    kindRaw !== "SHORT" &&
    kindRaw !== "NEUTRAL" &&
    kindRaw !== "CANNOT_EVALUATE"
  ) {
    errors.push(`неизвестный kind=${describeValue(kindRaw)}`);
  }

  let label = "";

  if (labelRaw !== undefined) {
    if (typeof labelRaw !== "string") {
      errors.push(`label должен быть строкой (получено ${describeValue(labelRaw)})`);
    } else {
      label = labelRaw;
    }
  }

  let facts: readonly string[] = Object.freeze([] as readonly string[]);

  if (factsRaw !== undefined) {
    if (!Array.isArray(factsRaw)) {
      errors.push(
        `facts должен быть НАСТОЯЩИМ массивом строк (получено ${describeValue(factsRaw)})`
      );
    } else {
      // Копия создаётся ОДИН раз и поэлементно: чужой массив остаётся
      // снаружи, а снимок замораживается.
      const copy: string[] = [];
      const items: readonly unknown[] = factsRaw as readonly unknown[];

      for (let index = 0; index < items.length; index += 1) {
        const item = items[index];

        if (typeof item !== "string") {
          errors.push(
            `facts должен содержать только строки: facts[${String(index)}] = ${describeValue(item)}`
          );

          break;
        }

        copy.push(item);
      }

      if (errors.length === 0) {
        facts = Object.freeze(copy);
      }
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    decision: Object.freeze({
      kind: kindRaw as SignalDecisionKind,
      stopLoss: stopLossRaw,
      takeProfit: takeProfitRaw,
      label,
      facts,
      extraKeys: Object.freeze(
        ownKeys.filter((key) => !DECISION_FIELDS.includes(key))
      )
    })
  };
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
  /**
   * Сколько баров ФАКТИЧЕСКИ доступно провайдеру:
   * index − firstVisibleIndex + 1. При warmup-окне сегмента это меньше,
   * чем index + 1 (исправлено аудитом: раньше заявлялось index + 1,
   * что противоречило firstVisibleIndex > 0).
   */
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
  /**
   * Метки сегмента (TRAIN/VALIDATION/OOS) в контексте НЕТ намеренно
   * (пункт 19 политики): торговое решение не должно знать, на каком
   * этапе оценки его прогоняют. Сегмент знает вызывающий слой
   * (spлиты/отчёты), а не логика входа.
   */
}

export type SignalProvider = (context: SignalContext) => SignalDecision | null;

/**
 * Адаптер стратегии — предпочтительная форма источника решений для
 * сертифицируемых прогонов (пункты 19 и 20 политики).
 *
 * Контракт для P2-B: рыночная информация поступает адаптеру
 * ИСКЛЮЧИТЕЛЬНО через каузальный `SignalContext`, который владеет
 * движок. Никаких собственных массивов баров, глобалов и заранее
 * вычисленных «будущих» срезов: только при таком условии контрфакт-
 * диагностика no-lookahead имеет смысл, а структурный барьер barAt
 * покрывает весь канал данных.
 */
export interface SignalAdapter {
  /** Идентичность источника решений (входит в отпечатки прогона). */
  readonly adapterId: string;
  /** Версия источника решений. */
  readonly version: string;
  /**
   * Сколько ЗАКРЫТЫХ баров истории (включая текущий) нужно адаптеру:
   * 1 — только текущий бар, 3 — текущий и два предыдущих. Движок и
   * сегментный прогон поднимают warmup как max(config.warmupBars,
   * requiredLookbackBars − 1) баров ПЕРЕД началом окна, поэтому
   * требование истории ОБЯЗАНО быть явным, а не «на глаз».
   */
  readonly requiredLookbackBars: number;
  /** Решающая функция. Получает только каузальный контекст. */
  readonly decide: SignalProvider;
}

/** Все допустимые формы источника решений. */
export type SignalSource =
  | SignalProvider
  | SignalDecisionList
  | SignalAdapter;

/**
 * Типовая защита адаптера. Список решений (массив) и функция
 * отличаются от адаптера по наличию строкового `adapterId` и функции
 * `decide`; порядок проверок важен: функция не является объектом, а
 * массив не имеет `decide`.
 */
export function isSignalAdapter(source: SignalSource): source is SignalAdapter {
  return (
    typeof source === "object" &&
    source !== null &&
    !Array.isArray(source) &&
    typeof (source as SignalAdapter).decide === "function"
  );
}

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
/** Глубоко заморожен: дефолты нельзя изменить из вызывающего кода. */
export const BACKTEST_DEFAULTS: ResolvedBacktestConfig = deepFreeze<ResolvedBacktestConfig>({
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
});

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

/**
 * Решение отклонено как несогласованное.
 *
 * Производятся движком только два первых кода (обе — на баре СИГНАЛА):
 *  - "invalid-levels"       — структурно невалидные уровни/метка/факты;
 *  - "levels-on-wrong-side" — уровни не обрамляют close бара сигнала.
 * Два последних кода — ИСТОРИЧЕСКИЕ: до hardening (p2a-1.0.0) по ним
 * отклонялся гэповый вход, что удаляло из выборки класс убыточных
 * сделок (пункт 4a политики). Теперь гэп на входе ИСПОЛНЯЕТСЯ, коды
 * сохранены только ради стабильной формы `rejectedByReason` (4 ключа)
 * и их счётчики всегда нулевые.
 */
export type RejectReason =
  | "invalid-levels"
  | "levels-on-wrong-side"
  | "entry-levels-breached-at-open"
  | "entry-fill-outside-levels";

/** Коды отказов, которые движок больше не производит (см. RejectReason). */
export const RETIRED_REJECT_REASONS: readonly RejectReason[] = [
  "entry-levels-breached-at-open",
  "entry-fill-outside-levels"
];

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
  /**
   * Опорная цена, известная НА МОМЕНТ СИГНАЛА (close бара сигнала):
   * относительно неё проверялись уровни и от неё считается плановый
   * риск. Пункт 11 политики.
   */
  readonly plannedEntryReference: number;
  /**
   * ПЛАНОВЫЙ риск: |plannedEntryReference − stopLoss| × quantity.
   * Первичный знаменатель R (не может схлопнуться из-за гэпа или
   * слиппеджа на входе).
   */
  readonly plannedRisk: number;
  /**
   * ДИАГНОСТИКА: |entryPrice − stopLoss| × quantity (риск по
   * фактической цене входа). Первичным знаменателем R НЕ является.
   */
  readonly riskAmount: number;
  /** Задуманное reward/risk по плановым уровням: |tp − ref| / |ref − sl|. */
  readonly plannedRewardRisk: number;
  readonly grossPnl: number;
  readonly feeEntry: number;
  readonly feeExit: number;
  readonly feesTotal: number;
  /** Аналитическая стоимость слиппеджа (в валюте счёта). */
  readonly slippageCost: number;
  readonly netPnl: number;
  /** gross / plannedRisk (первичный, плановый знаменатель). */
  readonly grossR: number;
  /** net / plannedRisk (заголовный ЧИСТЫЙ R). */
  readonly rMultiple: number;
  /** ДИАГНОСТИКА: gross / riskAmount (знаменатель по факту входа). */
  readonly grossRActualFill: number;
  /** ДИАГНОСТИКА: net / riskAmount (знаменатель по факту входа). */
  readonly rMultipleActualFill: number;
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
   * null — только если опорная цена не была конечной (бары
   * валидируются, поэтому на практике недостижимо).
   */
  readonly referencePrice: number | null;
  /**
   * Уровни решения КАК ОНИ БЫЛИ получены. null означает «значение не
   * было конечным числом»: NaN/±Infinity нормализуются здесь в null,
   * чтобы успешный результат оставался полностью конечным и
   * сериализуемым (пункт 17), а фактическое значение приводится в
   * тексте detail.
   */
  readonly stopLoss: number | null;
  readonly takeProfit: number | null;
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
  /** ДИАГНОСТИКА: средний R по фактическому знаменателю входа. */
  readonly avgRActualFill: number | null;
  /** ДИАГНОСТИКА: медиана R по фактическому знаменателю входа. */
  readonly medianRActualFill: number | null;
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
  /**
   * CLOSE-TO-CLOSE нереализованная база: открытая позиция
   * переоценивается по close каждого бара. Консервативной НЕ является
   * (пункт 13 политики); консервативная оценка — adverse excursion ниже.
   */
  readonly maxDrawdownMarkToMarket: number;
  readonly maxDrawdownMarkToMarketPct: number | null;
  /**
   * Наиболее консервативная база (MAE): открытая позиция
   * переоценивается по наихудшей цене бара — LONG по low, SHORT по high.
   */
  readonly maxAdverseExcursionDrawdown: number;
  readonly maxAdverseExcursionDrawdownPct: number | null;
  /**
   * Эквити уходило ≤ 0 ПО ЛЮБОЙ из трёх баз (маржинальной модели в
   * P2-A нет, поэтому такой исход возможен и обязан быть видимым).
   */
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
  /**
   * Начало разогрева ВНУТРИ сегмента; null для полного прогона
   * (поле сохранено без изменения семантики для обратной
   * совместимости проекций). Для полного прогона смотри
   * historyStartIndex.
   */
  readonly warmupStartIndex: number | null;
  /** Источник решений: адаптер, функция-провайдер или готовый список. */
  readonly signalSourceKind: "adapter" | "provider" | "list";
  /** Идентичность адаптера; null, если источник — не адаптер. */
  readonly adapterId: string | null;
  readonly adapterVersion: string | null;
  /**
   * Заявленное число ЗАКРЫТЫХ баров истории, нужных источнику решений
   * (1 — только текущий бар). Для провайдера/списка всегда 1: чужое
   * требование истории не выдумывается.
   */
  readonly requiredLookbackBars: number;
  /**
   * Индекс первого бара, доступного решениям через context.barAt
   * (всегда заполнен, в отличие от warmupStartIndex). Разгон —
   * КАУЗАЛЬНАЯ история ДО окна, а не утечка будущего.
   */
  readonly historyStartIndex: number;
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

/**
 * Результат прогона: либо успех, либо структурированная ошибка.
 *
 * Стадии: "config" (конфиг), "adapter" (источник решений-адаптер),
 * "bars" (данные/окно), "provider" (поведение источника решений),
 * "arithmetic" (переполнение: в результате появилось неконечное число,
 * пункт 17 политики).
 */
export type BacktestOutcome =
  | { readonly ok: true; readonly result: BacktestResult }
  | {
      readonly ok: false;
      /**
       * Стадия отказа. `"signals"` — контейнер источника решений не
       * является ни массивом решений, ни функцией, ни валидным
       * адаптером (пункт 24 политики); `"adapter"` — объект похож на
       * адаптер, но невалиден.
       */
      readonly stage:
        | "config"
        | "adapter"
        | "signals"
        | "bars"
        | "provider"
        | "arithmetic";
      readonly errors: readonly string[];
    };

export interface BacktestInput {
  readonly bars: readonly BacktestBar[];
  /**
   * Провайдер-функция, список решений (настоящий Array) либо адаптер
   * стратегии. Классификация строгая: любой другой контейнер —
   * отказ stage `"signals"` (пункт 24 политики).
   */
  readonly signals: SignalSource;
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
/** Ключи BacktestConfig: неизвестные ключи отклоняются (пункт 21). */
export const BACKTEST_CONFIG_KEYS: readonly string[] = [
  "quantity",
  "initialEquity",
  "entryPolicy",
  "sameBarPolicy",
  "timeoutBars",
  "slippage",
  "fees",
  "requireUniformGrid",
  "expectedTimeframeMs",
  "warmupBars"
];

/**
 * Глубокая заморозка (пункт 18 политики): вложенные объекты конфига и
 * результата больше не мутируются, поэтому отпечаток конфига не может
 * разойтись с metadata.configFingerprint постфактум.
 *
 * `visited` — защита от циклических ссылок: без неё объект, ссылающийся
 * сам на себя, дал бы бесконечную рекурсию (RangeError). Функция
 * публичная, поэтому вход не предполагается «заведомо древовидным».
 */
export function deepFreeze<T>(value: T, visited?: WeakSet<object>): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const seen = visited ?? new WeakSet<object>();
  const target = value as unknown as Record<string, unknown>;

  if (seen.has(target)) {
    return value;
  }

  seen.add(target);

  for (const key of Object.keys(target)) {
    const nested = target[key];

    if (nested !== null && typeof nested === "object" && !Object.isFrozen(nested)) {
      deepFreeze(nested, seen);
    }
  }

  return Object.freeze(value);
}

export function resolveBacktestConfig(
  config?: BacktestConfig
): ConfigCheck {
  const errors: string[] = [];
  const source: BacktestConfig = config ?? {};

  if (config !== null && config !== undefined) {
    if (typeof config !== "object" || Array.isArray(config)) {
      return { ok: false, errors: ["config: ожидается объект"] };
    }

    // Пункт 21 политики: неизвестный ключ — ошибка, а не молчаливый
    // дефолт. Опечатка в имени параметра не должна менять семантику.
    const known = new Set(BACKTEST_CONFIG_KEYS);

    for (const key of Object.keys(config)) {
      if (!known.has(key)) {
        errors.push(
          `config: неизвестный ключ "${key}" (допустимы: ${BACKTEST_CONFIG_KEYS.join(", ")})`
        );
      }
    }

    for (const key of ["slippage", "fees"] as const) {
      const nested = source[key];

      if (nested !== undefined) {
        if (typeof nested !== "object" || nested === null || Array.isArray(nested)) {
          errors.push(`config.${key}: ожидается объект`);

          continue;
        }

        const allowed =
          key === "slippage" ? ["kind", "value"] : ["bps", "fixedPerSide"];

        for (const nestedKey of Object.keys(nested)) {
          if (!allowed.includes(nestedKey)) {
            errors.push(
              `config.${key}: неизвестный ключ "${nestedKey}" (допустимы: ${allowed.join(", ")})`
            );
          }
        }
      }
    }
  }

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
    config: deepFreeze<ResolvedBacktestConfig>({
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
    })
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
