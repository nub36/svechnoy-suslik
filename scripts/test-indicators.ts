/**
 * Индикаторы — численные тесты соответствия.
 *
 * Цель: доказать, что macdSeries()/macd() считают MACD,
 * signal и histogram РОВНО как эталонный алгоритм
 * production до c14c97b:
 *
 *   fastSeries = emaSeries(values, fast)
 *   slowSeries = emaSeries(values, slow)
 *   macdValues[i] = fastSeries[i + (slow - fast)] - slowSeries[i]
 *   expectedSignal    = ema(macdValues, signal)
 *   expectedMacd      = последний macdValues
 *   expectedHistogram = expectedMacd - expectedSignal
 *
 * Ключевой факт о выравнивании (проверяется тестами ниже):
 * emaSeries возвращает КОМПАКТНЫЙ массив без null:
 * emaSeries(values, p)[k] соответствует входному индексу
 * (p - 1) + k. Поэтому signal в точке macdValues[j] — это
 * signalSeries[j - (signalPeriod - 1)]. Вариант
 * signalSeries[j] читал бы macdValues[j + signalPeriod - 1] —
 * ЗНАЧЕНИЕ ИЗ БУДУЩЕГО (look-ahead), а на хвосте —
 * undefined. Тесты A/B фиксируют правильное размещение.
 *
 * Запуск:
 *   npx tsx scripts/test-indicators.ts --self-test
 */

import {
  atr,
  atrSeries,
  ema,
  emaSeries,
  macd,
  macdSeries,
  rsi,
  rsiSeries,
  sma,
  smaSeries
} from "../lib/indicators";

type Check = { name: string; ok: boolean };

/* ================================================================
 * Детерминированный генератор (LCG) — воспроизводимость.
 * ================================================================ */

function makeRng(seed: number) {
  let state = seed % 2147483647;

  if (state <= 0) {
    state += 2147483646;
  }

  return () => {
    state =
      (state * 16807) % 2147483647;

    return (state - 1) / 2147483646;
  };
}

function makeValues(
  length: number,
  seed: number
): number[] {
  const rng = makeRng(seed);

  let price = 100;

  return Array.from(
    { length },
    () => {
      price =
        price *
        (1 + (rng() - 0.5) / 40);

      return Math.round(price * 100) / 100;
    }
  );
}

/* ================================================================
 * Эталонный алгоритм production до c14c97b.
 * Использует примитивы emaSeries/ema ровно так,
 * как это делал старый скалярный macd().
 * ================================================================ */

function referenceMacd(
  values: number[],
  fast: number,
  slow: number,
  signalPeriod: number
): {
  macdValues: number[];
  expectedMacd: number;
  expectedSignal: number;
  expectedHistogram: number;
  /** macdValues[j] -> входной индекс. */
  indexOfMacdValue: (j: number) => number;
} | null {
  if (
    values.length <
    slow + signalPeriod
  ) {
    return null;
  }

  const fastSeries = emaSeries(
    values,
    fast
  );
  const slowSeries = emaSeries(
    values,
    slow
  );

  const offset = slow - fast;

  const macdValues: number[] = [];

  for (
    let i = 0;
    i < slowSeries.length;
    i++
  ) {
    const fastValue =
      fastSeries[i + offset];

    if (fastValue === undefined) {
      continue;
    }

    macdValues.push(
      fastValue - slowSeries[i]
    );
  }

  const expectedSignal = ema(
    macdValues,
    signalPeriod
  );

  if (
    expectedSignal === null ||
    macdValues.length === 0
  ) {
    return null;
  }

  const expectedMacd =
    macdValues[macdValues.length - 1];

  return {
    macdValues,
    expectedMacd,
    expectedSignal,
    expectedHistogram:
      expectedMacd - expectedSignal,

    indexOfMacdValue: (
      j: number
    ) => j + slow - 1
  };
}

/* ================================================================
 * A. Численная эквивалентность последнего результата
 *    и ПОЭЛЕМЕНТНОЕ совпадение всей выравненной серии.
 * ================================================================ */

