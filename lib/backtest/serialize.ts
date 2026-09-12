/**
 * P2-A — детерминированная сериализация и отпечатки.
 *
 * Политика (contract.ts, пункты 15 и 16):
 *  - каноническая форма: ключи объектов сортируются лексикографически
 *    НА ВСЕХ УРОВНЯХ (порядок полей во входе не влияет на вывод);
 *  - все конечные числа нормализуются до 10 знаков после запятой,
 *    −0 заменяется на 0 (иначе «-0» и «0» дали бы разные отпечатки);
 *  - NaN/Infinity/BigInt в выводе НЕВОЗМОЖНЫ: сериализация бросает
 *    исключение вместо тихого «null» (JSON.stringify(NaN) = null — это
 *    подмена данных, а не сериализация);
 *  - отпечатки — sha256 канонической формы; в преамбулу отпечатка
 *    входит версия контракта, поэтому изменение семантики меняет
 *    отпечаток тех же данных;
 *  - единственный внешний импорт слоя — node:crypto (детерминированный
 *    хеш): ни process.env, ни времени, ни случайности, ни fs, ни сети.
 *
 * Идентичные вход + конфиг ⇒ байт-в-байт идентичная каноническая
 * строка ⇒ идентичный отпечаток. Это проверяется тестами напрямую.
 */

import { createHash } from "node:crypto";

import {
  BACKTEST_CONTRACT_VERSION,
  type BacktestBar,
  type BacktestResult,
  type ResolvedBacktestConfig
} from "./contract";

/** Знаков после запятой в канонической форме чисел. */
export const CANONICAL_PRECISION = 10;

/**
 * Нормализация числа: 10 знаков, −0 → 0.
 *
 * Не конечные значения — исключение: в контракте P2-A таких чисел в
 * результате быть не должно (нулевой знаменатель → null, не Infinity).
 */
export function canonicalNumber(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(
      `serialize: не конечное число (${String(value)}) — результат обязан быть сериализуем без NaN/Infinity`
    );
  }

  // toFixed(10) + Number() гасит шум представления IEEE-754.
  const rounded = Number(value.toFixed(CANONICAL_PRECISION));

  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Каноническая копия значения: объекты с отсортированными ключами,
 * нормализованные числа, undefined-поля отбрасываются (как в JSON).
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) {
    return null;
  }

  const type = typeof value;

  if (type === "number") {
    return canonicalNumber(value as number);
  }

  if (type === "string" || type === "boolean") {
    return value;
  }

  if (type === "bigint") {
    throw new Error("serialize: BigInt не поддерживается контрактом");
  }

  if (type === "function" || type === "symbol") {
    throw new Error(
      "serialize: функции/символы не являются данными результата (провайдер сигналов не сериализуется)"
    );
  }

  if (value instanceof Date) {
    throw new Error(
      "serialize: Date запрещён — метаданные не должны зависеть от времени"
    );
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalize(item));
  }

  const source = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const key of Object.keys(source).sort()) {
    const item = source[key];

    if (item === undefined) {
      continue;
    }

    result[key] = canonicalize(item);
  }

  return result;
}

/** Канонический JSON без пробелов (байт-в-байт воспроизводимый). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/** sha256 строки в hex. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Отпечаток произвольного значения: sha256(версия контракта + JSON). */
export function fingerprintOf(value: unknown): string {
  return sha256Hex(`${BACKTEST_CONTRACT_VERSION}|${canonicalJson(value)}`);
}

/** Отпечаток разрешённого конфига. */
export function fingerprintConfig(config: ResolvedBacktestConfig): string {
  return fingerprintOf({ scope: "config", config });
}

/** Отпечаток входных баров (включая volume — это часть входа). */
export function fingerprintBars(bars: readonly BacktestBar[]): string {
  return fingerprintOf({ scope: "bars", bars });
}

/** Каноническая форма результата прогона (для хранения/сравнения). */
export function serializeResult(result: BacktestResult): string {
  return canonicalJson({ scope: "result", result });
}

/** Отпечаток результата: равен для логически идентичных прогонов. */
export function fingerprintResult(result: BacktestResult): string {
  return sha256Hex(serializeResult(result));
}

/**
 * Отпечаток «входа» прогона (бары + конфиг + границы сегмента) —
 * удобный ключ кэша/сравнения «те же данные и тот же конфиг».
 */
export function fingerprintRunInput(args: {
  readonly bars: readonly BacktestBar[];
  readonly config: ResolvedBacktestConfig;
  readonly segment?: { readonly name: string; readonly startIndex: number; readonly endIndexExclusive: number } | null;
}): string {
  return fingerprintOf({
    scope: "run-input",
    bars: args.bars,
    config: args.config,
    segment: args.segment ?? null
  });
}
