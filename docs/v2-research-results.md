# V2 Research Results — 2026-09-14T06:19:54.046Z

Source: SYNTHETIC forced 5856 candles
Date range: 2026-08-01T00:00:00.000Z -> 2026-10-01T00:00:00.000Z
Splits: TRAIN 2026-08-01T00:00:00.000Z->2026-09-06T14:24:00.000Z (60%), VALIDATION 2026-09-06T14:24:00.000Z->2026-09-18T19:12:00.000Z (20%), OOS 2026-09-18T19:12:00.000Z->2026-10-01T00:00:00.000Z (20%) OOS-blind

## V1 Baseline (frozen)
- Total signals: 8 perDay 0.131
- LONG 3 (0.375) SHORT 5 (0.625)
- EDGE episodes 8
- TP1-before-SL 8 (1) TP2 8 (1) TP3 8 (1) STOP-before-TP1 0 (0)
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 6 perDay 0.492 LONG 1 SHORT 5 TP1 6 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)

## V2 Candidates

### V2-OFF (no trend) — OFF SCORE_BOOST — freqVsV1 100.0%
- Aggregate: signals 8 perDay 0.131 LONG 3 SHORT 5 TP1 8 (1) TP2 8 (1) TP3 8 (1) STOP 0 (0)
- LONG: count 3 TP1 3 TP2 3 TP3 3 STOP 0
- SHORT: count 5 TP1 5 TP2 5 TP3 5 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 6 perDay 0.492 LONG 1 SHORT 5 TP1 6 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 55 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 55 met 4/7

### V2-A SMC+MARKET_STRUCTURE SCORE_BOOST — MARKET_STRUCTURE SCORE_BOOST — freqVsV1 100.0%
- Aggregate: signals 8 perDay 0.131 LONG 3 SHORT 5 TP1 8 (1) TP2 8 (1) TP3 8 (1) STOP 0 (0)
- LONG: count 3 TP1 3 TP2 3 TP3 3 STOP 0
- SHORT: count 5 TP1 5 TP2 5 TP3 5 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 6 perDay 0.492 LONG 1 SHORT 5 TP1 6 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 70 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 70 met 4/7

### V2-B SMC+EMA SCORE_BOOST — EMA SCORE_BOOST — freqVsV1 87.5%
- Aggregate: signals 7 perDay 0.115 LONG 3 SHORT 4 TP1 7 (1) TP2 6 (0.857) TP3 4 (0.571) STOP 0 (0)
- LONG: count 3 TP1 3 TP2 2 TP3 1 STOP 0
- SHORT: count 4 TP1 4 TP2 4 TP3 3 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 5 perDay 0.41 LONG 1 SHORT 4 TP1 5 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT at 2026-09-13T08:00:00.000Z score 70
  Detail: Found 1 signals near 08:15, first SHORT at 2026-09-13T08:00:00.000Z score 70

### V2-C SMC+HTF 1h SCORE_BOOST — HTF SCORE_BOOST — freqVsV1 75.0%
- Aggregate: signals 6 perDay 0.098 LONG 2 SHORT 4 TP1 6 (1) TP2 6 (1) TP3 6 (1) STOP 0 (0)
- LONG: count 2 TP1 2 TP2 2 TP3 2 STOP 0
- SHORT: count 4 TP1 4 TP2 4 TP3 4 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 4 perDay 0.328 LONG 0 SHORT 4 TP1 4 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 70 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 70 met 4/7

### V2-D SMC+COMBINED SCORE_BOOST — COMBINED SCORE_BOOST — freqVsV1 75.0%
- Aggregate: signals 6 perDay 0.098 LONG 2 SHORT 4 TP1 6 (1) TP2 6 (1) TP3 6 (1) STOP 0 (0)
- LONG: count 2 TP1 2 TP2 2 TP3 2 STOP 0
- SHORT: count 4 TP1 4 TP2 4 TP3 4 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 4 perDay 0.328 LONG 0 SHORT 4 TP1 4 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 70 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 70 met 4/7

