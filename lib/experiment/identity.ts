/**
 * P2-C — идентичность и отпечатки эксперимента.
 *
 * Всё строится на P2-A-сериализаторе (`canonicalJson`, `fingerprintOf`,
 * `fingerprintConfig`, `fingerprintBars`): второй сериализатор не
 * создаётся, поэтому отпечатки P2-C и P2-A совместимы и сравниваемы.
 *
 * Идентичность конфигурации связывает: субъект (стратегия + рынок +
 * таймфрейм + диапазон данных), метку, параметры-данные, разрешённый
 * конфиг P2-A и описание источника решений. Отсюда следует проверяемое
 * свойство: результат, полученный на другом рынке/таймфрейме или с
 * другим конфигом, имеет ДРУГОЙ `configurationId` и не может быть
 * выдан за результат этой конфигурации.
 */

import {
  type BacktestBar,
  type ResolvedBacktestConfig,
  type SignalDecisionList,
  resolveBacktestConfig
} from "../backtest/contract";
import {
  fingerprintBars,
  fingerprintConfig,
  fingerprintOf
} from "../backtest/serialize";
import {
  SELECTION_KEY_SCOPE,
  type DataRange,
  type ExperimentSubject,
  type ExperimentSubjectInput,
  type ResolvedVariant,
  type SignalSourceDescriptor,
  type VariantDefinition,
  type VariantRejection
} from "./contract";

/** Диапазон данных вычисляется ИЗ БАРОВ — заявить его «на глаз» нельзя. */
export function describeDataRange(bars: readonly BacktestBar[]): DataRange {
  return {
    barsCount: Array.isArray(bars) ? bars.length : 0,
    firstBarTime: bars.length > 0 ? bars[0].time : null,
    lastBarTime: bars.length > 0 ? bars[bars.length - 1].time : null,
    barsFingerprint: fingerprintBars(bars)
  };
}

/** Субъект эксперимента: заявленная идентичность + фактический диапазон. */
export function describeSubject(
  input: ExperimentSubjectInput,
  bars: readonly BacktestBar[]
): ExperimentSubject {
  return {
    strategy: {
      slug: input.strategy.slug,
      version: input.strategy.version
    },
    market: {
      asset: input.market.asset,
      exchange: input.market.exchange ?? null,
      timeframe: input.market.timeframe,
      timeframeMs: input.market.timeframeMs ?? null
    },
    dataRange: describeDataRange(bars)
  };
}

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Проверка заявленной идентичности субъекта. */
export function validateSubject(subject: ExperimentSubject): readonly string[] {
  const errors: string[] = [];

  if (!isNonEmptyString(subject.strategy.slug)) {
    errors.push("subject.strategy.slug: непустая строка");
  }

  if (!isNonEmptyString(subject.strategy.version)) {
    errors.push("subject.strategy.version: непустая строка (версия стратегии обязательна)");
  }

  if (!isNonEmptyString(subject.market.asset)) {
    errors.push("subject.market.asset: непустая строка");
  }

  if (!isNonEmptyString(subject.market.timeframe)) {
    errors.push("subject.market.timeframe: непустая строка");
  }

  if (
    subject.market.exchange !== null &&
    !isNonEmptyString(subject.market.exchange)
  ) {
    errors.push("subject.market.exchange: непустая строка или null");
  }

  if (
    subject.market.timeframeMs !== null &&
    (!Number.isInteger(subject.market.timeframeMs) || subject.market.timeframeMs <= 0)
  ) {
    errors.push("subject.market.timeframeMs: целое > 0 или null");
  }

  if (!Number.isInteger(subject.dataRange.barsCount) || subject.dataRange.barsCount < 1) {
    errors.push("subject.dataRange.barsCount: целое ≥ 1");
  }

  if (!FINGERPRINT_PATTERN.test(subject.dataRange.barsFingerprint)) {
    errors.push("subject.dataRange.barsFingerprint: sha256 hex");
  }

  const { firstBarTime, lastBarTime } = subject.dataRange;

  if (
    firstBarTime !== null &&
    lastBarTime !== null &&
    lastBarTime < firstBarTime
  ) {
    errors.push("subject.dataRange: lastBarTime < firstBarTime");
  }

  return errors;
}

/** Отпечаток субъекта (стратегия + рынок + диапазон данных). */
export function fingerprintSubject(subject: ExperimentSubject): string {
  return fingerprintOf({ scope: "experiment-subject", subject });
}

