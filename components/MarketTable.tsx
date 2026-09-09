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

export default function MarketTable({ coins }: { coins: Coin[] }) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.toLowerCase();

    return coins.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.symbol.toLowerCase().includes(q)
    );
  }, [coins, query]);

  return (
    <>
      <div className="toolbar">
        <input
          className="search"
          placeholder="Поиск BTC, ETH, SOL..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />

        <button className="chip">Все активы</button>
        <button className="chip">🔥 С сигналом</button>
        <button className="chip">Рост</button>
        <button className="chip">Падение</button>
        <button className="chip">Настроить колонки</button>
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
              <th>RSI</th>
              <th>Сигнал</th>
            </tr>
          </thead>

          <tbody>
            {filtered.map((coin, i) => {
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
                  <td className="muted">—</td>

                  <td>
                    <span className="signal neutral">АНАЛИЗ</span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
