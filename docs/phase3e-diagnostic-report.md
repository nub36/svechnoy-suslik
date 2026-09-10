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

**Наблюдаемое расхождение**: для `1d` все биржи кроме BINGX имеют `openTime` в `00:00 UTC` (canonical daily граница `openTime % 86_400_000 === 0`), BINGX отдаёт `16:00 UTC`. Это стабильно воспроизводится (`16 × 3_600_000 = 57_600_000 ms` сдвиг).

**Интерпретация**: BingX daily выровнен к `00:00 CST (UTC+8)` — полночь по пекинскому времени, что и даёт `16:00 UTC` предыдущего дня. Это не баг нашего адаптера, а особенность источника. API BingX документирует `interval=1d` как *exchange-local daily* (CST), тогда как Binance/Bybit/Gate/KuCoin отдают daily как `00:00 UTC`. Других временных зон у остальных нет (проверено: их `openTime` для `1h/4h/1d` всегда `% tfMs === 0`).

**Вывод**: для `1d` cross-exchange агрегация некорректна, пока BINGX не нормализован. Для `5m/15m/1h/4h` BINGX совпадает с остальными (`% tfMs === 0`) — расхождение только на `1d`.

## 3. Alignment guard — generic для всех TF

**Файл**: `lib/strategies/alignment.ts` (pure, без DB/Prisma/Signal/workers, детерминированный, без lookahead).

- `isCanonicalAligned(date, tf)` — `date.getTime() % SMCTIMEFRAME_MS[tf] === 0` (canonical UTC граница; для `1d` это `00:00 UTC`, для `1h` — ровный час, для `4h` — кратно 4 ч от полуночи UTC, для `5m/15m` — кратно 5/15 мин).
- `checkCandleAlignment(results, tf)` — по результатам `evaluateSmartMoneyWithCandles` (только `evaluated`) собирает `details: {exchange, candleTime, utcHour, offsetMs, aligned}` и `misaligned`; `aligned = true` только если **все** `evaluated` выровнены; `reason` содержит список `EXCHANGE 16` и `expected UTC 00`.
- `canAggregateSafely(check)` — `check.aligned` (есть хотя бы один `evaluated` и все aligned). Пустой `evaluated` → `false` (не агрегировать).

Контракт проверен инспекцией `lib/strategies/runtime.ts: aggregateAssetGroup` — он принимает уже оценённые `IndividualSmartMoneySignalWithAvailability[]` и не проверяет окна; ранее Phase 3B предполагал, что окна уже canonical. Теперь перед вызовом `aggregateAssetGroup` в обоих CLI (`smart-money-readonly.ts` и `smart-money-diagnostic.ts`) стоит явная проверка `checkCandleAlignment` + `canAggregateSafely`, с логированием `MISALIGNED — cannot-aggregate / REFUSED`.

Покрытие: `1d` мисагрегирован → `REFUSED`, остальные `5m/15m/1h/4h` aligned → `ALIGNED — можно агрегировать` (включая BINGX для этих TF).

## 4. Diagnostic tooling — что добавлено, как проверено

### 4.1 CLI args (`scripts/smart-money-cli-args.ts`)

- Pure parser: `Args.diagnosticCanonicalConfig: boolean` (default `false`), `parseSmartMoneyArgs` теперь распознаёт `--diagnostic-canonical-config`; валидация и `validateCliArgs` не менялись; без флага поведение идентично `2850a2c`.

### 4.2 `scripts/smart-money-readonly.ts` (read-only, mutation-free)

