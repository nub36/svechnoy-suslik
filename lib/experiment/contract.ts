/**
 * P2-C — Experiment / Report foundation: КОНТРАКТ И ПОЛИТИКА.
 *
 * Чистый детерминированный слой поверх P2-A (`lib/backtest/*`):
 * формализованный эксперимент (subject + split + набор конфигураций),
 * честный отчёт по TRAIN/VALIDATION/OOS, детерминированное сравнение
 * конфигураций и контракт воспроизводимости.
 *
 * БЕЗ Prisma/PostgreSQL/БД/сети/workers/process.env/текущего времени/
 * случайности/файлов хранения. Зависимости — только `lib/backtest/*`
 * (P2-A) и `node:crypto` через P2-A-сериализатор. P2-B (read-only
 * historical data plane) разрабатывается отдельно и сюда НЕ входит:
 * входы P2-C — pure/in-memory (бары + источник решений).
 *
 * ══════════════════════════════════════════════════════════════════
 * ПОЛИТИКА (каждый пункт зафиксирован и покрыт тестами:
 * scripts/test-experiment-contract.ts, test-experiment-report.ts,
 * test-experiment-leakage.ts)
 * ══════════════════════════════════════════════════════════════════
 *
 * 1. P2-A — ЕДИНСТВЕННЫЙ ИСТОЧНИК ИСТИНЫ. P2-C не исполняет сделки и
 *    НЕ пересчитывает метрики другим алгоритмом: он проектирует
 *    (копирует поле-в-поле), агрегирует и оформляет. Каждое число в
 *    отчёте — это значение из `BacktestMetrics`/`BacktestResult` P2-A,
 *    что проверяется тестами на точное равенство (не «примерно»).
 *    Маркер `provenance: "p2a-metrics-verbatim"` записывается в каждый
 *    сегментный отчёт.
 *
 * 2. ЭТО НЕ ОПТИМИЗАТОР. P2-C не генерирует конфигурации, не подбирает
 *    параметры, не ищет максимум win rate/PF и не выбирает «лучший»
 *    прогон по умолчанию. Он упорядочивает и сравнивает ТОЛЬКО явно
 *    переданный вызывающим кодом набор и ТОЛЬКО по явно запрошенным
 *    критериям.
 *
 * 3. РАЗБИЕНИЕ — ТОЛЬКО P2-A. Используется фактический
 *    `chronologicalSplit` из `lib/backtest/splits.ts`; второй,
 *    несовместимый алгоритм разбиения не создаётся. TRAIN → VALIDATION
 *    → OOS хронологически, сегменты стыкуются вплотную, пересечений и
 *    дыр нет, OOS = остаток. Любое отклонение — отказ, а не «починка».
 *
 * 4. ПРИЧИННОСТЬ И LEAKAGE. Главное правило: БУДУЩИЕ данные не могут
 *    влиять на прошлое. Causal historical warm-up ДО текущего asOf
 *    (чтение баров раньше начала сегмента в пределах `warmupBars`)
 *    утечкой НЕ считается — это прошлое, оно законно и в P2-A
 *    разрешено структурно. Утечкой считается: вход через границу
 *    сегмента, пересечение окон, результат чужого сегмента, результат
 *    чужой конфигурации, результат чужого рынка/таймфрейма, и
 *    использование OOS при выборе конфигурации. Всё это проверяется
 *    валидаторами `lib/experiment/validate.ts` (частично переиспользуя
 *    P2-A `assertNoSegmentLeakage`).
 *
 * 5. ИЗОЛЯЦИЯ OOS — ТРИ УРОВНЯ.
 *      a) СТРУКТУРНО: ранжирование и выбор принимают только
 *         `EvidenceEntry[]` из блока TRAIN (selection evidence) или
 *         VALIDATION (confirmation evidence). Тип `SelectionStage`
 *         физически не содержит "OOS", поэтому передать OOS в
 *         ранжирование нельзя без явного приведения типов. Статус
 *         участника блока определяется сегментом САМОГО блока, а не
 *         сводным статусом варианта: отказ OOS-сегмента не может
 *         исключить конфигурацию из TRAIN/VALIDATION-ранжирования
 *         (пункт 22в);
 *      b) ПОЛИТИКОЙ: `selectionPolicy.stage === "OOS"` — ошибка
 *         валидации конфига эксперимента;
 *      c) ПРОВЕРКОЙ: `assertRankingIndependentOfOos` ПЕРЕСЧИТЫВАЕТ
 *         записанный порядок из сохранённых TRAIN/VALIDATION-
 *         свидетельств и сверяет его; порядок, полученный с оглядкой на
 *         OOS, не воспроизведётся и будет отвергнут.
 *    OOS публикуется отдельным блоком `evidence.oosFinal` с явной
 *    пометкой, что в выборе он не участвовал.
 *
 * 6. НИКАКОГО CHERRY-PICKING. Кажд объявленный вариант присутствует в
 *    записи эксперимента РОВНО ОДИН раз: и оценённый, и отклонённый
 *    (со стадией, причиной и списком ошибок). Инвариант
 *    `counts.declared === counts.evaluated + counts.rejected` и
 *    `variants.length === counts.declared` проверяется тестами:
 *    передать 10 конфигураций и получить только лучшую невозможно.
 *    Вариант считается `evaluated` только если ВСЕ ТРИ сегмента
 *    отработали и прошли проверку утечки; иначе `rejected` с указанием
 *    конкретного сегмента. Сводный статус варианта — это СВОДКА
 *    происхождения (и она честно показывает отказ любого сегмента), но
 *    НЕ критерий участия в ранжировании: участие определяется статусом
 *    сегмента, по которому строится ранжирование (пункт 22в).
 *
 * 7. ПОРЯДОК ПРЕДСТАВЛЕНИЯ — детерминированный и НЕ зависимый от
 *    результата: `"input-order"` (порядок переданного массива, ДЕФОЛТ)
 *    либо `"configuration-id"` (лексикографически по идентичности
 *    конфигурации). Результат-зависимые порядки ("by-profit-factor",
 *    "by-win-rate", "best-first") — ошибка валидации с перечислением
 *    допустимых значений: молчаливая сортировка по лучшему PF
 *    запрещена. Позиция входа (`inputOrder`) сохраняется в записи
 *    всегда, даже при `"configuration-id"`.
 *
 * 8. РАНЖИРОВАНИЕ (если явно запрошено). Критерии — из закрытого
 *    набора ключей `RankingCriterion` (все они существуют в
 *    TRAIN/VALIDATION-свидетельствах). Направление каждого критерия
 *    ЗАФИКСИРОВАНО контрактом (netPnl/winRate/PF/expectancy/avgR/
 *    medianR/trades — по убыванию; maxDrawdownPct/maxConsecutiveLosses
 *    — по возрастанию), а не выбирается «как удобнее». `null`
 *    (отсутствие свидетельства, например PF при нуле убытков)-sortируется
 *    ПОСЛЕ любого числа при любом направлении. Полный порядок
 *    обеспечивается детерминированным tie-break: сначала по OOS-слепому
 *    `selectionKey` (объявленная идентичность, пункт 22), затем по
 *    порядку объявления `inputOrder`. Тай-брейк НЕ использует полную
 *    `configurationId` (она включает отпечаток всего списка решений,
 *    включая OOS-окно) и НЕ использует `presentationOrder` (при
 *    `orderPolicy="configuration-id"` он производен от полной
 *    идентичности) — иначе OOS-изменение могло бы менять победителя.
 *    Ранжирование ≠ выбор: `select-by-rank` требует отдельной явной
 *    политики. В ранжировании участвуют только те конфигурации, у
 *    которых ОЦЕНЁН сегмент, по которому строится ранжирование;
 *    остальные перечисляются с причиной (для отказа — причина отказа
 *    именно этого сегмента).
 *
 * 9. ИДЕНТИЧНОСТЬ. `configurationId` = sha256 канонической формы
 *    {subjectFingerprint, label, paramsFingerprint, configFingerprint
 *    (P2-A), signalSource}. Включение subject привязывает конфигурацию
 *    к рынку/таймфрейму/диапазону данных, поэтому результат одного
 *    рынка нельзя выдать за результат другого. Для list-формы
 *    `signalSource.fingerprint` — отпечаток ВСЕГО списка решений, то
 *    есть включая решения OOS-окна (это часть объявленного входа и
 *    часть происхождения). Функция-провайдер несериализуема, поэтому
 *    для provider-формы ОБЯЗАТЕЛЕН явный `signalSourceId` (иначе
 *    идентичность двух разных провайдеров совпала бы) — его отсутствие
 *    есть ошибка валидации варианта. Дубликат `configurationId` внутри
 *    эксперимента: первый экземпляр оценивается, последующие —
 *    `rejected` с причиной `duplicate-configuration-id`, и все остаются
 *    в отчёте. Полная `configurationId` НЕ используется для тай-брейка
 *    выбора — см. пункт 22.
 *
 * 10. ОТПЕЧАТКИ. `inputFingerprint` = sha256 канонической формы
 *    {subject, split, orderPolicy, selectionPolicy, упорядоченный
 *    список configurationId}; `resultFingerprint` = sha256 канонической
 *    формы всех сегментных результатов; `reportFingerprint` = sha256
 *    канонического отчёта. Сериализация и sha256 ПЕРЕИСПОЛЬЗУЮТСЯ из
 *    P2-A (`canonicalJson`, `sha256Hex`, `fingerprintOf`,
 *    `fingerprintConfig`, `fingerprintBars`, `fingerprintResult`) —
 *    второй несовместимый сериализатор не создаётся.
 *
 * 11. ВОСПРОИЗВОДИМОСТЬ. Идентичные (вход эксперимента, результаты
 *    P2-A, набор конфигураций) ⇒ байт-в-байт идентичный канонический
 *    отчёт и идентичный `reportFingerprint`. Никаких `Date.now()`,
 *    `randomUUID`, hostname, pid, версий зависимостей, порядка ключей
 *    объекта и порядка обхода `Set`/`Map` в выводе.
 *
 * 12. ОТЧЁТ ПО СЕГМЕНТУ публикует (всё — из P2-A): trades, gross PnL,
 *    net PnL, win rate, profit factor + state, expectancy, average R,
 *    median R, max realized drawdown (+ % и времена пика/впадины),
 *    max MTM drawdown (+ %), consecutive losses/wins, counts по всем
 *    пяти причинам выхода (включая TIMEOUT), same-bar ambiguity, gap
 *    through, openAtEnd, комиссии и стоимость слиппеджа, decisionCounts
 *    (включая CANNOT_EVALUATE и NEUTRAL раздельно), skipped/rejected по
 *    кодам причин, характеристики окна и сетки, отпечаток результата.
 *
 * 13. ЧЕСТНОСТЬ ПУСТЫХ И ГРАНИЧНЫХ СОСТОЯНИЙ. Ноль сделок в сегменте —
 *    валидный исход: отношения остаются `null` (как в P2-A), PF = null
 *    с состоянием `no-trades`/`no-losses`, Infinity не появляется.
 *    Отклонённый вариант даёт `metrics: null` в блоках свидетельств —
 *    но сам блок сохраняется. Нулевые значения не подменяются нулями
 *    «для красоты».
 *
 * 14. ВНЕ ОБЪЁМА P2-C (осознанно, без заглушек): Sharpe/Sortino и
 *    прочие метрики, которых нет в P2-A (их нельзя «досчитать» другим
 *    алгоритмом — это нарушило бы пункт 1); walk-forward и Monte-Carlo;
 *    генерация/перебор параметров; подключение к PostgreSQL/Prisma и
 *    сохранение прогонов (это P2-B и отдельный integration layer);
 *    runner/workers/UI; Kill Zones, AMD, HTF-контекст, AI-суждения,
 *    on-chain, funding/OI; любые изменения SMC-скоринга, outsideRange,
 *    eligibility и Smart Money-агрегации; любые изменения семантики
 *    исполнения P2-A.
 *
 * 15. ИНТЕГРАЦИЯ С P2-B/P2AB (C1–C2). P2-B — ТОЛЬКО data plane: он
 *     поставляет исторические бары и НЕ поставляет решения/сигналы. Все
 *     стадии отказа P2-A (`config`/`adapter`/`signals`/`bars`/`provider`/
 *     `arithmetic`) отображаются на собственные стадии P2-C явно и
 *     исчерпывающе (`Record<BacktestFailureStage, …>`): молчаливого
 *     сведения к `provider-failure` нет, ошибки P2-A переносятся без
 *     потерь.
 *
 * 16. СВЕРКА ЭКВИТИ (C0). `finalEquity` обязан ТОЧНО совпадать с
 *     последней точкой `equityCurve` и сходиться с
 *     `initialEquity + totalNetPnl` с допуском на накопление плавающей
 *     точки `1e-9 * max(1, |initialEquity|)`. Точное равенство второго
 *     вида НЕ требуется: hardened P2-A накапливает числа в порядке
 *     сделок. Значимая бухгалтерская ошибка отвергается (негативный
 *     контроль), допуск её не скрывает.
 *
 * 17. НЕФИНИТНЫЕ СВИДЕТЕЛЬСТВА (C3). NaN/±Infinity не попадают в
 *     ранжирование: свидетельство исключается детерминированно с
 *     причиной `non-finite-evidence`; нефинитный вариант не может стать
 *     rank 0. Отказ P2-A стадии `arithmetic` и эта проверка — разные
 *     уровни защиты.
 *
 * 18. ГЛУБОКАЯ НЕИЗМЕНЯЕМОСТЬ (C4). Публичные выходы P2-C
 *     (VariantRecord, SegmentReport, EvidenceMetrics, EvidenceBlocks,
 *     ComparisonRow/View, RankingRecord и вложенные структуры)
 *     замораживаются рекурсивно (переиспользуется P2-A `deepFreeze`);
 *     попытка мутации не меняет ни отчёт, ни отпечатки.
 *
 * 19. МЕТРИКИ (C5). Проекция — дословная, включая hardened-метрики
 *     `maxAdverseExcursionDrawdown(+Pct)` и диагностические
 *     `avgRActualFill`/`medianRActualFill`. `avgR`/`medianR` — по
 *     ПЛАНОВОМУ риску; `*ActualFill` — диагностика по фактическому
 *     знаменателю входа и НЕ критерий ранжирования (пункт 8).
 *
 * 20. ГРАНИЦЫ ЧЕСТНОСТИ (C6). В записи и отчёте публикуется непустой
 *     `limitations` (EXPERIMENT_LIMITATIONS): OOS структурно исключён из
 *     входов выбора; SignalContext не содержит метки сегмента; это НЕ
 *     доказательство невозможности использовать замыкание/глобальное
 *     будущее; assertDecisionInvariance — контрфактическая диагностика;
 *     структурная гарантия — только по каналу контекста. Отчёт не
 *     является заявлением о доходности.
 *
 * 21. ОТПЕЧАТОК ПОДАННОГО РЕЗУЛЬТАТА (C7). `SegmentReport` — ДЕТЕРМИНИРОВАННАЯ
 *     проекция `BacktestResult` (пункт 1), поэтому принятый извне результат
 *     проверяется ДВУМЯ сверками: `report.resultFingerprint ===
 *     fingerprintResult(result)` И поэлементным равенством отчёта
 *     пересчитанной проекции `projectSegmentReport(result, segment, window)`.
 *     Подмена метрик сохранённого отчёта при подлинном отпечатке
 *     отвергается. Изменение только OOS-результата меняет
 *     общий/отчётный отпечаток, но НЕ меняет выбор/ранжирование по
 *     TRAIN/VALIDATION.
 *
 * 22. ПОЛНАЯ ИДЕНТИЧНОСТЬ ≠ ВЫБОРНАЯ ИДЕНТИЧНОСТЬ (C7, hardening #1).
 *     (а) ПОЛНАЯ идентичность `configurationId` — отпечаток всего
 *     объявленного входа: subjectFingerprint, label, paramsFingerprint,
 *     configFingerprint и `signalSource`; для list-формы сюда входит
 *     отпечаток ВСЕГО списка решений, включая решения OOS-окна. Она
 *     нужна для происхождения, дедупликации и отпечатков записи/отчёта и
 *     МЕНЯЕТСЯ при изменении только OOS-решений — это ожидаемо.
 *     (б) ВЫБОРНЫЙ ключ `selectionKey` (SELECTION_KEY_SCOPE,
 *     SELECTION_KEY_INPUTS) строится ТОЛЬКО из объявленной идентичности,
 *     известной до OOS: subjectFingerprint, label, paramsFingerprint,
 *     configFingerprint, `signalSource.kind` и (только для
 *     provider-формы) `signalSource.signalSourceId`. Содержимое списка
 *     решений в выборный ключ НЕ входит: оно включает OOS-окно и потому
 *     для выбора непригодно. Выборный ключ OOS-слеп по построению:
 *     решения/результаты/метрики/отчёт/отпечаток/статус/ошибки OOS не
 *     являются его входами, поэтому при изменении только OOS выборный
 *     ключ НЕ меняется.
 *     (в) СТАТУС УЧАСТИЯ в ранжировании берётся из сегмента, по которому
 *     строится ранжирование (TRAIN или VALIDATION), а не из сводного
 *     статуса варианта: отказ OOS-сегмента не исключает конфигурацию из
 *     TRAIN/VALIDATION-ранжирования и не может сменить победителя.
 *     (г) ЧТО МЕНЯЕТСЯ при изменении только OOS: полная идентичность и
 *     отпечатки (записи/результата/отчёта) — да, когда изменение входит
 *     в объявленный вход (OOS-решения) или в OOS-результат; порядок и
 *     состав ранжирования, победитель и `rationale` выбора — нет.
 *     (д) Коллизия `selectionKey` (одинаковая объявленная идентичность
 *     при разных списках решений) разрешается `inputOrder` — порядком
 *     объявления; он также не зависит от результатов.
 *     (е) СВОДНЫЙ статус варианта (`VariantRecord.status`) — это сводка
 *     ПРОИСХОЖДЕНИЯ по всем трём сегментам: отказ любого сегмента честно
 *     переводит вариант в `rejected` и остаётся видимым в `rejection`,
 *     `segments.*.status/errors` и в отчёте. Сводный статус НЕ является
 *     критерием выбора.
 *     (ж) ДОПУСТИМОСТЬ выбора (hardening #2) проверяется по СЕГМЕНТУ
 *     СТАДИИ ВЫБОРА (TRAIN или VALIDATION): победитель обязан
 *     присутствовать в записи, совпадать с победителем собственного
 *     ранжирования и иметь `segments[stage].status === "ok"`. OOS в этой
 *     проверке не участвует; другой сегмент (VALIDATION или OOS) не может
 *     задним числом сделать выбор недействительным.
 *     (з) OOS-отказ у победителя TRAIN/VALIDATION-ранжирования может
 *     оставить СВОДНЫЙ статус варианта `rejected` (происхождение честно
 *     видно), но НЕ отменяет выбор, сделанный без чтения OOS, и не
 *     приводит к отказу записи уровня `stage="invariant"`.
 *     (и) `label` — объявленный НЕ финансовый вход выборного ключа: при
 *     точном равенстве критериев порядок задаёт лексикографика ключа,
 *     поэтому смена одной метки может детерминированно изменить
 *     победителя; финансовая интерпретация метки контрактом не
 *     подразумевается. `inputOrder` — документированный финальный
 *     fallback при коллизии выборных ключей. Нефинитное свидетельство
 *     (включая диагностическое, не являющееся критерием ранжирования)
 *     консервативно исключает вариант из ранжирования (fail-closed), а не
 *     сравнивается молча.
 * ══════════════════════════════════════════════════════════════════
 */

