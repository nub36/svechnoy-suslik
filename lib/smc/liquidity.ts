/**
 * SMC Phase 2B — liquidity layer: structural swing liquidity,
 * EQH/EQL, lifecycle (OPEN/SWEPT/BROKEN/EXPIRED), sweep-vs-breakout.
 *
 * ПЕРЕИСПОЛЬЗОВАНИЕ PHASE 1 (второго pivot-алгоритма НЕТ):
 * вход — validateAndPrepare + horizonCandles (canonical horizon),
 * pivots — ТОЛЬКО findPivots со swing-окном (layer "swing");
 * пивот доступен liquidity ровно когда pivot.confirmedAt <= asOf
 * (горизонт это гарантирует). Historical eventTime НИКОГДА не
 * используется как момент известности.
 *
 * STRUCTURAL: каждый confirmed swing-high pivot → BUY_SIDE level,
 * swing-low → SELL_SIDE level. Plateau одного pivot = ОДИН level
 * (один pivot по plateau-политике Phase 1). eventTime =
 * pivot.eventTime (исторический anchor), createdAt =
 * pivot.confirmedAt (actionable boundary).
 *
 * EQH/EQL (отдельный origin): пара РАЗНЫХ confirmed swing-pivots
 * одного рода (plateau одного pivot EQH/EQL НЕ является).
 * INITIAL ENGINEERING DEFAULT / HYPOTHESIS (не LuxAlgo formula):
 *   eqToleranceAtr = 0.10, eqConfirmBars = 2,
 *   sweepMinPenetrationAtr = 0.05, liquidityMaxAgeCandles = 750.
 *
 * ATR-AT-PIVOT RULE: tolerance-check использует ATR на actionable
 * boundary p2 — последняя CLOSED свеча с effectiveCloseTime <=
 * p2.confirmedAt (это сама confirm-свеча p2, grid совпадает);
 * ATR causal (computeAtrSeries). ATR unavailable → EQ candidate
 * unavailable (уровень не создаётся, raw pair не принимается).
 *
 * EQ PAIRING / CLUSTER (deterministic v1 policy):
 * 1) JOIN: для нового пивота p ищем кластер того же рода в
 *    состоянии pending или created-OPEN (resolved/discarded не
 *    участвуют) с максимальным lastJoinConfirmedAtMs (tie —
 *    позднее создание); если |p.price − cluster.price| <= tol —
 *    p вливается: sourcePivotKeys.push, price = max(high-цен) /
 *    min(low-цен) и eventTime/anchor обновляются ТОЛЬКО у
 *    pending (не-public) кластера; у created-OPEN кластера
 *    price/key/createdAt ЗАМОРОЖЕНЫ (identity уровня не меняется
 *    после создания) — join добавляет только provenance в
 *    sources (защита от десятков дубликатов EQH).
 * 2) CREATE: иначе пара с ближайшим предыдущим UNRESOLVED
 *    same-kind pivot p1 ("unresolved" = не источник
 *    разрешившегося (SWEPT/BROKEN/EXPIRED) EQ-кластера;
 *    membership в структурных уровнях на eligibility не влияет),
 *    p2 позже p1 по eventTime И confirmedAt; перебор от ближайшего
 *    (latest confirmedAt, tie — latest eventTime), берётся ПЕРВЫЙ,
 *    удовлетворяющий tolerance. Никто не подошёл — пары нет.
 * 3) CONFIRMATION: candidate создаётся уровнем только после
 *    eqConfirmBars последующих CLOSED свеч без close за уровень в
 *    breakout-направлении (EQH: ни один close > price). Breakout в
 *    окне → candidate discard (уровень никогда не существует).
 *    createdAt = effectiveCloseTime ПОСЛЕДНЕЙ confirmation свечи
 *    (НЕ backdate к p2.confirmedAt). До createdAt EQ невидим.
 *
 * EQ PRICE: EQH = max(source pivot highs), EQL = min(source lows) —
 * консервативная внешняя граница (тестируется).
 *
 * RESOLUTION MACHINE (единая для STRUCTURAL и EQH_EQL; применяется
 * к свечам с effectiveCloseTime СТРОГО позже createdAt):
 *   BUY_SIDE: close > price → BROKEN (приоритет close-beyond);
 *     иначе (ATR causal доступен) high >= price + 0.05*ATR AND
 *     close < price → SWEPT (reclaim внутрь строгий).
 *   SELL_SIDE: зеркало (close < price → BROKEN; low <= price −
 *     0.05*ATR AND close > price → SWEPT).
 *   close РОВНО на уровне: ни broken, ни swept (strict rules) →
 *   уровень остаётся OPEN. Одна свеча не может дать SWEPT и
 *   BROKEN одновременно (направления close взаимоисключающи,
 *   close-priority). Resolution однократный: SWEPT/BROKEN/EXPIRED
 *   финальны. resolvedAt = effectiveCloseTime разрешившей свечи,
 *   resolvedByCandleTime = её openTime.
 *
 * LIQUIDITY EVENT != STRUCTURE EVENT: модуль НЕ создаёт BOS/CHoCH
 * и не дублирует FSM — BROKEN это lifecycle конкретного уровня.
 *
 * EXPIRY: maxAgeCandles последующих CLOSED свеч после createdAt
 * (0 = выключено); BROKEN/SWEPT до expiry имеют приоритет (та же
 * свеча: sweep/break проверяются раньше expiry). Expiry не меняет
 * identity.
 *
 * IDENTITY (без DB IDs/random):
 *   STRUCTURAL: SMC1|LQ|tf|side|STRUCTURAL|pivotAnchorOpenTimeMs
 *   EQH_EQL:    SMC1|LQ|tf|side|EQH_EQL|creationTriggerAnchorMs
 *   (trigger фиксируется в момент создания кластера и не меняется
 *   при joins). Одинаковые input/config/asOf → одинаковые ключи.
 *
 * COMPLEXITY: pivots O(n·window); fold O(n·A) где A — число
 * неразрешённых уровней (уровень разрешается один раз);
 * pairing/join — backward scan с ленивым skip'ом resolved,
 * практически O(P·k) (худший случай O(P²)); O(n³) нет.
 *
 * STATELESS: никакого mutable runtime state между вызовами —
 * весь lifecycle детерминированно пересчитывается из candles
 * <= asOf (future-injection invariance тестируется).
 */

