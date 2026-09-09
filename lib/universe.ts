/**
 * Основной universe проекта «Свечной Суслик».
 *
 * С перехода ЭТАПА A основным universe является
 * Top-100: Asset с заполненным rank, rank <= 100.
 *
 * Схема НЕ менялась: поля Asset.rank (место в рейтинге)
 * и Asset.top500 (исторический флаг «входил в Top-500
 * рейтинга») остаются как есть; исторические данные
 * Top-500 (Asset/Market/Candle/IndicatorSnapshot)
 * сохраняются полностью — universe ограничивает только
 * НОВЫЙ основной анализ.
 *
 * Единая точка правды: любое место кода, которому нужно
 * «сколько активов в universe / входит ли актив»,
 * использует эти функции, а не локальные числа.
 */

export const TOP_UNIVERSE_SIZE = 100;

export const TOP_UNIVERSE_LABEL = "Top-100";

/**
 * Исторический (legacy) размер рейтинга Top-500.
 *
 * НЕ является universe. Используется только:
 * - scripts/rank-assets.ts — поддерживает legacy-флаг
 *   Asset.top500 для первых 500 мест (совместимость
 *   со старыми данными);
 * - CLI worker'ов (--top) как безопасный максимум
 *   вместе с large-run guard (lib/ohlcv/plan.ts):
 *   диагностика --plan --top=500 разрешена, реальные
 *   большие прогоны требуют --confirm-large-run.
 */
export const LEGACY_TOP500_SIZE = 500;

/**
 * Семантика legacy-поля Strategy.config.filters.top500Only.
 *
 * Имя поля СОХРАНЕНО (production JSON-конфиги уже
 * существуют в БД, переименование ломало бы их парсер).
 * Со ЭТАПА A-fix значение true трактуется как
 * «ограничить основным ranked universe проекта»,
 * а основной ranked universe — это Top-100
 * (isInTopUniverse: rank 1..100), НЕ флаг Asset.top500.
 * Старые конфиги с top500Only=true остаются валидны
 * без каких-либо изменений в БД.
 */

/** Входит ли актив с таким rank в основной universe. */
export function isInTopUniverse(
  rank: number | null | undefined
): boolean {
  return (
    rank !== null &&
    rank !== undefined &&
    rank >= 1 &&
    rank <= TOP_UNIVERSE_SIZE
  );
}

/** Условие Prisma для выборки universe-активов. */
export function topUniverseRankFilter(): {
  rank: { lte: number; not: null };
} {
  return {
    rank: {
      lte: TOP_UNIVERSE_SIZE,
      not: null
    }
  };
}
