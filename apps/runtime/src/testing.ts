/** Waits until `check` stops throwing, for assertions on work that finishes asynchronously. */
export async function eventually<T>(check: () => T | Promise<T>, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}