import { findPivots } from "./pivots";
import { computeAtrSeries } from "./volatility";
import {
  assertValidAsOf,
  assertValidTf,
  horizonCandles,
  SmcInputError,
  validateAndPrepare
} from "./validate";
import {
  SWING_PIVOT_WINDOW,
  SmcCandle,
  SmcPivot,
  SmcTimeframe
} from "./types";

export type SmcLiquiditySide = "BUY_SIDE" | "SELL_SIDE";
export type SmcLiquidityOrigin = "STRUCTURAL" | "EQH_EQL";
export type SmcLiquidityState =
  | "OPEN"
  | "SWEPT"
  | "BROKEN"
  | "EXPIRED";

export interface SmcLiquidityConfig {
  tf: SmcTimeframe;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 14 (ATR14 проекта). */
  atrPeriod: number;
  /** Default swing window Phase 1 (SWING_PIVOT_WINDOW). */
  swingLeft: number;
  swingRight: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 0.10 */
  eqToleranceAtr: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 2 */
  eqConfirmBars: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 0.05 */
  sweepMinPenetrationAtr: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 750; 0 = выключено. */
  maxAgeCandles: number;
}

export function defaultLiquidityConfig(
  tf: SmcTimeframe
): SmcLiquidityConfig {
  return {
    tf,
    atrPeriod: 14,
    swingLeft: SWING_PIVOT_WINDOW,
    swingRight: SWING_PIVOT_WINDOW,
    eqToleranceAtr: 0.1,
    eqConfirmBars: 2,
    sweepMinPenetrationAtr: 0.05,
    maxAgeCandles: 750
  };
}