function runReferenceEquivalence(
  add: (name: string, ok: boolean) => void
): void {
  const combos: [
    number,
    number,
    number
  ][] = [
    [12, 26, 9],
    [5, 35, 7],
    [8, 17, 9]
  ];

  for (const [
    fast,
    slow,
    signalPeriod
  ] of combos) {
    // Первая длина — ровно минимум guard (slow + signal):
    // дополнительная граничная проверка на каждый набор.
    const lengths = [
      slow + signalPeriod,
      100,
      300,
      1000
    ];

    for (const length of lengths) {
      const values = makeValues(
        length,
        fast * 1000 + slow * 10 + signalPeriod + length
      );

      const reference = referenceMacd(
        values,
        fast,
        slow,
        signalPeriod
      );

      const label = `MACD ${fast}/${slow}/${signalPeriod} × ${length}`;

      if (!reference) {
        add(
          `${label}: эталон вернул null (недостаточно истории)`,
          false
        );

        continue;
      }

      const scalar = macd(
        values,
        fast,
        slow,
        signalPeriod
      );

      add(
        `${label}: macd().macd === ожидаемый (${reference.expectedMacd.toFixed(6)})`,
        scalar !== null &&
          scalar.macd ===
            reference.expectedMacd
      );

      add(
        `${label}: macd().signal === ожидаемый (${reference.expectedSignal.toFixed(6)})`,
        scalar !== null &&
          scalar.signal ===
            reference.expectedSignal
      );

      add(
        `${label}: macd().histogram === ожидаемый (${reference.expectedHistogram.toFixed(6)})`,
        scalar !== null &&
          scalar.histogram ===
            reference.expectedHistogram
      );

      /*
       * Поэлементная проверка выравнивания: macdSeries
       * возвращает массивы, выровненные по входным
       * индексам (null в зоне прогрева). Для предложенного
       * в ревью варианта signalSeries[j] этот тест
       * провалился бы: signal сдвинулся бы на
       * signalPeriod-1 свечей в будущее, а на хвосте
       * исчез бы вовсе.
       */
      const series = macdSeries(
        values,
        fast,
        slow,
        signalPeriod
      );

      const refSignalSeries = emaSeries(
        reference.macdValues,
        signalPeriod
      );

      let macdOk = true;
      let signalOk = true;
      let histOk = true;

      for (
        let j = 0;
        j < reference.macdValues.length;
        j++
      ) {
        const inputIndex =
          reference.indexOfMacdValue(j);

        // MACD-линия в точности на своей свече
        if (
          series.macd[inputIndex] !==
          reference.macdValues[j]
        ) {
          macdOk = false;
          break;
        }

        const signalIndex =
          j - (signalPeriod - 1);

        if (signalIndex >= 0) {
          const expectedSignal =
            refSignalSeries[signalIndex];

          if (
            series.signal[inputIndex] !==
              expectedSignal ||
            series.histogram[inputIndex] !==
              reference.macdValues[j] -
                expectedSignal
          ) {
            signalOk = false;
            histOk = false;
            break;
          }
        } else if (
          series.signal[inputIndex] !== null ||
          series.histogram[inputIndex] !== null
        ) {
          // signal раньше времени прогрева —
          // значит есть заглядывание в будущее
          signalOk = false;
          histOk = false;
          break;
        }
      }

      // За последним macd-значением всё должно быть null
      const lastInputIndex =
        reference.indexOfMacdValue(
          reference.macdValues.length - 1
        );

      const tailClean =
        series.macd
          .slice(lastInputIndex + 1)
          .every((x) => x === null) &&
        series.signal
          .slice(lastInputIndex + 1)
          .every((x) => x === null);

      // До slow-1 всё null
      const headClean = series.macd
        .slice(0, slow - 1)
        .every((x) => x === null);

      add(
        `${label}: macd-серия поэлементно совпадает с эталоном на своих свечах`,
        macdOk && headClean && tailClean
      );

      add(
        `${label}: signal/histogram поэлементно совпадают без заглядывания в будущее`,
        signalOk && histOk
      );
    }
  }
}

