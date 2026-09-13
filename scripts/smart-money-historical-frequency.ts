/**
 * Smart Money Historical Frequency — READ-ONLY BASELINE — STEP B/C/D/E
 *
 * STRICTLY READ-ONLY: only findMany/findFirst/findUnique/count, no create/update/delete/upsert/$executeRaw.
 * Uses existing production SMC: evaluateSmc() from lib/smc/evaluate.ts — no second algorithm.
 * Uses existing common horizon: selectCommonClosedHorizon, truncateCandlesToHorizon.
 * Uses existing aggregation: aggregateAssetGroup.
 *
 * Usage on VPS (where DATABASE_URL exists):
 *   npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 1h
 *   npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 15m,1h,4h,1d
 *   npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 1h --limit 2000
 *   npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 1h --last 500
 *   npx tsx scripts/enable-btc-strategy.ts --show
 *   npx tsx scripts/smart-money-diagnostic.ts --symbol BTC --timeframe 1h
 *
 * Output:
 * - per exchange: first/last closed, counts, CANNOT_EVALUATE/NEUTRAL/LONG/SHORT %, score distribution, A-I counts
 * - multi-exchange common horizon baseline
 * - bottleneck 60<=max<72 TOP-10 combos, >=72 TOP-10 combos
 * - current 20/20 exact decomposition
 */

import "dotenv/config";
import { defaultSmcScoringConfig, type SmcScoringConfig } from "../lib/smc/config";
import { evaluateSmc, type SmcEvaluation } from "../lib/smc/evaluate";
import type { SmcTimeframe, SmcRawCandle } from "../lib/smc/types";
import { isSmcTimeframe, SMCTIMEFRAME_MS } from "../lib/smc/types";
import {
  selectCommonClosedHorizon,
  truncateCandlesToHorizon,
  type CommonHorizonMarket,
} from "../lib/strategies/common-horizon";
import { aggregateAssetGroup } from "../lib/strategies/runtime";
import { isSmartMoneyExchangeEligible } from "../lib/strategies/smart-money-eligibility";
import { SMART_MONEY_SLUG } from "../lib/strategies/smart-money";

let prisma: any = null;
async function getPrisma() {
  if (!prisma) {
    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient();
  }
  return prisma;
}

type Args = {
  symbol: string;
  timeframes: SmcTimeframe[];
  limit: number | null; // max candles per market, null = all
  last: number | null; // evaluate only last N points, null = all
  help: boolean;
};

function parseArgs(): Args {
  const raw = process.argv.slice(2);
  let symbol = "BTC";
  let timeframes: SmcTimeframe[] = ["1h"];
  let limit: number | null = null;
  let last: number | null = null;
  let help = false;

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === "--symbol" && raw[i + 1]) {
      symbol = raw[++i].toUpperCase();
    } else if (a.startsWith("--symbol=")) {
      symbol = a.split("=")[1].toUpperCase();
    } else if (a === "--timeframe" && raw[i + 1]) {
      const v = raw[++i];
      timeframes = v.split(",").map((s) => s.trim() as SmcTimeframe).filter((s) => isSmcTimeframe(s));
    } else if (a.startsWith("--timeframe=")) {
      const v = a.split("=")[1];
      timeframes = v.split(",").map((s) => s.trim() as SmcTimeframe).filter((s) => isSmcTimeframe(s));
    } else if (a === "--timeframes" && raw[i + 1]) {
      const v = raw[++i];
      timeframes = v.split(",").map((s) => s.trim() as SmcTimeframe).filter((s) => isSmcTimeframe(s));
    } else if (a.startsWith("--timeframes=")) {
      const v = a.split("=")[1];
      timeframes = v.split(",").map((s) => s.trim() as SmcTimeframe).filter((s) => isSmcTimeframe(s));
    } else if (a === "--limit" && raw[i + 1]) {
      limit = Number(raw[++i]);
    } else if (a.startsWith("--limit=")) {
      limit = Number(a.split("=")[1]);
    } else if (a === "--last" && raw[i + 1]) {
      last = Number(raw[++i]);
    } else if (a.startsWith("--last=")) {
      last = Number(a.split("=")[1]);
    } else if (a === "--help" || a === "-h") {
      help = true;
    }
  }

  if (timeframes.length === 0) timeframes = ["1h"];
  return { symbol, timeframes, limit, last, help };
}

