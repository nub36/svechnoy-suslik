"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useRouter } from "next/navigation";
import {
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type HistogramData,
  type LineData,
    type UTCTimestamp
} from "lightweight-charts";
import {
  emaSeries,
  macdSeries,
  rsiSeries,
  smaSeries
} from "@/lib/indicators";
import {
  candlesIntegrityOk,
  mergeOlder,
  nextStatusAfterListFailure,
  resolveSymbolFromList
} from "@/lib/chart/history";
import { candleFreshness } from "@/lib/data/freshness";
import {
  buildChartSearch,
  CHART_TIMEFRAMES,
  parseChartUrlState
} from "@/lib/chart/url-state";
import {
  LEGEND_BOTTOM_GAP_PX,
  SUSLIK_HANDLE_SCALE,
  SUSLIK_HANDLE_SCROLL,
  SUSLIK_KINETIC_SCROLL,
  SUSLIK_MAIN_PANE_SCALE_MARGINS,
  SUSLIK_RIGHT_PRICE_SCALE,
  SUSLIK_TIME_SCALE_NAVIGATION,
  createMainPaneAutoscaleProvider,
  legendSpace,
  shiftLogicalRange
} from "@/lib/chart/chart-ux";
import {
  SMC_NETWORK_ERROR_MESSAGE,
  SmartMoneyPanel,
  buildSmcPanelViewModel,
  createSmcCommitter,
  createSmcControllerState,
  isSmcAbortError,
  reduceSmcState,
  type SmcCommitter,
  type SmcEvent,
  type SmcPanelState,
  type SmcPanelViewModel
} from "@/components/chart/SmartMoneyPanel";

/**
 * Свечной график на lightweight-charts.
 *
 * Данные — только существующие PostgreSQL Candle
 * через /api/chart/candles (закрытые свечи).
 * Индикаторы считаются серверно существующим слоем
 * lib/indicators: EMA 20/50/200, SMA 20, RSI 14,
 * MACD 12/26/9 и объём.
 *
 * Тема берётся из CSS-переменных проекта и обновляется
 * автоматически при переключении dark/light.
 *
 * P1-C: toggle «Смарт Мани» — ТОЛЬКО UI-state. Он подключает
 * read-only панель (components/chart/SmartMoneyPanel.tsx) к
 * существующему GET /api/chart/smc с ТЕКУЩИМИ symbol/timeframe
 * графика и НЕ трогает Strategy.enabled/status, admin API,
 * PostgreSQL, Signal и worker'ы. Свечи при этом остаются
 * данными ВЫБРАННОЙ биржи, а Smart Money — asset-level
 * мультибиржевая оценка (агрегат + per-exchange сводки),
 * поэтому exchange в SMC-запрос не передаётся. Отрисовка
 * SMC-примитивов поверх свечей — следующий этап P1-D, здесь
 * её нет.
 *
 * CHART UX (fix поверх P1-C):
 *  - легенда OHLC/индикаторов и кнопка «Сбросить масштаб» не
 *    перекрывают правую ценовую шкалу: место резервируется по
 *    ФАКТИЧЕСКИМ измерениям lightweight-charts (timeScale().width(),
 *    priceScale("right").width(), legend.offsetLeft), арифметика —
 *    чистая функция legendSpace() в lib/chart/chart-ux.ts;
 *  - навигация/масштаб — ШТАТНЫЕ options библиотеки 5.2.1
 *    (handleScroll / handleScale / kineticScroll / rightPriceScale /
 *    timeScale), явно зафиксированные в том же модуле: колесо → zoom,
 *    drag внутри plot → движение по истории, драг по осям → масштаб
 *    осей, двойной клик по оси → auto-scale, touch — драг и pinch;
 *  - ручной уход назад в историю сохраняется при подгрузке старых
 *    свечей (shiftLogicalRange), fitContent/scrollToRealTime при
 *    mergeOlder не вызываются; переключение индикаторов не
 *    пересоздаёт график и не перезапрашивает свечи.
 */

type SymbolInfo = {
  symbol: string;
  name: string | null;
  rank: number | null;
};

type MarketTimeframe = {
  timeframe: string;
  count: number;
  lastCandleTime: string | null;
};

type MarketInfo = {
  marketId: number;
  exchange: string;
  exchangeSymbol: string;
  timeframes: MarketTimeframe[];
};

type MarketsResponse = {
  asset?: {
    symbol: string;
    name: string | null;
    rank: number | null;
  };
  markets?: MarketInfo[];
  symbols?: SymbolInfo[];
  error: string | null;
};

type TimePoint = { time: number; value: number };

type CandlesResponse = {
  market: { exchange: string; exchangeSymbol: string };
  timeframe: string;
  candles: {
    time: number;
    open: number;
    high: number;
    low: number;
    close: number;
  }[];
  volume: { time: number; value: number }[];
  indicators: {
    ema20: TimePoint[];
    ema50: TimePoint[];
    ema200: TimePoint[];
    sma20: TimePoint[];
    rsi14: TimePoint[];
    macd: {
      macd: TimePoint[];
      signal: TimePoint[];
      histogram: TimePoint[];
    };
  } | null;
  message?: string;
  error?: string;
  hasMore?: boolean;
  nextCursor?: number | null;
  count?: number;
};

type ThemeColors = {
  panel: string;
  panel2: string;
  text: string;
  muted: string;
  line: string;
  green: string;
  red: string;
  accent: string;
};

function readThemeColors(): ThemeColors {
  const styles = getComputedStyle(
    document.documentElement
  );

  const read = (name: string, fallback: string) =>
    styles.getPropertyValue(name).trim() ||
    fallback;

  return {
    panel: read("--panel", "#0e1319"),
    panel2: read("--panel2", "#141a22"),
    text: read("--text", "#edf1f5"),
    muted: read("--muted", "#828c98"),
    line: read("--line", "#202832"),
    green: read("--green", "#35d397"),
    red: read("--red", "#ff536b"),
    accent: read("--accent", "#8875ff")
  };
}

const TIMEFRAME_LABELS: Record<
  string,
  string
> = {
  "5m": "5 минут",
  "15m": "15 минут",
  "1h": "1 час",
  "4h": "4 часа",
  "1d": "1 день"
};

function timeframeLabel(tf: string): string {
  return TIMEFRAME_LABELS[tf] ?? tf;
}

/* ---------- пересчёт индикаторов на клиенте ---------- */

/**
 * При подгрузке истории индикаторы пересчитываются
 * на клиенте тем же слоем lib/indicators, который
 * использует сервер: линии EMA/RSI/MACD остаются
 * математически непрерывными через стык батчей.
 */

