/**
 * P2-C — порядок представления, ранжирование и выбор конфигурации.
 *
 * Три свойства, которые здесь обеспечены:
 *  1) порядок представления НЕ зависит от результата (только порядок
 *     входа или лексикографика configurationId);
 *  2) ранжирование возможно ТОЛЬКО по TRAIN/VALIDATION — тип
 *     `SelectionStage` не содержит "OOS", а функция ранжирования
 *     принимает только блок свидетельств своей стадии, поэтому OOS
 *     физически не попадает в сравнение;
 *  3) записанный порядок ПРОВЕРЯЕМ: `assertRankingIndependentOfOos`
 *     пересчитывает его из сохранённых свидетельств той же стадии и
 *     сверяет — порядок, полученный с оглядкой на OOS, не
 *     воспроизведётся и будет отвергнут.
 *
 * P2-C не генерирует конфигурации и не ищет максимум: ранжирование
 * выполняется только если вызывающий код явно его запросил, и только по
 * явно перечисленным критериям с зафиксированным направлением.
 */

import { deepFreeze } from "../backtest/immutable";
import { canonicalJson } from "../backtest/serialize";
import {
  RANKING_CRITERIA,
  RANKING_CRITERION_DIRECTION,
  SELECTION_STAGES,
  SELECTION_TIE_BREAK,
  type EvidenceEntry,
  type EvidenceMetrics,
  type RankingCriterion,
  type RankingEntry,
  type RankingExclusionReason,
  type RankingRecord,
  type SelectionPolicy,
  type SelectionRecord,
  type SelectionStage,
  type VariantRecord,
  type VariantRejection
} from "./contract";

/** Проверка политики выбора/порядка. */
export function validateSelectionPolicy(
  policy: SelectionPolicy
): readonly string[] {
  const errors: string[] = [];

  if (policy === null || typeof policy !== "object") {
    return ["selectionPolicy: ожидается объект"];
  }

  if (policy.kind === "none") {
    return errors;
  }

  if (policy.kind !== "rank-only" && policy.kind !== "select-by-rank") {
    errors.push('selectionPolicy.kind: "none" | "rank-only" | "select-by-rank"');

    return errors;
  }

  const stage: string = policy.stage;

  if (stage === "OOS") {
    errors.push(
      "selectionPolicy.stage=OOS запрещён: OOS — финальное свидетельство и не может участвовать в выборе конфигурации"
    );
  } else if (!SELECTION_STAGES.includes(stage as SelectionStage)) {
    errors.push(
      `selectionPolicy.stage: ${SELECTION_STAGES.join(" | ")} (OOS исключён намеренно)`
    );
  }

  if (!Array.isArray(policy.criteria) || policy.criteria.length === 0) {
    errors.push("selectionPolicy.criteria: непустой массив критериев");

    return errors;
  }

  const seen = new Set<string>();

  for (const criterion of policy.criteria) {
    if (!RANKING_CRITERIA.includes(criterion)) {
      errors.push(
        `selectionPolicy.criteria: неизвестный критерий ${String(criterion)} (допустимы ${RANKING_CRITERIA.join(", ")})`
      );
    }

    if (seen.has(String(criterion))) {
      errors.push(
        `selectionPolicy.criteria: дубликат критерия ${String(criterion)}`
      );
    }

    seen.add(String(criterion));
  }

  return errors;
}

/** Проверка политики порядка представления. */
export function validateOrderPolicy(policy: string): readonly string[] {
  if (policy === "input-order" || policy === "configuration-id") {
    return [];
  }

  return [
    `orderPolicy: допустимы только "input-order" | "configuration-id" (порядок не должен зависеть от результата; значения вроде "by-profit-factor"/"best-first" запрещены)`
  ];
}

/**
 * Детерминированный порядок представления. Результат-зависимая
 * сортировка здесь невозможна: доступны только inputOrder и
 * configurationId.
 */
export function applyPresentationOrder(
  variants: readonly VariantRecord[],
  policy: "input-order" | "configuration-id"
): readonly VariantRecord[] {
  const ordered = [...variants];

  if (policy === "configuration-id") {
    ordered.sort((a, b) => {
      if (a.configurationId === b.configurationId) {
        return a.inputOrder - b.inputOrder;
      }

      return a.configurationId < b.configurationId ? -1 : 1;
    });
  } else {
    ordered.sort((a, b) => a.inputOrder - b.inputOrder);
  }

  return ordered.map((variant, index) => ({
    ...variant,
    presentationOrder: index
  }));
}

