/**
 * SMC Phase 2C — Order Block core (V1, conservative).
 *
 * ПЕРЕИСПОЛЬЗОВАНИЕ (новых детекторов НЕТ): pivot/FSM —
 * evaluateStructure Phase 1; displacement — evaluateDisplacements
 * Phase 2A; FVG confluence — evaluateFvgs Phase 2A; sweep
 * confluence — evaluateLiquidity Phase 2B; horizon —
 * validateAndPrepare + horizonCandles. Один canonical core.
 *
 * CANONICAL V1 DEFINITION (opposite candle — только CANDIDATE):
 * bullish OB существует только когда есть ВСЁ:
 *   1) bullish primitive displacement impulse (см. grouping);
 *   2) candidate origin: contiguous cluster bearish свечей
 *      (close < open) непосредственно ПЕРЕД impulseStart; если
 *      свеча перед impulseStart не bearish — кандидата нет;
 *      zone = FULL wick range кластера
 *      (bottom = min low, top = max high);
 *   3) structural confirmation: BOS up / CHOCH up, причём
 *      CONSERVATIVE CHOCH POLICY: CHOCH сам OB не подтверждает
 *      (CHOCH — transition, не confirmed reversal); reversal-OB
 *      подтверждается последующим BOS того же направления —
 *      формальная связь с FSM без её изменения: CHOCH-event не
 *      участвует в matching, а последующий reversal-BOS
 *      matches impulse и его confirmedAt (позже CHOCH) является
 *      confirmedAt OB. Failed CHOCH (reclaim) такой BOS в окне
 *      не порождает → OB нет. CAUSAL CONSTRAINT для
 *      reversal-confirming BOS (BOS, непосредственно следующий
 *      за CHOCH того же направления в хронологии events): он
 *      матчит только impulse, принадлежащий reversal-ноге, —
 *      impulse не закончился ДО CHOCH-свечи
 *      (impulse.endIndex >= chochIdx); pre-CHOCH impulse
 *      прежней структуры не переиспользуется лишь потому, что
 *      попал в окно confirmMaxCandles.
 *   4) temporal: confirmation candle в пределах
 *      obConfirmMaxCandles CLOSED boundaries после impulseEnd
 *      (eventIdx - impulseEndIdx <= max, eventIdx >= impulseEndIdx).
 *
 * IMPULSE GROUPING V1 (deterministic, поверх готовых displacement
 * events): impulse = contiguous sequence максимум
 * obImpulseMaxCandles свечей, начинающаяся с primitive
 * displacement candle данного направления; continuation входит
 * только если направлена туда же (close > open bullish / close <
 * open bearish); continuation НЕ обязана сама быть displacement.
 * Impulses максимальны и не пересекаются внутри направления.
 *
 * ONE-TO-ONE MATCHING: каждый BOS-event матчит РОВНО ОДИН
 * nearest preceding unmatched eligible impulse того же направления
 * (eligible = есть candidate cluster; nearest = max impulseEndIdx;
 * impulses одного направления не пересекаются, tie невозможен).
 * Event расходуется однократно; impulse порождает максимум один
 * OB (исчерпывается matching'ом, даже если candidate отброшен
 * pre-confirmation policy).
 *
 * PRE-CONFIRMATION POLICY (scan свечей impulseEnd+1 ..
 * confirmationCandle−1, только candles <= confirmedAt):
 *  - wick inside zone: НЕ mitigation; только счётчик
 *    preConfirmationTouches (payload);
 *  - close через ДАЛЬНЮЮ границу (bullish close < bottom /
 *    bearish close > top): candidate INVALID, discard — OB не
 *    становится confirmed (никогда не появляется в output).
 *
 * CONFIRMED AT: BOS.confirmedAt (для conservative reversal —
 * подтверждается reversal-BOS, НЕ original CHOCH.confirmedAt).
 * До confirmedAt OB для потребителя НЕ существует.
 *
 * LIFECYCLE (свечи с effClose СТРОГО > confirmedAt; confirmation
 * candle себя не митигирует):
 *   touch bullish: low <= top (inclusive); bearish: high >= bottom;
 *   firstTouchedAt = firstMitigatedAt = первый touch (V1);
 *   penetration fraction: bullish (top - minLow)/(top-bottom),
 *   bearish (maxHigh - bottom)/(top-bottom), clamp [0,1]
 *   (wick через дальнюю границу + close внутри = fraction 1,
 *   MITIGATED, НЕ invalidated — strict close rule);
 *   invalidation: bullish close < bottom / bearish close > top
 *   (строго) — финальна;
 *   retests: in/out state machine: вход = wick-in-zone после
 *   candle СНАРУЖИ (bullish out: low > top); первый вход = 1,
 *   consecutive внутри не растут, выход+вход = +1;
 *   expiry: obMaxAgeCandles последующих CLOSED свеч после
 *   confirmedAt (0 = выкл); INVALIDATED приоритетен.
 *   Состояния: OPEN / MITIGATED / INVALIDATED / EXPIRED.
 *
 * CONFLUENCE (annotation, НЕ gate):
 *   hasFvgInImpulse: существует confirmed FVG того же direction,
 *   чья ТРЕТЬЯ свеча (её effClose = fvg.confirmedAt) лежит в
 *   интервале [clusterStart .. impulseEnd] и fvg.confirmedAt <=
 *   structureConfirmedAt (будущие FVG исключены);
 *   hasLiquiditySweepBeforeImpulse: существует SWEPT level
 *   ПРОТИВОПОЛОЖНОЙ стороны (bullish → SELL_SIDE), чья
 *   resolving-свеча (resolvedByCandleTime = её openTime →
 *   канонический индекс CLOSED-массива horizon) строго
 *   ПРЕДШЕСТВУЕТ impulseStart, а индексная дистанция
 *   distance = impulseStartIndex − sweepCandleIndex лежит в
 *   [1 .. sweepLookbackCandles] (lookback = число CLOSED свеч;
 *   семантика канонических индексов, НЕ wall-clock: таймгэпы
 *   истории на eligible не влияют); дополнительно resolvedAt <=
 *   impulseStart.openTime; resolvedByCandleTime не маппится на
 *   horizon → level не eligible; sweepLookbackCandles = 0 →
 *   confluence выключена (всегда false).
 *
 * DUPLICATES: не merge; каждый matched event — отдельный OB с
 * отдельным key; overlapping зоны остаются раздельными events.
 *
 * IDENTITY: SMC1|OB|tf|direction|layer|structureEventKey|candidateStartOpenMs
 * (без DB-id/random; price в identity не входит; lifecycle key не
 * меняет). layer = config.structureLayer; internal/swing — ОДИН
 * алгоритм, слои не смешиваются в одном вызове.
 *
 * COMPLEXITY: sub-evaluations O(n·window)/O(n·A); impulses O(n);
 * matching — события хронологически, поиск bounded окном
 * (последний matched impulseEndIdx монотонно не убывает —
 * backward scan короткий); lifecycle O(n) суммарно. Без
 * cartesian-произведений.
 *
 * STATELESS: результат — детерминированная функция
 * (raw, config, asOf); future-injection invariance тестируется.
 */

