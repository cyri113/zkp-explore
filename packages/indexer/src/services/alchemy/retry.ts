// services/alchemy/retry.ts
export async function retry<T>(fn: () => Promise<T>, attempts = 3, delayMs = 1000): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const backoff = delayMs * 2 ** i;
      await new Promise(r => setTimeout(r, backoff));
    }
  }
  throw lastError;
}