### V2-D SMC+COMBINED TIERING — COMBINED TIERING — freqVsV1 100.0%
- Aggregate: signals 8 perDay 0.131 LONG 3 SHORT 5 TP1 8 (1) TP2 8 (1) TP3 8 (1) STOP 0 (0)
- LONG: count 3 TP1 3 TP2 3 TP3 3 STOP 0
- SHORT: count 5 TP1 5 TP2 5 TP3 5 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 6 perDay 0.492 LONG 1 SHORT 5 TP1 6 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 70 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 70 met 4/7

### V2-D SMC+COMBINED HARD_ALIGNMENT — COMBINED HARD_ALIGNMENT — freqVsV1 75.0%
- Aggregate: signals 6 perDay 0.098 LONG 2 SHORT 4 TP1 6 (1) TP2 6 (1) TP3 6 (1) STOP 0 (0)
- LONG: count 2 TP1 2 TP2 2 TP3 2 STOP 0
- SHORT: count 4 TP1 4 TP2 4 TP3 4 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 4 perDay 0.328 LONG 0 SHORT 4 TP1 4 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 55 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 55 met 4/7
  WARNING: HARD_ALIGNMENT may cause -80% signals

### V2-A MARKET_STRUCTURE SCORE_BOOST min70 — MARKET_STRUCTURE SCORE_BOOST — freqVsV1 100.0%
- Aggregate: signals 8 perDay 0.131 LONG 3 SHORT 5 TP1 8 (1) TP2 8 (1) TP3 8 (1) STOP 0 (0)
- LONG: count 3 TP1 3 TP2 3 TP3 3 STOP 0
- SHORT: count 5 TP1 5 TP2 5 TP3 5 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 6 perDay 0.492 LONG 1 SHORT 5 TP1 6 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 70 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 70 met 4/7

### V2-D COMBINED TIERING min70 — COMBINED TIERING — freqVsV1 100.0%
- Aggregate: signals 8 perDay 0.131 LONG 3 SHORT 5 TP1 8 (1) TP2 8 (1) TP3 8 (1) STOP 0 (0)
- LONG: count 3 TP1 3 TP2 3 TP3 3 STOP 0
- SHORT: count 5 TP1 5 TP2 5 TP3 5 STOP 0
  - TRAIN: signals 2 perDay 0.055 LONG 2 SHORT 0 TP1 2 (1) STOP 0 (0)
  - VALIDATION: signals 6 perDay 0.492 LONG 1 SHORT 5 TP1 6 (1) STOP 0 (0)
  - OOS: signals 0 perDay 0 LONG 0 SHORT 0 TP1 0 (0) STOP 0 (0)
- Regression 2026-09-13 08:15 SHORT -> 11:00 REARM: SHORT longScore 10 shortScore 70 met 4/7
  Detail: Evaluation at exact regression candle 2026-09-13T08:15:00.000Z: SHORT longScore 10 shortScore 70 met 4/7

## Recommended
- Model: V2-A SMC+MARKET_STRUCTURE SCORE_BOOST
- TrendMode: MARKET_STRUCTURE Policy: SCORE_BOOST
- Frequency retained: 100.0%
- Rationale: improves quality vs V1 without destroying quantity, SCORE_BOOST/TIERING preferred over HARD_ALIGNMENT, preserves frequency
- Regression: SHORT longScore 10 shortScore 70 met 4/7 — not tuned for this episode