import {
  type BacktestBar,
  type BacktestConfig,
  type BacktestResult,
  type ChronologicalSplit,
  type ChronologicalSplitConfig,
  type DecisionCounts,
  type ExitReason,
  type RejectReason,
  type ResolvedBacktestConfig,
  type SegmentWindow,
  type SignalDecisionList,
  type SignalProvider,
  type SkipReason,
  type SplitName
} from "../backtest/contract";

/** Версия контракта P2-C: меняется при любом изменении семантики. */
export const EXPERIMENT_CONTRACT_VERSION = "p2c-1.2.0";

/** Имя слоя в метаданных (детерминированная константа). */
export const EXPERIMENT_LAYER_NAME = "suslik-experiment";

/** Маркер того, что метрики сегмента взяты из P2-A без пересчёта. */
export const METRICS_PROVENANCE = "p2a-metrics-verbatim";

/**
 * Границы честности эксперимента (C6). Непустой список публикуется в
 * записи эксперимента и в отчёте; формулировки фиксированы контрактом,
 * чтобы отчётность нельзя было пересказать сильнее, чем она есть.
 *
 * Массив ЗАМОРОЖЕН (`Object.freeze`): это каноническое значение, и
 * внешняя мутация (push/splice/присваивание по индексу) невозможна —
 * инвариант непустых ограничений нельзя ослабить извне. `validate.ts`
 * дополнительно сверяет опубликованные ограничения с собственной
 * неизменяемой копией формулировок, а не только с «непустотой».
 */
