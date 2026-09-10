/**
 * SMC Phase 1 — детерминированные pivots с plateau-политикой
 * (спецификация V2 §3, с исправлением off-by-one).
 *
 * НАША convention (не параметр LuxAlgo):
 * - plateau = максимальный run i..k свечей с РАВНЫМ значением
 *   high (low — зеркально); равенство — ТОЧНОЕ (a === b),
 *   без ATR/процентного допуска. Плато-политика не имеет
 *   отношения к EQH/EQL (те не реализованы в Phase 1).
 * - pivot существует, если:
 *     left-контекст [i-left .. i-1] весь СТРОГО ниже пика
 *     (требуется полный левый контекст, иначе пивота нет);
 *     right-контекст [k+1 .. k+right] весь СТРОГО ниже пика
 *     (требуется full right-контекст ПОСЛЕ КОНЦА plateau);
 * - anchor = ПЕРВАЯ свеча plateau: eventTime = openTime[i].
 *   Продление plateau вправо не двигает eventTime —
 *   identity стабильна;
 * - confirmedAt = effectiveCloseTime(k + right): нужно right
 *   ЗАКРЫТЫХ свечей ПОСЛЕ конца plateau. До confirmedAt
 *   пивот не возвращается (pending не существует).
 *
 * Исправление off-by-one (review V2): при right=2 после
 * конца plateau нужны ровно ДВЕ закрытые правые свечи:
 *   100,110,110,105            → pending (только 105);
 *   100,110,110,110,105        → pending (только 105);
 *   90,95,100,110,110,110,105,104 → confirmed (105,104).
 */

import {
  smcPivotKey,
  SmcCandle,
  SmcPivot,
  SmcPivotKind,
  StructureParams
} from "./types";

function valueOf(
  candle: SmcCandle,
  kind: SmcPivotKind
): number {
  return kind === "high" ? candle.high : candle.low;
}

/** Контекст обязан быть строго «за» уровнем: для high —
 * ниже, для low — выше. Равенство невозможно по построению
 * (расширяло бы plateau), но проверяется явно. */
function contextStrictlyBeyond(
  candles: SmcCandle[],
  from: number,
  to: number,
  level: number,
  kind: SmcPivotKind
): boolean {
  for (let j = from; j <= to; j++) {
    const value = valueOf(candles[j], kind);

    if (kind === "high" ? value >= level : value <= level) {
      return false;
    }
  }

  return true;
}

/**
 * Все пивоты одного kind по массиву канонических свечей.
 * Возвращает в порядке сканирования (по anchor). Один и тот
 * же алгоритм используется для internal и swing слоёв —
 * отличается только StructureParams (left/right).
 */
export function findPivots(
  candles: SmcCandle[],
  params: StructureParams,
  kind: SmcPivotKind
): SmcPivot[] {
  const out: SmcPivot[] = [];
  const { left, right, layer, tf } = params;
  const lastIndex = candles.length - 1;

  let start = 0;

  while (start <= lastIndex) {
    const level = valueOf(candles[start], kind);

    // Расширяем plateau вправо по точному равенству.
    let end = start;

    while (
      end + 1 <= lastIndex &&
      valueOf(candles[end + 1], kind) === level
    ) {
      end += 1;
    }

    const hasLeft = start - left >= 0;
    const hasRight = end + right <= lastIndex;

    if (
      hasLeft &&
      hasRight &&
      contextStrictlyBeyond(
        candles,
        start - left,
        start - 1,
        level,
        kind
      ) &&
      contextStrictlyBeyond(
        candles,
        end + 1,
        end + right,
        level,
        kind
      )
    ) {
      const anchor = candles[start];

      out.push({
        key: smcPivotKey(
          tf,
          layer,
          kind,
          anchor.openTime.getTime()
        ),
        layer,
        kind,
        price: level,
        eventTime: anchor.openTime,
        confirmedAt: candles[end + right].effectiveCloseTime
      });
    }

    // Перепрыгиваем внутренность plateau: свечи середины
    // plateau никогда не являются отдельными пивотами.
    start = end + 1;
  }

  return out;
}