/**
 * Описание источника решений.
 *
 * Provider-форма ОБЯЗАНА иметь явный `signalSourceId`: функция не
 * сериализуема, и без явной идентичности два разных провайдера дали бы
 * один и тот же `configurationId` (а значит, чужой результат можно было
 * бы выдать за свой).
 */
export function describeSignalSource(
  signals: VariantDefinition["signals"],
  signalSourceId: string | undefined
):
  | { readonly ok: true; readonly descriptor: SignalSourceDescriptor }
  | { readonly ok: false; readonly errors: readonly string[] } {
  if (typeof signals === "function") {
    if (!isNonEmptyString(signalSourceId)) {
      return {
        ok: false,
        errors: [
          "signals: provider-форма требует явного signalSourceId (функция несериализуема, идентичность обязана быть заявленной)"
        ]
      };
    }

    return {
      ok: true,
      descriptor: { kind: "provider", signalSourceId }
    };
  }

  if (!Array.isArray(signals)) {
    return {
      ok: false,
      errors: ["signals: ожидается функция-провайдер либо массив решений"]
    };
  }

  const list: SignalDecisionList = signals;

  try {
    return {
      ok: true,
      descriptor: {
        kind: "list",
        length: list.length,
        fingerprint: fingerprintOf({ scope: "signal-list", list })
      }
    };
  } catch (error) {
    return {
      ok: false,
      errors: [
        `signals: список решений несериализуем (${
          error instanceof Error ? error.message : String(error)
        })`
      ]
    };
  }
}

/** Отпечаток параметров-данных (P2-C их не интерпретирует). */
export function fingerprintParams(
  params: Readonly<Record<string, unknown>>
): string {
  return fingerprintOf({ scope: "variant-params", params });
}

/** Идентичность конфигурации внутри эксперимента. */
export function configurationIdOf(args: {
  readonly subjectFingerprint: string;
  readonly label: string;
  readonly paramsFingerprint: string;
  readonly configFingerprint: string;
  readonly signalSource: SignalSourceDescriptor;
}): string {
  return fingerprintOf({
    scope: "experiment-configuration",
    subjectFingerprint: args.subjectFingerprint,
    label: args.label,
    paramsFingerprint: args.paramsFingerprint,
    configFingerprint: args.configFingerprint,
    signalSource: args.signalSource
  });
}

/**
 * ВЫБОРНЫЙ (selection) ключ конфигурации — OOS-слепой ПО ПОСТРОЕНИЮ.
 *
 * Входы (исчерпывающе, см. `SELECTION_KEY_INPUTS`): subjectFingerprint,
 * label, paramsFingerprint, configFingerprint, `signalSource.kind` и — только
 * для provider-формы — объявленный `signalSource.signalSourceId`.
 *
 * В ключ СОЗНАТЕЛЬНО не входит `signalSource.fingerprint` list-формы:
 * он покрывает весь список решений, включая решения OOS-окна, поэтому
 * любое изменение только-OOS-части объявленного входа меняло бы полную
 * `configurationId` (это правильно для происхождения) и НЕ должно менять
 * выбор. Ни результаты, ни метрики, ни отчёты, ни статусы/ошибки сегментов
 * в выборный ключ не входят: его невозможно «подсмотреть» в OOS.
 */
export function selectionKeyOf(args: {
  readonly subjectFingerprint: string;
  readonly label: string;
  readonly paramsFingerprint: string;
  readonly configFingerprint: string;
  readonly signalSource: SignalSourceDescriptor;
}): string {
  return fingerprintOf({
    scope: SELECTION_KEY_SCOPE,
    subjectFingerprint: args.subjectFingerprint,
    label: args.label,
    paramsFingerprint: args.paramsFingerprint,
    configFingerprint: args.configFingerprint,
    signalSourceKind: args.signalSource.kind,
    signalSourceId:
      args.signalSource.kind === "provider" ? args.signalSource.signalSourceId : null
  });
}

/** Вариант после попытки разрешения. */
export interface VariantResolution {
  readonly inputOrder: number;
  readonly definition: VariantDefinition;
  readonly resolved: ResolvedVariant | null;
  readonly rejection: VariantRejection | null;
  /**
   * Для отказа `duplicate-configuration-id` — идентичность, с которой
   * произошёл конфликт. Передаётся структурой, а не разбором текста
   * ошибки: отчёт обязан показывать реальный конфликтующий id.
   */
  readonly duplicateOfConfigurationId: string | null;
}

function rejection(
  stage: VariantRejection["stage"],
  reason: VariantRejection["reason"],
  errors: readonly string[]
): VariantRejection {
  return { stage, reason, segment: null, errors: [...errors] };
}