export const EXPERIMENT_LIMITATIONS: readonly string[] = Object.freeze([
  "OOS структурно исключён из входов выбора и ранжирования: тип SelectionStage не содержит \"OOS\", а блоки свидетельств разделены (trainSelection / validationConfirmation / oosFinal).",
  "SignalContext не содержит метки сегмента (TRAIN/VALIDATION/OOS): торговое решение не знает стадии, на которой его прогоняют.",
  "Это НЕ доказательство того, что произвольный JS стратегии не может использовать замыкание/глобальную информацию о будущем: структурная гарантия — только по каналу контекста.",
  "assertDecisionInvariance — контрфактическая диагностика, а не абсолютное доказательство отсутствия lookahead.",
  "Структурная гарантия изоляции — только по каналу контекста (SignalContext); иные каналы (замыкания, глобальные объекты) ею не покрываются.",
  "Отчёт P2-C не является заявлением о доходности: из него не следуют выводы о прибыльности.",
  "Историческая реконструкция eligibility (rank/quoteVolume) невозможна; текущие значения не подставляются вместо исторических."
]);

/**
 * Область отпечатка ВЫБОРНОГО ключа. Отдельная от
 * `experiment-configuration`: полная идентичность и выборный ключ —
 * разные сущности (см. пункт 22 политики контракта).
 */
