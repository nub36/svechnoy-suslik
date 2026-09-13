-- PHASE 2B — Signal identity + execution semantics
-- Adds signalCandleTime, referenceExchange, referencePrice, aggregatePrice, executionPolicy, signalSource, metadata, atrAtSignal, nextBarOpenPrice, nextBarOpenTime
-- And unique constraint [strategyId, symbol, timeframe, signalCandleTime] without direction

-- CreateEnum
CREATE TYPE "SignalSource" AS ENUM ('LIVE_FORWARD', 'SEEDED', 'BACKTEST');

-- AlterTable
ALTER TABLE "Signal" ADD COLUMN "signalCandleTime" TIMESTAMP(3);
ALTER TABLE "Signal" ADD COLUMN "referenceExchange" TEXT;
ALTER TABLE "Signal" ADD COLUMN "referencePrice" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "aggregatePrice" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "executionPolicy" TEXT;
ALTER TABLE "Signal" ADD COLUMN "signalSource" "SignalSource" NOT NULL DEFAULT 'LIVE_FORWARD';
ALTER TABLE "Signal" ADD COLUMN "metadata" JSONB;
ALTER TABLE "Signal" ADD COLUMN "atrAtSignal" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "nextBarOpenPrice" DOUBLE PRECISION;
ALTER TABLE "Signal" ADD COLUMN "nextBarOpenTime" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Signal_symbol_timeframe_signalCandleTime_idx" ON "Signal"("symbol", "timeframe", "signalCandleTime");
CREATE INDEX "Signal_strategyId_signalCandleTime_idx" ON "Signal"("strategyId", "signalCandleTime");
CREATE INDEX "Signal_signalSource_idx" ON "Signal"("signalSource");

-- Create unique constraint without direction — one signal per candle per strategy/symbol/timeframe
-- PostgreSQL NULL handling: multiple NULLs allowed, so legacy rows with NULL are not constrained
CREATE UNIQUE INDEX "Signal_strategyId_symbol_timeframe_signalCandleTime_key" ON "Signal"("strategyId", "symbol", "timeframe", "signalCandleTime");
