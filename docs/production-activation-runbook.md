# PRODUCTION ACTIVATION RUNBOOK — PHASE 2C → VPS
# Строго по ступеням, READ-ONLY first, NO auto write

**Commit для deploy:** afc11b0 (PHASE 2C FINAL HARDENING)
**Branch:** arena/01a09726-svechnoy-suslik
**ВАЖНО:** SMART_MONEY_WRITE_ENABLED НЕ устанавливать true на этом этапе

---

## STAGE 0 — PRODUCTION PRE-FLIGHT (READ-ONLY)

На VPS выполнить:

```bash
cd /root/svechnoy-suslik || cd /home/*/svechnoy-suslik || cd ~/svechnoy-suslik
pwd
git branch --show-current
git rev-parse HEAD
git status
pm2 status
node -v
psql --version
```

Показать фактическую схему Signal:

```bash
psql $DATABASE_URL -c '\d "Signal"'
psql $DATABASE_URL -c '\d "SignalOutcome"' || echo "SignalOutcome not exists yet"
psql $DATABASE_URL -c '\dT "SignalSource"' || psql $DATABASE_URL -c "SELECT unnest(enum_range(NULL::\"SignalSource\"))"
```

Проверить существование колонок:

```sql
SELECT column_name, data_type FROM information_schema.columns WHERE table_name='Signal' ORDER BY column_name;
-- Ожидаемые для 2C: signalCandleTime, referenceExchange, referencePrice, aggregatePrice, executionPolicy, signalSource, metadata, atrAtSignal, participantCount, evaluatedCount, longVotes, shortVotes, neutralVotes, confirmationCount, confirmationTotal, commonHorizonPolicy, referenceFallback, nextBarOpenPrice, nextBarOpenTime
```

Enum:

```sql
SELECT enumlabel FROM pg_enum JOIN pg_type ON pg_type.oid=pg_enum.enumtypid WHERE pg_type.typname='SignalSource' ORDER BY enumsortorder;
-- Ожидаемо: LIVE_FORWARD, SEEDED, BACKTEST, LEGACY
```

Существующие сигналы:

```sql
SELECT id,symbol,timeframe,direction,score,"strategyId","createdAt", "signalSource", "signalCandleTime" FROM "Signal" ORDER BY id;
```

Не выводить secrets, только var name где используется.

---

## STAGE 1 — MIGRATION DECISION

Определить состояние:

A. ни одна Phase2 migration не применена — в \d Signal нет signalCandleTime, нет SignalSource enum
B. применена только часть 2B — есть signalCandleTime но нет LEGACY в enum, default LIVE_FORWARD
C. применена 2B целиком — есть все поля 2B но нет SignalOutcome, нет participantCount и т.д., enum без LEGACY или с LEGACY но default LIVE_FORWARD
D. применены 2B+2C — есть SignalOutcome, все structured колонки, enum включает LEGACY, default LEGACY
E. неизвестное/частичное

**Migration plan по состоянию:**

- **A:** применить `prisma/migrations/20260913_add_signal_identity/migration.sql` (исправленный с LEGACY default) + `20260913_phase2c_hardening/migration.sql`
- **B/C:** если enum без LEGACY, сначала `ALTER TYPE "SignalSource" ADD VALUE 'LEGACY'` в отдельной транзакции, затем применить `phase2c_hardening` (он делает UPDATE legacy to LEGACY и SET DEFAULT LEGACY и создает SignalOutcome)
- **D:** ничего не делать, только проверить
- **E:** STOP, показать \d Signal и ждать анализа

Если schema неожиданная: STOP.

---

## STAGE 2 — BACKUP

Перед любым ALTER:

```bash
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="/tmp/svechnoy_backup_${TIMESTAMP}.sql"
echo "Backup to $BACKUP_FILE"
pg_dump $DATABASE_URL > $BACKUP_FILE
echo "Exit code: $?"
ls -lh $BACKUP_FILE
test -s $BACKUP_FILE && echo "Backup OK size>0" || echo "Backup FAILED"
```

Не печатать DATABASE_URL. Если backup failed: STOP.

---

## STAGE 3 — SAFE MIGRATION

Применить только SQL необходимый для фактического состояния.

Пример для состояния A (ничего не применено):

```bash
psql $DATABASE_URL -f prisma/migrations/20260913_add_signal_identity/migration.sql
# Проверить exit code
psql $DATABASE_URL -f prisma/migrations/20260913_phase2c_hardening/migration.sql
```

Пример для состояния B (2B частично, default LIVE_FORWARD, нет LEGACY):

```bash
psql $DATABASE_URL -c "ALTER TYPE \"SignalSource\" ADD VALUE 'LEGACY';"
# Может потребовать отдельной сессии, если в транзакции — выполнить вне транзакции
psql $DATABASE_URL -f prisma/migrations/20260913_phase2c_hardening/migration.sql
```

После каждой части проверять exit code.

КРИТИЧНО: существующие seed/demo Signal не должны стать LIVE_FORWARD.

После migration:

```sql
SELECT "signalSource", COUNT(*) FROM "Signal" GROUP BY "signalSource";
-- До первого настоящего SMC: LIVE_FORWARD должен быть 0
-- ID1/ID2 должны быть LEGACY либо SEEDED, но НЕ LIVE_FORWARD

SELECT id, "signalSource", "signalCandleTime", direction, reason FROM "Signal" ORDER BY id LIMIT 10;

-- Проверить unique identity
SELECT "strategyId", symbol, timeframe, "signalCandleTime", COUNT(*) FROM "Signal" WHERE "signalCandleTime" IS NOT NULL GROUP BY 1,2,3,4 HAVING COUNT(*)>1;
-- Должно быть 0 строк

-- Проверить SignalOutcome relation
\d "SignalOutcome"
SELECT COUNT(*) FROM "SignalOutcome";
```

