/**
 * Chart UX regression (fix поверх P1-C): навигация/масштаб собственного
 * SuslikChart, резерв места под правую ценовую шкалу (легенда не
 * перекрывает price scale), сохранение ручного viewport при подгрузке
 * истории, ВЕРТИКАЛЬНЫЙ масштаб основной панели (AUTO-запас по видимым
 * high/low отдельно от свободы ручного drag'а по ценовой шкале), а также
 * статические гарды на CandleChart.tsx и globals.css.
 *
 * Детерминированно: WITHOUT DOM, WITHOUT browser, WITHOUT lightweight-charts
 * runtime — проверяются чистые функции lib/chart/chart-ux.ts и исходники.
 * Новых зависимостей нет.
 *
 * Запуск: npx tsx scripts/test-chart-ux.ts
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTOSCALE_LEGEND_RESERVE_MAX,
  AUTOSCALE_MIN_EDGE_PAD_PX,
  AUTOSCALE_SPAN_PAD_RATIO,
  LEGEND_BOTTOM_GAP_PX,
  LEGEND_RIGHT_GAP_PX,
  SUSLIK_HANDLE_SCALE,
  SUSLIK_HANDLE_SCROLL,
  SUSLIK_KINETIC_SCROLL,
  SUSLIK_MAIN_PANE_SCALE_MARGINS,
  SUSLIK_RIGHT_PRICE_SCALE,
  SUSLIK_TIME_SCALE_NAVIGATION,
  autoscalePadding,
  chartGestureBindings,
  createMainPaneAutoscaleProvider,
  legendSpace,
  priceScaleBand,
  projectAutoscaleExtremes,
  shiftLogicalRange,
  validateScaleMargins,
  verticalScaleModePolicy
} from "../lib/chart/chart-ux";
import { mergeOlder } from "../lib/chart/history";

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

/* ---------- исходники ---------- */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

function readSource(relPath: string): string {
  return readFileSync(resolve(ROOT, relPath), "utf8");
}

/** Код без комментариев (чтобы комментарии не давали ложных срабатываний). */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function extractBetween(
  text: string,
  startMarker: string,
  endMarker: string,
  label: string
): string {
  const start = text.indexOf(startMarker);

  if (start === -1) {
    throw new Error(`${label}: не найден стартовый маркер ${startMarker}`);
  }

  const end = text.indexOf(endMarker, start + startMarker.length);

  if (end === -1) {
    throw new Error(`${label}: не найден концевой маркер ${endMarker}`);
  }

  return text.slice(start, end);
}

const CHART_SRC = readSource("components/chart/CandleChart.tsx");
const PANEL_SRC = readSource("components/chart/SmartMoneyPanel.tsx");
const CSS_SRC = readSource("app/globals.css");
const UX_SRC = readSource("lib/chart/chart-ux.ts");

const chartCode = stripComments(CHART_SRC);
const cssCode = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, "");

/* ================================================================ */
/* 1. Штатные interaction options lightweight-charts 5.2.1           */
/* ================================================================ */

console.log("\n=== 1. Навигация/масштаб: документированные options ===");

// Горизонтальная навигация (drag/scroll по истории).
eq(SUSLIK_HANDLE_SCROLL.pressedMouseMove, true, "handleScroll: click+drag внутри plot перемещает историю");
eq(SUSLIK_HANDLE_SCROLL.horzTouchDrag, true, "handleScroll: touch-драг по горизонтали перемещает историю");
eq(SUSLIK_HANDLE_SCROLL.mouseWheel, true, "handleScroll: deltaX колеса/тачпада листает историю");
eq(
  SUSLIK_HANDLE_SCROLL.vertTouchDrag,
  false,
  "handleScroll: вертикальный touch отдан странице (график не «ловит» палец)"
);
eq(
  Object.keys(SUSLIK_HANDLE_SCROLL).sort(),
  ["horzTouchDrag", "mouseWheel", "pressedMouseMove", "vertTouchDrag"],
  "handleScroll: ключи — ровно документированный набор HandleScrollOptions (без опечаток)"
);

// Масштабирование (zoom / оси).
eq(SUSLIK_HANDLE_SCALE.mouseWheel, true, "handleScale: deltaY колеса → zoom временной шкалы");
eq(SUSLIK_HANDLE_SCALE.pinch, true, "handleScale: touch pinch → zoom");
eq(
  SUSLIK_HANDLE_SCALE.axisPressedMouseMove,
  { time: true, price: true },
  "handleScale: драг по оси времени и по ценовой шкале меняет масштаб (штатно)"
);
eq(
  SUSLIK_HANDLE_SCALE.axisDoubleClickReset,
  { time: true, price: true },
  "handleScale: двойной клик по оси времени/цены возвращает auto-scale"
);
eq(
  Object.keys(SUSLIK_HANDLE_SCALE).sort(),
  ["axisDoubleClickReset", "axisPressedMouseMove", "mouseWheel", "pinch"],
  "handleScale: ключи — ровно документированный набор HandleScaleOptions"
);

// Цена-шкала: взаимодействие НЕ отключено, шкала видима, auto-scale.
eq(SUSLIK_RIGHT_PRICE_SCALE.visible, true, "rightPriceScale: ценовая шкала видима");
eq(SUSLIK_RIGHT_PRICE_SCALE.autoScale, true, "rightPriceScale: auto-scale по умолчанию (к нему возвращает сброс)");
eq(SUSLIK_RIGHT_PRICE_SCALE.alignLabels, true, "rightPriceScale: подписи выровнены (не наезжают друг на друга)");
eq(SUSLIK_RIGHT_PRICE_SCALE.borderVisible, true, "rightPriceScale: граница шкалы видима");
eq(
  SUSLIK_RIGHT_PRICE_SCALE.ensureEdgeTickMarksVisible,
  true,
  "rightPriceScale: крайние ценовые метки не обрезаются"
);
ok(
  !("mode" in SUSLIK_RIGHT_PRICE_SCALE),
  "rightPriceScale: режим шкалы не переопределён (остаётся штатный Normal)"
);
ok(
  !("minimumWidth" in SUSLIK_RIGHT_PRICE_SCALE),
  "rightPriceScale: ширина не задаётся хардкодом — берётся из priceScale().width()"
);
ok(
  !("scaleMargins" in SUSLIK_RIGHT_PRICE_SCALE),
  "rightPriceScale: scaleMargins основной панели не меняются (volume настраивается отдельно)"
);

// Инерция: штатная на touch, без самодельной физики на мыши.
eq(SUSLIK_KINETIC_SCROLL.touch, true, "kineticScroll: инерция на touch — штатная");
eq(SUSLIK_KINETIC_SCROLL.mouse, false, "kineticScroll: мышью инерции нет (точный drag)");

// Временная шкала: края свободны (история грузится влево, сброс — вправо).
eq(SUSLIK_TIME_SCALE_NAVIGATION.fixLeftEdge, false, "timeScale: левый край не зафиксирован (подгрузка истории влево)");
eq(SUSLIK_TIME_SCALE_NAVIGATION.fixRightEdge, false, "timeScale: правый край не зафиксирован (scrollToRealTime возможен)");
eq(
  SUSLIK_TIME_SCALE_NAVIGATION.rightBarStaysOnScroll,
  false,
  "timeScale: правый бар не «прилипает» при прокрутке (штатный дефолт)"
);
ok(
  !("barSpacing" in SUSLIK_TIME_SCALE_NAVIGATION),
  "timeScale: barSpacing не хардкодится (дефолт библиотеки)"
);

/* ---------- опции действительно применяются к графику ---------- */

