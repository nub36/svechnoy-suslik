# Свечной Суслик — Product Roadmap & Backlog

Последнее обновление: 10.09.2026
HEAD: `877dc61889866888fff2f5f91747405a1f9ae0a9` (Phase 3E alignment fix, **не принят на VPS**)
Ветка: `arena/01a08b68-svechnoy-suslik`
Статус: документация — без изменения runtime/Admin/DB

> Эта документация — единственный актуальный бэклог. `PROJECT_CONTEXT.md` §1–31 остаётся историческим контекстом; приоритеты и границы фич — здесь. `CHANGELOG.md` — хронология выполненных этапов. `docs/phase3e-diagnostic-report.md` — диагностический отчёт Phase 3E.

---

## 0. Направление продукта

«Свечной Суслик» — самостоятельная crypto analytics platform. Не копировать UI/брендинг TRdesk/TradingView. Референсы могут вдохновлять функциональность только.

Ключевые отличия:
- реальные PostgreSQL-данные рынка (не демо);
- объяснимые стратегии (exact reasons);
- мультибиржевое подтверждение (minExchanges);
- воспроизводимые расчёты по **CLOSED** свечам;
- честные состояния `cannot-evaluate` ≠ `NEUTRAL`;
- будущие бэктесты без фальшивой статистики;
- объяснимые сигналы с точным скоopen.

Никаких выдуманных AI-прогнозов и фейковых метрик.

---

## 1. Порядок приоритетов (обязателен)

**P0 — Завершить Smart Money Strategy**
- Phase 3E multi-timeframe verification (текущий; `877dc61` ожидает VPS-приёмку)
- Phase 3D advanced configurable SMC parameters (Displacement, FVG, Liquidity, Order Blocks и др.)
- Полная Admin-конфигурируемость (русские описания, диапазоны, зависимости)
- Финальная приёмка Smart Money (read-only → staged → enabled)

**P1 — SuslikChart / визуализация стратегии**
- Собственный график на PostgreSQL-свечах, оверлеи SMC, объяснение `WHY` сигнала

**P2 — Backtest Engine / тестер стратегий**
- Честный, воспроизводимый, без lookahead, с комиссией/проскальзыванием

**P3 — Suslik Scanner + Market dashboard**
- Top-100 сканер по реальным данным Strategy

**P4 — Дополнительный центр индикаторной аналитики**
- Только реальные рассчитанные индикаторы

**P5 — Signal Engine + alerts ТОЛЬКО после готовности стратегии/бэктеста**

**P6 — Watchlist / персонализация**

**P7 — Статьи/CMS и дальнейшее расширение продукта**

Нельзя реализовывать P1–P7 в обход P0, нельзя запускать Signal/алерты до приёмки.

---

## 2. SuslikChart — изменение требования

**Отменено:** переключатель страниц `[ Суслик ] [ TradingView ]`

**Сейчас:**
- Развивать **собственный SuslikChart** на PostgreSQL-свечах (`lib/exchanges`, `Candle`, `IndicatorSnapshot`)
- Не реализовывать TradingView-режим, не имитировать его UI, не выдавать самодельный график за TradingView

**Текущие оверлеи:**
- Свечи, Volume, EMA(20/50/200), RSI(14), MACD(12/26/9)

**Будущие Smart Money оверлеи (после финализации ядра стратегии):**
- swing highs / lows
- BOS (Break of Structure)
- CHoCH / MSS
- liquidity levels
- liquidity sweeps
- FVG / imbalance
- Swing Order Blocks
- Internal Order Blocks
- mitigation / invalidation где осмысленно
- active dealing range
- Premium / Equilibrium / Discount
- вклад каждой компоненты в LONG/SHORT scoring
- мультитаймфрейм-контекст

**Критичный UX:** открыв результат/сигнал Smart Money, пользователь должен **видеть ПОЧЕМУ** он возник.
Пример заголовка:
`BTC · 15m · LONG 82/100 · confirmed 4/5 exchanges`
→ на графике подсвечены соответствующие BOS/sweep/OB/FVG/range.

Реализация только после Phase 3E/3D — не блокирует текущий P0.

---

## 3. Сканер Суслика (P3)