export const SELECTION_KEY_SCOPE = "experiment-selection-key-oos-blind-v1";

/**
 * ИСЧЕРПЫВАЮЩИЙ список входов выборного ключа (OOS-слепой по
 * построению). Ни одно поле, производное от OOS-решений, OOS-результатов,
 * OOS-метрик, OOS-отчёта/отпечатка, OOS-статуса или OOS-ошибок, в ключ не
 * входит. Проверяется тестом «выборный ключ неизменен при OOS-мутации».
 */
export const SELECTION_KEY_INPUTS: readonly string[] = Object.freeze([
  "subjectFingerprint",
  "label",
  "paramsFingerprint",
  "configFingerprint",
  "signalSource.kind",
  "signalSource.signalSourceId"
]);

/**
 * Механика полного порядка при полном равенстве критериев
 * ранжирования (машиночитаемое объявление контракта тай-брейка).
 *
 * Ключ — `selectionKey` (см. SELECTION_KEY_INPUTS): объявленная
 * идентичность конфигурации, известная ДО OOS. Коллизия ключа
 * разрешается порядком объявления (`inputOrder`) — он также не зависит
 * от результатов. `presentationOrder` здесь намеренно НЕ используется:
 * при `orderPolicy=\"configuration-id\"` он сам производен от полной
 * `configurationId`, то есть от OOS-отпечатка списка решений.
 */