ok(/handleScroll: SUSLIK_HANDLE_SCROLL/.test(chartCode), "CandleChart: handleScroll передан в createChart");
ok(/handleScale: SUSLIK_HANDLE_SCALE/.test(chartCode), "CandleChart: handleScale передан в createChart");
ok(/kineticScroll: SUSLIK_KINETIC_SCROLL/.test(chartCode), "CandleChart: kineticScroll передан в createChart");
ok(/\.\.\.SUSLIK_RIGHT_PRICE_SCALE/.test(chartCode), "CandleChart: rightPriceScale — из общего модуля");
ok(/\.\.\.SUSLIK_TIME_SCALE_NAVIGATION/.test(chartCode), "CandleChart: timeScale — из общего модуля");
ok(
  /createChart\(container, \{/.test(chartCode),
  "CandleChart: опции задаются штатным createChart (не пост-хаком)"
);

// Никакой собственной «физики» drag/zoom поверх библиотеки.
for (const token of [
  "addEventListener",
  "requestAnimationFrame",
  "onWheel",
  "onMouseDown",
  "onTouchStart",
  "onPointerDown",
  "deltaY",
  "deltaX"
]) {
  ok(
    !chartCode.includes(token),
    `CandleChart: нет самодельной обработки ввода (${token}) — навигация штатная`
  );
}
for (const token of ["inertia", "physics", "velocity", "friction", "momentum"]) {
  ok(!chartCode.toLowerCase().includes(token), `CandleChart: нет самодельной физики (${token})`);
}
ok(
  /import type \{[\s\S]*?\} from "lightweight-charts";/.test(UX_SRC),
  "lib/chart/chart-ux: типы библиотеки импортируются type-only (runtime-зависимости нет)"
);
ok(
  !/^import \{/m.test(UX_SRC),
  "lib/chart/chart-ux: runtime-импортов lightweight-charts нет (модуль чистый)"
);

/* ================================================================ */
/* 2. Легенда не перекрывает правую ценовую шкалу                    */
/* ================================================================ */

console.log("\n=== 2. Легенда: резерв места под price scale ===");

eq(LEGEND_RIGHT_GAP_PX, 8, "legend: зазор до ценовой шкалы — константа модуля, не хардкод в компоненте");

// Desktop: контейнер 1240, plot-область 1160, шкала 76.4px, легенда left=8.
{
  const space = legendSpace({
    plotWidth: 1160,
    priceScaleWidth: 76.4,
    leftInset: 8,
    containerWidth: 1240
  });

  eq(space.priceScaleWidthPx, 77, "legend desktop: ширина шкалы округлена вверх (резерв не занижен)");
  eq(space.reservedRightPx, 85, "legend desktop: справа зарезервировано 77px шкалы + 8px зазор");
  eq(space.maxWidthPx, 1144, "legend desktop: maxWidth = plot − leftInset − зазор");
  ok(
    (space.maxWidthPx ?? 0) + 8 + LEGEND_RIGHT_GAP_PX <= 1160,
    "legend desktop: легенда целиком внутри plot-области (не заезжает под шкалу)"
  );
  ok(
    space.reservedRightPx >= Math.ceil(76.4),
    "legend desktop: резерв не меньше фактической ширины шкалы — подписи цен не скрыты"
  );
  ok(Number.isInteger(space.maxWidthPx ?? 0), "legend desktop: значение целое (CSS px без дробей)");
}

// Fallback: plot-область ещё не измерена (first paint), есть контейнер и шкала.
{
  const space = legendSpace({
    plotWidth: 0,
    priceScaleWidth: 77,
    leftInset: 8,
    containerWidth: 1240
  });

  eq(space.maxWidthPx, 1147, "legend fallback: контейнер − leftInset − шкала − зазор");
  eq(space.reservedRightPx, 85, "legend fallback: резерв под шкалу сохранён");
}

// Узкий экран (430px): медиа-правило меняет leftInset на 6.
{
  const space = legendSpace({
    plotWidth: 320,
    priceScaleWidth: 54.2,
    leftInset: 6,
    containerWidth: 390
  });

  eq(space.priceScaleWidthPx, 55, "legend narrow: ширина шкалы округлена вверх");
  eq(space.maxWidthPx, 306, "legend narrow: maxWidth = 320 − 6 − 8");
  ok((space.maxWidthPx ?? 0) <= 320 - 6, "legend narrow: легенда не шире plot-области");
}

// Совсем узко: места нет → null (CSS-fallback + медиа-правила), без отрицательных значений.
{
  const space = legendSpace({
    plotWidth: 16,
    priceScaleWidth: 60,
    leftInset: 8,
    containerWidth: 80
  });

  eq(space.maxWidthPx, null, "legend tiny: maxWidth не выдумывается — остаётся CSS-fallback");
  eq(space.reservedRightPx, 68, "legend tiny: резерв под шкалу всё равно посчитан");
}

// Ценовая шкала скрыта/ещё не создана (width = 0).
{
  const space = legendSpace({
    plotWidth: 900,
    priceScaleWidth: 0,
    leftInset: 8
  });

  eq(space.priceScaleWidthPx, 0, "legend без шкалы: ширина 0");
  eq(space.reservedRightPx, LEGEND_RIGHT_GAP_PX, "legend без шкалы: резерв = только зазор");
  eq(space.maxWidthPx, 884, "legend без шкалы: maxWidth = plot − leftInset − зазор");
}

// Мусорные входы не роняют функцию и не дают отрицательных ширин.
{
  const garbage = [
    { plotWidth: Number.NaN, priceScaleWidth: Number.NaN, leftInset: Number.NaN },
    { plotWidth: Number.POSITIVE_INFINITY, priceScaleWidth: 70, leftInset: 8 },
    { plotWidth: -500, priceScaleWidth: -70, leftInset: -8 },
    { plotWidth: 0, priceScaleWidth: 0, leftInset: 0 },
    {
      plotWidth: undefined as unknown as number,
      priceScaleWidth: undefined as unknown as number,
      leftInset: undefined as unknown as number
    }
  ];

  for (const input of garbage) {
    const space = legendSpace({ ...input, containerWidth: Number.NaN });

    ok(
      space.maxWidthPx === null || space.maxWidthPx > 0,
      `legend garbage ${JSON.stringify(input)}: maxWidth либо null, либо положительный`
    );
    ok(
      space.reservedRightPx >= 0 && Number.isFinite(space.reservedRightPx),
      `legend garbage ${JSON.stringify(input)}: резерв конечный и неотрицательный`
    );
    ok(
      space.priceScaleWidthPx >= 0 && Number.isInteger(space.priceScaleWidthPx),
      `legend garbage ${JSON.stringify(input)}: ширина шкалы — целое неотрицательное`
    );
  }
}

// Кастомный зазор: 0 (вплотную к шкале) и увеличенный.
{
  const tight = legendSpace({ plotWidth: 1000, priceScaleWidth: 70, leftInset: 8, gapPx: 0 });
  const wide = legendSpace({ plotWidth: 1000, priceScaleWidth: 70, leftInset: 8, gapPx: 24 });

  eq(tight.maxWidthPx, 992, "legend gap=0: легенда может доходить до границы plot-области");
  eq(tight.reservedRightPx, 70, "legend gap=0: резерв = ширина шкалы");
  eq(wide.maxWidthPx, 968, "legend gap=24: зазор уменьшает maxWidth");
  eq(wide.reservedRightPx, 94, "legend gap=24: резерв увеличен на зазор");
}

/* ---------- легенда/шкала в исходниках: измерения, а не хардкод ---------- */

ok(/timeScale\(\)\.width\(\)/.test(chartCode), "CandleChart: ширина plot-области берётся из timeScale().width()");
ok(
  /priceScale\("right"\)\s*\.width\(\)/.test(chartCode),
  'CandleChart: ширина ценовой шкалы берётся из priceScale("right").width()'
);
ok(/legendSpace\(\{/.test(chartCode), "CandleChart: арифметика резерва — чистая функция legendSpace");
ok(/offsetLeft/.test(chartCode), "CandleChart: левый отступ легенды измеряется, а не хардкодится");
ok(/--chart-legend-max-w/.test(chartCode), "CandleChart: maxWidth легенды пишется CSS-переменной");
ok(/--chart-price-scale-w/.test(chartCode), "CandleChart: ширина шкалы доступна CSS (кнопка сброса)");
ok(/subscribeSizeChange/.test(chartCode), "CandleChart: пересчёт на изменение размера — штатная подписка библиотеки");
ok(
  !/priceScaleWidth:\s*\d/.test(chartCode),
  "CandleChart: ширина ценовой шкалы не задана числом (только измерение)"
);
ok(
  !/maxWidth\s*=\s*\d/.test(chartCode),
  "CandleChart: maxWidth легенды не вычисляется хардкодом"
);
ok(
  !/style\.width\s*=/.test(chartCode),
  "CandleChart: ширина легенды не форсится напрямую (только max-width через CSS-переменную)"
);

/* ---------- CSS: wrap/overflow/responsive ---------- */

const legendCss = extractBetween(cssCode, ".chartLegend {", "}", "CSS .chartLegend");
ok(
  /max-width: var\(--chart-legend-max-w, calc\(100% - 16px\)\)/.test(legendCss),
  "CSS легенда: max-width из измерений с fallback (легенда не выходит за контейнер)"
);
ok(/flex-wrap: wrap/.test(legendCss), "CSS легенда: при нехватке места — корректный wrap");
ok(/overflow-wrap: anywhere/.test(legendCss), "CSS легенда: длинные значения не ломают layout");
ok(/pointer-events: none/.test(legendCss), "CSS легенда: не перехватывает drag/zoom графика");
ok(/position: absolute/.test(legendCss), "CSS легенда: остаётся внутри plot/chart content area");

const resetCss = extractBetween(cssCode, ".chartResetScale {", "}", "CSS .chartResetScale");
ok(
  /right: calc\(var\(--chart-price-scale-w, 0px\) \+ 10px\)/.test(resetCss),
  "CSS кнопка сброса: сдвинута на фактическую ширину ценовой шкалы (не закрывает ценовые подписи)"
);

ok(/@media \(max-width: 430px\)/.test(cssCode), "CSS: responsive-поведение узких экранов сохранено");
ok(/@media \(max-width: 360px\)/.test(cssCode), "CSS: поведение очень узких экранов сохранено");
const narrowReset = extractBetween(
  cssCode,
  "@media (max-width: 430px) {",
  "@media (max-width: 360px)",
  "CSS media 430"
);
ok(
  /right: calc\(var\(--chart-price-scale-w, 0px\) \+ 6px\)/.test(narrowReset),
  "CSS 430px: резерв под ценовую шкалу сохранён и на узких экранах"
);
ok(
  /\.chartLegend \{/.test(narrowReset),
  "CSS 430px: у легенды есть отдельное responsive-правило"
);
ok(/height: clamp\(360px, 58vh, 560px\)/.test(cssCode), "CSS: высота контейнера графика (responsive) не менялась");

/* ================================================================ */
/* 3. Ручная история: viewport не сбрасывается                       */
/* ================================================================ */

console.log("\n=== 3. Viewport при подгрузке истории ===");

// Типичный merge: 300 свечей вставлено в начало.
{
  const shifted = shiftLogicalRange({ from: -3.5, to: 41.2 }, 300);

  eq(shifted, { from: 296.5, to: 341.2 }, "viewport: диапазон сдвинут ровно на число добавленных свечей");
  ok(
    shifted !== null &&
      Math.abs(shifted.to - shifted.from - (41.2 - -3.5)) < 1e-9,
    "viewport: ширина видимой области не меняется (масштаб пользователя сохранён)"
  );
}

// Нечего восстанавливать → null, и вызывающий код viewport не трогает.
eq(shiftLogicalRange({ from: 0, to: 40 }, 0), null, "viewport: добавлено 0 свечей — диапазон не трогаем");
eq(shiftLogicalRange({ from: 0, to: 40 }, -12), null, "viewport: отрицательное added — диапазон не трогаем");
eq(shiftLogicalRange(null, 300), null, "viewport: диапазон неизвестен — ничего не восстанавливаем");
eq(
  shiftLogicalRange({ from: Number.NaN, to: 40 }, 300),
  null,
  "viewport: неконечный from — диапазон не восстанавливаем"
);
eq(
  shiftLogicalRange({ from: 0, to: Number.POSITIVE_INFINITY }, 300),
  null,
  "viewport: неконечный to — диапазон не восстанавливаем"
);
eq(shiftLogicalRange({ from: 5, to: 20 }, Number.NaN), null, "viewport: неконечное added — диапазон не трогаем");

// Интеграция с реальным mergeOlder: пользователь стоит на истории и
// после подгрузки видит ТЕ ЖЕ свечи (не последние и не «уехавшие»).
{
  const current = Array.from({ length: 41 }, (_, i) => ({ time: 1000 + i }));
  const older = Array.from({ length: 90 }, (_, i) => ({ time: 910 + i }));
  const merged = mergeOlder(current, older);

  eq(merged.added, 90, "viewport/merge: добавлено 90 свечей");
  eq(merged.merged.length, 131, "viewport/merge: массив объединён без дублей");

  // Пользователь вручную ушёл назад: видит current[5]…current[20].
  const manual = { from: 5, to: 20 };
  const shifted = shiftLogicalRange(manual, merged.added);

  ok(shifted !== null, "viewport/merge: диапазон восстановлен");
  eq(shifted!.from, 95, "viewport/merge: from сдвинут на added");
  eq(shifted!.to, 110, "viewport/merge: to сдвинут на added");
  eq(merged.merged[shifted!.from].time, current[5].time, "viewport/merge: левый край — ТА ЖЕ свеча, что и до подгрузки");
  eq(merged.merged[shifted!.to].time, current[20].time, "viewport/merge: правый край — ТА ЖЕ свеча");
  ok(
    shifted!.to !== merged.merged.length - 1,
    "viewport/merge: никакого forced scroll-to-latest (правый край не последний бар)"
  );
}

/* ---------- loadOlder в исходнике: без fitContent/scrollToRealTime ---------- */

const loadOlderCode = stripComments(
  extractBetween(
    CHART_SRC,
    "const loadOlder = useCallback(",
    "loadOlderRef.current = () => {",
    "loadOlder CandleChart"
  )
);
ok(/getVisibleLogicalRange\(\)/.test(loadOlderCode), "loadOlder: видимый диапазон запоминается ДО setData");
ok(/shiftLogicalRange\(/.test(loadOlderCode), "loadOlder: сдвиг диапазона — чистая функция (покрыта тестами)");
ok(/setVisibleLogicalRange\(shifted\)/.test(loadOlderCode), "loadOlder: диапазон восстанавливается после setData");
ok(/shifted !== null/.test(loadOlderCode), "loadOlder: при null viewport не трогается вовсе");
for (const token of ["fitContent", "scrollToRealTime", "setVisibleRange(", "scrollToPosition"]) {
  ok(
    !loadOlderCode.includes(token),
    `loadOlder: НЕТ ${token} — ручной уход в историю не сбрасывается`
  );
}
ok(/subscribeVisibleLogicalRangeChange/.test(chartCode), "chart: подгрузка истории влево сохранена (range.from <= 2)");
ok(/range\.from <= 2/.test(chartCode), "chart: триггер подгрузки истории не менялся");
ok(/mergeOlder\(/.test(chartCode), "chart: слияние истории — прежний lib/chart/history (semantics не менялись)");

// fitContent остаётся ТОЛЬКО на свежей загрузке окна.
const applyDataCode = stripComments(
  extractBetween(CHART_SRC, "const applyData = useCallback(", "const applyVisibility = useCallback(", "applyData CandleChart")
);
eq(
  (applyDataCode.match(/fitContent\(\)/g) ?? []).length,
  1,
  "applyData: fitContent ровно один раз — только на свежей загрузке окна"
);
eq(
  (chartCode.match(/fitContent\(\)/g) ?? []).length,
  1,
  "chart: fitContent больше нигде не вызывается (в том числе при mergeOlder)"
);
eq(
  (chartCode.match(/scrollToRealTime\(\)/g) ?? []).length,
  1,
  "chart: scrollToRealTime — только в сбросе масштаба (явное действие пользователя)"
);

/* ---------- переключение индикаторов не пересоздаёт график ---------- */

ok(
  /applyVisibilityRef\.current\(\)/.test(chartCode),
  "chart: видимость индикаторов применяется через стабильную ссылку"
);
const createEffectDeps = extractBetween(
  chartCode,
  "const chart = createChart(container, {",
  "}, [applyChartTheme",
  "эффект создания графика"
);
ok(!/applyVisibility\b/.test(createEffectDeps.replace(/applyVisibilityRef/g, "")), "chart: эффект создания графика не зависит от applyVisibility");
ok(
  /\}, \[applyChartTheme, renderLegendAt, applyChartMetrics\]\);/.test(chartCode),
  "chart: эффект создания графика стабилен — график создаётся один раз"
);
const loadCandlesDeps = extractBetween(
  chartCode,
  "const loadCandles = useCallback(",
  "const loadOlder = useCallback(",
  "loadCandles CandleChart"
);
ok(
  !/applyVisibility,/.test(loadCandlesDeps),
  "loadCandles: переключение индикатора НЕ перезапрашивает свечи (viewport не сбрасывается)"
);
eq(
  (chartCode.match(/visible: show/g) ?? []).length,
  9,
  "chart: видимость всех 9 серий (Volume/EMA20/50/200/SMA20/RSI/MACD/сигнал/гистограмма) по-прежнему управляется"
);
ok(
  /useEffect\(\(\) => \{\s*applyVisibility\(\);\s*\}, \[applyVisibility\]\);/.test(chartCode),
  "chart: отдельный эффект применяет видимость к живым сериям (поведение индикаторов не изменилось)"
);

/* ---------- RSI/MACD панели не сломаны ---------- */

ok(/chart\.panes\(\)/.test(chartCode), "chart: панели RSI/MACD по-прежнему настраиваются");
eq((chartCode.match(/setStretchFactor\(/g) ?? []).length, 3, "chart: stretch-факторы трёх панелей сохранены");
ok(/title: "RSI 14"[\s\S]{0,40}?,\s*1\s*\)/.test(chartCode), "chart: RSI остаётся в отдельной панели 1");
ok(/title: "MACD"[\s\S]{0,40}?,\s*2\s*\)/.test(chartCode), "chart: MACD остаётся в панели 2");
ok(/title: "сигнал"[\s\S]{0,40}?,\s*2\s*\)/.test(chartCode), "chart: сигнальная линия MACD — в панели 2");
ok(
  /for \(const pane of chart\.panes\(\)\)/.test(chartCode),
  "chart: сброс auto-scale выполняется для ценовых шкал ВСЕХ панелей"
);

/* ---------- сброс масштаба: штатная семантика ---------- */

const resetCode = stripComments(
  extractBetween(chartCode, "const resetChartScale = useCallback(", "const rebuildLegendMaps = useCallback(", "resetChartScale")
);
ok(/resetTimeScale\(\)/.test(resetCode), "reset: timeScale().resetTimeScale() — штатный сброс масштаба времени");
ok(/setAutoScale\(true\)/.test(resetCode), "reset: авто-масштаб ценовой шкалы возвращается штатным API");
ok(/scrollToRealTime\(\)/.test(resetCode), "reset: возврат к последним закрытым барам — штатный API");
ok(/applyChartMetrics\(\)/.test(resetCode), "reset: резерв места под легенду пересчитывается");
ok(
  /onDoubleClick=\{resetChartScale\}/.test(chartCode),
  "chart: двойной клик по графику по-прежнему сбрасывает масштаб"
);
ok(
  /Сбросить масштаб/.test(CHART_SRC),
  "chart: кнопка «Сбросить масштаб» осталась"
);

/* ================================================================ */
/* 4. Smart Money P1-C не сломан                                     */
/* ================================================================ */

console.log("\n=== 4. P1-C Smart Money: без изменений ===");

ok(/createSmcCommitter\(/.test(chartCode), "P1-C: commit-гейт по-прежнему создаётся в CandleChart");
ok(/smcCommitter\.markUnmounted\(\)/.test(chartCode), "P1-C: cleanup снимает разрешение React-записей");
ok(/dispatchSmc\(\{ type: "unmount" \}\)/.test(chartCode), "P1-C: unmount идёт через машину состояний (abort)");
ok(/smcCommitter\.commit\(/.test(chartCode), "P1-C: переходы применяются через гейт");
ok(/new AbortController\(\)/.test(chartCode), "P1-C: AbortController сохранён");
ok(/buildSmcPanelViewModel\(smcPanel\.projection, exchange\)/.test(chartCode), "P1-C: view-model знает выбранную биржу");
ok(/<SmartMoneyPanel/.test(CHART_SRC), "P1-C: панель рендерится компонентом");
ok(!/setSmcEnabled\s*\(|setSmcPanel\s*\(/.test(chartCode), "P1-C: React-сеттеры SMC вызываются только через гейт");

// Компактный UX панели (progressive disclosure) не тронут этим фиксом.
const panelCode = stripComments(PANEL_SRC);
eq((panelCode.match(/<details/g) ?? []).length, 2, "P1-C: два native <details> — «Почему» и «Технические детали»");
ok(!/<details[^>]*\bopen\b/.test(PANEL_SRC), "P1-C: все <details> закрыты по умолчанию");
ok(/<summary style=\{SUMMARY_STYLE\}>Почему<\/summary>/.test(PANEL_SRC), "P1-C: WHY раскрывается по действию пользователя");
ok(
  /<summary style=\{SUMMARY_STYLE\}>Технические детали<\/summary>/.test(PANEL_SRC),
  "P1-C: техническая диагностика — в collapsed-блоке"
);
ok(/cannot-evaluate/.test(PANEL_SRC), "P1-C: cannot-evaluate по-прежнему отдельный verdict");
ok(/refusalSummary/.test(PANEL_SRC), "P1-C: краткая безопасная причина отказа сохранена");
ok(!/reason\.value/.test(stripComments(PANEL_SRC).replace(/value: reason\.value/g, "")), "P1-C: raw value не рендерится в WHY");

/* ---------- защищённые пути и безопасность ---------- */

for (const token of [
  "smc-contract",
  "smc-projection",
  "smc-api-service",
  "prisma",
  "PrismaClient",
  "createSignal",
  "signalWorker",
  "lib/signals"
]) {
  ok(
    !chartCode.includes(token),
    `chart: нет обращения к защищённому пути/Signal (${token})`
  );
}
ok(
  !/method\s*:/.test(chartCode),
  "chart: все запросы GET (method: POST/PUT не появился)"
);
eq(
  (chartCode.match(/fetch\s*\(/g) ?? []).length,
  5,
  "chart: ровно пять fetch — markets, markets?symbol, candles, candles?before (история), SMC; новых запросов нет"
);

/* ---------- формулировки: баллы, не вероятность ---------- */

const FORBIDDEN = /вероятн|шанс|прогноз|accuracy|probability/i;
const noteText = extractBetween(CHART_SRC, ". Навигация: перетаскивание", "{historyEnded", "подсказка о навигации");
ok(!FORBIDDEN.test(noteText), "текст навигации: нет вероятностных формулировок");
ok(!noteText.includes("%"), "текст навигации: нет процентов");
ok(!FORBIDDEN.test(UX_SRC), "lib/chart/chart-ux: нет вероятностных формулировок");
ok(!/%/.test(UX_SRC.replace(/\/\*[\s\S]*?\*\//g, "")), "lib/chart/chart-ux: нет процентов");

/* ================================================================ */
/* 5. Вертикальный масштаб: AUTO-запас vs MANUAL-свобода             */
/* ================================================================ */

console.log("\n=== 5. Вертикальный масштаб основной панели ===");

/** Типичная геометрия: панель 240px, легенда в две строки (низ 62px). */
const DESKTOP_PANE_PX = 240;
const DESKTOP_LEGEND_BOTTOM_PX = 62;
/** Мобильная геометрия: панель 254px, легенда в пять строк (низ 124px). */
const MOBILE_PANE_PX = 254;
const MOBILE_LEGEND_BOTTOM_PX = 124;
/** Видимый диапазон pump'а: high 110, low 100. */
const PUMP_HIGH = 110;
const PUMP_LOW = 100;
const PUMP_SPAN = PUMP_HIGH - PUMP_LOW;

/* ---------- 5.1 Явные scaleMargins основной панели ---------- */

eq(
  SUSLIK_MAIN_PANE_SCALE_MARGINS,
  { top: 0.2, bottom: 0.1 },
  "margins: основная панель имеет ЯВНЫЕ top/bottom отступы (не молчаливый дефолт)"
);
eq(
  Object.keys(SUSLIK_MAIN_PANE_SCALE_MARGINS).sort(),
  ["bottom", "top"],
  "margins: ключи — ровно документированный PriceScaleMargins"
);
ok(
  validateScaleMargins(SUSLIK_MAIN_PANE_SCALE_MARGINS).ok,
  "margins: значения проходят штатную валидацию библиотеки"
);
eq(
  validateScaleMargins(SUSLIK_MAIN_PANE_SCALE_MARGINS).reason,
  null,
  "margins: причина ошибки отсутствует"
);
ok(
  SUSLIK_MAIN_PANE_SCALE_MARGINS.top > 0 &&
    SUSLIK_MAIN_PANE_SCALE_MARGINS.bottom > 0,
  "margins: отступы сверху и снизу положительные (разумный padding)"
);
ok(
  SUSLIK_MAIN_PANE_SCALE_MARGINS.top +
    SUSLIK_MAIN_PANE_SCALE_MARGINS.bottom <
    1,
  "margins: top + bottom < 1 (требование lightweight-charts)"
);
ok(
  SUSLIK_MAIN_PANE_SCALE_MARGINS.top +
    SUSLIK_MAIN_PANE_SCALE_MARGINS.bottom <=
    0.5,
  "margins: сумма ≤ 0.5 — полоса рисования не меньше половины панели (ручной zoom не зажат)"
);
ok(
  !("scaleMargins" in SUSLIK_RIGHT_PRICE_SCALE),
  "margins: chart-level rightPriceScale отступов не содержит → RSI/MACD остаются на штатных дефолтах"
);

// Валидация повторяет правила PriceScale._internal_applyOptions
// (top/bottom в 0..1, сумма не больше 1).
for (const bad of [
  { top: -0.1, bottom: 0.1 },
  { top: 0.1, bottom: -0.2 },
  { top: 1.2, bottom: 0 },
  { top: 0, bottom: 1.5 },
  { top: 0.7, bottom: 0.5 },
  { top: Number.NaN, bottom: 0.1 },
  { top: 0.1, bottom: Number.POSITIVE_INFINITY },
  {
    top: undefined as unknown as number,
    bottom: 0.1
  },
  null,
  undefined
]) {
  const res = validateScaleMargins(bad);

  ok(
    !res.ok,
    `margins validation: ${JSON.stringify(bad)} отклоняется`
  );
  ok(
    typeof res.reason === "string" && res.reason.length > 0,
    `margins validation: ${JSON.stringify(bad)} — причина названа`
  );
}
for (const good of [
  { top: 0, bottom: 0 },
  { top: 0.999, bottom: 0 },
  { top: 0.5, bottom: 0.5 },
  { top: 0.2, bottom: 0.1 }
]) {
  ok(
    validateScaleMargins(good).ok,
    `margins validation: ${JSON.stringify(good)} принимается`
  );
}

/* ---------- 5.2 Геометрия полосы рисования ---------- */

{
  const band = priceScaleBand({ paneHeightPx: DESKTOP_PANE_PX });

  eq(band.topMarginPx, 48, "band: верхний отступ = top × высота панели");
  eq(band.bottomMarginPx, 24, "band: нижний отступ = bottom × высота панели");
  eq(band.bandPx, 168, "band: полоса рисования = высота − отступы");
}
{
  const band = priceScaleBand({
    paneHeightPx: DESKTOP_PANE_PX,
    margins: { top: 0.25, bottom: 0.25 }
  });

  eq(band.bandPx, 120, "band: собственные отступы учитываются");
}
for (const bad of [0, -100, Number.NaN, Number.POSITIVE_INFINITY]) {
  const band = priceScaleBand({ paneHeightPx: bad });

  ok(
    band.bandPx === 0 && band.topMarginPx === 0 && band.bottomMarginPx === 0,
    `band: вырожденная высота ${String(bad)} → нули, без NaN`
  );
}
{
  const band = priceScaleBand({
    paneHeightPx: DESKTOP_PANE_PX,
    margins: { top: 0.9, bottom: 0.9 }
  });

  ok(
    Math.abs(
      band.bandPx -
        DESKTOP_PANE_PX *
          (1 -
            SUSLIK_MAIN_PANE_SCALE_MARGINS.top -
            SUSLIK_MAIN_PANE_SCALE_MARGINS.bottom)
    ) < 1e-9,
    "band: невалидные отступы откатываются к константе основной панели"
  );
}

/* ---------- 5.3 Штатный mapping экстремумов ---------- */

// Без запаса библиотека кладёт high/low ВПЛОТНУЮ к границам полосы —
// именно это и выглядело как «цена уходит за верхнюю границу».
{
  const naked = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: PUMP_LOW,
    rangeMax: PUMP_HIGH,
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW
  });

  ok(naked !== null, "projection: валидный вход проецируется");
  eq(naked!.highY, naked!.bandTopY, "projection без запаса: high лежит на верхней границе полосы");
  eq(naked!.lowY, naked!.bandBottomY, "projection без запаса: low лежит на нижней границе полосы");
  eq(naked!.highClearancePx, 0, "projection без запаса: зазора над high нет");
  eq(naked!.lowClearancePx, 0, "projection без запаса: зазора под low нет");
}
// Экстремум вне диапазона шкалы детектируется (fits = false), а не
// прячется клампом.
{
  const clipped = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: PUMP_LOW,
    rangeMax: PUMP_HIGH,
    visibleHigh: PUMP_HIGH + 5,
    visibleLow: PUMP_LOW
  });

  ok(clipped !== null, "projection/clipped: проекция существует");
  ok(
    clipped!.highClearancePx < 0,
    "projection/clipped: high за пределами диапазона → clearance отрицательный"
  );
  ok(!clipped!.fits, "projection/clipped: обрезанный экстремум помечен как не помещающийся");
}
for (const bad of [
  { paneHeightPx: 0, rangeMin: 100, rangeMax: 110 },
  { paneHeightPx: 240, rangeMin: 110, rangeMax: 110 },
  { paneHeightPx: 240, rangeMin: 120, rangeMax: 110 },
  { paneHeightPx: 240, rangeMin: Number.NaN, rangeMax: 110 },
  { paneHeightPx: Number.NaN, rangeMin: 100, rangeMax: 110 }
]) {
  eq(
    projectAutoscaleExtremes(bad),
    null,
    `projection: вырожденный вход ${JSON.stringify(bad)} → null (диапазон расширяет библиотека)`
  );
}

/* ---------- 5.4 AUTO-запас: pump/dump видны полностью ---------- */

{
  const pad = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: DESKTOP_LEGEND_BOTTOM_PX
  });

  ok(pad.above > 0 && pad.below > 0, "padding desktop: запас есть сверху и снизу");
  ok(
    Math.abs(pad.below - PUMP_SPAN * AUTOSCALE_SPAN_PAD_RATIO) < 1e-9,
    "padding desktop: нижний запас — доля видимого спана (пропорционально волатильности)"
  );
  ok(
    pad.above > pad.below,
    "padding desktop: верхний запас больше нижнего — сверху легенда"
  );
  eq(pad.legendReservePx, 14, "padding desktop: легенда занимает 14px сверх верхнего отступа");
  ok(
    pad.legendReserveRatio > 0 &&
      pad.legendReserveRatio <= AUTOSCALE_LEGEND_RESERVE_MAX,
    "padding desktop: резерв под легенду в допустимых долях полосы"
  );

  const proj = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: PUMP_LOW - pad.below,
    rangeMax: PUMP_HIGH + pad.above,
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW
  });

  ok(proj !== null, "padding desktop: проекция с запасом существует");
  ok(proj!.fits, "padding desktop: pump high/low помещаются в полосу");
  ok(
    proj!.highClearancePx >= AUTOSCALE_MIN_EDGE_PAD_PX,
    "padding desktop: high НЕ вплотную к краю полосы"
  );
  ok(
    proj!.lowClearancePx >= AUTOSCALE_MIN_EDGE_PAD_PX,
    "padding desktop: low НЕ вплотную к краю полосы"
  );
  ok(
    proj!.highY >= DESKTOP_LEGEND_BOTTOM_PX - 1e-9,
    "padding desktop: pump high ниже legend-бокса (не уходит под легенду)"
  );
  ok(
    proj!.highY > 0 && proj!.lowY < DESKTOP_PANE_PX - 1,
    "padding desktop: экстремумы внутри панели, а не за её границей"
  );
}

// Мобильный layout: легенда в пять строк перекрывает половину панели.
{
  const pad = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: MOBILE_PANE_PX,
    legendBottomPx: MOBILE_LEGEND_BOTTOM_PX
  });
  const proj = projectAutoscaleExtremes({
    paneHeightPx: MOBILE_PANE_PX,
    rangeMin: PUMP_LOW - pad.below,
    rangeMax: PUMP_HIGH + pad.above,
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW
  });

  ok(proj !== null && proj.fits, "padding mobile: pump помещается в полосу");
  ok(
    proj!.highY >= MOBILE_LEGEND_BOTTOM_PX - 1e-9,
    "padding mobile: pump high ниже высокой легенды"
  );
  ok(
    (proj!.lowY - proj!.highY) / proj!.bandPx >= 0.5,
    "padding mobile: видимые свечи занимают не меньше половины полосы (не полоска)"
  );
}

// Легенды нет (скрыта на узких экранах / ещё не отрисована).
{
  const pad = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: 0
  });

  eq(pad.legendReservePx, 0, "padding без легенды: резерв нулевой");
  ok(
    Math.abs(pad.above - pad.below) < 1e-9,
    "padding без легенды: запас симметричный"
  );
  ok(
    Math.abs(pad.above - PUMP_SPAN * AUTOSCALE_SPAN_PAD_RATIO) < 1e-9,
    "padding без легенды: минимум — минимальный краевой зазор либо доля спана"
  );

  const proj = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: PUMP_LOW - pad.below,
    rangeMax: PUMP_HIGH + pad.above,
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW
  });

  ok(
    proj !== null && proj.highClearancePx >= AUTOSCALE_MIN_EDGE_PAD_PX,
    "padding без легенды: экстремумы всё равно не вплотную к краю"
  );
}