/* ================================================================
 * B. Границы размещения (12/26/9):
 *    macdValues[0] -> вход 25;
 *    первый signal -> j=8 -> вход 33;
 *    guard macd(): N >= slow + signal = 35.
 * ================================================================ */

function runBoundaryPlacement(
  add: (name: string, ok: boolean) => void
): void {
  const [fast, slow, signalPeriod] = [
    12, 26, 9
  ];

  // N = 34: математически signal появился бы,
  // но guard macd() гасит весь результат
  {
    const values = makeValues(34, 34001);

    const series = macdSeries(
      values,
      fast,
      slow,
      signalPeriod
    );

    const scalar = macd(
      values,
      fast,
      slow,
      signalPeriod
    );

    add(
      "N=34: guard slow+signal — macd() = null, серии полностью null",
      scalar === null &&
        series.macd.length === 34 &&
        series.macd.every((x) => x === null) &&
        series.signal.every((x) => x === null) &&
        series.histogram.every((x) => x === null)
    );
  }

  // N = 35: минимальная история с ненулевым результатом
  {
    const values = makeValues(35, 35001);

    const series = macdSeries(
      values,
      fast,
      slow,
      signalPeriod
    );

    const reference = referenceMacd(
      values,
      fast,
      slow,
      signalPeriod
    );

    add(
      "N=35: macd на последней свече (вход 34) === последний macdValues",
      reference !== null &&
        series.macd[34] ===
          reference.expectedMacd
    );

    add(
      "N=35: signal на последней свече (вход 34) === ema(macdValues, 9)",
      reference !== null &&
        series.signal[34] ===
          reference.expectedSignal
    );

    add(
      "N=35: macd впервые на входе 25, signal впервые на входе 33",
      series.macd.slice(0, 25).every((x) => x === null) &&
        series.macd[25] !== null &&
        series.signal.slice(0, 33).every((x) => x === null) &&
        series.signal[33] !== null
    );
  }

  // N = 40: первое появление signal — ТОЧНО на входе 33,
  // на предыдущей свече (32) signal ещё null.
  {
    const values = makeValues(40, 40001);

    const series = macdSeries(
      values,
      fast,
      slow,
      signalPeriod
    );

    const firstMacdIndex =
      series.macd.findIndex(
        (x) => x !== null
      );

    const firstSignalIndex =
      series.signal.findIndex(
        (x) => x !== null
      );

    const at33 = series.signal[33];

    const reference = referenceMacd(
      values,
      fast,
      slow,
      signalPeriod
    );

    const expectedSignalAt33 =
      reference === null
        ? NaN
        : emaSeries(
            reference.macdValues,
            signalPeriod
          )[0];

    add(
      "N=40: macd начинается ровно на входе 25 (slow-1)",
      firstMacdIndex === 25
    );

    add(
      "N=40: signal впервые появляется ровно на входе 33 (j=8)",
      firstSignalIndex === 33 &&
        at33 === expectedSignalAt33
    );

    add(
      "N=40: на предыдущей свече (вход 32) signal ещё null",
      series.signal[32] === null
    );
  }

  // Малый недегенеративный случай 3/5/2 на [1..10]:
  // macd с входа 4, signal с входа 5, значения сверены.
  {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    const series = macdSeries(
      values,
      3,
      5,
      2
    );

    const scalar = macd(values, 3, 5, 2);

    // эталон вручную: fast=[2,3,4,5,6,7,8,9], slow=[3,4,5,6,7,8],
    // macdValues=[1,1,1,1,1,1] (вход 4..9), signal=ema(...,2)=1
    add(
      "3/5/2 на [1..10]: macd с входа 4, signal с входа 5, macd() = {1, 1, 0}",
      series.macd[4] === 1 &&
        series.macd[3] === null &&
        series.signal[5] === 1 &&
        series.signal[4] === null &&
        scalar !== null &&
        scalar.macd === 1 &&
        scalar.signal === 1 &&
        scalar.histogram === 0
    );
  }
}

