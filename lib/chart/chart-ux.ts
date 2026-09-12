/**
 * Chart UX собственного SuslikChart: штатная interaction-модель
 * lightweight-charts ^5.2.1, геометрия легенды и сохранение ручного
 * viewport при подгрузке истории.
 *
 * Чистая логика: без React, без DOM, без Prisma, без fetch — поэтому
 * детерминированно тестируется в scripts/test-chart-ux.ts.
 *
 * ВАЖНО: собственной «физики» drag/zoom здесь НЕТ и не появляется.
 * Библиотека уже умеет всё необходимое; модуль лишь
 *  1) фиксирует ЯВНЫЕ значения документированных options
 *     (handleScroll / handleScale / kineticScroll / rightPriceScale /
 *     timeScale), чтобы навигация не зависела от молчаливых дефолтов;
 *  2) считает, сколько пикселей легенда имеет права занять, чтобы не
 *     залезать на правую ценовую шкалу — по ФАКТИЧЕСКОЙ ширине
 *     plot-области и шкалы (chart.timeScale().width() и
 *     chart.priceScale("right").width()), без hardcoded координат;
 *  3) считает сдвиг видимого логического диапазона при слиянии более
 *     старой истории, чтобы ручной уход назад в историю не сбрасывался;
 *  4) задаёт ВЕРТИКАЛЬНЫЙ масштаб основной панели: явные scaleMargins
 *     и штатный autoscaleInfoProvider с запасом по видимым high/low
 *     (AUTO-режим), не ограничивая ручной drag по ценовой шкале.
 *
 * Семантика options взята из установленного lightweight-charts 5.2.1
 * (dist/typings.d.ts): handleScroll.mouseWheel реагирует на deltaX
 * (горизонтальный свайп/колесо), handleScale.mouseWheel — на deltaY
 * (zoom в точке курсора), то есть оси не конфликтуют; вертикального
 * zoom'а колесом в модели библиотеки НЕТ — цена масштабируется только
 * drag'ом по ценовой шкале (см. chartGestureBindings).
 *
 * Выводы по вертикальному масштабу подтверждены аудитом исходника
 * установленной версии (dist/lightweight-charts.development.mjs):
 *  - PriceScale._private__topMarginPx/_bottomMarginPx и
 *    _private__logicalToCoordinate: scaleMargins участвуют в mapping'е
 *    координат ВСЕГДА (и в auto-, и в ручном режиме);
 *  - PriceScale._private__recalculatePriceRangeImpl: в ручном режиме
 *    (isCustomPriceRange() && !isAutoScale()) пересчёт НЕ выполняется,
 *    поэтому autoscaleInfoProvider в ручном режиме не вызывается;
 *  - Model._internal_applyPriceScaleOptions("right", …) применяет опции
 *    ко ВСЕМ панелям, поэтому отступы основной панели задаются через
 *    шкалу самой серии свечей (pane 0), а не chart-level.
 */
import type {
  AutoscaleInfo,
  AutoscaleInfoProvider,
  DeepPartial,
  HandleScaleOptions,
  HandleScrollOptions,
  KineticScrollOptions,
  PriceScaleMargins,
  TimeScaleOptions,
  VisiblePriceScaleOptions
} from "lightweight-charts";

/* ------------------------------------------------------------------ */
/* 1. Навигация и масштаб: документированные interaction options       */
/* ------------------------------------------------------------------ */

/**
 * Перемещение по истории (горизонтальная навигация).
 *
 * - pressedMouseMove: click+drag внутри plot → горизонтальное
 *   перемещение по истории (штатное поведение библиотеки);
 * - mouseWheel: deltaX колеса/тачпада (горизонтальный свайп) →
 *   перемещение по истории; deltaY при этом уходит в handleScale
 *   (zoom), поэтому оба флага включены и не конфликтуют;
 * - horzTouchDrag: touch-драг по горизонтали → история;
 * - vertTouchDrag: ВЫКЛЮЧЕН сознательно — график встроен в длинную
 *   страницу /coin/[symbol], и вертикальный touch-свайп обязан
 *   прокручивать страницу, а не «ловиться» ценовой шкалой.
 */