export interface SmcLiquidityLevel {
  key: string;
  tf: SmcTimeframe;
  side: SmcLiquiditySide;
  origin: SmcLiquidityOrigin;
  price: number;
  sourcePivotKeys: string[];
  eventTime: Date;
  createdAt: Date;
  state: SmcLiquidityState;
  resolvedAt: Date | null;
  resolvedByCandleTime: Date | null;
  /** Payload при SWEPT: (extreme − price)/ATR свечи. */
  sweepPenetrationAtr: number | null;
}

export function assertValidLiquidityConfig(
  config: SmcLiquidityConfig
): void {
  assertValidTf(config.tf);

  if (
    !Number.isInteger(config.atrPeriod) ||
    config.atrPeriod < 1
  ) {
    throw new SmcInputError(
      "liquidity.atrPeriod: ожидается целое >= 1"
    );
  }

  for (const field of [
    "swingLeft",
    "swingRight"
  ] as const) {
    const value = config[field];

    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value > 500
    ) {
      throw new SmcInputError(
        `liquidity.${field}: ожидается целое 1..500`
      );
    }
  }

  for (const field of [
    "eqToleranceAtr",
    "sweepMinPenetrationAtr"
  ] as const) {
    const value = config[field];

    if (!Number.isFinite(value) || value < 0) {
      throw new SmcInputError(
        `liquidity.${field}: ожидается конечное число >= 0`
      );
    }
  }

  for (const field of [
    "eqConfirmBars",
    "maxAgeCandles"
  ] as const) {
    const value = config[field];

    if (!Number.isInteger(value) || value < 0) {
      throw new SmcInputError(
        `liquidity.${field}: ожидается целое >= 0 (0 = выключено)`
      );
    }
  }
}

interface PivotRec {
  key: string;
  kind: "high" | "low";
  price: number;
  eventTimeMs: number;
  confirmedAtMs: number;
  /** Источник разрешившегося EQ-кластера. */
  resolved: boolean;
}

interface Cluster {
  seq: number;
  kind: "high" | "low";
  side: SmcLiquiditySide;
  sources: string[];
  price: number;
  eventTimeMs: number;
  /** Индекс boundary-свечи последнего joined пивота. */
  anchorIdx: number;
  lastJoinConfirmedAtMs: number;
  creationTriggerEventTimeMs: number;
  status: "pending" | "created" | "discarded";
  /** Индекс уровня в levels после создания. */
  levelIdx: number | null;
  /** Индекс свечи создания уровня (после created). */
  createdIdx: number | null;
}

interface LevelRec {
  key: string;
  side: SmcLiquiditySide;
  origin: SmcLiquidityOrigin;
  price: number;
  sourcePivotKeys: string[];
  eventTimeMs: number;
  createdAtMs: number;
  createdIdx: number;
  state: SmcLiquidityState;
  resolvedAtMs: number | null;
  resolvedByCandleTimeMs: number | null;
  sweepPenetrationAtr: number | null;
  /** Число subsequent CLOSED свеч после createdAt. */
  subsequent: number;
  clusterSeq: number | null;
}

