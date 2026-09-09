/**
 * Подгрузка истории свечей: чистая логика без React и Prisma.
 *
 * Используется и сервером (валидация параметров
 * /api/chart/candles), и клиентом (слияние батчей без дублей).
 * Тесты: scripts/test-chart-history.ts.
 */

export const DEFAULT_HISTORY_LIMIT = 300;
export const MIN_HISTORY_LIMIT = 50;
/** Серверный максимум — больше этого клиент получить не может. */
export const MAX_HISTORY_LIMIT = 1000;

export type CursorCheck =
  | { ok: true; ms: number }
  | { ok: false; message: string };

/**
 * Валидация cursor-параметра `before` (openTime в мс).
 * Строгая: только целое положительное число, не в будущем.
 */
export function validateCursor(
  raw: string | null | undefined
): CursorCheck {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      message:
        "Нужен параметр before (openTime свечи в миллисекундах)"
    };
  }

  if (!/^\d+$/.test(raw.trim())) {
    return {
      ok: false,
      message:
        "Параметр before должен быть целым неотрицательным числом (мс)"
    };
  }

  const ms = Number(raw);

  if (ms <= 0) {
    return {
      ok: false,
      message: "Параметр before должен быть больше 0"
    };
  }

  // Сутки запаса на расхождение часов.
  if (ms > Date.now() + 24 * 60 * 60 * 1000) {
    return {
      ok: false,
      message: "Параметр before указывает на будущее"
    };
  }

  return { ok: true, ms };
}

/**
 * limit для пагинации: невалидное значение — дефолт,
 * валидное обрезается в 50..1000 (серверный максимум).
 * Точная копия прежнего поведения роута (невалидно → 300).
 */
export function parseHistoryLimit(
  raw: string | null | undefined
): number {
  const value = Number(raw ?? DEFAULT_HISTORY_LIMIT);

  if (
    !Number.isInteger(value) ||
    value < MIN_HISTORY_LIMIT ||
    value > MAX_HISTORY_LIMIT
  ) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return value;
}

/**
 * Слияние истории: добавляет к текущему окну (ASC по time)
 * только строго более старые свечи, без дублей — ни с
 * текущим окном, ни внутри самого батча истории.
 */
export function mergeOlder<
  T extends { time: number }
>(
  current: T[],
  older: T[]
): { merged: T[]; added: number } {
  if (current.length === 0) {
    return { merged: older, added: older.length };
  }

  if (older.length === 0) {
    return { merged: current, added: 0 };
  }

  const boundary = current[0].time;
  const kept: T[] = [];

  for (const point of older) {
    if (point.time >= boundary) {
      continue;
    }

    if (
      kept.length > 0 &&
      point.time <= kept[kept.length - 1].time
    ) {
      continue;
    }

    kept.push(point);
  }

  if (kept.length === 0) {
    return { merged: current, added: 0 };
  }

  return {
    merged: [...kept, ...current],
    added: kept.length
  };
}

/* ---------- чистые функции состояния графика ---------- */

export type ChartStatus =
  | "loading"
  | "loading-data"
  | "ok"
  | "empty"
  | "error";

/**
 * Выбор символа после загрузки списка активов:
 * предпочитаемый (URL/страница) остаётся, если реально
 * есть в списке; иначе первый из списка; пустой список
 * НЕ сбрасывает уже выбранный символ (точка B ревью).
 */
export function resolveSymbolFromList(
  preferred: string | null | undefined,
  list: readonly { symbol: string }[]
): string | null {
  if (
    preferred &&
    list.some((item) => item.symbol === preferred)
  ) {
    return preferred;
  }

  return list[0]?.symbol ?? null;
}

/**
 * Ошибка/пустота СПИСКА активов не должна затирать
 * рабочий график: статус "ok" «липкий» (точка C ревью —
 * гонка list-fetch против успешных candles).
 */
export function nextStatusAfterListFailure(
  current: ChartStatus
): ChartStatus {
  return current === "ok" ? current : "error";
}

/**
 * Целостность ответа (точка F ревью): если сервер сообщил
 * count > 0, итоговый массив свечей не может быть пустым.
 */
export function candlesIntegrityOk(
  count: number | null | undefined,
  candles: readonly unknown[]
): boolean {
  if (
    count !== null &&
    count !== undefined &&
    count > 0 &&
    candles.length === 0
  ) {
    return false;
  }

  return true;
}