/* ================================================================
 * C. Обратная совместимость скалярного API
 *    против НЕЗАВИСИМЫХ реализаций
 *    (другой порядок операций => допуск 1e-9).
 * ================================================================ */

function refSma(
  values: number[],
  period: number
): number | null {
  if (values.length < period) {
    return null;
  }

  let sum = 0;

  for (
    let i = values.length - period;
    i < values.length;
    i++
  ) {
    sum += values[i];
  }

  return sum / period;
}

function refEma(
  values: number[],
  period: number
): number | null {
  if (values.length < period) {
    return null;
  }

  const k = 2 / (period + 1);

  let e = 0;

  for (let i = 0; i < period; i++) {
    e += values[i];
  }

  e /= period;

  for (
    let i = period;
    i < values.length;
    i++
  ) {
    // Алгебраически та же формула, другой порядок:
    // k*x + (1-k)*e вместо (x-e)*k + e.
    e = k * values[i] + (1 - k) * e;
  }

  return e;
}

function refRsi(
  values: number[],
  period: number
): number | null {
  if (values.length < period + 1) {
    return null;
  }

  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change =
      values[i] - values[i - 1];

    avgGain +=
      change > 0 ? change : 0;
    avgLoss +=
      change < 0 ? -change : 0;
  }

  avgGain /= period;
  avgLoss /= period;

  for (
    let i = period + 1;
    i < values.length;
    i++
  ) {
    const change =
      values[i] - values[i - 1];

    avgGain =
      (avgGain * (period - 1) +
        (change > 0 ? change : 0)) /
      period;

    avgLoss =
      (avgLoss * (period - 1) +
        (change < 0 ? -change : 0)) /
      period;
  }

  if (avgLoss === 0) {
    return 100;
  }

  const rs = avgGain / avgLoss;

  return 100 - 100 / (1 + rs);
}

function refAtr(
  candles: {
    high: number;
    low: number;
    close: number;
  }[],
  period: number
): number | null {
  if (candles.length < period + 1) {
    return null;
  }

  const tr: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    tr.push(
      Math.max(
        candles[i].high - candles[i].low,
        Math.abs(
          candles[i].high -
            candles[i - 1].close
        ),
        Math.abs(
          candles[i].low -
            candles[i - 1].close
        )
      )
    );
  }

  let value = 0;

  for (let i = 0; i < period; i++) {
    value += tr[i];
  }

  value /= period;

  for (let i = period; i < tr.length; i++) {
    value =
      (value * (period - 1) + tr[i]) /
      period;
  }

  return value;
}

function closeTo(
  a: number | null,
  b: number | null,
  tol = 1e-9
): boolean {
  if (a === null || b === null) {
    return a === b;
  }

  const scale = Math.max(
    Math.abs(a),
    Math.abs(b),
    1e-12
  );

  return (
    Math.abs(a - b) / scale <= tol
  );
}

