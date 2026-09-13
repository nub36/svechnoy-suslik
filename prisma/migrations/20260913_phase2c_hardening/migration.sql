-- PHASE 2C — FINAL HARDENING
-- Fixes legacy classification, adds SignalOutcome, structured confirmation, removes optimistic fallback

-- Add LEGACY to enum if not exists (first migration had only 3 values, now 4)
-- PostgreSQL: ALTER TYPE ... ADD VALUE is not transactional in older versions, but we try
DO $$ BEGIN
  ALTER TYPE "SignalSource" ADD VALUE 'LEGACY';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Alter Signal.entry to nullable (was required, now nullable for WAITING_ENTRY)
ALTER TABLE "Signal" ALTER COLUMN "entry" DROP NOT NULL;

-- Add new structured confirmation columns if not exist
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "participantCount" INTEGER;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "evaluatedCount" INTEGER;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "longVotes" INTEGER;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "shortVotes" INTEGER;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "neutralVotes" INTEGER;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "confirmationCount" INTEGER;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "confirmationTotal" INTEGER;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "commonHorizonPolicy" TEXT;
ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "referenceFallback" BOOLEAN DEFAULT false;

-- Fix legacy classification: existing rows should be LEGACY, not LIVE_FORWARD
-- First migration set default LIVE_FORWARD, which would have auto-classified old rows as live
-- This update corrects: all rows where signalCandleTime IS NULL (legacy) or where signalSource = LIVE_FORWARD and created before this migration should become LEGACY
-- For safety, update all rows that have signalSource = LIVE_FORWARD and signalCandleTime IS NULL to LEGACY
UPDATE "Signal" SET "signalSource" = 'LEGACY' WHERE "signalCandleTime" IS NULL AND "signalSource" = 'LIVE_FORWARD';

-- Also, any rows that were seeded via seed-test-signal should be SEEDED, but we cannot distinguish automatically
-- Manual step after migration: UPDATE "Signal" SET "signalSource"='SEEDED' WHERE id IN (1,2) OR reason LIKE '%Тестовый сигнал%';

-- Change default to LEGACY to avoid future auto-classification as LIVE_FORWARD
ALTER TABLE "Signal" ALTER COLUMN "signalSource" SET DEFAULT 'LEGACY';

-- Create SignalOutcome table
CREATE TABLE IF NOT EXISTS "SignalOutcome" (
  "id" SERIAL PRIMARY KEY,
  "signalId" INTEGER NOT NULL UNIQUE,
  "status" TEXT NOT NULL DEFAULT 'WAITING_ENTRY',
  "entryTime" TIMESTAMP(3),
  "entryPrice" DOUBLE PRECISION,
  "stopLoss" DOUBLE PRECISION,
  "takeProfit1" DOUBLE PRECISION,
  "takeProfit2" DOUBLE PRECISION,
  "takeProfit3" DOUBLE PRECISION,
  "exitTime" TIMESTAMP(3),
  "exitPrice" DOUBLE PRECISION,
  "realizedR" DOUBLE PRECISION,
  "maxFavorableR" DOUBLE PRECISION,
  "maxAdverseR" DOUBLE PRECISION,
  "barsHeld" INTEGER,
  "tp1HitAt" TIMESTAMP(3),
  "tp2HitAt" TIMESTAMP(3),
  "tp3HitAt" TIMESTAMP(3),
  "executionPolicy" TEXT,
  "executionParams" JSONB,
  "atrAtSignal" DOUBLE PRECISION,
  "timeoutCandles" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "SignalOutcome_status_idx" ON "SignalOutcome"("status");
CREATE INDEX IF NOT EXISTS "SignalOutcome_entryTime_idx" ON "SignalOutcome"("entryTime");

-- Foreign key
DO $$ BEGIN
  ALTER TABLE "SignalOutcome" ADD CONSTRAINT "SignalOutcome_signalId_fkey" FOREIGN KEY ("signalId") REFERENCES "Signal"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- Ensure unique index for [strategyId, symbol, timeframe, signalCandleTime] exists (from phase 2B)
CREATE UNIQUE INDEX IF NOT EXISTS "Signal_strategyId_symbol_timeframe_signalCandleTime_key" ON "Signal"("strategyId", "symbol", "timeframe", "signalCandleTime");

-- Comment on NULL handling
COMMENT ON INDEX "Signal_strategyId_symbol_timeframe_signalCandleTime_key" IS 'One signal per candle per strategy/symbol/timeframe, direction NOT included to prevent LONG and SHORT on same candle. PostgreSQL NULL distinct: legacy NULLs allowed.';

