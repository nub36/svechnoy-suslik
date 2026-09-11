# BingX 1d Alignment Root-Cause Audit — READ-ONLY

**Date:** 2026-09-11
**Baseline:** `d5029df40d75fd2d6ba36ac55c4bfac95a8e254c` (Phase 3D-D fix test-only)
**Scope:** Audit only. No DB UPDATE/DELETE/INSERT, no rewriting, no migrations, no Prisma schema change, no workers, no new bulk collection, no Strategy update, no Save/PUT, no Signal writes, no Signal Engine, no SMC math change, no Phase3E guard change, no 1d enable, no global BingX removal.
**Status:** `edf3732` remains NOT ancestor (verified).

---

## 0. Executive Summary (proven, not speculation)

**Proven root cause:** BingX Spot `GET /openApi/spot/v2/market/kline?interval=1d` returns a **real 24h exchange candle whose daily boundary is 00:00 UTC+8 = 16:00 UTC**, not 00:00 UTC. Our ingestion code does **not** introduce the offset — it faithfully stores `openTime = Number(row[0])` as given by the API. Therefore stored BingX `1d` rows are **internally regular 24h candles from 16:00→16:00 UTC**, not canonical UTC days with a timestamp bug.

**Consequence:** Multi-exchange `1d` aggregation with the other four exchanges (canonical 00:00 UTC grid) is unsafe and is correctly **REFUSED** by Phase 3E generic alignment guard (`offGrid + horizonMismatch`). `5m/15m/1h/4h` are unaffected — BingX is observed aligned on those grids and remains globally usable.

**Narrowest technically correct remediation (recommended):**
- **Immediate, zero-risk:** **Option A** — keep BingX globally, exclude/refuse BingX **only for `1d` multi-exchange SMC aggregation** via an explicit per-timeframe eligibility policy. `1d` then aggregates the remaining 4 aligned markets (Binance/Bybit/Gate/KuCoin) with `minExchanges=3` still safe. No data deletion, no timestamp rewriting.
- **Future, if canonical UTC `1d` for BingX is desired:** **Option C** — reconstruct canonical UTC `[00:00,24:00)` daily candles from **complete, CLOSED BingX `1h`** candles (open=first, high=max, low=min, close=last, volume=sum) only after the UTC day is fully closed, with strict no-lookahead and gap handling. **Option B** (request UTC-aligned `1d` directly from BingX) is not available today — no documented timezone/session parameter in the current Spot kline endpoint. **Option D** (remove BingX globally) is contraindicated — BingX is proven reliable on 5m/15m/1h/4h.

---

## 1. Complete BingX Candle Ingestion Path (audited files)

| Step | File / Code | Behavior | Evidence that 16:00 UTC is **not** introduced by us |
|---|---|---|---|
| **1. Exchange adapter — endpoint** | `lib/exchanges/bingx.ts:8-9, 172-176` `API = "https://open-api.bingx.com"`; `GET /openApi/spot/v2/market/kline?symbol=${symbol}&interval=${bingxInterval(tf)}&limit=${min(limit,1000)}` | For `1d`, `bingxInterval("1d") === "1d"` literally, no weekly/monthly, no extra params. | No timezone, session, or `timeZone` query param is sent. Compare Binance/Bybit/Gate/KuCoin adapters — also no timezone param, yet they yield 00:00 UTC. Difference is exchange-side definition, not our request. |
| **2. Timeframe mapping** | `lib/exchanges/bingx.ts:11-19` `bingxInterval` map, `20-29` `timeframeMs` map (`1d: 86400000`) | `duration = timeframeMs(tf)` used only to compute `closeTime = openTime + duration - 1`. | `duration` is pure UTC millisecond constant, not locale-dependent. It does not shift `openTime`. |
| **3. Timestamp parsing** | `lib/exchanges/bingx.ts:210-251` `if (Array.isArray(row)) { openTime = Number(row[0]); } else { openTime = Number(row.time ?? row.openTime ?? row.timestamp); }` | Takes API-provided timestamp verbatim, `new Date(openTime)`. | No `+8h` adjustment, no `toLocaleString`, no `Intl`, no `Date` timezone conversion. If API sent 00:00 UTC, we would store 00:00 UTC. Observed 16:00 UTC therefore **comes from API**. |
| **4. closeTime derivation** | `closeTime = openTime + duration - 1` | `closeTime` is deterministically 1 ms before next open, consistent with `duration`. | For `1d` 16:00 open, close is next day 15:59:59.999 UTC (internally regular 24h). |
| **5. closed flag** | `closed: closeTime < now` | Wall-clock comparison, not session logic. | Does not affect `openTime` grid. Historical candles are `closed=true` regardless of boundary. |
| **6. Worker normalization** | `lib/ohlcv/sync.ts:1-310` `runOhlcvSync`, `upsertCandles`, `isValidCandle` | No resampling, no timezone normalization, no openTime rewriting. `isValidCandle` checks finite OHLC, `high>=low`, etc., but **never** `openTime % tfMs === 0`. `upsertCandles` upserts on `where: { marketId_timeframe_openTime: { marketId, timeframe, openTime } }` with exact `openTime` as given. `runOhlcvSync` filters `incoming = last ? candles.filter(c => c.openTime >= last.openTime) : candles` — no shift. It logs `first → lastOpen` ISO strings verbatim. | Worker is pass-through persistence; it cannot create 16:00 from 00:00 or vice versa. It would faithfully persist whatever the adapter returns. |
| **7. DB persistence** | `prisma/schema.prisma` `model Candle` `@@unique([marketId, timeframe, openTime])` `@@index([marketId, timeframe, openTime])` | `openTime` stored as UTC `DateTime` (PostgreSQL `timestamptz`), `closeTime` nullable, `closed` bool. | Uniqueness includes exact `openTime`. A 16:00 UTC row and a 00:00 UTC row are distinct keys; no deduplication hides the offset. `SELECT` in `runOhlcvSync` and in `lib/strategies/alignment.ts` reads `openTime` exactly as stored. |

**Conclusion of trace:** **All 7 steps are transparent, UTC-agnostic pass-through**. No step contains `+8h`, `+57600000`, `getUTCHours`, `toLocaleString("Asia/Shanghai")`, `timeZone`, or any session logic that could synthesize 16:00 UTC. The 16:00 UTC boundary **originates at the BingX API** on the wire.

---

## 2. Is 16:00 UTC from API or from our code? — Proven

**Proven: API origin.**

- **Code inspection (hypothesis → evidence):** Hypotheses examined: (a) we parse `row.time` vs `row[0]` incorrectly; (b) we treat seconds as milliseconds or vice versa; (c) we add duration offset; (d) we apply local timezone. Evidence: adapter handles **both** array and object forms, but both paths do `Number(row[0])` or `Number(row.time)` and immediately `new Date(openTime)` with **no** arithmetic except `+ duration -1` for `closeTime`. `duration` for `1d` is fixed `86400000`. Therefore `openTime` hour is exactly `new Date(Number(row[0])).getUTCHours()` as returned by BingX.

- **Cross-exchange differential (strong evidence):** Same worker code path (`runOhlcvSync` → `adapter.getCandles` → `upsertCandles`) is used for **all 5 exchanges** with identical `Timeframe` enum, identical `upsert` logic, identical DB schema. Binance/Bybit/Gate/KuCoin consistently produce `openTime.getUTCHours() === 0` for `1d`, while BingX consistently produces `16`. If our code introduced the offset, it would affect all exchanges uniformly or be parameterized — it is not. The variance is **per-exchange, per-API**.

- **Intraday control (evidence of no global skew):** Same BingX adapter, same code path, same `timeframeMs` logic, produces **grid-aligned** candles for `5m/15m/1h/4h` (observed `openTime % tfMs === 0` and `getUTCHours` aligned to UTC hour boundaries). A code-level timezone bug would misalign all timeframes, not exclusively `1d`. The isolation to `1d` points to **exchange-defined daily session**, not a parsing bug.

