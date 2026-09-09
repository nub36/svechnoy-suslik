"use client";

import Link from "next/link";
import { Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

type SearchResult = {
  symbol: string;
  name: string | null;
  rank: number | null;
};

/**
 * Рабочий поиск по активам: запрос к /api/search
 * (PostgreSQL), переход на страницу монеты.
 * До появления базы честно пишет «Ничего не найдено»
 * или ошибку, не выдумывает результаты.
 */
export default function SearchBox() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    SearchResult[]
  >([]);
  const [status, setStatus] = useState<
    "idle" | "loading" | "error" | "done"
  >("idle");
  const boxRef = useRef<HTMLDivElement | null>(
    null
  );

  useEffect(() => {
    if (!open) {
      return;
    }

    const trimmed = query.trim();

    if (trimmed.length === 0) {
      setResults([]);
      setStatus("idle");

      return;
    }

    const controller =
      new AbortController();

    const timer = setTimeout(() => {
      setStatus("loading");

      fetch(
        `/api/search?q=${encodeURIComponent(trimmed)}`,
        { signal: controller.signal }
      )
        .then((response) =>
          response.json()
        )
        .then((data) => {
          if (
            controller.signal.aborted
          ) {
            return;
          }

          if (data.error) {
            setStatus("error");
            setResults([]);

            return;
          }

          setResults(
            data.results ?? []
          );
          setStatus("done");
        })
        .catch((error) => {
          if (
            error instanceof DOMException &&
            error.name === "AbortError"
          ) {
            return;
          }

          setStatus("error");
          setResults([]);
        });
    }, 250);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  useEffect(() => {
    if (!open) {
      return;
    }

    const onClick = (event: MouseEvent) => {
      if (
        boxRef.current &&
        !boxRef.current.contains(
          event.target as Node
        )
      ) {
        setOpen(false);
      }
    };

    const onKey = (
      event: KeyboardEvent
    ) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener(
      "mousedown",
      onClick
    );
    document.addEventListener(
      "keydown",
      onKey
    );

    return () => {
      document.removeEventListener(
        "mousedown",
        onClick
      );
      document.removeEventListener(
        "keydown",
        onKey
      );
    };
  }, [open]);

  if (!open) {
    return (
      <button
        className="iconBtn"
        title="Поиск актива"
        onClick={() => setOpen(true)}
      >
        <Search size={18} />
      </button>
    );
  }

  return (
    <div
      className="searchBox"
      ref={boxRef}
    >
      <div className="searchBoxRow">
        <input
          autoFocus
          className="searchBoxInput"
          placeholder="Тикер или название…"
          value={query}
          onChange={(e) =>
            setQuery(e.target.value)
          }
          aria-label="Поиск актива"
        />

        <button
          className="iconBtn"
          title="Закрыть поиск"
          onClick={() => {
            setOpen(false);
            setQuery("");
            setResults([]);
          }}
        >
          <X size={18} />
        </button>
      </div>

      {status === "loading" && (
        <div className="searchBoxHint muted">
          Поиск…
        </div>
      )}

      {status === "error" && (
        <div className="searchBoxHint muted">
          База временно недоступна
        </div>
      )}

      {status === "done" &&
        results.length === 0 && (
          <div className="searchBoxHint muted">
            Ничего не найдено
          </div>
        )}

      {results.length > 0 && (
        <ul className="searchBoxList">
          {results.map((r) => (
            <li key={r.symbol}>
              <Link
                href={`/coin/${r.symbol}`}
                onClick={() => {
                  setOpen(false);
                  setQuery("");
                  setResults([]);
                }}
              >
                <b>{r.symbol}</b>
                <span className="muted">
                  {r.name ?? ""}
                  {r.rank
                    ? ` · #${r.rank}`
                    : ""}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
