"use client";

import { useEffect, useRef, useState, useId } from "react";

declare global {
  interface Window {
    TradingView: any;
  }
}

type Props = {
  symbol?: string;
  interval?: string;
  theme?: "light" | "dark";
};

export default function TradingViewWidget({ symbol = "BINANCE:BTCUSDT", interval = "15", theme = "dark" }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);
  const reactId = useId();
  // Stable id for SSR — useId is stable, no random in render
  const containerId = `tradingview_${reactId.replace(/:/g, "_")}`;
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!chartRef.current) return;
    if (typeof window === "undefined") return;

    let cancelled = false;

    const createWidget = () => {
      if (cancelled) return;
      if (!chartRef.current) return;
      if (!window.TradingView || !window.TradingView.widget) {
        setError("TradingView не загрузился");
        setLoading(false);
        return;
      }
      try {
        // Ensure chart container has id and is empty (TradingView injects iframe)
        chartRef.current.id = containerId;
        // Do not use innerHTML = "" that would remove React children — chartRef is dedicated empty div
        widgetRef.current = new window.TradingView.widget({
          autosize: true,
          symbol,
          interval,
          timezone: "Etc/UTC",
          theme,
          style: "1",
          locale: "ru",
          toolbar_bg: "#0e1319",
          enable_publishing: false,
          hide_top_toolbar: false,
          hide_legend: false,
          save_image: false,
          allow_symbol_change: false,
          container_id: containerId,
          studies: [],
        });
        setLoading(false);
        setError(null);
      } catch (e) {
        console.error("[TradingViewWidget] create failed", e);
        setError("Ошибка инициализации графика");
        setLoading(false);
      }
    };

    const loadScript = () => {
      if (window.TradingView && window.TradingView.widget) {
        createWidget();
        return;
      }
      const existing = document.querySelector('script[data-tradingview="true"]') as HTMLScriptElement | null;
      if (existing) {
        if (window.TradingView && window.TradingView.widget) {
          createWidget();
        } else {
          const onLoad = () => createWidget();
          const onError = () => {
            if (!cancelled) {
              setError("Не удалось загрузить TradingView (блокировщик?)");
              setLoading(false);
            }
          };
          existing.addEventListener("load", onLoad);
          existing.addEventListener("error", onError);
        }
        return;
      }
      const script = document.createElement("script");
      script.src = "https://s3.tradingview.com/tv.js";
      script.async = true;
      script.setAttribute("data-tradingview", "true");
      script.onload = () => {
        if (!cancelled) createWidget();
      };
      script.onerror = () => {
        if (!cancelled) {
          setError("Не удалось загрузить TradingView (проверьте блокировщик)");
          setLoading(false);
        }
      };
      document.head.appendChild(script);
    };

    const timer = setTimeout(() => loadScript(), 50);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      try {
        // Best effort cleanup — TradingView widget doesn't have official destroy, remove container content
        if (chartRef.current) {
          chartRef.current.innerHTML = "";
        }
      } catch {}
      widgetRef.current = null;
    };
  }, [symbol, interval, theme, containerId]);

  return (
    <div className="tradingViewCard">
      <div className="tradingViewHeader">
        <b>График TradingView</b>
        <span className="muted" style={{ fontSize: "11px" }}>
          BTC/USDT · 15 минут · TradingView
        </span>
      </div>
      <div className="tradingViewContainer" style={{ position: "relative" }}>
        <div ref={chartRef} id={containerId} style={{ width: "100%", height: "100%" }} />
        {loading && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "var(--panel)", color: "var(--muted)", fontSize: "12px" }}>
            Загрузка графика {symbol} {interval}м...
          </div>
        )}
        {error && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: "6px", padding: "12px", textAlign: "center", background: "var(--panel)" }}>
            <span style={{ fontSize: "12px", color: "var(--muted)" }}>{error}</span>
            <span style={{ fontSize: "11px", color: "var(--muted)" }}>BINANCE:BTCUSDT 15м — откройте на TradingView.com</span>
            <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px", color: "var(--accent)", textDecoration: "underline" }}>
              Открыть на TradingView.com
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