Будущий раздел «Сканер Суслика». Primary universe: **Top-100** (`Asset.rank 1..100`, `lib/universe.ts` `TOP_UNIVERSE_SIZE=100`, `isInTopUniverse`). Legacy `top500` / `Asset.top500` / `filters.top500Only` сохранены как история/совместимость.

Сканер показывает только реальные данные:

- Asset / symbol
- timeframe: `5m / 15m / 1h / 4h / 1d`
- Smart Money direction: `LONG / SHORT / NEUTRAL / cannot-evaluate`
- LONG score, SHORT score
- мультибиржевое подтверждение: `3/5, 4/5`
- conflict state
- last relevant BOS
- liquidity sweep state
- FVG state
- Swing OB, Internal OB
- Premium / Equilibrium / Discount
- data freshness (`lib/data/freshness.ts`: `age ≤2D → АКТУАЛЬНО`, `≤6D → ЗАДЕРЖКА`, иначе `УСТАРЕЛО`)
- last CLOSED candle (`openTime`)

Фильтры/сортировка: direction, score, timeframe, confirmation, liquidity/volume, наличие SMC-компоненты, freshness. Клик → ` /coin/[symbol]` с объяснением scoring.

Никаких фейковых строк сканера.

---

## 4. Объяснимость «Почему нет сигнала?»

Нельзя показывать только `BTC NEUTRAL`.

Нужно показывать:

```
BTC · 1h
LONG 20 / SHORT 15  threshold 72
- bullish swing structure +20
- bearish internal structure +10 SHORT
- bearish internal OB +5 SHORT
- no fresh BOS
- no liquidity sweep
- no active FVG
- no active dealing range
```

`cannot-evaluate` остаётся отдельным от `NEUTRAL` (недостаточно истории, невалидные свечи, фильтры). Пользователь понимает, почему нет LONG/SHORT.

---

## 5. Мультитаймфрейм-матрица

Будущая фича Scanner/Coin:

```
BTC
5m   LONG
15m  LONG
1h   NEUTRAL
4h   LONG
1d   cannot-evaluate
```

Никогда не превращать `cannot-evaluate` / недоступность в фейковый `NEUTRAL`. Опционально показывать scores и `confirmation`.

---

## 6. Центр индикаторной аналитики (P4)

Будущий раздел «Индикаторы». Старт только с реальных рассчитанных:

- EMA, RSI, MACD, ATR, Volume, Smart Money analytics

Возможные реальные расширения после готовности данных:
- volatility, relative volume, market breadth, trend breadth, cross-asset rankings

Funding / Open Interest / ликвидации / order book / CVD / on-chain — **только после** появления реальных источников и пайплайнов хранения. Не создавать фейковые значения для заполнения UI.

---

## 7. Backtest Engine / Тестер стратегий (P2)

Высокий приоритет после Smart Money + визуализация. Будущий раздел «Тестер стратегий» / Backtest.

Требования честности:
- CLOSED свечи только
- no lookahead, детерминизм
- commission, slippage
- in-sample / out-of-sample, walk-forward
- trades, win rate, PnL, max drawdown, profit factor, Sharpe, Sortino
- стабильность по активам / таймфреймам / режимам рынка

Нельзя заявлять прибыльность до этих тестов. Никакого фейкового PnL/winrate.

---

## 8. Сигналы — будущее, не сейчас (P5)

Продукт предполагает реальные сигналы, но **Signal Engine строго запрещён сейчас**.

Экспериментальный коммит `edf3732` **не должен** попадать в текущую работу (`git merge-base --is-ancestor edf3732 HEAD` → NOT ancestor, проверено).

Текущий Smart Money производит только Strategy Runtime/results (read-only, без записи `Signal`).

Будущий Signal концептуально:

```
BTC 15m LONG 82/100 confirmed 4/5
- компоненты и баллы, candleTime, версия стратегии, timeframe, биржи
- chart-контекст
```

Production-запись `Signal` возможна только в отдельно спроектированной и одобренной фазе после:
- финальной приёмки Smart Money
- multi-TF верификации (Phase 3E)
- готовности архитектуры бэктеста

Сейчас — никакой реализации.

---

## 9. Алерты — после Signal Engine