/** Ядро на подготовленном horizon-массиве. */
export function findLiquidityLevels(
  candles: SmcCandle[],
  config: SmcLiquidityConfig
): SmcLiquidityLevel[] {
  assertValidLiquidityConfig(config);

  const params = {
    tf: config.tf,
    layer: "swing" as const,
    left: config.swingLeft,
    right: config.swingRight
  };

  const highPivots = findPivots(candles, params, "high");
  const lowPivots = findPivots(candles, params, "low");

  // Детерминированный merge: по confirmedAt, tie — high первым,
  // затем по anchor.
  const pivots: SmcPivot[] = [
    ...highPivots,
    ...lowPivots
  ].sort((a, b) => {
    const confDiff =
      a.confirmedAt.getTime() - b.confirmedAt.getTime();

    if (confDiff !== 0) {
      return confDiff;
    }

    const kindDiff =
      (a.kind === "high" ? 0 : 1) - (b.kind === "high" ? 0 : 1);

    if (kindDiff !== 0) {
      return kindDiff;
    }

    return a.eventTime.getTime() - b.eventTime.getTime();
  });

  const pivotsByBoundary = new Map<number, SmcPivot[]>();

  for (const pivot of pivots) {
    const ms = pivot.confirmedAt.getTime();
    const bucket = pivotsByBoundary.get(ms);

    if (bucket) {
      bucket.push(pivot);
    } else {
      pivotsByBoundary.set(ms, [pivot]);
    }
  }

  const atr = computeAtrSeries(
    candles,
    config.atrPeriod
  );

  const pivotRecs = new Map<string, PivotRec>();
  const pivotOrder: PivotRec[] = [];
  const clusters: Cluster[] = [];
  const levels: LevelRec[] = [];
  let nextSeq = 0;

  const sideOf = (
    kind: "high" | "low"
  ): SmcLiquiditySide =>
    kind === "high" ? "BUY_SIDE" : "SELL_SIDE";

  const markClusterResolved = (cluster: Cluster): void => {
    for (const sourceKey of cluster.sources) {
      const rec = pivotRecs.get(sourceKey);

      if (rec) {
        rec.resolved = true;
      }
    }
  };

  const registerStructural = (
    pivot: SmcPivot,
    t: number
  ): void => {
    levels.push({
      key: `SMC1|LQ|${config.tf}|${sideOf(pivot.kind)}|STRUCTURAL|${pivot.eventTime.getTime()}`,
      side: sideOf(pivot.kind),
      origin: "STRUCTURAL",
      price: pivot.price,
      sourcePivotKeys: [pivot.key],
      eventTimeMs: pivot.eventTime.getTime(),
      createdAtMs: pivot.confirmedAt.getTime(),
      createdIdx: t,
      state: "OPEN",
      resolvedAtMs: null,
      resolvedByCandleTimeMs: null,
      sweepPenetrationAtr: null,
      subsequent: 0,
      clusterSeq: null
    });
  };

  const eqJoinOrCreate = (
    pivot: SmcPivot,
    t: number
  ): void => {
    const atrValue = atr[t];

    // ATR unavailable на boundary p2 → EQ unavailable.
    if (atrValue === null || atrValue === undefined) {
      return;
    }

    const toleranceDistance =
      config.eqToleranceAtr * atrValue;
    const kind = pivot.kind;

    // 1) JOIN: pending или created-OPEN кластеры того же рода,
    //    ближайший по lastJoinConfirmedAtMs (tie — позднее
    //    создание). Resolved/discarded не участвуют.
    let joinTarget: Cluster | null = null;

    for (const cluster of clusters) {
      if (cluster.kind !== kind) {
        continue;
      }

      if (cluster.status === "discarded") {
        continue;
      }

      if (
        cluster.status === "created" &&
        levels[cluster.levelIdx!].state !== "OPEN"
      ) {
        continue;
      }

      if (
        joinTarget === null ||
        cluster.lastJoinConfirmedAtMs >
          joinTarget.lastJoinConfirmedAtMs ||
        (cluster.lastJoinConfirmedAtMs ===
          joinTarget.lastJoinConfirmedAtMs &&
          cluster.seq > joinTarget.seq)
      ) {
        if (
          Math.abs(pivot.price - cluster.price) <=
          toleranceDistance
        ) {
          joinTarget = cluster;
        }
      }
    }

    if (joinTarget !== null) {
      joinTarget.sources.push(pivot.key);
      joinTarget.lastJoinConfirmedAtMs =
        pivot.confirmedAt.getTime();

      // Created-кластер: уровень уже public — добавляем
      // provenance и в его sourcePivotKeys (identity/price/
      // createdAt заморожены).
      if (
        joinTarget.status === "created" &&
        joinTarget.levelIdx !== null
      ) {
        levels[joinTarget.levelIdx].sourcePivotKeys.push(
          pivot.key
        );
      }

      if (joinTarget.status === "pending") {
        // Ещё не public: price/eventTime/anchor обновляются,
        // confirmation window перезапускается от нового anchor.
        joinTarget.price =
          kind === "high"
            ? Math.max(joinTarget.price, pivot.price)
            : Math.min(joinTarget.price, pivot.price);
        joinTarget.eventTimeMs = pivot.eventTime.getTime();
        joinTarget.anchorIdx = t;
      }
      // created-OPEN: price/key/createdAt заморожены — join
      // добавляет только provenance в sourcePivotKeys.

      return;
    }

    // 2) CREATE: ближайший предыдущий UNRESOLVED same-kind
    //    pivot, удовлетворяющий tolerance (перебор от
    //    ближайшего: latest confirmedAt, tie — latest eventTime).
    let partner: PivotRec | null = null;

    for (
      let i = pivotOrder.length - 1;
      i >= 0;
      i--
    ) {
      const candidate = pivotOrder[i];

      if (candidate.kind !== kind || candidate.resolved) {
        continue;
      }

      if (
        candidate.confirmedAtMs >=
          pivot.confirmedAt.getTime() ||
        candidate.eventTimeMs >= pivot.eventTime.getTime()
      ) {
        continue;
      }

      if (
        Math.abs(pivot.price - candidate.price) <=
        toleranceDistance
      ) {
        partner = candidate;
        break;
      }
    }

    if (partner === null) {
      return;
    }

    const cluster: Cluster = {
      seq: nextSeq++,
      kind,
      side: sideOf(kind),
      sources: [partner.key, pivot.key],
      price:
        kind === "high"
          ? Math.max(partner.price, pivot.price)
          : Math.min(partner.price, pivot.price),
      eventTimeMs: pivot.eventTime.getTime(),
      anchorIdx: t,
      lastJoinConfirmedAtMs: pivot.confirmedAt.getTime(),
      creationTriggerEventTimeMs: pivot.eventTime.getTime(),
      status: "pending",
      levelIdx: null,
      createdIdx: null
    };

    clusters.push(cluster);

    if (config.eqConfirmBars === 0) {
      cluster.status = "created";
      cluster.createdIdx = t;
      cluster.levelIdx = levels.length;
      levels.push({
        key: `SMC1|LQ|${config.tf}|${cluster.side}|EQH_EQL|${cluster.creationTriggerEventTimeMs}`,
        side: cluster.side,
        origin: "EQH_EQL",
        price: cluster.price,
        sourcePivotKeys: [...cluster.sources],
        eventTimeMs: cluster.eventTimeMs,
        createdAtMs: candles[t].effectiveCloseTime.getTime(),
        createdIdx: t,
        state: "OPEN",
        resolvedAtMs: null,
        resolvedByCandleTimeMs: null,
        sweepPenetrationAtr: null,
        subsequent: 0,
        clusterSeq: cluster.seq
      });
    }
  };

  const resolveLevel = (
    level: LevelRec,
    state: SmcLiquidityState,
    atMs: number,
    candleOpenTimeMs: number,
    penetrationAtr: number | null
  ): void => {
    level.state = state;
    level.resolvedAtMs = atMs;
    level.resolvedByCandleTimeMs = candleOpenTimeMs;
    level.sweepPenetrationAtr = penetrationAtr;

    if (level.clusterSeq !== null) {
      const cluster = clusters.find(
        (candidate) =>
          candidate.seq === level.clusterSeq
      );

      if (cluster) {
        markClusterResolved(cluster);
      }
    }
  };

  for (let t = 0; t < candles.length; t++) {
    const boundaryMs =
      candles[t].effectiveCloseTime.getTime();
    const close = candles[t].close;

    // (1) Confirmation windows pending-кандидатов.
    for (const cluster of clusters) {
      if (cluster.status !== "pending") {
        continue;
      }

      if (t <= cluster.anchorIdx) {
        continue;
      }

      const closeBeyond =
        cluster.kind === "high"
          ? close > cluster.price
          : close < cluster.price;

      if (closeBeyond) {
        // Breakout до окончания confirmation → discard.
        cluster.status = "discarded";
        continue;
      }

      if (
        t ===
        cluster.anchorIdx + config.eqConfirmBars
      ) {
        cluster.status = "created";
        cluster.levelIdx = levels.length;
        levels.push({
          key: `SMC1|LQ|${config.tf}|${cluster.side}|EQH_EQL|${cluster.creationTriggerEventTimeMs}`,
          side: cluster.side,
          origin: "EQH_EQL",
          price: cluster.price,
          sourcePivotKeys: [...cluster.sources],
          eventTimeMs: cluster.eventTimeMs,
          createdAtMs: boundaryMs,
          createdIdx: t,
          state: "OPEN",
          resolvedAtMs: null,
          resolvedByCandleTimeMs: null,
          sweepPenetrationAtr: null,
          subsequent: 0,
          clusterSeq: cluster.seq
        });
      }
    }

    // (2) Регистрация пивотов этой boundary.
    const registered =
      pivotsByBoundary.get(boundaryMs) ?? [];

    for (const pivot of registered) {
      pivotRecs.set(pivot.key, {
        key: pivot.key,
        kind: pivot.kind,
        price: pivot.price,
        eventTimeMs: pivot.eventTime.getTime(),
        confirmedAtMs: pivot.confirmedAt.getTime(),
        resolved: false
      });
      pivotOrder.push(
        pivotRecs.get(pivot.key)!
      );

      registerStructural(pivot, t);
      eqJoinOrCreate(pivot, t);
    }

    // (3) Resolution machine + expiry: только уровни,
    // созданные СТРОГО раньше этой свечи.
    for (const level of levels) {
      if (
        level.state !== "OPEN" ||
        level.createdIdx >= t
      ) {
        continue;
      }

      level.subsequent += 1;
      const atrValue = atr[t];

      if (level.side === "BUY_SIDE") {
        if (close > level.price) {
          resolveLevel(
            level,
            "BROKEN",
            boundaryMs,
            candles[t].openTime.getTime(),
            null
          );
          continue;
        }

        if (atrValue !== null && atrValue !== undefined) {
          const threshold =
            config.sweepMinPenetrationAtr * atrValue;

          if (
            candles[t].high >= level.price + threshold &&
            close < level.price
          ) {
            resolveLevel(
              level,
              "SWEPT",
              boundaryMs,
              candles[t].openTime.getTime(),
              (candles[t].high - level.price) / atrValue
            );
            continue;
          }
        }
      } else {
        if (close < level.price) {
          resolveLevel(
            level,
            "BROKEN",
            boundaryMs,
            candles[t].openTime.getTime(),
            null
          );
          continue;
        }

        if (atrValue !== null && atrValue !== undefined) {
          const threshold =
            config.sweepMinPenetrationAtr * atrValue;

          if (
            candles[t].low <= level.price - threshold &&
            close > level.price
          ) {
            resolveLevel(
              level,
              "SWEPT",
              boundaryMs,
              candles[t].openTime.getTime(),
              (level.price - candles[t].low) / atrValue
            );
            continue;
          }
        }
      }

      if (
        config.maxAgeCandles > 0 &&
        level.subsequent >= config.maxAgeCandles
      ) {
        resolveLevel(
          level,
          "EXPIRED",
          boundaryMs,
          candles[t].openTime.getTime(),
          null
        );
      }
    }
  }

  return levels.map((level) => ({
    key: level.key,
    tf: config.tf,
    side: level.side,
    origin: level.origin,
    price: level.price,
    sourcePivotKeys: [...level.sourcePivotKeys],
    eventTime: new Date(level.eventTimeMs),
    createdAt: new Date(level.createdAtMs),
    state: level.state,
    resolvedAt:
      level.resolvedAtMs === null
        ? null
        : new Date(level.resolvedAtMs),
    resolvedByCandleTime:
      level.resolvedByCandleTimeMs === null
        ? null
        : new Date(level.resolvedByCandleTimeMs),
    sweepPenetrationAtr: level.sweepPenetrationAtr
  }));
}

/** Каноническая точка входа: validateAndPrepare +
 * horizonCandles + findPivots Phase 1; свечи после asOf
 * физически не видны. */
export function evaluateLiquidity(
  raw: Parameters<typeof validateAndPrepare>[0],
  config: SmcLiquidityConfig,
  asOf: Date
): SmcLiquidityLevel[] {
  assertValidLiquidityConfig(config);
  assertValidAsOf(asOf);

  const prepared = validateAndPrepare(raw, config.tf);

  return findLiquidityLevels(
    horizonCandles(prepared, asOf),
    config
  );
}