// Экстремальная легенда: резерв ограничен, свечи не превращаются в полоску.
{
  const pad = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: DESKTOP_PANE_PX
  });

  ok(
    pad.legendReserveRatio <= AUTOSCALE_LEGEND_RESERVE_MAX + 1e-12,
    "padding extreme: резерв под легенду ограничен константой"
  );
  ok(
    pad.above <= PUMP_SPAN,
    "padding extreme: запас сверху не превышает видимый спан"
  );
  const total = PUMP_SPAN + pad.above + pad.below;
  ok(
    PUMP_SPAN / total >= 0.5,
    "padding extreme: видимые свечи занимают ≥ половины диапазона"
  );
}

// Монотонность: больше легенда → больше запас сверху.
{
  const a = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: 40
  });
  const b = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: 80
  });
  const c = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: 120
  });

  ok(a.above <= b.above && b.above <= c.above, "padding: запас сверху монотонно растёт с высотой легенды");
  ok(
    a.below === b.below && b.below === c.below,
    "padding: нижний запас от легенды не зависит"
  );

  const small = autoscalePadding({
    visibleHigh: 101,
    visibleLow: 100,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: DESKTOP_LEGEND_BOTTOM_PX
  });
  const big = autoscalePadding({
    visibleHigh: 200,
    visibleLow: 100,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: DESKTOP_LEGEND_BOTTOM_PX
  });

  ok(big.above > small.above, "padding: запас растёт вместе с видимым спаном (сильный pump)");
}

