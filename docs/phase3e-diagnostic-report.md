# Phase 3E — Multi-timeframe diagnostic report (READ-ONLY)

Date: 2026-09-10
Branch: `arena/01a08b68-svechnoy-suslik` parent `2850a2c` (Phase 3C staged `["1h"]`)
Scope: READ-ONLY verification, no DB writes, no Strategy mutation, no workers, no Signal.

## 1. Baseline facts (as given, verified by diagnostic code)

- Universe: BTC on 5 exchanges (BINANCE, BYBIT, GATE, KUCOIN, BINGX), PostgreSQL, `closed=true`.
- Counts on production (per task description, воспроизводимо диагностикой):
  - `5m`: 299 each exchange (5×299), `badStep=0`, `badClosedCloseTime=0`
  - `15m`: BYBIT 300, others 299, `badStep=0`, `badClosedCloseTime=0`
  - `1h`: 306 each, `badStep=0`, `badClosedCloseTime=0`
  - `4h`: 299 each, `badStep=0`, `badClosedCloseTime=0`
  - `1d`: 299 each, `badStep=0`, `badClosedCloseTime=0`
- Signal table: 0 rows (Phase 2/3B: no Signal Engine yet).
- Strategy `smart-money-suslik v1 id=2`: `DRAFT`, `enabled=false`, `timeframes=["1h"]`, `minExchanges=3` — staged, не меняется в этой фазе.
- `edf3732…` NOT ancestor — не релевантно текущему HEAD.
- Существующий `smart-money-readonly.ts` без флага корректно **отказывал** для `5m/15m/4h/1d` когда в Strategy только `["1h"]` — это поведение сохранено. Флаг `--diagnostic-canonical-config` лишь добавляет диагностический bypass, не ослабляет нормальный путь.

## 2. BINGX 1d adapter audit

**Файл**: `lib/exchanges/bingx.ts` — без изменений, только audit (read-only).

| Параметр | Значение |
|---|---|
| Endpoint | `https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=${symbol}&interval=${bingxInterval(tf)}&limit=${min(limit,1000)}` |
| Интервал для `1d` | `bingxInterval("1d") === "1d"` (строка `"1d"`, без weekly/monthly) |
| Парсинг `openTime` | `Number(row[0])` если массив, иначе `row.time ?? row.openTime ?? row.timestamp` → `new Date(openTime)` |
| `closeTime` | `openTime + duration - 1`, где `duration = 86_400_000` для `1d`; `closed = closeTime < now` |
| Ресамплинг | отсутствует — сырые свечи BingX пишутся как есть в `Candle.openTime` |

**Observed DB fact (no external cause asserted)**: For `1d`, BINGX BTC candles observed in PostgreSQL use `16:00 UTC` openTime boundary, while the other four observed exchanges use `00:00 UTC` (canonical `openTime % 86_400_000 === 0`). This is stably reproduced (`16 * 3_600_000 = 57_600_000` ms delta). We do NOT assert a proven external cause such as CST/UTC+8 without authoritative adapter contract — only observed storage behavior.

**Вывод**: для `1d` cross-exchange агрегация некорректна, пока BINGX не нормализован. Для `5m/15m/1h/4h` observed как UTC-grid aligned для всех 5 бирж (`% tfMs === 0`) — расхождение только на `1d` stale/horizon тест показал критичность generic guard.

## 3. Alignment guard — generic для всех TF (fixed)

**Файл**: `lib/strategies/alignment.ts` (pure, без DB/Prisma/Signal/workers, детерминированный, без lookahead).

`MarketStrategyResult.candleTime` — latest CLOSED candle openTime (PostgreSQL `closed=true` последняя свеча). Для одного timeframe одинаковый `candleTime` означает один и тот же интервал `[candleTime, candleTime+tf)`; wall-clock не сравнивается.

Safe aggregation требует ОБА условия:

- A) canonical grid: `candleTime.getTime() % SMCTIMEFRAME_MS[tf] === 0` (UTC граница: 5m каждые 5 мин, 1h ровно час, 4h кратно 4ч, 1d полночь UTC)
- B) same evaluation horizon: все `evaluated` рынки имеют точно одинаковый `candleTime` (ровно одно значение; даже одна свеча разницы — разные окна, stale). Без tolerance/skew.

Структура результата:

- `isCanonicalAligned(date, tf)` — проверка A
- `checkCandleAlignment(results, tf)` → `AlignmentCheck { aligned/safe, referenceCandleTime, details, offGrid, horizonMismatch, misaligned (alias offGrid), alignedCount, totalEvaluated, reason }`
  - `referenceCandleTime` — `details[0].candleTime` или `null` если нет evaluated
  - `offGrid` — `!isCanonicalAligned`
  - `horizonMismatch` — `candleTime !== referenceCandleTime`
  - `safe = offGrid.length===0 && horizonMismatch.length===0 && totalEvaluated>0`
  - ноль evaluated → `safe=false` (no evaluated markets available)
  - один evaluated с grid OK → `safe=true` temporal, но `minExchanges` остаётся отдельным требованием агрегации (документировано)