import {
  evaluateDisplacements,
  SmcDisplacement
} from "./displacement";
import { evaluateFvgs } from "./fvg";
import {
  evaluateLiquidity,
  defaultLiquidityConfig
} from "./liquidity";
import { evaluateStructure } from "./fsm";
import {
  assertValidAsOf,
  assertValidTf,
  horizonCandles,
  SmcInputError,
  validateAndPrepare
} from "./validate";
import {
  SmcCandle,
  SmcDirection,
  SmcLayer,
  SmcRawCandle,
  SmcStructureEvent,
  SmcTimeframe
} from "./types";

export interface SmcOrderBlockConfig {
  tf: SmcTimeframe;
  layer: SmcLayer;
  /** Default swing window Phase 1 (для FSM и liquidity). */
  swingLeft: number;
  swingRight: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 14 (ATR14 проекта). */
  atrPeriod: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 3 */
  impulseMaxCandles: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 10 */
  confirmMaxCandles: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 750; 0 = выкл. */
  maxAgeCandles: number;
  /** INITIAL ENGINEERING DEFAULT / HYPOTHESIS: 5. Семантика —
   * число CLOSED свеч (канонические индексы) между
   * resolving-свечей sweep и impulseStart; 0 = confluence выкл. */
  sweepLookbackCandles: number;
}