export const SUSLIK_HANDLE_SCROLL: HandleScrollOptions = {
  mouseWheel: true,
  pressedMouseMove: true,
  horzTouchDrag: true,
  vertTouchDrag: false
};

/**
 * Масштабирование по времени и по цене.
 *
 * - mouseWheel: deltaY колеса → zoom временной шкалы в точке курсора;
 * - pinch: touch-щипок → zoom (нормальное поведение на мобильных);
 * - axisPressedMouseMove.time: драг по оси времени → визуально
 *   расширить/сжать временную шкалу;
 * - axisPressedMouseMove.price: драг по правой ценовой шкале →
 *   изменение вертикального масштаба ШТАТНЫМ способом библиотеки
 *   (собственная реализация price-pan не нужна и не добавляется);
 * - axisDoubleClickReset.time/.price: двойной клик по оси времени или
 *   по ценовой шкале возвращает auto/default scale — тот же результат,
 *   что и кнопка «Сбросить масштаб».
 */
export const SUSLIK_HANDLE_SCALE: HandleScaleOptions = {
  mouseWheel: true,
  pinch: true,
  axisPressedMouseMove: { time: true, price: true },
  axisDoubleClickReset: { time: true, price: true }
};

/**
 * Инерционная прокрутка: на touch — штатная (kinetic), мышью — без
 * инерции, чтобы drag по истории был точным.
 */
export const SUSLIK_KINETIC_SCROLL: KineticScrollOptions = {
  mouse: false,
  touch: true
};

/**
 * Правая ценовая шкала: видима, auto-scale по умолчанию (сброс
 * масштаба возвращает именно его), подписи выровнены, а крайние метки
 * не обрезаются — критичные price labels не должны пропадать.
 */
export const SUSLIK_RIGHT_PRICE_SCALE: DeepPartial<VisiblePriceScaleOptions> = {
  visible: true,
  autoScale: true,
  alignLabels: true,
  borderVisible: true,
  ticksVisible: false,
  ensureEdgeTickMarksVisible: true
};

/**
 * Временная шкала: оба края СВОБОДНЫ.
 *
 * fixLeftEdge/fixRightEdge включёнными делать нельзя: история
 * подгружается слева (курсор по openTime), а возврат к последним барам
 * выполняется timeScale().scrollToRealTime() — штатные «фиксации» края
 * заблокировали бы и то, и другое. rightBarStaysOnScroll оставлен
 * выключенным (дефолт библиотеки): при прокрутке правый бар не
 * «прилипает», иначе ручная история вела бы себя непредсказуемо.
 */
export const SUSLIK_TIME_SCALE_NAVIGATION: DeepPartial<TimeScaleOptions> = {
  fixLeftEdge: false,
  fixRightEdge: false,
  rightBarStaysOnScroll: false
};

export interface ChartGestureBinding {
  /** Пользовательское действие. */
  gesture: string;
  /** Какая ось задействована. */
  axis: "time" | "price";
  /** Что происходит. */
  action: string;
  /** Включено ли соответствующей штатной опцией. */
  enabled: boolean;
}

/**
 * Соответствие «жест → штатная опция lightweight-charts 5.2.1».
 *
 * Ключевое разделение: колесо/свайп над plot — это ВСЕГДА время
 * (deltaY → handleScale.mouseWheel = zoom временной шкалы, deltaX →
 * handleScroll.mouseWheel = движение по истории). Вертикального zoom'а
 * колесом в модели библиотеки нет, поэтому price-масштаб колесом
 * подменён быть не может: цена масштабируется только drag'ом по правой
 * ценовой шкале (handleScale.axisPressedMouseMove.price) и возвращается
 * в auto-scale двойным кликом по ней либо кнопкой сброса.
 */
/**
 * Штатная нормализация библиотеки: axisPressedMouseMove и
 * axisDoubleClickReset могут быть заданы одним boolean — тогда он
 * относится сразу к обеим осям (см. разбор options в lightweight-charts
 * 5.2.1: isBoolean(axisPressedMouseMove) → { time, price }).
 */
function axisFlags(
  value: boolean | { time: boolean; price: boolean }
): { time: boolean; price: boolean } {
  if (typeof value === "boolean") {
    return { time: value, price: value };
  }

  return { time: value.time, price: value.price };
}

