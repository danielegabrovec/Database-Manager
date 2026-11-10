/** Serialize writes and merge pending patches so a slow older save cannot win. */
export function createSettingsWriter(
  save: (settings: Record<string, unknown>) => Promise<unknown>,
) {
  let pending: Record<string, unknown> | null = null;
  let waiters: { resolve: () => void; reject: (reason: unknown) => void }[] =
    [];
  let running = false;
  async function drain() {
    if (running) return;
    running = true;
    try {
      while (pending) {
        const patch = pending;
        const batch = waiters;
        pending = null;
        waiters = [];
        try {
          await save(patch);
          batch.forEach(({ resolve }) => resolve());
        } catch (error) {
          batch.forEach(({ reject }) => reject(error));
        }
      }
    } finally {
      running = false;
    }
  }
  return {
    write(settings: Record<string, unknown>): Promise<void> {
      pending = { ...pending, ...settings };
      const completion = new Promise<void>((resolve, reject) =>
        waiters.push({ resolve, reject }),
      );
      void drain();
      return completion;
    },
  };
}
