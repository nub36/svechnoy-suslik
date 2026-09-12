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
 *     старой истории, чтобы ручной уход назад в историю не сбрасывался.
 *
 * Семантика options взята из установленного lightweight-charts 5.2.1
 * (dist/typings.d.ts): handleScroll.mouseWheel реагирует на deltaX
 * (горизонтальный свайп/колесо), handleScale.mouseWheel — на deltaY
 * (zoom в точке курсора), то есть оси не конфликтуют.
 */
import type {
  DeepPartial,
  HandleScaleOptions,
  HandleScrollOptions,
  KineticScrollOptions,
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