export interface SelectionTieBreakContract {
  readonly key: "selection-key";
  readonly keyInputs: readonly string[];
  readonly fallback: "input-order";
  readonly oosBlind: true;
}

export const SELECTION_TIE_BREAK: SelectionTieBreakContract = Object.freeze({
  key: "selection-key",
  keyInputs: SELECTION_KEY_INPUTS,
  fallback: "input-order",
  oosBlind: true
});

/* ------------------------------------------------------------------ */
/* Идентичность субъекта эксперимента                                   */
/* ------------------------------------------------------------------ */

export interface StrategyIdentity {
  readonly slug: string;
  readonly version: string;
}

export interface MarketIdentity {
  /** Инструмент/актив (например, "BTCUSDT"). */
  readonly asset: string;
  /** Биржа или null, если эксперимент бирженезависимый. */
  readonly exchange: string | null;
  /** Человекочитаемый таймфрейм (например, "1h"). */
  readonly timeframe: string;
  /**
   * Заявленный шаг сетки в мс. Если задан, P2-C сверяет его с
   * `metadata.timeframeMs` каждого сегментного результата: несовпадение
   * = подмена таймфрейма.
   */
  readonly timeframeMs: number | null;
}

export interface DataRange {
  readonly barsCount: number;
  readonly firstBarTime: number | null;
  readonly lastBarTime: number | null;
  /** sha256 канонической формы баров (P2-A `fingerprintBars`). */
  readonly barsFingerprint: string;
}

export interface ExperimentSubject {
  readonly strategy: StrategyIdentity;
  readonly market: MarketIdentity;
  readonly dataRange: DataRange;
}

/** То, что declares вызывающий код; `dataRange` вычисляется из баров. */
export interface ExperimentSubjectInput {
  readonly strategy: StrategyIdentity;
  readonly market: MarketIdentity;
}

/* ------------------------------------------------------------------ */
/* Конфигурация (вариант)                                               */
/* ------------------------------------------------------------------ */

/**
 * Описание источника решений. Функция несериализуема, поэтому для
 * provider-формы идентичность задаётся ЯВНЫМ `signalSourceId`.
 */
export type SignalSourceDescriptor =
  | {
      readonly kind: "list";
      readonly length: number;
      readonly fingerprint: string;
    }
  | {
      readonly kind: "provider";
      readonly signalSourceId: string;
    };

export interface VariantDefinition {
  /** Человекочитаемое имя конфигурации (входит в идентичность). */
  readonly label: string;
  /**
   * Параметры стратегии как ДАННЫЕ (входят в идентичность). P2-C их не
   * интерпретирует и не подбирает.
   */
  readonly params?: Readonly<Record<string, unknown>> | null;
  /** Конфигурация исполнения P2-A. */
  readonly config: BacktestConfig;
  /** Источник решений: провайдер (функция) либо список по индексам баров. */
  readonly signals: SignalProvider | SignalDecisionList;
  /** ОБЯЗАТЕЛЕН, если `signals` — функция (см. пункт 9 политики). */
  readonly signalSourceId?: string;
}

/** Вариант после разрешения: идентичность вычислена, конфиг полный. */
export interface ResolvedVariant {
  readonly inputOrder: number;
  readonly label: string;
  readonly params: Readonly<Record<string, unknown>>;
  readonly config: ResolvedBacktestConfig;
  readonly configFingerprint: string;
  readonly paramsFingerprint: string;
  readonly signalSource: SignalSourceDescriptor;
  /** Полная идентичность (включая OOS-часть объявленного входа). */
  readonly configurationId: string;
  /**
   * OOS-слепой выборный ключ (пункт 22): только объявленная
   * идентичность, известная до OOS. Используется как tie-break.
   */
  readonly selectionKey: string;
}

/* ------------------------------------------------------------------ */
/* Порядок представления и выбор конфигурации                           */
/* ------------------------------------------------------------------ */

/**
 * Допустимые порядки представления. Оба детерминированы и НЕ зависят
 * от результата (пункт 7 политики).
 */
export type PresentationOrderPolicy = "input-order" | "configuration-id";

export const PRESENTATION_ORDER_POLICIES: readonly PresentationOrderPolicy[] = [
  "input-order",
  "configuration-id"
];

/**
 * Стадии, по которым разрешено ранжировать и выбирать. "OOS" здесь
 * НЕТ намеренно (пункт 5 политики): OOS — финальное свидетельство, а
 * не критерий отбора.
 */
export type SelectionStage = "TRAIN" | "VALIDATION";

export const SELECTION_STAGES: readonly SelectionStage[] = [
  "TRAIN",
  "VALIDATION"
];

/**
 * Ключи `EvidenceMetrics` со значением `number | null` — вычисляются
 * компилятором, поэтому критерий ранжирования НЕ МОЖЕТ разойтись с
 * фактическим полем свидетельств (переименование метрики ломает сборку,
 * а не молча меняет смысл сравнения). Объявление `EvidenceMetrics` ниже
 * по файлу — для типов это не существенно (hoisting), но порядок чтения
 * учтён в комментарии к секции отчётов.
 */
type EvidenceNumericKey = {
  readonly [K in keyof EvidenceMetrics]: EvidenceMetrics[K] extends
    | number
    | null
    ? K
    : never;
}[keyof EvidenceMetrics];

/**
 * Закрытый набор критериев ранжирования: пересечение разрешённых имён с
 * числовыми ключами TRAIN/VALIDATION-свидетельств.
 */
