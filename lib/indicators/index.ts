export function sma(
  values: number[],
  period: number
): number | null {
  const series = smaSeries(values, period);

  return series.length
    ? series[series.length - 1]
    : null;
}

/**
 * SMA-серия, выровненная по входу:
 * null пока не набрался период.
 */
export function smaSeries(
  values: number[],
  period: number
): (number | null)[] {
  const result: (number | null)[] = [];

  if (period <= 0) {
    return values.map(() => null);
  }

  let sum = 0;

  for (let i = 0; i < values.length; i++) {
    sum += values[i];

    if (i >= period) {
      sum -= values[i - period];
    }

    result.push(
      i >= period - 1 ? sum / period : null
    );
  }

  return result;
}

export function emaSeries(
  values: number[],
  period: number
): number[] {
  if (values.length < period || period <= 0) {
    return [];
  }

  const multiplier = 2 / (period + 1);

  const seed =
    values
      .slice(0, period)
      .reduce((sum, value) => sum + value, 0) /
    period;

  const result: number[] = [seed];

  let previous = seed;

  for (let i = period; i < values.length; i++) {
    const current =
      (values[i] - previous) * multiplier +
      previous;

    result.push(current);
    previous = current;
  }

  return result;
}

export function ema(
  values: number[],
  period: number
): number | null {
  const series = emaSeries(values, period);

  return series.length
    ? series[series.length - 1]
    : null;
}

/**
 * RSI-серия (метод Уайлдера), выровненная по входу:
 * null пока не набрался period+1 значений.
 * Значения совпадают с последовательными вызовами
 * классического алгоритма.
 */
export function rsiSeries(
  values: number[],
  period = 14
): (number | null)[] {
  const result: (number | null)[] = values.map(
    () => null
  );

  if (values.length < period + 1 || period <= 0) {
    return result;
  }

  let gain = 0;
  let loss = 0;

  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1];

    if (change >= 0) {
      gain += change;
    } else {
      loss += Math.abs(change);
    }
  }

  let avgGain = gain / period;
  let avgLoss = loss / period;

  result[period] = rsiFromAverages(
    avgGain,
    avgLoss
  );

  for (let i = period + 1; i < values.length; i++) {
    const change =
      values[i] - values[i - 1];

    const currentGain =
      change > 0 ? change : 0;

    const currentLoss =
      change < 0 ? Math.abs(change) : 0;

    avgGain =
      (avgGain * (period - 1) + currentGain) /
      period;

    avgLoss =
      (avgLoss * (period - 1) + currentLoss) /
      period;

    result[i] = rsiFromAverages(
      avgGain,
      avgLoss
    );
  }

  return result;
}

function rsiFromAverages(
  avgGain: number,
  avgLoss: number
): number {
  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

export function rsi(
  values: number[],
  period = 14
): number | null {
  const series = rsiSeries(values, period);
  const last = series[series.length - 1];

  return last === undefined ? null : last;
}

/**
 * MACD-серии (macd / signal / histogram),
 * выровненные по входу: null в зоне прогрева.
 */
export function macdSeries(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
): {
  macd: (number | null)[];
  signal: (number | null)[];
  histogram: (number | null)[];
} {
  const aligned: (number | null)[] =
    values.map(() => null);
  const alignedSignal: (number | null)[] =
    values.map(() => null);
  const alignedHist: (number | null)[] =
    values.map(() => null);

  if (
    values.length < slow + signalPeriod ||
    fast <= 0 ||
    slow <= 0 ||
    signalPeriod <= 0
  ) {
    return {
      macd: aligned,
      signal: alignedSignal,
      histogram: alignedHist
    };
  }

  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);

  const offset = slow - fast;

  const macdValues: number[] = [];

  for (let i = 0; i < slowSeries.length; i++) {
    const fastValue =
      fastSeries[i + offset];

    if (fastValue === undefined) {
      continue;
    }

    macdValues.push(
      fastValue - slowSeries[i]
    );
  }

  const signalSeries = emaSeries(
    macdValues,
    signalPeriod
  );

  /*
   * macdValues[j] соответствует индексу входа
   * j + slow - 1. Сигнальная EMA в точке j — это
   * signalSeries[j - (signalPeriod - 1)],
   * потому что emaSeries начинает серию с сидом
   * на позиции period - 1.
   */
  for (
    let j = 0;
    j < macdValues.length;
    j++
  ) {
    const index = j + slow - 1;

    if (index >= values.length) {
      break;
    }

    aligned[index] = macdValues[j];

    const signalIndex =
      j - (signalPeriod - 1);

    if (
      signalIndex >= 0 &&
      signalIndex < signalSeries.length
    ) {
      const signal =
        signalSeries[signalIndex];

      alignedSignal[index] = signal;
      alignedHist[index] =
        macdValues[j] - signal;
    }
  }

  return {
    macd: aligned,
    signal: alignedSignal,
    histogram: alignedHist
  };
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
) {
  const series = macdSeries(
    values,
    fast,
    slow,
    signalPeriod
  );

  const macdValue =
    series.macd[series.macd.length - 1];

  const signalValue =
    series.signal[series.signal.length - 1];

  const histogramValue =
    series.histogram[
      series.histogram.length - 1
    ];

  if (
    macdValue === null ||
    macdValue === undefined ||
    signalValue === null ||
    signalValue === undefined
  ) {
    return null;
  }

  return {
    macd: macdValue,
    signal: signalValue,
    histogram:
      histogramValue ??
      macdValue - signalValue
  };
}

/**
 * ATR-серия (метод Уайлдера), выровненная по свечам:
 * null пока не набрался period+1 свечей.
 */
export function atrSeries(
  candles: {
    high: number;
    low: number;
    close: number;
  }[],
  period = 14
): (number | null)[] {
  const result: (number | null)[] = candles.map(
    () => null
  );

  if (
    candles.length < period + 1 ||
    period <= 0
  ) {
    return result;
  }

  const trueRanges: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const current = candles[i];
    const previous = candles[i - 1];

    trueRanges.push(
      Math.max(
        current.high - current.low,
        Math.abs(
          current.high - previous.close
        ),
        Math.abs(
          current.low - previous.close
        )
      )
    );
  }

  let value =
    trueRanges
      .slice(0, period)
      .reduce((sum, tr) => sum + tr, 0) /
    period;

  result[period] = value;

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {
    value =
      (value * (period - 1) +
        trueRanges[i]) /
      period;

    result[i + 1] = value;
  }

  return result;
}

export function atr(
  candles: {
    high: number;
    low: number;
    close: number;
  }[],
  period = 14
): number | null {
  const series = atrSeries(candles, period);
  const last = series[series.length - 1];

  return last === undefined ? null : last;
}
