-- EDGE/RE-ARM V1: persistent state survives PM2 restart
-- One persistent regime 08:15..10:45 should be ONE signal, not 11

CREATE TABLE IF NOT EXISTS "StrategySignalState" (
  "id" SERIAL PRIMARY KEY,
  "strategyId" INTEGER NOT NULL,
  "symbol" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "lastEvaluatedCandleTime" TIMESTAMP(3),
  "aggregateState" TEXT NOT NULL DEFAULT 'NEUTRAL',
  "lastSignalCandleTime" TIMESTAMP(3),
  "lastSignalDirection" TEXT,
  "lastEvaluationStatus" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "StrategySignalState_strategyId_symbol_timeframe_key" ON "StrategySignalState"("strategyId", "symbol", "timeframe");
CREATE INDEX IF NOT EXISTS "StrategySignalState_symbol_timeframe_idx" ON "StrategySignalState"("symbol", "timeframe");
CREATE INDEX IF NOT EXISTS "StrategySignalState_strategyId_idx" ON "StrategySignalState"("strategyId");
CREATE INDEX IF NOT EXISTS "StrategySignalState_aggregateState_idx" ON "StrategySignalState"("aggregateState");

-- Add setupKey and triggerType to Signal if not exists (from previous phase)
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "setupKey" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "triggerType" TEXT;
CREATE INDEX IF NOT EXISTS "Signal_setupKey_idx" ON "Signal"("setupKey");
CREATE INDEX IF NOT EXISTS "Signal_triggerType_idx" ON "Signal"("triggerType");

COMMENT ON TABLE "StrategySignalState" IS 'EDGE/RE-ARM V1 persistent state: survives PM2 restart, unique [strategyId,symbol,timeframe], stores lastEvaluatedCandleTime, aggregateState NEUTRAL/LONG/SHORT/CANNOT_EVALUATE/DATA_UNAVAILABLE etc, lastSignalCandleTime/Direction. Idempotent: same horizon no-op, older refused. Unavailable preserves state, no re-arm. Bootstrap without signal default.';
COMMENT ON COLUMN "Signal"."setupKey" IS 'Causal setup identity for research, not for production dedup V1. Hash of BOS key, OB key, FVG key etc.';
COMMENT ON COLUMN "Signal"."triggerType" IS 'EDGE or REVERSAL or BOOTSTRAP — how signal was triggered via edge state machine';