export type RankingCriterion = Extract<
  EvidenceNumericKey,
  | "trades"
  | "netPnl"
  | "winRate"
  | "profitFactor"
  | "expectancy"
  | "avgR"
  | "medianR"
  | "maxRealizedDrawdownPct"
  | "maxConsecutiveLosses"
>;

export const RANKING_CRITERIA: readonly RankingCriterion[] = [
  "trades",
  "netPnl",
  "winRate",
  "profitFactor",
  "expectancy",
  "avgR",
  "medianR",
  "maxRealizedDrawdownPct",
  "maxConsecutiveLosses"
];

/**
 * Направление каждого критерия ЗАФИКСИРОВАНО контрактом, а не
 * выбирается в момент сравнения (иначе «удобное» направление стало бы
 * способом подгонки статистики).
 */
export const RANKING_CRITERION_DIRECTION: Readonly<
  Record<RankingCriterion, "desc" | "asc">
> = {
  trades: "desc",
  netPnl: "desc",
  winRate: "desc",
  profitFactor: "desc",
  expectancy: "desc",
  avgR: "desc",
  medianR: "desc",
  maxRealizedDrawdownPct: "asc",
  maxConsecutiveLosses: "asc"
};

export type SelectionPolicy =
  | { readonly kind: "none" }
  | {
      readonly kind: "rank-only";
      readonly stage: SelectionStage;
      readonly criteria: readonly RankingCriterion[];
    }
  | {
      readonly kind: "select-by-rank";
      readonly stage: SelectionStage;
      readonly criteria: readonly RankingCriterion[];
    };

/** ДЕФОЛТ: ничего не выбирается и не ранжируется (пункт 2 политики). */
export const DEFAULT_SELECTION_POLICY: SelectionPolicy = { kind: "none" };

/* ------------------------------------------------------------------ */
/* Отчёт по сегменту (проекция метрик P2-A)                             */
/* ------------------------------------------------------------------ */

export interface SegmentReport {
  readonly provenance: typeof METRICS_PROVENANCE;
  readonly segment: SplitName;
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly barsCount: number;
  readonly firstBarTime: number | null;
  readonly lastBarTime: number | null;
  readonly timeframeMs: number | null;
  readonly gridGaps: number;
  /* --- сделки --- */
  readonly trades: number;
  readonly longTrades: number;
  readonly shortTrades: number;
  readonly wins: number;
  readonly losses: number;
  readonly breakeven: number;
  readonly winRate: number | null;
  /* --- деньги --- */
  readonly grossPnl: number;
  readonly netPnl: number;
  readonly netWinTotal: number;
  readonly netLossTotal: number;
  readonly grossWinTotal: number;
  readonly grossLossTotal: number;
  readonly fees: number;
  readonly slippageCost: number;
  readonly finalEquity: number;
  /* --- отношения --- */
  readonly profitFactor: number | null;
  readonly profitFactorState: "ok" | "no-losses" | "no-trades";
  readonly expectancy: number | null;
  readonly avgR: number | null;
  readonly medianR: number | null;
  readonly avgGrossR: number | null;
  readonly medianGrossR: number | null;
  /** ДИАГНОСТИКА (P2-A): средний R по ФАКТИЧЕСКОМУ знаменателю входа. */
  readonly avgRActualFill: number | null;
  /** ДИАГНОСТИКА (P2-A): медиана R по фактическому знаменателю входа. */
  readonly medianRActualFill: number | null;
  readonly avgWin: number | null;
  readonly avgLoss: number | null;
  readonly largestWin: number | null;
  readonly largestLoss: number | null;
  /* --- просадка: две базы P2-A --- */
  readonly maxRealizedDrawdown: number;
  readonly maxRealizedDrawdownPct: number | null;
  readonly realizedDrawdownPeakTime: number | null;
  readonly realizedDrawdownTroughTime: number | null;
  readonly maxMtmDrawdown: number;
  readonly maxMtmDrawdownPct: number | null;
  /** MAE-просадка P2-A — наиболее консервативная база. */
  readonly maxAdverseExcursionDrawdown: number;
  readonly maxAdverseExcursionDrawdownPct: number | null;
  readonly equityNonPositive: boolean;
  /* --- серии и удержание --- */
  readonly maxConsecutiveWins: number;
  readonly maxConsecutiveLosses: number;
  readonly avgBarsHeld: number | null;
  readonly maxBarsHeld: number;
  /* --- причины выхода и неоднозначности --- */
  readonly exitReasonCounts: Readonly<Record<ExitReason, number>>;
  readonly timeoutExits: number;
  readonly sameBarAmbiguityTrades: number;
  readonly gapThroughTrades: number;
  readonly openAtEndTrades: number;
  /* --- решения: cannot-evaluate ≠ NEUTRAL --- */
  readonly signalsEvaluated: number;
  readonly decisionCounts: DecisionCounts;
  readonly cannotEvaluate: number;
  readonly neutral: number;
  readonly noSignal: number;
  readonly skippedByReason: Readonly<Record<SkipReason, number>>;
  readonly rejectedByReason: Readonly<Record<RejectReason, number>>;
  /** sha256 канонической формы P2-A результата сегмента. */
  readonly resultFingerprint: string;
}

/**
 * Подмножество метрик, по которому допускается сравнивать конфигурации.
 *
 * Проекция ДОСЛОВНАЯ (C5): значения копируются из `BacktestMetrics` без
 * пересчёта. `avgR`/`medianR` P2-A считает по ПЛАНОВОМУ риску входа;
 * `avgRActualFill`/`medianRActualFill` — ДИАГНОСТИКА по фактическому
 * знаменателю входа и в закрытый набор критериев ранжирования НЕ входят.
 * `maxAdverseExcursionDrawdown(+Pct)` — hardened-метрика P2-A
 * (наиболее консервативная база просадки).
 */
