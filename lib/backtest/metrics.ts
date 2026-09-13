/**
 * P2-A — метрики.
 *
 * Политика (contract.ts, пункты 12 и 13):
 *  - ТОЛЬКО фактически исполненные сделки: skipped/rejected не влияют;
 *  - при нуле сделок все отношения/средние/медианы = null (0/0 ≠ 0);
 *  - profit factor считается по ЧИСТОМУ PnL; при нулевом знаменателе —
 *    null + profitFactorState, а не Infinity;
 *  - win ⇔ netPnl > 0; netPnl = 0 — breakeven (не win и не loss);
 *    breakeven прерывает серии выигрышей и проигрышей;
 *  - медиана для чётного числа — среднее двух центральных;
 *  - drawdown считается по ТРЁМ базам, каждая публикуется под своим
 *    именем (ничего не переименовано и не подменено):
 *      a) maxDrawdown / maxDrawdownPct — РЕАЛИЗОВАННАЯ эквити: точка на
 *         каждую закрытую сделку. Основная база;
 *      b) maxDrawdownMarkToMarket / …Pct — CLOSE-TO-CLOSE
 *         нереализованная: открытая позиция переоценивается по CLOSE
 *         каждого бара, будущая комиссия выхода не резервируется.
 *         Внутрибарные экстремумы не учитываются, поэтому эта база
 *         оптимистичнее (c);
 *      c) maxAdverseExcursionDrawdown / …Pct — КОНСЕРВАТИВНАЯ: та же
 *         переоценка, но по неблагоприятному экстремуму бара
 *         (LONG → low, SHORT → high). Показывает худший
 *         нереализованный спад, который мог наступить внутри бара;
 *  - equityNonPositive взводится, если ЛЮБАЯ из трёх баз уходила в ноль
 *    или ниже;
 *  - maxDrawdownPct = 0 (не null) при нулевой просадке и положительном
 *    первом значении эквити; null — только когда пик ≤ 0;
 *  - finalEquity равен ПОСЛЕДНЕЙ точке реализованной кривой эквити
 *    (а не initialEquity + totalNetPnl: порядок сложения float может
 *    расходиться в последних разрядах, а отчёт обязан быть
 *    самосогласованным);
 *  - profitFactorState = "no-losses" при отсутствии чистых убытков,
 *    ВКЛЮЧАЯ случай «все сделки в breakeven» (netPnl = 0): тогда PF =
 *    null, winRate = 0 и это не считается прибылью;
 *  - агрегаты считаются циклами, а НЕ Math.max(…arr) / Math.min(…arr):
 *    spread раскрывает аргументы в стековый кадр и падает с
 *    RangeError примерно на 150k+ записей.
 */

import {
  type BacktestBar,
  type BacktestMetrics,
  type BacktestTrade,
  type ExitReason,
  type ResolvedBacktestConfig
} from "./contract";
import { grossPnl } from "./costs";

export interface MetricsInput {
  readonly trades: readonly BacktestTrade[];
  readonly bars: readonly BacktestBar[];
  readonly startIndex: number;
  readonly endIndexExclusive: number;
  readonly config: ResolvedBacktestConfig;
}

const ZERO_EXIT_COUNTS: Record<ExitReason, number> = {
  STOP_LOSS: 0,
  TAKE_PROFIT: 0,
  TIMEOUT: 0,
  END_OF_DATA: 0,
  SEGMENT_END: 0
};

function sum(values: readonly number[]): number {
  let total = 0;

  for (const value of values) {
    total += value;
  }

  return total;
}

/**
 * Максимум циклом: null на пустом входе, без RangeError на больших
 * массивах (spread-вариант падает примерно на 150k+ элементах).
 */
function maxValue(values: readonly number[]): number | null {
  let best: number | null = null;

  for (const value of values) {
    if (best === null || value > best) {
      best = value;
    }
  }

  return best;
}

