/**
 * CRITICAL TEST: STRICT ATOMICITY
 * Signal create + Outcome create + State update either all commit or all rollback
 *
 * Test with stateful fake prisma.$transaction mock
 */

let passed = 0, failed = 0;
function ok(cond: boolean, label: string) {
  if (cond) { passed++; console.log(`✅ ${label}`); } else { failed++; console.log(`❌ FAIL: ${label}`); }
}

// Fake DB counts
type FakeDB = { signals: any[]; outcomes: any[]; states: any[] };

function createFakePrisma(failAt: "outcome" | "state" | "none") {
  const db: FakeDB = { signals: [], outcomes: [], states: [] };
  // Track inside transaction tentative writes, only commit on success
  const prisma = {
    _db: db,
    $transaction: async (cb: (tx: any) => Promise<any>) => {
      const tentativeSignals: any[] = [];
      const tentativeOutcomes: any[] = [];
      const tentativeStates: any[] = [];
      const tx = {
        signal: {
          create: async ({ data }: any) => {
            const created = { id: db.signals.length + tentativeSignals.length + 1, ...data };
            tentativeSignals.push(created);
            return created;
          },
        },
        signalOutcome: {
          create: async ({ data }: any) => {
            if (failAt === "outcome") throw new Error("Outcome create failed - DB connection lost");
            const created = { id: db.outcomes.length + tentativeOutcomes.length + 1, ...data };
            tentativeOutcomes.push(created);
            return created;
          },
        },
        strategySignalState: {
          findUnique: async () => null,
          create: async ({ data }: any) => {
            if (failAt === "state") throw new Error("State update failed - constraint violation");
            const created = { id: db.states.length + tentativeStates.length + 1, ...data };
            tentativeStates.push(created);
            return created;
          },
          update: async () => {
            if (failAt === "state") throw new Error("State update failed - deadlock");
            return { id: 1 };
          },
        },
      };
      try {
        const res = await cb(tx);
        // Commit only if cb succeeds
        db.signals.push(...tentativeSignals);
        db.outcomes.push(...tentativeOutcomes);
        db.states.push(...tentativeStates);
        return res;
      } catch (e) {
        // Rollback — discard tentative
        throw e;
      }
    },
  };
  return prisma;
}

async function runScenario(failAt: "outcome" | "state" | "none", label: string) {
  const prisma = createFakePrisma(failAt);
  const candidate = {
    symbol: "BTC",
    timeframe: "15m",
    direction: "SHORT",
    score: 80,
    entry: 77000,
    stopLoss: 78000,
    takeProfit1: 76000,
    takeProfit2: 75000,
    takeProfit3: 74000,
    executionStatus: "READY",
    reason: "test",
    strategyId: 1,
    signalCandleTime: new Date("2026-09-13T08:15:00Z"),
    referenceExchange: "BINANCE",
    referencePrice: 77000,
    aggregatePrice: 77000,
    executionPolicy: "SMC_ATR_V1",
    metadata: { longVotes: 0, shortVotes: 3, neutralVotes: 0, policy: "QUORUM" },
    atrAtSignal: 100,
    entryTime: new Date("2026-09-13T08:30:00Z"),
    participantCount: 3,
    evaluatedCount: 3,
    confirmationCount: 3,
    confirmationTotal: 3,
    executionParams: { timeoutCandles: 20 },
    referenceFallback: false,
  };
  const transition = { triggerType: "EDGE", reason: "test", action: "EMIT" };
  const setupKey = "test-key";

  try {
    await (prisma as any).$transaction(async (tx: any) => {
      const created = await tx.signal.create({
        data: {
          symbol: candidate.symbol,
          timeframe: candidate.timeframe,
          direction: candidate.direction,
          score: candidate.score,
          entry: candidate.entry,
          stopLoss: candidate.stopLoss,
          takeProfit1: candidate.takeProfit1,
          takeProfit2: candidate.takeProfit2,
          takeProfit3: candidate.takeProfit3,
          status: "ACTIVE",
          reason: candidate.reason,
          strategyId: candidate.strategyId,
          signalCandleTime: candidate.signalCandleTime,
          referenceExchange: candidate.referenceExchange,
          referencePrice: candidate.referencePrice,
          aggregatePrice: candidate.aggregatePrice,
          executionPolicy: candidate.executionPolicy,
          signalSource: "LIVE_FORWARD",
          metadata: candidate.metadata,
          atrAtSignal: candidate.atrAtSignal,
          nextBarOpenPrice: candidate.entry,
          nextBarOpenTime: candidate.entryTime,
          participantCount: candidate.participantCount,
          evaluatedCount: candidate.evaluatedCount,
          longVotes: candidate.metadata.longVotes,
          shortVotes: candidate.metadata.shortVotes,
          neutralVotes: candidate.metadata.neutralVotes,
          confirmationCount: candidate.confirmationCount,
          confirmationTotal: candidate.confirmationTotal,
          commonHorizonPolicy: candidate.metadata.policy,
          referenceFallback: candidate.referenceFallback,
          setupKey,
          triggerType: transition.triggerType,
        },
      });
      const outcome = await tx.signalOutcome.create({
        data: {
          signalId: created.id,
          status: "OPEN",
          entryTime: candidate.entryTime,
          entryPrice: candidate.entry,
          stopLoss: candidate.stopLoss,
          takeProfit1: candidate.takeProfit1,
          takeProfit2: candidate.takeProfit2,
          takeProfit3: candidate.takeProfit3,
          executionPolicy: candidate.executionPolicy,
          executionParams: candidate.executionParams,
          atrAtSignal: candidate.atrAtSignal,
          timeoutCandles: candidate.executionParams.timeoutCandles,
        },
      });
      await tx.strategySignalState.create({
        data: {
          strategyId: candidate.strategyId,
          symbol: candidate.symbol,
          timeframe: candidate.timeframe,
          lastEvaluatedCandleTime: candidate.signalCandleTime,
          aggregateState: candidate.direction,
          lastSignalCandleTime: candidate.signalCandleTime,
          lastSignalDirection: candidate.direction,
          lastEvaluationStatus: candidate.direction,
          metadata: { lastReason: transition.reason },
        },
      });
    });

    if (failAt === "none") {
      ok((prisma as any)._db.signals.length === 1, `${label}: signals=1 committed`);
      ok((prisma as any)._db.outcomes.length === 1, `${label}: outcomes=1 committed`);
      ok((prisma as any)._db.states.length === 1, `${label}: states=1 committed`);
    } else {
      ok(false, `${label}: should have thrown but did not`);
    }
  } catch (e: any) {
    if (failAt !== "none") {
      ok((prisma as any)._db.signals.length === 0, `${label}: Signal count unchanged after rollback (0)`);
      ok((prisma as any)._db.outcomes.length === 0, `${label}: Outcome count unchanged after rollback (0)`);
      ok((prisma as any)._db.states.length === 0, `${label}: State unchanged after rollback (0)`);
      console.log(`  Expected error caught: ${e.message} — rollback verified`);
    } else {
      ok(false, `${label}: unexpected error ${e.message}`);
    }
  }
}

(async () => {
  console.log("=== TRANSACTION ATOMICITY TESTS ===");
  await runScenario("none", "Happy path all commit");
  await runScenario("outcome", "1. Signal succeeds, Outcome throws => all rollback");
  await runScenario("state", "2. Signal+Outcome succeed, State throws => all rollback");
  console.log(`\n=== RESULT: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) process.exit(1);
})();