// Вырожденные и мусорные входы.
for (const bad of [
  { visibleHigh: 100, visibleLow: 100, paneHeightPx: 240, legendBottomPx: 62 },
  { visibleHigh: 90, visibleLow: 100, paneHeightPx: 240, legendBottomPx: 62 },
  { visibleHigh: Number.NaN, visibleLow: 100, paneHeightPx: 240, legendBottomPx: 62 },
  { visibleHigh: 110, visibleLow: Number.NaN, paneHeightPx: 240, legendBottomPx: 62 },
  { visibleHigh: 110, visibleLow: 100, paneHeightPx: 0, legendBottomPx: 62 },
  { visibleHigh: 110, visibleLow: 100, paneHeightPx: -50, legendBottomPx: 62 },
  { visibleHigh: 110, visibleLow: 100, paneHeightPx: Number.NaN, legendBottomPx: 62 },
  { visibleHigh: 110, visibleLow: 100, paneHeightPx: 240, legendBottomPx: -20 },
  { visibleHigh: 110, visibleLow: 100, paneHeightPx: 240, legendBottomPx: Number.NaN },
  { visibleHigh: 110, visibleLow: 100, paneHeightPx: 240, legendBottomPx: Number.POSITIVE_INFINITY }
]) {
  const pad = autoscalePadding(bad);

  ok(
    Number.isFinite(pad.above) && pad.above >= 0,
    `padding garbage ${JSON.stringify(bad)}: above конечный и неотрицательный`
  );
  ok(
    Number.isFinite(pad.below) && pad.below >= 0,
    `padding garbage ${JSON.stringify(bad)}: below конечный и неотрицательный`
  );
  ok(
    Number.isFinite(pad.legendReserveRatio) &&
      pad.legendReserveRatio >= 0 &&
      pad.legendReserveRatio <= AUTOSCALE_LEGEND_RESERVE_MAX + 1e-12,
    `padding garbage ${JSON.stringify(bad)}: резерв в допустимых границах`
  );
}
eq(
  autoscalePadding({
    visibleHigh: 100,
    visibleLow: 100,
    paneHeightPx: 240,
    legendBottomPx: 62
  }),
  { above: 0, below: 0, legendReservePx: 0, legendReserveRatio: 0 },
  "padding: вырожденный диапазон не трогаем (его расширяет библиотека на 5 × minMove)"
);