/**
 * Поля `EvidenceMetrics` с НЕФИНИТНЫМ числом (NaN/±Infinity).
 *
 * `null` — законное отсутствие свидетельства (например PF при нуле
 * убытков), а не нарушение. Нефинитное число — нарушение: такое
 * свидетельство в ранжирование не попадает (C3, fail-closed).
 */
export function nonFiniteEvidenceFields(
  metrics: EvidenceMetrics
): readonly string[] {
  const fields: string[] = [];

  for (const [key, value] of Object.entries(metrics)) {
    if (typeof value === "number" && !Number.isFinite(value)) {
      fields.push(key);
    }
  }

  return fields.sort();
}

function criterionValue(
  entry: EvidenceEntry,
  criterion: RankingCriterion
): number | null {
  if (entry.metrics === null) {
    return null;
  }

  const value = entry.metrics[criterion];

  return typeof value === "number" ? value : null;
}

function compareByCriteria(
  a: EvidenceEntry,
  b: EvidenceEntry,
  criteria: readonly RankingCriterion[]
): number {
  for (const criterion of criteria) {
    const valueA = criterionValue(a, criterion);
    const valueB = criterionValue(b, criterion);

    // null — отсутствие свидетельства: всегда ПОСЛЕ любого числа,
    // независимо от направления критерия (иначе PF=null при нуле
    // убытков «побеждал» бы конечный PF).
    if (valueA === null && valueB === null) {
      continue;
    }

    if (valueA === null) {
      return 1;
    }

    if (valueB === null) {
      return -1;
    }

    if (valueA === valueB) {
      continue;
    }

    const ascending = RANKING_CRITERION_DIRECTION[criterion] === "asc";

    return ascending
      ? valueA < valueB
        ? -1
        : 1
      : valueA > valueB
        ? -1
        : 1;
  }

  // Полный порядок (пункт 8/22): tie-break по OOS-СЛЕПОМУ выборному
  // ключу, а при его коллизии — по порядку объявления.
  //
  // Полная `configurationId` здесь НЕ используется: для list-формы она
  // включает отпечаток всего списка решений, в том числе OOS-окна, и
  // изменение только OOS-решений меняло бы порядок и победителя.
  // `presentationOrder` здесь тоже НЕ используется: при
  // `orderPolicy="configuration-id"` он производен от полной
  // `configurationId` — то есть от того же OOS-отпечатка.
  if (a.selectionKey !== b.selectionKey) {
    return a.selectionKey < b.selectionKey ? -1 : 1;
  }

  return a.inputOrder - b.inputOrder;
}

function sameValues(
  a: EvidenceEntry,
  b: EvidenceEntry,
  criteria: readonly RankingCriterion[]
): boolean {
  return criteria.every((criterion) => {
    const valueA = criterionValue(a, criterion);
    const valueB = criterionValue(b, criterion);

    return valueA === valueB;
  });
}

/**
 * Явное ранжирование по свидетельствам ОДНОЙ стадии.
 *
 * На вход принимает только блок TRAIN или VALIDATION: блок OOS сюда
 * передать нельзя по типу, а внутри функции он не читается.
 */
export function rankEvidence(
  stage: SelectionStage,
  entries: readonly EvidenceEntry[],
  criteria: readonly RankingCriterion[]
): RankingRecord {
  const participants: EvidenceEntry[] = [];
  const excludedFromRanking: {
    configurationId: string;
    reason: RankingExclusionReason;
  }[] = [];

  for (const entry of entries) {
    if (entry.status === "evaluated" && entry.metrics !== null) {
      // C3: NaN/±Infinity не участвуют в сравнении молча — только
      // детерминированное исключение с явной причиной.
      if (nonFiniteEvidenceFields(entry.metrics).length > 0) {
        excludedFromRanking.push({
          configurationId: entry.configurationId,
          reason: "non-finite-evidence"
        });

        continue;
      }

      participants.push(entry);
    } else {
      excludedFromRanking.push({
        configurationId: entry.configurationId,
        reason: entry.rejectionReason ?? "invalid-variant"
      });
    }
  }

  const sorted = [...participants].sort((a, b) =>
    compareByCriteria(a, b, criteria)
  );

  const order: RankingEntry[] = sorted.map((entry, index) => {
    const values: Partial<Record<RankingCriterion, number | null>> = {};

    for (const criterion of criteria) {
      values[criterion] = criterionValue(entry, criterion);
    }

    const previous = index === 0 ? null : sorted[index - 1];

    return {
      rank: index,
      configurationId: entry.configurationId,
      selectionKey: entry.selectionKey,
      label: entry.label,
      values: Object.freeze(values),
      tieBreakApplied: previous !== null && sameValues(previous, entry, criteria)
    };
  });

  return deepFreeze({
    stage,
    criteria: [...criteria],
    oosConsulted: false,
    tieBreak: SELECTION_TIE_BREAK,
    order: Object.freeze(order),
    excludedFromRanking: Object.freeze([...excludedFromRanking])
  });
}

