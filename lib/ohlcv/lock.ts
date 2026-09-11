import type { PrismaClient } from "@prisma/client";

export const OHLCV_ADVISORY_LOCK_KEY = 727923; // arbitrary 32-bit key for OHLCV worker single-instance

export async function tryAcquireOhlcvLock(prisma: PrismaClient): Promise<boolean> {
  const rows = await prisma.$queryRaw<Array<{ acquired: boolean }>>`
    SELECT pg_try_advisory_lock(${OHLCV_ADVISORY_LOCK_KEY}) as acquired
  `;
  return rows[0]?.acquired === true;
}

export async function releaseOhlcvLock(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRaw`
    SELECT pg_advisory_unlock(${OHLCV_ADVISORY_LOCK_KEY})
  `;
}