- **Raw wire evidence (what would prove it definitively on VPS):** `curl "https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=BTC-USDT&interval=1d&limit=5"` and `Date(openTime)` will show `T16:00:00.000Z` open times for recent daily rows, while Binance `GET /api/v3/klines?symbol=BTCUSDT&interval=1d` shows `T00:00:00.000Z` for the same calendar UTC dates. This is the definitive **before-DB** wire capture. In this audit we do **not** fetch bulk data, but the pipeline analysis already proves our code is not the source; wire capture is the recommended live confirmation before a future remediation commit.

**Classification:** **Evidence** (adapter/worker source + differential behavior) → API origin. **Hypothesis** (unproven without wire capture in this sandbox) → exact BingX session is `UTC+8` (Asia/Shanghai). The hypothesis is **strongly supported** by `16:00 UTC = 00:00 CST` arithmetic and by known Asian exchange conventions, but is labeled hypothesis until documented by BingX API contract or live `curl` proof.

---

## 3. BingX API Semantics (evidence vs hypothesis)

### 3.1 What the adapter currently requests

```
GET https://open-api.bingx.com/openApi/spot/v2/market/kline
  ?symbol=BTC-USDT
  &interval=1d
  &limit=5..300
```

- No `startTime`, `endTime`, `timeZone`, `session`, `utc` param.
- `interval` is literal `"1d"` (not `"D"` like Bybit, not `"1day"` like KuCoin).
- Response is array-of-arrays: `[openTime, open, high, low, close, volume]` where `openTime` is **epoch millis** (e.g., `...000` divisible by `86400000` plus `57600000` offset for 16:00).

Checked `lib/exchanges/bingx.ts:172-176` — only three query params. No hidden `headers` with timezone. No `fetch` options with locale.

### 3.2 What BingX documents (evidence from inspection, hypothesis flagged)

- **Evidence from code:** BingX adapter does **not** handle a documented timezone param, and the endpoint as used has **no** optional param that we are omitting that would select UTC. If BingX supported `?timeZone=UTC` or `?session=UTC`, we would expect to see it in other BingX integrations or in the adapter's evolution — we do not.

- **Hypothesis (to be verified against official BingX Spot API docs before any Option B attempt):** BingX Spot kline `1d` is defined as **exchange session day 00:00–24:00 in the exchange's local timezone (UTC+8, Asia/Shanghai/Singapore)**. This is the standard for several Asia-origin spot exchanges and explains `T16:00:00Z` precisely (`00:00+08:00 = 16:00Z`). The other four exchanges explicitly document UTC daily boundaries (Binance docs: “kline open time is UTC”; Bybit `interval=D` docs: UTC; Gate/KuCoin: UTC). BingX docs are expected to either omit timezone (implying exchange local) or explicitly state `UTC+8`. In this audit we **do not** assert the doc wording without fetching `https://bingx-api.github.io/docs/swap/…` or `https://open-api.bingx.com` OpenAPI spec — the exact doc quote must be captured in the future remediation commit's evidence.

- **Distinguishing evidence from hypothesis in table:**

| Claim | Evidence | Hypothesis |
|---|---|---|
| `BingX 1d` as fetched by our adapter opens at 16:00 UTC | `openTime` stored = API `row[0]` verbatim, no transform; observed DB `getUTCHours()=16` stable | — |
| `BingX 1d` would be 00:00 UTC if we requested differently today | — | No param found that would change it; must be proven by trying `?interval=1d&timeZone=0` or similar and seeing if BingX honors it — **not yet tried, do not assume** |
| Boundary = `UTC+8` | Arithmetic `16*3600*1000 = 57600000 = 8*3600*1000` offset from UTC midnight, matches CST | Exchange docs stating “daily kline is 00:00 UTC+8” — must be quoted |
| Intraday 5m/15m/1h/4h are UTC | Observed `openTime % tfMs === 0` and hour-aligned across all 5 exchanges, including BingX | — |

**Recommendation for future commit:** Before attempting Option B, fetch and archive:
- `curl -s "https://open-api.bingx.com/openApi/spot/v2/market/kline?symbol=BTC-USDT&interval=1d&limit=2" | jq .`
- Official BingX API docs page for `GET /openApi/spot/v2/market/kline` (request params table, response example, timezone note)
- If a `timeZone` or `utc` param is discovered, record its exact name, allowed values, and a before/after `curl` proof that `1d` can be made to open at `00:00Z`.

---

## 4. Comparison: Why Binance/Bybit/Gate/KuCoin are canonical 00:00 UTC while BingX is 16:00 UTC

| Exchange | Adapter interval for `1d` | Endpoint & assumed daily definition | Timestamp handling in our adapter | Observed `1d` openTime UTC |
|---|---|---|---|---|
| **BINANCE** | `interval=timeframe` → `"1d"` | `GET /api/v3/klines?interval=1d` — **Binance docs: UTC** (kline open time is UTC midnight) | `row[0]` (openTime ms), `row[6]` (closeTime ms) verbatim, `closed = closeTime < now` | `00:00:00Z` (`openTime % 86400000 === 0`) |
| **BYBIT** | `bybitInterval("1d") === "D"` | `GET /v5/market/kline?interval=D` — **Bybit docs: UTC** (category=spot, `D` = UTC day) | `openTime = Number(row[0])`, `closeTime = openTime+86400000-1` | `00:00:00Z` |
| **GATE** | `"1d"` | `GET /api/v4/spot/candlesticks?interval=1d` — **Gate docs: UTC** | `openTime = Number(row[0])*1000`, `closeTime = openTime+86400000-1` | `00:00:00Z` |
| **KUCOIN** | `"1day"` | `GET /api/v1/market/candles?type=1day` — **KuCoin docs: UTC** (with `startAt/endAt` in seconds) | `openTime = Number(row[0])*1000`, `closeTime = openTime+86400*1000-1` | `00:00:00Z` |
| **BINGX** | `"1d"` | `GET /openApi/spot/v2/market/kline?interval=1d` — **BingX docs: likely UTC+8** (not UTC) | `openTime = Number(row[0])` verbatim, `closeTime = openTime+86400000-1` | **`16:00:00Z`** (`openTime % 86400000 === 57600000`) |

**Key differentiator:** All five adapters **do the same** — they take `openTime` as given and derive `closeTime` locally with `+ duration -1`. None does timezone conversion. The **exchange-side definition** of what `interval=1d` means is what differs. Binance/Bybit/Gate/KuCoin define it as UTC day; BingX defines it as Asia session day. Our code's uniformity proves the divergence is **external**, not internal.

Additional corroboration from dose-response: `5m/15m/1h/4h` are defined as **fixed-duration intervals** anchored to UTC (e.g., `1h` = 3600000 ms from Unix epoch 00:00 UTC) on **all** exchanges, including BingX. Daily is the only interval where an exchange may choose a **session** definition (midnight in local TZ) rather than a pure duration. This explains the isolation to `1d`.

---

## 5. Stored BTC BingX 1d Rows — READ-ONLY Audit (no DB mutation)

This section reports **what can be proven from pipeline + Phase 3E diagnostics without new bulk fetch**, and what must be re-verified on VPS before a future enabling commit.

### 5.1 What is proven from Phase 3E diagnostics (evidence)

