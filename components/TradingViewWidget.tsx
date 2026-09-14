"use client";

import { useEffect, useRef } from "react";

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

  useEffect(() => {
    if (!containerRef.current) return;

    const containerId = `tradingview_${Math.random().toString(36).slice(2)}`;
    containerRef.current.id = containerId;

    const createWidget = () => {
      if (!window.TradingView || !containerRef.current) return;
      // Clear previous
      containerRef.current.innerHTML = "";
      // Re-assign id after clear
      containerRef.current.id = containerId;

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
        container_id: containerId,
        studies: [],
        // Keep responsive, integrated with current design
        // If custom Pine smart-money-v2.pine cannot be embedded, we do NOT fake support — plain chart only
        // backend V2 status/signals remain website data, pine maintained separately for TradingView.com
      });
    };

    const loadScript = () => {
      if (window.TradingView) {
        createWidget();
        return;
      }
      const script = document.createElement("script");
      script.src = "https://s.tradingview.com/tv.js";
      script.async = true;
      script.onload = () => createWidget();
      document.head.appendChild(script);
    };

    loadScript();

    return () => {
      // Cleanup
      if (containerRef.current) containerRef.current.innerHTML = "";
      widgetRef.current = null;
    };
  }, [symbol, interval, theme]);

  return (
    <div className="tradingViewCard">
      <div className="tradingViewHeader">
        <b>График TradingView</b>
        <span className="muted" style={{ fontSize: "11px" }}>
          {symbol} · {interval}м · BINANCE default · Smart Money V2 Pine — отдельно на TradingView.com
        </span>
      </div>
      <div ref={containerRef} className="tradingViewContainer" />
    </div>
  );
}