type RawCandle = {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

function alignCompactClient(
  compact: number[],
  offset: number,
  times: number[]
): TimePoint[] {
  const result: TimePoint[] = [];

  for (let j = 0; j < compact.length; j++) {
    const index = j + offset;

    if (index >= times.length) {
      break;
    }

    result.push({
      time: times[index],
      value: compact[j]
    });
  }

  return result;
}

function alignNullableClient(
  series: (number | null | undefined)[],
  times: number[]
): TimePoint[] {
  const result: TimePoint[] = [];

  for (let i = 0; i < series.length; i++) {
    const value = series[i];

    if (
      value !== null &&
      value !== undefined &&
      Number.isFinite(value)
    ) {
      result.push({
        time: times[i],
        value
      });
    }
  }

  return result;
}

function computeIndicators(
  candles: RawCandle[]
): NonNullable<CandlesResponse["indicators"]> {
  const times = candles.map((c) => c.time);
  const closes = candles.map((c) => c.close);
  const macd = macdSeries(closes, 12, 26, 9);

  return {
    ema20: alignCompactClient(
      emaSeries(closes, 20),
      19,
      times
    ),
    ema50: alignCompactClient(
      emaSeries(closes, 50),
      49,
      times
    ),
    ema200: alignCompactClient(
      emaSeries(closes, 200),
      199,
      times
    ),
    sma20: alignNullableClient(
      smaSeries(closes, 20),
      times
    ),
    rsi14: alignNullableClient(
      rsiSeries(closes, 14),
      times
    ),
    macd: {
      macd: alignNullableClient(
        macd.macd,
        times
      ),
      signal: alignNullableClient(
        macd.signal,
        times
      ),
      histogram: alignNullableClient(
        macd.histogram,
        times
      )
    }
  };
}

/* ---------- легенда под курсором ---------- */

type LegendMaps = {
  index: Map<number, number>;
  candles: RawCandle[];
  volume: Map<number, number>;
  ema20: Map<number, number>;
  ema50: Map<number, number>;
  ema200: Map<number, number>;
  sma20: Map<number, number>;
  rsi14: Map<number, number>;
  macdM: Map<number, number>;
  macdS: Map<number, number>;
  macdH: Map<number, number>;
  lastTime: number;
};

function fmtPrice(
  value: number | null | undefined
): string {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  const abs = Math.abs(value);
  const digits =
    abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;

  return value.toLocaleString("ru-RU", {
    maximumFractionDigits: digits
  });
}

function fmtVolume(
  value: number | null | undefined
): string {
  if (
    value === null ||
    value === undefined ||
    !Number.isFinite(value)
  ) {
    return "—";
  }

  if (value >= 1e9) {
    return (value / 1e9).toFixed(2) + " млрд";
  }

  if (value >= 1e6) {
    return (value / 1e6).toFixed(2) + " млн";
  }

  if (value >= 1e3) {
    return (value / 1e3).toFixed(1) + " тыс.";
  }

  return value.toFixed(2);
}

function fmtTime(time: number): string {
  return new Date(time * 1000).toLocaleString(
    "ru-RU",
    {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    }
  );
}

/**
 * HTML легенды под курсором (чистая функция: те же строки, что и
 * раньше, — меняется только место вызова).
 *
 * Вынесена из renderLegendAt, чтобы метрики графика пересчитывались
 * ПОСЛЕ записи в DOM: высота legend-бокса участвует в AUTO-запасе
 * основной панели (длинная свеча не должна уходить под легенду).
 */
function legendHtml(
  time: number | null,
  maps: LegendMaps | null
): string {
  if (!maps || maps.index.size === 0) {
    return '<span class="k">Загрузка данных…</span>';
  }

  const t =
    time !== null && maps.index.has(time)
      ? time
      : maps.lastTime;
  const i = maps.index.get(t);
  const candle = maps.candles[i ?? -1];

  if (!candle) {
    return '<span class="k">Нет данных</span>';
  }

  const up = candle.close >= candle.open;
  const span = (
    key: string,
    value: string,
    cls?: string
  ) =>
    `<span class="k">${key}</span> ` +
    `<b class="${cls ?? ""}">${value}</b>`;

  return [
    `<span class="lgTime">${fmtTime(t)}</span>`,
    span("O", fmtPrice(candle.open)),
    span("H", fmtPrice(candle.high)),
    span("L", fmtPrice(candle.low)),
    span(
      "C",
      fmtPrice(candle.close),
      up ? "up" : "down"
    ),
    span(
      "Объём",
      fmtVolume(maps.volume.get(t))
    ),
    span("EMA20", fmtPrice(maps.ema20.get(t))),
    span("EMA50", fmtPrice(maps.ema50.get(t))),
    span("EMA200", fmtPrice(maps.ema200.get(t))),
    span("SMA20", fmtPrice(maps.sma20.get(t))),
    span("RSI14", fmtPrice(maps.rsi14.get(t))),
    span("MACD", fmtPrice(maps.macdM.get(t))),
    span("сигн.", fmtPrice(maps.macdS.get(t))),
    span(
      "гист.",
      fmtPrice(maps.macdH.get(t)),
      (maps.macdH.get(t) ?? 0) >= 0
        ? "up"
        : "down"
    )
  ].join(" ");
}

function valueMap(
  points: TimePoint[] | undefined
): Map<number, number> {
  const map = new Map<number, number>();

  for (const point of points ?? []) {
    map.set(point.time, point.value);
  }

  return map;
}

export default function CandleChart({
  initialSymbol,
  initialExchange,
  initialTimeframe
}: {
  initialSymbol?: string;
  initialExchange?: string;
  initialTimeframe?: string;
}) {
  const containerRef =
    useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(
    null
  );

  const candleSeriesRef =
    useRef<ISeriesApi<"Candlestick"> | null>(
      null
    );
  const volumeSeriesRef =
    useRef<ISeriesApi<"Histogram"> | null>(
      null
    );
  const ema20Ref =
    useRef<ISeriesApi<"Line"> | null>(null);
  const ema50Ref =
    useRef<ISeriesApi<"Line"> | null>(null);
  const ema200Ref =
    useRef<ISeriesApi<"Line"> | null>(null);
  const sma20Ref =
    useRef<ISeriesApi<"Line"> | null>(null);
  const rsiRef =
    useRef<ISeriesApi<"Line"> | null>(null);
  const macdLineRef =
    useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef =
    useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistRef =
    useRef<ISeriesApi<"Histogram"> | null>(
      null
    );
  const rsiGuideLinesRef = useRef<
    IPriceLine[]
  >([]);

  const dataRef = useRef<CandlesResponse | null>(
    null
  );

  /* ---------- состояние подгрузки истории ---------- */

  // Сырые свечи/объём текущего окна (ASC по time) —
  // база для слияния истории без дублей.
  const rawCandlesRef = useRef<RawCandle[]>([]);
  const volumeRawRef = useRef<TimePoint[]>([]);
  const hasMoreRef = useRef(true);
  const oldestTimeRef = useRef<number | null>(null);
  const loadingOlderRef = useRef(false);
  const olderAbortRef = useRef<AbortController | null>(
    null
  );
  const loadOlderRef = useRef<() => void>(() => {});
  const router = useRouter();
  const legendRef =
    useRef<HTMLDivElement | null>(null);
  const legendMapsRef =
    useRef<LegendMaps | null>(null);

  /* ---------- резерв места под правую ценовую шкалу ---------- */

  // Обёртка графика: на неё пишутся измеренные CSS-переменные
  // (--chart-legend-max-w, --chart-price-scale-w), поэтому легенда и
  // кнопка сброса масштаба не залезают на правую price scale.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Последнее записанное значение ширины легенды — чтобы не дёргать
  // style на каждом движении курсора (легенда обновляется часто).
  const legendMaxWidthRef = useRef<number | null>(null);
  const priceScaleWidthRef = useRef<number | null>(null);
  // Вертикальная геометрия основной панели: нижний край легенды (px от
  // верха панели) и высота панели. -1 — «ещё не измеряли», поэтому
  // первое же измерение считается изменением и включает AUTO-запас.
  const legendBottomPxRef = useRef(-1);
  const mainPaneHeightPxRef = useRef(-1);

  const [historyLoading, setHistoryLoading] =
    useState(false);
  const [historyEnded, setHistoryEnded] =
    useState(false);
  const [historyError, setHistoryError] =
    useState(false);

  // метаданные статусной строки: сколько свечей загружено,
  // время последней закрытой (для freshness)
  const [dataMeta, setDataMeta] = useState<{
    count: number;
    lastTime: number | null;
    exchangeSymbol: string;
  } | null>(null);

  const [symbols, setSymbols] = useState<
    SymbolInfo[]
  >([]);
  const [symbolsFailed, setSymbolsFailed] =
    useState(false);
  const [symbol, setSymbol] = useState(
    initialSymbol?.toUpperCase() ?? ""
  );
  const [markets, setMarkets] = useState<
    MarketInfo[]
  >([]);
  const [exchange, setExchange] = useState(() => {
    // валидация URL до загрузки списков: неизвестная
    // биржа всё равно падёт на fallback при загрузке рынков
    const parsed = parseChartUrlState(
      initialExchange,
      initialTimeframe,
      []
    );

    return parsed.exchange ?? "";
  });
  const [timeframe, setTimeframe] = useState(() => {
    const parsed = parseChartUrlState(
      initialExchange,
      initialTimeframe,
      []
    );

    return parsed.timeframe ?? "1h";
  });

  const [status, setStatus] = useState<
    "loading" | "loading-data" | "ok" | "empty" | "error"
  >("loading");
  const [errorMessage, setErrorMessage] =
    useState("");

  const [showVolume, setShowVolume] =
    useState(true);
  const [showEma, setShowEma] = useState(true);
  const [showSma, setShowSma] = useState(false);
  const [showRsi, setShowRsi] = useState(true);
  const [showMacd, setShowMacd] =
    useState(true);

  /* ---------- применение темы к графику ---------- */

  const applyChartTheme = useCallback(() => {
    const chart = chartRef.current;

    if (!chart) {
      return;
    }

    const colors = readThemeColors();

    chart.applyOptions({
      layout: {
        background: {
          color: "transparent"
        },
        textColor: colors.text,
        panes: {
          separatorColor: colors.line,
          separatorHoverColor:
            colors.accent + "44",
          enableResize: true
        }
      },
      grid: {
        vertLines: { color: colors.line },
        horzLines: { color: colors.line }
      },
      rightPriceScale: {
        borderColor: colors.line
      },
      timeScale: {
        borderColor: colors.line
      },
      crosshair: {
        vertLine: {
          color: colors.muted,
          labelBackgroundColor:
            colors.panel2
        },
        horzLine: {
          color: colors.muted,
          labelBackgroundColor:
            colors.panel2
        }
      }
    });

    const candle =
      candleSeriesRef.current;

    if (candle) {
      candle.applyOptions({
        upColor: colors.green,
        downColor: colors.red,
        wickUpColor: colors.green,
        wickDownColor: colors.red,
        borderUpColor: colors.green,
        borderDownColor: colors.red
      });
    }

    volumeSeriesRef.current?.applyOptions({
      color: colors.muted + "66"
    });

    const lineColor = (
      series: ISeriesApi<"Line"> | null,
      color: string
    ) => {
      series?.applyOptions({
        color
      });
    };

    lineColor(ema20Ref.current, colors.accent);
    lineColor(
      ema50Ref.current,
      colors.text === "#edf1f5"
        ? "#e8b34b"
        : "#b7791f"
    );
    lineColor(ema200Ref.current, colors.red);
    lineColor(
      sma20Ref.current,
      colors.muted
    );
    lineColor(rsiRef.current, colors.accent);
    lineColor(
      macdLineRef.current,
      colors.accent
    );
    lineColor(
      macdSignalRef.current,
      colors.red
    );

    // histogram MACD перекрашиваем по знаку
    const data = dataRef.current;

    if (data?.indicators && macdHistRef.current) {
      macdHistRef.current.setData(
        data.indicators.macd.histogram.map(
          (p): HistogramData => ({
            time: p.time as UTCTimestamp,
            value: p.value,
            color:
              p.value >= 0
                ? colors.green + "99"
                : colors.red + "99"
          })
        )
      );
    }

    // направляющие RSI 30/70
    for (const line of rsiGuideLinesRef.current) {
      try {
        rsiRef.current?.removePriceLine(
          line
        );
      } catch {
        // линия уже снята
      }
    }

    rsiGuideLinesRef.current = [];

    if (rsiRef.current) {
      rsiGuideLinesRef.current = [
        rsiRef.current.createPriceLine({
          price: 70,
          color: colors.muted,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: ""
        }),
        rsiRef.current.createPriceLine({
          price: 30,
          color: colors.muted,
          lineWidth: 1,
          lineStyle: 2,
          axisLabelVisible: true,
          title: ""
        })
      ];
    }
  }, []);

  /* ---------- метрики графика: шкала, легенда, вертикаль ---------- */

  /**
   * Явные scaleMargins правой ценовой шкалы ОСНОВНОЙ панели (свечи).
   *
   * Шкала берётся у самой серии (candleSeries.priceScale()), а НЕ через
   * chart.applyOptions({ rightPriceScale }): chart-level опции
   * библиотека применяет сразу ко всем панелям, а RSI и MACD обязаны
   * остаться на штатных дефолтах со своим autoscale.
   *
   * Ручной вертикальный масштаб это НЕ отменяет: значения одинаковы в
   * обоих режимах, auto-scale возвращается только явным действием
   * пользователя (кнопка «Сбросить масштаб» / двойной клик), а при
   * выключенном auto-scale шкала вообще не трогается.
   */
  const applyMainPaneScaleMargins = useCallback(() => {
    const candle = candleSeriesRef.current;

    if (!candle) {
      return;
    }

    try {
      const scale = candle.priceScale();

      if (scale.options().autoScale !== true) {
        // Пользователь увёл масштаб вручную (drag по ценовой шкале) —
        // никаких повторных applyOptions: ручной диапазон остаётся его.
        return;
      }

      scale.applyOptions({
        scaleMargins: SUSLIK_MAIN_PANE_SCALE_MARGINS
      });
    } catch {
      // Шкала панели ещё не готова — отступы применятся при следующем
      // пересчёте метрик.
    }
  }, []);

  /**
   * Легенда (дата/O/H/L/C/объём/EMA/RSI/MACD) и кнопка сброса масштаба
   * обязаны оставаться ВНУТРИ plot-области: справа находится ценовая
   * шкала, и её подписи не должны перекрываться.
   *
   * Здесь же измеряется ВЕРТИКАЛЬНАЯ геометрия основной панели — высота
   * панели и нижний край legend-бокса; от них зависит AUTO-запас
   * ценового диапазона (см. createMainPaneAutoscaleProvider в
   * lib/chart/chart-ux.ts).
   *
   * Ширина берётся из ФАКТИЧЕСКИХ измерений lightweight-charts, а не из
   * hardcoded координат:
   *  - chart.timeScale().width() — ширина plot-области БЕЗ колонок
   *    ценовых шкал (layout-конвенция библиотеки);
   *  - chart.priceScale("right").width() — ширина самой шкалы;
   *  - legend.offsetLeft — фактический левый отступ легенды из CSS
   *    (включая media-правила узких экранов).
   * Арифметика — чистая функция legendSpace() в lib/chart/chart-ux.ts.
   * Результат пишется CSS-переменными на обёртку графика, поэтому при
   * недостатке места легенда корректно переносится (flex-wrap) и не
   * вылезает под ценовую шкалу.
   */
  const applyChartMetrics = useCallback(() => {
    const chart = chartRef.current;
    const wrap = wrapRef.current;

    if (!chart || !wrap) {
      return;
    }

    let plotWidth = 0;
    let priceScaleWidth = 0;
    let paneHeightPx = 0;

    try {
      plotWidth = chart.timeScale().width();
      priceScaleWidth = chart
        .priceScale("right")
        .width();
      paneHeightPx =
        chart.panes()[0]?.getHeight() ?? 0;
    } catch {
      // Plot-область/шкала/панели ещё не созданы (first paint) — ниже
      // сработает fallback по ширине контейнера, а вертикальная
      // геометрия пересчитается при следующем измерении.
    }

    const legendEl = legendRef.current;

    const space = legendSpace({
      plotWidth,
      priceScaleWidth,
      leftInset: legendEl ? legendEl.offsetLeft : 0,
      containerWidth: wrap.clientWidth
    });

    const unchanged =
      space.maxWidthPx === legendMaxWidthRef.current &&
      space.priceScaleWidthPx === priceScaleWidthRef.current;

    if (!unchanged) {
      legendMaxWidthRef.current = space.maxWidthPx;
      priceScaleWidthRef.current = space.priceScaleWidthPx;

      if (space.maxWidthPx === null) {
        // Измерить не удалось — оставляем CSS-fallback.
        wrap.style.removeProperty("--chart-legend-max-w");
      } else {
        wrap.style.setProperty(
          "--chart-legend-max-w",
          `${space.maxWidthPx}px`
        );
      }

      wrap.style.setProperty(
        "--chart-price-scale-w",
        `${space.priceScaleWidthPx}px`
      );
    }

    /* -------- вертикальная геометрия основной панели -------- */

    // Нижний край legend-бокса в координатах панели: легенда — overlay
    // внутри графика (offsetParent — chartWrap, а верх chartWrap
    // совпадает с верхом контейнера и панели 0). Скрытая легенда
    // (offsetHeight = 0, например на экранах уже 360px) резерва не даёт.
    const legendBottomPx =
      legendEl && legendEl.offsetHeight > 0
        ? legendEl.offsetTop +
          legendEl.offsetHeight +
          LEGEND_BOTTOM_GAP_PX
        : 0;

    const verticalUnchanged =
      legendBottomPx === legendBottomPxRef.current &&
      paneHeightPx === mainPaneHeightPxRef.current;

    legendBottomPxRef.current = legendBottomPx;
    mainPaneHeightPxRef.current = paneHeightPx;

    if (verticalUnchanged) {
      return;
    }

    // Высота панели или легенды изменилась → AUTO-запас надо
    // пересчитать. Штатный способ: повторное применение тех же
    // scaleMargins даёт fullUpdate, после которого библиотека
    // пересчитывает ценовой диапазон — и только в auto-scale
    // (в ручном режиме пересчёт не выполняется, ручной диапазон
    // остаётся нетронутым).
    applyMainPaneScaleMargins();
  }, [applyMainPaneScaleMargins]);

  /* ---------- наполнение серий данными ---------- */

  /**
   * «Сбросить масштаб» — ТОЛЬКО кнопка (не двойной клик по графику):
   * возврат к ожидаемому виду ШТАТНЫМИ средствами lightweight-charts
   * 5.2.1 — timeScale().resetTimeScale() (barSpacing/rightOffset к
   * дефолту), setAutoScale(true) на правой ценовой шкале каждой панели
   * и timeScale().scrollToRealTime() (последние закрытые бары).
   * Собственная «физика» масштаба не реализуется.
   *
   * Разделение жестов (урок проваленного ревью 5ff7795 — см.
   * PROJECT_CONTEXT §31m): двойной клик по ценовой шкале обязан возвращать ТОЛЬКО
   * авто-масштаб цены (штатный axisDoubleClickReset.price) и не трогать
   * время; полный сброс времени — явное действие пользователя кнопкой.
   */
  const resetChartScale = useCallback(() => {
    const chart = chartRef.current;

    if (!chart) {
      return;
    }

    chart.timeScale().resetTimeScale();

    // У панелей RSI и MACD собственные правые ценовые шкалы:
    // auto-scale возвращается во всех панелях, иначе индикаторы
    // остались бы в растянутом вручную состоянии.
    try {
      for (const pane of chart.panes()) {
        pane.priceScale("right").setAutoScale(true);
      }
    } catch {
      // Шкалы панелей ещё не готовы; масштаб времени уже сброшен,
      // auto-scale вернётся при следующей отрисовке.
    }

    chart.timeScale().scrollToRealTime();

    applyChartMetrics();
  }, [applyChartMetrics]);

  const rebuildLegendMaps = useCallback(
    (data: CandlesResponse) => {
      const index = new Map<number, number>();

      data.candles.forEach((candle, i) => {
        index.set(candle.time, i);
      });

      legendMapsRef.current = {
        index,
        candles: data.candles,
        volume: valueMap(data.volume),
        ema20: valueMap(
          data.indicators?.ema20
        ),
        ema50: valueMap(
          data.indicators?.ema50
        ),
        ema200: valueMap(
          data.indicators?.ema200
        ),
        sma20: valueMap(
          data.indicators?.sma20
        ),
        rsi14: valueMap(
          data.indicators?.rsi14
        ),
        macdM: valueMap(
          data.indicators?.macd.macd
        ),
        macdS: valueMap(
          data.indicators?.macd.signal
        ),
        macdH: valueMap(
          data.indicators?.macd.histogram
        ),
        lastTime:
          data.candles.length > 0
            ? data.candles[
                data.candles.length - 1
              ].time
            : 0
      };
    },
    []
  );

  const renderLegendAt = useCallback(
    (time: number | null) => {
      const el = legendRef.current;

      if (el) {
        el.innerHTML = legendHtml(
          time,
          legendMapsRef.current
        );
      }

      // Метрики пересчитываются ПОСЛЕ записи в DOM: легенда обновляется
      // чаще всего остального (движение курсора, данные, история), а
      // измеряются и ширина ценовой шкалы (зависит от разрядности цен),
      // и фактическая высота legend-бокса (от неё зависит AUTO-запас
      // основной панели по вертикали).
      applyChartMetrics();
    },
    [applyChartMetrics]
  );

  const applyData = useCallback(
    (data: CandlesResponse) => {
      // точка F ревью: успешный ответ с count > 0
      // не имеет права превратиться в пустой график
      if (
        !candlesIntegrityOk(
          data.count ?? data.candles.length,
          data.candles
        )
      ) {
        console.error(
          "[CandleChart] Противоречивый ответ API:",
          "count > 0 при пустом массиве свечей — данные не применены"
        );

        setStatus("error");
        setErrorMessage(
          "Сервер вернул противоречивые данные свечей"
        );

        return;
      }

      dataRef.current = data;

      // база для последующей подгрузки истории
      rawCandlesRef.current = data.candles;
      volumeRawRef.current = data.volume;
      hasMoreRef.current = data.hasMore === true;
      oldestTimeRef.current =
        data.candles.length > 0
          ? data.candles[0].time * 1000
          : null;

      rebuildLegendMaps(data);
      setDataMeta({
        count: data.candles.length,
        lastTime:
          data.candles.length > 0
            ? data.candles[data.candles.length - 1]
                .time
            : null,
        exchangeSymbol:
          data.market.exchangeSymbol
      });

      const colors = readThemeColors();

      candleSeriesRef.current?.setData(
        data.candles.map(
          (c): CandlestickData =>
            ({
              time: c.time as UTCTimestamp,
              open: c.open,
              high: c.high,
              low: c.low,
              close: c.close
            }) as CandlestickData
        )
      );

      volumeSeriesRef.current?.setData(
        data.volume.map(
          (v): HistogramData => ({
            time: v.time as UTCTimestamp,
            value: v.value,
            color:
              colors.muted + "55"
          })
        )
      );

      const setLine = (
        series: ISeriesApi<"Line"> | null,
        points: TimePoint[]
      ) => {
        series?.setData(
          points.map(
            (p): LineData => ({
              time: p.time as UTCTimestamp,
              value: p.value
            })
          )
        );
      };

      setLine(
        ema20Ref.current,
        data.indicators?.ema20 ?? []
      );
      setLine(
        ema50Ref.current,
        data.indicators?.ema50 ?? []
      );
      setLine(
        ema200Ref.current,
        data.indicators?.ema200 ?? []
      );
      setLine(
        sma20Ref.current,
        data.indicators?.sma20 ?? []
      );
      setLine(
        rsiRef.current,
        data.indicators?.rsi14 ?? []
      );
      setLine(
        macdLineRef.current,
        data.indicators?.macd.macd ?? []
      );
      setLine(
        macdSignalRef.current,
        data.indicators?.macd.signal ?? []
      );

      macdHistRef.current?.setData(
        data.indicators?.macd.histogram.map(
          (p): HistogramData => ({
            time: p.time as UTCTimestamp,
            value: p.value,
            color:
              p.value >= 0
                ? colors.green + "99"
                : colors.red + "99"
          })
        ) ?? []
      );

      // fitContent — ТОЛЬКО на свежей загрузке окна (первая
      // отрисовка, смена актива/биржи/таймфрейма, «Повторить»):
      // это ожидаемый default view. Подгрузка более старой истории
      // (loadOlder) fitContent/scrollToRealTime НЕ вызывает —
      // ручной уход назад в историю там сохраняется.
      chartRef.current?.timeScale().fitContent();

      // renderLegendAt заодно пересчитывает резерв места под
      // ценовую шкалу (applyChartMetrics).
      renderLegendAt(null);
    },
    [rebuildLegendMaps, renderLegendAt]
  );

  const applyVisibility = useCallback(() => {
    volumeSeriesRef.current?.applyOptions({
      visible: showVolume
    });
    ema20Ref.current?.applyOptions({
      visible: showEma
    });
    ema50Ref.current?.applyOptions({
      visible: showEma
    });
    ema200Ref.current?.applyOptions({
      visible: showEma
    });
    sma20Ref.current?.applyOptions({
      visible: showSma
    });
    rsiRef.current?.applyOptions({
      visible: showRsi
    });
    macdLineRef.current?.applyOptions({
      visible: showMacd
    });
    macdSignalRef.current?.applyOptions({
      visible: showMacd
    });
    macdHistRef.current?.applyOptions({
      visible: showMacd
    });
  }, [showVolume, showEma, showSma, showRsi, showMacd]);

  // Видимость индикаторов применяется к УЖЕ созданным сериям отдельным
  // эффектом ниже. Потребители (создание графика и загрузка свечей)
  // держат стабильную ссылку, поэтому переключение EMA/SMA/RSI/MACD/
  // Volume НЕ пересоздаёт график и НЕ перезапрашивает свечи: ручной
  // уход назад в историю при этом не сбрасывается на последние бары.
  const applyVisibilityRef = useRef(applyVisibility);

  useEffect(() => {
    applyVisibilityRef.current = applyVisibility;
  }, [applyVisibility]);

  /* ---------- создание графика ---------- */

  useEffect(() => {
    const container =
      containerRef.current;

    if (!container) {
      return;
    }

    const colors = readThemeColors();

    const chart = createChart(container, {
      autoSize: true,
      localization: {
        locale: "ru-RU"
      },
      layout: {
        background: {
          color: "transparent"
        },
        textColor: colors.text,
        fontSize: 12,
        panes: {
          separatorColor: colors.line,
          separatorHoverColor:
            colors.accent + "44",
          enableResize: true
        },
        attributionLogo: false
      },
      grid: {
        vertLines: { color: colors.line },
        horzLines: { color: colors.line }
      },
      /*
       * Навигация и масштаб — ШТАТНЫЕ interaction options
       * lightweight-charts 5.2.1 (значения и обоснование каждого
       * флага — в lib/chart/chart-ux.ts):
       *  - колесо мыши (deltaY) → zoom временной шкалы в точке
       *    курсора, горизонтальный свайп/колесо (deltaX) → движение
       *    по истории;
       *  - click+drag внутри plot → горизонтальное перемещение
       *    истории (pressedMouseMove);
       *  - драг по оси времени → растянуть/сжать временную шкалу,
       *    драг по правой ценовой шкале → вертикальный масштаб
       *    (axisPressedMouseMove.time/.price);
       *  - двойной клик по оси времени/цены → возврат к auto-scale
       *    (axisDoubleClickReset), как и кнопка «Сбросить масштаб»;
       *  - touch: горизонтальный драг и pinch работают, вертикальный
       *    драг отдан странице (vertTouchDrag false).
       * Собственная «физика» drag/zoom поверх библиотеки не пишется.
       */
      handleScroll: SUSLIK_HANDLE_SCROLL,
      handleScale: SUSLIK_HANDLE_SCALE,
      kineticScroll: SUSLIK_KINETIC_SCROLL,
      rightPriceScale: {
        ...SUSLIK_RIGHT_PRICE_SCALE,
        borderColor: colors.line
      },
      timeScale: {
        ...SUSLIK_TIME_SCALE_NAVIGATION,
        borderColor: colors.line,
        timeVisible: true,
        secondsVisible: false
      },
      crosshair: {
        vertLine: {
          color: colors.muted,
          labelBackgroundColor:
            colors.panel2
        },
        horzLine: {
          color: colors.muted,
          labelBackgroundColor:
            colors.panel2
        }
      }
    });

    chartRef.current = chart;

    candleSeriesRef.current =
      chart.addSeries(CandlestickSeries, {
        upColor: colors.green,
        downColor: colors.red,
        wickUpColor: colors.green,
        wickDownColor: colors.red,
        borderUpColor: colors.green,
        borderDownColor: colors.red,
        priceLineWidth: 1,
        /*
         * ВЕРТИКАЛЬНЫЙ AUTO-запас основной панели — штатный
         * autoscaleInfoProvider библиотеки: базовый диапазон (видимые
         * high/low свечей) расширяется в ценовых единицах так, чтобы
         * экстремумы pump/dump не ложились вплотную к краю полосы и не
         * уходили под legend-бокс.
         *
         * На ручной масштаб не влияет: в ручном режиме библиотека не
         * пересчитывает диапазон (PriceScale
         * ._private__recalculatePriceRangeImpl сразу завершается при
         * isCustomPriceRange() && !isAutoScale()), провайдер не
         * вызывается, и пользователь свободно сжимает/растягивает цену
         * drag'ом по правой ценовой шкале. Собственных min/max
         * ограничений приложение не добавляет.
         */
        autoscaleInfoProvider:
          createMainPaneAutoscaleProvider({
            paneHeightPx: () => {
              try {
                return (
                  chart.panes()[0]?.getHeight() ?? 0
                );
              } catch {
                return 0;
              }
            },
            legendBottomPx: () =>
              legendBottomPxRef.current
          })
      });

    volumeSeriesRef.current =
      chart.addSeries(HistogramSeries, {
        priceFormat: {
          type: "volume"
        },
        priceScaleId: "",
        priceLineVisible: false,
        lastValueVisible: false
      });

    volumeSeriesRef.current
      .priceScale()
      .applyOptions({
        scaleMargins: {
          top: 0.82,
          bottom: 0
        }
      });

    const lineDefaults = {
      lineWidth: 2 as const,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false
    };

    ema20Ref.current = chart.addSeries(
      LineSeries,
      {
        ...lineDefaults,
        color: colors.accent,
        title: "EMA 20"
      }
    );

    ema50Ref.current = chart.addSeries(
      LineSeries,
      {
        ...lineDefaults,
        color:
          colors.text === "#edf1f5"
            ? "#e8b34b"
            : "#b7791f",
        title: "EMA 50"
      }
    );

    ema200Ref.current = chart.addSeries(
      LineSeries,
      {
        ...lineDefaults,
        color: colors.red,
        title: "EMA 200"
      }
    );

    sma20Ref.current = chart.addSeries(
      LineSeries,
      {
        ...lineDefaults,
        lineWidth: 1,
        color: colors.muted,
        title: "SMA 20"
      }
    );

    // RSI — отдельная панель
    rsiRef.current = chart.addSeries(
      LineSeries,
      {
        ...lineDefaults,
        color: colors.accent,
        title: "RSI 14"
      },
      1
    );

    // MACD — третья панель
    macdLineRef.current = chart.addSeries(
      LineSeries,
      {
        ...lineDefaults,
        color: colors.accent,
        title: "MACD"
      },
      2
    );

    macdSignalRef.current =
      chart.addSeries(
        LineSeries,
        {
          ...lineDefaults,
          color: colors.red,
          title: "сигнал"
        },
        2
      );

    macdHistRef.current = chart.addSeries(
      HistogramSeries,
      {
        priceFormat: {
          type: "price"
        },
        priceLineVisible: false,
        lastValueVisible: false
      },
      2
    );

    try {
      const panes = chart.panes();

      if (panes.length >= 3) {
        panes[0].setStretchFactor(4);
        panes[1].setStretchFactor(1.6);
        panes[2].setStretchFactor(1.6);
      }
    } catch {
      // пропорции панелей не критичны
    }

    applyVisibilityRef.current();

    // Прокрутка влево до начала видимой области —
    // подгружаем более старую историю (cursor по openTime).
    chart
      .timeScale()
      .subscribeVisibleLogicalRangeChange(
        (range) => {
          if (range && range.from <= 2) {
            loadOlderRef.current();
          }
        }
      );

    // Легенда: OHLCV и значения индикаторов под курсором.
    // Обновление напрямую в DOM — без ре-рендеров React.
    chart.subscribeCrosshairMove((param) => {
      const time = param.time
        ? Number(param.time)
        : null;
      const maps = legendMapsRef.current;

      renderLegendAt(
        time !== null &&
          maps !== null &&
          maps.index.has(time)
          ? time
          : null
      );
    });

    // Размер plot-области меняется (resize окна, перестройка панелей
    // RSI/MACD, смена разрядности цен) — резерв места под легенду и
    // кнопку сброса пересчитывается ШТАТНОЙ подпиской библиотеки,
    // а не самодельным ResizeObserver поверх неё.
    chart
      .timeScale()
      .subscribeSizeChange(() => {
        applyChartMetrics();
      });

    applyChartMetrics();

    // реакция на смену темы
    const observer =
      new MutationObserver(() => {
        applyChartTheme();
      });

    observer.observe(
      document.documentElement,
      {
        attributes: true,
        attributeFilter: [
          "data-theme"
        ]
      }
    );

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      ema20Ref.current = null;
      ema50Ref.current = null;
      ema200Ref.current = null;
      sma20Ref.current = null;
      rsiRef.current = null;
      macdLineRef.current = null;
      macdSignalRef.current = null;
      macdHistRef.current = null;
      rsiGuideLinesRef.current = [];
    };
    // applyVisibility намеренно НЕ в зависимостях: график создаётся
    // один раз, а видимость серий применяет отдельный эффект.
  }, [applyChartTheme, renderLegendAt, applyChartMetrics]);

  /* ---------- загрузка списков ---------- */

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const response = await fetch(
          "/api/chart/markets"
        );

        const data: MarketsResponse =
          await response.json();

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          if (!cancelled) {
            setSymbolsFailed(true);
            setStatus((prev) =>
              nextStatusAfterListFailure(prev)
            );
            setErrorMessage(
              data.error ??
                "Не удалось загрузить список активов"
            );
          }

          return;
        }

        const list = data.symbols ?? [];

        if (list.length === 0) {
          if (!cancelled) {
            setSymbolsFailed(true);
            setStatus((prev) =>
              nextStatusAfterListFailure(prev)
            );
            setErrorMessage(
              "Нет данных: в PostgreSQL пока нет свечей. Запустите OHLCV worker."
            );
          }

          return;
        }

        if (cancelled) {
          return;
        }

        setSymbols(list);
        setSymbolsFailed(false);

        // выбранный (URL/страница) символ не сбрасывается:
        // пустой/частичный список ему не хозяин
        const nextSymbol =
          resolveSymbolFromList(
            initialSymbol?.toUpperCase() ??
              null,
            list
          );

        if (nextSymbol) {
          setSymbol(nextSymbol);
        }
      } catch {
        if (!cancelled) {
          setSymbolsFailed(true);
          setStatus((prev) =>
            nextStatusAfterListFailure(prev)
          );
          setErrorMessage(
            "Ошибка соединения с сервером"
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [initialSymbol]);

  /* ---------- загрузка рынков выбранного актива ---------- */

  useEffect(() => {
    if (!symbol) {
      return;
    }

    let cancelled = false;

    (async () => {
      setStatus("loading-data");

      try {
        const response = await fetch(
          `/api/chart/markets?symbol=${encodeURIComponent(symbol)}`
        );

        const data: MarketsResponse =
          await response.json();

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          if (!cancelled) {
            setStatus((prev) =>
              nextStatusAfterListFailure(prev)
            );
            setErrorMessage(
              data.error ??
                "Не удалось загрузить рынки"
            );
          }

          return;
        }

        const list = data.markets ?? [];

        setMarkets(list);

        if (list.length === 0) {
          setStatus("empty");
          setErrorMessage(
            `Нет данных: у ${symbol} пока нет рынков со свечами`
          );

          return;
        }

        // URL-биржа имеет приоритет, если реально есть
        const urlExchange = parseChartUrlState(
          initialExchange,
          initialTimeframe,
          list.map((m) => m.exchange)
        ).exchange;

        setExchange(
          urlExchange ?? list[0].exchange
        );

        const first = urlExchange
          ? list.find((m) => m.exchange === urlExchange) ??
            list[0]
          : list[0];

        if (
          !first.timeframes.some(
            (t) =>
              t.timeframe === timeframe
          )
        ) {
          const preferred =
            first.timeframes.find(
              (t) => t.timeframe === "1h"
            ) ?? first.timeframes[0];

          if (preferred) {
            setTimeframe(
              preferred.timeframe
            );
          }
        }
      } catch {
        if (!cancelled) {
          setStatus((prev) =>
            nextStatusAfterListFailure(prev)
          );
          setErrorMessage(
            "Ошибка соединения с сервером"
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // timeframe сознательно не в зависимостях:
    // таймфрейм выбирается только при смене актива
  }, [symbol]);

  /* ---------- загрузка свечей ---------- */

  const requestIdRef = useRef(0);
  const abortRef = useRef<
    AbortController | null
  >(null);

  const loadCandles = useCallback(
    async () => {
      if (!symbol || !exchange) {
        return;
      }

      // смена окна: обрываем подгрузку истории
      // и начинаем отсчёт заново
      olderAbortRef.current?.abort();
      loadingOlderRef.current = false;
      setHistoryLoading(false);
      setHistoryEnded(false);
      setHistoryError(false);

      abortRef.current?.abort();

      const controller =
        new AbortController();

      abortRef.current = controller;

      const requestId =
        ++requestIdRef.current;

      setStatus("loading-data");

      try {
        const response = await fetch(
          `/api/chart/candles?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&timeframe=${encodeURIComponent(timeframe)}`,
          { signal: controller.signal }
        );

        const data: CandlesResponse =
          await response.json();

        if (
          requestId !== requestIdRef.current
        ) {
          return;
        }

        if (!response.ok) {
          setStatus("error");
          setErrorMessage(
            data.error ??
              "Не удалось загрузить свечи"
          );

          return;
        }

        if (
          data.candles.length === 0
        ) {
          setStatus("empty");
          setErrorMessage(
            data.message ??
              "Нет данных по этому рынку и таймфрейму"
          );

          return;
        }

        applyData(data);
        applyVisibilityRef.current();
        applyChartTheme();
        setStatus("ok");
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }

        if (
          requestId !== requestIdRef.current
        ) {
          return;
        }

        setStatus("error");
        setErrorMessage(
          "Ошибка соединения с сервером"
        );
      }
    },
    [
      symbol,
      exchange,
      timeframe,
      applyData,
      applyChartTheme
    ]
  );

  /* ---------- подгрузка истории при прокрутке влево ---------- */

  const loadOlder = useCallback(
    async () => {
      if (
        loadingOlderRef.current ||
        !hasMoreRef.current
      ) {
        return;
      }

      if (
        !symbol ||
        !exchange ||
        oldestTimeRef.current === null
      ) {
        return;
      }

      loadingOlderRef.current = true;
      setHistoryLoading(true);

      const controller =
        new AbortController();

      olderAbortRef.current = controller;

      try {
        const response = await fetch(
          `/api/chart/candles?symbol=${encodeURIComponent(symbol)}&exchange=${encodeURIComponent(exchange)}&timeframe=${encodeURIComponent(timeframe)}&before=${oldestTimeRef.current}&limit=300`,
          { signal: controller.signal }
        );

        const data: CandlesResponse =
          await response.json();

        if (controller.signal.aborted) {
          return;
        }

        // Ошибка истории не должна ломать график:
        // прекращаем попытки и честно сообщаем
        // (отдельно от ошибки основной загрузки).
        if (
          !response.ok ||
          !Array.isArray(data.candles)
        ) {
          hasMoreRef.current = false;
          setHistoryEnded(true);
          setHistoryError(true);

          return;
        }

        const candlesMerge = mergeOlder(
          rawCandlesRef.current,
          data.candles
        );

        // Добавлять нечего — истории дальше нет,
        // прекращаем запросы.
        if (candlesMerge.added === 0) {
          hasMoreRef.current = false;
          setHistoryEnded(true);

          return;
        }

        const volumeMerge = mergeOlder(
          volumeRawRef.current,
          data.volume
        );

        rawCandlesRef.current =
          candlesMerge.merged;
        volumeRawRef.current =
          volumeMerge.merged;
        oldestTimeRef.current =
          candlesMerge.merged[0].time * 1000;
        hasMoreRef.current =
          data.hasMore === true;

        // Полный пересчёт индикаторов по объединённому
        // окну тем же слоем lib/indicators.
        const indicators =
          computeIndicators(candlesMerge.merged);

        const merged: CandlesResponse = {
          ...dataRef.current!,
          candles: candlesMerge.merged,
          volume: volumeMerge.merged,
          indicators
        };

        dataRef.current = merged;
        rebuildLegendMaps(merged);
        renderLegendAt(null);
        setDataMeta({
          count: merged.candles.length,
          lastTime:
            merged.candles.length > 0
              ? merged.candles[
                  merged.candles.length - 1
                ].time
              : null,
          exchangeSymbol:
            data.market.exchangeSymbol
        });

        const chart = chartRef.current;
        const colors = readThemeColors();

        // Сохраняем видимую область: запоминаем логический диапазон
        // ДО setData (после слияния индексы баров сдвинутся).
        const range =
          chart
            ?.timeScale()
            .getVisibleLogicalRange() ?? null;

        candleSeriesRef.current?.setData(
          merged.candles.map(
            (c): CandlestickData =>
              ({
                time: c.time as UTCTimestamp,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close
              }) as CandlestickData
          )
        );

        volumeSeriesRef.current?.setData(
          merged.volume.map(
            (v): HistogramData => ({
              time: v.time as UTCTimestamp,
              value: v.value,
              color: colors.muted + "55"
            })
          )
        );

        const setLine = (
          series: ISeriesApi<"Line"> | null,
          points: TimePoint[]
        ) => {
          series?.setData(
            points.map(
              (p): LineData => ({
                time: p.time as UTCTimestamp,
                value: p.value
              })
            )
          );
        };

        setLine(
          ema20Ref.current,
          indicators.ema20
        );
        setLine(
          ema50Ref.current,
          indicators.ema50
        );
        setLine(
          ema200Ref.current,
          indicators.ema200
        );
        setLine(
          sma20Ref.current,
          indicators.sma20
        );
        setLine(
          rsiRef.current,
          indicators.rsi14
        );
        setLine(
          macdLineRef.current,
          indicators.macd.macd
        );
        setLine(
          macdSignalRef.current,
          indicators.macd.signal
        );

        macdHistRef.current?.setData(
          indicators.macd.histogram.map(
            (p): HistogramData => ({
              time: p.time as UTCTimestamp,
              value: p.value,
              color:
                p.value >= 0
                  ? colors.green + "99"
                  : colors.red + "99"
            })
          )
        );

        // РУЧНОЙ VIEWPORT СОХРАНЯЕТСЯ: диапазон сдвигается ровно на
        // число добавленных свечей (чистая арифметика —
        // lib/chart/chart-ux.ts, покрыта scripts/test-chart-ux.ts).
        // fitContent / scrollToRealTime / setVisibleRange здесь
        // сознательно НЕ вызываются: подгрузка более старой истории не
        // имеет права неожиданно возвращать пользователя к последним
        // барам. Если диапазон неизвестен либо добавлено 0 свечей,
        // shiftLogicalRange вернёт null и viewport не трогается вовсе.
        const shifted = shiftLogicalRange(
          range,
          candlesMerge.added
        );

        if (chart && shifted !== null) {
          chart
            .timeScale()
            .setVisibleLogicalRange(shifted);
        }

        // Порядок цен в окне мог измениться → ширина ценовой шкалы
        // тоже; резерв места под легенду пересчитывается.
        applyChartMetrics();

        if (!hasMoreRef.current) {
          setHistoryEnded(true);
        }
      } catch (error) {
        if (
          error instanceof DOMException &&
          error.name === "AbortError"
        ) {
          return;
        }

        // Сеть/сервер недоступны: не зацикливаемся,
        // история остаётся как есть, сообщаем отдельно.
        hasMoreRef.current = false;
        setHistoryEnded(true);
        setHistoryError(true);
      } finally {
        loadingOlderRef.current = false;
        setHistoryLoading(false);
      }
    },
    [
      symbol,
      exchange,
      timeframe,
      rebuildLegendMaps,
      renderLegendAt,
      applyChartMetrics
    ]
  );

  useEffect(() => {
    loadOlderRef.current = () => {
      void loadOlder();
    };
  }, [loadOlder]);

  useEffect(() => {
    void loadCandles();

    return () => {
      olderAbortRef.current?.abort();
      abortRef.current?.abort();
    };
  }, [loadCandles]);

  useEffect(() => {
    applyVisibility();
  }, [applyVisibility]);

  /* ---------- Smart Money (P1-C): UI-only toggle + read-only fetch ---------- */

  // Состояние SMC-запроса живёт в commit-гейте (машина состояний —
  // components/chart/SmartMoneyPanel.tsx), а в React-стейте только то,
  // что нужно для рендера: enabled и панель. Это ТОТ ЖЕ подход, что и у
  // свечей: AbortController + requestId-identity, поэтому устаревший
  // ответ не может перезаписать новый state.
  const smcAbortRef = useRef<AbortController | null>(null);

  const [smcEnabled, setSmcEnabled] = useState(false);
  const [smcPanel, setSmcPanel] = useState<SmcPanelState>({
    status: "off"
  });

  // Ленивая инициализация гейта (один раз на экземпляр компонента):
  // host замыкает стабильные React-сеттеры и отмену активного запроса.
  const smcCommitterRef = useRef<SmcCommitter | null>(null);

  if (smcCommitterRef.current === null) {
    smcCommitterRef.current = createSmcCommitter(
      createSmcControllerState(),
      {
        setEnabled: setSmcEnabled,
        setPanel: setSmcPanel,
        abortActive: () => {
          smcAbortRef.current?.abort();
          smcAbortRef.current = null;
        }
      }
    );
  }

  const smcCommitter = smcCommitterRef.current;

  const dispatchSmc = useCallback(
    (event: SmcEvent) => {
      const transition = reduceSmcState(
        smcCommitter.getState(),
        event
      );

      smcCommitter.commit(transition);

      if (transition.fetch === null) {
        return;
      }

      const { requestId, url } = transition.fetch;

      const controller = new AbortController();

      smcAbortRef.current = controller;

      // Ответ/ошибка возвращаются в ту же машину состояний: событие
      // принимается, только если панель всё ещё включена И requestId
      // совпал с активным. Отмена (abort) не меняет ничего — stale
      // панель не остаётся.
      void (async () => {
        try {
          const response = await fetch(url, {
            signal: controller.signal
          });

          const body: unknown = await response
            .json()
            .catch(() => null);

          smcCommitter.commit(
            reduceSmcState(smcCommitter.getState(), {
              type: "http-response",
              requestId,
              ok: response.ok,
              httpStatus: response.status,
              body
            })
          );
        } catch (error) {
          if (isSmcAbortError(error)) {
            smcCommitter.commit(
              reduceSmcState(smcCommitter.getState(), {
                type: "aborted",
                requestId
              })
            );

            return;
          }

          // Ошибка Smart Money изолирована: status/errorMessage
          // свечного графика здесь НЕ трогаются.
          smcCommitter.commit(
            reduceSmcState(smcCommitter.getState(), {
              type: "network-error",
              requestId,
              message: SMC_NETWORK_ERROR_MESSAGE
            })
          );
        }
      })();
    },
    [smcCommitter]
  );

  // Смена symbol/timeframe при включённом Smart Money — новый запрос
  // (старый отменяется). Смена exchange запрос НЕ создаёт: Smart Money
  // — asset-level, а не данные выбранной биржи.
  useEffect(() => {
    dispatchSmc({ type: "params", symbol, timeframe });
  }, [symbol, timeframe, dispatchSmc]);

  // Lifecycle-фикс: на mount React-записи разрешаются (dev StrictMode
  // монтирует компонент дважды, поэтому флаг поднимается в теле
  // эффекта, а не только при создании гейта). В cleanup флаг сначала
  // опускается и лишь затем отправляется unmount-переход: активный
  // SMC-запрос отменяется, ref-state гаснет (поздний ответ не проходит
  // enabled/requestId-гард), а setState уже размонтированному
  // компоненту из cleanup НЕ отправляется.
  useEffect(() => {
    smcCommitter.markMounted();

    return () => {
      smcCommitter.markUnmounted();
      dispatchSmc({ type: "unmount" });
    };
  }, [smcCommitter, dispatchSmc]);

  const smcViewModel = useMemo<SmcPanelViewModel | null>(
    () =>
      smcPanel.status === "ready"
        ? buildSmcPanelViewModel(smcPanel.projection, exchange)
        : null,
    [smcPanel, exchange]
  );

  /* ---------- UI ---------- */

  const selectedMarket = markets.find(
    (m) => m.exchange === exchange
  );

  const loading =
    status === "loading" ||
    status === "loading-data";

  // свежесть последней закрытой свечи для статусной строки
  const lastFreshness =
    status === "ok" && dataMeta?.lastTime
      ? candleFreshness(
          timeframe,
          dataMeta.lastTime * 1000,
          new Date()
        )
      : null;

  const lastTimeLabel =
    dataMeta?.lastTime
      ? new Date(
          dataMeta.lastTime * 1000
        ).toLocaleString("ru-RU", {
          timeZone: "UTC",
          day: "2-digit",
          month: "2-digit",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit"
        }) + " UTC"
      : null;

  return (
    <div className="chartCard">
      <div className="chartToolbar">
        <label className="chartField">
          <span>Монета</span>

          <select
            value={symbol}
            disabled={symbols.length === 0}
            onChange={(e) => {
              const next = e.target.value;

              setSymbol(next);

              // URL следует за выбором: /coin/ETH?...
              // (мягкая навигация Next — серверная карточка
              // монеты тоже обновляется, без полной перезагрузки)
              if (/^[A-Z0-9]{1,16}$/.test(next)) {
                router.push(
                  `/coin/${next}${buildChartSearch(exchange, timeframe)}`,
                  { scroll: false }
                );
              }
            }}
          >
            {symbols.length === 0 ? (
              <option value="">
                {symbolsFailed
                  ? "Список недоступен"
                  : "Нет активов"}
              </option>
            ) : (
              symbols.map((s) => (
                <option
                  key={s.symbol}
                  value={s.symbol}
                >
                  {s.symbol}
                  {s.rank
                    ? ` · #${s.rank}`
                    : ""}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="chartField">
          <span>Биржа</span>

          <select
            value={exchange}
            disabled={markets.length === 0}
            onChange={(e) => {
              setExchange(e.target.value);

              window.history.replaceState(
                null,
                "",
                `${window.location.pathname}${buildChartSearch(e.target.value, timeframe)}`
              );
            }}
          >
            {markets.length === 0 ? (
              <option value="">
                Нет рынков
              </option>
            ) : (
              markets.map((m) => (
                <option
                  key={m.marketId}
                  value={m.exchange}
                >
                  {m.exchange}
                </option>
              ))
            )}
          </select>
        </label>

        <label className="chartField">
          <span>Таймфрейм</span>

          <select
            value={timeframe}
            disabled={
              !selectedMarket ||
              selectedMarket.timeframes
                .length === 0
            }
            onChange={(e) => {
              setTimeframe(e.target.value);

              window.history.replaceState(
                null,
                "",
                `${window.location.pathname}${buildChartSearch(exchange, e.target.value)}`
              );
            }}
          >
            {(selectedMarket
              ?.timeframes ?? []).map(
              (t) => (
                <option
                  key={t.timeframe}
                  value={t.timeframe}
                >
                  {timeframeLabel(
                    t.timeframe
                  )}
                </option>
              )
            )}
          </select>
        </label>

        <fieldset className="chartToggles">
          <legend className="muted">
            Индикаторы
          </legend>

          <label>
            <input
              type="checkbox"
              checked={showEma}
              onChange={(e) =>
                setShowEma(
                  e.target.checked
                )
              }
            />
            EMA
          </label>

          <label>
            <input
              type="checkbox"
              checked={showSma}
              onChange={(e) =>
                setShowSma(
                  e.target.checked
                )
              }
            />
            SMA
          </label>

          <label>
            <input
              type="checkbox"
              checked={showVolume}
              onChange={(e) =>
                setShowVolume(
                  e.target.checked
                )
              }
            />
            Объём
          </label>

          <label>
            <input
              type="checkbox"
              checked={showRsi}
              onChange={(e) =>
                setShowRsi(
                  e.target.checked
                )
              }
            />
            RSI
          </label>

          <label>
            <input
              type="checkbox"
              checked={showMacd}
              onChange={(e) =>
                setShowMacd(
                  e.target.checked
                )
              }
            />
            MACD
          </label>
        </fieldset>

        <fieldset className="chartToggles">
          <legend className="muted">
            Смарт Мани
          </legend>

          <label
            title={
              "Показывает агрегированную Smart Money оценку. " +
              "Только отображение: настройки стратегии и база " +
              "данных не меняются"
            }
          >
            <input
              type="checkbox"
              checked={smcEnabled}
              disabled={!symbol}
              onChange={(e) =>
                dispatchSmc({
                  type: "toggle",
                  enabled: e.target.checked,
                  symbol,
                  timeframe
                })
              }
            />
            Смарт Мани:{" "}
            {smcEnabled ? "Вкл" : "Выкл"}
          </label>
        </fieldset>
      </div>

      {status === "error" ? (
        <div className="chartStatus">
          <p>⚠ {errorMessage}</p>

          <button
            className="chip"
            onClick={() => {
              setStatus("loading-data");
              void loadCandles();
            }}
          >
            Повторить
          </button>
        </div>
      ) : status === "empty" ? (
        <div className="chartStatus">
          <p>{errorMessage}</p>
        </div>
      ) : (
        /*
          НА ОБЁРТКЕ НАМЕРЕННО НЕТ React-обработчика двойного клика.

          Двойной клик по правой ценовой шкале библиотека обрабатывает
          сама (handleScale.axisDoubleClickReset.price → Pane
          ._internal_resetPriceScale → autoScale true), двойной клик по
          оси времени — тоже сама (axisDoubleClickReset.time). Обработчик
          на обёртке всплывал бы от canvas'а шкалы и поверх штатного
          сброса цены выполнял resetTimeScale() + scrollToRealTime():
          масштаб времени прыгал («приближает/отдаляет»), история
          уезжала к последним барам, а только что выставленный drag'ом
          вертикальный масштаб уничтожался (setAutoScale(true) по всем
          панелям). Полный сброс — только кнопка «Сбросить масштаб».
        */
        <div
          ref={wrapRef}
          className="chartWrap"
        >
          <div
            ref={containerRef}
            className="chartContainer"
          />

          <div
            ref={legendRef}
            className="chartLegend"
          />

          {dataMeta && (
            <div className="chartDataStatus muted">
              <span className="chartStatusMarket">
                {exchange && selectedMarket
                  ? `${exchange} · ${dataMeta.exchangeSymbol} · ${timeframeLabel(timeframe)}`
                  : timeframeLabel(timeframe)}
              </span>

              <span>
                Загружено свечей:{" "}
                {dataMeta.count}
              </span>

              {lastTimeLabel && (
                <span>
                  Последняя: {lastTimeLabel}
                </span>
              )}

              {lastFreshness && (
                <span
                  className={`freshBadge ${lastFreshness.status}`}
                >
                  ● {lastFreshness.label}
                </span>
              )}

              {historyLoading && (
                <span>Загрузка истории…</span>
              )}

              {historyEnded &&
                !historyError && (
                  <span>
                    История загружена полностью
                  </span>
                )}

              {historyError && (
                <span className="chartHistoryError">
                  Ошибка загрузки истории —
                  график остался на
                  загруженных данных
                </span>
              )}
            </div>
          )}

          {loading && (
            <div className="chartOverlay">
              Загрузка…
            </div>
          )}

          {historyLoading && (
            <div className="chartHistoryLoader">
              Загрузка истории…
            </div>
          )}

          <button
            type="button"
            className="chip chartResetScale"
            title="Вернуть масштаб по умолчанию"
            onClick={resetChartScale}
          >
            Сбросить масштаб
          </button>
        </div>
      )}

      {/* P1-C: read-only панель Smart Money. Рендерится независимо от
          статуса свечей (ошибка свечей не прячет Smart Money, ошибка
          Smart Money не ломает свечи); при toggle OFF компонент
          возвращает null. */}
      <SmartMoneyPanel
        panel={smcPanel}
        viewModel={smcViewModel}
        timeframeLabelOf={timeframeLabel}
      />

      {status === "ok" && (
        <div className="chartNote muted">
          Показаны только закрытые свечи из PostgreSQL
          {selectedMarket
            ? ` · рынок ${selectedMarket.exchangeSymbol} на ${selectedMarket.exchange}`
            : ""}
          . Навигация: перетаскивание мышью или
          горизонтальный свайп — движение по истории,
          колесо мыши или щипок — масштаб, драг по оси
          времени или по ценовой шкале — масштаб оси,
          двойной клик по оси и кнопка «Сбросить
          масштаб» — возврат к авто-масштабу и последним
          закрытым барам; прокрутка влево подгружает
          более старую историю, текущий вид при этом
          сохраняется
          {historyEnded
            ? " · история загружена полностью"
            : ""}
          .
        </div>
      )}
    </div>
  );
}