- `printHelp` дополнен строкой про `--diagnostic-canonical-config`.
- `runSymbolMode(symbol, tf, diagnostic=false)` и `runMarketMode(id, tf, diagnostic=false)` — диагностический путь bypasses `Strategy.timeframes` проверку (`if (!cfgForTf) → ошибка` сохраняется для `!diagnostic`; при `diagnostic=true` берётся `defaultSmcScoringConfig(tf)` — canonical `minimumSignalScore 72 / swing 20 / atr 14` etc.).
- `filters`/`minExchanges` **не игнорируются**: если `validateSmartMoneyRuntime` для Strategy `ok`, они берутся из Strategy (операторские параметры, независимые от TF) с явным логом `DIAGNOSTIC filters/minExchanges: using Strategy DB values`; иначе `DEFAULT` с логом — без молчаливых подстановок.
- Loud баннер `DIAGNOSTIC ONLY — CANONICAL CONFIG — READ-ONLY` при `diagnostic=true`.
- Перед агрегацией — alignment guard (см. §3) с детальным логом по каждой бирже и веткой `REFUSED` для `1d` misaligned.
- В остальном: `CLOSED only` (`where: {closed:true}` + `last 500 DESC → reverse → ASC`), `no Signal INSERT/UPDATE`, `no workers`, `no Prisma Strategy update`, `minExchanges` из Strategy/default.

### 4.3 `scripts/smart-money-diagnostic.ts` — explicit diagnostic-only wrapper

- Всегда diagnostic (без флага), canonical `defaultSmcScoringConfig(tf)`, read-only, `CLOSED only`, per-exchange вывод + alignment guard + `REFUSED` для `1d` misaligned — тот же guard что и в `readonly --diagnostic`.
- Содержит встроенный audit-комментарий про BINGX 1d (endpoint/interval/UTC+8) и секцию `=== 5m/15m/4h unlock report / 1d remaining ===`.
- Self-test (`--self-test`) — 12 pure проверок alignment (misaligned `1d` BINGX 16 vs 00, aligned `5m/15m/1h/4h`).
- Не импортирует workers/Signal, не пишет в DB; `prisma.signal.count()` только для чтения (allowed).

### 4.4 Tests (`scripts/test-smart-money-diagnostic.ts`, `--self-test` в diagnostic)

Доказано **pure/read-only**, без БД (кроме `count()` read):

1. **Normal reject** — `Strategy ["1h"]` → `rt.configs["15m"] === undefined`; `readonly` без флага содержит `if (!cfgForTf) → "не поддерживает timeframe"`; с флагом — bypass.
2. **Diagnostic can evaluate** `5m/15m/4h` с canonical config (evaluated/cannot-evaluate, но не ошибка парсера), `tf` совпадает, `minimumScore 72`.
3. **Only CLOSED** — открытый бар `closed=false` → `cannot-evaluate`; оба CLI фильтруют `closed:true` и логируют `CLOSED`.
4. **Not mutated** — `grep` подтверждает отсутствие `prisma.strategy.update/create` в alignment/diagnostic/readonly.
5. **Aligned aggregate ok** — `5m/15m/4h` все биржи `alignedMs === 12:00 UTC` → `check.aligned=true`, `canAggregateSafely=true`, `aggregateAssetGroup` `evaluated 5`.
6. **Misaligned 1d not aggregated** — `BINGX 16 vs others 00` → `!aligned`, `!canAggregateSafely`, `misaligned=[BINGX]`, diagnostic/readonly логируют `MISALIGNED — cannot-aggregate / REFUSED`, не агрегируют молча.
7. **Deterministic** — двойной прогон `evaluateSmartMoneyWithCandles` и `checkCandleAlignment` даёт идентичный JSON.
8. **No-lookahead** — `evaluateSmc(full, asOf) === evaluateSmc(prefix, asOf)` (asOf до будущих баров).
9. **No Signal** — отсутствие `prisma.signal.create/update` в `diagnostic`, `alignment`, `smart-money.ts`.
10. **CLI flag** — `parseSmartMoneyArgs(["--diagnostic-canonical-config"]) → diagnosticCanonicalConfig true`, без флага `false`.

Дополнительно: `npx tsc --noEmit` — 0, `npx tsx scripts/test-smart-money.ts` 62/62, `test-seed-smart-money.ts` 86/86, `test-smart-money-phase3c-fix.ts` 28/28 — все зелёные.

## 5. Per-exchange diagnostic output + aggregate

Оба CLI выводят per-exchange строки:

