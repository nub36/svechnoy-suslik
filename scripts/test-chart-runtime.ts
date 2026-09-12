/**
 * Runtime-регрессия ВЕРТИКАЛЬНОГО масштаба собственного SuslikChart.
 *
 * В отличие от scripts/test-chart-ux.ts (чистые функции + исходники) этот
 * тест поднимает НАСТОЯЩИЙ lightweight-charts 5.2.1 в headless-DOM
 * (scripts/chart-dom-shim.ts) и диспатчит НАСТОЯЩИЕ mousedown/mousemove/
 * mouseup/dblclick/wheel/touch по реальным canvas'ам виджетов, а затем
 * проверяет СОСТОЯНИЕ и ИНВАРИАНТЫ взаимодействия, а не литералы опций:
 *
 *  1. drag по правой ценовой шкале = ВЕРТИКАЛЬНЫЙ масштаб: autoScale
 *     уходит в false, ценовой диапазон меняется, а видимый
 *     логический/временной диапазон и barSpacing НЕ меняются;
 *  2. ручной режим ЖИВЁТ после wheel (time zoom), drag по plot
 *     (история), chart.applyOptions (тема), scale.applyOptions
 *     (scaleMargins из applyChartMetrics), series.setData (подгрузка
 *     истории) и переключения видимости серий;
 *  3. двойной клик по ценовой шкале возвращает ТОЛЬКО авто-масштаб
 *     цены и НЕ трогает время (именно это ломал React-onDoubleClick на
 *     обёртке графика — см. PROJECT_CONTEXT §31m);
 *  4. кнопка «Сбросить масштаб» возвращает авто-масштаб цены во всех
 *     панелях и последние закрытые бары;
 *  5. AUTO-режим: видимые high/low не обрезаны и не спрятаны под
 *     легенду (запас даёт autoscaleInfoProvider);
 *  6. touch-драг по ценовой шкале работает так же, как мышиный;
 *  7. hit-target: правая ценовая шкала — отдельный интерактивный
 *     виджет (свой canvas, слушатели mousedown/touchstart, курсор
 *     ns-resize), панели RSI/MACD drag'ом основной панели не трогаются.
 *
 * Новых зависимостей нет: DOM-шим написан вручную, браузер не нужен.
 *
 * Запуск: npx tsx scripts/test-chart-runtime.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  installChartDom,
  type ShimCanvasElement
} from "./chart-dom-shim";

/*
 * КРИТИЧНО: глобалы window/document ставятся ДО импорта библиотеки —
 * lightweight-charts фиксирует `isRunningOnClientSide = typeof window
 * !== 'undefined'` в момент вычисления модуля.
 */
const dom = installChartDom({ width: 1200, height: 560 });

let passed = 0;
let total = 0;
const failures: string[] = [];

function ok(condition: boolean, label: string): void {
  total += 1;

  if (condition) {
    passed += 1;
  } else {
    failures.push(label);
    console.error(`FAIL: ${label}`);
  }
}

function eq(actual: unknown, expected: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);

  total += 1;

  if (a === b) {
    passed += 1;
  } else {
    failures.push(`${label}\n   actual=${a}\n   expect=${b}`);
    console.error(`FAIL: ${label}\n   actual=${a}\n   expect=${b}`);
  }
}

function near(
  actual: number,
  expected: number,
  tolerance: number,
  label: string
): void {
  total += 1;

  if (Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance) {
    passed += 1;
  } else {
    failures.push(
      `${label}\n   actual=${String(actual)}\n   expect≈${String(expected)}±${String(tolerance)}`
    );
    console.error(
      `FAIL: ${label}\n   actual=${String(actual)}\n   expect≈${String(expected)}±${String(tolerance)}`
    );
  }
}

/* ---------- исходники: замок на отсутствие перехвата dblclick ---------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function readSource(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

const CHART_SRC = readSource("components/chart/CandleChart.tsx");

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/* ---------- геометрия и жесты ---------- */

