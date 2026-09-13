-- PHASE 2B — Signal identity + execution semantics
-- Adds signalCandleTime, referenceExchange, referencePrice, aggregatePrice, executionPolicy, signalSource, metadata, atrAtSignal, nextBarOpenPrice, nextBarOpenTime
-- And unique constraint [strategyId, symbol, timeframe, signalCandleTime] without direction
-- PHASE 2C FIX: default LEGACY, not LIVE_FORWARD, to avoid auto-classifying old rows as live

-- CreateEnum with LEGACY from start (PHASE 2C hardening)
CREATE TYPE "SignalSource" AS ENUM ('LIVE_FORWARD', 'SEEDED', 'BACKTEST', 'LEGACY');

-- AlterTable
ALTER TABLE "Signal" ADD COLUMN "signalCandleTime" TIMESTAMP(3);
ALTER TABLE "Signal" ADD COLUMN "referenceExchange" TEXT;
ALTER TABLE "Signal" ADD COLUMN "referencePrice" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "aggregatePrice" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "executionPolicy" TEXT;
-- PHASE 2C: default LEGACY to avoid auto-classifying old ID1/ID2 as LIVE_FORWARD
ALTER TABLE "Signal" ADD COLUMN "signalSource" "SignalSource" NOT NULL DEFAULT 'LEGACY';
ALTER TABLE "Signal" ADD COLUMN "metadata" JSONB;
ALTER TABLE "Signal" ADD COLUMN "atrAtSignal" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "nextBarOpenPrice" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "nextBarOpenTime" TIMESTAMP(3);

-- Fix legacy: existing rows (including ID1/ID2 seeded) become LEGACY, not LIVE_FORWARD
-- New real signals must explicitly set LIVE_FORWARD in application code
UPDATE "Signal" SET "signalSource" = 'LEGACY' WHERE "signalCandleTime" IS NULL;

-- CreateIndex
CREATE INDEX "Signal_symbol_timeframe_signalCandleTime_idx" ON "Signal"("symbol", "timeframe", "signalCandleTime");
CREATE INDEX "Signal_strategyId_signalCandleTime_idx" ON "Signal"("strategyId", "signalCandleTime");
CREATE INDEX "Signal_signalSource_idx" ON "Signal"("signalSource");

-- Create unique constraint without direction — one signal per candle per strategy/symbol/timeframe
-- PostgreSQL NULL handling: multiple NULLs allowed, so legacy rows with NULL are not constrained
-- Direction NOT included to prevent LONG and SHORT on same candle
CREATE UNIQUE INDEX "Signal_strategyId_symbol_timeframe_signalCandleTime_key" ON "Signal"("strategyId", "symbol", "timeframe", "signalCandleTime");