export function defaultOrderBlockConfig(
  tf: SmcTimeframe,
  layer: SmcLayer = "swing"
): SmcOrderBlockConfig {
  return {
    tf,
    layer,
    swingLeft: layer === "swing" ? 20 : 3,
    swingRight: layer === "swing" ? 20 : 3,
    atrPeriod: 14,
    impulseMaxCandles: 3,
    confirmMaxCandles: 10,
    maxAgeCandles: 750,
    sweepLookbackCandles: 5
  };
}

export type SmcOrderBlockState =
  | "OPEN"
  | "MITIGATED"
  | "INVALIDATED"
  | "EXPIRED";

export interface SmcOrderBlock {
  key: string;
  tf: SmcTimeframe;
  direction: SmcDirection;
  layer: SmcLayer;
  bottom: number;
  top: number;
  /** openTime ПЕРВОЙ свечи candidate cluster. */
  eventTime: Date;
  /** openTime первой impulse-свечи. */
  impulseStartAt: Date;
  /** effectiveCloseTime последней impulse-свечи. */
  impulseEndAt: Date;
  /** Key ПОДТВЕРЖДАЮЩЕГО FSM event (reversal-BOS для
   * conservative CHOCH path). */
  structureEventKey: string;
  structureEventType: "BOS" | "CHOCH";
  /** openTime confirmation candle. */
  structureEventTime: Date;
  confirmedAt: Date;
  firstTouchedAt: Date | null;
  firstMitigatedAt: Date | null;
  maxPenetrationFraction: number;
  retests: number;
  invalidatedAt: Date | null;
  expiredAt: Date | null;
  /** Wick-in-zone до confirmation — payload, не mitigation. */
  preConfirmationTouches: number;
  hasFvgInImpulse: boolean;
  hasLiquiditySweepBeforeImpulse: boolean;
  state: SmcOrderBlockState;
}

export function assertValidOrderBlockConfig(
  config: SmcOrderBlockConfig
): void {
  assertValidTf(config.tf);

  if (config.layer !== "internal" && config.layer !== "swing") {
    throw new SmcInputError(
      "ob.layer: ожидается internal | swing"
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
        `ob.${field}: ожидается целое 1..500`
      );
    }
  }

  if (
    !Number.isInteger(config.atrPeriod) ||
    config.atrPeriod < 1
  ) {
    throw new SmcInputError(
      "ob.atrPeriod: ожидается целое >= 1"
    );
  }

  if (
    !Number.isInteger(config.impulseMaxCandles) ||
    config.impulseMaxCandles < 1 ||
    config.impulseMaxCandles > 10
  ) {
    throw new SmcInputError(
      "ob.impulseMaxCandles: ожидается целое 1..10"
    );
  }

  if (
    !Number.isInteger(config.confirmMaxCandles) ||
    config.confirmMaxCandles < 1 ||
    config.confirmMaxCandles > 100
  ) {
    throw new SmcInputError(
      "ob.confirmMaxCandles: ожидается целое 1..100"
    );
  }

  for (const field of [
    "maxAgeCandles",
    "sweepLookbackCandles"
  ] as const) {
    const value = config[field];

    if (!Number.isInteger(value) || value < 0) {
      throw new SmcInputError(
        `ob.${field}: ожидается целое >= 0 (0 = выключено)`
      );
    }
  }
}

