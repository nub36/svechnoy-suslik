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