function printHelp() {
  console.log(`
Smart Money Historical Frequency — READ-ONLY BASELINE

Usage:
  npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 1h
  npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 15m,1h,4h,1d
  npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 1h --limit 2000
  npx tsx scripts/smart-money-historical-frequency.ts --symbol BTC --timeframe 1h --last 500

Options:
  --symbol BTC                Asset symbol (default BTC)
  --timeframe 1h / 15m,1h,4h,1d  Timeframes to evaluate
  --limit 2000                Max closed candles per market to load (null = all)
  --last 500                  Evaluate only last N points per market (null = all evaluable)
  --help

READ-ONLY: only SELECT, no writes. Uses production evaluateSmc().
BINGX 1d excluded via isSmartMoneyExchangeEligible.
Common horizon via selectCommonClosedHorizon + truncateCandlesToHorizon.
Aggregation via aggregateAssetGroup minExchanges.
`);
}

type ScoreBucket = "0-19" | "20-39" | "40-59" | "60-71" | "72-79" | "80-89" | "90-100";
function bucket(score: number | null): ScoreBucket {
  if (score === null) return "0-19";
  if (score < 20) return "0-19";
  if (score < 40) return "20-39";
  if (score < 60) return "40-59";
  if (score < 72) return "60-71";
  if (score < 80) return "72-79";
  if (score < 90) return "80-89";
  return "90-100";
}

type ComponentCode = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I";
const CODE_TO_COMP: Record<string, ComponentCode> = {
  SWING_TREND: "A",
  RECENT_SWING_BOS: "B",
  INTERNAL_TREND: "C",
  LIQUIDITY_SWEEP: "D",
  SWING_ORDER_BLOCK: "E",
  INTERNAL_ORDER_BLOCK: "F",
  FVG: "G",
  RANGE_POSITION: "H",
  OB_FVG_CONFLUENCE: "I",
};

type ComponentStats = {
  longHits: number;
  shortHits: number;
  zero: number; // neither long nor short
  staleSoft: number; // counted via softCodes
};

function emptyCompStats(): ComponentStats {
  return { longHits: 0, shortHits: 0, zero: 0, staleSoft: 0 };
}

type PerExchangeResult = {
  exchange: string;
  marketId: number;
  exchangeSymbol: string;
  timeframe: SmcTimeframe;
  firstCandle: Date | null;
  lastCandle: Date | null;
  closedCandles: number;
  evaluatedPoints: number;
  cannotEvaluate: number;
  neutral: number;
  long: number;
  short: number;
  longPct: number;
  shortPct: number;
  avgLongScore: number | null;
  avgShortScore: number | null;
  scoreDistLong: Record<ScoreBucket, number>;
  scoreDistShort: Record<ScoreBucket, number>;
  scoreDistMax: Record<ScoreBucket, number>;
  components: Record<ComponentCode, ComponentStats>;
  bottleneckCombosBelow: Map<string, number>; // key = sorted comps that gave points for winning side
  bottleneckCombosAbove: Map<string, number>;
  lastEvaluations: Array<{ time: Date; eval: SmcEvaluation }>; // for E
};

function createDist(): Record<ScoreBucket, number> {
  return { "0-19": 0, "20-39": 0, "40-59": 0, "60-71": 0, "72-79": 0, "80-89": 0, "90-100": 0 };
}

