"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import type { Coin } from "@/lib/market";

function money(n: number) {
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;

  return `$${n.toLocaleString("ru-RU", {
    maximumFractionDigits: 4
  })}`;
}

type Filter = "all" | "up" | "down";

/**
 * Таблица рынка: данные CoinGecko (сервер),
 * клиентские фильтры «Все / Рост / Падение».
 *
 * Колонки RSI и «Сигнал» с заглушками удалены:
 * реальных данных для них пока нет, а выдумывать
 * значения запрещено.
 */
export default function MarketTable({ coins }: { coins: Coin[] }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  if (coins.length === 0) {
    return (
      <div className="tableBox">
        <p className="muted" style={{ padding: "1rem" }}>
          Нет данных: источник рынка временно недоступен.
        </p>
      </div>
    );
  }

  const filtered = useMemo(() => {
    const q = query.toLowerCase();

    return coins.filter((c) => {
      if (
        q &&
        !c.name.toLowerCase().includes(q) &&
        !c.symbol.toLowerCase().includes(q)
      ) {
        return false;
      }

      const change =
        c.price_change_percentage_24h ?? 0;

      if (filter === "up" && change < 0) {
        return false;
      }

      if (filter === "down" && change >= 0) {
        return false;
      }

      return true;
    });
  }, [coins, query, filter]);

  const filters: {
    id: Filter;
    label: string;
  }[] = [
    { id: "all", label: "Все активы" },
    { id: "up", label: "Рост" },
    { id: "down", label: "Падение" }
  ];

  return (
    <>
      <div className="toolbar">
        <input
          className="search"
          placeholder="Поиск BTC, ETH, SOL..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        {filters.map((f) => (
          <button
            key={f.id}
            className={`chip${
              filter === f.id ? " chipActive" : ""
            }`}
            onClick={() => setFilter(f.id)}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="tableBox">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Актив</th>
              <th>Цена</th>
              <th>24ч</th>
              <th>Объём 24ч</th>
              <th>Капитализация</th>
            </tr>
          </thead>

          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={6} className="muted" style={{ textAlign: "center", padding: "1.2rem" }}>
                  Ничего не найдено
                </td>
              </tr>
            ) : (
              filtered.map((coin, i) => {
                const change = coin.price_change_percentage_24h ?? 0;

                return (
                  <tr key={coin.id}>
                    <td className="muted">{i + 1}</td>

                    <td>
                      <Link
                        href={`/coin/${coin.symbol.toUpperCase()}`}
                        className="asset"
                      >
                        {coin.image ? (
                          <img
                            src={coin.image}
                            alt=""
                            width={31}
                            height={31}
                            style={{ borderRadius: "50%" }}
                          />
                        ) : (
                          <span className="coinIcon">
                            {coin.symbol.slice(0, 2).toUpperCase()}
                          </span>
                        )}

                        <span>
                          {coin.symbol.toUpperCase()}
                          <small
                            className="muted"
                            style={{ display: "block", fontWeight: 400 }}
                          >
                            {coin.name}
                          </small>
                        </span>
                      </Link>
                    </td>

                    <td>{money(coin.current_price)}</td>

                    <td className={change >= 0 ? "positive" : "negative"}>
                      {change >= 0 ? "+" : ""}
                      {change.toFixed(2)}%
                    </td>

                    <td>{money(coin.total_volume)}</td>
                    <td>{money(coin.market_cap)}</td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
