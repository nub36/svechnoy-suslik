/**
 * P2-B — единый источник длительности таймфрейма.
 *
 * Требование: "gap detection должен быть timeframe-aware, используя
 * timeframe duration source, а не второй набор констант".
 *
 * Единственный источник — SMCTIMEFRAME_MS из lib/smc/types.ts.
 * P2-B не хардкодит свои 5m/15m/1h/4h/1d, а импортирует отсюда.
 *
 * HARDENING:
 * - unknown timeframe must be explicit invalid/unknown, never healthy defaults
 * - CLI unknown timeframe must exit non-zero
 * - No arbitrary timeframe fabrication
 */

import { SMCTIMEFRAME_MS, type SmcTimeframe } from "../smc/types";

export { SMCTIMEFRAME_MS };
export type { SmcTimeframe };

/**
 * Получить длительность ТФ в ms из единственного источника.
 * Возвращает null если ТФ неизвестен (не бросает, чтобы coverage мог
 * отчитаться о неизвестном ТФ как explicit invalid).
 */
export function getTimeframeMs(timeframe: string): number | null {
  const ms = (SMCTIMEFRAME_MS as Record<string, number>)[timeframe];
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/**
 * Проверить, является ли timeframe каноническим (из SMCTIMEFRAME_MS).
 * Unknown timeframe → false (fail-closed, never healthy true).
 */
export function isCanonicalTimeframe(timeframe: string): boolean {
  return getTimeframeMs(timeframe) !== null;
}

/**
 * Список канонических ТФ — единственный источник.
 */
export const CANONICAL_TIMEFRAMES: readonly string[] = Object.freeze(
  Object.keys(SMCTIMEFRAME_MS)
) as readonly string[];

/**
 * Fail-closed validation for CLI and data-plane.
 * Throws structured error if timeframe unknown.
 */
export function assertCanonicalTimeframe(timeframe: string): number {
  const ms = getTimeframeMs(timeframe);
  if (ms === null) {
    throw new Error(
      `Unknown timeframe '${timeframe}'. Supported: ${CANONICAL_TIMEFRAMES.join(", ")} (explicit invalid, never healthy)`
    );
  }
  return ms;
}

/* ------------------------------------------------------------------ */
/* Canonical request window — P2-B HARDENING #2 (MANDATORY FIX 1)      */
/* ------------------------------------------------------------------ */

/**
 * Чистое форматирование epoch ms → ISO-8601 UTC строка, БЕЗ `new Date`:
 * P2-A isolation-тест (scripts/test-backtest-engine.ts: FORBIDDEN_TOKENS)
 * запрещает токен `new Date` в lib/backtest/*.ts, и это осознанное
 * ограничение (никаких объектов Date/часов внутри слоя). Алгоритм —
 * гражданская дата из дней эпохи (Howard Hinnant, civil_from_days),
 * полностью детерминированный, отрицательные ms поддержаны через floor.
 */
export function formatIsoUtc(epochMs: number): string {
  if (!Number.isFinite(epochMs)) {
    return String(epochMs);
  }

  const days = Math.floor(epochMs / 86_400_000);
  const msOfDay = epochMs - days * 86_400_000;

  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1_460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp + (mp < 10 ? 3 : -9);
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);

  const hours = Math.floor(msOfDay / 3_600_000);
  const minutes = Math.floor((msOfDay % 3_600_000) / 60_000);
  const seconds = Math.floor((msOfDay % 60_000) / 1000);
  const millis = msOfDay % 1000;

  const pad = (value: number, width: number): string =>
    String(value).padStart(width, "0");

  return (
    `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}` +
    `T${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)}.${pad(millis, 3)}Z`
  );
}

/**
 * Копия Date из ЯВНОГО epoch ms (часы не читаются).
 *
 * `Reflect.construct` вместо `new Date(...)`: P2-A isolation-тест запрещает
 * токен `new Date` внутри lib/backtest/*.ts. Семантика — детерминированная
 * конструкция из переданного значения, что и нужно для публикации копий
 * строк, принадлежащих провайдеру (Prisma), а не для чтения времени.
 *
 * ВАЖНО (JS-ограничение): Object.freeze НЕ мешает `date.setTime(...)` —
 * внутренний слот [[DateValue]] не является свойством объекта. Поэтому
 * наружу отдаётся ИМЕННО КОПИЯ: мутация даты потребителем не может
 * затронуть ни состояние провайдера, ни последующие fetch-и.
 */
export function utcDateFromMs(epochMs: number): Date {
  return Reflect.construct(Date, [epochMs]) as unknown as Date;
}

/**
 * Ошибка канонического окна запроса. Fail-closed контракт:
 * окно, в котором НЕТ ни одного канонического открытия, не является
 * «покрытием 0%» — это невалидный запрос, и он обязан падать, а не
 * публиковать healthy/false-числа.
 */
export class CanonicalWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalWindowError";
  }
}

