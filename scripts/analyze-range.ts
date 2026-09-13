/**
 * TASK D — INVESTIGATE DEALING RANGE H
 * 1h H mostly unavailable. Determine why.
 * Count per timeframe: range available, unavailable, DISCOUNT, PREMIUM, EQUILIBRIUM, outside
 */

import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { defaultSmcScoringConfig, deriveSubConfigs } from "../lib/smc/config";
import { SMCTIMEFRAME_MS, type SmcRawCandle, type SmcTimeframe } from "../lib/smc/types";
import { evaluateDealingRange } from "../lib/smc/range";

const prisma = new PrismaClient();

async function analyzeRange(tf: SmcTimeframe, limit: number) {
  console.log(`\n=== RANGE AUDIT ${tf} last ${limit} ===`);
  const asset = await prisma.asset.findUnique({ where: { symbol: "BTC" }, select: { id: true } });
  const market = await prisma.market.findFirst({ where: { assetId: asset!.id, exchange: "BINANCE", enabled: true, status: "ACTIVE", quote: "USDT" }, select: { id: true } });
  const rows = await prisma.candle.findMany({ where: { marketId: market!.id, timeframe: tf, closed: true }, orderBy: { openTime: "desc" }, take: limit, select: { openTime: true, open: true, high: true, low: true, close: true, closed: true } });
  rows.reverse();
  const candles = rows as SmcRawCandle[];
  const cfg = defaultSmcScoringConfig(tf);
  const subs = deriveSubConfigs(cfg);

  let available = 0, unavailable = 0;
  let discount = 0, premium = 0, equilibrium = 0, outside = 0;
  let reasons: Record<string, number> = {};

  for (let i = 84; i < candles.length; i++) {
    const slice = candles.slice(0, i + 1);
    const asOf = new Date(slice[slice.length - 1].openTime.getTime() + SMCTIMEFRAME_MS[tf]);
    try {
      const evalRange = evaluateDealingRange(slice as any, subs.range, asOf);
      if (evalRange.current) {
        available++;
        const zone = evalRange.priceContext?.zone;
        if (zone === "DISCOUNT") discount++;
        else if (zone === "PREMIUM") premium++;
        else if (zone === "EQUILIBRIUM") equilibrium++;
        if (evalRange.priceContext?.outsideRange) outside++;
      } else {
        unavailable++;
        // Reason: no BOS yet, or CHOCH closed range, or protectedAnchor null
        const key = evalRange.history.length === 0 ? "no BOS ever" : "CHOCH closed or no active BOS";
        reasons[key] = (reasons[key] || 0) + 1;
      }
    } catch (e) {
      unavailable++;
      const msg = (e as Error).message.slice(0, 50);
      reasons[msg] = (reasons[msg] || 0) + 1;
    }
  }

  console.log(`Available: ${available}, Unavailable: ${unavailable}, total ${available + unavailable}`);
  console.log(`DISCOUNT=${discount} PREMIUM=${premium} EQUILIBRIUM=${equilibrium} outside=${outside}`);
  console.log(`Reasons unavailable: ${JSON.stringify(reasons)}`);
  console.log(`\nInterpretation for ${tf}:`);
  console.log(`- Range requires BOS with protectedAnchor != null. If swing structure in REVERSAL_PENDING or UNDEFINED, or BOS has null anchor, no range.`);
  console.log(`- On higher TF, BOS frequency low, CHOCH closes range, so periods without active range are expected.`);
  console.log(`- eqBand=0.02 creates narrow equilibrium [0.48,0.52], so most available will be DISCOUNT/PREMIUM, not EQUILIBRIUM.`);
}

async function main() {
  for (const tf of ["15m", "1h", "4h", "1d"] as SmcTimeframe[]) {
    const limit = tf === "15m" ? 1000 : tf === "1h" ? 2000 : tf === "4h" ? 1000 : 500;
    await analyzeRange(tf, limit);
  }
  await prisma.$disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
