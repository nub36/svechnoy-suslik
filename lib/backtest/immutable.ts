/**
 * P2-B — иммутабельность публичных результатов (MANDATORY FIX 4).
 *
 * Независимый аудит P2-B нашёл достижимые мутабельные публичные структуры:
 * shallow `Object.freeze` не защищает вложенные объекты/массивы
 * (`requestedAlignment`, `requestedRange`, вложенные массивы anomalies,
 * элементы contiguousRanges, результат findCommonTimestamps, meta V2 и т.д.).
 *
 * Контракт: все публичные структуры P2-B (coverage, aggregate, gaps,
 * intervals, fetch/meta, plan) заморожены ГЛУБОКО. Мутация обязана быть
 * невозможна, а не «не рекомендуется».
 *
 * Реализация НЕ является sandbox'ом: она защищает от случайной/небрежной
 * мутации потребителем. Чужой код, получивший объект до заморозки или
 * обёрнутый в Proxy, этой функцией не ограничивается — как и в P2-A,
 * это документированное ограничение, а не гарантия против hostile-кода.
 *
 * Циклы обрабатываются через WeakSet (self-cycle, взаимный цикл), чтобы
 * deepFreeze не падал с RangeError.
 */

export function deepFreeze<T>(value: T, seen?: WeakSet<object>): T {
  if (value === null || typeof value !== "object") {
    return value;
  }

  const visited = seen ?? new WeakSet<object>();
  const obj = value as unknown as object;

  if (visited.has(obj)) {
    return value;
  }
  visited.add(obj);

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      deepFreeze(value[i], visited);
    }
  } else {
    for (const key of Object.keys(obj as Record<string, unknown>)) {
      deepFreeze((obj as Record<string, unknown>)[key], visited);
    }
  }

  return Object.freeze(value);
}

/**
 * Shallow copy + deep freeze. Используется там, где вход принадлежит
 * вызывающему коду (провайдер строк, внешние массивы) и мы не имеем права
 * ни замораживать, ни отдавать ссылку на его объекты.
 */
export function freezeCopy<T extends object>(value: T): Readonly<T> {
  return deepFreeze({ ...value });
}

/** Заморозить массив поэлементно и вернуть его же (для свежих массивов). */
export function freezeArray<T>(items: T[]): readonly T[] {
  for (const item of items) {
    deepFreeze(item);
  }
  return Object.freeze(items);
}
