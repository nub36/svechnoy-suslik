import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

/**
 * Ленивая инициализация клиента.
 *
 * Зачем: импорт модуля не должен падать вместе с
 * приложением, если клиент Prisma ещё не готов
 * (например, в песочнице без prisma generate).
 * Клиент создаётся при первом реальном обращении,
 * на VPS поведение то же, что и раньше.
 */
function getClient(): PrismaClient {
  if (!globalForPrisma.prisma) {
    globalForPrisma.prisma =
      new PrismaClient();
  }

  return globalForPrisma.prisma;
}

export const prisma: PrismaClient =
  new Proxy({} as PrismaClient, {
    get(_target, prop, receiver) {
      const client = getClient();

      const value = Reflect.get(
        client as object,
        prop,
        receiver
      );

      return typeof value === "function"
        ? value.bind(client)
        : value;
    }
  });