```json
{
  "mode": "DISABLED",
  "symbol": "BTC",
  "timeframe": "15m",
  "referenceExchange": "BINANCE",
  "minimumSignalScore": 35,
  "swingLeft": 20,
  "swingRight": 20,
  "internalLeft": 3,
  "internalRight": 3,
  "atrPeriod": 14,
  "structureEventFreshBars": 10,
  "sweepFreshBars": 5,
  "orderBlockFreshBars": 20,
  "fvgFreshBars": 20,
  "eqBand": 0.02,
  "weights": {
    "swingStructureBias": 20,
    "recentSwingBos": 15,
    "internalStructure": 10,
    "liquiditySweep": 10,
    "swingOrderBlock": 15,
    "internalOrderBlock": 5,
    "fvg": 10,
    "rangePosition": 10,
    "confluence": 5
  },
  "confirmations": {
    "bos": {
      "enabled": true,
      "weight": 20,
      "required": false,
      "category": "INDEPENDENT",
      "description": "Break of Structure — SWING_TREND + RECENT_SWING_BOS"
    },
    "choch": {
      "enabled": false,
      "weight": 0,
      "required": false,
      "category": "PLACEHOLDER",
      "description": "Change of Character — duplicate of internalStructure (INTERNAL_TREND), disabled to avoid double count"
    },
    "orderBlock": {
      "enabled": true,
      "weight": 20,
      "required": false,
      "category": "INDEPENDENT",
      "description": "Order Block — SWING_ORDER_BLOCK (or INTERNAL as fallback)"
    },
    "fvg": {
      "enabled": true,
      "weight": 15,
      "required": false,
      "category": "INDEPENDENT",
      "description": "Fair Value Gap — FVG"
    },
    "liquiditySweep": {
      "enabled": true,
      "weight": 15,
      "required": false,
      "category": "INDEPENDENT",
      "description": "Liquidity Sweep — LIQUIDITY_SWEEP"
    },
    "displacement": {
      "enabled": false,
      "weight": 0,
      "required": false,
      "category": "PLACEHOLDER",
      "description": "Displacement — evaluateSmc exposes displacements[] but scoring has no DISPLACEMENT reason yet, placeholder until exposed"
    },
    "rangePosition": {
      "enabled": true,
      "weight": 15,
      "required": false,
      "category": "INDEPENDENT",
      "description": "Premium/Discount — RANGE_POSITION"
    },
    "confluence": {
      "enabled": true,
      "weight": 5,
      "required": false,
      "category": "DERIVED",
      "description": "OB+FVG confluence — OB_FVG_CONFLUENCE overlap bonus, derived, not duplicate weight"
    },
    "internalStructure": {
      "enabled": true,
      "weight": 10,
      "required": false,
      "category": "CONTEXT",
      "description": "Internal structure bias — INTERNAL_TREND context"
    }
  },
  "trend": {
    "enabled": true,
    "mode": "MARKET_STRUCTURE",
    "policy": "SCORE_BOOST",
    "emaFast": 20,
    "emaSlow": 50,
    "emaSlopeLookback": 5,
    "htfTimeframe": "1h",
    "weight": 15,
    "counterTrendPenalty": 10
  },
  "atr": {
    "period": 14,
    "stopMultiplier": 1.5,
    "takeProfit1Multiplier": 1.5,
    "takeProfit2Multiplier": 2.5,
    "takeProfit3Multiplier": 4
  },
  "filters": {
    "minimumQuoteVolume24h": 0,
    "top500Only": false
  },
  "execution": {
    "closedCandleOnly": true,
    "cooldownCandles": 3
  }
}
```

## Strategy Isolation
V2 has own confirmations, score, StrategySignalState via strategyId, EDGE/HOLD/REARM/REVERSAL lifecycle, Signal records. V2 only -> save V2, V1 only -> save V1, both same/conflicting -> save BOTH (different strategyId). UI may classify CONFLICT but persistence not discard. trend-suslik and smart-money-suslik not regressed.

## Blocking for DRY_RUN/FORWARD_TEST
Need DB with BINANCE BTC/USDT 15m max history, owner approval to set mode DRY_RUN (currently DISABLED). V2 LIVE blocked per task. Outcome tracker generic supports V2. Signal worker now supports smart-money-v2 slug but forces dryRun for V2 LIVE blocked.
