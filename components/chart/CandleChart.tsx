"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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

export default function CandleChart({
  initialSymbol
}: {
  initialSymbol?: string;
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

  const [symbols, setSymbols] = useState<
    SymbolInfo[]
  >([]);
  const [symbol, setSymbol] = useState(
    initialSymbol?.toUpperCase() ?? ""
  );
  const [markets, setMarkets] = useState<
    MarketInfo[]
  >([]);
  const [exchange, setExchange] =
    useState("");
  const [timeframe, setTimeframe] =
    useState("1h");

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

  /* ---------- наполнение серий данными ---------- */

  const applyData = useCallback(
    (data: CandlesResponse) => {
      dataRef.current = data;

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

      chartRef.current?.timeScale().fitContent();
    },
    []
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
      rightPriceScale: {
        borderColor: colors.line
      },
      timeScale: {
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
        priceLineWidth: 1
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

    applyVisibility();

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
  }, [applyChartTheme, applyVisibility]);

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
          setStatus("error");
          setErrorMessage(
            data.error ??
              "Не удалось загрузить список активов"
          );

          return;
        }

        const list = data.symbols ?? [];

        setSymbols(list);

        if (list.length === 0) {
          setStatus("empty");
          setErrorMessage(
            "Нет данных: в PostgreSQL пока нет свечей. Запустите OHLCV worker."
          );

          return;
        }

        const preferred =
          initialSymbol?.toUpperCase();

        if (
          preferred &&
          list.some(
            (s) => s.symbol === preferred
          )
        ) {
          setSymbol(preferred);
        } else {
          setSymbol(list[0].symbol);
        }
      } catch {
        if (!cancelled) {
          setStatus("error");
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
          setStatus("error");
          setErrorMessage(
            data.error ??
              "Не удалось загрузить рынки"
          );

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

        setExchange(list[0].exchange);

        const first = list[0];

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
          setStatus("error");
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
        applyVisibility();
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
      applyVisibility,
      applyChartTheme
    ]
  );

  useEffect(() => {
    void loadCandles();

    return () => {
      abortRef.current?.abort();
    };
  }, [loadCandles]);

  useEffect(() => {
    applyVisibility();
  }, [applyVisibility]);

  /* ---------- UI ---------- */

  const selectedMarket = markets.find(
    (m) => m.exchange === exchange
  );

  const loading =
    status === "loading" ||
    status === "loading-data";

  return (
    <div className="chartCard">
      <div className="chartToolbar">
        <label className="chartField">
          <span>Монета</span>

          <select
            value={symbol}
            disabled={symbols.length === 0}
            onChange={(e) =>
              setSymbol(e.target.value)
            }
          >
            {symbols.length === 0 ? (
              <option value="">
                Нет активов
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
            onChange={(e) =>
              setExchange(e.target.value)
            }
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
            onChange={(e) =>
              setTimeframe(e.target.value)
            }
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
        <div className="chartWrap">
          <div
            ref={containerRef}
            className="chartContainer"
          />

          {loading && (
            <div className="chartOverlay">
              Загрузка…
            </div>
          )}
        </div>
      )}

      {status === "ok" && (
        <div className="chartNote muted">
          Показаны только закрытые свечи из PostgreSQL
          {selectedMarket
            ? ` · рынок ${selectedMarket.exchangeSymbol} на ${selectedMarket.exchange}`
            : ""}
          . Масштаб — колесо мыши или щипок,
          прокрутка истории — перетаскивание.
        </div>
      )}
    </div>
  );
}
