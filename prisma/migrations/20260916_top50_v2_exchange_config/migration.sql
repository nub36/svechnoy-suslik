-- TOP-50 public site + Smart Money V2 + ExchangeConfig + Asset archive
-- Additive only, no DROP/TRUNCATE, safe for prisma migrate deploy

-- Asset: add archivedAt for soft archive
ALTER TABLE "Asset" ADD COLUMN IF NOT EXISTS "archivedAt" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "Asset_archivedAt_idx" ON "Asset"("archivedAt");

-- Strategy: add mode for DISABLED/DRY_RUN/FORWARD_TEST/LIVE
ALTER TABLE "Strategy" ADD COLUMN IF NOT EXISTS "mode" TEXT NOT NULL DEFAULT 'DISABLED';
CREATE INDEX IF NOT EXISTS "Strategy_mode_idx" ON "Strategy"("mode");

-- ExchangeConfig: public/ohlcv/live enabled, default, priority
CREATE TABLE IF NOT EXISTS "ExchangeConfig" (
  "id" SERIAL PRIMARY KEY,
  "exchange" TEXT NOT NULL UNIQUE,
  "publicEnabled" BOOLEAN NOT NULL DEFAULT true,
  "ohlcvEnabled" BOOLEAN NOT NULL DEFAULT true,
  "liveEnabled" BOOLEAN NOT NULL DEFAULT true,
  "isDefault" BOOLEAN NOT NULL DEFAULT false,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "ExchangeConfig_publicEnabled_idx" ON "ExchangeConfig"("publicEnabled");
CREATE INDEX IF NOT EXISTS "ExchangeConfig_priority_idx" ON "ExchangeConfig"("priority");
CREATE INDEX IF NOT EXISTS "ExchangeConfig_isDefault_idx" ON "ExchangeConfig"("isDefault");

-- Seed default exchange configs: BINANCE default true priority 100, others ohlcvEnabled=false for VPS 2GB
-- PUBLIC Top-50 ingestion scans ONLY BINANCE by default (ohlcvEnabled=true)
-- Admin can manually enable OHLCV for other exchanges later
-- BTC dedicated worker does NOT use ExchangeConfig filtering, keeps 5 markets quorum 3/5
INSERT INTO "ExchangeConfig" ("exchange", "publicEnabled", "ohlcvEnabled", "liveEnabled", "isDefault", "priority")
VALUES 
  ('BINANCE', true, true, true, true, 100),
  ('BYBIT', true, false, true, false, 90),
  ('GATE', true, false, true, false, 80),
  ('KUCOIN', true, false, true, false, 70),
  ('BINGX', true, false, true, false, 60)
ON CONFLICT ("exchange") DO NOTHING;

-- StrategyResearchResult: store V2 research metrics
CREATE TABLE IF NOT EXISTS "StrategyResearchResult" (
  "id" SERIAL PRIMARY KEY,
  "strategyId" INTEGER NOT NULL REFERENCES "Strategy"("id") ON DELETE CASCADE,
  "model" TEXT NOT NULL,
  "timeframe" TEXT NOT NULL,
  "trainFrom" TIMESTAMP(3),
  "trainTo" TIMESTAMP(3),
  "validFrom" TIMESTAMP(3),
  "validTo" TIMESTAMP(3),
  "oosFrom" TIMESTAMP(3),
  "oosTo" TIMESTAMP(3),
  "metrics" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "StrategyResearchResult_strategyId_idx" ON "StrategyResearchResult"("strategyId");
CREATE INDEX IF NOT EXISTS "StrategyResearchResult_model_idx" ON "StrategyResearchResult"("model");
CREATE INDEX IF NOT EXISTS "StrategyResearchResult_timeframe_idx" ON "StrategyResearchResult"("timeframe");
CREATE INDEX IF NOT EXISTS "StrategyResearchResult_createdAt_idx" ON "StrategyResearchResult"("createdAt");

-- Comments
COMMENT ON COLUMN "Asset"."archivedAt" IS 'Soft archive: set timestamp when archived, NULL means active. OHLCV/Signals/Outcomes preserved.';
COMMENT ON COLUMN "Strategy"."mode" IS 'Strategy mode: DISABLED/DRY_RUN/FORWARD_TEST/LIVE — default DISABLED, LIVE not enabled in this task';
COMMENT ON TABLE "ExchangeConfig" IS 'Public exchange management: publicEnabled/ohlcvEnabled/liveEnabled/isDefault/priority, BINANCE default true priority 100';
COMMENT ON TABLE "StrategyResearchResult" IS 'V2 research results: model (V1 baseline, V2-A/B/C/D), timeframe, train/valid/oos ranges, metrics JSON with signals/day LONG/SHORT TP1/TP2/TP3 STOP frequency';