interface ImpulseRec {
  dir: SmcDirection;
  startIndex: number;
  endIndex: number;
  matched: boolean;
  hasCandidate: boolean;
  clusterStartIndex: number;
  clusterBottom: number;
  clusterTop: number;
}

/** Ядро на подготовленном horizon-массиве. */
export function findOrderBlocks(
  candles: SmcCandle[],
  config: SmcOrderBlockConfig
): SmcOrderBlock[] {
  assertValidOrderBlockConfig(config);

  const closeMs = candles.map((candle) =>
    candle.effectiveCloseTime.getTime()
  );
  const openMs = candles.map((candle) =>
    candle.openTime.getTime()
  );
  const indexByOpen = new Map<number, number>();

  for (let i = 0; i < candles.length; i++) {
    indexByOpen.set(openMs[i], i);
  }

  const params = {
    tf: config.tf,
    layer: config.layer,
    left: config.swingLeft,
    right: config.swingRight
  };

  // Sub-evaluations (те же проверенные слои) на ТОМ ЖЕ
  // horizon: candles уже обрезаны canonical horizon'ом, поэтому
  // asOf = effClose последней свечи эквивалентен исходному.
  // Shim обратно в raw-форму (свечи прошли validateAndPrepare,
  // все CLOSED) — это НЕ пересортировка и NOT повторный horizon.
  const rawShim = candles.map((candle) => ({
    openTime: candle.openTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    closed: true as const
  }));
  const horizonAsOf = new Date(
    candles[candles.length - 1].effectiveCloseTime
  );
  const structure = evaluateStructure(
    rawShim,
    params,
    horizonAsOf
  );
  const displacements = evaluateDisplacements(
    rawShim,
    {
      tf: config.tf,
      atrPeriod: config.atrPeriod,
      bodyAtrMin: 1.5,
      rangeAtrMin: 2.0,
      bullCloseLocMin: 0.6,
      bearCloseLocMax: 0.4
    },
    horizonAsOf
  );
  const fvgs = evaluateFvgs(
    rawShim,
    {
      tf: config.tf,
      atrPeriod: config.atrPeriod,
      minGapAtr: 0.1,
      maxAgeCandles: 0
    },
    horizonAsOf
  );
  const liquidityConfig = {
    ...defaultLiquidityConfig(config.tf),
    atrPeriod: config.atrPeriod,
    swingLeft: config.swingLeft,
    swingRight: config.swingRight,
    maxAgeCandles: 0
  };
  const liquidity = evaluateLiquidity(
    rawShim,
    liquidityConfig,
    horizonAsOf
  );

  // --- impulse grouping: максимальные contiguous runs ---
  const dispDirByOpen = new Map<
    number,
    SmcDirection
  >();

  for (const displacement of displacements) {
    dispDirByOpen.set(
      displacement.eventTime.getTime(),
      displacement.direction
    );
  }

  const inImpulse: Record<"up" | "down", boolean[]> = {
    up: candles.map(() => false),
    down: candles.map(() => false)
  };
  const impulses: ImpulseRec[] = [];

  const buildImpulses = (dir: SmcDirection): void => {
    const bullish = dir === "up";

    for (let i = 0; i < candles.length; i++) {
      if (
        inImpulse[dir][i] ||
        dispDirByOpen.get(openMs[i]) !== dir
      ) {
        continue;
      }

      let end = i;

      while (
        end + 1 < candles.length &&
        end - i + 1 < config.impulseMaxCandles &&
        (bullish
          ? candles[end + 1].close > candles[end + 1].open
          : candles[end + 1].close < candles[end + 1].open)
      ) {
        end += 1;
      }

      for (let j = i; j <= end; j++) {
        inImpulse[dir][j] = true;
      }

      // Candidate cluster: contiguous opposite-direction
      // свечи непосредственно перед impulseStart.
      let hasCandidate = false;
      let clusterStart = i;
      let bottom = Number.POSITIVE_INFINITY;
      let top = Number.NEGATIVE_INFINITY;

      if (i > 0) {
        const opposite = bullish
          ? candles[i - 1].close < candles[i - 1].open
          : candles[i - 1].close > candles[i - 1].open;

        if (opposite) {
          hasCandidate = true;
          clusterStart = i - 1;
          let j = i - 1;

          while (j >= 0) {
            const candle = candles[j];
            const isOpposite = bullish
              ? candle.close < candle.open
              : candle.close > candle.open;

            if (!isOpposite) {
              break;
            }

            clusterStart = j;
            bottom = Math.min(bottom, candle.low);
            top = Math.max(top, candle.high);
            j -= 1;
          }

          // Defensive invariant: канонический OHLC (validate:
          // high >= max(open,close), low <= min(open,close)) для
          // opposite-свечи гарантирует high > low каждой свечи
          // кластера, т.е. top > bottom СТРОГО — знаменатель
          // maxPenetrationFraction (top−bottom) не может быть 0.
          // Защита от вырожденного кластера (например, direct
          // вызов findOrderBlocks вне validate) без epsilon:
          // top <= bottom → candidate отвергается.
          if (!(top > bottom)) {
            hasCandidate = false;
          }
        }
      }

      impulses.push({
        dir,
        startIndex: i,
        endIndex: end,
        matched: false,
        hasCandidate,
        clusterStartIndex: clusterStart,
        clusterBottom: bottom,
        clusterTop: top
      });
    }
  };

  buildImpulses("up");
  buildImpulses("down");

  impulses.sort(
    (a, b) => a.startIndex - b.startIndex
  );

  // --- structural matching (conservative CHOCH policy) ---
  const confirmers = structure.events.filter(
    (event: SmcStructureEvent) => event.type === "BOS"
  );

  // Reversal-confirmation BOS: BOS, непосредственно следующий
  // (в хронологическом events — один event максимум за свечу)
  // за CHOCH ТОГО ЖЕ направления. Из REVERSAL_PENDING_X
  // возможны ровно два перехода — CHOCH_INVALIDATED или BOS X,
  // поэтому "prev = CHOCH X" детерминированно идентифицирует
  // reversal-подтверждение без изменения FSM. Значение —
  // канонический индекс CHOCH-свечи (или null, если BOS не
  // reversal-confirmation / CHOCH-свеча вне horizon).
  const reversalChochIdxByEventKey = new Map<
    string,
    number | null
  >();

  for (let i = 0; i < structure.events.length; i++) {
    const event = structure.events[i];

    if (event.type !== "BOS") {
      continue;
    }

    const prev = i > 0 ? structure.events[i - 1] : null;
    const choch =
      prev !== null &&
      prev.type === "CHOCH" &&
      prev.dir === event.dir
        ? prev
        : null;
    const chochIdx =
      choch === null
        ? null
        : indexByOpen.get(choch.eventTime.getTime());

    reversalChochIdxByEventKey.set(
      event.key,
      chochIdx === undefined ? null : chochIdx
    );
  }

  const out: SmcOrderBlock[] = [];

  const hasFvgInInterval = (
    dir: SmcDirection,
    fromIdx: number,
    toIdx: number,
    structureConfirmedMs: number
  ): boolean => {
    for (const fvg of fvgs) {
      if (fvg.direction !== dir) {
        continue;
      }

      const confirmedMs = fvg.confirmedAt.getTime();

      if (confirmedMs > structureConfirmedMs) {
        continue;
      }

      // Третья свеча FVG (effClose = confirmedAt) должна
      // лежать в интервале cluster..impulse.
      for (
        let idx = fromIdx;
        idx <= toIdx;
        idx++
      ) {
        if (closeMs[idx] === confirmedMs) {
          return true;
        }
      }
    }

    return false;
  };

  const hasOppositeSweepBefore = (
    dir: SmcDirection,
    impulseStartIndex: number
  ): boolean => {
    // sweepLookbackCandles = 0 → confluence выключена.
    if (config.sweepLookbackCandles === 0) {
      return false;
    }

    const wantedSide =
      dir === "up" ? "SELL_SIDE" : "BUY_SIDE";

    for (const level of liquidity) {
      if (
        level.state !== "SWEPT" ||
        level.side !== wantedSide ||
        level.resolvedAt === null ||
        level.resolvedByCandleTime === null
      ) {
        continue;
      }

      // (1) sweep разрешён не позднее границы перед
      // impulseStart.
      if (
        level.resolvedAt.getTime() >
        openMs[impulseStartIndex]
      ) {
        continue;
      }

      // (2) resolving-свеча по каноническому индексу
      // (resolvedByCandleTime = её openTime); НЕ маппится на
      // horizon-массив → level не eligible. wall-clock
      // миллисекунды для дистанции НЕ используются.
      const sweepIdx = indexByOpen.get(
        level.resolvedByCandleTime.getTime()
      );

      if (sweepIdx === undefined) {
        continue;
      }

      // (3) distance = impulseStartIndex − sweepCandleIndex;
      // eligible при distance ∈ [1 .. sweepLookbackCandles]
      // (lookback=5 ⇒ sweep-свеча — одна из предыдущих 5
      // CLOSED свеч перед impulseStart; окно включительно).
      const distance = impulseStartIndex - sweepIdx;

      if (
        distance >= 1 &&
        distance <= config.sweepLookbackCandles
      ) {
        return true;
      }
    }

    return false;
  };

  for (const event of confirmers) {
    const eventIdx = indexByOpen.get(
      event.eventTime.getTime()
    );

    if (eventIdx === undefined) {
      continue;
    }

    let target: ImpulseRec | null = null;
    const reversalChochIdx =
      reversalChochIdxByEventKey.get(event.key) ?? null;

    for (const impulse of impulses) {
      if (
        impulse.dir !== event.dir ||
        impulse.matched ||
        !impulse.hasCandidate
      ) {
        continue;
      }

      if (
        impulse.endIndex > eventIdx ||
        eventIdx - impulse.endIndex >
          config.confirmMaxCandles
      ) {
        continue;
      }

      // Causal constraint для reversal-confirming BOS:
      // impulse принадлежит reversal-ноге только если он НЕ
      // закончился ДО CHOCH-свечи (endIndex >= chochIdx).
      // Pre-CHOCH impulse прежней структуры не переиспользуется
      // лишь потому, что попал в окно confirmMaxCandles.
      if (
        reversalChochIdx !== null &&
        impulse.endIndex < reversalChochIdx
      ) {
        continue;
      }

      if (
        target === null ||
        impulse.endIndex > target.endIndex
      ) {
        target = impulse;
      }
    }

    if (target === null) {
      continue;
    }

    target.matched = true;
    const bullish = event.dir === "up";
    const zoneBottom = target.clusterBottom;
    const zoneTop = target.clusterTop;

    // Pre-confirmation policy.
    let preTouches = 0;
    let discarded = false;

    for (
      let j = target.endIndex + 1;
      j < eventIdx;
      j++
    ) {
      const candle = candles[j];
      const touched = bullish
        ? candle.low <= zoneTop
        : candle.high >= zoneBottom;

      if (touched) {
        preTouches += 1;
      }

      const closedThroughFar = bullish
        ? candle.close < zoneBottom
        : candle.close > zoneTop;

      if (closedThroughFar) {
        discarded = true;
        break;
      }
    }

    if (discarded) {
      continue;
    }

    const structureConfirmedMs =
      event.confirmedAt.getTime();
    const confirmedAt = event.confirmedAt;
    const key = `SMC1|OB|${config.tf}|${event.dir}|${config.layer}|${event.key}|${openMs[target.clusterStartIndex]}`;

    const ob: SmcOrderBlock = {
      key,
      tf: config.tf,
      direction: event.dir,
      layer: config.layer,
      bottom: zoneBottom,
      top: zoneTop,
      eventTime: new Date(
        openMs[target.clusterStartIndex]
      ),
      impulseStartAt: new Date(
        openMs[target.startIndex]
      ),
      impulseEndAt: new Date(
        closeMs[target.endIndex]
      ),
      structureEventKey: event.key,
      structureEventType: event.type === "CHOCH" ? "CHOCH" : "BOS",
      structureEventTime: event.eventTime,
      confirmedAt,
      firstTouchedAt: null,
      firstMitigatedAt: null,
      maxPenetrationFraction: 0,
      retests: 0,
      invalidatedAt: null,
      expiredAt: null,
      preConfirmationTouches: preTouches,
      hasFvgInImpulse: hasFvgInInterval(
        event.dir,
        target.clusterStartIndex,
        target.endIndex,
        structureConfirmedMs
      ),
      hasLiquiditySweepBeforeImpulse:
        hasOppositeSweepBefore(
          event.dir,
          target.startIndex
        ),
      state: "OPEN"
    };

    // --- post-confirmation lifecycle ---
    const gap = zoneTop - zoneBottom;
    let extreme = bullish
      ? Number.POSITIVE_INFINITY
      : Number.NEGATIVE_INFINITY;
    let wasIn = false;
    let subsequent = 0;

    for (
      let j = eventIdx + 1;
      j < candles.length;
      j++
    ) {
      const candle = candles[j];

      subsequent += 1;

      const inZone = bullish
        ? candle.low <= zoneTop
        : candle.high >= zoneBottom;

      if (inZone && !wasIn) {
        ob.retests += 1;
      }

      if (inZone) {
        wasIn = true;

        if (ob.firstTouchedAt === null) {
          ob.firstTouchedAt = candle.effectiveCloseTime;
          ob.firstMitigatedAt = ob.firstTouchedAt;
        }

        extreme = bullish
          ? Math.min(extreme, candle.low)
          : Math.max(extreme, candle.high);

        const raw = bullish
          ? (zoneTop - extreme) / gap
          : (extreme - zoneBottom) / gap;

        ob.maxPenetrationFraction = Math.min(
          1,
          Math.max(0, raw)
        );
      } else {
        wasIn = false;
      }

      const invalidated = bullish
        ? candle.close < zoneBottom
        : candle.close > zoneTop;

      if (invalidated) {
        ob.invalidatedAt = candle.effectiveCloseTime;
        break;
      }

      if (
        config.maxAgeCandles > 0 &&
        subsequent >= config.maxAgeCandles
      ) {
        ob.expiredAt = candle.effectiveCloseTime;
        break;
      }
    }

    if (ob.invalidatedAt !== null) {
      ob.state = "INVALIDATED";
    } else if (ob.expiredAt !== null) {
      ob.state = "EXPIRED";
    } else if (ob.firstTouchedAt !== null) {
      ob.state = "MITIGATED";
    } else {
      ob.state = "OPEN";
    }

    out.push(ob);
  }

  return out;
}

/** Каноническая точка входа: canonical Phase 1 horizon;
 * свечи после asOf физически не видны ни одному sub-слою. */
export function evaluateOrderBlocks(
  raw: SmcRawCandle[],
  config: SmcOrderBlockConfig,
  asOf: Date
): SmcOrderBlock[] {
  assertValidOrderBlockConfig(config);
  assertValidAsOf(asOf);

  const prepared = validateAndPrepare(raw, config.tf);

  return findOrderBlocks(
    horizonCandles(prepared, asOf),
    config
  );
}