export interface EvidenceMetrics {
  readonly trades: number;
  readonly grossPnl: number;
  readonly netPnl: number;
  readonly winRate: number | null;
  readonly profitFactor: number | null;
  readonly profitFactorState: "ok" | "no-losses" | "no-trades";
  readonly expectancy: number | null;
  readonly avgR: number | null;
  readonly medianR: number | null;
  /** ДИАГНОСТИКА (P2-A): средний R по фактическому знаменателю входа. */
  readonly avgRActualFill: number | null;
  /** ДИАГНОСТИКА (P2-A): медиана R по фактическому знаменателю входа. */
  readonly medianRActualFill: number | null;
  readonly maxRealizedDrawdown: number;
  readonly maxRealizedDrawdownPct: number | null;
  readonly maxMtmDrawdown: number;
  /** MAE-просадка P2-A (консервативная база). */
  readonly maxAdverseExcursionDrawdown: number;
  readonly maxAdverseExcursionDrawdownPct: number | null;
  readonly maxConsecutiveLosses: number;
}

/* ------------------------------------------------------------------ */
/* Записи эксперимента                                                  */
/* ------------------------------------------------------------------ */

export type VariantStatus = "evaluated" | "rejected";

export type VariantRejectionStage =
  | "variant"
  | "split"
  | "config"
  | "adapter"
  | "signals"
  | "bars"
  | "provider"
  | "arithmetic"
  | "leakage"
  | "segment";

export interface VariantRejection {
  readonly stage: VariantRejectionStage;
  /** Детерминированный код причины (не свободный текст). */
  readonly reason:
    | "invalid-variant"
    | "missing-signal-source-id"
    | "duplicate-configuration-id"
    | "invalid-config"
    | "adapter-failure"
    | "signals-failure"
    | "invalid-bars"
    | "provider-failure"
    | "arithmetic-failure"
    | "segment-failure"
    | "leakage-detected"
    | "identity-mismatch";
  readonly segment: SplitName | null;
  readonly errors: readonly string[];
}

export interface SegmentRecord {
  readonly segment: SplitName;
  readonly window: SegmentWindow;
  readonly status: "ok" | "failed";
  readonly errors: readonly string[];
  /**
   * СЕГМЕНТ-ЛОКАЛЬНЫЙ код причины отказа (null при status="ok").
   * Именно он — а не первая причина по варианту — определяет причину
   * исключения из ранжирования по этому сегменту (пункт 22в), поэтому
   * отказ OOS-сегмента не может выдать себя за отказ TRAIN.
   */
  readonly rejectionReason: VariantRejection["reason"] | null;
  readonly leakageOk: boolean;
  readonly leakageErrors: readonly string[];
  /** P2-A результат КАК ЕСТЬ (source of truth); null при отказе. */
  readonly result: BacktestResult | null;
  /** Проекция метрик P2-A; null при отказе. */
  readonly report: SegmentReport | null;
}

export interface VariantSegments {
  readonly TRAIN: SegmentRecord;
  readonly VALIDATION: SegmentRecord;
  readonly OOS: SegmentRecord;
}

export interface VariantRecord {
  /** Полная идентичность (происхождение, дедупликация, отпечатки). */
  readonly configurationId: string;
  /** OOS-слепой выборный ключ (пункт 22б) — вход тай-брейка. */
  readonly selectionKey: string;
  readonly label: string;
  readonly inputOrder: number;
  readonly presentationOrder: number;
  readonly status: VariantStatus;
  readonly rejection: VariantRejection | null;
  readonly params: Readonly<Record<string, unknown>>;
  readonly paramsFingerprint: string;
  readonly configFingerprint: string;
  readonly signalSource: SignalSourceDescriptor | null;
  readonly segments: VariantSegments | null;
}

export interface EvidenceEntry {
  readonly configurationId: string;
  /** OOS-слепой выборный ключ (пункт 22б). */
  readonly selectionKey: string;
  readonly label: string;
  readonly inputOrder: number;
  readonly presentationOrder: number;
  /**
   * Статус УЧАСТИЯ в блоке: определяется сегментом САМОГО блока
   * (пункт 22в), а не сводным статусом варианта. Поэтому отказ
   * OOS-сегмента не превращает TRAIN-свидетельство в «rejected».
   */
  readonly status: VariantStatus;
  /** Причина отказа сегмента этого блока (null, если сегмент оценён). */
  readonly rejectionReason: VariantRejection["reason"] | null;
  readonly metrics: EvidenceMetrics | null;
}

export interface EvidenceBlocks {
  /** Блок selection evidence: только TRAIN. */
  readonly trainSelection: readonly EvidenceEntry[];
  /** Блок confirmation evidence: только VALIDATION. */
  readonly validationConfirmation: readonly EvidenceEntry[];
  /** Блок final evidence: только OOS, в выборе НЕ участвует. */
  readonly oosFinal: readonly EvidenceEntry[];
}

export interface RankingEntry {
  readonly rank: number;
  /** Полная идентичность (происхождение). */
  readonly configurationId: string;
  /** OOS-слепой ключ, которым определён порядок при равенстве критериев. */
  readonly selectionKey: string;
  readonly label: string;
  /**
   * Значения ЗАПРОШЕННЫХ критериев, по которым строился порядок
   * (для проверяемости: порядок можно пересчитать из этих чисел).
   */
  readonly values: Readonly<Partial<Record<RankingCriterion, number | null>>>;
  /**
   * True, если порядок в этой позиции определил тай-брейк
   * (`selectionKey`, а при его коллизии — `inputOrder`), а не значения
   * критериев. Никогда не означает «порядок по полной configurationId».
   */
  readonly tieBreakApplied: boolean;
}

/** Причина исключения из ранжирования: отказ варианта либо нефинитное свидетельство. */
export type RankingExclusionReason =
  | VariantRejection["reason"]
  | "non-finite-evidence";