/** Минимум циклом: null на пустом входе (см. maxValue). */
function minValue(values: readonly number[]): number | null {
  let best: number | null = null;

  for (const value of values) {
    if (best === null || value < best) {
      best = value;
    }
  }

  return best;
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Точка кривой эквити: время + значение. */
interface EquitySample {
  readonly time: number;
  readonly equity: number;
}

/** Цена переоценки бара: close (MTM) либо неблагоприятный экстремум. */
type RevaluationPrice = "close" | "adverse-extreme";

/**
 * Эквити по барам окна: одна точка на бар.
 *
 * Реализованная часть — сумма netPnl сделок, закрытых на этом баре или
 * раньше; нереализованная — валовая переоценка открытой позиции:
 *  - "close" → close-to-close mark-to-market (база b);
 *  - "adverse-extreme" → по неблагоприятному экстремуму бара
 *    (LONG → low, SHORT → high) — консервативная база (c).
 *
 * Будущая комиссия выхода в обеих базах не резервируется (это
 * документированное приближение, а не «чистая» переоценка). Позиция на
 * баре закрытия считается уже закрытой (exitIndex <= i).
 */
function revaluedEquity(
  args: MetricsInput,
  price: RevaluationPrice
): readonly EquitySample[] {
  const { trades, bars, startIndex, endIndexExclusive, config } = args;
  const points: EquitySample[] = [];

  let realized = config.initialEquity;
  let cursor = 0;

  for (let i = startIndex; i < endIndexExclusive; i += 1) {
    const bar = bars[i];

    while (cursor < trades.length && trades[cursor].exitIndex <= i) {
      realized += trades[cursor].netPnl;
      cursor += 1;
    }

    const openTrade =
      cursor < trades.length && trades[cursor].entryIndex <= i
        ? trades[cursor]
        : null;

    const markPrice =
      openTrade === null
        ? bar.close
        : price === "close"
          ? bar.close
          : openTrade.direction === "LONG"
            ? bar.low
            : bar.high;

    const unrealized =
      openTrade === null
        ? 0
        : grossPnl(
            openTrade.direction,
            openTrade.entryPrice,
            markPrice,
            openTrade.quantity
          );

    points.push({ time: bar.time, equity: realized + unrealized });
  }

  return points;
}

/**
 * Close-to-close mark-to-market эквити (база b). Экспортируется для
 * тестов и для будущей отрисовки. НЕ учитывает внутрибарные
 * экстремумы — для этого есть adverseExcursionEquity.
 */
export function markToMarketEquity(
  args: MetricsInput
): readonly EquitySample[] {
  return revaluedEquity(args, "close");
}

/**
 * Консервативная эквити по неблагоприятному экстремуму бара
 * (LONG → low, SHORT → high) — база c: maxAdverseExcursionDrawdown.
 */
export function adverseExcursionEquity(
  args: MetricsInput
): readonly EquitySample[] {
  return revaluedEquity(args, "adverse-extreme");
}

/** Реализованная кривая эквити: старт + точка на каждую закрытую сделку. */
export function realizedEquity(
  trades: readonly BacktestTrade[],
  firstTime: number,
  initialEquity: number
): readonly EquitySample[] {
  const points: EquitySample[] = [{ time: firstTime, equity: initialEquity }];
  let equity = initialEquity;

  for (const trade of trades) {
    equity += trade.netPnl;
    points.push({ time: trade.exitTime, equity });
  }

  return points;
}

interface DrawdownStats {
  readonly maxDrawdown: number;
  readonly maxDrawdownPct: number | null;
  readonly peakTime: number | null;
  readonly troughTime: number | null;
  readonly equityNonPositive: boolean;
}

/**
 * Максимальная просадка по последовательности точек эквити.
 *
 * Процент берётся в точке максимального АБСОЛЮТНОГО спада (одно
 * событие, два представления). Если пик ≤ 0, процент не определён
 * (null) и взводится equityNonPositive.
 */
export function drawdownStats(
  points: readonly EquitySample[]
): DrawdownStats {
  if (points.length === 0) {
    return {
      maxDrawdown: 0,
      maxDrawdownPct: null,
      peakTime: null,
      troughTime: null,
      equityNonPositive: false
    };
  }

  let peak = points[0].equity;
  let peakTime = points[0].time;
  let maxDrawdown = 0;
  let maxDrawdownPct: number | null = peak > 0 ? 0 : null;
  let maxPeakTime: number | null = points[0].time;
  let maxTroughTime: number | null = points[0].time;
  let equityNonPositive = points[0].equity <= 0;

  for (const point of points) {
    if (point.equity > peak) {
      peak = point.equity;
      peakTime = point.time;
    }

    // Флаг означает «эквити уходила в ноль или ниже»: маржинальной
    // модели в P2-A нет, поэтому такой исход возможен и обязан быть
    // видимым в метриках, а не прятаться за «пик ≤ 0».
    if (point.equity <= 0) {
      equityNonPositive = true;
    }

    const drawdown = peak - point.equity;

    if (drawdown > maxDrawdown) {
      maxDrawdown = drawdown;
      maxDrawdownPct = peak > 0 ? (drawdown / peak) * 100 : null;
      maxPeakTime = peakTime;
      maxTroughTime = point.time;
    }
  }

  return {
    maxDrawdown,
    maxDrawdownPct,
    peakTime: maxPeakTime,
    troughTime: maxTroughTime,
    equityNonPositive
  };
}

/** Полный набор метрик по исполненным сделкам. */
export function computeBacktestMetrics(args: MetricsInput): BacktestMetrics {
  const { trades, bars, startIndex, config } = args;
  const count = trades.length;

  const wins = trades.filter((trade) => trade.netPnl > 0);
  const losses = trades.filter((trade) => trade.netPnl < 0);
  const breakeven = trades.filter((trade) => trade.netPnl === 0);

  const netValues = trades.map((trade) => trade.netPnl);
  const grossValues = trades.map((trade) => trade.grossPnl);
  const rValues = trades.map((trade) => trade.rMultiple);
  const grossRValues = trades.map((trade) => trade.grossR);
  // Диагностика по фактическому исполнению (знаменатель — риск от
  // реальной цены входа): публикуется отдельно от планового R.
  const rActualFillValues = trades.map((trade) => trade.rMultipleActualFill);
  const winNetValues = wins.map((trade) => trade.netPnl);
  const lossNetValues = losses.map((trade) => trade.netPnl);

  const totalGrossPnl = sum(grossValues);
  const totalNetPnl = sum(netValues);
  const netWinTotal = sum(winNetValues);
  const netLossTotal = Math.abs(sum(lossNetValues));
  const grossWinTotal = sum(grossValues.filter((value) => value > 0));
  const grossLossTotal = Math.abs(sum(grossValues.filter((value) => value < 0)));

  let profitFactor: number | null = null;
  let profitFactorState: BacktestMetrics["profitFactorState"];

  if (count === 0) {
    profitFactorState = "no-trades";
  } else if (netLossTotal > 0) {
    profitFactor = netWinTotal / netLossTotal;
    profitFactorState = "ok";
  } else {
    // Чистых убытков нет: PF не определён (деление на ноль), Infinity
    // в JSON не сериализуется и не используется.
    profitFactorState = "no-losses";
  }

  let maxConsecutiveWins = 0;
  let maxConsecutiveLosses = 0;
  let currentWins = 0;
  let currentLosses = 0;

  for (const trade of trades) {
    if (trade.netPnl > 0) {
      currentWins += 1;
      currentLosses = 0;
      maxConsecutiveWins = Math.max(maxConsecutiveWins, currentWins);
    } else if (trade.netPnl < 0) {
      currentLosses += 1;
      currentWins = 0;
      maxConsecutiveLosses = Math.max(maxConsecutiveLosses, currentLosses);
    } else {
      // Breakeven прерывает обе серии: это не выигрыш и не убыток.
      currentWins = 0;
      currentLosses = 0;
    }
  }

  const exitReasonCounts: Record<ExitReason, number> = { ...ZERO_EXIT_COUNTS };

  for (const trade of trades) {
    exitReasonCounts[trade.exitReason] += 1;
  }

  const firstTime =
    bars.length > 0 && startIndex < bars.length
      ? bars[startIndex].time
      : trades.length > 0
        ? trades[0].entryTime
        : 0;

  const realizedPoints = realizedEquity(
    trades,
    firstTime,
    config.initialEquity
  );
  const realizedStats = drawdownStats(realizedPoints);
  const markToMarketStats = drawdownStats(markToMarketEquity(args));
  const adverseStats = drawdownStats(adverseExcursionEquity(args));
  const barsHeld = trades.map((trade) => trade.barsHeld);
  const maxBarsHeld = maxValue(barsHeld);

  return {
    trades: count,
    longTrades: trades.filter((trade) => trade.direction === "LONG").length,
    shortTrades: trades.filter((trade) => trade.direction === "SHORT").length,
    wins: wins.length,
    losses: losses.length,
    breakeven: breakeven.length,
    winRate: count === 0 ? null : (wins.length / count) * 100,
    totalGrossPnl,
    totalNetPnl,
    totalFees: sum(trades.map((trade) => trade.feesTotal)),
    totalSlippageCost: sum(trades.map((trade) => trade.slippageCost)),
    netWinTotal,
    netLossTotal,
    grossWinTotal,
    grossLossTotal,
    profitFactor,
    profitFactorState,
    expectancy: count === 0 ? null : totalNetPnl / count,
    avgR: mean(rValues),
    medianR: median(rValues),
    avgRActualFill: mean(rActualFillValues),
    medianRActualFill: median(rActualFillValues),
    avgWin: mean(winNetValues),
    avgLoss: mean(lossNetValues),
    largestWin: maxValue(winNetValues),
    largestLoss: minValue(lossNetValues),
    avgGrossR: mean(grossRValues),
    medianGrossR: median(grossRValues),
    maxConsecutiveWins,
    maxConsecutiveLosses,
    avgBarsHeld: mean(barsHeld),
    maxBarsHeld: maxBarsHeld === null ? 0 : maxBarsHeld,
    exitReasonCounts: Object.freeze(exitReasonCounts),
    sameBarAmbiguityTrades: trades.filter((trade) => trade.sameBarAmbiguity)
      .length,
    gapThroughTrades: trades.filter((trade) => trade.gapThrough).length,
    openAtEndTrades:
      exitReasonCounts.END_OF_DATA + exitReasonCounts.SEGMENT_END,
    // Самосогласованность отчёта: финал эквити = последняя точка
    // реализованной кривой (тот же порядок float-сложения).
    finalEquity: realizedPoints[realizedPoints.length - 1].equity,
    maxDrawdown: realizedStats.maxDrawdown,
    maxDrawdownPct: realizedStats.maxDrawdownPct,
    maxDrawdownPeakTime: realizedStats.peakTime,
    maxDrawdownTroughTime: realizedStats.troughTime,
    maxDrawdownMarkToMarket: markToMarketStats.maxDrawdown,
    maxDrawdownMarkToMarketPct: markToMarketStats.maxDrawdownPct,
    maxAdverseExcursionDrawdown: adverseStats.maxDrawdown,
    maxAdverseExcursionDrawdownPct: adverseStats.maxDrawdownPct,
    equityNonPositive:
      realizedStats.equityNonPositive ||
      markToMarketStats.equityNonPositive ||
      adverseStats.equityNonPositive
  };
}
