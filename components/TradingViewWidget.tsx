"use client";

import { useEffect, useRef, useState } from "react";

declare global {
  interface Window {
    TradingView: any;
  }
}

type Props = {
  symbol?: string; // e.g. BINANCE:BTCUSDT
  interval?: string; // e.g. 15
  theme?: "light" | "dark";
};

export default function TradingViewWidget({ symbol = "BINANCE:BTCUSDT", interval = "15", theme = "dark" }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetRef = useRef<any>(null);
  const idRef = useRef<string>(`tradingview_${Math.random().toString(36).slice(2)}_${Date.now()}`);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    if (typeof window === "undefined") return;

    const containerId = idRef.current;
    // Ensure container has stable id
    if (containerRef.current) {
      containerRef.current.id = containerId;
    }

    let cancelled = false;

    const createWidget = () => {
      if (cancelled) return;
      if (!containerRef.current) return;
      if (!window.TradingView || !window.TradingView.widget) {
        setError("TradingView не загрузился");
        setLoading(false);
        return;
      }
      try {
        // Clear previous content safely (avoid blank large box on re-mount)
        if (containerRef.current) {
          containerRef.current.innerHTML = "";
        }

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
          // Official Advanced Chart widget — plain chart only, Pine separate
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

      // Avoid duplicate script tags
      const existing = document.querySelector('script[data-tradingview="true"]') as HTMLScriptElement | null;
      if (existing) {
        if (window.TradingView && window.TradingView.widget) {
          createWidget();
        } else {
          existing.addEventListener("load", createWidget);
          existing.addEventListener("error", () => {
            setError("Не удалось загрузить TradingView (блокировщик?)");
            setLoading(false);
          });
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
          setError("Не удалось загрузить TradingView (проверьте блокировщик рекламы)");
          setLoading(false);
        }
      };
      document.head.appendChild(script);
    };

    // Small delay to ensure container is mounted and has height (Next.js client navigation)
    const timer = setTimeout(() => {
      loadScript();
    }, 100);

    return () => {
      cancelled = true;
      clearTimeout(timer);
      try {
        if (containerRef.current) {
          containerRef.current.innerHTML = "";
        }
      } catch {}
      widgetRef.current = null;
    };
  }, [symbol, interval, theme]);

  return (
    <div className="tradingViewCard">
      <div className="tradingViewHeader">
        <b>График TradingView</b>
        <span className="muted" style={{ fontSize: "11px" }}>
          BTC/USDT · 15 минут · TradingView
        </span>
      </div>
      <div ref={containerRef} className="tradingViewContainer">
        {loading && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--muted)", fontSize: "12px" }}>
            Загрузка графика {symbol} {interval}м...
          </div>
        )}
        {error && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", gap: "6px", padding: "12px", textAlign: "center" }}>
            <span style={{ fontSize: "12px", color: "var(--muted)" }}>{error}</span>
            <span style={{ fontSize: "11px", color: "var(--muted)" }}>
              BINANCE:BTCUSDT 15м — откройте график на TradingView.com или проверьте блокировщик
            </span>
            <a href={`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: "11px", color: "var(--accent)", textDecoration: "underline" }}>
              Открыть на TradingView.com
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