async function evaluateMarketHistory(
  market: { id: number; exchange: string; exchangeSymbol: string },
  timeframe: SmcTimeframe,
  config: SmcScoringConfig,
  limit: number | null,
  lastN: number | null
): Promise<PerExchangeResult> {
  // READ-ONLY: only findMany
  const db = await getPrisma();
  const candlesRaw = await db.candle.findMany({
    where: {
      marketId: market.id,
      timeframe,
      closed: true,
    },
    orderBy: { openTime: "asc" },
    ...(limit ? { take: limit } : {}),
    select: {
      openTime: true,
      open: true,
      high: true,
      low: true,
      close: true,
      closed: true,
    },
  });

  const result: PerExchangeResult = {
    exchange: market.exchange,
    marketId: market.id,
    exchangeSymbol: market.exchangeSymbol,
    timeframe,
    firstCandle: candlesRaw[0]?.openTime ?? null,
    lastCandle: candlesRaw[candlesRaw.length - 1]?.openTime ?? null,
    closedCandles: candlesRaw.length,
    evaluatedPoints: 0,
    cannotEvaluate: 0,
    neutral: 0,
    long: 0,
    short: 0,
    longPct: 0,
    shortPct: 0,
    avgLongScore: null,
    avgShortScore: null,
    scoreDistLong: createDist(),
    scoreDistShort: createDist(),
    scoreDistMax: createDist(),
    components: {
      A: emptyCompStats(),
      B: emptyCompStats(),
      C: emptyCompStats(),
      D: emptyCompStats(),
      E: emptyCompStats(),
      F: emptyCompStats(),
      G: emptyCompStats(),
      H: emptyCompStats(),
      I: emptyCompStats(),
    },
    bottleneckCombosBelow: new Map(),
    bottleneckCombosAbove: new Map(),
    lastEvaluations: [],
  };

  if (candlesRaw.length === 0) return result;

  // Convert to SmcRawCandle
  const allCandles: SmcRawCandle[] = candlesRaw.map((c: any) => ({
    openTime: c.openTime,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    closed: true as const,
  }));

  const durationMs = SMCTIMEFRAME_MS[timeframe];
  // Evaluate sliding window: for each i >= minHistory, asOf = openTime[i] + duration
  // Using effectiveCloseTime logic: openTime + duration
  const minHistory = 84; // minimumSwingHistoryCandles for 20/20 = 84
  let sumLong = 0;
  let sumShort = 0;
  let countLong = 0;
  let countShort = 0;

  const startIdx = Math.max(minHistory, lastN ? Math.max(0, allCandles.length - lastN) : minHistory);
  const endIdx = allCandles.length - 1; // last candle is evaluable as history, asOf = its close

  for (let i = startIdx; i <= endIdx; i++) {
    const prefix = allCandles.slice(0, i + 1);
    const asOf = new Date(prefix[prefix.length - 1].openTime.getTime() + durationMs);
    let evaluation: SmcEvaluation;
    try {
      evaluation = evaluateSmc(prefix, config, asOf);
    } catch (e) {
      // SmcInputError or other validation -> count as CANNOT_EVALUATE
      result.cannotEvaluate++;
      continue;
    }

    result.evaluatedPoints++;

    // Track last 5 for STEP E
    if (i >= endIdx - 4) {
      result.lastEvaluations.push({ time: prefix[prefix.length - 1].openTime, eval: evaluation });
    }

    if (evaluation.direction === "CANNOT_EVALUATE") {
      result.cannotEvaluate++;
      // components zero?
      for (const reason of evaluation.reasons) {
        const comp = CODE_TO_COMP[reason.code];
        if (comp) {
          result.components[comp].zero++;
        }
      }
      // score dist for null -> 0-19
      result.scoreDistLong["0-19"]++;
      result.scoreDistShort["0-19"]++;
      result.scoreDistMax["0-19"]++;
      continue;
    }

    // NEUTRAL / LONG / SHORT
    const longScore = evaluation.longScore ?? 0;
    const shortScore = evaluation.shortScore ?? 0;
    const maxScore = Math.max(longScore, shortScore);

    // Score dist
    result.scoreDistLong[bucket(longScore)]++;
    result.scoreDistShort[bucket(shortScore)]++;
    result.scoreDistMax[bucket(maxScore)]++;

    sumLong += longScore;
    sumShort += shortScore;
    countLong++;
    countShort++;

    if (evaluation.direction === "LONG") result.long++;
    else if (evaluation.direction === "SHORT") result.short++;
    else result.neutral++;

    // Components
    for (const reason of evaluation.reasons) {
      if (reason.code === "DIRECTION_CONFLICT") continue;
      const comp = CODE_TO_COMP[reason.code];
      if (!comp) continue;
      const stats = result.components[comp];
      if (reason.longPoints > 0) stats.longHits++;
      else if (reason.shortPoints > 0) stats.shortHits++;
      else stats.zero++;

      // stale via softCodes
      // softCodes are in evaluation.availability.softUnavailable
    }

    // Count stale via softUnavailable codes mapping
    const softMap: Record<string, ComponentCode> = {
      STRUCTURE_UNDEFINED: "A",
      STRUCTURE_TRANSITION: "A",
      NO_RECENT_LIQUIDITY_SWEEP: "D",
      NO_SWING_ORDER_BLOCK: "E",
      NO_INTERNAL_ORDER_BLOCK: "F",
      NO_ACTIVE_FVG: "G",
      NO_ACTIVE_DEALING_RANGE: "H",
      // B has no soft code? It just 0 when no fresh BOS
    };
    for (const soft of evaluation.availability.softUnavailable) {
      const comp = softMap[soft.code];
      if (comp) result.components[comp].staleSoft++;
      // For B, we detect zero as stale
      if (soft.code === "NO_SWING_ORDER_BLOCK" || soft.code === "NO_INTERNAL_ORDER_BLOCK" || soft.code === "NO_ACTIVE_FVG" || soft.code === "NO_RECENT_LIQUIDITY_SWEEP" || soft.code === "NO_ACTIVE_DEALING_RANGE") {
        // already counted
      }
    }
    // For B, if zero then stale
    const bReason = evaluation.reasons.find((r) => r.code === "RECENT_SWING_BOS");
    if (bReason && bReason.longPoints === 0 && bReason.shortPoints === 0) {
      result.components["B"].zero++;
      // Consider stale if no fresh BOS
      // We count as staleSoft for B when zero
      result.components["B"].staleSoft++;
    }

    // Bottleneck analysis for 60<=max<72 and >=72
    if (maxScore >= 60 && maxScore < 72) {
      // Winning side
      const winningSide = longScore >= shortScore ? "LONG" : "SHORT";
      const winningReasons = evaluation.reasons.filter((r) =>
        winningSide === "LONG" ? r.longPoints > 0 : r.shortPoints > 0
      );
      const comboKey = winningReasons
        .map((r) => CODE_TO_COMP[r.code] ?? r.code)
        .filter(Boolean)
        .sort()
        .join("+");
      const keyWithScore = `${comboKey} =${maxScore} ${winningSide}`;
      // For TOP-10 we want combo without score, but also keep score example
      const simpleKey = comboKey || "(none)";
      result.bottleneckCombosBelow.set(simpleKey, (result.bottleneckCombosBelow.get(simpleKey) ?? 0) + 1);
    } else if (maxScore >= 72) {
      const winningSide = longScore >= shortScore ? "LONG" : "SHORT";
      const winningReasons = evaluation.reasons.filter((r) =>
        winningSide === "LONG" ? r.longPoints > 0 : r.shortPoints > 0
      );
      const comboKey = winningReasons
        .map((r) => CODE_TO_COMP[r.code] ?? r.code)
        .filter(Boolean)
        .sort()
        .join("+");
      const simpleKey = comboKey || "(none)";
      result.bottleneckCombosAbove.set(simpleKey, (result.bottleneckCombosAbove.get(simpleKey) ?? 0) + 1);
    }
  }

  result.avgLongScore = countLong > 0 ? sumLong / countLong : null;
  result.avgShortScore = countShort > 0 ? sumShort / countShort : null;
  result.longPct = result.evaluatedPoints > 0 ? (result.long / result.evaluatedPoints) * 100 : 0;
  result.shortPct = result.evaluatedPoints > 0 ? (result.short / result.evaluatedPoints) * 100 : 0;

  return result;
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`=== SMART MONEY HISTORICAL FREQUENCY — READ-ONLY — ${args.symbol} ${args.timeframes.join(",")} ===`);
  console.log(`Limit per market: ${args.limit ?? "ALL"} | Last N points: ${args.last ?? "ALL"}`);
  console.log(`BINGX 1d excluded via isSmartMoneyExchangeEligible`);
  console.log(`Config: canonical 72/20/20/3/3/14/10/5/20/20/0.02 weights 20/15/10/10/15/5/10/10/5`);
  console.log(`READ-ONLY: only SELECT, no writes, uses production evaluateSmc()\n`);

  // STEP A — production state
  console.log(`--- STEP A — PRODUCTION STATE smart-money-suslik ---`);
  try {
    const strategies = await (await getPrisma()).strategy.findMany({
      where: { slug: SMART_MONEY_SLUG },
      orderBy: [{ version: "desc" }],
      take: 5,
    });
    if (strategies.length === 0) {
      console.log(`No strategy found with slug ${SMART_MONEY_SLUG} — need seed`);
    } else {
      for (const s of strategies) {
        console.log(
          `id=${s.id} slug=${s.slug} v${s.version} enabled=${s.enabled} status=${s.status} timeframes=${s.timeframes.join(",")} minExchanges=${s.minExchanges}`
        );
        console.log(`config: ${JSON.stringify(s.config, null, 2)}`);
      }
    }
  } catch (e) {
    console.error(`Error loading Strategy: ${(e as Error).message}`);
  }

  // For each timeframe
  for (const timeframe of args.timeframes) {
    if (!isSmcTimeframe(timeframe)) {
      console.error(`Invalid timeframe ${timeframe} — skip`);
      continue;
    }

    const config = defaultSmcScoringConfig(timeframe);
    console.log(`\n\n=== TIMEFRAME ${timeframe} — CONFIG minScore ${config.minimumScore} swing ${config.swingLeft}/${config.swingRight} internal ${config.internalLeft}/${config.internalRight} ===`);

    // Load markets for BTC
    // READ-ONLY: findMany Asset + Market
    const asset = await (await getPrisma()).asset.findUnique({
      where: { symbol: args.symbol },
      select: { id: true, symbol: true, rank: true },
    });

    if (!asset) {
      console.error(`Asset ${args.symbol} not found — skip ${timeframe}`);
      continue;
    }

    const markets = await (await getPrisma()).market.findMany({
      where: {
        assetId: asset.id,
        enabled: true,
        status: "ACTIVE",
        quote: "USDT",
        marketType: "SPOT",
      },
      select: {
        id: true,
        exchange: true,
        exchangeSymbol: true,
        quoteVolume24h: true,
      },
      orderBy: { exchange: "asc" },
    });

    // Filter eligible via isSmartMoneyExchangeEligible
    const eligibleMarkets = markets.filter((m: any) => {
      try {
        return isSmartMoneyExchangeEligible(m.exchange as any, timeframe as any);
      } catch {
        return false;
      }
    });

    console.log(`Eligible markets for ${args.symbol} ${timeframe}: ${eligibleMarkets.length}/${markets.length} (BINGX 1d excluded) — ${eligibleMarkets.map((m: any) => m.exchange).join(",")}`);

    const perExchangeResults: PerExchangeResult[] = [];

    for (const market of eligibleMarkets) {
      console.log(`\n-- Evaluating ${market.exchange} ${market.exchangeSymbol} id=${market.id} ${timeframe} --`);
      const res = await evaluateMarketHistory(market as any, timeframe, config, args.limit, args.last);
      perExchangeResults.push(res);

      console.log(
        `  first=${res.firstCandle?.toISOString() ?? "—"} last=${res.lastCandle?.toISOString() ?? "—"} closed=${res.closedCandles} evaluated=${res.evaluatedPoints} CANNOT=${res.cannotEvaluate} NEUTRAL=${res.neutral} LONG=${res.long} SHORT=${res.short} LONG%=${res.longPct.toFixed(3)}% SHORT%=${res.shortPct.toFixed(3)}% avgLong=${res.avgLongScore?.toFixed(2) ?? "—"} avgShort=${res.avgShortScore?.toFixed(2) ?? "—"}`
      );
      console.log(`  ScoreDist MAX: ${JSON.stringify(res.scoreDistMax)}`);
      console.log(`  ScoreDist LONG: ${JSON.stringify(res.scoreDistLong)}`);
      console.log(`  ScoreDist SHORT: ${JSON.stringify(res.scoreDistShort)}`);
      console.log(`  Components:`);
      for (const comp of ["A", "B", "C", "D", "E", "F", "G", "H", "I"] as ComponentCode[]) {
        const st = res.components[comp];
        console.log(`    ${comp}: longHits=${st.longHits} shortHits=${st.shortHits} zero=${st.zero} staleSoft=${st.staleSoft}`);
      }

      // Bottleneck TOP-10 below
      const belowSorted = [...res.bottleneckCombosBelow.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      console.log(`  TOP-10 combos 60<=max<72 (bottleneck below 72):`);
      for (const [combo, cnt] of belowSorted) {
        console.log(`    ${combo}: ${cnt}`);
      }
      const aboveSorted = [...res.bottleneckCombosAbove.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      console.log(`  TOP-10 combos >=72 (real signals):`);
      for (const [combo, cnt] of aboveSorted) {
        console.log(`    ${combo}: ${cnt}`);
      }

      // STEP E — last evaluations exact decomposition
      if (res.lastEvaluations.length > 0) {
        console.log(`  LAST ${res.lastEvaluations.length} evaluations exact decomposition (STEP E):`);
        for (const { time, eval: ev } of res.lastEvaluations) {
          console.log(`    Time ${time.toISOString()} direction=${ev.direction} longScore=${ev.longScore} shortScore=${ev.shortScore} asOf=${ev.asOf.toISOString()} tf=${ev.tf}`);
          console.log(`      Availability evaluable=${ev.availability.evaluable} hard=${ev.availability.hardFailures.map((h) => h.code).join(",") || "—"} soft=${ev.availability.softUnavailable.map((s) => s.code).join(",") || "—"}`);
          if (ev.swingStructure) console.log(`      Swing phase=${ev.swingStructure.phase} pivots=${ev.swingStructure.pivots.length} events=${ev.swingStructure.events.length} levels=${ev.swingStructure.levels.length}`);
          if (ev.internalStructure) console.log(`      Internal phase=${ev.internalStructure.phase} pivots=${ev.internalStructure.pivots.length} events=${ev.internalStructure.events.length}`);
          console.log(`      Displacements=${ev.displacements.length} FVGs=${ev.fvgs.length} Liquidity=${ev.liquidity.length} swingOB=${ev.swingOrderBlocks.length} internalOB=${ev.internalOrderBlocks.length} range=${ev.dealingRange?.current ? "YES" : "NO"} zone=${ev.dealingRange?.priceContext?.zone ?? "—"}`);
          console.log(`      Reasons:`);
          for (const r of ev.reasons) {
            console.log(`        ${CODE_TO_COMP[r.code] ?? r.code} ${r.code}: long=${r.longPoints} short=${r.shortPoints} max=${r.maxPoints} label="${r.label}" value=${r.value ?? "—"}`);
          }
          // Facts details for protected high/low, BOS/CHOCH, sweep, OB, FVG, premium/discount, ATR
          // We can show last BOS/CHOCH from swing events
          const lastBos = ev.swingStructure?.events.filter((e) => e.type === "BOS").slice(-1)[0];
          const lastChoch = ev.swingStructure?.events.filter((e) => e.type === "CHOCH").slice(-1)[0];
          console.log(`      Last BOS: ${lastBos ? `${lastBos.dir} key=${lastBos.brokenPivotKey} price=${lastBos.brokenLevelPrice} eventTime=${lastBos.eventTime.toISOString()} confirmedAt=${lastBos.confirmedAt.toISOString()} protectedAnchor=${lastBos.protectedAnchor?.pivotKey ?? "—"} price=${lastBos.protectedAnchor?.price ?? "—"}` : "—"}`);
          console.log(`      Last CHOCH: ${lastChoch ? `${lastChoch.dir} key=${lastChoch.brokenPivotKey} price=${lastChoch.brokenLevelPrice} eventTime=${lastChoch.eventTime.toISOString()} confirmedAt=${lastChoch.confirmedAt.toISOString()}` : "—"}`);
          // protected high/low from levels
          const protectedHigh = ev.swingStructure?.levels.filter((l) => l.kind === "high" && l.state === "AVAILABLE").slice(-1)[0];
          const protectedLow = ev.swingStructure?.levels.filter((l) => l.kind === "low" && l.state === "AVAILABLE").slice(-1)[0];
          console.log(`      Protected High: ${protectedHigh ? `price=${protectedHigh.price} pivotKey=${protectedHigh.pivotKey} eventTime=${protectedHigh.eventTime.toISOString()} confirmedAt=${protectedHigh.confirmedAt.toISOString()} state=${protectedHigh.state}` : "—"}`);
          console.log(`      Protected Low: ${protectedLow ? `price=${protectedLow.price} pivotKey=${protectedLow.pivotKey} eventTime=${protectedLow.eventTime.toISOString()} confirmedAt=${protectedLow.confirmedAt.toISOString()} state=${protectedLow.state}` : "—"}`);
          // last sweep
          const lastSweep = ev.liquidity.filter((l) => l.state === "SWEPT").slice(-1)[0];
          console.log(`      Last Sweep: ${lastSweep ? `side=${lastSweep.side} price=${lastSweep.price} resolvedAt=${lastSweep.resolvedAt?.toISOString() ?? "—"} state=${lastSweep.state}` : "—"}`);
          // swing OB
          const lastSwingOb = ev.swingOrderBlocks.filter((ob) => ob.state === "OPEN" || ob.state === "MITIGATED").slice(-1)[0];
          console.log(`      Swing OB: ${lastSwingOb ? `dir=${lastSwingOb.direction} key=${lastSwingOb.key} bottom=${lastSwingOb.bottom} top=${lastSwingOb.top} state=${lastSwingOb.state} confirmedAt=${lastSwingOb.confirmedAt.toISOString()}` : "—"}`);
          const lastInternalOb = ev.internalOrderBlocks.filter((ob) => ob.state === "OPEN" || ob.state === "MITIGATED").slice(-1)[0];
          console.log(`      Internal OB: ${lastInternalOb ? `dir=${lastInternalOb.direction} key=${lastInternalOb.key} bottom=${lastInternalOb.bottom} top=${lastInternalOb.top} state=${lastInternalOb.state}` : "—"}`);
          const lastFvg = ev.fvgs.filter((f) => f.state === "OPEN" || f.state === "TOUCHED" || f.state === "CE_MITIGATED").slice(-1)[0];
          console.log(`      FVG: ${lastFvg ? `dir=${lastFvg.direction} key=${lastFvg.key} bottom=${lastFvg.bottom} top=${lastFvg.top} state=${lastFvg.state}` : "—"}`);
          console.log(`      Dealing Range: ${ev.dealingRange?.current ? `low=${ev.dealingRange.current.low} high=${ev.dealingRange.current.high} zone=${ev.dealingRange.priceContext?.zone} pos=${ev.dealingRange.priceContext?.position}` : "NO"}`);
          // ATR - from facts? We don't have ATR directly, but we can compute from last candle? For now show from config atrPeriod
          console.log(`      ATR period ${config.atrPeriod} — effective horizon ${time.toISOString()} -> asOf ${ev.asOf.toISOString()}`);
        }
      }
    }

    // STEP C — MULTI-EXCHANGE BASELINE common horizon
    console.log(`\n\n--- STEP C — MULTI-EXCHANGE BASELINE ${timeframe} ---`);
    try {
      // Load candles for all eligible markets
      const marketCandles: CommonHorizonMarket[] = [];
      for (const market of eligibleMarkets) {
        const candlesRaw = await (await getPrisma()).candle.findMany({
          where: { marketId: market.id, timeframe, closed: true },
          orderBy: { openTime: "asc" },
          ...(args.limit ? { take: args.limit } : {}),
          select: {
            openTime: true,
            open: true,
            high: true,
            low: true,
            close: true,
            closed: true,
          },
        });
        const smcCandles: SmcRawCandle[] = candlesRaw.map((c: any) => ({
          openTime: c.openTime,
          open: c.open,
          high: c.high,
          low: c.low,
          close: c.close,
          closed: true as const,
        }));
        marketCandles.push({
          exchange: market.exchange,
          marketId: market.id,
          candles: smcCandles,
        });
      }

      if (marketCandles.length === 0) {
        console.log(`No eligible markets with candles for ${timeframe}`);
        continue;
      }

      // Compute common horizons by intersection of timestamps
      // For simplicity, use selectCommonClosedHorizon iteratively? We need all common timestamps, not just latest.
      // We'll compute intersection set of all openTimes that are canonical and closed.
      const timeSets = marketCandles.map((m) => new Set(m.candles.map((c) => c.openTime.getTime())));
      let intersection = new Set<number>(timeSets[0]);
      for (let i = 1; i < timeSets.length; i++) {
        const next = new Set<number>();
        for (const t of intersection) if (timeSets[i].has(t)) next.add(t);
        intersection = next;
      }
      const commonTimes = [...intersection].sort((a, b) => a - b);
      console.log(`Common timestamps across ${marketCandles.length} exchanges: ${commonTimes.length} (out of max ${Math.max(...marketCandles.map((m) => m.candles.length))})`);

      // For last N common times, evaluate multi-exchange
      const evalTimes = args.last ? commonTimes.slice(-args.last) : commonTimes;
      let totalCommon = evalTimes.length;
      let evaluableHorizons = 0;
      let longAgg = 0;
      let shortAgg = 0;
      let neutralAgg = 0;
      let cannotAgg = 0;
      const confirmationDist: Record<string, number> = {};
      const longPer1000: number[] = [];
      const shortPer1000: number[] = [];

      for (const commonMs of evalTimes) {
        const commonDate = new Date(commonMs);
        const now = new Date(commonMs + SMCTIMEFRAME_MS[timeframe] * 2); // now = common + 2*D to make expectedLatestClosed = common
        const selection = selectCommonClosedHorizon(marketCandles, timeframe, { now });
        // We need to truncate to commonMs, not selection.commonHorizon which is latest common
        // For historical baseline, we force truncate to this commonMs
        const truncated = marketCandles.map((mc) => ({
          ...mc,
          candles: truncateCandlesToHorizon(mc.candles, commonDate),
        }));

        // Evaluate each market at this horizon
        const marketResults: any[] = [];
        for (const mc of truncated) {
          const prefix = mc.candles;
          if (prefix.length < 84) {
            marketResults.push({
              status: "cannot-evaluate" as const,
              exchange: mc.exchange,
              marketId: mc.marketId,
              reason: "INSUFFICIENT_HISTORY",
            });
            continue;
          }
          const asOf = new Date(commonDate.getTime() + SMCTIMEFRAME_MS[timeframe]);
          try {
            const ev = evaluateSmc(prefix, config, asOf);
            if (ev.direction === "CANNOT_EVALUATE") {
              marketResults.push({
                status: "cannot-evaluate" as const,
                exchange: mc.exchange,
                marketId: mc.marketId,
                reason: ev.availability.hardFailures.map((h) => h.code).join(","),
              });
            } else {
              marketResults.push({
                status: "evaluated" as const,
                exchange: mc.exchange,
                market: `${args.symbol}USDT`,
                marketId: mc.marketId,
                candleTime: commonDate,
                price: prefix[prefix.length - 1].close,
                longScore: ev.longScore ?? 0,
                shortScore: ev.shortScore ?? 0,
                direction: ev.direction as any,
                reasons: ev.reasons.map((r) => ({
                  label: r.code,
                  long: r.longPoints > 0,
                  short: r.shortPoints > 0,
                  weight: r.maxPoints,
                  value: r.value ?? undefined,
                })),
                warnings: [],
              });
            }
          } catch (e) {
            marketResults.push({
              status: "cannot-evaluate" as const,
              exchange: mc.exchange,
              marketId: mc.marketId,
              reason: (e as Error).message.slice(0, 100),
            });
          }
        }

        // Check if we have at least minExchanges evaluable
        const evaluable = marketResults.filter((m) => m.status === "evaluated");
        if (evaluable.length < 2) {
          cannotAgg++;
          continue;
        }

        evaluableHorizons++;
        const minExchanges = 3; // for SMC
        const agg = aggregateAssetGroup(args.symbol, timeframe, SMART_MONEY_SLUG, 1, marketResults as any, minExchanges);

        if (agg.direction === "LONG") longAgg++;
        else if (agg.direction === "SHORT") shortAgg++;
        else if (agg.conflict) {
          // conflict counts as NEUTRAL but we track
          neutralAgg++;
        } else {
          neutralAgg++;
        }

        // Confirmation distribution: e.g., "2/5", "3/5"
        const key = `${agg.confirmation}/${eligibleMarkets.length}`;
        confirmationDist[key] = (confirmationDist[key] ?? 0) + 1;

        // For per 1000 bars frequency, we will compute after loop
      }

      console.log(`Total common horizons: ${totalCommon} evaluable: ${evaluableHorizons} LONG agg: ${longAgg} SHORT agg: ${shortAgg} NEUTRAL agg: ${neutralAgg} CANNOT/no agg: ${cannotAgg}`);
      console.log(`LONG per 1000 bars: ${totalCommon > 0 ? ((longAgg / totalCommon) * 1000).toFixed(3) : "—"} | SHORT per 1000: ${totalCommon > 0 ? ((shortAgg / totalCommon) * 1000).toFixed(3) : "—"}`);
      console.log(`Confirmation distribution:`);
      for (const [k, v] of Object.entries(confirmationDist).sort()) {
        console.log(`  ${k}: ${v}`);
      }
    } catch (e) {
      console.error(`Error in multi-exchange baseline ${timeframe}: ${(e as Error).message}`);
      console.error((e as Error).stack);
    }
  }

  await (await getPrisma()).$disconnect();
  console.log(`\n=== DONE — READ-ONLY BASELINE ===`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