- **Source:** `docs/phase3e-diagnostic-report.md` §1-2, `scripts/smart-money-diagnostic.ts` §18, `lib/strategies/alignment.ts` checks, all read-only. They report the **latest CLOSED** `1d` `candleTime` per exchange for BTC, derived from `Candle` where `closed=true`.
- **Observed (BTC, PostgreSQL, 5 exchanges, `closed=true`):**
  - `BINANCE/BYBIT/GATE/KUCOIN` latest CLOSED `1d` `openTime` → `T00:00:00.000Z` (e.g., `2026-09-10T00:00:00Z` in diagnostics)
  - `BINGX` latest CLOSED `1d` `openTime` → `T16:00:00.000Z` (e.g., `2026-09-09T16:00:00Z` covering `2026-09-09 16:00Z → 2026-09-10 15:59:59.999Z`)
  - `offGrid` for BingX 1d: `true` (`openTime % 86400000 === 57600000 !== 0`)
  - `horizonMismatch` for BingX 1d vs reference (00:00): `true` (`16:00 !== 00:00`)
  - `safe === false` → `MULTI-EXCHANGE AGGREGATION REFUSED` (generic guard, not 1d-specific hack), `aggregateAssetGroup` **not called**.
- **Implication:** The latest row alone already proves the grid offset. It is not a single-row glitch.

### 5.2 What is strongly indicated and must be re-verified with READ-ONLY SQL before enabling

Design the future VPS check as **read-only, no writes**, e.g.:

```sql
-- BTC via Asset.symbol='BTC', Market.exchange='BINGX', timeframe='1d'
SELECT
  date_trunc('day', "openTime") as utc_day,
  extract(hour from "openTime" at time zone 'UTC') as utc_hour,
  count(*) as rows,
  min("openTime") as earliest,
  max("openTime") as latest,
  -- continuity: lag check
  bool_and(extract(epoch from ("openTime" - lag("openTime") over (order by "openTime"))) = 86400
           OR lag("openTime") over (order by "openTime") IS NULL) as is_24h_continuous
FROM "Candle"
WHERE "marketId" IN (SELECT id FROM "Market" WHERE exchange='BINGX' AND "quote"='USDT' AND "marketType"='SPOT'
                     AND "assetId"=(SELECT id FROM "Asset" WHERE symbol='BTC'))
  AND timeframe='1d'
GROUP BY utc_hour
ORDER BY utc_hour;

-- Detailed 10-row sample with UTC hour distribution
SELECT "openTime" AT TIME ZONE 'UTC' as open_utc,
       "closeTime" AT TIME ZONE 'UTC' as close_utc,
       closed,
       extract(hour from "openTime" at time zone 'UTC') as hour_utc,
       ("openTime"::bigint % 86400000) as ms_mod
FROM "Candle"
WHERE "marketId" IN (...)
  AND timeframe='1d'
ORDER BY "openTime" DESC
LIMIT 20;

-- Check duplicates/gaps: count distinct openTime vs total
SELECT count(*) as total, count(DISTINCT "openTime") as distinct_open FROM "Candle" WHERE ... AND timeframe='1d';

-- Cross-exchange 1d canonical grid check for BTC
SELECT exchange, "openTime" AT TIME ZONE 'UTC', "closeTime" AT TIME ZONE 'UTC'
FROM "Candle" JOIN "Market" ON "Market".id="Candle"."marketId"
WHERE "Asset".symbol='BTC' AND timeframe='1d' AND closed=true
  AND "openTime" = (SELECT max("openTime") FROM "Candle" WHERE timeframe='1d' AND closed=true AND "marketId"="Market".id)
ORDER BY exchange;
```

**Expected findings (hypothesis to be confirmed, not yet asserted as DB fact in this sandbox):**

| Property | Expected for BingX BTC `1d` | Evidence level today |
|---|---|---|
| Earliest/latest `openTime` | Span of ingestion (e.g., last ~299 days back from latest 16:00) | To be read on VPS; Phase 3E reports `limit 299` fetched per exchange for `1d` with same horizon check |
| UTC hour distribution | **100% `16`** (`hour_utc = 16` for all rows), `ms_mod = 57600000`, `0` rows at `00` | Proven for latest row; full distribution to be confirmed by `GROUP BY hour_utc` |
| 24h continuity | `is_24h_continuous = true` (`openTime_n+1 - openTime_n = 86400000` for all consecutive rows) | Expected given `badStep=0` in diagnostics (310h/ 4h style checks showed `badStep=0` for 1d) |
| closeTime relationship | `closeTime = openTime + 86400000 - 1` (e.g., `2026-09-09T16:00:00Z` → `2026-09-10T15:59:59.999Z`), `closed = closeTime < now` | Proven from adapter code `closeTime = openTime + duration -1` |
| Duplicates/gaps | `total === distinct_open`, no gaps except where exchange had no market (BTC has all 5) | Expected `0` duplicates (upsert key `marketId_timeframe_openTime` prevents dups), gaps only if API returned less than `limit` — not observed |
| Consistency | **All** stored BingX daily candles consistently use `16:00 UTC` — not a mix of `00:00` and `16:00` | Latest proves 16:00; full scan will prove consistency; a mixed grid would have been caught as `offGrid` flapping |

**Why we do not assert full distribution without new DB read in this commit:** The sandbox has **no `DATABASE_URL`** and we are forbidden to launch Top-100/Top-500 workers or bulk fetch. The audit is therefore **code-path + latest-row** proven; the full `GROUP BY hour_utc` scan is the exact read-only check to run on VPS before the next commit.

**What we can assert now (without DB) with high confidence:** The **adapter + worker** pipeline **cannot** produce a mixed hour distribution — it writes exactly what the API returns, and the API's `1d` definition is stable (exchange session). So if the latest is `16:00`, the prior 298 are overwhelmingly likely also `16:00` with 24h spacing. This will be trivially confirmed by the read-only SQL above.

---

## 6. Is Stored BingX 1d OHLC a Different Session Window (A) or a Timestamp Bug (B)?

**This is the critical distinction from the task.**

### 6.1 Definitions

- **A) Real 24h exchange candle 16:00→16:00 UTC** — OHLC aggregated by the exchange from `16:00:00.000Z` inclusive to next day `15:59:59.999Z` inclusive, with `open` = price at 16:00, `close` = price at 15:59:59.999, `high/low/volume` from that actual 24h window. Its `openTime` **correctly** labels the window it represents; it is not a UTC day and must not be relabeled.
- **B) Canonical UTC day `[00:00,24:00)` whose timestamp is merely encoded/parsed incorrectly** — OHLC actually aggregated from `00:00→24:00 UTC` but the timestamp was shifted by `+16h` during parsing (e.g., misinterpreting seconds vs millis, or adding `8h` offset, or reading `closeTime` as `openTime`). In this case, shifting `openTime` back by `-16h` would **correctly** recover the UTC day's OHLC.

### 6.2 Evidence that it is A, not B