export interface RankingRecord {
  readonly stage: SelectionStage;
  readonly criteria: readonly RankingCriterion[];
  /** Констатно false: OOS не читался (пункт 5 политики). */
  readonly oosConsulted: false;
  /** Машиночитаемая механика тай-брейка (пункт 8/22). */
  readonly tieBreak: SelectionTieBreakContract;
  readonly order: readonly RankingEntry[];
  readonly excludedFromRanking: readonly {
    readonly configurationId: string;
    readonly reason: RankingExclusionReason;
  }[];
}

export interface SelectionRecord {
  readonly policy: SelectionPolicy;
  readonly performed: boolean;
  /** Полная идентичность победителя (происхождение). */
  readonly selectedConfigurationId: string | null;
  /** OOS-слепой ключ победителя (предмет выбора). */
  readonly selectedSelectionKey: string | null;
  readonly selectedLabel: string | null;
  readonly rationale: string;
  readonly oosConsulted: false;
  readonly ranking: RankingRecord | null;
}

export interface ExperimentCounts {
  readonly declared: number;
  readonly evaluated: number;
  readonly rejected: number;
}

export interface OosIsolationRecord {
  readonly oosConsultedForSelection: false;
  readonly oosConsultedForRanking: false;
  /** Как именно обеспечена изоляция (константа контракта, не свободный текст). */
  readonly mechanism:
    | "structural-evidence-type+policy-stage-whitelist+recomputed-ranking"
    | "structural-evidence-type+policy-stage-whitelist";
  /** Независимая перепроверка записанного порядка ранжирования. */
  readonly rankingIndependenceVerified: boolean;
}

/** Строка сравнения: ОДИН вариант = ОДНА строка (проигравшие не удаляются). */
export interface ComparisonRow {
  readonly presentationOrder: number;
  readonly inputOrder: number;
  readonly configurationId: string;
  /** OOS-слепой выборный ключ (пункт 22б) — виден в отчёте сравнения. */
  readonly selectionKey: string;
  readonly label: string;
  readonly status: VariantStatus;
  readonly rejectionReason: VariantRejection["reason"] | null;
  readonly rejectionStage: VariantRejectionStage | null;
  readonly rejectionErrors: readonly string[];
  readonly train: SegmentReport | null;
  readonly validation: SegmentReport | null;
  readonly oos: SegmentReport | null;
}

/**
 * Отчёт сравнения: полное представление эксперимента плюс три
 * разделённых блока свидетельств и отпечаток канонической формы.
 */
export interface ComparisonView {
  readonly contractVersion: string;
  readonly layer: string;
  readonly subject: ExperimentSubject;
  readonly subjectFingerprint: string;
  readonly split: ChronologicalSplit;
  readonly orderPolicy: PresentationOrderPolicy;
  readonly inputFingerprint: string;
  readonly resultFingerprint: string;
  readonly counts: ExperimentCounts;
  readonly rows: readonly ComparisonRow[];
  /** Selection evidence — только TRAIN. */
  readonly trainSelectionEvidence: readonly EvidenceEntry[];
  /** Confirmation evidence — только VALIDATION. */
  readonly validationConfirmationEvidence: readonly EvidenceEntry[];
  /** Final evidence — только OOS; в выборе не участвует. */
  readonly oosFinalEvidence: readonly EvidenceEntry[];
  readonly selection: SelectionRecord;
  readonly oosIsolation: OosIsolationRecord;
  /** Непустые границы честности (C6), публикуются в отчёте. */
  readonly limitations: readonly string[];
  /** sha256 канонической формы отчёта. */
  readonly reportFingerprint: string;
  /** Сама каноническая форма (байт-в-байт воспроизводима). */
  readonly canonicalReport: string;
}

export interface ExperimentRecord {
  readonly contractVersion: string;
  readonly layer: string;
  readonly subject: ExperimentSubject;
  readonly subjectFingerprint: string;
  readonly split: ChronologicalSplit;
  readonly orderPolicy: PresentationOrderPolicy;
  readonly inputFingerprint: string;
  readonly resultFingerprint: string;
  readonly counts: ExperimentCounts;
  /** ВСЕ объявленные варианты, в порядке представления. */
  readonly variants: readonly VariantRecord[];
  readonly evidence: EvidenceBlocks;
  readonly selection: SelectionRecord;
  readonly oosIsolation: OosIsolationRecord;
  /** Непустые границы честности (C6); входят в канонический отчёт. */
  readonly limitations: readonly string[];
}

/**
 * Стадии отказа УРОВНЯ ЭКСПЕРИМЕНТА (не уровня конфигурации):
 *  - policy   — недопустимая политика порядка/выбора (например, stage=OOS);
 *  - bars     — данные непригодны (P2-A валидация структуры/сетки);
 *  - variants — не объявлено ни одной конфигурации;
 *  - subject  — заявленная идентичность невалидна;
 *  - split    — P2-A разбиение невозможно или нехронологично;
 *  - invariant— нарушен собственный инвариант записи (cherry-picking или
 *               зависимость выбора от OOS). Такой отказ означает дефект
 *               слоя, а не данных: он не должен возникать никогда.
 * Отказ отдельной конфигурации НЕ является отказом эксперимента: она
 * остаётся в отчёте со статусом `rejected` и причиной.
 */
export type ExperimentFailureStage =
  | "policy"
  | "bars"
  | "variants"
  | "subject"
  | "split"
  | "invariant";

export type ExperimentOutcome =
  | { readonly ok: true; readonly record: ExperimentRecord }
  | {
      readonly ok: false;
      readonly stage: ExperimentFailureStage;
      readonly errors: readonly string[];
    };

/**
 * Вход эксперимента. Бары — ровно тот же тип, что и в P2-A
 * (`BacktestBar`): второй тип данных не создаётся.
 */
export interface ExperimentInput {
  readonly bars: readonly BacktestBar[];
  readonly subject: ExperimentSubjectInput;
  readonly variants: readonly VariantDefinition[];
  readonly splitConfig?: Partial<ChronologicalSplitConfig>;
  readonly orderPolicy?: PresentationOrderPolicy;
  readonly selectionPolicy?: SelectionPolicy;
}