Будущее: Telegram / web / возможно email.

Примеры условий (выбирает пользователь):
- Smart Money LONG score ≥80
- минимум 3 подтверждения бирж
- timeframe 15m
- выбранные активы/watchlist

Бэкенда алертов сейчас нет.

---

## 10. Watchlist (P6)

Персональный список монет:

- последние результаты Strategy
- multi-TF матрица
- scores, confirmation, важные SMC-события
- позже сигналы/алерты

Только реальные данные.

---

## 11. Market Dashboard

Эволюция каталога рынка (Top-100) с фильтрами/сортировкой, рангом, ценой/изменением, объёмом, freshness, состоянием стратегии, multi-TF, confirmation, ссылками на SuslikChart.

---

## 12. Admin vs Public стратегии

- **Admin Strategy** — профессиональная конфигурация детерминированных алгоритмов (`/admin/strategies/[id]`, `StrategyEditor`, `validateSmartMoneyRuntime`)
- **Public `/strategies`** — человекочитаемое объяснение: что анализирует стратегия, текущие реальные результаты, позже верифицированные бэктесты, без редактирования production-конфига

Не выносить Admin-контролы в паблик.

---

## 13. Admin-конфигурируемость

Smart Money должен быть максимально разумно конфигурируем через Admin, но **никогда** не делать конфигурируемыми инварианты безопасности:
- CLOSED-only
- no-lookahead
- детерминизм
- cannot-evaluate семантика
- Signal safety, валидационная связность

Phase 3D открывает безопасные профессиональные параметры: Displacement, FVG, Liquidity, Order Blocks и др.

Каждая настройка Admin — русское объяснение: что значит, что делает увеличение/уменьшение, допустимый диапазон, дефолт, зависимости.

---

## 14. Статьи / CMS (P7)

Admin: список, создание/редактирование, title/slug/excerpt/content/cover/categories/tags/draft/published/publish date/SEO/preview
Public: `/articles`, `/articles/[slug]`
Только PostgreSQL. Без фейковых статей.

---

## 15. Монетизация

Не реализовывать pricing/subscription сейчас. Возможная модель Free/Pro рассматривается только после появления ценности: scanner, стратегии, бэктесты, реальные сигналы, алерты.

---

## 16. Текущие правила безопасности (обязательны)

- Signal Engine `edf3732` запрещён
- Никаких фейковых market/signal/backtest данных
- Никакого `prisma db push --force-reset` / удаления PostgreSQL без необходимости
- Никаких воркеров без явного одобрения; web не запускает OHLCV/snapshot workers
- Review и production сейчас делят один PostgreSQL — `Admin Save` во время review мутирует реальную БД (осторожно)
- Top-100 — основной universe (`rank 1..100`); `Asset.top500` / `top500Only` — legacy/история
- Прибыльность стратегии требует бэктеста / out-of-sample доказательств
- Все расчёты — CLOSED свечи, детерминизм, cannot-evaluate честно
- `877dc61` Phase 3E fix ожидает независимой приёмки на VPS — до неё не продолжать имплементацию следующих приоритетов

---

## 17. Что сделано на 877dc61 и что дальше

- Phase 3C: `["1h"]` staged lock, Admin/API, `minExchanges 3`, `DRAFT disabled`
- Phase 3E diagnostic: `lib/strategies/alignment.ts` (grid + same horizon, `referenceCandleTime`, `offGrid`/`horizonMismatch`, `safe=false` для 0 evaluated), generic `MULTI-EXCHANGE AGGREGATION REFUSED` для всех TF, `docs/phase3e-diagnostic-report.md`
- **Дальше:** VPS-приёмка `877dc61` → Phase 3D configurable SMC → финальная приёмка Smart Money → P1 SuslikChart → P2 Backtest → затем P3–P7

---

## 18. Связанные документы

- `PROJECT_CONTEXT.md` — исторический контекст (до §31g)
- `CHANGELOG.md` — хронология этапов
- `docs/phase3e-diagnostic-report.md` — отчёт Phase 3E (observed BINGX 16:00 UTC vs 00:00 UTC)
- `lib/strategies/alignment.ts` — guard-реализация
- `lib/universe.ts` — Top-100 константы