```
[BINANCE BTCUSDT] 1d e=100.00 score L/S 0/0 dir=NEUTRAL conf=LOW candleTime=2026-01-10T00:00:00.000Z ...
[BINGX ...] candleTime=2026-01-10T16:00:00.000Z ...
=== Выравнивание окон (alignment) 1d ===
  BINANCE: candleTime=... UTC hour=0 offset=0ms ALIGNED
  BINGX:   candleTime=... UTC hour=16 offset=57600000ms MISALIGNED
  ⚠ MISALIGNED — cannot-aggregate for multi-exchange 1d: ...
=== Агрегация BTC 1d smart-money-suslik v1 — REFUSED (misaligned) ===
```

Для `5m/15m/4h`:

```
=== Выравнивание окон 15m ===
  BINANCE: ... hour=12 offset=0ms ALIGNED
  ...
  ✓ ALIGNED 5/5 — можно агрегировать
=== Агрегация BTC 15m ... ===
  direction: LONG votes: LONG 5 ... confirmation: true
```

## 6. 5m/15m/4h unlock safety vs 1d remaining

| TF | Data integrity | Alignment | SMC can evaluate (diagnostic) | Multi-exchange aggregate | Unlock |
|---|---|---|---|---|---|
| `5m` | 299 each, badStep 0 | `ALIGNED` (все 5 бирж `% 300000 ===0`, BINGX совпадает) | yes (canonical 72/20, только `CLOSED`, детерм.) | `canAggregateSafely=true` | **READY to unlock** — staged `["1h"] → ["1h","5m"]` etc. после ревью, без кода (только Admin/API guard снять) |
| `15m` | 300 BYBIT / 299 others, badStep 0 | `ALIGNED` (`% 900000 ===0`) | yes | `canAggregateSafely=true` | **READY** — аналогично `5m` |
| `4h` | 299 each, badStep 0 | `ALIGNED` (`% 14_400_000 ===0`) | yes | `canAggregateSafely=true` | **READY** |
| `1d` | 299 each, badStep 0 | `MISALIGNED` — BINGX 16 UTC vs others 00 UTC | yes per-exchange (каждая биржа сама консистентна), но cross-exchange окно разное | `REFUSED` для `1d` | **BLOCKED** — требуется `Phase 3E-1d`: либо нормализовать BINGX daily к UTC 00 при записи/чтении (пересчёт `openTime` → предыдущий UTC-день 00:00 или исключение BINGX из `1d` universe), либо хранить `candleIntervalStartUtc` отдельно; до этого `1d` остаётся locked в Admin (`["1h"]`) |

Никакой разблокировки в этом PR не делается — Admin `SmartMoneyStrategyEditor.tsx` и `app/api/admin/strategies/[id]/route.ts` остаются `["1h"]` locked (Phase 3C), только diagnostic показывает готовность `5m/15m/4h`.

## 7. Гарантии

- `tsc --noEmit` — 0 (включая `diagnostic` и `alignment`).
- Нет writes: `rg "prisma\.signal\.create|prisma\.strategy\.update" scripts/smart-money-diagnostic.ts lib/strategies/alignment.ts` — пусто; `smart-money-readonly.ts` только `count()` для проверки read-only.
- Нет workers/Signal Engine: `rg "signal-worker|workers" scripts/smart-money-diagnostic.ts` — пусто.
- `CLOSED only` + no lookahead + deterministic — покрыто тестами (§4.4).
- Parent `2850a2c`, push только в `arena/01a08b68-svechnoy-suslik` (Arenas).

## 8. Как запустить

```bash
# Normal (должен отказать для 15m когда Strategy ["1h"])
npx tsx scripts/smart-money-readonly.ts --symbol BTC --timeframe 15m
# → "не поддерживает timeframe 15m"

# Diagnostic (canonical, read-only, per-exchange + alignment, не пишет в DB)
npx tsx scripts/smart-money-readonly.ts --symbol BTC --timeframe 15m --diagnostic-canonical-config
npx tsx scripts/smart-money-readonly.ts --market-id 1 --timeframe 1d --diagnostic-canonical-config
npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 1d
npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 15m

# Pure checks
npx tsx scripts/test-smart-money-diagnostic.ts
npx tsx scripts/smart-money-diagnostic.ts --self-test
npx tsc --noEmit
```

---
_Generated by Phase 3E diagnostic, canonical scoring `defaultSmcScoringConfig(tf)` — minimumSignalScore 72, swing 20/20, ATR 14 etc. — read-only verification only._