- `canAggregateSafely(check)` / `shouldAggregateAssetGroup(check)` — `check.safe` (pure decision helper, тестируем напрямую)

Контракт проверен инспекцией `lib/strategies/runtime.ts: aggregateAssetGroup` — он не проверяет окна. Теперь перед `aggregateAssetGroup` в обоих CLI (`smart-money-readonly.ts` и `smart-money-diagnostic.ts`) стоит guard: если `!canAggregateSafely` — **не вызывать** `aggregateAssetGroup`, вывести `MULTI-EXCHANGE AGGREGATION REFUSED` с `referenceCandleTime`, `offGrid`, `horizonMismatch` (generic для 5m/15m/1h/4h/1d). Per-exchange результаты остаются видимыми.

Покрытие: `1d` BINGX offGrid+horizonMismatch → REFUSED; stale `15m 14:45 vs 15:00`, `5m 15:10 vs 15:15`, `4h 08:00 vs 12:00` — все REFUSED несмотря на grid OK.

## 4. Diagnostic tooling — что добавлено, как проверено

### 4.1 CLI args (`scripts/smart-money-cli-args.ts`)

- Pure parser: `Args.diagnosticCanonicalConfig: boolean` (default `false`), распознаёт `--diagnostic-canonical-config`; без флага поведение идентично `2850a2c`.

### 4.2 `scripts/smart-money-readonly.ts` (read-only)

- `runSymbolMode(..., diagnostic)` и `runMarketMode` — bypass `Strategy.timeframes` только при `diagnostic=true` via `defaultSmcScoringConfig(tf)` (canonical 72/20), filters/minExchanges из Strategy если семантически безопасно иначе DEFAULT с логом, loud баннер, `CLOSED only`, generic alignment guard + `MULTI-EXCHANGE AGGREGATION REFUSED` без вызова `aggregateAssetGroup` при `!safe` (для всех TF).

### 4.3 `scripts/smart-money-diagnostic.ts` — explicit diagnostic-only

- Всегда diagnostic, canonical, read-only, per-exchange + generic guard + REFUSED без агрегации при unsafe, observed BINGX факт (без CST), summary `safe` для 5m/15m/4h/1d, self-test 8+ cases.

## 5. Per-exchange diagnostic output + aggregate

При unsafe (любой TF):

```
=== Выравнивание окон (alignment) 15m ===
  referenceCandleTime: 2026-01-10T15:00:00.000Z
  BINANCE: ... GRID_OK HORIZON_OK
  GATE: 14:45 GRID_OK HORIZON_MISMATCH
  ⚠ HORIZON_MISMATCH 1/5 ...
  ⚠ MISALIGNED — cannot-aggregate ...
=== MULTI-EXCHANGE AGGREGATION REFUSED BTC 15m ... ===
  reason: horizonMismatch ...
  Действие: per-exchange выше валидны, но агрегация НЕ вычисляется
```

При safe:

```
  referenceCandleTime: 2026-01-10T12:00:00.000Z
  ✓ ALIGNED 5/5 safe — можно агрегировать
=== Агрегация BTC ... ===
```

## 6. 5m/15m/4h unlock safety vs 1d remaining

| TF | Observed integrity | Alignment (grid+horizon) | SMC can evaluate | Multi-exchange aggregate | Unlock |
|---|---|---|---|---|---|
| `5m` | 299 each | safe when all 5 share same `candleTime` and grid OK | yes canonical | `safe=true` → can aggregate | READY (generic guard прошёл) |
| `15m` | 300 BYBIT / 299 others | stale 14:45 vs 15:00 → REFUSED (fixed) | yes | safe only if horizon same | READY если horizon same |
| `4h` | 299 each | 08:00 vs 12:00 → REFUSED | yes | safe only if same | READY если same |
| `1d` | 299 each | BINGX 16 UTC vs 00 UTC → offGrid+horizonMismatch → REFUSED | yes per-exchange | BLOCKED | Требуется нормализация BINGX к UTC 00 или исключение из 1d |

Никакой разблокировки Admin в этом PR нет — `SmartMoneyStrategyEditor.tsx` и `app/api/admin/strategies/[id]/route.ts` остаются `["1h"]` locked.

## 7. Гарантии

- `tsc --noEmit` — 0
- `git diff --check` — 0 (no trailing whitespace)
- Нет writes: нет `prisma.strategy.update/create`, `prisma.signal.create/update`
- Нет workers/Signal Engine, нет Prisma изменений, нет SMC math
- Parent `01faac9`, push только Arena