function runScalarCompatibility(
  add: (name: string, ok: boolean) => void
): void {
  let smaOk = 0;
  let emaOk = 0;
  let rsiOk = 0;
  let atrOk = 0;
  let macdOk = 0;
  const total = 150;

  for (let t = 0; t < total; t++) {
    const n =
      30 +
      Math.floor(
        makeRng(t + 1)() * 400
      );

    const rng = makeRng(t + 7777);

    let price = 50 + rng() * 100;

    const values: number[] = [];

    const candles: {
      high: number;
      low: number;
      close: number;
    }[] = [];

    for (let i = 0; i < n; i++) {
      price *= 1 + (rng() - 0.5) / 25;

      const close =
        Math.round(price * 100) / 100;

      values.push(close);

      const prev =
        values[i - 1] ?? close;

      candles.push({
        high:
          Math.max(close, prev) *
          (1 + rng() / 200),
        low:
          Math.min(close, prev) *
          (1 - rng() / 200),
        close
      });
    }

    const periods = [5, 14, 20, 50, 200];

    if (
      periods.every((p) =>
        closeTo(
          sma(values, p),
          refSma(values, p)
        )
      )
    ) {
      smaOk++;
    }

    if (
      periods.every((p) =>
        closeTo(
          ema(values, p),
          refEma(values, p)
        )
      )
    ) {
      emaOk++;
    }

    if (
      periods.every((p) =>
        closeTo(
          rsi(values, p),
          refRsi(values, p)
        )
      )
    ) {
      rsiOk++;
    }

    if (
      periods.every((p) =>
        closeTo(
          atr(candles, p),
          refAtr(candles, p)
        )
      )
    ) {
      atrOk++;
    }

    const combos: [
      number,
      number,
      number
    ][] = [
      [12, 26, 9],
      [5, 35, 7],
      [8, 17, 9]
    ];

    const refMacdOk = combos.every(
      ([f, s, g]) => {
        const got = macd(
          values,
          f,
          s,
          g
        );

        const reference =
          referenceMacd(
            values,
            f,
            s,
            g
          );

        if (reference === null) {
          return got === null;
        }

        return (
          got !== null &&
          closeTo(
            got.macd,
            reference.expectedMacd,
            1e-12
          ) &&
          closeTo(
            got.signal,
            reference.expectedSignal,
            1e-12
          ) &&
          closeTo(
            got.histogram,
            reference.expectedHistogram,
            1e-12
          )
        );
      }
    );

    if (refMacdOk) {
      macdOk++;
    }
  }

  add(
    `sma(): ${smaOk}/${total} наборов совпали с независимым эталоном`,
    smaOk === total
  );
  add(
    `ema(): ${emaOk}/${total} наборов совпали с независимым эталоном`,
    emaOk === total
  );
  add(
    `rsi(): ${rsiOk}/${total} наборов совпали с независимым эталоном`,
    rsiOk === total
  );
  add(
    `atr(): ${atrOk}/${total} наборов совпали с независимым эталоном`,
    atrOk === total
  );
  add(
    `macd(): ${macdOk}/${total} наборов совпали с эталоном старого алгоритма`,
    macdOk === total
  );

  // Серии согласованы со своими скалярными версиями
  // на одних и тех же данных.
  const values = makeValues(250, 999);

  const candles = values.map((close, i) => ({
    high: close * 1.01,
    low: close * 0.99,
    close
  }));

  let seriesConsistent = true;

  const periodList = [5, 14, 20, 50, 200];

  for (const p of periodList) {
    if (
      !closeTo(
        sma(values, p),
        smaSeries(values, p).at(-1) ??
          null
      ) ||
      !closeTo(
        ema(values, p),
        emaSeries(values, p).at(-1) ??
          null
      ) ||
      !closeTo(
        rsi(values, p),
        rsiSeries(values, p).at(-1) ??
          null
      ) ||
      !closeTo(
        atr(candles, p),
        atrSeries(candles, p).at(-1) ??
          null
      )
    ) {
      seriesConsistent = false;
    }
  }

  add(
    "серии согласованы со скалярными sma/ema/rsi/atr (250 значений)",
    seriesConsistent
  );
}

/* ================================================================
 * Запуск
 * ================================================================ */

function main(): void {
  console.log(
    "Индикаторы — численные тесты соответствия\n"
  );

  const checks: Check[] = [];

  const add = (name: string, ok: boolean) =>
    checks.push({ name, ok });

  runReferenceEquivalence(add);
  runBoundaryPlacement(add);
  runScalarCompatibility(add);

  const passed = checks.filter(
    (c) => c.ok
  ).length;

  for (const c of checks) {
    console.log(
      `${c.ok ? "✓" : "✗"} ${c.name}`
    );
  }

  console.log(
    `\nItog: ${passed}/${checks.length}`
  );

  if (passed !== checks.length) {
    process.exit(1);
  }
}

main();