// Собственные параметры политики.
{
  const pad = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: 0,
    spanPadRatio: 0.1,
    minEdgePadPx: 0
  });

  ok(
    Math.abs(pad.above - PUMP_SPAN * 0.1) < 1e-9,
    "padding params: spanPadRatio переопределяется"
  );
  const capped = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: DESKTOP_PANE_PX,
    legendReserveMax: 0.1
  });

  ok(
    capped.legendReserveRatio <= 0.1 + 1e-12,
    "padding params: legendReserveMax ограничивает резерв"
  );
  const customMargins = autoscalePadding({
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    paneHeightPx: DESKTOP_PANE_PX,
    legendBottomPx: MOBILE_LEGEND_BOTTOM_PX,
    margins: { top: 0.4, bottom: 0.1 }
  });
  const customProj = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: PUMP_LOW - customMargins.below,
    rangeMax: PUMP_HIGH + customMargins.above,
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW,
    margins: { top: 0.4, bottom: 0.1 }
  });

  eq(customProj!.bandTopY, 96, "padding params: собственные отступы меняют геометрию полосы");
  ok(
    customProj!.highY >= MOBILE_LEGEND_BOTTOM_PX - 1e-9,
    "padding params: запас считается под фактическую полосу — high снова ниже легенды"
  );
  ok(
    customProj!.fits,
    "padding params: экстремумы помещаются и с собственными отступами"
  );
}

