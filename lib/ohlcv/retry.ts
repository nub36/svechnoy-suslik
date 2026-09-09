export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  options?: {
    attempts?: number;
    baseDelayMs?: number;
  }
): Promise<T> {
  const attempts = options?.attempts ?? 3;
  const baseDelayMs = options?.baseDelayMs ?? 500;
  let lastError: unknown;

  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i >= attempts) break;

      const delay = baseDelayMs * 2 ** (i - 1);
      console.warn(
        `  retry ${i}/${attempts} ${label} через ${delay}ms:`,
        error instanceof Error ? error.message : error
      );
      await sleep(delay);
    }
  }

  throw lastError;
}
