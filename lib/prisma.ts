let PrismaClientCtor: any;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  PrismaClientCtor = require("@prisma/client").PrismaClient;
} catch {
  PrismaClientCtor = null;
}

const globalForPrisma = globalThis as unknown as {
  prisma?: any;
};

function createPrismaClient() {
  if (!PrismaClientCtor) {
    // Fallback mock for build phase when client not generated
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
          return async () => [];
        }
        // Return mock for any model access
        return new Proxy({}, {
          get() {
            return async () => null;
          }
        });
      }
    }) as any;
  }
  try {
    return new PrismaClientCtor();
  } catch {
    return new Proxy({}, {
      get(_target, prop) {
        if (prop === "$queryRaw" || prop === "$queryRawUnsafe") {
          return async () => [];
        }
        return new Proxy({}, {
          get() {
            return async () => null;
          }
        });
      }
    }) as any;
  }
}

export const prisma =
  globalForPrisma.prisma ??
  createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