Ничего не удалять.

---

## STAGE 4 — CODE DEPLOY WITHOUT SMC WRITE

После успешной migration:

```bash
cd /root/svechnoy-suslik
git fetch origin
git checkout arena/01a09726-svechnoy-suslik
git rev-parse HEAD # должен быть afc11b0 или новее проверенный
npx prisma generate
npx tsc --noEmit
npm run build
```

Если ЛЮБОЙ шаг падает: НЕ restart PM2, STOP и вернуть ошибку.

Если всё green:

```bash
pm2 restart svechnoy-suslik --update-env || pm2 restart all --update-env
pm2 status
pm2 logs --lines 50
```

ВАЖНО: SMART_MONEY_WRITE_ENABLED НЕ устанавливать true. Проверить:

```bash
env | grep SMART_MONEY || echo "SMART_MONEY_WRITE_ENABLED not set — correct for this stage"
cat .env | grep SMART_MONEY || echo "not in .env — correct"
```

Существующий signal worker не должен начать писать SMC.

---

## STAGE 5 — REAL PRODUCTION SMC DRY-RUN

Самый важный этап. На настоящей production DB выполнить ТОЛЬКО dry-run:

```bash
# BTC 15m
npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=15m --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM

# BTC 1h
npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1h --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM

# BTC 4h
npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=4h --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM

# BTC 1d
npx tsx scripts/signal-worker.ts --symbol=BTC --timeframe=1d --strategy=smart-money-suslik --dry-run --common-horizon-policy=QUORUM
```

Никакого `--enable-smart-money-write` `--no-dry-run`

Для каждого TF вернуть:

- COMMON HORIZON
- eligible exchanges, fresh exchanges, stale exchanges, reference exchange, referenceFallback
- Для каждой биржи: direction, longScore, shortScore, evaluable, hardFailures, softUnavailable
- A-I contributions: A swing, B BOS, C internal, D sweep, E swing OB, F internal OB, G FVG, H range, I confluence
- AGGREGATION: evaluatedCount, minExchanges, longVotes, shortVotes, neutralVotes, direction, confirmation
- Если candidate LONG/SHORT: показать candidate, но НЕ persist

---

## STAGE 6 — DATABASE WRITE ASSERTION

Перед dry-run:

```sql
SELECT COUNT(*) FROM "Signal";
SELECT COUNT(*) FROM "SignalOutcome";
```

После всех dry-run повторить.

Counts должны быть ИДЕНТИЧНЫ. Если изменились: CRITICAL BUG, STOP.

---

## STAGE 7 — HISTORICAL BASELINE

Теперь, раз код находится на VPS, выполнить READ-ONLY historical baseline.

Сначала BTC 1h last 500, затем при нормальной нагрузке:

- 15m last 1000
- 1h last 2000
- 4h last 1000
- 1d last 500

Скрипт для baseline (если есть scripts/test-historical-baseline.ts) или вручную через:

```bash
npx tsx scripts/test-historical-baseline.ts --symbol=BTC --timeframe=1h --limit=500
```

Получить реальные:

- LONG, SHORT, NEUTRAL, CANNOT_EVALUATE
- score distributions
- A-I frequencies
- multi-exchange QUORUM aggregation
- LONG/SHORT per 1000 bars
- 60-71 bottlenecks
- >=72 combinations
- signal spacing

Это должны быть MEASURED числа, не предположения.

---

## STAGE 8 — GO/NO-GO

После real dry-run + historical baseline ответить:

1. Работает ли SMC технически на production данных?
2. Есть ли hardFailures?
3. Получает ли SMC >=72 хотя бы исторически?
4. Получаются ли multi-exchange confirmations?
5. Какова реальная частота агрегированных LONG/SHORT?
6. Нет ли очевидного компонента A-I, который всегда 0?
7. Корректно ли QUORUM ведёт себя на реальных данных?
8. Можно ли включать LIVE_FORWARD без изменения scoring?

Вердикт: GO_LIVE_WRITE или NO_GO

Если NO_GO: точная техническая причина.

Если GO: НЕ включай write автоматически. STOP и жди отдельного подтверждения.

---

## НЕ ДЕЛАТЬ НА ЭТОМ ЭТАПЕ

- менять minScore 72
- менять weights
- менять freshness
- менять SMC config
- запускать seed
- создавать SMC Signal
- включать SMART_MONEY_WRITE_ENABLED
- добавлять write flag
- делать markers
- запускать outcome tracker
- делать stats UI
- live trading

---

## ФИНАЛЬНЫЙ ОТЧЁТ ШАБЛОН

Заполнить после выполнения на VPS:

- PRODUCTION_SCHEMA_BEFORE
- BACKUP (file, size, exit code)
- MIGRATION_APPLIED (which SQL, exit codes)
- PRODUCTION_SCHEMA_AFTER
- BUILD_RESULTS (prisma generate, tsc, build)
- DRY_RUN_DB_COUNTS_BEFORE_AFTER
- REAL_SMC_15M
- REAL_SMC_1H
- REAL_SMC_4H
- REAL_SMC_1D
- HISTORICAL_BASELINE
- A_I_FREQUENCY
- QUORUM_RESULTS
- SIGNAL_FREQUENCY
- GO_NO_GO

Затем STOP.