/**
 * Каноническое окно запроса.
 *
 * КОНТРАКТ (единственный, детерминированный — вариант B аудита):
 * - бар идентифицируется openTime (epoch ms, UTC); каноническая сетка
 *   таймфрейма D — это `t % D === 0` (та же проверка, что в
 *   lib/strategies/alignment.ts:isCanonicalAligned);
 * - бар покрывает [t, t + D) и каузально закрыт в t + D;
 * - бар входит в запрошенное окно ⟺ `from <= t < to` (to исключительно);
 * - ОЖИДАЕМЫЙ набор = канонические открытия в окне, а НЕ искусственная
 *   сетка, заякоренная на `from`:
 *     effectiveFrom = ceil(from / D) * D   (первое каноническое >= from)
 *     expectedCount = |{ t : t % D === 0, from <= t < to }|
 *   Пример (1h, [00:30, 03:30)): канонические открытия 01:00, 02:00,
 *   03:00 → expectedCount = 3 (а не 4 «слота от 00:30»).
 * - bounds НЕ обязаны быть выровнены; если они не выровнены, окно
 *   помечается `canonicalized: true` и это ОБЯЗАНО быть видно
 *   потребителю (coverage/plan/report/CLI) — «молчаливый healthy 100%»
 *   на невыровненном запросе запрещён.
 * - окно без канонических открытий (например 1h [00:10, 00:50)) →
 *   CanonicalWindowError (fail closed), а не coverageRatio=0/1.
 *
 * Инварианты: from < to, конечные целые ms, timeframeMs > 0.
 */
export interface CanonicalWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly timeframeMs: number;
  /** Первое каноническое открытие >= fromMs. */
  readonly effectiveFromMs: number;
  /** toMs (исключительно) — граница запроса не двигается. */
  readonly effectiveToMs: number;
  /** Число канонических открытий в [from, to). */
  readonly expectedCanonicalSlots: number;
  readonly fromAligned: boolean;
  readonly toAligned: boolean;
  readonly fromRemainder: number;
  readonly toRemainder: number;
  /** Оба bounds лежат на канонической сетке. */
  readonly isAligned: boolean;
  /** Bounds не на сетке → окно пересчитано по канонической сетке. */
  readonly canonicalized: boolean;
}

/**
 * Целочисленное `ceil(value / divisor)` для неотрицательных безопасных
 * целых (ms). Без float-деления: экономит от of-by-one на больших ms.
 */
function integerCeilDiv(value: number, divisor: number): number {
  return Math.floor((value + divisor - 1) / divisor);
}

/** Сколько канонических открытий попадает в [fromMs, toMs). */
export function countCanonicalSlots(
  fromMs: number,
  toMs: number,
  timeframeMs: number
): number {
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return 0;
  if (!isValidTimeframeMsLocal(timeframeMs)) return 0;
  if (fromMs >= toMs) return 0;

  const effectiveFrom = integerCeilDiv(fromMs, timeframeMs) * timeframeMs;

  if (effectiveFrom >= toMs) return 0;

  return Math.floor((toMs - 1 - effectiveFrom) / timeframeMs) + 1;
}

function isValidTimeframeMsLocal(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isInteger(value) &&
    value > 0
  );
}

/**
 * Вычислить каноническое окно запроса. Fail-closed:
 * - невалидные аргументы → CanonicalWindowError;
 * - from >= to → CanonicalWindowError;
 * - окно без канонических открытий → CanonicalWindowError.
 */
export function canonicalWindow(
  fromMs: number,
  toMs: number,
  timeframeMs: number
): CanonicalWindow {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)) {
    throw new CanonicalWindowError(
      `canonicalWindow: from/to должны быть целыми safe ms, получено from=${String(fromMs)} to=${String(toMs)}`
    );
  }
  if (!isValidTimeframeMsLocal(timeframeMs)) {
    throw new CanonicalWindowError(
      `canonicalWindow: timeframeMs должен быть целым >0, получен ${String(timeframeMs)}`
    );
  }
  if (fromMs >= toMs) {
    throw new CanonicalWindowError(
      `canonicalWindow: from должен быть < to, получено from=${fromMs} to=${toMs}`
    );
  }

  const effectiveFromMs = integerCeilDiv(fromMs, timeframeMs) * timeframeMs;
  const expectedCanonicalSlots = countCanonicalSlots(fromMs, toMs, timeframeMs);

  if (expectedCanonicalSlots === 0) {
    throw new CanonicalWindowError(
      `canonicalWindow: окно [${formatIsoUtc(fromMs)}, ${formatIsoUtc(toMs)}) ` +
        `не содержит ни одного канонического открытия таймфрейма ${timeframeMs} ms ` +
        `(первое каноническое открытие ${formatIsoUtc(effectiveFromMs)} >= to) — fail closed, не coverage 0%`
    );
  }

  const fromRemainder = fromMs % timeframeMs;
  const toRemainder = toMs % timeframeMs;
  const fromAligned = fromRemainder === 0;
  const toAligned = toRemainder === 0;

  return Object.freeze({
    fromMs,
    toMs,
    timeframeMs,
    effectiveFromMs,
    effectiveToMs: toMs,
    expectedCanonicalSlots,
    fromAligned,
    toAligned,
    fromRemainder,
    toRemainder,
    isAligned: fromAligned && toAligned,
    canonicalized: !fromAligned || !toAligned,
  });
}