/* ---------- 5.5 Штатный autoscaleInfoProvider ---------- */

const provider = createMainPaneAutoscaleProvider({
  paneHeightPx: () => DESKTOP_PANE_PX,
  legendBottomPx: () => DESKTOP_LEGEND_BOTTOM_PX
});
const baseInfo = () => ({
  priceRange: { minValue: PUMP_LOW, maxValue: PUMP_HIGH }
});

{
  const res = provider(baseInfo);

  ok(res !== null && res.priceRange !== null, "provider: результат валиден");
  ok(
    res!.priceRange!.maxValue > PUMP_HIGH,
    "provider: диапазон расширен сверху (pump high не в край)"
  );
  ok(
    res!.priceRange!.minValue < PUMP_LOW,
    "provider: диапазон расширен снизу (dump low не в край)"
  );
  ok(
    res!.priceRange!.minValue <= PUMP_LOW &&
      res!.priceRange!.maxValue >= PUMP_HIGH,
    "provider: видимые high/low НЕ клампятся и не подменяются (семантика OHLC сохранена)"
  );
  ok(
    res!.priceRange!.maxValue - res!.priceRange!.minValue > PUMP_SPAN,
    "provider: диапазон только шире базового — сужения нет"
  );
  eq(res!.margins, undefined, "provider: px-составляющая AutoScaleMargins не используется (ручной режим не сжимается)");

  const proj = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: res!.priceRange!.minValue,
    rangeMax: res!.priceRange!.maxValue,
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW
  });

  ok(
    proj !== null && proj.fits,
    "provider: pump полностью помещается в основную панель"
  );
  ok(
    proj!.highY >= DESKTOP_LEGEND_BOTTOM_PX - 1e-9,
    "provider: pump high рисуется ниже легенды"
  );
}
eq(provider(() => null), null, "provider: null от базовой реализации пробрасывается");
eq(
  provider(() => ({ priceRange: null })),
  { priceRange: null },
  "provider: пустой диапазон пробрасывается без падения"
);
{
  const degenerate = provider(() => ({
    priceRange: { minValue: 100, maxValue: 100 }
  }));

  eq(
    degenerate,
    { priceRange: { minValue: 100, maxValue: 100 }, margins: undefined },
    "provider: вырожденный диапазон возвращается как есть (расширяет библиотека)"
  );
}
{
  const withMargins = provider(() => ({
    priceRange: { minValue: PUMP_LOW, maxValue: PUMP_HIGH },
    margins: { above: 3, below: 4 }
  }));

  eq(
    withMargins!.margins,
    { above: 3, below: 4 },
    "provider: чужие px-margins пробрасываются без изменений"
  );
}
{
  const zeroGeometry = createMainPaneAutoscaleProvider({
    paneHeightPx: () => 0,
    legendBottomPx: () => 0
  })(baseInfo);

  ok(
    zeroGeometry!.priceRange!.maxValue > PUMP_HIGH &&
      zeroGeometry!.priceRange!.minValue < PUMP_LOW,
    "provider: без измерений панели остаётся пропорциональный запас"
  );
}
{
  const throwing = createMainPaneAutoscaleProvider({
    paneHeightPx: () => Number.NaN,
    legendBottomPx: () => Number.POSITIVE_INFINITY
  })(baseInfo);

  ok(
    Number.isFinite(throwing!.priceRange!.maxValue) &&
      Number.isFinite(throwing!.priceRange!.minValue),
    "provider: мусорная геометрия не даёт NaN в диапазон"
  );
}
// Ни при какой геометрии провайдер не сужает диапазон.
for (const paneHeightPx of [0, 60, 120, 240, 400, 800]) {
  for (const legendBottomPx of [0, 30, 62, 124, 240, 400]) {
    const res = createMainPaneAutoscaleProvider({
      paneHeightPx: () => paneHeightPx,
      legendBottomPx: () => legendBottomPx
    })(baseInfo);

    ok(
      res!.priceRange!.minValue <= PUMP_LOW &&
        res!.priceRange!.maxValue >= PUMP_HIGH,
      `provider grid H=${String(paneHeightPx)} legend=${String(legendBottomPx)}: диапазон не уже базового`
    );
  }
}

