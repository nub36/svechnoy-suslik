export function sma(
  values: number[],
  period: number
): number | null {
  if (values.length < period || period <= 0) {
    return null;
  }

  const slice = values.slice(-period);

  return (
    slice.reduce((sum, value) => sum + value, 0) /
    period
  );
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

export function rsi(
  values: number[],
  period = 14
): number | null {
  if (values.length < period + 1) {
    return null;
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

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1];

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
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

export function macd(
  values: number[],
  fast = 12,
  slow = 26,
  signalPeriod = 9
) {
  if (values.length < slow + signalPeriod) {
    return null;
  }

  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);

  const offset = slow - fast;

  const macdSeries: number[] = [];

  for (let i = 0; i < slowSeries.length; i++) {
    const fastValue =
      fastSeries[i + offset];

    if (fastValue === undefined) {
      continue;
    }

    macdSeries.push(
      fastValue - slowSeries[i]
    );
  }

  const signal = ema(
    macdSeries,
    signalPeriod
  );

  if (
    signal === null ||
    macdSeries.length === 0
  ) {
    return null;
  }

  const value =
    macdSeries[macdSeries.length - 1];

  return {
    macd: value,
    signal,
    histogram: value - signal
  };
}

export function atr(
  candles: {
    high: number;
    low: number;
    close: number;
  }[],
  period = 14
): number | null {
  if (candles.length < period + 1) {
    return null;
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

  for (
    let i = period;
    i < trueRanges.length;
    i++
  ) {
    value =
      (value * (period - 1) +
        trueRanges[i]) /
      period;
  }

  return value;
}