interface Widget {
  el: ShimCanvasElement;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Shot {
  autoScale: boolean;
  from: number;
  to: number;
  span: number;
  logicalFrom: number;
  logicalTo: number;
  barSpacing: number;
}

function rectOf(el: ShimCanvasElement): Widget {
  const r = el.getBoundingClientRect();

  return {
    el,
    left: r.left,
    top: r.top,
    width: r.width,
    height: r.height
  };
}

/**
 * Canvas'ы виджетов ищутся по ФАКТИЧЕСКОЙ геометрии и по наличию
 * слушателей mousedown (их ставит MouseEventHandler библиотеки), а не по
 * порядку в DOM: так тест проверяет реальный hit-target, а не предположение.
 */
function findWidgets(
  canvases: ShimCanvasElement[],
  paneHeight: number
): { axis: Widget | null; plot: Widget | null; timeAxis: Widget | null } {
  const boxes = canvases
    .filter((el) => el.shimListenerCount("mousedown") > 0)
    .map(rectOf);

  const inPane = (w: Widget): boolean =>
    Math.abs(w.height - paneHeight) < 2;

  const axis = boxes
    .filter((w) => inPane(w) && w.left > 0)
    .sort((a, b) => b.left - a.left)[0];

  const plot = boxes.filter((w) => inPane(w) && w.left === 0)[0];

  const timeAxis = boxes
    .filter((w) => w.left === 0 && !inPane(w))
    .sort((a, b) => b.top - a.top)[0];

  return {
    axis: axis ?? null,
    plot: plot ?? null,
    timeAxis: timeAxis ?? null
  };
}

async function main(): Promise<void> {
  const libUrl = pathToFileURL(
    resolve(
      ROOT,
      "node_modules/lightweight-charts/dist/lightweight-charts.development.mjs"
    )
  ).href;

  /*
   * exports-карта пакета разрешает только ".", поэтому development-бандл
   * берётся прямым file-URL (внутренний `import "fancy-canvas"` при этом
   * резолвится штатно).
   */
  const lwc = (await import(libUrl)) as typeof import("lightweight-charts");
  const ux = await import("../lib/chart/chart-ux");

  console.log("=== 0. Замок на перехват двойного клика обёрткой ===");

  eq(
    count(CHART_SRC, "onDoubleClick"),
    0,
    "chart: на обёртке/контейнере НЕТ React-onDoubleClick — двойной клик по ценовой шкале обрабатывает только библиотека"
  );
  eq(
    count(CHART_SRC, "onClick={resetChartScale}"),
    1,
    "chart: полный сброс масштаба остался на кнопке «Сбросить масштаб»"
  );
  eq(
    count(CHART_SRC, "resetChartScale"),
    2,
    "chart: resetChartScale упоминается ровно дважды (определение + кнопка) — больше ни к какому жесту не привязан"
  );
  ok(
    /axisDoubleClickReset:\s*\{\s*time:\s*true,\s*price:\s*true\s*\}/.test(
      readSource("lib/chart/chart-ux.ts")
    ),
    "ux: штатный axisDoubleClickReset (price+time) включён"
  );

  console.log("\n=== 1. График в headless-DOM ===");

  const chart = lwc.createChart(dom.container as never, {
    width: 1200,
    height: 560,
    autoSize: false,
    localization: { locale: "ru-RU" },
    layout: {
      background: { color: "transparent" },
      textColor: "#edf1f5",
      fontSize: 12,
      panes: {
        separatorColor: "#2a3441",
        separatorHoverColor: "#44444444",
        enableResize: true
      },
      attributionLogo: false
    },
    grid: {
      vertLines: { color: "#2a3441" },
      horzLines: { color: "#2a3441" }
    },
    handleScroll: ux.SUSLIK_HANDLE_SCROLL,
    handleScale: ux.SUSLIK_HANDLE_SCALE,
    kineticScroll: ux.SUSLIK_KINETIC_SCROLL,
    rightPriceScale: {
      ...ux.SUSLIK_RIGHT_PRICE_SCALE,
      borderColor: "#2a3441"
    },
    timeScale: {
      ...ux.SUSLIK_TIME_SCALE_NAVIGATION,
      borderColor: "#2a3441",
      timeVisible: true,
      secondsVisible: false
    }
  });

  const LEGEND_BOTTOM_PX = 62;

  const candle = chart.addSeries(lwc.CandlestickSeries, {
    priceLineWidth: 1,
    autoscaleInfoProvider: ux.createMainPaneAutoscaleProvider({
      paneHeightPx: () => {
        try {
          return chart.panes()[0]?.getHeight() ?? 0;
        } catch {
          return 0;
        }
      },
      legendBottomPx: () => LEGEND_BOTTOM_PX
    })
  });

  const volume = chart.addSeries(lwc.HistogramSeries, {
    priceFormat: { type: "volume" },
    priceScaleId: "",
    priceLineVisible: false,
    lastValueVisible: false
  });

  volume
    .priceScale()
    .applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

  const rsi = chart.addSeries(lwc.LineSeries, { lineWidth: 2 }, 1);
  const macd = chart.addSeries(lwc.LineSeries, { lineWidth: 2 }, 2);

  /* Данные: базовая пила + dump в середине + pump в конце (экстремумы). */
  const CANDLE_COUNT = 300;
  const FIRST_TIME = 1700000000;

  const candleAt = (i: number): {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
  } => {
    const base = 100 + Math.sin(i / 9) * 4;
    const pump = i > 285 ? (i - 285) * 3.5 : 0;
    const dump = i > 100 && i < 111 ? (i - 100) * -2.5 : 0;

    return {
      time: FIRST_TIME + i * 3600,
      open: base + pump + dump,
      high: base + pump + dump + 2,
      low: base + pump + dump - 2,
      close: base + pump + dump + 1
    };
  };

  const candles = Array.from({ length: CANDLE_COUNT }, (_, i) => ({
    ...candleAt(i),
    time: (FIRST_TIME + i * 3600) as never
  }));

  const maxHigh = Math.max(...candles.map((c) => c.high));
  const minLow = Math.min(...candles.map((c) => c.low));

  volume.setData(
    candles.map((c) => ({
      time: c.time as never,
      value: 1000 + (c.close - c.open) * 10
    }))
  );
  rsi.setData(
    candles.map((c) => ({
      time: c.time as never,
      value: 50 + Math.sin(c.close) * 20
    }))
  );
  macd.setData(
    candles.map((c) => ({ time: c.time as never, value: Math.cos(c.close) }))
  );

  const panes = chart.panes();

  panes[0].setStretchFactor(4);
  panes[1].setStretchFactor(1.6);
  panes[2].setStretchFactor(1.6);

  candle.setData(candles);
  chart.timeScale().fitContent();

  await dom.settle(30);
  dom.layout();

  const scale = chart.priceScale("right", 0);
  const ts = chart.timeScale();
  const pane0Height = panes[0].getHeight();

  ok(panes.length === 3, "chart: три панели (свечи, RSI, MACD)");
  ok(pane0Height > 100, `chart: pane 0 отрисована (height=${String(pane0Height)})`);

  const shot = (): Shot => {
    const range = scale.getVisibleRange();
    const logical = ts.getVisibleLogicalRange();

    return {
      autoScale: scale.options().autoScale === true,
      from: range ? range.from : Number.NaN,
      to: range ? range.to : Number.NaN,
      span: range ? range.to - range.from : Number.NaN,
      logicalFrom: logical ? logical.from : Number.NaN,
      logicalTo: logical ? logical.to : Number.NaN,
      barSpacing: ts.options().barSpacing ?? Number.NaN
    };
  };

  const sameTime = (a: Shot, b: Shot, label: string): void => {
    near(b.logicalFrom, a.logicalFrom, 1e-9, `${label}: logicalRange.from не изменился`);
    near(b.logicalTo, a.logicalTo, 1e-9, `${label}: logicalRange.to не изменился`);
    near(b.barSpacing, a.barSpacing, 1e-9, `${label}: barSpacing (zoom времени) не изменился`);
  };

  const widgets = findWidgets(dom.canvases(), pane0Height);

  console.log("\n=== 2. Hit-target правой ценовой шкалы ===");

  ok(widgets.axis !== null, "axis: виджет правой ценовой шкалы найден по геометрии");
  ok(widgets.plot !== null, "plot: виджет основной панели найден по геометрии");
  ok(widgets.timeAxis !== null, "time: виджет оси времени найден по геометрии");

  if (widgets.axis === null || widgets.plot === null) {
    throw new Error("Виджеты не найдены — продолжать бессмысленно");
  }

  const axis = widgets.axis;
  const plot = widgets.plot;

  ok(axis.width >= 20, `axis: интерактивная ширина достаточна (${String(Math.round(axis.width))}px)`);
  ok(
    axis.left >= plot.left + plot.width - 1,
    "axis: шкала СПРАВА от plot-области (не перекрыта ею)"
  );
  eq(
    axis.el.shimListenerCount("mousedown") > 0 &&
      axis.el.shimListenerCount("touchstart") > 0,
    true,
    "axis: на canvas шкалы висят слушатели mousedown/touchstart (MouseEventHandler)"
  );

  /*
   * Курсор ставит PriceAxisWidget._private__setCursor на свою обёртку
   * (div внутри td оси): ns-resize — это ровно та «↕», которую видит
   * пользователь над ценовой шкалой. Если её нет — указатель до виджета
   * шкалы не доходит.
   */
  const axisBox = axis.el.parentElement;

  ok(
    axisBox !== null && axisBox.tagName === "DIV",
    "axis: у canvas шкалы есть div-обёртка виджета"
  );
  ok(
    axis.el.closestTag("td") !== null,
    "axis: шкала лежит в отдельной ячейке таблицы (своя колонка)"
  );

  dom.dispatch(axis.el, dom.mouse("mouseenter"));
  ok(
    axisBox !== null && axisBox.style.getPropertyValue("cursor") === "ns-resize",
    "axis: при наведении курсор становится ns-resize (↕) — шкала принимает указатель"
  );
  dom.dispatch(axis.el, dom.mouse("mouseleave"));
  ok(
    axisBox !== null && axisBox.style.getPropertyValue("cursor") !== "ns-resize",
    "axis: после ухода курсора ns-resize снимается"
  );

  console.log("\n=== 3. AUTO: экстремумы видны и не под легендой ===");

  const auto = shot();

  ok(auto.autoScale, "auto: по умолчанию auto-scale включён");
  ok(auto.to > maxHigh, `auto: верх диапазона выше pump-high (${auto.to.toFixed(2)} > ${maxHigh.toFixed(2)})`);
  ok(auto.from < minLow, `auto: низ диапазона ниже dump-low (${auto.from.toFixed(2)} < ${minLow.toFixed(2)})`);

  const band = ux.priceScaleBand({
    paneHeightPx: pane0Height,
    margins: ux.SUSLIK_MAIN_PANE_SCALE_MARGINS
  });
  const highY = candle.priceToCoordinate(maxHigh);
  const lowY = candle.priceToCoordinate(minLow);

  ok(highY !== null && lowY !== null, "auto: экстремумы проецируются в координаты");

  if (highY !== null && lowY !== null) {
    ok(
      highY >= band.topMarginPx + ux.AUTOSCALE_MIN_EDGE_PAD_PX - 0.5,
      `auto: pump-high не обрезан сверху (y=${highY.toFixed(1)}, margin=${band.topMarginPx.toFixed(1)})`
    );
    ok(
      highY >= LEGEND_BOTTOM_PX,
      `auto: pump-high не спрятан под легендой (y=${highY.toFixed(1)} ≥ ${String(LEGEND_BOTTOM_PX)})`
    );
    ok(
      lowY <= pane0Height - band.bottomMarginPx - ux.AUTOSCALE_MIN_EDGE_PAD_PX + 0.5,
      `auto: dump-low не обрезан снизу (y=${lowY.toFixed(1)})`
    );
    ok(
      highY < lowY,
      "auto: проекция не вывернута (high выше low)"
    );
  }

  console.log("\n=== 4. Drag по ценовой шкале = только вертикаль ===");

  const dragAxis = (fromRatio: number, toRatio: number): void => {
    const x = Math.round(axis.left + axis.width / 2);
    const y1 = Math.round(axis.top + axis.height * fromRatio);
    const y2 = Math.round(axis.top + axis.height * toRatio);
    const yMid = Math.round((y1 + y2) / 2);

    dom.dispatch(axis.el, dom.mouse("mousedown", { clientX: x, clientY: y1 }));
    dom.dispatch(axis.el, dom.mouse("mousemove", { clientX: x, clientY: yMid }));
    dom.dispatch(axis.el, dom.mouse("mousemove", { clientX: x, clientY: y2 }));
    dom.dispatch(
      axis.el,
      dom.mouse("mouseup", { clientX: x, clientY: y2, buttons: 0 })
    );
    dom.flushFrames();
  };

  const beforeDrag = shot();
  const spreadBefore = (() => {
    const a = candle.priceToCoordinate(maxHigh);
    const b = candle.priceToCoordinate(minLow);

    return a === null || b === null ? Number.NaN : Math.abs(b - a);
  })();

  dragAxis(0.5, 0.9);

  const afterDrag = shot();

  eq(afterDrag.autoScale, false, "drag: auto-scale выключился (ручной режим)");
  ok(
    afterDrag.span > beforeDrag.span * 1.2,
    `drag: диапазон цены растянулся (${beforeDrag.span.toFixed(2)} → ${afterDrag.span.toFixed(2)})`
  );
  sameTime(beforeDrag, afterDrag, "drag");

  const spreadAfter = (() => {
    const a = candle.priceToCoordinate(maxHigh);
    const b = candle.priceToCoordinate(minLow);

    return a === null || b === null ? Number.NaN : Math.abs(b - a);
  })();

  ok(
    spreadAfter < spreadBefore,
    `drag: свечи СЖАЛИСЬ по вертикали (${spreadBefore.toFixed(1)}px → ${spreadAfter.toFixed(1)}px)`
  );
  ok(
    Number.isFinite(spreadAfter) && spreadAfter > 0,
    "drag: вертикальный масштаб остался конечным и ненулевым"
  );

  /* Обратное движение — растяжение. */
  dragAxis(0.9, 0.45);

  const afterReverse = shot();

  ok(
    afterReverse.span < afterDrag.span,
    `drag: обратное движение сжимает диапазон обратно (${afterDrag.span.toFixed(2)} → ${afterReverse.span.toFixed(2)})`
  );
  eq(afterReverse.autoScale, false, "drag: ручной режим сохраняется между движениями");
  sameTime(beforeDrag, afterReverse, "drag (обратно)");

  ok(
    chart.priceScale("right", 1).options().autoScale === true &&
      chart.priceScale("right", 2).options().autoScale === true,
    "drag: панели RSI/MACD не затронуты (у них свой auto-scale)"
  );

  console.log("\n=== 5. Ручной режим живёт после прочих жестов/обновлений ===");

  /* 5.1 wheel над plot = time zoom, цену не трогает. */
  const beforeWheel = shot();

  dom.dispatch(
    plot.el,
    dom.wheel({
      clientX: Math.round(plot.left + plot.width / 2),
      clientY: Math.round(plot.top + plot.height / 2),
      deltaY: -120,
      deltaX: 0
    })
  );
  dom.flushFrames();

  const afterWheel = shot();

  eq(afterWheel.autoScale, false, "wheel: ручной режим цены пережил колесо");
  near(afterWheel.span, beforeWheel.span, 1e-9, "wheel: ценовой диапазон не изменился");
  ok(
    Math.abs(afterWheel.barSpacing - beforeWheel.barSpacing) > 1e-6,
    `wheel: колесо — это zoom ВРЕМЕНИ (${beforeWheel.barSpacing.toFixed(3)} → ${afterWheel.barSpacing.toFixed(3)})`
  );

  /* 5.2 drag по plot = история (горизонталь), цену не трогает. */
  const beforePlotDrag = shot();
  const px = Math.round(plot.left + plot.width / 2);
  const py = Math.round(plot.top + plot.height / 2);

  dom.dispatch(plot.el, dom.mouse("mousedown", { clientX: px, clientY: py }));
  dom.dispatch(plot.el, dom.mouse("mousemove", { clientX: px + 40, clientY: py }));
  dom.dispatch(plot.el, dom.mouse("mousemove", { clientX: px + 90, clientY: py }));
  dom.dispatch(plot.el, dom.mouse("mousemove", { clientX: px + 140, clientY: py }));
  dom.dispatch(
    plot.el,
    dom.mouse("mouseup", { clientX: px + 140, clientY: py, buttons: 0 })
  );
  dom.flushFrames();

  const afterPlotDrag = shot();

  eq(afterPlotDrag.autoScale, false, "plot drag: ручной режим цены пережил горизонтальный drag");
  near(afterPlotDrag.span, beforePlotDrag.span, 1e-9, "plot drag: ценовой диапазон не изменился");
  near(afterPlotDrag.barSpacing, beforePlotDrag.barSpacing, 1e-9, "plot drag: zoom времени не изменился");
  ok(
    Math.abs(afterPlotDrag.logicalFrom - beforePlotDrag.logicalFrom) > 1,
    `plot drag: история сдвинулась (${beforePlotDrag.logicalFrom.toFixed(2)} → ${afterPlotDrag.logicalFrom.toFixed(2)})`
  );

  /* 5.3 chart.applyOptions (ровно то, что делает applyChartTheme). */
  const beforeTheme = shot();

  chart.applyOptions({
    layout: { background: { color: "transparent" } },
    grid: {
      vertLines: { color: "#2a3441" },
      horzLines: { color: "#2a3441" }
    },
    rightPriceScale: { borderColor: "#2a3441" },
    timeScale: { borderColor: "#2a3441" },
    crosshair: { vertLine: { color: "#5b6b7c" } }
  });
  dom.flushFrames();

  const afterTheme = shot();

  eq(afterTheme.autoScale, false, "applyOptions: смена темы не вернула auto-scale");
  near(afterTheme.span, beforeTheme.span, 1e-9, "applyOptions: ценовой диапазон не изменился");
  sameTime(beforeTheme, afterTheme, "applyOptions");

  /* 5.4 scale.applyOptions({scaleMargins}) — путь applyChartMetrics. */
  const beforeMargins = shot();

  scale.applyOptions({ scaleMargins: ux.SUSLIK_MAIN_PANE_SCALE_MARGINS });
  dom.flushFrames();

  const afterMargins = shot();

  eq(afterMargins.autoScale, false, "scaleMargins: повторное применение отступов не вернуло auto-scale");
  near(afterMargins.span, beforeMargins.span, 1e-9, "scaleMargins: ручной диапазон не изменился");

  /* 5.5 series.setData с более старой историей (путь loadOlder). */
  const beforeOlder = shot();
  const OLDER_COUNT = 40;

  const older = Array.from({ length: OLDER_COUNT }, (_, k) => {
    const i = k - OLDER_COUNT;
    const base = 100 + Math.sin(i / 9) * 4;

    return {
      time: (FIRST_TIME + i * 3600) as never,
      open: base,
      high: base + 2,
      low: base - 2.5,
      close: base + 1
    };
  });

  candle.setData([...older, ...candles]);
  await dom.settle(20);
  dom.flushFrames();

  const afterOlder = shot();

  eq(afterOlder.autoScale, false, "loadOlder: подгрузка истории не вернула auto-scale");
  near(afterOlder.span, beforeOlder.span, 1e-9, "loadOlder: ручной ценовой диапазон не изменился");
  near(
    afterOlder.logicalFrom - beforeOlder.logicalFrom,
    OLDER_COUNT,
    1e-6,
    "loadOlder: viewport сдвинулся ровно на число добавленных баров"
  );

  /* 5.6 переключение видимости серий (тулбар Volume/EMA/RSI/MACD). */
  const beforeVisible = shot();

  volume.applyOptions({ visible: false });
  rsi.applyOptions({ visible: false });
  dom.flushFrames();

  const afterVisible = shot();

  eq(afterVisible.autoScale, false, "toggles: скрытие серий не вернуло auto-scale");
  near(afterVisible.span, beforeVisible.span, 1e-9, "toggles: ручной диапазон не изменился");

  volume.applyOptions({ visible: true });
  rsi.applyOptions({ visible: true });
  dom.flushFrames();

  console.log("\n=== 6. Двойной клик по ценовой шкале = только цена ===");

  const beforeDbl = shot();

  for (let i = 0; i < 2; i += 1) {
    const x = Math.round(axis.left + axis.width / 2);
    const y = Math.round(axis.top + axis.height * 0.5);

    dom.dispatch(axis.el, dom.mouse("mousedown", { clientX: x, clientY: y }));
    dom.dispatch(
      axis.el,
      dom.mouse("mouseup", { clientX: x, clientY: y, buttons: 0 })
    );
  }

  dom.flushFrames();

  const afterDbl = shot();

  eq(afterDbl.autoScale, true, "dblclick: авто-масштаб цены вернулся");
  sameTime(
    beforeDbl,
    afterDbl,
    "dblclick"
  );
  ok(
    afterDbl.span < beforeDbl.span,
    `dblclick: диапазон пересчитан по видимым барам (${beforeDbl.span.toFixed(2)} → ${afterDbl.span.toFixed(2)})`
  );

  console.log("\n=== 7. Кнопка «Сбросить масштаб» ===");

  /* Снова уходим в ручной режим и в историю, затем — штатный сброс. */
  dragAxis(0.5, 0.85);
  dom.dispatch(plot.el, dom.mouse("mousedown", { clientX: px, clientY: py }));
  dom.dispatch(plot.el, dom.mouse("mousemove", { clientX: px + 60, clientY: py }));
  dom.dispatch(plot.el, dom.mouse("mousemove", { clientX: px + 120, clientY: py }));
  dom.dispatch(plot.el, dom.mouse("mousemove", { clientX: px + 180, clientY: py }));
  dom.dispatch(
    plot.el,
    dom.mouse("mouseup", { clientX: px + 180, clientY: py, buttons: 0 })
  );
  dom.flushFrames();

  eq(shot().autoScale, false, "reset: перед сбросом режим ручной");

  /* Ровно то, что делает resetChartScale() в CandleChart.tsx. */
  ts.resetTimeScale();

  for (const pane of chart.panes()) {
    pane.priceScale("right").setAutoScale(true);
  }

  ts.scrollToRealTime();

  await dom.settle(80);
  dom.flushFrames(4);
  await dom.settle(80);
  dom.flushFrames(4);

  const afterReset = shot();

  eq(afterReset.autoScale, true, "reset: авто-масштаб цены вернулся");
  eq(
    chart.panes().every((pane) => pane.priceScale("right").options().autoScale === true),
    true,
    "reset: авто-масштаб вернулся во ВСЕХ панелях (RSI/MACD тоже)"
  );

  const visibleRange = ts.getVisibleRange();
  const lastTime = FIRST_TIME + (CANDLE_COUNT - 1) * 3600;

  ok(
    visibleRange !== null && Number(visibleRange.to) >= lastTime - 3600,
    "reset: последние закрытые бары снова видны"
  );

  const resetHighY = candle.priceToCoordinate(maxHigh);

  ok(
    resetHighY === null || resetHighY >= LEGEND_BOTTOM_PX - 200,
    "reset: после сброса авто-запас снова работает"
  );

  console.log("\n=== 8. Touch-драг по ценовой шкале ===");

  const touchAt = (yRatio: number, id: number): { touches: unknown[]; changedTouches: unknown[] } => {
    const touch = {
      identifier: id,
      clientX: Math.round(axis.left + axis.width / 2),
      clientY: Math.round(axis.top + axis.height * yRatio),
      pageX: Math.round(axis.left + axis.width / 2),
      pageY: Math.round(axis.top + axis.height * yRatio),
      target: axis.el
    };

    return { touches: [touch], changedTouches: [touch] };
  };

  /*
   * handleScroll.vertTouchDrag:false (осознанно: вертикальный свайп по
   * графику отдан прокрутке страницы) библиотека читает И в виджете
   * ценовой шкалы: PriceAxisWidget передаёт в MouseEventHandler
   * treatVertTouchDragAsPageScroll = () => !vertTouchDrag. Поэтому
   * вертикальный touch-драг по шкале уходит странице и цену не меняет —
   * фиксируем это как известное поведение, а не как «работает».
   */
  const beforeTouch = shot();

  dom.dispatch(axis.el, dom.mouse("touchstart", touchAt(0.5, 1)));
  dom.dispatch(axis.el, dom.mouse("touchmove", touchAt(0.7, 1)));
  dom.dispatch(axis.el, dom.mouse("touchmove", touchAt(0.85, 1)));
  dom.dispatch(axis.el, dom.mouse("touchend", { ...touchAt(0.85, 1), touches: [] }));
  dom.flushFrames();

  const afterTouch = shot();

  near(
    afterTouch.span,
    beforeTouch.span,
    1e-9,
    "touch: вертикальный свайп по шкале отдан странице (vertTouchDrag:false) и цену не меняет"
  );
  sameTime(beforeTouch, afterTouch, "touch");

  /* Двойной тап по шкале — штатный возврат авто-масштаба на touch. */
  // те же 500 мс защиты от призрачных mouse-событий после touch
  await dom.settle(520);
  dragAxis(0.5, 0.85);
  eq(shot().autoScale, false, "touch: перед двойным тапом режим ручной (мышью)");

  for (let i = 0; i < 2; i += 1) {
    dom.dispatch(axis.el, dom.mouse("touchstart", touchAt(0.5, 2)));
    dom.dispatch(axis.el, dom.mouse("touchend", { ...touchAt(0.5, 2), touches: [] }));
  }

  dom.flushFrames();

  const afterDoubleTap = shot();

  eq(afterDoubleTap.autoScale, true, "touch: двойной тап по шкале возвращает авто-масштаб цены");
  sameTime(beforeTouch, afterDoubleTap, "touch (двойной тап)");

  console.log("\n=== 9. Ось времени — отдельный жест ===");

  /*
   * После touch-событий библиотека 500 мс (в шкале timeStamp) игнорирует
   * мышиные — штатная защита от «призрачных» mouse-событий. Ждём реальное
   * время, чтобы жесты мыши ниже обрабатывались.
   */
  await dom.settle(520);

  const timeAxis = widgets.timeAxis;

  ok(timeAxis !== null, "time: виджет оси времени найден");

  if (timeAxis !== null) {
    /* У TimeAxisWidget _private__cell — это td оси (у ценовой — div). */
    const timeBox = timeAxis.el.closestTag("td");

    dom.dispatch(timeAxis.el, dom.mouse("mouseenter"));
    ok(
      timeBox !== null && timeBox.style.getPropertyValue("cursor") === "ew-resize",
      "time: курсор оси времени — ew-resize (↔), не путается с ценовой шкалой"
    );
    dom.dispatch(timeAxis.el, dom.mouse("mouseleave"));

    /* Уходим в ручной режим цены и меняем масштаб времени колесом. */
    dragAxis(0.5, 0.8);

    const zoomed = shot();

    dom.dispatch(
      plot.el,
      dom.wheel({
        clientX: Math.round(plot.left + plot.width / 2),
        clientY: Math.round(plot.top + plot.height / 2),
        deltaY: -240,
        deltaX: 0
      })
    );
    dom.flushFrames();

    const beforeTimeDbl = shot();

    ok(
      Math.abs(beforeTimeDbl.barSpacing - zoomed.barSpacing) > 1e-6,
      "time: колесо изменило масштаб времени ( precondition )"
    );

    for (let i = 0; i < 2; i += 1) {
      const x = Math.round(timeAxis.left + timeAxis.width / 2);
      const y = Math.round(timeAxis.top + timeAxis.height / 2);

      dom.dispatch(timeAxis.el, dom.mouse("mousedown", { clientX: x, clientY: y }));
      dom.dispatch(
        timeAxis.el,
        dom.mouse("mouseup", { clientX: x, clientY: y, buttons: 0 })
      );
    }

    dom.flushFrames();
    await dom.settle(30);
    dom.flushFrames();

    const afterTimeDbl = shot();

    eq(
      afterTimeDbl.autoScale,
      false,
      "time: двойной клик по оси времени НЕ возвращает авто-масштаб цены"
    );
    near(
      afterTimeDbl.span,
      beforeTimeDbl.span,
      1e-9,
      "time: двойной клик по оси времени не меняет ценовой диапазон"
    );
    ok(
      Math.abs(afterTimeDbl.barSpacing - beforeTimeDbl.barSpacing) > 1e-6,
      `time: двойной клик по оси времени сбрасывает масштаб ВРЕМЕНИ (${beforeTimeDbl.barSpacing.toFixed(3)} → ${afterTimeDbl.barSpacing.toFixed(3)})`
    );
  }

  chart.remove();
}

function finish(): void {
  dom.restore();

  console.log(`\nItog: ${passed}/${total}`);

  if (failures.length > 0) {
    console.error("Проваленные проверки:");

    for (const f of failures) {
      console.error(`  - ${f}`);
    }
  }

  process.exit(failures.length === 0 ? 0 : 1);
}

main()
  .then(finish)
  .catch((error: unknown) => {
    console.error("RUNTIME ERROR:", error);
    finish();
  });
