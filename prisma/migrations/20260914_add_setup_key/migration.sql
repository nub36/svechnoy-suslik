-- PHASE: SMC EVENT SEMANTICS — setupKey design, not yet applied production
-- One persistent regime 08:15..10:45 should be ONE setup, not 11 adjacent signals

ALTER TABLE "Signal" ADD COLUMN IF NOT EXISTS "setupKey" TEXT;
CREATE INDEX IF NOT EXISTS "Signal_setupKey_idx" ON "Signal"("setupKey");

-- Future unique for persistent setup dedup (not enforced yet, keep existing unique):
-- CREATE UNIQUE INDEX "Signal_strategyId_symbol_timeframe_setupKey_key" ON "Signal"("strategyId", "symbol", "timeframe", "setupKey");
-- But PostgreSQL NULL distinct: legacy NULLs allowed, new SMC with setupKey NOT NULL will be constrained to one per setup
-- For now keep @@unique([strategyId, symbol, timeframe, signalCandleTime]) as is

COMMENT ON COLUMN "Signal"."setupKey" IS 'Causal setup identity: hash of strategyVersion|symbol|timeframe|direction|swingPhase|bosKey|swingOBKey|intOBKey|fvgKey|sweepKey|rangeKey — no score, no future outcome. Same BOS+OB+FVG next candle => same setupKey. New BOS/OB/FVG => new setupKey.';