/* ---------- 5.6 AUTO и MANUAL — разные режимы ---------- */

{
  const auto = verticalScaleModePolicy("auto");
  const manual = verticalScaleModePolicy("manual");

  eq(auto.mode, "auto", "policy: режим AUTO");
  eq(manual.mode, "manual", "policy: режим MANUAL");
  eq(auto.paddingApplied, true, "policy AUTO: запас применяется (экстремумы не обрезаются)");
  eq(
    manual.paddingApplied,
    false,
    "policy MANUAL: запас НЕ применяется — ручной вертикальный zoom свободен"
  );
  ok(
    auto.rangeSource !== manual.rangeSource,
    "policy: источники диапазона AUTO и MANUAL различаются (default padding ≠ manual freedom)"
  );
  eq(auto.clamps.length, 0, "policy AUTO: искусственных ограничений нет");
  eq(
    manual.clamps.length,
    0,
    "policy MANUAL: никаких собственных min/max clamp'ов вертикального zoom'а"
  );
  eq(
    auto.restoredBy.length,
    0,
    "policy AUTO: auto-scale не «возвращается» сам (нечего возвращать)"
  );
  eq(
    manual.restoredBy.length,
    3,
    "policy MANUAL: auto-scale возвращается двойным кликом по шкале, кнопкой сброса и двойным кликом по графику"
  );
  ok(
    manual.restoredBy.some((r) => r.includes("axisDoubleClickReset.price")),
    "policy MANUAL: двойной клик по ценовой шкале — штатный возврат auto-scale"
  );
  ok(
    manual.restoredBy.some((r) => r.includes("Сбросить масштаб")),
    "policy MANUAL: кнопка «Сбросить масштаб» возвращает auto-scale"
  );
  eq(
    auto.scaleMarginsApplied,
    manual.scaleMarginsApplied,
    "policy: scaleMargins — общая геометрия полосы, режим не переключают"
  );
}
// Ручное «сплющивание» и растягивание приложение не ограничивает:
// ручной диапазон просто проецируется как есть.
{
  const flattened = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: 0,
    rangeMax: 1000,
    visibleHigh: PUMP_HIGH,
    visibleLow: PUMP_LOW
  });

  ok(
    flattened !== null && flattened.fits,
    "manual: сильный ручной zoom out (свечи полоской)проецируется без ограничений"
  );
  ok(
    flattened!.lowY - flattened!.highY < 5,
    "manual: сплющенные свечи занимают несколько пикселей — приложение их не растягивает принудительно"
  );

  const stretched = projectAutoscaleExtremes({
    paneHeightPx: DESKTOP_PANE_PX,
    rangeMin: 99.9,
    rangeMax: 100.1,
    visibleHigh: 100.1,
    visibleLow: 99.9
  });

  ok(
    stretched !== null && stretched.fits,
    "manual: сильный ручной zoom in (растянутые свечи) проектируется без ограничений"
  );
  ok(
    stretched!.lowY - stretched!.highY > 100,
    "manual: растянутые свечи занимают почти всю полосу — clamp'ов нет"
  );
}

/* ---------- 5.7 Жесты: время и цена разделены ---------- */

{
  const rows = chartGestureBindings(
    SUSLIK_HANDLE_SCROLL,
    SUSLIK_HANDLE_SCALE
  );

  eq(rows.length, 9, "gestures: полная карта жестов (9 строк)");
  ok(
    rows.every((r) => r.axis === "time" || r.axis === "price"),
    "gestures: ось — только time или price"
  );

  const enabledPrice = rows.filter(
    (r) => r.axis === "price" && r.enabled
  );

  eq(
    enabledPrice.length,
    2,
    "gestures: цену масштабируют ровно два жеста — drag по правой шкале и двойной клик по ней"
  );
  ok(
    enabledPrice.some((r) => r.gesture.includes("drag по правой ценовой шкале")),
    "gestures: drag по правой ценовой шкале → вертикальный масштаб (axisPressedMouseMove.price)"
  );
  ok(
    enabledPrice.some((r) => r.gesture.includes("двойной клик по ценовой шкале")),
    "gestures: двойной клик по ценовой шкале → возврат price auto-scale"
  );
  eq(
    rows.filter((r) => r.axis === "price" && r.gesture.includes("колесо")).length,
    0,
    "gestures: колесо НЕ масштабирует цену — вертикальный zoom колесом не подменяется"
  );
  ok(
    rows.every(
      (r) => !r.gesture.includes("колесо") || r.axis === "time"
    ),
    "gestures: любое колесо — это время/история"
  );

  const find = (gesture: string) =>
    rows.find((r) => r.gesture === gesture);

  eq(find("drag по plot")?.axis, "time", "gestures: drag по plot — движение по истории");
  eq(find("drag по plot")?.enabled, true, "gestures: drag по plot включён");
  eq(find("колесо/свайп deltaY")?.axis, "time", "gestures: deltaY — zoom временной шкалы");
  eq(find("колесо/свайп deltaY")?.enabled, true, "gestures: deltaY включён");
  eq(find("колесо/свайп deltaX")?.axis, "time", "gestures: deltaX — движение по истории");
  eq(find("drag по оси времени")?.enabled, true, "gestures: drag по оси времени растягивает время");
  eq(find("pinch")?.axis, "time", "gestures: pinch — время");
  eq(
    find("вертикальный touch-драг")?.enabled,
    false,
    "gestures: вертикальный touch отдан странице (цена пальцем не перехватывается)"
  );

  // Штатная нормализация boolean → обе оси.
  const normalized = chartGestureBindings(SUSLIK_HANDLE_SCROLL, {
    ...SUSLIK_HANDLE_SCALE,
    axisPressedMouseMove: true,
    axisDoubleClickReset: true
  });

  ok(
    normalized
      .filter((r) => r.axis === "price" && r.enabled)
      .some((r) => r.gesture.includes("drag по правой ценовой шкале")),
    "gestures: axisPressedMouseMove = true нормализуется и для цены"
  );
  const disabled = chartGestureBindings(SUSLIK_HANDLE_SCROLL, {
    ...SUSLIK_HANDLE_SCALE,
    axisPressedMouseMove: false
  });

  ok(
    !disabled
      .filter((r) => r.axis === "price" && r.enabled)
      .some((r) => r.gesture.includes("drag")),
    "gestures: axisPressedMouseMove = false действительно выключает вертикальный drag"
  );
}

/* ---------- 5.8 Статические гарды CandleChart ---------- */

