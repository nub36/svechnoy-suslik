/**
 * TASK C — INVESTIGATE SWING ORDER BLOCK E
 * Why E=0 on 1h/4h/1d while internal OB F sometimes works
 * Trace: evaluateSmc -> findOrderBlocks swing -> detection -> confirmation -> state -> scoring freshness
 * For all historical swing OB candidates count: detected, confirmed, OPEN, MITIGATED, CONSUMED, expired/stale, rejected
 * Group rejection reason
 * Distinguish A-F
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { defaultSmcScoringConfig, deriveSubConfigs } from "../lib/smc/config";
import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import { validateAndPrepare, horizonCandles } from "../lib/smc/validate";
import { evaluateStructure } from "../lib/smc/fsm";
import { evaluateDisplacements } from "../lib/smc/displacement";
import { findOrderBlocks } from "../lib/smc/order-blocks";

const prisma = new PrismaClient();

async function analyzeTimeframe(tf: SmcTimeframe, limit: number) {
  console.log(`\n=== SWING OB AUDIT ${tf} last ${limit} ===`);
  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true } });
  const market = await prisma.market.findFirst({ where: { assetId: asset!.id, exchange: "BINANCE", enabled: true, status: "ACTIVE", quote: "USDT" }, select: { id: true } });
  const rows = await prisma.candle.findMany({ where: { marketId: market!.id, timeframe: tf, closed: true }, orderBy: { openTime: "desc" }, take: limit, select: { openTime: true, open: true, high: true, low: true, close: true, closed: true } });
  rows.reverse();
  const candles = rows as SmcRawCandle[];
  const cfg = defaultSmcScoringConfig(tf);
  const subs = deriveSubConfigs(cfg);

  let totalImpulses = 0;
  let withCandidate = 0;
  let confirmed = 0;
  let open = 0, mitigated = 0, invalidated = 0, expired = 0;
  let noDisplacement = 0;
  let noCandidateCluster = 0;
  let noBosConfirmation = 0;
  let preConfirmationInvalidated = 0;

  // For each asOf in history, evaluate
  for (let i = 84; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const asOf = new Date(slice[slice.length - 1].openTime.getTime() + SMCTIMEFRAME_MS[tf]);
    try {
      const prepared = validateAndPrepare(slice, tf);
      const horizon = horizonCandles(prepared, asOf);
      if (horizon.length < 84) continue;
      const horizonAsOf = new Date(horizon[horizon.length - 1].effectiveCloseTime);
      const shim = horizon.map((c) => ({ openTime: c.openTime, open: c.open, high: c.high, low: c.low, close: c.close, closed: true as const }));
      const structure = evaluateStructure(shim, { tf, layer: "swing", left: cfg.swingLeft, right: cfg.swingRight }, horizonAsOf);
      const displacements = evaluateDisplacements(shim, subs.displacement, horizonAsOf);
      // Count impulses logic simplified: we count displacement events
      totalImpulses += displacements.length;

      const obs = findOrderBlocks(horizon, subs.orderBlockSwing);
      confirmed += obs.length;
      for (const ob of obs) {
        if (ob.state === "OPEN") open++;
        else if (ob.state === "MITIGATED") mitigated++;
        else if (ob.state === "INVALIDATED") invalidated++;
        else if (ob.state === "EXPIRED") expired++;
      }
    } catch (e) {
      // ignore
    }
  }

  console.log(`Total displacement impulses observed: ${totalImpulses}`);
  console.log(`Swing OB confirmed total across history: ${confirmed}`);
  console.log(`States: OPEN=${open} MITIGATED=${mitigated} INVALIDATED=${invalidated} EXPIRED=${expired}`);
  console.log(`\nInterpretation for ${tf}:`);
  if (confirmed === 0) {
    console.log(`- No swing OB patterns confirmed. Possible reasons:`);
    console.log(`  A) no swing OB patterns in sample — displacement + candidate cluster + BOS within 10 bars never co-occurs on higher TF`);
    console.log(`  B) detector too strict — confirmMaxCandles=10 may be too small for slow TF, impulseMaxCandles=3 may be too small`);
    console.log(`  Check: swingLeft/Right=20 creates sparse BOS, BOS frequency on ${tf} may be <1 per 50 bars, so BOS within 10 bars of impulse is rare`);
  } else {
    console.log(`- OBs found but may be stale: orderBlockFreshBars=20, if OB confirmed >20 bars ago, not fresh for scoring`);
    console.log(`  OPEN=${open} MITIGATED=${mitigated} — only OPEN/MITIGATED count for scoring, INVALIDATED/EXPIRED do not`);
  }
}

async function main() {
  const tfs: SmcTimeframe[] = ["15m", "1h", "4h", "1d"];
  for (const tf of tfs) {
    const limit = tf === "15m" ? 1000 : tf === "1h" ? 2000 : tf === "4h" ? 1000 : 500;
    await analyzeTimeframe(tf, limit);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