export function chartGestureBindings(
  scroll: HandleScrollOptions,
  scale: HandleScaleOptions
): ChartGestureBinding[] {
  const axisMove = axisFlags(scale.axisPressedMouseMove);
  const doubleClick = axisFlags(scale.axisDoubleClickReset);

  return [
    {
      gesture: "drag по plot",
      axis: "time",
      action: "движение по истории",
      enabled: scroll.pressedMouseMove
    },
    {
      gesture: "колесо/свайп deltaY",
      axis: "time",
      action: "zoom временной шкалы в точке курсора",
      enabled: scale.mouseWheel
    },
    {
      gesture: "колесо/свайп deltaX",
      axis: "time",
      action: "движение по истории",
      enabled: scroll.mouseWheel
    },
    {
      gesture: "drag по оси времени",
      axis: "time",
      action: "растянуть/сжать временную шкалу",
      enabled: axisMove.time
    },
    {
      gesture: "drag по правой ценовой шкале",
      axis: "price",
      action: "вертикальный масштаб: сжать/растянуть цену",
      enabled: axisMove.price
    },
    {
      gesture: "pinch",
      axis: "time",
      action: "zoom",
      enabled: scale.pinch
    },
    {
      gesture: "двойной клик по ценовой шкале",
      axis: "price",
      action: "вернуть price auto-scale",
      enabled: doubleClick.price
    },
    {
      gesture: "двойной клик по оси времени",
      axis: "time",
      action: "вернуть масштаб времени",
      enabled: doubleClick.time
    },
    {
      gesture: "вертикальный touch-драг",
      axis: "price",
      action: "прокрутка страницы (график палец не перехватывает)",
      enabled: scroll.vertTouchDrag
    }
  ];
}

/* ------------------------------------------------------------------ */
/* 2. Легенда: резерв места под правую ценовую шкалу                   */
/* ------------------------------------------------------------------ */

/** Визуальный зазор между правым краем легенды и ценовой шкалой, px. */
export const LEGEND_RIGHT_GAP_PX = 8;

export interface LegendSpaceInput {
  /**
   * Ширина plot-области графика БЕЗ колонок ценовых шкал:
   * chart.timeScale().width() — layout-конвенция самой библиотеки.
   */
  plotWidth: number;
  /**
   * Фактическая ширина правой ценовой шкалы:
   * chart.priceScale("right").width() (0, если шкала ещё не создана).
   */
  priceScaleWidth: number;
  /** Фактический левый отступ легенды: element.offsetLeft. */
  leftInset: number;
  /**
   * Ширина контейнера графика — fallback на случай, когда plot-область
   * ещё не измерена (first paint / status != ok).
   */
  containerWidth?: number;
  /** Зазор до ценовой шкалы (по умолчанию LEGEND_RIGHT_GAP_PX). */
  gapPx?: number;
}

export interface LegendSpace {
  /**
   * Максимальная ширина легенды в px. null — измерить не удалось
   * (нет ни plot-области, ни контейнера): вызывающий код НЕ трогает
   * inline-стиль, и действует CSS-fallback с media-правилами.
   */
  maxWidthPx: number | null;
  /**
   * Сколько px справа зарезервировано под ценовую шкалу вместе с
   * зазором (используется и для позиции кнопки сброса масштаба).
   */
  reservedRightPx: number;
  /** Ширина правой ценовой шкалы, приведённая к целому px. */
  priceScaleWidthPx: number;
}

