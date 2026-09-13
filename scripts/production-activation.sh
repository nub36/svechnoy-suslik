#!/bin/bash
set -e
# PRODUCTION ACTIVATION — STAGED, SAFE, NO AUTO WRITE
# Run on VPS only, not in Arena sandbox
# Commit: afc11b0 PHASE 2C FINAL HARDENING

echo "=== STAGE 0 — PRE-FLIGHT READ-ONLY ==="
cd /root/svechnoy-suslik 2>/dev/null || cd /home/*/svechnoy-suslik 2>/dev/null || cd ~/svechnoy-suslik 2>/dev/null || { echo "Cannot find svechnoy-suslik dir"; exit 1; }
pwd
git branch --show-current
git rev-parse HEAD
git status
pm2 status || echo "pm2 not running"
node -v
psql --version || echo "psql not found"

echo ""
echo "=== Signal schema ==="
psql $DATABASE_URL -c '\d "Signal"' || echo "Failed \d Signal"
psql $DATABASE_URL -c '\d "SignalOutcome"' || echo "SignalOutcome not exists yet — expected before migration"
psql $DATABASE_URL -c "SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=pg_enum.enumtypid WHERE pg_type.typname='SignalSource' ORDER BY enumsortorder;" || echo "SignalSource enum not exists"

echo ""
echo "=== Columns ==="
psql $DATABASE_URL -c "SELECT column_name, data_type FROM information_schema.columns WHERE table_name='Signal' ORDER BY column_name;"

echo ""
echo "=== Existing Signals ==="
psql $DATABASE_URL -c 'SELECT id,symbol,timeframe,direction,score,"strategyId","createdAt","signalSource","signalCandleTime" FROM "Signal" ORDER BY id LIMIT 20;'

echo ""
echo "=== STAGE 1 — MIGRATION DECISION ==="
echo "Check output above manually:"
echo "A. no signalCandleTime, no SignalSource => no Phase2"
echo "B. has signalCandleTime but no LEGACY or default LIVE_FORWARD => partial 2B"
echo "C. has 2B fields but no SignalOutcome => full 2B"
echo "D. has SignalOutcome + structured cols + LEGACY default => 2B+2C"
echo "E. unknown"
echo "If unexpected: STOP"

read -p "Continue? (type YES to proceed to backup): " CONFIRM
if [ "$CONFIRM" != "YES" ]; then echo "STOP"; exit 1; fi

echo ""
echo "=== STAGE 2 — BACKUP ==="
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/svechnoy_backup_${TIMESTAMP}.sql"
echo "Backup to $BACKUP_FILE"
pg_dump $DATABASE_URL > $BACKUP_FILE
EC=$?
echo "Exit code: $EC"
ls -lh $BACKUP_FILE
if [ $EC -ne 0 ] || [ ! -s $BACKUP_FILE ]; then echo "Backup FAILED — STOP"; exit 1; fi
echo "Backup OK"

read -p "Backup OK. Continue to migration? (YES): " CONFIRM2
if [ "$CONFIRM2" != "YES" ]; then echo "STOP"; exit 1; fi

echo ""
echo "=== STAGE 3 — SAFE MIGRATION ==="
echo "Apply based on detected state. Example for state A:"
echo "psql \$DATABASE_URL -f prisma/migrations/20260913_add_signal_identity/migration.sql"
echo "psql \$DATABASE_URL -f prisma/migrations/20260913_phase2c_hardening/migration.sql"
echo ""
echo "For state B/C (enum without LEGACY):"
echo "psql \$DATABASE_URL -c \"ALTER TYPE \\\"SignalSource\\\" ADD VALUE 'LEGACY';\""
echo "Then phase2c_hardening"
echo ""
echo "MANUAL STEP REQUIRED — edit this script or run manually"
echo "After migration, verify:"
psql $DATABASE_URL -c 'SELECT "signalSource", COUNT(*) FROM "Signal" GROUP BY "signalSource";' || echo "After migration check failed — run manually"
echo "LIVE_FORWARD should be 0 before first real SMC"
echo "ID1/ID2 should be LEGACY or SEEDED, not LIVE_FORWARD"

echo ""
echo "=== STAGE 4 — CODE DEPLOY WITHOUT SMC WRITE ==="
echo "After migration success:"
echo "git fetch origin && git checkout arena/01a09726-svechnoy-suslik && git rev-parse HEAD"
echo "npx prisma generate && npx tsc --noEmit && npm run build"
echo "If any fails: STOP, do not restart PM2"
echo "If green: pm2 restart, but ensure SMART_MONEY_WRITE_ENABLED not true"
echo "env | grep SMART_MONEY"

echo ""
echo "=== STAGE 5 — REAL PRODUCTION SMC DRY-RUN ==="
echo "Only dry-run:"
echo "npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=15m --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM"
echo "npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM"
echo "npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=4h --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM"
echo "npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1d --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM"

echo ""
echo "=== STAGE 6 — DB WRITE ASSERTION ==="
echo "Before dry-run: SELECT COUNT(*) FROM \"Signal\"; SELECT COUNT(*) FROM \"SignalOutcome\";"
echo "After dry-run: same counts must be identical"

echo ""
echo "=== END OF AUTOMATED PART ==="
echo "STAGE 7 and 8 require manual analysis"
