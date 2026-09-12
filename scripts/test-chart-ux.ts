/**
 * Chart UX regression (fix поверх P1-C): навигация/масштаб собственного
 * SuslikChart, резерв места под правую ценовую шкалу (легенда не
 * перекрывает price scale), сохранение ручного viewport при подгрузке
 * истории, а также статические гарды на CandleChart.tsx и globals.css.
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
  LEGEND_RIGHT_GAP_PX,
  SUSLIK_HANDLE_SCALE,
  SUSLIK_HANDLE_SCROLL,
  SUSLIK_KINETIC_SCROLL,
  SUSLIK_RIGHT_PRICE_SCALE,
  SUSLIK_TIME_SCALE_NAVIGATION,
  legendSpace,
  shiftLogicalRange
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

/* ---------- итог ---------- */

console.log(`\nItog: ${passed}/${total}`);

if (failures.length > 0) {
  console.error("Проваленные проверки:");

  for (const f of failures) {
    console.error(`  - ${f}`);
  }
}

process.exit(failures.length === 0 ? 0 : 1);