/**
 * Разрешение всех вариантов. Отказ варианта НЕ прерывает разрешение
 * остальных: отклонённые конфигурации должны остаться в отчёте
 * (никакого cherry-picking).
 */
export function resolveVariants(
  variants: readonly VariantDefinition[],
  subjectFingerprint: string
): readonly VariantResolution[] {
  const resolutions: VariantResolution[] = [];
  const seen = new Set<string>();

  for (let inputOrder = 0; inputOrder < variants.length; inputOrder += 1) {
    const definition = variants[inputOrder];

    if (definition === null || typeof definition !== "object") {
      resolutions.push({
        inputOrder,
        definition,
        resolved: null,
        duplicateOfConfigurationId: null,
        rejection: rejection("variant", "invalid-variant", [
          "вариант не является объектом"
        ])
      });

      continue;
    }

    const errors: string[] = [];

    if (!isNonEmptyString(definition.label)) {
      errors.push("label: непустая строка");
    }

    const params: Readonly<Record<string, unknown>> =
      definition.params === undefined || definition.params === null
        ? {}
        : definition.params;

    if (
      typeof params !== "object" ||
      Array.isArray(params) ||
      params === null
    ) {
      errors.push("params: объект-словарь либо null/undefined");
    }

    let paramsFingerprint: string | null = null;

    try {
      paramsFingerprint = fingerprintParams(params);
    } catch (error) {
      errors.push(
        `params: несериализуемы (${
          error instanceof Error ? error.message : String(error)
        })`
      );
    }

    const resolvedConfig = resolveBacktestConfig(definition.config);

    if (!resolvedConfig.ok) {
      resolutions.push({
        inputOrder,
        definition,
        resolved: null,
        duplicateOfConfigurationId: null,
        rejection: rejection("config", "invalid-config", [
          ...errors,
          ...resolvedConfig.errors
        ])
      });

      continue;
    }

    const source = describeSignalSource(
      definition.signals,
      definition.signalSourceId
    );

    if (!source.ok) {
      resolutions.push({
        inputOrder,
        definition,
        resolved: null,
        duplicateOfConfigurationId: null,
        rejection: rejection(
          "variant",
          source.errors.some((item) => item.includes("signalSourceId"))
            ? "missing-signal-source-id"
            : "invalid-variant",
          [...errors, ...source.errors]
        )
      });

      continue;
    }

    if (errors.length > 0 || paramsFingerprint === null) {
      resolutions.push({
        inputOrder,
        definition,
        resolved: null,
        duplicateOfConfigurationId: null,
        rejection: rejection(
          "variant",
          "invalid-variant",
          errors.length > 0 ? errors : ["params: не удалось вычислить отпечаток"]
        )
      });

      continue;
    }

    const configFingerprint = fingerprintConfig(resolvedConfig.config);
    const configurationId = configurationIdOf({
      subjectFingerprint,
      label: definition.label,
      paramsFingerprint,
      configFingerprint,
      signalSource: source.descriptor
    });
    const selectionKey = selectionKeyOf({
      subjectFingerprint,
      label: definition.label,
      paramsFingerprint,
      configFingerprint,
      signalSource: source.descriptor
    });

    if (seen.has(configurationId)) {
      resolutions.push({
        inputOrder,
        definition,
        resolved: null,
        duplicateOfConfigurationId: configurationId,
        rejection: rejection("variant", "duplicate-configuration-id", [
          `configurationId ${configurationId} уже объявлен ранее: идентичная конфигурация не оценивается дважды, но остаётся в отчёте`
        ])
      });

      continue;
    }

    seen.add(configurationId);

    resolutions.push({
      inputOrder,
      definition,
      resolved: {
        inputOrder,
        label: definition.label,
        params,
        config: resolvedConfig.config,
        configFingerprint,
        paramsFingerprint,
        signalSource: source.descriptor,
        configurationId,
        selectionKey
      },
      rejection: null,
      duplicateOfConfigurationId: null
    });
  }

  return resolutions;
}

/** Отпечаток входа эксперимента (без результатов). */
export function fingerprintExperimentInput(args: {
  readonly subject: ExperimentSubject;
  readonly subjectFingerprint: string;
  readonly split: unknown;
  readonly orderPolicy: string;
  readonly selectionPolicy: unknown;
  readonly configurationIds: readonly string[];
}): string {
  return fingerprintOf({
    scope: "experiment-input",
    subjectFingerprint: args.subjectFingerprint,
    subject: args.subject,
    split: args.split,
    orderPolicy: args.orderPolicy,
    selectionPolicy: args.selectionPolicy,
    configurationIds: [...args.configurationIds]
  });
}