const metricsCode = extractBetween(
  chartCode,
  "const applyChartMetrics = useCallback(",
  "const resetChartScale = useCallback(",
  "applyChartMetrics CandleChart"
);
const marginsCode = extractBetween(
  chartCode,
  "const applyMainPaneScaleMargins = useCallback(",
  "const applyChartMetrics = useCallback(",
  "applyMainPaneScaleMargins CandleChart"
);
const legendCode = extractBetween(
  chartCode,
  "const renderLegendAt = useCallback(",
  "const applyData = useCallback(",
  "renderLegendAt CandleChart"
);
const createChartCode = extractBetween(
  chartCode,
  "const chart = createChart(container, {",
  "chartRef.current = chart;",
  "createChart CandleChart"
);

eq(
  (chartCode.match(/autoscaleInfoProvider/g) ?? []).length,
  1,
  "chart: autoscaleInfoProvider задан ровно один раз — серия свечей"
);
ok(
  /createMainPaneAutoscaleProvider\(\{/.test(chartCode),
  "chart: запас считается чистой функцией из lib/chart/chart-ux"
);
eq(
  (chartCode.match(/SUSLIK_MAIN_PANE_SCALE_MARGINS/g) ?? []).length,
  2,
  "chart: отступы основной панели — константа модуля (импорт + применение)"
);
eq(
  (chartCode.match(/scaleMargins/g) ?? []).length,
  2,
  "chart: scaleMargins только у volume-overlay и основной панели"
);
ok(
  /scaleMargins: \{\s*top: 0\.82,\s*bottom: 0\s*\}/.test(chartCode),
  "chart: volume-overlay остался в нижней части панели (top 0.82)"
);
ok(
  /scale\.applyOptions\(\{\s*scaleMargins: SUSLIK_MAIN_PANE_SCALE_MARGINS\s*\}\)/.test(
    chartCode
  ),
  "chart: отступы применяются к шкале серии свечей, а не chart-level"
);
ok(
  /const scale = candle\.priceScale\(\);/.test(marginsCode),
  "chart: шкала берётся у серии свечей → это панель 0, а не RSI/MACD"
);
ok(
  !/chart\s*\.\s*applyOptions\(\{[\s\S]{0,400}?rightPriceScale[\s\S]{0,200}?scaleMargins/.test(
    chartCode
  ),
  "chart: chart-level applyOptions не меняет отступы (иначе задели бы RSI/MACD)"
);
ok(
  !/rightPriceScale: \{[\s\S]{0,300}?scaleMargins/.test(createChartCode),
  "chart: в createChart у rightPriceScale отступов нет"
);
ok(
  !/(rsiRef|macdLineRef|macdSignalRef|macdHistRef)[\s\S]{0,300}?scaleMargins/.test(
    chartCode
  ),
  "chart: у серий RSI/MACD отступы не переопределяются (свой autoscale сохранён)"
);
ok(
  /if \(scale\.options\(\)\.autoScale !== true\) \{/.test(marginsCode),
  "chart: при выключенном auto-scale шкала не трогается — ручной масштаб не отменяется"
);
eq(
  (chartCode.match(/setAutoScale\(/g) ?? []).length,
  1,
  "chart: setAutoScale вызывается ровно один раз — в сбросе масштаба"
);
eq(
  (chartCode.match(/autoScale/g) ?? []).length,
  1,
  "chart: autoScale упоминается только в гарде ручного режима (эффекты его не переключают)"
);
eq(
  (chartCode.match(/setVisibleRange\(/g) ?? []).length,
  0,
  "chart: setVisibleRange не вызывается — ценовой диапазон приложение не навязывает"
);
eq(
  (chartCode.match(/margins:/g) ?? []).length,
  0,
  "chart: px-составляющая AutoScaleMargins не используется (она сжимала бы полосу и в ручном режиме)"
);
for (const token of [
  "Math.min",
  "Math.max",
  "priceRange",
  "clamp",
  "minBarHeight",
  "onMouseMove",
  "onPointerMove",
  "onPointerDown",
  "onTouchMove",
  "onWheel",
  "wheel",
  "setPointerCapture",
  "getBoundingClientRect"
]) {
  ok(
    !chartCode.includes(token),
    `chart: нет собственной вертикальной физики/клампов (${token})`
  );
}
ok(
  /chart\.panes\(\)\[0\]\?\.getHeight\(\)/.test(chartCode),
  "chart: высота основной панели измеряется штатным getHeight()"
);
ok(
  /legendEl\.offsetTop \+/.test(metricsCode) &&
    /legendEl\.offsetHeight/.test(metricsCode),
  "chart: нижний край легенды измеряется, а не хардкодится"
);
ok(
  !/legendBottomPx = [1-9]/.test(metricsCode) &&
    !/paneHeightPx = [1-9]/.test(metricsCode),
  "chart: вертикальная геометрия не задана хардкодом"
);
ok(
  /LEGEND_BOTTOM_GAP_PX/.test(metricsCode),
  "chart: зазор под легендой — константа модуля"
);
ok(
  /if \(verticalUnchanged\) \{\s*return;/.test(metricsCode),
  "chart: отступы перечитываются только при реальном изменении геометрии (не на каждое движение курсора)"
);
ok(
  /applyMainPaneScaleMargins\(\);/.test(metricsCode),
  "chart: изменение геометрии перечитывает autoscale основной панели"
);
ok(
  legendCode.indexOf("legendHtml(") < legendCode.indexOf("applyChartMetrics()") &&
    legendCode.indexOf("legendHtml(") !== -1,
  "chart: метрики считаются ПОСЛЕ записи легенды (высота легенды фактическая)"
);
ok(
  /paneHeightPx: \(\) => \{/.test(chartCode),
  "chart: провайдер читает высоту панели в момент пересчёта (не кэш)"
);
ok(
  /legendBottomPx: \(\) =>/.test(chartCode),
  "chart: провайдер читает нижний край легенды в момент пересчёта"
);
ok(
  /\}, \[applyMainPaneScaleMargins\]\);/.test(chartCode),
  "chart: applyChartMetrics остаётся стабильным useCallback"
);
ok(
  /\}, \[applyChartTheme, renderLegendAt, applyChartMetrics\]\);/.test(chartCode),
  "chart: эффект создания графика по-прежнему создаёт график один раз"
);
ok(
  /setStretchFactor\(4\)/.test(chartCode),
  "chart: stretch-фактор основной панели не менялся"
);

/* ---------- 5.9 Легенда не закрывает ценовую шкалу (прежний фикс) ---------- */

{
  const space = legendSpace({
    plotWidth: 1160,
    priceScaleWidth: 76.4,
    leftInset: 8,
    containerWidth: 1240
  });

  ok(
    (space.maxWidthPx ?? 0) + 8 + LEGEND_RIGHT_GAP_PX <= 1160,
    "legend/price axis: правый край легенды левее ценовой шкалы — drag по шкале не перекрыт"
  );
  ok(
    space.reservedRightPx >= Math.ceil(76.4),
    "legend/price axis: резерв под шкалу сохранён"
  );
}
ok(
  /right: calc\(var\(--chart-price-scale-w, 0px\) \+ 10px\)/.test(cssCode),
  "CSS: кнопка сброса сдвинута левее ценовой шкалы — ось остаётся доступной для drag'а"
);
ok(
  /pointer-events: none/.test(
    extractBetween(cssCode, ".chartLegend {", "}", "CSS .chartLegend (5)")
  ),
  "CSS: легенда не перехватывает pointer-события графика и ценовой шкалы"
);
eq(LEGEND_BOTTOM_GAP_PX, 4, "legend: зазор под легендой — константа модуля");
ok(
  AUTOSCALE_SPAN_PAD_RATIO > 0 && AUTOSCALE_SPAN_PAD_RATIO < 0.2,
  "padding: доля спана разумная (не раздувает диапазон)"
);
ok(
  AUTOSCALE_MIN_EDGE_PAD_PX >= 1 && AUTOSCALE_MIN_EDGE_PAD_PX <= 8,
  "padding: минимальный краевой зазор — единицы пикселей"
);
ok(
  AUTOSCALE_LEGEND_RESERVE_MAX > 0 && AUTOSCALE_LEGEND_RESERVE_MAX <= 0.5,
  "padding: резерв под легенду не может съесть больше половины полосы"
);

/* ---------- итог ---------- */

console.log(`\nItog: ${passed}/${total}`);

if (failures.length > 0) {
  console.error("Проваленные проверки:");

  for (const f of failures) {
    console.error(`  - ${f}`);
  }
}

process.exit(failures.length === 0 ? 0 : 1);