function finitePositive(value: number | undefined): boolean {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

/**
 * Сколько места legend имеет права занять, чтобы НЕ перекрывать правую
 * ценовую шкалу.
 *
 * Основной путь — plotWidth (библиотека сама знает ширину области
 * рисования, колонки ценовых шкал в неё не входят), поэтому из неё
 * вычитаются только левый отступ легенды и зазор. Fallback — ширина
 * контейнера минус фактическая ширина шкалы минус зазор (до первого
 * измерения plot-области).
 *
 * Никаких «магических» координат: все входы — фактические измерения
 * lightweight-charts и DOM. Результат никогда не бывает отрицательным:
 * если места нет, возвращается null (CSS-fallback / media-правила).
 */
export function legendSpace(input: LegendSpaceInput): LegendSpace {
  const gapPx =
    typeof input.gapPx === "number" &&
    Number.isFinite(input.gapPx) &&
    input.gapPx >= 0
      ? Math.floor(input.gapPx)
      : LEGEND_RIGHT_GAP_PX;

  const priceScaleWidthPx = finitePositive(input.priceScaleWidth)
    ? Math.ceil(input.priceScaleWidth)
    : 0;

  const leftInset = finitePositive(input.leftInset)
    ? Math.floor(input.leftInset)
    : 0;

  const reservedRightPx = priceScaleWidthPx + gapPx;

  if (finitePositive(input.plotWidth)) {
    const available = Math.floor(
      input.plotWidth - leftInset - gapPx
    );

    return {
      maxWidthPx: available > 0 ? available : null,
      reservedRightPx,
      priceScaleWidthPx
    };
  }

  if (finitePositive(input.containerWidth)) {
    const available = Math.floor(
      (input.containerWidth as number) - leftInset - reservedRightPx
    );

    return {
      maxWidthPx: available > 0 ? available : null,
      reservedRightPx,
      priceScaleWidthPx
    };
  }

  return {
    maxWidthPx: null,
    reservedRightPx,
    priceScaleWidthPx
  };
}

/* ------------------------------------------------------------------ */
/* 3. Ручная история: viewport не сбрасывается при mergeOlder          */
/* ------------------------------------------------------------------ */

export interface LogicalRangeLike {
  from: number;
  to: number;
}

/**
 * Сдвиг видимого ЛОГИЧЕСКОГО диапазона после подгрузки более старой
 * истории.
 *
 * mergeOlder() дописывает `addedBars` свечей В НАЧАЛО массива, поэтому
 * логические индексы всех прежних баров увеличиваются на addedBars.
 * Если диапазон не сдвинуть, пользователь увидит не тот участок
 * истории, на который он вручную ушёл (фактически — неожиданный
 * «отъезд» viewport'а).
 *
 * Возвращает null, когда восстанавливать нечего:
 *  - диапазон неизвестен (шкала ещё не готова / график пересоздан);
 *  - добавлено 0 свечей — тогда viewport не трогают ВООБЩЕ.
 *
 * Никакого forced scroll-to-latest здесь нет и быть не может: функция
 * только сдвигает существующий диапазон, а вызывающий код при null
 * не вызывает setVisibleLogicalRange/fitContent/scrollToRealTime.
 */
export function shiftLogicalRange(
  range: LogicalRangeLike | null,
  addedBars: number
): LogicalRangeLike | null {
  if (range === null || typeof range !== "object") {
    return null;
  }

  if (
    !Number.isFinite(range.from) ||
    !Number.isFinite(range.to)
  ) {
    return null;
  }

  if (
    typeof addedBars !== "number" ||
    !Number.isFinite(addedBars) ||
    addedBars <= 0
  ) {
    return null;
  }

  return {
    from: range.from + addedBars,
    to: range.to + addedBars
  };
}

/* ------------------------------------------------------------------ */
/* 4. Вертикальный масштаб основной панели: AUTO-запас vs MANUAL       */
/* ------------------------------------------------------------------ */

/**
 * Явные scaleMargins правой ценовой шкалы ОСНОВНОЙ панели (свечи).
 *
 * Числа совпадают со штатным дефолтом lightweight-charts 5.2.1
 * (priceScaleOptionsDefaults.scaleMargins = { bottom: 0.1, top: 0.2 }),
 * но заданы ЯВНО и применяются только к шкале панели 0 — через
 * candleSeries.priceScale().applyOptions({ scaleMargins }).
 *
 * Почему не chart-level rightPriceScale: Model
 * ._internal_applyPriceScaleOptions("right", …) применяет опции сразу
 * ко ВСЕМ панелям, а панели RSI и MACD обязаны остаться на штатных
 * дефолтах (свой autoscale, без навязанных отступов).
 *
 * Почему отступы умеренные и НЕ динамические: scaleMargins участвуют в
 * пересчёте координат ВСЕГДА — и в auto-scale, и после ручного drag'а
 * по ценовой шкале (PriceScale._private__topMarginPx/_bottomMarginPx →
 * _private__logicalToCoordinate). Раздувая их, мы сжимали бы полосу
 * рисования и тем самым ограничивали ручной вертикальный масштаб.
 * Весь AUTO-запас (включая резерв под легенду) поэтому добавляется
 * штатным autoscaleInfoProvider — см. createMainPaneAutoscaleProvider.
 */
export const SUSLIK_MAIN_PANE_SCALE_MARGINS: PriceScaleMargins = {
  top: 0.2,
  bottom: 0.1
};

/**
 * Базовый пропорциональный запас autoscale: доля видимого спана цены
 * сверху и снизу. Экстремумы pump/dump никогда не рисуются «в край»
 * полосы, а абсолютный запас растёт вместе с волатильностью.
 */
export const AUTOSCALE_SPAN_PAD_RATIO = 0.025;

/**
 * Максимальная доля полосы рисования, которую autoscale резервирует
 * сверху под легенду. Ограничение сознательное: на очень узких экранах
 * легенда занимает 4-5 строк, и без ограничения свечи сжались бы в
 * полоску. Лучше небольшой остаточный нахлёст полупрозрачной легенды,
 * чем нечитаемый ценовой диапазон.
 */
export const AUTOSCALE_LEGEND_RESERVE_MAX = 0.45;

/** Минимальный зазор между экстремумом и краём полосы рисования, px. */
export const AUTOSCALE_MIN_EDGE_PAD_PX = 2;

/** Зазор между нижним краем легенды и ценовой полосой, px. */
export const LEGEND_BOTTOM_GAP_PX = 4;

export interface ScaleMarginsLike {
  top: number;
  bottom: number;
}

export interface ScaleMarginsValidation {
  ok: boolean;
  reason: string | null;
}

/**
 * Проверка scaleMargins ровно по правилам библиотеки:
 * PriceScale._internal_applyOptions бросает Error, если top или bottom
 * вне [0..1] либо если top + bottom > 1.
 */
export function validateScaleMargins(
  margins: ScaleMarginsLike | null | undefined
): ScaleMarginsValidation {
  if (margins === null || typeof margins !== "object") {
    return { ok: false, reason: "scaleMargins не заданы" };
  }

  const top = margins.top;
  const bottom = margins.bottom;

  if (typeof top !== "number" || !Number.isFinite(top) || top < 0 || top > 1) {
    return {
      ok: false,
      reason: `top вне диапазона 0..1: ${String(top)}`
    };
  }

  if (
    typeof bottom !== "number" ||
    !Number.isFinite(bottom) ||
    bottom < 0 ||
    bottom > 1
  ) {
    return {
      ok: false,
      reason: `bottom вне диапазона 0..1: ${String(bottom)}`
    };
  }

  if (top + bottom > 1) {
    return {
      ok: false,
      reason: `сумма отступов больше единицы: ${String(top + bottom)}`
    };
  }

  return { ok: true, reason: null };
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : fallback;
}

function resolveMargins(
  margins: ScaleMarginsLike | undefined
): PriceScaleMargins {
  if (validateScaleMargins(margins).ok) {
    const safe = margins as ScaleMarginsLike;

    return { top: safe.top, bottom: safe.bottom };
  }

  return {
    top: SUSLIK_MAIN_PANE_SCALE_MARGINS.top,
    bottom: SUSLIK_MAIN_PANE_SCALE_MARGINS.bottom
  };
}

export interface PriceScaleBand {
  /** Верхний отступ полосы рисования, px. */
  topMarginPx: number;
  /** Нижний отступ полосы рисования, px. */
  bottomMarginPx: number;
  /** Высота полосы, в которую ложится ценовой диапазон, px. */
  bandPx: number;
}

/**
 * Полоса рисования цены: internalHeight = height − topMarginPx −
 * bottomMarginPx (PriceScale._internal_internalHeight вместе с
 * _private__topMarginPx/_bottomMarginPx; px-составляющие marginAbove и
 * marginBelow в AUTO добавляет сама библиотека).
 */
export function priceScaleBand(input: {
  paneHeightPx: number;
  margins?: ScaleMarginsLike;
}): PriceScaleBand {
  const margins = resolveMargins(input.margins);
  const height = Math.max(0, finiteNumber(input.paneHeightPx, 0));
  const topMarginPx = height * margins.top;
  const bottomMarginPx = height * margins.bottom;

  return {
    topMarginPx,
    bottomMarginPx,
    bandPx: Math.max(0, height - topMarginPx - bottomMarginPx)
  };
}

export interface AutoscaleExtremesInput {
  paneHeightPx: number;
  /** Диапазон ценовой шкалы (в AUTO — видимые high/low плюс запас). */
  rangeMin: number;
  rangeMax: number;
  /** Фактический high видимых свечей (по умолчанию rangeMax). */
  visibleHigh?: number;
  /** Фактический low видимых свечей (по умолчанию rangeMin). */
  visibleLow?: number;
  margins?: ScaleMarginsLike;
}

export interface AutoscaleExtremesProjection {
  /** y фактического high, px от верха панели. */
  highY: number;
  /** y фактического low, px от верха панели. */
  lowY: number;
  /** Верхняя граница полосы рисования (= topMarginPx). */
  bandTopY: number;
  /** Нижняя граница полосы рисования. */
  bandBottomY: number;
  topMarginPx: number;
  bottomMarginPx: number;
  bandPx: number;
  /** Сколько px остаётся над high внутри полосы. */
  highClearancePx: number;
  /** Сколько px остаётся под low внутри полосы. */
  lowClearancePx: number;
  /** Оба экстремума внутри полосы и внутри панели. */
  fits: boolean;
}

/**
 * Куда попадут экстремумы видимых свечей при заданном диапазоне шкалы.
 *
 * Формула — штатный mapping библиотеки (PriceScale
 * ._private__logicalToCoordinate + _internal_invertedCoordinate при
 * invertScale = false):
 *
 *   y(price) = topMarginPx + (bandPx − 1) × (rangeMax − price) / (rangeMax − rangeMin)
 *
 * то есть rangeMax ложится на верхнюю границу полосы, rangeMin — на
 * нижнюю. Вход НЕ клампится: если экстремум не помещается в диапазон,
 * clearance становится отрицательным и fits = false — именно так тест
 * отличает «экстремум обрезан» от «экстремум с запасом».
 *
 * null — проекции нет (нет высоты панели либо диапазон вырожден;
 * вырожденный диапазон библиотека сама расширяет на 5 × minMove).
 */
export function projectAutoscaleExtremes(
  input: AutoscaleExtremesInput
): AutoscaleExtremesProjection | null {
  const margins = resolveMargins(input.margins);
  const height = finiteNumber(input.paneHeightPx, 0);
  const min = finiteNumber(input.rangeMin, Number.NaN);
  const max = finiteNumber(input.rangeMax, Number.NaN);

  if (height <= 0 || !Number.isFinite(min) || !Number.isFinite(max)) {
    return null;
  }

  const span = max - min;

  if (span <= 0) {
    return null;
  }

  const band = priceScaleBand({ paneHeightPx: height, margins });
  const usable = Math.max(1, band.bandPx - 1);
  const yOf = (price: number): number =>
    band.topMarginPx + (usable * (max - price)) / span;

  const highY = yOf(finiteNumber(input.visibleHigh, max));
  const lowY = yOf(finiteNumber(input.visibleLow, min));
  const bandBottomY = height - band.bottomMarginPx - 1;
  const highClearancePx = highY - band.topMarginPx;
  const lowClearancePx = bandBottomY - lowY;

  return {
    highY,
    lowY,
    bandTopY: band.topMarginPx,
    bandBottomY,
    topMarginPx: band.topMarginPx,
    bottomMarginPx: band.bottomMarginPx,
    bandPx: band.bandPx,
    highClearancePx,
    lowClearancePx,
    fits:
      highClearancePx >= 0 &&
      lowClearancePx >= 0 &&
      highY >= 0 &&
      lowY <= height - 1 &&
      highY < lowY
  };
}

export interface AutoscalePaddingInput {
  /** Максимум видимых свечей (high) из штатного autoscaleInfo. */
  visibleHigh: number;
  /** Минимум видимых свечей (low). */
  visibleLow: number;
  /** Высота основной панели, px: chart.panes()[0].getHeight(). */
  paneHeightPx: number;
  /**
   * Нижний край легенды в координатах панели, px
   * (offsetTop + offsetHeight + LEGEND_BOTTOM_GAP_PX). 0 — легенды нет
   * (например, на экранах уже 360px она скрыта CSS-ом).
   */
  legendBottomPx: number;
  margins?: ScaleMarginsLike;
  spanPadRatio?: number;
  legendReserveMax?: number;
  minEdgePadPx?: number;
}

export interface AutoscalePadding {
  /** Запас СВЕРХ видимого high, в ценовых единицах. */
  above: number;
  /** Запас НИЖЕ видимого low, в ценовых единицах. */
  below: number;
  /** Сколько px сверху занимает легенда сверх верхнего отступа. */
  legendReservePx: number;
  /** Доля полосы рисования, зарезервированная под легенду. */
  legendReserveRatio: number;
}

/**
 * Запас autoscale основной панели — в ЦЕНОВЫХ единицах.
 *
 * Смысл: библиотека в auto-scale кладёт видимый high ровно на верхнюю
 * границу полосы (см. projectAutoscaleExtremes), то есть «вплотную».
 * Запас поднимает диапазон шкалы так, что
 *
 *  1) экстремумы pump/dump всегда отстоят от края полосы минимум на
 *     minEdgePadPx и на долю спана (AUTOSCALE_SPAN_PAD_RATIO);
 *  2) видимый high оказывается НИЖЕ legend-бокса: легенда — overlay
 *     внутри панели, и без резерва длинная свеча уходила бы под неё.
 *
 * Решение уравнения проекции (L = span + above + below):
 *   y(high) = topMarginPx + (bandPx − 1) × above / L ≥ topMarginPx + r × (bandPx − 1)
 *   ⇒ above ≥ r × (span + below) / (1 − r)
 *
 * Вырожденный диапазон (span ≤ 0) не трогаем: его библиотека сама
 * расширяет на 5 × minMove.
 */
export function autoscalePadding(
  input: AutoscalePaddingInput
): AutoscalePadding {
  const margins = resolveMargins(input.margins);
  const ratio = Math.max(0, finiteNumber(input.spanPadRatio, AUTOSCALE_SPAN_PAD_RATIO));
  const reserveMax = Math.min(
    0.9,
    Math.max(0, finiteNumber(input.legendReserveMax, AUTOSCALE_LEGEND_RESERVE_MAX))
  );
  const minEdgePadPx = Math.max(
    0,
    finiteNumber(input.minEdgePadPx, AUTOSCALE_MIN_EDGE_PAD_PX)
  );

  const span = finiteNumber(input.visibleHigh, Number.NaN) -
    finiteNumber(input.visibleLow, Number.NaN);

  if (!Number.isFinite(span) || span <= 0) {
    return {
      above: 0,
      below: 0,
      legendReservePx: 0,
      legendReserveRatio: 0
    };
  }

  const below = span * ratio;
  const band = priceScaleBand({
    paneHeightPx: input.paneHeightPx,
    margins
  });
  const legendBottomPx = Math.max(0, finiteNumber(input.legendBottomPx, 0));
  const legendReservePx = Math.max(0, legendBottomPx - band.topMarginPx);
  const usable = Math.max(1, band.bandPx - 1);

  const reserveRatio =
    band.bandPx > 0
      ? Math.min(
          reserveMax,
          Math.max(legendReservePx, minEdgePadPx) / usable
        )
      : 0;

  const aboveFromReserve =
    reserveRatio > 0 && reserveRatio < 1
      ? (reserveRatio * (span + below)) / (1 - reserveRatio)
      : 0;

  return {
    above: Math.max(span * ratio, aboveFromReserve),
    below,
    legendReservePx,
    legendReserveRatio: reserveRatio
  };
}

export interface MainPaneGeometry {
  /** Высота основной панели, px: chart.panes()[0].getHeight(). */
  paneHeightPx: () => number;
  /** Нижний край легенды в координатах панели, px (0 — легенды нет). */
  legendBottomPx: () => number;
}

/**
 * Штатный autoscaleInfoProvider основной панели.
 *
 * baseImplementation — это расчёт самой библиотеки по ВИДИМЫМ high/low
 * свечей (не по close), поэтому семантика OHLC сохраняется: диапазон
 * только РАСШИРЯЕТСЯ (minValue − below, maxValue + above) и никогда не
 * сужается, не клампится и не подменяется.
 *
 * Разделение AUTO и MANUAL (аудит 5.2.1):
 *  - провайдер вызывается только из PriceScale
 *    ._private__recalculatePriceRangeImpl, а тот сразу завершается при
 *    isCustomPriceRange() && !isAutoScale() — то есть после ручного
 *    drag'а по ценовой шкале запас НЕ пересчитывается и диапазон
 *    пользователя не правится: ручное «сплющивание» и растягивание
 *    свечей остаются полностью свободными;
 *  - запас возвращается в priceRange (ценовые единицы), а НЕ в
 *    AutoScaleMargins (пиксели): px-поля хранятся на шкале и продолжали
 *    бы сжимать полосу рисования даже в ручном режиме.
 */
export function createMainPaneAutoscaleProvider(
  geometry: MainPaneGeometry
): AutoscaleInfoProvider {
  return (baseImplementation: () => AutoscaleInfo | null) => {
    const info = baseImplementation();

    if (info === null || info === undefined || info.priceRange === null) {
      return info ?? null;
    }

    const padding = autoscalePadding({
      visibleHigh: info.priceRange.maxValue,
      visibleLow: info.priceRange.minValue,
      paneHeightPx: finiteNumber(geometry.paneHeightPx(), 0),
      legendBottomPx: finiteNumber(geometry.legendBottomPx(), 0)
    });

    if (padding.above <= 0 && padding.below <= 0) {
      return info;
    }

    return {
      priceRange: {
        minValue: info.priceRange.minValue - padding.below,
        maxValue: info.priceRange.maxValue + padding.above
      },
      margins: info.margins
    };
  };
}

export type VerticalScaleMode = "auto" | "manual";

export interface VerticalScaleModePolicy {
  mode: VerticalScaleMode;
  /** Кто задаёт ценовой диапазон. */
  rangeSource: string;
  /** Применяется ли AUTO-запас (пропорциональный + резерв под легенду). */
  paddingApplied: boolean;
  /** Участвуют ли scaleMargins в геометрии полосы. */
  scaleMarginsApplied: boolean;
  /** Искусственные ограничения ручного вертикального zoom'а. */
  clamps: readonly string[];
  /** Чем возвращается auto-scale. */
  restoredBy: readonly string[];
}

/**
 * Политика вертикального масштаба: AUTO и MANUAL — РАЗНЫЕ режимы.
 *
 * AUTO (открытие графика, сброс, двойной клик по шкале): диапазон
 * считается библиотекой по видимым high/low, к нему добавляется запас
 * (autoscalePadding), экстремумы не обрезаются краем панели и легендой.
 *
 * MANUAL (drag по правой ценовой шкале, handleScale
 * .axisPressedMouseMove.price): диапазон задаёт пользователь, запас не
 * применяется, никаких собственных min/max-ограничений приложение не
 * добавляет — действуют только штатные ограничения библиотеки.
 * Ручной масштаб не отменяется никаким React-эффектом: setAutoScale(true)
 * вызывается лишь явным сбросом пользователя.
 */
export function verticalScaleModePolicy(
  mode: VerticalScaleMode
): VerticalScaleModePolicy {
  if (mode === "manual") {
    return {
      mode,
      rangeSource:
        "drag по правой ценовой шкале (handleScale.axisPressedMouseMove.price)",
      paddingApplied: false,
      scaleMarginsApplied: true,
      clamps: [],
      restoredBy: [
        "двойной клик по ценовой шкале (handleScale.axisDoubleClickReset.price)",
        "кнопка «Сбросить масштаб»",
        "двойной клик по графику"
      ]
    };
  }

  return {
    mode,
    rangeSource:
      "видимые high/low свечей (штатный autoscaleInfo) плюс запас autoscalePadding",
    paddingApplied: true,
    scaleMarginsApplied: true,
    clamps: [],
    restoredBy: []
  };
}