| Evidence | Supports A (different window) | Contradicts B (timestamp bug) |
|---|---|---|
| **No shift code in adapter** (§1) | `openTime = Number(row[0])` verbatim — if B were true, OHLC would still be from 16:00 session but timestamp would be correct per exchange definition, not a bug. There is no `-16h` or `+16h` in our code to produce B. | B would require a **-16h** or **+16h** bug in our parsing to turn a true 00:00 UTC candle into a 16:00 label. No such code exists. |
| **Endpoint semantics** (§3) | BingX defines `1d` as Asia session day (00:00 CST). The OHLC it returns **is** the 16:00→16:00 UTC window's OHLC by construction. | If BingX defined `1d` as UTC, it would return `00:00 UTC` like the other four. It does not. |
| **Intraday consistency** (§2) | `5m/15m/1h/4h` are **duration-anchored II` to UTC epoch, not session-anchored. They align across exchanges. Only `1d` is session-anchored, which is exactly the pattern expected for an exchange choosing a local midnight for daily, while keeping intraday on UTC. | A timestamp bug would affect all timeframes that use the same `row[0]` parsing path — but only `1d` is affected. |
| **24h continuity** (§5) | 24h spacing with `57600000` offset is internally consistent for a `16:00` session. | A timestamp bug that simply offset labels would still show 24h spacing (so spacing alone does not distinguish), but the **OHLC values** would be those of the UTC day, not the 16:00 session. The OHLC values for BingX `1d` at 16:00 will differ from Binance `1d` at 00:00 for the same UTC calendar date, even when both are sampled on the same wall-clock day, because they cover different 8h of price action. |
| **OHLC divergence test (future VPS proof for A)** | Compare `SELECT open,high,low,close,volume FROM Candle WHERE exchange='BINGX' AND openTime='2026-09-09T16:00:00Z'` vs `WHERE exchange='BINANCE' AND openTime='2026-09-09T00:00:00Z'` and also vs `BINANCE` `openTime='2026-09-10T00:00:00Z'`. The BingX 16:00 day's OHLC will **not** equal either Binance UTC day's OHLC, but will equal the BTC price action from `2026-09-09 16:00Z → 2026-09-10 15:59Z`. Constructing a UTC day from BingX `1h` candles `[2026-09-09 00:00Z .. 2026-09-09 23:00Z]` will produce a different OHLC than BingX's stored `1d` at `16:00Z` — proving they are different windows. | If it were B, the shifted label would still have OHLC of the UTC day, so `BINGX 16:00` OHLC would equal `BINANCE 00:00 UTC` OHLC for the same calendar date (modulo exchange spread). It does not (expected divergence ~8h of price action). |

**Conclusion: Proven to be A (with B disproven by code absence + pattern isolation; OHLC divergence to be recorded as live VPS proof).**

**Therefore: DO NOT simply shift timestamps to `00:00 UTC`.** Doing `UPDATE Candle SET openTime = openTime - interval '16 hours' WHERE exchange='BINGX' AND timeframe='1d'` would **falsely label** a `16:00→16:00` OHLC window as if it were a `00:00→24:00` UTC day. That corrupts OHLC semantics: `open` would be claimed to be at 00:00 UTC when it was at 16:00 UTC, `high/low` would be from the wrong 24h window, `volume` from the wrong session. This is **data fabrication**.

**If it had been B, timestamp normalization would be safe** — we would have documented the exact parsing error (e.g., `row[0]` is seconds but we treated as millis, or `row[6]` is closeTime but we treated as openTime) and shown that `openTime - 16h` recovers the true UTC window's OHLC, verified by `openTime % 86400000 === 0` after shift and by OHLC equality with reconstructed UTC day from `1h`. No such evidence exists; instead we have evidence for A.

---

## 7. Remediation Options — Without Implementing (comparison)

| Option | Description | Scope | Data mutation | Risk | When to use | Evidence needed |
|---|---|---|---|---|---|---|
| **A. Keep BingX globally, exclude/refuse BingX only for `1d` multi-exchange SMC aggregation** | BingX remains for all symbols/timeframes except `1d` aggregation. Alignment guard or eligibility filter excludes `exchange='BINGX'` when `timeframe='1d'` from `canAggregateSafely`/eligible set. `1d` then aggregates with 4 remaining aligned markets (Binance/Bybit/Gate/KuCoin). Per-exchange `1d` evaluation (long/short/neutral per market) remains visible, only multi-exchange `aggregateAssetGroup` is refused for BingX-inclusive 1d groups. | **Narrowest**: one `if tf==='1d' then eligible = all \ {BINGX}` or `horizonMismatch` already covers it, but explicit policy makes intent clear. No OHLC rewrite. | **None** today: existing BingX `1d` rows stay in DB but are ignored for 1d aggregation (or left untouched). No DELETE/UPDATE. Future: optionally add `WHERE exchange != 'BINGX'` in 1d aggregation queries or `eligibleExchanges` set. | **Zero risk to OHLC integrity**. Reduces `1d` max confirmation from `5/5` to `4/4` (since one exchange excluded). With `minExchanges=3`, `4` remains safe for `LONG/SHORT` confirmation. No lookahead, no volume fabrication. | **Immediate** — this audit recommends A as the **first** remediation commit (see §9 plan). It matches the already-proven Phase 3E safety (REFUSE) but makes the exclusion explicit and testable, rather than relying solely on generic `offGrid` detection. |
| **B. Request canonical UTC-aligned `1d` candles from BingX, if API supports it** | Keep BingX in `1d` aggregation but fetch `1d` as UTC day directly from BingX by passing a timezone/session param (e.g., `?interval=1d&timeZone=UTC` or `?session=UTC` or `X-MBX-TIMEZONE`). The exchange then returns `openTime` at `00:00 UTC` with OHLC for `[00:00,24:00) UTC`. | **Narrow** if param exists: no reconstruction, OHLC is exchange-computed UTC day (authoritative). | **No mutation** of existing rows on read; on next fetch, new UTC `1d` rows would be inserted with `openTime` at `00:00 UTC` (distinct key `marketId+tf+openTime`), so both `16:00` (old) and `00:00` (new) could coexist until old rows age out or are explicitly handled. Requires handling of duplicate calendar dates with two session definitions. | **Low risk if param truly exists and is documented**, but **high risk if assumed**. If BingX does not support it, we would be fabricating a param that is ignored, still getting `16:00` rows and thinking they are UTC — silent failure. Must be proven by **wire capture** that the param actually changes `openTime`. | **Only if** `curl` proof + BingX docs quote show a `timeZone` param that yields `00:00Z` daily. In this audit, **no such param was found** in `lib/exchanges/bingx.ts` and no BingX docs were fetched to prove it. Therefore B is **not actionable today** — it is a research spike for the future commit, not a recommendation. |
| **C. Construct canonical UTC `1d` candles from smaller CLOSED BingX candles (e.g., `1h`)** | Keep BingX in `1d` aggregation but **do not** use its native `1d` endpoint. Instead, for `timeframe='1d'` when `exchange='BINGX'`, compute UTC daily candles from **complete, CLOSED `1h`** candles: `open = first 1h open` at `00:00 UTC`, `high = max(high of 24 1h)`, `low = min(low)`, `close = last 1h close` at `23:00 UTC→15:59:59.999Z`, `volume = sum(volume of 24 1h)`, `openTime = UTC 00:00`, `closeTime = UTC 23:59:59.999`, `closed = true` only after `last 1h closeTime < now` (i.e., UTC day fully closed). No lookahead, only past CLOSED hours. | **Medium** — introduces a **derived** daily candle that is not from the exchange's native `1d` endpoint, but from its `1h` endpoint which is proven UTC-aligned. Requires 24 `1h` rows per UTC day, gap handling, and a distinct code path. | **No mutation of existing `1d` rows** on first implementation; new derived rows would be inserted with `openTime` at `00:00 UTC` (different key), so both native `16:00` and derived `00:00` could coexist. Must decide whether to **keep both** (native `16:00` as `exchangeSession='Asia'` and derived `00:00` as `canonicalUtc`) or **replace** (delete native `16:00` rows after derived proven). Deleting without careful migration would be data loss of a valid session window. | **Medium risk, manageable** if implemented strictly: <br>• Requires that `1h` data is **complete** (24/24 hours, no missing `1h` due to API gaps or `closed=false` filtering). A missing `1h` must cause `cannot-evaluate` for that UTC day, not a partial high/low. <br>• Must handle DST? No, UTC has no DST, but must handle `1h` fetch `limit` and `startAt/endAt` correctly. <br>• Volume sum is correct only if `1h` volumes are in same units (base volume) — they are (`Number(row[5])`). <br>• High/low from `1h` aggregation **does** equal true daily high/low if `1h` high/low are correctly sampled (they are, since `1h` candles are exchange's 1h OHLC). <br>• Must not introduce lookahead: only `CLOSED` `1h` rows (`closeTime < now`) may be used, and the derived daily may only be marked `closed=true` after `23:00 UTC` hour closes. <br>• Tested correctly, this is **mathematically safe** and is the standard way to get a canonical UTC daily when the exchange's native daily is session-based. | **Future enhancement** after Option A is live and `1d` 4-exchange aggregation is proven safe. It restores BingX `1d` to `5/5` coverage but with derived UTC daily. Requires a new `lib/exchanges/bingx.ts` branch or `lib/ohlcv/derive.ts` helper, plus extensive tests (see §11). Not to be done in the same commit as A — keep commits narrow. |
| **D. Remove BingX globally** | Exclude `exchange='BINGX'` from **all** symbols and timeframes (OHLCV worker, markets, alignment, charts, strategy). | **Broadest**, global. | **Destructive** if implemented as `DELETE FROM Market WHERE exchange='BINGX'` or `enabled=false` globally — would drop ~500 markets and ~300 candles per timeframe per market that are currently **proven aligned** on `5m/15m/1h/4h`. | **High collateral damage** for no gain. BingX is **not** known to be bad globally — it is proven aligned on 4/5 timeframes. Removing it globally would reduce `5m/15m/1h/4h` confirmation from `5/5` to `4/4` for no reason, and would require re-proving `5m/15m/1h/4h` still safe with 4. The audit task explicitly says **do not** do this merely because of `1d` issue. | **Only if** evidence shows BingX is generally unreliable (e.g., frequent `badStep`, `badClosedCloseTime`, missing hours on `1h`, or API instability across multiple TFs). Current evidence shows **no** such unreliability: Phase 3E diagnostics report `badStep=0` for `5m/15m/1h/4h` across all 5, and BingX `5m/15m/1h/4h` are `GRID_OK` and `HORIZON_OK`. Therefore **D is contraindicated** now. |

**Summary table — which options truly resettle `1d` to UTC without OHLC fabrication:**

- **A** does **not** resettle — it **excludes** the misaligned session (safest, immediate).
- **B** would resettle **if** BingX supports UTC param (unproven, needs wire proof).
- **C** **does** resettle via deterministic UTC reconstruction from `1h` (proven safe if complete).
- **D** does not resettle — it removes the exchange.

---

## 8. Other Symbols/Timeframes/Exchanges — Analogous Off-Grid Check (READ-ONLY, no new bulk fetch)

**What was checked:** This audit is **code-path + existing BTC diagnostic** based, per “Do NOT launch Top-100/Top-500 workers, do NOT fetch large new datasets, do NOT mutate DB.” We inspected:

- **All 5 exchanges × 5 timeframes** in code: `lib/exchanges/*` interval maps, `timeframeMs` constants, `getCandles` parsing, `isValidCandle`, `runOhlcvSync` upsert, and Phase 3E `lib/strategies/alignment.ts` `isCanonicalAligned` (`% 86400000` for `1d`, etc.).
- **BTC diagnostic as representative:** Phase 3E reports for BTC (`5m 299, 15m 299/300, 1h 306, 4h 299, 1d 299` with `badStep=0`) across all 5 exchanges. `5m/15m/1h/4h` are `GRID_OK` for **all** exchanges including BingX; `1d` `offGrid` is **only** BingX.
- **Other symbols:** No other symbol was bulk-fetched in this task. However, the **pipeline is per-market, not per-symbol**: `marketId_timeframe_openTime` upsert, `timeframeMs` constants, and `interval` strings are **identical** for every symbol on a given exchange. There is no symbol-dependent branch in `bingx.ts` that could make `BTC-USDT` daily `16:00` but `ETH-USDT` daily `00:00`. Therefore the `1d` session definition is **exchange-level, not symbol-level**. If `BTC` is `16:00`, `ETH/USDT` on BingX `1d` will also be `16:00`. This is a **sound extrapolation**, not a DB proof — it will be spot-checked on VPS with a second symbol read-only query:

```sql
SELECT symbol, extract(hour from "openTime" at time zone 'UTC') as hour_utc, count(*)
FROM "Candle" JOIN "Market" ON "Market".id="Candle"."marketId" JOIN "Asset" ON "Asset".id="Market"."assetId"
WHERE timeframe='1d' AND exchange='BINGX' AND closed=true
GROUP BY symbol, hour_utc ORDER BY symbol;
-- Expected: every symbol hour_utc=16 for 1d, no symbol at 00
```

- **Other timeframes on BingX:** `5m/15m/1h/4h` are **not** off-grid for any exchange in the BTC sample. The code path for `5m` is `openTime = Number(row[0])` with no session param, same as `1d`. The difference is that `5m` etc. are **duration-anchored** (multiples of `300000` etc. from Unix epoch) and thus align to UTC by construction on all exchanges, while `1d` is **session-anchored** (midnight in exchange TZ). So no analogous off-grid is expected for intraday TFs, and none was observed.

**Conclusion:** **No evidence of analogous off-grid beyond BingX `1d`.** The only required spot-check before a future enabling commit is the `GROUP BY symbol, hour_utc` above for one or two other Top-10 symbols (e.g., `ETH`, `SOL`) to confirm the exchange-level rule. **Do not** launch a Top-500 scan for this — a 2-symbol read-only check is sufficient.

---

## 9. Consequences of Excluding BingX Only on `1d` (Option A safety)

**With exclusion, `1d` would aggregate 4 exchanges:**

- Eligible `1d` set = `{BINANCE, BYBIT, GATE, KUCOIN}` (canonical `00:00 UTC`)
- BingX `1d` remains in DB but is **not** passed to `checkCandleAlignment` / `aggregateAssetGroup` for `timeframe='1d'`. Per-exchange BingX `1d` evaluation (long/short/neutral per market) can still be displayed, but not counted toward `4/5` confirmation.
- `minExchanges` = `3` (Smart Money) → `4` eligible is **sufficient** for `LONG 3/4` or `4/4` confirmation. The generic guard `checkCandleAlignment` with 4/4 aligned and `safe=true` will allow `aggregateAssetGroup`. The `minExchanges` semantics do not change; only the denominator changes from `5` to `4` for `1d`. This is **safe** because `minExchanges` is a **minimum**, not an exact `5`.
- **What remains safe:**
  - `5m/15m/1h/4h` still aggregate `5/5` (BingX included)
  - `1d` aggregates `4/4` (BingX excluded) — still meets `3`
  - No lookahead, no CLOSED violation, no Signal change
- **What must be explicit in code (future commit):** A per-timeframe eligibility policy, e.g.:

```ts
// lib/strategies/eligibility.ts (future)
export const TIMEFRAME_ELIGIBLE_EXCHANGES: Record<Timeframe, ExchangeName[]> = {
  "5m": ["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "15m":["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "1h": ["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "4h": ["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "1d": ["BINANCE","BYBIT","GATE","KUCOIN"], // BINGX excluded until UTC reconstruction lands
};
```

Or, minimally, in the diagnostic/aggregation path:

```ts
const eligible = results.filter(r => !(timeframe==="1d" && r.exchange==="BINGX"));
const check = checkCandleAlignment(eligible, timeframe);
if (!canAggregateSafely(check)) return REFUSE;
```

The generic guard already refuses `5/5` with BingX `1d` mixed in (since `offGrid` triggers `safe=false`). The explicit eligibility makes the **intent** clear and prevents a future “all 5 must be present” misreading, and it allows `4/4` to be `safe=true` intentionally.

**Do NOT enable `1d` yet** — the audit task says “do NOT enable `1d` yet.” Enabling `1d` requires the eligibility change to be live **and** to be proven with 4-exchange `1d` BTC diagnostics (see §11).

---

## 10. Proven Root Cause (concise, evidence-labeled)

**Proven:** BingX Spot `1d` kline's `openTime` as returned by `GET /openApi/spot/v2/market/kline?interval=1d` is **16:00 UTC** (not `00:00 UTC`), while Binance/Bybit/Gate/KuCoin same endpoint with `1d` equivalent returns `00:00 UTC`. Our code stores it verbatim (`Number(row[0])` → `new Date(openTime)`), so the offset is **not** introduced by our code. The `16:00 UTC` boundary is byte-for-byte the exchange's definition of a daily candle.

**Evidence:**
- `lib/exchanges/bingx.ts:172-251` — no timezone conversion, `openTime` verbatim.
- `lib/ohlcv/sync.ts` — pass-through upsert on exact `openTime`.
- Observed DB latest CLOSED `1d` `openTime` per Phase 3E: `BINGX T16:00:00Z` vs 4× `T00:00:00Z` (`T16:00Z % 86400000 = 57600000`).
- Intraday control: same BingX code path yields `GRID_OK` for `5m/15m/1h/4h`, so not a global parse bug.

**Strong hypothesis (labeled, not asserted as doc fact without wire capture):** The `16:00 UTC` boundary corresponds to **00:00 CST (UTC+8)**, i.e., BingX's daily session is midnight in `Asia/Shanghai` timezone. This matches `16:00 UTC = 00:00+08:00` and is the common pattern for Asia-origin exchanges. The exact BingX docs phrase must be captured via `curl` + docs fetch before a future Option B claim.

**Answer to §6:** **A) Real 24h exchange candle 16:00→16:00 UTC** with correct OHLC for that window, **not** B) a UTC day mislabeled. Shifting timestamps to `00:00` would **falsely label** a different OHLC window as a UTC day.

---

## 11. Recommended Remediation (safest)

**Primary recommendation: Option A now.**

- Keep BingX globally for `5m/15m/1h/4h` and for `1d` per-exchange display if desired.
- Exclude BingX **only for `1d` multi-exchange aggregation** via explicit per-timeframe eligibility.
- `1d` then aggregates **4 aligned markets** (Binance/Bybit/Gate/KuCoin) with `minExchanges=3` → `3/4` or `4/4` confirmation is safe.
- No data rewrite, no deletion, no timestamp shift, no new derived candles in this step.

**Secondary, future, if UTC `1d` with 5/5 coverage is desired: Option C (reconstruct UTC daily from `1h`).** Only after Option A is live and proven.

- Research spike for Option B (try `?timeZone=UTC` param) should be done **before** committing to C, to see if BingX can natively do UTC daily. If B is proven viable with wire capture, it may be simpler than C. If not, proceed to C.
- Option D (global removal) is **not recommended** — BingX is proven good on 4/5 TFs.

---

## 12. Exact Implementation Plan for a Future Separate Commit (not this audit)

This plan is **documentation only** — do not implement in this commit. The next commit should be narrow, test-driven, and VPS-verified.

### 12.1 Commit 1 — Option A (per-timeframe eligibility)

**Files to touch (narrow):**
- (new) `lib/strategies/eligibility.ts` or `lib/ohlcv/eligibility.ts` — pure, no DB, no Signal, exports `getEligibleExchanges(timeframe: Timeframe): ExchangeName[]` or `isExchangeEligible(exchange, timeframe): boolean`. Pure function, deterministic, no `Date.now()`.
- `lib/strategies/alignment.ts` — no change to `isCanonicalAligned`/`checkCandleAlignment` (they remain generic), but call sites filter by eligibility before `checkCandleAlignment`.
- `scripts/smart-money-diagnostic.ts` + `scripts/smart-money-readonly.ts` — filter `results` by `isExchangeEligible(ex, tf)` before `checkCandleAlignment`. Keep generic `offGrid/horizonMismatch` guard as defense-in-depth; it will now see 4/4 for `1d` (BingX already excluded) and `safe` can become `true` for `1d` when 4 are aligned.
- `app/api/admin/strategies/[id]/route.ts` — add explicit note that `1d` aggregation uses 4 exchanges (no code change needed beyond eligibility, since API already has `allowedVerified` and `1d` disabled for now; eligibility will matter when `1d` is eventually enabled).
- `lib/exchanges/types.ts` — ensure `ExchangeName`/`Timeframe` enums cover the eligibility map.
- Tests: (new) `scripts/test-eligibility.ts` + update `scripts/test-smart-money-diagnostic.ts` to cover `1d` 4/4 safe vs 5/5 with BingX refused.

**Code sketch (illustrative, not to be committed yet):**

```ts
// lib/strategies/eligibility.ts
import type { ExchangeName, Timeframe } from "../exchanges/types";
export const ELIGIBLE_EXCHANGES_BY_TF: Record<Timeframe, readonly ExchangeName[]> = {
  "5m":  ["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "15m": ["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "1h":  ["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "4h":  ["BINANCE","BYBIT","GATE","KUCOIN","BINGX"],
  "1d":  ["BINANCE","BYBIT","GATE","KUCOIN"], // BINGX excluded until UTC reconstruction
} as const;
export function isEligible(ex: ExchangeName, tf: Timeframe): boolean {
  return (ELIGIBLE_EXCHANGES_BY_TF[tf] as readonly string[]).includes(ex);
}
```

**Call-site change (illustrative):**

```ts
const eligibleResults = results.filter(r => isEligible(r.exchange as ExchangeName, timeframe as Timeframe));
const check = checkCandleAlignment(eligibleResults, timeframe);
if (!canAggregateSafely(check)) {
  console.log("MULTI-EXCHANGE AGGREGATION REFUSED");
  return;
}
const agg = aggregateAssetGroup(eligibleResults, timeframe, ...);
```

**Alternative minimal without new file (also acceptable for a narrow commit):**

```ts
const isBingX1dExcluded = (ex: string, tf: string) => !(tf==="1d" && ex==="BINGX");
const eligible = results.filter(r => isBingX1dExcluded(r.exchange, timeframe));
```

**Tests for the commit:**
- `getEligibleExchanges("1d")` does not contain `"BINGX"`, others do.
- `isEligible("BINGX","1d")===false`, `isEligible("BINGX","1h")===true`.
- `checkCandleAlignment` for `1d` with 4× `T00:00Z` → `safe=true`; with 5× including `T16:00Z` → `safe=false` (existing, but now pre-filtered).
- Diagnostic script for BTC `1d` with `isEligible` filter → `referenceCandleTime=T00:00Z`, `alignedCount=4`, `safe=true` (when 4 are CLOSED and horizon same).
- `test-smart-money-phase3c-fix.ts` continues to assert `1d` disabled for now — no change until separate `1d` enable commit.

### 12.2 Commit 2 — (optional) Option B spike (research only, no prod change)

- `curl` proof: `BTC-USDT` `1d` with and without candidate `timeZone` param, capture `openTime` hour.
- Docs capture: BingX API docs page quote for `interval=1d` timezone definition.
- If param works, document it in this audit's next revision and propose a `bingx.ts` change to add `&timeZone=0` (or similar) for `1d` only, with fallback to Option A if not.

### 12.3 Commit 3 — (optional) Option C — UTC daily reconstruction from `1h` (if B not viable)

**New helper (pure, no DB, deterministic):**
- (new) `lib/ohlcv/derive-daily.ts` — `deriveUtcDailyCandles(bingxHourlyCands: CandleData[], utcDay: Date): CandleData | null` — strict: requires **exactly 24** CLOSED `1h` rows covering `[00:00,24:00)` UTC, in order, no gaps, all `closed=true`, `openTime` hour-aligned, `volume` sum, `high=max`, `low=min`, etc. Returns `null` → `cannot-evaluate` if incomplete.

**Pipeline:**
- In `lib/exchanges/bingx.ts` or `lib/ohlcv/sync.ts`, branch: `if (timeframe==="1d" && market.exchange==="BINGX") { fetch 1h ×24, derive }` — but **only after UTC day CLOSED** (i.e., `now >= utcDay+86400000`). This is a **derived** candle, not a native `1d` fetch. The derived `openTime` is `Date(UTC 00:00)`, distinct from native `16:00` key, so it inserts as a new row (or replaces native if policy is to derive exclusively). Recommend **keeping derived as canonical for `1d` eligibility** and either (a) keep native `16:00` rows but ignore them for UTC aggregation (they remain valid Asia session candles), or (b) stop fetching native `1d` for BingX entirely and only derive.

**Tests for C:**
- `deriveUtcDaily` with 24× `1h` CLOSED → correct UTC `1d` OHLCV.
- With 23× `1h` → `null` (cannot-evaluate).
- With one `1h` `closed=false` (current hour) → `null`.
- With `1h` high/low extremes correctly propagated to daily high/low.
- No lookahead: `now` just before `24:00` → `null`; just after `24:00` with 24 CLOSED → derived.
- Integration: BTC `1d` BingX UTC derived vs Binance UTC `1d` → `openTime` both `00:00Z`, `safe=true` for 5/5 when derived.

### 12.4 What NOT to do in these commits

- Do not `UPDATE Candle SET openTime = openTime - 16h` (fabrication).
- Do not `DELETE FROM Candle WHERE exchange='BINGX' AND timeframe='1d'` globally without archiving.
- Do not change `lib/smc/*` math, `lib/strategies/alignment.ts` canonical grid logic (it already correctly detects `16:00` as off-grid), or enable `1d` until §11 tests are green on VPS.

---

## 13. Migration / Data Implications, If Any

**For Option A (recommended immediate):**

- **No migration.** Existing BingX `1d` rows at `16:00 UTC` remain in `Candle` table exactly as is. They are **not** deleted, not updated, not rewritten. Their `marketId_timeframe_openTime` key is distinct from `00:00` rows, so they do not collide with future `00:00` rows (if any).
- **Application-level implication only:** `1d` aggregation queries must filter `exchange != 'BINGX'` (or `isEligible`). This is a **read-path** filter, not a data migration. The rows remain queryable for per-exchange display or for Asia-session analysis if ever needed, but are simply not counted toward `minExchanges` for `1d`.
- **Chart / other consumers:** `/api/chart/candles` for BingX `1d` will still return `16:00` candles if requested for BingX `1d` — that is correct per exchange session. No chart change is required for Option A, because `1d` remains `BLOCKED` for multi-exchange, and per-exchange chart remains truthful.
- **Retention:** No need to backfill or delete. Future Option C derived UTC rows will be **new** rows at `00:00` (different `openTime`), coexisting with old `16:00` rows until a deliberate retention policy is chosen (e.g., keep both, or archive `16:00` after derived proven). That retention choice is **out of scope** for Option A.

**For Option B (if UTC param proven):**

- **No timestamp shift migration.** New fetches would insert new rows at `00:00` (different key). Old `16:00` rows would remain until explicitly archived. A migration to delete old `16:00` rows could be done **only after** new `00:00` rows have been backfilled and proven to have `24h` continuity. The migration would be `DELETE FROM Candle WHERE exchange='BINGX' AND timeframe='1d' AND extract(hour from openTime at time zone 'UTC')=16` — but this is **not** part of the audit commit and must be a separate, reviewed, `WHERE`-scoped delete with a `SELECT COUNT(*)` preview.

**For Option C (derived UTC daily):**

- **No in-place rewrite.** Derived UTC `00:00` rows are **new** inserts, not updates of `16:00` rows. They have different `openTime`, so they do not overwrite. The derived `1d` for BingX would from then on be sourced from `1h`, not from the native `1d` endpoint. Existing native `16:00` rows could be kept as `exchangeSession='Asia'` for audit, or deleted after a `GROUP BY` verification that derived `00:00` rows have `count == distinct == expected` and `is_24h_continuous`.
- **Data volume:** `1d` is 1 row per day per market; derived does not increase `1h` volume (it reads existing `1h` rows). No new `1h` fetch is needed beyond existing `1h` ingestion (which is already proven for BingX).
- **Volume semantics:** Derived `volume = sum(1h volume)` is correct for base volume; quote volume (if any) similarly sum. No `quoteVolume` field in `Candle` model, so only `volume` (base) is stored — sum is correct.

**General safety rule for any future migration that deletes/updates candles:**

- **No `prisma db push --force-reset`, no `TRUNCATE`, no `DELETE` without `WHERE exchange='BINGX' AND timeframe='1d' AND hour=16`.**
- **Preview with `SELECT` first, log `COUNT(*)` before/after.**
- **No Signal writes during migration.**
- **Strategy `id=2` remains `DRAFT disabled timeframes=["1h"]` — no Strategy update.**

---

## 14. Tests Required Before Enabling `1d` (must be green on VPS)

**Do not enable `1d` (Admin/API/Strategy) until all of these are green on real PostgreSQL (VPS), read-only where noted, plus the existing Phase 3E/3D tests.**

### 14.1 Already required (existing, must stay green)

- `npx tsx scripts/test-smc-phase3d-c.ts` → **91/91** (Strategy JSON boundary, 14 advanced params, 1d runtime still `ok` but Admin/API blocked)
- `npx tsx scripts/test-smc-phase3d-config.ts` → **70/70**
- `npx tsx scripts/test-smc-phase3d-b.ts` → **55/55**
- `npx tsx scripts/test-smc-phase3d-d.ts` → **126/126** (no Math.round)
- `npx tsx scripts/test-smart-money-phase3c-fix.ts` → **40/40** (with scope-aware resetAll check, 5m/15m/1h/4h verified, 1d disabled)
- `npx tsx scripts/test-admin-consistency.ts` → **84/84**
- `npx tsc --noEmit` → **0**
- `git diff --check` → **0**
- `git merge-base --is-ancestor edf3732 HEAD` → **1** (NOT ancestor)

### 14.2 New tests for Option A (per-timeframe eligibility) — must be added before enabling `1d`

- (new) `scripts/test-eligibility.ts` or extended `test-smart-money-diagnostic.ts`:
  - `getEligibleExchanges("1d")` does not contain `"BINGX"`, but `"5m"/"15m"/"1h"/"4h"` do.
  - `isEligible("BINGX","1d")===false`, `isEligible("BINGX","1h")===true`, `isEligible("BINANCE","1d")===true`.
  - `checkCandleAlignment` for BTC `1d` with 4× `T00:00Z` (filtered eligible) → `safe=true`, `referenceCandleTime=T00:00Z`, `alignedCount=4`.
  - `checkCandleAlignment` for BTC `1d` with 5× including `T16:00Z` (unfiltered) → `safe=false`, `offGrid` contains `BINGX`, `horizonMismatch` contains `BINGX`.
  - `canAggregateSafely` for eligible 4 → `true`.
  - Diagnostic script for BTC `1d` after filtering → `4/4 ALIGNED safe` and `aggregateAssetGroup` is called with 4, produces `LONG/SHORT/NEUTRAL` with `confirmation 3/4` or `4/4` (depending on market evaluations), not `REFUSED`.

### 14.3 New tests for Option C (if UTC reconstruction is pursued)

- (new) `scripts/test-derive-daily.ts` — pure, no DB:
  - 24× `CLOSED` `1h` BTC BingX `T00:00Z .. T23:00Z` → derived `1d` `openTime=T00:00Z`, `open=first.open`, `close=last.close`, `high=max`, `low=min`, `volume=sum`, `closed=true`.
  - 23× `1h` → `null` (incomplete → cannot-evaluate).
  - One `1h` `closed=false` (e.g., current hour not yet closed) → `null`.
  - `high`/`low` extremes correctly propagated (e.g., `1h` with spike).
  - No lookahead: `now = 2026-09-10T23:59:00Z` (before `23:00` close) → `null`; `now = 2026-09-11T00:00:01Z` with 24 `CLOSED` → derived.
  - Volume sum correctness: `sum(1h.volume) === derived.volume`.
  - Deterministic: same 24 `1h` → same derived `1d` on every run.

### 14.4 VPS read-only verifications before enabling `1d` (no writes)

- `SELECT` hour distribution (§5.2 SQL) for BTC `1d` BingX → `100% hour=16` today; for other 4 → `100% hour=0`.
- Same for `ETH` (second symbol) to prove exchange-level rule.
- `SELECT` continuity for BingX `1d`: `lag(openTime)` = `86400000` for all consecutive rows.
- `SELECT` duplicates: `count(*) == count(DISTINCT openTime)` for BingX `1d`.
- After Option A code is live but before enabling `1d` in Strategy: run `npx tsx scripts/smart-money-diagnostic.ts --timeframe=1d` (or `smart-money-readonly.ts --diagnostic-canonical-config --timeframe=1d`) on VPS → expect `4/4 ALIGNED safe` (eligible filtered) and `aggregateAssetGroup` **called** for `1d` (previously `REFUSED` with 5/4+1). Record the output.
- After Option C (if pursued): run same diagnostic for BingX `1d` **derived** vs native `1d` comparison: derived `1d` `T00:00Z` vs Binance `1d` `T00:00Z` → `safe=true` for `5/5` (derived now aligns). Also verify derived `1d` OHLC **differs** from native `16:00` OHLC for same calendar date (proving they are different windows, per §6).

### 14.5 What must **not** be done before enabling `1d`

- Do not `UPDATE` BingX `1d` `openTime` by `-16h` (fabrication, §6).
- Do not `DELETE` BingX `1d` `16:00` rows without a `SELECT COUNT(*)` preview and without a decision on retention (keep both vs archive).
- Do not set `Strategy id=2 timeframes` to include `"1d"` in DB (no `prisma.strategy.update`), and do not change `app/api/admin/strategies/[id]/route.ts` to allow `"1d"` until the above tests are green.

---

## 15. Evidence Summary (concise, for PROJECT_CONTEXT.md)

| Question | Answer | Evidence | Hypothesis vs Proven |
|---|---|---|---|
| Why 16:00 UTC? | BingX defines `1d` as **Asia session day 00:00 CST (UTC+8) = 16:00 UTC** | `lib/exchanges/bingx.ts` stores `row[0]` verbatim, no shift; other exchanges same code path yield `00:00 UTC`; `16*3600000=57600000=8h` offset | Proven: API origin, not our code. Hypothesis: exact doc phrase “UTC+8” to be quoted from BingX docs + `curl` wire capture (next commit) |
| Which steps could have introduced it? | None — 7-step ingestion is pass-through (adapter → worker → upsert → DB). Intraday `5m/15m/1h/4h` control shows no global skew, isolating `1d` session definition. | `bingx.ts` lines 172-251, `sync.ts` `upsertCandles`, `@@unique([marketId,timeframe,openTime])` | Proven: no `+8h` in code |
| Is stored OHLC a different window (A) or timestamp bug (B)? | **A — real 16:00→16:00 UTC window** (00:00→00:00 CST). OHLC is for that window, not a UTC day. | No shift code; `1d` isolated; `24h` continuity; OHLC divergence test will show `BINGX 16:00` ≠ `BINANCE 00:00` for same UTC date | Proven A, B disproven by code absence; live OHLC divergence to be recorded as VPS proof |
| Why others are 00:00 UTC? | Binance/Bybit/Gate/KuCoin document **UTC** daily (`interval=1d/D/1day` = UTC midnight). | Adapter interval maps + observed `00:00Z` DB rows | Proven: cross-exchange differential |
| Stored rows audit? | Latest `1d` BingX BTC `T16:00:00Z` vs others `T00:00:00Z`; `offGrid+horizonMismatch` → `safe=false`. Full distribution to be read-only verified on VPS (`GROUP BY hour_utc` → `16` for BingX, `0` for others, `24h` continuity, no dups). | Phase 3E diagnostics + `badStep=0` | Latest proven, full scan to be done read-only on VPS (no bulk fetch) |
| Which remediation is safest? | **Option A now** (exclude BingX only on `1d`, keep globally), **Option C later** (UTC daily from `1h`) if 5/5 desired, **Option B** only if `timeZone` param proven, **Option D contraindicated** | Comparison table §7, `minExchanges=3` with 4 eligible remains safe (`3/4` or `4/4`) | Proven: A zero-risk, C mathematically safe if complete, B unproven, D collateral damage |
| Other TFs/symbols off-grid? | No analogous off-grid beyond BingX `1d`; `5m/15m/1h/4h` are `GRID_OK` for all 5 exchanges. Symbol-level check for `ETH` will confirm exchange-level rule. | `5m/15m/1h/4h` `openTime % tfMs === 0` for BingX in BTC diagnostics; code is per-exchange not per-symbol | Proven for BTC; `ETH` spot-check to be done read-only |
| Consequences of 4-exchange `1d`? | `4` aligned markets suffice for `minExchanges=3` (`3/4` or `4/4` confirmation safe). | `aggregateAssetGroup` semantics (`3` minimum, not exact `5`) | Proven: safe |
| What is **not** to be done now? | No DB UPDATE/DELETE, no timestamp shift, no global BingX removal, no `1d` enable, no workers, no Signal, no SMC math change. | Task safety + `edf3732` NOT ancestor | Proven: audit-only commit |

---

## 16. Deliverable of This Audit Commit (what this file and PROJECT_CONTEXT.md update achieve)

- **This file** (`docs/bingx-1d-alignment-audit.md`) is the **full audit document** covering the 9 questions, distinguished evidence/hypothesis, and the comparison/plan.
- **PROJECT_CONTEXT.md** receives a **concise summary section** (next §) that points to this file, states the proven root cause (A, not B), recommends Option A now + Option C as future, and lists the exact next steps and tests before enabling `1d`.
- **No production files changed:** No `components/admin`, `app/api`, `lib/smc`, `lib/strategies`, `lib/exchanges`, `lib/ohlcv`, `prisma`, `Signal`, `alignment`, `chart`.
- **Verification for this commit:** `git diff --check` clean, `npx tsc --noEmit` if any TS touched (ideally no TS changes — this audit is `.md` only, so `tsc` is a no-op but still `0`), `git merge-base --is-ancestor edf3732 HEAD` → exit `1` (NOT ancestor), **NO DB mutation**, **NO workers**, **NO Signal**, **NO runtime/math changes**.

---

## 17. References

- `lib/exchanges/bingx.ts` (adapter, `openApi/spot/v2/market/kline`, `interval=1d`, `row[0]` verbatim)
- `lib/exchanges/binance.ts`, `bybit.ts`, `gate.ts`, `kucoin.ts` (comparison, UTC daily)
- `lib/ohlcv/sync.ts` (worker, `upsertCandles`, `isValidCandle`, `marketId_timeframe_openTime`)
- `lib/strategies/alignment.ts` (`isCanonicalAligned`, `checkCandleAlignment`, `canAggregateSafely`)
- `docs/phase3e-diagnostic-report.md` (Phase 3E `1d` 16:00 vs 00:00 observation, `offGrid+horizonMismatch`)
- `scripts/smart-money-diagnostic.ts` (`1d` `BINGX 16:00` vs others `00:00` cases)
- `scripts/test-smart-money-diagnostic.ts` (`CASE 5` 1d offGrid)
- `app/api/admin/strategies/[id]/route.ts` (Phase 3E `1d` guard message `16:00 UTC vs 00:00 UTC`)
- `PROJECT_CONTEXT.md` §32-38 (Phase 3E/3D context, `minExchanges=3`, `edf3732` NOT ancestor)

---

*End of audit — next commit is implementation (Option A) after review, not in this audit.*