export interface RankingIndependenceReport {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/**
 * Перепроверка: записанный порядок воспроизводится из сохранённых
 * свидетельств заявленной стадии. Если порядок «подсмотрен» в OOS, он
 * не воспроизведётся.
 */
export function assertRankingIndependentOfOos(
  ranking: RankingRecord,
  evidence: {
    readonly trainSelection: readonly EvidenceEntry[];
    readonly validationConfirmation: readonly EvidenceEntry[];
  }
): RankingIndependenceReport {
  const errors: string[] = [];

  if (ranking.oosConsulted !== false) {
    errors.push("ranking.oosConsulted обязан быть false");
  }

  if (ranking.stage === ("OOS" as SelectionStage)) {
    errors.push("ranking.stage=OOS запрещён");
  }

  const source =
    ranking.stage === "TRAIN"
      ? evidence.trainSelection
      : evidence.validationConfirmation;

  const recomputed = rankEvidence(ranking.stage, source, ranking.criteria);

  if (canonicalJson(recomputed.order) !== canonicalJson(ranking.order)) {
    errors.push(
      "порядок ранжирования НЕ воспроизводится из свидетельств заявленной стадии — возможно скрытое использование OOS или подмена порядка"
    );
  }

  if (
    canonicalJson(recomputed.excludedFromRanking) !==
    canonicalJson(ranking.excludedFromRanking)
  ) {
    errors.push(
      "список исключённых из ранжирования не воспроизводится (подмена состава)"
    );
  }

  return { ok: errors.length === 0, errors };
}

const NO_SELECTION_RATIONALE =
  "P2-C не выбирает конфигурацию: все объявленные варианты представлены полностью";

/** Запись выбора/ранжирования по политике. */
export function buildSelectionRecord(
  policy: SelectionPolicy,
  evidence: {
    readonly trainSelection: readonly EvidenceEntry[];
    readonly validationConfirmation: readonly EvidenceEntry[];
  }
): SelectionRecord {
  if (policy.kind === "none") {
    return deepFreeze({
      policy,
      performed: false,
      selectedConfigurationId: null,
      selectedSelectionKey: null,
      selectedLabel: null,
      rationale: NO_SELECTION_RATIONALE,
      oosConsulted: false,
      ranking: null
    });
  }

  const source =
    policy.stage === "TRAIN"
      ? evidence.trainSelection
      : evidence.validationConfirmation;
  const ranking = rankEvidence(policy.stage, source, policy.criteria);
  const top = ranking.order.length > 0 ? ranking.order[0] : null;
  // `performed` означает «выбор ДЕЙСТВИТЕЛЬНО выполнен»: политика
  // select-by-rank при пустом ранжировании (все конфигурации отклонены)
  // ничего не выбирает, и утверждать обратное отчёт не имеет права.
  const performed = policy.kind === "select-by-rank" && top !== null;

  const rationale =
    policy.kind === "select-by-rank"
      ? top === null
        ? "выбор не выполнен: ни одна конфигурация не дала оцениваемых свидетельств"
        : `выбор по явному ранжированию stage=${policy.stage} критерии=${policy.criteria.join(",")} (OOS не читался)`
      : `ранжирование зафиксировано как свидетельство stage=${policy.stage}, выбор конфигурации не выполнялся`;

  return deepFreeze({
    policy,
    performed,
    selectedConfigurationId: performed && top !== null ? top.configurationId : null,
    selectedSelectionKey: performed && top !== null ? top.selectionKey : null,
    selectedLabel: performed && top !== null ? top.label : null,
    rationale,
    oosConsulted: false,
    ranking
  });
}
